'use strict';
// Wetter ohne CUxD (Wunsch Thomas, 12.10.2026): aktuelle Werte von Open-Meteo (kostenlos, ohne Schlüssel/Anmeldung).
// Standort aus der CCU (Systemsteuerung → Zeit/Standort, /usr/local/etc/config/time.conf) – läuft auf jeder CCU3.
// Übertragen werden nur Breiten-/Längengrad (auf 2 Stellen gerundet, ca. 1 km). Abruf alle 30 Minuten, höchstens 64 KB Antwort.
// Genutzt von: Diagrammen (Eintrag „Wetter“) und dem Entfeuchter als Reserve, wenn der Außenfühler fehlt.
const fs = require('fs'), path = require('path'), https = require('https');
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const TIME_CONF = '/usr/local/etc/config/time.conf';
const DEFAULTS = Object.freeze({ enabled: true, intervalMinutes: 30 });
const CODES = { 0: 'klar', 1: 'überwiegend klar', 2: 'teilweise bewölkt', 3: 'bedeckt', 45: 'Nebel', 48: 'Raureifnebel', 51: 'leichter Nieselregen', 53: 'Nieselregen', 55: 'starker Nieselregen', 61: 'leichter Regen', 63: 'Regen', 65: 'starker Regen', 66: 'gefrierender Regen', 67: 'starker gefrierender Regen', 71: 'leichter Schneefall', 73: 'Schneefall', 75: 'starker Schneefall', 77: 'Schneegriesel', 80: 'leichte Regenschauer', 81: 'Regenschauer', 82: 'starke Regenschauer', 85: 'Schneeschauer', 86: 'starke Schneeschauer', 95: 'Gewitter', 96: 'Gewitter mit Hagel', 99: 'starkes Gewitter mit Hagel' };

function settings(web) {
  let c = {}; try { c = web.security.configSnapshot.read().wetter || {}; } catch {}
  const s = { ...DEFAULTS, ...(isObject(c) ? c : {}) };
  if (typeof s.enabled !== 'boolean') s.enabled = true;
  s.intervalMinutes = Number.isInteger(s.intervalMinutes) && s.intervalMinutes >= 15 && s.intervalMinutes <= 180 ? s.intervalMinutes : 30;
  // Eigene Orte (Wunsch Thomas): Name + Koordinaten; „ort“ = angezeigter Ort (leer = Standort der Zentrale)
  s.orte = Array.isArray(s.orte) ? s.orte.filter(validPlace).slice(0, 10) : [];
  s.ort = typeof s.ort === 'string' && s.orte.some(o => o.name === s.ort) ? s.ort : '';
  return s;
}
const validPlace = o => isObject(o) && typeof o.name === 'string' && o.name.trim().length >= 1 && o.name.length <= 60 && !/[\x00-\x1f\x7f]/.test(o.name) && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 90 && Math.abs(o.lon) <= 180;
const round2 = v => Math.round(v * 100) / 100;
function place(web, timeConf) { const s = settings(web), o = s.orte.find(x => x.name === s.ort); return o ? { lat: round2(o.lat), lon: round2(o.lon), name: o.name } : location(timeConf); }
function location(file = TIME_CONF) {
  try {
    const t = fs.readFileSync(file, 'utf8'), lat = Number(/^LATITUDE=(-?[\d.]+)/m.exec(t)?.[1]), lon = Number(/^LONGITUDE=(-?[\d.]+)/m.exec(t)?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
  } catch {}
  return null;
}
function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'CCU3-Matter-Bridge' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error('Antwort ' + res.statusCode)); return; }
      let size = 0; const chunks = [];
      res.on('data', c => { size += c.length; if (size > 65536) { req.destroy(Error('Antwort zu groß')); return; } chunks.push(c); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('Ungültige Antwort')); } });
    });
    req.on('timeout', () => req.destroy(Error('Zeitüberschreitung'))); req.on('error', reject);
  });
}
const num = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : null;
function parse(data) {
  const c = data?.current; if (!isObject(c)) throw Error('Keine aktuellen Werte');
  return { temperature: num(c.temperature_2m, -60, 60), humidity: num(c.relative_humidity_2m, 0, 100), apparent: num(c.apparent_temperature, -80, 70),
    wind: num(c.wind_speed_10m, 0, 400), pressure: num(c.pressure_msl, 800, 1100), cloud: num(c.cloud_cover, 0, 100), precipitation: num(c.precipitation, 0, 500),
    code: Number.isInteger(c.weather_code) ? c.weather_code : null, text: CODES[c.weather_code] || '', time: typeof c.time === 'string' ? c.time.slice(0, 20) : '',
    day: c.is_day === 0 ? false : c.is_day === 1 ? true : null };
}
// Vorhersage für die Wetter-Seite (gleiche Anfrage): nächste 24 Stunden und 5 Tage. Ungültige Einträge entfallen.
const isoTime = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v) ? v : null;
function parseForecast(data) {
  const out = { hours: [], days: [] }, hh = data?.hourly, dd = data?.daily;
  const code = v => Number.isInteger(v) && v >= 0 && v <= 99 ? v : null;
  if (isObject(hh) && Array.isArray(hh.time)) for (let i = 0; i < Math.min(hh.time.length, 24); i++) {
    const t = isoTime(hh.time[i]); if (!t) continue;
    out.hours.push({ time: t, temperature: num(hh.temperature_2m?.[i], -60, 60), rain: num(hh.precipitation_probability?.[i], 0, 100), code: code(hh.weather_code?.[i]) });
  }
  if (isObject(dd) && Array.isArray(dd.time)) for (let i = 0; i < Math.min(dd.time.length, 7); i++) {
    const t = isoTime(dd.time[i]); if (!t) continue;
    out.days.push({ date: t, max: num(dd.temperature_2m_max?.[i], -60, 60), min: num(dd.temperature_2m_min?.[i], -60, 60), rain: num(dd.precipitation_probability_max?.[i], 0, 100),
      code: code(dd.weather_code?.[i]), text: CODES[dd.weather_code?.[i]] || '', sunrise: isoTime(dd.sunrise?.[i]), sunset: isoTime(dd.sunset?.[i]) });
  }
  return out;
}

