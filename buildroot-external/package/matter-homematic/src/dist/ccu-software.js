'use strict';
// OpenCCU-Wartung (Wunsch Thomas, 12.10.2026): ersetzt „OpenCCU Software“ und „Herunterfahren“ der alten Wartungsseite.
// - Software-Stand: installierte und verfügbare Version über das Prüfskript der CCU (/bin/checkFirmwareUpdate.sh, online bei
//   openccu.de, kostenlos, höchstens alle 6 Stunden).
// - Update: nur auf ausdrücklichen Klick eines Administrators; das Skript legt vorher eine CCU-Sicherung (.sbk) an (-b)
//   und startet danach neu (-r). Nie automatisch, nie wiederholt.
// - Herunterfahren: nur auf Klick (danach Strom aus/an zum Starten).
// Abgesicherter Modus / Recovery und Protokollstufen werden bewusst nicht angeboten (Notfall per SSH).
const fs = require('node:fs'), { execFile } = require('node:child_process');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const SCRIPT = '/bin/checkFirmwareUpdate.sh';
const run = (file, args, timeout) => new Promise(ok => execFile(file, args, { timeout }, (e, out) => ok({ code: e ? (Number.isInteger(e.code) ? e.code : 99) : 0, out: String(out || '') })));
let cache = { at: 0, value: null }, busy = false, started = 0;
const runner = web => web.deps?.softwareRun || run;
function parse(out, code) {
  const inst = /Installed version:\s*([0-9.]+)\s*(?:\(([^)]*)\))?/.exec(out), latest = /Latest version\.*:\s*([0-9.]+)/.exec(out);
  return { installed: inst ? inst[1] : '', platform: inst?.[2] || '', latest: latest ? latest[1] : '', updateAvailable: code === 1, checkedAt: new Date().toISOString(), ok: !!inst && code <= 1 };
}
async function status(web, fresh) {
  if (!fresh && cache.value && Date.now() - cache.at < 6 * 3600000) return cache.value;
  if (!fs.existsSync(web.deps?.softwareScript || SCRIPT)) throw fail('Auf diesem System gibt es keine OpenCCU-Update-Prüfung', 501);
  const r = await runner(web)(web.deps?.softwareScript || SCRIPT, [], 45000), v = parse(r.out, r.code);
  if (!v.ok) { v.error = 'Update-Prüfung nicht möglich (Internet?)'; }
  cache = { at: Date.now(), value: v }; return v;
}
async function update(web) {
  if (Date.now() - started < 3600000) throw fail('Das Update wurde gerade gestartet – die Zentrale startet gleich neu', 409);
  const s = await status(web, true);
  if (!s.updateAvailable) throw fail('Keine neue OpenCCU-Version verfügbar', 409);
  started = Date.now();
  // Im Hintergrund: Sicherung (-b), Update anwenden (-a), Neustart (-r). Die Verbindung bricht dabei ab.
  Promise.resolve().then(() => runner(web)(web.deps?.softwareScript || SCRIPT, ['-a', '-b', '-r'], 3600000)).catch(() => {});
  return { success: true, message: 'OpenCCU-Update auf ' + s.latest + ' gestartet. Vorher wird eine Sicherung angelegt; danach startet die Zentrale neu (ca. 10–20 Minuten). Nicht vom Strom trennen.' };
}
async function shutdown(web) {
  Promise.resolve().then(() => runner(web)(web.deps?.poweroff || '/sbin/poweroff', [], 60000)).catch(() => {});
  return { success: true, message: 'Die Zentrale fährt herunter. Zum Starten kurz vom Strom trennen und wieder verbinden.' };
}
const isAdmin = auth => !!auth && !auth.session?.localBypass && (!auth.session?.role || auth.session.role === 'admin');
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getCcuSoftware', 'startCcuUpdate', 'shutdownCcuNow'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!isAdmin(auth)) { send(403, { error: 'Nur nach Anmeldung als Administrator möglich' }); return true; }
    if (method === 'getCcuSoftware') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await status(web, u.searchParams.get('neu') === '1')); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!p || typeof p !== 'object' || p.bestaetigt !== true || Object.keys(p).length !== 1) throw fail('Bitte ausdrücklich bestätigen');
    if (busy) { send(429, { error: 'Läuft bereits' }); return true; }
    busy = true; try { send(200, await (method === 'startCcuUpdate' ? update : shutdown)(web)); } finally { busy = false; }
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Wartung: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, _test: { parse, reset: () => { cache = { at: 0, value: null }; busy = false; started = 0; } } };
