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
// faultOn (Wunsch Thomas, 13.10.2026): meldet der Jeep einen Ladefehler (höchstens 30 min alte Fahrzeugmeldung) und steht er
// am Ladeplatz → Steckdose an (einmal je Ladefehler)
// akkuKWh (Thomas 13.10.2026): Der Jeep überträgt keine kWh, nur den Akkustand in % (am echten Fahrzeug geprüft:
// evInfo.battery = stateOfCharge, chargingStatus, chargingLevel, timeToFullyChargeL2, plugInStatus, Reichweiten). Darum die nutzbare
// Kapazität als Einstellung, Standard 9,1 kWh (Compass 4xe PHEV: 11,4 kWh brutto, ca. 9,1 kWh netto laut Testbericht vision-mobility.de;
// eine Datenbank nennt 10,0 kWh) – alle daraus berechneten Akku-kWh gelten als geschätzt.
const DEFAULTS = Object.freeze({ akkuKWh: 9.1, enabled: false, socket: '', stopBelowW: 100, stopAfterMin: 3, startTimeoutSec: 60, startW: 10, stopAtPercent: 100, priceEur: 0.38, notify: true, note: '', autoOn: false, awayOff: false, faultOn: true, retries: 1, retryWaitSec: 60, homeLat: null, homeLon: null, homeAddress: '', radiusM: 100 });
const FAULT_MAX_AGE_MS = 30 * 60000;// Wartezeit auf Strom: erster Versuch wie eingestellt, neuer Versuch doppelt (mindestens 120 s) – Puffer fürs Fahrzeug
const waitMs = (s, se) => (se.tries ? Math.max(120, s.startTimeoutSec * 2) : s.startTimeoutSec) * 1000;
// Ladefehler im Uconnect-Ladestatus (battery.chargingStatus); unbekannte Werte werden einmal protokolliert
const isFault = v => typeof v === 'string' && /fault|error|fail|interrupt|abort|problem/i.test(v);
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
  s.akkuKWh = num(s.akkuKWh, 3, 30, 'Nutzbare Akkukapazität (kWh)');
  num(s.priceEur, 0, 5, 'Strompreis (€/kWh)'); s.priceEur = Math.round(s.priceEur * 10000) / 10000; // 4 Stellen (z. B. 0,3088 €/kWh naturenergie)
  if (typeof s.note !== 'string' || s.note.trim().length > 200 || /[\x00-\x1f\x7f]/.test(s.note)) throw fail('Bemerkung: höchstens 200 Zeichen, keine Steuerzeichen');
  s.note = s.note.trim();
  if (typeof s.autoOn !== 'boolean' || typeof s.awayOff !== 'boolean' || typeof s.faultOn !== 'boolean') throw fail('Ein/Aus ungültig');
  if ((s.homeLat === null) !== (s.homeLon === null)) throw fail('Ladeplatz unvollständig');
  if (typeof s.homeAddress !== 'string' || s.homeAddress.length > 160 || /[\x00-\x1f\x7f]/.test(s.homeAddress)) throw fail('Adresse ungültig');
  if (s.homeLat !== null && (typeof s.homeLat !== 'number' || typeof s.homeLon !== 'number' || !Number.isFinite(s.homeLat) || !Number.isFinite(s.homeLon) || Math.abs(s.homeLat) > 90 || Math.abs(s.homeLon) > 180)) throw fail('Ladeplatz ungültig');
  s.radiusM = Math.round(num(s.radiusM, 30, 2000, 'Umkreis (m)'));
  s.retries = Math.round(num(s.retries, 0, 3, 'Neue Versuche ohne Strom'));
  s.retryWaitSec = Math.round(num(s.retryWaitSec, 10, 300, 'Pause vor neuem Versuch (Sekunden)'));
  if ((s.autoOn || s.awayOff) && s.homeLat === null) throw fail('Zuerst den Ladeplatz festlegen (aktueller Jeep-Standort)');
  return s;
}
const settings = web => { try { const c = web.security.configSnapshot.read().jeepLaden; return isObject(c) ? normalize(c) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };
// Geräteliste nennt Tasmota-Steckdosen „tasmota@<mac>-<n>“, geschaltet wird über „TASMOTA-<mac>:<n>“.
const switchAddress = a => { const m = /^tasmota@([a-f0-9]{12})-(\d{1,2})$/.exec(String(a || '')); return m ? 'TASMOTA-' + m[1] + ':' + m[2] : String(a || ''); };
// Akkustand je Ladung: Anfang = letzte Fahrzeugmeldung bis 20 min nach dem Einschalten (der Jeep meldet sich beim Ladestart);
// Ende = neueste Meldung danach. Die Ende-WhatsApp geht SOFORT mit den Tasmota-Werten raus (Wunsch Thomas 13.10.2026: genau eine
// Nachricht je Ladung, Tasmota ist genauer). Fehlt am Ende eine frische Meldung (höchstens 10 min alt), wird der Akkustand bis zu
// 20 min später nur still in der Ladeliste nachgetragen – ohne zweite Nachricht.
const SOC_START_WINDOW = 20 * 60000, SOC_FRESH = 10 * 60000, SOC_WAIT = 20 * 60000;
function evaluate(entry, akkuKWh) {
  const a = entry.socStart, b = entry.socEnd; entry.akkuKWh = akkuKWh; entry.batteryKWh = null; entry.efficiencyPct = null; entry.lossKWh = null; entry.costPerBatteryKWh = null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return entry;
  entry.batteryKWh = Math.round((b - a) / 100 * akkuKWh * 100) / 100;
  if (Number.isFinite(entry.kWh) && entry.kWh > 0 && entry.batteryKWh > 0) {
    const eff = entry.batteryKWh / entry.kWh;
    if (eff >= 0.3 && eff <= 1.05) { entry.efficiencyPct = Math.round(eff * 100); entry.lossKWh = Math.round(Math.max(0, entry.kWh - entry.batteryKWh) * 100) / 100; }
    if (Number.isFinite(entry.costEur)) entry.costPerBatteryKWh = Math.round(entry.costEur / entry.batteryKWh * 100) / 100;
  }
  return entry;
}
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
  constructor(web, { now = () => Date.now(), timerMs = 15000, switchDevice, socketRow, jeepPercent, send, jeepPlug, jeepPosition, jeepCharging } = {}) {
    this.web = web; this.now = now; this.timerMs = timerMs; this.timer = null; this.busy = false;
    this.jeepPlugImpl = jeepPlug || null; this.jeepPositionImpl = jeepPosition || null; this.jeepChargingImpl = jeepCharging || null;
    this.switchDevice = switchDevice || ((w, a, on) => require('./automationen').switchDevice(w, a, on));
    this.socketRowImpl = socketRow || null; this.jeepPercentImpl = jeepPercent || null; this.sendImpl = send || null;
    this.file = path.join(path.dirname(web.deps.configPath), 'jeep-laden-state.json');
    this.state = { prevOn: null, session: null, sessions: [], months: {}, monthsPriced: {}, lastTotal: null, month: '', log: [], plugLatch: false, faultLatch: false, retry: null };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (typeof raw.prevOn === 'boolean') this.state.prevOn = raw.prevOn;
      if (isObject(raw.session) && Number.isFinite(raw.session.start)) this.state.session = raw.session;
      if (Array.isArray(raw.sessions)) this.state.sessions = raw.sessions.filter(isObject).slice(-LIMITS.sessions);
      if (isObject(raw.months)) for (const [k, v] of Object.entries(raw.months)) if (/^\d{4}-\d\d$/.test(k) && Number.isFinite(v) && v >= 0) this.state.months[k] = v;
      if (isObject(raw.monthsPriced)) for (const [k, v] of Object.entries(raw.monthsPriced)) if (/^\d{4}-\d\d$/.test(k) && isObject(v) && Number.isFinite(v.kWh) && Number.isFinite(v.eur) && v.kWh >= 0 && v.eur >= 0) this.state.monthsPriced[k] = { kWh: v.kWh, eur: v.eur };
      if (Number.isFinite(raw.lastTotal)) this.state.lastTotal = raw.lastTotal;
      if (typeof raw.month === 'string' && /^\d{4}-\d\d$/.test(raw.month)) this.state.month = raw.month;
      if (Array.isArray(raw.log)) this.state.log = raw.log.filter(isObject).slice(-LIMITS.log);
      if (isObject(raw.pending) && typeof raw.pending.end === 'string' && Number.isFinite(raw.pending.until)) this.state.pending = { end: raw.pending.end, until: raw.pending.until };
      if (typeof raw.plugLatch === 'boolean') this.state.plugLatch = raw.plugLatch;
      if (typeof raw.faultLatch === 'boolean') this.state.faultLatch = raw.faultLatch;      if (isObject(raw.retry) && Number.isFinite(raw.retry.at) && Number.isInteger(raw.retry.tries)) this.state.retry = { at: raw.retry.at, tries: raw.retry.tries, since: Number.isFinite(raw.retry.since) ? raw.retry.since : raw.retry.at };
    } catch {}
  }
  // SD-Karte schonen (13.10.2026, gemessen: vorher alle 15 s 9 KB neu geschrieben): unverändert → gar nicht schreiben;
  // ändern sich nur Zählerstand/Monatswerte (laufende Ladung) → höchstens 1× je Minute; alles andere (Ladebeginn/-ende,
  // Meldungen, Versuche) sofort, damit nach einem Neustart nichts doppelt kommt.
  save() {
    try {
      const all = JSON.stringify(this.state); if (all === this.savedAll) return;
      const { lastTotal, months, monthsPriced, ...rest } = this.state, core = JSON.stringify(rest), now = Date.now();
      if (core === this.savedCore && this.savedAt && now - this.savedAt < 60000) return;
      require('./durable-storage').atomicJson(this.file, this.state); this.savedAll = all; this.savedCore = core; this.savedAt = now;
    } catch {}
  }
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
  trackSoc(se) {
    const p = this.jeepPercent(); if (!p) return;
    if (!Number.isFinite(se.socStartAt) || (p.at > se.socStartAt && p.at <= se.start + SOC_START_WINDOW)) { se.socStart = p.value; se.socStartAt = p.at; }
    if (p.at > se.start && p.at >= se.socStartAt && (!Number.isFinite(se.socEndAt) || p.at > se.socEndAt)) { se.socEnd = p.value; se.socEndAt = p.at; }
  }
  endText(entry) {
    const used = entry.kWh, iso = t => t ? new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    let t = `CCU3 · Jeep\n${this.stamp()}\nLadung beendet (${entry.reason}).` + (used !== null ? `\nGeladen: ${de(used)} kWh` + (entry.costEur !== null ? `, Kosten ${de(entry.costEur)} €` : '') : '');
    if (Number.isFinite(entry.socStart) && Number.isFinite(entry.socEnd)) {
      t += `\nAkku: ${entry.socStart} % → ${entry.socEnd} %` + (entry.batteryKWh !== null ? ` (≈ ${de(entry.batteryKWh)} kWh im Akku, geschätzt bei ${de(entry.akkuKWh, 1)} kWh nutzbar)` : '');
      // Wirkungsgrad/Ladeverlust nicht mehr in der WhatsApp (Wunsch Thomas 13.10.2026) – steht weiter in der Ladeliste
    } else if (Number.isFinite(entry.socStart)) t += `\nAkku am Anfang: ${entry.socStart} % (Meldung ${iso(entry.socStartAt)} Uhr); den Stand am Ende trägt die Ladeliste nach, sobald sich der Jeep meldet.`;
    // Monat bisher mit Gesamtkosten (Wunsch Thomas 13.10.2026), Kosten mit dem beim Laden gültigen Preis (monthCost)
    const m = monthKey(this.now()), cost = this.monthCost(m, settings(this.web).priceEur);
    return t + `\nMonat bisher: ${de(this.state.months[m] || 0)} kWh` + (cost !== null && cost > 0 ? `, Kosten ${de(cost)} €` : '');
  }
  // Akkustand am Ende nachtragen: frische Fahrzeugmeldung abwarten (höchstens 20 min), dann still auswerten (keine zweite WhatsApp)
  async finishPending(s, now) {
    const pe = this.state.pending; if (!pe) return;
    const entry = this.state.sessions.find(x => x.end === pe.end); if (!entry) { this.state.pending = null; return; }
    const p = this.jeepPercent(), startAt = Date.parse(entry.socStartAt || '');
    const fresh = p && p.at >= Date.parse(pe.end) - SOC_FRESH && (!Number.isFinite(startAt) || p.at > startAt);
    if (!fresh && now < pe.until) return;
    if (fresh) { entry.socEnd = p.value; entry.socEndAt = new Date(p.at).toISOString(); }
    evaluate(entry, s.akkuKWh); this.state.pending = null;
    if (fresh) this.note('Akkustand nach dem Laden nachgetragen: ' + entry.socStart + ' % → ' + entry.socEnd + ' %' + (entry.batteryKWh !== null ? ' (≈ ' + de(entry.batteryKWh) + ' kWh, geschätzt)' : ''));
  }
  plug() { try { return this.jeepPlugImpl ? this.jeepPlugImpl() : plugOf((this.web.jeepService?.rows || [])[0]); } catch { return null; } }
  // Ladestatus des Jeep mit Zeitpunkt der Fahrzeugmeldung: { status, at } oder null
  charging() {
    try {
      if (this.jeepChargingImpl) return this.jeepChargingImpl();
      const row = (this.web.jeepService?.rows || [])[0], at = Date.parse(row?.vehicleUpdatedAt || '');
      if (typeof row?.charging !== 'string' || !Number.isFinite(at)) return null;
      if (!(this.seenCharging ||= new Set()).has(row.charging) && this.seenCharging.size < 20) { this.seenCharging.add(row.charging); console.log('[jeep-laden] Ladestatus vom Jeep: ' + row.charging); }
      return { status: row.charging, at };
    } catch { return null; }
  }
  async position() { try { return this.jeepPositionImpl ? await this.jeepPositionImpl() : await require('./jeep-standort').standort(this.web, null, false); } catch { return null; } }
  // Ladeplatz: eingesteckt am Ladeplatz → Steckdose an (einmal je Einstecken, damit Ausschalten von Hand gilt);
  // Jeep weiter als der Umkreis weg → Steckdose aus. Standort höchstens jede Minute bzw. alle 5 Minuten (Uconnect-Abfrage).
  async geo(s, st, now) {
    const plugged = this.plug();
    if (plugged === false && this.state.plugLatch) { this.state.plugLatch = false; this.note('Ladekabel ausgesteckt'); }
    // Ladefehler: nur eine höchstens 30 min alte Fahrzeugmeldung zählt; einmal je Ladefehler (erneut erst nach einer Meldung ohne Fehler)
    const ch = this.charging();
    // Akku voll laut letzter Meldung → weder Ladefehler- noch Einsteck-Automatik schalten ein (13.10.2026 live: nach „Akku 100 %“
    // schaltete „eingesteckt“ sofort wieder ein, nach dem Ausstecken der Ladefehler noch einmal → zwei 0-kWh-Meldungen)
    const pctNow = s.stopAtPercent > 0 ? this.jeepPercent() : null, full = !!pctNow && pctNow.value >= s.stopAtPercent;
    if (ch && !isFault(ch.status) && this.state.faultLatch) this.state.faultLatch = false;
    if (s.faultOn && !st.on && plugged !== false && !full && ch && isFault(ch.status) && now - ch.at <= FAULT_MAX_AGE_MS && !this.state.faultLatch && now - (this.faultAt || 0) >= 60000) {
      this.faultAt = now; const pos = await this.position(); if (!pos) return;
      const d = distM(s.homeLat, s.homeLon, pos.lat, pos.lon);
      if (d <= s.radiusM) {
        this.state.faultLatch = true; this.note('Jeep meldet Ladefehler (' + ch.status + ') am Ladeplatz – Steckdose wird eingeschaltet');
        try { await this.switchDevice(this.web, s.socket, true); await this.whatsapp(`CCU3 · Jeep\n${this.stamp()}\nLadefehler gemeldet – Steckdose am Ladeplatz eingeschaltet.`); }
        catch (e) { this.note('Einschalten fehlgeschlagen: ' + (e.status ? e.message : 'Fehler')); }
        return;
      }
    }
    if (s.autoOn && !st.on && plugged === true && !full && !this.state.plugLatch && now - (this.geoAt || 0) >= 60000) {
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
  // Monatskosten mit dem Preis, der beim Laden galt (Wunsch Thomas 13.10.2026): je Monat werden kWh und € mit dem jeweils gültigen
  // Strompreis mitgezählt (monthsPriced). Ältere kWh ohne gespeicherten Preis rechnen mit dem aktuellen Preis.
  count(total) {
    if (!Number.isFinite(total)) return;
    const last = this.state.lastTotal;
    if (Number.isFinite(last) && total > last && total - last < 100) {
      const m = monthKey(this.now()), add = total - last, price = settings(this.web).priceEur, p = this.state.monthsPriced[m] || { kWh: 0, eur: 0 };
      this.state.months[m] = kwh((this.state.months[m] || 0) + add);
      this.state.monthsPriced[m] = { kWh: kwh(p.kWh + add), eur: Math.round((p.eur + add * price) * 10000) / 10000 };
    }
    this.state.lastTotal = total;
    const keys = Object.keys(this.state.months).sort(); while (keys.length > LIMITS.months) { const k = keys.shift(); delete this.state.months[k]; delete this.state.monthsPriced[k]; }
  }
  monthCost(m, price) {
    const used = this.state.months[m] || 0, p = this.state.monthsPriced[m];
    if (!p && !(price > 0)) return null;
    return Math.round(((p ? p.eur : 0) + Math.max(0, used - (p ? p.kWh : 0)) * (price || 0)) * 100) / 100;
  }
  async monthEnd() {
    const m = monthKey(this.now());
    if (!this.state.month) { this.state.month = m; return; }
    if (this.state.month === m) return;
    const prev = this.state.month; this.state.month = m;
    const used = this.state.months[prev] || 0, s = settings(this.web);
    const [y, mo] = prev.split('-');
    this.note(`Monatsabschluss ${mo}/${y}: ${de(used)} kWh`);
    const cost = this.monthCost(prev, s.priceEur), avg = cost !== null && used > 0 ? cost / used : null;
    await this.whatsapp(`CCU3 · Jeep Monatsverbrauch ${mo}/${y}\n${de(used)} kWh` + (cost !== null && cost > 0 ? `\nKosten ${de(cost)} € (Ø ${de(avg, 4)} €/kWh)` : ''));
  }
  async off(s, reason) {
    if (this.state.session) this.state.session.reason = reason;
    let r; try { r = await this.switchDevice(this.web, s.socket, false); } catch (e) { this.note('Ausschalten fehlgeschlagen (' + reason + '): ' + (e.status ? e.message : 'Fehler')); return; }
    this.note('Steckdose aus: ' + reason + (r?.confirmed === true ? '' : ' (nicht bestätigt)'));
    // Von der Ladesteuerung ausgeschaltet, Kabel steckt noch → „eingesteckt am Ladeplatz“ erst nach erneutem Einstecken wieder
    if (this.plug() !== false) this.state.plugLatch = true;
  }
  async tick() {
    if (this.busy) return null;
    this.busy = true;
    try {
      const s = settings(this.web), now = this.now();
      await this.monthEnd();
      if (!s.socket) { this.save(); return null; }
      const row = this.socketRow(s), st = row?.currentState || {};
      // Offline: nichts schalten (die Meldung „nicht erreichbar“ macht die Tasmota-Onlineprüfung, tasmota-wache.js)
      if (!row || row.online === false || typeof st.on !== 'boolean') { this.save(); return null; }
      this.count(st.energyTotal);
      const power = Number.isFinite(st.power) ? st.power : null;
      // Einschalten erkannt (auch von Hand, Apple Home oder alte Taste)
      // (bei einem neuen Versuch ohne zweite „Ladung beginnt“-Nachricht; die Zahl der Versuche geht in die neue Ladung mit)
      if (st.on && this.state.prevOn !== true) {
        const retry = this.state.retry; this.state.retry = null;
        this.state.session = { start: now, startTotal: Number.isFinite(st.energyTotal) ? st.energyTotal : null, sawPower: false, lowSince: null, reason: '', tries: retry ? retry.tries : 0, socStart: null, socStartAt: null, socEnd: null, socEndAt: null };
        if (retry) this.note('Neuer Versuch ' + retry.tries + ': Steckdose wieder an');
        else if (this.state.prevOn === false) { this.note('Steckdose an – Ladung beginnt'); await this.whatsapp(`CCU3 · Jeep\n${this.stamp()}\nLadung beginnt.` + (Number.isFinite(st.energyTotal) ? `\nZählerstand ${de(st.energyTotal, 3)} kWh` : '')); }
      }
      if (this.state.session) this.trackSoc(this.state.session);
      await this.finishPending(s, now);
      // Ausschalten erkannt → Ladung abschließen (nicht beim Aus für einen neuen Versuch)
      if (!st.on && this.state.prevOn === true && this.state.session && this.state.retry) this.state.session = null;
      if (!st.on && this.state.prevOn === true && this.state.session) {
        const se = this.state.session, used = Number.isFinite(se.startTotal) && Number.isFinite(st.energyTotal) ? kwh(Math.max(0, st.energyTotal - se.startTotal)) : null;
        const iso = t => Number.isFinite(t) ? new Date(t).toISOString() : null;
        const entry = evaluate({ start: new Date(se.start).toISOString(), end: new Date(now).toISOString(), kWh: used, costEur: used !== null && s.priceEur > 0 ? Math.round(used * s.priceEur * 100) / 100 : null, reason: se.reason || 'von Hand ausgeschaltet',
          socStart: Number.isFinite(se.socStart) ? se.socStart : null, socStartAt: iso(se.socStartAt), socEnd: Number.isFinite(se.socEnd) ? se.socEnd : null, socEndAt: iso(se.socEndAt) }, s.akkuKWh);
        this.state.sessions.push(entry); this.state.sessions = this.state.sessions.slice(-LIMITS.sessions); this.state.session = null;
        this.note('Ladung beendet: ' + (used !== null ? de(used) + ' kWh' : 'Verbrauch unbekannt') + ' – ' + entry.reason);
        // Genau eine WhatsApp, sofort (Tasmota-Werte). Fehlt der frische Akkustand am Ende, nur still in der Liste nachtragen.
        const freshEnd = Number.isFinite(se.socEndAt) && se.socEndAt >= now - SOC_FRESH;
        if (!freshEnd) { entry.socEnd = null; entry.socEndAt = null; evaluate(entry, s.akkuKWh); }
        if (entry.socStart !== null && !freshEnd) this.state.pending = { end: entry.end, until: now + SOC_WAIT };        await this.whatsapp(this.endText(entry));
      }
      this.state.prevOn = st.on;
      // Neuer Versuch fällig: Steckdose nach der Pause wieder an (höchstens 10 min lang, sonst verworfen)
      const rt = this.state.retry;
      if (rt && (!s.enabled || now - rt.since > 600000)) { this.state.retry = null; this.note('Neuer Versuch verworfen'); }
      else if (rt && !st.on && now >= rt.at) {
        try { await this.switchDevice(this.web, s.socket, true); } catch (e) { this.state.retry = null; this.note('Neuer Versuch: Einschalten fehlgeschlagen: ' + (e.status ? e.message : 'Fehler')); await this.whatsapp(`CCU3 · Jeep\n${this.stamp()}\nNeuer Ladeversuch: Steckdose ließ sich nicht einschalten.`); }
      }
      if (s.enabled && s.homeLat !== null && (s.autoOn || s.awayOff || s.faultOn)) await this.geo(s, st, now);
      if (st.on && this.state.session && s.enabled) {
        const se = this.state.session;
        if (power !== null && power >= s.startW) { if (!se.sawPower && se.tries) this.note('Strom fließt nach Versuch ' + se.tries); se.sawPower = true; }
        // Bestätigung vom Jeep (Fahrzeugmeldung neuer als das Einschalten), einmal je Ladung ins Protokoll
        const ch = se.sawPower && !se.jeepSaid ? this.charging() : null;
        if (ch && ch.at > se.start) { se.jeepSaid = ch.status; this.note('Jeep meldet: ' + ch.status + (isFault(ch.status) ? ' (Ladefehler trotz Strom)' : '')); }
        const pct = s.stopAtPercent > 0 ? this.jeepPercent() : null;
        if (pct && pct.at > se.start && pct.value >= s.stopAtPercent) await this.off(s, `Akku ${pct.value} %`);
        else if (!se.sawPower && now - se.start >= waitMs(s, se)) {
          // Kein Strom: neuer Versuch (aus, Pause, wieder an) – nicht, wenn der Akku laut letzter Meldung schon voll ist.
          // Puffer (Wunsch Thomas 13.10.2026): beim neuen Versuch doppelte Wartezeit auf Strom, mindestens 2 Minuten.
          const full = pct && pct.value >= s.stopAtPercent;
          if ((se.tries || 0) < s.retries && !full) {
            const tries = (se.tries || 0) + 1;
            try { await this.switchDevice(this.web, s.socket, false); this.state.retry = { at: now + s.retryWaitSec * 1000, tries, since: now }; this.note(`Kein Strom innerhalb ${s.startTimeoutSec} s – neuer Versuch ${tries} in ${s.retryWaitSec} s`); }
            catch (e) { this.note('Ausschalten für neuen Versuch fehlgeschlagen: ' + (e.status ? e.message : 'Fehler')); }
          // Grund kurz (Wunsch Thomas 13.10.2026: „kein Strom innerhalb 60 s“ raus aus der Meldung)
          } else await this.off(s, (full ? 'Akku voll' : 'kein Strom – Akku voll oder Stecker nicht drin') + (se.tries ? ` (auch nach ${se.tries} neuem Versuch${se.tries > 1 ? 'en' : ''})` : ''));
        }
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
      percent: pct ? { value: pct.value, at: new Date(pct.at).toISOString() } : null, session: this.state.session ? { start: new Date(this.state.session.start).toISOString(), startTotal: this.state.session.startTotal, socStart: this.state.session.socStart ?? null } : null, pending: !!this.state.pending,
      sessions: this.state.sessions.slice().reverse(), months: Object.entries(this.state.months).sort((a, b) => b[0].localeCompare(a[0])).map(([month, v]) => ({ month, kWh: v, costEur: this.monthCost(month, s.priceEur) })), log: this.state.log.slice().reverse() };
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
module.exports = { handle, start, normalize, DEFAULTS, _test: { Laden, laden, evaluate, monthKey, switchAddress, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
