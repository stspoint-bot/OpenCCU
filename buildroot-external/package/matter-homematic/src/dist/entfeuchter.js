'use strict';
// Entfeuchter-Steuerung (Wunsch Thomas, 11.10.2026):
// - Licht an UND (Feuchte >= Ein-Grenze ODER „Duschen erkannt“) → Entfeuchter an.
// - Feuchte unter Aus-Grenze (und – falls Außenwerte genutzt – kaum noch feuchter als draußen) → Entfeuchter aus.
// - Licht aus → Entfeuchter wird nie eingeschaltet (ein laufender trocknet weiter bis „trocken“).
// „Duschen erkannt“: absolute Feuchte (g/m³) im Bad liegt deutlich über der Außenluft (CUxD-Wetter / OpenWeatherMap,
// ReGa-Systemvariablen). %-Werte von innen und außen sind wegen der Temperatur nicht direkt vergleichbar.
// Schutz: Entscheidung erst bei zwei gleichen Messungen in Folge, Mindestlaufzeit, Mindestpause, Höchstlaufzeit.
// Geschaltet wird über denselben geprüften Weg wie in den Automationen (einmal senden, zurücklesen).
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const ADDRESS = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$/;
const SYSVAR = /^[A-Za-z0-9 _.()+%-]{1,80}$/;
const WIFI = /^(smartlife|smartplus)@[A-Za-z0-9_-]{1,64}$/; // WLAN-Fühler als Außenquelle
const LIMITS = Object.freeze({ log: 30 });
const DEFAULTS = Object.freeze({ enabled: false, light: '', sensor: '', sensorFallback: '', actor: '', onRh: 65, offRh: 58, useOutdoor: true, onDelta: 5, offDelta: 3.5, // normale Raumluft liegt ~3 g/m³ über draußen; Duschen deutlich mehr
  outdoorSensor: '', outdoorRh: 'OpenWeatherMap Luftfeuchte (rel.)', outdoorT: 'OpenWeatherMap Temperatur', minOnMin: 10, minOffMin: 5, maxOnMin: 120, note: '' });

// Absolute Feuchte in g/m³ (Magnus-Formel), aus Temperatur °C und relativer Feuchte %.
function absHum(t, rh) {
  if (!Number.isFinite(t) || !Number.isFinite(rh) || rh < 0 || rh > 100 || t < -40 || t > 80) return null;
  const e = 6.112 * Math.exp(17.62 * t / (243.12 + t)) * rh / 100;
  return Math.round(216.7 * e / (273.15 + t) * 10) / 10;
}
const num = (v, min, max, name) => { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw fail(name + ': ' + min + ' bis ' + max); return Math.round(v * 10) / 10; };
function normalize(p) {
  if (!isObject(p)) throw fail('Ungültige Einstellung');
  const keys = Object.keys(DEFAULTS);
  if (Object.keys(p).some(k => !keys.includes(k))) throw fail('Unerwartete Felder in der Einstellung');
  const s = { ...DEFAULTS, ...p };
  if (typeof s.enabled !== 'boolean' || typeof s.useOutdoor !== 'boolean') throw fail('Ein/Aus ungültig');
  // Feuchtefühler darf auch ein WLAN-Fühler sein (z. B. Smart-Life-Sensor im Bad)
  for (const k of ['light', 'sensor', 'sensorFallback', 'actor']) if (s[k] !== '' && (typeof s[k] !== 'string' || !(ADDRESS.test(s[k]) || (/^sensor/.test(k) && WIFI.test(s[k]))))) throw fail('Gerät ungültig: ' + k);
  if (s.sensorFallback === s.sensor) s.sensorFallback = '';
  if (s.enabled && (!s.light || !s.sensor || !s.actor)) throw fail('Zum Einschalten Licht, Feuchtefühler und Entfeuchter auswählen');
  s.onRh = num(s.onRh, 30, 95, 'Einschalten ab'); s.offRh = num(s.offRh, 25, 90, 'Ausschalten unter');
  if (s.offRh >= s.onRh) throw fail('„Ausschalten unter“ muss kleiner sein als „Einschalten ab“');
  s.onDelta = num(s.onDelta, 0.5, 15, 'Duschen erkannt ab'); s.offDelta = num(s.offDelta, 0, 10, 'Trocken unter');
  if (s.offDelta >= s.onDelta) throw fail('„Trocken unter“ muss kleiner sein als „Duschen erkannt ab“');
  for (const k of ['outdoorRh', 'outdoorT']) if (typeof s[k] !== 'string' || !SYSVAR.test(s[k])) throw fail('Name der Außen-Variable ungültig');
  if (s.outdoorSensor !== '' && (typeof s.outdoorSensor !== 'string' || !WIFI.test(s.outdoorSensor))) throw fail('Außenfühler ungültig');
  s.minOnMin = Math.round(num(s.minOnMin, 0, 120, 'Mindestlaufzeit')); s.minOffMin = Math.round(num(s.minOffMin, 0, 120, 'Mindestpause')); s.maxOnMin = Math.round(num(s.maxOnMin, 10, 720, 'Höchstlaufzeit'));
  if (s.maxOnMin <= s.minOnMin) throw fail('Höchstlaufzeit muss größer als die Mindestlaufzeit sein');
  // Bemerkung (erscheint in der Überschrift)
  if (typeof s.note !== 'string' || s.note.trim().length > 200 || /[\x00-\x1f\x7f]/.test(s.note)) throw fail('Bemerkung: höchstens 200 Zeichen, keine Steuerzeichen');
  s.note = s.note.trim();
  return s;
}
const settings = web => { try { const c = web.security.configSnapshot.read().entfeuchter; return isObject(c) ? normalize(c) : { ...DEFAULTS }; } catch { return { ...DEFAULTS }; } };

