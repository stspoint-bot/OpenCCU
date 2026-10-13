'use strict';
const caches=new WeakMap();
async function capability(connector,device){
 if(!device || device.matterDeviceType!=='Thermostat')return {allowed:false,reason:'Kein Heizthermostat'};
 const channel=connector.getChannels().get(device.hmAddress);
 if(!channel || !['BidCos-RF','HmIP-RF','CUxD'].includes(channel.interface))return {allowed:false,reason:'Thermostat-Schnittstelle nicht freigegeben'};
 const mapping=Object.values(device.valueMappings||{}).find(v=>v.matterCluster==='thermostat' && v.matterAttribute==='occupiedHeatingSetpoint');
 if(!mapping || !['SET_TEMPERATURE','SET_POINT_TEMPERATURE'].includes(mapping.hmKey))return {allowed:false,reason:'Keine unterstützte Solltemperatur'};
 let cache=caches.get(connector);if(!cache){cache=new Map();caches.set(connector,cache);}
 const old=cache.get(device.hmAddress);
 if(old && old.channel===channel && old.key===mapping.hmKey && Date.now()<old.until)return old.promise;
 const promise=(async()=>{
  try{
   const description=await connector.rpcCall(channel.interface,'getParamsetDescription',[device.hmAddress,'VALUES']);
   const param=description?.[mapping.hmKey];
   if(!param || !['FLOAT','INTEGER'].includes(param.TYPE) || !(param.OPERATIONS&2) || !(param.OPERATIONS&1))return {allowed:false,reason:'Solltemperatur nicht lesbar und schreibbar'};
   if(!Number.isFinite(param.MIN)||!Number.isFinite(param.MAX))return {allowed:false,reason:'Temperaturgrenzen nicht verfügbar'};
   // Conservative heating range; special OFF/ON sentinel values are not advertised as temperatures.
   const min=Math.ceil(Math.max(5,param.MIN)*2)/2,max=Math.floor(Math.min(30,param.MAX)*2)/2;
   if(min>max)return {allowed:false,reason:'Keine unterstützten Temperaturgrenzen'};
   return {allowed:true,key:mapping.hmKey,min,max,step:0.5,interface:channel.interface};
  }catch{return {allowed:false,reason:'Thermostat-Eigenschaften derzeit nicht verfügbar'};}
 })();
 cache.set(device.hmAddress,{channel,key:mapping.hmKey,until:Date.now()+300000,promise});return promise;
}
function validateTemperature(value,cap){
 if(typeof value!=='number'||!Number.isFinite(value)||value<cap.min||value>cap.max||Math.abs(value*2-Math.round(value*2))>1e-8)
  throw Object.assign(Error(`Solltemperatur muss zwischen ${cap.min} und ${cap.max} °C in 0,5-°C-Schritten liegen`),{status:400});
}
function readings(connector,device){
 const values=connector.getChannels().get(device.hmAddress)?.paramsets?.VALUES||{};
 const setpoint=Object.values(device.valueMappings||{}).find(v=>v.matterAttribute==='occupiedHeatingSetpoint' && v.matterCluster==='thermostat');
 const actual=Object.values(device.valueMappings||{}).find(v=>v.matterAttribute==='localTemperature' && v.matterCluster==='thermostat');
 const numeric=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
 return {temperature:numeric(values[actual?.hmKey]),setpoint:numeric(values[setpoint?.hmKey])};
}
async function setTemperature(connector,device,temperature){
 const cap=await capability(connector,device);
 if(!cap.allowed)throw Object.assign(Error(cap.reason),{status:403});
 validateTemperature(temperature,cap);
 await connector.setValue(device.hmAddress,cap.key,temperature);
 let actual;try{actual=await connector.getValue(device.hmAddress,cap.key);}catch{actual=null;}
 const confirmed=typeof actual==='number'&&Math.abs(actual-temperature)<0.001;
 if(confirmed)connector.handleEvent('matter-homematic-'+cap.interface,device.hmAddress,cap.key,actual);
 return {accepted:true,confirmed,setpoint:confirmed?actual:null,requestedTemperature:temperature,message:confirmed?'Solltemperatur von CCU bestätigt':'Solltemperatur an CCU übergeben; warte auf Rückmeldung'};
}
module.exports={capability,readings,validateTemperature,setTemperature};
