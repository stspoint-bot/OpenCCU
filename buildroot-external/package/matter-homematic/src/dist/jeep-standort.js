'use strict';
// Jeep-Standort mit Karte (Wunsch Thomas, 12.10.2026) – nur lesen.
// - Standort: Uconnect „location/lastknown“ (wie die Jeep-App), höchstens alle 5 Minuten neu gefragt.
// - Adresse: OpenStreetMap Nominatim (kostenlos), nur bei neuem Standort, gemerkt.
// - Karte: Die Oberfläche darf keine fremden Bilder laden; die Bridge holt darum genau die 3×3 OpenStreetMap-Kacheln
//   rund um das Auto und reicht sie durch (kein offener Durchreicher: andere Kacheln werden abgelehnt), im Speicher gemerkt.
// - Nur nach Anmeldung als CCU-Administrator; der Standort wird nirgends gespeichert und nie ins Protokoll geschrieben.
const https = require('node:https');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const UA = 'CCU3-Matter-Bridge/0.21 (privat, ein Fahrzeug)';
const ZOOM = 16, TTL = 300000;
let cache = { vin: null, at: 0, value: null, pending: null };
const addresses = new Map(), tiles = new Map();
let fetcher = (url, binary) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'de' }, timeout: 8000 }, res => {
    const chunks = []; let size = 0;
    res.on('data', c => { size += c.length; if (size > 1048576) { req.destroy(Error('zu groß')); return; } chunks.push(c); });
    res.on('end', () => { if (res.statusCode !== 200) { reject(fail('Kartendienst antwortet nicht (' + res.statusCode + ')', 502)); return; } const b = Buffer.concat(chunks); if (binary) { resolve(b); return; } try { resolve(JSON.parse(b.toString('utf8'))); } catch { reject(fail('Ungültige Antwort', 502)); } });
  });
  req.on('timeout', () => req.destroy(fail('Zeitüberschreitung', 504))); req.on('error', e => reject(e.status ? e : fail('Kartendienst nicht erreichbar', 502)));
});
const num = v => { const n = typeof v === 'string' ? Number(v) : v; return typeof n === 'number' && Number.isFinite(n) ? n : null; };
// Uconnect-Antwort lesen (Feldnamen je nach Fahrzeug leicht verschieden)
function parse(d) {
  const o = d && typeof d === 'object' ? (d.location || d.lastKnownLocation || d) : {};
  const lat = num(o.latitude ?? o.lat), lon = num(o.longitude ?? o.lon ?? o.lng);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const t = num(o.timeStamp ?? o.timestamp ?? o.time) ?? Date.parse(o.timeStamp || o.timestamp || '');
  return { lat, lon, at: Number.isFinite(t) && t > 0 ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : null, approx: o.isLocationApprox === true };
}
const tileOf = (lat, lon, z = ZOOM) => { const n = 2 ** z, x = (lon + 180) / 360 * n, r = lat * Math.PI / 180, y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n; return { x, y }; };
async function address(lat, lon) {
  const k = lat.toFixed(4) + ',' + lon.toFixed(4); if (addresses.has(k)) return addresses.get(k);
  let text = '';
  try { const r = await fetcher('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6));
    const a = r?.address || {}; const street = [a.road || a.pedestrian || a.path, a.house_number].filter(Boolean).join(' '), place = [a.postcode, a.city || a.town || a.village || a.municipality].filter(Boolean).join(' ');
    text = [street, place].filter(Boolean).join(', ') || String(r?.display_name || '').split(',').slice(0, 3).join(',').trim(); } catch {}
  text = text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 160);
  if (addresses.size > 50) addresses.delete(addresses.keys().next().value); addresses.set(k, text); return text;
}
async function standort(web, vin, fresh, now = Date.now()) {
  const svc = web.jeepService; if (!svc?.connected || typeof svc.client?.location !== 'function') throw fail('Jeep ist nicht verbunden. Bitte zuerst auf der Jeep-Seite anmelden.', 409);
  const row = (svc.rows || []).find(r => !vin || r.vin === vin); if (!row) throw fail('Fahrzeug gehört nicht zum angemeldeten Jeep-Konto', 404);
  if (cache.pending && cache.vin === row.vin) return cache.pending;
  if (cache.value && cache.vin === row.vin && now - cache.at < (fresh ? 60000 : TTL)) return cache.value;
  cache = { ...cache, vin: row.vin, pending: (async () => {
    let d; try { d = await svc.client.location(row.vin); } catch (e) { throw fail('Standort nicht abrufbar' + (e.upstreamStatus ? ' (HTTP ' + e.upstreamStatus + ')' : ''), 502); }
    const p = parse(d); if (!p) throw fail('Uconnect liefert gerade keinen Standort', 404);
    const t = tileOf(p.lat, p.lon), k = p.lat.toFixed(4) + ',' + p.lon.toFixed(4);
    const v = { ...p, address: addresses.get(k) || '', map: { zoom: ZOOM, x: Math.floor(t.x), y: Math.floor(t.y), px: Math.round((t.x - Math.floor(t.x)) * 256), py: Math.round((t.y - Math.floor(t.y)) * 256) }, readAt: new Date(now).toISOString() };
    // Schneller (Thomas: „Karte dauert ewig“): Adresse und die 9 Kacheln im Hintergrund holen – der Standort kommt sofort zurück,
    // die Kacheln liegen bereit, bevor das Handy sie anfragt; die Adresse steht beim nächsten Abruf (oder 2 s später) da.
    if (!v.address) address(p.lat, p.lon).then(a => { v.address = a; }).catch(() => {}); // v ist dasselbe Objekt wie im Speicher
    setTimeout(() => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tile(v.map.x + dx, v.map.y + dy).catch(() => {}); }, 0);
    return v;
  })() };
  try { const v = await cache.pending; cache = { vin: row.vin, at: now, value: v, pending: null }; return v; } catch (e) { cache = { ...cache, pending: null }; throw e; }
}
async function tile(x, y) {
  const m = cache.value?.map; if (!m || !Number.isInteger(x) || !Number.isInteger(y) || Math.abs(x - m.x) > 1 || Math.abs(y - m.y) > 1) throw fail('Kachel nicht freigegeben', 403);
  const k = ZOOM + '/' + x + '/' + y; if (tiles.has(k)) return tiles.get(k);
  const b = await fetcher('https://tile.openstreetmap.org/' + k + '.png', true);
  if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) throw fail('Ungültige Kachel', 502);
  if (tiles.size >= 27) tiles.delete(tiles.keys().next().value); tiles.set(k, b); return b;
}
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getJeepStandort', 'getJeepKarte'].includes(method)) return false;
  try {
    if (!auth || auth.session?.localBypass) throw fail('Nur nach Anmeldung als CCU-Administrator möglich', 403);
    if (req.method !== 'GET') throw fail('GET erforderlich', 405);
    if (method === 'getJeepStandort') { web.sendJson(res, 200, await standort(web, u.searchParams.get('vin') || null, u.searchParams.get('neu') === '1')); return true; }
    const b = await tile(Number(u.searchParams.get('x')), Number(u.searchParams.get('y')));
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': b.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' }); res.end(b);
  } catch (e) { web.sendJson(res, e.status || 500, { error: e.status ? e.message : 'Standort: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, standort, tile, parse, tileOf, _test: { reset() { cache = { vin: null, at: 0, value: null, pending: null }; addresses.clear(); tiles.clear(); }, setFetcher(f) { fetcher = f; } } };
