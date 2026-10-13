'use strict';
// Verlaufsdaten (für Diagramme) aufzeichnen und optional auf einem Netzwerkspeicher (z. B. WD
// My Cloud, SMB-Freigabe) ablegen. Läuft im Bridge-Prozess auf der CCU3; nutzt nur Node-Bordmittel
// und das in OpenCCU enthaltene mount.cifs. Das Passwort liegt verschlüsselt im Schlüsselspeicher
// und wird nur kurz als Datei mit Rechten 0600 an mount übergeben (nie auf der Befehlszeile).
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const SHARE = /^[A-Za-z0-9 _.-]{1,80}$/;
const FOLDER = /^[A-Za-z0-9_.-]{1,64}$/;
const KEEP_DAYS = 14; let MOUNT = '/media/ccu3-netzspeicher';
// Suchpfad mit /sbin (12.10.2026): Die Bridge läuft mit PATH ohne /sbin. Ohne /sbin/mount.cifs bindet busybox-mount direkt über
// den Kern ein, der „credentials=“ nicht kennt – es geht kein Passwort mit und die WD antwortet „Permission denied“ (13).
const execEnv = () => ({ ...process.env, PATH: '/sbin:/usr/sbin:' + (process.env.PATH || '/usr/bin:/bin') });
let exec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 20000, env: execEnv() }, (e, out, err) => e ? reject(Object.assign(e, { stderr: String(err || '') })) : resolve(String(out))));
let platform = process.platform;
const state = { timer: null, web: null, lastSample: null, lastSync: null, lastError: null, mounted: false, busy: false, authFailAt: 0, forceMount: false };
let readMounts = () => { try { return fs.readFileSync('/proc/mounts', 'utf8'); } catch { return ''; } };

const dataDir = web => path.dirname(web.deps.configPath);
const historyDir = web => path.join(dataDir(web), 'verlauf');
function vault(web) { const { Vault } = require('./smartplus'); return new Vault(path.join(dataDir(web), 'netzspeicher-secrets.json')); }
function secret(web) { try { return vault(web).read(); } catch { return {}; } }
const ADDR = /^[A-Za-z0-9@:_.-]{1,96}$/;
function recordOff(web) { try { const r = web.security.configSnapshot.read().netzspeicher?.recordOff; return r && typeof r === 'object' && !Array.isArray(r) ? r : {}; } catch { return {}; } }
function settings(web) {
  const c = web.security.configSnapshot.read().netzspeicher || {};
  return { enabled: c.enabled === true, host: c.host || '', share: c.share || '', folder: c.folder || 'ccu3', user: c.user || '', intervalMinutes: Number.isInteger(c.intervalMinutes) ? c.intervalMinutes : 10, recordLocal: c.recordLocal !== false };
}
const day = d => d.toISOString().slice(0, 10);

