'use strict';
// Jeep-Wache (Wunsch Thomas, 12.10.2026): WhatsApp-Hinweise, Nachtschloss und Fahrzeugzustand.
// - WhatsApp über den vorhandenen Dienst der Bridge (web.security.monitor.send). Jeder Anlass ist einzeln abschaltbar und wird
//   höchstens einmal gemeldet (gemerkt in jeep-wache-state.json, übersteht Neustarts):
//   Frostschutz heizt vor (nur aus einer Automation) · „Klima sofort“-Plan ließ sich nicht zurücksetzen · abends am Ladeplatz,
//   aber nicht eingesteckt · Akku niedrig (Warnschwelle von „Akku niedrig“) · Reifendruck-Warnung des Fahrzeugs.
//   „Ladung beginnt/beendet“ und den Monatsverbrauch meldet weiterhin jeep-laden.js.
// - Nachtschloss (Freigabe Thomas, 12.10.2026: NUR verriegeln): zur eingestellten Uhrzeit höchstens einmal je Nacht RDL, wenn der
//   Jeep am Ladeplatz steht, die Zündung aus ist und er seit seiner letzten Fahrzeugmeldung nicht bestätigt verriegelt wurde.
//   Nie entriegeln, nie Motor, nie wiederholen (jeep-fernsteuerung prüft „Nachtschloss“ zusätzlich selbst).
// - Fahrzeugzustand aus der ohnehin alle 5 min geholten Fahrzeugmeldung (keine Zusatzabfrage, am echten Jeep am 12.10.2026 belegt:
//   status → vehicleInfo.odometer, .tyrePressure[], .distanceToService, .daysToService), dazu Ladekosten je Monat aus jeep-laden.js.
const fs = require('node:fs'), path = require('node:path');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const hhmmOk = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const DEFAULTS = Object.freeze({ frost: true, gaveUp: true, notPlugged: true, notPluggedTime: '21:00', low: true, tyres: true, nightLock: true, nightLockTime: '22:00' });
const WINDOW_MS = { notPlugged: 30 * 60000, nightLock: 60 * 60000 };
const KEYS = Object.keys(DEFAULTS);

function normalize(p) {
  if (!isObject(p) || Object.keys(p).some(k => !KEYS.includes(k))) throw fail('Ungültige Einstellung');
  const s = { ...DEFAULTS, ...p };
  for (const k of ['frost', 'gaveUp', 'notPlugged', 'low', 'tyres', 'nightLock']) if (typeof s[k] !== 'boolean') throw fail('Ein/Aus ungültig');
  if (!hhmmOk(s.notPluggedTime) || !hhmmOk(s.nightLockTime)) throw fail('Uhrzeit als HH:MM angeben');
  return s;
}
const settings = web => { try { const c = web.security.configSnapshot.read().jeepWache; return isObject(c) ? normalize(c) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };
// Ladeplatz aus der Jeep-Ladesteuerung (jeep-laden.js); Koordinaten bleiben auf der CCU
function ladeplatz(web) { try { const c = web.security.configSnapshot.read().jeepLaden; const s = require('./jeep-laden').normalize(isObject(c) ? c : {}); return s.homeLat === null ? null : { lat: s.homeLat, lon: s.homeLon, radiusM: s.radiusM }; } catch { return null; } }
const distM = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); };
const de = (v, n = 1) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const at = (t, hhmm) => { const d = new Date(t); d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), 0, 0); return d.getTime(); };
const clock = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

