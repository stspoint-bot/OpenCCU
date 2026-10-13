'use strict';
// Neue Geräte anlernen – eigener Weg ohne OpenCCU-Oberfläche:
// 1. Anlernmodus der Funkschnittstellen (Homematic / Homematic IP) starten und stoppen.
// 2. Neu hinzugekommene Geräte erkennen: Beim Start des Anlernmodus merkt sich die Bridge, welche
//    Geräte es schon gibt. Alles, was danach über die Funkverbindung neu gemeldet wird, gilt als neu.
//    Dafür wird der Posteingang der OpenCCU nicht mehr gelesen.
// 3. Fertigstellen (Name, Raum, Apple Home) geschieht auf der Seite mit den vorhandenen, bereits
//    genutzten Funktionen der Bridge; „Fertig“ nimmt das Gerät nur aus der Liste der neuen Geräte.
// Alle Aktionen nur für CCU-Administratoren. Schreibende Funkbefehle werden nie wiederholt.
const fs = require('node:fs');
const path = require('node:path');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const IFACES = { 'HmIP-RF': 'Homematic IP', 'BidCos-RF': 'Homematic (BidCos)' };
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const KEEP_MS = 14 * 86400000, MAX_KNOWN = 5000;

function connector(web) { const c = web.deps.getConnector(); if (!c || typeof c.rpcCall !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503); return c; }
function available(web) {
  const c = web.deps.getConnector(), cfg = c?.config?.interfaces || {};
  return Object.keys(IFACES).filter(n => cfg[n]?.enabled !== false && c?.clients?.has?.(n) && !c?.failedInterfaces?.has?.(n));
}
const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Error('keine Antwort')), ms))]);

// ---- Merkliste „schon bekannt“ -------------------------------------------------------------
const file = web => path.join(path.dirname(web.deps.configPath), 'anlernen-bekannt.json');
function readKnown(web) {
  try {
    const raw = JSON.parse(fs.readFileSync(file(web), 'utf8'));
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.startedAt) || !Array.isArray(raw.known) || raw.known.length > MAX_KNOWN || raw.known.some(a => typeof a !== 'string' || !DEVICE.test(a))) return null;
    if (Date.now() - raw.startedAt > KEEP_MS) return null; // nach 14 Tagen gilt nichts mehr als „neu“
    return { startedAt: raw.startedAt, known: new Set(raw.known) };
  } catch { return null; }
}
function writeKnown(web, startedAt, known) { require('./durable-storage').atomicJson(file(web), { startedAt, known: [...known].slice(0, MAX_KNOWN) }); }
function deviceAddresses(web) { const c = web.deps.getConnector(); return [...(c?.getDevices?.()?.keys?.() || [])].filter(a => typeof a === 'string' && DEVICE.test(a)); }
function recent(web) {
  const state = readKnown(web); if (!state) return [];
  const c = web.deps.getConnector(), devices = c?.getDevices?.() || new Map(), channels = c?.getChannels?.() || new Map(), mapped = web.deps.getDevices?.() || new Map();
  const out = [];
  for (const [address, device] of devices) {
    if (typeof address !== 'string' || !DEVICE.test(address) || state.known.has(address)) continue;
    const list = [...channels.keys()].filter(a => typeof a === 'string' && a.startsWith(address + ':'));
    out.push({ address, type: String(device?.type || '').slice(0, 64), interface: String(device?.interface || '').slice(0, 32), label: IFACES[device?.interface] || String(device?.interface || ''), channels: list.length, usable: list.filter(a => mapped.has(a)) });
    if (out.length >= 50) break;
  }
  return out;
}

async function status(web) {
  const c = web.deps.getConnector();
  const interfaces = await Promise.all(Object.entries(IFACES).map(async ([name, label]) => {
    const connected = available(web).includes(name);
    let remaining = null, error = null;
    if (connected) { try { const v = await timeout(c.rpcCall(name, 'getInstallMode', []), 4000); remaining = Number.isFinite(Number(v)) ? Number(v) : 0; } catch (e) { error = e.message; } }
    return { name, label, connected, remaining, error };
  }));
  let list = null, listError = null;
  try { list = recent(web); } catch (e) { listError = e.message; }
  return { interfaces, recent: list, recentError: listError, checkedAt: new Date().toISOString() };
}

