'use strict';
const {safeList}=require('./smartplus-api');
function rows(web){const list=['smartplus','smartlife'].flatMap(provider=>safeList(web,provider).devices.map(d=>({address:provider+'@'+d.id,provider,id:d.id,name:d.name,customName:true,exposed:d.exposed,hmChannelType:provider==='smartplus'?'SMART+':'Smart Life',hmDeviceType:d.capabilities.kind||'WiFi',interfaceId:provider,matterDeviceType:d.capabilities.kind==='sensor'?'Temperature / Humidity Sensor':['plug','cooler'].includes(d.capabilities.kind)?'OnOffPlugInUnit':d.capabilities.color?'ExtendedColorLight':d.capabilities.temperature?'ColorTemperatureLight':d.capabilities.brightness?'DimmableLight':'OnOffLight',room:d.room||'',roomId:d.room||'',online:d.online,onlineCheck:d.onlineCheck!==false,currentState:d.state||{},switchState:typeof d.state?.on==='boolean'?d.state.on:null,switchControl:{allowed:false},wifiUrl:provider==='smartlife'?'/smartlife.html':'/smartplus.html',capabilities:d.capabilities})));return list.concat(require('./dyson-api').publicList(web).devices.map(d=>({address:'dyson@'+d.id,provider:'dyson',id:d.id,name:d.name,customName:true,exposed:d.exposed,hmChannelType:'Dyson',hmDeviceType:d.type,interfaceId:'dyson',matterDeviceType:'Fan',room:'',roomId:'',online:d.online,onlineCheck:d.onlineCheck===true,currentState:d.state||{},switchControl:{allowed:false},wifiUrl:'/dyson.html',capabilities:{kind:'fan',...(d.capabilities||{})}})));}
async function handle(web,req,res,u){if(u.pathname!=='/api/'||u.searchParams.get('method')!=='setWifiDevice')return false;
 try{if(req.method!=='POST')throw Object.assign(Error('POST erforderlich'),{status:405});const p=await require('./web-security').body(req),match=/^(smartplus|smartlife|dyson)@([A-Za-z0-9_-]{1,64})$/.exec(p.address||'');
  if(!match||Object.keys(p).some(k=>!['address','name','exposed','onlineCheck'].includes(k))||Object.keys(p).length!==2)throw Object.assign(Error('Ungültige WLAN-Geräteänderung'),{status:400});
  const [,provider,id]=match,current=web.security.configSnapshot.read()[provider]?.devices?.find(d=>d.id===id);if(!current)throw Object.assign(Error('Gerät nicht gefunden'),{status:404});
  if(Object.hasOwn(p,'name')&&(typeof p.name!=='string'||!p.name.trim()||p.name.length>64||/[\x00-\x1f]/.test(p.name)))throw Object.assign(Error('Gerätename muss 1–64 Zeichen enthalten'),{status:400});
  for(const key of ['exposed','onlineCheck'])if(Object.hasOwn(p,key)&&typeof p[key]!=='boolean')throw Object.assign(Error('Ungültige Auswahl'),{status:400});
  if(web.wifiSetupBusy)throw Object.assign(Error('WLAN-Geräteeinrichtung läuft bereits'),{status:429});web.wifiSetupBusy=true;
  try{web.writeConfigPatch(c=>{const d=c[provider].devices.find(d=>d.id===id);if(p.name!==undefined)d.name=p.name.trim();if(p.exposed!==undefined)d.exposed=p.exposed;if(p.onlineCheck!==undefined)d.onlineCheck=p.onlineCheck;});
   if(p.onlineCheck!==undefined){if(web.security.monitor){web.security.monitor.generation++;web.security.monitor.incidents.delete(provider+':'+id);}}
   else await web.deps.restartBridge();
   web.sendJson(res,200,{success:true,name:p.name?.trim()||current.name,message:p.onlineCheck!==undefined?'Onlineprüfung gespeichert':'Gespeichert und auf Matter angewendet'});
  }finally{web.wifiSetupBusy=false;}
 }catch(e){web.sendJson(res,e.status||502,{error:e.message});}return true;
}
function alertEnabled(web,id){const match=/^(smartplus|smartlife|dyson):([A-Za-z0-9_-]{1,64})$/.exec(id);if(!match)return true;const d=web.security.configSnapshot.read()[match[1]]?.devices?.find(d=>d.id===match[2]);return !!d&&(match[1]==='dyson'?d.onlineCheck===true:d.onlineCheck!==false);}
module.exports={rows,handle,alertEnabled};
