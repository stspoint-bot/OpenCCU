'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process');
const fail=message=>Object.assign(Error(message),{status:503});
let active=null;
async function create(directory,{spawnImpl=spawn,script='/bin/createBackup.sh',timeoutMs=900000,signal}={}){
 if(active)throw fail('Ein natives CCU-Sicherungsprogramm läuft oder wird noch beendet.');
 const ticket={child:null,closed:false};active=ticket;
 try{
 if(signal?.aborted)throw fail('CCU-Sicherung abgebrochen');if(!fs.existsSync(script))throw fail('Das native CCU-Sicherungsprogramm ist nicht verfügbar. Die CCU-WebUI verwenden.');
 const real=await fsp.realpath(directory);if(real!==path.resolve(directory))throw fail('Sicherungsverzeichnis enthält eine unerwartete Verknüpfung');
 // The vendor script temporarily holds compressed contents and the final SBK;
 // encryption then holds the SBK and its ciphertext. Budget both plus headroom.
 const stat=await fsp.statfs(real);if(Number(stat.bavail)*Number(stat.bsize)<1088*1048576)throw fail('Für eine vollständige verschlüsselte CCU-Sicherung sind mindestens 1088 MiB freier temporärer Speicher erforderlich.');
 const output=path.join(real,'native.sbk');
 await new Promise((resolve,reject)=>{
  let child,timer,killTimer,finished=false,failed=false,size=0,abort=()=>{};
  const kill=signal=>{try{if(child&&Number.isInteger(child.pid)&&child.pid>1){if(process.platform==='win32')child.kill(signal);else process.kill(-child.pid,signal);}}catch{}};
  const finish=error=>{if(finished)return;finished=true;clearTimeout(timer);clearTimeout(killTimer);if(failed)kill('SIGKILL');signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
  try{child=spawnImpl(script,[output],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});ticket.child=child;}catch{finish(fail('CCU-Sicherung konnte nicht gestartet werden'));return;}
  abort=()=>{if(finished)return;failed=true;kill('SIGTERM');if(!killTimer)killTimer=setTimeout(()=>{kill('SIGKILL');finish(fail('CCU-Sicherung wurde wegen Zeitlimit oder Abbruch beendet. Das Sicherungsprogramm muss vor einem neuen Lauf vollständig schließen.'));},2000);};signal?.addEventListener('abort',abort,{once:true});
  const overflow=part=>{size+=part.length;if(size>65536){abort();}};
  child.stdout.on('data',overflow);child.stderr.on('data',overflow);
  child.once('error',()=>finish(fail('CCU-Sicherungsprogramm konnte nicht ausgeführt werden')));
  child.once('close',code=>{ticket.closed=true;if(active===ticket)active=null;finish(!failed&&code===0?null:fail('CCU-Sicherung ist fehlgeschlagen oder hat das Zeitlimit überschritten. Keine vollständige Sicherung bestätigt.'));});
  timer=setTimeout(abort,timeoutMs);if(signal?.aborted)abort();
 });
 const result=await fsp.lstat(output);if(!result.isFile()||result.isSymbolicLink()||result.size<1024||result.size>512*1048576-52)throw fail('Natives CCU-Sicherungsarchiv fehlt oder hat eine unzulässige Größe');
 await fsp.chmod(output,0o600);return output;
 }finally{if(active===ticket&&(!ticket.child||ticket.closed))active=null;}
}
module.exports={create};
