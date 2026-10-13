'use strict';
const fs=require('node:fs'), path=require('node:path'), http=require('node:http'), crypto=require('node:crypto'), os=require('node:os');
const {atomicJson}=require('./web-security');
const escape = value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function params(raw) {
  const values=new URLSearchParams(raw);const result={};
  for(const [key,value] of values) {if(Object.hasOwn(result,key))throw Error('Doppelte Formularfelder');result[key]=value;}
  return result;
}
function sidValue(value) {
  const sid=typeof value==='string'?value.replace(/^@([A-Za-z0-9]{10})@$/,'$1'):'';
  if(!/^[A-Za-z0-9]{10}$/.test(sid))throw Error('Ungültige CCU-Sitzung. Einstellungen aus der Zusatzsoftware-Übersicht öffnen.');
  return sid;
}
function rpc(port, method, parameters) {
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify({version:'1.1',method,params:parameters});
    const req=http.request({host:'127.0.0.1',port,path:'/api/homematic.cgi',method:'POST',timeout:5000,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{
      let raw='',bytes=0;res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)req.destroy(Error('CCU-Antwort zu groß'));else raw+=chunk;});
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('CCU-API nicht erreichbar');const reply=JSON.parse(raw);if(reply.error||reply.result===undefined||reply.result===null)throw Error('CCU-Administrator-Sitzung erforderlich');resolve(reply.result);}catch(error){reject(error);}});
    });req.on('error',reject);req.on('timeout',()=>req.destroy(Error('CCU-Sitzungsprüfung hat nicht geantwortet')));req.end(data);
  });
}
function signingKey(directory) {
  const file=path.join(directory,'web-settings-key');
  try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
  const value=fs.readFileSync(file,'utf8');if(!/^[a-f0-9]{64}$/.test(value))throw Error('Ungültiger Sitzungsschlüssel');return value;
}
const digest=(key,sid,timestamp,nonce)=>crypto.createHmac('sha256',key).update(sid+'|'+timestamp+'|'+nonce).digest('hex');
function issueToken(key,sid,now=Date.now()) {const timestamp=Math.floor(now/1000),nonce=crypto.randomBytes(16).toString('hex');return `${timestamp}.${nonce}.${digest(key,sid,timestamp,nonce)}`;}
function validToken(key,sid,value,now=Date.now()) {
  const match=/^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(value||'');if(!match)return false;
  const age=now/1000-Number(match[1]);if(age<0||age>900)return false;
  return crypto.timingSafeEqual(Buffer.from(match[3]),Buffer.from(digest(key,sid,match[1],match[2])));
}
function configure(config, enabled, interfaces=os.networkInterfaces()) {
  config.web ||= {};config.web.authEnabled=enabled;
  let restart=false;
  if(!config.web.host || config.web.host==='127.0.0.1') {
    if(!(interfaces.eth0||[]).some(i=>i.family==='IPv4'&&!i.internal))throw Error('Kein lokaler IPv4-Zugang auf eth0 verfügbar');
    config.web.host='0.0.0.0';config.web.localBindAuto=true;restart=true;
  }
  return restart;
}
async function render(env, input, dependencies={}) {
  const configPath=env.MATTER_HOMEMATIC_SETTINGS_CONFIG || '/usr/local/etc/config/addons/matter-homematic/config.json';
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const post=env.REQUEST_METHOD==='POST';
  if(!['GET','POST'].includes(env.REQUEST_METHOD||'GET'))throw Error('GET oder POST erforderlich');
  if(post && !/^application\/x-www-form-urlencoded(?:;|$)/i.test(env.CONTENT_TYPE||''))throw Error('Formular-Content-Type erforderlich');
  const fields=params(post?input:env.QUERY_STRING||''); const sid=sidValue(fields.sid);
  const check=dependencies.rpc || rpc;
  await check(config.ccu?.regaPort||80,'Firewall.getConfiguration',{_session_id_:sid});
  const key=signingKey(path.dirname(configPath));let message='',restarted=false;
  if(post) {
    const host=env.HTTP_HOST||''; const scheme=env.HTTPS==='on'?'https:':'http:';
    // Some CCU CGI environments omit HTTP_ORIGIN. The signed, SID-bound
    // token below is mandatory regardless of which browser headers arrive.
    if(env.HTTP_SEC_FETCH_SITE==='cross-site')throw Error('Formular stammt nicht von dieser CCU');
    const requestOrigin=env.HTTP_ORIGIN;
    // Opaque/missing Origin still requires the ADMIN session and signed SID-bound token.
    const source=(requestOrigin && requestOrigin!=='null' ? requestOrigin : env.HTTP_REFERER) || '';
    if(source) {
      let origin;try{origin=new URL(source);}catch{throw Error('Ungültige Formular-Herkunft');}
      if(origin.protocol!==scheme||origin.host!==host||origin.username||origin.password)throw Error('Formular stammt nicht von dieser CCU');
    }
    if(!validToken(key,sid,fields.csrf))throw Error('Formular abgelaufen. Einstellungen neu öffnen.');
    if(fields.action!=='save'||!['on',undefined].includes(fields.authEnabled))throw Error('Ungültige Einstellung');
    const restart=configure(config,fields.authEnabled==='on',dependencies.interfaces?.() || os.networkInterfaces());
    atomicJson(configPath,config);
    restarted=restart;
    if(restart) {
      (dependencies.restart || (()=>{
        const child=require('node:child_process').spawn('/usr/local/etc/config/rc.d/matter-homematic',['restart'],{detached:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
      }))();message='Gespeichert. Der Add-on-Dienst wird neu gestartet; bitte einige Sekunden warten.';
    } else message='Gespeichert. Die Auswahl ist sofort wirksam.';
  }
  const enabled=config.web?.authEnabled!==false;const csrf=issueToken(key,sid);
  const local=(dependencies.interfaces?.() || os.networkInterfaces()).eth0?.find(i=>i.family==='IPv4'&&!i.internal)?.address;
  const port=config.web?.port||8080;
  const localUrl=local ? `http://${local}:${port}/` : '';
  // Local HTTP settings navigate after saving; HTTPS settings stay on the
  // confirmation page because a private LAN address may be unreachable remotely.
  const httpsPage=env.HTTPS==='on'||/^https:/i.test(env.HTTP_ORIGIN||env.HTTP_REFERER||'');
  const redirect=post&&!enabled&&localUrl&&!httpsPage;
  const delay=restarted?12:1;
  const refresh=redirect?`<meta http-equiv="refresh" content="${delay};url=${escape(localUrl)}">`:'';
  if(redirect)message+=` Die lokale Oberfläche öffnet sich automatisch in ${delay} Sekunden.`;
  let link='';
  if(!enabled && local)link=`<p><a href="http://${escape(local)}:${port}/" target="_blank" rel="noreferrer">Lokale Oberfläche ohne Passwort öffnen</a></p>`;
  if(config.web?.publicOrigin) {
    const url=new URL(config.web.publicOrigin);if(url.protocol==='https:'&&!url.username&&!url.password)link+=`<p><a href="${escape(url.origin)}/" target="_blank" rel="noreferrer">Geschützte HTTPS-Oberfläche öffnen</a></p>`;
  }
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">${refresh}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Matter-Homematic Einstellungen</title><style>body{font:16px system-ui;background:#f0f3f7;color:#172335;padding:24px}main{max-width:650px;margin:auto;padding:28px;background:white;border-radius:12px}label{display:flex;gap:12px;align-items:center;font-weight:600;padding:16px 0}input[type=checkbox]{width:22px;height:22px}button{padding:12px 22px;background:#3769b7;color:white;border:0;border-radius:6px;font:inherit}.status{padding:12px;background:#e7f4e9}</style></head><body><main><h1>Matter-Homematic 0.19.1</h1><h2>Einstellungen</h2>${message?'<p role="status" class="status">'+escape(message)+'</p>':''}<form method="post" action="config.cgi"><input type="hidden" name="sid" value="${escape(sid)}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="save"><label><input type="checkbox" name="authEnabled" ${enabled?'checked':''}>Passwort-Abfrage aktiv</label><p>Aktiv: Anmeldung mit den CCU3-WebUI-Zugangsdaten. Deaktiviert: direkter Zugriff ohne Anmeldung aus dem lokalen eth0-Netz.</p><p>Der HTTPS-Fernzugriff bleibt mit Anmeldung geschützt. CSRF- und Sitzungsprüfung bleiben auch lokal aktiv.</p><button type="submit">Speichern</button></form>${link}<p>Namen, Räume, Gerätefreigaben und Matter-Kopplung bleiben erhalten.</p></main></body></html>`;
}
module.exports={render,configure,sidValue,issueToken,validToken};
if(require.main===module) (async()=>{
  let raw='',size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)throw Error('Formular zu groß');raw+=chunk;}
  const page=await render(process.env,raw);process.stdout.write('Content-Type: text/html; charset=UTF-8\nCache-Control: no-store\nReferrer-Policy: same-origin\nX-Content-Type-Options: nosniff\n\n'+page);
})().catch(error=>{process.stdout.write('Status: 403 Forbidden\nContent-Type: text/html; charset=UTF-8\nCache-Control: no-store\n\n<!doctype html><html lang="de"><meta charset="utf-8"><h1>CCU-Einstellungen nicht verfügbar</h1><p>'+escape(error.message)+'</p><p>Aus der CCU-WebUI über Zusatzsoftware → Matter-Homematic → Einstellungen öffnen. Eine gültige Administrator-Sitzung ist erforderlich.</p></html>');});
