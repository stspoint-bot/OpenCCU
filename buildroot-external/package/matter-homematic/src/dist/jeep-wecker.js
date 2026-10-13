'use strict';
// Jeep „Fahrzeugdaten aktualisieren“ nach Zeitplan (Wunsch Thomas, 11.10.2026).
// Der Jeep meldet sich nur beim Fahren/Laden bei der Cloud. Alle X Stunden (Standard 4) prüft die Bridge, ob die
// letzten Fahrzeugdaten älter als das Intervall sind, und weckt das Auto dann EINMAL per Uconnect-Befehl DEEPREFRESH.
// Schutz: Wird die PIN abgelehnt, wird nicht automatisch erneut versucht (sonst Sperre der Uconnect-PIN).
// Die PIN liegt nur verschlüsselt im Schlüsselspeicher (jeep-pin.json) und wird nie ausgegeben.
const path = require('node:path');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const LIMITS = Object.freeze({ minHours: 2, maxHours: 24, defaultHours: 4 });

function settings(config) {
  const s = isObject(config.jeepDeepRefresh) ? config.jeepDeepRefresh : {};
  const hours = Number.isInteger(s.hours) && s.hours >= LIMITS.minHours && s.hours <= LIMITS.maxHours ? s.hours : LIMITS.defaultHours;
  return { enabled: s.enabled !== false, hours };
}
const vault = web => new (require('./smartplus').Vault)(path.join(path.dirname(web.deps.configPath), 'jeep-pin.json'));
function readPin(web) { try { const s = vault(web).read(); return typeof s.pin === 'string' && /^\d{4}$/.test(s.pin) ? s.pin : null; } catch { return null; } }

