'use strict';
// CCU-Sicherung erstellen und einspielen (Wunsch Thomas, 12.10.2026: „ich muss in der Lage sein, das System zu sichern und
// einzuspielen“). Ersetzt die „Backup-Verwaltung“ der alten Systemsteuerung. Nutzt die Standardskripte der CCU (Jens Maus):
// /bin/createBackup.sh <Ordner> und /bin/restoreBackup.sh [-c] [-r] <Datei.sbk>.
// Ablage: /usr/local/etc/config/matter-sicherungen (createBackup.sh nimmt den Zielordner selbst nicht in die Sicherung auf;
// /usr/local/tmp wird beim Neustart geleert). Höchstens 3 .sbk-Dateien auf der CCU (Wunsch Thomas 12.10.2026): ältere werden auf
// die WD ausgelagert (netzspeicher.storeBackup: Kopie zurückgelesen und verglichen, dort bleiben die neuesten 10) und erst danach
// auf der CCU gelöscht. Ist die WD nicht erreichbar, bleibt die Datei auf der CCU (Notbremse: höchstens 6, dann nur schon
// gesicherte löschen). Ohne eingerichtete WD wie bisher: höchstens 3, älteste gelöscht.
// Sicherer Ablauf beim Einspielen (auf der echten CCU gelesen, S05CheckBackupRestore): Beim Neustart löscht die CCU ganz
// /usr/local (außer tmp) und packt die Sicherung aus – eine Sicherung auf der CCU wäre danach weg. Deshalb:
//   1. frische Sicherung erstellen UND herunterladen oder auf die WD kopieren (höchstens 2 Stunden alt), 2. Datei prüfen (restoreBackup.sh -c),
//   3. Schieberegler-Rückfrage, 4. einspielen + Neustart (restoreBackup.sh -r). Nur Administratoren.
// Ein CCU-Sicherheitsschlüssel wird nicht abgefragt (auf dieser CCU nicht gesetzt); verlangt das Skript ihn, bricht es ab → SSH.
const fs = require('node:fs'), fsp = require('node:fs/promises'), path = require('node:path'), { spawn } = require('node:child_process');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.sbk$/;
const MAX_UPLOAD = 600 * 1048576, KEEP = 3, HARD_MAX = 6, FRESH_MS = 2 * 3600000;
const dir = web => web.deps?.sicherungDir || '/usr/local/etc/config/matter-sicherungen';
const script = (web, n) => web.deps?.sicherungScripts?.[n] || '/bin/' + n + '.sh';
const stateFile = web => path.join(dir(web), 'ccu-sicherungen.json');
let job = { state: 'idle', message: '', at: null }, restoring = 0, wdState = { laeuft: false, fehler: null, letzte: null };
const wd = web => web.deps?.netzspeicher || require('./netzspeicher');
const wdReady = web => { try { return !!wd(web).backupReady(web); } catch { return false; } };

