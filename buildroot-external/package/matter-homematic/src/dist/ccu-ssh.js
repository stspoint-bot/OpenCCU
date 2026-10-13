'use strict';
// SSH-Zugang der Zentrale: Zustand ansehen, ein-/ausschalten, Zugangsschlüssel verwalten.
// Arbeitet direkt mit den Systemdateien (wie OpenCCU selbst) und braucht deshalb keine OpenCCU-Oberfläche:
// - an/aus: Merkdatei /usr/local/etc/config/sshEnabled, Dienst über /etc/init.d/S50sshd
// - Schlüssel: /usr/local/etc/ssh/authorized_keys (dorthin zeigt /root/.ssh)
// Nur für CCU-Administratoren. Private Schlüssel und Passwörter werden nie angenommen oder ausgegeben.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFile } = require('node:child_process');

const DEFAULT_PATHS = Object.freeze({ flag: '/usr/local/etc/config/sshEnabled', keys: '/usr/local/etc/ssh/authorized_keys', init: '/etc/init.d/S50sshd', pid: '/var/run/sshd.pid', shadow: '/etc/config/shadow' });
const LIMITS = Object.freeze({ keys: 20, line: 16384, comment: 64, file: 262144 });
const TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
// Neue Schlüssel dürfen nur anmelden, nicht weiterleiten.
const RESTRICT = 'no-port-forwarding,no-agent-forwarding,no-X11-forwarding';
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const paths = web => ({ ...DEFAULT_PATHS, ...(web.deps?.sshPaths || {}) });

// Eine Zeile aus authorized_keys zerlegen: [Optionen] Typ Schlüssel [Kommentar]
function parseLine(line) {
  const text = String(line).trim();
  if (!text || text.startsWith('#') || text.length > LIMITS.line) return null;
  const at = TYPES.map(t => { const m = new RegExp('(^|[\\s,"])(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\s+([A-Za-z0-9+/]+={0,3})(\\s+(.*))?$').exec(text); return m ? { m, t } : null; }).find(Boolean);
  if (!at) return null;
  const blob = Buffer.from(at.m[3], 'base64');
  if (blob.length < 20 || blob.toString('base64').replace(/=+$/, '') !== at.m[3].replace(/=+$/, '')) return null;
  const n = blob.readUInt32BE(0);
  if (n !== at.t.length || blob.toString('latin1', 4, 4 + n) !== at.t) return null;
  const options = text.slice(0, at.m.index + at.m[1].length).trim();
  return { type: at.t, blob, comment: (at.m[5] || '').trim(), options };
}
const fingerprint = blob => 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
const cleanComment = c => String(c || '').replace(/[^\w.@ +:-]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.comment);

function readKeys(file) {
  try { const st = fs.statSync(file); if (st.size > LIMITS.file) throw fail('Schlüsseldatei ist ungewöhnlich groß; bitte von Hand prüfen', 500); return fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}
function listKeys(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) { const k = parseLine(line); if (k) out.push({ type: k.type, fingerprint: fingerprint(k.blob), comment: cleanComment(k.comment), restricted: k.options.length > 0 }); }
  return out;
}
// Atomar schreiben (erst Hilfsdatei, dann umbenennen), Rechte 0600.
function writeKeys(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.neu-' + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  try { fs.chmodSync(file, 0o600); } catch {}
}

