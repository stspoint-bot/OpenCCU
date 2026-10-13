'use strict';
// Automationen: eigene Wenn-Dann-Regeln der Bridge (der „Editor“). Läuft im Bridge-Prozess auf
// der CCU3 und braucht dafür weder die OpenCCU-Oberfläche noch deren Programmlogik (ReGa):
// Auslöser kommen als Funk-Rückmeldungen über die vorhandene CCU-Verbindung, geschaltet wird über
// dieselben geprüften Wege wie auf der Seite „Geräte“ (gleiche Fähigkeitsprüfung, Rücklesen).
//
// Sicherheitsregeln dieses Bausteins:
// - Beim Start der Bridge und nach einem Neuaufbau der Funkverbindung wird nichts ausgelöst
//   (Schonfrist). In dieser Zeit werden Rückmeldungen nur als Ausgangszustand gemerkt.
// - Ausgelöst wird nur bei einem echten Wechsel (z. B. „keine Bewegung“ → „Bewegung“).
// - Einschalten wird nie automatisch wiederholt. Nur das zeitgesteuerte Ausschalten wird bei
//   einem Fehler bis zu dreimal nachgeholt, weil „Aus“ nichts doppelt schalten kann.
// - Eine Regel, die sich in 10 Minuten mehr als 30-mal auslöst, wird angehalten (Schleifenschutz).
// - Ändern, Löschen und Testen nur nach Anmeldung als CCU-Administrator.
//
// Neben den Funkgeräten der CCU können weitere Geräte teilnehmen (derzeit Tasmota-WLAN-Geräte).
// Sie melden sich über „ports.extras“ an und bringen ihre Auslöser, Ziele und Schaltwege selbst mit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const ADDRESS = /^[A-Za-z0-9_-]{1,64}:\d{1,3}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const RULE_ID = /^[a-f0-9]{12}$/;
const DUTY_WARN = 80, DUTY_HOLD = 90; // Duty Cycle in %: Warnung / automatisches Einschalten zurückhalten
// Außentemperatur-Bedingung prüfen (ohne „at“)
function outdoorCheck(c) { if (!['above', 'below'].includes(c.op)) throw fail('Bedingung: über oder unter wählen'); if (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < -40 || c.value > 50) throw fail('Außentemperatur: Wert von -40 bis 50 °C'); return { type: 'outdoor', op: c.op, value: Math.round(c.value * 10) / 10 }; }
// Vorhergesagte Temperatur für HH:MM (heute, oder morgen, wenn die Uhrzeit schon mehr als eine Stunde vorbei ist); null = keine Vorhersage.
// Nur eine Vorhersage, die höchstens 3 Stunden alt ist.
function forecastAt(web, hhmm, now) {
  let w = null; try { w = require('./wetter').wetter(web); } catch { return null; }
  const hours = w?.state?.forecast?.hours; if (!Array.isArray(hours) || !w.state.at || now - w.state.at > 3 * 3600000) return null;
  const d = new Date(now); d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3)), 0, 0); if (d.getTime() < now - 3600000) d.setDate(d.getDate() + 1);
  const target = d.getTime(), list = hours.map(x => ({ t: Date.parse(x.time), v: x.temperature })).filter(x => Number.isFinite(x.t) && typeof x.v === 'number').sort((a, b) => a.t - b.t);
  for (let i = 0; i < list.length; i++) {
    if (list[i].t === target) return list[i].v;
    if (i > 0 && list[i - 1].t < target && list[i].t > target) return Math.round((list[i - 1].v + (list[i].v - list[i - 1].v) * (target - list[i - 1].t) / (list[i].t - list[i - 1].t)) * 10) / 10;
  }
  return null;
}
const LIMITS = Object.freeze({ rules: 100, conditions: 4, actions: 8, name: 64, delay: 3600, duration: 86400, log: 200, sources: 3000 });
const DAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// Rückmeldungen, die als Auslöser oder Bedingung angeboten werden. „state“ = wahr/falsch oder 0/1.
const KEYS = Object.freeze({
  STATE: { kind: 'state' },
  MOTION: { kind: 'bool', title: 'Bewegung', on: 'Bewegung erkannt', off: 'keine Bewegung mehr' },
  PRESENCE_DETECTION_STATE: { kind: 'bool', title: 'Anwesenheit', on: 'Anwesenheit erkannt', off: 'keine Anwesenheit mehr' },
  PRESS_SHORT: { kind: 'event', title: 'Taste', on: 'Taste kurz gedrückt' },
  PRESS_LONG: { kind: 'event', title: 'Taste', on: 'Taste lang gedrückt' },
  LEVEL: { kind: 'number', title: 'Helligkeit / Position', unit: '%', scale: 100, min: 0, max: 100 },
  ACTUAL_TEMPERATURE: { kind: 'number', title: 'Temperatur', unit: '°C', min: -40, max: 80 },
  TEMPERATURE: { kind: 'number', title: 'Temperatur', unit: '°C', min: -40, max: 80 },
  HUMIDITY: { kind: 'number', title: 'Luftfeuchte', unit: '%', min: 0, max: 100 },
  ACTUAL_HUMIDITY: { kind: 'number', title: 'Luftfeuchte', unit: '%', min: 0, max: 100 },
  ILLUMINATION: { kind: 'number', title: 'Helligkeit', unit: 'Lux', min: 0, max: 200000 },
  CURRENT_ILLUMINATION: { kind: 'number', title: 'Helligkeit', unit: 'Lux', min: 0, max: 200000 },
  BRIGHTNESS: { kind: 'number', title: 'Helligkeit', unit: '', min: 0, max: 255 },
  POWER: { kind: 'number', title: 'Leistung', unit: 'W', min: 0, max: 100000 },
  LOWBAT: { kind: 'bool', title: 'Batterie', on: 'Batterie schwach', off: 'Batterie wieder in Ordnung' },
  LOW_BAT: { kind: 'bool', title: 'Batterie', on: 'Batterie schwach', off: 'Batterie wieder in Ordnung' },
  UNREACH: { kind: 'bool', title: 'Erreichbarkeit', on: 'nicht mehr erreichbar', off: 'wieder erreichbar' },
  SMOKE_DETECTOR_ALARM_STATUS: { kind: 'state', title: 'Rauchmelder', on: 'Rauch erkannt', off: 'kein Rauchalarm mehr' },
  WATERLEVEL_DETECTED: { kind: 'bool', title: 'Wassermelder', on: 'Wasser erkannt', off: 'kein Wasser mehr' },
  MOISTURE_DETECTED: { kind: 'bool', title: 'Wassermelder', on: 'Feuchtigkeit erkannt', off: 'keine Feuchtigkeit mehr' },
  ALARMSTATE: { kind: 'bool', title: 'Alarm', on: 'Alarm ausgelöst', off: 'Alarm beendet' },
  RAINING: { kind: 'bool', title: 'Regen', on: 'es regnet', off: 'es regnet nicht mehr' }
});
function stateTexts(type) {
  if (/CONTACT|ROTARY_HANDLE|WINDOW|DOOR/i.test(type || '')) return { title: 'Fenster / Tür', on: 'geöffnet', off: 'geschlossen' };
  if (/SWITCH|DIMMER|KEY|ACTUATOR/i.test(type || '')) return { title: 'Schaltzustand', on: 'eingeschaltet', off: 'ausgeschaltet' };
  return { title: 'Zustand', on: 'an', off: 'aus' };
}
// wahr/falsch aus einer Rückmeldung; Zahlen 0/1 (Homematic IP) zählen als falsch/wahr.
const boolish = v => typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : undefined;
function sourceInfo(channel, key, value) {
  const def = KEYS[key]; if (!def) return null;
  if (def.kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', title: def.title, unit: def.unit, scale: def.scale || 1, min: def.min, max: def.max, current: Math.round(value * (def.scale || 1) * 10) / 10 } : null;
  if (def.kind === 'event') return typeof value === 'boolean' ? { kind: 'event', title: def.title, on: def.on } : null;
  if (def.kind === 'bool' && typeof value !== 'boolean') return null;
  if (boolish(value) === undefined) return null;
  const texts = def.on ? def : stateTexts(channel.type);
  return { kind: 'bool', title: texts.title, on: texts.on, off: texts.off, current: boolish(value) };
}

// Tasten melden einen Druck nur als Ereignis; die CCU führt dafür oft keinen gespeicherten Wert.
// Solche Kanäle werden am Kanaltyp erkannt. Die 50 virtuellen Tasten der Zentrale bleiben außen vor.
const KEY_CHANNEL = /^(KEY|KEY_TRANSCEIVER|MULTI_MODE_INPUT_TRANSMITTER)$/;
const VIRTUAL = /^(BidCoS-RF|HmIP-RCV-\d+|CUxD|INT\d+)(:|$)/i;
function sourcesOf(address, channel) {
  const out = [];
  if (!channel || VIRTUAL.test(address) || /VIRTUAL_KEY/.test(channel.type || '')) return out;
  const values = channel.paramsets?.VALUES || {};
  for (const key of Object.keys(values)) { const info = sourceInfo(channel, key, values[key]); if (info) out.push({ key, ...info }); }
  if (KEY_CHANNEL.test(channel.type || '')) for (const key of ['PRESS_SHORT', 'PRESS_LONG']) if (!out.some(o => o.key === key)) out.push({ key, kind: 'event', title: KEYS[key].title, on: KEYS[key].on });
  return out;
}

// ---------- Zugriff auf die Bridge (für Tests und die Testumgebung austauschbar) ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function locked(web, address, fn) {
  const pending = web.security?.pending;
  if (!pending) return fn();
  const end = Date.now() + 5000;
  while (pending.has(address)) { if (Date.now() > end) throw fail('Gerät wird gerade von einem anderen Auftrag geschaltet', 429); await sleep(100); }
  pending.add(address);
  try { return await fn(); } finally { pending.delete(address); }
}
const ports = {
  connector: web => web.deps.getConnector(),
  ready: web => web.deps.isCcuConnected?.() !== false && web.deps.isDiscoveryComplete?.() !== false,
  rows: web => { try { return web.getDevices?.().devices || []; } catch { return []; } },
  mapped: web => web.deps.getDevices?.() || new Map(),
  async capabilities(web, address) {
    const mapped = ports.mapped(web).get(address); if (!mapped) return null;
    const [sw, dim] = await Promise.all([web.security.capability(address), require('./dimmer-control').capability(web, address)]);
    let thermostat = null;
    if (mapped.matterDeviceType === 'Thermostat') { const c = await require('./thermostat-control').capability(ports.connector(web), mapped); if (c.allowed) thermostat = { min: c.min, max: c.max, step: c.step }; }
    return { switch: sw.allowed === true, dimmer: dim.allowed === true, thermostat };
  },
  // Gleicher Ablauf wie „Schalten“ auf der Geräteseite: Fähigkeit prüfen, einmal senden, rücklesen.
  switch(web, address, on) {
    return locked(web, address, async () => {
      const security = web.security, connector = ports.connector(web);
      const cap = await security.capability(address);
      if (!cap.allowed) throw fail(cap.reason || 'Kein schaltbarer Aktor', 403);
      await connector.setValue(address, 'STATE', on);
      const source = security.stateAddress(address);
      let actual; try { actual = await require('./switch-readback').readback(connector, source, on); } catch {}
      if (typeof actual !== 'boolean' || actual !== on) return { confirmed: false };
      connector.handleEvent('matter-homematic-' + cap.interface, source, 'STATE', actual);
      return { confirmed: true };
    });
  },
  dimmer(web, address, percent) {
    return locked(web, address, async () => {
      const security = web.security, connector = ports.connector(web);
      if (!(await require('./dimmer-control').capability(web, address)).allowed) throw fail('Kein bestätigter Dimmer', 403);
      await connector.setValue(address, 'LEVEL', percent / 100); // Kommazahl: Homematic erwartet FLOAT, auch für 0 und 1
      const source = security.stateAddress(address);
      let actual; try { actual = await connector.getValue(source, 'LEVEL'); } catch {}
      const valid = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0 && actual <= 1;
      if (valid) connector.handleEvent('matter-homematic-' + connector.getChannels().get(source)?.interface, source, 'LEVEL', actual);
      return { confirmed: valid && Math.abs(actual - percent / 100) <= 0.005 };
    });
  },
  thermostat(web, address, temperature) {
    return locked(web, address, async () => {
      const mapped = ports.mapped(web).get(address);
      const r = await require('./thermostat-control').setTemperature(ports.connector(web), mapped, temperature);
      return { confirmed: r.confirmed === true };
    });
  },
  // Weitere Gerätearten neben der CCU (je Weboberfläche einmal angelegt).
  extras: web => { let list = extraCache.get(web); if (!list) { list = [require('./tasmota').automation(web), require('./jeep-fernsteuerung').automation(web), require('./ecovacs').automation(web)]; extraCache.set(web, list); } return list; }
};
const extraCache = new WeakMap();
function extraList(web) { try { return ports.extras(web) || []; } catch { return []; } }
function extraFor(web, address) { return extraList(web).find(x => { try { return x.owns(address); } catch { return false; } }) || null; }
// Rückmeldungen eines Geräts – gleich, ob CCU-Kanal oder weiteres Gerät.
function sourcesFor(web, channels, address) { const x = extraFor(web, address); if (x) { try { return x.sources(address) || []; } catch { return []; } } return sourcesOf(address, channels.get(address)); }
async function capabilitiesFor(web, address) { const x = extraFor(web, address); return x ? x.capabilities(address) : ports.capabilities(web, address); }

