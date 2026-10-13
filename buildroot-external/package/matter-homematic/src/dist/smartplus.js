'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const light=require('./smartplus-light');
async function bounded(promise,ms=8000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('SMART+-Zeitlimit')),ms);})]);}finally{clearTimeout(timer);}}
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id);
const validIp=ip=>ip===''||typeof ip==='string'&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)&&ip.split('.').length===4&&ip.split('.').every(n=>/^\d{1,3}$/.test(n)&&Number(n)<=255);
const {atomicJson:atomic,createKey}=require('./durable-storage');
class Vault{
 constructor(file){this.file=file;this.keyFile=file+'.key';}
 key(create=true){if(!fs.existsSync(this.keyFile)){if(!create)throw Error('SMART+-Schlüsselspeicher-Schlüssel fehlt');createKey(this.keyFile);}const key=fs.readFileSync(this.keyFile);if(key.length!==32)throw Error('SMART+-Schlüsselspeicher ungültig');return key;}
 read(){if(!fs.existsSync(this.file))return {};if(fs.statSync(this.file).size>4194304)throw Error('SMART+-Schlüsselspeicher zu groß');const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!data||typeof data.iv!=='string'||!/^[a-f0-9]{24}$/.test(data.iv)||typeof data.tag!=='string'||!/^[a-f0-9]{32}$/.test(data.tag)||typeof data.data!=='string'||!/^([a-f0-9]{2})+$/.test(data.data))throw Error('SMART+-Schlüsselspeicher ungültig');const dec=crypto.createDecipheriv('aes-256-gcm',this.key(false),Buffer.from(data.iv,'hex'));dec.setAuthTag(Buffer.from(data.tag,'hex'));return JSON.parse(Buffer.concat([dec.update(Buffer.from(data.data,'hex')),dec.final()]).toString());}
 write(secrets){const iv=crypto.randomBytes(12),enc=crypto.createCipheriv('aes-256-gcm',this.key(),iv),data=Buffer.concat([enc.update(JSON.stringify(secrets)),enc.final()]);atomic(this.file,{iv:iv.toString('hex'),tag:enc.getAuthTag().toString('hex'),data:data.toString('hex')});}
}
function rgbToHsv(rgb){const [r,g,b]=rgb.map(n=>Math.max(0,n)),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;let h=delta===0?0:max===r?60*((g-b)/delta%6):max===g?60*((b-r)/delta+2):60*((r-g)/delta+4);return {hue:(h+360)%360,saturation:max===0?0:delta/max*100};}
function xyToHsv(x,y){if(y<=0||x<0||x+y>1.001)return {hue:0,saturation:0};const X=x/y,Z=(1-x-y)/y;let rgb=[1.656492*X-.354851-.255038*Z,-.707196*X+1.655397+.036152*Z,.051713*X-.121364+1.01153*Z];rgb=rgb.map(n=>n<=.0031308?12.92*n:1.055*Math.pow(n,1/2.4)-.055);return rgbToHsv(rgb);}
function hsvToXy(h,s){let rgb=light.hsvToRgb(h,s/100,1).map(n=>n/255).map(n=>n>.04045?Math.pow((n+.055)/1.055,2.4):n/12.92);const [r,g,b]=rgb,X=.664511*r+.154324*g+.162028*b,Y=.283881*r+.668433*g+.047685*b,Z=.000088*r+.07231*g+.986039*b,total=X+Y+Z;return {currentX:Math.round((total?X/total:.3127)*65536),currentY:Math.round((total?Y/total:.329)*65536)};}
class Smartplus extends EventEmitter{
 constructor(bridge,matter,{Client,provider='smartplus'}={}){super();this.provider=provider==='smartlife'?'smartlife':'smartplus';this.label=this.provider==='smartlife'?'Smart Life':'SMART+';this.bridge=bridge;this.matter=matter;this.Client=Client||require('../vendor/node_modules/tuyapi');this.entries=new Map();this.stopped=false;this.timer=null;}
 async start(){
 const config=this.bridge.config[this.provider];if(!config?.vaultPath){if(config?.devices?.some(d=>d.exposed&&!require('./device-exclusions').excluded(d)))throw Error(this.label+'-Schlüsselspeicher fehlt; unvollständige Matter-Liste wird nicht veröffentlicht');return;}
 this.cacheFile=path.join(path.dirname(config.vaultPath),this.provider+'-lan-cache.json');this.addresses={};
 try{if(fs.statSync(this.cacheFile).size<=65536){const stored=JSON.parse(fs.readFileSync(this.cacheFile,'utf8'));for(const [id,c]of Object.entries(stored))if(validId(id)&&validIp(c?.ip)&&c.ip&&['3.1','3.3','3.4','3.5'].includes(c.version)&&validIp(c.configuredIp||''))this.addresses[id]={ip:c.ip,version:c.version,configuredIp:c.configuredIp||'',configuredVersion:c.configuredVersion};}}catch{}
 let secrets;try{secrets=new Vault(config.vaultPath).read();}catch{if(config.devices?.some(d=>d.exposed&&!require('./device-exclusions').excluded(d)))throw Error(this.label+'-Schlüsselspeicher konnte nicht gelesen werden; Matter-Start abgebrochen');this.emit('notice',this.label+'-Schlüsselspeicher konnte nicht gelesen werden');return;}
 for(const item of (config.devices||[]).slice(0,128)){
  if(require('./device-exclusions').excluded(item))continue;
  if(!validId(item.id)||!item.profile||!validIp(item.ip||'')||!['3.1','3.3','3.4','3.5'].includes(item.version)||typeof secrets[item.id]!=='string'||Buffer.byteLength(secrets[item.id])!==16){if(item.exposed)throw Error(this.label+'-Freigabe enthält ungültige Gerätedaten; Matter-Start abgebrochen');continue;}
  const entry={item,state:{},dps:{},online:false,localOnline:false,cloudOnline:false,busy:false,syncing:0,desired:{},lastAttempt:0,client:null,endpoint:null};this.entries.set(item.id,entry);
  if(item.exposed){try{entry.endpoint=this.endpoint(entry);await this.bridge.addEndpointWithStableNumber(entry.endpoint);if(item.profile.kind==='sensor'&&item.profile.readings?.humidity){entry.humidityEndpoint=this.sensorEndpoint(entry,true);await this.bridge.addEndpointWithStableNumber(entry.humidityEndpoint);}}catch{this.emit('notice',this.label+'-Matter-Gerät konnte nicht angelegt werden: '+item.name);entry.endpoint=null;throw Error(this.label+'-Matter-Gerät konnte nicht angelegt werden; unvollständige Liste wird nicht veröffentlicht');}}
  const stored=this.addresses[item.id],cached=stored&&stored.configuredIp===(item.ip||'')&&(!stored.configuredVersion||stored.configuredVersion===item.version)?stored:null;entry.client=new this.Client({id:item.id,key:secrets[item.id],ip:cached?.ip||item.ip||undefined,version:cached?.version||item.version,issueGetOnConnect:false,issueRefreshOnPing:false});
  entry.client.on('data',data=>this.feedback(entry,data));entry.client.on('dp-refresh',data=>this.feedback(entry,data));
  entry.client.on('error',()=>this.offline(entry));entry.client.on('disconnected',()=>this.offline(entry));
 }
 this.secrets=secrets;
 this.discovery=new (require('./tuya-discovery').TuyaDiscovery)();
 // One discovery at a time avoids opening conflicting UDP discovery sockets.
 if(this.provider==='smartlife'&&[...this.entries.values()].some(e=>e.item.profile.kind==='sensor')){
  const {SensorCloud}=require('./smartlife-sensor-cloud');
  this.sensorCloud=new SensorCloud({
   credentials:()=>new Vault(path.join(path.dirname(config.vaultPath),'backup-accounts-secrets.json')).read().smartlife,
   entries:()=>[...this.entries.values()],
   apply:(entry,result)=>this.cloudFeedback(entry,result),
   notice:message=>this.emit('notice',message)
  });
  this.sensorCloud.start();
 }
 this.connectLoop().catch(()=>{});this.timer=setInterval(()=>this.connectLoop().catch(()=>{}),15000);this.timer.unref();
 }
 async attemptConnection(entry){
  if(this.stopped||entry.busy)return;
  if(entry.localOnline ?? entry.online){
   if(Date.now()-(entry.lastPoll||0)<30000)return;
   // Serialize status reads with control writes on the same Tuya connection.
   entry.lastPoll=Date.now();entry.busy=true;
   try{const data=await bounded(entry.client.get({schema:true}));if(!this.stopped)await this.feedback(entry,data);}
   catch{this.offline(entry);entry.client.disconnect();}
   finally{entry.busy=false;}
   return;
  }
  if(Date.now()-entry.lastAttempt<30000)return;
  entry.lastAttempt=Date.now();entry.busy=true;
  try{
   if(!entry.client.device.ip)await entry.client.find({timeout:5});
   if(this.stopped)return;
   if(!validIp(entry.client.device.ip)||!['3.1','3.3','3.4','3.5'].includes(entry.client.device.version))throw Error('Keine unterstützte lokale Geräteverbindung');
   await bounded(entry.client.connect());if(this.stopped){entry.client.disconnect();return;}
   const data=await bounded(entry.client.get({schema:true}));entry.lastPoll=Date.now();if(!this.stopped){await this.feedback(entry,data);if(entry.online){entry.failures=0;this.remember(entry);}}
  }catch{this.offline(entry);entry.client.disconnect();entry.failures=(entry.failures||0)+1;if(entry.failures>=2){entry.client.device.ip=undefined;delete this.addresses[entry.item.id];}}
  finally{entry.busy=false;}
 }
 remember(entry){const ip=entry.client.device.ip,version=entry.client.device.version;if(!this.cacheFile||!validIp(ip)||!ip||!['3.1','3.3','3.4','3.5'].includes(version))return;const previous=this.addresses[entry.item.id];if(previous?.ip===ip&&previous?.version===version)return;this.addresses[entry.item.id]={ip,version,configuredIp:entry.item.ip||'',configuredVersion:entry.item.version};try{atomic(this.cacheFile,this.addresses);}catch{this.emit('notice',this.label+'-Geräteadresse konnte nicht dauerhaft gespeichert werden');}}
 async connectLoop(){if(this.connecting||this.stopped)return;this.connecting=true;
  try{
   const entries=[...this.entries.values()],ready=entries.filter(e=>e.client.device.ip),unknown=entries.filter(e=>!e.client.device.ip);
   let index=0;
   // Known-address devices never wait for sequential UDP discoveries.
   const worker=async()=>{while(index<ready.length&&!this.stopped)await this.attemptConnection(ready[index++]);};
   const discovery=async()=>{if(process.platform==='linux'&&this.discovery)await this.discovery.find(unknown);for(const entry of unknown){if(this.stopped)break;await this.attemptConnection(entry);}};
   await Promise.all([worker(),worker(),worker(),discovery()]);
  }finally{this.connecting=false;}
 }

