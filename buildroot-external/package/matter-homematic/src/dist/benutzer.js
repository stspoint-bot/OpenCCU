'use strict';
// Benutzerverwaltung (Wunsch Thomas, 12.10.2026): eigene Benutzer mit Rollen – unabhängig von der alten CCU.
//   Administrator: alles · Bewohner: Geräte bedienen und alles ansehen, nichts einstellen · Gast: nur ansehen.
// Die Anmeldung als CCU-Administrator bleibt als Notzugang (Rolle Administrator).
// Passwörter tippt jeder selbst; gespeichert wird nur ein scrypt-Hash (mit eigenem Salz) in benutzer.json (Rechte 0600),
// nie das Passwort. Für Nicht-Administratoren gilt eine feste Erlaubnisliste – alles andere wird abgelehnt (403).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ROLES = Object.freeze({ admin: 'Administrator', bewohner: 'Bewohner', gast: 'Gast' });
const NAME = /^[A-Za-z0-9._-]{3,32}$/;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
// Ansehen (Gast und Bewohner)
const VIEW = new Set(['getDevices', 'getRooms', 'getRaumZuordnung', 'getCcuOverview', 'getWetter', 'getFavoriten', 'getHistory', 'getAutomations', 'getAutomationLog', 'getAutomationCatalog',
  'getGeraeteVerwaltung', 'getGeraetLive', 'getGeraeteAktivitaet', 'getGewerke', 'getDeviceIcons', 'getDirectLinks', 'getBridgeStatus', 'getServiceStatus', 'getTasmotaDevices', 'getDysonDevices', 'getEcovacs',
  'getJeepOverview', 'getJeepMatterDevices', 'getInterfaces', 'webAuthInfo', 'getEigenesKonto', 'getGemerkteGeraete', 'getLetzteWerte']);
// Bedienen (nur Bewohner)
const OPERATE = new Set(['setSwitchState', 'setDimmerLevel', 'setThermostatTemperature', 'controlTasmota', 'controlSmartplus', 'controlSmartlife', 'controlDyson', 'controlEcovacs']);
const SELF = new Set(['setEigenesPasswort', 'loescheGemerktesGeraet']); // eigenes Passwort ändern (Bewohner und Gast)

const file = web => path.join(path.dirname(web.deps.configPath), 'benutzer.json');
function load(web) { try { const d = JSON.parse(fs.readFileSync(file(web), 'utf8')); return Array.isArray(d.users) ? d.users.filter(u => isObject(u) && NAME.test(u.name) && ROLES[u.role] && typeof u.salt === 'string' && typeof u.hash === 'string') : []; } catch { return []; } }
function store(web, users) { const f = file(web), tmp = f + '.neu-' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 }); try { fs.renameSync(tmp, f); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; } try { fs.chmodSync(f, 0o600); } catch {} }
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10 || pw.length > 128) throw fail('Das Passwort muss 10 bis 128 Zeichen lang sein');
  if (/[\x00-\x1f\x7f]/.test(pw)) throw fail('Das Passwort darf keine Steuerzeichen enthalten');
  if (!/[A-Za-zÄÖÜäöüß]/.test(pw) || !/[0-9]/.test(pw)) throw fail('Das Passwort braucht Buchstaben und Ziffern');
}
const hashOf = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, Buffer.from(salt, 'base64'), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? no(e) : ok(k.toString('base64'))));
async function makeHash(pw) { const salt = crypto.randomBytes(16).toString('base64'); return { salt, hash: await hashOf(pw, salt) }; }
async function matches(user, pw) { try { const h = Buffer.from(await hashOf(pw, user.salt), 'base64'), want = Buffer.from(user.hash, 'base64'); return h.length === want.length && crypto.timingSafeEqual(h, want); } catch { return false; } }

