'use strict';
// Favoriten (Wunsch Thomas, 12.10.2026): eigene Listen mit Geräten, die auf der Seite „Favoriten“ mit aktuellem Wert
// und Bedienung erscheinen. Gespeichert in der Bridge-Einstellung (config.favoriten), nicht in der CCU.
// „Aus der alten CCU übernehmen“ liest die Favoriten der OpenCCU (ReGa, nur lesen) – läuft auf jeder CCU3.
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ITEM = /^[A-Za-z0-9@_.:-]{1,100}$/;
const LIMITS = Object.freeze({ lists: 20, items: 60, name: 40 });
// ReGa: Variablen nur einmal anlegen (nicht in der Schleife), sonst bricht das Skript ab.
const SCRIPT = '! MH_FAVORITEN\nboolean f=true;boolean g=true;string lid;string eid;object l;object o;Write("{\\"lists\\":[");' +
  'foreach(lid,dom.GetObject(ID_FAVORITES).EnumUsedIDs()){l=dom.GetObject(lid);if(l){if(!f){Write(",");}f=false;g=true;' +
  'Write("{\\"name\\":\\"" # l.Name().UriEncode() # "\\",\\"items\\":[");' +
  'foreach(eid,l.EnumUsedIDs()){o=dom.GetObject(eid);if(o){if(o.IsTypeOf(OT_CHANNEL)){if(!g){Write(",");}g=false;Write("\\"" # o.Address() # "\\"");}}}' +
  'Write("]}");}}Write("]}");';

function stored(web) {
  let c; try { c = web.security.configSnapshot.read().favoriten; } catch {}
  return isObject(c) && Array.isArray(c.lists) ? c.lists.filter(isObject).slice(0, LIMITS.lists) : [];
}
function normalize(p) {
  if (!isObject(p) || Object.keys(p).some(k => k !== 'lists') || !Array.isArray(p.lists) || p.lists.length > LIMITS.lists) throw fail('Höchstens ' + LIMITS.lists + ' Listen');
  const ids = new Set();
  return p.lists.map((l, i) => {
    if (!isObject(l) || Object.keys(l).some(k => !['id', 'name', 'items'].includes(k))) throw fail('Liste ' + (i + 1) + ' ungültig');
    if (typeof l.name !== 'string' || !l.name.trim() || l.name.trim().length > LIMITS.name || /[\x00-\x1f\x7f]/.test(l.name)) throw fail('Listenname mit 1 bis ' + LIMITS.name + ' Zeichen angeben');
    let id = typeof l.id === 'string' && /^[a-z0-9]{1,16}$/.test(l.id) ? l.id : Math.random().toString(36).slice(2, 10);
    while (ids.has(id)) id += 'x'; ids.add(id);
    if (!Array.isArray(l.items) || l.items.length > LIMITS.items) throw fail('Höchstens ' + LIMITS.items + ' Geräte je Liste');
    const items = [...new Set(l.items.map(a => { if (typeof a !== 'string' || !ITEM.test(a)) throw fail('Gerät ungültig in „' + l.name.trim() + '“'); return a; }))];
    return { id, name: l.name.trim(), items };
  });
}
const decode = s => String(s).replace(/%([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
// Favoriten der alten OpenCCU lesen. Anzeigeprofile (PC, PDA, Zentrale, _USER…) und leere Listen werden ausgelassen;
// das CUxD-Wetter wird durch das neue Wetter (Open-Meteo) ersetzt.
async function fromCcu(web) {
  const connector = web.deps.getConnector?.();
  if (!connector || typeof connector.regaScript !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503);
  let data; try { data = JSON.parse(String(await connector.regaScript(SCRIPT, 8181)).trim()); } catch { throw fail('Favoriten der CCU nicht lesbar', 502); }
  const out = [];
  for (const l of Array.isArray(data?.lists) ? data.lists : []) {
    const name = decode(l.name || '').trim();
    if (!name || /^(PC|PDA|Zentrale|_USER\d+)$/i.test(name)) continue;
    const items = [...new Set((Array.isArray(l.items) ? l.items : []).filter(a => typeof a === 'string' && ITEM.test(a)).map(a => /^CUX90\d{5}:/.test(a) ? 'wetter' : a))];
    if (items.length) out.push({ name: name.slice(0, LIMITS.name), items: items.slice(0, LIMITS.items) });
  }
  return out;
}
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getFavoriten', 'saveFavoriten', 'importFavoriten'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    if (method === 'getFavoriten') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, { lists: stored(web) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const body = await require('./web-security').body(req);
    if (method === 'importFavoriten') {
      if (isObject(body) && Object.keys(body).length) throw fail('Ungültige Anfrage');
      const found = await fromCcu(web), have = stored(web);
      const merged = [...have, ...found.filter(f => !have.some(h => h.name === f.name))].slice(0, LIMITS.lists);
      const lists = normalize({ lists: merged }); web.writeConfigPatch(c => { c.favoriten = { lists }; });
      send(200, { success: true, lists, message: found.length ? found.length + ' Liste(n) aus der alten CCU übernommen' + (have.length ? ' (vorhandene Listen mit gleichem Namen blieben unverändert).' : '.') : 'In der alten CCU wurden keine Favoriten mit Geräten gefunden.' });
      return true;
    }
    const lists = normalize(body);
    web.writeConfigPatch(c => { c.favoriten = { lists }; });
    send(200, { success: true, lists, message: 'Favoriten gespeichert.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Favoriten: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, normalize, fromCcu, SCRIPT, LIMITS };