function readState(web) { try { const s = JSON.parse(fs.readFileSync(stateFile(web), 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; } catch { return {}; } }
function writeState(web, s) { const f = stateFile(web), tmp = f + '.neu-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, f); }
function run(web, file, args, timeout) {
  if (web.deps?.sicherungRun) return Promise.resolve(web.deps.sicherungRun(file, args));
  return new Promise(ok => {
    let out = '', child; const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeout);
    try { child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch { clearTimeout(t); ok({ code: 99, out: '' }); return; }
    const add = d => { out += d; if (out.length > 20000) out = out.slice(-20000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', () => { clearTimeout(t); ok({ code: 99, out }); });
    child.on('close', code => { clearTimeout(t); ok({ code: Number.isInteger(code) ? code : 99, out }); });
  });
}
async function list(web) {
  const st = readState(web); let names = [];
  try { names = (await fsp.readdir(dir(web))).filter(n => NAME.test(n)); } catch {}
  const files = [];
  for (const n of names) { try { const s = await fsp.lstat(path.join(dir(web), n)); if (s.isFile()) files.push({ name: n, size: s.size, at: s.mtime.toISOString(), pruefungLaeuft: checking.has(n), kind: st[n]?.kind === 'hochgeladen' ? 'hochgeladen' : 'erstellt', heruntergeladen: st[n]?.heruntergeladen === true, aufWd: st[n]?.wd || null, geprueft: st[n]?.geprueft || null }); } catch {} }
  return files.sort((a, b) => b.at.localeCompare(a.at));
}
// Auf die WD kopieren: Name mit 14-stelligem Zeitstempel, damit die WD je Art die neuesten 10 behält.
async function toWd(web, name) {
  const f = path.join(dir(web), name), s = await fsp.lstat(f), d = s.mtime, p2 = n => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  const res = await wd(web).storeBackup(web, f, 'ccu-sicherung-' + stamp + '.sbk');
  const st = readState(web); st[name] = { ...(st[name] || {}), wd: { at: new Date().toISOString(), pfad: res?.path || '' } };
  // Merken auch nach dem Löschen auf der CCU: letzte selbst erstellte Sicherung auf der WD (für „vorher gesichert“ beim Einspielen)
  // und das letzte Prüfergebnis (für den Überblick)
  if (st[name].kind !== 'hochgeladen' && st[name].kind !== 'von WD') st._letzteAufWd = { name, erstellt: s.mtime.toISOString(), wdName: 'ccu-sicherung-' + stamp + '.sbk' };
  if (st[name].geprueft) st._letztePruefung = { name, ...st[name].geprueft };
  writeState(web, st);
  wdState = { laeuft: false, fehler: null, letzte: { name, at: new Date().toISOString(), pfad: res?.path || '' } };
  return res;
}
async function prune(web, keepName) {
  if (wdState.laeuft) return;
  if (!wdReady(web)) { // ohne WD wie bisher: höchstens 3
    const files = await list(web), st = readState(web);
    for (const f of files.filter(f => f.name !== keepName).slice(keepName ? KEEP - 1 : KEEP)) { try { await fsp.unlink(path.join(dir(web), f.name)); delete st[f.name]; } catch {} }
    writeState(web, st); return;
  }
  wdState = { ...wdState, laeuft: true };
  try {
    // Jede Sicherung gehört auch auf die WD: liegengebliebene (WD war weg) nachholen, älteste zuerst
    for (const f of (await list(web)).filter(f => !f.aufWd && f.name.endsWith('.sbk')).reverse()) {
      try { await toWd(web, f.name); wdCache.at = 0; } catch (e) { wdState = { ...wdState, fehler: 'Auslagern auf die WD fehlgeschlagen – Sicherung bleibt auf der CCU: ' + String(e.message || e).slice(0, 160) }; break; }
    }
    // Nur WD (Wunsch Thomas 12.10.2026 spät): alles, was sicher auf der WD liegt, von der CCU löschen – außer gerade in Prüfung
    // und eine fürs Einspielen von der WD geholte Sicherung (2 Stunden). Nicht auf der WD → bleibt (wird nachgeholt).
    for (const f of (await list(web)).filter(f => f.name !== keepName && f.aufWd && !checking.has(f.name) && !(f.kind === 'von WD' && Date.now() - Date.parse(readState(web)[f.name]?.wd?.at || 0) < FRESH_MS))) {
      try { await fsp.unlink(path.join(dir(web), f.name)); const st = readState(web); delete st[f.name]; writeState(web, st); } catch {}
    }
    // Notbremse für den Speicher: über 6 Dateien nur solche löschen, die schon auf der WD liegen oder heruntergeladen wurden
    const rest = (await list(web)).filter(f => f.name !== keepName);
    for (const f of rest.slice(HARD_MAX - 1).filter(f => f.aufWd || f.heruntergeladen)) { try { await fsp.unlink(path.join(dir(web), f.name)); const st = readState(web); delete st[f.name]; writeState(web, st); } catch {} }
  } finally { wdState = { ...wdState, laeuft: false }; }
}
function copyToWd(web, name) {
  if (typeof name !== 'string' || !NAME.test(name) || !fs.existsSync(path.join(dir(web), name))) throw fail('Datei nicht gefunden', 404);
  if (!wdReady(web)) throw fail('Die WD ist noch nicht eingerichtet (System → Sicherung & Wiederherstellung (WD) → WD verbinden)', 409);
  if (wdState.laeuft) throw fail('Es wird gerade auf die WD kopiert – bitte warten', 429);
  wdState = { ...wdState, laeuft: true, fehler: null };
  toWd(web, name).catch(e => { wdState = { ...wdState, fehler: 'Kopieren auf die WD fehlgeschlagen: ' + String(e.message || e).slice(0, 160) }; }).finally(() => { wdState = { ...wdState, laeuft: false }; });
  return { laeuft: true, message: 'Wird auf die WD kopiert und geprüft (bei großen Sicherungen einige Minuten) …' };
}
async function freeBytes(web) { try { const s = await fsp.statfs(dir(web)); return Number(s.bavail) * Number(s.bsize); } catch { return Infinity; } }
// Sicherungen auf der WD (neueste 10) – gemerkt für 5 Minuten, damit die Seite die WD nicht bei jedem Aufruf einbindet
const wdCache = { at: 0, files: [], fehler: null };
async function wdFiles(web, fresh) {
  if (!wdReady(web)) return { files: [], fehler: null };
  if (!fresh && Date.now() - wdCache.at < 300000) return wdCache;
  try { const l = typeof wd(web).listBackups === 'function' ? await wd(web).listBackups(web, 'ccu-sicherung-') : []; Object.assign(wdCache, { at: Date.now(), files: l.filter(f => NAME.test(f.name)).slice(0, 10), fehler: null }); }
  catch (e) { Object.assign(wdCache, { at: Date.now(), fehler: String(e.message || e).slice(0, 200) }); }
  return wdCache;
}
// Zeitplan: alle X Tage um HH:MM eine Sicherung des kompletten Systems (Einstellung ccuSicherungPlan)
const PLAN = Object.freeze({ enabled: false, everyDays: 7, time: '03:00' });
function plan(web) { let c; try { c = web.security.configSnapshot.read().ccuSicherungPlan; } catch {} return c && typeof c === 'object' ? { ...PLAN, ...c } : { ...PLAN }; }
function nextRun(web, now = Date.now()) {
  const p = plan(web); if (!p.enabled) return null;
  const last = Date.parse(readState(web)._plan?.last || '') || 0, [hh, mm] = p.time.split(':').map(Number);
  // Noch nie gelaufen: heute zur Uhrzeit (schon vorbei → morgen). Sonst: Tag der letzten + X Tage zur Uhrzeit; überfällig → jetzt.
  const d = new Date(last || now); d.setHours(hh, mm, 0, 0);
  if (!last) { if (d.getTime() <= now) d.setDate(d.getDate() + 1); return d.getTime(); }
  d.setDate(d.getDate() + p.everyDays);
  return Math.max(d.getTime(), now);
}
async function planTick(web, now = Date.now()) {
  const p = plan(web); if (!p.enabled || job.state === 'running' || restoring) return false;
  // fällig: noch nie gelaufen → in den 5 Minuten ab HH:MM; sonst ab „letzte + X Tage, HH:MM“ (verpasst → beim nächsten Takt)
  const last = Date.parse(readState(web)._plan?.last || '') || 0, [hh, mm] = p.time.split(':').map(Number), d = new Date(last || now); d.setHours(hh, mm, 0, 0);
  if (!last && !(now >= d.getTime() && now < d.getTime() + 300000)) return false;
  if (last) { d.setDate(d.getDate() + p.everyDays); if (now < d.getTime()) return false; }
  const st = readState(web); st._plan = { last: new Date(now).toISOString() }; writeState(web, st);
  try { await create(web); return true; } catch (e) { job = { state: 'error', message: 'Geplante Sicherung nicht gestartet: ' + (e.message || 'Fehler'), at: new Date(now).toISOString() }; return false; }
}
async function overview(web, opts = {}) { const w = await wdFiles(web, opts.wdNeu); const n = nextRun(web); return { files: await list(web), job: { ...job }, restoring: restoring > 0, ordner: dir(web), wd: { bereit: wdReady(web), ...wdState, files: w.files, lesefehler: w.fehler }, plan: { ...plan(web), naechste: n ? new Date(n).toISOString() : null, letzte: readState(web)._plan?.last || null }, frischGesichert: frischAufWd(web) }; }
// ---- Überblick „Sicherungen“ (Wunsch Thomas über die Sitzung „Sicherungen WD/CCU3“, 12.10.2026) ----
// WD: sicherungsstatus.json (nur lesen, nur bekannte Felder, nur Text/Zahlen, gekürzt); älter als 15 min → „WD meldet sich nicht“.
// CCU3: aus unserem eigenen Zeitplan und den Sicherungen auf CCU/WD.
const TXT = (v, n = 300) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n) : null;
const NUM = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const ENUM = (v, ok) => ok.includes(v) ? v : null;
const BEREICH_TEXT = ['id', 'name', 'inhalt', 'ort', 'letzteText', 'ergebnis', 'naechsteText', 'rhythmus', 'aufbewahrung', 'kopieStick', 'stickFreiGB', 'auftragText'];
function cleanWd(raw) {
  let d; try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || d.version !== 1) return null;
  const b = (Array.isArray(d.bereiche) ? d.bereiche : []).slice(0, 8).filter(x => x && typeof x === 'object').map(x => {
    const o = {}; for (const k of BEREICH_TEXT) o[k] = TXT(x[k]);
    Object.assign(o, { letzte: NUM(x.letzte), naechste: NUM(x.naechste), anzahl: NUM(x.anzahl), groesseMB: NUM(x.groesseMB), kopienStick: NUM(x.kopienStick), pruefung: ENUM(x.pruefung, ['ok', 'falsch', 'defekt', 'unbekannt']), stickErreichbar: typeof x.stickErreichbar === 'boolean' ? x.stickErreichbar : null });
    return o;
  });
  const w = d.wochenbericht && typeof d.wochenbericht === 'object' ? { weg: TXT(d.wochenbericht.weg, 60), rhythmus: TXT(d.wochenbericht.rhythmus, 120), letzteText: TXT(d.wochenbericht.letzteText, 60), naechsteText: TXT(d.wochenbericht.naechsteText, 60), auftragText: TXT(d.wochenbericht.auftragText, 200) } : null;
  return { erstellt: NUM(d.erstellt), erstelltText: TXT(d.erstelltText, 40), zustandWd: ENUM(d.zustandWd, ['ok', 'hinweis', 'warnung', 'fehler']), bereiche: b, wochenbericht: w };
}
// Zustand der WD selbst (wdstatus.json, Sitzung „Sicherungen WD/CCU3“ 12.10.2026): nur bekannte Felder, Zahlen/kurze Texte
function cleanWdSystem(raw) {
  let d; try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || d.version !== 1) return null;
  const B = v => typeof v === 'boolean' ? v : null, STUFE = ['ok', 'hinweis', 'warnung', 'fehler'];
  return {
    erstellt: NUM(d.erstellt), erstelltText: TXT(d.erstelltText, 40), zustandWd: ENUM(d.zustandWd, STUFE), modell: TXT(d.modell, 80),
    platten: (Array.isArray(d.platten) ? d.platten : []).slice(0, 4).filter(p => p && typeof p === 'object').map(p => ({ name: TXT(p.name, 60), gesamtGB: NUM(p.gesamtGB), freiGB: NUM(p.freiGB), belegtProzent: NUM(p.belegtProzent), smart: ENUM(p.smart, ['ok', 'warnung', 'fehler', 'unbekannt']), defekteSektoren: NUM(p.defekteSektoren), temperaturC: NUM(p.temperaturC), betriebsstunden: NUM(p.betriebsstunden) })),
    stick: d.stick && typeof d.stick === 'object' ? { erreichbar: B(d.stick.erreichbar), gesamtGB: NUM(d.stick.gesamtGB), freiGB: NUM(d.stick.freiGB) } : null,
    systemTemperaturC: NUM(d.systemTemperaturC), cpuLast1: NUM(d.cpuLast1), ramFreiMB: NUM(d.ramFreiMB), laufzeitTage: NUM(d.laufzeitTage), letzterNeustartText: TXT(d.letzterNeustartText, 40), firmware: TXT(d.firmware, 60), updateVerfuegbar: B(d.updateVerfuegbar),
    dienste: (Array.isArray(d.dienste) ? d.dienste : []).slice(0, 12).filter(x => x && typeof x === 'object').map(x => ({ name: TXT(x.name, 60), laeuft: B(x.laeuft) })),
    netz: d.netz && typeof d.netz === 'object' ? { ip: TXT(d.netz.ip, 40), tailscale: B(d.netz.tailscale) } : null,
    hinweise: (Array.isArray(d.hinweise) ? d.hinweise : []).slice(0, 30).map(x => TXT(x, 200)).filter(Boolean),
    punkte: (Array.isArray(d.punkte) ? d.punkte : []).slice(0, 60).filter(x => x && typeof x === 'object').map(x => ({ stufe: ENUM(x.stufe, STUFE), bereich: TXT(x.bereich, 40), name: TXT(x.name, 80), text: TXT(x.text, 200) }))
  };
}
const wdSystemCache = { at: 0, value: null };
const wdStatusCache = { at: 0, value: null };
async function ueberblick(web, now = Date.now()) {
  let wdTeil = { eingerichtet: wdReady(web), status: null, fehler: null, meldetSichNicht: false };
  if (wdTeil.eingerichtet) {
    if (now - wdStatusCache.at > 60000) {
      try { const r = typeof wd(web).readStatusFile === 'function' ? await wd(web).readStatusFile(web) : null; wdStatusCache.value = r ? { status: cleanWd(r.text), fehler: r && !cleanWd(r.text) ? 'Statusdatei der WD unlesbar' : null } : { status: null, fehler: 'Die WD hat noch keine Statusdatei abgelegt' }; }
      catch (e) { wdStatusCache.value = { status: null, fehler: String(e.message || e).slice(0, 200) }; }
      wdStatusCache.at = now;
    }
    Object.assign(wdTeil, wdStatusCache.value);
    if (now - wdSystemCache.at > 60000) {
      try { const r = typeof wd(web).readStatusFile === 'function' ? await wd(web).readStatusFile(web, 'wdstatus.json') : null; wdSystemCache.value = r ? cleanWdSystem(r.text) : null; } catch { wdSystemCache.value = null; }
      wdSystemCache.at = now;
    }
    wdTeil.system = wdSystemCache.value; wdTeil.systemAlt = !wdTeil.system || !wdTeil.system.erstellt || now - wdTeil.system.erstellt * 1000 > 15 * 60000;
    wdTeil.meldetSichNicht = !wdTeil.status || !wdTeil.status.erstellt || now - wdTeil.status.erstellt * 1000 > 15 * 60000;
  }
  const files = await list(web), w = await wdFiles(web), p = plan(web), n = nextRun(web, now);
  const alle = [...files.map(f => ({ name: f.name, at: f.at, wo: 'CCU' })), ...(w.files || []).map(f => ({ name: f.name, at: f.at, wo: 'WD' }))].sort((a, b) => b.at.localeCompare(a.at));
  const neueste = alle[0] || null, lokal = files[0] || null;
  const ccu = { letzte: neueste?.at || null, wo: [files.length ? files.length + ' auf der CCU' : null, w.files?.length ? w.files.length + ' auf der WD' : null].filter(Boolean).join(', ') || 'keine',
    naechste: n ? new Date(n).toISOString() : null, zeitplan: p.enabled ? 'alle ' + p.everyDays + ' Tag(e) um ' + p.time + ' Uhr' : 'aus (nur von Hand)', pruefung: lokal?.pruefungLaeuft || job.message === 'Sicherung wird geprüft …' ? 'laeuft' : (() => { const g = (lokal && lokal.geprueft) || readState(web)._letztePruefung; return g ? (g.ok ? 'ok' : 'falsch') : 'unbekannt'; })(),
    aufWd: lokal ? !!lokal.aufWd : (readState(web)._letzteAufWd ? true : null), job: job.state === 'running' ? job.message : null, everyDays: p.enabled ? p.everyDays : null, bridgeJob: bridgeJob.state === 'idle' ? null : bridgeJob.message };
  return { jetzt: new Date(now).toISOString(), ccu, wd: wdTeil };
}
// ---- „Jetzt ausführen“ je Kästchen im Überblick (Wunsch Thomas) ----
// ccu3-komplett: komplette CCU-Sicherung; ccu3: Bridge-Sicherung (wie vor einer Installation) und auf die WD;
// webseite-taeglich / webseite-komplett / wochenbericht: Auftrag an die WD (führt sie bei der nächsten 5-Minuten-Runde aus).
const BRIDGE_PFADE = ['/usr/local/addons/matter-homematic', '/usr/local/etc/config/addons/matter-homematic', '/usr/local/etc/config/rc.d/matter-homematic', '/usr/local/etc/config/addons/www/matter-homematic'];
const lastStart = new Map(); let bridgeJob = { state: 'idle', message: '' };
async function jetzt(web, id, now = Date.now()) {
  if (!['ccu3-komplett', 'ccu3', 'webseite-taeglich', 'webseite-komplett', 'wochenbericht'].includes(id)) throw fail('Unbekannter Bereich');
  if (now - (lastStart.get(id) || 0) < 600000) throw fail('Wurde gerade erst angestoßen – bitte 10 Minuten warten', 429);
  if (restoring) throw fail('Eine Sicherung wird gerade eingespielt', 409);
  if (id === 'ccu3-komplett') { await create(web); lastStart.set(id, now); return { message: 'Komplette Sicherung läuft (einige Minuten) – danach automatisch auf die WD und geprüft.' }; }
  if (id === 'ccu3') {
    if (bridgeJob.state === 'running') throw fail('Bridge-Sicherung läuft bereits', 429);
    await fsp.mkdir(dir(web), { recursive: true, mode: 0o700 });
    if (await freeBytes(web) < 300 * 1048576) throw fail('Zu wenig freier Speicher auf der CCU', 507);
    const p2 = n => String(n).padStart(2, '0'), d = new Date(now), name = 'matter-sicherung-vor-hand-' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.tar.gz';
    lastStart.set(id, now); bridgeJob = { state: 'running', message: 'Bridge-Sicherung läuft …' };
    run(web, 'tar', ['czf', path.join(dir(web), name), ...BRIDGE_PFADE.filter(p => web.deps?.sicherungRun || fs.existsSync(p))], 10 * 60000).then(async r => {
      if (r.code !== 0) { bridgeJob = { state: 'error', message: 'Bridge-Sicherung fehlgeschlagen (Code ' + r.code + ')' }; return; }
      try { await fsp.chmod(path.join(dir(web), name), 0o600); } catch {}
      // höchstens 3 Bridge-Sicherungen auf der CCU (wie der Installer)
      try { const alt = (await fsp.readdir(dir(web))).filter(n => /^matter-sicherung-vor-.+\.tar\.gz$/.test(n)); const st = await Promise.all(alt.map(async n => [n, (await fsp.lstat(path.join(dir(web), n))).mtimeMs])); for (const [n] of st.sort((a, b) => b[1] - a[1]).slice(3)) await fsp.unlink(path.join(dir(web), n)); } catch {}
      const k = await bridgeAuslagern(web).catch(() => 0);
      bridgeJob = { state: 'done', message: 'Bridge-Sicherung erstellt' + (k ? ' und auf die WD kopiert.' : (wdReady(web) ? ' – Kopie auf die WD folgt.' : '.')) };
    }).catch(() => { bridgeJob = { state: 'error', message: 'Bridge-Sicherung fehlgeschlagen' }; });
    return { message: 'Bridge-Sicherung läuft (etwa 1 Minute) – danach auf die WD.' };
  }
  if (!wdReady(web) || typeof wd(web).writeRequest !== 'function') throw fail('Die WD ist nicht verbunden', 409);
  await wd(web).writeRequest(web, id); lastStart.set(id, now);
  wdStatusCache.at = 0; // nächster Überblick liest die Statusdatei neu (Ergebnis „auftragText“)
  return { message: 'Auftrag an die WD gegeben – sie startet ihn in wenigen Sekunden; das Ergebnis erscheint hier im Kästchen.' };
}
// Von der WD zurückholen (für „Wiederherstellen“): danach automatisch prüfen
let holen = null;
function fromWd(web, name) {
  if (typeof name !== 'string' || !NAME.test(name) || !/^ccu-sicherung-\d{14}\.sbk$/.test(name)) throw fail('Datei ungültig');
  if (!wdReady(web)) throw fail('Die WD ist nicht eingerichtet', 409);
  if (holen || wdState.laeuft) throw fail('Es wird gerade mit der WD kopiert – bitte warten', 429);
  if (restoring) throw fail('Eine Sicherung wird gerade eingespielt', 409);
  const dest = path.join(dir(web), name);
  if (fs.existsSync(dest)) { startCheck(web, name); return { laeuft: true, message: 'Liegt schon auf der CCU – wird geprüft …' }; }
  holen = name; wdState = { ...wdState, laeuft: true, fehler: null };
  (async () => {
    try { await fsp.mkdir(dir(web), { recursive: true, mode: 0o700 }); if (await freeBytes(web) < 1024 * 1048576) throw fail('Zu wenig freier Speicher auf der CCU (mindestens 1 GB nötig)'); await wd(web).fetchBackup(web, name, dest);
      const st = readState(web); st[name] = { kind: 'von WD', heruntergeladen: false, wd: { at: new Date().toISOString(), pfad: 'WD' } }; writeState(web, st); startCheck(web, name); }
    catch (e) { wdState = { ...wdState, fehler: 'Holen von der WD fehlgeschlagen: ' + String(e.message || e).slice(0, 160) }; }
    finally { holen = null; wdState = { ...wdState, laeuft: false }; }
  })();
  return { laeuft: true, message: 'Wird von der WD geholt und danach geprüft (bei großen Sicherungen einige Minuten) …' };
}

// ---- Erstellen (im Hintergrund, dauert einige Minuten) ----
async function create(web) {
  if (job.state === 'running') throw fail('Es wird gerade eine Sicherung erstellt', 429);
  if (restoring) throw fail('Eine Sicherung wird gerade eingespielt', 409);
  if (!fs.existsSync(script(web, 'createBackup'))) throw fail('Auf diesem System gibt es kein CCU-Sicherungsprogramm', 501);
  await fsp.mkdir(dir(web), { recursive: true, mode: 0o700 });
  if (await freeBytes(web) < 1024 * 1048576) throw fail('Zu wenig freier Speicher (mindestens 1 GB nötig)', 507);
  const before = new Set((await list(web)).map(f => f.name));
  job = { state: 'running', message: 'Sicherung wird erstellt … (einige Minuten)', at: new Date().toISOString() };
  run(web, script(web, 'createBackup'), [dir(web)], 30 * 60000).then(async r => {
    const neu = (await list(web)).find(f => !before.has(f.name));
    if (r.code !== 0 || !neu || neu.size < 1024) { job = { state: 'error', message: 'Sicherung fehlgeschlagen' + (r.code ? ' (Code ' + r.code + ')' : ''), at: new Date().toISOString() }; return; }
    try { await fsp.chmod(path.join(dir(web), neu.name), 0o600); } catch {}
    const st = readState(web); st[neu.name] = { kind: 'erstellt', heruntergeladen: false }; writeState(web, st);
    // Erst prüfen (solange sie auf der CCU liegt), dann auf die WD, dann auf der CCU löschen (Wunsch Thomas 12.10.2026 spät:
    // „nur WD, keine mehr auf der CCU“). Ohne erreichbare WD bleibt sie auf der CCU und wird später nachgeholt.
    // „fertig“ erst am Ende des ganzen Ablaufs.
    const at = new Date().toISOString(); let ziel = 'auf der CCU – bitte herunterladen oder WD verbinden';
    job = { state: 'running', message: 'Sicherung wird geprüft …', name: neu.name, at };
    checking.add(neu.name); try { await check(web, neu.name).catch(() => {}); } finally { checking.delete(neu.name); }
    if (wdReady(web) && !wdState.laeuft) {
      job = { ...job, message: 'Sicherung wird auf die WD kopiert …' };
      wdState = { ...wdState, laeuft: true, fehler: null };
      try { await toWd(web, neu.name); ziel = 'auf der WD'; wdCache.at = 0; }
      catch (e) { ziel = 'auf der CCU (WD nicht erreichbar – wird nachgeholt)'; wdState = { ...wdState, fehler: 'Kopieren auf die WD fehlgeschlagen – Sicherung liegt auf der CCU: ' + String(e.message || e).slice(0, 160) }; }
      finally { wdState = { ...wdState, laeuft: false }; }
    }
    await prune(web, null);
    const g = readState(web)[neu.name]?.geprueft || readState(web)._letztePruefung;
    job = { state: 'done', message: 'Sicherung erstellt, ' + (g ? (g.ok ? 'geprüft ✓' : 'Prüfung FEHLGESCHLAGEN') : 'nicht geprüft') + ', liegt ' + ziel + '.', name: neu.name, at };
  }).catch(() => { job = { state: 'error', message: 'Sicherung fehlgeschlagen', at: new Date().toISOString() }; });
  return overview(web);
}
// ---- Herunterladen ----
async function download(web, res, name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw fail('Datei ungültig');
  const f = path.join(dir(web), name); let s; try { s = await fsp.lstat(f); } catch { throw fail('Datei nicht gefunden', 404); }
  if (!s.isFile()) throw fail('Datei nicht gefunden', 404);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(s.size), 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  await new Promise((ok, no) => { const r = fs.createReadStream(f); r.on('error', no); res.on('finish', ok); res.on('close', ok); r.pipe(res); });
  if (res.writableFinished) { const st = readState(web); st[name] = { ...(st[name] || { kind: 'erstellt' }), heruntergeladen: true, heruntergeladenAm: new Date().toISOString() }; writeState(web, st); }
}
// ---- Hochladen in Teilen (je höchstens 16 MB): der Webserver nimmt eine Anfrage nur 30 s lang an, eine ganze .sbk
// (echte CCU 12.10.2026: 374 MB) schafft das über WLAN nicht. Teil 1 (start=0) legt die Datei an, jeder weitere hängt an. ----
const CHUNK = 16 * 1048576; let upload = null;
async function uploadPart(web, req, q) {
  if (restoring) throw fail('Eine Sicherung wird gerade eingespielt', 409);
  const len = Number(req.headers?.['content-length']), startAt = Number(q.get('start')), total = Number(q.get('gesamt')), original = q.get('datei');
  if (!Number.isInteger(len) || len < 1 || len > CHUNK || !Number.isInteger(startAt) || startAt < 0 || !Number.isInteger(total) || total < 1024 || total > MAX_UPLOAD || startAt + len > total) throw fail('Datei: 1 KB bis 600 MB, Endung .sbk');
  if (startAt === 0) {
    if (typeof original !== 'string' || !/\.sbk$/i.test(original)) throw fail('Bitte eine CCU-Sicherung (.sbk) wählen');
    await fsp.mkdir(dir(web), { recursive: true, mode: 0o700 });
    if (await freeBytes(web) < total * 3 + 200 * 1048576) throw fail('Zu wenig freier Speicher für diese Sicherung', 507);
    if (upload) { try { await fsp.unlink(upload.tmp); } catch {} }
    const name = 'hochgeladen-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.sbk';
    upload = { id: require('node:crypto').randomBytes(12).toString('hex'), name, tmp: path.join(dir(web), name + '.teil'), size: 0, total, original: original.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) };
    await fsp.writeFile(upload.tmp, Buffer.alloc(0), { mode: 0o600 });
  } else if (!upload || q.get('id') !== upload.id || startAt !== upload.size || total !== upload.total) throw fail('Hochladen unterbrochen – bitte neu starten', 409);
  const u = upload;
  await new Promise((ok, no) => {
    let size = 0; const w = fs.createWriteStream(u.tmp, { flags: 'a', mode: 0o600 });
    req.on('data', d => { size += d.length; if (size > len) { req.destroy(); w.destroy(); no(fail('Teil zu groß')); } });
    req.on('error', () => { w.destroy(); no(fail('Hochladen abgebrochen')); });
    w.on('error', () => no(fail('Speichern fehlgeschlagen', 500)));
    w.on('finish', () => size === len ? ok() : no(fail('Hochladen unvollständig')));
    req.pipe(w);
  }).catch(async e => { try { await fsp.unlink(u.tmp); } catch {} if (upload === u) upload = null; throw e; });
  u.size += len;
  if (u.size < u.total) return { id: u.id, empfangen: u.size };
  upload = null;
  await fsp.rename(u.tmp, path.join(dir(web), u.name));
  const st = readState(web); st[u.name] = { kind: 'hochgeladen', heruntergeladen: true, original: u.original }; writeState(web, st);
  startCheck(web, u.name);
  prune(web, u.name).catch(() => {}); // Auslagern auf die WD dauert – im Hintergrund
  return { fertig: true, name: u.name, files: await list(web) };
}
// ---- Prüfen (restoreBackup.sh -c: Prüfsumme, Firmware-Version, Schlüssel) – dauert bei großen Sicherungen Minuten,
// darum im Hintergrund; das Ergebnis steht danach bei der Datei (geprueft). ----
const checking = new Set();
async function check(web, name) {
  if (typeof name !== 'string' || !NAME.test(name) || !fs.existsSync(path.join(dir(web), name))) throw fail('Datei nicht gefunden', 404);
  if (!fs.existsSync(script(web, 'restoreBackup'))) throw fail('Auf diesem System gibt es kein CCU-Einspielprogramm', 501);
  const r = await run(web, script(web, 'restoreBackup'), ['-c', path.join(dir(web), name)], 30 * 60000);
  const out = r.out.replace(/[^\x20-\x7e\n]/g, '').trim().slice(-3000), ver = /generated on ([0-9.]+), applying to ([0-9.]+)/.exec(out);
  const ok = r.code === 0 && /Config check processing only/.test(out), key = /security key/i.test(out) && /Enter security key|does NOT match/.test(out);
  const message = ok ? 'Sicherung ist in Ordnung (erstellt mit OpenCCU ' + (ver?.[1] || '?') + ', hier läuft ' + (ver?.[2] || '?') + ').' : key ? 'Die Sicherung oder die CCU ist mit einem Sicherheitsschlüssel geschützt – Einspielen nur per SSH (siehe Hilfe → Notfall).' : 'Sicherung ist beschädigt oder passt nicht zu dieser CCU.';
  const st = readState(web); if (st[name] || fs.existsSync(path.join(dir(web), name))) { st[name] = { ...(st[name] || {}), geprueft: { ok, at: new Date().toISOString(), version: ver?.[1] || '', message } }; writeState(web, st); }
  return { name, ok, version: ver?.[1] || '', laufend: ver?.[2] || '', schluessel: key, message, ausgabe: out };
}
function startCheck(web, name) {
  if (typeof name !== 'string' || !NAME.test(name) || !fs.existsSync(path.join(dir(web), name))) throw fail('Datei nicht gefunden', 404);
  if (checking.has(name)) return { laeuft: true };
  checking.add(name); check(web, name).catch(() => {}).finally(() => checking.delete(name));
  return { laeuft: true, message: 'Prüfung läuft (bei großen Sicherungen einige Minuten) …' };
}
// Frische Sicherung des jetzigen Stands liegt auf der WD (höchstens 2 Stunden alt)?
const frischAufWd = (web, now = Date.now()) => { const l = readState(web)._letzteAufWd; return !!(l && now - Date.parse(l.erstellt) < FRESH_MS); };
// ---- Einspielen (danach startet die CCU neu) ----
async function restore(web, name) {
  if (restoring) throw fail('Eine Sicherung wird bereits eingespielt – die CCU startet gleich neu', 409);
  if (job.state === 'running') throw fail('Es wird gerade eine Sicherung erstellt – bitte warten', 429);
  const files = await list(web), now = Date.now();
  const safe = f => f.kind === 'erstellt' && (f.heruntergeladen || f.aufWd) && now - Date.parse(f.at) < FRESH_MS;
  const vorher = files.find(f => safe(f) && f.name !== name) || files.find(f => safe(f) && f.name === name) || (frischAufWd(web, now) ? { aufWd: true } : null);
  if (!vorher) throw fail('Bitte zuerst eine frische Sicherung des jetzigen Stands erstellen und herunterladen oder auf die WD kopieren (höchstens 2 Stunden alt). Beim Einspielen löscht die CCU alles außer der gewählten Sicherung.', 409);
  if (checking.has(name)) throw fail('Die Prüfung läuft noch – bitte warten', 409);
  const g = readState(web)[name]?.geprueft; if (!g) throw fail('Bitte die Sicherung zuerst prüfen', 409);
  if (!g.ok) throw fail(g.message || 'Sicherung ist beschädigt oder passt nicht zu dieser CCU.', 409);
  if (now - Date.parse(g.at) > 3600000) throw fail('Die Prüfung ist älter als 1 Stunde – bitte erneut prüfen', 409);
  restoring = now;
  // Im Hintergrund: das Skript plant die Wiederherstellung und startet neu (-r). Die Verbindung bricht dabei ab.
  Promise.resolve().then(() => run(web, script(web, 'restoreBackup'), ['-r', path.join(dir(web), name)], 30 * 60000)).then(r => { if (r.code !== 0) { restoring = 0; job = { state: 'error', message: 'Einspielen abgebrochen (Code ' + r.code + '). Nichts geändert.', at: new Date().toISOString() }; } }).catch(() => { restoring = 0; });
  return { success: true, message: 'Die Sicherung wird eingespielt. Die CCU startet jetzt neu und packt sie dabei aus (ca. 5–10 Minuten). Nicht vom Strom trennen. Danach neu anmelden.' };
}

const isAdmin = auth => !!auth && !auth.session?.localBypass && (!auth.session?.role || auth.session.role === 'admin');
const METHODS = ['starteSicherungJetzt', 'getSicherungsUeberblick', 'setCcuSicherungPlan', 'holeCcuSicherungWd', 'kopiereCcuSicherungWd', 'getCcuSicherungen', 'downloadCcuSicherung', 'createCcuSicherung', 'uploadCcuSicherung', 'pruefeCcuSicherung', 'spieleCcuSicherungEin', 'loescheCcuSicherung'];
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!METHODS.includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d), gets = ['getCcuSicherungen', 'downloadCcuSicherung', 'getSicherungsUeberblick'];
  try {
    if (!isAdmin(auth)) { send(403, { error: 'Nur nach Anmeldung als Administrator möglich' }); return true; }
    if (req.method !== (gets.includes(method) ? 'GET' : 'POST')) { send(405, { error: (gets.includes(method) ? 'GET' : 'POST') + ' erforderlich' }); return true; }
    if (method === 'getCcuSicherungen') { send(200, await overview(web, { wdNeu: u.searchParams.get('wd') === '1' })); return true; }
    if (method === 'getSicherungsUeberblick') { send(200, await ueberblick(web)); return true; }
    if (method === 'downloadCcuSicherung') { await download(web, res, u.searchParams.get('name')); return true; }
    if (method === 'uploadCcuSicherung') { send(200, await uploadPart(web, req, u.searchParams)); return true; }
    const p = await require('./web-security').body(req);
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw fail('Ungültige Angabe');
    if (method === 'createCcuSicherung') { if (p.bestaetigt !== true || Object.keys(p).length !== 1) throw fail('Bitte ausdrücklich bestätigen'); send(200, await create(web)); return true; }
    if (method === 'starteSicherungJetzt') { if (Object.keys(p).some(k => k !== 'id') || typeof p.id !== 'string') throw fail('Ungültige Angabe'); send(200, await jetzt(web, p.id)); return true; }
    if (method === 'setCcuSicherungPlan') {
      if (Object.keys(p).some(k => !['enabled', 'everyDays', 'time'].includes(k)) || typeof p.enabled !== 'boolean' || !Number.isInteger(p.everyDays) || p.everyDays < 1 || p.everyDays > 30 || typeof p.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) throw fail('Zeitplan: alle 1 bis 30 Tage, Uhrzeit HH:MM');
      web.writeConfigPatch(c => { c.ccuSicherungPlan = { enabled: p.enabled, everyDays: p.everyDays, time: p.time }; });
      send(200, { ...(await overview(web)), message: p.enabled ? 'Zeitplan gespeichert: alle ' + p.everyDays + ' Tag(e) um ' + p.time + ' Uhr.' : 'Zeitplan ausgeschaltet.' }); return true;
    }
    if (Object.keys(p).some(k => !['name', 'bestaetigt'].includes(k))) throw fail('Ungültige Angabe');
    if (method === 'pruefeCcuSicherung') { send(200, startCheck(web, p.name)); return true; }
    if (method === 'kopiereCcuSicherungWd') { send(200, copyToWd(web, p.name)); return true; }
    if (method === 'holeCcuSicherungWd') { send(200, fromWd(web, p.name)); return true; }
    if (method === 'loescheCcuSicherung') {
      if (typeof p.name !== 'string' || !NAME.test(p.name)) throw fail('Datei ungültig'); if (restoring) throw fail('Eine Sicherung wird gerade eingespielt', 409);
      try { await fsp.unlink(path.join(dir(web), p.name)); } catch { throw fail('Datei nicht gefunden', 404); }
      const st = readState(web); delete st[p.name]; writeState(web, st); send(200, await overview(web)); return true;
    }
    if (p.bestaetigt !== true) throw fail('Bitte ausdrücklich bestätigen');
    send(200, await restore(web, p.name));
  } catch (e) { if (!res.headersSent) send(e.status || 500, { error: e.status ? e.message : 'Sicherung: Anfrage fehlgeschlagen' }); else try { res.destroy(); } catch {} }
  return true;
}
// ---- Bridge-Sicherungen vor Installationen (matter-sicherung-vor-*.tar.gz, ~50 MB) zusätzlich auf die WD ----
// (Wunsch Thomas 12.10.2026: „alles auslagern, was geht“; Zugang von „WD (Netzwerkspeicher) verbinden“). Auf der CCU behält
// der Installer die letzten 3; auf der WD bleiben die neuesten 10 (Name mit 14-stelligem Zeitstempel). Jede Datei nur einmal.
const BRIDGE = /^matter-sicherung-vor-[A-Za-z0-9._-]{1,80}\.tar\.gz$/;
async function bridgeAuslagern(web) {
  if (!wdReady(web) || wdState.laeuft || restoring) return 0;
  let names = []; try { names = (await fsp.readdir(dir(web))).filter(n => BRIDGE.test(n)).sort(); } catch { return 0; }
  const st = readState(web), done = st._bridgeWd && typeof st._bridgeWd === 'object' ? st._bridgeWd : {}; let n = 0;
  wdState = { ...wdState, laeuft: true };
  try {
    for (const name of names) {
      if (done[name]) continue;
      const f = path.join(dir(web), name), d = (await fsp.lstat(f)).mtime, p2 = x => String(x).padStart(2, '0');
      const stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
      try { const r = await wd(web).storeBackup(web, f, 'bridge-sicherung-' + stamp + '.tar.gz'); done[name] = { at: new Date().toISOString(), pfad: r?.path || '' }; n++; }
      catch (e) { wdState = { ...wdState, fehler: 'Bridge-Sicherung nicht auf die WD kopiert: ' + String(e.message || e).slice(0, 140) }; break; }
    }
  } finally { wdState = { ...wdState, laeuft: false }; }
  const st2 = readState(web); st2._bridgeWd = Object.fromEntries(Object.entries(done).filter(([k]) => names.includes(k))); writeState(web, st2);
  return n;
}
// Beim Start der Bridge (nach 3 Minuten) und alle 6 Stunden: neue Bridge-Sicherungen und überzählige CCU-Sicherungen auslagern
let autoTimer = null;
function start(web) {
  if (autoTimer) return;
  const run = () => { bridgeAuslagern(web).catch(() => {}).then(() => prune(web, null)).catch(() => {}); };
  setTimeout(run, 180000).unref?.(); autoTimer = setInterval(run, 6 * 3600000); autoTimer.unref?.();
  // Zeitplan jede Minute prüfen (startet nur, wenn fällig)
  const pt = setInterval(() => planTick(web).catch(() => {}), 60000); pt.unref?.();
}
module.exports = { handle, start, _test: { jetzt, lastStart, bridgeAuslagern, list, nextRun, planTick, wdFiles, ueberblick, cleanWd, cleanWdSystem, wdSystemCache, wdStatusCache, reset: () => { job = { state: 'idle', message: '', at: null }; restoring = 0; upload = null; holen = null; checking.clear(); wdState = { laeuft: false, fehler: null, letzte: null }; Object.assign(wdCache, { at: 0, files: [], fehler: null }); }, wd: () => wdState, checking: () => checking.size, job: () => job } };
