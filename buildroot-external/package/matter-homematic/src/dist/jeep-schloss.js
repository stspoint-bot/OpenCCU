'use strict';
// Dazu „Jeep vorheizen“ als Schalter in Apple Home (klimaEndpoint, unten).
// Jeep-Türen als Schloss in Apple Home (Wunsch Thomas, 12.10.2026: „als Schloss“). Apple Home verlangt bei Schlössern zum
// Entriegeln Face ID/Code; verriegeln geht direkt. Befehle laufen über jeep-fernsteuerung (PIN, 30 s Abstand, Bestätigung
// vom Fahrzeug) – lehnt Uconnect ab, bekommt Apple Home einen Fehler statt eines falschen Zustands.
// Zustand wie py-uconnect: doors.driver/passenger/leftRear/rightRear.status == 'LOCKED' im Fahrzeugstatus.
const LOCKED = 1, UNLOCKED = 2, NOT_FULLY = 0;
const DOORS = ['driver', 'passenger', 'leftRear', 'rightRear'];
// Türstatus wie in der Jeep-App: /remote/status (jeep-cloud remoteStatus) – sparsam (Takt siehe start) und einmal 90 s nach einem
// Tür-Befehl; nur lesen. Ergebnis je Fahrzeug (VIN) im Speicher.
const remote = new Map(); let timer = null, webRef = null, servicesLogged = false;
// Sparen (12.10.2026): Thomas' Jeep liefert keinen Türstatus (v1 leer, v2 404). Nach 3 Läufen ohne Türstatus fragt der
// Zeitgeber nur noch alle 6 h; nach einem Tür-Befehl (soon) und beim Aufruf von Hand wird wie bisher sofort gelesen.
const RARE_MS = 6 * 3600000; let empty = 0, lastRead = 0;
const due = (now = Date.now()) => empty < 3 || now - lastRead >= RARE_MS;
const doorsOf = d => d && typeof d === 'object' ? (d.doors || d.vehicleInfo?.doors || d.remoteStatus?.doors || null) : null;
// Türzustand wie in der Jeep-App (Thomas 12.10.2026: Handy-Seite zeigte nach Neustarts „Zustand unbekannt“): der neueste
// erfolgreiche RDL/RDU aus den Uconnect-Benachrichtigungen – auch Befehle aus der Jeep-App – gilt als bestätigter Zustand.
// Wird bei jedem Lauf gelesen (eine Abfrage); /remote/status nur, wenn fällig (timer) bzw. von Hand/nach einem Befehl.
async function refresh(web = webRef, { timer = false } = {}) {
  const svc = web?.jeepService; if (!svc?.connected || !svc.client) return;
  for (const r of (svc.rows || []).slice(0, 4)) if (typeof r?.vin === 'string' && typeof svc.client.lastDoorCommand === 'function') {
    try { const c = await svc.client.lastDoorCommand(r.vin); if (c) fromCloud(require('./jeep-matter').vehicleId(r.vin), c.lock, c.at); } catch {}
  }
  if (typeof svc.client.remoteStatus !== 'function' || (timer && !due())) return;
  lastRead = Date.now(); let found = false;
  for (const r of (svc.rows || []).slice(0, 4)) {
    if (typeof r?.vin !== 'string') continue;
    // Einmal je Bridge-Start: Dienstliste des Fahrzeugs (nur Dienstnamen und Kennzeichen) – welche Befehle (Licht, WLAN …) es gibt
    if (!servicesLogged) { const list = r?.sources?.vehicle?.data?.services; if (Array.isArray(list)) { servicesLogged = true; console.log('[jeep] Dienste: ' + list.slice(0, 80).map(s => String(s?.service || '?').slice(0, 30) + (s?.vehicleCapable ? '' : '-') + (s?.serviceEnabled ? '' : '!')).join(' ')); } }
    try {
      const data = await svc.client.remoteStatus(r.vin), parts = data && (data.v1 || data.v2) ? [data.v1, data.v2] : [data];
      const doors = parts.map(doorsOf).find(Boolean) || null; if (doors) found = true;
      // Kurzprobe für das Protokoll: Feldnamen bis Tiefe 2 und Textwerte gekürzt (Türstatus ist nicht geheim; keine Kennungen)
      const probe = (o, d = 0) => !o || typeof o !== 'object' ? (typeof o === 'string' ? o.slice(0, 20) : o) : d > 1 ? '{…}' : Object.fromEntries(Object.entries(o).filter(([k]) => !/vin|uid|token|id$|email|lat|lon/i.test(k)).slice(0, 15).map(([k, v]) => [k, probe(v, d + 1)]));
      remote.set(r.vin, { doors, keys: JSON.stringify(parts.map(p => probe(p))).slice(0, 700), at: Date.now() });
    }
    catch (e) { if (!remote.has(r.vin)) remote.set(r.vin, { doors: null, keys: 'Fehler ' + (e.upstreamStatus || e.status || ''), at: Date.now() }); }
  }
  empty = found ? 0 : empty + 1;
}
// Takt 5 min (Wunsch Thomas 13.10.2026, vorher 15 min): liest nur die Befehlsrückmeldungen (RDL/RDU, auch aus der Jeep-App) –
// die leere /remote/status-Abfrage bleibt durch due() bei höchstens alle 6 h
function start(web, every = 300000) { webRef = web; loadConfirmed(); if (timer) return; setTimeout(() => refresh().catch(() => {}), 60000).unref?.(); timer = setInterval(() => refresh(webRef, { timer: true }).catch(() => {}), every); timer.unref?.(); }
function soon(ms = 90000) { setTimeout(() => refresh().catch(() => {}), ms).unref?.(); }
let logged = false;
function state(row) {
  const d = row?.sources?.status?.data, doors = remote.get(row?.vin)?.doors || doorsOf(row?.details?.sources?.remote?.data) || doorsOf(d);
  if (!doors || typeof doors !== 'object') {
    // Einmal je Bridge-Start: welche Felder der Fahrzeugstatus hat (nur Namen, keine Werte) – zur Suche nach dem Türstatus
    if (!logged && row && remote.has(row.vin)) { logged = true; const keys = o => o && typeof o === 'object' ? Object.keys(o).slice(0, 40).join(',') : String(typeof o); console.log('[jeep-schloss] kein Türstatus; remote/status: ' + (remote.get(row.vin)?.keys ?? 'noch nicht gelesen') + ' | Quellen: ' + keys(row.sources) + ' | status: ' + keys(d) + (d?.vehicleInfo ? ' | vehicleInfo: ' + keys(d.vehicleInfo) : '')); }
    return null;
  }
  const st = DOORS.map(k => doors[k]?.status).filter(s => typeof s === 'string');
  if (!st.length) return null;
  if (st.every(s => s === 'LOCKED')) return LOCKED;
  if (st.every(s => s === 'UNLOCKED')) return UNLOCKED;
  return NOT_FULLY;
}
const text = v => v === LOCKED ? 'verriegelt' : v === UNLOCKED ? 'entriegelt' : v === NOT_FULLY ? 'nicht ganz verriegelt' : null;
// Das Fahrzeug meldet seinen Türstatus erst Minuten später an die Cloud. Bis dahin (höchstens 3 Minuten) gilt der
// befohlene Zustand – sonst springt Apple Home nach „Verriegeln“ sofort auf den alten Stand zurück (Thomas, 12.10.2026).
const held = new Map(), HOLD_MS = 180000, lastCmd = new Map();
function hold(id, value, now = Date.now()) { held.set(id, { value, until: now + HOLD_MS }); lastCmd.set(id, { value, at: now }); }
// Liefert die Cloud keinen Türstatus: ehrlich den letzten Befehl zeigen („zuletzt abgeschlossen 19:20“) statt „unbekannt“.
const hhmm = t => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
function guess(id, value, now = Date.now()) { const c = lastCmd.get(id); if ((value === null || value === undefined) && (c?.ok || c?.failed)) return c.value; const v = shown(id, value, now); return v !== null && v !== undefined ? v : c?.value ?? null; }
// Bestätigung vom Fahrzeug (12.10.2026: Uconnect liefert für Thomas' Jeep keinen Türstatus – v1 leer, v2 404 –, bestätigt
// aber jeden Tür-Befehl nach 6–10 s; so kennt auch die Jeep-App den Zustand). Bestätigt → gilt bis zum nächsten Befehl.
// Gemerkt in jeep-tuer.json (nur bestätigter Zustand und Zeit), damit er einen Bridge-Neustart übersteht.
const fileOf = () => webRef?.deps?.configPath ? require('node:path').join(require('node:path').dirname(webRef.deps.configPath), 'jeep-tuer.json') : null;
function confirmed(id, lock, state, now = Date.now()) {
  const value = lock ? LOCKED : UNLOCKED;
  if (state === 'confirmed') { lastCmd.set(id, { value, at: now, ok: true }); held.delete(id); }
  else if (state === 'failed') { lastCmd.set(id, { value: lock ? UNLOCKED : LOCKED, at: now, failed: true }); held.delete(id); }
  else return;
  saveConfirmed();
}
function saveConfirmed() { const f = fileOf(); if (f) try { const fs = require('node:fs'); fs.writeFileSync(f + '.tmp', JSON.stringify(Object.fromEntries([...lastCmd].filter(([, c]) => c.ok || c.failed))), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); } catch {} }
// Zustand aus den Benachrichtigungen: nur übernehmen, wenn neuer als der bekannte (ein gerade gesendeter Befehl gewinnt)
function fromCloud(id, lock, at) { const old = lastCmd.get(id); if (old && old.at >= at) return false; lastCmd.set(id, { value: lock ? LOCKED : UNLOCKED, at, ok: true }); held.delete(id); saveConfirmed(); return true; }
function loadConfirmed() { const f = fileOf(); if (!f) return; try { const d = JSON.parse(require('node:fs').readFileSync(f, 'utf8')); for (const [id, c] of Object.entries(d || {})) if (/^[a-f0-9]{24}$/.test(id) && [LOCKED, UNLOCKED].includes(c?.value) && Number.isFinite(c?.at) && !lastCmd.has(id)) lastCmd.set(id, { value: c.value, at: c.at, ok: c.ok === true, failed: c.failed === true }); } catch {} }
function label(id, value, now = Date.now()) {
  const c = lastCmd.get(id);
  if (value === null || value === undefined) {
    if (c?.ok) return text(c.value) + ' (bestätigt ' + hhmm(c.at) + ')';
    if (c?.failed) return 'Befehl nicht ausgeführt (' + hhmm(c.at) + ')';
  }
  const v = shown(id, value, now); if (v !== null && v !== undefined) return text(v);
  return c ? 'zuletzt ' + (c.value === LOCKED ? 'abgeschlossen' : 'aufgeschlossen') + ' ' + hhmm(c.at) : null;
}
function release(id) { held.delete(id); }
function shown(id, value, now = Date.now()) {
  const h = held.get(id); if (!h) return value;
  if (now > h.until || value === h.value) { held.delete(id); return value; }
  return h.value;
}
async function command(id, lock) { return require('./jeep-fernsteuerung').fromMatter(id, lock); }
// Apple Home wartet nicht lange: Lehnt Uconnect innerhalb von 9 s ab → Fehler an Apple Home; dauert es länger,
// läuft der Befehl weiter, Apple Home bekommt den befohlenen Zustand (bei späterer Ablehnung wird er wieder freigegeben).
async function send(id, lock, wait = 9000) {
  const run = command(id, lock).then(r => { console.log('[jeep-schloss] ' + (lock ? 'Verriegeln' : 'Entriegeln') + ' aus Apple Home: ' + (r?.message || 'angenommen')); return r; },
    e => { release(id); console.log('[jeep-schloss] ' + (lock ? 'Verriegeln' : 'Entriegeln') + ' aus Apple Home abgelehnt: ' + (e?.message || 'Fehler')); throw e; });
  let timer; const late = new Promise(ok => { timer = setTimeout(() => ok('spaet'), wait); timer.unref?.(); });
  try { if (await Promise.race([run, late]) === 'spaet') run.catch(() => {}); } finally { clearTimeout(timer); }
  hold(id, lock ? LOCKED : UNLOCKED);
}
function endpoint(matter, id, basic) {
  const { Endpoint, MutableEndpoint, behaviors } = matter;
  class JeepLock extends behaviors.DoorLockServer {
    // Erst wenn Uconnect den Befehl angenommen hat (oder nach 9 s noch arbeitet), zeigt Apple Home den neuen Zustand; Ablehnung → Fehler (nie wiederholt).
    async lockDoor() { await send(id, true); this.state.lockState = LOCKED; }
    async unlockDoor() { await send(id, false); this.state.lockState = UNLOCKED; }
  }
  const type = MutableEndpoint({ name: 'JeepDoorLock', deviceType: 0x000a, deviceRevision: 3, behaviors: { identify: behaviors.IdentifyServer, doorLock: JeepLock, bridgedDeviceBasicInformation: behaviors.BridgedDeviceBasicInformationServer } });
  return new Endpoint(type, { id: 'jeep-' + id + '-lock-v1', bridgedDeviceBasicInformation: { ...basic, nodeLabel: 'Jeep Türen', productName: 'Jeep Türschloss' }, doorLock: { lockState: null, lockType: 0, actuatorEnabled: true, operatingMode: 0 } });
}
// Zuletzt vom Fahrzeug bestätigter Tür-Befehl (für das Nachtschloss in jeep-wache.js): { value, at, ok } oder null
function lastConfirmed(id) { const c = lastCmd.get(id); return c && c.ok ? { value: c.value, at: c.at } : null; }