// ---------- Fahrzeugzustand ----------
const num = v => { const n = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
const km = (o, max = 2000000) => { const v = num(o?.value); if (v === null || v < 0 || v > max) return null; const u = String(o?.unit || 'km').toLowerCase(); return u === 'mi' ? Math.round(v * 1.609344) : u === 'km' ? Math.round(v) : null; };
const RAD = { FL: 'vorne links', FR: 'vorne rechts', RL: 'hinten links', RR: 'hinten rechts' };
const STATUS = { NORMAL: 'in Ordnung', LOW: 'zu niedrig', HIGH: 'zu hoch', FLAT: 'Reifen platt', UNKNOWN: 'unbekannt' };
function bar(p) { const v = num(p?.value); if (v === null || v <= 0) return null; const u = String(p?.unit || '').toLowerCase(); const b = u === 'kpa' ? v / 100 : u === 'psi' ? v * 0.0689476 : u === 'bar' ? v : null; return b === null || b > 10 ? null : Math.round(b * 100) / 100; }
function health(row) {
  const vi = row?.sources?.status?.data?.vehicleInfo; if (!isObject(vi)) return null;
  const tyres = (Array.isArray(vi.tyrePressure) ? vi.tyrePressure : []).filter(isObject).slice(0, 6).map(t => {
    const st = typeof t.status === 'string' ? t.status.toUpperCase().slice(0, 20) : '';
    return { pos: RAD[t.type] || String(t.type || '?').slice(0, 12), bar: bar(t.pressure), status: STATUS[st] || st.toLowerCase() || 'unbekannt', warning: t.warning === true || ['LOW', 'HIGH', 'FLAT'].includes(st) };
  });
  const days = num(vi.daysToService);
  return { odometerKm: km(vi.odometer?.odometer), serviceKm: km(vi.distanceToService?.distanceToService, 100000), serviceDays: days !== null && days >= -3650 && days <= 3650 ? Math.round(days) : null, tyres };
}

class Wache {
  constructor(web, { now = () => Date.now(), timerMs = 60000, send, position, fern } = {}) {
    this.web = web; this.now = now; this.timerMs = timerMs; this.timer = null; this.busy = false;
    this.sendImpl = send || null; this.positionImpl = position || null; this.fernImpl = fern || null;
    this.file = web.deps?.configPath ? path.join(path.dirname(web.deps.configPath), 'jeep-wache-state.json') : null;
    this.state = { sent: {}, latch: {}, done: {}, log: [] };
    try {
      const r = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of ['sent', 'latch', 'done']) if (isObject(r[k])) this.state[k] = Object.fromEntries(Object.entries(r[k]).filter(([a, b]) => a.length < 80 && (typeof b === 'string' || typeof b === 'boolean')).slice(-100));
      if (Array.isArray(r.log)) this.state.log = r.log.filter(isObject).slice(-30);
    } catch {}
  }
  // SD-Karte schonen (13.10.2026): nur schreiben, wenn sich der Zustand geändert hat (vorher jede Minute)
  save() { if (!this.file) return; try { const s = JSON.stringify(this.state); if (s === this.savedJson) return; require('./durable-storage').atomicJson(this.file, this.state); this.savedJson = s; } catch {} }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), this.timerMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  note(text) { this.state.log.push({ at: new Date(this.now()).toISOString(), text: String(text).slice(0, 200) }); this.state.log = this.state.log.slice(-30); }
  rows() { return (this.web.jeepService?.rows || []).filter(r => typeof r?.vin === 'string').slice(0, 4); }
  fern() { return this.fernImpl || require('./jeep-fernsteuerung').fern(this.web); }
  async position(vin) { return this.positionImpl ? this.positionImpl(vin) : require('./jeep-standort').standort(this.web, vin, false); }
  // Höchstens einmal je Schlüssel; gemerkt VOR dem Versand (auch ein fehlgeschlagener Versand wird nicht wiederholt – kein Spam)
  async whatsapp(key, text) {
    if (this.state.sent[key]) return false;
    const keys = Object.keys(this.state.sent); if (keys.length >= 100) delete this.state.sent[keys[0]];
    this.state.sent[key] = new Date(this.now()).toISOString(); this.note('WhatsApp: ' + text.split('\n').slice(1).join(' '));
    this.save();
    try { if (this.sendImpl) await this.sendImpl(text); else await this.web.security.monitor.send(text); return true; }
    catch (e) { this.note('WhatsApp nicht gesendet: ' + (e?.status ? e.message : 'Versand fehlgeschlagen')); this.save(); return false; }
  }
  // Ereignisse aus jeep-fernsteuerung.js
  async event(kind, data = {}) {
    const s = settings(this.web), now = this.now();
    if (kind === 'vorheizen' && s.frost && data.reason === 'Automation') {
      let t = null; try { t = require('./wetter').wetter(this.web).fresh()?.temperature; } catch {}
      return this.whatsapp('frost:' + dayKey(now) + ':' + (data.departure || ''), 'CCU3 · Jeep\nFrostschutz: Jeep heizt vor, fertig um ' + data.departure + ' Uhr.' + (typeof t === 'number' ? '\nAußen jetzt ' + de(t) + ' °C.' : ''));
    }
    if (kind === 'gaveUp' && s.gaveUp) return this.whatsapp('gaveUp:' + (data.until || dayKey(now)), 'CCU3 · Jeep\n„Klima sofort“: Zeitplan ' + data.nr + ' im Auto konnte nicht zurückgesetzt werden. Bitte in der Jeep-App prüfen und Plan ' + data.nr + ' ausschalten.');
    return false;
  }
  async atHome(vin, home) {
    let pos; try { pos = await this.position(vin); } catch { return null; }
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return null;
    return distM(home.lat, home.lon, pos.lat, pos.lon) <= home.radiusM;
  }
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      const s = settings(this.web), now = this.now(), today = dayKey(now), svc = this.web.jeepService;
      if (!svc?.connected) return null;
      const config = (() => { try { return this.web.security.configSnapshot.read(); } catch { return {}; } })(), JM = require('./jeep-matter');
      for (const row of this.rows()) {
        const id = JM.vehicleId(row.vin), name = this.rows().length > 1 ? 'Jeep ' + (row.name || '') : 'Jeep', battery = typeof row.batteryPercent === 'number' ? row.batteryPercent : null;
        const plugged = row.sources?.status?.data?.evInfo?.battery?.plugInStatus, h = health(row);
        // Akku niedrig: einmal je Absinken; erneut erst nach Laden (Stecker drin) oder Akku wieder 5 % über der Schwelle
        const limit = JM.warningThreshold(config, 'jeep@' + id + '-lowbattery'), lk = 'low:' + id;
        if (battery !== null && (plugged === true || battery >= limit + 5)) { if (this.state.latch[lk]) { delete this.state.latch[lk]; delete this.state.sent[lk]; } }
        else if (s.low && battery !== null && battery < limit && plugged !== true && !this.state.latch[lk]) { this.state.latch[lk] = true; await this.whatsapp(lk, 'CCU3 · ' + name + '\nAkku niedrig: ' + battery + ' % (Warnschwelle ' + limit + ' %). Bitte laden.'); }
        // Reifendruck: einmal je Warnung; erneut erst, wenn das Fahrzeug alle Reifen wieder ohne Warnung meldet
        const bad = (h?.tyres || []).filter(t => t.warning), tk = 'tyre:' + id;
        if (h?.tyres?.length && !bad.length) { if (this.state.latch[tk]) { delete this.state.latch[tk]; delete this.state.sent[tk]; } }
        else if (s.tyres && bad.length && !this.state.latch[tk]) { this.state.latch[tk] = true; await this.whatsapp(tk, 'CCU3 · ' + name + '\nReifendruck-Warnung: ' + bad.map(t => t.pos + (t.bar !== null ? ' ' + de(t.bar, 2) + ' bar' : '') + ' (' + t.status + ')').join(', ') + '.'); }
        const home = ladeplatz(this.web);
        // Abends am Ladeplatz, aber nicht eingesteckt: im Fenster ab der Uhrzeit, einmal je Abend; Standort nur, wenn der Stecker fehlt
        const pk = 'plug:' + id + ':' + today, pFrom = at(now, s.notPluggedTime);
        if (s.notPlugged && home && !this.state.done[pk] && now >= pFrom && now < pFrom + WINDOW_MS.notPlugged && plugged === false && (battery === null || battery < 95)) {
          const there = await this.atHome(row.vin, home);
          if (there === true) { this.state.done[pk] = true; await this.whatsapp(pk, 'CCU3 · ' + name + '\nDer Jeep steht am Ladeplatz, ist aber nicht eingesteckt' + (battery !== null ? ' (Akku ' + battery + ' %)' : '') + '.'); }
        }
        await this.nightLock(s, row, id, home, now, today);
      }
      // Alte Tagesmerker aufräumen
      for (const k of Object.keys(this.state.done)) if (!k.endsWith(today)) delete this.state.done[k];
      this.save();
      return true;
    } finally { this.busy = false; }
  }
  async nightLock(s, row, id, home, now, today) {
    const key = 'lock:' + id + ':' + today, from = at(now, s.nightLockTime);
    if (!s.nightLock || this.state.done[key] || now < from || now >= from + WINDOW_MS.nightLock) return;
    const finish = text => { this.state.done[key] = true; this.note('Nachtschloss: ' + text); };
    if (!home) return finish('kein Ladeplatz festgelegt (Seite Jeep laden) – nichts getan');
    const S = require('./jeep-schloss'), last = S.lastConfirmed(id), report = Date.parse(row.vehicleUpdatedAt || '') || 0;
    if (last?.value === S.LOCKED && last.at >= report) return finish('schon verriegelt (bestätigt ' + clock(last.at) + ') – nichts getan');
    const ign = row.sources?.status?.data?.evInfo?.ignitionStatus;
    if (typeof ign === 'string' && /^(on|run|start)/i.test(ign)) return; // Zündung an: jemand im Auto – später im Fenster erneut prüfen
    const there = await this.atHome(row.vin, home);
    if (there === null) return; // Standort gerade nicht lesbar – im Fenster erneut
    if (!there) return finish('Jeep nicht am Ladeplatz – nichts getan');
    try {
      const r = await this.fern().run(row.vin, 'tueren', true, 'Nachtschloss');
      try { S.hold(id, S.LOCKED); } catch {}
      finish('verriegelt – ' + (r?.message || 'von Uconnect angenommen'));
    } catch (e) {
      if (e.status === 429) return; // anderer Jeep-Befehl läuft bzw. 20 s Abstand – nächste Minute erneut
      finish('fehlgeschlagen – ' + (e.status ? e.message : 'Fehler'));
      await this.whatsapp('lockfail:' + id + ':' + today, 'CCU3 · Jeep\nNachtschloss: Verriegeln hat nicht geklappt (' + String(e.status ? e.message : 'Fehler').slice(0, 160) + '). Bitte in der Jeep-App prüfen.');
    }
  }
  status() {
    const s = settings(this.web), JM = require('./jeep-matter');
    let laden = null; try { laden = require('./jeep-laden')._test.laden(this.web).status(); } catch {}
    return { settings: s, ladeplatz: !!ladeplatz(this.web), whatsapp: !!this.web.security?.monitor,
      vehicles: this.rows().map((r, i, all) => ({ name: all.length > 1 ? 'Jeep Fahrzeug ' + (i + 1) : 'Jeep', updatedAt: r.vehicleUpdatedAt || null, ...(health(r) || { odometerKm: null, serviceKm: null, serviceDays: null, tyres: [] }), lockedConfirmed: (() => { try { const c = require('./jeep-schloss').lastConfirmed(JM.vehicleId(r.vin)); return c ? { locked: c.value === 1, at: new Date(c.at).toISOString() } : null; } catch { return null; } })() })),
      costs: laden ? { priceEur: laden.settings?.priceEur ?? null, months: (laden.months || []).slice(0, 12) } : null, log: this.state.log.slice().reverse() };
  }
}
const instances = new WeakMap();
function wache(web, options) { let w = instances.get(web); if (!w) { w = new Wache(web, options); instances.set(web, w); } return w; }
function start(web, options) { const w = wache(web, options); w.start(); return w; }
function event(web, kind, data) { wache(web).event(kind, data).catch(() => {}); }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getJeepWache', 'saveJeepWache'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const w = wache(web);
    if (method === 'getJeepWache') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, w.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const s = normalize(await require('./web-security').body(req));
    web.writeConfigPatch(c => { c.jeepWache = s; });
    send(200, { success: true, ...w.status(), message: 'Gespeichert.' + (s.nightLock && !ladeplatz(web) ? ' Hinweis: Für das Nachtschloss zuerst unter „Jeep laden“ den Ladeplatz festlegen.' : '') });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Jeep-Wache: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, event, normalize, health, DEFAULTS, _test: { Wache, wache, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
