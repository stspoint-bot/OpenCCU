'use strict';
// Tasmota: WLAN-Geräte mit Tasmota-Firmware (Steckdosen, Schalter, Dimmer, Fühler) einbinden.
// Es wird ausschließlich die lokale Web-Schnittstelle der Geräte im eigenen Heimnetz benutzt
// (http://<Gerät>/cm?cmnd=…). Keine Cloud, kein Konto, keine Kosten, kein zusätzlicher Dienst.
//
// Sicherheitsregeln dieses Bausteins:
// - Angesprochen werden nur private Heimnetz-Adressen (10.x, 172.16–31.x, 192.168.x), Port 80,
//   keine Rechnernamen, keine Weiterleitungen, Antworten höchstens 32 KB, festes Zeitlimit.
// - Die Suche prüft nur das eigene Heimnetz der Zentrale (höchstens 254 Adressen je Netz) mit
//   einer lesenden Statusabfrage. Dabei wird nie ein Passwort mitgeschickt.
// - Ein Gerätepasswort wird verschlüsselt abgelegt (AES-256-GCM), nie wieder ausgegeben und nur an
//   das Gerät geschickt, zu dem es gehört. Zuerst als Anmeldekopf; nur wenn das Gerät den nicht
//   kennt (ältere Tasmota-Firmware), so wie Tasmota es vorschreibt: als Teil der Anfrage. Tasmota
//   überträgt im Heimnetz grundsätzlich unverschlüsselt; das Passwort wird hier nirgends protokolliert.
// - Hinzufügen, Ändern, Entfernen und Suchen nur nach Anmeldung als CCU-Administrator.
// - Befehle werden genau einmal gesendet; als „bestätigt“ gilt nur die Antwort des Geräts.
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const fail = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
const MAC = /^[a-f0-9]{12}$/;
const ENTRY_ID = /^([a-f0-9]{12})-(s|[1-9]|1[0-6])$/;
const ADDRESS = /^TASMOTA-([a-f0-9]{12}):(\d{1,2})$/;
const LIMITS = Object.freeze({ hosts: 64, relays: 16, name: 64, password: 64, response: 32768, subnets: 2 });
// Abfragetakt: in Ruhe „Status 11“ alle 10 s; nach einem Befehl oder einer erkannten Änderung 2 Minuten lang alle 3 s.
// Messwerte („Status 10“) alle 30 s nur bei Geräten mit Fühler oder Leistungsmessung, Kennung („Status 0“) alle 5 Minuten
// und sofort nach jedem Aussetzer oder Laufzeitsprung. Nicht erreichbare Geräte alle 30 s.
const TIMING = Object.freeze({ request: 3000, probe: 1500, poll: 3000, pollIdle: 10000, activeMs: 120000, pollOffline: 30000, sensors: 30000, identify: 300000, offlineAfter: 3, scanParallel: 24, rediscover: [15 * 60000, 60 * 60000, 6 * 3600000, 24 * 3600000] });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------- Adressen ----------
function ipParts(ip) {
  const m = typeof ip === 'string' ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip) : null;
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  // Keine führenden Nullen (würden mancherorts als Oktalzahl gelesen).
  if (parts.some((n, i) => n > 255 || String(n) !== m[i + 1])) return null;
  return parts;
}
// Nur Geräteadressen im privaten Heimnetz; Netz- und Rundrufadresse ausgeschlossen.
function privateIp(ip) {
  const p = ipParts(ip); if (!p) return false;
  const [a, b, , d] = p;
  if (d === 0 || d === 255) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
// Die /24-Netze, in denen die Zentrale selbst steht (höchstens zwei).
function ownSubnets(interfaces) {
  const out = [];
  let list = {}; try { list = interfaces() || {}; } catch { }
  for (const entries of Object.values(list)) for (const e of entries || []) {
    if (!e || e.internal || (e.family !== 'IPv4' && e.family !== 4) || !privateIp(e.address)) continue;
    const base = e.address.split('.').slice(0, 3).join('.');
    if (!out.some(s => s.base === base)) out.push({ base, self: e.address });
  }
  return out.slice(0, LIMITS.subnets);
}

// ---------- Übertragung ----------
function httpRequest(ip, command, password, options = {}) {
  return new Promise((resolve, reject) => {
    if (!privateIp(ip)) { reject(fail('Adresse liegt nicht im Heimnetz')); return; }
    const target = options.endpoint ? options.endpoint(ip) : { host: ip, port: 80 };
    const timeout = options.timeout || TIMING.request;
    const headers = { Accept: 'application/json', Connection: 'close' };
    const legacy = !!password && options.legacy === true;
    if (password && !legacy) headers.Authorization = 'Basic ' + Buffer.from('admin:' + password, 'utf8').toString('base64');
    let done = false, hard = null;
    const finish = (fn, value) => { if (done) return; done = true; clearTimeout(hard); fn(value); };
    const req = http.request({ host: target.host, port: target.port, method: 'GET', path: '/cm?' + (legacy ? 'user=admin&password=' + encodeURIComponent(password) + '&' : '') + 'cmnd=' + encodeURIComponent(command), headers, agent: false, timeout }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > LIMITS.response) { req.destroy(); finish(reject, fail('Antwort des Geräts zu groß', 502)); return; } chunks.push(chunk); });
      res.on('end', () => finish(resolve, { status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish(reject, fail('Verbindung zum Gerät abgebrochen', 502)));
    });
    hard = setTimeout(() => { req.destroy(); finish(reject, fail('Gerät antwortet nicht', 504, 'TIMEOUT')); }, timeout + 500);
    req.on('timeout', () => { req.destroy(); finish(reject, fail('Gerät antwortet nicht', 504, 'TIMEOUT')); });
    req.on('error', () => finish(reject, fail('Gerät nicht erreichbar', 502, 'UNREACHABLE')));
    req.end();
  });
}
// Ein Tasmota-Befehl; liefert das JSON-Objekt der Antwort. Weiterleitungen und Fehlerseiten gelten als Fehler.
async function commandOnce(request, ip, cmnd, password, options) {
  const res = await request(ip, cmnd, password, options);
  let data = null; try { data = JSON.parse(res.text); } catch { }
  if (res.status === 401 || (isObject(data) && typeof data.WARNING === 'string' && /user=/i.test(data.WARNING))) throw fail(password ? 'Gerätepasswort wird nicht angenommen' : 'Gerät verlangt ein Passwort', 401, 'AUTH');
  if (res.status !== 200 || !isObject(data)) throw fail('Keine gültige Tasmota-Antwort', 502, 'NOTASMOTA');
  return data;
}
// Mit Passwort: erst der Anmeldekopf. Lehnt das Gerät ab, hat es den Befehl nicht ausgeführt; dann
// folgt genau ein Versuch in der älteren Form. Welche Form das Gerät versteht, merkt sich „mode“.
async function command(request, ip, cmnd, password, options = {}) {
  const mode = options.mode || {};
  if (!password) return commandOnce(request, ip, cmnd, undefined, { ...options, legacy: false });
  if (mode.legacy !== true) {
    try { return await commandOnce(request, ip, cmnd, password, { ...options, legacy: false }); }
    catch (e) { if (e.code !== 'AUTH') throw e; }
  }
  const data = await commandOnce(request, ip, cmnd, password, { ...options, legacy: true });
  mode.legacy = true;
  return data;
}

