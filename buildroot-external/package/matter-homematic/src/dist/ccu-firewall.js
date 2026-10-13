'use strict';
// Firewall der Zentrale (Wunsch Thomas, 12.10.2026): ansehen und ändern in der neuen Oberfläche statt in der alten OpenCCU-Seite.
// Arbeitet wie OpenCCU selbst: Einstellungen in /etc/config/firewall.conf (gleiches Format wie libfirewall.tcl),
// anwenden mit /bin/setfirewall.tcl. Nur für CCU-Administratoren.
// Schutz vor dem Aussperren:
// - Ports, die Matter/Apple Home und diese Oberfläche brauchen (5353, 5540, 8090), lassen sich nicht entfernen.
// - Nach dem Anwenden muss der Browser innerhalb von 90 Sekunden „Funktioniert“ bestätigen – sonst wird die vorherige
//   Einstellung automatisch wiederhergestellt (wie bei einer Bildschirmauflösung am PC).
// - Vor jeder Änderung eine Sicherung der alten Datei daneben.
const fs = require('node:fs'), { execFile } = require('node:child_process');
const DEFAULT_PATHS = Object.freeze({ conf: '/etc/config/firewall.conf', apply: '/bin/setfirewall.tcl', external: '/etc/config/AllowExternalAccess' });
const REQUIRED = Object.freeze({ 5353: 'Apple Home findet die Bridge (mDNS)', 5540: 'Matter (Apple Home)', 8090: 'diese Oberfläche' });
const KNOWN_PORTS = Object.freeze({ 80: 'alte Oberfläche (HTTP)', 81: 'Add-on-Seiten', 85: 'Add-on-Seiten', 8181: 'ReGa-Skripte', 9292: 'Funk-Dienst (XML-RPC)', 9874: 'Bridge-Rückmeldungen', 9875: 'Bridge-Rückmeldungen (HmIP/BidCos)', 9876: 'Bridge-Rückmeldungen (früher CUxD)', 9877: 'Bridge-Rückmeldungen', 5353: REQUIRED[5353], 5540: REQUIRED[5540], 8090: REQUIRED[8090], 8701: 'CUxD (entfernt)' });
const SERVICES = Object.freeze({ XMLRPC: 'Funk-Schnittstellen (XML-RPC)', REGA: 'Logikschicht (ReGa / Skripte)', NEOSERVER: 'Mediola NEO Server', SNMP: 'SNMP (Netzwerküberwachung)' });
const ACCESS = ['full', 'restricted', 'none'], MODES = ['MOST_OPEN', 'RESTRICTIVE'];
const LIMITS = Object.freeze({ ips: 20, ports: 50, confirmMs: 90000 });
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const paths = web => ({ ...DEFAULT_PATHS, ...(web.deps?.firewallPaths || {}) });

// IPv4/IPv6-Adresse oder Netz (CIDR) – streng, damit nichts Fremdes in die Datei gelangt.
function validIp(s) {
  if (typeof s !== 'string' || s.length > 50) return false;
  const [addr, bits, more] = s.split('/'); if (more !== undefined) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return addr.split('.').every(x => Number(x) <= 255) && (bits === undefined || (/^\d{1,2}$/.test(bits) && Number(bits) <= 32));
  if (/^[0-9a-fA-F:]{2,39}$/.test(addr) && addr.includes(':') && (addr.match(/::/g) || []).length <= 1) return bits === undefined || (/^\d{1,3}$/.test(bits) && Number(bits) <= 128);
  return false;
}
const validPort = p => Number.isInteger(p) && p >= 1 && p <= 65535;

