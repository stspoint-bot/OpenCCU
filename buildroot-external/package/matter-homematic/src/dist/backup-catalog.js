'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const {atomicJson}=require('./durable-storage');
const fail=(message,status=503)=>Object.assign(Error(message),{status});
const MAX_JOBS=10,MAX_FILE=512*1048576;
const validName=name=>typeof name==='string'&&/^matter-(settings-\d{14}\.tspoint-backup|ccu-\d{14}\.sbk\.enc)$/.test(name);
function remote(value){if(!value)return undefined;let url;try{url=new URL(value.url);}catch{return undefined;}return url.protocol==='https:'&&url.hostname==='drive.google.com'&&!url.username&&!url.password&&!url.port&&url.href.length<2048?{url:url.href}:undefined;}
async function checkedDirectory(directory,root){
 if(path.dirname(directory)!==root||!/^matter-backup-[A-Za-z0-9]{6}$/.test(path.basename(directory))||await fsp.realpath(directory)!==directory)throw fail('Ungültiger Sicherungspfad');
 const stat=await fsp.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail('Ungültiges Sicherungsverzeichnis');
}
function persist(job){atomicJson(path.join(job.directory,'backup-job.json'),{id:job.id,state:job.state,created:job.created,message:job.message,files:job.files.map(file=>({name:file.name,label:file.label,...(file.remote?{remote:file.remote}:{})}))});}
async function cleanTransient(job){
 await checkedDirectory(job.directory,job.root);
 for(const name of await fsp.readdir(job.directory)){
  if(name!=='native.sbk'&&!/^tmp\.[A-Za-z0-9]{6}$/.test(name)&&!/^matter-ccu-\d{14}\.sbk\.enc\.tmp-[a-f0-9]{16}$/.test(name))continue;
  const filename=path.join(job.directory,name),stat=await fsp.lstat(filename);
  if(stat.isSymbolicLink()||await fsp.realpath(filename)!==filename)throw fail('Unerwartete Verknüpfung in temporärer Sicherung');
  if(stat.isDirectory())await fsp.rm(filename,{recursive:true,force:false});else if(stat.isFile())await fsp.unlink(filename);else throw fail('Unerwartete temporäre Sicherungsdatei');
 }
}
async function initialize(web){
 if(web.backupCatalogPromise)return web.backupCatalogPromise;
 web.backupCatalogPromise=(async()=>{
  const root=await fsp.realpath('/usr/local/tmp'),jobs=[];let examined=0;
  const entries=await fsp.opendir(root);
  for await(const entry of entries){
   if(!/^matter-backup-[A-Za-z0-9]{6}$/.test(entry.name))continue;
   if(++examined>64)throw fail('Zu viele temporäre Sicherungsverzeichnisse. Speicher prüfen.');
   const directory=path.join(root,entry.name);await checkedDirectory(directory,root);
   const manifest=path.join(directory,'backup-job.json');if(!fs.existsSync(manifest))continue;
   const stat=await fsp.lstat(manifest);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw fail('Ungültiger Sicherungsverlauf');
   const data=JSON.parse(await fsp.readFile(manifest,'utf8'));
   if(!data||typeof data.id!=='string'||!/^[a-f0-9]{32}$/.test(data.id)||!['running','complete','partial','failed'].includes(data.state)||typeof data.created!=='string'||!Number.isFinite(Date.parse(data.created))||typeof data.message!=='string'||data.message.length>2048||!Array.isArray(data.files)||data.files.length>2)throw fail('Ungültiger Sicherungsverlauf');
   const files=[];for(const file of data.files){
    if(!validName(file.name)||typeof file.label!=='string'||file.label.length>256)throw fail('Ungültiger Sicherungseintrag');
    const filename=path.join(directory,file.name),s=await fsp.lstat(filename);
    if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>MAX_FILE)throw fail('Gesicherte Datei fehlt oder ist ungültig');
    files.push({name:file.name,label:file.label,path:filename,...(remote(file.remote)?{remote:remote(file.remote)}:{})});
   }
   const job={...data,directory,root,files,recovered:true};
   let discovered=false;
   for(const name of await fsp.readdir(directory)){
    if(!validName(name)||files.some(file=>file.name===name))continue;
    if(files.length>=2)throw fail('Zu viele unerwartete Sicherungsdateien');
    const filename=path.join(directory,name),s=await fsp.lstat(filename);if(!s.isFile()||s.isSymbolicLink()||s.size<1||s.size>MAX_FILE)throw fail('Unerwartete Sicherungsdatei ist ungültig');
    if(name.endsWith('.sbk.enc')){const handle=await fsp.open(filename,'r');try{const magic=Buffer.alloc(8);await handle.read(magic,0,8,0);if(s.size<=52||!magic.equals(require('./native-backup-crypto').MAGIC))throw fail('Unbekannte verschlüsselte CCU-Datei');}finally{await handle.close();}}
    else{if(s.size>3*1048576)throw fail('Unerwartete Matter-Sicherung zu groß');const envelope=JSON.parse(await fsp.readFile(filename,'utf8'));if(envelope.format!=='tspoint-encrypted-backup-v1'||envelope.cipher!=='aes-256-gcm')throw fail('Unbekannte Matter-Sicherungsdatei');}
    files.push({name,label:name.endsWith('.sbk.enc')?'Wiedergefundene verschlüsselte CCU-Sicherung':'Wiedergefundene verschlüsselte Matter-Sicherung',path:filename});discovered=true;
   }
   if(data.state==='running'||discovered){
    job.state=files.length?'partial':'failed';job.message='Sicherung wurde unterbrochen. Nur bereits fertiggestellte verschlüsselte Dateien sind verfügbar.';
    await cleanTransient(job);
    persist(job);
   }
   if(jobs.some(old=>old.id===job.id))throw fail('Doppelter Sicherungseintrag');jobs.push(job);
  }
  jobs.sort((a,b)=>a.created.localeCompare(b.created));web.backupHistory=jobs;if(!web.cloudBackupJob)web.cloudBackupJob=jobs.at(-1);return {root,jobs};
 })();
 try{return await web.backupCatalogPromise;}catch(error){web.backupCatalogPromise=null;throw error;}
}
async function remove(web,id){
 const {root,jobs}=await initialize(web);const job=jobs.find(item=>item.id===id);
 if(!job)throw fail('Sicherung nicht gefunden',404);if(job.state==='running')throw fail('Laufende Sicherung kann nicht entfernt werden',429);
 await checkedDirectory(job.directory,root);await fsp.rm(job.directory,{recursive:true,force:false});jobs.splice(jobs.indexOf(job),1);
 if(web.cloudBackupJob===job)web.cloudBackupJob=jobs.at(-1);
}
async function rotate(web,keep,verify){
 if(!Number.isInteger(keep)||keep<1||keep>MAX_JOBS)throw fail('Ungültige lokale Aufbewahrung');
 const {jobs}=await initialize(web),eligible=jobs.filter(job=>job.state==='complete'&&job.files.length&&job.files.every(file=>file.remote));
 // Keep the most recent complete local copies and retain every partial backup.
 while(eligible.length>keep){const oldest=eligible.shift();if(!await verify(oldest.files))throw fail('Ältere lokale Sicherung bleibt erhalten: Cloud-Datei oder Prüfsumme konnte nicht bestätigt werden.');await remove(web,oldest.id);}
}
module.exports={initialize,persist,remove,cleanTransient,rotate,MAX_JOBS};
