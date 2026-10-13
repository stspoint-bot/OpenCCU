'use strict';
// Verbindung der Bridge zur CCU („Box“): Adresse, Ports, Benutzer und Passwort ansehen, testen
// und speichern. Das Passwort wird verschlüsselt im vorhandenen Schlüsselspeicher (AES-256-GCM,
// wie bei SMART+/Backup) abgelegt, nie an den Browser zurückgegeben und aus der Klartext-
// Konfiguration entfernt. Lesen für angemeldete Nutzer, Testen/Speichern nur für CCU-Administratoren.
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const PORTS = { 'BidCos-RF': 2001, 'HmIP-RF': 2010, CUxD: 8701, VirtualDevices: 9292 };

function vault(web) {
  const { Vault } = require('./smartplus');
  return new Vault(path.join(path.dirname(web.deps.configPath), 'ccu-connection-secrets.json'));
}
function readSecret(web) { try { return vault(web).read(); } catch { return {}; } }
// Gespeichertes Passwort in die laufende Verbindung übernehmen (ohne Neustart, nur Speicher).
function applySecret(web) {
  const s = readSecret(web), c = web.deps.getConnector?.();
  if (c && c.config && typeof s.password === 'string') { if (s.user) c.config.user = s.user; c.config.password = s.password; }
}

function validHost(host) {
  if (typeof host !== 'string') return false;
  host = host.trim();
  return net.isIP(host) !== 0 || HOST.test(host);
}
function current(web) {
  const config = web.security.configSnapshot.read(), ccu = config.ccu || {}, secret = readSecret(web);
  const connector = web.deps.getConnector?.();
  const interfaces = Object.fromEntries(Object.entries(ccu.interfaces || {}).map(([name, value]) => [name, {
    enabled: value.enabled === true, port: value.port,
    connected: !!(connector && connector.clients?.has(name) && !connector.failedInterfaces?.has(name))
  }]));
  return {
    host: ccu.host || '127.0.0.1', regaPort: ccu.regaPort || 80, user: secret.user || ccu.user || '',
    hasPassword: typeof secret.password === 'string' && secret.password.length > 0,
    plaintextPassword: typeof ccu.password === 'string' && ccu.password.length > 0,
    runningHost: connector?.config?.host || null, interfaces
  };
}

function tcp(host, port, timeout = 3000) {
  return new Promise(resolve => {
    const started = Date.now(); let done = false;
    let socket;
    const finish = (ok, detail) => { if (done) return; done = true; try { socket?.destroy(); } catch {} resolve({ ok, ms: Date.now() - started, detail }); };
    try {
      socket = net.createConnection({ host, port, timeout });
      socket.on('connect', () => finish(true, 'erreichbar'));
      socket.on('timeout', () => finish(false, 'keine Antwort'));
      socket.on('error', e => finish(false, e.code === 'ECONNREFUSED' ? 'Port geschlossen' : e.code || 'nicht erreichbar'));
    } catch (e) { finish(false, e.message); }
  });
}
function jsonRpc(host, port, method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ version: '1.1', method, params });
    const req = http.request({ host, port, path: '/api/homematic.cgi', method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let raw = '', size = 0;
      res.on('data', c => { size += c.length; if (size > 65536) req.destroy(Error('Antwort zu groß')); else raw += c; });
      res.on('end', () => { try { const r = JSON.parse(raw); if (r.error) reject(Error(r.error.message || 'abgelehnt')); else resolve(r.result); } catch { reject(Error('keine gültige CCU-Antwort (HTTP ' + res.statusCode + ')')); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(Error('keine Antwort')));
    req.end(data);
  });
}

function checkInput(p, keys) {
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !keys.includes(k))) throw fail('Unerwartete Felder in der Anfrage');
  if (!validHost(p.host)) throw fail('Adresse der CCU ungültig (IP-Adresse oder Name, ohne http://)');
  if (p.regaPort !== undefined && (!Number.isInteger(p.regaPort) || p.regaPort < 1 || p.regaPort > 65535)) throw fail('Port ungültig');
  if (p.user !== undefined && (typeof p.user !== 'string' || p.user.length > 64 || CONTROL.test(p.user))) throw fail('Benutzername ungültig (höchstens 64 Zeichen)');
  if (p.password !== undefined && (typeof p.password !== 'string' || p.password.length > 256 || CONTROL.test(p.password))) throw fail('Passwort ungültig (höchstens 256 Zeichen)');
  return { host: p.host.trim(), regaPort: p.regaPort || 80, user: (p.user || '').trim(), password: p.password || '' };
}