function checkFields(p, keys) { if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) throw fail('Unerwartete Felder in der Anfrage'); }
function targets(web, iface) {
  const list = iface === 'all' ? available(web) : [iface];
  if (!list.length || list.some(n => !Object.hasOwn(IFACES, n))) throw fail('Keine passende verbundene Funkschnittstelle');
  for (const n of list) if (!available(web).includes(n)) throw fail(IFACES[n] + ' ist nicht verbunden', 503);
  return list;
}
async function start(web, p) {
  checkFields(p, ['interface', 'seconds']);
  const seconds = p.seconds === undefined ? 60 : p.seconds;
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 300) throw fail('Dauer 30 bis 300 Sekunden');
  const c = connector(web), list = targets(web, p.interface || 'all');
  // Vor dem Funkbefehl merken, was es schon gibt. Geräte, die noch als „neu“ in der Liste
  // stehen, bleiben neu, bis sie mit „Fertig“ abgeschlossen wurden.
  const before = readKnown(web), now = deviceAddresses(web);
  const known = new Set(now.filter(a => !before || before.known.has(a)));
  if (!before) for (const a of now) known.add(a);
  writeKnown(web, Date.now(), known);
  const results = [];
  for (const name of list) {
    try {
      // Homematic: (an, Dauer, Modus 1 = normal). Homematic IP akzeptiert je nach Version 2 oder 3 Werte.
      try { await timeout(c.rpcCall(name, 'setInstallMode', [true, seconds, 1]), 5000); }
      catch (e) { if (name !== 'HmIP-RF') throw e; await timeout(c.rpcCall(name, 'setInstallMode', [true, seconds]), 5000); }
      results.push({ name, ok: true });
    } catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  const ok = results.filter(r => r.ok).map(r => IFACES[r.name]);
  if (!ok.length) throw fail('Anlernmodus konnte nicht gestartet werden: ' + results.map(r => IFACES[r.name] + ': ' + r.error).join('; '), 502);
  return { success: true, results, message: 'Anlernmodus aktiv für ' + ok.join(' und ') + ' (' + seconds + ' Sekunden). Jetzt am Gerät die Anlerntaste drücken bzw. die Batterie einlegen.' };
}
// Anlernen per Seriennummer und Schlüssel (ersetzt „Geräte anlernen“ der alten CCU, Wunsch Thomas 12.10.2026):
// Homematic IP: SGTIN (24 Zeichen) + Gerätekey (32 Zeichen) vom Aufkleber → Anlernmodus nur für dieses Gerät (Whitelist).
// Homematic (BidCos): Seriennummer (10 Zeichen) → addDevice. Einmal senden, Ergebnis anzeigen; der Schlüssel wird nicht gespeichert.
async function startWithKey(web, p) {
  checkFields(p, ['sgtin', 'key', 'serial']);
  const c = connector(web);
  const before = readKnown(web), now = deviceAddresses(web), known = new Set(now.filter(a => !before || before.known.has(a)));
  if (!before) for (const a of now) known.add(a);
  if (typeof p.serial === 'string' && p.serial) {
    const serial = p.serial.trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(serial)) throw fail('Seriennummer: 10 Zeichen (Buchstaben und Ziffern), z. B. MEQ1234567');
    writeKnown(web, Date.now(), known);
    try { await timeout(c.rpcCall('BidCos-RF', 'addDevice', [serial]), 30000); } catch (e) { throw fail('Homematic-Gerät nicht angelernt: ' + String(e.message || 'Fehler').slice(0, 120) + '. Gerät in Funkreichweite? Seriennummer richtig?', 502); }
    return { success: true, message: 'Homematic-Gerät ' + serial + ' wird angelernt. Es erscheint gleich unten bei den neuen Geräten.' };
  }
  const sgtin = String(p.sgtin || '').replace(/[\s-]/g, '').toUpperCase(), key = String(p.key || '').replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(sgtin)) throw fail('SGTIN: 24 Zeichen (0–9, A–F) vom Aufkleber, Bindestriche sind erlaubt');
  if (!/^[0-9A-F]{32}$/.test(key)) throw fail('Gerätekey: 32 Zeichen (0–9, A–F) vom Aufkleber');
  writeKnown(web, Date.now(), known);
  try { await timeout(c.rpcCall('HmIP-RF', 'setInstallModeWithWhitelist', [true, 120, [{ ADDRESS: sgtin, KEY_MODE: 'LOCAL', KEY: key }]]), 8000); }
  catch (e) { throw fail('Anlernen per Schlüssel nicht gestartet: ' + String(e.message || 'Fehler').slice(0, 120), 502); }
  return { success: true, message: 'Anlernmodus für dieses Gerät aktiv (2 Minuten). Jetzt die Batterie einlegen bzw. das Gerät mit Strom verbinden.' };
}
async function stop(web, p) {
  checkFields(p, ['interface']);
  const c = connector(web), results = [];
  for (const name of targets(web, p.interface || 'all')) { try { await timeout(c.rpcCall(name, 'setInstallMode', [false]), 5000); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, error: e.message }); } }
  return { success: results.some(r => r.ok), results, message: 'Anlernmodus beendet.' };
}
async function finish(web, p) {
  checkFields(p, ['address']);
  if (typeof p.address !== 'string' || !DEVICE.test(p.address)) throw fail('Gerät ungültig');
  const state = readKnown(web);
  if (!state || !recent(web).some(d => d.address === p.address)) throw fail('Dieses Gerät steht nicht (mehr) in der Liste der neuen Geräte', 404);
  state.known.add(p.address); writeKnown(web, state.startedAt, state.known);
  rememberFinished(web, p.address);
  return { success: true, message: 'Gerät ist fertig eingerichtet.' };
}
// „Neu angelernt (letzte 3 Stunden)“ auf der Geräteseite: Zeitpunkt von „Fertig“ je Gerät (höchstens 50, älter als 3 h fällt weg).
const RECENT_MS = 3 * 3600000;
const finishedFile = web => path.join(path.dirname(web.deps.configPath), 'neu-angelernt.json');
function finished(web) {
  try { const raw = JSON.parse(fs.readFileSync(finishedFile(web), 'utf8')); return raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([a, t]) => DEVICE.test(a) && Number.isFinite(t) && Date.now() - t < RECENT_MS)) : {}; } catch { return {}; }
}
function rememberFinished(web, address) {
  try { const all = { ...finished(web), [address]: Date.now() }; const keep = Object.fromEntries(Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 50)); require('./durable-storage').atomicJson(finishedFile(web), keep); } catch {}
}
async function handle(web, req, res, u, auth) {
  const method = u.searchParams.get('method');
  if (!['getInstallStatus', 'startInstallMode', 'stopInstallMode', 'finishNewDevice', 'startInstallWithKey'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (method === 'getInstallStatus') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await status(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || auth.session?.localBypass || (auth.session?.role && auth.session.role !== 'admin')) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    send(200, await ({ startInstallMode: start, stopInstallMode: stop, finishNewDevice: finish, startInstallWithKey: startWithKey }[method])(web, p));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Anlernen fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, IFACES, finished, _test: { recent, readKnown, rememberFinished } };
