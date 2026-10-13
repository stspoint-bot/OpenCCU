'use strict';
// Anmelde-Wächter: Bei mehr als 10 falschen Anmeldungen innerhalb von 24 Stunden geht eine
// WhatsApp-Nachricht an die unter „Dienste & WhatsApp“ hinterlegte Nummer. Gezählt werden falsche
// Zugangsdaten und Versuche, die wegen zu vieler Fehlversuche bereits abgewiesen wurden.
// Die vorhandene Bremse (höchstens 8 Versuche je Adresse in 15 Minuten) bleibt unverändert.
// Es werden weder Benutzernamen noch Passwörter gespeichert oder verschickt.
const THRESHOLD = 10, WINDOW_MS = 24 * 3600000, REPEAT_MS = 6 * 3600000, MAX = 2000;
const state = { failures: [], lastAlert: 0, sinceAlert: 0, lastResult: null, now: Date.now };

function prune() { const cut = state.now() - WINDOW_MS; while (state.failures.length && state.failures[0].at < cut) state.failures.shift(); }
function maskIp(ip) { return typeof ip === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : 'unbekannt'; }
function failed(web, ip) {
  try {
    const now = state.now();
    state.failures.push({ at: now, ip: maskIp(ip) }); if (state.failures.length > MAX) state.failures.shift();
    prune(); state.sinceAlert++;
    if (state.failures.length <= THRESHOLD) return;
    // Erste Warnung beim 11. Fehlversuch; danach höchstens alle 6 Stunden und nur bei mehr als
    // 10 weiteren Fehlversuchen.
    if (state.lastAlert && (now - state.lastAlert < REPEAT_MS || state.sinceAlert <= THRESHOLD)) return;
    state.lastAlert = now; state.sinceAlert = 0;
    const addresses = [...new Set(state.failures.map(f => f.ip))].slice(-5).join(', ');
    const text = 'CCU3 · Anmelde-Warnung\n' + new Date(now).toLocaleString('de-DE') + '\nMehr als ' + THRESHOLD + ' falsche Anmeldungen an der Oberfläche in den letzten 24 Stunden (' + state.failures.length + ' Versuche).\nZuletzt von: ' + addresses + '\nWenn du das nicht warst: Passwort des CCU-Administrators ändern und VPN-Geräte im Tailscale-Konto prüfen.';
    console.error('[anmeldung] Mehr als ' + THRESHOLD + ' falsche Anmeldungen in 24 Stunden (' + state.failures.length + ').');
    const monitor = web?.security?.monitor;
    if (!monitor || typeof monitor.send !== 'function') { state.lastResult = { at: new Date(now).toISOString(), ok: false, message: 'WhatsApp-Dienst nicht verfügbar' }; return; }
    Promise.resolve().then(() => monitor.send(text)).then(
      () => { state.lastResult = { at: new Date(now).toISOString(), ok: true, message: 'WhatsApp-Warnung übergeben' }; },
      e => { state.lastResult = { at: new Date(now).toISOString(), ok: false, message: 'WhatsApp-Warnung nicht gesendet: ' + (e?.status ? e.message : 'Versand fehlgeschlagen') }; });
  } catch { /* der Wächter darf die Anmeldung nie stören */ }
}
function status(web) {
  prune();
  let ready = false; try { ready = web.security.monitor.settings().hasKey === true; } catch {}
  return { threshold: THRESHOLD, windowHours: 24, failures: state.failures.length, lastFailure: state.failures.length ? new Date(state.failures.at(-1).at).toISOString() : null, lastAlert: state.lastAlert ? new Date(state.lastAlert).toISOString() : null, lastResult: state.lastResult, whatsappReady: ready };
}
async function handle(web, req, res, u, auth) {
  if (u.searchParams.get('method') !== 'getLoginWatch') return false;
  if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
  if (!auth || auth.session?.localBypass) { web.sendJson(res, 403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
  web.sendJson(res, 200, status(web)); return true;
}
module.exports = { failed, status, handle, THRESHOLD, _test: { state, reset: () => { state.failures.length = 0; state.lastAlert = 0; state.sinceAlert = 0; state.lastResult = null; state.now = Date.now; } } };
