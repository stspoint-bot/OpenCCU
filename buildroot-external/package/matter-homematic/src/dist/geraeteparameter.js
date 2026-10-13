'use strict';
// Geräteeinstellungen (Wunsch Thomas, 12.10.2026): ersetzt die Gerätekonfiguration der alten OpenCCU.
// Liest und ändert die MASTER-Parameter eines Geräts bzw. Kanals (Homematic IP und Homematic) – generisch aus der
// Gerätebeschreibung (Typ, Min/Max, Auswahlliste, Einheit). Zeitprogramme (Wochenprofile) sind ausgeblendet – dafür gibt es
// das Wochenprogramm. Sichtbar sind nur Parameter, die die Gerätebeschreibung als sichtbar und schreibbar meldet.
// Nur Administratoren; nur geänderte Werte werden gesendet (wenig Funk); danach wird zurückgelesen.
const { rpc } = require('./wochenprogramm');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ADDR = /^[A-Za-z0-9_-]{1,64}(:\d{1,3})?$/;
const PROFILE = /^\d\d_WP_|^P\d_|_(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)_\d+$|^(ENDTIME|TEMPERATURE)_(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)/;
// Verständliche Namen für häufige Einstellungen (Rest bleibt als Fachbegriff in der Expertenliste)
const NAMES = { TEMPERATURE_OFFSET: 'Temperatur-Abgleich', BOOST_TIME_PERIOD: 'Boost-Dauer', BOOST_POSITION: 'Boost-Ventilöffnung', TEMPERATURE_WINDOW_OPEN: 'Temperatur bei offenem Fenster',
  TEMPERATURE_MINIMUM: 'Mindesttemperatur', TEMPERATURE_MAXIMUM: 'Höchsttemperatur', TEMPERATURE_COMFORT: 'Komforttemperatur', TEMPERATURE_LOWERING: 'Absenktemperatur', SHOW_SET_TEMPERATURE: 'Anzeige Solltemperatur',
  CHANNEL_OPERATION_MODE: 'Betriebsart des Kanals', POWERUP_JUMPTARGET: 'Verhalten nach Stromausfall', STATUSINFO_MINDELAY: 'Statusmeldung Mindestverzögerung', STATUSINFO_RANDOM: 'Statusmeldung Zufallsverzögerung',
  MOTION_DETECTION_SENSITIVITY: 'Empfindlichkeit Bewegung', BRIGHTNESS_FILTER: 'Helligkeitsfilter', CAPTURE_WITHIN_INTERVAL: 'Erfassung im Intervall', EVENT_FILTER_PERIOD: 'Ereignisfilter', MIN_INTERVAL: 'Mindestabstand Meldungen',
  LONG_PRESS_TIME: 'Zeit für langen Tastendruck', DBL_PRESS_TIME: 'Zeit für Doppelklick', LOCAL_RESET_DISABLED: 'Zurücksetzen am Gerät sperren', ROUTER_MODULE_ENABLED: 'Funk-Router', DISABLE_MSG_TO_AC: 'Keine Meldungen an die Zentrale',
  LOW_BAT_LIMIT: 'Batterie schwach ab', CYCLIC_INFO_MSG: 'Regelmäßige Statusmeldung', CYCLIC_INFO_MSG_DIS: 'Regelmäßige Meldung (Abstand)', BACKLIGHT_ON_TIME: 'Beleuchtungsdauer Anzeige', BUTTON_RESPONSE_WITHOUT_BACKLIGHT: 'Tasten ohne Beleuchtung',
  DUTYCYCLE_LIMIT: 'Sendezeit-Grenze', ENABLE_ROUTING: 'Weiterleitung (Routing)', TRANSMIT_TRY_MAX: 'Sendeversuche', SIGNAL_TYPE: 'Signal', VALVE_OFFSET: 'Ventil-Versatz', VALVE_MAXIMUM_POSITION: 'Ventil maximal',
  MSG_FOR_POS_A: 'Meldung Stellung A', MSG_FOR_POS_B: 'Meldung Stellung B', EVENT_DELAY_UNIT: 'Verzögerung (Einheit)', EVENT_DELAY_VALUE: 'Verzögerung (Wert)' };
