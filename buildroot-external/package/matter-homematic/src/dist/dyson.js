'use strict';
const path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const profile=require('./dyson-profile'),{DysonMqtt}=require('./dyson-mqtt'),{DysonDiscovery}=require('./dyson-discovery'),{Vault}=require('./smartplus');
const fail=(text,status)=>Object.assign(Error(text),{status});
const time=()=>new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
class Dyson extends EventEmitter {
 constructor(bridge,matter,{Client=DysonMqtt,Discovery=DysonDiscovery}={}){super();Object.assign(this,{bridge,matter,Client,Discovery});this.entries=new Map();this.stopped=false;}
 async start(){
  const config=this.bridge.config.dyson;if(!config?.devices?.length)return;
  if(!config.vaultPath||config.devices.length>32)throw Error('Dyson-Konfiguration unvollständig');
  const secrets=new Vault(config.vaultPath).read();profile.validateDevices(config.devices,secrets);this.discovery=new this.Discovery(this.matter.dns);
  for(const item of config.devices){
   if(!profile.serialValid(item.id)||!profile.TYPES.has(item.type)||typeof secrets[item.id]!=='string')throw Error('Ungültige gespeicherte Dyson-Gerätedaten');
   const entry={item,credential:secrets[item.id],state:{},raw:{},online:false,syncing:0,lastAttempt:0,desired:{},syncQueue:Promise.resolve()};this.entries.set(item.id,entry);
   if(item.exposed){entry.endpoint=this.endpoint(entry);await this.bridge.addEndpointWithStableNumber(entry.endpoint);}
  }
  this.loop().catch(()=>this.emit('notice','Dyson-Erkennung fehlgeschlagen'));
  this.timer=setInterval(()=>this.loop().catch(()=>this.emit('notice','Dyson-Erkennung fehlgeschlagen')),30000);this.timer.unref();
 }
 public(){return [...this.entries.values()].map(e=>({id:e.item.id,name:e.item.name,type:e.item.type,exposed:e.item.exposed,onlineCheck:e.item.onlineCheck===true,online:e.online,ip:e.ip||'',state:{...e.state},controlStatus:e.controlStatus||null,capabilities:{speed:true,auto:true,oscillation:Object.hasOwn(e.state,'oscillation'),matterOscillation:e.rocking===true,night:Object.hasOwn(e.state,'night')}}));}
 async loop(){
  if(this.stopped||this.looping)return;this.looping=true;
  try{
   const missing=[...this.entries.values()].filter(e=>!e.client&&!e.connecting&&Date.now()-e.lastAttempt>=30000);
   const addresses=await this.discovery.find(missing.map(e=>e.item.id));
   let index=0;const worker=async()=>{while(index<missing.length&&!this.stopped){const e=missing[index++];e.lastAttempt=Date.now();const ip=addresses.get(e.item.id);if(ip)await this.connect(e,ip);}};
   await Promise.all([worker(),worker()]);
   for(const entry of this.entries.values())if(entry.client?.ready&&!entry.busy){try{if(entry.lastSeen&&Date.now()-entry.lastSeen>90000){entry.client.stop();continue;}await entry.client.publish({msg:'REQUEST-CURRENT-STATE',time:time()});}catch{entry.client.stop();}}
  }finally{this.looping=false;}
 }
 async connect(entry,ip){
  entry.connecting=true;
  try{
   const client=new this.Client({host:ip,serial:entry.item.id,credential:entry.credential,type:entry.item.type});entry.client=client;entry.ip=ip;
   client.on('message',bytes=>{if(this.stopped||entry.client!==client)return;this.feedback(entry,bytes).catch(()=>this.emit('notice','Dyson-Status konnte nicht übernommen werden'));});
   client.on('offline',()=>{if(entry.client!==client)return;entry.online=false;entry.client=null;entry.ip='';this.publish(entry);});
   await client.connect();if(this.stopped){client.stop();return;}
   await client.publish({msg:'REQUEST-CURRENT-STATE',time:time()});
   await client.publish({msg:'REQUEST-PRODUCT-ENVIRONMENT-CURRENT-SENSOR-DATA',time:time()});
  }catch{entry.client?.stop();entry.client=null;entry.online=false;this.publish(entry);}
  finally{entry.connecting=false;}
 }
 async feedback(entry,bytes){
  let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return;}
  if(!data||typeof data!=='object'||Array.isArray(data))return;
  if(['CURRENT-STATE','STATE-CHANGE'].includes(data.msg)&&data['product-state']&&typeof data['product-state']==='object'&&!Array.isArray(data['product-state'])){
   // Only retain known protocol fields, avoiding prototype keys and unbounded state.
   for(const key of ['fmod','fpwr','fnsp','auto','oson','nmod','hmod','qtar','rhtm'])if(Object.hasOwn(data['product-state'],key))entry.raw[key]=profile.field(data['product-state'],key);
   entry.state=profile.state(entry.raw,entry.item.type,entry.state);entry.online=typeof entry.state.on==='boolean';entry.lastSeen=Date.now();
  }else if(data.msg==='ENVIRONMENTAL-CURRENT-SENSOR-DATA'&&data.data&&typeof data.data==='object'){
   for(const [key,target,min,max,scale,offset]of [['tact','temperature',2000,3500,10,273.15],['hact','humidity',0,100,1,0]]){
    const raw=profile.field(data.data,key);if(typeof raw==='string'&&/^\d{1,4}$/.test(raw)&&Number(raw)>=min&&Number(raw)<=max)entry.state[target]=Math.round((Number(raw)/scale-offset)*10)/10;
   }
  }else return;
  await this.publish(entry);
 }
 publish(entry){
  if(this.stopped)return Promise.resolve();this.emit('state',{id:entry.item.id,online:entry.online,...entry.state});
  entry.syncQueue=entry.syncQueue.catch(()=>{}).then(async()=>{
   if(this.stopped||!entry.endpoint)return;
   const s=entry.state,update={bridgedDeviceBasicInformation:{reachable:entry.online}};
   if(typeof s.on==='boolean'){
    update.fanControl={fanMode:s.on?(s.auto?5:4):0,percentSetting:s.auto&&s.on?null:s.on&&Number.isFinite(s.speed)?s.speed*10:0};
    if(!s.on||Number.isFinite(s.speed))update.fanControl.percentCurrent=s.on?s.speed*10:0;
    if(entry.rocking&&typeof s.oscillation==='boolean')update.fanControl.rockSetting={rockLeftRight:s.oscillation,rockUpDown:false,rockRound:false};
   }
   entry.syncing++;try{await entry.endpoint.set(update);}finally{entry.syncing--;}
  });entry.syncQueue.catch(()=>this.emit('notice','Dyson-Matter-Rückmeldung fehlgeschlagen'));return entry.syncQueue;
 }
 async control(id,input){
  const entry=this.entries.get(id);if(!entry)throw fail('Dyson-Gerät nicht gefunden',404);
  // A direct off request must also cancel an older unsent Matter speed request.
  if(input?.on===false){clearTimeout(entry.flushTimer);entry.desired={};}
  if(!entry.online||!entry.client?.ready)throw fail('Dyson ist derzeit nicht erreichbar',503);
  if(entry.busy)throw fail('Dyson-Auftrag läuft bereits',429);
  const data=profile.command(input,entry.item.type,entry.raw);entry.busy=true;
  let timer,listener,finish;
  const confirmation=new Promise(resolve=>{finish=resolve;listener=state=>{if(state.id===id&&Object.entries(input).every(([key,value])=>state[key]===value))resolve(true);};this.on('state',listener);});
  entry.controlStatus={at:new Date().toISOString(),confirmed:false,message:'Geräterückmeldung steht aus.'};
  try{await entry.client.publish({msg:'STATE-SET',time:time(),'mode-reason':'LAPP',data},{ack:true});await entry.client.publish({msg:'REQUEST-CURRENT-STATE',time:time()});timer=setTimeout(()=>finish(false),4000);const confirmed=await confirmation;const message=confirmed?'Gerät hat den gewünschten Zustand bestätigt.':'Gerät hat den gewünschten Zustand noch nicht bestätigt. Anzeige und Gerät prüfen.';entry.controlStatus={at:new Date().toISOString(),confirmed,message};return {accepted:true,confirmed,state:{...entry.state},message};}
  catch{entry.controlStatus={at:new Date().toISOString(),confirmed:false,message:'Übertragung fehlgeschlagen. Keine bestätigte Geräteänderung.'};throw fail('Dyson-Auftrag wurde nicht bestätigt. Gerätestatus vor erneutem Schalten prüfen.',502);}
  finally{clearTimeout(timer);this.off('state',listener);finish(false);entry.busy=false;}
 }
 schedule(entry,input){if(this.stopped||entry.syncing||!this.bridge.serverNode?.lifecycle.isOnline)return;entry.desired=require('./dyson-command-queue').merge(entry.desired,input);clearTimeout(entry.flushTimer);entry.flushTimer=setTimeout(async()=>{const command=entry.desired;entry.desired={};try{await this.control(entry.item.id,command);}catch{this.emit('notice','Dyson-Matter-Auftrag konnte nicht bestätigt werden');await this.publish(entry).catch(()=>{});}},150);}
 endpoint(entry){
  const {Endpoint,devices,behaviors}=this.matter;
  // Declare only a verified direction for legacy Link models. Never advertise
  // vertical/circular rocking or assume support for unverified model families.
  entry.rocking=['469','475','455'].includes(entry.item.type);
  const features=['MultiSpeed','Auto',...(entry.rocking?['Rocking']:[])];
  const endpoint=new Endpoint(devices.FanDevice.with(behaviors.BridgedDeviceBasicInformationServer,behaviors.FanControlServer.with(...features)),{id:'dyson-'+crypto.createHash('sha256').update(entry.item.id).digest('hex').slice(0,24),bridgedDeviceBasicInformation:{vendorName:'Dyson',productName:'WLAN-Ventilator',nodeLabel:require('./matter-text').text(entry.item.name),serialNumber:require('./matter-text').serial(entry.item.id),reachable:false},fanControl:{fanMode:0,fanModeSequence:2,percentSetting:0,percentCurrent:0,speedMax:10,speedSetting:0,speedCurrent:0,...(entry.rocking?{rockSupport:{rockLeftRight:true,rockUpDown:false,rockRound:false},rockSetting:{rockLeftRight:false,rockUpDown:false,rockRound:false}}:{})}});
  if(entry.rocking)endpoint.events.fanControl.rockSetting$Changed.on(value=>{if(typeof value?.rockLeftRight==='boolean'&&value.rockLeftRight!==entry.state.oscillation)this.schedule(entry,{oscillation:value.rockLeftRight});});
  endpoint.events.fanControl.percentSetting$Changed.on(value=>{if(typeof value==='number'){if(value===0)this.schedule(entry,{on:false});else if(Math.ceil(value/10)!==entry.state.speed)this.schedule(entry,{speed:Math.max(1,Math.min(10,Math.ceil(value/10)))});}});
  endpoint.events.fanControl.fanMode$Changed.on(value=>{if(value===0&&entry.state.on!==false)this.schedule(entry,{on:false});else if(value===5&&!entry.state.auto)this.schedule(entry,{on:true,auto:true});else if(value!==0&&value!==5&&entry.state.on!==true)this.schedule(entry,{on:true});});
  return endpoint;
 }
 async stop(){this.stopped=true;clearInterval(this.timer);this.discovery?.stop();for(const e of this.entries.values()){clearTimeout(e.flushTimer);e.client?.stop();e.credential='';await e.syncQueue.catch(()=>{});}this.entries.clear();}
}
module.exports={Dyson};
