'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const token = () => crypto.randomBytes(32).toString('hex');
const normalizeIp = ip => (ip || '').replace(/^::ffff:/, '');
const loopback = ip => ['127.0.0.1', '::1'].includes(normalizeIp(ip));
const v4number = ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(n=>Number(n)<=255) ? ip.split('.').reduce((n,x)=>(n*256+Number(x))>>>0,0) : null;
function localLan(ip, host, port) {
  const peer=v4number(ip); if(peer===null) return false;
  for(const nic of require('node:os').networkInterfaces().eth0 || []) {
    if(nic.family!=='IPv4' || nic.internal || host !== `${nic.address}:${port}`) continue;
    const addr=v4number(nic.address), mask=v4number(nic.netmask);
    if(addr!==null && mask!==null && mask!==0 && (peer & mask)===(addr & mask)) return true;
  }
  return false;
}
const equal = (a,b) => {if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&crypto.timingSafeEqual(left,right);};
const {atomicJson}=require('./durable-storage');
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw Object.assign(new Error('JSON Content-Type erforderlich'), { status: 415 });
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw Object.assign(new Error('Anfrage zu groß'), { status: 413 });
    chunks.push(chunk);
  }
  try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error(); return data; }
  catch { throw Object.assign(new Error('Ungültiges JSON'), { status: 400 }); }
}
function roomsByAddress(data){
 const byId=new Map();
 for(const room of data.rooms)for(const id of new Set(room.channelIds)){if(!byId.has(id))byId.set(id,[]);byId.get(id).push(room.name);}
 return new Map(data.channels.map(c=>[c.address,byId.get(c.id)||[]]));
}
class SecureWeb {
  constructor(web, options = {}) {
    this.web = web; this.options = options;
    this.configSnapshot=new (require("./runtime-core").ConfigSnapshot)(web.deps.configPath);
    this.sessions = new Map(); this.attempts = new Map(); this.streams = new Map(); this.caps = new Map(); this.pending = new Set();
    this.queue = Promise.resolve(); this.loginBusy = false; this.ticks = 0;
    this.timer = setInterval(() => this.maintenanceTick(), 1000); this.timer.unref();
    this.monitor = new (require('./service-monitor').ServiceMonitor)(web);
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)require('./jeep-connection').ensure(this.web).restore().catch(()=>{});});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./backup-storage').schedule(this.web);}catch{console.error('[backup-schedule] Initialization failed (details omitted)');}});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./netzspeicher').start(this.web);}catch{console.error('[netzspeicher] Start fehlgeschlagen (Details ausgelassen)');}});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./automationen').start(this.web);}catch{console.error('[automationen] Start fehlgeschlagen (Details ausgelassen)');}});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./tasmota').start(this.web);}catch{console.error('[tasmota] Start fehlgeschlagen (Details ausgelassen)');}});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./ccu-neustart').start(this.web);}catch{console.error('[neustart] Start fehlgeschlagen (Details ausgelassen)');}});
    queueMicrotask(()=>{if(!this.stopped&&this.web.security===this)try{require('./jeep-wecker').start(this.web);}catch{console.error('[jeep-wecker] Start fehlgeschlagen (Details ausgelassen)');}});
  }
  context(req) {
    const ip = normalizeIp(req.socket.remoteAddress); const authEnabled=this.authEnabled();
    const trusted = (this.options.trustedProxies || []).includes(ip);
    let origin;
    if (trusted && (!loopback(ip) || req.headers['x-forwarded-proto'] !== undefined)) {
      const origins = [this.options.publicOrigin, ...(Array.isArray(this.options.publicOrigins) ? this.options.publicOrigins : [])].filter(o => typeof o === 'string' && o); if (!origins.length || req.headers['x-forwarded-proto'] !== 'https') throw Object.assign(new Error('HTTPS-Proxy-Konfiguration ungültig'), { status: 403 });
      origin = origins.map(o => new URL(o).origin).find(o => new URL(o).host === req.headers.host) || new URL(origins[0]).origin; // mehrere HTTPS-Adressen (Tailscale + https://<CCU>)
      if (!origin.startsWith('https://') || req.headers.host !== new URL(origin).host) throw Object.assign(new Error('Host ungültig'), { status: 403 });
    } else {
      const host = req.headers.host || '';
      const lan = localLan(ip,host,this.web.port);
      if (!loopback(ip) && !lan) throw Object.assign(new Error('Zugriff nur über konfigurierten HTTPS-Proxy oder freigegebenen lokalen Zugang'), { status: 403 });
      if (!lan && !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw Object.assign(new Error('Host ungültig'), { status: 403 });
      origin = (req.socket.encrypted?'https://':'http://') + host;
    }
    return { ip, origin, secure: trusted||req.socket.encrypted===true, authEnabled };
  }
  session(req) {
    const raw = /(?:^|;\s*)mh_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const session = this.sessions.get(raw);
    if (!session || Date.now() - session.seen > 2 * 86400000 || Date.now() - session.created > 2 * 86400000) { this.sessions.delete(raw); return null; }
    return { raw, session };
  }
  json(res, status, data) { if (!res.writableEnded) this.web.sendJson(res, status, data); }
  async handle(req,res){
    let handled;
    try{handled=await this.handleSecure(req,res);return handled;}
    finally{if(handled!==false)req.releaseConfiguration?.();}
  }
  async handleSecure(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-hashes' 'sha256-bpg0ThoWShyRWyeb2Yby6aQQCAVRJCeCEkv8IHPHWUM=' 'sha256-Yr211FiN3DUoAsbxeq76fuTCdURWPI7z4M/qLlaVLk4=' 'sha256-j0ktAmz+QbWKkXHos4kGl+Hpr8jT4c+PmQga3GyI6cA=' 'sha256-YPqSUs1650oB3pOLb93GsiTcFdDGbzSKhZ0j2EEBfO0=' 'sha256-UjsiEh2kkYnP61hZuM3krmN9fLDhlmCcd63dUMYfBAc=' 'sha256-h/Q8Cci8m15EAUqoUV8chbYeg2dzjEnmVBY1YYNlsnU=' 'sha256-XJEJMaaNEXCB22iWccK2c5yR6X033bHeH9dEa5pt4FA=' 'sha256-Ig7rahmE0rKq7Yy4GS2QGSfyq1BSGJiTno9i3GIxfF4=' 'sha256-eqwdqiIuIltTodb/Nq/iuahVlaAz4c92fm98H8hmibY=' 'sha256-0P02qtE8pmTg/KNLrY35/hPBREo2EGG5CmfMKCwkPpU=' 'sha256-JnY6D0x71JVWb5s+6QGfw9CDtdfmOqtr1qTNP/EZ3FM=' 'sha256-9Gwe9FOfFXqsn3XMwd9F1asWLbuN6p7W02/XjZFTf+s=' 'sha256-Wg7gyXKB0RjjAaeThD8ImoYtrOPGMth8n+/NFfTn7C4=' 'sha256-j0yLbY55tfp4cYR/rvkuoG1y0Ff4YAuukeGr+YCy34o=' 'sha256-l4jTgn9F5/XndVOY9UWjfVURHUS+7nj/i9pUNx4HBGo=' 'sha256-V5NHkyosBGOkPEHyVz4C2DUhbO9mBn3s+N0HgGNYMro=' 'sha256-OgX7xhePgT7/2WLV7CL81pFhxc/viywQ/r4z6RKfAuk=' 'sha256-smHnubIYrdPk7n+MFDQ4h9z2I8YEPlaWiMmyS5D0MIM=' 'sha256-lpfj9EF/zeG9FFvwVp0ZpDW6UB344S0YA5KacPustGc=' 'sha256-j+c440eGotd8jak0+UecQO7nDkJUJetqxRkeSrthiF4='; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    const ctx = this.context(req); const u = new URL(req.url, ctx.origin);
    res.setHeader('X-Matter-Homematic-Web', '0.19.1');
    const noPassword = !ctx.secure && !ctx.authEnabled;
    if (u.pathname === '/api/' && u.searchParams.getAll('method').length === 1) {
      const authRoutes = { webLogin: '/auth/login', webSession: '/auth/session', webLogout: '/auth/logout', webActivity: '/auth/activity' };
      if (Object.hasOwn(authRoutes, u.searchParams.get('method'))) u.pathname = authRoutes[u.searchParams.get('method')];
    }
    if (ctx.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (req.method !== 'GET' && req.method !== 'POST') { this.json(res, 405, { error: 'GET/POST erforderlich' }); return true; }
    if (req.headers.origin && req.headers.origin !== ctx.origin) { this.json(res, 403, { error: 'Origin ungültig' }); return true; }
    if (req.method === 'POST' && req.headers.origin !== ctx.origin) { this.json(res, 403, { error: 'Origin erforderlich' }); return true; }
    if (u.pathname === '/api/' && u.searchParams.get('method') === 'webAuthInfo') {
      if (req.method !== 'GET') { this.json(res, 405, { error: 'GET erforderlich' }); return true; }
      this.json(res, 200, { protocol: 'mh-web-auth-v1', version: require('../package.json').version.replace(/-openccu-ccu3$/, ''), authRequired: !noPassword, matterReady: this.web.deps.isMatterReady?.() === true }); return true;
    }
    if (u.pathname === '/login.html' || u.pathname === '/js/login.js') { if (req.method !== 'GET') { this.json(res, 405, { error: 'GET erforderlich' }); return true; } if(noPassword && u.pathname === '/login.html' && u.searchParams.get('admin') !== '1') {res.writeHead(303,{Location:'/'});res.end();return true;} this.web.serveStatic(u.pathname, res); return true; }
    if (u.pathname === '/auth/login') {
      if (req.method !== 'POST') { this.json(res, 405, { error: 'POST erforderlich' }); return true; }
      const now = Date.now(); const a = this.attempts.get(ctx.ip) || { count: 0, since: now };
      if (now - a.since > 15 * 60000) { a.count = 0; a.since = now; }
      if (a.count >= 8) require('./login-alert').failed(this.web, ctx.ip);
      if (a.count >= 8 || this.loginBusy) { this.json(res, 429, { error: 'Zu viele Anmeldeversuche. Später erneut versuchen.' }); return true; }
      a.count++; this.attempts.set(ctx.ip, a); this.loginBusy = true;
      try {
        const p = await body(req);
        if (typeof p.username !== 'string' || !p.username || p.username.length > 64 || typeof p.password !== 'string' || !p.password || p.password.length > 256) { this.json(res, 400, { error: 'Benutzername und Passwort erforderlich' }); return true; }
        if (await require('./benutzer').login(this, res, ctx, p)) return true;
        let sid, authFailed = false;
        try {
          sid = await this.connector().jsonRpc('Session.login', { username: p.username, password: p.password });
          if (typeof sid !== 'string' || !sid) throw new Error('Keine CCU-Sitzung');
          // The bridge API includes restart, configuration and factory reset.
          // Require CCU ADMIN via a read-only ADMIN-level method; never promote guests.
          await this.connector().jsonRpc('Firewall.getConfiguration', { _session_id_: sid });
          await require('./ccu-sso').open(this, p.username, p.password);
        } catch { authFailed = true; }
        finally { p.password = ''; if (typeof sid === 'string' && sid) await this.connector().jsonRpc('Session.logout', { _session_id_: sid }).catch(() => {}); }
        if (authFailed) require('./login-alert').failed(this.web, ctx.ip);
        if (authFailed) { this.json(res, 401, { error: 'CCU-Anmeldung fehlgeschlagen. CCU-Administrator und erreichbare JSON-RPC-API erforderlich.' }); return true; }
        this.attempts.delete(ctx.ip); if (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value); // erfolgreich: Zähler zurück; bei vollem Speicher weicht die älteste Sitzung
        if (this.sessions.size >= 32) { this.json(res, 429, { error: 'Sitzungslimit erreicht' }); return true; }
        const raw = token(); const session = { csrf: token(), created: now, seen: now };
        this.sessions.set(raw, session);
        require('./ccu-sso').bind(this, session);
        res.setHeader('Set-Cookie', `mh_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=172800${ctx.secure ? '; Secure' : ''}`);
        if (p.merken === true) require('./geraet-merken').issue(this, res, ctx, session, req.headers['user-agent'], p.username);
        this.json(res, 200, { csrf: session.csrf });
      } finally { this.loginBusy = false; }
      return true;
    }
    let auth = this.session(req);
    if (!auth) auth = require('./geraet-merken').restore(this, req, res, ctx);
    if(auth?.session.localBypass && !noPassword) {this.sessions.delete(auth.raw);auth=null;}
    if(!auth && noPassword) {
      if(this.sessions.size>=32) {this.json(res,429,{error:'Sitzungslimit erreicht'});return true;}
      const raw=token(), session={csrf:token(),created:Date.now(),seen:Date.now(),localBypass:true};
      this.sessions.set(raw,session);auth={raw,session};
      res.setHeader('Set-Cookie',`mh_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=172800`);
    }
    if (!auth) {
      if (req.method === 'GET' && /^\/[A-Za-z0-9_-]+\.html$/.test(u.pathname)) { res.writeHead(303, { Location: '/login.html' }); res.end(); return true; }
      if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/jeep.html') { res.writeHead(303, { Location: '/login.html' }); res.end(); }
      else this.json(res, 401, { error: 'Anmeldung erforderlich' });
      return true;
    }
    if (req.method === 'POST' && !equal(req.headers['x-csrf-token'], auth.session.csrf)) { this.json(res, 403, { error: 'CSRF-Token ungültig' }); return true; }
    if (require('./benutzer').gate(this, auth, req, res, u)) return true;
    // Automatic dashboard polling and SSE do not extend user inactivity.
    if (req.method === 'POST') auth.session.seen = Date.now();
    if (u.pathname === '/auth/session') { this.json(res, 200, { csrf: auth.session.csrf, admin: !auth.session.localBypass }); return true; }
    if (u.pathname === '/auth/activity') {
      if (req.method !== 'POST') { this.json(res, 405, { error: 'POST erforderlich' }); return true; }
      this.json(res, 200, { success: true }); return true;
    }
    if (u.pathname === '/auth/logout') {
      if (req.method !== 'POST') { this.json(res, 405, { error: 'POST erforderlich' }); return true; }
      require('./geraet-merken').forget(this, req);
      this.sessions.delete(auth.raw); res.setHeader('Set-Cookie', 'mh_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); this.json(res, 200, { success: true }); return true;
    }
    if (u.pathname === '/events') {
      if (req.method !== 'GET' || this.streams.size >= 16) { this.json(res, 429, { error: 'Event-Verbindungslimit' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
      res.write('event: ready\ndata: {}\n\n'); this.streams.set(res, { req, raw: auth.raw });
      req.on('close', () => this.streams.delete(res)); return true;
    }
    if (u.pathname === '/api/' && u.searchParams.getAll('method').length !== 1) { this.json(res, 400, { error: 'Genau eine Methode erforderlich' }); return true; }
    if(u.pathname==='/api/'&&req.method==='POST'){
      const method=u.searchParams.get('method');
      const control=['controlSmartplus','controlSmartlife','controlDyson','setSwitchState','setDimmerLevel','setThermostatTemperature','testNotification','logoutJeep'].includes(method);
      if(this.configurationOperation&&(!control||this.configurationOperation.blocksControls)){
        this.json(res,429,{error:'Konfigurationsänderung läuft bereits; bitte warten'});return true;
      }
      if(!control){
        const operation={blocksControls:['restoreBackup','factoryReset','restartBridge'].includes(method)};
        this.configurationOperation=operation;
        req.releaseConfiguration=()=>{if(this.configurationOperation===operation)this.configurationOperation=null;};
      }
    }
    if(await require('./backup').handleBackup(this.web,req,res,u))return true;
    if((this.web.cloudBackupStarting||this.web.cloudBackupJob?.state==='running')&&req.method==='POST'&&!['controlSmartplus','controlSmartlife','controlDyson','setSwitchState','setDimmerLevel','setThermostatTemperature','logoutJeep'].includes(u.searchParams.get('method'))){this.json(res,429,{error:'Sicherung läuft; Konfigurationsänderungen erst danach.'});return true;}
    if(await require('./backup-storage').handle(this.web,req,res,u))return true;
    if(await require('./dimmer-control').handle(this.web,req,res,u))return true;
    if(await require('./wifi-devices').handle(this.web,req,res,u))return true;
    if(await require('./jeep-matter').handle(this.web,req,res,u))return true;
    if(await require('./smartplus-api').handleSmartplus(this.web,req,res,u))return true;
    if(await require('./smartplus-api').handleSmartlife(this.web,req,res,u))return true;
    if(await require('./dyson-api').handle(this.web,req,res,u))return true;
    if(await require('./jeep-api').handle(this.web,req,res,u))return true;
    if(await require('./runtime-api').handleRuntime(this.web,req,res,u))return true;
    if(await require('./service-monitor').handleServices(this.web,req,res,u))return true;
    if(await require('./ccu-zentrale').handle(this.web,req,res,u,auth))return true;
    if (u.pathname === '/api/' && u.searchParams.get('method') === 'getDevices') {
      if (req.method !== 'GET') { this.json(res, 405, { error: 'GET erforderlich' }); return true; }
      const ccuRooms=await this.ccuRooms().read();this.ccuRooms().apply(ccuRooms,this.web.deps.getDevices(),this.connector().getChannels());
      const data = this.web.getDevices();
      const roomIndex=roomsByAddress(ccuRooms);
      for(let offset=0;offset<data.devices.length;offset+=16) await Promise.all(data.devices.slice(offset,offset+16).map(async device => {
        device.ccuRooms=[...(roomIndex.get(device.address)||[])];
        device.roomId=device.ccuRooms[0]||'';device.room=device.ccuRooms.join(', ');
        const cap = await this.capability(device.address);
        device.switchControl = cap;
        device.dimmerControl = await require('./dimmer-control').capability(this.web,device.address);
        const mapped = this.web.deps.getDevices().get(device.address);
        if (mapped?.matterDeviceType === 'Thermostat') {
          const heating = require('./thermostat-control');
          device.thermostatControl = await heating.capability(this.connector(), mapped);
          device.thermostatState = heating.readings(this.connector(), mapped);
        }
        const value = this.connector().getChannels().get(this.stateAddress(device.address))?.paramsets?.VALUES?.STATE;
        device.switchState = typeof value === 'boolean' ? value : null;
        if (device.switchState === null && cap?.allowed) device.switchState = await require('./zustand-nachlesen').read(this, device.address, cap);
      }));
      data.devices.push(...require('./wifi-devices').rows(this.web));
      data.devices.push(...require('./jeep-matter').rows(this.web));
      data.devices.push(...require('./tasmota').rows(this.web));
      this.json(res, 200, data); return true;
    }
    if (u.pathname === '/api/' && ['getRooms', 'createRoom', 'deleteRoom', 'setRoomName', 'setDeviceRoom'].includes(u.searchParams.get('method'))) {
      const method = u.searchParams.get('method');
      if ((method === 'getRooms') !== (req.method === 'GET')) { this.json(res, 405, { error: method === 'getRooms' ? 'GET erforderlich' : 'POST erforderlich' }); return true; }
      if(method==='getRooms') {const data=await this.ccuRooms().read();this.ccuRooms().apply(data,this.web.deps.getDevices(),this.connector().getChannels());this.json(res,200,this.canonicalRooms(data));return true;}
      const p=await body(req);
      if(method==='setDeviceRoom' && (!this.web.deps.getDevices().has(p.address)||typeof p.room!=='string'||typeof p.address!=='string'||!/^[A-Za-z0-9_-]{1,64}:\d{1,3}$/.test(p.address))) {this.json(res,400,{error:'Gerät oder Raum ungültig'});return true;}
      const data=await this.ccuRooms().change(method,p);this.ccuRooms().apply(data,this.web.deps.getDevices(),this.connector().getChannels());
      this.json(res,200,{success:true,name:p.name?.trim(),source:'CCU'});return true;
    }
    if(u.pathname==='/api/' && u.searchParams.get('method')==='factoryReset') {
      if(req.method!=='POST'){this.json(res,405,{error:'POST erforderlich'});return true;}
      const p=await body(req);if(p.confirmation!=='PAIRING ZURÜCKSETZEN'){this.json(res,400,{error:'Zusätzliche Pairing-Bestätigung erforderlich'});return true;}
      await this.web.handleFactoryReset(res);return true;
    }
    if (u.pathname === '/api/' && u.searchParams.get('method') === 'setThermostatTemperature') {
      if(req.method!=='POST'){this.json(res,405,{error:'POST erforderlich'});return true;}
      const p=await body(req);
      if(Object.keys(p).some(k=>!['address','temperature'].includes(k)) || typeof p.address!=='string' || !/^[A-Za-z0-9_-]{1,64}:\d{1,3}$/.test(p.address) || typeof p.temperature!=='number' || !Number.isFinite(p.temperature)) {
        this.json(res,400,{error:'Kanaladresse und numerische Solltemperatur erforderlich'});return true;
      }
      if(!this.web.deps.isCcuConnected()){this.json(res,503,{error:'CCU nicht verbunden'});return true;}
      if(this.pending.has(p.address)||this.pending.size>=4){this.json(res,429,{error:'Auftrag läuft bereits; bitte warten'});return true;}
      this.pending.add(p.address);
      try {
        const result=await require('./thermostat-control').setTemperature(this.connector(),this.web.deps.getDevices().get(p.address),p.temperature);
        this.json(res,result.confirmed?200:202,{success:true,...result});
      }catch(error){this.json(res,error.status||502,{error:error.status?error.message:'Temperaturauftrag konnte nicht bestätigt werden: '+error.message});}
      finally{this.pending.delete(p.address);}
      return true;
    }
    if (u.pathname === '/api/' && u.searchParams.get('method') === 'setSwitchState') {
      if (req.method !== 'POST') { this.json(res, 405, { error: 'POST erforderlich' }); return true; }
      const p = await body(req);
      if (Object.keys(p).some(k => !['address', 'state'].includes(k)) || typeof p.address !== 'string' || !/^[A-Za-z0-9_-]{1,64}:\d{1,3}$/.test(p.address) || typeof p.state !== 'boolean') { this.json(res, 400, { error: 'Erwartet {address: Kanaladresse, state: boolean}' }); return true; }
      if (!this.web.deps.isCcuConnected()) { this.json(res, 503, { error: 'CCU nicht verbunden' }); return true; }
      const cap = await this.capability(p.address);
      if (!cap.allowed) { this.json(res, 403, { error: cap.reason }); return true; }
      if (this.pending.has(p.address) || this.pending.size >= 4) { this.json(res, 429, { error: 'Schaltauftrag läuft bereits; bitte warten' }); return true; }
      this.pending.add(p.address);
      try {
        await this.connector().setValue(p.address, 'STATE', p.state);
        const source = this.stateAddress(p.address);
        let actual;
        actual = await require('./switch-readback').readback(this.connector(), source, p.state);
        if (typeof actual === 'boolean' && actual === p.state) {
          this.connector().handleEvent('matter-homematic-' + cap.interface, source, 'STATE', actual);
          this.json(res, 200, { success: true, accepted: true, state: actual, confirmed: true, message: 'Zustand von CCU bestätigt' });
        } else {
          // Acknowledged write, but feedback is delayed/unavailable. Never retry or inject stale state.
          this.json(res, 202, { success: true, accepted: true, state: null, requestedState: p.state, confirmed: false, message: 'Befehl an CCU übergeben; warte auf Rückmeldung' });
        }
      } catch (error) { this.json(res, 502, { error: 'Schaltbefehl konnte nicht bestätigt werden: ' + error.message + '. Zustand vor erneutem Schalten prüfen.' }); }
      finally { this.pending.delete(p.address); }
      return true;
    }
    return false;
  }
  connector() { return this.web.deps.getConnector(); }
  authEnabled() {
    try {return this.configSnapshot.read().web?.authEnabled !== false;}
    catch {return true;}
  }
  ccuRooms(){const c=this.connector();if(this.roomConnector!==c){this.roomConnector=c;this.roomService=new(require('./ccu-rooms').CcuRooms)(c);}return this.roomService;}
  canonicalRooms(data){const mapped=this.web.deps.getDevices();return {rooms:data.rooms.map(r=>({originalName:r.name,name:r.name,id:r.id,customName:false,deviceCount:data.channels.filter(c=>mapped.has(c.address)&&r.channelIds.includes(c.id)).length})).sort((a,b)=>a.name.localeCompare(b.name,'de',{sensitivity:'base'})),count:data.rooms.length,source:'CCU'};}
  stateAddress(address) { return this.web.deps.getStateAddress?.(address) || address; }
  roomConfig() { const config = this.configSnapshot.read(); const d = config.devices || {}; return { names: d.roomNames || {}, assignments: d.roomAssignments || {}, deleted: d.deletedRooms || [], extra: d.webRooms || [] }; }
  rooms() {return this.canonicalRooms(this.ccuRooms().value||{rooms:[],channels:[]});}
  async capability(address) {
    const c = this.connector(); const channel = c.getChannels().get(address); const mapped = this.web.deps.getDevices().get(address);
    const denied = reason => ({ allowed: false, reason });
    if (!channel || !mapped) return denied('Unbekannter oder nicht zugeordneter Kanal');
    if (!['BidCos-RF', 'HmIP-RF', 'CUxD'].includes(channel.interface)) return denied('Schnittstelle nicht freigegeben');
    if (!['SWITCH', 'SWITCH_VIRTUAL_RECEIVER', 'DIMMER', 'DIMMER_VIRTUAL_RECEIVER', 'KEY'].includes(channel.type)) return denied('Sensorkanal oder unbekannter Aktortyp');
    if (channel.type === 'KEY' && channel.interface !== 'CUxD') return denied('Taster ist kein Aktor');
    const vm = mapped.valueMappings?.STATE;
    if (!['OnOffPlugInUnit', 'OnOffLight', 'DimmableLight'].includes(mapped.matterDeviceType) || vm?.matterCluster !== 'onOff') return denied('Kein schaltbarer Aktor');
    const old = this.caps.get(address);
    if (old && old.channel === channel && Date.now() < old.until) return old.promise;
    const task = async () => {
      try {
        const description = await c.rpcCall(channel.interface, 'getParamsetDescription', [address, 'VALUES']);
        const state = description?.STATE;
        if (state?.TYPE !== 'BOOL' || !(state.OPERATIONS & 2) || !(state.OPERATIONS & 1)) return denied('STATE ist kein lesbarer/schreibbarer BOOL-Aktorwert');
        return { allowed: true, interface: channel.interface };
      } catch { return denied('Aktorfähigkeit nicht bestätigt: RPC-Beschreibung nicht verfügbar'); }
    };
    const entry={channel,until:Infinity,promise:null};
    entry.promise=task().then(result=>{entry.until=Date.now()+(result.allowed?5*60000:5000);return result;});
    this.caps.set(address,entry);
    return entry.promise;
  }
  maintenanceTick() {
    try { this.tick(); this.maintenanceFailed = false; }
    catch {
      // A corrupt/replaced configuration must neither kill Matter nor leave access open.
      this.sessions.clear();
      for (const res of this.streams.keys()) { try { res.end(); } catch {} }
      this.streams.clear();
      const now = Date.now();
      if (!this.maintenanceFailed || now - this.lastMaintenanceLog >= 60000) {
        console.error('Web-Sitzungsprüfung fehlgeschlagen; Sitzungen geschlossen. Konfiguration und CCU-Verbindung prüfen.');
        this.lastMaintenanceLog = now;
      }
      this.maintenanceFailed = true;
    }
  }
  tick() {
    if(this.authEnabled()) for(const [raw,s] of this.sessions) if(s.localBypass) this.sessions.delete(raw);
    const c = this.connector();
    if (c !== this.attached) {
      this.attached?.off('deviceEvent', this.listener); this.attached = c; this.caps.clear();
      this.listener = event => {
        if(event.key==='LEVEL'&&typeof event.value==='number'&&Number.isFinite(event.value)&&event.value>=0&&event.value<=1){
          for(const [address,device]of this.web.deps.getDevices()){
            if(device.matterDeviceType!=='DimmableLight'||this.stateAddress(address)!==event.address)continue;
            const payload=`event: dimmer\ndata: ${JSON.stringify({address,percent:Math.round(event.value*100),level:event.value})}\n\n`;
            for(const res of this.streams.keys())if(!res.write(payload)){res.end();this.streams.delete(res);}
          }
        }
        if(typeof event.value==='number' && Number.isFinite(event.value)) {
          for(const [address,device] of this.web.deps.getDevices()) {
            if(device.matterDeviceType!=='Thermostat'||device.hmAddress!==event.address)continue;
            const mapping=Object.values(device.valueMappings||{}).find(v=>v.hmKey===event.key && v.matterCluster==='thermostat');
            const field=mapping?.matterAttribute==='localTemperature'?'temperature':mapping?.matterAttribute==='occupiedHeatingSetpoint'?'setpoint':null;
            if(!field)continue;
            const payload=`event: thermostat\ndata: ${JSON.stringify({address,[field]:event.value})}\n\n`;
            for(const res of this.streams.keys())if(!res.write(payload)){res.end();this.streams.delete(res);}
          }
        }
        if (event.key !== 'STATE' || typeof event.value !== 'boolean') return;
        for (const address of this.web.deps.getDevices().keys()) {
          if (this.stateAddress(address) !== event.address) continue;
          const payload = `event: state\ndata: ${JSON.stringify({ address, state: event.value })}\n\n`;
          for (const res of this.streams.keys()) if (!res.write(payload)) { res.end(); this.streams.delete(res); }
        }
      };
      c.on('deviceEvent', this.listener);
    }
    for (const [res, info] of this.streams) if (!this.session(info.req)) { res.end(); this.streams.delete(res); }
    for (const [raw, s] of this.sessions) if (Date.now() - s.seen > 2 * 86400000 || Date.now() - s.created > 2 * 86400000) this.sessions.delete(raw);
    for (const [ip, a] of this.attempts) if (Date.now() - a.since > 15 * 60000) this.attempts.delete(ip);
    if (this.attempts.size > 1024) this.attempts.delete(this.attempts.keys().next().value);
    if (++this.ticks % 20 === 0) for (const res of this.streams.keys()) res.write(': heartbeat\n\n');
  }
  stop() { this.stopped=true;if(this.web.jeepConnection)this.web.jeepConnection.stop();else this.web.jeepService?.logout();this.web.backupSchedule?.stop();this.web.cloudBackupController?.abort();this.web.googleBackup?.stop();this.web.googleBackup=null; clearInterval(this.timer); this.monitor.stop(); this.attached?.off('deviceEvent', this.listener); for (const res of this.streams.keys()) res.end(); this.streams.clear(); this.sessions.clear(); }
  validateLegacy(req, payload) {
    const method = new URL(req.url, 'http://localhost').searchParams.get('method');
    if (['setDeviceExposed', 'setDeviceName', 'setDeviceTilt'].includes(method) && (!this.web.deps.getDevices().has(payload.address) || !/^[A-Za-z0-9_-]{1,64}:\d{1,3}$/.test(payload.address))) throw Object.assign(new Error('Geräteadresse ungültig'), { status: 400 });
    if (method === 'setSystemVariableExposed' && !this.web.deps.getSystemVariables().some(v => String(v.id) === payload.id)) throw Object.assign(new Error('Systemvariable unbekannt'), { status: 400 });
  }
}
module.exports = { SecureWeb, atomicJson, body, localLan, roomsByAddress };
