'use strict';
// Automations-Assistent (Wunsch Thomas, 12.10.2026).
// Stufe 1 – immer verfügbar, offline: Vorschläge je Gerätetyp (Taster, Bewegungsmelder, Fensterkontakt, Fühler, Schalter).
// Stufe 2 – optional: freier Satz → KI (Google Gemini, kostenlose Stufe, eigener Schlüssel von Thomas) → Regelvorschlag.
// „Mauer“ um die KI: Sie bekommt nur Satz + Gerätenamen/-typen (Kurzzeichen statt Adressen), liefert nur einen
// Regelvorschlag im festen Format; der läuft durch dieselbe Regelprüfung wie eine Eingabe von Hand
// (normalizeRule + Prüfung gegen die Geräte). Es wird NIE gespeichert oder geschaltet – das macht erst Thomas mit „Übernehmen“.
// Höchstens 20 KI-Anfragen je Stunde; der Schlüssel liegt verschlüsselt auf der CCU und wird nie ausgegeben.
const path = require('path'), https = require('https');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
// Google-Schlüssel: „AIza…“ und neuere Formate mit Punkt; beim Einfügen mitkopierte Leerzeichen/Anführungszeichen werden entfernt
const KEY = /^[A-Za-z0-9._~+/=-]{20,200}$/, cleanKey = k => String(k).replace(/[​-‍﻿]/g, '').trim().replace(/^["'`„“”]+|["'`„“”]+$/g, '').trim(), MODEL = /^[a-z0-9.-]{3,40}$/;
const DEFAULTS = Object.freeze({ enabled: false, model: 'gemini-3.8-flash' }); // 12.10.2026: gemini-2.5-flash gibt es für neue Konten nicht mehr
const LIMIT_PER_HOUR = 20;
const vault = web => new (require('./smartplus').Vault)(path.join(path.dirname(web.deps.configPath), 'ki-schluessel.json'));
const readKey = web => { try { const s = vault(web).read(); return typeof s.key === 'string' && KEY.test(s.key) ? s.key : null; } catch { return null; } };
function settings(web) {
  let c = {}; try { c = web.security.configSnapshot.read().ki || {}; } catch {}
  return { enabled: c.enabled === true, model: typeof c.model === 'string' && MODEL.test(c.model) ? c.model : DEFAULTS.model };
}
const A = () => require('./automationen');
const devOf = a => String(a || '').split(':')[0];
const re = (s, x) => new RegExp(x, 'i').test(s || '');

// ---------- Stufe 1: Vorschläge je Gerät ----------
// Ziel-Vorschlag: zuerst gleiches Gerät/gleicher Raum, sonst leer (Thomas wählt).
function pickTarget(targets, room, prefer) {
  const inRoom = targets.filter(t => room && t.room === room);
  return (inRoom.find(t => prefer(t)) || inRoom[0] || null)?.address || '';
}
async function suggestions(web, device) {
  const cat = await A()._test.catalog(web);
  const sources = cat.sources.filter(s => devOf(s.address) === device);
  if (!sources.length) return { device, suggestions: [], note: 'Für dieses Gerät gibt es keine Auslöser (kein Taster/Fühler).' };
  const room = sources[0].room, name = sources[0].name.replace(/:\d+$/, '');
  const switches = cat.targets.filter(t => t.switch), thermos = cat.targets.filter(t => t.thermostat);
  const light = t => re(t.name, 'licht|lampe|leuchte');
  const out = [];
  const keys = sources.filter(s => s.key === 'PRESS_SHORT');
  if (keys.length) {
    const target = pickTarget(switches, room, light);
    out.push({ title: 'Taste schaltet ein Licht/eine Steckdose um', rules: keys.slice(0, 4).map((k, i) => ({ name: name + ' Taste ' + (i + 1), enabled: true, trigger: { type: 'device', address: k.address, key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'toggle', address: target }] })) });
    if (keys.length >= 2) out.push({ title: 'Obere Taste ein, untere Taste aus', rules: [
      { name: name + ' an', enabled: true, trigger: { type: 'device', address: keys[1].address, key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'switch', address: target, on: true }] },
      { name: name + ' aus', enabled: true, trigger: { type: 'device', address: keys[0].address, key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'switch', address: target, on: false }] }] });
  }
  const motion = sources.find(s => s.key === 'MOTION');
  if (motion) out.push({ title: 'Bewegung → Licht für 2 Minuten an (nur wenn dunkel)', rules: [{ name: name + ': Licht bei Bewegung', enabled: true, trigger: { type: 'device', address: motion.address, key: 'MOTION', op: 'on' }, conditions: [{ type: 'sun', when: 'dark' }], actions: [{ type: 'switch', address: pickTarget(switches, room, light), on: true, duration: 120 }] }] });
  const contact = sources.find(s => s.key === 'STATE' && re(s.title + ' ' + (s.on || ''), 'offen|geöffnet|open'));
  if (contact && thermos.length) out.push({ title: 'Fenster offen → Heizung im Raum auf 12 °C', rules: [{ name: name + ': Heizung runter bei offenem Fenster', enabled: true, trigger: { type: 'device', address: contact.address, key: 'STATE', op: 'on' }, conditions: [], actions: [{ type: 'thermostat', address: pickTarget(thermos, room, () => true), temperature: 12 }] }] });
  const hum = sources.find(s => s.key === 'HUMIDITY' || s.key === 'ACTUAL_HUMIDITY');
  if (hum) out.push({ title: 'Luftfeuchte über 65 % → Steckdose (z. B. Entfeuchter/Lüfter) an', rules: [{ name: name + ': Feuchte hoch', enabled: true, trigger: { type: 'device', address: hum.address, key: hum.key, op: 'above', value: 65 }, conditions: [], actions: [{ type: 'switch', address: pickTarget(switches, room, t => re(t.name, 'entfeucht|lüfter|luefter')), on: true }] }] });
  const temp = sources.find(s => s.key === 'ACTUAL_TEMPERATURE' || s.key === 'TEMPERATURE');
  if (temp && !hum) out.push({ title: 'Temperatur unter 5 °C → Steckdose an (Frostschutz)', rules: [{ name: name + ': Frostschutz', enabled: true, trigger: { type: 'device', address: temp.address, key: temp.key, op: 'below', value: 5 }, conditions: [], actions: [{ type: 'switch', address: pickTarget(switches, room, () => true), on: true }] }] });
  const sw = sources.find(s => s.key === 'STATE' && switches.some(t => t.address === s.address));
  if (sw) out.push({ title: 'Zeitplan: abends aus (22:30, jeden Tag)', rules: [{ name: name + ' abends aus', enabled: true, trigger: { type: 'time', time: '22:30', days: [0, 1, 2, 3, 4, 5, 6] }, conditions: [], actions: [{ type: 'switch', address: sw.address, on: false }] }] });
  return { device, name, room, suggestions: out };
}

