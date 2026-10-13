'use strict';
// Direkte Geräteverknüpfungen (Wunsch Thomas, 11.10.2026): anzeigen, was in den Geräten selbst gespeichert ist
// (z. B. Wandschalter → Aktor). Diese Verknüpfungen schalten auch ohne CCU/Bridge.
// Stufe 1: lesen (getLinks der Funkschnittstellen). Stufe 2 (unten): anlegen und löschen, mit Sicherung.
const IFACES = ['HmIP-RF', 'BidCos-RF'];
const TTL = 60000, LIMIT = 2000;
let cache = { at: 0, value: null, pending: null };
const text = (s, max = 200) => (typeof s === 'string' ? s : '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
const dev = a => String(a || '').split(':')[0];

async function read(web) {
  const connector = web.deps.getConnector?.();
  if (!connector || typeof connector.rpcCall !== 'function') throw Object.assign(Error('CCU-Verbindung nicht verfügbar'), { status: 503 });
  const channels = connector.getChannels?.() || new Map();
  let rows = []; try { rows = web.getDevices?.().devices || []; } catch {}
  const nameOf = address => {
    const v = /^BidCoS-RF:(\d+)$/i.exec(address) || /^HmIP-RCV-1:(\d+)$/i.exec(address);
    if (v && !channels.get(address)?.name) return { name: 'Virtuelle CCU-Taste ' + v[1], room: '', known: true };
    const row = rows.find(r => r.address === address);
    const ch = channels.get(address);
    const name = row?.name || (ch?.name && !ch.name.includes(dev(address)) ? ch.name : '') || channels.get(dev(address) + ':0')?.name?.replace(/:\d+$/, '') || address;
    return { name: text(name, 80), room: text(row?.room || ch?.room || '', 80), known: !!(row || ch || channels.get(dev(address) + ':0')) };
  };
  const links = [], errors = [];
  for (const iface of IFACES) {
    if (connector.config?.interfaces?.[iface]?.enabled === false) continue;
    let list;
    try { list = await Promise.race([connector.rpcCall(iface, 'getLinks', ['', 0]), new Promise((_, r) => setTimeout(() => r(Error('Zeitüberschreitung')), 15000))]); }
    catch (e) { errors.push(iface + ': ' + text(e.message, 80)); continue; }
    if (!Array.isArray(list)) continue;
    for (const l of list.slice(0, LIMIT)) {
      if (!l || typeof l.SENDER !== 'string' || typeof l.RECEIVER !== 'string') continue;
      const s = nameOf(l.SENDER), r = nameOf(l.RECEIVER);
      links.push({ interface: iface, sender: l.SENDER, senderName: s.name, senderRoom: s.room, receiver: l.RECEIVER, receiverName: r.name, receiverRoom: r.room,
        name: text(l.NAME), description: text(l.DESCRIPTION === 'NO_DESCRIPTION' ? '' : l.DESCRIPTION),
        unknown: !s.known || !r.known, internal: dev(l.SENDER) === dev(l.RECEIVER), virtual: /^(BidCoS-RF|HmIP-RCV-1|[A-Z0-9]*VIR)/i.test(l.SENDER) });
    }
  }
  links.sort((a, b) => (a.receiverRoom || '~').localeCompare(b.receiverRoom || '~', 'de') || a.receiverName.localeCompare(b.receiverName, 'de'));
  return { links, errors, readAt: new Date().toISOString() };
}
function links(web) {
  const now = Date.now();
  if (cache.pending) return cache.pending;
  if (cache.value && now - cache.at < TTL) return Promise.resolve(cache.value);
  cache.pending = read(web).then(v => { cache = { at: Date.now(), value: v, pending: null }; return v; }, e => { cache.pending = null; throw e; });
  return cache.pending;
}
// ---- Stufe 2 (Wunsch Thomas, 12.10.2026): anlegen und löschen – nur Administratoren, mit Rückfrage in der Oberfläche.
// Vor dem Löschen werden die Verknüpfungsparameter beider Seiten in verknuepfungen-sicherung.json gesichert (letzte 50).
const ADDR = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$/;
const roles = s => (typeof s === 'string' ? s : '').split(/\s+/).filter(Boolean).slice(0, 20);
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Error('Zeitüberschreitung')), ms))]);
const fail = (m, status = 400) => Object.assign(Error(m), { status });
// Kanäle, die verknüpft werden können (Rollen aus den Gerätebeschreibungen der Funkdienste)
async function candidates(web) {
  const connector = web.deps.getConnector?.();
  if (!connector || typeof connector.rpcCall !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503);
  const channels = connector.getChannels?.() || new Map(); let rows = []; try { rows = web.getDevices?.().devices || []; } catch {}
  const out = [];
  for (const iface of IFACES) {
    if (connector.config?.interfaces?.[iface]?.enabled === false) continue;
    let list; try { list = await withTimeout(connector.rpcCall(iface, 'listDevices', []), 15000); } catch { continue; }
    for (const d of Array.isArray(list) ? list.slice(0, 5000) : []) {
      if (!d || typeof d.ADDRESS !== 'string' || !ADDR.test(d.ADDRESS)) continue;
      const src = roles(d.LINK_SOURCE_ROLES), dst = roles(d.LINK_TARGET_ROLES); if (!src.length && !dst.length) continue;
      const row = rows.find(r => r.address === d.ADDRESS), ch = channels.get(d.ADDRESS), parent = channels.get(dev(d.ADDRESS) + ':0');
      const name = row?.name || (ch?.name && !ch.name.includes(dev(d.ADDRESS)) ? ch.name : '') || ((parent?.name || dev(d.ADDRESS)).replace(/:\d+$/, '') + ' Kanal ' + d.ADDRESS.split(':')[1]);
      // channelType (z. B. KEY_TRANSCEIVER, SWITCH_VIRTUAL_RECEIVER) für den Assistenten: Art in Worten, gleichartige Kanäle bündeln
      out.push({ interface: iface, address: d.ADDRESS, name: text(name, 80), room: text(row?.room || ch?.room || '', 80), type: text(d.PARENT_TYPE || '', 40), channelType: text(d.TYPE || '', 60), source: src, target: dst });
    }
  }
  return { channels: out.sort((a, b) => a.name.localeCompare(b.name, 'de')) };
}
const backupFile = web => require('path').join(require('path').dirname(web.deps.configPath), 'verknuepfungen-sicherung.json');
function saveBackup(web, entry) {
  const fs = require('fs'), f = backupFile(web); let list = []; try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  if (!Array.isArray(list)) list = []; list.push(entry); list = list.slice(-50);
  const tmp = f + '.neu-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f);
}
async function change(web, method, p) {
  const connector = web.deps.getConnector?.();
  if (!connector || typeof connector.rpcCall !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503);
  const keys = method === 'addDirectLink' ? ['interface', 'sender', 'receiver', 'name'] : ['interface', 'sender', 'receiver'];
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !keys.includes(k)) || !IFACES.includes(p.interface) || !ADDR.test(p.sender || '') || !ADDR.test(p.receiver || '') || p.sender === p.receiver) throw fail('Ungültige Angabe');
  if (method === 'addDirectLink') {
    const name = p.name === undefined ? '' : p.name; if (typeof name !== 'string' || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw fail('Name: höchstens 60 Zeichen');
    const c = (await candidates(web)).channels, s = c.find(x => x.address === p.sender && x.interface === p.interface), r = c.find(x => x.address === p.receiver && x.interface === p.interface);
    if (!s || !r) throw fail('Kanal nicht gefunden', 404);
    if (!s.source.some(x => r.target.includes(x))) throw fail('Diese beiden Kanäle passen nicht zusammen');
    await withTimeout(connector.rpcCall(p.interface, 'addLink', [p.sender, p.receiver, name.trim(), '']), 30000);
  } else {
    const cur = (await read(web)).links.find(l => l.interface === p.interface && l.sender === p.sender && l.receiver === p.receiver);
    if (!cur) throw fail('Verknüpfung nicht gefunden', 404);
    const entry = { at: new Date().toISOString(), interface: p.interface, sender: p.sender, receiver: p.receiver, name: cur.name, description: cur.description, senderName: cur.senderName, receiverName: cur.receiverName, paramsets: {} };
    for (const [a, b] of [[p.receiver, p.sender], [p.sender, p.receiver]]) { try { entry.paramsets[a] = await withTimeout(connector.rpcCall(p.interface, 'getParamset', [a, b]), 15000); } catch {} }
    saveBackup(web, entry);
    await withTimeout(connector.rpcCall(p.interface, 'removeLink', [p.sender, p.receiver]), 30000);
  }
  cache = { at: 0, value: null, pending: null };
  return links(web);
}
async function handle(web, req, res, u, auth) {
  const m = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (m === 'getLinkCandidates' || m === 'addDirectLink' || m === 'removeDirectLink') {
    if (!auth || auth.session?.localBypass || (auth.session?.role && auth.session.role !== 'admin')) { web.sendJson(res, 403, { error: 'Nur nach Anmeldung als Administrator möglich' }); return true; }
    if (req.method !== (m === 'getLinkCandidates' ? 'GET' : 'POST')) { web.sendJson(res, 405, { error: (m === 'getLinkCandidates' ? 'GET' : 'POST') + ' erforderlich' }); return true; }
    try { web.sendJson(res, 200, m === 'getLinkCandidates' ? await candidates(web) : await change(web, m, await require('./web-security').body(req))); }
    catch (e) { web.sendJson(res, e.status || 502, { error: e.status ? e.message : 'Die CCU hat die Änderung abgelehnt' }); }
    return true;
  }
  if (m !== 'getDirectLinks') return false;
  if (!auth) { web.sendJson(res, 403, { error: 'Anmeldung erforderlich' }); return true; }
  if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
  try { web.sendJson(res, 200, await links(web)); } catch (e) { web.sendJson(res, e.status || 502, { error: e.status ? e.message : 'Verknüpfungen nicht lesbar' }); }
  return true;
}
module.exports = { handle, _test: { read, candidates, change, reset: () => { cache = { at: 0, value: null, pending: null }; } } };
