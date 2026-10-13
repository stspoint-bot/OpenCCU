'use strict';
// Ecovacs-Saugroboter (Deebot X1 Omni, Wunsch Thomas 13.10.2026: „wie beim Jeep“, möglichst alle Funktionen in Matter).
// - Verbindung über die Ecovacs-Cloud (ecovacs-cloud.js); Zugang (E-Mail, MD5 des Passworts, feste Geräte-Kennung) verschlüsselt
//   im vorhandenen AES-256-GCM-Schlüsselspeicher (ecovacs-secrets.json). Das Passwort tippt Thomas selbst ein.
// - Zustand per Abfrage: während der Reinigung alle 30 s, sonst alle 5 min; Einstellungen/Räume/Verschleiß alle 30 min.
// - Befehle: Start, Räume, Pause, Weiter, Stopp, zur Station, Absaugen, Mopp waschen, Trocknen, Roboter finden.
//   Welche Variante der Roboter annimmt (clean_V2 oder clean), wird beim ersten Mal ausprobiert und gemerkt.
// - Weboberfläche /ecovacs.html, Automationen (Ziel „Saugroboter“: ein = reinigen, aus = zur Station),
//   Apple Home über ecovacs-matter.js (eigener Matter-Knoten).
// Geprüft am echten Konto (nur lesend, 13.10.2026): Klasse 1vxt52, Antworten siehe outputs\ecovacs-auslesen-*.json.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { EventEmitter } = require('node:events');
const { EcovacsCloud, md5, fail } = require('./ecovacs-cloud');
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