function parse(text) {
  const cfg = { mode: 'RESTRICTIVE', ips: [], userPorts: [], services: {} };
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const sec = /^\[SERVICE ([A-Z0-9_]+)\]$/.exec(line); if (sec) { section = sec[1]; cfg.services[section] = cfg.services[section] || { ports: [], access: 'none' }; continue; }
    const m = /^([^=]+)=(.*)$/.exec(line); if (!m) continue;
    const key = m[1].trim(), value = m[2].trim();
    if (!section) {
      if (key === 'MODE' && MODES.includes(value)) cfg.mode = value;
      else if (key === 'IPs') cfg.ips = value.split(/\s+/).filter(validIp);
      else if (key === 'USERPORTS') cfg.userPorts = value.split(/\s+/).map(Number).filter(validPort);
    } else if (key === 'Ports') cfg.services[section].ports = value.split(/\s+/).map(Number).filter(validPort);
    else if (key === 'Access' && ACCESS.includes(value)) cfg.services[section].access = value;
  }
  return cfg;
}
// Gleiches Format wie Firewall_saveConfiguration (libfirewall.tcl)
function serialize(cfg) {
  let out = '# Firewall Configuration file\n#   created ' + new Date().toString() + '\n# This file was automatically gernerated\n# Please do not change anything\n\n';
  out += 'MODE = ' + cfg.mode + '\n\nIPs = ' + cfg.ips.join(' ') + '\n\n';
  if (cfg.userPorts.length) out += 'USERPORTS = ' + cfg.userPorts.join(' ');
  out += '\n\n';
  for (const [id, s] of Object.entries(cfg.services)) out += '[SERVICE ' + id + ']\nId = ' + id + '\nPorts = ' + s.ports.join(' ') + '\nAccess = ' + s.access + '\n\n';
  return out;
}
function read(web) { return fs.readFileSync(paths(web).conf, 'latin1'); }
function publicView(web, text = read(web)) {
  const cfg = parse(text), p = paths(web);
  return {
    mode: cfg.mode, ips: cfg.ips,
    userPorts: cfg.userPorts.map(port => ({ port, label: KNOWN_PORTS[port] || '', required: Object.hasOwn(REQUIRED, port) })),
    services: Object.entries(cfg.services).map(([id, s]) => ({ id, label: SERVICES[id] || id, ports: s.ports, access: s.access })),
    externalAccess: fs.existsSync(p.external), required: Object.entries(REQUIRED).map(([port, label]) => ({ port: Number(port), label })),
    pending: pending ? { until: new Date(pending.until).toISOString() } : null, limits: LIMITS
  };
}
function normalize(p, current) {
  if (!isObject(p) || Object.keys(p).some(k => !['mode', 'ips', 'userPorts', 'services'].includes(k))) throw fail('Unerwartete Angaben');
  if (!MODES.includes(p.mode)) throw fail('Modus ungültig');
  if (!Array.isArray(p.ips) || !p.ips.length || p.ips.length > LIMITS.ips) throw fail('1 bis ' + LIMITS.ips + ' erlaubte Netze angeben');
  const ips = [...new Set(p.ips.map(x => typeof x === 'string' ? x.trim() : x))];
  for (const ip of ips) if (!validIp(ip)) throw fail('„' + String(ip).slice(0, 50) + '“ ist keine gültige Adresse bzw. kein gültiges Netz (z. B. 192.168.0.0/16)');
  if (!Array.isArray(p.userPorts) || p.userPorts.length > LIMITS.ports) throw fail('Höchstens ' + LIMITS.ports + ' freigegebene Ports');
  const ports = [...new Set(p.userPorts)];
  for (const port of ports) if (!validPort(port)) throw fail('Port ' + String(port).slice(0, 10) + ' ungültig (1 bis 65535)');
  for (const [port, label] of Object.entries(REQUIRED)) if (!ports.includes(Number(port))) throw fail('Port ' + port + ' wird für ' + label + ' gebraucht und kann nicht entfernt werden');
  if (!isObject(p.services)) throw fail('Dienste ungültig');
  const services = JSON.parse(JSON.stringify(current.services));
  for (const [id, access] of Object.entries(p.services)) {
    if (!Object.hasOwn(services, id)) throw fail('Unbekannter Dienst ' + String(id).slice(0, 20));
    if (!ACCESS.includes(access)) throw fail('Zugriff für ' + id + ' ungültig');
    services[id].access = access;
  }
  return { mode: p.mode, ips, userPorts: ports.sort((a, b) => a - b), services };
}
const runApply = file => new Promise((resolve, reject) => execFile(file, [], { timeout: 30000 }, e => e ? reject(fail('Die Firewall hat die Einstellung nicht übernommen', 502)) : resolve()));
let pending = null, busy = false;
function write(web, text) {
  const file = paths(web).conf, tmp = file + '.neu-' + process.pid;
  fs.writeFileSync(tmp, text, { encoding: 'latin1', mode: 0o644 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
async function apply(web) { await (web.deps?.firewallApply || runApply)(paths(web).apply); }
async function save(web, p) {
  if (pending) throw fail('Bitte zuerst die letzte Änderung bestätigen oder abwarten', 409);
  const before = read(web), cfg = normalize(p, parse(before)), text = serialize(cfg);
  const backup = paths(web).conf + '.vor-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(backup, before, { encoding: 'latin1', mode: 0o600 });
  write(web, text);
  try { await apply(web); } catch (e) { write(web, before); try { await apply(web); } catch {} throw e; }
  // Ohne Bestätigung aus dem Browser automatisch zurück.
  const now = (web.deps?.now || Date.now)();
  pending = { until: now + LIMITS.confirmMs, before, timer: setTimeout(() => rollback(web).catch(() => {}), LIMITS.confirmMs) };
  pending.timer.unref?.();
  return { success: true, ...publicView(web), message: 'Firewall angewendet. Bitte innerhalb von 90 Sekunden „Funktioniert – behalten“ drücken, sonst wird die vorherige Einstellung wiederhergestellt.' };
}
async function rollback(web) {
  const p = pending; if (!p) return false;
  clearTimeout(p.timer); pending = null;
  write(web, p.before); await apply(web);
  return true;
}
async function confirm(web) {
  if (!pending) throw fail('Keine Änderung wartet auf Bestätigung', 409);
  clearTimeout(pending.timer); pending = null;
  return { success: true, ...publicView(web), message: 'Firewall-Einstellung bleibt bestehen.' };
}
async function undo(web) { if (!(await rollback(web))) throw fail('Keine Änderung wartet auf Bestätigung', 409); return { success: true, ...publicView(web), message: 'Vorherige Firewall-Einstellung wiederhergestellt.' }; }
const POST = { saveFirewall: save, confirmFirewall: confirm, undoFirewall: undo };

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (method !== 'getFirewall' && !Object.hasOwn(POST, method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (!fs.existsSync(paths(web).conf)) { send(501, { error: 'Auf diesem System gibt es keine CCU-Firewall' }); return true; }
    if (method === 'getFirewall') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, publicView(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (busy) { send(429, { error: 'Eine Änderung läuft bereits; bitte kurz warten' }); return true; }
    busy = true; try { send(200, await POST[method](web, p)); } finally { busy = false; }
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Firewall: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, _test: { parse, serialize, validIp, normalize, REQUIRED, reset: () => { if (pending) clearTimeout(pending.timer); pending = null; busy = false; } } };