class Controller {
  constructor(web, { now = () => Date.now(), timerMs = 60000, switchDevice, readOutdoor, wifiRows, wifiMeta } = {}) {
    this.wifiRows = wifiRows || null; this.wifiMeta = wifiMeta || null;
    this.web = web; this.now = now; this.timerMs = timerMs;
    this.switchDevice = switchDevice || ((w, a, on) => require('./automationen').switchDevice(w, a, on));
    this.readOutdoorImpl = readOutdoor || null;
    this.state = { values: null, streakOn: 0, streakOff: 0, ownSince: null, lastOffAt: 0, outdoor: null, outdoorAt: 0, busy: false, log: [] };
    this.timer = null;
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), this.timerMs); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }
  value(address, key) {
    // Tasmota-Steckdosen direkt (ohne CUxD-Hülle): Zustand über den Tasmota-Baustein
    if (typeof address === 'string' && address.startsWith('TASMOTA-')) { try { return require('./tasmota').automation(this.web).value(address, key); } catch { return undefined; } }
    // WLAN-Fühler: Feuchte/Temperatur aus der Geräteliste (nur wenn erreichbar)
    if (typeof address === 'string' && WIFI.test(address)) {
      try { const row = (this.wifiRows ? this.wifiRows() : require('./wifi-devices').rows(this.web)).find(d => d.address === address); if (!row || row.online === false) return undefined; const st = row.currentState || {};
        // Zwischengespeicherte Cloud-Werte: liefert die Zeile einen Zeitstempel und ist er älter als 30 min, gilt der Wert nicht
        // Smart Life: Cloud-Werte bleiben bei fehlgeschlagener Abfrage stehen. Gültig nur, wenn die letzte Abfrage geklappt hat und die
        // Messung (cloudMeasuredAt = Tuya update_time, aus smartplus-api.safeList) höchstens 30 min alt ist.
        const meta = this.wifiMeta ? this.wifiMeta(address) : (() => { const [p, id] = address.split('@'); try { return require('./smartplus-api').safeList(this.web, p)?.devices?.find(d => d.id === id) || null; } catch { return null; } })();
        if (meta && meta.cloudFailed === true) return undefined;
        const ts = Date.parse(meta?.cloudMeasuredAt || ''); if (Number.isFinite(ts) && this.now() - ts > 30 * 60000) return undefined;
        return { HUMIDITY: st.humidity, ACTUAL_TEMPERATURE: st.temperature }[key]; } catch { return undefined; }
    }
    const ch = this.web.deps.getConnector?.()?.getChannels?.()?.get(address); const v = ch?.paramsets?.VALUES?.[key]; return v;
  }
  async outdoor(s) {
    if (!s.useOutdoor) return null;
    if (!s.outdoorSensor && this.state.outdoor && this.now() - this.state.outdoorAt < 15 * 60000) return this.state.outdoor;
    let o = null;
    if (s.outdoorSensor) {
      // gleiche Prüfung wie beim Raumfühler (offline, Cloud-Abfrage fehlgeschlagen, Messung älter als 30 min → Reserve)
      const rh = Number(this.value(s.outdoorSensor, 'HUMIDITY')), t = Number(this.value(s.outdoorSensor, 'ACTUAL_TEMPERATURE'));
      if (Number.isFinite(rh) && Number.isFinite(t)) o = { rh, t, at: this.now(), source: 'Fühler' };
    }
    // Reserve ohne CUxD: Wetter von Open-Meteo (Baustein wetter.js), höchstens 3 Stunden alt
    if (!o && !this.readOutdoorImpl) try { const w = require('./wetter').wetter(this.web).fresh(); if (w && Number.isFinite(w.temperature) && Number.isFinite(w.humidity)) o = { rh: w.humidity, t: w.temperature, at: w.at, source: 'Open-Meteo' }; } catch { o = null; }
    if (!o) try {
      if (this.readOutdoorImpl) o = await this.readOutdoorImpl(s);
      else {
        const q = n => `object v=dom.GetObject(ID_SYSTEM_VARIABLES).Get("${n}");if(v){Write(v.Value()#";"#v.Timestamp().ToInteger());}`;
        const raw = String(await this.web.deps.getConnector().regaScript(q(s.outdoorRh) + 'Write("|");' + q(s.outdoorT), 8181)).trim();
        const [a, b] = raw.split('|').map(x => x.split(';'));
        const rh = Number(a?.[0]), t = Number(b?.[0]), at = Math.min(Number(a?.[1]), Number(b?.[1])) * 1000;
        if (Number.isFinite(rh) && Number.isFinite(t) && Number.isFinite(at)) o = { rh, t, at, source: 'CUxD-Wetter' };
      }
    } catch { o = null; }
    // Werte älter als 6 Stunden zählen nicht (CUxD-Wetter aktualisiert bei Thomas nur alle paar Stunden; Außenfeuchte ändert sich langsam).
    if (o && (!Number.isFinite(o.at) || this.now() - o.at > 6 * 3600000)) o = null;
    if (o) { o.ah = absHum(o.t, o.rh); o.source = o.source || 'CUxD-Wetter'; }
    this.state.outdoor = o; this.state.outdoorAt = this.now();
    return o;
  }
  note(on, reason, confirmed) {
    const e = { at: new Date(this.now()).toISOString(), on, reason, confirmed };
    this.state.log.unshift(e); this.state.log.length = Math.min(this.state.log.length, LIMITS.log);
    console.log('[entfeuchter] ' + (on ? 'EIN' : 'AUS') + ' – ' + reason + (confirmed ? '' : ' (nicht bestätigt)'));
  }
  async tick() {
    const s = settings(this.web), st = this.state, now = this.now();
    if (!s.enabled || st.busy) return null;
    const { boolish } = require('./automationen');
    const light = boolish(this.value(s.light, 'STATE')), actorOn = boolish(this.value(s.actor, 'STATE'));
    // Feuchtefühler; liefert er nichts (offline, Cloud-Zugang abgelaufen, Wert zu alt), gilt der Ersatzfühler (z. B. Wandthermostat)
    const read = a => { if (!a) return null; const r = Number(this.value(a, 'HUMIDITY') ?? this.value(a, 'ACTUAL_HUMIDITY')), tt = Number(this.value(a, 'ACTUAL_TEMPERATURE') ?? this.value(a, 'TEMPERATURE')); return Number.isFinite(r) ? { rh: r, t: tt } : null; };
    const main = read(s.sensor), alt = main ? null : read(s.sensorFallback), used = main || alt;
    const rh = used ? used.rh : NaN, t = used ? used.t : NaN, sensorUsed = main ? 'Fühler' : alt ? 'Ersatzfühler' : null;
    const ah = absHum(t, rh), out = await this.outdoor(s);
    const diff = ah !== null && out?.ah != null ? Math.round((ah - out.ah) * 10) / 10 : null;
    st.values = { at: new Date(now).toISOString(), light: light ?? null, actorOn: actorOn ?? null, rh: Number.isFinite(rh) ? rh : null, t: Number.isFinite(t) ? t : null, ah, sensorUsed, outdoor: out ? { rh: out.rh, t: out.t, ah: out.ah, at: new Date(out.at).toISOString(), source: out.source } : null, diff };
    if (actorOn && !st.ownSince) st.seenOnSince = st.seenOnSince || now; else if (actorOn === false) st.seenOnSince = null;
    // Sicherheit: Kein gültiger Feuchtewert, Entfeuchter läuft → spätestens nach der Höchstlaufzeit trotzdem aus
    if (actorOn === true && !Number.isFinite(rh)) {
      const since = st.ownSince || st.seenOnSince;
      if (since && now - since >= s.maxOnMin * 60000) return this.act(s.actor, false, 'Höchstlaufzeit ' + s.maxOnMin + ' min erreicht (kein Feuchtewert)');
      return null;
    }
    if (typeof actorOn !== 'boolean' || !Number.isFinite(rh)) return null; // ohne gültige Werte nichts tun
    const humid = rh >= s.onRh || (diff !== null && diff >= s.onDelta);
    // Trocken = relative Feuchte unter „Ausschalten unter“. Der Vergleich mit außen gilt nur zum Einschalten (Duschen erkennen)
    // bzw. als zusätzlicher Ausschaltgrund: Bei kalter Außenluft liegt das warme Bad sonst immer > 3,5 g/m³ darüber und der
    // Entfeuchter ginge nie aus (Fehler 13.10.2026: 57 % bei 60 % Grenze, lief trotzdem weiter).
    const dry = rh < s.offRh || (diff !== null && diff < s.offDelta && rh < s.onRh);
    if (!actorOn) {
      st.streakOff = 0;
      if (st.ownSince) { st.ownSince = null; st.lastOffAt = now; } // von außen ausgeschaltet
      const ready = now - st.lastOffAt >= s.minOffMin * 60000;
      st.streakOn = light === true && humid && ready ? st.streakOn + 1 : 0;
      if (st.streakOn >= 2) {
        st.streakOn = 0;
        const why = 'Licht an, Feuchte ' + rh + ' %' + (diff !== null ? ', Bad ' + ah + ' g/m³ / außen ' + out.ah + ' g/m³' : '') + (rh >= s.onRh ? ' (über ' + s.onRh + ' %)' : ' (Duschen erkannt)');
        return this.act(s.actor, true, why);
      }
      return null;
    }
    st.streakOn = 0;
    // Höchstlaufzeit gilt auch, wenn er von Hand oder vor einem Neustart der Bridge eingeschaltet wurde (dann ab dem ersten Sehen)
    const onFor = st.ownSince ? now - st.ownSince : null, seenFor = st.seenOnSince ? now - st.seenOnSince : null;
    const tooLong = (onFor ?? seenFor) !== null && (onFor ?? seenFor) >= s.maxOnMin * 60000;
    const mayStop = onFor === null || onFor >= s.minOnMin * 60000;
    st.streakOff = (dry && mayStop) || tooLong ? st.streakOff + 1 : 0;
    if (st.streakOff >= 2) {
      st.streakOff = 0;
      return this.act(s.actor, false, tooLong ? 'Höchstlaufzeit ' + s.maxOnMin + ' min erreicht' : 'trocken: Feuchte ' + rh + ' % (unter ' + s.offRh + ' %)' + (diff !== null ? ', Unterschied zu außen ' + diff + ' g/m³' : ''));
    }
    return null;
  }
  async act(address, on, reason) {
    this.state.busy = true;
    try {
      let r; try { r = await this.switchDevice(this.web, address, on); } catch (e) { this.note(on, reason + ' – Fehler: ' + (e.status ? e.message : 'Schalten fehlgeschlagen'), false); return { on, ok: false }; }
      const ok = r?.confirmed === true;
      if (on) this.state.ownSince = this.now(); else { this.state.ownSince = null; this.state.lastOffAt = this.now(); }
      this.note(on, reason, ok);
      return { on, ok };
    } finally { this.state.busy = false; }
  }
  status() { const s = settings(this.web); return { settings: s, values: this.state.values, log: this.state.log, running: !!this.timer }; }
}
const instances = new WeakMap();
function controller(web, options) { let c = instances.get(web); if (!c) { c = new Controller(web, options); instances.set(web, c); } return c; }
function start(web, options) { const c = controller(web, options); c.start(); return c; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getEntfeuchter', 'saveEntfeuchter'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const c = controller(web);
    if (method === 'getEntfeuchter') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, c.status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const s = normalize(await require('./web-security').body(req));
    web.writeConfigPatch(cfg => { cfg.entfeuchter = s; });
    c.state.streakOn = c.state.streakOff = 0;
    send(200, { success: true, ...c.status(), message: s.enabled ? 'Gespeichert. Die Entfeuchter-Steuerung ist eingeschaltet und prüft jede Minute.' : 'Gespeichert. Die Entfeuchter-Steuerung ist ausgeschaltet.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Entfeuchter: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, absHum, normalize, DEFAULTS, _test: { Controller, controller, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
