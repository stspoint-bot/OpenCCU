'use strict';
// Geplanter Neustart der CCU3: an gewählten Wochentagen zu einer festen Uhrzeit, auf Wunsch mit
// WhatsApp-Hinweis vorher. Dazu „jetzt neu starten“ von Hand. Ersetzt das bisherige Skript-Programm.
//
// Sicherheitsregeln dieses Bausteins:
// - Werkseitig ausgeschaltet. Einstellen und Auslösen nur nach Anmeldung als CCU-Administrator.
// - Höchstens ein geplanter Neustart in 20 Stunden; nie in den ersten 10 Minuten nach einem Start
//   (verhindert Neustart-Schleifen, auch wenn die Uhr springt).
// - Läuft gerade eine Sicherung oder Geräte-Einrichtung, wird bis zu 30 Minuten gewartet, sonst
//   fällt der Neustart an diesem Tag aus.
// - Vor dem Neustart sichert die Zentrale ihren Stand; der Neustart-Befehl ist fest eingebaut
//   (/sbin/reboot ohne Befehlszeile), es wird nichts aus Eingaben zusammengesetzt.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LIMITS = Object.freeze({ minGapMs: 20 * 3600000, minUptimeS: 600, windowMs: 30 * 60000, confirm: 'CCU NEU STARTEN' });
const DAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const DEFAULT = Object.freeze({ enabled: false, time: '04:00', days: [1], notify: true });

function normalize(p) {
  if (!isObject(p) || Object.keys(p).some(k => !['enabled', 'time', 'days', 'notify'].includes(k))) throw fail('Unerwartete Angaben');
  if (typeof p.enabled !== 'boolean' || typeof p.notify !== 'boolean') throw fail('Ein/Aus ungültig');
  if (typeof p.time !== 'string' || !TIME.test(p.time)) throw fail('Uhrzeit im Format HH:MM angeben');
  if (!Array.isArray(p.days) || p.days.length > 7 || new Set(p.days).size !== p.days.length || p.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw fail('Wochentage ungültig');
  if (p.enabled && !p.days.length) throw fail('Mindestens einen Wochentag wählen');
  return { enabled: p.enabled, time: p.time, days: [...p.days].sort((a, b) => a - b), notify: p.notify };
}
function stored(web) {
  try { return normalize(web.security.configSnapshot.read().scheduledReboot); } catch { return { ...DEFAULT, days: [...DEFAULT.days] }; }
}
// Der echte Neustart. Nur auf der CCU (Linux) vorhanden; überall sonst passiert nichts.
function realReboot() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'linux' || !fs.existsSync('/sbin/reboot')) { reject(fail('Neustart ist nur auf der CCU3 möglich', 501)); return; }
    execFile('/sbin/reboot', [], { timeout: 15000 }, error => error ? reject(fail('Neustart-Befehl fehlgeschlagen', 502)) : resolve());
  });
}
const withTimeout = (promise, ms) => { let t; return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(Error('Zeitlimit')), ms); })]).finally(() => clearTimeout(t)); };