// ---------- Stufe 2: KI hinter der Mauer ----------
const usage = new WeakMap();
function allow(web, now = Date.now()) { const l = (usage.get(web) || []).filter(t => now - t < 3600000); if (l.length >= LIMIT_PER_HOUR) return false; l.push(now); usage.set(web, l); return true; }
function post(url, body, key, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request(url, { method: 'POST', timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'x-goog-api-key': key } }, res => {
      let size = 0; const chunks = [];
      res.on('data', c => { size += c.length; if (size > 262144) { req.destroy(Error('Antwort zu groß')); return; } chunks.push(c); });
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); const c = res.statusCode; if (c !== 200) { reject(fail(c === 429 ? 'Kostenloses Kontingent der KI für jetzt aufgebraucht' : c === 400 || c === 403 ? 'KI-Schlüssel ungültig oder nicht freigeschaltet' : c === 503 ? 'Die KI ist gerade überlastet – bitte in ein paar Minuten nochmal' : 'KI antwortet nicht (' + c + ')', c === 429 || c === 503 ? c : 502)); return; } try { resolve(JSON.parse(text)); } catch { reject(fail('Ungültige Antwort der KI', 502)); } });
    });
    req.on('timeout', () => req.destroy(fail('KI antwortet nicht (Zeitüberschreitung)', 504))); req.on('error', e => reject(fail(e.message || 'Verbindung zur KI fehlgeschlagen', e.status === 504 ? 504 : 502))); req.end(data);
  });
}
// Google meldet bei Andrang 503 („high demand“) – einmal kurz warten und neu fragen, dann das kleinere, kostenlose Ausweichmodell.
// Zeitüberschreitung (504, großes Modell unter Last bis ~1 min) → gleich das Ausweichmodell (antwortet in wenigen Sekunden).
const FALLBACK = 'gemini-flash-lite-latest';
async function postRetry(send, url, body, key, wait = ms => new Promise(r => setTimeout(r, ms))) {
  const urls = [url, url, url.replace(/models\/[^:]+:/, 'models/' + FALLBACK + ':')];
  for (let i = 0; ; i++) { try { return await send(urls[i], body, key); } catch (e) { if (![503, 504].includes(e.status) || i >= 2) throw e; if (e.status === 504) i = 1; else if (!i) await wait(3000); } }
}
// Geräteliste für die KI: Kurzzeichen statt Adressen (die KI sieht keine Adresse), nur Name, Raum, Fähigkeit.
function aliases(cat) {
  const map = new Map(), lines = [], keys = new Map();
  for (const s of cat.sources) if (!keys.has(s.address)) keys.set(s.address, s.key);
  const add = (address, text) => { if (!map.has(address)) { const id = 'g' + (map.size + 1); map.set(address, id); } lines.push(map.get(address) + ': ' + text); };
  for (const s of cat.sources.slice(0, 400)) add(s.address, `Auslöser „${s.name}“ (${s.room || 'ohne Raum'}) – Rückmeldung ${s.key}${s.kind === 'number' ? ' (Zahl' + (s.unit ? ' in ' + s.unit : '') + ')' : s.kind === 'event' ? ' (Tastendruck)' : ' (an/aus)'}`);
  for (const t of cat.targets.slice(0, 300)) add(t.address, `Ziel „${t.name}“ (${t.room || 'ohne Raum'}) – kann ${[t.switch && 'schalten', t.dimmer && 'dimmen', t.thermostat && 'Solltemperatur'].filter(Boolean).join(', ')}`);
  const back = new Map([...map].map(([a, id]) => [id, a]));
  return { lines: [...new Set(lines)], back, keys };
}
const SCHEMA = { type: 'OBJECT', properties: { name: { type: 'STRING' }, trigger: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['device', 'time'] }, device: { type: 'STRING' }, key: { type: 'STRING' }, op: { type: 'STRING', enum: ['on', 'off', 'event', 'above', 'below'] }, value: { type: 'NUMBER' }, time: { type: 'STRING' }, days: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['type'] },
  conditions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['device', 'time', 'sun'] }, device: { type: 'STRING' }, key: { type: 'STRING' }, op: { type: 'STRING' }, value: { type: 'NUMBER' }, from: { type: 'STRING' }, to: { type: 'STRING' }, when: { type: 'STRING', enum: ['dark', 'light'] } }, required: ['type'] } },
  actions: { type: 'ARRAY', items: { type: 'OBJECT', properties: { type: { type: 'STRING', enum: ['switch', 'toggle', 'dimmer', 'thermostat'] }, device: { type: 'STRING' }, on: { type: 'BOOLEAN' }, percent: { type: 'INTEGER' }, temperature: { type: 'NUMBER' }, delay: { type: 'INTEGER' }, duration: { type: 'INTEGER' } }, required: ['type', 'device'] } },
  rueckfrage: { type: 'STRING' } }, required: ['name', 'trigger', 'actions'] };