// Anmeldung mit eigenem Benutzer (aufgerufen aus der Anmeldung, bevor die CCU gefragt wird). true = erledigt.
async function login(sec, res, ctx, p) {
  const web = sec.web, users = load(web), u = users.find(x => x.name.toLowerCase() === String(p.username).toLowerCase());
  if (!u) return false;
  const ok = await matches(u, p.password); p.password = '';
  if (!ok) { require('./login-alert').failed(web, ctx.ip); sec.json(res, 401, { error: 'Anmeldung fehlgeschlagen.' }); return true; }
  // Erfolgreich: Fehlversuchs-Zähler zurück (sonst sperrt häufiges Ab-/Anmelden); bei vollem Speicher weicht die älteste Sitzung
  sec.attempts?.delete?.(ctx.ip); if (sec.sessions.size >= 32) sec.sessions.delete(sec.sessions.keys().next().value);
  const raw = crypto.randomBytes(32).toString('hex'), now = Date.now(), session = { csrf: crypto.randomBytes(32).toString('hex'), created: now, seen: now, user: u.name, role: u.role };
  sec.sessions.set(raw, session);
  res.setHeader('Set-Cookie', `mh_session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=172800${ctx.secure ? '; Secure' : ''}`);
  if (p.merken === true) require('./geraet-merken').issue(sec, res, ctx, session, ctx.ua, u.name); // „Dieses Gerät merken“ (nur HTTPS)
  try { store(web, users.map(x => x === u ? { ...x, lastLogin: new Date(now).toISOString() } : x)); } catch {}
  sec.json(res, 200, { csrf: session.csrf });
  return true;
}
// Rechte-Wächter: läuft nach der Sitzungs- und CSRF-Prüfung. true = Anfrage erledigt (abgelehnt bzw. beantwortet).
function gate(sec, auth, req, res, u) {
  const role = auth?.session?.role; if (!role || role === 'admin') return false;
  if (u.pathname === '/auth/session') { sec.json(res, 200, { csrf: auth.session.csrf, admin: false, role, user: auth.session.user }); return true; }
  if (['/auth/activity', '/auth/logout', '/events'].includes(u.pathname)) return false;
  if (u.pathname === '/api/') {
    const m = u.searchParams.get('method') || '';
    const allowed = req.method === 'GET' ? VIEW.has(m) : SELF.has(m) || (role === 'bewohner' && OPERATE.has(m));
    if (!allowed) { sec.json(res, 403, { error: 'Dafür fehlt die Berechtigung (Rolle ' + ROLES[role] + ').' }); return true; }
    return false;
  }
  if (req.method !== 'GET') { sec.json(res, 403, { error: 'Dafür fehlt die Berechtigung.' }); return true; }
  return false; // Seiten, Bilder, Skripte
}
// ---- Verwaltung (nur Administratoren) ----
const isAdmin = auth => !!auth && !auth.session?.localBypass && (!auth.session?.role || auth.session.role === 'admin');
const pub = u => ({ name: u.name, role: u.role, rolle: ROLES[u.role], created: u.created || null, lastLogin: u.lastLogin || null });
async function change(web, p) {
  if (!isObject(p) || !['add', 'role', 'password', 'delete'].includes(p.action) || typeof p.name !== 'string' || !NAME.test(p.name)) throw fail('Benutzername: 3 bis 32 Zeichen (Buchstaben, Ziffern, Punkt, Strich)');
  if (Object.keys(p).some(k => !['action', 'name', 'role', 'password'].includes(k))) throw fail('Unerwartete Angaben');
  const users = load(web), i = users.findIndex(x => x.name.toLowerCase() === p.name.toLowerCase());
  if (p.action === 'add') {
    if (i >= 0) throw fail('Benutzer gibt es schon'); if (users.length >= 20) throw fail('Höchstens 20 Benutzer');
    if (!ROLES[p.role]) throw fail('Rolle wählen'); checkPassword(p.password);
    users.push({ name: p.name, role: p.role, ...(await makeHash(p.password)), created: new Date().toISOString() });
  } else {
    if (i < 0) throw fail('Benutzer nicht gefunden', 404);
    if (p.action === 'role') { if (!ROLES[p.role]) throw fail('Rolle wählen'); users[i] = { ...users[i], role: p.role }; }
    else if (p.action === 'password') { checkPassword(p.password); users[i] = { ...users[i], ...(await makeHash(p.password)) }; }
    else users.splice(i, 1);
  }
  p.password = '';
  store(web, users);
  // Geänderte/gelöschte Benutzer müssen sich neu anmelden
  if (p.action !== 'add') for (const [raw, s] of web.security?.sessions || []) if (s.user && s.user.toLowerCase() === p.name.toLowerCase()) web.security.sessions.delete(raw);
  return { success: true, users: load(web).map(pub), rollen: ROLES };
}
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getBenutzer', 'saveBenutzer', 'getEigenesKonto', 'setEigenesPasswort'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    if (method === 'getEigenesKonto') { send(200, { user: auth.session?.user || null, role: auth.session?.role || 'admin', rolle: ROLES[auth.session?.role || 'admin'] }); return true; }
    if (method === 'setEigenesPasswort') {
      if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
      const p = await require('./web-security').body(req), name = auth.session?.user;
      if (!name) throw fail('Nur für eigene Benutzer (nicht für die CCU-Anmeldung)');
      if (!isObject(p) || Object.keys(p).some(k => !['old', 'password'].includes(k)) || typeof p.old !== 'string') throw fail('Altes und neues Passwort eingeben');
      const users = load(web), x = users.find(v => v.name === name); if (!x || !(await matches(x, p.old))) throw fail('Das alte Passwort stimmt nicht', 403);
      checkPassword(p.password); Object.assign(x, await makeHash(p.password)); p.password = p.old = ''; store(web, users);
      send(200, { success: true, message: 'Passwort geändert.' }); return true;
    }
    if (!isAdmin(auth)) { send(403, { error: 'Nur für Administratoren' }); return true; }
    if (method === 'getBenutzer') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, { users: load(web).map(pub), rollen: ROLES }); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    send(200, await change(web, await require('./web-security').body(req)));
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Benutzer: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { login, gate, handle, ROLES, _test: { load, VIEW, OPERATE, checkPassword } };