function pidAlive(file) {
  try { const pid = Number(fs.readFileSync(file, 'utf8').trim()); if (!Number.isInteger(pid) || pid <= 1) return false; process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function status(web) {
  const p = paths(web), available = fs.existsSync(p.init);
  return { available, enabled: fs.existsSync(p.flag), running: available ? pidAlive(p.pid) : false, keys: listKeys(readKeys(p.keys)), limits: { keys: LIMITS.keys } };
}
const run = (file, args) => new Promise((resolve, reject) => execFile(file, args, { timeout: 20000 }, (e, out, err) => e ? reject(Object.assign(fail('Der SSH-Dienst hat nicht wie erwartet reagiert', 502), { detail: String(err || e.message).slice(0, 200) })) : resolve(out)));

async function setEnabled(web, p) {
  if (!isObject(p) || Object.keys(p).length !== 1 || typeof p.enabled !== 'boolean') throw fail('Ungültige Auswahl');
  const s = paths(web);
  if (!fs.existsSync(s.init)) throw fail('Auf diesem System gibt es keinen SSH-Dienst', 501);
  const runInit = arg => (web.deps?.sshRun || run)(s.init, [arg]);
  if (p.enabled) { fs.writeFileSync(s.flag, '', { mode: 0o644 }); await runInit('start'); }
  else { await runInit('stop'); try { fs.unlinkSync(s.flag); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const st = status(web);
  return { success: true, ...st, message: p.enabled ? (st.running ? 'SSH ist eingeschaltet.' : 'SSH ist eingeschaltet; der Dienst startet gleich.') : 'SSH ist ausgeschaltet. Es ist keine Anmeldung per SSH mehr möglich.' };
}
function addKey(web, p) {
  if (!isObject(p) || Object.keys(p).some(k => !['key', 'comment'].includes(k)) || typeof p.key !== 'string') throw fail('Bitte den öffentlichen Schlüssel einfügen');
  if (/PRIVATE KEY/.test(p.key)) throw fail('Das ist ein privater Schlüssel. Bitte nur den öffentlichen Schlüssel (Datei mit .pub) einfügen – der private bleibt auf deinem Gerät.');
  const raw = p.key.replace(/\r?\n/g, ' ').trim();
  if (raw.length > LIMITS.line) throw fail('Schlüssel ist zu lang');
  const k = parseLine(raw);
  if (!k || k.options) throw fail('Das ist kein gültiger öffentlicher SSH-Schlüssel (beginnt z. B. mit „ssh-ed25519“).');
  if (k.type === 'ssh-rsa' && k.blob.length < 270) throw fail('RSA-Schlüssel unter 2048 Bit sind nicht sicher genug. Bitte einen ed25519-Schlüssel verwenden.');
  if (p.comment !== undefined && typeof p.comment !== 'string') throw fail('Bezeichnung ungültig');
  const comment = cleanComment(p.comment !== undefined && p.comment.trim() ? p.comment : k.comment) || 'Schlüssel ' + new Date().toISOString().slice(0, 10);
  const file = paths(web).keys, text = readKeys(file), list = listKeys(text), fp = fingerprint(k.blob);
  if (list.some(x => x.fingerprint === fp)) throw fail('Dieser Schlüssel ist schon eingetragen', 409);
  if (list.length >= LIMITS.keys) throw fail('Höchstens ' + LIMITS.keys + ' Schlüssel');
  writeKeys(file, (text && !text.endsWith('\n') ? text + '\n' : text) + RESTRICT + ' ' + k.type + ' ' + k.blob.toString('base64') + ' ' + comment + '\n');
  return { success: true, ...status(web), message: 'Schlüssel „' + comment + '“ eingetragen. Er darf sich nur anmelden, nichts weiterleiten.' };
}
function removeKey(web, p) {
  if (!isObject(p) || Object.keys(p).length !== 1 || typeof p.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(p.fingerprint)) throw fail('Schlüssel ungültig');
  const file = paths(web).keys, lines = readKeys(file).split(/\r?\n/);
  let removed = null;
  const keep = lines.filter(line => { const k = parseLine(line); if (k && fingerprint(k.blob) === p.fingerprint) { removed = cleanComment(k.comment) || k.type; return false; } return true; });
  if (removed === null) throw fail('Schlüssel nicht gefunden', 404);
  writeKeys(file, keep.join('\n').replace(/\n*$/, '\n').replace(/^\n$/, ''));
  return { success: true, ...status(web), message: 'Schlüssel „' + removed + '“ entfernt. Wer ihn hatte, kann sich nicht mehr anmelden.' };
}

// SSH-Passwort (Benutzer root) ändern – wie OpenCCU (CCU.setSSHPassword): SHA-512-Wert mit mkpasswd, Eintrag in /etc/config/shadow.
// Unterschied: Das Passwort geht über die Standardeingabe an mkpasswd (nie in einer Befehlszeile), wird nie gespeichert,
// protokolliert oder zurückgegeben.
const HASH = /^\$6\$[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{86}$/;
const sha512crypt = password => new Promise((resolve, reject) => {
  const child = execFile('mkpasswd', ['-m', 'sha512'], { timeout: 20000 }, (e, out) => { if (e) reject(fail('Passwort konnte nicht verschlüsselt werden', 502)); else resolve(String(out).trim()); });
  child.stdin.end(password + '\n');
});
async function setPassword(web, p) {
  if (!isObject(p) || Object.keys(p).length !== 1 || typeof p.password !== 'string') throw fail('Bitte ein neues Passwort eingeben');
  const pw = p.password;
  if (pw.length < 10 || pw.length > 64) throw fail('Das Passwort muss 10 bis 64 Zeichen lang sein');
  if (/[\x00-\x1f\x7f]/.test(pw) || /^\s|\s$/.test(pw)) throw fail('Das Passwort darf keine Steuerzeichen und keine Leerzeichen am Anfang oder Ende enthalten');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw fail('Das Passwort braucht Buchstaben und Ziffern');
  const file = paths(web).shadow, text = fs.readFileSync(file, 'utf8');
  if (!/^root:[^:\n]*:/m.test(text)) throw fail('Benutzer root nicht gefunden – nichts geändert', 500);
  const digest = await (web.deps?.sshHash || sha512crypt)(pw);
  if (!HASH.test(digest)) throw fail('Passwort konnte nicht verschlüsselt werden – nichts geändert', 502);
  const mode = fs.statSync(file).mode & 0o777, tmp = file + '.neu-' + process.pid;
  fs.writeFileSync(tmp, text.replace(/^root:[^:\n]*:/m, 'root:' + digest + ':'), { mode });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
  return { success: true, ...status(web), message: 'Das SSH-Passwort wurde geändert. Es gilt ab der nächsten Anmeldung.' };
}

let busy = false;
async function exclusive(fn) { if (busy) throw fail('Eine Änderung läuft bereits; bitte kurz warten', 429); busy = true; try { return await fn(); } finally { busy = false; } }
// Ohne SSH-Dienst (z. B. Testumgebung am PC) wird nichts geschrieben.
const onCcu = fn => (web, p) => { if (!fs.existsSync(paths(web).init)) throw fail('Auf diesem System gibt es keinen SSH-Dienst', 501); return fn(web, p); };
const POST = { setSshEnabled: onCcu(setEnabled), addSshKey: onCcu(addKey), removeSshKey: onCcu(removeKey), setSshPassword: onCcu(setPassword) };

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (method !== 'getSshStatus' && !Object.hasOwn(POST, method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (method === 'getSshStatus') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, status(web)); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    send(200, await exclusive(() => POST[method](web, p)));
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'SSH: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, status, LIMITS, _test: { parseLine, listKeys, fingerprint, RESTRICT } };
