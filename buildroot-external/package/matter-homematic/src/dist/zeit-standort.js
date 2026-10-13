'use strict';
// Zeit & Standort (Wunsch Thomas, 12.10.2026): ersetzt „Zeit-/Positionseinstellung“ der alten OpenCCU.
// Gleiche Dateien und Schritte wie OpenCCU (cp_time.cgi): /etc/config/time.conf, /etc/config/TZ + /bin/updateTZ.sh,
// Standort zusätzlich an ReGa (system.Longitude/Latitude), Uhr an die Funkmodule (SetInterfaceClock), NTP-Server in
// /etc/config/ntpclient (+ setclock). Sonnenauf-/untergang berechnet die Bridge selbst (unabhängig von ReGa).
// Der Standort ist privat: nur für CCU-Administratoren, nie protokolliert. Sicherung vor jeder Änderung.
const fs = require('node:fs'), { execFile } = require('node:child_process');
const DEFAULT_PATHS = Object.freeze({ time: '/etc/config/time.conf', tz: '/etc/config/TZ', ntp: '/etc/config/ntpclient', zoneinfo: '/usr/share/zoneinfo', updateTz: '/bin/updateTZ.sh', hwclock: '/sbin/hwclock', setInterfaceClock: '/bin/SetInterfaceClock', setclock: '/bin/setclock' });
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const paths = web => ({ ...DEFAULT_PATHS, ...(web?.deps?.timePaths || {}) });
const TZ_NAME = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}$/, HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/;
// Nur Namenszeichen (Sicherheitsdurchgang 13.10.2026): time.conf kann von Shell-Skripten der CCU eingelesen werden – daher
// auch kein $, `, ;, & oder | (vorher nur Anführungszeichen/Steuerzeichen gesperrt).
const TEXT = /^[\p{L}\p{M}\p{N} .,()\/-]{0,64}$/u;

function readTime(file) {
  let t = ''; try { t = fs.readFileSync(file, 'latin1'); } catch {}
  const get = k => { const m = new RegExp('^\\s*' + k + "\\s*=\\s*'?([^'\\n]*)'?\\s*$", 'm').exec(t); return m ? m[1].trim() : ''; };
  const lat = Number(get('LATITUDE')), lon = Number(get('LONGITUDE'));
  const ok = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  return { country: get('COUNTRY'), city: get('CITY'), lat: ok ? lat : null, lon: ok ? lon : null, timezone: get('TIMEZONE') };
}
function readNtp(file) { try { const m = /^\s*NTPSERVERS\s*=\s*'?([^'\n]*)'?\s*$/m.exec(fs.readFileSync(file, 'latin1')); return m ? m[1].trim().split(/\s+/).filter(h => HOST.test(h)) : []; } catch { return []; } }

// Sonnenauf-/untergang (Sonnenaufgangsgleichung, Genauigkeit etwa 1 Minute); Ergebnis als Zeitpunkte (ms) oder null (Polartag/-nacht).
function sunTimes(date, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const rad = Math.PI / 180, J = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12) / 86400000 + 2440587.5;
  const n = Math.ceil(J - 2451545.0 + 0.0008), Js = n - lon / 360;
  const M = (357.5291 + 0.98560028 * Js) % 360, C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360, Jt = 2451545.0 + Js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const sinD = Math.sin(L * rad) * Math.sin(23.4397 * rad), cosD = Math.cos(Math.asin(sinD));
  const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * sinD) / (Math.cos(lat * rad) * cosD);
  if (cosW < -1 || cosW > 1) return null;
  const w = Math.acos(cosW) / rad, ms = j => Math.round((j - 2440587.5) * 86400000);
  return { rise: ms(Jt - w / 360), set: ms(Jt + w / 360) };
}
// Für die Automationen: Minuten nach Mitternacht (Ortszeit) oder null, wenn kein Standort eingetragen ist.
function sunMinutes(web, now = Date.now()) {
  const loc = readTime(paths(web).time); const s = sunTimes(new Date(now), loc.lat, loc.lon); if (!s) return null;
  const min = t => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
  const rise = min(s.rise), set = min(s.set); return rise < set ? { rise, set } : null;
}

function status(web) {
  const p = paths(web), loc = readTime(p.time), now = new Date(), sun = sunTimes(now, loc.lat, loc.lon);
  const hm = t => t == null ? null : new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return { now: now.toISOString(), localTime: now.toLocaleString('de-DE'), timezone: loc.timezone, country: loc.country, city: loc.city, lat: loc.lat, lon: loc.lon,
    ntpServers: readNtp(p.ntp), sun: sun ? { rise: hm(sun.rise), set: hm(sun.set) } : null, sync: syncState };
}
let syncState = null;
const run = (file, args = [], input) => new Promise(resolve => { const c = execFile(file, args, { timeout: 20000 }, (e, out) => resolve(e ? null : String(out))); if (input !== undefined) c.stdin.end(input); });
async function refreshSync(web) { const out = await (web?.deps?.timeRun || run)('/usr/bin/chronyc', ['tracking']); if (!out) { syncState = null; return; } const m = /System time\s*:\s*([\d.]+) seconds (slow|fast)/.exec(out), r = /Reference ID\s*:\s*\S+\s*\(([^)]*)\)/.exec(out); syncState = { offsetMs: m ? Math.round(Number(m[1]) * 100000) / 100 : null, source: r ? r[1].slice(0, 80) : '' }; }