// ---------- Aufzeichnung ----------
// Messwerte je Gerät aus dem Gerätezustand der Bridge ableiten (nur Zahlen).
function metrics(d, values) {
  const s = d.currentState || {}, out = [];
  // Direkt vom Gerät (CCU-Werte), wenn der Matter-Zustand fehlt – z. B. Wandthermostat HmIP-WTH-2: Luftfeuchte steht nur dort
  // (Thomas 12.10.2026: „Wandthermostat zum Aufzeichnen markiert, aber nicht in den Diagrammen“)
  const v = values && typeof values === 'object' ? values : {}, fin = Number.isFinite;
  const addHm = () => {
    if (!out.some(o => o[0] === 'Temperatur') && fin(v.ACTUAL_TEMPERATURE)) out.push(['Temperatur', Math.round(v.ACTUAL_TEMPERATURE * 10) / 10, '°C']);
    if (!out.some(o => o[0] === 'Luftfeuchte') && fin(v.HUMIDITY)) out.push(['Luftfeuchte', v.HUMIDITY, '%']);
    if (!out.some(o => o[0] === 'Solltemperatur') && fin(v.SET_POINT_TEMPERATURE)) out.push(['Solltemperatur', v.SET_POINT_TEMPERATURE, '°C']);
  };
  if (Number.isFinite(s.localTemperature)) out.push(['Temperatur', s.localTemperature / 100, '°C']);
  if (Number.isFinite(s.occupiedHeatingSetpoint)) out.push(['Solltemperatur', s.occupiedHeatingSetpoint / 100, '°C']);
  if (Number.isFinite(s.measuredValue)) { const hum = /humid/i.test(d.matterDeviceType || ''); out.push([hum ? 'Luftfeuchte' : 'Messwert', s.measuredValue / 100, hum ? '%' : '']); }
  if (Number.isFinite(s.temperature)) out.push(['Temperatur', s.temperature, '°C']);
  if (Number.isFinite(s.humidity)) out.push(['Luftfeuchte', s.humidity, '%']);
  if (Number.isFinite(s.currentLevel)) out.push(['Helligkeit', Math.round(s.currentLevel / 254 * 100), '%']);
  else if (typeof s.onOff === 'boolean') out.push(['Ein/Aus', s.onOff ? 1 : 0, '']);
  else if (typeof s.on === 'boolean') out.push(['Ein/Aus', s.on ? 1 : 0, '']);
  if (d.provider === 'jeep' && Number.isFinite(Number(s.value))) out.push([d.matterDeviceType || 'Wert', Number(s.value), s.unit || '']);
  // Stromverbrauch (z. B. Tasmota-Steckdosen mit Messung)
  if (Number.isFinite(s.power)) out.push(['Leistung', s.power, 'W']);
  if (Number.isFinite(s.energyToday)) out.push(['Energie heute', s.energyToday, 'kWh']);
  if (Number.isFinite(s.energyTotal)) out.push(['Zählerstand', s.energyTotal, 'kWh']);
  if (Number.isFinite(s.windKmh)) out.push(['Wind', s.windKmh, 'km/h']);
  if (Number.isFinite(s.pressureHpa)) out.push(['Luftdruck', s.pressureHpa, 'hPa']);
  if (Number.isFinite(s.rainMm)) out.push(['Niederschlag', s.rainMm, 'mm']);
  if (Number.isFinite(s.voltage)) out.push(['Spannung', s.voltage, 'V']);
  if (Number.isFinite(s.current)) out.push(['Strom', s.current, 'A']);
  addHm();
  return out;
}
const csv = v => { const t = String(v ?? ''); return /[;"\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
function sample(web) {
  const now = new Date(), list = recordable(web).filter(d => !recordOff(web)[d.address]);
  let channels = new Map(); try { channels = web.deps.getConnector?.()?.getChannels?.() || new Map(); } catch {}
  const lines = [];
  for (const d of list) for (const [metric, value, unit] of metrics(d, channels.get(d.address)?.paramsets?.VALUES)) lines.push([now.toISOString(), d.address, d.name || d.address, d.room || '', metric, value, unit].map(csv).join(';'));
  return { at: now, lines };
}
// Alle Einträge, die es derzeit gibt (CCU-Geräte, Tasmota, WLAN-Geräte, Wetter) – auch für das Diagramm-Archiv
function recordable(web) {
  const base = web.getDevices?.().devices || [], seen = new Set(base.map(d => d.address));
  // Tasmota-Geräte immer mit aufzeichnen (auch ohne Apple-Home-Freigabe), damit der Stromverbrauch im Diagramm erscheint.
  let tasmota = []; try { tasmota = require('./tasmota').rows(web).filter(d => !seen.has(d.address)); } catch {}
  // Steckdose gehört zu einem CUxD-Gerät: nur Leistung/Energie unter dessen Adresse und Namen (kein doppeltes Ein/Aus).
  tasmota = tasmota.map(d => { const cux = d.cuxd && base.find(b => b.address === d.cuxd.address + ':1'); if (!cux) return d; const s = d.currentState || {}; return { address: cux.address, name: cux.name, room: cux.room, exposed: true, currentState: { power: s.power, energyToday: s.energyToday, energyTotal: s.energyTotal, voltage: s.voltage, current: s.current } }; });
  // WLAN-Fühler und -Geräte (Smart Life, SMART+, Dyson) ebenfalls aufzeichnen, z. B. einen Außenfühler.
  let wifi = []; try { wifi = require('./wifi-devices').rows(web).filter(d => !seen.has(d.address)); } catch {}
  // Wetter (Open-Meteo) als eigener Eintrag „Wetter“
  let wetter = []; try { const r = require('./wetter').historyRow(web); if (r) wetter = [r]; } catch {}
  // „Aufzeichnen“ gilt unabhängig von der Apple-Home-Freigabe (vorher fehlten nicht freigegebene Geräte, z. B. Wandthermostat Bad);
  // Geräte, bei denen „Aufzeichnen“ ausgeschaltet ist (Geräteseite), überspringt sample().
  return [...base, ...tasmota, ...wifi, ...wetter];
}
function appendLocal(web, rows) {
  const dir = historyDir(web); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, day(rows.at) + '.csv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'Zeit;Adresse;Gerät;Raum;Messgröße;Wert;Einheit\n', { mode: 0o600 });
  if (rows.lines.length) fs.appendFileSync(file, rows.lines.join('\n') + '\n');
  // Nur die letzten 14 Tage lokal behalten (Flash der CCU schonen).
  const cutoff = day(new Date(Date.now() - KEEP_DAYS * 86400000));
  for (const f of fs.readdirSync(dir)) if (/^\d{4}-\d\d-\d\d\.csv$/.test(f) && f.slice(0, 10) < cutoff) fs.rmSync(path.join(dir, f), { force: true });
}

// ---------- Netzwerkspeicher (SMB/CIFS) ----------
function tcp(host, port, timeout = 4000) {
  return new Promise(resolve => { let done = false, s; const end = ok => { if (done) return; done = true; try { s && s.destroy(); } catch {} resolve(ok); };
    try { s = net.createConnection({ host, port, timeout }); s.on('connect', () => end(true)); s.on('timeout', () => end(false)); s.on('error', () => end(false)); } catch { end(false); } });
}
// Verständliche Meldung statt der rohen Systemmeldung (die technische Ursache steht dahinter in Klammern).
function mountHint(cfg, raw) {
  const why = raw.slice(0, 160);
  if (/No such file or directory|ENOENT/i.test(raw)) return 'Die Freigabe „' + cfg.share + '“ gibt es auf ' + cfg.host + ' nicht. Bitte den Namen genau wie auf dem Netzwerkspeicher eintragen (z. B. „ccu3-sicherung“, auf Groß-/Kleinschreibung achten). (' + why + ')';
  if (/Permission denied|EACCES|Operation not permitted|EPERM/i.test(raw)) return 'Benutzer oder Passwort werden vom Netzwerkspeicher nicht angenommen, oder dieser Benutzer darf die Freigabe „' + cfg.share + '“ nicht benutzen. (' + why + ')';
  if (/Host is down|No route|timed out|ETIMEDOUT|EHOSTUNREACH|Connection refused/i.test(raw)) return 'Der Netzwerkspeicher unter ' + cfg.host + ' antwortet nicht. Adresse prüfen und ob er eingeschaltet ist. (' + why + ')';
  return 'Freigabe konnte nicht eingebunden werden: ' + raw.slice(0, 200);
}
async function mount(web, cfg, pass) {
  if (platform !== 'linux') throw fail('Netzwerkspeicher kann nur auf der CCU eingebunden werden (hier Testumgebung).', 501);
  if (state.mounted) return;
  // Nach einem Bridge-Neustart weiß der Speicher nichts mehr vom Einhängen (Chat1 12.10.2026: Freigabe war ZWEIMAL eingehängt):
  // steht MOUNT schon in /proc/mounts, zuerst lösen und frisch einhängen (sonst stapeln sich die Einhängungen).
  try { if (readMounts().split('\n').some(l => l.split(' ')[1] === MOUNT)) { for (let i = 0; i < 20; i++) { try { await exec('umount', ['-l', MOUNT]); } catch { break; } if (!readMounts().split('\n').some(l => l.split(' ')[1] === MOUNT)) break; } } } catch {}
  // Wurden Benutzer/Passwort abgelehnt (-13), nicht alle paar Minuten erneut versuchen (füllt das Kernel-Protokoll):
  // erst nach 6 Stunden oder nach „Speichern“/„Verbindung testen“ wieder.
  if (state.authFailAt && Date.now() - state.authFailAt < 6 * 3600000 && !state.forceMount) throw fail('Die WD hat Benutzer oder Passwort zuletzt abgelehnt – bitte unter „WD (Netzwerkspeicher) verbinden“ prüfen und speichern.', 502);
  fs.mkdirSync(MOUNT, { recursive: true, mode: 0o700 });
  const cred = path.join(dataDir(web), '.netzspeicher-cred');
  fs.writeFileSync(cred, `username=${cfg.user}\npassword=${pass}\n`, { mode: 0o600 });
  try {
    let last;
    for (const vers of ['3.0', '2.1']) { // WD My Cloud: SMB 3 oder 2.1
      try { await exec('mount', ['-t', 'cifs', `//${cfg.host}/${cfg.share}`, MOUNT, '-o', `credentials=${cred},vers=${vers},iocharset=utf8,uid=0,gid=0,file_mode=0600,dir_mode=0700,noserverino,soft,nounix`]); state.mounted = true; state.authFailAt = 0; state.forceMount = false; return; }
      catch (e) { last = e; if (/Permission denied|EACCES|-13\b/i.test(String(e.stderr || e.message || ''))) break; } // Anmeldung abgelehnt: andere SMB-Version hilft nicht
    }
    const raw = ((last && (last.stderr || last.message)) || 'unbekannt').trim();
    if (/Permission denied|EACCES|-13\b/i.test(raw)) state.authFailAt = Date.now();
    state.forceMount = false;
    throw fail(mountHint(cfg, raw), 502);
  } finally { fs.rmSync(cred, { force: true }); }
}
async function unmount() { if (!state.mounted) return; try { await exec('umount', ['-l', MOUNT]); } catch {} state.mounted = false; }
async function syncRemote(web, rows) {
  const cfg = settings(web), pass = secret(web).password || '';
  if (!cfg.enabled || !cfg.host || !cfg.share) return;
  await mount(web, cfg, pass);
  const dir = path.join(MOUNT, cfg.folder, 'verlauf'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, day(rows.at) + '.csv');
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'Zeit;Adresse;Gerät;Raum;Messgröße;Wert;Einheit\n');
  if (rows.lines.length) fs.appendFileSync(file, rows.lines.join('\n') + '\n');
  state.lastSync = new Date().toISOString();
}
// ---------- Sicherungen auf dem Netzwerkspeicher ----------
// Eine fertige (verschlüsselte) Sicherungsdatei nach <Unterordner>/sicherungen kopieren und danach vollständig
// zurücklesen und vergleichen. Es bleiben die neuesten KEEP_BACKUPS Dateien je Art; ältere werden entfernt.
const KEEP_BACKUPS = 10;
function backupReady(web) { const cfg = settings(web); return !!(cfg.host && cfg.share && cfg.user); }
async function storeBackup(web, src, name) {
  const cfg = settings(web), pass = secret(web).password || '';
  if (!backupReady(web)) throw fail('Zuerst unter System → Netzwerkspeicher (WD) Adresse, Freigabe und Benutzer eintragen.', 409);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name)) throw fail('Ungültiger Dateiname der Sicherung');
  const crypto = require('node:crypto'), hash = f => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });
  while (state.busy) await new Promise(r => setTimeout(r, 200));
  state.busy = true;
  try {
    await mount(web, cfg, pass);
    const dir = path.join(MOUNT, cfg.folder, 'sicherungen'); fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name), tmp = target + '.teil';
    await fs.promises.copyFile(src, tmp);
    const [a, b] = await Promise.all([hash(src), hash(tmp)]);
    if (a !== b) { fs.rmSync(tmp, { force: true }); throw fail('Die Kopie auf dem Netzwerkspeicher ist nicht vollständig. Bitte erneut versuchen.', 502); }
    fs.renameSync(tmp, target);
    // Aufräumen: je Art (Name ohne Zeitstempel) nur die neuesten Dateien behalten.
    const kind = n => n.replace(/\d{14}/, '#');
    const same = fs.readdirSync(dir).filter(n => kind(n) === kind(name) && /\d{14}/.test(n)).sort();
    for (const old of same.slice(0, Math.max(0, same.length - KEEP_BACKUPS))) fs.rmSync(path.join(dir, old), { force: true });
    return { share: cfg.share, path: cfg.folder + '/sicherungen/' + name, sha256: a };
  } catch (e) { await unmount(); throw e.status ? e : fail('Kopieren auf den Netzwerkspeicher fehlgeschlagen: ' + String(e.code || e.message || e).slice(0, 120), 502); }
  finally { state.busy = false; }
}
// Sicherungen auf der WD auflisten (nur Dateien mit 14-stelligem Zeitstempel, optional je Art) – für „Wiederherstellen“
async function listBackups(web, prefix = '') {
  const cfg = settings(web), pass = secret(web).password || '';
  if (!backupReady(web)) return [];
  while (state.busy) await new Promise(r => setTimeout(r, 200));
  state.busy = true;
  try {
    await mount(web, cfg, pass);
    const dir = path.join(MOUNT, cfg.folder, 'sicherungen'); if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const n of fs.readdirSync(dir).filter(n => /^[A-Za-z0-9._-]{1,120}$/.test(n) && /\d{14}/.test(n) && !n.endsWith('.teil') && n.startsWith(prefix))) {
      try { const s = fs.statSync(path.join(dir, n)); if (s.isFile()) out.push({ name: n, size: s.size, at: s.mtime.toISOString() }); } catch {}
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) { await unmount(); throw e.status ? e : fail('WD nicht lesbar: ' + String(e.code || e.message || e).slice(0, 120), 502); }
  finally { state.busy = false; }
}
// Statusdatei der WD (sicherungsstatus.json in der Wurzel der Freigabe, schreibt die WD alle 5 Minuten; Sitzung
// „Sicherungen WD/CCU3“ 12.10.2026) – nur lesen, höchstens 64 KB, roh zurück (Prüfung der Felder macht ccu-sicherung.js).
async function readStatusFile(web, name = 'sicherungsstatus.json') {
  if (!['sicherungsstatus.json', 'wdstatus.json'].includes(name)) throw fail('Unbekannte Statusdatei');
  const cfg = settings(web), pass = secret(web).password || '';
  if (!backupReady(web)) return null;
  while (state.busy) await new Promise(r => setTimeout(r, 200));
  state.busy = true;
  try {
    await mount(web, cfg, pass);
    const f = path.join(MOUNT, name); if (!fs.existsSync(f)) return null;
    const s = fs.statSync(f); if (!s.isFile() || s.size > 65536) throw fail('Statusdatei der WD ungültig', 502);
    return { text: fs.readFileSync(f, 'utf8'), mtime: s.mtime.toISOString() };
  } catch (e) { await unmount(); throw e.status ? e : fail('WD nicht lesbar: ' + String(e.code || e.message || e).slice(0, 120), 502); }
  finally { state.busy = false; }
}
// Auftrag an die WD (Knopf „Jetzt ausführen“ im Sicherungs-Überblick): kleine Datei auftrag-<id>.json in der Wurzel der
// Freigabe; die WD führt ihn bei ihrer nächsten 5-Minuten-Runde aus und löscht die Datei. Nur feste ids, fester Inhalt.
const AUFTRAG_IDS = ['webseite-taeglich', 'webseite-komplett', 'wochenbericht'];
async function writeRequest(web, id) {
  if (!AUFTRAG_IDS.includes(id)) throw fail('Unbekannter Auftrag');
  const cfg = settings(web), pass = secret(web).password || '';
  if (!backupReady(web)) throw fail('Die WD ist nicht eingerichtet', 409);
  while (state.busy) await new Promise(r => setTimeout(r, 200));
  state.busy = true;
  try {
    await mount(web, cfg, pass);
    const f = path.join(MOUNT, 'auftrag-' + id + '.json'), tmp = f + '.teil';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, id, angefordert: Math.floor(Date.now() / 1000), von: 'ccu3' }));
    fs.renameSync(tmp, f);
    return { id };
  } catch (e) { await unmount(); throw e.status ? e : fail('Auftrag nicht auf die WD geschrieben: ' + String(e.code || e.message || e).slice(0, 120), 502); }
  finally { state.busy = false; }
}
// Eine Sicherung von der WD zurück auf die CCU holen (vollständig gelesen und verglichen)
async function fetchBackup(web, name, dest) {
  const cfg = settings(web), pass = secret(web).password || '';
  if (!backupReady(web)) throw fail('Die WD ist nicht eingerichtet', 409);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || !/\d{14}/.test(name)) throw fail('Ungültiger Dateiname der Sicherung');
  const crypto = require('node:crypto'), hash = f => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex'))); });
  while (state.busy) await new Promise(r => setTimeout(r, 200));
  state.busy = true;
  try {
    await mount(web, cfg, pass);
    const src = path.join(MOUNT, cfg.folder, 'sicherungen', name); if (!fs.existsSync(src)) throw fail('Sicherung auf der WD nicht gefunden', 404);
    const tmp = dest + '.teil';
    await fs.promises.copyFile(src, tmp);
    const [a, b] = await Promise.all([hash(src), hash(tmp)]);
    if (a !== b) { fs.rmSync(tmp, { force: true }); throw fail('Die Kopie von der WD ist nicht vollständig. Bitte erneut versuchen.', 502); }
    fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, dest);
    return { sha256: a };
  } catch (e) { await unmount(); throw e.status ? e : fail('Holen von der WD fehlgeschlagen: ' + String(e.code || e.message || e).slice(0, 120), 502); }
  finally { state.busy = false; }
}
async function tick(web) {
  if (state.busy) return; state.busy = true;
  try {
    const rows = sample(web); state.lastSample = rows.at.toISOString();
    if (settings(web).recordLocal) appendLocal(web, rows);
    try { await syncRemote(web, rows); state.lastError = null; } catch (e) { state.lastError = e.message; await unmount(); }
  } catch (e) { state.lastError = 'Aufzeichnung: ' + e.message; }
  finally { state.busy = false; }
}
function start(web) {
  if (state.timer) return; state.web = web;
  const minutes = Math.max(1, Math.min(60, settings(web).intervalMinutes));
  state.timer = setInterval(() => tick(web), minutes * 60000); state.timer.unref?.();
  setTimeout(() => tick(web), 60000).unref?.(); // erste Messung nach dem Start der Bridge
}
function restart(web) { if (state.timer) clearInterval(state.timer); state.timer = null; start(web); }

