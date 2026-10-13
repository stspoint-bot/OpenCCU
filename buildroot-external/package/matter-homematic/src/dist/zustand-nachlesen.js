'use strict';
// Schaltzustand nachlesen (12.10.2026, Favoriten-Fenster zeigte „?“ bei „Bad Licht“): Die Geräteliste kennt den Zustand nur
// aus Meldungen der CCU. Nach einem Neustart der Bridge fehlt er, bis das Gerät etwas meldet. Dann einmal bei der CCU lesen
// (getValue STATE, nur lesen, höchstens 3 s) und 60 s merken. Es wird KEIN Ereignis erzeugt (Automationen/Apple Home bleiben unberührt).
const TTL = 60000, cache = new Map();
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(Error('Zeitüberschreitung')), ms))]);
async function read(sec, address, cap) {
  if (!cap?.allowed || typeof cap.interface !== 'string') return null;
  const source = sec.stateAddress(address), hit = cache.get(source), now = Date.now();
  if (hit && now - hit.at < TTL) return hit.value;
  let value = null;
  try { const v = await withTimeout(sec.connector().rpcCall(cap.interface, 'getValue', [source, 'STATE']), 3000); if (typeof v === 'boolean') value = v; else if (v === 0 || v === 1) value = v === 1; } catch {}
  cache.set(source, { at: now, value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
module.exports = { read, _test: { reset: () => cache.clear() } };
