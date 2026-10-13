'use strict';
// Jeep-Ladesteuerung (Wunsch Thomas, 11.10.2026) – ersetzt die alten CCU-Programme „Jeep start“, „Jeep Steckdose Ein“,
// „P Jeep Laden beendet“, „P Jeep-Monatsabschluss“ … (dort werden sie deaktiviert, nicht gelöscht):
// - Steckdose geht an → WhatsApp „Jeep: Ladung beginnt“ (mit Zählerstand).
// - Innerhalb von 1 Minute kein Strom → Steckdose aus (Akku voll oder Stecker nicht drin).
// - Während des Ladens Leistung länger als x Minuten unter y W → aus (Ladung beendet).
// - Akkustand des Jeep ≥ 100 % → aus. Der Akkustand zählt nur, wenn die Fahrzeugmeldung NEUER ist als das Einschalten
//   (sonst würde ein alter 100-%-Wert die Steckdose sofort wieder abschalten).
// - Ende → WhatsApp mit geladenen kWh und Kosten; Aufzeichnung je Ladung und Monatsverbrauch aus dem Zähler der Steckdose;
//   am Monatsanfang WhatsApp mit dem Gesamtverbrauch des Vormonats.
// Geschaltet wird über den geprüften Weg der Automationen (einmal senden, zurücklesen).
const fs = require('fs'), path = require('path');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const SOCKET = /^TASMOTA-[A-Za-z0-9_-]{1,64}:\d{1,2}$/;
// autoOn/awayOff (Wunsch Thomas, 12.10.2026): Ladeplatz (homeLat/homeLon) ± radiusM – eingesteckt am Ladeplatz → an; Jeep weg → aus
const DEFAULTS = Object.freeze({ enabled: false, socket: '', stopBelowW: 100, stopAfterMin: 3, startTimeoutSec: 60, startW: 10, stopAtPercent: 100, priceEur: 0.38, notify: true, note: '', autoOn: false, awayOff: false, homeLat: null, homeLon: null, homeAddress: '', radiusM: 100 });
const LIMITS = Object.freeze({ sessions: 60, months: 36, log: 40 });

