'use strict';
// Systemzustand als Ampel (Wunsch Thomas 13.10.2026): fasst an einem Ort zusammen, was gut, was nicht so gut und was
// schlecht ist – CCU3, WD, Sicherungen, Internet (aus dem Wartungsscript der CCU3, /tmp/ccu3-wartung/status.json),
// Bridge-Dienste/Integrationen (service-monitor) und Gerätemeldungen (ccu-zentrale). Nur lesen; „Jetzt prüfen“ startet
// das Wartungsscript mit festen Argumenten (nur Administrator, höchstens einmal pro Minute).
const fs = require('node:fs'), { execFile } = require('node:child_process');
const STATUS = '/tmp/ccu3-wartung/status.json', SCRIPT = '/usr/local/etc/config/ccu3-wartung/wartung.sh';
const STUFEN = ['ok', 'hinweis', 'warnung', 'fehler'];
const ALT_MIN = 40; // Prüfstand älter → Wartungsscript läuft nicht mehr
let lastRun = 0, running = null;
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const txt = (v, n = 300) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : '';

function wartung(now = Date.now(), file = STATUS) {
  let raw;
  try { const s = fs.statSync(file); if (!s.isFile() || s.size > 65536) throw Error(); raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { punkte: [{ id: 'wartung-fehlt', bereich: 'CCU3', stufe: 'warnung', text: 'Kein Prüfstand des Wartungsscripts vorhanden (läuft es noch?)' }], erstellt: null }; }
  if (!raw || raw.version !== 1 || !Array.isArray(raw.punkte)) return { punkte: [{ id: 'wartung-ungueltig', bereich: 'CCU3', stufe: 'warnung', text: 'Prüfstand des Wartungsscripts ist ungültig' }], erstellt: null };
  const punkte = raw.punkte.slice(0, 120).filter(p => p && STUFEN.includes(p.stufe) && typeof p.id === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(p.id))
    .map(p => ({ id: p.id, bereich: ['CCU3', 'WD', 'Sicherungen', 'Internet'].includes(p.bereich) ? p.bereich : 'CCU3', stufe: p.stufe, text: txt(p.text) }));
  const erstellt = Number.isFinite(raw.erstellt) ? raw.erstellt * 1000 : null;
  if (!erstellt || now - erstellt > ALT_MIN * 60000) punkte.unshift({ id: 'wartung-alt', bereich: 'CCU3', stufe: 'warnung', text: 'Wartungsscript hat seit ' + (erstellt ? Math.round((now - erstellt) / 60000) + ' Min.' : 'längerem') + ' nicht geprüft' });
  return { punkte, erstellt, naechste: Number.isFinite(raw.naechste) ? raw.naechste * 1000 : null, aufraeumen: txt(raw.aufraeumen), wdWartung: txt(raw.wdWartung), langtest: langtest(raw.langtest) };
}
// Festplatten-Langtest der WD (boot.sh, alle 10 Tage um 3 Uhr oder per Knopf): nur bekannte Felder
function langtest(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return null;
  return { stufe: STUFEN.includes(l.stufe) ? l.stufe : 'hinweis', text: txt(l.text, 160), letzterStart: txt(l.letzterStartText, 20), letzterAbschluss: txt(l.letzterAbschlussText, 20),
    ergebnis: txt(l.ergebnis, 80), laeuftProzent: Number.isInteger(l.laeuftProzent) && l.laeuftProzent >= 0 && l.laeuftProzent <= 100 ? l.laeuftProzent : null,
    naechster: txt(l.naechsterText, 40), auftrag: txt(l.auftragText, 120), rhythmus: txt(l.rhythmus, 60) };
}

function dienste(web) {
  const out = [];
  try {
    const st = web.security?.monitor?.status?.();
    for (const r of (st?.services || []).slice(0, 60)) {
      if (!r || r.status === 'disabled') continue;
      // Geräte (Steckdosen, Lampen, Dyson …), die einfach ausgesteckt sind, sind kein Fehler (Wunsch Thomas 13.10.2026):
      // abgewählte Ausfallwarnung bzw. Onlineprüfung aus → gar nicht zeigen; sonst ohne Verbindung → grau „aus“ (zählt nicht für die Ampel).
      // Dienste und Schnittstellen der CCU bleiben bei Ausfall rot.
      const geraet = r.canIgnoreWarning === true;
      if (geraet && r.status !== 'online' && (r.warningIgnored || r.notifyEnabled === false)) continue;
      if (!geraet && r.warningIgnored) continue;
      const stufe = r.status === 'online' ? 'ok' : r.status === 'offline' ? (geraet ? 'aus' : 'fehler') : 'hinweis';
      const wie = r.status === 'online' ? 'läuft' : r.status === 'offline' ? (geraet ? 'ohne Verbindung – ausgesteckt oder ohne Strom?' : 'nicht erreichbar') : r.status === 'pending' ? 'Neustart der Bridge nötig' : 'nicht prüfbar';
      out.push({ id: 'dienst:' + txt(String(r.id), 80), bereich: 'Dienste & Integrationen', stufe, text: txt(String(r.name || r.id), 80) + ' – ' + wie });
    }
  } catch {}
  if (!out.length) out.push({ id: 'dienste-leer', bereich: 'Dienste & Integrationen', stufe: 'hinweis', text: 'Dienstprüfung der Bridge noch ohne Ergebnis' });
  return out;
}