// Antwort der KI → Regel (nur bekannte Kurzzeichen, nur erlaubte Felder). Alles andere fällt weg.
// Antwort der KI lesen: alle Textteile (ohne „Gedanken“) zusammen, Code-Zeichen ```json weg, vom ersten { bis zum letzten }.
// Unbrauchbar → Grund ins Protokoll (Abbruchgrund, Anfang der Antwort) und klare Meldung.
function parseAnswer(answer) {
  const c = answer?.candidates?.[0], parts = Array.isArray(c?.content?.parts) ? c.content.parts : [];
  let text = parts.filter(p => !p?.thought && typeof p?.text === 'string').map(p => p.text).join('').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}'); if (a >= 0 && b > a) text = text.slice(a, b + 1);
  try { const ai = JSON.parse(text); if (isObject(ai)) return ai; } catch {}
  console.log('[assistent] unverwertbare KI-Antwort: Abbruch ' + (c?.finishReason || answer?.promptFeedback?.blockReason || '?') + ', ' + parts.length + ' Teile, Anfang: ' + JSON.stringify(text.slice(0, 160)));
  throw fail(c?.finishReason === 'MAX_TOKENS' ? 'Die KI-Antwort war zu lang und wurde abgeschnitten – bitte kürzer beschreiben' : c?.finishReason === 'SAFETY' || answer?.promptFeedback?.blockReason ? 'Die KI hat die Anfrage abgelehnt – bitte anders formulieren' : 'Die KI hat keinen verwertbaren Vorschlag geliefert – bitte nochmal oder anders formulieren', 422);
}
// Fehlt die Rückmeldung (kleinere Modelle lassen sie gern weg), gilt die einzige bekannte Rückmeldung des Auslösers.
function toRule(ai, back, keys = new Map()) {
  if (!isObject(ai)) throw fail('Die KI hat keinen verwertbaren Vorschlag geliefert', 422);
  const addr = id => { const a = back.get(String(id || '')); if (!a) throw fail('Die KI nannte ein unbekanntes Gerät – bitte genauer beschreiben', 422); return a; };
  const t = ai.trigger || {};
  const trigger = t.type === 'time' ? { type: 'time', time: t.time, days: Array.isArray(t.days) && t.days.length ? t.days : [0, 1, 2, 3, 4, 5, 6] }
    : { type: 'device', address: addr(t.device), key: t.key || keys.get(back.get(String(t.device || ''))), op: t.op, ...(t.op === 'above' || t.op === 'below' ? { value: t.value } : {}) };
  const conditions = (Array.isArray(ai.conditions) ? ai.conditions : []).slice(0, 4).map(c => c.type === 'sun' ? { type: 'sun', when: c.when } : c.type === 'time' ? { type: 'time', from: c.from, to: c.to } : { type: 'device', address: addr(c.device), key: c.key, op: c.op, ...(c.op === 'above' || c.op === 'below' ? { value: c.value } : {}) });
  const actions = (Array.isArray(ai.actions) ? ai.actions : []).slice(0, 8).map(a => {
    const o = { type: a.type === 'switch' && typeof a.on !== 'boolean' ? 'toggle' : a.type, address: addr(a.device) }; // „schalten“ ohne an/aus = umschalten
    if (o.type === 'switch') o.on = a.on === true; if (a.type === 'dimmer') o.percent = a.percent; if (a.type === 'thermostat') o.temperature = a.temperature;
    if (Number.isInteger(a.delay) && a.delay > 0) o.delay = a.delay; if (Number.isInteger(a.duration) && a.duration > 0 && o.type !== 'toggle' && o.type !== 'thermostat') o.duration = a.duration;
    return o;
  });
  return { name: String(ai.name || 'KI-Vorschlag').slice(0, 64), enabled: true, trigger, conditions, actions };
}
async function ask(web, text, deps = {}) {
  const s = settings(web);
  if (!s.enabled) throw fail('Die KI ist ausgeschaltet (Automationen → Assistent → KI einrichten)', 409);
  const key = deps.key !== undefined ? deps.key : readKey(web); if (!key) throw fail('Kein KI-Schlüssel hinterlegt', 409);
  if (typeof text !== 'string' || text.trim().length < 5 || text.length > 500 || /[\x00-\x09\x0b-\x1f\x7f]/.test(text)) throw fail('Bitte in einem Satz beschreiben, was passieren soll (5 bis 500 Zeichen)');
  if (!allow(web)) throw fail('Höchstens ' + LIMIT_PER_HOUR + ' KI-Anfragen je Stunde', 429);
  const cat = await A()._test.catalog(web), { lines, back, keys } = aliases(cat);
  const prompt = 'Du bist ein Assistent, der NUR Hausautomations-Regeln im vorgegebenen JSON-Format vorschlägt. Du kannst nichts schalten und nichts speichern. ' +
    'Verwende ausschließlich die Kurzzeichen der Geräteliste (g1, g2, …). Rückmeldungen (key) nur wie angegeben. Uhrzeiten HH:MM, Wochentage 0=So … 6=Sa. ' +
    'Dauer/Verzögerung in Sekunden. Bedingung „nur wenn dunkel“ = {type:"sun",when:"dark"}. „Mit einem Taster/Schalter schalten“ ohne Angabe von an oder aus = Aktion "toggle" (umschalten); "switch" immer mit "on" true/false. Wenn etwas unklar ist, trage eine kurze Rückfrage in „rueckfrage“ ein.\n\nGeräte:\n' + lines.join('\n') + '\n\nWunsch: ' + text.trim();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${s.model}:generateContent`;
  const answer = await postRetry(deps.post || post, url, { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 4096 } }, key, deps.wait);
  const ai = parseAnswer(answer);
  if (typeof ai.rueckfrage === 'string' && ai.rueckfrage.trim() && (!Array.isArray(ai.actions) || !ai.actions.length)) return { question: ai.rueckfrage.trim().slice(0, 300) };
  // Mauer: dieselbe Prüfung wie bei Eingabe von Hand – sonst kein Vorschlag.
  const rule = A().normalizeRule(toRule(ai, back, keys)); delete rule.id;
  await A().checkAgainstDevices(web, rule);
  return { rule, ...(typeof ai.rueckfrage === 'string' && ai.rueckfrage.trim() ? { question: ai.rueckfrage.trim().slice(0, 300) } : {}) };
}

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getAssistent', 'suggestAutomation', 'askAssistent', 'saveAssistent'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (method === 'getAssistent' || method === 'suggestAutomation') {
      if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
      if (method === 'getAssistent') { send(200, { ki: { ...settings(web), hasKey: !!readKey(web), limitPerHour: LIMIT_PER_HOUR } }); return true; }
      const device = u.searchParams.get('device') || ''; if (!/^[A-Za-z0-9_-]{1,64}$/.test(device)) throw fail('Gerät ungültig');
      send(200, await suggestions(web, device)); return true;
    }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (method === 'askAssistent') { if (!isObject(p) || Object.keys(p).some(k => k !== 'text')) throw fail('Ungültige Anfrage'); send(200, await ask(web, p.text)); return true; }
    if (!isObject(p) || Object.keys(p).some(k => !['enabled', 'model', 'key', 'removeKey'].includes(k))) throw fail('Ungültige Einstellung');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw fail('Ein/Aus ungültig');
    if (p.model !== undefined && (typeof p.model !== 'string' || !MODEL.test(p.model))) throw fail('Modellname ungültig');
    if (p.key !== undefined && p.key !== '' && (typeof p.key !== 'string' || !KEY.test(cleanKey(p.key)))) throw fail('Der Schlüssel hat nicht das erwartete Format (Google-AI-Studio-Schlüssel, z. B. beginnend mit „AIza“)');
    if (p.removeKey === true) vault(web).write({}); else if (p.key) vault(web).write({ key: cleanKey(p.key) });
    web.writeConfigPatch(c => { c.ki = { ...settings(web), ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.model ? { model: p.model } : {}) }; });
    send(200, { success: true, ki: { ...settings(web), hasKey: !!readKey(web), limitPerHour: LIMIT_PER_HOUR }, message: 'Gespeichert.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Assistent: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, suggestions, ask, toRule, aliases, _test: { allow, usage } };
