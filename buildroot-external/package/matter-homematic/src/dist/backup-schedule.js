'use strict';
const fs=require('node:fs'),path=require('node:path');
const calendar=require('./backup-calendar'),{atomicJson,atomicBytes}=require('./durable-storage'),{Vault}=require('./smartplus');
const defaults=()=>({enabled:false,frequency:'daily',time:'03:00',weekday:0,intervalHours:24,timeZone:'Europe/Berlin',destination:'google',includeCcu:true,selected:['names','rooms','ui'],rotateLocal:false,localCopies:2});
const fail=(message,status=400)=>Object.assign(Error(message),{status});
class BackupSchedule{
 constructor(web,{now=Date.now,startJob=(p,owner)=>require('./backup-storage').start(web,p,owner),directory=path.dirname(web.deps.configPath),timer=true}={}){
  this.web=web;this.now=now;this.startJob=startJob;this.file=path.join(directory,'backup-schedule.json');this.vault=new Vault(path.join(directory,'backup-schedule-secrets.json'));this.busy=false;this.stopped=false;this.blocked=false;this.error='';
  if(timer){this.timer=setInterval(()=>this.tick().catch(()=>{this.error='Zeitplan konnte nicht verarbeitet werden.';}),60000);this.timer.unref();this.tick().catch(()=>{});}
 }
 read(){
  if(!fs.existsSync(this.file))return {config:defaults(),anchor:this.now(),lastSlot:null,last:null};
  if(fs.statSync(this.file).size>65536)throw fail('Zeitplan-Datei ist zu groß',503);
  const data=JSON.parse(fs.readFileSync(this.file,'utf8'));calendar.validate(data.config);
  if(!Number.isFinite(data.anchor)||typeof data.lastSlot!=='string'||data.lastSlot.length>40||data.last&&(!Number.isFinite(data.last.at)||!['reserved','running','complete','partial','failed'].includes(data.last.state)))throw fail('Gespeicherter Zeitplan ungültig',503);
  return data;
 }
 status(){
  let data;try{data=this.read();}catch{this.error='Gespeicherter Zeitplan konnte nicht gelesen werden; bitte prüfen und neu speichern.';return {config:defaults(),hasPassword:false,last:null,next:null,error:this.error,blocked:true};}
  let hasPassword=false;try{const password=this.vault.read().password;hasPassword=typeof password==='string'&&password.length>=10&&password.length<=256;}catch{}
  let next=null;try{next=calendar.slot(data.config,this.now(),data.anchor).nextText;}catch{this.error='CCU-Uhrzeit prüfen.';}
  return {config:data.config,hasPassword,last:data.last,next,error:this.error,blocked:this.blocked};
 }
 configure(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['config','password'].includes(k))||typeof input.password!=='string'||input.password.length>256)throw fail('Zeitplan und Sicherungspasswort prüfen');
  let config;try{config=calendar.validate(input.config);}catch(error){throw fail(error.message);}
  if(config.enabled&&config.destination==='icloud-pc')throw fail('Zuerst den iCloud-Synchronisations-PC verbinden.',503);
  if(config.enabled&&config.includeCcu&&!fs.existsSync('/bin/createBackup.sh'))throw fail('Vollständige CCU-Sicherung nur direkt auf der CCU verfügbar',503);
  let stored={};try{stored=this.vault.read();}catch{if(config.enabled&&!input.password)throw fail('Gespeichertes Sicherungspasswort nicht lesbar; neu eingeben',503);}
  const password=input.password||stored.password;
  if(config.enabled&&(typeof password!=='string'||password.length<10||password.length>256))throw fail('Für automatische Sicherungen ein Passwort mit 10–256 Zeichen speichern.');
  const anchor=this.now(),current=config.enabled?calendar.slot(config,anchor,anchor):{key:'disabled'};
  const paths=[this.file,this.vault.file,this.vault.keyFile],previous=new Map(paths.map(file=>[file,fs.existsSync(file)?fs.readFileSync(file):null]));
  try{
   if(input.password){if(input.password.length<10)throw fail('Sicherungspasswort zu kurz');this.vault.write({password:input.password});}
   atomicJson(this.file,{config,anchor,lastSlot:current.key,last:null});
  }catch(error){
   let restored=true;for(const [file,bytes]of previous)try{if(bytes)atomicBytes(file,bytes);else if(fs.existsSync(file))fs.unlinkSync(file);}catch{restored=false;}
   if(!restored)this.blocked=true;
   throw error;
  }finally{input.password='';}
  this.blocked=false;this.error='';
  return this.status();
 }
 async tick(){
  if(this.busy||this.stopped||this.blocked)return;
  this.busy=true;
  try{
   const data=this.read();if(!data.config.enabled)return;
   if(data.last&&this.now()<data.last.at){this.clockBlocked=true;this.error='CCU-Uhrzeit liegt vor der letzten Sicherung. Uhrzeit prüfen; kein doppelter Lauf gestartet.';return;}
   if(this.clockBlocked){this.clockBlocked=false;this.error='';}
   if(typeof this.web.deps.isDiscoveryComplete==='function'&&this.web.deps.isDiscoveryComplete()===false)return;
   if(this.web.cloudBackupStarting||this.web.cloudBackupJob?.state==='running'||this.web.backupBusy||this.web.wifiSetupBusy)return;
   const current=calendar.slot(data.config,this.now(),data.anchor);
   const interrupted=data.last&&['reserved','running'].includes(data.last.state);
   if(interrupted&&this.now()-data.last.at<50*60000)return;
   const retry=data.last?.state==='failed'&&data.last.slot===current.key&&data.last.attempt<3&&this.now()-data.last.at>=3600000;
   if(data.lastSlot===current.key&&!retry&&!interrupted)return;
   const password=this.vault.read().password;if(typeof password!=='string'||password.length<10)throw fail('Gespeichertes Sicherungspasswort fehlt.',503);
   const attempt=data.last?.slot===current.key?(data.last.attempt||0)+1:1;
   if(attempt>3)return;
   data.lastSlot=current.key;data.last={slot:current.key,at:this.now(),state:'reserved',attempt,message:'Sicherung wird vorbereitet.'};
   // Reserve durably before starting work: no duplicate start after a restart.
   try{atomicJson(this.file,data);}catch{this.blocked=true;throw fail('Zeitplan konnte nicht dauerhaft reserviert werden; automatische Sicherung angehalten.',503);}
   let accepted;
   try{
    accepted=await this.startJob({selected:data.config.selected,includeCcu:data.config.includeCcu,destination:data.config.destination,rotateLocal:data.config.rotateLocal,localCopies:data.config.localCopies,password},'schedule');
    data.last.state='running';data.last.jobId=accepted.job.id;data.last.message='Automatische Sicherung läuft.';atomicJson(this.file,data);
    const job=this.web.cloudBackupJob;
    if(!job||job.id!==accepted.job.id||!job.promise)throw Error('Unexpected scheduled job');
    await job.promise;data.last.state=['complete','partial'].includes(job.state)?job.state:'failed';data.last.message=job.message;data.last.finishedAt=this.now();atomicJson(this.file,data);
   }catch(error){data.last.state='failed';data.last.message=error.status?error.message:'Automatische Sicherung fehlgeschlagen; Speicher und Cloud-Anmeldung prüfen.';atomicJson(this.file,data);}
  }catch(error){this.error=error.status?error.message:'Zeitplan oder CCU-Uhrzeit konnte nicht gelesen werden.';}
  finally{this.busy=false;}
 }
 stop(){this.stopped=true;clearInterval(this.timer);}
}
module.exports={BackupSchedule,defaults};
