'use strict';
const crypto=require('node:crypto');
const labels=Object.freeze({battery:'Batteriestand',electric:'Elektrische Reichweite',fuel:'Kraftstoff-Reichweite',lowbattery:'Akku niedrig',percent:'Akkustand %',lock:'Türschloss',klima:'Vorheizen'}); // lock: jeep-schloss.js; klima: Schalter „Jeep vorheizen“ (jeep-schloss.js)
const vehicleId=vin=>crypto.createHash('sha256').update(vin).digest('hex').slice(0,24);
const validAddress=/^jeep@([a-f0-9]{24})-(battery|electric|fuel|lowbattery|percent|lock|klima)$/; // lock: Türschloss, klima: Vorheizen (jeep-schloss.js)
const finite=(v,max)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:null;
function warningThreshold(config,address){const value=config.jeepWarningThresholds?.[address];return Number.isInteger(value)&&value>=1&&value<=100?value:20;}
function values(row,threshold=20) {
 const fuel=row.sources?.status?.data?.vehicleInfo?.fuel?.distanceToEmpty||{};
 const distance=(v,unit)=>{if(typeof v!=='number'&&(typeof v!=='string'||!/^\d+(\.\d+)?$/.test(v)))return null;const n=finite(Number(v),5000);return n===null?null:/^km$/i.test(unit)?n:/^mi$/i.test(unit)?n*1.609344:null;};
 const battery=finite(row.batteryPercent,100);
 return {lowbattery:battery===null?null:battery<threshold?1:0,battery,percent:battery,electric:distance(row.range,row.rangeUnit),fuel:distance(fuel.value,fuel.unit),lock:require('./jeep-schloss').state(row),klima:typeof row?.vin==='string'?require('./jeep-schloss').klimaState(vehicleId(row.vin)):null}; // lock: Türschloss; klima: läuft Klima sofort (jeep-schloss)
}
// Akkustand %: Der Jeep meldet sich nur beim Fahren/Laden. Der letzte bekannte Wert wird dauerhaft gemerkt
// (jeep-akkustand-percent.json neben config.json) und weiter angezeigt – auch nach einem Neustart der Bridge.
const percentFile=configPath=>require('node:path').join(require('node:path').dirname(configPath),'jeep-akkustand-percent.json');
// Akkustand percent: Datei nur beim ersten Mal lesen, danach aus dem Speicher (update() läuft alle 5 s; 12.10.2026 gespart)
const percentCache=new Map();
function lastPercent(configPath){const file=percentFile(configPath);if(percentCache.has(file))return {...percentCache.get(file)};let d={};try{const x=JSON.parse(require('node:fs').readFileSync(file,'utf8'));if(x&&typeof x==='object'&&!Array.isArray(x))d=x;}catch{}percentCache.set(file,d);return {...d};}
function rememberPercent(configPath,id,value,at){const all=lastPercent(configPath),old=all[id];if(old&&old.value===value)return;all[id]={value,at:at||new Date().toISOString()};const file=percentFile(configPath);percentCache.set(file,all);try{require('node:fs').writeFileSync(file+'.neu',JSON.stringify(all),{mode:0o600});require('node:fs').renameSync(file+'.neu',file);}catch{}}
function settings(config) {
 const selected=config.jeepMatter||{};
 if(!selected||typeof selected!=='object'||Array.isArray(selected)||Object.keys(selected).length>16||Object.entries(selected).some(([address,value])=>!validAddress.test(address)||typeof value!=='boolean'))throw Error('Ungültige Jeep-Matter-Freigaben');
 return selected;
}
function rows(web) {
 const config=web.security.configSnapshot.read(),names=config.jeepNames||{},rooms=config.jeepRooms||{},selected=settings(config),state=web.jeepService?.public()||{connected:false,vehicles:[]};
 const result=state.vehicles.slice(0,4).flatMap((row,index)=>{
  const id=vehicleId(row.vin),threshold=warningThreshold(config,'jeep@'+id+'-lowbattery'),v=values(web.jeepService.rows[index],threshold);
  const kept=v.percent===null&&web.deps?.configPath?lastPercent(web.deps.configPath)[id]:null;if(kept&&Number.isFinite(kept.value))v.percent=kept.value;
  return Object.entries(labels).map(([key,label])=>({address:'jeep@'+id+'-'+key,provider:'jeep',id:id+'-'+key,
   name:names['jeep@'+id+'-'+key]||'Jeep Fahrzeug '+(index+1)+' · '+label,readOnly:true,customName:true,exposed:selected['jeep@'+id+'-'+key]===true,
   hmChannelType:'Jeep Cloud',hmDeviceType:'Messwert',interfaceId:'jeep',room:rooms['jeep@'+id+'-'+key]||'',roomId:rooms['jeep@'+id+'-'+key]||'',
   matterDeviceType:key==='lowbattery'?'OnOffLight':key==='percent'?'Prozentanzeige (Rollladen-Kachel)':key==='lock'?'Türschloss (entriegeln mit Face ID)':key==='klima'?'Schalter „Jeep vorheizen“ (Siri, jeep-schloss)':key==='battery'?'Power Source':'Jeep-Reichweite (Erweiterung)',online:state.connected===true,
   currentState:{value:key==='lock'?require('./jeep-schloss').label(id,v[key]):key==='klima'?(v[key]===true?'heizt vor':v[key]===false?'aus':null):v[key],lockGuess:key==='lock'?require('./jeep-schloss').text(require('./jeep-schloss').guess(id,v[key])):undefined,threshold:key==='lowbattery'?threshold:undefined,unit:key==='lowbattery'||key==='lock'||key==='klima'?'':key==='battery'||key==='percent'?'%':'km',warning:key==='lowbattery'?(v[key]===null?null:v[key]===1):undefined,timestamp:row.vehicleUpdatedAt,stale:row.stale===true||state.connected!==true},
   capabilities:{kind:'sensor'},switchControl:{allowed:false}}));
 });
 for(const [address,enabled]of Object.entries(selected))if(enabled&&!result.some(r=>r.address===address)){
  const [,id,key]=validAddress.exec(address);
  result.push({address,provider:'jeep',id:id+'-'+key,name:names[address]||'Jeep · '+labels[key],readOnly:true,customName:true,exposed:true,
   hmChannelType:'Jeep Cloud',hmDeviceType:'Messwert',interfaceId:'jeep',room:rooms[address]||'',roomId:rooms[address]||'',
   matterDeviceType:key==='lowbattery'?'OnOffLight':key==='percent'?'Prozentanzeige (Rollladen-Kachel)':key==='lock'?'Türschloss (entriegeln mit Face ID)':key==='klima'?'Schalter „Jeep vorheizen“ (Siri, jeep-schloss)':key==='battery'?'Power Source':'Jeep-Reichweite (Erweiterung)',online:false,
   currentState:{value:key==='percent'&&web.deps?.configPath&&Number.isFinite(lastPercent(web.deps.configPath)[id]?.value)?lastPercent(web.deps.configPath)[id].value:null,threshold:key==='lowbattery'?warningThreshold(config,address):undefined,unit:key==='lowbattery'?'':key==='battery'||key==='percent'?'%':'km',warning:key==='lowbattery'?null:undefined,timestamp:key==='percent'&&web.deps?.configPath?lastPercent(web.deps.configPath)[id]?.at||null:null,stale:true},capabilities:{kind:'sensor'},switchControl:{allowed:false}});
 }
 return result;
}
function endpoint(matter,key,id,vendorId) {
 const {Endpoint,MutableEndpoint,ClusterBehavior,behaviors,types}=matter;
 const basic={nodeLabel:labels[key],productName:'Jeep Cloud-Messwert',serialNumber:'j-'+id+'-'+key[0],reachable:false};
 if(key==='lowbattery') {
  // A status light represents cloud telemetry, never a vehicle command.
  // Reject writes so a controller cannot falsify the reported warning.
  class TelemetryOnOff extends behaviors.OnOffServer {
   on(){throw Error('Jeep battery warning is read-only');}
   off(){throw Error('Jeep battery warning is read-only');}
   toggle(){throw Error('Jeep battery warning is read-only');}
   onWithTimedOff(){throw Error('Jeep battery warning is read-only');}
   onWithRecallGlobalScene(){throw Error('Jeep battery warning is read-only');}
   offWithEffect(){throw Error('Jeep battery warning is read-only');}
  }
  const type=MutableEndpoint({name:'JeepBatteryWarningLight',deviceType:0x0100,deviceRevision:3,behaviors:{identify:behaviors.IdentifyServer,groups:behaviors.GroupsServer,scenesManagement:behaviors.ScenesManagementServer,onOff:TelemetryOnOff,bridgedDeviceBasicInformation:behaviors.BridgedDeviceBasicInformationServer}});
  // New ID avoids reusing a persisted contact endpoint as a different type.
  return new Endpoint(type,{id:'jeep-'+id+'-'+key+'-light-v1',bridgedDeviceBasicInformation:{...basic,nodeLabel:'Jeep - Akku niedrig'},onOff:{onOff:false}});
 }
 if(key==='lock')return require('./jeep-schloss').endpoint(matter,id,basic); // Türschloss (jeep-schloss.js)
 if(key==='klima')return require('./jeep-schloss').klimaEndpoint(matter,id,basic); // Schalter „Jeep vorheizen“ (jeep-schloss.js)
 if(key==='percent') {
  // Akkustand % als Rollladen-Kachel (Wunsch Thomas, 11.10.2026): Apple Home fasst Feuchte-Kacheln zusammen; ein Rollladen zeigt „54 % geöffnet“ groß an. Nur Anzeige (percent): jede Bedienung wird abgelehnt.
  class PercentRollo extends behaviors.WindowCoveringServer.with('Lift','PositionAwareLift'){initialize(){this.internal.disableOperationalModeHandling=true;super.initialize();}handleMovement(){}upOrOpen(){throw Error('Jeep Akkustand percent: nur Anzeige');}downOrClose(){throw Error('Jeep Akkustand percent: nur Anzeige');}stopMotion(){throw Error('Jeep Akkustand percent: nur Anzeige');}goToLiftPercentage(){throw Error('Jeep Akkustand percent: nur Anzeige');}}
  const type=MutableEndpoint({name:'JeepBatteryPercentRollo',deviceType:0x0202,deviceRevision:4,behaviors:{identify:behaviors.IdentifyServer,windowCovering:PercentRollo,bridgedDeviceBasicInformation:behaviors.BridgedDeviceBasicInformationServer}});
  return new Endpoint(type,{id:'jeep-'+id+'-percent-rollo-v1',bridgedDeviceBasicInformation:{...basic,nodeLabel:'Jeep - Akkustand',vendorName:'Jeep'},windowCovering:{type:0,numberOfActuationsLift:0,configStatus:{operational:true,onlineReserved:false,liftMovementReversed:false,liftPositionAware:true,tiltPositionAware:false,liftEncoderControlled:false,tiltEncoderControlled:false},mode:{motorDirectionReversed:false,calibrationMode:false,maintenanceMode:false,ledFeedback:false},operationalStatus:{global:0,lift:0,tilt:0},endProductType:0,currentPositionLiftPercent100ths:null,targetPositionLiftPercent100ths:null}}); // percent
 }
 if(key==='battery') {
  const PowerSource=behaviors.PowerSourceServer.with('Battery');
  const type=MutableEndpoint({name:'JeepBattery',deviceType:0x0011,deviceRevision:1,deviceClass:'utility',behaviors:{powerSource:PowerSource,bridgedDeviceBasicInformation:behaviors.BridgedDeviceBasicInformationServer}});
  return new Endpoint(type,{id:'jeep-'+id+'-'+key,bridgedDeviceBasicInformation:basic,powerSource:{status:0,order:0,description:'Jeep Antriebsbatterie',endpointList:[],batChargeLevel:0,batReplaceability:0,batReplacementNeeded:false,batPresent:true,batPercentRemaining:null}});
 }
 // Explicit vendor extension: not a temperature/humidity sensor, no commands.
 if(!Number.isInteger(vendorId)||vendorId<1||vendorId>65534)throw Error('Matter-Vendor-ID fehlt');
 const cluster=types.Cluster({id:((vendorId<<16)|0xfc10)>>>0,name:'JeepDistance',revision:1,attributes:{
  kilometres:types.Attribute(0,types.TlvNullable(types.TlvDouble),{default:null}),
  updatedAt:types.Attribute(1,types.TlvString.bound({maxLength:32}),{default:''}),
  stale:types.Attribute(2,types.TlvBoolean,{default:true})}});
 const schema=new types.ClusterModel({id:cluster.id,name:cluster.name,children:[
  {tag:'attribute',id:0,name:'Kilometres',type:'double',access:'R V',conformance:'M',quality:'X',default:null},
  {tag:'attribute',id:1,name:'UpdatedAt',type:'string',access:'R V',conformance:'M',constraint:'max 32',default:''},
  {tag:'attribute',id:2,name:'Stale',type:'bool',access:'R V',conformance:'M',default:true}
 ]});
 const Distance=ClusterBehavior.for(cluster,schema);
 const type=MutableEndpoint({name:'JeepDistance',deviceType:((vendorId<<16)|0x8001)>>>0,deviceRevision:1,
  behaviors:{jeepDistance:Distance,bridgedDeviceBasicInformation:behaviors.BridgedDeviceBasicInformationServer}});
 return new Endpoint(type,{id:'jeep-'+id+'-'+key,bridgedDeviceBasicInformation:basic,jeepDistance:{kilometres:null,updatedAt:'',stale:true}});
}
class JeepMatter {
 constructor(bridge,matter){this.bridge=bridge;this.matter=matter;this.entries=new Map();this.stopped=false;this.busy=false;this.configSnapshot=new (require('./runtime-core').ConfigSnapshot)(matter.configPath);}
 async start(){
  this.connection=require('./jeep-connection').source(this.matter.configPath);this.service=this.connection.service;
  for(const [address,enabled]of Object.entries(settings(this.bridge.config)))if(enabled){const [,id,key]=validAddress.exec(address),ep=endpoint(this.matter,key,id,this.bridge.config.bridge.vendorId);await this.bridge.addEndpointWithStableNumber(ep);this.entries.set(address,{id,key,endpoint:ep});}
  this.connection.restore().catch(()=>{});
  this.timer=setInterval(()=>{if(!this.busy)this.pending=this.update().catch(()=>console.error('[jeep-matter] Measurement update failed'));},5000);this.timer.unref();
  await this.update();
 }
 async update(){if(this.busy||this.stopped)return;this.busy=true;try{
  const publicState=this.service.public(),config=this.configSnapshot.read();
  for(const e of this.entries.values()){
   if(this.stopped)break;
   const row=this.service.rows.find(r=>vehicleId(r.vin)===e.id),meta=publicState.vehicles.find(r=>vehicleId(r.vin)===e.id);
   let value=row?values(row,warningThreshold(config,'jeep@'+e.id+'-lowbattery'))[e.key]:null;
   if(e.key==='percent'){if(value!==null)rememberPercent(this.matter.configPath,e.id,value,meta?.vehicleUpdatedAt);else{const k=lastPercent(this.matter.configPath)[e.id];if(k&&Number.isFinite(k.value))value=k.value;}}
   const timestamp=typeof meta?.vehicleUpdatedAt==='string'&&Number.isFinite(Date.parse(meta.vehicleUpdatedAt))?new Date(meta.vehicleUpdatedAt).toISOString():'';
   const age=timestamp?Date.now()-Date.parse(timestamp):Infinity;
   const stale=!meta||!timestamp||age>900000||age< -60000||meta.stale===true||!publicState.connected;
   const retainedWarning=e.key==='lowbattery'&&!!meta&&!!timestamp&&age>= -60000&&publicState.connected===true&&meta.stale!==true&&value!==null;
   const update={bridgedDeviceBasicInformation:{reachable:e.key==='lowbattery'?retainedWarning:e.key==='percent'?value!==null:!stale&&value!==null}};
   {const std={percent:'Jeep - Akkustand',lock:'Jeep Türen',klima:'Jeep vorheizen'}[e.key];if(std){const nm=String((config.jeepNames||{})['jeep@'+e.id+'-'+e.key]||std).trim().slice(0,32);if(e.endpoint.state.bridgedDeviceBasicInformation.nodeLabel!==nm)update.bridgedDeviceBasicInformation.nodeLabel=nm;}} // Akkustand percent, Türschloss lock, Vorheizen klima (jeep-schloss): Name aus der Geräteseite für Apple Home
   if(e.key==='battery')update.powerSource={status:stale?0:1,batPercentRemaining:value===null?null:Math.round(value*2),batChargeLevel:value===0?2:0};
   else if(e.key==='lowbattery'){if(retainedWarning)update.onOff={onOff:value===1};}
   else if(e.key==='lock'){update.bridgedDeviceBasicInformation.reachable=publicState.connected===true;const lk=require('./jeep-schloss').guess(e.id,value);if(lk!==null)update.doorLock={lockState:lk};}
   else if(e.key==='klima'){update.bridgedDeviceBasicInformation.reachable=publicState.connected===true;if(typeof value==='boolean'&&e.endpoint.state.onOff.onOff!==value)update.onOff={onOff:value};} // Vorheizen (jeep-schloss.js): an, solange Klima sofort läuft // Türschloss (jeep-schloss.js): Zustand aus den Fahrzeugdaten, nach einem Befehl bis zu 3 min der befohlene
   else if(e.key==='percent'){if(value!==null){const closed=Math.round((100-value)*100);update.windowCovering={currentPositionLiftPercent100ths:closed,targetPositionLiftPercent100ths:closed};}} // percent: 0 = ganz offen = 100 % Akku
   else update.jeepDistance={kilometres:value,updatedAt:timestamp,stale};
   await e.endpoint.set(update);
  }
 }finally{this.busy=false;}}
 async stop(){this.stopped=true;clearInterval(this.timer);await this.pending;}
}
async function handle(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;
 if(!['getJeepMatterDevices','setJeepExposed','setJeepOnlineExposed','setJeepName','setJeepRoom','setJeepWarningThreshold'].includes(method))return false;
 try{
  // Exposure uses the same session/CSRF gate as other device exposure controls.
  // The detailed catalogue remains administrator-only.
  if(method==='getJeepMatterDevices')require('./tailscale-backup').requireAdmin(web,req);
  if(method==='getJeepMatterDevices'){
   if(req.method!=='GET')throw Object.assign(Error('GET erforderlich'),{status:405});
   web.sendJson(res,200,{devices:rows(web)});return true;
  }
  if(req.method!=='POST')throw Object.assign(Error('POST erforderlich'),{status:405});
  const p=await require('./web-security').body(req);
  if(method==='setJeepWarningThreshold'){
   if(Object.keys(p).length!==2||typeof p.address!=='string'||!/^jeep@[a-f0-9]{24}-lowbattery$/.test(p.address)||!rows(web).some(d=>d.address===p.address)||!Number.isInteger(p.threshold)||p.threshold<1||p.threshold>100)throw Object.assign(Error('Warnschwelle muss eine ganze Zahl von 1 bis 100 Prozent sein'),{status:400});
   web.writeConfigPatch(c=>{c.jeepWarningThresholds={...(c.jeepWarningThresholds||{}),[p.address]:p.threshold};});
   web.sendJson(res,200,{success:true,threshold:p.threshold});return true;
  }
  if(method==='setJeepRoom'){
   if(Object.keys(p).length!==2||typeof p.address!=='string'||!validAddress.test(p.address)||!rows(web).some(d=>d.address===p.address)||typeof p.room!=='string'||p.room.length>168||/[\x00-\x1f\x7f]/.test(p.room))throw Object.assign(Error('Vorhandenen Jeep-Messwert und Raum auswählen'),{status:400});
   if(p.room&&!((await web.security.ccuRooms().read()).rooms.some(r=>r.name===p.room)))throw Object.assign(Error('Raum ist auf der CCU nicht vorhanden'),{status:400});
   web.writeConfigPatch(c=>{c.jeepRooms={...(c.jeepRooms||{})};if(p.room)c.jeepRooms[p.address]=p.room;else delete c.jeepRooms[p.address];});
   web.sendJson(res,200,{success:true,room:p.room});return true;
  }
  if(method==='setJeepName'){
   if(Object.keys(p).length!==2||typeof p.address!=='string'||!validAddress.test(p.address)||!rows(web).some(d=>d.address===p.address)||typeof p.name!=='string'||!p.name.trim()||p.name.trim().length>64||/[\x00-\x1f\x7f]/.test(p.name))throw Object.assign(Error('Vorhandenen Jeep-Messwert und Namen mit 1 bis 64 Zeichen angeben'),{status:400});
   const name=p.name.trim();
   web.writeConfigPatch(c=>{c.jeepNames={...(c.jeepNames||{}),[p.address]:name};});
   web.sendJson(res,200,{success:true,name});return true;
  }
  const available=rows(web),bulk=method==='setJeepOnlineExposed';
  if(bulk?(Object.keys(p).length!==1||typeof p.exposed!=='boolean'):(Object.keys(p).length!==2||typeof p.exposed!=='boolean'||typeof p.address!=='string'||!validAddress.test(p.address)||!available.some(r=>r.address===p.address)))throw Object.assign(Error('Vorhandenen Jeep-Messwert auswählen'),{status:400});
  const chosen=bulk?available.filter(d=>!p.exposed||(d.online===true&&!d.currentState.stale&&Number.isFinite(d.currentState.value))).map(d=>d.address):[p.address];
  if(bulk&&p.exposed&&!chosen.length)throw Object.assign(Error('Keine aktuellen Jeep-Messwerte verfügbar. Zuerst Fahrzeugdaten aktualisieren.'),{status:409});
  if(web.jeepMatterBusy)throw Object.assign(Error('Jeep-Freigabe wird bereits angewendet'),{status:429});
  web.jeepMatterBusy=true;
  try{web.writeConfigPatch(c=>{c.jeepMatter={...settings(c)};for(const address of chosen){if(p.exposed)c.jeepMatter[address]=true;else delete c.jeepMatter[address];}settings(c);});await web.deps.restartBridge();web.sendJson(res,200,{success:true,message:'Matter-Freigabe angewendet',changed:chosen.length});}
  finally{web.jeepMatterBusy=false;}
 }catch(e){web.sendJson(res,e.status||502,{error:e.status?e.message:'Matter-Freigabe konnte nicht angewendet werden'});}return true;
}
module.exports={JeepMatter,rows,handle,endpoint,values,settings,vehicleId,warningThreshold,lastPercent,rememberPercent};
