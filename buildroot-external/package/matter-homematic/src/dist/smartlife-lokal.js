'use strict';
// Smart Life und SMART+ (beide Tuya) direkt im Heimnetz – nach dem Vorbild von tasmota.js:
// - lokales Tuya-Protokoll 3.3 (3.4/3.5 über dieselbe Bibliothek), nur private Heimnetz-Adressen
// - Kennungsprüfung: jede Antwort muss mit dem Geräteschlüssel (local_key) verschlüsselt sein und die
//   eigene Geräte-ID tragen; unverschlüsselte oder fremde Antworten werden verworfen. Vor einem Befehl
//   an ein länger nicht bestätigtes Gerät wird zuerst der Status gelesen.
// - sparsamer Takt: in Ruhe alle 10 s, nach einem Befehl 2 Minuten lang alle 3 s, nicht erreichbar alle 30 s
// - Leistung/Spannung/Strom, wenn die Steckdose sie misst (Profil aus smartlife-profile.js)
// - Adresssuche schonend: zuerst nur die Nachbarliste (ARP) der CCU; das Heimnetz wird höchstens einmal je Stunde
//   durchsucht und dabei nie ein bekanntes Gerät angesprochen (Tuya-Geräte erlauben nur eine Verbindung; ständiges
//   Anklopfen alle 90 s kann sie nach Tagen hängen lassen).
// - Rückfall Tuya-Cloud (nur Smart Life) für Steckdosen/Schalter, nur solange sie lokal nicht erreichbar sind (höchstens alle 5 min,
//   höchstens 1000 Anfragen je Tag; nutzt nur den beim Import gespeicherten Zugang)
// Geräteschlüssel und Cloud-Zugang liegen verschlüsselt (AES-256-GCM, Vault aus smartplus.js) und werden nie
// ausgegeben oder protokolliert.
const path = require('node:path'), crypto = require('node:crypto'), net = require('node:net'), { EventEmitter } = require('node:events');
const { Smartplus, Vault, validIp, validId, bounded } = require('./smartplus');
const { ENDPOINTS, signature, validateCredentials } = require('./smartlife-cloud');

const TIMING = Object.freeze({ poll: 3000, pollIdle: 10000, activeMs: 120000, retry: 30000, verify: 15000, tick: 1000, cloud: 300000, cloudTrigger: 60000, cloudNotice: 3600000, cloudDaily: 1000, scan: 3600000 });
const VERSIONS = ['3.1', '3.3', '3.4', '3.5'];
const SWITCHING = ['plug', 'switch'];
const fail = (message, status) => Object.assign(Error(message), { status });

// Härtet den Parser einer tuyapi-Verbindung: ab Protokoll 3.2 nur Antworten, die sich mit dem Geräteschlüssel
// entschlüsseln lassen (die Bibliothek würde sonst Klartext annehmen), und nie Daten mit fremder Geräte-ID.
function harden(client) {
  const parser = client?.device?.parser, id = client?.device?.id;
  if (!parser || typeof parser.getPayload !== 'function' || parser.hardened) return client;
  const original = parser.getPayload.bind(parser);
  parser.getPayload = (data, version) => {
    if (!data || !data.length) return original(data, version);
    const v = String(version || parser.version);
    // Eine nicht vertrauenswürdige Antwort beendet die Verbindung sofort (offene Abfragen scheitern ohne Wartezeit).
    const reject = message => { queueMicrotask(() => { try { client.disconnect(); } catch {} }); throw Error(message); };
    if (v !== '3.1') { try { parser.cipher.decrypt(data, v); } catch { reject('Tuya-Antwort nicht mit dem Geräteschlüssel verschlüsselt'); } }
    const out = original(data, version);
    if (out && typeof out === 'object' && !Buffer.isBuffer(out)) {
      const devId = out.devId ?? out.data?.devId;
      if (devId !== undefined && devId !== id) reject('Antwort eines fremden Tuya-Geräts');
    }
    return out;
  };
  parser.hardened = true;
  return client;
}
function hardenedClient(Base) {
  return class extends Base { constructor(options) { super(options); harden(this); } };
}