// ---------- Schnittstelle ----------
function check(p) {
  const keys = ['enabled', 'host', 'share', 'folder', 'user', 'password', 'intervalMinutes', 'recordLocal'];
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !keys.includes(k))) throw fail('Unerwartete Felder in der Anfrage');
  const host = String(p.host || '').trim(), share = String(p.share || '').trim(), folder = String(p.folder || 'ccu3').trim();
  if (host && net.isIP(host) === 0 && !HOST.test(host)) throw fail('Adresse ungültig (z. B. 192.168.50.15, ohne \\\\ oder smb://)');
  if (share && !SHARE.test(share)) throw fail('Freigabename ungültig (Buchstaben, Zahlen, Leerzeichen, . _ -)');
  if (!FOLDER.test(folder)) throw fail('Unterordner ungültig (Buchstaben, Zahlen, . _ -)');
  for (const [k, max] of [['user', 64], ['password', 256]]) if (p[k] !== undefined && (typeof p[k] !== 'string' || p[k].length > max || /[\x00-\x1f\x7f]/.test(p[k]) || (k === 'user' && /[,=]/.test(p[k])))) throw fail(k === 'user' ? 'Benutzername ungültig' : 'Passwort ungültig');
  const interval = p.intervalMinutes === undefined ? 10 : p.intervalMinutes;
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw fail('Intervall 1 bis 60 Minuten');
  if (p.enabled === true && (!host || !share)) throw fail('Zum Einschalten Adresse und Freigabe angeben');
  return { enabled: p.enabled === true, host, share, folder, user: String(p.user || '').trim(), password: p.password || '', intervalMinutes: interval, recordLocal: p.recordLocal !== false };
}
function publicStatus(web) {
  const cfg = settings(web), s = secret(web);
  let files = [];
  try { files = fs.readdirSync(historyDir(web)).filter(f => /\.csv$/.test(f)).sort(); } catch {}
  return { settings: { ...cfg, hasPassword: !!s.password }, recordOff: Object.keys(recordOff(web)), status: { running: !!state.timer, lastSample: state.lastSample, lastSync: state.lastSync, lastError: state.lastError, mounted: state.mounted, localDays: files.length, onCcu: platform === 'linux' } };
}
async function save(web, p) {
  state.authFailAt = 0; state.forceMount = true; // neue Zugangsdaten: sofort wieder versuchen
  const v = check(p), old = secret(web), cfgOld = settings(web);
  const password = v.password || (old.user === v.user ? old.password || '' : '');
  vault(web).write(v.user || password ? { user: v.user, password } : {});
  web.writeConfigPatch(c => { c.netzspeicher = { enabled: v.enabled, host: v.host, share: v.share, folder: v.folder, user: v.user, intervalMinutes: v.intervalMinutes, recordLocal: v.recordLocal, ...(c.netzspeicher?.recordOff ? { recordOff: c.netzspeicher.recordOff } : {}) }; });
  if (cfgOld.host !== v.host || cfgOld.share !== v.share || cfgOld.user !== v.user || v.password) await unmount();
  restart(web); v.password = '';
  return { success: true, ...publicStatus(web), message: v.enabled ? 'Gespeichert. Daten werden ab der nächsten Messung auf den Netzwerkspeicher geschrieben.' : 'Gespeichert. Netzwerkspeicher ist ausgeschaltet; Aufzeichnung ' + (v.recordLocal ? 'läuft lokal weiter.' : 'ist aus.') };
}
async function test(web, p) {
  state.authFailAt = 0; state.forceMount = true;
  const v = check({ ...p, enabled: false }), old = secret(web);
  if (!v.host || !v.share) throw fail('Adresse und Freigabe angeben');
  const password = v.password || (old.user === v.user ? old.password || '' : ''); v.password = '';
  const steps = [];
  const reach = await tcp(v.host, 445); steps.push({ label: 'Netzwerkspeicher erreichbar (SMB, Port 445)', ok: reach });
  if (!reach) return { ok: false, steps, message: 'Unter dieser Adresse antwortet kein Netzwerkspeicher. IP prüfen.' };
  if (platform !== 'linux') { steps.push({ label: 'Freigabe einbinden', ok: null, detail: 'nur auf der CCU möglich' }); return { ok: null, steps, message: 'Erreichbarkeit geprüft. Einbinden und Schreiben werden auf der CCU getestet.' }; }
  const wasMounted = state.mounted; if (wasMounted) await unmount();
  try {
    await mount(web, v, password); steps.push({ label: 'Freigabe eingebunden (Benutzer/Passwort korrekt)', ok: true });
    const dir = path.join(MOUNT, v.folder); fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.ccu3-schreibtest-' + Date.now());
    fs.writeFileSync(probe, 'CCU3 Schreibtest'); const ok = fs.readFileSync(probe, 'utf8') === 'CCU3 Schreibtest'; fs.rmSync(probe, { force: true });
    steps.push({ label: 'Schreiben, Lesen und Löschen einer Testdatei', ok });
    return { ok, steps, message: ok ? 'Netzwerkspeicher funktioniert.' : 'Testdatei konnte nicht korrekt gelesen werden.' };
  } catch (e) { steps.push({ label: 'Freigabe einbinden', ok: false, detail: e.message }); return { ok: false, steps, message: e.message }; }
  finally { await unmount(); }
}
// Verlaufsdateien für die Diagramme: je Tag genau eine Datei – von der WD, wenn dort eingeschaltet und erreichbar
// (dort liegen auch ältere Tage), sonst von der CCU (letzte 14 Tage). Fällt die WD aus, bleiben die CCU-Daten.
const WD_DAYS = 92;
async function historyFiles(web, since) {
  const pick = new Map(), isDay = f => /^\d{4}-\d\d-\d\d\.csv$/.test(f) && f.slice(0, 10) >= day(since);
  try { for (const f of fs.readdirSync(historyDir(web))) if (isDay(f)) pick.set(f, path.join(historyDir(web), f)); } catch {}
  const cfg = settings(web);
  let source = 'ccu', error = null;
  if (cfg.enabled && backupReady(web)) {
    while (state.busy) await new Promise(r => setTimeout(r, 200));
    state.busy = true;
    try {
      await mount(web, cfg, secret(web).password || '');
      const dir = path.join(MOUNT, cfg.folder, 'verlauf');
      let names = []; try { names = fs.readdirSync(dir).filter(isDay); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const f of names) { const wp = path.join(dir, f), lp = pick.get(f); if (!lp || fs.statSync(wp).size >= fs.statSync(lp).size) pick.set(f, wp); }
      source = 'wd';
    } catch (e) { error = e.message; } finally { state.busy = false; }
  }
  return { files: [...pick.keys()].sort().map(f => pick.get(f)), source, error };
}
async function history(web, u) {
  const wdOn = settings(web).enabled && backupReady(web);
  const address = u.searchParams.get('address') || '', hours = Math.max(1, Math.min(24 * (wdOn ? WD_DAYS : KEEP_DAYS), Number(u.searchParams.get('hours')) || 24));
  const since = new Date(Date.now() - hours * 3600000), series = new Map(), devices = new Map();
  const { files, source, error } = await historyFiles(web, since);
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
      if (!line) continue;
      const cols = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ';') { cols.push(cur); cur = ''; } else cur += c; } cols.push(cur);
      const [time, addr, name, room, metric, value, unit] = cols;
      const prev = devices.get(addr); devices.set(addr, { address: addr, name, room, last: prev && prev.last > time ? prev.last : time });
      if (addr !== address || time < since.toISOString()) continue;
      const key = metric + '|' + unit; if (!series.has(key)) series.set(key, { metric, unit, points: [] });
      const n = Number(value); if (Number.isFinite(n)) series.get(key).points.push([time, n]);
    }
  }
  for (const s of series.values()) if (s.points.length > 2000) { const step = Math.ceil(s.points.length / 2000); s.points = s.points.filter((_, i) => i % step === 0); }
  // Geräte, die seit mindestens 3 Stunden (bzw. 3 Messabständen) nichts mehr liefern, als „alt“ markieren und ans Ende stellen
  // (z. B. zusammengeführte oder entfernte Einträge). Gemessen an der neuesten Aufzeichnung, nicht an der Uhr.
  const newest = [...devices.values()].reduce((m, d) => d.last > m ? d.last : m, '');
  const gap = Math.max(3 * 3600000, 3 * (settings(web).intervalMinutes || 5) * 60000);
  const fresh = newest ? new Date(Date.parse(newest) - gap).toISOString() : '';
  // Diagramm-Archiv (Wunsch Thomas): Einträge, die es nicht mehr gibt oder die nichts mehr liefern, kommen grundsätzlich ins Archiv
  let exists = null; try { exists = new Set(recordable(web).map(d => d.address)); } catch {}
  const list = [...devices.values()].map(d => { const gone = !!exists && !exists.has(d.address), old = d.last < fresh; return { ...d, old, ...(gone ? { gone } : {}), archiv: gone || old }; })
    .sort((a, b) => (a.archiv - b.archiv) || a.name.localeCompare(b.name, 'de'));
  return { devices: list, series: [...series.values()], hours, source, maxDays: wdOn && source === 'wd' ? WD_DAYS : KEEP_DAYS, ...(error ? { sourceError: error } : {}) };
}

