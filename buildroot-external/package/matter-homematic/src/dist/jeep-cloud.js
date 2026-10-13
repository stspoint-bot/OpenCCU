'use strict';
// Read-only Node port of the EU login/status flow in hass-uconnect/py-uconnect.
// Ergänzt 12.10.2026: Fernbefehle (remoteCommand) für Klima, Motor und Türen.
// Upstream commit and Apache-2.0 attribution are recorded in upstream/.
const crypto=require('node:crypto');
const LOGIN='https://login.jeep.com',API='https://channels.sdpr-01.fcagcv.com';
const TOKEN='https://authz.sdpr-01.fcagcv.com/v2/cognito/identity/token';
const COGNITO='https://cognito-identity.eu-west-1.amazonaws.com/';
// PIN-Dienst für Fahrzeugbefehle (EU), wie py-uconnect brands.py AUTH_EU (öffentlicher App-Schlüssel, kein Nutzergeheimnis).
const MFA='https://mfa.fcl-01.fcagcv.com',MFA_KEY='JWRYW7IYhW9v0RqDghQSx4UcRYRILNmc8zAuh5ys';
const LOGIN_KEY='3_ZvJpoiZQ4jT5ACwouBG5D1seGEntHGhlL0JYlZNtj95yERzqpH4fFyIewVMmmK7j';
const API_KEY='2wGyL6PHec9o1UeLPYpoYa1SkEWqeBur9bLsi24i';
// Fernbefehle mit API-Version wie py-uconnect command.py (Pfad „remote“).
const REMOTE=Object.freeze({ROPRECOND:'v1',ROPRECOND_OFF:'v1',ROHVACON:'v2',ROHVACOFF:'v2',ROCOMFORTON:'v2',ROCOMFORTOFF:'v2',REON:'v1',REOFF:'v1',RDL:'v1',RDU:'v1',ROLIGHTS:'v1'});
const ALLOWED=new Set([LOGIN,new URL(API).origin,new URL(TOKEN).origin,new URL(COGNITO).origin,MFA]);
const fail=(message,status=502)=>Object.assign(Error(message),{status});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const hmac=(key,x)=>crypto.createHmac('sha256',key).update(x).digest();
const encode=x=>encodeURIComponent(x).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const compare=(a,b)=>a<b?-1:a>b?1:0;
function sign(url,method,headers,credentials,{now=new Date(),region='eu-west-1',service='execute-api',body=''}={}){
 const u=new URL(url),date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8);
 const h=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v).trim().replace(/\s+/g,' ')]));
 h.host=u.host;h['x-amz-date']=date;if(credentials.SessionToken)h['x-amz-security-token']=credentials.SessionToken;
 const names=Object.keys(h).sort(compare),query=[...u.searchParams].map(([k,v])=>[encode(k),encode(v)]).sort((a,b)=>compare(a[0],b[0])||compare(a[1],b[1])).map(([k,v])=>k+'='+v).join('&');
 const uri=u.pathname.split('/').map(s=>encode(decodeURIComponent(s))).join('/');
 const canonical=[method,uri,query,names.map(n=>n+':'+h[n]+'\n').join(''),names.join(';'),hash(body)].join('\n');
 const scope=day+'/'+region+'/'+service+'/aws4_request';
 const key=hmac(hmac(hmac(hmac('AWS4'+credentials.SecretKey,day),region),service),'aws4_request');
 h.authorization='AWS4-HMAC-SHA256 Credential='+credentials.AccessKeyId+'/'+scope+', SignedHeaders='+names.join(';')+', Signature='+hmac(key,'AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+hash(canonical)).toString('hex');
 delete h.host;return h;
}
function number(value,min,max){if(typeof value!=='number'&&typeof value!=='string')return null;if(typeof value==='string'&&!/^-?\d+(\.\d+)?$/.test(value))return null;const n=Number(value);return Number.isFinite(n)&&n>=min&&n<=max?n:null;}
function normalize(vehicle,p,now=Date.now()){
 const battery=p?.evInfo?.battery||{},range=battery.distanceToEmpty||{};
 const time=number(p?.timestamp,1,now+300000),soc=number(battery.stateOfCharge,0,100);
 return {vin:vehicle.vin,name:typeof vehicle.nickname==='string'?vehicle.nickname.slice(0,80):'Jeep Compass',model:typeof vehicle.modelDescription==='string'?vehicle.modelDescription.slice(0,80):null,
  year:number(vehicle.tsoModelYear,1990,2100),batteryPercent:soc,
  charging:typeof battery.chargingStatus==='string'?battery.chargingStatus.slice(0,40):null,
  range:number(range.value,0,5000),rangeUnit:['km','mi','KM','MI'].includes(range.unit)?range.unit.toLowerCase():null,
  vehicleUpdatedAt:time===null?null:new Date(time).toISOString(),fetchedAt:new Date(now).toISOString(),
  stale:time===null||now-time>900000,available:soc!==null};
}
class JeepCloud{
 constructor({fetchImpl=fetch,clock=()=>Date.now()}={}){this.fetch=fetchImpl;this.clock=clock;this.cookies=new Map();this.credentials=null;this.uid=null;this.closed=false;}
 headers(){return {'x-clientapp-name':'CWP','x-clientapp-version':'1.0',clientrequestid:crypto.randomBytes(8).toString('hex').toUpperCase(),'x-api-key':API_KEY,locale:'de_de','x-originator-type':'web','content-type':'application/json'};}
 close(){this.closed=true;this.credentials=null;this.uid=null;this.cookies.clear();}
 async request(url,{method='GET',headers={},body,allowArray=false}={}){
  const u=new URL(url);if(this.closed)throw fail('Jeep-Verbindung wurde beendet',401);
  if(!ALLOWED.has(u.origin)||u.protocol!=='https:'||u.username||u.password)throw fail('Unzulässiges Jeep-Ziel',400);
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
  try{
   const cookies=u.origin===LOGIN?[...this.cookies].map(([k,v])=>k+'='+v).join('; '):'';
   const res=await this.fetch(u.href,{method,body,headers:{'User-Agent':'Mozilla/5.0',...headers,...(cookies?{Cookie:cookies}:{})},redirect:'error',signal:ctrl.signal});
   if(!res.ok){
    // Begründung von Uconnect (z. B. debugMsg) kurz aufheben – nur Klartext, gekürzt, ohne Sonderzeichen; nie Token/Kopfzeilen
    let reason='';try{let txt='';if(res.body?.getReader){const rd=res.body.getReader();try{while(txt.length<4096){const {done,value}=await rd.read();if(done)break;txt+=Buffer.from(value).toString('utf8');}}finally{try{await rd.cancel();}catch{}}}else if(typeof res.text==='function')txt=await res.text();txt=txt.slice(0,4096);let j=null;try{j=JSON.parse(txt);}catch{}const pick=j&&typeof j==='object'?[j.debugMsg,j.message,j.errorMessage,j.error_description,j.error,j.errorCode,j.responseStatus].find(v=>typeof v==='string'&&v.trim()):'';reason=String(pick||'').replace(/[^\p{L}\p{N} .,:;_()\/-]/gu,' ').replace(/\s+/g,' ').trim().slice(0,160);}catch{}
    throw Object.assign(fail(res.status===401||res.status===403?'Jeep-Anmeldung oder Berechtigung nicht bestätigt':'Jeep-Dienst nicht erreichbar; später erneut versuchen',res.status===401||res.status===403?401:502),{upstreamStatus:res.status,upstreamReason:reason});
   }
   if(u.origin===LOGIN)for(const cookie of res.headers.getSetCookie?.()||[]){const pair=cookie.split(';')[0],at=pair.indexOf('=');if(at>0&&pair.length<=4096&&this.cookies.size<32)this.cookies.set(pair.slice(0,at),pair.slice(at+1));}
   const reader=res.body.getReader();let size=0;const chunks=[];
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576){await reader.cancel();throw fail('Jeep-Antwort zu groß');}chunks.push(value);}}
   finally{reader.releaseLock();}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('Jeep hat keine gültigen Fahrzeugdaten geliefert');}
   if(!data||typeof data!=='object'||(!allowArray&&Array.isArray(data)))throw fail('Ungültige Jeep-Antwort');
   if(this.closed)throw fail('Jeep-Verbindung wurde beendet',401);return data;
  }catch(e){if(e.status)throw e;throw fail('Jeep-Abfrage fehlgeschlagen oder Zeitlimit erreicht');}finally{clearTimeout(timer);}
 }
 defaults(extra){return {targetEnv:'jssdk',loginMode:'standard',sdk:'js_latest',authMode:'cookie',sdkBuild:'12234',format:'json',APIKey:LOGIN_KEY,...extra};}
 async account(path,params){
  // Credentials stay in the POST body, never in URLs or logs.
  const r=await this.request(LOGIN+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(this.defaults(params)).toString()});
  if(r.statusCode!==200||(r.errorCode!==undefined&&r.errorCode!==0))throw fail('Jeep-Anmeldung nicht bestätigt. Konto, Passwort und erforderliche Bestätigung in der Jeep-App prüfen.',401);
  return r;
 }
 async login(email,password){
  if(typeof email!=='string'||email.length>254||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=='string'||!password||password.length>256)throw fail('Jeep-E-Mail und Passwort prüfen',400);
  try{
   const boot=await this.request(LOGIN+'/accounts.webSdkBootstrap?apiKey='+encode(LOGIN_KEY));if(boot.statusCode!==200)throw fail('Jeep-Anmeldung derzeit nicht verfügbar');
   const account=await this.account('/accounts.login',{loginID:email,password,sessionExpiration:300,include:'profile,data,emails,subscriptions,preferences'});
   if(!/^[\w-]{1,128}$/.test(account.UID||'')||typeof account.sessionInfo?.login_token!=='string')throw fail('Jeep-Konto erfordert eine zusätzliche Bestätigung',401);
   const jwt=await this.account('/accounts.getJWT',{login_token:account.sessionInfo.login_token,fields:'profile.firstName,profile.lastName,profile.email,country,locale,data.disclaimerCodeGSDP'});
   if(typeof jwt.id_token!=='string'||jwt.id_token.length>32768)throw fail('Jeep-Anmeldung unvollständig',401);
   const identity=await this.request(TOKEN,{method:'POST',headers:this.headers(),body:JSON.stringify({gigya_token:jwt.id_token})});
   if(typeof identity.Token!=='string'||typeof identity.IdentityId!=='string'||identity.Token.length>32768||identity.IdentityId.length>256)throw fail('Jeep-Zugangstoken fehlt',401);
   const aws=await this.request(COGNITO,{method:'POST',headers:{'Content-Type':'application/x-amz-json-1.1','X-Amz-Target':'AWSCognitoIdentityService.GetCredentialsForIdentity'},body:JSON.stringify({IdentityId:identity.IdentityId,Logins:{'cognito-identity.amazonaws.com':identity.Token}})});
   const c=aws.Credentials;
   if(!c||!['AccessKeyId','SecretKey','SessionToken'].every(k=>typeof c[k]==='string'&&c[k].length>0&&c[k].length<=32768)||!Number.isFinite(c.Expiration)||c.Expiration*1000<=this.clock()+60000)throw fail('Jeep-Sitzung fehlt oder ist abgelaufen',401);
   this.uid=account.UID;this.credentials=c;this.cookies.clear();
  }catch(e){this.close();throw e;}
 }
 async get(path,params={}){return this.read(path,{params});}
 async read(path,{params={},method='GET',data}={}){
  if(!this.credentials||this.credentials.Expiration*1000<=this.clock()+30000)throw fail('Jeep-Sitzung abgelaufen. Bitte erneut anmelden.',401);
  const url=new URL(API+path);url.search=new URLSearchParams(params).toString();
  const body=data===undefined?undefined:JSON.stringify(data);
  return this.request(url.href,{method,body,allowArray:true,headers:sign(url.href,method,this.headers(),this.credentials,{now:new Date(this.clock()),body:body||''})});
 }
 // Einziger Fahrzeugbefehl: „Fahrzeugdaten aktualisieren“ (DEEPREFRESH über v1, Ersatz v2) – weckt das Auto nur,
 // damit es seinen Zustand an die Cloud meldet. Ablauf wie py-uconnect: PIN prüfen → Befehl mit pinAuth senden.
 async signedPost(base,path,data,apiKey){
  if(!this.credentials||this.credentials.Expiration*1000<=this.clock()+30000)throw fail('Jeep-Sitzung abgelaufen. Bitte erneut anmelden.',401);
  const url=base+path,body=JSON.stringify(data),headers={...this.headers(),'x-api-key':apiKey};
  return this.request(url,{method:'POST',body,headers:sign(url,'POST',headers,this.credentials,{now:new Date(this.clock()),body})});
 }
 async deepRefresh(vin,pin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw fail('Uconnect-PIN muss aus 4 Ziffern bestehen',400);
  let auth;
  try{auth=await this.signedPost(MFA,'/v1/accounts/'+this.uid+'/ignite/pin/authenticate',{pin:Buffer.from(pin,'utf8').toString('base64')},MFA_KEY);}
  catch(e){if(e.upstreamStatus===401||e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect-PIN wurde nicht angenommen. Automatische Aktualisierung angehalten, damit die PIN nicht gesperrt wird.',403),{pinRejected:true});throw e;}
  if(typeof auth?.token!=='string'||!auth.token||auth.token.length>8192)throw Object.assign(fail('Uconnect-PIN wurde nicht bestätigt.',403),{pinRejected:true});
  const send=(version,name)=>this.signedPost(API,'/'+version+'/accounts/'+this.uid+'/vehicles/'+vin+'/ev',{command:name,pinAuth:auth.token},API_KEY);
  // Echte Antworten (11.10.2026): v1 403 „Deep refresh not allowed if the vehicle is not plugged-in“; v2 erlaubt nur „DEEPREFRESH“.
  let r;try{r=await send('v1','DEEPREFRESH');}catch(e){if(e.upstreamStatus!==403)throw e;try{r=await send('v2','DEEPREFRESH');}catch(e2){if(e2.upstreamStatus===403||e2.upstreamStatus===400)throw Object.assign(fail('Uconnect lehnt das Aktualisieren ab – das geht nur, wenn der Jeep am Ladekabel hängt.',409),{notPlugged:true});throw e2;}}
  if(r?.responseStatus!=='pending')throw fail('Das Fahrzeug hat die Aktualisierung nicht angenommen.');
  return {accepted:true,correlationId:typeof r.correlationId==='string'?r.correlationId.slice(0,80):null};
 }
 // Fahrzeug wecken OHNE Ladekabel (Freigabe Thomas 13.10.2026): „VF“ (Standort anfordern, wie „Fahrzeug finden“ in der App;
 // py-uconnect REFRESH_LOCATION: POST /v1/…/vehicles/{vin}/location). Kein Schalten, kein Hupen/Licht – das Auto meldet sich nur.
 // Gleicher PIN-Schutz wie oben (abgelehnte PIN → sofort anhalten).
 async refreshLocation(vin,pin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw fail('Uconnect-PIN muss aus 4 Ziffern bestehen',400);
  let auth;
  try{auth=await this.signedPost(MFA,'/v1/accounts/'+this.uid+'/ignite/pin/authenticate',{pin:Buffer.from(pin,'utf8').toString('base64')},MFA_KEY);}
  catch(e){if(e.upstreamStatus===401||e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect-PIN wurde nicht angenommen. Aktualisierung angehalten, damit die PIN nicht gesperrt wird.',403),{pinRejected:true});throw e;}
  if(typeof auth?.token!=='string'||!auth.token||auth.token.length>8192)throw Object.assign(fail('Uconnect-PIN wurde nicht bestätigt.',403),{pinRejected:true});
  let r;
  try{r=await this.signedPost(API,'/v1/accounts/'+this.uid+'/vehicles/'+vin+'/location',{command:'VF',pinAuth:auth.token},API_KEY);}
  catch(e){if(e.upstreamStatus===403||e.upstreamStatus===400||e.upstreamStatus===404)throw Object.assign(fail('Uconnect lehnt das Anfordern der Fahrzeugdaten ab'+(e.upstreamReason?' – „'+e.upstreamReason+'“':'')+' (HTTP '+e.upstreamStatus+').',409),{upstreamStatus:e.upstreamStatus});throw e;}
  if(r?.responseStatus!=='pending')throw fail('Das Fahrzeug hat die Anfrage nicht angenommen.');
  return {accepted:true,correlationId:typeof r.correlationId==='string'?r.correlationId.slice(0,80):null};
 }
 // Fernbefehle (Klima, Motor, Türen) wie py-uconnect command.py: POST /{v}/accounts/{uid}/vehicles/{vin}/remote.
 // Nur die hier gelisteten Befehle; die Freigabe je Fahrzeug prüft jeep-fernsteuerung.js anhand der „services“.
 async remoteCommand(vin,pin,name){
  const version=REMOTE[name];if(!version)throw fail('Befehl nicht erlaubt',400);
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw fail('Uconnect-PIN muss aus 4 Ziffern bestehen',400);
  let auth;
  try{auth=await this.signedPost(MFA,'/v1/accounts/'+this.uid+'/ignite/pin/authenticate',{pin:Buffer.from(pin,'utf8').toString('base64')},MFA_KEY);}
  catch(e){if(e.upstreamStatus===401||e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect-PIN wurde nicht angenommen. Fernsteuerung angehalten, damit die PIN nicht gesperrt wird.',403),{pinRejected:true});throw e;}
  if(typeof auth?.token!=='string'||!auth.token||auth.token.length>8192)throw Object.assign(fail('Uconnect-PIN wurde nicht bestätigt.',403),{pinRejected:true});
  let r;
  try{r=await this.signedPost(API,'/'+version+'/accounts/'+this.uid+'/vehicles/'+vin+'/remote',{command:name,pinAuth:auth.token},API_KEY);}
  catch(e){if(e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect lehnt den Befehl für dieses Fahrzeug ab'+(e.upstreamReason?' – Begründung von Uconnect: „'+e.upstreamReason+'“':'')+' (HTTP '+e.upstreamStatus+').',409),{reason:e.upstreamReason||'',upstreamStatus:e.upstreamStatus});throw e;}
  if(r?.responseStatus!=='pending')throw fail('Das Fahrzeug hat den Befehl nicht angenommen.');
  return {accepted:true,correlationId:typeof r.correlationId==='string'?r.correlationId.slice(0,80):null};
 }
 // Zeitpläne ins Auto schreiben (Klima-/Ladeplan wie die Jeep-App; Wunsch Thomas 12.10.2026). Am echten Jeep geprüft:
 // POST /v2/…/ev/schedule/ mit {command:'CPPLUS',schedules:[alle Plätze],pinAuth} → 200 „pending“ mit correlationId
 // (ohne command: 400 „requestBody requires property command“). Immer alle Plätze senden, nur der geänderte weicht ab.
 async setSchedules(vin,pin,schedules){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  if(typeof pin!=='string'||!/^\d{4}$/.test(pin))throw fail('Uconnect-PIN muss aus 4 Ziffern bestehen',400);
  if(!Array.isArray(schedules)||!schedules.length||schedules.length>8)throw fail('Ungültige Zeitpläne',400);
  let auth;
  try{auth=await this.signedPost(MFA,'/v1/accounts/'+this.uid+'/ignite/pin/authenticate',{pin:Buffer.from(pin,'utf8').toString('base64')},MFA_KEY);}
  catch(e){if(e.upstreamStatus===401||e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect-PIN wurde nicht angenommen. Fernsteuerung angehalten, damit die PIN nicht gesperrt wird.',403),{pinRejected:true});throw e;}
  if(typeof auth?.token!=='string'||!auth.token||auth.token.length>8192)throw Object.assign(fail('Uconnect-PIN wurde nicht bestätigt.',403),{pinRejected:true});
  let r;
  try{r=await this.signedPost(API,'/v2/accounts/'+this.uid+'/vehicles/'+vin+'/ev/schedule/',{command:'CPPLUS',schedules,pinAuth:auth.token},API_KEY);}
  catch(e){if(e.upstreamStatus===403||e.upstreamStatus===400)throw Object.assign(fail('Uconnect lehnt den Zeitplan ab'+(e.upstreamReason?' – Begründung von Uconnect: „'+e.upstreamReason+'“':'')+' (HTTP '+e.upstreamStatus+').',409),{reason:e.upstreamReason||'',upstreamStatus:e.upstreamStatus});throw e;}
  if(r?.responseStatus!=='pending')throw fail('Das Fahrzeug hat den Zeitplan nicht angenommen.');
  return {accepted:true,correlationId:typeof r.correlationId==='string'?r.correlationId.slice(0,80):null};
 }
 // Zeitpläne des Fahrzeugs lesen (Laden/Vorklimatisieren mit Abfahrtszeit, wie die Jeep-App) – nur lesen, ohne PIN
 // 12.10.2026: v4 liefert für Thomas' Jeep „HTTP 500 DB operation error“ – darum mehrere bekannte Varianten nacheinander
 // (nur GET, nur lesen); die erste mit Inhalt wird gemerkt und künftig zuerst gefragt. Fehler nennt alle Versuche.
 async chargeSchedules(vin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  const base='/accounts/'+this.uid+'/vehicles/'+vin;
  const all=['/v4'+base+'/ev/schedule/','/v3'+base+'/ev/schedule/','/v2'+base+'/ev/schedule/','/v1'+base+'/ev/schedule/','/v1'+base+'/ev/chargeschedule/','/v2'+base+'/ev/departuretimes/','/v1'+base+'/remote/schedules/','/v1'+base+'/hvac/schedule/'];
  const order=this.schedulePath?[this.schedulePath,...all.filter(p=>p!==this.schedulePath)]:all,tried=[];
  for(const p of order){
   try{const r=await this.get(p);if(r&&typeof r==='object'&&Object.keys(r).length){this.schedulePath=p;return {...(Array.isArray(r)?{items:r}:r),_quelle:p.replace(base,'').replace(/\/$/,'')};}tried.push(p.replace(base,'')+': leer');}
   catch(e){if(e.status===401)throw e;tried.push(p.replace(base,'')+': '+(e.upstreamStatus||e.status||'?')+(e.upstreamReason?' '+String(e.upstreamReason).slice(0,40):''));}
  }
  throw Object.assign(fail('Zeitpläne nicht lesbar – versucht: '+tried.join(' | '),502),{upstreamStatus:502});
 }
 // Letzter bekannter Standort (nur lesen, wie py-uconnect): /v1/…/location/lastknown
 async location(vin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  return this.get('/v1/accounts/'+this.uid+'/vehicles/'+vin+'/location/lastknown');
 }
 // Türen/Fenster wie in der Jeep-App (nur lesen, wie py-uconnect): /remote/status – v1 und v2 (je nach Fahrzeug liefert nur eine
 // Variante Inhalt). Ergebnis {v1, v2}; Fehler je Variante als {fehler: HTTP-Status}.
 async remoteStatus(vin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  // Variante mit 404 („gibt es für dieses Fahrzeug nicht“) wird gemerkt und nicht erneut gefragt (12.10.2026: v2 immer 404).
 const one=async v=>{if(this.remoteMissing?.has(v))return {fehler:404};try{return await this.get('/'+v+'/accounts/'+this.uid+'/vehicles/'+vin+'/remote/status');}catch(e){if(e.status===401)throw e;if(e.upstreamStatus===404)(this.remoteMissing||=new Set()).add(v);return {fehler:e.upstreamStatus||e.status||'?'};}};
  return {v1:await one('v1'),v2:await one('v2')};
 }
 // Letzter erfolgreicher Tür-Befehl laut Uconnect-Benachrichtigungen (nur lesen) – auch Befehle aus der Jeep-App.
 // Am echten Jeep belegt (12.10.2026): items[].eventName 'RDL'/'RDU', notification.data.status 'SUCCESS', timestamp (ms).
 async lastDoorCommand(vin){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw fail('Fahrzeug ungültig',400);
  const n=await this.get('/v1/accounts/'+this.uid+'/vehicles/'+vin+'/notifications');
  let best=null;for(const x of (Array.isArray(n?.notifications?.items)?n.notifications.items:[]).slice(0,500)){const at=Number(x?.timestamp);if(!['RDL','RDU'].includes(x?.eventName)||!/^success$/i.test(String(x?.notification?.data?.status||''))||!Number.isFinite(at)||at>this.clock()+300000)continue;if(!best||at>best.at)best={lock:x.eventName==='RDL',at};}
  return best;
 }
 // Rückmeldung zu einem Fernbefehl (nur lesen, wie py-uconnect _poll_correlation_id): /remote/{id}/status, bei 404 die
 // Benachrichtigungen. Ergebnis: 'success' | 'failure' | 'pending'.
 async commandStatus(vin,id){
  if(typeof vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw fail('Ungültige Abfrage',400);
  const judge=s=>{s=String(s||'').toLowerCase();return /^(success|succeeded|completed|complete)$/.test(s)?'success':/^(failure|failed|error|rejected)$/.test(s)?'failure':'pending';};
  try{const r=await this.get('/v1/accounts/'+this.uid+'/vehicles/'+vin+'/remote/'+id+'/status/');return judge(r?.status||r?.responseStatus);}
  catch(e){if(e.upstreamStatus!==404)throw e;}
  const n=await this.get('/v1/accounts/'+this.uid+'/vehicles/'+vin+'/notifications');
  const item=(Array.isArray(n?.notifications?.items)?n.notifications.items:[]).find(x=>x?.correlationId===id);
  return item?judge(item?.notification?.data?.status):'pending';
 }
 async vehicles(){
  const r=await this.get('/v4/accounts/'+this.uid+'/vehicles',{stage:'ALL',sdp:'ALL',brand:'REST'});
  if(!Array.isArray(r.vehicles)||r.vehicles.length>4)throw fail('Ungültige Fahrzeugliste oder mehr als vier Fahrzeuge im Konto');
  const rows=[];
  for(const vehicle of r.vehicles){
   if(typeof vehicle?.vin!=='string'||! /^[A-HJ-NPR-Z0-9]{17}$/.test(vehicle.vin))continue;
   let data,partial=false;
   try{data=await this.get('/v3/accounts/'+this.uid+'/vehicles/'+vehicle.vin+'/status/');}
   catch(e){
    if(e.status===401)throw e;
    if([400,404,502].includes(e.upstreamStatus))try{data=await this.get('/v4/accounts/'+this.uid+'/vehicles/'+vehicle.vin+'/status/');}
    catch(fallback){if(fallback.status===401)throw fallback;partial=true;data={};}
    else{partial=true;data={};}
   }
   const sources={vehicle:{available:true,data:require('./jeep-data').sanitize(vehicle)},status:{available:!partial,data:require('./jeep-data').sanitize(data)}};
   rows.push({...normalize(vehicle,data,this.clock()),partial,sources});
  }
  return rows;
 }
 async details(vehicle){
  const prefix='/accounts/'+this.uid+'/vehicles/'+vehicle.vin,started=this.clock(),sources={...vehicle.sources};
  // These paths and read-only POSTs come from the pinned upstream API client.
  const specs=[['remote','/v1'+prefix+'/remote/status'],['location','/v1'+prefix+'/location/lastknown'],['health','/v1'+prefix+'/vhr/'],['maintenance','/v1'+prefix+'/maintenance/history/'],['notifications','/v1'+prefix+'/notifications'],['stolenStatus','/v1'+prefix+'/svla/status/'],['subscription','/v1'+prefix+'/subscription/'],['chargeSchedule','/v4'+prefix+'/ev/schedule/'],['lastTrip','/v2'+prefix+'/ecocoaching/get-last-trip/','POST'],['trips','/v2'+prefix+'/ecocoaching/get-trips/','POST'],['imageMetadata','/v4'+prefix+'/image/','POST',{imageURLs:[{id:vehicle.vin,width:600,height:340,resp:'png'}]}]];
  for(const [name,path,method='GET',data,params]of specs){
   if(this.clock()-started>=60000){sources[name]={available:false,reason:'Zeitbudget erreicht'};continue;}
   try{const result=await this.read(path,{method,data,params});sources[name]={available:true,data:require('./jeep-data').sanitize(result),fetchedAt:new Date(this.clock()).toISOString()};}
   catch(e){if((e.status===401&&e.upstreamStatus!==403)||this.closed)throw e;sources[name]={available:false,reason:e.upstreamStatus===403?'Quelle nicht freigegeben':e.upstreamStatus===404?'Quelle nicht vorhanden':'Quelle derzeit nicht verfügbar'};}
  }
  return {sources,...require('./jeep-data').catalog(sources),fetchedAt:new Date(this.clock()).toISOString()};
 }
}
module.exports={JeepCloud,sign,normalize,fail};
module.exports.REMOTE=REMOTE;
