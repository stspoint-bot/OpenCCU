'use strict';
// Backup only the persistent FileStore, not executables, temporary sockets,
// login links, CGI signing tokens, RAM logs, or incoming Taildrop files.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const LIMIT=512*1024;
const fail=message=>Object.assign(Error(message),{status:400});
function options(web){
 // Dependency injection is internal/test-only; no path is accepted from backup data.
 return web.deps.tailscaleBackup||{directory:'/usr/local/etc/config/addons/tspoint-tailscale',service:'/usr/local/etc/config/rc.d/tspoint-tailscale'};
}
function machine(web){
 const injected=options(web).machine;
 if(injected)return injected();
 let mac;
 try{mac=fs.readFileSync('/sys/class/net/eth0/address','utf8').trim();}catch{mac=(os.networkInterfaces().eth0||[]).find(n=>n.mac)?.mac;}
 if(typeof mac!=='string'||!/^([a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(mac)||mac==='00:00:00:00:00:00')throw fail('CCU-Gerätekennung für die VPN-Sicherung nicht verfügbar');
 return crypto.createHash('sha256').update('tspoint-ccu-eth0-v1:'+mac.toLowerCase()).digest('hex');
}
function readState(file){
 let fd;
 try{
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>LIMIT)throw fail('Tailscale-Zustandsdatei ist ungültig oder zu groß');
  const value=fs.readFileSync(fd);if(value.length>LIMIT)throw fail('Tailscale-Zustandsdatei zu groß');return value;
 }catch(e){if(e.code==='ENOENT')return null;throw e;}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
function stateObject(bytes){
 let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw fail('Tailscale-Zustandsdatei enthält kein gültiges JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>4096)throw fail('Ungültiger Tailscale-Zustand');
 for(const [key,encoded]of Object.entries(value)){
  if(['__proto__','constructor','prototype'].includes(key)||key.length>1024||typeof encoded!=='string'||encoded.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)||Buffer.from(encoded,'base64').toString('base64')!==encoded)throw fail('Ungültiger Tailscale-Speicherwert');
 }
 return value;
}
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['format','present','machine','state','accessMode'].includes(k))||value.format!=='tspoint-tailscale-state-v1'||typeof value.present!=='boolean')throw fail('Ungültige Tailscale-Sicherung');
 if(value.accessMode!==undefined&&!['ccu','lan'].includes(value.accessMode))throw fail('Ungültige VPN-Zugriffsauswahl');
 if(!value.present){if(value.machine!==null||value.state!==null)throw fail('Ungültige leere Tailscale-Sicherung');return value;}
 if(!/^[a-f0-9]{64}$/.test(value.machine||'')||typeof value.state!=='string'||value.state.length>Math.ceil(LIMIT/3)*4||value.state.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.state))throw fail('Ungültige Tailscale-Sicherung');
 const raw=Buffer.from(value.state,'base64');if(raw.length>LIMIT||raw.toString('base64')!==value.state)throw fail('Ungültige Tailscale-Sicherung');stateObject(raw);return value;
}
function capture(web){
 const o=options(web),bytes=readState(path.join(o.directory,'tailscaled.state'));
 const hasMode=bytes!==null||fs.existsSync(path.join(o.directory,'access-mode'))||fs.existsSync(o.service);
 const settings=hasMode?{accessMode:readMode(o.directory)}:{};
 if(bytes===null)return {format:'tspoint-tailscale-state-v1',present:false,machine:null,state:null,...settings};
 stateObject(bytes);return validate({format:'tspoint-tailscale-state-v1',present:true,machine:machine(web),state:bytes.toString('base64'),...settings});
}
function readMode(directory){const value=readState(path.join(directory,'access-mode'));if(value===null)return 'ccu';const mode=value.toString('utf8').trim();if(value.length>16||!['ccu','lan'].includes(mode))throw fail('Ungültige VPN-Zugriffsauswahl');return mode;}
function preview(web,value){
 validate(value);
 const scope=value.accessMode==='lan'?' Zugriff: gesamtes lokales Heimnetz der Ziel-CCU.':value.accessMode==='ccu'?' Zugriff: nur die Ziel-CCU.':'';
 if(!value.present)return 'Keine gespeicherte Tailscale-Anmeldung in dieser Sicherung.'+scope;
 if(value.machine!==machine(web))return 'Andere CCU: VPN-Identität wird nicht übernommen. Die eigene Anmeldung der Ziel-CCU bleibt erhalten.'+scope;
 return 'Dieselbe CCU: gespeicherte VPN-Anmeldung und Einstellungen werden wiederhergestellt. Fernzugriff wird dabei kurz unterbrochen.'+scope;
}
function exec(service,args){return new Promise((resolve,reject)=>execFile(service,args,{timeout:35000,maxBuffer:8192,env:{PATH:'/usr/bin:/bin',LANG:'C'}},e=>e?reject(e):resolve()));}
function normalizedState(value){
 const state=stateObject(Buffer.from(value.state,'base64'));
 // Never advertise a formerly assigned LAN address after restoring a backup.
 // The supervisor publishes the current CCU or LAN route according to access-mode.
 for(const [key,encoded]of Object.entries(state)){
  let prefs;try{prefs=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{continue;}
  if(prefs&&typeof prefs==='object'&&!Array.isArray(prefs)&&Object.hasOwn(prefs,'AdvertiseRoutes')){
   prefs.AdvertiseRoutes=[];prefs.CorpDNS=false;prefs.RouteAll=false;prefs.RunSSH=false;
   state[key]=Buffer.from(JSON.stringify(prefs)).toString('base64');
  }
 }
 return state;
}
function transaction(web,value){
 validate(value);
 const note=preview(web,value),o=options(web),file=path.join(o.directory,'tailscaled.state'),modeFile=path.join(o.directory,'access-mode');
 const restoreIdentity=value.present&&value.machine===machine(web);
 const mode=value.accessMode??(restoreIdentity?'ccu':undefined);
 const changeMode=mode!==undefined&&mode!==readMode(o.directory);
 if(!restoreIdentity&&!changeMode)return {note,async apply(){},async rollback(){},release(){}};
 if(!fs.existsSync(o.service))throw fail('Tailscale-Add-on zuerst auf dieser CCU installieren');
 const command=o.exec||exec;
 let locked=false,stopped=false,wasRunning=false,before,beforeMode;
 const lock=path.join(o.directory,'action.lock');
 function release(){if(!locked)return;try{try{fs.unlinkSync(path.join(lock,'owner.json'));}catch(e){if(e.code!=='ENOENT')throw e;}fs.rmdirSync(lock);}finally{locked=false;}}
 async function apply(){
  fs.mkdirSync(o.directory,{recursive:true,mode:0o700});fs.chmodSync(o.directory,0o700);
  if(fs.existsSync(lock)){
   let owner;try{owner=JSON.parse(fs.readFileSync(path.join(lock,'owner.json'),'utf8'));}catch{}
   let alive=false;if(Number.isSafeInteger(owner?.pid)&&owner.pid>1){try{process.kill(owner.pid,0);alive=true;}catch(e){alive=e.code==='EPERM';}}
   if(!alive&&Date.now()-fs.statSync(lock).mtimeMs>60000){try{fs.unlinkSync(path.join(lock,'owner.json'));}catch(e){if(e.code!=='ENOENT')throw e;}fs.rmdirSync(lock);}
  }
  try{fs.mkdirSync(lock,{mode:0o700});locked=true;fs.writeFileSync(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});}
  catch(e){if(e.code==='EEXIST')throw Object.assign(Error('Tailscale-Verwaltung läuft bereits; bitte warten'),{status:429});throw e;}
  try{await command(o.service,['status']);wasRunning=true;}catch(e){if(e.code!==1)throw e;}
  // Mark before issuing stop: even a partially failed stop needs recovery.
  stopped=true;await command(o.service,['stop']);
  before=readState(file);
  beforeMode=readState(modeFile);
  if(restoreIdentity)require('./durable-storage').atomicJson(file,normalizedState(value));
  else if(before!==null)require('./durable-storage').atomicJson(file,normalizedState({state:before.toString('base64')}));
  if(mode!==undefined)atomicBytes(modeFile,Buffer.from(mode+'\n'));
  if(wasRunning)await command(o.service,['start']);
 }
 async function rollback(){
  if(!stopped)return;
  await command(o.service,['stop']);
  if(before!==undefined){if(before===null){try{fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}else atomicBytes(file,before);}
  if(beforeMode!==undefined){if(beforeMode===null){try{fs.unlinkSync(modeFile);}catch(e){if(e.code!=='ENOENT')throw e;}}else atomicBytes(modeFile,beforeMode);}
  if(wasRunning)await command(o.service,['start']);
 }
 return {note,apply,rollback,release};
}
function atomicBytes(file,value){
 const temp=file+'.restore-'+crypto.randomBytes(8).toString('hex');let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,value);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);require('./durable-storage').syncDirectory(path.dirname(file));}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function requireAdmin(web,req){const session=web.security.session(req)?.session;if(!session||session.localBypass)throw Object.assign(Error('Für Zugangsdaten und Datensicherungen ist eine CCU-Administrator-Anmeldung erforderlich. Auf der Sicherungsseite „Als Administrator anmelden“ wählen.'),{status:403});}
module.exports={capture,validate,preview,transaction,requireAdmin,normalizedState};