async function test(web, p) {
  const input = checkInput(p, ['host', 'regaPort', 'user', 'password']);
  // Leeres Passwort: das gespeicherte für denselben Benutzer verwenden.
  const secret = readSecret(web);
  if (!input.password && input.user && secret.user === input.user) input.password = secret.password || '';
  const checks = [];
  const ports = [['CCU-Weboberfläche / JSON-API', input.regaPort], ['Logikschicht ReGa (lokal)', 8181], ...Object.entries(PORTS).map(([n, port]) => [n, port])];
  for (const [label, port] of ports) { const r = await tcp(input.host, port); checks.push({ label: label + ' (Port ' + port + ')', ok: r.ok, detail: r.detail }); }
  let login = { ok: null, detail: 'Kein Benutzer angegeben – Anmeldung nicht geprüft' };
  if (input.user) {
    try {
      const sid = await jsonRpc(input.host, input.regaPort, 'Session.login', { username: input.user, password: input.password });
      if (typeof sid !== 'string' || !sid) throw Error('keine Sitzung erhalten');
      let admin = false;
      try { await jsonRpc(input.host, input.regaPort, 'Firewall.getConfiguration', { _session_id_: sid }); admin = true; } catch {}
      await jsonRpc(input.host, input.regaPort, 'Session.logout', { _session_id_: sid }).catch(() => {});
      login = { ok: true, admin, detail: admin ? 'Anmeldung erfolgreich (Administrator)' : 'Anmeldung erfolgreich, aber ohne Administratorrechte' };
    } catch (e) { login = { ok: false, detail: 'Anmeldung fehlgeschlagen: ' + e.message }; }
  }
  input.password = '';
  const reachable = checks.filter(c => c.ok).length;
  return { checks, login, summary: reachable ? `${reachable} von ${checks.length} Diensten erreichbar` : 'CCU unter dieser Adresse nicht erreichbar' };
}

async function save(web, p) {
  const input = checkInput(p, ['host', 'regaPort', 'user', 'password']);
  const before = current(web), secret = readSecret(web);
  // Leeres Passwort behält das gespeicherte nur für denselben Benutzer.
  const password = input.password || (secret.user === input.user ? secret.password || '' : '');
  if (input.user || password) vault(web).write({ user: input.user, password });
  else vault(web).write({});
  web.writeConfigPatch(c => {
    c.ccu = { ...(c.ccu || {}), host: input.host, regaPort: input.regaPort };
    if (input.user) c.ccu.user = input.user; else delete c.ccu.user;
    delete c.ccu.password; // nie im Klartext in der Konfiguration
  });
  applySecret(web);
  input.password = '';
  const restartRequired = before.host !== input.host || before.regaPort !== input.regaPort;
  return { success: true, restartRequired, settings: current(web), message: restartRequired ? 'Gespeichert. Die neue Adresse gilt nach einem Neustart der Bridge.' : 'Gespeichert. Zugangsdaten sind sofort wirksam.' };
}

async function handle(web, req, res, u, auth) {
  const method = u.searchParams.get('method');
  if (!['getCcuConnection', 'testCcuConnection', 'saveCcuConnection'].includes(method)) return false;
  const send = (status, data) => web.sendJson(res, status, data);
  try {
    if (method === 'getCcuConnection') { if (req.method !== 'GET') return send(405, { error: 'GET erforderlich' }), true; applySecret(web); send(200, { settings: current(web), admin: !!(auth && !auth.session?.localBypass) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    send(200, method === 'testCcuConnection' ? await test(web, p) : await save(web, p));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Verbindungseinstellung fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, validHost, checkInput, applySecret };
