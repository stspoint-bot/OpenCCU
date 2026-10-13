'use strict';
// Wochenprogramme der Aktoren (Wunsch Thomas, 12.10.2026): Schaltzeiten lesen und ändern – Schalt- und Dimm-Wochenprogramm
// von Homematic IP (Kanaltyp SWITCH_WEEK_PROFILE / DIMMER_WEEK_PROFILE, bis zu 75 Schaltzeiten je Gerät).
// Gespeichert wird im Gerät selbst (MASTER-Paramset) – es läuft dann auch ohne CCU/Bridge.
// Aufbau je Schaltzeit nn (eQ-3): nn_WP_WEEKDAY (Bitmaske, Bit 0 = Sonntag … Bit 6 = Samstag), nn_WP_CONDITION (0 = feste Zeit,
// 1 = Sonnenauf-/untergang), nn_WP_FIXED_HOUR/MINUTE, nn_WP_ASTRO_TYPE (0 = Aufgang, 1 = Untergang), nn_WP_ASTRO_OFFSET (Minuten),
// nn_WP_LEVEL (0…1), nn_WP_TARGET_CHANNELS (Bitmaske der Aktorkanäle). Dauer bleibt „dauerhaft“ (Basis 7 / Faktor 31).
// Nur Administratoren; nur geänderte Werte werden gesendet (wenig Funk); Typen genau nach Gerätebeschreibung.
// Heizung (Thermostate, 12.10.2026): je Wochentag bis zu 13 Abschnitte „bis Uhrzeit → Temperatur“; der letzte endet um 24:00.
// HmIP: [Pn_]ENDTIME_<TAG>_<i> (Minuten) und [Pn_]TEMPERATURE_<TAG>_<i> (°C) im MASTER des Heizkanals, Profile P1…P6.
// BidCos (z. B. HM-CC-RT-DN): gleiche Namen ohne Profil, im MASTER des Geräts oder Kanals – wird anhand der Beschreibung gefunden.
const http = require('node:http');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const KANAL = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$/, HEIZ_ADR = /^[A-Za-z0-9_-]{1,64}(:\d{1,3})?$/, IFACES = ['HmIP-RF', 'BidCos-RF'];
const KINDS = { SWITCH_WEEK_PROFILE: 'switch', DIMMER_WEEK_PROFILE: 'dimmer' };