 offline(entry){if(this.stopped)return;entry.localOnline=false;entry.online=entry.item.profile.kind==='sensor'&&entry.cloudOnline===true;this.publish(entry);}
 async cloudFeedback(entry,result){
  if(this.stopped||this.provider!=='smartlife'||entry.item.profile.kind!=='sensor')return;
  entry.cloudOnline=result.online===true;entry.cloudQueriedAt=result.queriedAt;entry.cloudFailed=result.failed===true;
  if(!entry.localOnline&&entry.cloudOnline){Object.assign(entry.state,result.values);entry.readingSource='cloud';}
  entry.online=entry.localOnline===true||entry.cloudOnline;
  await this.publish(entry);
 }
 public(){return [...this.entries.values()].map(e=>({id:e.item.id,name:e.item.name,ip:e.item.ip,version:e.client?.device?.version||e.item.version,exposed:e.item.exposed,online:e.online,localOnline:e.localOnline===true,cloudOnline:e.cloudOnline===true,readingSource:e.readingSource||null,cloudQueriedAt:e.cloudQueriedAt||null,cloudFailed:e.cloudFailed===true,state:{...e.state},capabilities:{kind:e.item.profile.kind,readings:e.item.profile.readings||e.item.profile.extra||{},brightness:!!(e.item.profile.brightness||e.item.profile.color),color:!!e.item.profile.color,temperature:!!e.item.profile.temperature,minKelvin:e.item.profile.minKelvin,maxKelvin:e.item.profile.maxKelvin}}));}
 publish(entry){if(this.stopped)return Promise.resolve();this.emit('state',{id:entry.item.id,online:entry.online,...entry.state});return entry.endpoint?this.sync(entry).catch(()=>{}):Promise.resolve();}
 async feedback(entry,data){if(this.stopped)return;const dps=data?.dps||data?.data?.dps;if(!dps||typeof dps!=='object'||Array.isArray(dps))return;Object.assign(entry.dps,dps);const p=entry.item.profile;if(p.on)Object.assign(entry.state,light.decode(entry.dps,p));for(const [key,f]of Object.entries(p.readings||p.extra||{})){const raw=entry.dps[f.id];if(typeof raw==='number'&&Number.isFinite(raw)&&raw>=f.min&&raw<=f.max)entry.state[key]=raw/10**(f.scale||0);}entry.online=p.kind==='sensor'?Object.entries(p.readings||{}).some(([key,f])=>typeof dps[f.id]==='number'&&Number.isFinite(dps[f.id])&&dps[f.id]>=f.min&&dps[f.id]<=f.max):typeof entry.state.on==='boolean';entry.localOnline=entry.online;if(entry.localOnline)entry.readingSource='local';else if(p.kind==='sensor')entry.online=entry.cloudOnline===true;await this.publish(entry);}
 async sync(entry){
 if(entry.item.profile.kind==='sensor'){await entry.endpoint.set({bridgedDeviceBasicInformation:{reachable:entry.online},temperatureMeasurement:{measuredValue:Number.isFinite(entry.state.temperature)?Math.round(entry.state.temperature*100):null}});if(entry.humidityEndpoint)await entry.humidityEndpoint.set({bridgedDeviceBasicInformation:{reachable:entry.online},relativeHumidityMeasurement:{measuredValue:Number.isFinite(entry.state.humidity)?Math.round(entry.state.humidity*100):null}});return;}
 const ep=entry.endpoint,s=entry.state,update={bridgedDeviceBasicInformation:{reachable:entry.online}};
 if(typeof s.on==='boolean')update.onOff={onOff:s.on};
 if(Number.isFinite(s.brightness)&&(entry.item.profile.brightness||entry.item.profile.color))update.levelControl={currentLevel:Math.round(s.brightness*254/100)};
 const p=entry.item.profile,color={};if(p.color&&Number.isFinite(s.hue)&&Number.isFinite(s.saturation))Object.assign(color,{currentHue:Math.round(s.hue/360*254),currentSaturation:Math.round(s.saturation/100*254)},hsvToXy(s.hue,s.saturation));
 if(p.temperature&&Number.isFinite(s.kelvin))color.colorTemperatureMireds=Math.round(1000000/s.kelvin);
 if(s.mode&&(p.color||p.temperature))Object.assign(color,{colorMode:s.mode==='white'?2:0,enhancedColorMode:s.mode==='white'?2:0});
 if(Object.keys(color).length)update.colorControl=color;
 entry.syncing++;try{await ep.set(update);}finally{entry.syncing--;}
 }
 async control(id,command){
 const entry=this.entries.get(id);if(!entry)throw Object.assign(Error(this.label+'-Gerät nicht gefunden'),{status:404});
 if(!entry.online)throw Object.assign(Error(this.label+'-Gerät nicht lokal erreichbar. WLAN-Adresse und Protokoll prüfen.'),{status:503});
 if(entry.busy)throw Object.assign(Error('Lichtauftrag läuft bereits'),{status:429});
 const p=entry.item.profile;if(p.kind==='sensor')throw Object.assign(Error('Sensoren liefern Messwerte und sind nicht schaltbar'),{status:400});
 let dps;if(p.kind==='cooler'){
  if(!command||typeof command!=='object'||Array.isArray(command)||!Object.keys(command).length||Object.keys(command).some(k=>!['on','leftTarget','rightTarget'].includes(k)))throw Object.assign(Error('Ungültiger Kühlbox-Auftrag'),{status:400});
  dps=Object.hasOwn(command,'on')?light.encode({on:command.on},p,entry.state):{};
  for(const k of ['leftTarget','rightTarget'])if(Object.hasOwn(command,k)){const f=p.extra?.[k],raw=command[k]*10**(f?.scale||0);if(!f||typeof command[k]!=='number'||!Number.isFinite(raw)||raw<f.min||raw>f.max||Math.abs((raw-f.min)/(f.step||1)-Math.round((raw-f.min)/(f.step||1)))>1e-8)throw Object.assign(Error('Kühlbox-Temperatur außerhalb des bestätigten Bereichs'),{status:400});dps[f.id]=Math.round(raw);}
 }else dps=light.encode(command,p,entry.state);entry.busy=true;
 try{await bounded(entry.client.set({multiple:true,data:dps,shouldWaitForResponse:true}));const response=await bounded(entry.client.get({schema:true})).catch(()=>null);if(response)await this.feedback(entry,response);return {accepted:true,online:entry.online,state:{...entry.state},message:'Lichtauftrag übergeben; Status zeigt die letzte Geräterückmeldung'};}
 catch{this.offline(entry);entry.client.disconnect();throw Object.assign(Error('Lichtauftrag konnte nicht bestätigt werden; Gerätestatus prüfen'),{status:502});}
 finally{entry.busy=false;}
 }
 schedule(entry,command){if(entry.syncing||this.stopped||(this.bridge.serverNode&&!this.bridge.serverNode.lifecycle.isOnline))return;
 if(Object.hasOwn(command,'kelvin')){delete entry.desired.hue;delete entry.desired.saturation;}else if(Object.hasOwn(command,'hue')||Object.hasOwn(command,'saturation'))delete entry.desired.kelvin;
 Object.assign(entry.desired,command);clearTimeout(entry.flushTimer);entry.flushTimer=setTimeout(()=>this.flush(entry),150);}
 async flush(entry){if(this.stopped)return;if(entry.busy){entry.flushTimer=setTimeout(()=>this.flush(entry),150);return;}
 const command=entry.desired;entry.desired={};if(!Object.keys(command).length)return;
 try{await this.control(entry.item.id,command);}catch{this.emit('notice',this.label+'-Lichtauftrag fehlgeschlagen: '+entry.item.name);await this.sync(entry).catch(()=>{});}}
 endpoint(entry){
 if(entry.item.profile.kind==='sensor')return this.sensorEndpoint(entry,false);
 const {Endpoint,devices,behaviors}=this.matter,p=entry.item.profile;
 let definition=['plug','cooler'].includes(p.kind)?devices.OnOffPlugInUnitDevice:p.color&&p.temperature?devices.ExtendedColorLightDevice:p.temperature&&p.brightness?devices.ColorTemperatureLightDevice:p.brightness||p.color?devices.DimmableLightDevice:devices.OnOffLightDevice;
 const servers=[behaviors.BridgedDeviceBasicInformationServer];if(p.color)servers.push(behaviors.ColorControlServer.with(...(p.temperature?['HueSaturation','Xy','ColorTemperature']:['HueSaturation','Xy'])));else if(p.temperature&&!p.brightness)servers.push(behaviors.ColorControlServer.with('ColorTemperature'));
 definition=definition.with(...servers);
 const options={id:this.provider+'-'+crypto.createHash('sha256').update(entry.item.id).digest('hex').slice(0,24),bridgedDeviceBasicInformation:{vendorName:this.provider==='smartlife'?'Tuya':'LEDVANCE',productName:require('./matter-text').text(entry.item.name),nodeLabel:require('./matter-text').text(entry.item.name),serialNumber:require('./matter-text').serial(entry.item.id),reachable:false},onOff:{onOff:false}};
 if(p.brightness||p.color)options.levelControl={currentLevel:254,minLevel:1,maxLevel:254};
 if(p.color||p.temperature)options.colorControl={colorMode:p.color?0:2,enhancedColorMode:p.color?0:2,remainingTime:0,...(p.color?{currentHue:0,currentSaturation:0,currentX:20493,currentY:21561}:{}),...(p.temperature?{colorTemperatureMireds:Math.round(1000000/p.minKelvin),coupleColorTempToLevelMinMireds:Math.round(1000000/p.maxKelvin),colorTempPhysicalMinMireds:Math.round(1000000/p.maxKelvin),colorTempPhysicalMaxMireds:Math.round(1000000/p.minKelvin)}:{})};
 const endpoint=new Endpoint(definition,options);
 endpoint.events.onOff.onOff$Changed.on(value=>{if(entry.state.on!==value)this.schedule(entry,{on:value});});
 if(options.levelControl)endpoint.events.levelControl.currentLevel$Changed.on(value=>{if(value!==null&&value>0&&Math.round((entry.state.brightness||0)*254/100)!==value)this.schedule(entry,{brightness:Math.max(1,Math.min(100,value*100/254))});});
 if(p.color){endpoint.events.colorControl.currentHue$Changed.on(value=>{if(Math.round((entry.state.hue||0)/360*254)!==value)this.schedule(entry,{hue:value/254*360});});endpoint.events.colorControl.currentSaturation$Changed.on(value=>{if(Math.round((entry.state.saturation||0)/100*254)!==value)this.schedule(entry,{saturation:value/254*100});});
 const xy=()=>{if(entry.syncing)return;const c=endpoint.state.colorControl;this.schedule(entry,xyToHsv(c.currentX/65536,c.currentY/65536));};endpoint.events.colorControl.currentX$Changed.on(xy);endpoint.events.colorControl.currentY$Changed.on(xy);}
 if(p.temperature)endpoint.events.colorControl.colorTemperatureMireds$Changed.on(value=>{if(value&&Math.round(1000000/(entry.state.kelvin||p.minKelvin))!==value)this.schedule(entry,{kelvin:Math.max(p.minKelvin,Math.min(p.maxKelvin,Math.round(1000000/value)))});});
 return endpoint;
 }
 sensorEndpoint(entry,humidity){const {Endpoint,devices,behaviors}=this.matter,field=entry.item.profile.readings[humidity?'humidity':'temperature'],divisor=10**(field.scale||0);const definition=(humidity?devices.HumiditySensorDevice:devices.TemperatureSensorDevice).with(behaviors.BridgedDeviceBasicInformationServer);return new Endpoint(definition,{id:this.provider+'-'+crypto.createHash('sha256').update(entry.item.id).digest('hex').slice(0,24)+(humidity?'-humidity':''),bridgedDeviceBasicInformation:{vendorName:'Tuya',productName:'Smart Life Sensor',nodeLabel:require('./matter-text').text(entry.item.name+(humidity?' Feuchtigkeit':' Temperatur')),serialNumber:require('./matter-text').serial(entry.item.id+(humidity?'-humidity':'')),reachable:false},[humidity?'relativeHumidityMeasurement':'temperatureMeasurement']:{measuredValue:null,minMeasuredValue:Math.round(field.min/divisor*100),maxMeasuredValue:Math.round(field.max/divisor*100)}});}
 async stop(){this.stopped=true;clearInterval(this.timer);this.sensorCloud?.stop();this.discovery?.stop();for(const e of this.entries.values()){clearTimeout(e.flushTimer);e.client?.disconnect();}this.entries.clear();this.secrets=null;}
}
module.exports={Smartplus,Vault,validIp,validId,xyToHsv,hsvToXy,bounded};