// Cloud-Status einer Steckdose über die im Profil bestätigten Codes; nie einen Datenpunkt raten.
function plugFromStatus(profile, status) {
  if (!SWITCHING.includes(profile?.kind) || !Array.isArray(status) || status.length > 255) throw Error('Ungültige Steckdosen-Statusantwort');
  const values = {}, one = code => { const m = status.filter(dp => dp?.code === code); return m.length === 1 ? m[0].value : undefined; };
  const on = one(profile.on?.code);
  if (typeof on === 'boolean') values.on = on;
  const usb = profile.usb ? one(profile.usb.code) : undefined;
  if (typeof usb === 'boolean') values.usb = usb;
  for (const [key, f] of Object.entries(profile.readings || {})) {
    const raw = one(f.code);
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= f.min && raw <= f.max) values[key] = raw / 10 ** (f.scale || 0);
  }
  return values;
}

// Tuya-OpenAPI für den Rückfall: Status lesen und Schaltbefehl. Gleiche Grenzen wie smartlife-cloud.js.
// Tuya meldet den abgelaufenen kostenlosen Zugang („IoT Core“-Testzeitraum) mit diesem Code (belegt in tinytuya/Home-Assistant-Berichten).
const EXPIRED = '28841002';
class CloudFallback {
  constructor({ credentials, entries, apply, notice = () => {}, expired = null, fetchImpl = fetch, now = Date.now, nonce = () => crypto.randomUUID(), timing = TIMING }) {
    Object.assign(this, { credentials, entries, apply, notice, expired, fetch: fetchImpl, now, nonce, timing });
    this.session = null; this.running = null; this.stopped = false; this.lastRound = -Infinity; this.lastNotice = -Infinity; this.abort = new AbortController();
  }
  start() { if (this.timer || this.stopped) return; this.timer = setInterval(() => this.poll().catch(() => {}), this.timing.cloud); this.timer.unref?.(); }
  stop() { this.stopped = true; clearInterval(this.timer); this.session = null; this.abort.abort(); }
  // Nach einem lokalen Ausfall sofort nachsehen – aber höchstens einmal je Minute.
  trigger() { if (this.now() - this.lastRound >= this.timing.cloudTrigger) this.poll().catch(() => {}); }
  stored() { let c; try { c = this.credentials(); validateCredentials(c); } catch { return null; } return c; }
  async call(method, path, body) {
    const c = this.stored();
    if (!c) throw Error('Kein Smart-Life-Cloudzugang gespeichert');
    // Feste Obergrenze je Tag: der Rückfall kann das kostenlose Tuya-Kontingent nie aufbrauchen.
    const day = Math.floor(this.now() / 86400000); if (this.day !== day) { this.day = day; this.calls = 0; }
    if (this.calls >= this.timing.cloudDaily) throw Error('Tagesgrenze für Smart-Life-Cloud-Anfragen erreicht');
    this.calls++;
    if (!/^\/v1\.0\/(token\?grant_type=1|devices\/[A-Za-z0-9_-]{1,64}(\/status|\/commands)?)$/.test(path)) throw Error('Ungültige Tuya-Anfrage');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(c)).digest('hex');
    if (!path.startsWith('/v1.0/token') && (!this.session || this.session.fingerprint !== fingerprint || this.session.expires <= this.now())) {
      this.session = null;
      const t = await this.call('GET', '/v1.0/token?grant_type=1');
      if (typeof t?.access_token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(t.access_token) || !Number.isInteger(t.expire_time) || t.expire_time < 60 || t.expire_time > 86400) throw Error('Ungültige Tuya-Sitzung');
      this.session = { fingerprint, token: t.access_token, expires: this.now() + (t.expire_time - 30) * 1000 };
    }
    const token = path.startsWith('/v1.0/token') ? '' : this.session.token, text = body === undefined ? '' : JSON.stringify(body), timestamp = String(this.now()), nonce = this.nonce();
    const headers = { client_id: c.accessId, t: timestamp, nonce, sign_method: 'HMAC-SHA256', sign: signature({ accessId: c.accessId, accessSecret: c.accessSecret, token, timestamp, nonce, path, method, body: text }) };
    if (token) headers.access_token = token;
    if (text) headers['Content-Type'] = 'application/json';
    let response;
    try { response = await this.fetch(ENDPOINTS[c.region] + path, { method, redirect: 'error', headers, body: text || undefined, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]) }); }
    catch { throw Error('Tuya-Dienst nicht erreichbar'); }
    if (!response.ok || !response.body) throw Error('Tuya-Dienst meldet HTTP ' + response.status);
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 262144) throw Error('Tuya-Antwort zu groß'); chunks.push(Buffer.from(value)); } } finally { await reader.cancel().catch(() => {}); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw Error('Ungültige Tuya-Antwort'); }
    if (!data || data.success !== true) { if (/token/i.test(String(data?.msg || ''))) this.session = null; if (String(data?.code) === EXPIRED) this.expired?.(true); throw Error('Tuya-Abfrage fehlgeschlagen'); }
    if (!path.startsWith('/v1.0/token')) this.expired?.(false);
    return data.result;
  }
  poll() {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.round().finally(() => { this.running = null; });
    return this.running;
  }
  async round() {
    // Nur Steckdosen/Schalter, die lokal gerade nicht erreichbar sind – sonst keine einzige Cloud-Anfrage.
    const entries = this.entries().filter(e => SWITCHING.includes(e.item?.profile?.kind) && !e.localOnline).slice(0, 128);
    if (!entries.length || !this.stored()) return;
    this.lastRound = this.now();
    let failed = false;
    for (const entry of entries) {
      if (this.stopped) return;
      try {
        const detail = await this.call('GET', '/v1.0/devices/' + entry.item.id);
        if (!detail || typeof detail.online !== 'boolean') throw Error('Ungültiger Onlinestatus');
        const values = detail.online ? plugFromStatus(entry.item.profile, await this.call('GET', '/v1.0/devices/' + entry.item.id + '/status')) : {};
        if (!this.stopped) await this.apply(entry, { online: detail.online && typeof values.on === 'boolean', values, queriedAt: this.now() });
      } catch { failed = true; if (!this.stopped) await this.apply(entry, { online: false, failed: true, values: {}, queriedAt: this.now() }); }
    }
    if (failed && this.now() - this.lastNotice >= this.timing.cloudNotice) { this.lastNotice = this.now(); this.notice('Smart-Life-Cloud-Rückfall: Abfrage fehlgeschlagen; gespeicherten Zugang und Verbindung prüfen'); }
  }
  // field: 'on' (Steckdose) oder 'usb' (USB-Anschlüsse); nur die im Profil bestätigten Codes.
  async command(entry, field, value) {
    const code = (field === 'usb' ? entry.item.profile.usb : field === 'on' ? entry.item.profile.on : null)?.code;
    if (typeof value !== 'boolean' || typeof code !== 'string' || !(field === 'usb' ? /^switch_usb\d*$/ : /^switch(?:_\d+)?$/).test(code)) throw fail('Ungültiger Schaltauftrag', 400);
    const result = await this.call('POST', '/v1.0/devices/' + entry.item.id + '/commands', { commands: [{ code, value }] });
    if (result !== true) throw Error('Tuya-Cloud hat den Befehl nicht bestätigt');
    const values = plugFromStatus(entry.item.profile, await this.call('GET', '/v1.0/devices/' + entry.item.id + '/status'));
    await this.apply(entry, { online: typeof values.on === 'boolean', values, queriedAt: this.now() });
    return values;
  }
}

