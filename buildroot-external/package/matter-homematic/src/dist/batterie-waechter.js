'use strict';
// Batterie-Wächter (Wunsch Thomas, 11.10.2026): Geräte mit Batterie werden geprüft; ist eine Batterie schwach,
// kommt eine WhatsApp-Nachricht an die unter „Dienste & WhatsApp“ hinterlegte Nummer (gleicher Versandweg wie
// die Anmelde-Warnung). Quelle sind die Wartungskanäle (LOWBAT / LOW_BAT) wie bei „Meldungen & Zustand“ – es wird
// nichts zusätzlich bei der CCU abgefragt.
// Ruhig: höchstens eine Nachricht am Tag zur gewählten Uhrzeit, und ein Gerät erst nach 7 Tagen erneut.
const fs = require('fs'), path = require('path');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const REPEAT_MS = 7 * 24 * 3600000, LOG = 20;
const DEFAULTS = Object.freeze({ enabled: true, time: '18:00', note: '' });
const BATTERY = new Set(['LOWBAT', 'LOW_BAT']);

function normalize(p) {
  if (!isObject(p)) throw fail('Ungültige Einstellung');
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULTS, k))) throw fail('Unerwartete Felder in der Einstellung');
  const s = { ...DEFAULTS, ...p };
  if (typeof s.enabled !== 'boolean') throw fail('Ein/Aus ungültig');
  if (typeof s.time !== 'string' || !TIME.test(s.time)) throw fail('Uhrzeit im Format HH:MM angeben');
  if (typeof s.note !== 'string' || s.note.trim().length > 200 || /[\x00-\x1f\x7f]/.test(s.note)) throw fail('Bemerkung: höchstens 200 Zeichen, keine Steuerzeichen');
  s.note = s.note.trim();
  return s;
}
const settings = web => { try { const c = web.security.configSnapshot.read().batterie; return isObject(c) ? normalize(c) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };
const weak = web => { try { return require('./ccu-zentrale')._internal.messages(web).filter(m => BATTERY.has(m.type)).map(m => ({ id: m.id, device: m.device, room: m.room, address: m.address })); } catch { return []; } };
// Ablaufdatum des kostenlosen Tuya-Zugangs (IoT Core), von Thomas einmal eingetragen; 14 Tage vorher kommt eine Erinnerung
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, REMIND_DAYS = 14;
const tuyaAblauf = web => { try { const v = web.security.configSnapshot.read().tuyaZugang?.ablauf; return typeof v === 'string' && DATE.test(v) ? v : ''; } catch { return ''; } };
const daysLeft = (date, now) => { const n = new Date(now); return Math.round((new Date(date + 'T00:00:00').getTime() - new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()) / 86400000); }; // Kalendertage
const deDate = date => date.split('-').reverse().join('.');
const tuyaExpired = web => { try { return require('./smartplus-api').safeList(web, 'smartlife').devices.some(d => d.tuyaExpired === true); } catch { return false; } };
const day = t => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };

class Watcher {
  constructor(web, options = {}) {
    this.web = web; this.now = options.now || Date.now; this.tickMs = options.tickMs ?? 30000;
    this.file = path.join(path.dirname(web.deps.configPath), 'batterie-state.json');
    this.timer = null; this.busy = false; this.lastManual = 0;
    this.state = { reported: {}, lastDay: '', log: [], tuyaAt: 0 };
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Number.isFinite(raw.tuyaAt)) this.state.tuyaAt = raw.tuyaAt; if (typeof raw.tuyaReminded === 'string' && DATE.test(raw.tuyaReminded)) this.state.tuyaReminded = raw.tuyaReminded; } catch {}
    try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (isObject(raw.reported)) for (const [k, v] of Object.entries(raw.reported)) if (typeof k === 'string' && k.length <= 80 && Number.isFinite(v)) this.state.reported[k] = v; if (typeof raw.lastDay === 'string' && raw.lastDay.length <= 12) this.state.lastDay = raw.lastDay; if (Array.isArray(raw.log)) this.state.log = raw.log.filter(isObject).slice(-LOG); } catch {}
  }
  save() { try { require('./durable-storage').atomicJson(this.file, this.state); } catch {} }
  start() { if (this.timer) return; this.startedAt = this.now(); this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick() {
    const s = settings(this.web), now = this.now(), d = new Date(now);
    if (!s.enabled || this.busy) return null;
    if (this.startedAt && now - this.startedAt < 300000) return null; // nach dem Start erst die Gerätewerte ankommen lassen
    await this.tuyaCheck(now);
    const cur = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    // Einmal am Tag ab der gewählten Uhrzeit (auch nachgeholt, falls die Bridge zur Uhrzeit neu startete).
    if (cur < s.time || this.state.lastDay === day(now)) return null;
    this.state.lastDay = day(now);
    const list = weak(this.web), ids = new Set(list.map(x => x.id));
    for (const id of Object.keys(this.state.reported)) if (!ids.has(id)) delete this.state.reported[id]; // Batterie gewechselt
    const due = list.filter(x => !(now - (this.state.reported[x.id] || 0) < REPEAT_MS));
    if (!due.length) { this.save(); return { sent: false, count: list.length }; }
    return this.send(due, list.length, false);
  }
  async send(due, total, manual) {
    const now = this.now();
    this.busy = true;
    try {
      const lines = due.slice(0, 30).map(x => '• ' + x.device + (x.room ? ' (' + x.room + ')' : ''));
      const text = 'CCU3 · Batterie schwach\n' + new Date(now).toLocaleString('de-DE') + '\n' + lines.join('\n') + (due.length > 30 ? '\n… und ' + (due.length - 30) + ' weitere' : '') + '\nBitte die Batterien bald wechseln.';
      const monitor = this.web?.security?.monitor;
      let ok = false, message;
      if (!monitor || typeof monitor.send !== 'function') message = 'WhatsApp-Dienst nicht verfügbar';
      else { try { await monitor.send(text); ok = true; message = 'WhatsApp gesendet (' + due.length + (due.length === 1 ? ' Gerät' : ' Geräte') + ')'; } catch (e) { message = 'WhatsApp nicht gesendet: ' + (e?.status ? e.message : 'Versand fehlgeschlagen'); } }
      if (ok) for (const x of due) this.state.reported[x.id] = now;
      this.state.log.push({ at: new Date(now).toISOString(), ok, manual, message, devices: due.map(x => x.device).slice(0, 30) }); this.state.log = this.state.log.slice(-LOG);
      this.save();
      return { sent: ok, count: total, message };
    } finally { this.busy = false; }
  }
  // Smart Life (Thomas 13.10.2026): Ist der kostenlose Tuya-Zugang abgelaufen, liefern die Batterie-Fühler (Außenfühler, Bad Sensor)
  // keine Werte mehr. Dann eine WhatsApp mit dem Weg zum Verlängern – höchstens alle 7 Tage, unabhängig von der Batterie-Uhrzeit.
  async tuyaCheck(now = this.now()) {
    if (await this.tuyaReminder(now)) return true;
    if (!tuyaExpired(this.web) || now - (this.state.tuyaAt || 0) < REPEAT_MS || this.busy) return false;
    const monitor = this.web?.security?.monitor; if (!monitor || typeof monitor.send !== 'function') return false;
    this.state.tuyaAt = now; this.save();
    try { await monitor.send('CCU3 · Smart Life\nDer kostenlose Tuya-Zugang ist abgelaufen. Außenfühler und Bad Sensor liefern keine Werte mehr (der Entfeuchter nutzt Ersatzwerte).\nKostenlos verlängern: iot.tuya.com → Cloud → Cloud Services → IoT Core → „Extend Trial Period“.'); this.state.log.push({ at: new Date(now).toISOString(), ok: true, manual: false, message: 'WhatsApp: Tuya-Zugang abgelaufen', devices: [] }); }
    catch (e) { this.state.log.push({ at: new Date(now).toISOString(), ok: false, manual: false, message: 'WhatsApp (Tuya-Zugang) nicht gesendet: ' + (e?.status ? e.message : 'Versand fehlgeschlagen'), devices: [] }); }
    this.state.log = this.state.log.slice(-LOG); this.save(); return true;
  }
  // Erinnerung 14 Tage vor dem eingetragenen Ablaufdatum – je Datum genau einmal (neues Datum nach dem Verlängern → neue Erinnerung).
  async tuyaReminder(now = this.now()) {
    const date = tuyaAblauf(this.web), left = date ? daysLeft(date, now) : null;
    if (!date || left > REMIND_DAYS || this.state.tuyaReminded === date || this.busy) return false;
    const monitor = this.web?.security?.monitor; if (!monitor || typeof monitor.send !== 'function') return false;
    this.state.tuyaReminded = date; this.save();
    const text = 'CCU3 · Smart Life\nDer kostenlose Tuya-Zugang ' + (left < 0 ? 'ist am ' + deDate(date) + ' abgelaufen.' : left === 0 ? 'läuft heute ab.' : 'läuft am ' + deDate(date) + ' ab (noch ' + left + (left === 1 ? ' Tag' : ' Tage') + ').') +
      '\nJetzt kostenlos verlängern: iot.tuya.com → Cloud → Cloud Services → IoT Core → „Extend Trial Period“. Danach das neue Datum auf der Smart-Life-Seite eintragen.';
    let ok = false; try { await monitor.send(text); ok = true; } catch {}
    this.state.log.push({ at: new Date(now).toISOString(), ok, manual: false, message: ok ? 'WhatsApp: Tuya-Zugang läuft am ' + deDate(date) + ' ab' : 'WhatsApp (Tuya-Ablauf) nicht gesendet', devices: [] }); this.state.log = this.state.log.slice(-LOG);
    this.save(); return ok;
  }
  tuyaStatus(now = this.now()) { const date = tuyaAblauf(this.web), left = date ? daysLeft(date, now) : null; return { ablauf: date, tageRest: left, bald: left !== null && left <= REMIND_DAYS, abgelaufen: tuyaExpired(this.web) }; }
  // Von Hand: alle aktuell schwachen Batterien sofort melden (auch wenn schon gemeldet).
  async runNow() {
    const now = this.now();
    if (now - this.lastManual < 60000) throw fail('Bitte frühestens nach einer Minute erneut prüfen', 429);
    if (this.busy) throw fail('Versand läuft bereits', 429);
    this.lastManual = now;
    const list = weak(this.web);
    if (!list.length) return { sent: false, count: 0, message: 'Keine schwache Batterie gefunden – keine Nachricht nötig.' };
    return this.send(list, list.length, true);
  }
  status() {
    let ready = false; try { ready = this.web.security.monitor.settings().hasKey === true; } catch {}
    return { settings: settings(this.web), weak: weak(this.web), log: this.state.log, whatsappReady: ready, tuyaExpired: tuyaExpired(this.web) };
  }
}
const instances = new WeakMap();
function watcher(web, options) { let w = instances.get(web); if (!w) { w = new Watcher(web, options); instances.set(web, w); } return w; }
function start(web, options) { const w = watcher(web, options); w.start(); return w; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getBatterie', 'saveBatterie', 'runBatterie', 'getTuyaAblauf', 'saveTuyaAblauf'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const w = watcher(web);
    if (method === 'getTuyaAblauf') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, w.tuyaStatus()); return true; }
    if (method === 'saveTuyaAblauf') {
      if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
      const p = await require('./web-security').body(req);
      if (!isObject(p) || Object.keys(p).some(k => k !== 'ablauf') || typeof p.ablauf !== 'string' || (p.ablauf !== '' && !DATE.test(p.ablauf))) throw fail('Datum im Format TT.MM.JJJJ wählen');
      web.writeConfigPatch(cfg => { if (p.ablauf) cfg.tuyaZugang = { ablauf: p.ablauf }; else delete cfg.tuyaZugang; });
      const st = w.tuyaStatus(); send(200, { success: true, ...st, message: p.ablauf ? 'Gespeichert. Erinnerung per WhatsApp ' + REMIND_DAYS + ' Tage vor dem ' + deDate(p.ablauf) + '.' : 'Ablaufdatum gelöscht – keine Erinnerung.' }); return true;
    }
    if (method === 'getBatterie') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, w.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const body = await require('./web-security').body(req);
    if (method === 'runBatterie') { if (isObject(body) && Object.keys(body).length) throw fail('Ungültige Anfrage'); const r = await w.runNow(); send(200, { success: true, ...w.status(), message: r.message }); return true; }
    const s = normalize(body);
    web.writeConfigPatch(cfg => { cfg.batterie = s; });
    send(200, { success: true, ...w.status(), message: s.enabled ? `Gespeichert. Geprüft wird täglich ab ${s.time} Uhr.` : 'Gespeichert. Der Batterie-Wächter ist ausgeschaltet.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Batterie-Wächter: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, normalize, DEFAULTS, _test: { Watcher, watcher, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
