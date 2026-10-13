'use strict';
// Meldungen je CCU-Gerät abschalten (Wunsch Thomas, 13.10.2026; Schalter nur auf „Geräte (neu)“):
// abgeschaltete Geräte erscheinen nicht mehr im Systemzustand (Gerätemeldungen) und lösen keine Batterie-WhatsApp aus.
// Gespeichert wird nur die Geräteadresse (Seriennummer ohne Kanal) in config.meldungenAus. Die CCU selbst bleibt unverändert.
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const SERIAL = /^[A-Za-z0-9_-]{4,40}$/;
const deviceOf = a => String(a || '').split(':')[0];
function list(web) { try { const c = web.security.configSnapshot.read().meldungenAus; return Array.isArray(c) ? c.filter(a => typeof a === 'string' && SERIAL.test(a)).slice(0, 300) : []; } catch { return []; } }
const isOff = (web, address) => { const d = deviceOf(address); return !!d && list(web).includes(d); };
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getMeldungenAus', 'setGeraetMeldung'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (method === 'getMeldungenAus') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, { aus: list(web) }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!isObject(p) || Object.keys(p).some(k => !['address', 'enabled'].includes(k)) || typeof p.enabled !== 'boolean' || !SERIAL.test(deviceOf(p.address)) || String(p.address).includes(':')) throw fail('Gerät und Ein/Aus angeben');
    web.writeConfigPatch(c => { const s = new Set(Array.isArray(c.meldungenAus) ? c.meldungenAus.filter(a => typeof a === 'string' && SERIAL.test(a)) : []); if (p.enabled) s.delete(p.address); else s.add(p.address); c.meldungenAus = [...s].slice(0, 300); });
    send(200, { success: true, aus: list(web), message: p.enabled ? 'Meldungen für dieses Gerät an.' : 'Meldungen für dieses Gerät aus (Systemzustand und Batterie-WhatsApp).' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Meldungen: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, list, isOff, deviceOf };
