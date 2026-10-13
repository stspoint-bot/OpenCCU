'use strict';
const crypto=require('node:crypto');
// LEDVANCE OEM identifiers from FlagX/ha-ledvance-tuya-resync-localkey (MIT).
const CLIENT='fx3fvkvusmw45d7jn8xh',SECRET='A_armptsqyfpxa4ftvtc739ardncett3uy_cgqx3ku34mh5qdesd7fcaru3gx7tyurr';
const md5=text=>crypto.createHash('md5').update(text).digest('hex');
function mobileHash(text){const h=md5(text);return h.slice(8,16)+h.slice(0,8)+h.slice(24,32)+h.slice(16,24);}
function encryptPassword(password,modulus,exponent){
 if(!/^\d{1,1300}$/.test(String(modulus))||!/^\d{1,10}$/.test(String(exponent)))throw Error('Ungültige Anmeldeantwort');
 const n=BigInt(modulus);let e=BigInt(exponent),x=BigInt('0x'+Buffer.from(md5(password)).toString('hex')),r=1n;
 if(n<=x||e<1n||e>65537n)throw Error('Ungültiger Anmeldeschlüssel');
 while(e){if(e&1n)r=r*x%n;x=x*x%n;e>>=1n;}
 let hex=r.toString(16);if(hex.length%2)hex='0'+hex;
 return '0'.repeat(64)+hex;
}
class LedvanceCloud{
 constructor({fetchImpl=fetch}={}){this.fetch=fetchImpl;this.sid=null;this.deadline=0;this.deviceId=crypto.randomBytes(20).toString('hex');}
 async request(action,data,sid=true,query={}){
 if(this.deadline&&Date.now()>=this.deadline)throw Error('LEDVANCE-Gesamtzeitlimit erreicht');
 const params={appVersion:'1.1.6',appRnVersion:'5.14',channel:'oem',deviceId:this.deviceId,platform:'Linux',requestId:crypto.randomUUID(),lang:'de',clientId:CLIENT,osSystem:'9',os:'Android',timeZoneId:'Europe/Berlin',ttid:'sdk_tuya@'+CLIENT,et:'0.0.1',v:'1.0',sdkVersion:'3.10.0',time:String(Math.floor(Date.now()/1000)),a:action};
 Object.assign(params,query);if(sid){if(!this.sid)throw Error('Keine LEDVANCE-Sitzung');params.sid=this.sid;}
 const postData=data===undefined?undefined:JSON.stringify(data),keys=new Set(['a','v','lat','lon','lang','deviceId','imei','imsi','appVersion','ttid','isH5','h5Token','os','clientId','postData','time','requestId','n4h5','sid','sp','et']);
 const signed={...params,...(postData===undefined?{}:{postData})};const message=Object.keys(signed).sort().filter(k=>keys.has(k)).map(k=>k+'='+(k==='postData'?mobileHash(signed[k]):signed[k])).join('||');
 params.sign=crypto.createHmac('sha256',SECRET).update(message).digest('hex');
 let response;
 try{response=await this.fetch('https://a1.tuyaeu.com/api.json?'+new URLSearchParams(params),{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'TY-UA=APP/Android/1.1.6/SDK/null'},body:new URLSearchParams(postData===undefined?{}:{postData}),signal:AbortSignal.timeout(Math.max(1,Math.min(12000,this.deadline?this.deadline-Date.now():12000)))});}catch{throw Error('LEDVANCE-Anmeldedienst nicht erreichbar');}
 if(!response.ok)throw Error('LEDVANCE-Dienst meldet HTTP '+response.status);
 // Bound decoded replies; never report upstream bodies, credentials or session IDs.
 if(!response.body)throw Error('Leere LEDVANCE-Antwort');
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2097152)throw Error('LEDVANCE-Antwort zu groß');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
 let result;try{result=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('Ungültige LEDVANCE-Antwort');}
 if(!result||typeof result!=='object'||Array.isArray(result))throw Error('Ungültige LEDVANCE-Antwort');
 if(!result.success){const code=String(result.errorCode||'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,80);throw Error('LEDVANCE-Anmeldung/Abfrage fehlgeschlagen ('+code+'). Kontoland und App-Zugang prüfen; eventuell wird diese App-Version nicht unterstützt.');}
 return result.result;
 }
 async discover(username,password,countryCode=49){
 // Keep one login/session per instance; reject overlapping account operations.
 if(this.deadline)throw Object.assign(Error('LEDVANCE-Übernahme läuft bereits'),{status:429});
 this.deadline=Date.now()+240000;
 try{
 const token=await this.request('tuya.m.user.email.token.create',{countryCode,email:username},false);
 if(!token||typeof token!=='object')throw Error('Ungültige LEDVANCE-Anmeldeantwort');
 const login=await this.request('tuya.m.user.email.password.login',{countryCode:String(countryCode),email:username,ifencrypt:1,options:'{"group":1}',passwd:encryptPassword(password,token.publicKey,token.exponent),token:token.token},false);
 if(typeof login?.sid!=='string'||!login.sid)throw Error('Ungültige LEDVANCE-Sitzung');this.sid=login.sid;
 const groups=await this.request('tuya.m.location.list');if(!Array.isArray(groups)||groups.length>64)throw Error('Ungültige LEDVANCE-Geräteliste');
 const found=new Map();
 for(const group of groups){if(!group||!['string','number'].includes(typeof group.groupId))throw Error('Ungültige LEDVANCE-Gruppe');const list=await this.request('tuya.m.my.group.device.list',undefined,true,{gid:String(group.groupId)});if(!Array.isArray(list))continue;
  for(const device of list){if(found.size>=128)throw Error('Maximal 128 SMART+-Geräte');if(!device||typeof device.devId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(device.devId)||found.has(device.devId))continue;
   const detail=await this.request('tuya.m.device.get',{devId:device.devId});if(!detail||typeof detail!=='object'||Array.isArray(detail))throw Error('Ungültige LEDVANCE-Geräteantwort');found.set(device.devId,{...detail,online:detail.online===true||(detail.online===undefined&&device.online===true)});
  }
 }
 return [...found.values()];
 }finally{password='';this.sid=null;this.deadline=0;}
 }
}
module.exports={LedvanceCloud,encryptPassword,mobileHash};
