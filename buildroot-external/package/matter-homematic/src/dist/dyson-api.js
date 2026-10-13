'use strict';
const fs=require('node:fs'),path=require('node:path'),{Vault}=require('./smartplus'),{DysonCloud}=require('./dyson-cloud'),profile=require('./dyson-profile');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
function publicList(web){
 const config=web.security.configSnapshot.read().dyson||{},states=new Map((web.deps.getDyson?.()?.public()||[]).map(d=>[d.id,d]));
 return {devices:(config.devices||[]).map(d=>({id:d.id,name:d.name,type:d.type,exposed:!!d.exposed,onlineCheck:d.onlineCheck===true,online:false,state:{},...(states.get(d.id)||{})}))};
}
async function importDevices(web,devices){
 const dir=path.dirname(web.deps.configPath),file=path.join(dir,'dyson-secrets.json'),vault=new Vault(file),secrets=vault.read();
 const config=web.security.configSnapshot.read().dyson||{},existing=new Map((config.devices||[]).map(d=>[d.id,d]));
 for(const d of devices){if(!profile.serialValid(d.id)||!profile.TYPES.has(d.type))throw fail('Ungültige Dyson-Gerätekennung');secrets[d.id]=d.credential;
  const old=existing.get(d.id);existing.set(d.id,{id:d.id,type:d.type,name:old?.name||d.name?.trim()||'Dyson',exposed:old?.exposed===true,onlineCheck:old?.onlineCheck===true});}
 if(existing.size>32)throw fail('Maximal 32 Dyson-Geräte unterstützt');profile.validateDevices([...existing.values()],secrets);
 if(web.wifiSetupBusy||web.backupBusy)throw fail('Geräteeinrichtung oder Sicherung läuft bereits',429);
 const before=new Map([web.deps.configPath,file,file+'.key'].map(f=>[f,fs.existsSync(f)?fs.readFileSync(f):null]));web.wifiSetupBusy=true;
 try{vault.write(secrets);web.writeConfigPatch(c=>{c.dyson={devices:[...existing.values()],vaultPath:file};});await web.deps.restartBridge();}
 catch(error){let reverted=true;for(const [f,bytes]of before){try{if(bytes===null){if(fs.existsSync(f)){fs.unlinkSync(f);require('./durable-storage').syncDirectory(path.dirname(f));}}else require('./durable-storage').atomicBytes(f,bytes);}catch{reverted=false;}}
  try{await web.deps.restartBridge();}catch{reverted=false;}console.error('[dyson] Import failed; rollback '+(reverted?'completed':'failed')+' (credentials omitted)');
  throw fail(reverted?'Dyson-Import fehlgeschlagen; vorheriger Stand wiederhergestellt.':'Dyson-Import und Rücksicherung fehlgeschlagen. Dienstprotokoll und Sicherung prüfen.',500);
 }finally{web.wifiSetupBusy=false;}
}
async function handle(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;
 if(!['getDysonDevices','startDysonLogin','finishDysonLogin','addDysonWifi','saveDysonDevice','controlDyson'].includes(method))return false;
 try{
  if(req.method!==(method==='getDysonDevices'?'GET':'POST'))throw fail('Falsche Anfragemethode',405);
  if(method==='getDysonDevices'){web.sendJson(res,200,publicList(web));return true;}
  if(method!=='controlDyson')require('./tailscale-backup').requireAdmin(web,req);
  const p=await require('./web-security').body(req);
  if(method==='controlDyson'){
   const manager=web.deps.getDyson?.();if(!manager)throw fail('Dyson-Dienst wird noch gestartet',503);
   if(Object.keys(p).some(k=>!['id','command'].includes(k))||!profile.serialValid(p.id))throw fail('Ungültiger Dyson-Auftrag');
   web.sendJson(res,200,await manager.control(p.id,p.command));return true;
  }
  const session=web.security.session(req)?.raw;if(!session)throw fail('Administrator-Anmeldung erforderlich',403);
  if(method==='startDysonLogin'){
   if(Object.keys(p).some(k=>!['email','country'].includes(k)))throw fail('Ungültige Anmeldung');
   web.dysonChallenges ||= new Map();for(const [key,c]of web.dysonChallenges)if(c.expires<Date.now())web.dysonChallenges.delete(key);
   const previous=web.dysonChallenges.get(session);if(previous&&Date.now()-previous.created<60000)throw fail('Bitte eine Minute warten, bevor ein neuer Code angefordert wird',429);
   if(web.dysonChallenges.size>=16&&!previous)throw fail('Zu viele Anmeldungen; bitte später versuchen',429);
   const cloud=new (web.deps.DysonCloud||DysonCloud)(),reservation={created:Date.now(),expires:Date.now()+600000,pending:true};web.dysonChallenges.set(session,reservation);
   try{const challenge=await cloud.begin(p.email,p.country);web.dysonChallenges.set(session,{...challenge,created:reservation.created,cloud});}catch(error){if(web.dysonChallenges.get(session)===reservation)web.dysonChallenges.delete(session);throw error;}
   web.sendJson(res,200,{success:true,message:'Dyson-Bestätigungscode wurde angefordert. Bitte E-Mail und Spamordner prüfen.'});return true;
  }
  if(method==='finishDysonLogin'){
   if(Object.keys(p).some(k=>!['password','code'].includes(k)))throw fail('Ungültige Anmeldung');
   const challenge=web.dysonChallenges?.get(session);if(!challenge||challenge.pending)throw fail('Zuerst einen Dyson-Bestätigungscode anfordern');
   if(challenge.busy)throw fail('Dyson-Anmeldung läuft bereits',429);challenge.busy=true;let imported;try{imported=await challenge.cloud.finish(challenge,p.password,p.code);web.dysonChallenges.delete(session);}finally{challenge.busy=false;}
   await importDevices(web,imported.devices);web.sendJson(res,200,{success:true,imported:imported.devices.length,unsupported:imported.unsupported,message:'Dyson-Geräte übernommen. Gewünschte Geräte für Matter freigeben.'});return true;
  }
  if(method==='addDysonWifi'){
   if(Object.keys(p).some(k=>!['ssid','password','name'].includes(k))||typeof p.name!=='string'||!p.name.trim()||p.name.length>64||/[\x00-\x1f]/.test(p.name))throw fail('Dyson-WLAN-Daten und Gerätenamen prüfen');
   await importDevices(web,[{...profile.wifiCredentials(p.ssid,p.password),name:p.name}]);web.sendJson(res,200,{success:true,message:'Dyson-WLAN-Gerät übernommen. Die Adresse wird automatisch gesucht.'});return true;
  }
  if(Object.keys(p).some(k=>!['id','name','exposed','onlineCheck'].includes(k))||!profile.serialValid(p.id)||typeof p.name!=='string'||!p.name.trim()||p.name.length>64||/[\x00-\x1f]/.test(p.name)||typeof p.exposed!=='boolean'||typeof p.onlineCheck!=='boolean')throw fail('Ungültige Dyson-Geräteeinstellungen');
  if(!web.security.configSnapshot.read().dyson?.devices?.some(d=>d.id===p.id))throw fail('Dyson-Gerät nicht gefunden',404);
  const old=web.security.configSnapshot.read().dyson.devices.find(d=>d.id===p.id);
  web.writeConfigPatch(c=>{const d=c.dyson.devices.find(d=>d.id===p.id);Object.assign(d,{name:p.name.trim(),exposed:p.exposed,onlineCheck:p.onlineCheck});});
  if(old.name!==p.name.trim()||old.exposed!==p.exposed)await web.deps.restartBridge();
  web.sendJson(res,200,{success:true,message:'Dyson-Einstellungen gespeichert'});
 }catch(error){web.sendJson(res,error.status||502,{error:error.status?error.message:'Dyson-Einrichtung fehlgeschlagen. Gespeicherte Daten und Dienststatus prüfen.'});}
 return true;
}
module.exports={handle,publicList,importDevices};