// ---------- Auswertung der Geräteantworten ----------
const cleanText = (v, max) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
function onOff(v) {
  if (v === true || v === 1 || v === '1' || (typeof v === 'string' && v.toUpperCase() === 'ON')) return true;
  if (v === false || v === 0 || v === '0' || (typeof v === 'string' && v.toUpperCase() === 'OFF')) return false;
  return undefined;
}
function relayNumbers(sts) {
  const out = [];
  for (const key of Object.keys(sts || {})) { const m = /^POWER(\d{0,2})$/.exec(key); if (m && onOff(sts[key]) !== undefined) out.push(m[1] ? Number(m[1]) : 1); }
  return [...new Set(out)].filter(n => n >= 1 && n <= LIMITS.relays).sort((a, b) => a - b);
}
const hasShutter = o => Object.keys(o || {}).some(k => /^Shutter\d+$/.test(k));
function readings(sns) {
  const out = {};
  if (!isObject(sns)) return out;
  const fahrenheit = sns.TempUnit === 'F';
  for (const [name, part] of Object.entries(sns)) {
    if (!isObject(part)) continue;
    if (name === 'ENERGY') {
      if (typeof part.Power === 'number' && Number.isFinite(part.Power) && part.Power >= 0 && part.Power <= 100000) out.power = Math.round(part.Power * 10) / 10;
      // Energie in kWh: heute und Zählerstand (für Diagramme)
      if (typeof part.Today === 'number' && Number.isFinite(part.Today) && part.Today >= 0 && part.Today <= 10000) out.energyToday = Math.round(part.Today * 1000) / 1000;
      if (typeof part.Total === 'number' && Number.isFinite(part.Total) && part.Total >= 0 && part.Total <= 10000000) out.energyTotal = Math.round(part.Total * 1000) / 1000;
      // Spannung (V) und Strom (A) für die Diagramme
      if (typeof part.Voltage === 'number' && Number.isFinite(part.Voltage) && part.Voltage >= 0 && part.Voltage <= 500) out.voltage = Math.round(part.Voltage * 10) / 10;
      if (typeof part.Current === 'number' && Number.isFinite(part.Current) && part.Current >= 0 && part.Current <= 100) out.current = Math.round(part.Current * 1000) / 1000;
      continue;
    }
    if (out.temperature === undefined && typeof part.Temperature === 'number' && Number.isFinite(part.Temperature)) { const c = fahrenheit ? (part.Temperature - 32) * 5 / 9 : part.Temperature; if (c >= -40 && c <= 125) out.temperature = Math.round(c * 10) / 10; }
    if (out.humidity === undefined && typeof part.Humidity === 'number' && Number.isFinite(part.Humidity) && part.Humidity >= 0 && part.Humidity <= 100) out.humidity = Math.round(part.Humidity * 10) / 10;
  }
  return out;
}
// Beschreibung eines Geräts aus „Status 0“.
function describe(ip, s) {
  if (!isObject(s) || !isObject(s.StatusNET) || !isObject(s.StatusSTS) || !isObject(s.Status)) throw fail('Unter dieser Adresse antwortet kein Tasmota-Gerät', 422, 'NOTASMOTA');
  const mac = String(s.StatusNET.Mac || '').toLowerCase().replace(/[^a-f0-9]/g, '');
  if (!MAC.test(mac)) throw fail('Unter dieser Adresse antwortet kein Tasmota-Gerät', 422, 'NOTASMOTA');
  // Werkseitig heißen alle Geräte „Tasmota“; dann wird das Ende der Gerätekennung angehängt.
  const own = v => { const t = cleanText(v, LIMITS.name); return /^tasmota\d*$/i.test(t) ? '' : t; };
  const friendly = Array.isArray(s.Status.FriendlyName) ? s.Status.FriendlyName.map(own) : [];
  const name = own(s.Status.DeviceName) || friendly[0] || 'Tasmota ' + mac.slice(-4).toUpperCase();
  const shutter = hasShutter(s.StatusSNS) || hasShutter(s.StatusSTS);
  const numbers = shutter ? [] : relayNumbers(s.StatusSTS);
  const dimmer = typeof s.StatusSTS.Dimmer === 'number' && s.StatusSTS.Dimmer >= 0 && s.StatusSTS.Dimmer <= 100;
  const relays = numbers.map((n, i) => ({ n, name: numbers.length > 1 ? friendly[i] || (name.slice(0, LIMITS.name - 3) + ' ' + n) : name, dimmer: dimmer && i === 0 }));
  const r = readings(s.StatusSNS);
  const sensor = r.temperature !== undefined || r.humidity !== undefined ? { temperature: r.temperature !== undefined, humidity: r.humidity !== undefined } : null;
  return { mac, ip, name, version: cleanText(isObject(s.StatusFWR) ? s.StatusFWR.Version : '', 40), relays, sensor, power: r.power !== undefined, shutter, sts: s.StatusSTS, sns: s.StatusSNS };
}
function summary(d) {
  const parts = [];
  if (d.relays.length) parts.push(d.relays.some(r => r.dimmer) ? 'Dimmer' : d.relays.length === 1 ? '1 Schalter' : d.relays.length + ' Schalter');
  if (d.sensor) parts.push([d.sensor.temperature ? 'Temperatur' : '', d.sensor.humidity ? 'Luftfeuchte' : ''].filter(Boolean).join(' und '));
  if (d.power) parts.push('Leistungsmessung');
  if (d.shutter) parts.push('Rollladen (wird noch nicht unterstützt)');
  return parts.join(', ') || 'keine unterstützte Funktion';
}