// ---------- Prüfung einer Regel (Form) ----------
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function only(o, keys, what) { if (!isObject(o) || Object.keys(o).some(k => !keys.includes(k))) throw fail('Unerwartete Angaben: ' + what); }
function address(v) { if (typeof v !== 'string' || !ADDRESS.test(v)) throw fail('Gerät ungültig'); return v; }
function keyName(v) { if (typeof v !== 'string' || !Object.hasOwn(KEYS, v)) throw fail('Rückmeldung wird nicht unterstützt'); return v; }
function time(v) { if (typeof v !== 'string' || !TIME.test(v)) throw fail('Uhrzeit im Format HH:MM angeben'); return v; }
function integer(v, min, max, what) { if (!Number.isInteger(v) || v < min || v > max) throw fail(`${what}: ${min} bis ${max}`); return v; }
function deviceTest(o, ops, what) {
  only(o, ['type', 'address', 'key', 'op', 'value'], what);
  const out = { type: 'device', address: address(o.address), key: keyName(o.key) };
  if (!ops.includes(o.op)) throw fail('Vergleich ungültig: ' + what);
  out.op = o.op;
  const kind = KEYS[out.key].kind;
  const numeric = ['above', 'below'].includes(out.op);
  if (numeric !== (kind === 'number')) throw fail('Vergleich passt nicht zur Rückmeldung: ' + what);
  if ((out.op === 'event') !== (kind === 'event')) throw fail('Vergleich passt nicht zur Rückmeldung: ' + what);
  if (numeric) { const d = KEYS[out.key]; if (typeof o.value !== 'number' || !Number.isFinite(o.value) || o.value < d.min || o.value > d.max) throw fail(`Grenzwert: ${d.min} bis ${d.max}${d.unit ? ' ' + d.unit : ''}`); out.value = Math.round(o.value * 10) / 10; }
  else if (o.value !== undefined) throw fail('Unerwarteter Grenzwert: ' + what);
  return out;
}
function normalizeRule(p) {
  only(p, ['id', 'name', 'note', 'enabled', 'trigger', 'conditions', 'actions', 'problem'], 'Automation');
  const rule = {};
  if (p.id !== undefined) { if (typeof p.id !== 'string' || !RULE_ID.test(p.id)) throw fail('Kennung ungültig'); rule.id = p.id; }
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > LIMITS.name || /[\x00-\x1f\x7f]/.test(p.name)) throw fail('Name mit 1 bis 64 Zeichen angeben');
  rule.name = p.name.trim();
  // Bemerkung (wird in der Liste neben dem Namen gezeigt)
  if (p.note !== undefined && p.note !== '') { if (typeof p.note !== 'string' || p.note.trim().length > 200 || /[\x00-\x1f\x7f]/.test(p.note)) throw fail('Bemerkung: höchstens 200 Zeichen, keine Steuerzeichen'); if (p.note.trim()) rule.note = p.note.trim(); }
  rule.enabled = p.enabled !== false;
  if (typeof p.enabled !== 'boolean' && p.enabled !== undefined) throw fail('Aktiv/pausiert ungültig');
  if (!isObject(p.trigger)) throw fail('Auslöser („Wenn“) fehlt');
  if (p.trigger.type === 'time') {
    only(p.trigger, ['type', 'time', 'days', 'everyDays', 'startDate'], 'Auslöser');
    if (p.trigger.everyDays !== undefined) {
      // „Alle N Tage“ ab einem Starttag (z. B. Akku eines Geräts regelmäßig laden)
      const n = integer(p.trigger.everyDays, 1, 365, 'Alle wie viele Tage');
      const s = p.trigger.startDate;
      if (typeof s !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(s) || Number.isNaN(Date.parse(s + 'T00:00:00'))) throw fail('Starttag im Format JJJJ-MM-TT angeben');
      rule.trigger = { type: 'time', time: time(p.trigger.time), days: [0, 1, 2, 3, 4, 5, 6], everyDays: n, startDate: s };
    } else {
      if (p.trigger.startDate !== undefined) throw fail('Starttag nur mit „alle N Tage“');
      if (!Array.isArray(p.trigger.days) || !p.trigger.days.length || p.trigger.days.length > 7 || new Set(p.trigger.days).size !== p.trigger.days.length || p.trigger.days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw fail('Mindestens einen Wochentag wählen');
      rule.trigger = { type: 'time', time: time(p.trigger.time), days: [...p.trigger.days].sort((a, b) => a - b) };
    }
  } else if (p.trigger.type === 'device') rule.trigger = deviceTest(p.trigger, ['on', 'off', 'event', 'above', 'below'], 'Auslöser');
  else throw fail('Auslöser („Wenn“) ungültig');
  const conditions = p.conditions === undefined ? [] : p.conditions;
  if (!Array.isArray(conditions) || conditions.length > LIMITS.conditions) throw fail('Höchstens ' + LIMITS.conditions + ' Bedingungen');
  rule.conditions = conditions.map(c => {
    if (!isObject(c)) throw fail('Bedingung ungültig');
    if (c.type === 'time') { only(c, ['type', 'from', 'to'], 'Bedingung'); return { type: 'time', from: time(c.from), to: time(c.to) }; }
    if (c.type === 'device') return deviceTest(c, ['on', 'off', 'above', 'below'], 'Bedingung');
    if (c.type === 'sun') { only(c, ['type', 'when'], 'Bedingung'); if (!['dark', 'light'].includes(c.when)) throw fail('Bedingung: dunkel oder hell wählen'); return { type: 'sun', when: c.when }; }
    // Außentemperatur (Wetter von Open-Meteo, z. B. Frost): unter/über einem Wert; mit „at“ (HH:MM) die Vorhersage für diese Uhrzeit
    if (c.type === 'outdoor') { only(c, ['type', 'op', 'value', 'at'], 'Bedingung'); if (c.at !== undefined) return { ...outdoorCheck(c), at: time(c.at) }; if (!['above', 'below'].includes(c.op)) throw fail('Bedingung: über oder unter wählen'); if (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < -40 || c.value > 50) throw fail('Außentemperatur: Wert von -40 bis 50 °C'); return outdoorCheck(c); }
    // Nur wenn eine andere Regel heute schon ausgeführt wurde (z. B. „Aus“ nur nach „Ein“)
    if (c.type === 'firedToday') { only(c, ['type', 'ruleId'], 'Bedingung'); if (typeof c.ruleId !== 'string' || !RULE_ID.test(c.ruleId)) throw fail('Bedingung: Regel wählen'); return { type: 'firedToday', ruleId: c.ruleId }; }
    throw fail('Bedingung ungültig');
  });
  if (!Array.isArray(p.actions) || !p.actions.length || p.actions.length > LIMITS.actions) throw fail('1 bis ' + LIMITS.actions + ' Aktionen („Dann“) angeben');
  rule.actions = p.actions.map(a => {
    if (!isObject(a)) throw fail('Aktion ungültig');
    const out = { type: a.type, address: address(a.address) };
    if (a.type === 'switch') { only(a, ['type', 'address', 'on', 'delay', 'duration'], 'Aktion'); if (typeof a.on !== 'boolean') throw fail('Ein oder Aus wählen'); out.on = a.on; }
    else if (a.type === 'toggle') only(a, ['type', 'address', 'delay'], 'Aktion'); // umschalten: an → aus, aus → an
    else if (a.type === 'dimmer') { only(a, ['type', 'address', 'percent', 'delay', 'duration'], 'Aktion'); out.percent = integer(a.percent, 0, 100, 'Helligkeit in Prozent'); }
    else if (a.type === 'thermostat') { only(a, ['type', 'address', 'temperature', 'delay'], 'Aktion'); if (typeof a.temperature !== 'number' || !Number.isFinite(a.temperature) || a.temperature < 5 || a.temperature > 30 || Math.abs(a.temperature * 2 - Math.round(a.temperature * 2)) > 1e-8) throw fail('Temperatur: 5 bis 30 °C in 0,5-Schritten'); out.temperature = a.temperature; }
    else throw fail('Aktion ungültig');
    if (a.delay !== undefined && a.delay !== 0) out.delay = integer(a.delay, 1, LIMITS.delay, 'Verzögerung in Sekunden');
    if (a.duration !== undefined && a.duration !== 0) {
      if (a.type === 'thermostat' || (a.type === 'switch' && !a.on) || (a.type === 'dimmer' && a.percent === 0)) throw fail('„Für eine bestimmte Zeit“ gibt es nur beim Einschalten');
      out.duration = integer(a.duration, 1, LIMITS.duration, 'Dauer in Sekunden');
    }
    return out;
  });
  if (p.problem !== undefined) { if (typeof p.problem !== 'string' || p.problem.length > 200 || /[\x00-\x1f\x7f]/.test(p.problem)) throw fail('Hinweis ungültig'); if (p.problem) rule.problem = p.problem; }
  return rule;
}
function validateBackup(x) {
  if (!isObject(x) || Object.keys(x).some(k => !['paused', 'rules'].includes(k)) || (x.paused !== undefined && typeof x.paused !== 'boolean') || !Array.isArray(x.rules) || x.rules.length > LIMITS.rules) throw fail('Ungültige Automationen in der Sicherung');
  const ids = new Set();
  const rules = x.rules.map(r => { const n = normalizeRule(r); if (!n.id || ids.has(n.id)) throw fail('Ungültige Automationen in der Sicherung'); ids.add(n.id); return n; });
  return { paused: x.paused === true, rules };
}
// Für die Sicherung: nur gültige Regeln, ohne Laufzeitdaten.
function captureBackup(config) {
  const c = config?.automations, rules = [];
  if (isObject(c) && Array.isArray(c.rules)) for (const r of c.rules.slice(0, LIMITS.rules)) { try { const n = normalizeRule(r); if (n.id && !rules.some(x => x.id === n.id)) rules.push(n); } catch {} }
  return { paused: isObject(c) && c.paused === true, rules };
}
function stored(web) {
  const c = web.security.configSnapshot.read().automations;
  const rules = [];
  if (isObject(c) && Array.isArray(c.rules)) for (const r of c.rules.slice(0, LIMITS.rules)) { try { const n = normalizeRule(r); if (n.id) rules.push(n); } catch {} }
  return { paused: isObject(c) && c.paused === true, rules, ref: c };
}