class Wecker {
  constructor(web, { now = () => Date.now(), timerMs = 10 * 60000 } = {}) {
    this.web = web; this.now = now; this.timerMs = timerMs;
    this.state = { lastRun: null, lastResult: null, pinRejected: false, busy: false };
    this.timer = null;
  }
  config() { return settings(this.web.security.configSnapshot.read()); }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), this.timerMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }
  // Eingesteckt laut letzter Fahrzeugmeldung (evInfo.battery.plugInStatus): true/false, null = unbekannt
  plugged(svc) {
    let any = null;
    for (const r of svc?.rows || []) { const p = r?.sources?.status?.data?.evInfo?.battery?.plugInStatus; if (p === true) return true; if (p === false) any = false; }
    return any;
  }
  newest(svc) {
    let t = 0;
    for (const r of svc?.rows || []) { const v = Date.parse(r.vehicleUpdatedAt || ''); if (Number.isFinite(v) && v > t) t = v; }
    return t;
  }
  // Automatischer Lauf: nur wenn eingeschaltet, PIN vorhanden, nicht gesperrt, Daten älter als das Intervall
  // und der letzte eigene Versuch mindestens ein Intervall her ist.
  async tick() {
    const cfg = this.config(), svc = this.web.jeepService, ms = cfg.hours * 3600000, now = this.now();
    if (!cfg.enabled || this.state.pinRejected || this.state.busy || !svc?.connected || !svc.client || !readPin(this.web)) return false;
    if (this.plugged(svc) !== true) return false; // Uconnect erlaubt das Aktualisieren nur am Ladekabel
    const newest = this.newest(svc);
    if (newest && now - newest < ms) return false;
    if (this.state.lastRun && now - Date.parse(this.state.lastRun) < ms) return false;
    await this.run('Zeitplan');
    return true;
  }
  async run(reason) {
    const svc = this.web.jeepService, pin = readPin(this.web);
    if (!svc?.connected || !svc.client) throw fail('Jeep ist nicht verbunden. Bitte zuerst auf der Jeep-Seite anmelden.', 409);
    if (!pin) throw fail('Bitte zuerst die Uconnect-PIN speichern.', 409);
    if (this.state.busy) throw fail('Aktualisierung läuft bereits', 429);
    if (this.state.pinRejected) throw fail('Die Uconnect-PIN wurde zuletzt abgelehnt. Bitte die PIN neu speichern – bis dahin wird nichts gesendet (Schutz vor Sperre).', 409);
    // Ohne Ladekabel (Freigabe Thomas 13.10.2026): nur VON HAND und nur „VF“ (Standort/Daten anfordern) – der Zeitplan nie.
    const ohneKabel = this.plugged(svc) === false;
    if (ohneKabel && reason !== 'von Hand') throw fail('Der Jeep hängt nicht am Ladekabel; automatisch wird er dann nicht geweckt.', 409);
    if (ohneKabel && typeof svc.client.refreshLocation !== 'function') throw fail('Wecken ohne Ladekabel ist in dieser Version nicht verfügbar.', 409);
    const vins = (svc.rows || []).map(r => r.vin).filter(v => typeof v === 'string');
    if (!vins.length) throw fail('Kein Fahrzeug im Jeep-Konto gefunden', 404);
    this.state.busy = true; this.state.lastRun = new Date(this.now()).toISOString();
    try {
      for (const vin of vins) await (ohneKabel ? svc.client.refreshLocation(vin, pin) : svc.client.deepRefresh(vin, pin));
      this.state.lastResult = { ok: true, at: this.state.lastRun, reason, weg: ohneKabel ? 'VF' : 'DEEPREFRESH', message: ohneKabel ? 'Jeep (ohne Ladekabel) per „Fahrzeug finden“ geweckt; Türstatus und Standort werden in etwa 1–2 Minuten neu gelesen.' : 'Fahrzeug geweckt; neue Daten kommen in wenigen Minuten.' };
      // Neue Daten abholen, sobald das Auto gemeldet hat (die Bridge fragt die Cloud ohnehin regelmäßig ab); Türstatus nach 90 s neu lesen
      setTimeout(() => svc.refresh?.().catch(() => {}), 120000).unref?.();
      try { require('./jeep-schloss').soon(90000); } catch {}
      if (ohneKabel) console.log('[jeep-wecker] VF (ohne Ladekabel) von Hand gesendet – von Uconnect angenommen');
      return this.state.lastResult;
    } catch (e) {
      if (e.pinRejected) this.state.pinRejected = true;
      if (ohneKabel) console.log('[jeep-wecker] VF (ohne Ladekabel) nicht angenommen: ' + (e.status ? e.message : 'Fehler'));
      this.state.lastResult = { ok: false, at: this.state.lastRun, reason, message: e.status ? e.message : 'Aktualisierung fehlgeschlagen' };
      throw e.status ? e : fail('Aktualisierung fehlgeschlagen', 502);
    } finally { this.state.busy = false; }
  }
  status() {
    const cfg = this.config(), svc = this.web.jeepService, newest = this.newest(svc);
    return { ...cfg, hasPin: !!readPin(this.web), connected: !!svc?.connected, pluggedIn: this.plugged(svc), pinRejected: this.state.pinRejected, lastRun: this.state.lastRun, lastResult: this.state.lastResult,
      vehicleUpdatedAt: newest ? new Date(newest).toISOString() : null, limits: LIMITS };
  }
}
const instances = new WeakMap();
function wecker(web, options) { let w = instances.get(web); if (!w) { w = new Wecker(web, options); instances.set(web, w); } return w; }
function start(web, options) { const w = wecker(web, options); w.start(); return w; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getJeepRefresh', 'saveJeepRefresh', 'runJeepRefresh'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const w = wecker(web);
    if (method === 'getJeepRefresh') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, w.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (method === 'saveJeepRefresh') {
      if (!isObject(p) || Object.keys(p).some(k => !['enabled', 'hours', 'pin'].includes(k)) || typeof p.enabled !== 'boolean') throw fail('Ungültige Einstellung');
      if (p.hours !== undefined && (!Number.isInteger(p.hours) || p.hours < LIMITS.minHours || p.hours > LIMITS.maxHours)) throw fail('Abstand: ' + LIMITS.minHours + ' bis ' + LIMITS.maxHours + ' Stunden');
      if (p.pin !== undefined && p.pin !== '' && (typeof p.pin !== 'string' || !/^\d{4}$/.test(p.pin))) throw fail('Uconnect-PIN muss aus 4 Ziffern bestehen');
      if (typeof p.pin === 'string' && p.pin) { vault(web).write({ pin: p.pin }); w.state.pinRejected = false; }
      web.writeConfigPatch(c => { c.jeepDeepRefresh = { enabled: p.enabled, hours: p.hours ?? settings(c).hours }; });
      send(200, { success: true, ...w.status(), message: p.enabled ? 'Gespeichert. Die Bridge weckt den Jeep höchstens alle ' + (p.hours ?? settings(web.security.configSnapshot.read()).hours) + ' Stunden, und nur wenn seine Daten älter sind.' : 'Gespeichert. Automatische Aktualisierung ist ausgeschaltet.' });
      return true;
    }
    if (!isObject(p) || Object.keys(p).length) throw fail('Unerwartete Angaben');
    send(200, { success: true, ...(await w.run('von Hand')), status: w.status() });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Jeep-Aktualisierung: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, settings, LIMITS, _test: { Wecker, wecker, readPin, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
