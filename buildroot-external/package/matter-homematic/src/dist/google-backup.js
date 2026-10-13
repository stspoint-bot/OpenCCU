'use strict';
const fs=require('node:fs/promises'),crypto=require('node:crypto');
const fingerprint=data=>crypto.createHash('sha256').update((data.clientId||'')+'\0'+(data.refreshToken||'')).digest('hex');
const SCOPE='https://www.googleapis.com/auth/drive.file';
const fail=(message,status=502)=>Object.assign(Error(message),{status});
const tokenValid=t=>typeof t==='string'&&t.length>0&&t.length<=8192&&!/[\x00-\x20\x7f]/.test(t);
const fileId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,256}$/.test(id);
class GoogleBackup {
 constructor(vault,{fetchImpl=fetch,now=Date.now}={}){this.vault=vault;this.fetch=fetchImpl;this.now=now;this.pending=new Map();this.access=null;this.controllers=new Set();this.stopped=false;}
 status(){const data=this.vault.read(),needsReconnect=!!data.refreshToken&&this.invalidFingerprint===fingerprint(data);return {clientId:data.clientId||'',hasClientSecret:!!data.clientSecret,connected:!!data.refreshToken&&!needsReconnect,hasStoredConnection:!!data.refreshToken,needsReconnect,folderReady:fileId(data.folderId),...(fileId(data.folderId)?{folderUrl:'https://drive.google.com/drive/folders/'+data.folderId}:{})};}
 credentials(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Ungültige Google-Client-Konfiguration',400);const old=this.vault.read();const clientId=input.clientId?.trim()||old.clientId,clientSecret=input.clientSecret||(clientId===old.clientId?old.clientSecret:'');
  if(typeof clientId!=='string'||!/^\d{6,32}-[a-zA-Z0-9_-]{8,160}\.apps\.googleusercontent\.com$/.test(clientId)||typeof clientSecret!=='string'||clientSecret.length<8||clientSecret.length>256||/[\x00-\x20\x7f]/.test(clientSecret))throw fail('Registrierte Google-Client-ID und Client-Secret für „TVs und Geräte mit eingeschränkter Eingabe“ erforderlich.',400);
  return {clientId,clientSecret};
 }
 async request(url,{method='POST',form,json,token,headers={},body}={}){
  if(this.stopped)throw fail('Google-Sicherungsdienst gestoppt',503);const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);this.controllers.add(controller);
  try{
   const res=await this.fetch(url,{method,redirect:'error',signal:controller.signal,headers:{...(form?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(json?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...headers},...(form?{body:new URLSearchParams(form).toString()}:json?{body:JSON.stringify(json)}:body!==undefined?{body}:{})});
   const chunks=[];let size=0;if(res.body)for await(const part of res.body){size+=part.length;if(size>131072)throw fail('Google-Antwort zu groß');chunks.push(part);}
   const text=Buffer.concat(chunks).toString('utf8');let data={};if(text){try{data=JSON.parse(text);}catch{throw fail('Google lieferte keine gültige Antwort');}}
   if(!data||typeof data!=='object'||Array.isArray(data))throw fail('Ungültige Google-Antwort');
   return {status:res.status,headers:res.headers,data};
  }catch(error){if(error.status)throw error;throw fail('Google ist nicht erreichbar. Verbindung prüfen; keine bestätigte Sicherung melden.');}
  finally{clearTimeout(timer);this.controllers.delete(controller);}
 }
 async begin(session,input){
  for(const [key,value]of this.pending)if(value.expires<=this.now())this.pending.delete(key);
  if(this.pending.has(session))throw fail('Google-Anmeldung läuft bereits. Vorhandenen Code verwenden oder abwarten.',429);
  if(this.pending.size>=8)throw fail('Zu viele Google-Anmeldungen. Später erneut versuchen.',429);
  const client=this.credentials(input),reservation={expires:this.now()+60000,busy:true};this.pending.set(session,reservation);
  try{
   const response=await this.request('https://oauth2.googleapis.com/device/code',{form:{client_id:client.clientId,scope:SCOPE}}),d=response.data;
   if(this.stopped||this.pending.get(session)!==reservation)throw fail('Google-Anmeldung wurde abgebrochen.',409);
   if(response.status!==200)throw fail('Google hat den Anmeldevorgang abgelehnt. Client-Typ, Drive-API und Freigaben im Google-Projekt prüfen.',400);
   if(!tokenValid(d.device_code)||typeof d.user_code!=='string'||!/^[A-Z0-9-]{4,32}$/i.test(d.user_code)||!Number.isInteger(d.expires_in)||d.expires_in<10||d.expires_in>1800||!Number.isInteger(d.interval)||d.interval<1||d.interval>60)throw fail('Ungültiger Google-Anmeldevorgang');
   let url;try{url=new URL(d.verification_url);}catch{throw fail('Ungültige Google-Anmeldeseite');}
   if(url.protocol!=='https:'||url.username||url.password||!['google.com','www.google.com','accounts.google.com'].includes(url.hostname)||url.port||url.href.length>1024)throw fail('Unzulässige Google-Anmeldeseite');
   const challenge={...client,deviceCode:d.device_code,expires:this.now()+d.expires_in*1000,interval:d.interval*1000,next:this.now()+d.interval*1000,busy:false};this.pending.set(session,challenge);
   return {verificationUrl:url.href,userCode:d.user_code,expiresIn:d.expires_in,interval:d.interval};
  }catch(error){if(this.pending.get(session)===reservation)this.pending.delete(session);throw error;}
 }
 async poll(session){
  const c=this.pending.get(session);if(!c||c.expires<=this.now()){this.pending.delete(session);throw fail('Google-Anmeldung abgelaufen. Einen neuen Code anfordern.',400);}
  if(c.busy||this.now()<c.next)return {pending:true,interval:Math.ceil(c.interval/1000)||5};
  c.busy=true;c.next=this.now()+c.interval;
  try{
   const response=await this.request('https://oauth2.googleapis.com/token',{form:{client_id:c.clientId,client_secret:c.clientSecret,device_code:c.deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'}}),d=response.data;
   if(this.stopped||this.pending.get(session)!==c||c.expires<=this.now())throw fail('Google-Anmeldung wurde abgebrochen oder ist abgelaufen.',409);
   if(d.error==='authorization_pending')return {pending:true,interval:Math.ceil(c.interval/1000)};
   if(d.error==='slow_down'){c.interval=Math.min(c.interval+5000,300000);c.next=this.now()+c.interval;return {pending:true,interval:Math.ceil(c.interval/1000)};}
   if(response.status!==200){this.pending.delete(session);throw fail(d.error==='access_denied'?'Google-Anmeldung wurde abgelehnt.':'Google-Anmeldung fehlgeschlagen. Client-Konfiguration und Code prüfen.',400);}
   if(d.token_type!=='Bearer'||!tokenValid(d.access_token)||!tokenValid(d.refresh_token)||!Number.isInteger(d.expires_in)||d.expires_in<1||d.expires_in>86400||typeof d.scope!=='string'||!d.scope.split(' ').includes(SCOPE))throw fail('Google hat keinen gültigen Drive-Zugriff bestätigt');
   // A new login may select a different Google account even with the same
   // OAuth client. Do not retain a folder belonging to the previous account.
   this.vault.write({clientId:c.clientId,clientSecret:c.clientSecret,refreshToken:d.refresh_token});
   this.invalidFingerprint=null;
   this.access={token:d.access_token,expires:this.now()+d.expires_in*1000,fingerprint:fingerprint(this.vault.read())};this.pending.delete(session);return {connected:true};
  }finally{c.busy=false;}
 }
 async accessToken(){
  const data=this.vault.read();if(this.access&&this.access.fingerprint===fingerprint(data)&&this.access.expires>this.now()+60000)return this.access.token;
  if(!tokenValid(data.refreshToken))throw fail('Zuerst Google Drive verbinden.',400);
  const client=this.credentials(data),response=await this.request('https://oauth2.googleapis.com/token',{form:{client_id:client.clientId,client_secret:client.clientSecret,refresh_token:data.refreshToken,grant_type:'refresh_token'}}),d=response.data;
  if(response.status!==200||d.token_type!=='Bearer'||!tokenValid(d.access_token)||!Number.isInteger(d.expires_in)||d.expires_in<1||d.expires_in>86400){if(response.status===401||d.error==='invalid_grant')this.invalidFingerprint=fingerprint(data);throw fail('Google-Drive-Anmeldung konnte nicht erneuert werden. Bei abgelaufener Anmeldung erneut verbinden.',401);}
  this.invalidFingerprint=null;
  this.access={token:d.access_token,expires:this.now()+d.expires_in*1000,fingerprint:fingerprint(data)};return this.access.token;
 }
 stop(){this.stopped=true;for(const controller of this.controllers)controller.abort();this.controllers.clear();this.pending.clear();this.access=null;}
 disconnect(){if(this.uploading)throw fail('Sicherungsübertragung läuft noch',429);this.pending.clear();this.access=null;const data=this.vault.read();this.vault.write({...(data.clientId?{clientId:data.clientId}:{}),...(data.clientSecret?{clientSecret:data.clientSecret}:{})});return {connected:false};}
 async folder(token){
  const stored=this.vault.read();if(fileId(stored.folderId))return stored.folderId;
  const response=await this.request('https://www.googleapis.com/drive/v3/files?fields=id',{token,json:{name:'Matter CCU3 Sicherungen',mimeType:'application/vnd.google-apps.folder'}});
  if(![200,201].includes(response.status)||!fileId(response.data.id))throw fail('Google-Drive-Sicherungsordner konnte nicht bestätigt werden.');
  if(fingerprint(this.vault.read())!==fingerprint(stored))throw fail('Google-Verbindung wurde während der Ordnerprüfung geändert.',409);
  this.vault.write({...stored,folderId:response.data.id});return response.data.id;
 }
 async upload(file,name){
  if(typeof name!=='string'||!/^matter-[A-Za-z0-9_.-]{1,100}\.(tspoint-backup|sbk\.enc)$/.test(name))throw fail('Nur verschlüsselte Matter-/CCU-Sicherungen hochladen.',400);
  if(this.uploading)throw fail('Sicherungsübertragung läuft bereits',429);this.uploading=true;let handle,session;
  try{handle=await fs.open(file,'r');
   const stat=await handle.stat();if(!stat.isFile()||!stat.size||stat.size>512*1048576)throw fail('Sicherungsgröße ist unzulässig.',400);
   const connection=fingerprint(this.vault.read());
   const unchanged=()=>{if(fingerprint(this.vault.read())!==connection)throw fail('Google-Verbindung während der Übertragung geändert; Upload gestoppt.',409);};
   const authorized=async(url,options)=>{unchanged();let token=await this.accessToken();unchanged();let response=await this.request(url,{...options,token});if(response.status===401){this.access=null;unchanged();token=await this.accessToken();unchanged();response=await this.request(url,{...options,token});}return response;};
   const token=await this.accessToken(),folder=await this.folder(token),begin=await authorized('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size',{json:{name,parents:[folder]},headers:{'X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(stat.size)}});
   if(begin.status!==200)throw fail('Google konnte die Sicherungsübertragung nicht starten.');
   try{session=new URL(begin.headers.get('location'));}catch{throw fail('Google lieferte keine gültige Upload-Sitzung');}
   if(session.protocol!=='https:'||session.hostname!=='www.googleapis.com'||session.port||session.username||session.password||session.pathname!=='/upload/drive/v3/files'||session.href.length>4096)throw fail('Unzulässige Google-Upload-Sitzung');
   let offset=0,stalls=0,finalProbes=0;const deadline=this.now()+15*60000;
   while(offset<stat.size){
    if(this.now()>deadline)throw fail('Sicherungsübertragung hat zu lange gedauert.');
    const bytes=Buffer.alloc(Math.min(1048576,stat.size-offset)),read=await handle.read(bytes,0,bytes.length,offset);if(read.bytesRead!==bytes.length)throw fail('Sicherungsdatei änderte sich während der Übertragung.');
    let response;try{response=await authorized(session.href,{method:'PUT',body:bytes,headers:{'Content-Type':'application/octet-stream','Content-Length':String(bytes.length),'Content-Range':`bytes ${offset}-${offset+bytes.length-1}/${stat.size}`}});}catch(error){if(error.status===409||error.status===401)throw error;response=await authorized(session.href,{method:'PUT',body:Buffer.alloc(0),headers:{'Content-Length':'0','Content-Range':'bytes */'+stat.size}});}
    if([200,201].includes(response.status)){if(!fileId(response.data.id)||String(response.data.size)!==String(stat.size))throw fail('Google bestätigte keine vollständige Sicherung.');return {id:response.data.id,name,size:stat.size,url:'https://drive.google.com/file/d/'+response.data.id+'/view'};}
    // Recover ambiguous network/5xx responses by asking for the committed range.
    // Never start a second remote file for a retry of this upload session.
    if(response.status>=500)response=await authorized(session.href,{method:'PUT',body:Buffer.alloc(0),headers:{'Content-Length':'0','Content-Range':'bytes */'+stat.size}});
    if([200,201].includes(response.status)){if(!fileId(response.data.id)||String(response.data.size)!==String(stat.size))throw fail('Google bestätigte keine vollständige Sicherung.');return {id:response.data.id,name,size:stat.size,url:'https://drive.google.com/file/d/'+response.data.id+'/view'};}
    if(response.status!==308)throw fail('Google hat die Sicherungsübertragung nicht bestätigt.');
    const range=/^bytes=0-(\d+)$/.exec(response.headers.get('range')||''),next=range?Number(range[1])+1:0;
    if(!Number.isSafeInteger(next)||next>offset+bytes.length||next>stat.size||next<offset||++stalls>3)throw fail('Ungültiger oder wiederholt ausbleibender Google-Upload-Fortschritt.');
    if(next>offset)stalls=0;offset=next;
    if(offset===stat.size){
     while(finalProbes++<3){const complete=await authorized(session.href,{method:'PUT',body:Buffer.alloc(0),headers:{'Content-Length':'0','Content-Range':'bytes */'+stat.size}});if([200,201].includes(complete.status)){if(!fileId(complete.data.id)||String(complete.data.size)!==String(stat.size))throw fail('Google bestätigte keine vollständige Sicherung.');return {id:complete.data.id,name,size:stat.size,url:'https://drive.google.com/file/d/'+complete.data.id+'/view'};}if(complete.status!==308)throw fail('Google hat den Abschluss der Sicherung nicht bestätigt.');}
    }
   }
   throw fail('Google hat den Abschluss der Sicherung nicht bestätigt.');
  }finally{if(handle)await handle.close();this.uploading=false;}
 }
 async verifyBackupFiles(files){
  const token=await this.accessToken();
  for(const file of files){
   const match=/^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{1,256})\/view$/.exec(file.remote?.url||'');if(!match)return false;
   const handle=await fs.open(file.path,require('node:fs').constants.O_RDONLY|(require('node:fs').constants.O_NOFOLLOW||0));
   let size,digest;try{const stat=await handle.stat();if(!stat.isFile()||stat.size<1||stat.size>512*1048576)return false;size=stat.size;const hash=crypto.createHash('md5'),buffer=Buffer.alloc(1048576);for(let offset=0;offset<size;){const read=await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);if(!read.bytesRead)return false;hash.update(buffer.subarray(0,read.bytesRead));offset+=read.bytesRead;}const after=await handle.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)return false;digest=hash.digest('hex');}finally{await handle.close();}
   // MD5 is used only to compare Google's file checksum, never for passwords.
   const remote=await this.request('https://www.googleapis.com/drive/v3/files/'+match[1]+'?fields=id,size,trashed,md5Checksum',{method:'GET',token});
   if(remote.status!==200||remote.data.id!==match[1]||remote.data.trashed!==false||String(remote.data.size)!==String(size)||remote.data.md5Checksum!==digest)return false;
  }
  return true;
 }
}
module.exports={GoogleBackup,SCOPE};
