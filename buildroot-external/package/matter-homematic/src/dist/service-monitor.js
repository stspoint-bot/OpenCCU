'use strict';
const path=require('node:path'),net=require('node:net'),fs=require('node:fs');
const {Vault}=require('./smartplus');
function reachable(host,port){return new Promise(resolve=>{let settled=false;const socket=net.createConnection({host,port});const done=value=>{if(settled)return;settled=true;socket.destroy();resolve(value);};socket.setTimeout(2500,()=>done(false));socket.on('connect',()=>done(true));socket.on('error',()=>done(false));});}
class ServiceMonitor{
 constructor(web,{now=Date.now,probe=reachable,fetchImpl=fetch,intervalMs=30000}={}){
  this.sendTail=Promise.resolve();this.sendQueued=0;this.generation=0;this.web=web;this.now=now;this.probe=probe;this.fetch=fetchImpl;this.started=now();this.rows=[];this.incidents=new Map();this.busy=false;this.sending=false;this.stopped=false;this.lastAttempt=0;this.delivery={state:'not-configured'};
  this.vault=new Vault(path.join(path.dirname(web.deps.configPath),'whatsapp-secrets.json'));
  this.historyFile=path.join(path.dirname(web.deps.configPath),'cux-notification-times.json');this.cuxHistory={};
  try{const stored=JSON.parse(fs.readFileSync(this.historyFile,'utf8'));for(const [id,time] of Object.entries(stored))if(/^cux:CUX[A-Za-z0-9_-]{1,60}$/i.test(id)&&Number.isFinite(time)&&time>=0)this.cuxHistory[id]=time;}catch{}
  this.timer=setInterval(()=>this.check().catch(()=>{this.error='Dienstprüfung fehlgeschlagen';}),intervalMs);this.timer.unref();
 }
 settings(){const c=this.web.security.configSnapshot.read().notifications||{};let hasKey=false;try{const stored=this.vault.read();hasKey=!!stored.apiKey&&stored.phone===c.phone;}catch{}return {enabled:c.enabled===true,phone:c.phone||'',delaySeconds:c.delaySeconds??0,hasKey};}
 save(p){
  if(!p||Object.keys(p).some(k=>!['enabled','phone','apiKey','delaySeconds'].includes(k))||typeof p.enabled!=='boolean'||typeof p.phone!=='string'||!(/^\+[1-9]\d{7,14}$/.test(p.phone)||!p.enabled&&p.phone==='')||typeof p.apiKey!=='string'||!/^\d{0,64}$/.test(p.apiKey)||!Number.isInteger(p.delaySeconds)||p.delaySeconds<0||p.delaySeconds>3600)throw Object.assign(Error('Internationale Handynummer (+49…), API-Schlüssel und Wartezeit (0–3600 Sekunden) prüfen'),{status:400});
  const old=this.settings();if(p.enabled&&!p.apiKey&&(!old.hasKey||old.phone!==p.phone))throw Object.assign(Error('CallMeBot-Schlüssel für diese Handynummer erforderlich'),{status:400});
  if(p.apiKey)this.vault.write({...this.vault.read(),apiKey:p.apiKey,phone:p.phone});
  this.web.writeConfigPatch(c=>{c.notifications={enabled:p.enabled,phone:p.phone,delaySeconds:p.delaySeconds};});
  p.apiKey='';this.generation++;this.incidents.clear();this.started=this.now();return this.settings();
 }
 async collect(){
  const c=this.web.deps.getConnector(),host=this.web.deps.getCcuHost(),interfaces=this.web.getInterfaces().interfaces;
  const rows=[{id:'web',name:'Matter-Weboberfläche',status:'online',detail:'Webdienst antwortet'},{id:'matter',name:'Matter-Bridge',status:this.web.deps.isMatterOnline?.()===true?'online':'offline',detail:'Zustand des Matter-Netzwerkdienstes'}];
  rows.push(await require('./vpn-status').status());
  const tests=[{id:'ccu',name:'CCU-Webdienst',port:80}];
  for(const [name,i] of Object.entries(interfaces)){
   if(!i.enabled){rows.push({id:'interface:'+name,name,status:'disabled',detail:'In den Einstellungen deaktiviert'});continue;}
   if(!i.active){rows.push({id:'interface:'+name,name,status:'pending',detail:'Bridge-Neustart erforderlich'});continue;}
   tests.push({id:'interface:'+name,name,port:i.port,connected:c.clients.has(name)&&!c.failedInterfaces.has(name)});
  }
  const result=await Promise.all(tests.map(async t=>({...t,ok:await this.probe(host,t.port)})));
  rows.push(...result.map(t=>({id:t.id,name:t.name,status:t.ok&&t.connected!==false?'online':'offline',detail:'TCP-Port '+t.port+(t.connected===false?' / RPC-Verbindung fehlt':'')})));
  const config=this.web.security.configSnapshot.read();
  for(const provider of ['smartplus','smartlife']){
   const configured=config[provider]?.devices||[],manager=this.web.deps[provider==='smartplus'?'getSmartplus':'getSmartlife']?.(),states=new Map((manager?.public()||[]).map(d=>[d.id,d]));
   for(const d of configured)if(!require('./device-exclusions').excluded(d))rows.push({id:provider+':'+d.id,name:(provider==='smartplus'?'SMART+':'Smart Life')+' · '+d.name,status:states.get(d.id)?.online===true?'online':'offline',notifyEnabled:d.onlineCheck!==false,detail:d.exposed?'Für Matter freigegeben':'Nur lokale Bedienung'});
  }
  for(const d of require('./dyson-api').publicList(this.web).devices)rows.push({id:'dyson:'+d.id,name:'Dyson · '+d.name,status:d.online?'online':'offline',notifyEnabled:d.onlineCheck===true,detail:d.exposed?'Für Matter freigegeben':'Nur lokale Bedienung'});
  const jeep=this.web.jeepService?.public();
  rows.push({id:'jeep',name:'Jeep · Cloud-Daten',status:jeep?.connected===true?'online':'disabled',detail:jeep?.connected===true?'Angemeldet; Fahrzeugmeldungen können zeitversetzt sein':'Nicht angemeldet',notifyEnabled:false});
  rows.push(...await require('./cuxd-monitor').collect(this.web,this,this.ping));return require('./offline-exclusions').decorate(this.web,rows);
 }
 async check(){if(this.busy||this.stopped)return;this.busy=true;try{
  this.rows=(await this.collect()).filter(r=>!r.id.startsWith('cux:')||require('./cuxd-monitor').settings(this.web)[r.id.slice(4)]?.enabled===true);this.checkedAt=new Date(this.now()).toISOString();this.error=null;if(this.stopped)return;
  const settings=this.settings(),now=this.now(),present=new Set(this.rows.map(r=>r.id));
  for(const id of this.incidents.keys())if(!present.has(id))this.incidents.delete(id);
  for(const row of this.rows){if(row.status!=='offline'||row.notifyEnabled===false||row.warningIgnored){this.incidents.delete(row.id);continue;}if(!this.incidents.has(row.id))this.incidents.set(row.id,{since:now,notified:false});}
  if(!settings.enabled)return;
  const due=this.rows.filter(r=>{const i=this.incidents.get(r.id);if(!i||now-i.since<settings.delaySeconds*1000)return false;return r.id.startsWith('cux:')?this.cuxHistory[r.id]===undefined||now-this.cuxHistory[r.id]>=6*3600000:!i.notified;});
  if(!due.length)return;
  const generation=this.generation;
  const prefix='TSPoint-Bridge · '+new Date(now).toLocaleString('de-DE')+'\n'+(settings.delaySeconds?'Offline seit mindestens '+settings.delaySeconds+' Sekunden:':'Offline bei der aktuellen Prüfung:')+'\n';
  const batches=[];let batch=[],length=prefix.length;
  for(const row of due){const name=String(row.name).slice(0,2048);if(batch.length&&length+name.length+1>2800){batches.push(batch);batch=[];length=prefix.length;}batch.push({...row,name});length+=name.length+1;}if(batch.length)batches.push(batch);
  for(const group of batches){if(this.stopped)break;
   await this.send('',{beforeStart:()=>{
    if(this.stopped||generation!==this.generation||!this.settings().enabled)return false;
    const current=group.filter(row=>this.incidents.has(row.id)&&!require('./offline-exclusions').ignored(this.web,row.id)&&require('./wifi-devices').alertEnabled(this.web,row.id)&&(!row.id.startsWith('cux:')||require('./cuxd-monitor').settings(this.web)[row.id.slice(4)]?.enabled===true));
    if(!current.length)return false;
    // Mark only devices included in a request that is actually about to start.
    // An ambiguous transport failure is not automatically replayed.
    const attempt=this.now();this.lastAttempt=attempt;
    const history={...this.cuxHistory};
    for(const row of current)if(row.id.startsWith('cux:'))history[row.id]=attempt;
    if(current.some(row=>row.id.startsWith('cux:')))require('./web-security').atomicJson(this.historyFile,history);
    this.cuxHistory=history;
    for(const row of current)this.incidents.get(row.id).notified=true;
    return prefix+current.map(row=>row.name).join('\n');
   }}).catch(()=>{if(this.delivery.state!=='failed')this.error='Benachrichtigung konnte nicht gestartet werden; Einstellungen und freien Speicher prüfen';});
  }

 }finally{this.busy=false;}}
 send(message,options={}){
  if(this.stopped)return Promise.reject(Object.assign(Error('Dienst gestoppt'),{status:503}));
  if(this.sendQueued>=16)return Promise.reject(Object.assign(Error('Versandwarteschlange voll'),{status:429}));
  this.sendQueued++;
  const result=this.sendTail.then(()=>this.sendNow(message,options));
  this.sendTail=result.catch(()=>{});return result.finally(()=>this.sendQueued--);
 }
 async sendNow(message,{beforeStart}={}){
  if(this.stopped)throw Object.assign(Error('Dienst gestoppt'),{status:503});
  if(this.sending)throw Object.assign(Error('WhatsApp-Versand läuft bereits'),{status:429});
  const settings=this.settings();let key,phone=settings.phone;try{const stored=this.vault.read();if(settings.hasKey)key=stored.apiKey;}catch{}if(!key||!/^\+[1-9]\d{7,14}$/.test(phone))throw Object.assign(Error('Handynummer und CallMeBot-Schlüssel zuerst speichern'),{status:400});
  if(beforeStart){message=beforeStart();if(message===false)return {state:'skipped'};}
  if(typeof message!=='string'||message.length>3000)throw Object.assign(Error('Nachricht zu lang'),{status:400});
  this.sending=true;this.delivery={state:'sending',at:new Date(this.now()).toISOString()};
  try{const url=new URL('https://api.callmebot.com/whatsapp.php');url.search=new URLSearchParams({phone,text:message,apikey:key}).toString();
   const response=await this.fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000)});
   const reader=response.body.getReader();let length=0,text='';try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>65536)throw Error();text+=Buffer.from(value).toString();}}finally{await reader.cancel().catch(()=>{});}
   if(!response.ok||/\b(error|failed|invalid|not activated)\b/i.test(text))throw Error();
   this.delivery={state:'accepted',at:new Date(this.now()).toISOString(),message:'CallMeBot hat die Anfrage angenommen; Zustellung in WhatsApp prüfen'};return this.delivery;
  }catch{this.delivery={state:'failed',at:new Date(this.now()).toISOString(),message:'Versand nicht bestätigt. Internet, CallMeBot-Aktivierung und Schlüssel prüfen. Kein sofortiger Wiederholversuch; CUxD-Ausfälle werden nach sechs Stunden erneut gemeldet.'};throw Object.assign(Error(this.delivery.message),{status:502});}
  finally{this.sending=false;}
 }
 status(){return {checkedAt:this.checkedAt||null,services:this.rows,error:this.error||null,settings:this.settings(),cuxChecks:require('./cuxd-monitor').publicSettings(this.web,this),delivery:this.delivery};}
 stop(){this.stopped=true;clearInterval(this.timer);}
}
async function handleServices(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;if(!['getServiceStatus','saveNotifications','testNotification','saveCuxCheck','saveOfflineWarning'].includes(method))return false;
 if(req.method!==(method==='getServiceStatus'?'GET':'POST')){web.sendJson(res,405,{error:'HTTP-Methode nicht erlaubt'});return true;}
 try{const monitor=web.security.monitor;if(method==='getServiceStatus'){if(!monitor.checkedAt)await monitor.check();web.sendJson(res,200,monitor.status());}
 else{const p=await require('./web-security').body(req);if(method==='saveOfflineWarning'){require('./tailscale-backup').requireAdmin(web,req);require('./offline-exclusions').save(web,monitor,p);monitor.rows=require('./offline-exclusions').decorate(web,monitor.rows);web.sendJson(res,200,{saved:true});}else if(method==='saveCuxCheck'){require('./cuxd-monitor').save(web,monitor,p);await monitor.check();web.sendJson(res,200,{cuxChecks:require('./cuxd-monitor').publicSettings(web,monitor)});}else if(method==='saveNotifications')web.sendJson(res,200,{settings:monitor.save(p)});
 else{if(Object.keys(p).length)throw Object.assign(Error('Ungültige Testanfrage'),{status:400});if(monitor.lastTest&&monitor.now()-monitor.lastTest<60000)throw Object.assign(Error('Testnachricht frühestens nach einer Minute erneut senden'),{status:429});monitor.lastTest=monitor.now();web.sendJson(res,200,await monitor.send('TSPoint-Bridge · Testnachricht\nDie WhatsApp-Benachrichtigung ist eingerichtet.'));}}
 }catch(e){web.sendJson(res,e.status||502,{error:e.message});}return true;
}
module.exports={ServiceMonitor,handleServices,reachable};