class Scheduler {
  constructor(web, options = {}) {
    this.web = web; this.now = options.now || Date.now; this.uptime = options.uptime || (() => os.uptime());
    this.reboot = options.reboot || realReboot; this.wait = options.wait ?? 3000;
    this.file = path.join(path.dirname(web.deps.configPath), 'neustart-state.json');
    this.timer = null; this.running = false;
    this.state = this.load();
  }
  load() {
    const s = { lastRun: 0, lastDay: '', lastResult: null };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Number.isFinite(raw.lastRun) && raw.lastRun > 0) s.lastRun = raw.lastRun;
      if (typeof raw.lastDay === 'string' && raw.lastDay.length <= 12) s.lastDay = raw.lastDay;
      if (isObject(raw.lastResult) && typeof raw.lastResult.message === 'string') s.lastResult = { at: String(raw.lastResult.at || '').slice(0, 30), ok: raw.lastResult.ok === true, message: raw.lastResult.message.slice(0, 200) };
    } catch { }
    return s;
  }
  save() { try { require('./durable-storage').atomicJson(this.file, this.state); return true; } catch { return false; } }
  start() { if (this.timer) return; this.timer = setInterval(() => { this.tick().catch(() => { }); }, 20000); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  dayKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
  // Zeitpunkt des heutigen Termins, falls heute einer ansteht.
  dueToday(settings, now) {
    const d = new Date(now); if (!settings.days.includes(d.getDay())) return null;
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(settings.time.slice(0, 2)), Number(settings.time.slice(3)), 0, 0).getTime();
    return at;
  }
  next(settings, now) {
    if (!settings.enabled || !settings.days.length) return null;
    for (let i = 0; i < 8; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i);
      if (!settings.days.includes(d.getDay())) continue;
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(settings.time.slice(0, 2)), Number(settings.time.slice(3)), 0, 0).getTime();
      if (at > now || (i === 0 && now - at < LIMITS.windowMs && this.state.lastDay !== this.dayKey(d))) return at;
    }
    return null;
  }
  busy() { return this.web.backupBusy === true || this.web.wifiSetupBusy === true; }
  async tick() {
    if (this.running) return;
    const settings = stored(this.web); if (!settings.enabled) return;
    const now = this.now(), at = this.dueToday(settings, now), day = this.dayKey(new Date(now));
    if (at === null || now < at || now - at >= LIMITS.windowMs || this.state.lastDay === day) return;
    if (this.busy()) return; // später im Zeitfenster erneut versuchen
    // Der Tag gilt ab jetzt als erledigt – auch wenn eine Schutzregel den Neustart verhindert.
    this.state.lastDay = day;
    if (this.uptime() < LIMITS.minUptimeS) { this.result(false, 'Ausgelassen: Die CCU3 wurde gerade erst gestartet.'); return; }
    if (this.state.lastRun && now - this.state.lastRun < LIMITS.minGapMs) { this.result(false, 'Ausgelassen: Der letzte Neustart ist weniger als 20 Stunden her.'); return; }
    await this.run('Geplanter Neustart', settings.notify);
  }
  result(ok, message) { this.state.lastResult = { at: new Date(this.now()).toISOString(), ok, message }; this.save(); }
  // Ablauf: merken → WhatsApp (falls gewünscht) → Stand der Zentrale sichern → neu starten.
  async run(reason, notify) {
    if (this.running) throw fail('Ein Neustart läuft bereits', 429);
    this.running = true;
    try {
      this.state.lastRun = this.now(); this.state.lastResult = { at: new Date(this.now()).toISOString(), ok: true, message: reason + ' ausgelöst.' };
      if (!this.save()) { this.state.lastResult = { at: new Date(this.now()).toISOString(), ok: false, message: 'Abgebrochen: Merkdatei nicht schreibbar (Schutz vor Neustart-Schleifen).' }; throw fail('Neustart abgebrochen: Merkdatei nicht schreibbar', 500); }
      let notice = 'ohne WhatsApp-Hinweis';
      if (notify) {
        const monitor = this.web.security?.monitor;
        try { if (!monitor || typeof monitor.send !== 'function') throw Error('nicht verfügbar'); await withTimeout(Promise.resolve(monitor.send('CCU3 · ' + reason + '\n' + new Date(this.now()).toLocaleString('de-DE') + '\nDie CCU3 wird jetzt neu gestartet. Nach etwa 3 Minuten ist alles wieder erreichbar.')), 15000); notice = 'WhatsApp-Hinweis gesendet'; }
        catch { notice = 'WhatsApp-Hinweis nicht gesendet'; }
      }
      try { const connector = this.web.deps.getConnector?.(); if (connector && typeof connector.regaScript === 'function') await withTimeout(Promise.resolve(connector.regaScript('system.Save();', 8181)), 20000); } catch { }
      if (this.wait) await new Promise(resolve => setTimeout(resolve, this.wait));
      try { await this.reboot(); }
      catch (e) { this.result(false, reason + ' fehlgeschlagen: ' + (e.status ? e.message : 'Befehl nicht ausgeführt') + ' (' + notice + ').'); throw e.status ? e : fail('Neustart-Befehl fehlgeschlagen', 502); }
      this.result(true, reason + ' ausgelöst (' + notice + ').');
      return { notice };
    } finally { this.running = false; }
  }
  status() {
    const settings = stored(this.web), now = this.now(), next = this.next(settings, now);
    let whatsapp = false; try { whatsapp = this.web.security.monitor.settings().hasKey === true; } catch { }
    return { settings, days: DAY_NAMES, next: next ? new Date(next).toISOString() : null, lastRun: this.state.lastRun ? new Date(this.state.lastRun).toISOString() : null, lastResult: this.state.lastResult, uptimeSeconds: Math.round(this.uptime()), whatsappReady: whatsapp, available: process.platform === 'linux' && fs.existsSync('/sbin/reboot') || this.reboot !== realReboot };
  }
}
const schedulers = new WeakMap();
function scheduler(web, options) { let s = schedulers.get(web); if (!s) { s = new Scheduler(web, options); schedulers.set(web, s); } return s; }
function start(web, options) { const s = scheduler(web, options); s.start(); return s; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getScheduledReboot', 'saveScheduledReboot', 'rebootCcuNow'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    const admin = !!auth && !auth.session?.localBypass;
    if (!admin) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const s = scheduler(web);
    if (method === 'getScheduledReboot') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, s.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (method === 'saveScheduledReboot') {
      const next = normalize(p);
      web.writeConfigPatch(c => { c.scheduledReboot = next; });
      const st = s.status();
      send(200, { success: true, ...st, message: next.enabled ? 'Gespeichert. Nächster Neustart: ' + (st.next ? new Date(st.next).toLocaleString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'kein Termin') + '.' : 'Gespeichert. Der regelmäßige Neustart ist ausgeschaltet.' });
      return true;
    }
    if (!isObject(p) || Object.keys(p).some(k => k !== 'confirmation') || p.confirmation !== LIMITS.confirm) throw fail('Bestätigung fehlt');
    if (s.busy()) throw fail('Gerade läuft eine Sicherung oder Einrichtung; bitte danach erneut versuchen', 429);
    // Antwort zuerst senden, dann neu starten – sonst käme sie nicht mehr an.
    send(200, { success: true, message: 'Die CCU3 wird jetzt neu gestartet. Nach etwa 3 Minuten ist alles wieder erreichbar.' });
    s.run('Neustart von Hand', false).catch(() => { });
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Neustart: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, normalize, LIMITS, _test: { Scheduler, scheduler, stored, reset: web => { schedulers.get(web)?.stop(); schedulers.delete(web); } } };