async function handle(web, req, res, u, auth) {
  const method = u.searchParams.get('method');
  if (!['getNetStorage', 'saveNetStorage', 'testNetStorage', 'getHistory', 'setRecording'].includes(method)) return false;
  start(web);
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (method === 'getNetStorage' || method === 'getHistory') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, method === 'getHistory' ? await history(web, u) : publicStatus(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    if (method === 'setRecording') {
      if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['address', 'record'].includes(k)) || typeof p.address !== 'string' || !ADDR.test(p.address) || typeof p.record !== 'boolean') throw fail('Gerät oder Auswahl ungültig');
      web.writeConfigPatch(c => { const n = { ...(c.netzspeicher || {}) }, off = { ...(n.recordOff || {}) }; if (p.record) delete off[p.address]; else off[p.address] = true; if (Object.keys(off).length > 2000) throw fail('Zu viele Einträge'); n.recordOff = off; c.netzspeicher = n; });
      send(200, { success: true, recordOff: Object.keys(recordOff(web)), message: p.record ? 'Wird aufgezeichnet.' : 'Wird nicht mehr aufgezeichnet.' }); return true;
    }
    send(200, method === 'saveNetStorage' ? await save(web, p) : await test(web, p));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Netzwerkspeicher: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, metrics, check, storeBackup, backupReady, listBackups, fetchBackup, readStatusFile, writeRequest, _test: { execEnv, tick, sample, setExec: fn => { exec = fn; }, setPlatform: p => { platform = p; }, setMount: m => { MOUNT = m; }, setReadMounts: f => { readMounts = f; }, state, get MOUNT() { return MOUNT; } } };
