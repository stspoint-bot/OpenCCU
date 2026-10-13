'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {Vault}=require('./smartplus'),{GoogleBackup}=require('./google-backup');
const catalog=require('./backup-catalog');
const fail=(message,status=400)=>Object.assign(Error(message),{status});
const secretsFile=web=>path.join(path.dirname(web.deps.configPath),'cloud-backup-secrets.json');
function drive(web){if(!web.googleBackup||web.googleBackup.stopped)web.googleBackup=new GoogleBackup(new Vault(secretsFile(web)));return web.googleBackup;}
function schedule(web){if(!web.backupSchedule||web.backupSchedule.stopped)web.backupSchedule=new (require('./backup-schedule').BackupSchedule)(web);return web.backupSchedule;}
function captureSchedule(web){const plan=new (require('./backup-schedule').BackupSchedule)(web,{timer:false}),data=plan.read(),secret=plan.vault.read();return {config:data.config,...(typeof secret.password==='string'?{password:secret.password}:{})};}
function validateSchedule(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['config','password'].includes(key)))throw fail('Ungültiger Sicherungszeitplan in der Sicherung');
 const config=require('./backup-calendar').validate(value.config);
 if(value.password!==undefined&&(typeof value.password!=='string'||value.password.length<10||value.password.length>256))throw fail('Ungültiges Zeitplan-Passwort in der Sicherung');
 if(config.enabled&&!value.password)throw fail('Passwort für den gespeicherten Zeitplan fehlt');
 return {config,...(value.password?{password:value.password}:{})};
}
function publicJob(j){return j?{id:j.id,state:j.state,message:j.message,created:j.created,files:j.files.map(f=>({name:f.name,label:f.label,download:'/api/?method=downloadCloudBackup&job='+j.id+'&name='+encodeURIComponent(f.name),...(f.remote?{url:f.remote.url}:{})}))}:null;}
function jobStatus(web){return publicJob(web.cloudBackupJob);}
async function cleanup(directory,root){if(path.dirname(directory)!==root||!/^matter-backup-[A-Za-z0-9]{6}$/.test(path.basename(directory))||await fsp.realpath(directory)!==directory)throw Error('Unexpected backup cleanup path');await fsp.rm(directory,{recursive:true,force:true});}
async function start(web,p,owner){
 if(web.cloudBackupStarting)throw fail('Sicherung wird bereits vorbereitet',429);
 web.cloudBackupStarting=true;
 try{return await startReserved(web,p,owner);}finally{web.cloudBackupStarting=false;}
}
async function startReserved(web,p,owner){
 if(web.cloudBackupJob?.state==='running'||web.backupBusy||web.wifiSetupBusy)throw fail('Sicherung oder Geräteeinrichtung läuft bereits',429);
 if(Object.keys(p).some(k=>!['selected','includeCcu','password','destination','rotateLocal','localCopies'].includes(k))||!Array.isArray(p.selected)||typeof p.includeCcu!=='boolean'||!['download','google','icloud','wd'].includes(p.destination)||typeof p.password!=='string'||p.password.length<10||p.password.length>256||(!p.includeCcu&&!p.selected.length))throw fail('Sicherungsbereiche und Passwort mit 10–256 Zeichen prüfen');
 const rotateLocal=p.rotateLocal??false,localCopies=p.localCopies??2;if(typeof rotateLocal!=='boolean'||!Number.isInteger(localCopies)||localCopies<1||localCopies>10||rotateLocal&&p.destination!=='google')throw fail('Lokale Aufbewahrung prüfen');
 const content=p.selected.length?require('./backup').capture(web,p.selected):null;if(p.includeCcu&&!fs.existsSync('/bin/createBackup.sh'))throw fail('Vollständige CCU-Sicherung ist nur direkt auf der CCU möglich',503);
 if(p.destination==='google'&&!drive(web).status().connected)throw fail('Zuerst Google Drive anmelden');
 if(p.destination==='wd'&&!require('./netzspeicher').backupReady(web))throw fail('Zuerst unter System → Netzwerkspeicher (WD) Adresse, Freigabe und Benutzer eintragen.');
 const {root,jobs}=await catalog.initialize(web);if(rotateLocal)await catalog.rotate(web,localCopies,files=>drive(web).verifyBackupFiles(files));if(jobs.length>=catalog.MAX_JOBS)throw fail('Zehn lokale Sicherungen vorhanden. Zuerst herunterladen und einen alten lokalen Eintrag entfernen.',409);
 if(web.security?.stopped)throw fail('Sicherungsdienst wurde gestoppt',503);
 const directory=await fsp.mkdtemp(path.join(root,'matter-backup-'));await fsp.chmod(directory,0o700);
 if(web.security?.stopped){await cleanup(directory,root);throw fail('Sicherungsdienst wurde gestoppt',503);}
 const job={id:crypto.randomBytes(16).toString('hex'),state:'running',created:new Date().toISOString(),owner,files:[],directory,root,message:'Sicherung wird erstellt …'};web.cloudBackupJob=job;
 try{catalog.persist(job);}catch(error){await cleanup(directory,root);web.cloudBackupJob=jobs.at(-1);throw error;}jobs.push(job);
 const controller=new AbortController();web.cloudBackupController=controller;
 job.promise=(async()=>{
  const stamp=job.created.replace(/[^0-9]/g,'').slice(0,14);
  if(content){const file=path.join(directory,'matter-settings-'+stamp+'.tspoint-backup'),envelope=await require('./backup').seal(content,p.password);require('./durable-storage').atomicJson(file,envelope);job.files.push({name:path.basename(file),path:file,label:'Matter-Einstellungen, Geräte und ausgewählte Zugänge'});catalog.persist(job);}
  if(p.includeCcu){job.message='Vollständige native CCU-Sicherung wird erstellt …';const native=await require('./native-backup').create(directory,{signal:controller.signal});if(controller.signal.aborted)throw Error('Backup stopped');const file=path.join(directory,'matter-ccu-'+stamp+'.sbk.enc');await require('./native-backup-crypto').encryptFile(native,file,p.password,{signal:controller.signal});await fsp.unlink(native);job.files.push({name:path.basename(file),path:file,label:'Vollständige CCU3-Sicherung inklusive Zusatzsoftware und Matter-Kopplung'});catalog.persist(job);}
  if(controller.signal.aborted)throw Error('Backup stopped');
  if(p.destination==='wd'){job.message='Verschlüsselte Sicherung wird auf die WD übertragen …';for(const file of job.files){if(controller.signal.aborted)throw Error('Backup stopped');file.stored=await require('./netzspeicher').storeBackup(web,file.path,file.name);catalog.persist(job);}}
  if(p.destination==='google'){job.message='Verschlüsselte Sicherung wird zu Google Drive übertragen …';for(const file of job.files){if(controller.signal.aborted)throw Error('Backup stopped');file.remote=await drive(web).upload(file.path,file.name);catalog.persist(job);}}
  job.state='complete';job.message=p.destination==='wd'?'Alle Sicherungsdateien liegen auf der WD (Freigabe „'+job.files[0]?.stored?.share+'“, Ordner '+(job.files[0]?.stored?.path||'').replace(/\/[^/]*$/,'')+') und wurden nach dem Kopieren vollständig geprüft.':p.destination==='google'?'Google Drive hat alle Sicherungsdateien vollständig bestätigt.':p.destination==='icloud'?'Verschlüsselte Dateien sind bereit. Herunterladen und in der Dateien-App in iCloud Drive ablegen.':'Verschlüsselte Sicherungsdateien sind bereit zum Herunterladen.';
  catalog.persist(job);
  if(rotateLocal)try{await catalog.rotate(web,localCopies,files=>drive(web).verifyBackupFiles(files));}catch{job.message+=' Ältere lokale Kopien bleiben erhalten, weil ihre Cloud-Kopie noch nicht geprüft werden konnte.';catalog.persist(job);}
 })().catch(async error=>{
  // Retain completed encrypted files when a later archive/upload fails.
  // A partial result must remain downloadable, without claiming cloud success.
  job.state=job.files.length?'partial':'failed';
  job.message=job.files.length?'Sicherung nur teilweise abgeschlossen. Vorhandene verschlüsselte Dateien herunterladen; keine vollständige Cloud-Sicherung bestätigt.'+(error.status?' '+error.message:''):error.status?error.message:'Sicherung fehlgeschlagen oder unterbrochen. Keine vollständige Cloud-Sicherung bestätigt.';
  try{await catalog.cleanTransient(job);}catch{console.error('[backup-storage] Plaintext cleanup failed (paths and credentials omitted)');}
  try{catalog.persist(job);}catch{job.message+=' Der Sicherungsverlauf konnte nicht dauerhaft geschrieben werden. Freien Speicher prüfen.';console.error('[backup-storage] Failed job metadata could not be persisted (paths and credentials omitted)');}
 }).finally(()=>{p.password='';if(web.cloudBackupController===controller)web.cloudBackupController=null;});
 return {accepted:true,job:jobStatus(web)};
}
async function handle(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;
 if(!['getBackupStorage','getBackupSchedule','saveBackupSchedule','startGoogleBackupLogin','pollGoogleBackupLogin','disconnectGoogleBackup','createCloudBackup','downloadCloudBackup','deleteCloudBackup'].includes(method))return false;
 try{
  require('./tailscale-backup').requireAdmin(web,req);const owner=web.security.session(req).raw;
  const get=['getBackupStorage','getBackupSchedule','downloadCloudBackup'].includes(method);if(req.method!==(get?'GET':'POST'))throw fail('Falsche HTTP-Methode',405);
  if(method==='getBackupSchedule'){web.sendJson(res,200,schedule(web).status());return true;}
  if(method==='getBackupStorage'){const {jobs}=await catalog.initialize(web);web.sendJson(res,200,{google:drive(web).status(),nativeAvailable:fs.existsSync('/bin/createBackup.sh'),job:jobStatus(web),history:jobs.map(publicJob),categories:require('./backup').labels});return true;}
  if(method==='downloadCloudBackup'){
   const {jobs}=await catalog.initialize(web),job=jobs.find(item=>item.id===u.searchParams.get('job'));if(!job||!['complete','partial'].includes(job.state))throw fail('Sicherung ist nicht verfügbar',404);
   const file=job.files.find(f=>f.name===u.searchParams.get('name'));if(!file)throw fail('Sicherungsdatei nicht gefunden',404);
   const handle=await fsp.open(file.path,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
   try{const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>512*1048576)throw fail('Sicherungsdatei ist ungültig',503);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':String(stat.size),'Content-Disposition':'attachment; filename="'+file.name+'"','Cache-Control':'no-store'});const stream=handle.createReadStream();stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);return true;}catch(error){await handle.close();throw error;}
  }
  const p=await require('./web-security').body(req);
  if(method==='deleteCloudBackup'){if(Object.keys(p).some(k=>!['id','confirmation'].includes(k))||typeof p.id!=='string'||p.confirmation!=='LOKAL ENTFERNEN '+p.id)throw fail('Entfernen der lokalen Sicherung ausdrücklich bestätigen');await catalog.remove(web,p.id);web.sendJson(res,200,{removed:true});return true;}
  if(method==='saveBackupSchedule'){if(p.config?.enabled&&p.config.destination==='google'&&!drive(web).status().connected)throw fail('Zuerst Google Drive anmelden');if(p.config?.enabled&&p.config.destination==='wd'&&!require('./netzspeicher').backupReady(web))throw fail('Zuerst unter System → Netzwerkspeicher (WD) Adresse, Freigabe und Benutzer eintragen.');web.sendJson(res,200,schedule(web).configure(p));return true;}
  if(method==='createCloudBackup'){web.sendJson(res,202,await start(web,p,owner));return true;}
  if(method==='startGoogleBackupLogin'){
   if(Object.keys(p).some(k=>!['clientId','clientSecret'].includes(k)))throw fail('Ungültige Google-Client-Konfiguration');
   try{web.sendJson(res,200,await drive(web).begin(owner,p));}finally{p.clientSecret='';}return true;
  }
  if(Object.keys(p).length)throw fail('Leere Anfrage erforderlich');
  web.sendJson(res,200,method==='pollGoogleBackupLogin'?await drive(web).poll(owner):drive(web).disconnect());
 }catch(error){if(res.headersSent){res.destroy();return true;}web.sendJson(res,error.status||500,{error:error.status?error.message:'Sicherungsablage konnte nicht verarbeitet werden. Speicher und Anmeldung prüfen.'});}
 return true;
}
function validateSecrets(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['clientId','clientSecret','refreshToken','folderId'].includes(k)))throw fail('Ungültige Google-Drive-Zugangsdaten in der Sicherung');
 for(const [key,value]of Object.entries(data))if(typeof value!=='string'||value.length>8192||/[\x00-\x20\x7f]/.test(value))throw fail('Ungültiges Google-Drive-Zugangsfeld');
 if(Object.keys(data).length)new GoogleBackup({read:()=>data}).credentials(data);return data;
}
module.exports={handle,secretsFile,validateSecrets,start,jobStatus,schedule,captureSchedule,validateSchedule};