// ---------- gespeicherte Geräteliste ----------
function validName(v) { return typeof v === 'string' && !!v.trim() && v.trim().length <= LIMITS.name && !/[\x00-\x1f\x7f]/.test(v); }
function only(o, keys) { return isObject(o) && Object.keys(o).every(k => keys.includes(k)); }
// Strenge Prüfung eines gespeicherten Geräts; wirft bei jeder Abweichung.
function normalizeHost(h) {
  if (!only(h, ['mac', 'ip', 'name', 'version', 'auth', 'relays', 'sensor', 'power'])) throw fail('Ungültiges Tasmota-Gerät');
  if (typeof h.mac !== 'string' || !MAC.test(h.mac) || !privateIp(h.ip) || !validName(h.name)) throw fail('Ungültiges Tasmota-Gerät');
  if (h.version !== undefined && (typeof h.version !== 'string' || h.version.length > 40 || /[\x00-\x1f\x7f]/.test(h.version))) throw fail('Ungültiges Tasmota-Gerät');
  if (h.auth !== undefined && typeof h.auth !== 'boolean') throw fail('Ungültiges Tasmota-Gerät');
  if (h.power !== undefined && typeof h.power !== 'boolean') throw fail('Ungültiges Tasmota-Gerät');
  if (!Array.isArray(h.relays) || h.relays.length > LIMITS.relays) throw fail('Ungültiges Tasmota-Gerät');
  const seen = new Set();
  const relays = h.relays.map(r => {
    if (!only(r, ['n', 'name', 'exposed', 'dimmer']) || !Number.isInteger(r.n) || r.n < 1 || r.n > LIMITS.relays || seen.has(r.n) || !validName(r.name) || typeof r.exposed !== 'boolean' || (r.dimmer !== undefined && typeof r.dimmer !== 'boolean')) throw fail('Ungültiger Tasmota-Schalter');
    seen.add(r.n);
    return { n: r.n, name: r.name.trim(), exposed: r.exposed, dimmer: r.dimmer === true };
  });
  let sensor = null;
  if (h.sensor !== undefined && h.sensor !== null) {
    const s = h.sensor;
    if (!only(s, ['name', 'exposed', 'temperature', 'humidity']) || !validName(s.name) || typeof s.exposed !== 'boolean' || typeof s.temperature !== 'boolean' || typeof s.humidity !== 'boolean' || !(s.temperature || s.humidity)) throw fail('Ungültiger Tasmota-Fühler');
    sensor = { name: s.name.trim(), exposed: s.exposed, temperature: s.temperature, humidity: s.humidity };
  }
  if (!relays.length && !sensor && h.power !== true) throw fail('Tasmota-Gerät ohne unterstützte Funktion');
  return { mac: h.mac, ip: h.ip, name: h.name.trim(), version: h.version || '', auth: h.auth === true, relays, sensor, power: h.power === true };
}
// Nachsichtige Lesart der Konfiguration: Ungültiges wird ausgelassen, nie geraten.
function hostsFrom(config) {
  const list = isObject(config?.tasmota) && Array.isArray(config.tasmota.devices) ? config.tasmota.devices : [];
  const out = [], seen = new Set();
  for (const h of list.slice(0, LIMITS.hosts)) { try { const n = normalizeHost(h); if (!seen.has(n.mac)) { seen.add(n.mac); out.push(n); } } catch { } }
  return out;
}
function validPasswords(x) {
  if (!isObject(x)) throw fail('Ungültige Gerätepasswörter');
  const out = {};
  for (const [mac, pw] of Object.entries(x)) { if (!MAC.test(mac) || typeof pw !== 'string' || !pw || pw.length > LIMITS.password || /[\x00-\x1f\x7f]/.test(pw)) throw fail('Ungültige Gerätepasswörter'); out[mac] = pw; }
  return out;
}
const relayId = (mac, n) => mac + '-' + n;
const sensorId = mac => mac + '-s';
const relayAddress = (mac, n) => 'TASMOTA-' + mac + ':' + n;
const sensorAddress = mac => 'TASMOTA-' + mac + ':0';

