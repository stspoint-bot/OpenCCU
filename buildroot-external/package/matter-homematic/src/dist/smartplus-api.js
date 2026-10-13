'use strict';
const path=require('node:path'),{LedvanceCloud}=require('./smartplus-cloud'),{Vault,validIp,validId}=require('./smartplus'),{profile}=require('./smartplus-light');
async function body(req){let chunks=[],size=0;if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw Object.assign(Error('JSON erforderlich'),{status:415});for await(const chunk of req){size+=chunk.length;if(size>16384)throw Object.assign(Error('Anfrage zu groß'),{status:413});chunks.push(chunk);}let p;try{p=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Object.assign(Error('Ungültige Anfrage'),{status:400});}if(!p||typeof p!=='object'||Array.isArray(p))throw Object.assign(Error('Ungültige Anfrage'),{status:400});return p;}
const fail=message=>{throw Object.assign(Error(message),{status:400});};
function safeList(web,provider='smartplus'){const config=web.security.configSnapshot.read()[provider]||{},states=new Map((web.deps[provider==='smartlife'?'getSmartlife':'getSmartplus']?.()?.public()||[]).map(s=>[s.id,s]));return {devices:(config.devices||[]).filter(d=>!require('./device-exclusions').excluded(d)).map(d=>({id:d.id,name:d.name,onlineCheck:d.onlineCheck!==false,room:d.room||'',ip:d.ip||'',version:d.version,exposed:!!d.exposed,online:false,capabilities:{kind:d.profile.kind,readings:d.profile.readings||d.profile.extra||{},brightness:!!(d.profile.brightness||d.profile.color),color:!!d.profile.color,temperature:!!d.profile.temperature,minKelvin:d.profile.minKelvin,maxKelvin:d.profile.maxKelvin},...(states.get(d.id)||{})}))};}
async function handleProvider(web,req,res,u,provider='smartplus'){
 const smartlife=provider==='smartlife',brand=smartlife?'Smart Life':'SMART+',getManager=()=>web.deps[smartlife?'getSmartlife':'getSmartplus']?.();
 const actual=u.pathname==='/api/'?u.searchParams.get('method'):null;
 const accepted=smartlife?['getSmartlifeDevices','importSmartlife','saveSmartlifeDevice','controlSmartlife']:['getSmartplusDevices','importSmartplus','saveSmartplusDevice','controlSmartplus'];
 if(!accepted.includes(actual))return false;
 const method=smartlife?actual.replace('Smartlife','Smartplus'):actual;
 if(!['getSmartplusDevices','importSmartplus','saveSmartplusDevice','controlSmartplus'].includes(method))return false;
 try{
 if((method==='getSmartplusDevices')!==(req.method==='GET') || (method!=='getSmartplusDevices'&&req.method!=='POST')){web.sendJson(res,405,{error:'HTTP-Methode nicht erlaubt'});return true;}
 if(method==='getSmartplusDevices'){web.sendJson(res,200,safeList(web,provider));return true;}
 const p=await body(req);
 if(method==='controlSmartplus'){
  if(Object.keys(p).some(k=>!['id','command'].includes(k))||!validId(p.id))fail('Ungültiger Lichtauftrag');
  const manager=getManager();if(!manager)throw Object.assign(Error('Bridge noch nicht bereit'),{status:503});
  web.sendJson(res,200,await manager.control(p.id,p.command));return true;
 }
 if(web.wifiSetupBusy)throw Object.assign(Error('WLAN-Geräteeinrichtung läuft bereits'),{status:429});web.wifiSetupBusy=true;
 try{
 if(method==='importSmartplus'){
  let found,remembered;const autoExposeOnline=p.autoExposeOnline===true;if(p.autoExposeOnline!==undefined&&typeof p.autoExposeOnline!=='boolean')fail('Freigabe-Auswahl ungültig');delete p.autoExposeOnline;
  const saved=require('./backup').accounts(web)[provider];
  if(smartlife&&!p.accessSecret&&saved&&p.accessId===saved.accessId&&p.uid===saved.uid&&p.region===saved.region)p.accessSecret=saved.accessSecret;
  if(!smartlife&&!p.password&&saved&&p.username===saved.username&&p.countryCode===saved.countryCode)p.password=saved.password;
  if(smartlife){
    require('./smartlife-cloud').validateCredentials(p);
    remembered={...p};
    try{found=await new (web.deps.SmartlifeCloud||require('./smartlife-cloud').SmartlifeCloud)().discover(p);}finally{p.accessSecret='';}
  }else{
    if(Object.keys(p).some(k=>!['username','password','countryCode'].includes(k))||typeof p.username!=='string'||p.username.length>254||!p.username.includes('@')||typeof p.password!=='string'||!p.password||p.password.length>1024||!Number.isInteger(p.countryCode)||p.countryCode<1||p.countryCode>999)fail('E-Mail, Passwort und Kontoland erforderlich');
    remembered={...p};
    try{found=await new (web.deps.SmartplusCloud||LedvanceCloud)().discover(p.username.trim(),p.password,p.countryCode);}finally{p.password='';}
  }
  if(!Array.isArray(found)||found.length>128)fail('Ungültige WLAN-Geräteliste');
  require('./backup').rememberAccess(web,provider,remembered);remembered=null;
  const old=web.security.configSnapshot.read()[provider]||{},file=old.vaultPath||path.join(path.dirname(web.deps.configPath),provider+'-secrets.json'),vault=new Vault(file),keys=vault.read();
  const makeProfile=smartlife?require('./smartlife-profile').profile:profile;
  const byId=new Map((old.devices||[]).map(d=>[d.id,d]));let imported=0,unsupported=0;
  const otherIds=new Set((web.security.configSnapshot.read()[smartlife?'smartplus':'smartlife']?.devices||[]).map(d=>d.id));
  for(const item of found){const caps=makeProfile(item);if(!validId(item.devId)||otherIds.has(item.devId)||!caps||caps.kind==='cooler'||typeof item.localKey!=='string'||!/^[\x20-\x7e]{16}$/.test(item.localKey)){unsupported++;continue;}
   const previous=byId.get(item.devId);
   const family=x=>JSON.stringify([x.kind,!!x.brightness,!!x.color,!!x.temperature,!!x.readings?.temperature,!!x.readings?.humidity]);
   if(previous?.exposed&&family(previous.profile)!==family(caps))fail('Gerätetyp eines freigegebenen Geräts hat sich geändert. Import abgebrochen, um Matter-Zuordnungen zu erhalten.');
   keys[item.devId]=item.localKey;
   byId.set(item.devId,{...previous,id:item.devId,name:previous?.name||String(item.name||brand+' Gerät').slice(0,64),ip:previous?.ip||'',version:previous?.version||'3.3',exposed:previous?previous.exposed===true:(autoExposeOnline&&item.online===true),onlineCheck:previous?previous.onlineCheck!==false:false,profile:{...caps,...(previous?.profile?.temperature&&caps.temperature?{minKelvin:previous.profile.minKelvin,maxKelvin:previous.profile.maxKelvin}:{})}});imported++;
  }
  if(byId.size>128)fail('Maximal 128 WLAN-Geräte');
  if(!imported){web.sendJson(res,200,{imported:0,unsupported,message:'Keine unterstützten WLAN-Geräte mit lokalem Schlüssel und bestätigten Datenpunkten gefunden'});return true;}
  const next={vaultPath:file,devices:[...byId.values()]},changed=JSON.stringify(next)!==JSON.stringify(old)||JSON.stringify(keys)!==JSON.stringify(vault.read());
  if(changed){vault.write(keys);web.writeConfigPatch(config=>{config[provider]=next;});}
  if(changed)await web.deps.restartBridge();web.sendJson(res,200,{imported,unsupported,message:imported+' WLAN-Geräte importiert. Gewünschte Geräte für Matter freigeben.'});return true;
 }
 if(Object.keys(p).some(k=>!['id','name','ip','version','exposed','onlineCheck','minKelvin','maxKelvin'].includes(k))||!validId(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>64||/[\x00-\x1f]/.test(p.name)||!validIp(p.ip)||!['3.1','3.3','3.4','3.5'].includes(p.version)||typeof p.exposed!=='boolean'||(p.onlineCheck!==undefined&&typeof p.onlineCheck!=='boolean'))fail('Gerätename, lokale WLAN-Adresse, Protokoll und Freigabe prüfen');
 const current=web.security.configSnapshot.read()[provider]?.devices?.find(d=>d.id===p.id);if(!current)throw Object.assign(Error('Gerät nicht gefunden'),{status:404});
 if(current.profile.temperature&&(!Number.isInteger(p.minKelvin)||!Number.isInteger(p.maxKelvin)||p.minKelvin<2000||p.maxKelvin>10000||p.minKelvin>=p.maxKelvin))fail('Farbtemperaturgrenzen zwischen 2000 und 10000 K prüfen');
 const restart=current.name!==p.name.trim()||(current.ip||'')!==p.ip||current.version!==p.version||current.exposed!==p.exposed||(current.profile.temperature&&(current.profile.minKelvin!==p.minKelvin||current.profile.maxKelvin!==p.maxKelvin));
 web.writeConfigPatch(config=>{const d=config[provider].devices.find(d=>d.id===p.id);Object.assign(d,{name:p.name.trim(),ip:p.ip,version:p.version,exposed:p.exposed,...(p.onlineCheck!==undefined?{onlineCheck:p.onlineCheck}:{})});if(d.profile.temperature)Object.assign(d.profile,{minKelvin:p.minKelvin,maxKelvin:p.maxKelvin});});
 if(web.security.monitor){web.security.monitor.generation++;web.security.monitor.incidents.delete(provider+':'+p.id);}
 if(restart)await web.deps.restartBridge();web.sendJson(res,200,{success:true,message:restart?'Gespeichert. Matter-Freigabe übernommen.':'Gespeichert. Matter-Verbindung bleibt aktiv.'});
 }finally{web.wifiSetupBusy=false;}
 }catch(error){web.sendJson(res,error.status||502,{error:error.message});}
 return true;
}
const handleSmartplus=(web,req,res,u)=>handleProvider(web,req,res,u,'smartplus');
const handleSmartlife=(web,req,res,u)=>handleProvider(web,req,res,u,'smartlife');
module.exports={handleSmartplus,handleSmartlife,safeList};

