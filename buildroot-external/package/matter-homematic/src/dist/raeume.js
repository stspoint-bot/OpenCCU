'use strict';
// Eigene Räume (Wunsch Thomas, 12.10.2026): Räume und Zuordnungen liegen in der Bridge-Einstellung (config.raeume),
// nicht mehr in der CCU (ReGa). Beim ersten Bedarf werden die Räume einmalig aus der CCU übernommen; danach wird die
// CCU für Räume weder gelesen noch beschrieben – die Räume dort können gelöscht werden.
// Räume gelten für alle Geräte der Geräteseite: CCU-Kanäle und WLAN-/Tasmota-/Dyson-/Jeep-Einträge.
// Apple Home ist nicht betroffen (Matter-Kennung hängt nur an der Geräteadresse).
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const decode = s => String(s).replace(/%([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
const ADDRESS = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$|^(tasmota|smartplus|smartlife|dyson|jeep)@[A-Za-z0-9_.:-]{1,80}$/;
const LIMITS = Object.freeze({ rooms: 100, assign: 3000, name: 64 });
let web = null, timer = null, importing = null;

function validName(s) {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > LIMITS.name || /[\x00-\x1f\x7f]/.test(s) || ['__proto__', 'prototype', 'constructor'].includes(s.trim())) throw fail('Raumname muss 1–64 Zeichen enthalten');
  return s.trim();
}
function stored() {
  let c; try { c = web?.security?.configSnapshot?.read()?.raeume; } catch {}
  if (!isObject(c) || !Array.isArray(c.rooms) || !isObject(c.assign)) return null;
  const rooms = c.rooms.filter(r => isObject(r) && Number.isSafeInteger(r.id) && r.id > 0 && typeof r.name === 'string').slice(0, LIMITS.rooms);
  const ids = new Set(rooms.map(r => r.id)), assign = {};
  for (const [a, id] of Object.entries(c.assign)) if (ADDRESS.test(a) && ids.has(id)) assign[a] = id;
  return { rooms, assign, importedAt: typeof c.importedAt === 'string' ? c.importedAt : null };
}
function save(s) {
  if (!web || typeof web.writeConfigPatch !== 'function') throw fail('Einstellung nicht speicherbar', 503);
  web.writeConfigPatch(c => { c.raeume = { rooms: s.rooms, assign: s.assign, importedAt: s.importedAt || null }; });
}
// Einmalige Übernahme aus der CCU (nur lesen). Schlägt sie fehl, wird nichts angelegt – beim nächsten Mal erneut versucht.
async function importFromCcu(connector) {
  if (!connector || typeof connector.regaScript !== 'function') throw fail('CCU-Räume für die Übernahme nicht erreichbar', 502);
  const { READ } = require('./ccu-rooms');
  let data, error;
  for (const port of [...new Set([8181, connector.config?.regaPort || 80])]) {
    try { data = JSON.parse(String(await connector.regaScript(READ, port)).trim()); break; } catch (e) { error = e; }
  }
  if (!data || !Array.isArray(data.rooms) || !Array.isArray(data.channels)) throw fail('CCU-Räume für die Übernahme nicht lesbar' + (error ? ': ' + String(error.message).slice(0, 60) : ''), 502);
  const byId = new Map(data.channels.filter(c => c && Number.isSafeInteger(c.id) && typeof c.address === 'string').map(c => [c.id, decode(c.address)]));
  const rooms = [], assign = {}, names = new Set();
  for (const r of data.rooms) {
    if (!r || typeof r.name !== 'string' || !Array.isArray(r.channelIds)) continue;
    let name; try { name = validName(decode(r.name)); } catch { continue; }
    if (names.has(name) || rooms.length >= LIMITS.rooms) continue;
    names.add(name); const id = rooms.length + 1; rooms.push({ id, name });
    for (const cid of r.channelIds) { const a = byId.get(cid); if (a && ADDRESS.test(a) && !Object.hasOwn(assign, a)) assign[a] = id; }
  }
  const s = { rooms, assign, importedAt: new Date().toISOString() };
  save(s); return s;
}
async function ensure(connector) {
  const s = stored(); if (s) return s;
  if (!importing) importing = importFromCcu(connector).finally(() => { importing = null; });
  return importing;
}
// Ansicht im Format der bisherigen CCU-Raumdaten, damit alle Nutzer unverändert weiterarbeiten.
function view(s, connector) {
  const addresses = [...new Set([...((connector?.getChannels?.() || new Map()).keys()), ...Object.keys(s.assign)])].filter(a => typeof a === 'string');
  const channels = addresses.map((address, i) => ({ id: i + 1, address })), idOf = new Map(channels.map(c => [c.address, c.id]));
  const rooms = s.rooms.map(r => ({ id: r.id, name: r.name, channelIds: Object.entries(s.assign).filter(([, id]) => id === r.id).map(([a]) => idOf.get(a)).filter(Boolean) }));
  return { rooms, channels };
}
async function change(connector, method, p) {
  const allowed = { setDeviceRoom: ['address', 'room'], createRoom: ['name'], setRoomName: ['originalName', 'name'], deleteRoom: ['originalName'] }[method];
  if (!allowed || !isObject(p) || Object.keys(p).some(k => !allowed.includes(k)) || allowed.some(k => typeof p[k] !== 'string')) throw fail('Ungültige Raumaktion');
  const s = JSON.parse(JSON.stringify(await ensure(connector)));
  if (method === 'setDeviceRoom') {
    if (!ADDRESS.test(p.address)) throw fail('Ungültiges Gerät');
    if (p.room === '') delete s.assign[p.address];
    else { const r = s.rooms.find(x => x.name === p.room); if (!r) throw fail('Raum nicht gefunden', 404); if (!Object.hasOwn(s.assign, p.address) && Object.keys(s.assign).length >= LIMITS.assign) throw fail('Zu viele Zuordnungen'); s.assign[p.address] = r.id; }
  } else if (method === 'createRoom') {
    const name = validName(p.name);
    if (s.rooms.some(r => r.name === name)) throw fail('Raum existiert bereits');
    if (s.rooms.length >= LIMITS.rooms) throw fail('Höchstens ' + LIMITS.rooms + ' Räume');
    s.rooms.push({ id: Math.max(0, ...s.rooms.map(r => r.id)) + 1, name });
  } else {
    const r = s.rooms.find(x => x.name === p.originalName); if (!r) throw fail('Raum nicht gefunden', 404);
    if (method === 'setRoomName') { const name = validName(p.name); if (s.rooms.some(x => x.id !== r.id && x.name === name)) throw fail('Raumname existiert bereits'); r.name = name; }
    else { s.rooms = s.rooms.filter(x => x.id !== r.id); for (const [a, id] of Object.entries(s.assign)) if (id === r.id) delete s.assign[a]; }
  }
  save(s); return s;
}
// Räume regelmäßig auf die Geräte übertragen (die CCU-Erkennung setzt sonst ihren eigenen Wert).
async function applyNow() {
  if (!web) return;
  const connector = web.deps?.getConnector?.(); const s = stored(); if (!s || !connector) return;
  const svc = web.security?.ccuRooms?.(); if (!svc) return;
  try { svc.apply(view(s, connector), web.deps.getDevices?.() || new Map(), connector.getChannels?.() || new Map()); } catch {}
}
function start(w) { web = w; if (timer) return; timer = setInterval(() => applyNow().catch(() => {}), 30000); timer.unref?.(); setTimeout(() => ensure(web.deps?.getConnector?.()).then(applyNow).catch(() => {}), 25000).unref?.(); }
function attach(w) { if (!web) web = w; }
// Räume für WLAN-/Tasmota-/Dyson-/Jeep-Einträge und Taster ohne Matter-Kachel (übrige CCU-Kanäle laufen über die bisherige Raumschnittstelle).
async function handle(w, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getRaumZuordnung', 'setGeraetRaum'].includes(method)) return false;
  attach(w);
  const send = (st, d) => w.sendJson(res, st, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    if (method === 'getRaumZuordnung') {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      const s = await ensure(w.deps?.getConnector?.());
      const names = new Map(s.rooms.map(r => [r.id, r.name]));
      send(200, { rooms: s.rooms.map(r => r.name), assign: Object.fromEntries(Object.entries(s.assign).map(([a, id]) => [a, names.get(id)])), importedAt: s.importedAt }); return true;
    }
    if (auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!isObject(p) || typeof p.address !== 'string' || !ADDRESS.test(p.address)) throw fail('Gerät ungültig');
    await change(w.deps?.getConnector?.(), 'setDeviceRoom', p);
    send(200, { success: true });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Räume: Anfrage fehlgeschlagen' }); }
  return true;
}
// Aktuelle eigene Raumliste ohne Übernahme (null, solange noch keine angelegt ist)
function current(w) { attach(w); return stored(); }
module.exports = { start, attach, current, ensure, view, change, handle, applyNow, _test: { stored, importFromCcu, ADDRESS, reset: () => { web = null; if (timer) clearInterval(timer); timer = null; importing = null; } } };