// ---------- Dienst: Zustand, Abfragen, Schalten, Suche ----------
class Service extends EventEmitter {
  constructor(options = {}) {
    super(); this.setMaxListeners(50);
    this.options(options);
    this.hosts = new Map(); this.passwords = {}; this.timer = null; this.ticking = false;
    this.scanState = { running: false, done: 0, total: 0, found: [], finishedAt: null, error: null };
    this.persistAddress = null; this.rediscovering = false;
  }
  options(o = {}) {
    this.request = o.request || this.request || httpRequest;
    this.transport = o.endpoint ? { endpoint: o.endpoint } : (o.request ? {} : this.transport || {});
    this.now = o.now || this.now || Date.now;
    this.interfaces = o.interfaces || this.interfaces || (() => os.networkInterfaces());
    this.timing = { ...TIMING, ...(this.timing || {}), ...(o.timing || {}) };
  }
  // Geräteliste übernehmen; Laufzeitzustand bekannter Geräte bleibt erhalten.
  configure(hosts, passwords) {
    const next = new Map();
    for (const item of hosts) {
      const old = this.hosts.get(item.mac);
      const host = old || { online: false, verified: false, authMode: {}, failures: 0, lastSeen: 0, lastPoll: 0, lastSensors: 0, lastIdentify: 0, activeUntil: 0, uptime: null, lastError: '', relays: new Map(), readings: {}, chain: Promise.resolve(), busy: 0, offlineSince: 0, rediscover: 0, lastRediscover: 0 };
      if (old && (old.item.ip !== item.ip || old.item.auth !== item.auth)) { host.verified = false; host.authMode = {}; host.failures = 0; host.lastPoll = 0; host.uptime = null; }
      host.item = item;
      for (const n of [...host.relays.keys()]) if (!item.relays.some(r => r.n === n)) host.relays.delete(n);
      next.set(item.mac, host);
    }
    const removed = [...this.hosts.keys()].filter(mac => !next.has(mac));
    this.hosts = next;
    if (passwords) this.passwords = { ...passwords };
    for (const mac of Object.keys(this.passwords)) if (!next.has(mac)) delete this.passwords[mac];
    if (removed.length) this.emit('removed', removed);
    this.emit('configured');
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick(), 1000); this.timer.unref?.(); this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  tick() {
    const now = this.now();
    for (const host of this.hosts.values()) {
      if (host.busy) continue;
      // Schnell: erste Abfrage, nach Befehl/Änderung und nach einem Aussetzer (damit „offline“ so früh erkannt wird wie bisher).
      const every = !host.lastPoll || (host.online && (now < host.activeUntil || host.failures > 0)) ? this.timing.poll : host.online ? this.timing.pollIdle : this.timing.pollOffline;
      if (now - host.lastPoll >= every) this.poll(host).catch(() => { });
    }
    this.maybeRediscover(now);
  }
  // Alle Anfragen an ein Gerät nacheinander (Tasmota bedient immer nur eine).
  exec(host, cmnd, timeout) {
    host.busy++;
    const run = () => command(this.request, host.item.ip, cmnd, host.item.auth ? this.passwords[host.item.mac] : undefined, { ...this.transport, timeout: timeout || this.timing.request, mode: host.authMode });
    const task = host.chain.then(run, run);
    host.chain = task.catch(() => { }).finally(() => { host.busy--; });
    return task;
  }
  // Die Kennung (MAC) des Geräts wird beim ersten Kontakt, nach jedem Aussetzer, bei einem Sprung der
  // Gerätelaufzeit und danach regelmäßig geprüft. So gehen Befehle nie an ein fremdes Gerät, das
  // inzwischen dieselbe Adresse bekommen hat.
  async identify(host) {
    const d = describe(host.item.ip, await this.exec(host, 'Status 0'));
    if (this.hosts.get(host.item.mac) !== host) throw fail('Tasmota-Gerät nicht gefunden', 404);
    if (d.mac !== host.item.mac) {
      host.verified = false; host.lastError = 'Unter der gespeicherten Adresse antwortet ein anderes Gerät';
      if (host.online) { host.online = false; this.publish(host); }
      // Sofort nach der neuen Adresse suchen lassen.
      host.offlineSince = this.now() - 120000; host.lastRediscover = 0; host.rediscover = 0; host.failures = this.timing.offlineAfter;
      throw fail(host.lastError + '. Es wird nach dem Gerät gesucht.', 409, 'WRONGDEVICE');
    }
    host.verified = true; host.lastSensors = host.lastIdentify = this.now();
    host.uptime = null; this.sameRun(host, d.sts);
    this.seen(host);
    this.applySts(host, d.sts);
    if (isObject(d.sns)) this.applySns(host, d.sns);
    return d;
  }
  // Die Laufzeit des Geräts (UptimeSec) muss zur verstrichenen Zeit passen. Springt sie, wurde das Gerät
  // neu gestartet oder unter der Adresse antwortet ein anderes; dann wird die Kennung sofort geprüft.
  sameRun(host, sts) {
    const sec = sts.UptimeSec, now = this.now(), prev = host.uptime;
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) { host.uptime = null; return true; }
    host.uptime = { sec, at: now };
    if (!prev) return true;
    const elapsed = (now - prev.at) / 1000, delta = sec - prev.sec;
    return delta >= 0 && Math.abs(delta - elapsed) <= 15 + elapsed * 0.05;
  }
  async poll(host) {
    const now = this.now(); host.lastPoll = now;
    try {
      if (!host.verified || now - host.lastIdentify >= this.timing.identify) { await this.identify(host); return; }
      const data = await this.exec(host, 'Status 11');
      if (this.hosts.get(host.item.mac) !== host) return;
      if (!isObject(data.StatusSTS)) throw fail('Keine gültige Tasmota-Antwort', 502);
      if (!this.sameRun(host, data.StatusSTS)) { host.verified = false; await this.identify(host); return; }
      this.seen(host);
      this.applySts(host, data.StatusSTS);
      // Messwerte (Leistung, Temperatur, Feuchte) über die schlanke Abfrage, nur wo es welche gibt.
      if ((host.item.sensor || host.item.power) && now - host.lastSensors >= this.timing.sensors) {
        host.lastSensors = now;
        const sns = await this.exec(host, 'Status 10');
        if (this.hosts.get(host.item.mac) !== host) return;
        if (!isObject(sns.StatusSNS)) throw fail('Keine gültige Tasmota-Antwort', 502);
        this.applySns(host, sns.StatusSNS);
      }
    } catch (e) {
      if (this.hosts.get(host.item.mac) !== host || e.code === 'WRONGDEVICE') return;
      host.verified = false; host.failures++; host.lastError = e.code === 'AUTH' ? e.message : 'nicht erreichbar';
      if (host.online && host.failures >= this.timing.offlineAfter) { host.online = false; host.offlineSince = this.now(); host.rediscover = 0; host.lastRediscover = this.now(); this.publish(host); }
      else if (!host.online && !host.offlineSince) { host.offlineSince = this.now(); host.lastRediscover = this.now(); }
    }
  }
  seen(host) {
    host.failures = 0; host.lastSeen = this.now(); host.lastError = ''; host.offlineSince = 0; host.rediscover = 0;
    if (!host.online) { host.online = true; this.publish(host); }
  }
  relayState(host, n) { let s = host.relays.get(n); if (!s) { s = {}; host.relays.set(n, s); } return s; }
  applySts(host, sts) {
    const single = host.item.relays.length === 1;
    let moved = false; // echte Änderung (nicht das erste Einlesen) → eine Weile schneller abfragen
    for (const relay of host.item.relays) {
      const raw = Object.hasOwn(sts, 'POWER' + relay.n) ? sts['POWER' + relay.n] : (relay.n === 1 || single) && Object.hasOwn(sts, 'POWER') ? sts.POWER : undefined;
      const on = onOff(raw), state = this.relayState(host, relay.n);
      let changed = false;
      if (on !== undefined && state.on !== on) { moved ||= state.on !== undefined; state.on = on; changed = true; this.emit('value', { address: relayAddress(host.item.mac, relay.n), key: 'STATE', value: on }); }
      if (relay.dimmer && typeof sts.Dimmer === 'number' && sts.Dimmer >= 0 && sts.Dimmer <= 100 && state.brightness !== Math.round(sts.Dimmer)) { moved ||= state.brightness !== undefined; state.brightness = Math.round(sts.Dimmer); changed = true; this.emit('value', { address: relayAddress(host.item.mac, relay.n), key: 'LEVEL', value: state.brightness / 100 }); }
      if (changed) this.emit('state', this.entry(relayId(host.item.mac, relay.n)));
    }
    if (moved) host.activeUntil = this.now() + this.timing.activeMs;
  }
  applySns(host, sns) {
    const r = readings(sns); let changed = false;
    for (const [key, name] of [['temperature', 'TEMPERATURE'], ['humidity', 'HUMIDITY'], ['power', 'POWER'], ['energyToday', 'ENERGY_TODAY'], ['energyTotal', 'ENERGY_TOTAL']]) {
      if (r[key] === undefined || host.readings[key] === r[key]) continue;
      host.readings[key] = r[key]; changed = true;
      this.emit('value', { address: sensorAddress(host.item.mac), key: name, value: r[key] });
    }
    // Spannung/Strom nur für Anzeige und Diagramme (keine eigenen Automations-Auslöser)
    for (const key of ['voltage', 'current']) if (r[key] !== undefined && host.readings[key] !== r[key]) { host.readings[key] = r[key]; changed = true; }
    if (changed) this.publish(host);
  }
  publish(host) { for (const e of this.entriesOf(host)) this.emit('state', e); }
  entriesOf(host) {
    const h = host.item, out = [];
    for (const r of h.relays) {
      const s = host.relays.get(r.n) || {};
      out.push({ id: relayId(h.mac, r.n), mac: h.mac, ip: h.ip, kind: r.dimmer ? 'light' : 'plug', relay: r.n, name: r.name, exposed: r.exposed, dimmer: r.dimmer, online: host.online, address: relayAddress(h.mac, r.n), state: { ...(typeof s.on === 'boolean' ? { on: s.on } : {}), ...(r.dimmer && Number.isFinite(s.brightness) ? { brightness: s.brightness } : {}), ...(r.n === h.relays[0].n && Number.isFinite(host.readings.power) ? { power: host.readings.power } : {}), ...(r.n === h.relays[0].n && Number.isFinite(host.readings.energyToday) ? { energyToday: host.readings.energyToday } : {}), ...(r.n === h.relays[0].n && Number.isFinite(host.readings.energyTotal) ? { energyTotal: host.readings.energyTotal } : {}), ...(r.n === h.relays[0].n && Number.isFinite(host.readings.voltage) ? { voltage: host.readings.voltage } : {}), ...(r.n === h.relays[0].n && Number.isFinite(host.readings.current) ? { current: host.readings.current } : {}) } });
    }
    if (h.sensor) out.push({ id: sensorId(h.mac), mac: h.mac, ip: h.ip, kind: 'sensor', name: h.sensor.name, exposed: h.sensor.exposed, online: host.online, address: sensorAddress(h.mac), readings: { temperature: h.sensor.temperature, humidity: h.sensor.humidity }, state: { ...(h.sensor.temperature && Number.isFinite(host.readings.temperature) ? { temperature: host.readings.temperature } : {}), ...(h.sensor.humidity && Number.isFinite(host.readings.humidity) ? { humidity: host.readings.humidity } : {}) } });
    return out;
  }
  entries() { return [...this.hosts.values()].flatMap(h => this.entriesOf(h)); }
  entry(id) { const m = ENTRY_ID.exec(id || ''); const host = m && this.hosts.get(m[1]); return host ? this.entriesOf(host).find(e => e.id === id) || null : null; }
  // Schalten oder Dimmen: ein Sendeversuch; „bestätigt“ ist nur die Antwort des Geräts.
  async control(id, cmd) {
    const m = ENTRY_ID.exec(typeof id === 'string' ? id : ''), host = m && this.hosts.get(m[1]);
    const relay = host && m[2] !== 's' ? host.item.relays.find(r => r.n === Number(m[2])) : null;
    if (!host || (m[2] === 's' && !host.item.sensor)) throw fail('Tasmota-Gerät nicht gefunden', 404);
    if (!relay) throw fail('Fühler liefern Messwerte und sind nicht schaltbar');
    if (!only(cmd, ['on', 'brightness']) || Object.keys(cmd).length !== 1) throw fail('Ungültiger Befehl');
    let text;
    if (Object.hasOwn(cmd, 'on')) { if (typeof cmd.on !== 'boolean') throw fail('Ein oder Aus wählen'); text = 'Power' + relay.n + (cmd.on ? ' ON' : ' OFF'); }
    else {
      if (!relay.dimmer) throw fail('Dieses Gerät lässt sich nicht dimmen');
      if (!Number.isInteger(cmd.brightness) || cmd.brightness < 0 || cmd.brightness > 100) throw fail('Helligkeit: 0 bis 100 Prozent');
      text = cmd.brightness === 0 ? 'Power' + relay.n + ' OFF' : 'Dimmer ' + cmd.brightness;
    }
    let data;
    host.activeUntil = this.now() + this.timing.activeMs; // nach einem Befehl eine Weile schneller abfragen
    try {
      if (!host.verified) await this.identify(host); // erst sicherstellen, dass es das richtige Gerät ist
      data = await this.exec(host, text);
    } catch (e) {
      if (e.code === 'WRONGDEVICE') throw e;
      host.verified = false;
      throw fail(e.code === 'AUTH' ? e.message : 'Gerät nicht erreichbar – Befehl wurde nicht bestätigt', e.code === 'AUTH' ? 401 : 503);
    }
    if (this.hosts.get(host.item.mac) !== host) throw fail('Tasmota-Gerät nicht gefunden', 404);
    if (typeof data.Command === 'string') throw fail('Das Gerät kennt diesen Befehl nicht', 502);
    this.seen(host);
    this.applySts(host, data);
    const state = this.relayState(host, relay.n);
    const wantOn = Object.hasOwn(cmd, 'on') ? cmd.on : cmd.brightness > 0;
    const answered = Object.hasOwn(data, 'POWER' + relay.n) || Object.hasOwn(data, 'POWER') || (Object.hasOwn(cmd, 'brightness') && typeof data.Dimmer === 'number');
    const confirmed = answered && state.on === wantOn && (!Object.hasOwn(cmd, 'brightness') || cmd.brightness === 0 || state.brightness === cmd.brightness);
    return { confirmed, entry: this.entry(relayId(host.item.mac, relay.n)) };
  }
  // Ein einzelnes Gerät unter einer Adresse abfragen (ohne es zu speichern).
  async probe(ip, password, timeout) {
    if (!privateIp(ip)) throw fail('Bitte eine Adresse aus dem Heimnetz angeben, z. B. 192.168.50.70');
    return describe(ip, await command(this.request, ip, 'Status 0', password || undefined, { ...this.transport, timeout: timeout || this.timing.request }));
  }
  // Heimnetz der Zentrale nach Tasmota-Geräten absuchen. Es wird nie ein Passwort mitgeschickt.
  async sweep(onProgress) {
    const subnets = ownSubnets(this.interfaces), targets = [];
    for (const s of subnets) for (let i = 1; i <= 254; i++) { const ip = s.base + '.' + i; if (ip !== s.self) targets.push(ip); }
    const found = []; let index = 0, done = 0;
    const worker = async () => {
      while (index < targets.length) {
        const ip = targets[index++];
        try { const d = await this.probe(ip, undefined, this.timing.probe); found.push({ ip, mac: d.mac, name: d.name, version: d.version, summary: summary(d), supported: d.relays.length > 0 || !!d.sensor || d.power, needsPassword: false }); }
        catch (e) { if (e.code === 'AUTH') found.push({ ip, mac: '', name: 'Tasmota-Gerät mit Passwort', version: '', summary: 'verlangt das Gerätepasswort', supported: true, needsPassword: true }); }
        done++; onProgress?.(done, targets.length, found);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.timing.scanParallel, targets.length || 1) }, worker));
    return { found: found.sort((a, b) => ipParts(a.ip)[3] - ipParts(b.ip)[3] || a.ip.localeCompare(b.ip)), subnets: subnets.map(s => s.base + '.0/24'), total: targets.length };
  }
  startScan() {
    if (this.scanState.running || this.rediscovering) throw fail('Die Suche läuft bereits', 429);
    const state = this.scanState = { running: true, done: 0, total: 0, found: [], finishedAt: null, error: null, subnets: [] };
    this.sweep((done, total) => { state.done = done; state.total = total; })
      .then(r => { state.found = r.found; state.subnets = r.subnets; state.total = r.total; state.done = r.total; if (!r.subnets.length) state.error = 'Kein Heimnetz gefunden, das durchsucht werden kann.'; this.adoptAddresses(r.found); })
      .catch(() => { state.error = 'Die Suche ist fehlgeschlagen.'; })
      .finally(() => { state.running = false; state.finishedAt = new Date(this.now()).toISOString(); });
    return state;
  }
  scanStatus() {
    const s = this.scanState;
    return { running: s.running, done: s.done, total: s.total, finishedAt: s.finishedAt, error: s.error, subnets: s.subnets || [], found: s.found.map(f => ({ ...f, known: !!f.mac && this.hosts.has(f.mac) })) };
  }
  // Hat ein bekanntes Gerät vom Router eine neue Adresse bekommen, wird sie übernommen.
  // Nicht bei Geräten mit Passwort: Ihr Passwort soll nie an eine Adresse gehen, die sich nur
  // als dieses Gerät ausgibt. Solche Geräte werden von Hand über „Hinzufügen“ aktualisiert.
  adoptAddresses(found) {
    for (const f of found) {
      const host = f.mac && this.hosts.get(f.mac);
      if (!host || host.item.auth || host.item.ip === f.ip || !privateIp(f.ip)) continue;
      host.item = { ...host.item, ip: f.ip }; host.verified = false; host.failures = 0; host.lastPoll = 0;
      try { this.persistAddress?.(f.mac, f.ip); } catch { }
    }
  }
  // Ist ein Gerät länger nicht erreichbar, wird in wachsenden Abständen nach seiner neuen Adresse gesucht.
  maybeRediscover(now) {
    if (this.rediscovering || this.scanState.running) return;
    const due = [...this.hosts.values()].filter(h => !h.item.auth && !h.online && h.offlineSince && now - h.offlineSince >= 120000 && now - h.lastRediscover >= this.timing.rediscover[Math.min(h.rediscover, this.timing.rediscover.length - 1)]);
    if (!due.length) return;
    for (const h of due) { h.lastRediscover = now; h.rediscover++; }
    this.rediscovering = true;
    this.sweep().then(r => this.adoptAddresses(r.found)).catch(() => { }).finally(() => { this.rediscovering = false; });
  }
}
let shared = null;
function getService() { return shared ||= new Service(); }

