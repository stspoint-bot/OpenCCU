'use strict';
// CCU-Sitzung für Zusatzprogramm-Seiten (12.10.2026): Wer sich bei uns als CCU-Administrator anmeldet, bekommt zusätzlich
// eine CCU-Sitzung (ReGa). Die alte OpenCCU-Oberfläche ist abgeschaltet; gebraucht wird die Sitzung nur noch für die
// Einstellungsseite von Matter-Tailscale (/addons/tspoint-tailscale/config.cgi, Port 80), die ohne Sitzung 403 liefert.
// - Das Passwort wird nur für diese eine Anmeldung benutzt, nie gespeichert oder ausgegeben.
// - Die CCU-Sitzung lebt nur so lange wie unsere Sitzung: wird regelmäßig verlängert und beim Abmelden/Ablauf beendet.
// - Nur Administratoren (die Anmeldung bei uns setzt CCU-Administrator voraus).
const RENEW_MS = 4 * 60000, PENDING_MS = 30000, CHECK_MS = 60000;
const SID = /^[A-Za-z0-9]{6,64}$/;
let pending = null, timer = null;
const tracked = new Map(); // Sitzungsobjekt → { sid, renewed }
const rpc = (sec, method, params) => sec.connector().jsonRpc(method, params);
const logout = (sec, sid) => Promise.resolve().then(() => rpc(sec, 'Session.logout', { _session_id_: sid })).catch(() => {});

// Aufgerufen direkt nach erfolgreicher Administrator-Prüfung, solange das Passwort noch da ist.
async function open(sec, username, password) {
  try {
    const sid = await rpc(sec, 'Session.login', { username, password });
    if (typeof sid !== 'string' || !SID.test(sid)) return;
    if (pending) logout(sec, pending.sid);
    pending = { sid, at: Date.now() };
  } catch {}
}
// Aufgerufen, sobald unsere Sitzung angelegt ist.
function bind(sec, session) {
  const p = pending; pending = null;
  if (!p || Date.now() - p.at > PENDING_MS || !session || typeof session !== 'object') { if (p) logout(sec, p.sid); return; }
  // Höchstens EINE CCU-Sitzung: die CCU erlaubt nur wenige Sitzungen gleichzeitig
  // („invalid credentials or too many sessions“). Ältere werden beim neuen Anmelden beendet.
  for (const [s, t] of tracked) { tracked.delete(s); logout(sec, t.sid); }
  tracked.set(session, { sid: p.sid, renewed: Date.now() });
  if (!timer) { timer = setInterval(() => check(sec).catch(() => {}), CHECK_MS); timer.unref?.(); }
}
const alive = (sec, session) => [...(sec.sessions?.values?.() || [])].includes(session) && Date.now() - session.seen <= 2 * 86400000 && Date.now() - session.created <= 2 * 86400000;
async function check(sec) {
  if (pending && Date.now() - pending.at > PENDING_MS) { logout(sec, pending.sid); pending = null; }
  for (const [session, t] of tracked) {
    if (!alive(sec, session)) { tracked.delete(session); logout(sec, t.sid); continue; }
    if (Date.now() - t.renewed >= RENEW_MS) { try { await rpc(sec, 'Session.renew', { _session_id_: t.sid }); t.renewed = Date.now(); } catch { tracked.delete(session); } }
  }
  if (!tracked.size && !pending && timer) { clearInterval(timer); timer = null; }
}
// Tailscale-Einstellungsseite mit der CCU-Sitzung öffnen (feste Adresse dieser CCU, Port 80).
async function handle(web, req, res, u, auth) {
  if (u.pathname !== '/api/' || u.searchParams.get('method') !== 'getTailscaleSeite') return false;
  if (req.method !== 'GET') { web.sendJson(res, 405, { error: 'GET erforderlich' }); return true; }
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253})$/.test(host)) { web.sendJson(res, 400, { error: 'Adresse ungültig' }); return true; }
  // Hinter dem HTTPS-Weiterleiter der CCU (lighttpd :443 → :8090) dieselbe Adresse mit https
  const base = (req.headers['x-forwarded-proto'] === 'https' ? 'https://' : 'http://') + host + '/';
  const t = auth?.session && !auth.session.localBypass ? tracked.get(auth.session) : null;
  if (t) {
    try { await rpc(web.security, 'Session.renew', { _session_id_: t.sid }); t.renewed = Date.now(); web.sendJson(res, 200, { url: base + 'addons/tspoint-tailscale/config.cgi?sid=' + encodeURIComponent('@' + t.sid + '@'), direct: true }); return true; }
    catch { tracked.delete(auth.session); }
  }
  web.sendJson(res, 200, { url: '', direct: false, hint: 'Bitte einmal ab- und wieder als Administrator anmelden, dann erneut klicken.' });
  return true;
}
module.exports = { open, bind, handle, _test: { check, tracked, reset: () => { pending = null; tracked.clear(); if (timer) clearInterval(timer); timer = null; } } };
