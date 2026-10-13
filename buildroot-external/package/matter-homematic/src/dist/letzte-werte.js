'use strict';
// Messwerte je Gerät mit „Stand“ (Wunsch Thomas, 12.10.2026): alle Werte, die ein Gerät liefert (Temperatur, Feuchte,
// Leistung, Spannung, Strom …), wie bei den Smart-Life-Steckdosen – und von wann sie sind.
// CCU-Geräte: Werte aus der laufenden Bridge, Zeit der letzten Meldung aus der CCU (ReGa merkt sie sich je Datenpunkt,
// auch über Neustarts) und live aus den Meldungen, die die Bridge ohnehin bekommt. Tasmota: letzte Antwort des Geräts.
// Jeep: Zeitstempel der Cloud. Übrige WLAN-Geräte: Zeitpunkt der letzten Wertänderung seit Bridge-Start.
// Nur lesen – es wird nichts gefunkt und nichts geschaltet.
const SCRIPT = '! MH_STAND\nstring cid;string pid;object c;object p;integer m;integer x;string t="\\t";' +
  'foreach(cid,dom.GetObject(ID_CHANNELS).EnumUsedIDs()){c=dom.GetObject(cid);if(c){m=0;foreach(pid,c.DPs().EnumUsedIDs()){p=dom.GetObject(pid);if(p){x=p.Timestamp().ToInteger();if(x>m){m=x;}}}' +
  'if(m>0){Write(c.Address()#t#m#"\\n");}}}';
// Homematic-Werte: [Bezeichnung, Einheit, Umrechnung]
const HM = {
  ACTUAL_TEMPERATURE: ['Temperatur', '°C'], HUMIDITY: ['Luftfeuchte', '%'], SET_POINT_TEMPERATURE: ['Solltemperatur', '°C'],
  ILLUMINATION: ['Helligkeit', 'lx'], CURRENT_ILLUMINATION: ['Helligkeit', 'lx'], LEVEL: ['Stellung', '%', v => v * 100],
  POWER: ['Leistung', 'W'], VOLTAGE: ['Spannung', 'V'], CURRENT: ['Strom', 'mA'], FREQUENCY: ['Frequenz', 'Hz'], ENERGY_COUNTER: ['Zähler', 'Wh'],
  OPERATING_VOLTAGE: ['Batteriespannung', 'V'], WIND_SPEED: ['Wind', 'km/h'], RAIN_COUNTER: ['Regen', 'mm']
};
const FLAGS = { LOW_BAT: 'Batterie schwach', LOWBAT: 'Batterie schwach', UNREACH: 'nicht erreichbar', SABOTAGE: 'Sabotage' };
// WLAN-Geräte (currentState der Bridge): [Feld, Bezeichnung, Einheit]
const WIFI = [['temperature', 'Temperatur', '°C'], ['humidity', 'Luftfeuchte', '%'], ['power', 'Leistung', 'W'], ['voltage', 'Spannung', 'V'], ['current', 'Strom', 'A'],
  ['energyToday', 'Energie heute', 'kWh'], ['energyTotal', 'Zählerstand', 'kWh'], ['pm25', 'Feinstaub', 'µg/m³']];
const num = (v, unit) => { const r = Math.round(v * 100) / 100; return r.toLocaleString('de-DE') + (unit ? ' ' + unit : ''); };
const ADDRESS = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$/;