function geraete(web) {
  let m;
  try { m = require('./ccu-zentrale')._internal.messages(web); } catch { return [{ id: 'meldungen-fehlt', bereich: 'Geräte', stufe: 'hinweis', text: 'Gerätemeldungen der CCU nicht lesbar' }]; }
  // Geräte mit abgeschalteten Meldungen (meldungen-aus.js, „Geräte (neu)“) nicht zeigen
  let M = null; try { M = require('./meldungen-aus'); } catch {}
  const list = (Array.isArray(m) ? m : (m?.messages || [])).filter(x => !M || !M.isOff(web, x.address));
  if (!list.length) return [{ id: 'meldungen', bereich: 'Geräte', stufe: 'ok', text: 'Keine Gerätemeldungen – alle Geräte in Ordnung' }];
  // „Nicht erreichbar“ (UNREACH) heißt meist: ausgesteckt oder ohne Strom → grau „aus“, kein Fehler (Wunsch Thomas 13.10.2026)
  return list.slice(0, 40).map(x => ({ id: 'meldung:' + txt(String(x.id), 80), bereich: 'Geräte', stufe: x.type === 'UNREACH' ? 'aus' : x.level === 'bad' ? 'fehler' : 'hinweis',
    text: txt(String(x.device || 'Gerät'), 60) + (x.room ? ' (' + txt(String(x.room), 40) + ')' : '') + ': ' + txt(String(x.label || x.type || 'Meldung'), 80) }));
}

// Tasmota-Geräte mit Onlineprüfung (tasmota-wache.js): nicht erreichbar → grau „aus“ (ausgesteckt ist kein Fehler), sonst eine Sammelzeile
function tasmota(web) {
  let hosts = []; try { hosts = require('./tasmota-wache')._test.wache(web).status().hosts.filter(h => h.onlineCheck); } catch { return []; }
  if (!hosts.length) return [];
  const off = hosts.filter(h => !h.online);
  return [...off.slice(0, 30).map(h => ({ id: 'tasmota:' + h.mac, bereich: 'Dienste & Integrationen', stufe: 'aus', text: 'Tasmota · ' + txt(h.name || h.mac, 60) + ' – ohne Verbindung – ausgesteckt oder ohne Strom?' })),
    { id: 'tasmota', bereich: 'Dienste & Integrationen', stufe: 'ok', text: 'Tasmota: ' + (hosts.length - off.length) + ' von ' + hosts.length + ' Geräten erreichbar' }];
}

function zustand(web, now = Date.now(), file = STATUS) {
  const w = wartung(now, file), punkte = [...w.punkte, ...dienste(web), ...tasmota(web), ...geraete(web)];
  const zahl = s => punkte.filter(p => p.stufe === s).length;
  // Rot = Problem (dafür kommt auch eine WhatsApp), Gelb = nicht so gut / beobachten, Grün = alles gut
  const ampel = zahl('fehler') || zahl('warnung') ? 'rot' : zahl('hinweis') ? 'gelb' : 'gruen';
  return { ampel, zaehler: { ok: zahl('ok'), aus: zahl('aus'), hinweis: zahl('hinweis'), warnung: zahl('warnung'), fehler: zahl('fehler') },
    erstellt: w.erstellt, naechste: w.naechste, aufraeumen: w.aufraeumen || '', wdWartung: w.wdWartung || '', langtest: w.langtest || null, punkte, jetzt: now };
}

// Knopf „Festplatte jetzt prüfen“: Wartungsscript stellt der WD den Auftrag (die WD startet den Test binnen Sekunden)
let lastScan = 0;
function scanStarten() {
  if (Date.now() - lastScan < 600000) return Promise.reject(fail('Der Festplatten-Scan wurde gerade erst angefordert – bitte 10 Minuten warten', 429));
  if (!fs.existsSync(SCRIPT)) return Promise.reject(fail('Wartungsscript ist auf dieser CCU nicht eingerichtet', 404));
  lastScan = Date.now();
  return new Promise((resolve, reject) => execFile('/bin/sh', [SCRIPT, 'langtest'], { timeout: 30000, maxBuffer: 16384 }, (err, out) => {
    if (err) { lastScan = 0; reject(fail('Auftrag an die WD nicht möglich: ' + txt(String(out || err.message), 120), 502)); return; }
    if (!String(out).includes('Auftrag an die WD gestellt')) { lastScan = 0; reject(fail('Gerade läuft eine Prüfung – bitte in einer Minute noch einmal drücken', 409)); return; }
    resolve({ message: 'Auftrag an die WD gestellt. Der Scan startet in wenigen Sekunden und dauert etwa 4,5 Stunden; die WD arbeitet dabei normal weiter.' });
  }));
}

function pruefen() {
  if (running) return running;
  if (Date.now() - lastRun < 60000) return Promise.reject(fail('Bitte höchstens einmal pro Minute prüfen', 429));
  if (!fs.existsSync(SCRIPT)) return Promise.reject(fail('Wartungsscript ist auf dieser CCU nicht eingerichtet', 404));
  lastRun = Date.now();
  running = new Promise(resolve => execFile('/bin/sh', [SCRIPT, 'pruefen'], { timeout: 90000, maxBuffer: 65536 }, () => resolve()))
    .finally(() => { running = null; });
  return running;
}

const isAdmin = auth => !!auth && !auth.session?.localBypass && (!auth.session?.role || auth.session.role === 'admin');
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getSystemzustand', 'systemzustandPruefen', 'festplattenScanStarten'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    if (method === 'getSystemzustand') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, zustand(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!isAdmin(auth)) { send(403, { error: 'Nur nach Anmeldung als Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    if (p && (typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length)) throw fail('Ungültige Angabe');
    if (method === 'festplattenScanStarten') { send(200, await scanStarten()); return true; }
    await pruefen(); send(200, zustand(web));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Systemzustand nicht abrufbar' }); }
  return true;
}
module.exports = { handle, _test: { wartung, langtest, dienste, tasmota, geraete, zustand, reset: () => { lastRun = 0; running = null; lastScan = 0; } } };
