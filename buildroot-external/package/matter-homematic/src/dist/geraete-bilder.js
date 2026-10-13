'use strict';
// Gerätebilder wie in der alten CCU-Oberfläche (Wunsch Thomas, 11.10.2026) für die Geräteliste.
// Gelesen wird nur aus dem Dateisystem der CCU: Zuordnung Gerätetyp → Bild aus DEVDB.tcl, Bilder (50 px) aus
// /www/config/img/devices/50. Nur angemeldete Benutzer (der Aufruf kommt erst nach der Anmeldeprüfung hierher),
// nur Dateinamen aus diesem einen Ordner, nur PNG.
const fs = require('fs'), path = require('path');
const paths = { devdb: '/www/config/devdescr/DEVDB.tcl', dir: '/www/config/img/devices/50' };
const FILE = /^[A-Za-z0-9_.+-]{1,80}\.png$/, ADDRESS = /^[A-Za-z0-9_-]{1,64}$/;
let map = null;
function typeMap() {
  if (map) return map;
  const m = new Map();
  try {
    const text = fs.readFileSync(paths.devdb, 'utf8');
    const re = /([A-Za-z0-9_.+-]+) \{\{50 \/config\/img\/devices\/50\/([A-Za-z0-9_.+-]+\.png)\}/g;
    let x; while ((x = re.exec(text))) if (!m.has(x[1].toLowerCase()) && FILE.test(x[2])) m.set(x[1].toLowerCase(), x[2]);
  } catch {}
  if (m.size) map = m; // bei Lesefehler später erneut versuchen
  return m;
}
function icons(web) {
  const out = {}, m = typeMap();
  let devices = null; try { devices = web.deps.getConnector()?.getDevices?.(); } catch {}
  if (devices && typeof devices[Symbol.iterator] === 'function') for (const [address, d] of devices) {
    const file = typeof d?.type === 'string' ? m.get(d.type.toLowerCase()) : null;
    if (file && typeof address === 'string' && ADDRESS.test(address)) out[address] = file;
  }
  return out;
}
async function handle(web, req, res, u, auth) {
  const mine = u.pathname.startsWith('/geraet-bild/') || (u.pathname === '/api/' && u.searchParams.get('method') === 'getDeviceIcons');
  if (!mine) return false;
  if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
  if (u.pathname.startsWith('/geraet-bild/')) {
    const name = u.pathname.slice('/geraet-bild/'.length);
    if (req.method !== 'GET' || !FILE.test(name)) { res.writeHead(404); res.end(); return true; }
    let data; try { data = fs.readFileSync(path.join(paths.dir, name)); } catch { res.writeHead(404); res.end(); return true; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.end(data); return true;
  }
  if (u.pathname === '/api/' && u.searchParams.get('method') === 'getDeviceIcons') {
    if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
    web.sendJson(res, 200, { icons: icons(web) }); return true;
  }
  return false;
}
module.exports = { handle, icons, _test: { paths, reset: () => { map = null; } } };