function backup(file) { try { fs.copyFileSync(file, file + '.vor-' + new Date().toISOString().replace(/[:.]/g, '-')); } catch {} }
function writeAtomic(file, text) { const tmp = file + '.neu-' + process.pid; fs.writeFileSync(tmp, text, { encoding: 'latin1', mode: 0o644 }); try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } }

async function saveLocation(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['timezone', 'country', 'city', 'lat', 'lon'].includes(k))) throw fail('Unerwartete Angaben');
  const P = paths(web);
  if (typeof p.timezone !== 'string' || !TZ_NAME.test(p.timezone) || p.timezone.includes('..') || !fs.existsSync(P.zoneinfo + '/' + p.timezone)) throw fail('Zeitzone unbekannt (z. B. Europe/Berlin)');
  for (const k of ['country', 'city']) if (typeof p[k] !== 'string' || !TEXT.test(p[k])) throw fail((k === 'city' ? 'Ort' : 'Land') + ': höchstens 64 Zeichen, keine Anführungszeichen');
  if (typeof p.lat !== 'number' || !Number.isFinite(p.lat) || Math.abs(p.lat) > 90) throw fail('Breitengrad -90 bis 90');
  if (typeof p.lon !== 'number' || !Number.isFinite(p.lon) || Math.abs(p.lon) > 180) throw fail('Längengrad -180 bis 180');
  const lat = Math.round(p.lat * 1e6) / 1e6, lon = Math.round(p.lon * 1e6) / 1e6;
  backup(P.time); backup(P.tz);
  writeAtomic(P.time, 'COUNTRY=' + p.country.trim() + '\nCITY=' + p.city.trim() + '\nLATITUDE=' + lat + '\nLONGITUDE=' + lon + '\nTIMEZONE=' + p.timezone + '\n');
  writeAtomic(P.tz, p.timezone + '\n');
  const r = web?.deps?.timeRun || run;
  await r(P.updateTz);
  // ReGa bekommt den Standort weiter (alte Oberfläche, Programme der CCU); Zahlen sind geprüft.
  try { const c = web.deps.getConnector?.(); if (c?.regaScript) await c.regaScript('! MH_ZEIT_STANDORT\nvar x=system.Longitude(' + lon + ');var y=system.Latitude(' + lat + ');var a=dom.ChangedTimeManually();Write("MH_OK");', 8181); } catch {}
  await r(P.hwclock, ['-wu']); await r(P.setInterfaceClock, ['127.0.0.1:2001']);
  return { success: true, ...status(web), message: 'Zeitzone und Standort gespeichert. Die Sonnenzeiten werden ab jetzt daraus berechnet.' };
}
async function saveNtp(web, p) {
  if (!isObject(p) || Object.keys(p).length !== 1 || !Array.isArray(p.servers)) throw fail('Zeitserver angeben');
  const servers = [...new Set(p.servers.map(s => typeof s === 'string' ? s.trim() : ''))].filter(Boolean);
  if (!servers.length || servers.length > 8) throw fail('1 bis 8 Zeitserver angeben');
  for (const s of servers) if (!HOST.test(s)) throw fail('„' + s.slice(0, 60) + '“ ist kein gültiger Servername');
  const P = paths(web); backup(P.ntp);
  writeAtomic(P.ntp, "NTPSERVERS='" + servers.join(' ') + "'\n");
  await (web?.deps?.timeRun || run)(P.setclock, ['noloop']);
  return { success: true, ...status(web), message: 'Zeitserver gespeichert.' };
}
let busy = false;
const POST = { saveZeitStandort: saveLocation, saveZeitserver: saveNtp };
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (method !== 'getZeitStandort' && !Object.hasOwn(POST, method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (!fs.existsSync(paths(web).time) && !web?.deps?.timePaths) { send(501, { error: 'Auf diesem System gibt es keine CCU-Zeiteinstellung' }); return true; }
    if (method === 'getZeitStandort') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } await refreshSync(web).catch(() => {}); send(200, status(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (busy) { send(429, { error: 'Eine Änderung läuft bereits' }); return true; }
    busy = true; try { send(200, await POST[method](web, p)); } finally { busy = false; }
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Zeit & Standort: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, sunTimes, sunMinutes, readTime, _test: { readNtp, status, HOST, TZ_NAME } };
