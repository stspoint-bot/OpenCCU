'use strict';
// „Dieses Gerät merken“ (Wunsch Thomas über Chat1, 12.10.2026: Handy-Seite mit längerer Anmeldung).
// - Eigener, zufälliger Gerätecode (Cookie mh_geraet, HttpOnly, Secure, SameSite=Strict) – nur über HTTPS.
// - Gespeichert wird nur sha256(Code) in geraete-gemerkt.json (Rechte 0600), nie der Code selbst.
// - 30 Tage gültig, jede Nutzung verlängert (gleitend); höchstens 20 gemerkte Geräte (älteste fallen weg).
// - Ohne laufende Sitzung legt der Code eine neue Sitzung an (gleiche Rolle wie bei der Anmeldung); eigene Benutzer werden
//   dabei neu geprüft (gelöscht → Code ungültig, Rolle aktuell). „Abmelden“ macht den Code ungültig.
// - Liste und Entfernen unter „Mein Konto“ (Administratoren sehen alle, andere nur die eigenen).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const DAYS = 30, MAX = 20, ID = /^[a-f0-9]{16}$/, CODE = /^[a-f0-9]{64}$/;
const file = sec => path.join(path.dirname(sec.web.deps.configPath), 'geraete-gemerkt.json');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
function load(sec) { try { const d = JSON.parse(fs.readFileSync(file(sec), 'utf8')); return Array.isArray(d) ? d.filter(x => x && ID.test(x.id) && /^[a-f0-9]{64}$/.test(x.hash)) : []; } catch { return []; } }
function store(sec, list) { const f = file(sec), tmp = f + '.neu-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, f); try { fs.chmodSync(f, 0o600); } catch {} }
const label = ua => { ua = String(ua || ''); return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows-PC' : 'Gerät'; };
const parse = req => { const m = /(?:^|;\s*)mh_geraet=([a-f0-9]{16})\.([a-f0-9]{64})(?:;|$)/.exec(req.headers?.cookie || ''); return m ? { id: m[1], code: m[2] } : null; };
const addCookie = (res, c) => { const prev = res.getHeader?.('Set-Cookie'); res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : prev ? [prev] : []), c]); };
// Nach erfolgreicher Anmeldung mit Häkchen „Dieses Gerät merken“
function issue(sec, res, ctx, session, ua, user) {
  if (!ctx?.secure || !session) return false;
  const id = crypto.randomBytes(8).toString('hex'), code = crypto.randomBytes(32).toString('hex'), t = now();
  const list = load(sec).filter(x => x.expires > t);
  list.push({ id, hash: sha(code), user: session.user || (typeof user === 'string' ? user.slice(0, 64) : ''), role: session.role || 'admin', ccuAdmin: !session.role, label: label(ua), created: new Date(t).toISOString(), lastUsed: new Date(t).toISOString(), expires: t + DAYS * 86400000 });
  while (list.length > MAX) list.shift();
  store(sec, list);
  addCookie(res, `mh_geraet=${id}.${code}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DAYS * 86400}; Secure`);
  return true;
}
// Ohne Sitzung: gemerktes Gerät → neue Sitzung (nur HTTPS)
function restore(sec, req, res, ctx) {
  if (!ctx?.secure) return null;
  const c = parse(req); if (!c) return null;
  const list = load(sec), t = now(), e = list.find(x => x.id === c.id);
  if (!e || e.expires <= t) return null;
  const a = Buffer.from(sha(c.code), 'hex'), b = Buffer.from(e.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let role = e.ccuAdmin ? null : e.role, user = e.user;
  if (!e.ccuAdmin) { // eigener Benutzer: muss noch existieren, Rolle aktuell
    let users = []; try { users = JSON.parse(fs.readFileSync(path.join(path.dirname(sec.web.deps.configPath), 'benutzer.json'), 'utf8')).users || []; } catch {}
    const u = users.find(x => x && x.name === e.user); if (!u) { store(sec, list.filter(x => x.id !== e.id)); return null; }
    role = u.role;
  }
  if (sec.sessions.size >= 32) sec.sessions.delete(sec.sessions.keys().next().value);
  const raw = crypto.randomBytes(32).toString('hex'), session = { csrf: crypto.randomBytes(32).toString('hex'), created: t, seen: t, remembered: e.id, ...(role ? { role, user } : {}) };
  sec.sessions.set(raw, session);
  addCookie(res, `mh_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=172800; Secure`);
  if (t - Date.parse(e.lastUsed || 0) > 3600000 || e.expires - t < (DAYS - 1) * 86400000) { e.lastUsed = new Date(t).toISOString(); e.expires = t + DAYS * 86400000; store(sec, list); }
  return { raw, session };
}
// Abmelden: Gerätecode dieses Browsers ungültig machen
function forget(sec, req) { const c = parse(req); if (!c) return; const list = load(sec); if (list.some(x => x.id === c.id)) store(sec, list.filter(x => x.id !== c.id)); }
const isAdmin = s => !s?.localBypass && (!s?.role || s.role === 'admin');
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getGemerkteGeraete', 'loescheGemerktesGeraet'].includes(method)) return false;
  const sec = web.security, send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    const s = auth.session, mine = x => isAdmin(s) || (s.user && x.user === s.user && !x.ccuAdmin);
    const thisId = parse(req)?.id || '';
    if (method === 'getGemerkteGeraete') {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      send(200, { https: !!web.security.context?.(req)?.secure, geraete: load(sec).filter(x => x.expires > now() && mine(x)).map(x => ({ id: x.id, label: x.label, user: x.ccuAdmin ? 'CCU-Administrator' : x.user, created: x.created, lastUsed: x.lastUsed, expires: new Date(x.expires).toISOString(), diesesGeraet: x.id === thisId })) }); return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => k !== 'id') || typeof p.id !== 'string' || !ID.test(p.id)) { send(400, { error: 'Ungültige Angabe' }); return true; }
    const list = load(sec), e = list.find(x => x.id === p.id);
    if (!e || !mine(e)) { send(404, { error: 'Gerät nicht gefunden' }); return true; }
    store(sec, list.filter(x => x.id !== p.id));
    for (const [raw, ss] of sec.sessions) if (ss.remembered === p.id) sec.sessions.delete(raw); // dort sofort abmelden
    send(200, { success: true });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { issue, restore, forget, handle, _test: { load, parse, DAYS } };