let rega = { at: 0, map: new Map(), pending: null };
const heard = new Map(); let listening = null;
const changed = new Map(); // WLAN-Geräte: Adresse → { fp, at }
function listen(connector) {
  if (listening === connector || typeof connector?.on !== 'function') return;
  listening = connector;
  connector.on('deviceEvent', e => { if (e && typeof e.address === 'string' && ADDRESS.test(e.address)) { heard.set(e.address, Date.now()); if (heard.size > 3000) heard.delete(heard.keys().next().value); } });
}
function regaTimes(connector, now = Date.now()) {
  if (rega.pending) return rega.pending;
  if (now - rega.at < 300000 || typeof connector?.regaScript !== 'function') return Promise.resolve(rega.map);
  rega.pending = Promise.race([connector.regaScript(SCRIPT, 8181), new Promise((_, no) => setTimeout(() => no(Error('Zeit')), 15000).unref?.())])
    .then(out => { const map = new Map(); for (const line of String(out || '').split('\n')) { const [a, s] = line.split('\t'); if (ADDRESS.test(a || '') && /^\d{9,11}$/.test(s || '')) map.set(a, Number(s) * 1000); } rega = { at: Date.now(), map, pending: null }; return map; },
      () => { rega = { ...rega, at: Date.now() - 240000, pending: null }; return rega.map; });
  return rega.pending;
}
async function collect(web, now = Date.now()) {
  const connector = web.deps.getConnector?.(); listen(connector);
  const times = await regaTimes(connector, now), out = {};
  // CCU-Geräte: je Gerät (Seriennummer) alle Werte aller Kanäle
  for (const [address, c] of connector?.getChannels?.() || new Map()) {
    if (!ADDRESS.test(address)) continue;
    const base = address.split(':')[0], v = c?.paramsets?.VALUES || {}, maint = address.endsWith(':0');
    const e = out[base] || (out[base] = { values: [], flags: [], at: 0 }), before = e.values.length + e.flags.length;
    for (const [k, [label, unit, conv]] of Object.entries(HM)) {
      if (maint !== (k === 'OPERATING_VOLTAGE') || typeof v[k] !== 'number' || !Number.isFinite(v[k])) continue;
      if (e.values.some(x => x[0] === label)) continue;
      e.values.push([label, num(conv ? conv(v[k]) : v[k], unit)]);
    }
    for (const [k, label] of Object.entries(FLAGS)) if (v[k] === true && !e.flags.includes(label)) e.flags.push(label);
    const t = Math.max(times.get(address) || 0, heard.get(address) || 0);
    if (t && (e.values.length + e.flags.length > before || !maint)) e.at = Math.max(e.at, t);
  }
  // WLAN, Tasmota, Jeep, Dyson
  let rows = []; try { rows = (web.getDevices?.().devices || []).filter(d => d.provider); } catch {}
  const tasmotaSeen = new Map();
  if (rows.some(d => d.provider === 'tasmota')) try { for (const h of require('./tasmota')._test.publicList(web).hosts || []) if (h.lastSeen) for (const id of h.parts || []) tasmotaSeen.set(id, Date.parse(h.lastSeen)); } catch {}
  for (const d of rows) {
    const s = d.currentState || {}, values = [];
    for (const [f, label, unit] of WIFI) if (Number.isFinite(s[f])) values.push([label, num(s[f], unit)]);
    if (d.provider === 'jeep' && Number.isFinite(Number(s.value)) && s.value !== null) values.push([d.matterDeviceType || 'Wert', num(Number(s.value), s.unit || '')]);
    const fp = JSON.stringify(values), old = changed.get(d.address);
    if (!old || old.fp !== fp) changed.set(d.address, { fp, at: old ? now : 0 });
    let at = d.provider === 'jeep' ? Date.parse(s.timestamp || '') || 0 : (d.provider === 'tasmota' && tasmotaSeen.get(d.id)) || changed.get(d.address).at;
    out[d.address] = { values, flags: [], at, ...(at ? {} : { hint: 'seit Bridge-Start unverändert' }) };
  }
  for (const k of Object.keys(out)) { const e = out[k]; if (!e.values.length && !e.flags.length) { delete out[k]; continue; } e.values.sort((a, b) => (a[0] === 'Batteriespannung') - (b[0] === 'Batteriespannung')); e.at = e.at ? new Date(e.at).toISOString() : null; }
  return { now: new Date(now).toISOString(), devices: out };
}
async function handle(web, req, res, u, auth) {
  if (u.pathname !== '/api/' || u.searchParams.get('method') !== 'getLetzteWerte') return false;
  if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
  if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
  try { web.sendJson(res, 200, await collect(web)); } catch (e) { web.sendJson(res, e.status || 500, { error: e.status ? e.message : 'Werte nicht lesbar' }); }
  return true;
}
module.exports = { handle, collect, _test: { reset() { rega = { at: 0, map: new Map(), pending: null }; heard.clear(); changed.clear(); listening = null; }, SCRIPT } };