const isFloat = d => d?.TYPE === 'FLOAT', OPS_WRITE = 2, FLAG_VISIBLE = 1, FLAG_INTERNAL = 2;
async function ifaceOf(web, address) {
  for (const i of ['HmIP-RF', 'BidCos-RF']) { try { const d = await rpc(web, 'getDeviceDescription', [address], 8000, i); if (d && d.ADDRESS === address) return { iface: i, desc: d }; } catch {} }
  throw fail('Gerät oder Kanal nicht gefunden', 404);
}
function shown(key, d) { return !PROFILE.test(key) && isObject(d) && (Number(d.OPERATIONS) & OPS_WRITE) && (Number(d.FLAGS) & FLAG_VISIBLE) && !(Number(d.FLAGS) & FLAG_INTERNAL); }
async function read(web, address) {
  if (typeof address !== 'string' || !ADDR.test(address)) throw fail('Adresse ungültig');
  const { iface, desc } = await ifaceOf(web, address);
  const children = address.includes(':') ? [] : (Array.isArray(desc.CHILDREN) ? desc.CHILDREN : []).slice(0, 40);
  const one = async a => {
    let d = {}, v = {}; try { d = await rpc(web, 'getParamsetDescription', [a, 'MASTER'], 20000, iface) || {}; v = await rpc(web, 'getParamset', [a, 'MASTER'], 20000, iface) || {}; } catch { return null; }
    const params = Object.entries(d).filter(([k, x]) => shown(k, x)).slice(0, 150).map(([k, x]) => ({ key: k, name: NAMES[k] || '', type: x.TYPE, min: x.MIN, max: x.MAX, unit: typeof x.UNIT === 'string' ? x.UNIT.replace(/[^\x20-\x7e°%]/g, '').slice(0, 12) : '', list: Array.isArray(x.VALUE_LIST) ? x.VALUE_LIST.map(String).slice(0, 50) : null, value: v[k] }));
    params.sort((a1, b1) => (b1.name ? 1 : 0) - (a1.name ? 1 : 0) || a1.key.localeCompare(b1.key));
    return params.length ? { address: a, params } : null;
  };
  const kanaele = (await Promise.all([address, ...children].map(one))).filter(Boolean);
  return { address, iface, type: desc.TYPE || '', kanaele };
}
function convert(key, value, d) {
  const t = d.TYPE;
  if (t === 'BOOL' || t === 'ACTION') { if (typeof value !== 'boolean') throw fail(key + ': Ja oder Nein'); return value; }
  if (t === 'STRING') { if (typeof value !== 'string' || value.length > 64 || /[\x00-\x1f\x7f]/.test(value)) throw fail(key + ': Text ungültig'); return value; }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(key + ': Zahl erwartet');
  if (t === 'ENUM') { const n = Array.isArray(d.VALUE_LIST) ? d.VALUE_LIST.length : Number(d.MAX) + 1; if (!Number.isInteger(value) || value < 0 || value >= n) throw fail(key + ': Auswahl ungültig'); return value; }
  const min = Number(d.MIN), max = Number(d.MAX);
  if (Number.isFinite(min) && value < min - 1e-9) throw fail(key + ': mindestens ' + min);
  if (Number.isFinite(max) && value > max + 1e-9) throw fail(key + ': höchstens ' + max);
  if (t === 'INTEGER' && !Number.isInteger(value)) throw fail(key + ': ganze Zahl erwartet');
  return isFloat(d) ? { __type: 'double', value } : value;
}
async function save(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['address', 'values'].includes(k)) || typeof p.address !== 'string' || !ADDR.test(p.address) || !isObject(p.values)) throw fail('Ungültige Angaben');
  const keys = Object.keys(p.values); if (!keys.length) throw fail('Keine Änderung'); if (keys.length > 60) throw fail('Höchstens 60 Werte auf einmal');
  const { iface } = await ifaceOf(web, p.address);
  const d = await rpc(web, 'getParamsetDescription', [p.address, 'MASTER'], 20000, iface) || {}, cur = await rpc(web, 'getParamset', [p.address, 'MASTER'], 20000, iface) || {};
  const out = {};
  for (const k of keys) {
    if (!shown(k, d[k])) throw fail(k + ': nicht einstellbar');
    const v = convert(k, p.values[k], d[k]), raw = isObject(v) ? v.value : v;
    if (typeof raw === 'number' ? Math.abs(Number(cur[k]) - raw) < 1e-9 : cur[k] === raw) continue;
    out[k] = v;
  }
  if (Object.keys(out).length) await rpc(web, 'putParamset', [p.address, 'MASTER', out], 60000, iface);
  const after = await rpc(web, 'getParamset', [p.address, 'MASTER'], 20000, iface) || {};
  const notApplied = Object.keys(out).filter(k => { const raw = isObject(out[k]) ? out[k].value : out[k]; return typeof raw === 'number' ? Math.abs(Number(after[k]) - raw) > 0.011 : after[k] !== raw; });
  return { success: true, sent: Object.keys(out).length, pending: notApplied, message: !Object.keys(out).length ? 'Keine Änderung.' : notApplied.length ? Object.keys(out).length + ' Werte gesendet; ' + notApplied.length + ' werden übertragen, sobald das Gerät erreichbar ist (Batteriegeräte: Taste drücken).' : Object.keys(out).length + ' Werte gespeichert.' };
}
let busy = false;
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getGeraeteParameter', 'saveGeraeteParameter'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass || (auth.session?.role && auth.session.role !== 'admin')) { send(403, { error: 'Nur nach Anmeldung als Administrator möglich' }); return true; }
    if (method === 'getGeraeteParameter') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await read(web, u.searchParams.get('adresse'))); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (busy) { send(429, { error: 'Es werden gerade Einstellungen übertragen' }); return true; }
    busy = true; try { send(200, await save(web, p)); } finally { busy = false; }
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Geräteeinstellungen: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, _test: { shown, convert, PROFILE } };
