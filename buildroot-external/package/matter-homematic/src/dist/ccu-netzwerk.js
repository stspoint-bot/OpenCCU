'use strict';
// Netzwerk der Zentrale (Wunsch Thomas, 12.10.2026): ersetzt „Netzwerkeinstellungen“ der alten OpenCCU (cp_network.cgi).
// Wie OpenCCU: Einstellung in /etc/config/netconfig (HOSTNAME, MODE, IP, NETMASK, GATEWAY, NAMESERVER1/2), wirksam nach dem
// nächsten Neustart der CCU (es wird hier nichts neu gestartet). Nur für CCU-Administratoren; strenge Prüfung (IP, Maske und
// Gateway im selben Netz, keine Sonderadressen); Sicherung vor jeder Änderung.
const fs = require('node:fs'), os = require('node:os');
const DEFAULT_FILE = '/etc/config/netconfig';
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const file = web => web?.deps?.netconfigPath || DEFAULT_FILE;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const toInt = ip => ip.split('.').reduce((a, b) => (a * 256) + Number(b), 0);
function validMask(m) { if (!IPV4.test(m)) return false; const n = toInt(m); if (n === 0) return false; const inv = (~n) >>> 0; return ((inv + 1) & inv) === 0; }

function read(web) {
  let t = ''; try { t = fs.readFileSync(file(web), 'latin1'); } catch {}
  const get = k => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(t); return m ? m[1].trim().replace(/^'|'$/g, '') : ''; };
  return { text: t, hostname: get('HOSTNAME'), mode: get('MODE') === 'DHCP' ? 'DHCP' : 'MANUAL',
    configured: { ip: get('IP'), netmask: get('NETMASK'), gateway: get('GATEWAY'), dns1: get('NAMESERVER1'), dns2: get('NAMESERVER2') },
    current: { ip: get('CURRENT_IP'), netmask: get('CURRENT_NETMASK'), gateway: get('CURRENT_GATEWAY'), dns1: get('CURRENT_NAMESERVER1'), dns2: get('CURRENT_NAMESERVER2') } };
}
function status(web) {
  const r = read(web); let mac = '';
  try { mac = (os.networkInterfaces().eth0 || []).find(x => x.mac && x.mac !== '00:00:00:00:00:00')?.mac || ''; } catch {}
  return { hostname: r.hostname, mode: r.mode, configured: r.configured, current: r.current, mac, note: 'Änderungen gelten nach dem nächsten Neustart der Zentrale. Apple Home findet die Bridge danach über die neue Adresse.' };
}
function setProp(text, key, value) { const re = new RegExp('^' + key + '=.*$', 'm'); return re.test(text) ? text.replace(re, key + '=' + value) : text.replace(/\n?$/, '\n') + key + '=' + value + '\n'; }
function save(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['hostname', 'mode', 'ip', 'netmask', 'gateway', 'dns1', 'dns2'].includes(k))) throw fail('Unerwartete Angaben');
  if (typeof p.hostname !== 'string' || !HOST.test(p.hostname)) throw fail('Gerätename: Buchstaben, Ziffern und Bindestrich, höchstens 63 Zeichen');
  if (!['DHCP', 'MANUAL'].includes(p.mode)) throw fail('Automatisch (DHCP) oder feste Adresse wählen');
  const v = { ip: '', netmask: '', gateway: '', dns1: '', dns2: '' };
  if (p.mode === 'MANUAL') {
    for (const k of ['ip', 'gateway', 'dns1']) if (typeof p[k] !== 'string' || !IPV4.test(p[k])) throw fail({ ip: 'IP-Adresse', gateway: 'Gateway (Router)', dns1: 'DNS-Server' }[k] + ' ungültig (z. B. 192.168.1.10)');
    if (typeof p.netmask !== 'string' || !validMask(p.netmask)) throw fail('Netzmaske ungültig (z. B. 255.255.255.0)');
    if (p.dns2 !== undefined && p.dns2 !== '' && (typeof p.dns2 !== 'string' || !IPV4.test(p.dns2))) throw fail('Zweiter DNS-Server ungültig');
    const ip = toInt(p.ip), gw = toInt(p.gateway), m = toInt(p.netmask), net = (ip & m) >>> 0, bc = (net | (~m >>> 0)) >>> 0;
    if (ip === net || ip === bc) throw fail('Die IP-Adresse ist die Netz- oder Rundrufadresse');
    if (((gw & m) >>> 0) !== net) throw fail('Gateway liegt nicht im selben Netz wie die IP-Adresse');
    if (ip === gw) throw fail('IP-Adresse und Gateway dürfen nicht gleich sein');
    if (/^(0|127|169\.254|22[4-9]|2[3-5]\d)\./.test(p.ip)) throw fail('Diese IP-Adresse ist für die Zentrale nicht geeignet');
    Object.assign(v, { ip: p.ip, netmask: p.netmask, gateway: p.gateway, dns1: p.dns1, dns2: p.dns2 || '' });
  }
  const r = read(web); if (!r.text) throw fail('Netzwerk-Einstellung der Zentrale nicht lesbar', 500);
  fs.writeFileSync(file(web) + '.vor-' + new Date().toISOString().replace(/[:.]/g, '-'), r.text, { encoding: 'latin1', mode: 0o600 });
  let t = r.text;
  t = setProp(t, 'HOSTNAME', p.hostname); t = setProp(t, 'MODE', p.mode);
  if (p.mode === 'MANUAL') { t = setProp(t, 'IP', v.ip); t = setProp(t, 'NETMASK', v.netmask); t = setProp(t, 'GATEWAY', v.gateway); t = setProp(t, 'NAMESERVER1', v.dns1); t = setProp(t, 'NAMESERVER2', v.dns2 || '0.0.0.0'); }
  const tmp = file(web) + '.neu-' + process.pid; fs.writeFileSync(tmp, t, { encoding: 'latin1', mode: 0o644 });
  try { fs.renameSync(tmp, file(web)); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return { success: true, ...status(web), message: 'Gespeichert. Die neue Einstellung gilt nach dem nächsten Neustart der Zentrale.' };
}
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getNetzwerk', 'saveNetzwerk'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (!fs.existsSync(file(web))) { send(501, { error: 'Auf diesem System gibt es keine CCU-Netzwerkeinstellung' }); return true; }
    if (method === 'getNetzwerk') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, status(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    send(200, save(web, await require('./web-security').body(req)));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Netzwerk: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, _test: { read, validMask, toInt } };
