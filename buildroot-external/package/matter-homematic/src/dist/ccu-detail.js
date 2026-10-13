'use strict';
// CCU3 im Detail (Wunsch Thomas, 13.10.2026; Gegenstück zu „WD im Detail“ auf der Seite Systemzustand):
// Speicher, SD-Karte (geschrieben seit Start), Temperatur, Auslastung, Arbeitsspeicher, Laufzeit, Firmware, Dienste, Funk-Auslastung.
// Nur lesen, nur lokale Dateien der CCU (/proc, /sys) und eine kurze Funkabfrage; Ergebnis 60 s zwischengespeichert (spart Last).
const fs = require('node:fs'), fsp = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const CACHE_MS = 60000;
let cache = { at: 0, value: null };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const read = (f, max = 65536) => { try { const s = fs.statSync(f); if (s.size > max) return null; return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const txt = (v, n = 120) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '';
async function disk(p) { try { const s = await fsp.statfs(p); const total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize); return total > 0 ? { gesamtMB: Math.round(total / 1048576), freiMB: Math.round(free / 1048576), belegtProzent: Math.round((1 - free / total) * 100) } : null; } catch { return null; } }
// Dienste: Prozessnamen aus /proc/<pid>/comm bzw. cmdline (ein Durchlauf, ohne Hilfsprogramme)
const DIENSTE = [['Logikschicht (ReGaHss)', /^ReGaHss/], ['Funk Homematic (rfd)', /^rfd$/], ['Homematic IP (HMIPServer)', /HMIPServer/], ['Webserver (lighttpd)', /^lighttpd$/], ['SSH (sshd)', /^sshd$/], ['Wächter (monit)', /^monit$/], ['Zeitplaner (crond)', /^crond$/], ['Fernzugang (Tailscale)', /tailscaled/], ['CUxD', /^cuxd$/], ['Matter-Bridge', /matter-homematic/]];
function prozesse() {
  const names = [];
  try { for (const pid of fs.readdirSync('/proc')) { if (!/^\d+$/.test(pid)) continue; const c = read('/proc/' + pid + '/comm', 4096); const l = read('/proc/' + pid + '/cmdline', 8192); names.push(((c || '').trim() + ' ' + (l || '').replace(/\0/g, ' ')).trim()); if (names.length > 2000) break; } } catch { return null; }
  return names;
}
async function dutyCycle(web) {
  try {
    const c = web.deps.getConnector?.(); if (!c || typeof c.rpcCall !== 'function') return null;
    const list = await Promise.race([c.rpcCall('BidCos-RF', 'listBidcosInterfaces', []), new Promise((_, r) => setTimeout(() => r(Error('Zeit')), 4000))]);
    const d = Array.isArray(list) ? list.map(x => num(x?.DUTY_CYCLE)).filter(v => v !== null) : [];
    return d.length ? Math.max(...d) : null;
  } catch { return null; }
}
async function sammeln(web, now = Date.now()) {
  const temp = num((read('/sys/class/thermal/thermal_zone0/temp') || '').trim());
  const mem = read('/proc/meminfo') || '', kb = k => { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(mem); return m ? Number(m[1]) : null; };
  const st = (read('/sys/block/mmcblk0/mmcblk0p3/stat') || '').trim().split(/\s+/), geschrieben = st.length > 6 ? Math.round(Number(st[6]) * 512 / 1048576) : null;
  const sdSektoren = num((read('/sys/block/mmcblk0/size') || '').trim());
  const ver = read('/VERSION') || read('/boot/VERSION') || '', fw = /VERSION=([^\s]+)/.exec(ver)?.[1] || txt(ver.split('\n')[0], 40);
  const produkt = /PRODUCT=([^\s]+)/.exec(ver)?.[1] || '';
  let bridge = ''; try { bridge = txt(fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8'), 40); } catch {}
  const p = prozesse();
  const uptime = os.uptime();
  return {
    erstellt: now, modell: !produkt || /^rpi3$|ccu3/i.test(produkt) ? 'CCU3' : produkt.replace(/_/g, ' '), // OpenCCU nennt die CCU3 „rpi3“
    speicher: { daten: await disk('/usr/local'), system: await disk('/'), ram: await disk('/tmp') },
    sd: { gesamtGB: sdSektoren ? Math.round(sdSektoren * 512 / 1e9 * 10) / 10 : null, geschriebenSeitStartMB: geschrieben },
    temperaturC: temp !== null ? Math.round(temp / 100) / 10 : null,
    last: os.loadavg().map(v => Math.round(v * 100) / 100), kerne: os.cpus().length || null,
    ramGesamtMB: kb('MemTotal') !== null ? Math.round(kb('MemTotal') / 1024) : null, ramFreiMB: kb('MemAvailable') !== null ? Math.round(kb('MemAvailable') / 1024) : null,
    laufzeitTage: Math.round(uptime / 86400 * 10) / 10, letzterNeustart: new Date(now - uptime * 1000).toISOString(),
    firmware: txt(fw, 40), bridge, bridgeSpeicherMB: Math.round(process.memoryUsage().rss / 1048576),
    dienste: p ? DIENSTE.map(([name, re]) => ({ name, laeuft: p.some(x => re.test(x.split(' ')[0]) || re.test(x)) })).filter(d => d.laeuft || !/CUxD|Tailscale/.test(d.name)) : [],
    dutyCycle: await dutyCycle(web),
    // Prüfpunkte des Wartungsscripts zur CCU3 (wie der Zustandsbericht der WD)
    punkte: (() => { try { return require('./systemzustand')._test.wartung(now).punkte.filter(x => x.bereich === 'CCU3').slice(0, 60); } catch { return []; } })()
  };
}
async function detail(web) { const now = Date.now(); if (cache.value && now - cache.at < CACHE_MS) return cache.value; const v = await sammeln(web, now); cache = { at: now, value: v }; return v; }
async function handle(web, req, res, u, auth) {
  if (u.pathname !== '/api/' || u.searchParams.get('method') !== 'getCcuDetail') return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass || (auth.session?.role && auth.session.role !== 'admin')) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
    send(200, await detail(web));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'CCU-Bericht nicht lesbar' }); }
  return true;
}
module.exports = { handle, _test: { sammeln, disk, DIENSTE, reset: () => { cache = { at: 0, value: null }; } } };