function normalize(p) {
  if (!isObject(p)) throw fail('Ungültige Einstellung');
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULTS, k))) throw fail('Unerwartete Felder in der Einstellung');
  const s = { ...DEFAULTS, ...p };
  const num = (v, min, max, name) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw fail(name + ': ' + min + ' bis ' + max); return Math.round(v * 100) / 100; };
  if (typeof s.enabled !== 'boolean' || typeof s.notify !== 'boolean') throw fail('Ein/Aus ungültig');
  if (s.socket !== '' && (typeof s.socket !== 'string' || !SOCKET.test(s.socket))) throw fail('Steckdose ungültig');
  if (s.enabled && !s.socket) throw fail('Zum Einschalten die Jeep-Steckdose auswählen');
  s.stopBelowW = num(s.stopBelowW, 1, 3000, 'Ausschalten unter (W)');
  s.stopAfterMin = Math.round(num(s.stopAfterMin, 1, 60, 'Wie lange darunter (Minuten)'));
  s.startTimeoutSec = Math.round(num(s.startTimeoutSec, 30, 600, 'Wartezeit auf Strom (Sekunden)'));
  s.startW = num(s.startW, 1, 500, 'Strom fließt ab (W)');
  if (s.startW > s.stopBelowW) throw fail('„Strom fließt ab“ darf nicht größer sein als „Ausschalten unter“');
  s.stopAtPercent = Math.round(num(s.stopAtPercent, 0, 100, 'Ausschalten bei Akkustand (%; 0 = nie)'));
  num(s.priceEur, 0, 5, 'Strompreis (€/kWh)'); s.priceEur = Math.round(s.priceEur * 10000) / 10000; // 4 Stellen (z. B. 0,3088 €/kWh naturenergie)
  if (typeof s.note !== 'string' || s.note.trim().length > 200 || /[\x00-\x1f\x7f]/.test(s.note)) throw fail('Bemerkung: höchstens 200 Zeichen, keine Steuerzeichen');
  s.note = s.note.trim();
  if (typeof s.autoOn !== 'boolean' || typeof s.awayOff !== 'boolean') throw fail('Ein/Aus ungültig');
  if ((s.homeLat === null) !== (s.homeLon === null)) throw fail('Ladeplatz unvollständig');
  if (typeof s.homeAddress !== 'string' || s.homeAddress.length > 160 || /[\x00-\x1f\x7f]/.test(s.homeAddress)) throw fail('Adresse ungültig');
  if (s.homeLat !== null && (typeof s.homeLat !== 'number' || typeof s.homeLon !== 'number' || !Number.isFinite(s.homeLat) || !Number.isFinite(s.homeLon) || Math.abs(s.homeLat) > 90 || Math.abs(s.homeLon) > 180)) throw fail('Ladeplatz ungültig');
  s.radiusM = Math.round(num(s.radiusM, 30, 2000, 'Umkreis (m)'));
  if ((s.autoOn || s.awayOff) && s.homeLat === null) throw fail('Zuerst den Ladeplatz festlegen (aktueller Jeep-Standort)');
  return s;
}
const settings = web => { try { const c = web.security.configSnapshot.read().jeepLaden; return isObject(c) ? normalize(c) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };
// Geräteliste nennt Tasmota-Steckdosen „tasmota@<mac>-<n>“, geschaltet wird über „TASMOTA-<mac>:<n>“.
const switchAddress = a => { const m = /^tasmota@([a-f0-9]{12})-(\d{1,2})$/.exec(String(a || '')); return m ? 'TASMOTA-' + m[1] + ':' + m[2] : String(a || ''); };
const monthKey = t => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
const kwh = v => Math.round(v * 1000) / 1000;
// Entfernung in Metern (Haversine)
const distM = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(h)); };
// „Ladekabel eingesteckt“ aus dem Fahrzeugstatus (evInfo, wie py-uconnect: battery.plugInStatus); true/false/null (unbekannt)
let plugLogged = false;
function plugOf(row) {
  const ev = row?.sources?.status?.data?.evInfo; if (!ev || typeof ev !== 'object') return null;
  const b = ev.battery || ev;
  for (const v of [b.plugInStatus, b.plugStatus, b.chargerPluggedIn, ev.plugInStatus]) { if (typeof v === 'boolean') return v; if (typeof v === 'string' && /^(true|false|plugged|unplugged|connected|disconnected)/i.test(v)) return /^(true|plugged|connected)/i.test(v); }
  if (!plugLogged) { plugLogged = true; const k = o => o && typeof o === 'object' ? Object.keys(o).slice(0, 30).join(',') : ''; console.log('[jeep-laden] kein Stecker-Status gefunden; evInfo: ' + k(ev) + (ev.battery ? ' | battery: ' + k(ev.battery) : '')); }
  return null;
}
const de = (v, n = 2) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });

class Laden {
  constructor(web, { now = () => Date.now(), timerMs = 15000, switchDevice, socketRow, jeepPercent, send, jeepPlug, jeepPosition } = {}) {
    this.web = web; this.now = now; this.timerMs = timerMs; this.timer = null; this.busy = false;
    this.jeepPlugImpl = jeepPlug || null; this.jeepPositionImpl = jeepPosition || null;
    this.switchDevice = switchDevice || ((w, a, on) => require('./automationen').switchDevice(w, a, on));
    this.socketRowImpl = socketRow || null; this.jeepPercentImpl = jeepPercent || null; this.sendImpl = send || null;
    this.file = path.join(path.dirname(web.deps.configPath), 'jeep-laden-state.json');
    this.state = { prevOn: null, session: null, sessions: [], months: {}, lastTotal: null, month: '', log: [], plugLatch: false };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw.prevOn === 'boolean') this.state.prevOn = raw.prevOn;
      if (isObject(raw.session) && Number.isFinite(raw.session.start)) this.state.session = raw.session;
      if (Array.isArray(raw.sessions)) this.state.sessions = raw.sessions.filter(isObject).slice(-LIMITS.sessions);
      if (isObject(raw.months)) for (const [k, v] of Object.entries(raw.months)) if (/^\d{4}-\d\d$/.test(k) && Number.isFinite(v) && v >= 0) this.state.months[k] = v;
      if (Number.isFinite(raw.lastTotal)) this.state.lastTotal = raw.lastTotal;
      if (typeof raw.month === 'string' && /^\d{4}-\d\d$/.test(raw.month)) this.state.month = raw.month;
      if (Array.isArray(raw.log)) this.state.log = raw.log.filter(isObject).slice(-LIMITS.log);
      if (typeof raw.plugLatch === 'boolean') this.state.plugLatch = raw.plugLatch;
    } catch {}
  }
  save() { try { require('./durable-storage').atomicJson(this.file, this.state); } catch {} }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), this.timerMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  note(text) { this.state.log.push({ at: new Date(this.now()).toISOString(), text }); this.state.log = this.state.log.slice(-LIMITS.log); }
  socketRow(s) { try { return this.socketRowImpl ? this.socketRowImpl(s.socket) : require('./tasmota').rows(this.web).find(r => switchAddress(r.address) === s.socket) || null; } catch { return null; } }
  // Akkustand mit Zeitpunkt der Fahrzeugmeldung (aus der Jeep-Anbindung)
  jeepPercent() {
    try {
      if (this.jeepPercentImpl) return this.jeepPercentImpl();
      const row = require('./jeep-matter').rows(this.web).find(r => typeof r.address === 'string' && r.address.endsWith('-percent'));
      const v = row?.currentState?.value, at = Date.parse(row?.currentState?.timestamp || '');
      return Number.isFinite(v) && Number.isFinite(at) ? { value: v, at } : null;
    } catch { return null; }
  }
  plug() { try { return this.jeepPlugImpl ? this.jeepPlugImpl() : plugOf((this.web.jeepService?.rows || [])[0]); } catch { return null; } }
  async position() { try { return this.jeepPositionImpl ? await this.jeepPositionImpl() : await require('./jeep-standort').standort(this.web, null, false); } catch { return null; } }
  // Ladeplatz: eingesteckt am Ladeplatz → Steckdose an (einmal je Einstecken, damit Ausschalten von Hand gilt);
  // Jeep weiter als der Umkreis weg → Steckdose aus. Standort höchstens jede Minute bzw. alle 5 Minuten (Uconnect-Abfrage).
  async geo(s, st, now) {
    const plugged = this.plug();
    if (plugged === false && this.state.plugLatch) { this.state.plugLatch = false; this.note('Ladekabel ausgesteckt'); }
    if (s.autoOn && !st.on && plugged === true && !this.state.plugLatch && now - (this.geoAt || 0) >= 60000) {
      this.geoAt = now; const pos = await this.position(); if (!pos) return;
      const d = distM(s.homeLat, s.homeLon, pos.lat, pos.lon);
      if (d <= s.radiusM) {
        this.state.plugLatch = true; this.note('Jeep am Ladeplatz eingesteckt (' + Math.round(d) + ' m) – Steckdose wird eingeschaltet');
        try { await this.switchDevice(this.web, s.socket, true); } catch (e) { this.note('Einschalten fehlgeschlagen: ' + (e.status ? e.message : 'Fehler')); }
      }
    }
    if (s.awayOff && st.on && now - (this.awayAt || 0) >= 300000) {
      this.awayAt = now; const pos = await this.position(); if (!pos) return;
      const d = distM(s.homeLat, s.homeLon, pos.lat, pos.lon);
      if (d > s.radiusM) await this.off(s, 'Jeep nicht am Ladeplatz (' + Math.round(d) + ' m entfernt)');
    }
  }
  async whatsapp(text) {
    const s = settings(this.web); if (!s.notify) return;
    try { if (this.sendImpl) await this.sendImpl(text); else await this.web.security.monitor.send(text); }
    catch (e) { this.note('WhatsApp nicht gesendet: ' + (e?.status ? e.message : 'Versand fehlgeschlagen')); }
  }
  stamp() { return new Date(this.now()).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); }
  // Zählerstand fortschreiben: Zuwachs zählt für den laufenden Monat; ein kleinerer Zählerstand (Gerät zurückgesetzt) wird übernommen.
  count(total) {
    if (!Number.isFinite(total)) return;
    const last = this.state.lastTotal;
    if (Number.isFinite(last) && total > last && total - last < 100) { const m = monthKey(this.now()); this.state.months[m] = kwh((this.state.months[m] || 0) + (total - last)); }
    this.state.lastTotal = total;
    const keys = Object.keys(this.state.months).sort(); while (keys.length > LIMITS.months) delete this.state.months[keys.shift()];
  }
  async monthEnd() {
    const m = monthKey(this.now());
    if (!this.state.month) { this.state.month = m; return; }
    if (this.state.month === m) return;
    const prev = this.state.month; this.state.month = m;
    const used = this.state.months[prev] || 0, s = settings(this.web);
    const [y, mo] = prev.split('-');
    this.note(`Monatsabschluss ${mo}/${y}: ${de(used)} kWh`);
    await this.whatsapp(`CCU3 · Jeep Monatsverbrauch ${mo}/${y}\n${de(used)} kWh` + (s.priceEur > 0 ? `\nKosten ${de(used * s.priceEur)} € (bei ${de(s.priceEur, 2)} €/kWh)` : ''));
  }
  async off(s, reason) {
    if (this.state.session) this.state.session.reason = reason;
    let r; try { r = await this.switchDevice(this.web, s.socket, false); } catch (e) { this.note('Ausschalten fehlgeschlagen (' + reason + '): ' + (e.status ? e.message : 'Fehler')); return; }
    this.note('Steckdose aus: ' + reason + (r?.confirmed === true ? '' : ' (nicht bestätigt)'));
  }
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      const s = settings(this.web), now = this.now();
      await this.monthEnd();
      if (!s.socket) { this.save(); return null; }
      const row = this.socketRow(s), st = row?.currentState || {};
      if (!row || row.online === false || typeof st.on !== 'boolean') { this.save(); return null; }
      this.count(st.energyTotal);
      const power = Number.isFinite(st.power) ? st.power : null;
      // Einschalten erkannt (auch von Hand, Apple Home oder alte Taste)
      if (st.on && this.state.prevOn !== true) {
        this.state.session = { start: now, startTotal: Number.isFinite(st.energyTotal) ? st.energyTotal : null, sawPower: false, lowSince: null, reason: '' };
        if (this.state.prevOn === false) { this.note('Steckdose an – Ladung beginnt'); await this.whatsapp(`CCU3 · Jeep\n${this.stamp()}\nLadung beginnt.` + (Number.isFinite(st.energyTotal) ? `\nZählerstand ${de(st.energyTotal, 3)} kWh` : '')); }
      }
      // Ausschalten erkannt → Ladung abschließen
      if (!st.on && this.state.prevOn === true && this.state.session) {
        const se = this.state.session, used = Number.isFinite(se.startTotal) && Number.isFinite(st.energyTotal) ? kwh(Math.max(0, st.energyTotal - se.startTotal)) : null;
        const entry = { start: new Date(se.start).toISOString(), end: new Date(now).toISOString(), kWh: used, costEur: used !== null && s.priceEur > 0 ? Math.round(used * s.priceEur * 100) / 100 : null, reason: se.reason || 'von Hand ausgeschaltet' };
        this.state.sessions.push(entry); this.state.sessions = this.state.sessions.slice(-LIMITS.sessions); this.state.session = null;
        this.note('Ladung beendet: ' + (used !== null ? de(used) + ' kWh' : 'Verbrauch unbekannt') + ' – ' + entry.reason);
        await this.whatsapp(`CCU3 · Jeep\n${this.stamp()}\nLadung beendet (${entry.reason}).` + (used !== null ? `\nGeladen: ${de(used)} kWh` + (entry.costEur !== null ? `, Kosten ${de(entry.costEur)} €` : '') : '') + `\nMonat bisher: ${de(this.state.months[monthKey(now)] || 0)} kWh`);
      }
      this.state.prevOn = st.on;
      if (s.enabled && s.homeLat !== null && (s.autoOn || s.awayOff)) await this.geo(s, st, now);
      if (st.on && this.state.session && s.enabled) {
        const se = this.state.session;
        if (power !== null && power >= s.startW) se.sawPower = true;
        const pct = s.stopAtPercent > 0 ? this.jeepPercent() : null;
        if (pct && pct.at > se.start && pct.value >= s.stopAtPercent) await this.off(s, `Akku ${pct.value} %`);
        else if (!se.sawPower && now - se.start >= s.startTimeoutSec * 1000) await this.off(s, `kein Strom innerhalb ${s.startTimeoutSec} s – Akku voll oder Stecker nicht drin`);
        else if (se.sawPower && power !== null && power < s.stopBelowW) {
          if (!se.lowSince) se.lowSince = now;
          if (now - se.lowSince >= s.stopAfterMin * 60000) await this.off(s, `Leistung ${s.stopAfterMin} min unter ${de(s.stopBelowW, 0)} W – Ladung beendet`);
        } else se.lowSince = null;
      }
      this.save();
      return { on: st.on, power };
    } finally { this.busy = false; }
  }
  status() {
    const s = settings(this.web), row = s.socket ? this.socketRow(s) : null, pct = this.jeepPercent();
    let sockets = []; try { sockets = require('./tasmota').rows(this.web).filter(r => Number.isFinite(r.currentState?.power) || Number.isFinite(r.currentState?.energyTotal)).map(r => ({ address: switchAddress(r.address), name: r.name, on: r.currentState?.on === true, power: r.currentState?.power ?? null })); } catch {}
    // Koordinaten des Ladeplatzes nicht an die Oberfläche (nur Adresse und „festgelegt“), dazu der Stecker-Status des Jeep
    const pub = { ...s, homeSet: s.homeLat !== null }; delete pub.homeLat; delete pub.homeLon;
    return { settings: pub, plugged: this.plug(), sockets, now: row ? { on: row.currentState?.on === true, power: row.currentState?.power ?? null, energyTotal: row.currentState?.energyTotal ?? null, online: row.online !== false } : null,
      percent: pct ? { value: pct.value, at: new Date(pct.at).toISOString() } : null, session: this.state.session ? { start: new Date(this.state.session.start).toISOString(), startTotal: this.state.session.startTotal } : null,
      sessions: this.state.sessions.slice().reverse(), months: Object.entries(this.state.months).sort((a, b) => b[0].localeCompare(a[0])).map(([month, v]) => ({ month, kWh: v, costEur: s.priceEur > 0 ? Math.round(v * s.priceEur * 100) / 100 : null })), log: this.state.log.slice().reverse() };
  }
}
const instances = new WeakMap();
function laden(web, options) { let l = instances.get(web); if (!l) { l = new Laden(web, options); instances.set(web, l); } return l; }
function start(web, options) { const l = laden(web, options); l.start(); return l; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getJeepLaden', 'saveJeepLaden', 'setJeepLadeplatz'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const l = laden(web);
    if (method === 'getJeepLaden') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, l.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    // Ladeplatz = aktueller Jeep-Standort (frisch bei Uconnect gefragt); Koordinaten bleiben auf der CCU, die Oberfläche bekommt nur die Adresse
    if (method === 'setJeepLadeplatz') {
      await require('./web-security').body(req);
      const pos = await require('./jeep-standort').standort(web, null, true);
      const cur = settings(web), next = normalize({ ...cur, homeLat: Math.round(pos.lat * 1e6) / 1e6, homeLon: Math.round(pos.lon * 1e6) / 1e6, homeAddress: String(pos.address || '').slice(0, 160) });
      web.writeConfigPatch(cfg => { cfg.jeepLaden = next; });
      send(200, { success: true, ...l.status(), message: 'Ladeplatz festgelegt: ' + (pos.address || 'aktueller Jeep-Standort') + '.' }); return true;
    }
    const body = await require('./web-security').body(req), keep = settings(web);
    // Ladeplatz-Koordinaten kommen nie von der Oberfläche (nur über setJeepLadeplatz); beim Speichern bleiben sie erhalten
    const s = normalize({ ...(isObject(body) ? body : {}), homeLat: keep.homeLat, homeLon: keep.homeLon, homeAddress: keep.homeAddress });
    web.writeConfigPatch(cfg => { cfg.jeepLaden = s; });
    send(200, { success: true, ...l.status(), message: s.enabled ? 'Gespeichert. Die Jeep-Ladesteuerung ist eingeschaltet.' : 'Gespeichert. Die Jeep-Ladesteuerung schaltet nicht (Aufzeichnung läuft weiter, wenn eine Steckdose gewählt ist).' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Jeep-Laden: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, normalize, DEFAULTS, _test: { Laden, laden, monthKey, switchAddress, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