// ---------- „Jeep vorheizen“ als Schalter in Apple Home (Wunsch Thomas, 12.10.2026: per Siri vorheizen) ----------
// Ein = „Klima sofort“ (kurzzeitiger Klimaplan, jeep-fernsteuerung klimaPlan), Aus = Plan zurücksetzen. Gleicher Schutz wie von
// Hand (PIN-Sperre, 20 s Abstand, aktive Pläne werden nie angefasst). Lehnt Uconnect ab → Fehler an Apple Home, Schalter bleibt.
// Angezeigt wird „an“, solange „Klima sofort“ für das Fahrzeug bis zur Abfahrt läuft (jeep-matter.js update).
async function klimaSend(id, on, wait = 9000) {
  const run = require('./jeep-fernsteuerung').fromMatterKlima(id, on).then(r => { console.log('[jeep-vorheizen] ' + (on ? 'Ein' : 'Aus') + ' aus Apple Home: ' + (r?.message || 'angenommen')); return r; },
    e => { console.log('[jeep-vorheizen] ' + (on ? 'Ein' : 'Aus') + ' aus Apple Home abgelehnt: ' + (e?.message || 'Fehler')); throw e; });
  let timer; const late = new Promise(ok => { timer = setTimeout(() => ok('spaet'), wait); timer.unref?.(); });
  try { if (await Promise.race([run, late]) === 'spaet') run.catch(() => {}); } finally { clearTimeout(timer); }
}
function klimaEndpoint(matter, id, basic) {
  const { Endpoint, MutableEndpoint, behaviors } = matter;
  class VorheizenOnOff extends behaviors.OnOffServer {
    async on() { await klimaSend(id, true); this.state.onOff = true; }
    async off() { await klimaSend(id, false); this.state.onOff = false; }
    async toggle() { const on = this.state.onOff !== true; await klimaSend(id, on); this.state.onOff = on; }
  }
  const type = MutableEndpoint({ name: 'JeepVorheizen', deviceType: 0x010a, deviceRevision: 3, behaviors: { identify: behaviors.IdentifyServer, groups: behaviors.GroupsServer, scenesManagement: behaviors.ScenesManagementServer, onOff: VorheizenOnOff, bridgedDeviceBasicInformation: behaviors.BridgedDeviceBasicInformationServer } });
  return new Endpoint(type, { id: 'jeep-' + id + '-vorheizen-v1', bridgedDeviceBasicInformation: { ...basic, nodeLabel: 'Jeep vorheizen', productName: 'Jeep Klima sofort' }, onOff: { onOff: false } });
}
function klimaState(id) { try { return require('./jeep-fernsteuerung').sofortAktiv(id); } catch { return null; } }
module.exports = { state, text, label, guess, confirmed, endpoint, klimaEndpoint, klimaState, lastConfirmed, shown, hold, release, send, start, soon, refresh, LOCKED, UNLOCKED, NOT_FULLY, _test: { remote, due, fromCloud, lastCmd, reset: () => { empty = 0; lastRead = 0; } } };
