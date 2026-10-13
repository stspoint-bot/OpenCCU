'use strict';
// Geräte löschen (Seite „Geräte“, Kästchen „Löschen-Funktion anzeigen“):
// - getCcuDeviceList: alle Funkgeräte der CCU (Homematic IP / Homematic), auch Taster ohne schaltbare Kanäle.
// - deleteCcuDevice: Gerät auf Werkseinstellung zurücksetzen und aus der CCU entfernen (deleteDevice der Funkschnittstelle).
//   Normal: Flag 1 (Reset + Löschen). Ist das Gerät nicht erreichbar (z. B. Batteriegerät schläft), meldet der Aufruf einen
//   Fehler; erst dann kann der Administrator ausdrücklich „ohne Reset entfernen“ (Flag 2 = erzwingen) wählen.
// Nur für CCU-Administratoren, nie für die Zentrale selbst, nie für CUxD. Schreibende Funkbefehle werden nie wiederholt.
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const IFACES = { 'HmIP-RF': 'Homematic IP', 'BidCos-RF': 'Homematic (BidCos)' };
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Error('keine Antwort')), ms))]);
const protectedDevice = (address, device) => /^(BidCoS-RF|HmIP-RCV-1)$/i.test(address) || /CCU/i.test(String((device && device.type) || ""));

function connector(web) { const c = web.deps.getConnector(); if (!c || typeof c.rpcCall !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503); return c; }

function list(web) {
  const c = web.deps.getConnector(), devices = c?.getDevices?.() || new Map(), channels = c?.getChannels?.() || new Map();
  const names = new Map();
  for (const [a, ch] of channels) { if (typeof a !== 'string' || !ch || !ch.name) continue; const base = a.split(':')[0]; if (!names.has(base) && !String(ch.name).includes(base)) names.set(base, { name: String(ch.name), room: ch.room ? String(ch.room) : '' }); }
  const out = [];
  let fresh = {}; try { fresh = require('./ccu-anlernen').finished(web); } catch {}
  for (const [address, device] of devices) {
    if (typeof address !== 'string' || !DEVICE.test(address) || !Object.hasOwn(IFACES, device?.interface)) continue;
    const info = names.get(address) || {};
    const own = [...channels.keys()].filter(a => typeof a === 'string' && a.startsWith(address + ':')).length;
    out.push({ address, type: String(device?.type || '').slice(0, 64), interface: device.interface, label: IFACES[device.interface], name: info.name && !info.name.includes(address) ? info.name : '', room: info.room || '', channels: own, deletable: !protectedDevice(address, device), ...(fresh[address] ? { newSince: new Date(fresh[address]).toISOString() } : {}) });
  }
  return out.sort((a, b) => (a.name || a.type).localeCompare(b.name || b.type, 'de', { numeric: true }));
}

async function remove(web, p) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !['address', 'force'].includes(k))) throw fail('Unerwartete Felder in der Anfrage');
  if (typeof p.address !== 'string' || !DEVICE.test(p.address)) throw fail('Gerät ungültig');
  if (p.force !== undefined && typeof p.force !== 'boolean') throw fail('Angabe „erzwingen“ ungültig');
  const c = connector(web), device = c.getDevices?.()?.get?.(p.address);
  if (!device || !Object.hasOwn(IFACES, device.interface)) throw fail('Dieses Gerät gibt es nicht (mehr) in der CCU', 404);
  if (protectedDevice(p.address, device)) throw fail('Die Zentrale und ihre internen Geräte können nicht gelöscht werden', 403);
  const flags = p.force ? 2 : 1;
  try { await timeout(c.rpcCall(device.interface, 'deleteDevice', [p.address, flags]), 30000); }
  catch (e) {
    throw fail(p.force
      ? 'Entfernen nicht möglich: ' + e.message
      : 'Das Gerät konnte nicht auf Werkseinstellung gesetzt werden (' + e.message + '). Batteriegeräte vorher kurz wecken (Taste drücken) und erneut versuchen – oder „ohne Reset entfernen“ wählen.', 502);
  }
  try { web.log?.info?.('Gerät gelöscht: ' + p.address + (p.force ? ' (ohne Reset)' : ' (Werkseinstellung)')); } catch {}
  return { success: true, address: p.address, message: p.force ? 'Gerät wurde aus der CCU entfernt (ohne Reset am Gerät).' : 'Gerät wurde auf Werkseinstellung gesetzt und entfernt.' };
}

async function handle(web, req, res, u, auth) {
  const method = u.searchParams.get('method');
  if (!['getCcuDeviceList', 'deleteCcuDevice'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (method === 'getCcuDeviceList') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, { devices: list(web) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    send(200, await remove(web, await require('./web-security').body(req)));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Löschen fehlgeschlagen' }); }
  return true;
}

module.exports = { handle, list, remove, _internal: { protectedDevice } };