class Wetter {
  constructor(web, { now = Date.now, fetch = get, timeConf = TIME_CONF } = {}) {
    this.web = web; this.now = now; this.fetch = fetch; this.timeConf = timeConf; this.timer = null; this.busy = false;
    this.file = path.join(path.dirname(web.deps.configPath), 'wetter-state.json');
    this.state = { current: null, at: 0, error: null, lastTry: 0 };
    try { const r = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (isObject(r.current) && Number.isFinite(r.at)) { this.state.current = r.current; this.state.at = r.at; this.state.forecast = isObject(r.forecast) ? r.forecast : null; } } catch {}
  }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), 60000); this.timer.unref?.(); setTimeout(() => this.tick().catch(() => {}), 20000).unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick(force = false) {
    const s = settings(this.web), now = this.now();
    if (!s.enabled || this.busy) return null;
    if (!force && now - Math.max(this.state.at, this.state.lastTry) < s.intervalMinutes * 60000) return null;
    const loc = place(this.web, this.timeConf);
    if (!loc) { this.state.error = 'Standort fehlt (CCU-Systemsteuerung → Zeit/Standort)'; return null; }
    this.busy = true; this.state.lastTry = now;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,is_day&hourly=temperature_2m,precipitation_probability,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&forecast_days=5&forecast_hours=24&wind_speed_unit=kmh&timezone=auto`;
      const data = await this.fetch(url), cur = parse(data);
      if (cur.temperature === null && cur.humidity === null) throw Error('Keine Messwerte');
      let forecast = null; try { forecast = parseForecast(data); } catch {}
      this.state.current = cur; this.state.forecast = forecast; this.state.at = now; this.state.error = null;
      try { require('./durable-storage').atomicJson(this.file, { current: cur, forecast, at: now }); } catch {}
      return cur;
    } catch (e) { this.state.error = 'Wetter nicht abrufbar: ' + String(e.message || 'Fehler').slice(0, 80); return null; }
    finally { this.busy = false; }
  }
  // Nur Werte, die höchstens 3 Stunden alt sind (sonst null).
  fresh(maxMs = 3 * 3600000) { return this.state.current && this.now() - this.state.at <= maxMs ? { ...this.state.current, at: this.state.at } : null; }
  status() { return { settings: settings(this.web), location: place(this.web, this.timeConf), current: this.state.current, forecast: this.state.forecast || null, at: this.state.at ? new Date(this.state.at).toISOString() : null, error: this.state.error, source: 'Open-Meteo (open-meteo.com), kostenlos, ohne Schlüssel' }; }
}
const instances = new WeakMap();
function wetter(web, options) { let w = instances.get(web); if (!w) { w = new Wetter(web, options); instances.set(web, w); } return w; }
function start(web, options) { const w = wetter(web, options); w.start(); return w; }
// Für Diagramme: ein Eintrag „Wetter“.
function historyRow(web) {
  const c = wetter(web).fresh(); if (!c) return null;
  return { address: 'wetter', name: 'Wetter (Open-Meteo)', room: 'Draußen', exposed: true, currentState: { temperature: c.temperature, humidity: c.humidity, windKmh: c.wind, pressureHpa: c.pressure, rainMm: c.precipitation } };
}
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getWetter', 'saveWetter', 'suchWetterOrt'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    const w = wetter(web);
    if (method === 'getWetter') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, w.status()); return true; }
    // Ort suchen (Open-Meteo-Ortssuche, kostenlos, ohne Schlüssel): nur der eingegebene Ortsname wird übertragen.
    if (method === 'suchWetterOrt') {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      if (auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
      const q = String(u.searchParams.get('name') || '').trim();
      if (q.length < 2 || q.length > 60 || /[\x00-\x1f\x7f]/.test(q)) { send(400, { error: 'Ortsname mit 2 bis 60 Zeichen eingeben' }); return true; }
      let data; try { data = await w.fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=8&language=de&format=json'); } catch { send(502, { error: 'Ortssuche nicht erreichbar' }); return true; }
      const list = (Array.isArray(data?.results) ? data.results : []).filter(x => Number.isFinite(x.latitude) && Number.isFinite(x.longitude)).slice(0, 8)
        .map(x => ({ name: String(x.name || '').slice(0, 60), region: [x.admin3, x.admin2, x.admin1, x.country].filter(v => typeof v === 'string' && v).join(', ').slice(0, 120), lat: Math.round(x.latitude * 1e4) / 1e4, lon: Math.round(x.longitude * 1e4) / 1e4 }));
      send(200, { results: list }); return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    if (isObject(p) && p.orte !== undefined && (!Array.isArray(p.orte) || p.orte.length > 10 || !p.orte.every(validPlace))) throw fail('Orte: höchstens 10, je Name und Koordinaten');
    if (isObject(p) && p.ort !== undefined && (typeof p.ort !== 'string' || (p.ort && !(p.orte || settings(web).orte).some(o => o.name === p.ort)))) throw fail('Angezeigter Ort unbekannt');
    if (isObject(p) && p.orte) p.orte = p.orte.map(o => ({ name: o.name.trim(), lat: Math.round(o.lat * 1e4) / 1e4, lon: Math.round(o.lon * 1e4) / 1e4 }));
    if (!isObject(p) || Object.keys(p).some(k => !['enabled', 'intervalMinutes', 'orte', 'ort'].includes(k)) || (p.enabled !== undefined && typeof p.enabled !== 'boolean') || (p.intervalMinutes !== undefined && (!Number.isInteger(p.intervalMinutes) || p.intervalMinutes < 15 || p.intervalMinutes > 180))) throw fail('Ungültige Einstellung (Abruf alle 15 bis 180 Minuten)');
    web.writeConfigPatch(c => { c.wetter = { ...DEFAULTS, ...(isObject(c.wetter) ? c.wetter : {}), ...p }; });
    if (settings(web).enabled) await w.tick(true);
    send(200, { success: true, ...w.status(), message: settings(web).enabled ? 'Gespeichert. Wetter wird abgerufen.' : 'Gespeichert. Wetterabruf ist aus.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Wetter: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, historyRow, wetter, location, parse, _test: { Wetter, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