class SmartlifeLokal extends Smartplus {
  constructor(bridge, matter, options = {}) {
    const Base = options.Client || require('../vendor/node_modules/tuyapi');
    super(bridge, matter, { ...options, provider: options.provider === 'smartplus' ? 'smartplus' : 'smartlife', Client: hardenedClient(Base) });
    this.timing = { ...TIMING, ...(options.timing || {}) };
    this.now = options.now || Date.now;
    this.fetchImpl = options.fetchImpl;
    this.platform = options.platform || process.platform;
    this.discoveryOptions = options.discovery || {};
  }
  async start() {
    await super.start();
    if (this.stopped) return;
    this.watchSensorCloud();
    // Eigener Takt statt 15 s: jede Sekunde nachsehen, welches Gerät dran ist (kostet nichts, wenn keins dran ist).
    clearInterval(this.timer);
    this.timer = setInterval(() => this.connectLoop().catch(() => {}), this.timing.tick); this.timer.unref?.();
    // Eigene Suche: bekannte Geräte (beider Anbieter) werden beim Durchsuchen des Heimnetzes nie angesprochen.
    this.discovery?.stop();
    const { TuyaDiscovery } = require('./tuya-discovery'), connect = this.discoveryOptions.connect || net.createConnection;
    this.discovery = new TuyaDiscovery({ ...this.discoveryOptions, connect: options => this.busyIps().has(options.host) ? skipped() : connect(options) });
    const config = this.bridge.config[this.provider];
    if (this.provider === 'smartlife' && config?.vaultPath && [...this.entries.values()].some(e => SWITCHING.includes(e.item.profile.kind))) {
      this.cloud = new CloudFallback({
        credentials: () => new Vault(path.join(path.dirname(config.vaultPath), 'backup-accounts-secrets.json')).read().smartlife,
        entries: () => [...this.entries.values()],
        apply: (entry, result) => this.cloudFeedback(entry, result),
        notice: message => this.emit('notice', message), expired: v => this.setTuyaExpired(v),
        now: this.now, timing: this.timing, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
      });
      this.cloud.start();
    }
  }
  // Bekannte Adressen werden unabhängig von der (langsamen) Suche unbekannter Adressen abgefragt.
  connectLoop() {
    if (this.stopped) return Promise.resolve();
    const entries = [...this.entries.values()], ready = entries.filter(e => e.client.device.ip), unknown = entries.filter(e => !e.client.device.ip), jobs = [];
    if (!this.polling && ready.length) {
      this.polling = true; let i = 0;
      const worker = async () => { while (i < ready.length && !this.stopped) await this.attemptConnection(ready[i++]); };
      jobs.push(Promise.all([worker(), worker(), worker()]).finally(() => { this.polling = false; }));
    }
    if (!this.discovering && unknown.length) {
      this.discovering = true;
      jobs.push((async () => {
        if (this.platform === 'linux' && this.discovery) {
          this.discovery.known(unknown); // nur die Nachbarliste lesen, kein Gerät ansprechen
          if (unknown.some(e => !e.client.device.ip) && this.now() - (this.lastScan ?? -Infinity) >= this.timing.scan) { this.lastScan = this.now(); await this.discovery.find(unknown); }
        }
        for (const e of unknown) { if (this.stopped) break; await this.attemptConnection(e); }
      })().finally(() => { this.discovering = false; }));
    }
    return Promise.all(jobs);
  }
  async attemptConnection(entry) {
    if (this.stopped || entry.busy) return;
    const now = this.now();
    if (entry.localOnline) {
      if (now - (entry.lastPoll || 0) < (now < (entry.activeUntil || 0) ? this.timing.poll : this.timing.pollIdle)) return;
      entry.lastPoll = now; entry.busy = true;
      try { const data = await bounded(entry.client.get({ schema: true })); if (!this.stopped) await this.feedback(entry, data); }
      catch { this.offline(entry); entry.client.disconnect(); }
      finally { entry.busy = false; }
      return;
    }
    if (now - (entry.lastAttempt || 0) < this.timing.retry) return;
    entry.lastAttempt = now; entry.busy = true;
    try {
      if (!entry.client.device.ip) await entry.client.find({ timeout: 5 });
      // find() ersetzt bei abweichender Protokollversion den Parser – die Härtung sofort wieder anlegen.
      harden(entry.client);
      if (this.stopped) return;
      if (!validIp(entry.client.device.ip) || !entry.client.device.ip || !VERSIONS.includes(entry.client.device.version)) throw Error('Keine unterstützte lokale Geräteverbindung');
      await bounded(entry.client.connect()); if (this.stopped) { entry.client.disconnect(); return; }
      const data = await bounded(entry.client.get({ schema: true })); entry.lastPoll = this.now();
      if (!this.stopped) { await this.feedback(entry, data); if (entry.localOnline) { entry.failures = 0; this.remember(entry); } }
    } catch {
      this.offline(entry); entry.client.disconnect(); entry.failures = (entry.failures || 0) + 1;
      if (entry.failures >= 2) { entry.client.device.ip = undefined; delete this.addresses[entry.item.id]; }
    } finally { entry.busy = false; }
  }
  async feedback(entry, data) {
    if (this.stopped) return;
    const devId = data && typeof data === 'object' ? data.devId ?? data.data?.devId : undefined;
    if (devId !== undefined && devId !== entry.item.id) { this.foreign(entry); return; }
    const dps = data?.dps || data?.data?.dps, usb = entry.item.profile.usb;
    if (usb && dps && typeof dps === 'object' && typeof dps[usb.id] === 'boolean') entry.state.usb = dps[usb.id];
    await super.feedback(entry, data);
    if (entry.localOnline) { entry.verifiedAt = this.now(); entry.cloudOnline = false; }
  }
  // Adressen aller bekannten Tuya-Geräte (Smart Life und SMART+) – beim Durchsuchen tabu.
  busyIps() {
    const ips = new Set();
    for (const m of [this, this.bridge?.smartlife, this.bridge?.smartplus]) for (const e of m?.entries?.values?.() || []) { if (e.client?.device?.ip) ips.add(e.client.device.ip); if (e.item?.ip) ips.add(e.item.ip); }
    for (const a of Object.values(this.addresses || {})) if (a?.ip) ips.add(a.ip);
    return ips;
  }
  foreign(entry) {
    this.emit('notice', this.label + ': unter der Adresse von „' + entry.item.name + '“ antwortet ein anderes Gerät; Verbindung getrennt');
    this.offline(entry); entry.client.disconnect(); entry.client.device.ip = undefined; delete this.addresses[entry.item.id];
  }
  offline(entry) {
    if (this.stopped) return;
    if (!SWITCHING.includes(entry.item.profile.kind)) return super.offline(entry);
    const was = entry.localOnline === true;
    entry.localOnline = false; entry.online = entry.cloudOnline === true; this.publish(entry);
    if (was) this.cloud?.trigger();
  }
  async cloudFeedback(entry, result) {
    if (!SWITCHING.includes(entry.item.profile.kind)) return super.cloudFeedback(entry, result);
    if (this.stopped || entry.localOnline) return;
    entry.cloudOnline = result.online === true; entry.cloudQueriedAt = result.queriedAt; entry.cloudFailed = result.failed === true;
    if (entry.cloudOnline) { Object.assign(entry.state, result.values); entry.readingSource = 'cloud'; }
    entry.online = entry.cloudOnline;
    await this.publish(entry);
  }
  async control(id, command) {
    const entry = this.entries.get(id);
    if (!entry) throw fail(this.label + '-Gerät nicht gefunden', 404);
    const keys = command && typeof command === 'object' && !Array.isArray(command) ? Object.keys(command).join() : '';
    if (keys === 'usb' && (typeof command.usb !== 'boolean' || !entry.item.profile.usb)) throw fail('USB-Schalter nicht vorhanden oder ungültiger Auftrag', 400);
    entry.activeUntil = this.now() + this.timing.activeMs;
    // Kennungsprüfung: länger nicht bestätigt → erst Status lesen (entschlüsselt mit dem Geräteschlüssel, eigene ID).
    if (entry.localOnline && !entry.busy && this.now() - (entry.verifiedAt || 0) > this.timing.verify) {
      entry.busy = true;
      try { await this.feedback(entry, await bounded(entry.client.get({ schema: true }))); }
      catch { this.offline(entry); entry.client.disconnect(); }
      finally { entry.busy = false; }
    }
    if (!entry.localOnline && entry.cloudOnline && this.cloud && SWITCHING.includes(entry.item.profile.kind)) {
      if (!['on', 'usb'].includes(keys) || typeof command[keys] !== 'boolean') throw fail('Über die Cloud ist nur Ein/Aus möglich', 400);
      if (entry.busy) throw fail('Auftrag läuft bereits', 429);
      entry.busy = true;
      try { await this.cloud.command(entry, keys, command[keys]); return { accepted: true, online: entry.online, state: { ...entry.state }, via: 'cloud', message: 'Über die Tuya-Cloud geschaltet (lokal nicht erreichbar)' }; }
      catch (error) { throw fail(error.status === 400 ? error.message : 'Cloud-Befehl konnte nicht bestätigt werden; Gerätestatus prüfen', error.status || 502); }
      finally { entry.busy = false; }
    }
    if (!entry.localOnline) throw fail(this.label + '-Gerät nicht erreichbar' + (this.cloud ? ' (lokal und Cloud)' : ''), 503);
    if (keys === 'usb') {
      if (entry.busy) throw fail('Auftrag läuft bereits', 429);
      entry.busy = true;
      try {
        await bounded(entry.client.set({ multiple: true, data: { [entry.item.profile.usb.id]: command.usb }, shouldWaitForResponse: true }));
        const response = await bounded(entry.client.get({ schema: true })).catch(() => null); if (response) await this.feedback(entry, response);
        entry.activeUntil = this.now() + this.timing.activeMs;
        return { accepted: true, online: entry.online, state: { ...entry.state }, via: 'lokal', message: 'USB-Auftrag übergeben; Status zeigt die letzte Geräterückmeldung' };
      } catch { this.offline(entry); entry.client.disconnect(); throw fail('USB-Auftrag konnte nicht bestätigt werden; Gerätestatus prüfen', 502); }
      finally { entry.busy = false; }
    }
    const result = await super.control(id, command);
    entry.activeUntil = this.now() + this.timing.activeMs;
    return { ...result, via: 'lokal' };
  }
  // Smart-Life-Fühler mit Batterie gehen nur über die Tuya-Cloud (lokal grundsätzlich nicht). Damit niemand einen alten Wert für
  // aktuell hält: echte Messzeit (Tuya update_time) merken; und den Ablauf des kostenlosen Tuya-Zugangs erkennen (Thomas 13.10.2026).
  // Die Fühlerabfrage selbst (smartlife-sensor-cloud.js) bleibt unverändert; hier wird nur ihre Anfrage mitgelesen.
  watchSensorCloud() {
    const sc = this.sensorCloud; if (!sc || sc.watched) return; sc.watched = true; this.sensorTimes = this.sensorTimes || new Map();
    const base = sc.cloudFactory;
    sc.cloudFactory = options => {
      const cloud = base(options), request = cloud.request.bind(cloud);
      cloud.request = async p => {
        try {
          const r = await request(p), m = /^\/v1\.0\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(p);
          if (m) { this.setTuyaExpired(false); const t = Number(r?.update_time) * 1000; if (Number.isFinite(t) && t > 1e12 && t <= this.now() + 300000) this.sensorTimes.set(m[1], t); }
          return r;
        } catch (e) { if (String(e?.code) === EXPIRED) this.setTuyaExpired(true); throw e; }
      };
      return cloud;
    };
  }
  setTuyaExpired(v) {
    if (v === this.tuyaExpired) return; this.tuyaExpired = v;
    if (v) this.emit('notice', 'Smart Life: Der kostenlose Tuya-Zugang (IoT Core) ist abgelaufen – Fühler ohne WLAN-Verbindung liefern keine Werte mehr. Verlängern: iot.tuya.com → Cloud → IoT Core → Extend Trial Period');
  }
  public() {
    const extra = new Map([...this.entries.values()].map(e => [e.item.id, { via: e.localOnline ? 'lokal' : e.online ? 'cloud' : null, usb: !!e.item.profile.usb }]));
    return super.public().map(row => { const x = extra.get(row.id), m = this.sensorTimes?.get(row.id); return { ...row, via: x.via, capabilities: { ...row.capabilities, usb: x.usb }, cloudMeasuredAt: m ? new Date(m).toISOString() : null, tuyaExpired: this.tuyaExpired === true }; });
  }
  async stop() { this.cloud?.stop(); await super.stop(); }
}

// SMART+ (LEDVANCE): gleicher Baustein, aber ohne Cloud-Rückfall (LEDVANCE-Cloud ist eine andere Schnittstelle).
class SmartplusLokal extends SmartlifeLokal { constructor(bridge, matter, options = {}) { super(bridge, matter, { ...options, provider: 'smartplus' }); } }
// Ersatz für eine Verbindung, die beim Durchsuchen bewusst nicht aufgebaut wird.
function skipped() { const s = new EventEmitter(); s.setTimeout = () => s; s.destroy = () => {}; setImmediate(() => s.emit('error', Error('übersprungen'))); return s; }

module.exports = { EXPIRED,  SmartlifeLokal, SmartplusLokal, CloudFallback, TIMING, harden, hardenedClient, plugFromStatus, validId };
