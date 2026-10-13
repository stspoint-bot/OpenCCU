'use strict';
// Geräteverwaltung (Wunsch Thomas, 12.10.2026): Übersicht wie in der OpenCCU unter „Einstellungen → Geräte“ –
// Name, Typ, Seriennummer, Interface, Kategorie, Übertragungsmodus, Gewerk, Raum, Firmware, Funkempfang, Batterie,
// Status und die Kanäle. Nur lesen: ReGa (Namen, Räume, Gewerke) und Gerätebeschreibungen der Funkdienste
// (Firmware), Werte des Wartungskanals aus der laufenden Bridge. Es wird nichts gefunkt und nichts geändert.
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const TTL = 60000, LIMIT = { devices: 500, channels: 60 };
// ReGa: Variablen nur einmal anlegen; Ausgabe zeilenweise mit Tabulator (D = Gerät, C = Kanal, R = Raum, F = Gewerk).
const SCRIPT = '! MH_GERAETE\nstring did;string cid;string rid;object d;object c;object r;object i;string t="\\t";' +
  'foreach(did,dom.GetObject(ID_DEVICES).EnumUsedIDs()){d=dom.GetObject(did);if(d){i=dom.GetObject(d.Interface());Write("D"#t#d.Address()#t#d.Name().UriEncode()#t#d.HssType()#t#i.Name()#t#d.ReadyConfig()#"\\n");' +
  'foreach(cid,d.Channels().EnumUsedIDs()){c=dom.GetObject(cid);if(c){Write("C"#t#c.Address()#t#c.Name().UriEncode()#t#c.ChnDirection()#t#c.ChnAESActive()#t#c.Visible()#"\\n");}}}}' +
  'foreach(rid,dom.GetObject(ID_ROOMS).EnumUsedIDs()){r=dom.GetObject(rid);if(r){foreach(cid,r.EnumUsedIDs()){c=dom.GetObject(cid);if(c){Write("R"#t#r.Name().UriEncode()#t#c.Address()#"\\n");}}}}' +
  'foreach(rid,dom.GetObject(ID_FUNCTIONS).EnumUsedIDs()){r=dom.GetObject(rid);if(r){foreach(cid,r.EnumUsedIDs()){c=dom.GetObject(cid);if(c){Write("F"#t#r.Name().UriEncode()#t#c.Address()#"\\n");}}}}';