// ---------- Auswahllisten für den Assistenten ----------
function displayName(rows, address, channel) {
  const row = rows.get(address); if (row?.name) return row.name;
  if (channel?.name && channel.name !== address && !channel.name.includes(address)) return channel.name;
  return (channel?.type || 'Kanal') + ' ' + address;
}
async function catalog(web) {
  const connector = ports.connector(web), channels = connector?.getChannels?.() || new Map();
  const rows = new Map(ports.rows(web).map(r => [r.address, r]));
  const sources = [];
  outer: for (const [addr, channel] of channels) {
    if (typeof addr !== 'string' || !ADDRESS.test(addr)) continue;
    for (const info of sourcesOf(addr, channel)) {
      sources.push({ address: addr, name: displayName(rows, addr, channel), room: rows.get(addr)?.room || channel.room || '', ...info });
      if (sources.length >= LIMITS.sources) break outer;
    }
  }
  const targets = [], list = [...ports.mapped(web).keys()].filter(a => ADDRESS.test(a));
  for (let i = 0; i < list.length; i += 16) await Promise.all(list.slice(i, i + 16).map(async addr => {
    let cap = null; try { cap = await ports.capabilities(web, addr); } catch {}
    if (!cap || !(cap.switch || cap.dimmer || cap.thermostat)) return;
    targets.push({ address: addr, name: displayName(rows, addr, channels.get(addr)), room: rows.get(addr)?.room || channels.get(addr)?.room || '', switch: cap.switch === true, dimmer: cap.dimmer === true, thermostat: cap.thermostat || null });
  }));
  for (const x of extraList(web)) {
    try { for (const s of x.sources()) if (ADDRESS.test(s.address) && sources.length < LIMITS.sources) sources.push(s); } catch { }
    try { for (const t of x.targets()) if (ADDRESS.test(t.address)) targets.push(t); } catch { }
  }
  const byName = (a, b) => (a.room || '￿').localeCompare(b.room || '￿', 'de') || a.name.localeCompare(b.name, 'de') || a.address.localeCompare(b.address);
  return { sources: sources.sort(byName), targets: targets.sort(byName), days: DAY_NAMES, limits: LIMITS };
}
// Prüfung gegen die tatsächlich vorhandenen Geräte (beim Speichern).
async function checkAgainstDevices(web, rule) {
  const channels = ports.connector(web)?.getChannels?.() || new Map();
  const test = (t, what) => {
    const info = sourcesFor(web, channels, t.address).find(x => x.key === t.key);
    const fits = info && (info.kind === 'event' ? t.op === 'event' : info.kind === 'number' ? ['above', 'below'].includes(t.op) : ['on', 'off'].includes(t.op));
    if (!fits) throw fail(what + ': Dieses Gerät liefert die gewählte Rückmeldung nicht (mehr).', 409);
  };
  if (rule.trigger.type === 'device') test(rule.trigger, 'Auslöser');
  for (const c of rule.conditions) if (c.type === 'device') test(c, 'Bedingung');
  for (const a of rule.actions) {
    let cap = null; try { cap = await capabilitiesFor(web, a.address); } catch {}
    if (!cap) throw fail('Aktion: Gerät nicht gefunden.', 409);
    if ((a.type === 'switch' || a.type === 'toggle') && !cap.switch) throw fail('Aktion: Dieses Gerät lässt sich nicht ein-/ausschalten.', 409);
    if (a.type === 'dimmer' && !cap.dimmer) throw fail('Aktion: Dieses Gerät lässt sich nicht dimmen.', 409);
    if (a.type === 'thermostat') { if (!cap.thermostat) throw fail('Aktion: Dieses Gerät ist kein einstellbares Thermostat.', 409); if (a.temperature < cap.thermostat.min || a.temperature > cap.thermostat.max) throw fail(`Aktion: Temperatur ${cap.thermostat.min} bis ${cap.thermostat.max} °C.`, 409); }
  }
}