// ---------- Anbindung an die Weboberfläche ----------
const dataDir = web => path.dirname(web.deps.configPath);
const vault = web => new (require('./smartplus').Vault)(path.join(dataDir(web), 'tasmota-secrets.json'));
function readPasswords(web) { try { return validPasswords(vault(web).read()); } catch { return {}; } }
const synced = new WeakMap();
// Konfiguration → Dienst (nur wenn sich die gespeicherte Liste geändert hat).
function sync(web, force = false) {
  const svc = getService();
  let ref; try { ref = web.security.configSnapshot.read().tasmota; } catch { return svc; }
  if (!force && synced.has(web) && synced.get(web) === ref && svc.configuredFor === web) return svc;
  synced.set(web, ref); svc.configuredFor = web;
  svc.persistAddress = (mac, ip) => { web.writeConfigPatch(c => { const h = c.tasmota?.devices?.find(d => d.mac === mac); if (h && privateIp(ip)) h.ip = ip; }); };
  svc.configure(hostsFrom({ tasmota: ref }), readPasswords(web));
  return svc;
}
const tickers = new WeakMap();
function start(web) {
  const svc = sync(web, true);
  svc.start();
  if (!tickers.has(web)) { const t = setInterval(() => { try { sync(web); } catch { } }, 2000); t.unref?.(); tickers.set(web, t); }
  return svc;
}
function stop(web) { const t = tickers.get(web); if (t) clearInterval(t); tickers.delete(web); synced.delete(web); const svc = getService(); if (svc.configuredFor === web) { svc.stop(); svc.configuredFor = null; } }