const ADDRESS = /^[A-Za-z0-9_-]{1,64}(:\d{1,3})?$/;
const decode = s => String(s).replace(/%([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
const text = (s, max = 120) => (typeof s === 'string' ? s : '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
const DIRECTION = { 0: '', 1: 'Sender', 2: 'Empfänger' };
const FW_STATE = { UP_TO_DATE: 'aktuell', NEW_FIRMWARE_AVAILABLE: 'neue Firmware verfügbar', DELIVER_FIRMWARE_IMAGE: 'wird übertragen', READY_FOR_UPDATE: 'bereit zum Einspielen', DO_UPDATE_PENDING: 'Update angefordert', PERFORMING_UPDATE: 'wird eingespielt', LIVE_NEW_FIRMWARE_AVAILABLE: 'neue Firmware verfügbar', LIVE_DELIVER_FIRMWARE_IMAGE: 'wird übertragen', LIVE_READY_FOR_UPDATE: 'bereit zum Einspielen', LIVE_PERFORMING_UPDATE: 'wird eingespielt' };
// Empfangsart der Gerätebeschreibung (RX_MODE, Bitmaske)
function rxMode(v) {
  if (!Number.isInteger(v)) return '';
  if (v & 1) return 'Netzbetrieb (immer empfangsbereit)';
  if (v & 2) return 'Batterie (Burst)';
  if (v & 8) return 'Batterie (wacht auf)';
  return 'Batterie';
}
function parse(out) {
  const devices = new Map(), channels = new Map(), rooms = new Map(), functions = new Map();
  const add = (map, address, name) => { const list = map.get(address) || []; if (!list.includes(name)) list.push(name); map.set(address, list); };
  for (const line of String(out).replace(/<xml>[\s\S]*$/, '').split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'D' && f.length >= 6 && ADDRESS.test(f[1]) && devices.size < LIMIT.devices) devices.set(f[1], { address: f[1], name: text(decode(f[2])), type: text(f[3], 40), interface: text(f[4], 30), ready: f[5] === 'true' });
    else if (f[0] === 'C' && f.length >= 6 && ADDRESS.test(f[1])) channels.set(f[1], { address: f[1], name: text(decode(f[2])), direction: DIRECTION[f[3]] ?? '', aes: f[4] === 'true', visible: f[5] !== 'false' });
    else if (f[0] === 'R' && f.length >= 3 && ADDRESS.test(f[2])) add(rooms, f[2], text(decode(f[1]), 60));
    else if (f[0] === 'F' && f.length >= 3 && ADDRESS.test(f[2])) add(functions, f[2], text(decode(f[1]), 60));
  }
  return { devices, channels, rooms, functions };
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Error('Zeitüberschreitung')), ms))]);
async function read(web) {
  const connector = web.deps.getConnector?.();
  if (!connector || typeof connector.regaScript !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503);
  let data; try { data = parse(await timeout(connector.regaScript(SCRIPT, 8181), 20000)); } catch { throw fail('Geräteliste der CCU nicht lesbar', 502); }
  const live = connector.getChannels?.() || new Map();
  let icons = {}; try { icons = require('./geraete-bilder').icons(web) || {}; } catch {}
  let exposed = new Set(); try { exposed = new Set((web.getDevices?.().devices || []).filter(r => r.exposed).map(r => String(r.address).split(':')[0])); } catch {}
  // Räume aus der eigenen Raumliste der Bridge (die CCU-Räume sind abgelöst)
  try { const s = require('./raeume').current(web); if (!s) throw 0; const nm = new Map(s.rooms.map(r => [r.id, r.name])); data.rooms = new Map(Object.entries(s.assign).filter(([, id]) => nm.has(id)).map(([a, id]) => [a, [nm.get(id)]])); } catch {}
  const out = [], own = ownNames(web), gw = ownGewerk(web);
  for (const d of data.devices.values()) {
    // Eigener Gerätename (Geräteverwaltung): ersetzt den CCU-Namen; Kanäle heißen „Name:Kanal“.
    if (own[d.address]) { d.name = own[d.address]; for (const c of data.channels.values()) if (c.address.startsWith(d.address + ':')) c.name = own[d.address] + ':' + c.address.split(':')[1]; }
    // Gerätebeschreibung des Funkdienstes (Firmware, Empfangsart) – lokal, ohne Funk
    let desc = null;
    if (['HmIP-RF', 'BidCos-RF', 'BidCos-Wired', 'VirtualDevices'].includes(d.interface) && typeof connector.rpcCall === 'function') {
      try { desc = await timeout(connector.rpcCall(d.interface, 'getDeviceDescription', [d.address]), 5000); } catch {}
    }
    const values = live.get(d.address + ':0')?.paramsets?.VALUES || {};
    const num = k => typeof values[k] === 'number' && Number.isFinite(values[k]) ? values[k] : null;
    const bool = k => values[k] === true || values[k] === 1;
    const chs = [...data.channels.values()].filter(c => c.address.startsWith(d.address + ':'))
      .sort((a, b) => Number(a.address.split(':')[1]) - Number(b.address.split(':')[1])).slice(0, LIMIT.channels)
      .map(c => ({ ...c, type: text(live.get(c.address)?.type || '', 40), rooms: data.rooms.get(c.address) || [], functions: data.functions.get(c.address) || [] }));
    const all = k => [...new Set(chs.flatMap(c => c[k]))];
    const dirs = new Set(chs.map(c => c.direction).filter(Boolean));
    const fw = text(desc?.FIRMWARE, 20), avail = text(desc?.AVAILABLE_FIRMWARE, 20);
    out.push({
      address: d.address, name: d.name, type: d.type, interface: d.interface, ready: d.ready,
      icon: icons[d.address] || null,
      category: dirs.size === 2 ? 'Sender und Empfänger' : [...dirs][0] || '',
      transmission: chs.some(c => c.aes) ? (d.interface === 'HmIP-RF' ? 'Gesichert (immer verschlüsselt)' : 'Gesichert (AES)') : 'Standard',
      rooms: all('rooms'), functions: gw[d.address] ? [gw[d.address]] : all('functions'), central: CENTRAL.test(d.type) || /^(BidCoS-RF|HmIP-RCV-\d+)$/i.test(d.address),
      firmware: fw, firmwareUpdate: avail && fw && avail !== fw && avail !== '0.0.0' ? avail : '',
      firmwareState: FW_STATE[desc?.FIRMWARE_UPDATE_STATE] || '',
      power: rxMode(desc?.RX_MODE),
      rssi: num('RSSI_DEVICE'), rssiPeer: num('RSSI_PEER'), voltage: num('OPERATING_VOLTAGE'),
      lowBat: bool('LOW_BAT') || bool('LOWBAT'), unreach: bool('UNREACH'), configPending: bool('CONFIG_PENDING'), dutyCycle: bool('DUTY_CYCLE'), sabotage: bool('SABOTAGE'),
      inAppleHome: exposed.has(d.address),
      channels: chs
    });
  }
  out.sort((a, b) => (a.rooms[0] || '~').localeCompare(b.rooms[0] || '~', 'de') || a.name.localeCompare(b.name, 'de'));
  let roomNames = []; try { roomNames = (require('./raeume').current(web)?.rooms || []).map(r => r.name); } catch {}
  const gewerke = gewerkListe(web);
  return { devices: out, raeume: roomNames, gewerke, gewerkJe: gw, readAt: new Date().toISOString() };
}
// ---- Firmware-Update (ausdrücklicher Wunsch Thomas): nur für Geräte, nie für die Zentrale; nur Administratoren,
// nur auf Klick mit Schieberegler-Rückfrage in der Oberfläche; kein automatisches oder wiederholtes Auslösen.
const CENTRAL = /^(HmIP-CCU3|HmIP-RCV-50|HM-RCV-50|CCU\d?|HM-CCU|RPI-RF-MOD|HmIP-RFUSB)$/i;
const fwStarted = new Map(); // Gerät → Zeitpunkt (verhindert Doppelklicks: 10 Minuten Sperre)
async function firmwareUpdate(web, req) {
  const p = await require('./web-security').body(req);
  if (!p || typeof p !== 'object' || Object.keys(p).length !== 1 || typeof p.address !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.address)) throw fail('Gerät ungültig');
  if (/^(BidCoS-RF|HmIP-RCV-\d+)$/i.test(p.address)) throw fail('Die Zentrale selbst wird hier nicht aktualisiert');
  if (Date.now() - (fwStarted.get(p.address) || 0) < 600000) throw fail('Für dieses Gerät wurde das Update gerade erst gestartet – bitte abwarten', 409);
  const connector = web.deps.getConnector?.(); if (!connector?.rpcCall) throw fail('CCU-Verbindung nicht verfügbar', 503);
  let iface = null, desc = null;
  for (const i of ['HmIP-RF', 'BidCos-RF']) { try { const d = await timeout(connector.rpcCall(i, 'getDeviceDescription', [p.address]), 5000); if (d && d.ADDRESS === p.address) { iface = i; desc = d; break; } } catch {} }
  if (!desc) throw fail('Gerät nicht gefunden', 404);
  if (CENTRAL.test(String(desc.TYPE || ''))) throw fail('Die Zentrale selbst wird hier nicht aktualisiert');
  const fw = String(desc.FIRMWARE || ''), avail = String(desc.AVAILABLE_FIRMWARE || '');
  if (!avail || avail === fw || avail === '0.0.0') throw fail('Für dieses Gerät liegt keine neue Firmware vor', 409);
  fwStarted.set(p.address, Date.now());
  let ok;
  try { ok = await timeout(connector.rpcCall(iface, iface === 'HmIP-RF' ? 'installFirmware' : 'updateFirmware', [p.address]), 60000); }
  catch (e) { throw fail('Update nicht gestartet: ' + String(e.message || 'Fehler').slice(0, 120), 502); }
  cache = { at: 0, value: null, pending: null };
  if (!(ok === true || (Array.isArray(ok) && ok.length && ok.every(x => x === true)))) { fwStarted.delete(p.address); throw fail('Die Zentrale hat das Update nicht angenommen. Batteriegeräte vorher kurz wecken (Taste drücken) und erneut versuchen.', 502); }
  return { success: true, message: 'Firmware-Update ' + fw + ' → ' + avail + ' gestartet. Das kann einige Minuten dauern; das Gerät ist währenddessen nicht bedienbar. Nicht stromlos machen.' };
}
// ---- Raum und Gewerk je Gerät (eigene Einstellung der Bridge) ----
const GEWERKE = ['Licht', 'Heizung', 'Klima', 'Beschattung', 'Sicherheit', 'Verschluss', 'Energie', 'Wetter', 'Bewässerung', 'Unterhaltung', 'Sonstiges'];
// Gewerke-Liste (Wunsch Thomas): eigene, bearbeitbare Liste in der Bridge-Einstellung; ohne Liste die Grundauswahl.
function gewerkListe(web) { let c; try { c = web.security.configSnapshot.read().gewerkeListe; } catch {} return Array.isArray(c) ? c.filter(x => typeof x === 'string' && x.trim()).slice(0, 100) : [...GEWERKE]; }
const GEWERK_NAME = s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 40 && !/[\x00-\x1f\x7f]/.test(s);
async function changeGewerke(web, req) {
  const p = await require('./web-security').body(req);
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['action', 'name', 'newName'].includes(k)) || !['add', 'rename', 'delete'].includes(p.action) || !GEWERK_NAME(p.name)) throw fail('Ungültige Angabe');
  const name = p.name.trim(), list = gewerkListe(web);
  if (p.action === 'add') { if (list.includes(name)) throw fail('Gewerk gibt es schon'); if (list.length >= 100) throw fail('Höchstens 100 Gewerke'); list.push(name); web.writeConfigPatch(c => { c.gewerkeListe = list; }); }
  else if (!list.includes(name)) throw fail('Gewerk nicht gefunden', 404);
  else if (p.action === 'rename') {
    if (!GEWERK_NAME(p.newName)) throw fail('Neuer Name: 1 bis 40 Zeichen'); const nn = p.newName.trim(); if (nn !== name && list.includes(nn)) throw fail('Gewerk gibt es schon');
    web.writeConfigPatch(c => { c.gewerkeListe = list.map(x => x === name ? nn : x); c.geraeteGewerk = Object.fromEntries(Object.entries(c.geraeteGewerk || {}).map(([a, g]) => [a, g === name ? nn : g])); });
  } else web.writeConfigPatch(c => { c.gewerkeListe = list.filter(x => x !== name); c.geraeteGewerk = Object.fromEntries(Object.entries(c.geraeteGewerk || {}).filter(([, g]) => g !== name)); });
  cache = { at: 0, value: null, pending: null };
  return gewerkeStatus(web);
}
function gewerkeStatus(web) { const gw = ownGewerk(web), list = gewerkListe(web); return { liste: list.map(n => ({ name: n, geraete: Object.values(gw).filter(g => g === n).length })) }; }
function ownGewerk(web) { let c; try { c = web.security.configSnapshot.read().geraeteGewerk; } catch {} return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
async function setRaumGewerk(web, req) {
  const p = await require('./web-security').body(req);
  const extra = typeof p?.address === 'string' && /^(tasmota|smartplus|smartlife|dyson|jeep)@[A-Za-z0-9_.:-]{1,80}$/.test(p.address);
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['address', 'room', 'gewerk'].includes(k)) || typeof p.address !== 'string' || !(extra || /^[A-Za-z0-9_-]{1,64}$/.test(p.address))) throw fail('Gerät ungültig');
  const connector = web.deps.getConnector?.();
  if (p.room !== undefined) {
    if (typeof p.room !== 'string') throw fail('Raum ungültig');
    const R = require('./raeume'); R.attach(web);
    // Integrationen (WLAN/Tasmota/Dyson/Jeep): ein Eintrag; CCU-Geräte: alle Kanäle außer dem Wartungskanal
    const chans = extra ? [p.address] : [...(connector?.getChannels?.() || new Map()).keys()].filter(a => a.startsWith(p.address + ':') && !a.endsWith(':0'));
    if (!chans.length) throw fail('Gerät nicht gefunden', 404);
    for (const a of chans) await R.change(connector, 'setDeviceRoom', { address: a, room: p.room });
    try { await R.applyNow(); } catch {}
  }
  if (p.gewerk !== undefined) {
    if (typeof p.gewerk !== 'string' || p.gewerk.length > 40 || /[\x00-\x1f\x7f]/.test(p.gewerk)) throw fail('Gewerk ungültig');
    web.writeConfigPatch(c => { c.geraeteGewerk = { ...(c.geraeteGewerk || {}) }; if (p.gewerk.trim()) c.geraeteGewerk[p.address] = p.gewerk.trim(); else delete c.geraeteGewerk[p.address]; });
  }
  cache = { at: 0, value: null, pending: null };
  return { success: true };
}
// Aktueller Wert je Kanal (der wichtigste Messwert/Zustand), frisch aus der Bridge – ohne Funkverkehr.
const PRIMARY = ['STATE', 'LEVEL', 'ACTUAL_TEMPERATURE', 'HUMIDITY', 'MOTION', 'PRESENCE_DETECTION_STATE', 'ILLUMINATION', 'CURRENT_ILLUMINATION', 'POWER', 'ENERGY_COUNTER', 'SET_POINT_TEMPERATURE', 'WINDOW_STATE', 'LOCK_STATE', 'SMOKE_DETECTOR_ALARM_STATUS', 'WATERLEVEL_DETECTED', 'OPERATING_VOLTAGE'];
function withValues(web, result) {
  const live = web.deps.getConnector?.()?.getChannels?.() || new Map();
  for (const d of result.devices) {
    d.value = null;
    for (const c of d.channels) {
      const v = live.get(c.address)?.paramsets?.VALUES || {}, k = PRIMARY.find(x => typeof v[x] === 'number' || typeof v[x] === 'boolean');
      c.value = k && !(c.address.endsWith(':0') && k !== 'OPERATING_VOLTAGE') ? { key: k, value: v[k] } : null;
      if (!d.value && c.value && !c.address.endsWith(':0')) d.value = { ...c.value, channel: c.address };
    }
  }
  return result;
}
function ownNames(web) { let c; try { c = web.security.configSnapshot.read().geraeteNamen; } catch {} return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
async function setName(web, req) {
  const p = await require('./web-security').body(req);
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['address', 'name'].includes(k)) || typeof p.address !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.address)) throw fail('Gerät ungültig');
  if (typeof p.name !== 'string' || p.name.trim().length > 64 || /[\x00-\x1f\x7f]/.test(p.name)) throw fail('Name: höchstens 64 Zeichen');
  const name = p.name.trim();
  web.writeConfigPatch(c => { c.geraeteNamen = { ...(c.geraeteNamen || {}) }; if (name) c.geraeteNamen[p.address] = name; else delete c.geraeteNamen[p.address]; });
  cache = { at: 0, value: null, pending: null };
  return { success: true, name };
}
let cache = { at: 0, value: null, pending: null };
function list(web, fresh) {
  if (cache.pending) return cache.pending;
  if (!fresh && cache.value && Date.now() - cache.at < TTL) return Promise.resolve(cache.value);
  cache.pending = read(web).then(v => { cache = { at: Date.now(), value: v, pending: null }; return v; }, e => { cache.pending = null; throw e; });
  return cache.pending;
}
// ---- Live-Ansicht eines Geräts: aktuelle Werte der Kanäle und die letzten Tastendrücke ----
// Hört nur mit (Meldungen, die die Bridge ohnehin bekommt); es wird nichts gesendet. Höchstens 2000 Einträge im Speicher.
const recent = new Map(); let heard = null, hearer = null;
function listen(connector) {
  if (heard === connector || !connector || typeof connector.on !== 'function') return;
  if (heard && hearer) { try { heard.off('deviceEvent', hearer); } catch {} }
  heard = connector; hearer = e => {
    if (!e || typeof e.address !== 'string' || typeof e.key !== 'string' || !ADDRESS.test(e.address) || e.key.length > 40) return;
    const k = e.address + '|' + e.key; recent.delete(k); recent.set(k, { value: e.value, at: Date.now() });
    if (recent.size > 2000) recent.delete(recent.keys().next().value);
  };
  connector.on('deviceEvent', hearer);
}
const plain = v => typeof v === 'number' || typeof v === 'boolean' ? v : typeof v === 'string' ? text(v, 40) : null;
function live(web, device) {
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(device)) throw fail('Gerät ungültig');
  const connector = web.deps.getConnector?.(); if (!connector) throw fail('CCU-Verbindung nicht verfügbar', 503);
  listen(connector);
  const channels = [];
  for (const [address, c] of connector.getChannels?.() || new Map()) {
    if (!address.startsWith(device + ':')) continue;
    const values = {}, events = {};
    for (const [k, v] of Object.entries(c?.paramsets?.VALUES || {}).slice(0, 40)) { const p = plain(v); if (p !== null) values[k] = p; }
    for (const k of ['PRESS_SHORT', 'PRESS_LONG', 'PRESS_LONG_RELEASE', 'PRESS_LONG_START', 'MOTION', 'STATE']) { const r = recent.get(address + '|' + k); if (r) events[k] = { value: plain(r.value), at: new Date(r.at).toISOString() }; }
    channels.push({ address, type: text(c?.type || '', 40), name: text(c?.name || '', 80), key: Object.hasOwn(values, 'PRESS_SHORT') || /KEY|BUTTON|TRANSMITTER/.test(c?.type || ''), values, events });
  }
  if (!channels.length) throw fail('Gerät nicht gefunden', 404);
  channels.sort((a, b) => Number(a.address.split(':')[1]) - Number(b.address.split(':')[1]));
  return { device, channels, now: new Date().toISOString() };
}
async function handle(web, req, res, u, auth) {
  if (u.pathname !== '/api/') return false;
  // Grüner Punkt in der Geräteverwaltung: welche Geräte in den letzten 30 Sekunden betätigt wurden (Taste, Schalten, Dimmen).
  if (u.searchParams.get('method') === 'getGewerke') {
    if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
    if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
    web.sendJson(res, 200, gewerkeStatus(web)); return true;
  }
  for (const [m, fn] of [['startFirmwareUpdate', firmwareUpdate], ['setGeraetRaumGewerk', setRaumGewerk], ['saveGewerke', changeGewerke]]) {
    if (u.searchParams.get('method') !== m) continue;
    if (!auth || auth.session?.localBypass) { web.sendJson(res, 403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (req.method !== 'POST') { web.sendJson(res, 405, { error: 'POST erforderlich' }); return true; }
    try { web.sendJson(res, 200, await fn(web, req)); } catch (e) { web.sendJson(res, e.status || 500, { error: e.status ? e.message : 'Anfrage fehlgeschlagen' }); }
    return true;
  }
  if (u.searchParams.get('method') === 'setGeraetName') {
    if (!auth || auth.session?.localBypass) { web.sendJson(res, 403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (req.method !== 'POST') { web.sendJson(res, 405, { error: 'POST erforderlich' }); return true; }
    try { web.sendJson(res, 200, await setName(web, req)); } catch (e) { web.sendJson(res, e.status || 500, { error: e.status ? e.message : 'Name nicht gespeichert' }); }
    return true;
  }
  if (u.searchParams.get('method') === 'getGeraeteAktivitaet') {
    if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
    if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
    try { listen(web.deps.getConnector?.()); } catch {}
    const since = Date.now() - 30000, active = {}, pressed = {};
    for (const [k, r] of recent) { if (r.at < since) continue; const [address, key] = k.split('|'); if (!/^(PRESS_|STATE$|LEVEL$)/.test(key)) continue; const dev = address.split(':')[0]; if (!active[dev] || active[dev] < r.at) active[dev] = r.at; if (/^PRESS_/.test(key) && (!pressed[address] || pressed[address] < r.at)) pressed[address] = r.at; }
    // pressed: welche Taste (Kanal) zuletzt gedrückt wurde – für „Taste drücken“ im Verknüpfungs-Assistenten
    const iso = o => Object.fromEntries(Object.entries(o).map(([d, t]) => [d, new Date(t).toISOString()]));
    web.sendJson(res, 200, { now: new Date().toISOString(), active: iso(active), pressed: iso(pressed) });
    return true;
  }
  if (u.searchParams.get('method') === 'getGeraetLive') {
    if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
    if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
    try { web.sendJson(res, 200, live(web, u.searchParams.get('geraet'))); } catch (e) { web.sendJson(res, e.status || 500, { error: e.status ? e.message : 'Live-Werte nicht lesbar' }); }
    return true;
  }
  if (u.searchParams.get('method') !== 'getGeraeteVerwaltung') return false;
  if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
  if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
  try { listen(web.deps.getConnector?.()); } catch {}
  try { web.sendJson(res, 200, withValues(web, await list(web, u.searchParams.get('neu') === '1'))); } catch (e) { web.sendJson(res, e.status || 502, { error: e.status ? e.message : 'Geräteliste nicht lesbar' }); }
  return true;
}
module.exports = { handle, _test: { parse, read, rxMode, live, SCRIPT, reset: () => { cache = { at: 0, value: null, pending: null }; recent.clear(); heard = null; hearer = null; } } };