const ERRORS = Object.freeze({
  101: 'Akku schwach', 102: 'Roboter angehoben', 103: 'Antriebsrad blockiert', 104: 'Absturzsensoren verschmutzt', 105: 'Roboter steckt fest',
  106: 'Seitenbürsten verschlissen', 107: 'Filter verschlissen', 108: 'Seitenbürste verheddert', 109: 'Hauptbürste verheddert', 110: 'Staubbehälter fehlt',
  111: 'Stoßfänger klemmt', 112: 'Laser-Sensor gestört', 113: 'Hauptbürste verschlissen', 114: 'Staubbehälter voll', 115: 'Akku-Fehler', 117: 'Lagesensor gestört',
  119: 'Lüfter-Fehler', 120: 'Wassertank-Fehler', 126: 'Wassertank fehlt', 128: 'Wischmopps nicht beide eingesetzt', 129: 'Wischmopp verheddert',
  301: 'Frischwassertank leer', 302: 'Schmutzwassertank voll', 303: 'Frischwassertank fehlt', 304: 'Schmutzwassertank fehlt', 305: 'Schmutzwassertank voll',
  306: 'Filter im Waschbecken fehlt', 307: 'Station gestört', 310: 'Deckel der Station offen', 311: 'Staubbeutel wechseln', 312: 'Staubbeutel voll',
  317: 'Frischwasser lässt sich nicht nachfüllen', 318: 'Schmutzwassertank voll', 322: 'Frischwassertank leer oder fehlt', 323: 'Schmutzwassertank voll oder fehlt', 4200: 'Roboter nicht erreichbar'
});
// 314 („Wassermodul fehlt“) meldet der X1 Omni dauerhaft, obwohl er kein solches Modul hat – wird nicht angezeigt.
const IGNORED = new Set([0, 100, 314]);
const errorText = c => ERRORS[c] || 'Fehler ' + c;
const SPEEDS = Object.freeze([[1000, 'Leise'], [0, 'Normal'], [1, 'Max'], [2, 'Max+']]);
const WATER = Object.freeze([[1, 'Wenig'], [2, 'Mittel'], [3, 'Viel']]);
const ROOM_TYPES = Object.freeze({ 0: 'Raum', 1: 'Wohnzimmer', 2: 'Esszimmer', 3: 'Schlafzimmer', 4: 'Arbeitszimmer', 5: 'Küche', 6: 'Bad', 7: 'Waschküche', 8: 'Aufenthaltsraum', 9: 'Abstellraum', 10: 'Kinderzimmer', 11: 'Wintergarten', 12: 'Flur', 13: 'Balkon', 14: 'Fitnessraum' });
const LIFE = Object.freeze({ brush: 'Hauptbürste', sideBrush: 'Seitenbürsten', heap: 'Filter', unitCare: 'Pflege allgemein', roundMop: 'Wischmopps' });
// Einstellungen, die die Seite ändern darf: Name → [Lesebefehl, Schreibbefehl, Feld, Prüfung]
const SETTINGS = Object.freeze({
  speed: ['getSpeed', 'setSpeed', 'speed', v => SPEEDS.some(([k]) => k === v)],
  water: ['getWaterInfo', 'setWaterInfo', 'amount', v => WATER.some(([k]) => k === v)],
  autoEmpty: ['getAutoEmpty', 'setAutoEmpty', 'enable', v => v === 0 || v === 1],
  trueDetect: ['getTrueDetect', 'setTrueDetect', 'enable', v => v === 0 || v === 1],
  carpetBoost: ['getCarpertPressure', 'setCarpertPressure', 'enable', v => v === 0 || v === 1],
  childLock: ['getChildLock', 'setChildLock', 'on', v => v === 0 || v === 1],
  volume: ['getVolume', 'setVolume', 'volume', v => Number.isInteger(v) && v >= 0 && v <= 10],
  washInterval: ['getWashInterval', 'setWashInterval', 'interval', v => [10, 15, 25].includes(v)],
  dryingDuration: ['getDryingDuration', 'setDryingDuration', 'duration', v => [120, 180, 240].includes(v)],
  cleanCount: ['getCleanCount', 'setCleanCount', 'count', v => v === 1 || v === 2]
});
const LABELS = Object.freeze({ speed: 'Saugstärke', water: 'Wassermenge', autoEmpty: 'Automatisch absaugen', trueDetect: 'Hinderniserkennung', carpetBoost: 'Teppich-Turbo', childLock: 'Kindersicherung', volume: 'Lautstärke', washInterval: 'Mopp waschen alle (Min.)', dryingDuration: 'Trocknungsdauer (Min.)', cleanCount: 'Durchgänge' });
const valueText = (key, v) => key === 'speed' ? (SPEEDS.find(([k]) => k === v) || [, v])[1] : key === 'water' ? (WATER.find(([k]) => k === v) || [, v])[1] : ['autoEmpty', 'trueDetect', 'carpetBoost', 'childLock'].includes(key) ? (v ? 'ein' : 'aus') : String(v);
const ACTIONS = Object.freeze(['start', 'rooms', 'pause', 'resume', 'stop', 'home', 'empty', 'wash', 'washStop', 'dry', 'dryStop', 'find']);
const ACTION_TEXT = Object.freeze({ start: 'Reinigung gestartet', rooms: 'Raumreinigung gestartet', pause: 'pausiert', resume: 'fortgesetzt', stop: 'gestoppt', home: 'fährt zur Station', empty: 'Station saugt ab', wash: 'Mopp wird gewaschen', washStop: 'Waschen beendet', dry: 'Trocknen gestartet', dryStop: 'Trocknen beendet', find: 'Roboter meldet sich' });

