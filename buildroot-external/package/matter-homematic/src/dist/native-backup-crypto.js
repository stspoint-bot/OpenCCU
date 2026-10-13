'use strict';
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),{promisify}=require('node:util'),{pipeline}=require('node:stream/promises');
const derive=promisify(crypto.scrypt),MAGIC=Buffer.from('MCCUSBK1'),HEADER=36,MAX=512*1048576;
const fail=message=>Object.assign(Error(message),{status:400});
async function key(password,salt){if(typeof password!=='string'||password.length<10||password.length>256)throw fail('Sicherungspasswort mit 10–256 Zeichen erforderlich');return derive(password,salt,32,{N:16384,r:8,p:1,maxmem:64*1048576});}
async function publish(temp,destination){const handle=await fsp.open(temp,'r+');try{await handle.sync();}finally{await handle.close();}await fsp.link(temp,destination);await fsp.unlink(temp);require('./durable-storage').syncDirectory(path.dirname(destination));}
async function encryptFile(source,destination,password,{signal}={}){
 const stat=await fsp.stat(source);if(!stat.isFile()||!stat.size||stat.size>MAX-HEADER-16)throw fail('Native CCU-Sicherung hat eine unzulässige Größe');
 const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),header=Buffer.concat([MAGIC,salt,iv]),secret=await key(password,salt),temp=destination+'.tmp-'+crypto.randomBytes(8).toString('hex');
 try{
  const cipher=crypto.createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(header);const output=fs.createWriteStream(temp,{flags:'wx',mode:0o600});output.write(header);
  await pipeline(fs.createReadStream(source,{highWaterMark:262144}),cipher,output,{signal});
  const handle=await fsp.open(temp,'a');try{await handle.write(cipher.getAuthTag());await handle.sync();}finally{await handle.close();}
  const encrypted=await fsp.stat(temp);if(encrypted.size!==stat.size+HEADER+16)throw fail('CCU-Sicherungsdatei hat sich während der Verschlüsselung geändert');
  await publish(temp,destination);return {size:encrypted.size};
 }finally{secret.fill(0);await fsp.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function decryptFile(source,destination,password){
 const handle=await fsp.open(source,'r');let secret,temp;
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size<=HEADER+16||stat.size>MAX)throw fail('Ungültige verschlüsselte CCU-Sicherung');
  const header=Buffer.alloc(HEADER),tag=Buffer.alloc(16);if((await handle.read(header,0,HEADER,0)).bytesRead!==HEADER||(await handle.read(tag,0,16,stat.size-16)).bytesRead!==16||!header.subarray(0,8).equals(MAGIC))throw fail('Unbekanntes CCU-Sicherungsformat');
  secret=await key(password,header.subarray(8,24));const decipher=crypto.createDecipheriv('aes-256-gcm',secret,header.subarray(24));decipher.setAAD(header);decipher.setAuthTag(tag);temp=destination+'.tmp-'+crypto.randomBytes(8).toString('hex');
  try{await pipeline(fs.createReadStream(source,{start:HEADER,end:stat.size-17,highWaterMark:262144}),decipher,fs.createWriteStream(temp,{flags:'wx',mode:0o600}));}catch{throw fail('Sicherungspasswort falsch oder CCU-Sicherung beschädigt');}
  await publish(temp,destination);return {size:stat.size-HEADER-16};
 }finally{await handle.close();secret?.fill(0);if(temp)await fsp.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
module.exports={encryptFile,decryptFile,MAGIC,MAX};