// ---- kleines XML-RPC mit genauen Typen (nur zur lokalen Funkschnittstelle) ----
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function xmlValue(v) {
  if (v && v.__type === 'double') return '<value><double>' + Number(v.value).toFixed(6) + '</double></value>';
  if (typeof v === 'boolean') return '<value><boolean>' + (v ? 1 : 0) + '</boolean></value>';
  if (typeof v === 'number') return Number.isInteger(v) ? '<value><i4>' + v + '</i4></value>' : '<value><double>' + v + '</double></value>';
  if (isObject(v)) return '<value><struct>' + Object.entries(v).map(([k, x]) => '<member><name>' + esc(k) + '</name>' + xmlValue(x) + '</member>').join('') + '</struct></value>';
  return '<value><string>' + esc(v) + '</string></value>';
}
function parseXml(xml) {
  // Antwort in einfache Werte: struct → Objekt, array → Liste, Zahlen/Text/Wahrheitswerte
  let i = 0; const s = String(xml).replace(/>\s+</g, '><');
  const take = re => { re.lastIndex = i; const m = re.exec(s); if (!m || m.index !== i) return null; i = re.lastIndex; return m; };
  function value() {
    if (!take(/<value>/y)) return null;
    let out;
    if (take(/<struct>/y)) { out = {}; while (take(/<member>/y)) { const n = take(/<name>([^<]*)<\/name>/y); out[n[1]] = value(); take(/<\/member>/y); } take(/<\/struct>/y); }
    else if (take(/<array><data>/y)) { out = []; while (s.startsWith('<value>', i)) out.push(value()); take(/<\/data><\/array>/y); }
    else { const m = take(/<(i4|int|double|boolean|string)>([^<]*)<\/\1>/y) || take(/<(i4|int|double|boolean|string)\/>/y); if (m) out = m[1] === 'boolean' ? m[2] === '1' : m[1] === 'string' ? (m[2] || '') : Number(m[2]); else { const t = take(/([^<]*)/y); out = t ? t[1] : ''; } }
    take(/<\/value>/y); return out;
  }
  const f = s.indexOf('<fault>'); if (f >= 0) { i = f + 7; const v = value(); throw fail('Funkschnittstelle: ' + String(v?.faultString || 'Fehler').slice(0, 120), 502); }
  const p = s.indexOf('<param>'); if (p < 0) return null; i = p + 7; return value();
}
function rpc(web, method, params, timeout = 20000, iface = 'HmIP-RF') {
  const c = web.deps.getConnector?.(); const conf = c?.config || {};
  const host = conf.host || '127.0.0.1', port = conf.interfaces?.[iface]?.port || (iface === 'BidCos-RF' ? 2001 : 2010);
  const body = '<?xml version="1.0"?><methodCall><methodName>' + method + '</methodName><params>' + params.map(p => '<param>' + xmlValue(p) + '</param>').join('') + '</params></methodCall>';
  const send = (iface === 'HmIP-RF' ? web.deps.wochenRpc : web.deps.bidcosRpc) || ((b) => new Promise((ok, no) => {
    const r = http.request({ host, port, method: 'POST', headers: { 'Content-Type': 'text/xml' }, timeout }, res => { let d = ''; res.setEncoding('utf8'); res.on('data', x => { d += x; if (d.length > 2e6) r.destroy(Error('Antwort zu groß')); }); res.on('end', () => ok(d)); });
    r.on('timeout', () => r.destroy(Error('Zeitüberschreitung'))); r.on('error', no); r.end(b);
  }));
  return Promise.resolve(send(body, method, params)).then(parseXml);
}

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const pad = n => String(n).padStart(2, '0');
function decode(master, kind) {
  const slots = new Set(Object.keys(master).map(k => /^(\d\d)_WP_WEEKDAY$/.exec(k)?.[1]).filter(Boolean));
  const entries = [];
  for (const nn of [...slots].sort()) {
    const g = k => master[nn + '_WP_' + k], wd = Number(g('WEEKDAY')) || 0;
    if (!wd) continue;
    const cond = Number(g('CONDITION')) || 0;
    entries.push({ slot: Number(nn), days: DAYS.map((_, i) => i).filter(i => wd & (1 << i)),
      mode: cond === 1 ? (Number(g('ASTRO_TYPE')) === 1 ? 'sunset' : 'sunrise') : 'time',
      time: pad(Number(g('FIXED_HOUR')) || 0) + ':' + pad(Number(g('FIXED_MINUTE')) || 0), offset: Number(g('ASTRO_OFFSET')) || 0,
      level: Math.round((Number(g('LEVEL')) || 0) * 100), targets: Number(g('TARGET_CHANNELS')) || 1 });
  }
  return { kind, capacity: slots.size, entries };
}
function encode(entries, capacity, kind) {
  if (!Array.isArray(entries) || entries.length > capacity) throw fail('Höchstens ' + capacity + ' Schaltzeiten');
  const out = {};
  entries.forEach((e, idx) => {
    if (!isObject(e) || Object.keys(e).some(k => !['days', 'mode', 'time', 'offset', 'level', 'targets', 'slot'].includes(k))) throw fail('Schaltzeit ' + (idx + 1) + ' ungültig');
    if (!Array.isArray(e.days) || !e.days.length || e.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw fail('Schaltzeit ' + (idx + 1) + ': mindestens einen Wochentag wählen');
    if (!['time', 'sunrise', 'sunset'].includes(e.mode)) throw fail('Schaltzeit ' + (idx + 1) + ': Uhrzeit oder Sonne wählen');
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(e.time || ''); if (e.mode === 'time' && !m) throw fail('Schaltzeit ' + (idx + 1) + ': Uhrzeit HH:MM');
    const offset = e.offset === undefined ? 0 : e.offset; if (!Number.isInteger(offset) || offset < -120 || offset > 120) throw fail('Schaltzeit ' + (idx + 1) + ': Verschiebung -120 bis 120 Minuten');
    if (!Number.isInteger(e.level) || e.level < 0 || e.level > 100 || (kind === 'switch' && ![0, 100].includes(e.level))) throw fail('Schaltzeit ' + (idx + 1) + ': ' + (kind === 'switch' ? 'Ein oder Aus' : 'Helligkeit 0 bis 100 %'));
    const targets = e.targets === undefined ? 1 : e.targets; if (!Number.isInteger(targets) || targets < 1 || targets > 255) throw fail('Schaltzeit ' + (idx + 1) + ': Kanal ungültig');
    const nn = pad(idx + 1);
    Object.assign(out, { [nn + '_WP_WEEKDAY']: e.days.reduce((a, d) => a | (1 << d), 0), [nn + '_WP_CONDITION']: e.mode === 'time' ? 0 : 1,
      [nn + '_WP_FIXED_HOUR']: m ? Number(m[1]) : 0, [nn + '_WP_FIXED_MINUTE']: m ? Number(m[2]) : 0, [nn + '_WP_ASTRO_TYPE']: e.mode === 'sunset' ? 1 : 0,
      [nn + '_WP_ASTRO_OFFSET']: offset, [nn + '_WP_LEVEL']: { __type: 'double', value: e.level / 100 }, [nn + '_WP_TARGET_CHANNELS']: targets,
      [nn + '_WP_DURATION_BASE']: 7, [nn + '_WP_DURATION_FACTOR']: 31 });
  });
  for (let i = entries.length + 1; i <= capacity; i++) out[pad(i) + '_WP_WEEKDAY'] = 0; // übrige Plätze leeren
  return out;
}
// Nur geänderte Werte senden (wenig Funk); Typen nach Gerätebeschreibung (FLOAT → double)
function diff(next, current, desc) {
  const out = {};
  for (const [k, v] of Object.entries(next)) {
    if (!Object.hasOwn(current, k)) continue; // unbekannter Parameter: nie senden
    const raw = isObject(v) ? v.value : v, cur = Number(current[k]);
    if (Math.abs(cur - raw) < 1e-6) continue;
    out[k] = desc?.[k]?.TYPE === 'FLOAT' ? { __type: 'double', value: raw } : raw;
  }
  return out;
}
async function channelKind(web, kanal) {
  const d = await rpc(web, 'getDeviceDescription', [kanal]);
  const kind = KINDS[d?.TYPE]; if (!kind) throw fail('Dieser Kanal hat kein Schalt- oder Dimm-Wochenprogramm', 404);
  return kind;
}
async function read(web, kanal) {
  if (typeof kanal !== 'string' || !KANAL.test(kanal)) throw fail('Kanal ungültig');
  const kind = await channelKind(web, kanal), master = await rpc(web, 'getParamset', [kanal, 'MASTER']);
  if (!isObject(master)) throw fail('Wochenprogramm nicht lesbar', 502);
  return { kanal, ...decode(master, kind) };
}
async function save(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['kanal', 'entries'].includes(k)) || typeof p.kanal !== 'string' || !KANAL.test(p.kanal)) throw fail('Kanal ungültig');
  const kind = await channelKind(web, p.kanal), master = await rpc(web, 'getParamset', [p.kanal, 'MASTER']), desc = await rpc(web, 'getParamsetDescription', [p.kanal, 'MASTER']);
  const capacity = decode(master, kind).capacity; if (!capacity) throw fail('Wochenprogramm nicht lesbar', 502);
  const changes = diff(encode(p.entries, capacity, kind), master, desc);
  if (Object.keys(changes).length) await rpc(web, 'putParamset', [p.kanal, 'MASTER', changes], 60000);
  const after = await read(web, p.kanal);
  return { success: true, ...after, sent: Object.keys(changes).length, message: Object.keys(changes).length ? 'Wochenprogramm gespeichert (' + Object.keys(changes).length + ' Werte an das Gerät übertragen).' : 'Keine Änderung.' };
}
// ---- Heizprofile (Thermostate) ----
const TAGE = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const HEIZ_KEY = /^(?:P([1-6])_)?(ENDTIME|TEMPERATURE)_(SUNDAY|MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY)_(\d{1,2})$/;
const HEAT_TYPES = /^(HEATING_CLIMATECONTROL_TRANSCEIVER|CLIMATECONTROL_RT_TRANSCEIVER|THERMALCONTROL_TRANSMIT|CLIMATECONTROL_REGULATOR)$/;
const hhmm = m => m >= 1440 ? '24:00' : pad(Math.floor(m / 60)) + ':' + pad(m % 60);
function heatInfo(keys) {
  const profiles = new Set(), slots = {};
  for (const k of keys) { const m = HEIZ_KEY.exec(k); if (!m) continue; const p = m[1] ? Number(m[1]) : 0; profiles.add(p); slots[p] = Math.max(slots[p] || 0, Number(m[4])); }
  return { profiles: [...profiles].sort(), slots };
}
const heatKey = (profil, art, tag, i) => (profil ? 'P' + profil + '_' : '') + art + '_' + TAGE[tag] + '_' + i;
function heatDecode(master, profil, slots) {
  const days = {};
  for (let t = 0; t < 7; t++) {
    const seg = [];
    for (let i = 1; i <= slots; i++) {
      const end = Number(master[heatKey(profil, 'ENDTIME', t, i)]), temp = Number(master[heatKey(profil, 'TEMPERATURE', t, i)]);
      if (!Number.isFinite(end) || !Number.isFinite(temp)) break;
      seg.push({ bis: hhmm(Math.min(1440, end)), temp: Math.round(temp * 2) / 2 });
      if (end >= 1440) break;
    }
    days[t] = seg;
  }
  return days;
}
function heatEncode(days, profil, slots, tmin = 4.5, tmax = 30.5) {
  if (!isObject(days) || Object.keys(days).some(k => !/^[0-6]$/.test(k)) || Object.keys(days).length !== 7) throw fail('Alle sieben Wochentage angeben');
  const out = {};
  for (let t = 0; t < 7; t++) {
    const seg = days[t], name = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'][t];
    if (!Array.isArray(seg) || !seg.length || seg.length > slots) throw fail(name + ': 1 bis ' + slots + ' Abschnitte');
    let prev = 0;
    seg.forEach((s, i) => {
      if (!isObject(s) || Object.keys(s).some(k => !['bis', 'temp'].includes(k))) throw fail(name + ': Abschnitt ' + (i + 1) + ' ungültig');
      const m = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/.exec(s.bis || ''); if (!m) throw fail(name + ': Uhrzeit HH:MM');
      const end = s.bis === '24:00' ? 1440 : Number(m[1]) * 60 + Number(m[2]);
      if (end % 5) throw fail(name + ': Uhrzeiten in 5-Minuten-Schritten'); if (end <= prev) throw fail(name + ': Uhrzeiten aufsteigend');
      if (i === seg.length - 1 && end !== 1440) throw fail(name + ': letzter Abschnitt muss bis 24:00 gehen');
      if (typeof s.temp !== 'number' || !Number.isFinite(s.temp) || s.temp < tmin || s.temp > tmax || Math.round(s.temp * 2) !== s.temp * 2) throw fail(name + ': Temperatur ' + tmin + ' bis ' + tmax + ' °C in 0,5-Schritten');
      prev = end;
      out[heatKey(profil, 'ENDTIME', t, i + 1)] = end; out[heatKey(profil, 'TEMPERATURE', t, i + 1)] = { __type: 'double', value: s.temp };
    });
    const last = seg[seg.length - 1].temp; // übrige Plätze: bis 24:00 mit letzter Temperatur (so macht es auch die CCU)
    for (let i = seg.length + 1; i <= slots; i++) { out[heatKey(profil, 'ENDTIME', t, i)] = 1440; out[heatKey(profil, 'TEMPERATURE', t, i)] = { __type: 'double', value: last }; }
  }
  return out;
}
// Funkschnittstelle eines Geräts (HmIP zuerst)
async function ifaceOf(web, device) {
  for (const i of IFACES) { try { const d = await rpc(web, 'getDeviceDescription', [device], 10000, i); if (d && d.ADDRESS === device) return { iface: i, desc: d }; } catch {} }
  throw fail('Gerät nicht gefunden', 404);
}
async function heatRead(web, adr, iface, profil) {
  if (typeof adr !== 'string' || !HEIZ_ADR.test(adr) || !IFACES.includes(iface)) throw fail('Kanal ungültig');
  const master = await rpc(web, 'getParamset', [adr, 'MASTER'], 20000, iface); if (!isObject(master)) throw fail('Heizprofil nicht lesbar', 502);
  const info = heatInfo(Object.keys(master)); if (!info.profiles.length) throw fail('Kein Heizprofil gefunden', 404);
  const p = profil === undefined || profil === null || profil === '' ? info.profiles[0] : Number(profil); if (!info.profiles.includes(p)) throw fail('Profil ungültig');
  return { kind: 'heat', kanal: adr, iface, profiles: info.profiles, profil: p, slots: info.slots[p], days: heatDecode(master, p, info.slots[p]) };
}
async function heatSave(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['kanal', 'iface', 'profil', 'days'].includes(k)) || typeof p.kanal !== 'string' || !HEIZ_ADR.test(p.kanal) || !IFACES.includes(p.iface) || !Number.isInteger(p.profil)) throw fail('Kanal ungültig');
  const master = await rpc(web, 'getParamset', [p.kanal, 'MASTER'], 20000, p.iface), desc = await rpc(web, 'getParamsetDescription', [p.kanal, 'MASTER'], 20000, p.iface);
  if (!isObject(master)) throw fail('Heizprofil nicht lesbar', 502);
  const info = heatInfo(Object.keys(master)); if (!info.profiles.includes(p.profil)) throw fail('Profil ungültig');
  const td = desc?.[heatKey(p.profil, 'TEMPERATURE', 1, 1)], tmin = Number.isFinite(Number(td?.MIN)) ? Number(td.MIN) : 4.5, tmax = Number.isFinite(Number(td?.MAX)) ? Number(td.MAX) : 30.5;
  const changes = diff(heatEncode(p.days, p.profil, info.slots[p.profil], tmin, tmax), master, desc);
  if (Object.keys(changes).length) await rpc(web, 'putParamset', [p.kanal, 'MASTER', changes], 60000, p.iface);
  const after = await heatRead(web, p.kanal, p.iface, p.profil);
  return { success: true, ...after, sent: Object.keys(changes).length, message: Object.keys(changes).length ? 'Heizprofil gespeichert (' + Object.keys(changes).length + ' Werte an das Thermostat übertragen; Batteriegeräte übernehmen es beim nächsten Funkkontakt).' : 'Keine Änderung.' };
}
// Wochenprogramm-Kanäle eines Geräts finden (für die Geräteverwaltung): Schalt-/Dimmkanäle und Heizprofile
async function list(web, device) {
  if (typeof device !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(device)) throw fail('Gerät ungültig');
  const { iface, desc: d } = await ifaceOf(web, device);
  const children = Array.isArray(d?.CHILDREN) ? d.CHILDREN : [], out = [], heatCand = [];
  for (const ch of children.slice(0, 40)) {
    try { const cd = await rpc(web, 'getDeviceDescription', [ch], 10000, iface); if (iface === 'HmIP-RF' && KINDS[cd?.TYPE]) out.push({ kanal: ch, kind: KINDS[cd.TYPE], iface }); else if (HEAT_TYPES.test(cd?.TYPE || '')) heatCand.push(ch); } catch {}
  }
  // Heizprofil: zuerst Heizkanäle, dann das Gerät selbst (BidCos-Thermostate); nur eine Fundstelle
  if (heatCand.length || /CC|TRV|WTH|BWTH|TC-IT|STH/i.test(String(d?.TYPE || ''))) {
    for (const adr of [...heatCand, device]) {
      try { const pd = await rpc(web, 'getParamsetDescription', [adr, 'MASTER'], 10000, iface); if (isObject(pd) && heatInfo(Object.keys(pd)).profiles.length) { out.push({ kanal: adr, kind: 'heat', iface }); break; } } catch {}
    }
  }
  return { device, kanaele: out };
}
let busy = false;
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getWochenprogramme', 'getWochenprogramm', 'saveWochenprogramm'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (method === 'getWochenprogramme') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await list(web, u.searchParams.get('geraet'))); return true; }
    if (method === 'getWochenprogramm') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } const q = u.searchParams; send(200, q.get('art') === 'heat' ? await heatRead(web, q.get('kanal'), q.get('iface'), q.get('profil')) : await read(web, q.get('kanal'))); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (busy) { send(429, { error: 'Es wird gerade ein Wochenprogramm gespeichert' }); return true; }
    busy = true; try { send(200, isObject(p) && p.days !== undefined ? await heatSave(web, p) : await save(web, p)); } finally { busy = false; }
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Wochenprogramm: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, rpc, _test: { decode, encode, diff, xmlValue, parseXml, heatInfo, heatDecode, heatEncode, heatRead, heatSave, list } };