class EcovacsService extends EventEmitter {
  constructor({ vault, configPath = null, Cloud = EcovacsCloud, now = Date.now, schedule = true } = {}) {
    super(); this.vault = vault; this.configPath = configPath; this.Cloud = Cloud; this.now = now;
    this.cloud = null; this.robot = null; this.connected = false; this.busy = false; this.error = null; this.needCode = false;
    this.status = {}; this.settings = {}; this.rooms = []; this.life = []; this.stats = null; this.total = null; this.block = null;
    this.updatedAt = null; this.fullAt = 0; this.variant = null; this.lastCommand = 0; this.log = []; this.failures = 0; this.retryAt = 0; this.stopped = false;
    this.roomCache = new Map(); this.pollTimer = null; this.queue = Promise.resolve();
    if (schedule) { this.timer = setInterval(() => this.tick().catch(() => {}), 15000); this.timer.unref?.(); }
  }
  secrets() { try { const s = this.vault.read(); return isObject(s) ? s : {}; } catch { return null; } }
  deviceId() { const s = this.secrets() || {}; if (/^[a-f0-9]{32}$/.test(s.deviceId || '')) return s.deviceId; const id = md5(crypto.randomBytes(16).toString('hex')); this.vault.write({ ...s, deviceId: id }); return id; }
  note(text) { this.log.unshift({ at: new Date(this.now()).toISOString(), text: String(text).slice(0, 160) }); this.log.length = Math.min(this.log.length, 30); console.log('[ecovacs] ' + text); }
  // Läuft alle 15 s: Anmeldung wiederherstellen, fällige Abfragen
  async tick() {
    if (this.stopped || this.busy) return;
    if (!this.connected) { if (this.now() >= this.retryAt && !this.needCode) await this.restore(); return; }
    const active = ['cleaning', 'paused', 'returning'].includes(this.status.state) || (this.status.station && this.status.station !== 'idle');
    const due = this.now() - Date.parse(this.updatedAt || 0) >= (active ? 30000 : 300000);
    if (due) await this.refresh({ full: this.now() - this.fullAt >= 1800000 });
  }
  async restore() {
    const s = this.secrets();
    if (!s) { this.error = 'Gespeicherter Ecovacs-Zugang nicht lesbar. Bitte neu anmelden.'; return; }
    if (typeof s.account !== 'string' || !/^[a-f0-9]{32}$/.test(s.pwHash || '')) return;
    await this.run(async () => {
      try { await this.open(s.account, s.pwHash); this.failures = 0; }
      catch (e) {
        if (e.status === 401) { this.retryAt = Infinity; this.error = 'Ecovacs lehnt die Anmeldung ab – bitte auf der Saugroboter-Seite neu anmelden.'; }
        else if (e.status === 428) { this.needCode = true; this.error = 'Ecovacs verlangt einen Bestätigungscode – bitte auf der Saugroboter-Seite neu anmelden.'; }
        else { this.failures++; this.retryAt = this.now() + Math.min(1800000, 60000 * 2 ** Math.min(this.failures, 5)); this.error = 'Ecovacs derzeit nicht erreichbar – neuer Versuch folgt automatisch.'; }
      }
    });
  }
  // Nacheinander ausführen (nie zwei Cloud-Aufrufe gleichzeitig)
  run(fn) { const p = this.queue.then(async () => { this.busy = true; try { return await fn(); } finally { this.busy = false; } }); this.queue = p.catch(() => {}); return p; }
  async open(account, pwHash, code) {
    const cloud = new this.Cloud({ deviceId: this.deviceId() });
    if (code) await cloud.verify(account, code); else await cloud.login(account, pwHash);
    const list = (await cloud.devices()).filter(d => d.company === 'eco-ng');
    if (!list.length) throw fail('Im Ecovacs-Konto ist kein unterstützter Saugroboter', 404);
    this.cloud = cloud; this.robot = list[0]; this.connected = true; this.needCode = false; this.error = null; this.retryAt = 0;
    this.note('angemeldet: ' + this.robot.name + ' (' + this.robot.model + ')');
    await this.refreshNow(true);
    return this.public();
  }
  // Von der Seite: E-Mail + Passwort (nur MD5 wird gespeichert). Verlangt Ecovacs einen Code, wird er angefordert.
  async login(account, password) {
    if (typeof account !== 'string' || !/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(account.trim()) || typeof password !== 'string' || !password || password.length > 128) throw fail('E-Mail und Passwort des Ecovacs-Kontos angeben', 400);
    const acc = account.trim(), pwHash = md5(password); password = '';
    return this.run(async () => {
      this.vault.write({ ...(this.secrets() || {}), account: acc, pwHash, deviceId: this.deviceId() });
      try { return await this.open(acc, pwHash); }
      catch (e) {
        if (e.status !== 428) { this.error = e.status === 401 ? 'E-Mail oder Passwort falsch' : e.message; throw e; }
        await new this.Cloud({ deviceId: this.deviceId() }).requestCode(acc);
        this.needCode = true; this.error = null; this.note('Bestätigungscode per E-Mail angefordert');
        return { ...this.public(), needCode: true };
      }
    });
  }
  async verifyCode(code) {
    if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,10}$/.test(code.trim())) throw fail('Code aus der Ecovacs-E-Mail eingeben', 400);
    const s = this.secrets() || {};
    if (!s.account) throw fail('Zuerst E-Mail und Passwort eingeben', 409);
    return this.run(() => this.open(s.account, s.pwHash, code.trim()));
  }
  logout() { this.vault.write({ deviceId: (this.secrets() || {}).deviceId }); this.cloud = null; this.robot = null; this.connected = false; this.needCode = false; this.error = null; this.status = {}; this.note('abgemeldet'); this.emit('change'); return this.public(); }
  async call(cmd, args) {
    if (!this.cloud || !this.robot) throw fail('Saugroboter nicht verbunden', 409);
    try { return await this.cloud.command(this.robot, cmd, args); }
    catch (e) {
      if (e.expired) { // Token abgelaufen (nach etwa 6 Tagen): still neu anmelden und einmal wiederholen
        const s = this.secrets() || {};
        await this.cloud.login(s.account, s.pwHash);
        return this.cloud.command(this.robot, cmd, args);
      }
      throw e;
    }
  }
  refresh(opts) { return this.run(() => this.refreshNow(opts?.full)); }
  async refreshNow(full = false) {
    if (!this.connected) return;
    const st = { ...this.status }, get = async (cmd, args) => { const r = await this.call(cmd, args); return r.ok ? r.data : null; };
    try {
      const bat = await get('getBattery'); if (bat) { st.battery = Number(bat.value); st.batteryLow = Number(bat.isLow) === 1; }
      const ch = await get('getChargeState'); if (ch) st.charging = Number(ch.isCharging) === 1;
      let ci = await get('getCleanInfo_V2'); if (!ci) ci = await get('getCleanInfo');
      if (ci) Object.assign(st, cleanState(ci, st.charging));
      const er = await get('getError'); if (er) st.errors = (Array.isArray(er.code) ? er.code : []).map(Number).filter(c => !IGNORED.has(c));
      const ss = await get('getStationState'); if (ss) { st.station = ['idle', 'emptying', 'washing', 'drying'][Number(ss.state)] || 'idle'; st.stationErrors = (Array.isArray(ss.content?.error) ? ss.content.error : []).map(Number).filter(c => !IGNORED.has(c)); }
      this.robot.online = true;
      if (full) await this.refreshFull(get);
      this.status = st; this.updatedAt = new Date(this.now()).toISOString(); this.error = null;
    } catch (e) { this.error = e.message || 'Abfrage fehlgeschlagen'; if (e.status === 401) { this.connected = false; this.retryAt = this.now(); } }
    this.emit('change');
  }
  async refreshFull(get) {
    for (const [key, [cmd, , field]] of Object.entries(SETTINGS)) { const d = await get(cmd); if (d && d[field] !== undefined) this.settings[key] = Number(d[field]); }
    const block = await get('getBlock'); if (block) { const hm = t => /^\d{1,2}:\d{1,2}$/.test(String(t)) ? String(t).split(':').map(x => x.padStart(2, '0')).join(':') : ''; this.block = { enable: Number(block.enable) === 1, start: hm(block.start), end: hm(block.end) }; }
    const stats = await get('getStats'); if (stats) this.stats = { area: Number(stats.area) || 0, minutes: Math.round((Number(stats.time) || 0) / 60), start: Number(stats.start) ? new Date(Number(stats.start) * 1000).toISOString() : null, type: String(stats.type || '') };
    const total = await get('getTotalStats'); if (total) this.total = { area: Number(total.area) || 0, hours: Math.round((Number(total.time) || 0) / 3600), count: Number(total.count) || 0 };
    const life = await get('getLifeSpan', Object.keys(LIFE));
    if (Array.isArray(life)) this.life = life.filter(x => LIFE[x?.type]).map(x => ({ type: x.type, name: LIFE[x.type], percent: Number(x.total) > 0 ? Math.max(0, Math.min(100, Math.round(Number(x.left) / Number(x.total) * 100))) : null }));
    await this.loadRooms(get);
    this.fullAt = this.now();
  }
  // Räume der aktiven Karte: getMapSet (Kennungen) + getMapSubSet (Raumart) – nur neu, wenn sich die Karte ändert
  async loadRooms(get) {
    const info = await get('getCachedMapInfo'); const map = (Array.isArray(info?.info) ? info.info : []).find(m => Number(m?.using) === 1);
    if (!map?.mid) return;
    const set = await get('getMapSet', { mid: String(map.mid), type: 'ar' }); if (!set || !Array.isArray(set.subsets)) return;
    const key = map.mid + ':' + set.msid;
    if (this.roomCache.get('key') !== key) {
      const rooms = [];
      for (const s of set.subsets.slice(0, 32)) {
        const id = Number(s?.mssid); if (!Number.isInteger(id) || id < 0) continue;
        const sub = await get('getMapSubSet', { mid: String(map.mid), msid: String(set.msid), type: 'ar', mssid: String(id) });
        const own = String(sub?.name || s.name || '').trim(), type = Number(sub?.subtype ?? sub?.subType);
        rooms.push({ id, ecovacsName: own || (ROOM_TYPES[type] || 'Raum'), type: Number.isInteger(type) ? type : null });
      }
      // gleiche Raumart mehrfach (z. B. zwei „Küche“): durchnummerieren
      const seen = {}; for (const r of rooms) { seen[r.ecovacsName] = (seen[r.ecovacsName] || 0) + 1; }
      const cnt = {}; for (const r of rooms) if (seen[r.ecovacsName] > 1) { cnt[r.ecovacsName] = (cnt[r.ecovacsName] || 0) + 1; r.ecovacsName += ' ' + cnt[r.ecovacsName]; }
      this.roomCache.set('key', key); this.roomCache.set('rooms', rooms);
    }
    this.map = { id: String(map.mid), name: String(map.name || '') };
    this.rooms = this.roomCache.get('rooms') || [];
  }
  roomNames() { try { const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8')).ecovacs?.roomNames; return isObject(c) ? c : {}; } catch { return {}; } }
  roomList() { const own = this.roomNames(); return this.rooms.map(r => ({ id: r.id, name: typeof own[r.id] === 'string' && own[r.id].trim() ? own[r.id].trim() : r.ecovacsName, ecovacsName: r.ecovacsName })); }
  // Reinigungsbefehl: zuerst clean_V2 (ecovacs-deebot.js für X1), sonst clean (deebot-client) – die angenommene Variante wird gemerkt
  async clean(act, content) {
    const v2 = { act, content: { count: 1, donotClean: '', ...(content || {}) }, mode: '', router: 'plan' };
    const v1 = act === 'start' ? { act, type: content?.type || 'auto', ...(content?.value ? { content: content.value, count: content.count || 1 } : {}) } : { act };
    const tries = this.variant === 'clean' ? [['clean', v1]] : this.variant === 'clean_V2' ? [['clean_V2', act === 'start' ? v2 : { act }]] : [['clean_V2', act === 'start' ? v2 : { act }], ['clean', v1]];
    let last;
    for (const [cmd, args] of tries) { last = await this.call(cmd, args); if (last.ok) { if (this.variant !== cmd) { this.variant = cmd; this.note('Roboter versteht die Befehlsart ' + (cmd === 'clean' ? 'A' : 'B') + ' (' + cmd + ')'); } return last; } }
    return last;
  }
  async control(action, opts = {}) {
    if (!ACTIONS.includes(action)) throw fail('Unbekannte Aktion', 400);
    let rooms = null;
    if (action === 'rooms') {
      const known = new Set(this.rooms.map(r => r.id));
      if (!Array.isArray(opts.rooms) || !opts.rooms.length || opts.rooms.length > 32 || opts.rooms.some(id => !Number.isInteger(id) || !known.has(id))) throw fail('Mindestens einen vorhandenen Raum auswählen', 400);
      rooms = [...new Set(opts.rooms)];
    }
    const count = opts.count === 2 ? 2 : 1;
    return this.run(async () => {
      if (!this.connected) throw fail('Saugroboter nicht verbunden', 409);
      const wait = 2000 - (this.now() - this.lastCommand); if (wait > 0) await new Promise(r => setTimeout(r, wait)); // höchstens ein Befehl alle 2 s
      this.lastCommand = this.now();
      let r;
      switch (action) {
        case 'start': r = this.status.state === 'paused' ? await this.clean('resume') : await this.clean('start', { type: 'auto', count }); break;
        case 'rooms': r = await this.clean('start', { type: 'spotArea', value: rooms.join(','), count }); break;
        case 'pause': r = await this.clean('pause'); break;
        case 'resume': r = await this.clean('resume'); break;
        case 'stop': r = await this.clean('stop'); break;
        case 'home': r = await this.call('charge', { act: 'go' }); if (r.code === 30007) r = { ...r, ok: true }; break; // 30007: lädt bereits
        case 'empty': r = await this.call('setAutoEmpty', { act: 'start' }); if (!r.ok) r = await this.call('stationAction', { act: 1, type: 1 }); break;
        case 'wash': r = await this.call('clean_V2', { act: 'start', content: { count: 1, donotClean: '', type: 'washing' }, mode: '', router: 'plan' }); break;
        case 'washStop': r = await this.call('clean_V2', { act: 'stop', content: { count: 1, donotClean: '', type: 'washing' }, mode: '', router: 'plan' }); break;
        case 'dry': r = await this.call('stationAction', { act: 1, type: 2 }); break;
        case 'dryStop': r = await this.call('stationAction', { act: 4, type: 2 }); break;
        case 'find': r = await this.call('playSound', { count: 1, sid: 30 }); break;
      }
      const text = action === 'rooms' ? ACTION_TEXT.rooms + ' (' + rooms.map(id => this.roomList().find(x => x.id === id)?.name || id).join(', ') + ')' : ACTION_TEXT[action];
      if (!r.ok) { this.note('abgelehnt: ' + action + ' (' + (r.msg || r.code) + ')'); throw fail(r.noAnswer ? 'Der Roboter hat nicht geantwortet – ist er im WLAN?' : 'Der Roboter hat den Befehl abgelehnt (' + (r.msg || r.code) + ')', 409); }
      this.note(text + (opts.by ? ' – ' + opts.by : ''));
      this.soon();
      return { success: true, message: 'Saugroboter: ' + text };
    });
  }
  // Nach einem Befehl den Zustand zweimal nachlesen (3 s und 20 s)
  soon() { for (const ms of [3000, 20000]) { const t = setTimeout(() => this.refresh().catch(() => {}), ms); t.unref?.(); } }
  async setSetting(key, value) {
    const def = SETTINGS[key]; if (!def) throw fail('Unbekannte Einstellung', 400);
    if (!def[3](value)) throw fail('Wert nicht erlaubt', 400);
    return this.run(async () => {
      const r = await this.call(def[1], { [def[2]]: value });
      if (!r.ok) throw fail(r.noAnswer ? 'Der Roboter hat nicht geantwortet' : 'Der Roboter hat die Einstellung abgelehnt (' + (r.msg || r.code) + ')', 409);
      const back = await this.call(def[0]); // zurücklesen
      const now = back.ok && back.data ? Number(back.data[def[2]]) : value; this.settings[key] = now;
      this.note('Einstellung ' + (LABELS[key] || key) + ': ' + valueText(key, now)); this.emit('change');
      return { success: now === value, value: now, message: now === value ? 'Saugroboter: Einstellung gespeichert' : 'Saugroboter hat einen anderen Wert gemeldet' };
    });
  }
  public() {
    const s = this.status, errors = [...new Set([...(s.errors || []), ...(s.stationErrors || [])])];
    return {
      connected: this.connected, busy: this.busy, error: this.error, needCode: this.needCode, account: this.connected || this.needCode ? maskMail((this.secrets() || {}).account) : null,
      robot: this.robot ? { name: this.robot.name, model: this.robot.model, online: this.robot.online !== false } : null,
      state: { ...s, label: stateLabel(s), errors: errors.map(c => ({ code: c, text: errorText(c) })) },
      settings: { ...this.settings }, speeds: SPEEDS.map(([value, label]) => ({ value, label })), waters: WATER.map(([value, label]) => ({ value, label })),
      block: this.block, stats: this.stats, total: this.total, life: this.life, rooms: this.roomList(), map: this.map || null,
      updatedAt: this.updatedAt, log: this.log.slice(0, 15), variant: this.variant
    };
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
const maskMail = m => typeof m === 'string' && m.includes('@') ? m[0] + '…@' + m.split('@')[1] : null;
// Reinigungszustand aus getCleanInfo(_V2), Auswertung wie deebot-client
function cleanState(ci, charging) {
  const out = { trigger: String(ci.trigger || ''), cleanType: null };
  const cs = isObject(ci.cleanState) ? ci.cleanState : {};
  if (ci.trigger === 'alert') out.state = 'error';
  else if (ci.state === 'clean' || ci.state === 'washing') {
    out.state = cs.motionState === 'pause' ? 'paused' : cs.motionState === 'goCharging' ? 'returning' : 'cleaning';
    out.cleanType = String(cs.content?.type || cs.type || '') || null;
  } else if (ci.state === 'goCharging') out.state = 'returning';
  else out.state = charging ? 'docked' : 'idle';
  return out;
}
function stateLabel(s) {
  const base = { cleaning: s.cleanType === 'spotArea' ? 'reinigt Räume' : 'reinigt', paused: 'pausiert', returning: 'fährt zur Station', docked: s.battery >= 100 ? 'in der Station (voll)' : 'lädt in der Station', idle: 'bereit', error: 'Störung' }[s.state] || 'unbekannt';
  const st = { emptying: ' · Station saugt ab', washing: ' · Mopp wird gewaschen', drying: ' · Mopp trocknet' }[s.station] || '';
  return base + st;
}

// Ein Dienst je config.json (Weboberfläche und Matter teilen ihn)
const services = new Map();
function source(configPath) {
  const id = path.resolve(configPath); let s = services.get(id);
  if (!s || s.stopped) { const { Vault } = require('./smartplus'); s = new EcovacsService({ vault: new Vault(path.join(path.dirname(id), 'ecovacs-secrets.json')), configPath: id }); services.set(id, s); }
  return s;
}
const ensure = web => source(web.deps.configPath);

// Automationen: „Saugroboter“ als Schalter (ein = Reinigung starten, aus = zur Station)
function automation(web) {
  const ADDR = 'ECOVACS-1:1', svc = () => ensure(web);
  const has = a => a === ADDR && svc().connected;
  return {
    owns: a => typeof a === 'string' && a.startsWith('ECOVACS-'),
    has, name: () => (svc().robot?.name || 'Saugroboter'), sources: () => [],
    targets: () => svc().connected ? [{ address: ADDR, name: (svc().robot?.name || 'Saugroboter') + ' (ein = reinigen, aus = zur Station)', room: 'Saugroboter', switch: true, dimmer: false, thermostat: null }] : [],
    capabilities: a => has(a) ? { switch: true, dimmer: false, thermostat: null } : null,
    value: a => has(a) ? ['cleaning', 'paused'].includes(svc().status.state) : undefined,
    async switch(a, on) { if (!has(a)) throw fail('Saugroboter nicht verbunden', 409); await svc().control(on ? 'start' : 'home', { by: 'Automation' }); return { confirmed: false }; },
    async dimmer() { throw fail('Saugroboter lässt sich nicht dimmen', 403); },
    async thermostat() { throw fail('Kein Thermostat', 403); }
  };
}

function writeRoomName(web, id, name) {
  web.writeConfigPatch(c => { c.ecovacs = isObject(c.ecovacs) ? { ...c.ecovacs } : {}; const n = { ...(isObject(c.ecovacs.roomNames) ? c.ecovacs.roomNames : {}) }; if (name) n[id] = name; else delete n[id]; c.ecovacs.roomNames = n; });
}

const VIEW = ['getEcovacs'], OPERATE = ['controlEcovacs'], ADMIN = ['ecovacsLogin', 'ecovacsCode', 'ecovacsLogout', 'ecovacsSetting', 'ecovacsRoomName', 'ecovacsRefresh', 'ecovacsMatter'];
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (![...VIEW, ...OPERATE, ...ADMIN].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    // Rechte: Ansehen/Bedienen regelt der Rechte-Wächter (benutzer.js); Einrichten nur Administratoren
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung möglich' }); return true; }
    const admin = !auth.session?.role || auth.session.role === 'admin';
    if (ADMIN.includes(method) && !admin) { send(403, { error: 'Nur für Administratoren' }); return true; }
    const svc = ensure(web);
    if (method === 'getEcovacs') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, { ...svc.public(), admin, matter: require('./ecovacs-matter').info(web) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!isObject(p)) throw fail('Ungültige Anfrage', 400);
    if (method === 'controlEcovacs') { if (Object.keys(p).some(k => !['action', 'rooms', 'count'].includes(k))) throw fail('Ungültige Angaben', 400); send(200, await svc.control(p.action, { rooms: p.rooms, count: p.count, by: auth.session?.user ? 'von ' + auth.session.user : 'von Hand' })); return true; }
    if (method === 'ecovacsLogin') { const r = await svc.login(p.account, p.password); p.password = ''; send(200, r); return true; }
    if (method === 'ecovacsCode') { send(200, await svc.verifyCode(p.code)); return true; }
    if (method === 'ecovacsLogout') { send(200, svc.logout()); return true; }
    if (method === 'ecovacsRefresh') { if (!svc.connected) throw fail('Saugroboter nicht verbunden', 409); await svc.refresh({ full: true }); send(200, svc.public()); return true; }
    if (method === 'ecovacsSetting') { if (Object.keys(p).length !== 2 || typeof p.key !== 'string') throw fail('Ungültige Angaben', 400); send(200, await svc.setSetting(p.key, p.value)); return true; }
    if (method === 'ecovacsRoomName') {
      if (Object.keys(p).length !== 2 || !Number.isInteger(p.id) || !svc.rooms.some(r => r.id === p.id) || typeof p.name !== 'string' || p.name.trim().length > 32 || /[\x00-\x1f\x7f]/.test(p.name)) throw fail('Vorhandenen Raum und Namen (bis 32 Zeichen) angeben', 400);
      writeRoomName(web, p.id, p.name.trim()); svc.emit('change'); send(200, { success: true, rooms: svc.roomList() }); return true;
    }
    if (method === 'ecovacsMatter') { if (Object.keys(p).length !== 1 || typeof p.enabled !== 'boolean') throw fail('Ungültige Angaben', 400); send(200, await require('./ecovacs-matter').setEnabled(web, p.enabled)); return true; }
  } catch (e) { send(e.status && e.status < 600 ? e.status : 502, { error: e.status ? e.message : 'Saugroboter: Aktion fehlgeschlagen' }); }
  return true;
}
module.exports = { EcovacsService, source, ensure, handle, automation, cleanState, stateLabel, errorText, SETTINGS, ACTIONS, ROOM_TYPES };