// ---------- Sonnenzeiten ----------
// Sonnenauf- und -untergang kommen von der CCU selbst (Standort in der Systemsteuerung); Antwort z. B. „07:48:00 11.10.2026|18:42:00 11.10.2026“.
const SCRIPT_SUN = '! MH_AUTO_SUN\nWrite(system.SunriseTime() # "|" # system.SunsetTime());';
function parseSun(text) {
  const m = /^(\d\d):(\d\d):\d\d \d\d\.\d\d\.\d{4}\|(\d\d):(\d\d):\d\d \d\d\.\d\d\.\d{4}$/.exec(String(text || '').trim());
  if (!m) return null;
  const rise = +m[1] * 60 + +m[2], set = +m[3] * 60 + +m[4];
  if (rise >= set || rise > 24 * 60 || set > 24 * 60) return null;
  return { rise, set };
}
const hhmm = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

// ---------- Ablauf ----------
class Engine {
  constructor(web, options = {}) {
    this.web = web; this.now = options.now || Date.now;
    this.graceMs = options.graceMs ?? 120000; this.tickMs = options.tickMs ?? 1000;
    this.file = path.join(path.dirname(web.deps.configPath), 'automationen-state.json');
    this.connector = null; this.listener = null; this.reconnected = null; this.graceUntil = Infinity;
    this.baseline = new Map(); this.rules = []; this.paused = false; this.ref = undefined;
    this.fired = new Map(); this.pending = []; this.queue = Promise.resolve(); this.queued = 0;
    this.dirty = false; this.lastSave = 0; this.timer = null; this.error = null;
    this.extraSubs = new Map(); this.extraGraceUntil = this.now() + this.graceMs;
    this.sun = null; this.sunTried = 0; this.sunBusy = false;
    this.state = this.load();
  }
  load() {
    const state = { minutes: {}, pendingOff: [], log: [], stats: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (isObject(raw.minutes)) for (const [id, v] of Object.entries(raw.minutes)) if (RULE_ID.test(id) && typeof v === 'string' && v.length <= 20) state.minutes[id] = v;
      if (Array.isArray(raw.pendingOff)) for (const p of raw.pendingOff.slice(0, 200)) if (isObject(p) && ADDRESS.test(p.address || '') && ['switch', 'dimmer'].includes(p.type) && Number.isFinite(p.at)) state.pendingOff.push({ at: p.at, address: p.address, type: p.type, ruleId: RULE_ID.test(p.ruleId || '') ? p.ruleId : '', name: typeof p.name === 'string' ? p.name.slice(0, LIMITS.name) : '', tries: 0 });
      if (Array.isArray(raw.log)) state.log = raw.log.filter(isObject).slice(-LIMITS.log);
      if (isObject(raw.stats)) for (const [id, v] of Object.entries(raw.stats)) if (RULE_ID.test(id) && isObject(v)) state.stats[id] = { lastRun: typeof v.lastRun === 'string' ? v.lastRun : null, lastResult: typeof v.lastResult === 'string' ? v.lastResult.slice(0, 200) : '', count: Number.isSafeInteger(v.count) ? v.count : 0 };
    } catch {}
    return state;
  }
  save() {
    this.lastSave = this.now(); this.dirty = false;
    try { require('./durable-storage').atomicJson(this.file, this.state); } catch { this.error = 'Verlauf der Automationen konnte nicht gespeichert werden'; }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs); this.timer.unref?.();
    this.tick();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.attach(null); for (const off of this.extraSubs.values()) { try { off?.(); } catch {} } this.extraSubs.clear(); if (this.dirty) this.save(); }
  // Weitere Geräte melden Änderungen selbst; für sie zählt die Schonfrist ab dem Start der Automationen.
  attachExtras() {
    for (const x of extraList(this.web)) {
      if (this.extraSubs.has(x) || typeof x.subscribe !== 'function') continue;
      let off = null;
      try { off = x.subscribe(event => { try { if (event && x.owns(event.address)) this.onEvent(event); } catch (e) { this.error = e.message; } }); } catch {}
      this.extraSubs.set(x, off);
    }
  }
  attach(connector) {
    if (this.connector && this.listener) { try { this.connector.off('deviceEvent', this.listener); this.connector.off('connected', this.reconnected); this.connector.off('interfaceReconnected', this.reconnected); } catch {} }
    this.connector = connector || null; this.baseline.clear(); this.listener = null; this.reconnected = null; this.graceUntil = Infinity;
    if (!connector || typeof connector.on !== 'function') return;
    this.graceUntil = this.now() + this.graceMs;
    this.listener = event => { try { this.onEvent(event); } catch (e) { this.error = e.message; } };
    // Nach einem Neuaufbau der Funkverbindung melden Geräte ihren Zustand neu: wieder Schonfrist.
    this.reconnected = () => { this.graceUntil = Math.max(this.graceUntil, this.now() + this.graceMs); };
    connector.on('deviceEvent', this.listener); connector.on('connected', this.reconnected); connector.on('interfaceReconnected', this.reconnected);
    this.tap(connector);
  }
  // Die Bridge verwirft Funkmeldungen, zu denen die CCU keinen gespeicherten Wert kennt – das trifft
  // Tastendrücke. Diese eine Meldungsart wird hier mitgelesen und unverändert weitergereicht.
  tap(connector) {
    if (connector.mhAutomationTap) { connector.mhAutomationTap.engine = this; return; }
    const original = connector.handleEvent; if (typeof original !== 'function') return;
    const tap = { engine: this };
    connector.handleEvent = function (interfaceId, address, key, value) {
      try {
        if (value === true && (key === 'PRESS_SHORT' || key === 'PRESS_LONG') && typeof address === 'string') {
          const channel = this.getChannels?.().get(address), values = channel?.paramsets?.VALUES;
          if (channel && !VIRTUAL.test(address) && !(values && Object.hasOwn(values, key))) tap.engine?.listener?.({ address, key, value });
        }
      } catch {}
      return original.apply(this, arguments);
    };
    connector.mhAutomationTap = tap;
  }
  reload() {
    let s; try { s = stored(this.web); } catch { return; }
    if (s.ref !== undefined && s.ref === this.ref) return;
    this.ref = s.ref; this.rules = s.rules; this.paused = s.paused;
    const ids = new Set(s.rules.map(r => r.id));
    for (const id of Object.keys(this.state.minutes)) if (!ids.has(id)) { delete this.state.minutes[id]; this.dirty = true; }
    for (const id of Object.keys(this.state.stats)) if (!ids.has(id)) { delete this.state.stats[id]; this.dirty = true; }
  }
  // Tasten melden ihren Druck nur, wenn die Zentrale sie als „benutzt“ kennt (Zentralenverknüpfung). Früher erledigten das
  // CCU-Programme; ohne sie verstummen Taster. Deshalb meldet die Bridge jede Taste, die eine Automation auslöst, selbst –
  // wie ReGa (reportValueUsage). Einmal je Taste und Start; Batteriegeräte übernehmen es beim nächsten Tastendruck.
  reportUsage() {
    const c = this.connector; if (!c || typeof c.rpcCall !== 'function') return;
    this.reported ||= new Set();
    for (const rule of this.rules) {
      const t = rule.trigger;
      if (t.type !== 'device' || !['PRESS_SHORT', 'PRESS_LONG'].includes(t.key) || extraFor(this.web, t.address)) continue;
      const k = t.address + '|' + t.key; if (this.reported.has(k)) continue;
      const iface = c.getChannels?.().get(t.address)?.interface; if (!['HmIP-RF', 'BidCos-RF'].includes(iface)) continue;
      this.reported.add(k);
      Promise.resolve().then(() => c.rpcCall(iface, 'reportValueUsage', [t.address, t.key, 1])).catch(() => { this.reported.delete(k); });
    }
  }
  value(addr, key) { const x = extraFor(this.web, addr); if (x) { try { return x.value(addr, key); } catch { return undefined; } } return this.connector?.getChannels?.().get(addr)?.paramsets?.VALUES?.[key]; }
  seed() {
    for (const rule of this.rules) {
      if (rule.trigger.type !== 'device') continue;
      const k = rule.trigger.address + '|' + rule.trigger.key;
      if (this.baseline.has(k)) continue;
      const v = this.value(rule.trigger.address, rule.trigger.key);
      if (v !== undefined) this.baseline.set(k, v);
    }
  }
  tick() {
    try {
      const connector = ports.connector(this.web);
      if (connector !== this.connector) this.attach(connector);
      this.attachExtras();
      this.reload(); this.seed(); this.reportUsage();
      const now = this.now();
      this.refreshSun(now); this.refreshDuty(now);
      if (!this.paused) this.checkTimes(now);
      this.runDue(now);
      if (this.dirty && now - this.lastSave >= 5000) this.save();
      this.error = null;
    } catch (e) { this.error = e.message; }
  }
  // Funk-Auslastung (Duty Cycle) der Zentrale jede Minute lesen. Bei 100 % sendet die CCU nichts mehr – daher früh bremsen
  // und einmal per WhatsApp warnen (erneut erst, wenn der Wert zwischendurch unter 60 % war).
  refreshDuty(now) {
    const c = this.connector; if (!c || typeof c.rpcCall !== 'function' || this.dutyBusy || now - (this.dutyAt || 0) < 60000) return;
    this.dutyBusy = true; this.dutyAt = now;
    Promise.resolve().then(() => c.rpcCall('BidCos-RF', 'listBidcosInterfaces', [])).then(list => {
      const v = Math.max(...(Array.isArray(list) ? list : []).map(x => Number(x?.DUTY_CYCLE)).filter(Number.isFinite));
      if (!Number.isFinite(v)) return;
      this.duty = v;
      if (v < 60) this.dutyWarned = false;
      else if (v >= DUTY_WARN && !this.dutyWarned) {
        this.dutyWarned = true;
        const m = this.web?.security?.monitor;
        if (m && typeof m.send === 'function') Promise.resolve().then(() => m.send('CCU3 · Funk ausgelastet\nDuty Cycle ' + v + ' %. Bei 100 % reagiert die Zentrale nicht mehr.\nAutomatisches Einschalten (Bewegung, Zeit) wird ab ' + DUTY_HOLD + ' % zurückgehalten; Tasten und Ausschalten gehen weiter.')).catch(() => {});
        this.record({ ruleId: '', name: 'Funk-Schutz', cause: 'Duty Cycle ' + v + ' %', text: 'Warnung: Funk stark ausgelastet', ok: false, error: 'Bitte vorerst wenig schalten' });
      }
    }).catch(() => {}).finally(() => { this.dutyBusy = false; });
  }
  inGrace(address) { return this.now() < (address !== undefined && extraFor(this.web, address) ? this.extraGraceUntil : this.graceUntil); }
  onEvent(event) {
    if (!event || typeof event.address !== 'string' || typeof event.key !== 'string' || !Object.hasOwn(KEYS, event.key)) return;
    const k = event.address + '|' + event.key, known = this.baseline.has(k), previous = this.baseline.get(k);
    if (KEYS[event.key].kind !== 'event') this.baseline.set(k, event.value);
    const grace = this.inGrace(event.address);
    for (const rule of this.rules) {
      const t = rule.trigger;
      if (!rule.enabled || t.type !== 'device' || t.address !== event.address || t.key !== event.key) continue;
      // Diagnose: jede Meldung des Auslöse-Geräts mit Ergebnis festhalten (hilft, wenn eine Regel „nichts tut“).
      if (grace || this.paused) { this.trace(event, grace ? 'Schonfrist nach dem Start' : 'Automationen pausiert'); continue; }
      let hit = false;
      if (t.op === 'event') hit = event.value === true;
      else if (!known) hit = false; // ohne bekannten Ausgangszustand nie auslösen
      else if (t.op === 'on' || t.op === 'off') { const was = boolish(previous), is = boolish(event.value); hit = was !== undefined && is !== undefined && (t.op === 'on' ? !was && is : was && !is); }
      else if (typeof previous === 'number' && typeof event.value === 'number') { const s = KEYS[t.key].scale || 1, was = previous * s, is = event.value * s; hit = t.op === 'above' ? was <= t.value && is > t.value : was >= t.value && is < t.value; }
      this.trace(event, hit ? 'löst „' + rule.name + '“ aus' : !known ? 'Ausgangszustand unbekannt' : 'kein passender Wechsel (vorher ' + JSON.stringify(previous) + ')');
      if (hit) this.fire(rule, this.causeText(rule));
    }
  }
  trace(event, result) {
    const list = this.state.trace ||= [];
    list.push({ at: new Date(this.now()).toISOString(), address: event.address, key: event.key, value: typeof event.value === 'boolean' || typeof event.value === 'number' ? event.value : String(event.value).slice(0, 20), result: String(result).slice(0, 120) });
    if (list.length > 20) list.splice(0, list.length - 20);
    this.dirty = true;
  }
  causeText(rule) {
    const t = rule.trigger;
    if (t.type === 'time') return 'Uhrzeit ' + t.time + (t.everyDays ? ' (alle ' + t.everyDays + ' Tage)' : '');
    const extra = extraFor(this.web, t.address), channel = this.connector?.getChannels?.().get(t.address);
    let info = null; try { info = extra ? (extra.sources(t.address) || []).find(s => s.key === t.key) || null : sourceInfo(channel || {}, t.key, this.value(t.address, t.key)); } catch {}
    const name = this.nameOf(t.address);
    if (t.op === 'above' || t.op === 'below') return `${name}: ${info?.title || t.key} ${t.op === 'above' ? 'über' : 'unter'} ${t.value}${info?.unit ? ' ' + info.unit : ''}`;
    const def = extra && info?.on ? info : KEYS[t.key].on ? KEYS[t.key] : stateTexts(channel?.type);
    return `${name}: ${t.op === 'off' ? def.off : def.on}`;
  }
  nameOf(addr) {
    const x = extraFor(this.web, addr); if (x) { try { return x.name(addr); } catch { return addr; } }
    const rows = new Map(ports.rows(this.web).map(r => [r.address, r])); return displayName(rows, addr, this.connector?.getChannels?.().get(addr));
  }
  // Nur abfragen, wenn eine Regel die Sonne braucht: einmal je Tag (bei Fehler höchstens alle 10 Minuten).
  refreshSun(now) {
    if (!this.rules.some(r => r.conditions.some(c => c.type === 'sun'))) return;
    const day = new Date(now).toDateString();
    if (this.sun && this.sun.day === day) return;
    // Sonnenzeiten selbst aus dem Standort (Zeit & Standort) berechnen; ReGa nur als Rückfall ohne Standort.
    try { const own = require('./zeit-standort').sunMinutes(this.web, now); if (own) { this.sun = { ...own, day }; return; } } catch {}
    if (this.sunBusy || !this.connector || typeof this.connector.regaScript !== 'function') return;
    if (now - this.sunTried < 600000) return;
    this.sunTried = now; this.sunBusy = true;
    Promise.resolve().then(() => this.connector.regaScript(SCRIPT_SUN, 8181)).then(raw => { const s = parseSun(raw); if (s) this.sun = { ...s, day }; }, () => {}).finally(() => { this.sunBusy = false; });
  }
  checkTimes(now) {
    const d = new Date(now), hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${hhmm}`;
    for (const rule of this.rules) {
      const t = rule.trigger;
      if (!rule.enabled || t.type !== 'time' || t.time !== hhmm || !t.days.includes(d.getDay()) || this.state.minutes[rule.id] === key) continue;
      if (t.everyDays) { const s = new Date(t.startDate + 'T00:00:00'), diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - s) / 86400000); if (diff < 0 || diff % t.everyDays !== 0) continue; }
      this.state.minutes[rule.id] = key; this.dirty = true;
      this.fire(rule, this.causeText(rule));
    }
  }
  conditionsMet(rule, now) {
    for (const c of rule.conditions) {
      if (c.type === 'time') {
        const d = new Date(now), cur = d.getHours() * 60 + d.getMinutes(), m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
        const from = m(c.from), to = m(c.to);
        if (from === to) continue;
        if (!(from < to ? cur >= from && cur < to : cur >= from || cur < to)) return false;
      } else if (c.type === 'sun') {
        // Ohne Sonnenzeiten nicht auslösen (lieber einmal nichts als zur falschen Zeit).
        if (!this.sun) return false;
        const d = new Date(now), cur = d.getHours() * 60 + d.getMinutes(), dark = cur >= this.sun.set || cur < this.sun.rise;
        if (dark !== (c.when === 'dark')) return false;
      } else if (c.type === 'outdoor') {
        // Ohne frischen Wetterwert (höchstens 3 Stunden alt) nicht auslösen. Mit Uhrzeit: Vorhersage für diese Uhrzeit (Open-Meteo,
        // stündlich, dazwischen gemittelt); fehlt sie, gilt die aktuelle Temperatur.
        let w = null; try { w = require('./wetter').wetter(this.web).fresh(); } catch {}
        const t = c.at ? forecastAt(this.web, c.at, now) ?? (w && typeof w.temperature === 'number' ? w.temperature : null) : w && typeof w.temperature === 'number' ? w.temperature : null;
        if (t === null || !(c.op === 'above' ? t > c.value : t < c.value)) return false;
      } else if (c.type === 'firedToday') {
        const last = this.state.stats[c.ruleId]?.lastRun;
        if (!last || new Date(last).toDateString() !== new Date(now).toDateString()) return false;
      } else {
        const v = this.value(c.address, c.key);
        if (c.op === 'on' || c.op === 'off') { const b = boolish(v); if (b === undefined || b !== (c.op === 'on')) return false; }
        else { if (typeof v !== 'number' || !Number.isFinite(v)) return false; const s = v * (KEYS[c.key].scale || 1); if (!(c.op === 'above' ? s > c.value : s < c.value)) return false; }
      }
    }
    return true;
  }
  fire(rule, cause, manual = false) {
    const now = this.now();
    if (!manual) {
      const list = (this.fired.get(rule.id) || []).filter(t => now - t < 600000);
      if (list.length && now - list.at(-1) < 1000) return false; // Prellschutz
      if (list.length >= 30) { this.autoPause(rule, 'Automatisch angehalten: in 10 Minuten mehr als 30-mal ausgelöst.'); return false; }
      list.push(now); this.fired.set(rule.id, list);
      if (!this.conditionsMet(rule, now)) { this.stat(rule.id, 'Ausgelöst, Bedingung nicht erfüllt'); return false; }
    }
    // Erneutes Auslösen startet verzögerte Aktionen dieser Regel neu (Nachlaufzeit), statt sie zu stapeln.
    if (rule.actions.some(a => a.delay)) this.pending = this.pending.filter(p => p.rule.id !== rule.id);
    for (const action of rule.actions) {
      if (action.delay) { if (this.pending.length < 200) this.pending.push({ at: now + action.delay * 1000, rule: { id: rule.id, name: rule.name }, action, cause: cause + ' (verzögert)' }); }
      else this.enqueue({ id: rule.id, name: rule.name }, action, cause);
    }
    return true;
  }
  autoPause(rule, reason) {
    try {
      this.web.writeConfigPatch(c => { const r = c.automations?.rules?.find(x => x.id === rule.id); if (r) { r.enabled = false; r.problem = reason; } });
      this.ref = undefined; this.reload();
    } catch {}
    this.fired.delete(rule.id);
    this.record({ ruleId: rule.id, name: rule.name, cause: 'Schleifenschutz', text: reason, ok: false });
  }
  enqueue(rule, action, cause) {
    if (this.queued >= 100) { this.record({ ruleId: rule.id, name: rule.name, cause, text: this.describe(action), ok: false, error: 'Warteschlange voll; Aktion verworfen' }); return; }
    this.queued++;
    this.queue = this.queue.then(() => this.execute(rule, action, cause)).catch(() => {}).finally(() => { this.queued--; });
  }
  describe(action) {
    const name = this.nameOf(action.address);
    const dur = action.duration ? ` für ${formatSeconds(action.duration)}` : '';
    if (action.type === 'switch') return `${name} ${action.on ? 'einschalten' : 'ausschalten'}${dur}`;
    if (action.type === 'dimmer') return action.percent === 0 ? `${name} ausschalten` : `${name} auf ${action.percent} %${dur}`;
    return `${name} auf ${String(action.temperature).replace('.', ',')} °C`;
  }
  async run(action) {
    const extra = extraFor(this.web, action.address);
    if (extra) return action.type === 'switch' ? extra.switch(action.address, action.on) : action.type === 'dimmer' ? extra.dimmer(action.address, action.percent) : extra.thermostat(action.address, action.temperature);
    if (!ports.ready(this.web)) throw fail('CCU nicht verbunden', 503);
    if (action.type === 'switch') return ports.switch(this.web, action.address, action.on);
    if (action.type === 'dimmer') return ports.dimmer(this.web, action.address, action.percent);
    return ports.thermostat(this.web, action.address, action.temperature);
  }
  async execute(rule, action, cause) {
    // Umschalten: erst beim Ausführen den aktuellen Zustand lesen; unbekannt → lieber nichts tun.
    if (action.type === 'toggle') {
      const cur = boolish(this.value(action.address, 'STATE'));
      if (cur === undefined) { const e = { ruleId: rule.id, name: rule.name, cause, text: this.nameOf(action.address) + ' umschalten', ok: false, error: 'Zustand unbekannt – nicht umgeschaltet' }; this.record(e); return e; }
      action = { type: 'switch', address: action.address, on: !cur };
    }
    const entry = { ruleId: rule.id, name: rule.name, cause, text: this.describe(action), ok: false };
    try {
      // Funk-Schutz: bei hoher Auslastung kein automatisches Einschalten (Bewegung, Zeit, Zustände); Tasten und „Aus“ gehen weiter.
      const radio = action.type !== 'thermostat' && !extraFor(this.web, action.address), wantsOn = action.type === 'switch' ? action.on : action.type === 'dimmer' && action.percent > 0;
      const byKey = /^PRESS_/.test(this.rules.find(r => r.id === rule.id)?.trigger?.key || '');
      if (radio && wantsOn && !byKey && this.duty >= DUTY_HOLD) { entry.error = 'Funk ausgelastet (Duty Cycle ' + this.duty + ' %) – nicht gesendet'; this.record(entry); return entry; }
      const r = await this.run(action);
      entry.ok = true; entry.confirmed = r?.confirmed === true;
      const on = action.type === 'switch' ? action.on : action.type === 'dimmer' ? action.percent > 0 : null;
      if (on !== null) {
        this.state.pendingOff = this.state.pendingOff.filter(p => p.address !== action.address);
        if (on && action.duration) this.state.pendingOff.push({ at: this.now() + action.duration * 1000, address: action.address, type: action.type, ruleId: rule.id, name: rule.name, tries: 0 });
      }
    } catch (e) { entry.error = e.status ? e.message : 'Befehl nicht bestätigt: ' + e.message; }
    this.record(entry);
    return entry;
  }
  runDue(now) {
    if (this.pending.length) {
      const due = this.pending.filter(p => p.at <= now); this.pending = this.pending.filter(p => p.at > now);
      // Verzögertes Einschalten verfällt, wenn inzwischen alles pausiert wurde.
      for (const p of due) if (!this.paused) this.enqueue(p.rule, p.action, p.cause);
    }
    if (!this.state.pendingOff.some(p => p.at <= now)) return;
    // Funkgeräte warten auf die CCU-Verbindung; weitere Geräte (WLAN) sind davon unabhängig.
    const ccuReady = !!this.connector && ports.ready(this.web), can = p => p.at <= now && (ccuReady || !!extraFor(this.web, p.address));
    const due = this.state.pendingOff.filter(can); if (!due.length) return;
    this.state.pendingOff = this.state.pendingOff.filter(p => !can(p)); this.dirty = true;
    for (const p of due) {
      const action = p.type === 'dimmer' ? { type: 'dimmer', address: p.address, percent: 0 } : { type: 'switch', address: p.address, on: false };
      this.queued++;
      this.queue = this.queue.then(async () => {
        // Hat inzwischen eine andere Aktion dieses Gerät übernommen, entfällt das Ausschalten.
        if (this.state.pendingOff.some(x => x.address === p.address)) return;
        const entry = { ruleId: p.ruleId, name: p.name, cause: 'Zeit abgelaufen', text: this.describe(action), ok: false };
        try { const r = await this.run(action); entry.ok = true; entry.confirmed = r?.confirmed === true; }
        catch (e) {
          entry.error = e.status ? e.message : 'Befehl nicht bestätigt: ' + e.message;
          // „Aus“ darf nachgeholt werden (kann nichts doppelt schalten), höchstens dreimal.
          if ((p.tries || 0) < 2) { this.state.pendingOff.push({ ...p, at: this.now() + 30000, tries: (p.tries || 0) + 1 }); entry.error += ' – wird in 30 Sekunden erneut versucht'; }
        }
        this.record(entry);
      }).catch(() => {}).finally(() => { this.queued--; });
    }
  }
  stat(id, result, run = false) {
    if (!id) return;
    const s = this.state.stats[id] ||= { lastRun: null, lastResult: '', count: 0 };
    s.lastResult = result; if (run) { s.lastRun = new Date(this.now()).toISOString(); s.count++; }
    this.dirty = true;
  }
  record(entry) {
    entry.at = new Date(this.now()).toISOString();
    this.state.log.push(entry); if (this.state.log.length > LIMITS.log) this.state.log.splice(0, this.state.log.length - LIMITS.log);
    this.stat(entry.ruleId, entry.ok ? (entry.confirmed ? 'Ausgeführt und bestätigt' : 'Ausgeführt, Rückmeldung steht aus') : 'Fehler: ' + (entry.error || entry.text), entry.cause !== 'Schleifenschutz');
    this.dirty = true;
  }
  status() {
    return { sun: this.sun ? { rise: hhmm(this.sun.rise), set: hhmm(this.sun.set) } : null, running: !!this.timer, connected: !!this.connector && ports.ready(this.web), graceSeconds: this.inGrace() && Number.isFinite(this.graceUntil) ? Math.ceil((this.graceUntil - this.now()) / 1000) : 0, waiting: this.pending.length, pendingOff: this.state.pendingOff.map(p => ({ address: p.address, name: this.nameOf(p.address), at: new Date(p.at).toISOString() })), dutyCycle: Number.isFinite(this.duty) ? this.duty : null, error: this.error };
  }
}
function formatSeconds(s) { if (s % 3600 === 0) return s / 3600 + (s === 3600 ? ' Stunde' : ' Stunden'); if (s % 60 === 0) return s / 60 + (s === 60 ? ' Minute' : ' Minuten'); return s + ' Sekunden'; }

const engines = new WeakMap();
function engine(web, options) { let e = engines.get(web); if (!e) { e = new Engine(web, options); engines.set(web, e); } return e; }
function start(web, options) {
  const e = engine(web, options); e.start();
  // Entfeuchter-Steuerung läuft mit den Automationen (eigener Baustein, standardmäßig aus).
  if (!options) try { require('./entfeuchter').start(web); } catch { console.error('[entfeuchter] Start fehlgeschlagen (Details ausgelassen)'); }
  if (!options) try { require('./batterie-waechter').start(web); } catch { console.error('[batterie] Start fehlgeschlagen (Details ausgelassen)'); }
  // Suchpfad mit /sbin und /usr/sbin für alle Programme, die die Bridge startet (12.10.2026: Die Bridge läuft mit PATH ohne /sbin;
  // dadurch fehlten mount.cifs, iptables, ip, hwclock, reboot … – die WD ließ sich nie einbinden).
  if (!options) { const p = (process.env.PATH || '/usr/bin:/bin').split(':'); for (const d of ['/usr/sbin', '/sbin']) if (!p.includes(d)) p.unshift(d); process.env.PATH = p.join(':'); }
  if (!options) try { require('./jeep-fernsteuerung').attach(web); } catch {} // Jeep-Türschloss aus Apple Home (jeep-schloss.js)
  if (!options) try { require('./ccu-sicherung').start(web); } catch {} // Sicherungen auf die WD auslagern (alle 6 Stunden)
  if (!options) try { require('./jeep-laden').start(web); } catch { console.error('[jeep-laden] Start fehlgeschlagen (Details ausgelassen)'); }
  if (!options) try { require('./tasmota-wache').start(web); } catch { console.error('[tasmota-wache] Start fehlgeschlagen (Details ausgelassen)'); }
  if (!options) try { require('./dyson-adresse').start(web); } catch { console.error('[dyson-adresse] Start fehlgeschlagen (Details ausgelassen)'); }
  if (!options) try { require('./wetter').start(web); } catch { console.error('[wetter] Start fehlgeschlagen (Details ausgelassen)'); }
  if (!options) try { require('./raeume').start(web); } catch { console.error('[raeume] Start fehlgeschlagen (Details ausgelassen)'); }
  return e;
}

// ---------- Schnittstelle ----------
function publicRules(web, e) {
  const channels = ports.connector(web)?.getChannels?.() || new Map(), mapped = ports.mapped(web);
  return e.rules.map(rule => {
    let missing = null;
    const has = (addr, known) => { const x = extraFor(web, addr); if (!x) return known.has(addr); try { return x.has(addr); } catch { return false; } };
    const need = addr => { if (!has(addr, channels) && !missing) missing = 'Gerät ' + addr + ' ist nicht (mehr) vorhanden.'; };
    if (rule.trigger.type === 'device') need(rule.trigger.address);
    for (const c of rule.conditions) if (c.type === 'device') need(c.address);
    for (const a of rule.actions) if (!has(a.address, mapped) && !missing) missing = 'Gerät ' + a.address + ' ist nicht (mehr) vorhanden.';
    return { ...rule, status: { ...(e.state.stats[rule.id] || { lastRun: null, lastResult: '', count: 0 }), missing } };
  });
}
function overview(web, e) { e.ref = undefined; e.reload(); return { paused: e.paused, rules: publicRules(web, e), engine: e.status(), limits: LIMITS }; }
function writeRules(web, change) {
  web.writeConfigPatch(c => {
    const current = isObject(c.automations) ? c.automations : {};
    const next = { paused: current.paused === true, rules: Array.isArray(current.rules) ? current.rules : [] };
    change(next); c.automations = next;
  });
}
const POST = {
  async saveAutomation(web, e, p) {
    only(p, ['rule'], 'Anfrage');
    const rule = normalizeRule(p.rule); delete rule.problem;
    await checkAgainstDevices(web, rule);
    const existing = stored(web).rules;
    if (rule.id && !existing.some(r => r.id === rule.id)) throw fail('Automation nicht gefunden', 404);
    if (!rule.id) { if (existing.length >= LIMITS.rules) throw fail('Höchstens ' + LIMITS.rules + ' Automationen'); rule.id = crypto.randomBytes(6).toString('hex'); }
    if (existing.some(r => r.id !== rule.id && r.name.toLowerCase() === rule.name.toLowerCase())) throw fail('Eine Automation mit diesem Namen gibt es schon');
    writeRules(web, next => { const i = next.rules.findIndex(r => r.id === rule.id); if (i >= 0) next.rules[i] = rule; else next.rules.push(rule); });
    e.fired.delete(rule.id); e.baseline.delete(rule.trigger.type === 'device' ? rule.trigger.address + '|' + rule.trigger.key : '');
    return { success: true, rule, ...overview(web, e), message: 'Automation gespeichert.' };
  },
  async deleteAutomation(web, e, p) {
    only(p, ['id'], 'Anfrage'); if (typeof p.id !== 'string' || !RULE_ID.test(p.id)) throw fail('Kennung ungültig');
    if (!stored(web).rules.some(r => r.id === p.id)) throw fail('Automation nicht gefunden', 404);
    writeRules(web, next => { next.rules = next.rules.filter(r => r.id !== p.id); });
    e.pending = e.pending.filter(x => x.rule.id !== p.id);
    return { success: true, ...overview(web, e), message: 'Automation gelöscht.' };
  },
  async setAutomationEnabled(web, e, p) {
    only(p, ['id', 'enabled'], 'Anfrage'); if (typeof p.id !== 'string' || !RULE_ID.test(p.id) || typeof p.enabled !== 'boolean') throw fail('Angaben ungültig');
    if (!stored(web).rules.some(r => r.id === p.id)) throw fail('Automation nicht gefunden', 404);
    writeRules(web, next => { const r = next.rules.find(x => x.id === p.id); r.enabled = p.enabled; delete r.problem; });
    e.fired.delete(p.id); if (!p.enabled) e.pending = e.pending.filter(x => x.rule.id !== p.id);
    return { success: true, ...overview(web, e), message: p.enabled ? 'Automation ist aktiv.' : 'Automation ist pausiert.' };
  },
  async setAutomationsPaused(web, e, p) {
    only(p, ['paused'], 'Anfrage'); if (typeof p.paused !== 'boolean') throw fail('Angaben ungültig');
    writeRules(web, next => { next.paused = p.paused; });
    if (p.paused) e.pending = [];
    return { success: true, ...overview(web, e), message: p.paused ? 'Alle Automationen sind pausiert.' : 'Automationen laufen wieder.' };
  },
  async runAutomation(web, e, p) {
    only(p, ['id'], 'Anfrage'); if (typeof p.id !== 'string' || !RULE_ID.test(p.id)) throw fail('Kennung ungültig');
    e.ref = undefined; e.reload();
    const rule = e.rules.find(r => r.id === p.id); if (!rule) throw fail('Automation nicht gefunden', 404);
    if (e.queued > 0) throw fail('Es laufen noch Aktionen; bitte kurz warten', 429);
    const before = e.state.log.length ? e.state.log.at(-1) : null;
    e.fire(rule, 'Test von Hand', true);
    await e.queue;
    const at = before ? e.state.log.lastIndexOf(before) + 1 : 0;
    const steps = e.state.log.slice(at).filter(x => x.ruleId === rule.id && x.cause === 'Test von Hand');
    const delayed = rule.actions.filter(a => a.delay).length;
    const failed = steps.filter(s => !s.ok).length;
    return { success: failed === 0, steps, ...overview(web, e), message: (failed ? failed + ' Aktion(en) fehlgeschlagen.' : 'Test ausgeführt.') + (delayed ? ' ' + delayed + ' verzögerte Aktion(en) folgen.' : '') };
  }
};
async function handle(web, req, res, u, auth) {
  const method = u.searchParams.get('method');
  const gets = ['getAutomations', 'getAutomationCatalog', 'getAutomationLog'];
  if (!gets.includes(method) && !Object.hasOwn(POST, method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    const e = start(web);
    if (gets.includes(method)) {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      send(200, method === 'getAutomations' ? overview(web, e) : method === 'getAutomationCatalog' ? await catalog(web) : { log: e.state.log.slice().reverse() });
      return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const p = await require('./web-security').body(req);
    const result = await POST[method](web, e, p);
    e.save();
    send(200, result);
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Automationen: Anfrage fehlgeschlagen' }); }
  return true;
}
// Geprüfter Schaltweg (Fähigkeit prüfen, einmal senden, rücklesen) auch für andere Bausteine (z. B. entfeuchter.js).
// Für Entfeuchter, Jeep laden u. a.: Tasmota-Steckdosen und Jeep über ihren eigenen Weg, sonst CCU-Kanal
// (12.10.2026: vorher nur CCU – „Unbekannter oder nicht zugeordneter Kanal“ bei TASMOTA-…, Entfeuchter schaltete nicht)
const switchDevice = (web, address, on) => { const x = extraFor(web, address); return x ? x.switch(address, on) : ports.switch(web, address, on); };
module.exports = { handle, start, validateBackup, captureBackup, normalizeRule, checkAgainstDevices, switchDevice, boolish, KEYS, LIMITS, _test: { Engine, engine, parseSun, hhmm, SCRIPT_SUN, ports, catalog, stored, sourceInfo, sourcesOf, boolish, formatSeconds, setPorts: p => Object.assign(ports, p), reset: web => { engines.get(web)?.stop(); engines.delete(web); } } };