// ---------- Zuordnung zu CUxD ----------
// Auf der CCU3 sind Tasmota-Steckdosen als CUxD-Geräte (Typ 28 „System“) eingerichtet und darüber schon in Apple Home:
// cuxd.ps enthält je Gerät eine Kopfzeile „28 01003 HM-LC-Sw1-Pl“ und „ PARAMD 1 9 192.168.50.70“.
// Diese Steckdosen werden ihrem CUxD-Gerät zugeordnet und nicht ein zweites Mal in Apple Home angelegt.
const CUXD_PS = '/usr/local/addons/cuxd/cuxd.ps';
let cuxdCache = { file: '', mtime: -1, map: new Map() };
function parseCuxd(text) {
  const map = new Map(); let dev = null;
  for (const line of String(text).split(/\r?\n/)) {
    const head = /^(\d{2}) (\d{5}) \S/.exec(line);
    if (head) { dev = 'CUX' + head[1] + head[2]; continue; }
    const ip = /^\s+PARAMD \d+ \d+ (\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(line);
    if (dev && ip && !map.has(ip[1])) map.set(ip[1], dev);
  }
  return map;
}
function cuxdLinks(web) {
  const file = web.deps?.cuxdPs || CUXD_PS;
  // CUxD abgelöst (in der Verbindung zur CCU ausgeschaltet): keine Verknüpfung mehr – Steckdosen direkt freigeben.
  // CUxD ist abgelöst: nur noch zuordnen, wenn es ausdrücklich eingeschaltet ist (fehlt der Eintrag, gibt es kein CUxD).
  try { if (web.security?.configSnapshot?.read()?.ccu?.interfaces?.CUxD?.enabled !== true) return new Map(); } catch { return new Map(); }
  try {
    const fs = require('node:fs'), st = fs.statSync(file);
    if (st.size > 262144) return new Map();
    if (cuxdCache.file !== file || cuxdCache.mtime !== st.mtimeMs) cuxdCache = { file, mtime: st.mtimeMs, map: parseCuxd(fs.readFileSync(file, 'latin1')) };
    return cuxdCache.map;
  } catch { return new Map(); }
}
function cuxdOf(web, ip) {
  const address = cuxdLinks(web).get(ip);
  if (!address) return null;
  let name = '';
  try { const d = web.deps.getDevices?.(); name = cleanText((d?.get?.(address + ':1') || d?.get?.(address))?.name || '', LIMITS.name); } catch {}
  return { address, name };
}
function publicEntry(e, web) {
  const cuxd = web ? cuxdOf(web, e.ip) : null;
  return { id: e.id, mac: e.mac, ip: e.ip, kind: e.kind, name: e.name, exposed: e.exposed, online: e.online, state: e.state, address: e.address, ...(cuxd ? { cuxd } : {}), capabilities: { kind: e.kind, brightness: e.dimmer === true, ...(e.readings ? { readings: e.readings } : {}) } };
}
function publicList(web) {
  const svc = sync(web);
  return { devices: svc.entries().map(e => publicEntry(e, web)), hosts: [...svc.hosts.values()].map(h => { const cuxd = cuxdOf(web, h.item.ip); return { mac: h.item.mac, ip: h.item.ip, name: h.item.name, version: h.item.version, online: h.online, password: h.item.auth, lastSeen: h.lastSeen ? new Date(h.lastSeen).toISOString() : null, error: h.online ? '' : h.lastError, parts: svc.entriesOf(h).map(e => e.id), ...(cuxd ? { cuxd } : {}) }; }), limits: { hosts: LIMITS.hosts } };
}
// Zeilen für die Seite „Geräte“ (gleiche Form wie die übrigen WLAN-Geräte). Wirft nie.
function rows(web) {
  try {
    return sync(web).entries().map(e => ({ ...(cuxdOf(web, e.ip) ? { cuxd: cuxdOf(web, e.ip) } : {}), address: 'tasmota@' + e.id, provider: 'tasmota', id: e.id, name: e.name, customName: true, exposed: e.exposed, hmChannelType: 'Tasmota', hmDeviceType: e.kind === 'sensor' ? 'Fühler' : e.kind === 'light' ? 'Dimmer' : 'Schalter', interfaceId: 'tasmota', matterDeviceType: e.kind === 'sensor' ? 'Temperature / Humidity Sensor' : e.kind === 'light' ? 'DimmableLight' : 'OnOffPlugInUnit', room: '', roomId: '', online: e.online, onlineCheck: false, currentState: e.state, switchState: typeof e.state.on === 'boolean' ? e.state.on : null, switchControl: { allowed: false }, wifiUrl: '/tasmota.html', capabilities: { kind: e.kind, brightness: e.dimmer === true } }));
  } catch { return []; }
}
function writeHosts(web, change) {
  web.writeConfigPatch(c => {
    const hosts = hostsFrom(c);
    const next = change(hosts) || hosts;
    if (next.length > LIMITS.hosts) throw fail('Höchstens ' + LIMITS.hosts + ' Tasmota-Geräte');
    c.tasmota = { devices: next.map(h => { const n = normalizeHost(h); if (!n.sensor) delete n.sensor; return n; }) };
  });
}
// Geänderte Liste sofort im Dienst und – falls die Bridge läuft – in Matter anwenden.
async function apply(web) {
  const svc = sync(web, true);
  let matter = 'unverändert';
  try { const manager = web.deps.getTasmota?.(); if (manager) matter = (await manager.reconcile(hostsFrom(web.security.configSnapshot.read()))) ? 'angewendet' : 'unverändert'; }
  catch { matter = 'fehlgeschlagen'; }
  return { svc, matter };
}
const busy = new WeakSet();
async function exclusive(web, fn) {
  if (busy.has(web) || web.wifiSetupBusy || web.backupBusy) throw fail('Eine Einrichtung läuft bereits; bitte kurz warten', 429);
  busy.add(web);
  try { return await fn(); } finally { busy.delete(web); }
}
const POST = {
  async scanTasmota(web, p) {
    if (!only(p, [])) throw fail('Unerwartete Angaben');
    sync(web).startScan();
    return { success: true, scan: sync(web).scanStatus(), message: 'Die Suche im Heimnetz läuft.' };
  },
  // Gerät prüfen und mit allen Schaltern/Fühlern aufnehmen. Bei einem bekannten Gerät: Adresse/Passwort aktualisieren.
  addTasmota(web, p) {
    return exclusive(web, async () => {
      if (!only(p, ['ip', 'password']) || typeof p.ip !== 'string') throw fail('Bitte die Adresse des Geräts angeben');
      const ip = p.ip.trim();
      if (!privateIp(ip)) throw fail('Bitte eine Adresse aus dem Heimnetz angeben, z. B. 192.168.50.70');
      if (p.password !== undefined && (typeof p.password !== 'string' || p.password.length > LIMITS.password || /[\x00-\x1f\x7f]/.test(p.password))) throw fail('Gerätepasswort ungültig');
      const svc = sync(web);
      const existingByIp = [...svc.hosts.values()].find(h => h.item.ip === ip);
      // Ohne neue Eingabe darf ein gespeichertes Passwort nur an das Gerät gehen, zu dem es gehört.
      const password = p.password || (existingByIp?.item.auth ? svc.passwords[existingByIp.item.mac] : undefined);
      let d;
      try { d = await svc.probe(ip, password); }
      catch (e) {
        if (e.code === 'AUTH') throw fail(password ? 'Das Gerätepasswort wird nicht angenommen.' : 'Dieses Gerät verlangt sein Passwort (in Tasmota: „Web Admin Password“). Bitte eintragen.', 401, 'AUTH');
        if (e.code === 'NOTASMOTA') throw fail('Unter ' + ip + ' antwortet kein Tasmota-Gerät.', 422);
        throw fail('Unter ' + ip + ' ist kein Gerät erreichbar. WLAN und Adresse prüfen.', 502);
      }
      if (!d.relays.length && !d.sensor && !d.power) throw fail(d.shutter ? 'Dieses Gerät ist als Rollladen eingerichtet. Das wird noch nicht unterstützt.' : 'Dieses Gerät hat keinen Schalter und keinen unterstützten Fühler.', 422);
      if (existingByIp && existingByIp.item.mac !== d.mac && !p.password && existingByIp.item.auth) throw fail('Unter dieser Adresse antwortet jetzt ein anderes Gerät. Bitte das Passwort neu eingeben.', 409);
      let added = false;
      const cuxName = cuxdOf(web, ip)?.name || '';
      writeHosts(web, hosts => {
        const old = hosts.find(h => h.mac === d.mac);
        const relays = d.relays.map(r => { const o = old?.relays.find(x => x.n === r.n); return { n: r.n, name: o?.name || (cuxName && d.relays.length === 1 ? cuxName : r.name), exposed: o?.exposed === true, dimmer: r.dimmer }; });
        const sensor = d.sensor ? { name: old?.sensor?.name || (d.name + ' Fühler').slice(0, LIMITS.name), exposed: old?.sensor?.exposed === true, temperature: d.sensor.temperature, humidity: d.sensor.humidity } : null;
        const next = { mac: d.mac, ip, name: old?.name || cuxName || d.name, version: d.version, auth: !!password, relays, ...(sensor ? { sensor } : {}), power: d.power };
        if (old) hosts[hosts.indexOf(old)] = next; else { if (hosts.length >= LIMITS.hosts) throw fail('Höchstens ' + LIMITS.hosts + ' Tasmota-Geräte'); hosts.push(next); added = true; }
      });
      const secrets = readPasswords(web);
      if (password) secrets[d.mac] = password; else delete secrets[d.mac];
      for (const mac of Object.keys(secrets)) if (!hostsFrom(web.security.configSnapshot.read()).some(h => h.mac === mac) && mac !== d.mac) delete secrets[mac];
      if (password || Object.keys(secrets).length || require('node:fs').existsSync(vault(web).file)) vault(web).write(secrets);
      const { svc: s, matter } = await apply(web);
      const host = s.hosts.get(d.mac);
      if (host) { host.verified = true; host.lastSensors = host.lastIdentify = s.now(); host.lastPoll = s.now(); host.uptime = null; s.sameRun(host, d.sts); s.seen(host); s.applySts(host, d.sts); if (isObject(d.sns)) s.applySns(host, d.sns); }
      const linked = cuxdOf(web, ip);
      return { success: true, added, mac: d.mac, matter, ...publicList(web), message: (added ? '„' + d.name + '“ wurde hinzugefügt' : '„' + d.name + '“ wurde aktualisiert') + ' (' + summary(d) + ').' + (linked ? ' Gehört zum CUxD-Gerät ' + (linked.name ? '„' + linked.name + '“ (' + linked.address + ')' : linked.address) + ' und ist darüber schon in Apple Home.' : '') };
    });
  },
  setTasmotaDevice(web, p) {
    return exclusive(web, async () => {
      if (!only(p, ['id', 'name', 'exposed']) || typeof p.id !== 'string' || Object.keys(p).length < 2) throw fail('Ungültige Änderung');
      const m = ENTRY_ID.exec(p.id); if (!m) throw fail('Gerät ungültig');
      if (p.name !== undefined && !validName(p.name)) throw fail('Gerätename muss 1–64 Zeichen enthalten');
      if (p.exposed !== undefined && typeof p.exposed !== 'boolean') throw fail('Ungültige Auswahl');
      if (p.exposed === true) {
        const linked = cuxdOf(web, sync(web).hosts.get(m[1])?.item.ip);
        if (linked) throw fail('Diese Steckdose ist schon als CUxD-Gerät ' + (linked.name ? '„' + linked.name + '“ (' + linked.address + ')' : linked.address) + ' in Apple Home. Ein zweites Gerät würde dort doppelt erscheinen.', 409, 'CUXD');
      }
      let name = '';
      writeHosts(web, hosts => {
        const host = hosts.find(h => h.mac === m[1]);
        const part = host && (m[2] === 's' ? host.sensor : host.relays.find(r => r.n === Number(m[2])));
        if (!part) throw fail('Tasmota-Gerät nicht gefunden', 404);
        if (p.name !== undefined) part.name = p.name.trim();
        if (p.exposed !== undefined) part.exposed = p.exposed;
        name = part.name;
      });
      const { matter } = await apply(web);
      if (matter === 'fehlgeschlagen') return { success: true, name, matter, ...publicList(web), message: 'Gespeichert. Apple Home übernimmt die Änderung nach einem Neustart der Bridge (System → Wartung).' };
      return { success: true, name, matter, ...publicList(web), message: p.exposed === true ? '„' + name + '“ erscheint jetzt in Apple Home.' : p.exposed === false ? '„' + name + '“ ist aus Apple Home entfernt.' : 'Gespeichert.' };
    });
  },
  removeTasmota(web, p) {
    return exclusive(web, async () => {
      if (!only(p, ['mac']) || typeof p.mac !== 'string' || !MAC.test(p.mac)) throw fail('Gerät ungültig');
      let name = '';
      writeHosts(web, hosts => { const host = hosts.find(h => h.mac === p.mac); if (!host) throw fail('Tasmota-Gerät nicht gefunden', 404); name = host.name; return hosts.filter(h => h.mac !== p.mac); });
      const secrets = readPasswords(web);
      if (Object.hasOwn(secrets, p.mac)) { delete secrets[p.mac]; vault(web).write(secrets); }
      const { matter } = await apply(web);
      return { success: true, matter, ...publicList(web), message: '„' + name + '“ wurde entfernt. Am Gerät selbst wurde nichts geändert.' };
    });
  },
  async controlTasmota(web, p) {
    if (!only(p, ['id', 'command']) || typeof p.id !== 'string' || !ENTRY_ID.test(p.id) || !isObject(p.command)) throw fail('Ungültiger Befehl');
    const r = await sync(web).control(p.id, p.command);
    return { success: true, confirmed: r.confirmed, online: r.entry?.online === true, state: r.entry?.state || {}, message: r.confirmed ? 'Vom Gerät bestätigt.' : 'Befehl gesendet; das Gerät hat den neuen Zustand nicht bestätigt.' };
  }
};
const ADMIN = ['scanTasmota', 'addTasmota', 'setTasmotaDevice', 'removeTasmota'];
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  const gets = ['getTasmotaDevices', 'getTasmotaScan'];
  if (!gets.includes(method) && !Object.hasOwn(POST, method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (gets.includes(method)) {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      if (method === 'getTasmotaDevices') send(200, publicList(web));
      else if (!auth || auth.session?.localBypass) send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' });
      else send(200, sync(web).scanStatus());
      return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || (ADMIN.includes(method) && auth.session?.localBypass)) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    send(200, await POST[method](web, p));
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Tasmota: Anfrage fehlgeschlagen', ...(error.code === 'AUTH' ? { needsPassword: true } : {}) }); }
  return true;
}

// ---------- Automationen: Tasmota-Geräte als Auslöser und Ziel ----------
function automation(web) {
  const svc = () => sync(web);
  const parse = address => { const m = ADDRESS.exec(typeof address === 'string' ? address : ''); const host = m && svc().hosts.get(m[1]); return host ? { host, n: Number(m[2]) } : null; };
  const part = address => { const x = parse(address); if (!x) return null; if (x.n === 0) return x.host.item.sensor || x.host.item.power ? { ...x, sensor: true } : null; const relay = x.host.item.relays.find(r => r.n === x.n); return relay ? { ...x, relay } : null; };
  const sourcesOfPart = x => {
    const out = [], h = x.host;
    if (x.relay) {
      const s = h.relays.get(x.n) || {};
      out.push({ key: 'STATE', kind: 'bool', title: 'Schaltzustand', on: 'eingeschaltet', off: 'ausgeschaltet', ...(typeof s.on === 'boolean' ? { current: s.on } : {}) });
      if (x.relay.dimmer) out.push({ key: 'LEVEL', kind: 'number', title: 'Helligkeit', unit: '%', scale: 100, min: 0, max: 100, ...(Number.isFinite(s.brightness) ? { current: s.brightness } : {}) });
    } else {
      if (h.item.sensor?.temperature) out.push({ key: 'TEMPERATURE', kind: 'number', title: 'Temperatur', unit: '°C', scale: 1, min: -40, max: 80, ...(Number.isFinite(h.readings.temperature) ? { current: h.readings.temperature } : {}) });
      if (h.item.sensor?.humidity) out.push({ key: 'HUMIDITY', kind: 'number', title: 'Luftfeuchte', unit: '%', scale: 1, min: 0, max: 100, ...(Number.isFinite(h.readings.humidity) ? { current: h.readings.humidity } : {}) });
      if (h.item.power) out.push({ key: 'POWER', kind: 'number', title: 'Leistung', unit: 'W', scale: 1, min: 0, max: 100000, ...(Number.isFinite(h.readings.power) ? { current: h.readings.power } : {}) });
    }
    return out;
  };
  const nameOf = x => x.relay ? x.relay.name : x.host.item.sensor?.name || x.host.item.relays[0]?.name || x.host.item.name;
  return {
    owns: address => typeof address === 'string' && address.startsWith('TASMOTA-'),
    has: address => !!part(address),
    name: address => { const x = part(address); return x ? nameOf(x) : 'Tasmota-Gerät ' + address; },
    sources(address) {
      if (address !== undefined) { const x = part(address); return x ? sourcesOfPart(x) : []; }
      const out = [];
      for (const h of svc().hosts.values()) for (const addr of [...h.item.relays.map(r => relayAddress(h.item.mac, r.n)), sensorAddress(h.item.mac)]) { const x = part(addr); if (x) for (const s of sourcesOfPart(x)) out.push({ address: addr, name: nameOf(x), room: 'Tasmota (WLAN)', ...s }); }
      return out;
    },
    targets() { return [...svc().hosts.values()].flatMap(h => h.item.relays.map(r => ({ address: relayAddress(h.item.mac, r.n), name: r.name, room: 'Tasmota (WLAN)', switch: true, dimmer: r.dimmer === true, thermostat: null }))); },
    capabilities(address) { const x = part(address); return x?.relay ? { switch: true, dimmer: x.relay.dimmer === true, thermostat: null } : null; },
    value(address, key) {
      const x = part(address); if (!x) return undefined;
      if (x.relay) { const s = x.host.relays.get(x.n) || {}; return key === 'STATE' ? s.on : key === 'LEVEL' && Number.isFinite(s.brightness) ? s.brightness / 100 : undefined; }
      return { TEMPERATURE: x.host.readings.temperature, HUMIDITY: x.host.readings.humidity, POWER: x.host.readings.power }[key];
    },
    async switch(address, on) { const x = part(address); if (!x?.relay) throw fail('Tasmota-Gerät nicht gefunden', 404); return { confirmed: (await svc().control(relayId(x.host.item.mac, x.n), { on })).confirmed }; },
    async dimmer(address, percent) { const x = part(address); if (!x?.relay) throw fail('Tasmota-Gerät nicht gefunden', 404); if (!x.relay.dimmer) throw fail('Dieses Gerät lässt sich nicht dimmen', 403); return { confirmed: (await svc().control(relayId(x.host.item.mac, x.n), { brightness: percent })).confirmed }; },
    async thermostat() { throw fail('Kein Thermostat', 403); },
    subscribe(listener) { const svcNow = getService(); svcNow.on('value', listener); return () => svcNow.off('value', listener); }
  };
}

// ---------- Sicherung ----------
function captureBackup(web) { return { devices: hostsFrom(web.security.configSnapshot.read()), passwords: readPasswords(web) }; }
function validateBackup(x) {
  if (!only(x, ['devices', 'passwords']) || !Array.isArray(x.devices) || x.devices.length > LIMITS.hosts) throw fail('Ungültige Tasmota-Geräte in der Sicherung');
  const macs = new Set();
  const devices = x.devices.map(h => { const n = normalizeHost(h); if (macs.has(n.mac)) throw fail('Ungültige Tasmota-Geräte in der Sicherung'); macs.add(n.mac); return n; });
  const passwords = validPasswords(x.passwords === undefined ? {} : x.passwords);
  for (const mac of Object.keys(passwords)) if (!macs.has(mac)) throw fail('Ungültige Tasmota-Geräte in der Sicherung');
  for (const d of devices) if (d.auth && !passwords[d.mac]) throw fail('Gerätepasswort fehlt in der Sicherung');
  return { devices, passwords };
}
const secretsFile = web => vault(web).file;

module.exports = { handle, start, stop, rows, automation, getService, hostsFrom, normalizeHost, captureBackup, validateBackup, secretsFile, LIMITS, _test: { parseCuxd, cuxdOf, Service, httpRequest, command, commandOnce, describe, summary, readings, privateIp, ownSubnets, sync, publicList, relayId, sensorId, relayAddress, sensorAddress, reset() { shared?.stop(); shared?.removeAllListeners(); shared = null; } } };
