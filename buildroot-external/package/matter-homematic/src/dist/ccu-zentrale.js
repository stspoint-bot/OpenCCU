'use strict';
// Zentrale: Meldungen der Geräte, Systemzustand und – nur zur Übersicht – die bisherigen Programme
// des Unterbaus. Läuft im Bridge-Prozess auf der CCU3 (Node 22, nur Bordmittel).
//
// Eigener Weg seit 0.21.0: Die Meldungen (Batterie, Erreichbarkeit, Sabotage …) kommen nicht mehr
// aus der OpenCCU-Logik, sondern aus den Rückmeldungen der Geräte, die die Bridge über die
// Funkverbindung ohnehin laufend erhält (Wartungskanal „:0“ jedes Geräts). Dafür wird nichts
// zusätzlich an die CCU gesendet. Systemvariablen und das Bestätigen von OpenCCU-Meldungen sind
// entfallen. Die bisherigen Programme lassen sich weiter ansehen und bewusst von Hand starten,
// damit sichtbar bleibt, was im Unterbau noch läuft.

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const decode = s => String(s).replace(/%([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16)));
const ID = /^[1-9]\d{0,9}$/;
const LIMIT = { messages: 500, programs: 1000 };

// ---- Meldungen aus den Geräte-Rückmeldungen ---------------------------------------------
// Stufe: bad = sofort kümmern, warn = bald kümmern, info = nur zur Kenntnis.
const MESSAGE_TYPES = Object.freeze({
  UNREACH: ['Nicht erreichbar', 'bad', 'Das Gerät antwortet nicht. Stromversorgung, Batterie und Abstand zur Zentrale prüfen.'],
  LOWBAT: ['Batterie schwach', 'warn', 'Batterien bald wechseln.'],
  LOW_BAT: ['Batterie schwach', 'warn', 'Batterien bald wechseln.'],
  SABOTAGE: ['Gehäuse geöffnet (Sabotage)', 'bad', 'Sitz und Gehäuse des Geräts prüfen.'],
  ERROR_OVERHEAT: ['Übertemperatur', 'bad', 'Das Gerät ist zu heiß. Angeschlossene Last prüfen.'],
  DEVICE_IN_BOOTLOADER: ['Gerät im Startmodus', 'bad', 'Das Gerät arbeitet nicht normal (Bootloader). Kurz stromlos machen.'],
  ERROR_CODE: ['Gerätefehler', 'bad', 'Das Gerät meldet einen Fehlercode.'],
  DUTY_CYCLE: ['Sendelimit erreicht', 'warn', 'Das Gerät darf vorübergehend nicht mehr funken. Das löst sich nach spätestens einer Stunde von selbst.'],
  CONFIG_PENDING: ['Einstellungen werden übertragen', 'info', 'Bei Batteriegeräten einmal die Taste am Gerät drücken, damit es die Einstellungen abholt.'],
  UPDATE_PENDING: ['Geräte-Update steht bereit', 'info', 'Kein Handlungsbedarf.']
});
const firstSeen = new Map(); // seit wann die Bridge eine Meldung sieht (bis zum Neustart der Bridge)
function messages(web) {
  const connector = web.deps.getConnector(), channels = connector?.getChannels?.() || new Map(), devices = connector?.getDevices?.() || new Map();
  let rows = []; try { rows = web.getDevices?.().devices || []; } catch {}
  const friendly = address => {
    const row = rows.find(r => typeof r.address === 'string' && r.address.startsWith(address + ':') && r.name);
    if (row) return { name: row.name, room: row.room || '' };
    const maintenance = channels.get(address + ':0');
    for (const [a, c] of channels) if (a.startsWith(address + ':') && c?.name && !c.name.includes(address)) return { name: c.name.replace(/:\d+$/, ''), room: c.room || maintenance?.room || '' };
    return { name: (devices.get(address)?.type || 'Gerät') + ' ' + address, room: maintenance?.room || '' };
  };
  const out = [], active = new Set(), now = new Date().toISOString();
  for (const [address, channel] of channels) {
    if (typeof address !== 'string' || !address.endsWith(':0')) continue;
    const values = channel?.paramsets?.VALUES; if (!values) continue;
    const device = address.slice(0, -2);
    for (const [type, [label, level, hint]] of Object.entries(MESSAGE_TYPES)) {
      const v = values[type];
      if (!(v === true || (type === 'ERROR_CODE' && typeof v === 'number' && v > 0))) continue;
      const key = device + '|' + type; active.add(key);
      if (!firstSeen.has(key)) firstSeen.set(key, now);
      const f = friendly(device);
      out.push({ id: key, type, label: type === 'ERROR_CODE' ? label + ' ' + v : label, level, hint, device: f.name, room: f.room, address: device, since: firstSeen.get(key) });
      if (out.length >= LIMIT.messages) break;
    }
    if (out.length >= LIMIT.messages) break;
  }
  for (const key of firstSeen.keys()) if (!active.has(key)) firstSeen.delete(key);
  const order = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || a.device.localeCompare(b.device, 'de'));
}

// ---- Bisherige Programme des Unterbaus (nur ansehen und von Hand starten) ----------------
const SCRIPT_PROGRAMS = '! MH_ZENTRALE_PROGRAMS\n' +
  'Write("{\\"programs\\":[");boolean f=true;string pid;' +
  'foreach(pid,dom.GetObject(ID_PROGRAMS).EnumUsedIDs()){object p=dom.GetObject(pid);' +
  'if(p){if(p.IsTypeOf(OT_PROGRAM)&&!p.Internal()){if(!f){Write(",");}f=false;' +
  'Write("{\\"id\\":" # pid # ",\\"name\\":\\"" # p.Name().UriEncode() # "\\",\\"info\\":\\"" # p.PrgInfo().UriEncode() # "\\",\\"active\\":" # p.Active() # ",\\"visible\\":" # p.Visible() # ",\\"lastRun\\":\\"" # p.ProgramLastExecuteTime().Format("%d.%m.%Y %H:%M") # "\\"}");}}}' +
  'Write("]}");';

let lastPort = null;
async function rega(web, script, write = false) {
  const connector = web.deps.getConnector();
  if (!connector || typeof connector.regaScript !== 'function') throw fail('CCU-Verbindung nicht verfügbar', 503);
  // Lesen darf beide Zugänge probieren. Schreiben genau einmal über den zuletzt
  // funktionierenden Zugang: ein Zeitüberschreitungsfehler kann bedeuten, dass es schon wirkte.
  const ports = write ? [lastPort || 8181] : [...new Set([lastPort, 8181, connector.config?.regaPort || 80].filter(Boolean))];
  let error;
  for (const port of ports) {
    try { const out = String(await connector.regaScript(script, port)).trim(); if (!write) lastPort = port; return out; } catch (e) { error = e; }
  }
  throw fail((write ? 'Aktion nicht bestätigt (nicht wiederholt, Zustand prüfen): ' : 'Programme der Zentrale nicht lesbar: ') + (error?.message || 'unbekannt'), 502);
}
async function readJson(web, script, key, limit) {
  let data;
  try { data = JSON.parse(await rega(web, script)); } catch (e) { if (e.status) throw e; throw fail('Ungültige Antwort der CCU', 502); }
  if (!data || !Array.isArray(data[key])) throw fail('Ungültige Antwort der CCU', 502);
  if (data[key].length > limit) throw fail('Zu viele Einträge in der CCU-Antwort', 502);
  return data[key];
}
// Gleiche Lesevorgänge mehrerer Fenster zusammenlegen und kurz merken.
const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key), now = Date.now();
  if (hit && (hit.pending || now - hit.at < ttl)) return hit.pending || Promise.resolve(hit.value);
  const entry = { at: now, pending: null, value: undefined };
  entry.pending = fn().then(v => { entry.value = v; entry.at = Date.now(); entry.pending = null; return v; }, e => { cache.delete(key); throw e; });
  cache.set(key, entry);
  return entry.pending;
}
function invalidate(...keys) { for (const k of keys.length ? keys : [...cache.keys()]) cache.delete(k); }
const text = (s, max = 256) => decode(typeof s === 'string' ? s : '').slice(0, max);
const bool = v => v === true || v === 'true' || v === 1;

async function programs(web) {
  const rows = await cached('programs', 15000, () => readJson(web, SCRIPT_PROGRAMS, 'programs', LIMIT.programs));
  return rows.filter(r => Number.isSafeInteger(r.id) && r.id > 0).map(r => ({ id: r.id, name: text(r.name), info: text(r.info, 512), active: bool(r.active), visible: bool(r.visible), lastRun: text(r.lastRun, 32) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
}

// ---- Systemzustand -----------------------------------------------------------------------
async function dutyCycle(web) {
  try {
    const connector = web.deps.getConnector();
    const list = await Promise.race([connector.rpcCall('BidCos-RF', 'listBidcosInterfaces', []), new Promise((_, r) => setTimeout(() => r(Error('timeout')), 3000))]);
    if (!Array.isArray(list)) return null;
    const values = list.map(i => Number(i?.DUTY_CYCLE)).filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
  } catch { return null; }
}
function system(web) { return cached('system', 10000, () => systemRead(web)); }
// Nur noch Funk und Geräte (Seite „Meldungen & Zustand“). Speicher, Temperatur, Laufzeit der CCU3 zeigt seit 13.10.2026
// die Ampelseite „🚦 Systemzustand“ (dist/systemzustand.js, Wartungsscript der CCU3) – hier entfernt (Wunsch Thomas).
async function systemRead(web) {
  const connector = web.deps.getConnector();
  return {
    dutyCycle: await dutyCycle(web),
    devices: connector?.getDevices?.()?.size ?? null,
    radio: Object.entries(connector?.config?.interfaces || {}).filter(([, v]) => v?.enabled !== false).map(([name]) => ({ name, connected: connector.clients?.has?.(name) === true && !connector.failedInterfaces?.has?.(name) }))
  };
}

let busy = false;
async function exclusive(fn) {
  if (busy) throw fail('Eine Aktion läuft bereits; bitte kurz warten', 429);
  busy = true;
  try { return await fn(); } finally { busy = false; }
}
function idOf(p, keys) {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => !keys.includes(k))) throw fail('Unerwartete Felder in der Anfrage');
  const id = typeof p.id === 'number' ? String(p.id) : p.id;
  if (typeof id !== 'string' || !ID.test(id)) throw fail('Ungültige Kennung');
  return Number(id);
}
async function runProgram(web, p) {
  const id = idOf(p, ['id']);
  const program = (await programs(web)).find(x => x.id === id);
  if (!program) throw fail('Programm nicht gefunden', 404);
  return exclusive(async () => {
    // Ein Zeitüberschreitungsfehler kann bedeuten, dass das Programm lief: niemals wiederholen.
    invalidate('programs');
    const raw = await rega(web, `! MH_ZENTRALE_RUN ${id}\nobject p=dom.GetObject(${id});if(p){if(p.IsTypeOf(OT_PROGRAM)&&!p.Internal()){p.ProgramExecute();Write("MH_OK");}else{Write("MH_TYPE");}}else{Write("MH_MISSING");}`, true);
    invalidate('programs');
    if (raw !== 'MH_OK') throw fail('Die Zentrale hat den Programmstart nicht bestätigt', 502);
    return { success: true, message: `Programm „${program.name}“ wurde gestartet.` };
  });
}

// Bemerkung = Beschreibung des Programms in der Zentrale (dieselbe wie in der alten Oberfläche).
// ReGa speichert Latin-1; nur %XX-Bytes gelangen ins Skript, daher keine Skript-Einschleusung möglich.
const NOTE_MAP = { '\u201e': '"', '\u201c': '"', '\u201d': '"', '\u201a': "'", '\u2018': "'", '\u2019': "'", '\u2013': '-', '\u2014': '-', '\u2026': '...' };
function noteBytes(note) {
  if (typeof note !== 'string') throw fail('Ungültige Bemerkung');
  const s = [...note.trim()].map(c => NOTE_MAP[c] ?? c).join('');
  if (s.length > 200) throw fail('Bemerkung: höchstens 200 Zeichen');
  if (/[\x00-\x1f\x7f]/.test(s)) throw fail('Bemerkung: keine Steuerzeichen');
  if ([...s].some(c => c.charCodeAt(0) > 255)) throw fail('Die Bemerkung enthält Zeichen, die die Zentrale nicht speichern kann (z. B. € oder Emojis)');
  return [...s].map(c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
}
async function setProgramNote(web, p) {
  const id = idOf(p, ['id', 'note']);
  const bytes = noteBytes(p.note ?? '');
  const program = (await programs(web)).find(x => x.id === id);
  if (!program) throw fail('Programm nicht gefunden', 404);
  return exclusive(async () => {
    invalidate('programs');
    const raw = await rega(web, `! MH_ZENTRALE_NOTE ${id}\nobject p=dom.GetObject(${id});if(p){if(p.IsTypeOf(OT_PROGRAM)&&!p.Internal()){p.PrgInfo("${bytes}".UriDecode());Write("MH_OK");}else{Write("MH_TYPE");}}else{Write("MH_MISSING");}`, true);
    invalidate('programs');
    if (raw !== 'MH_OK') throw fail('Die Zentrale hat die Bemerkung nicht bestätigt', 502);
    return { success: true, message: `Bemerkung für „${program.name}“ gespeichert.` };
  });
}

const GET = {
  getCcuOverview: async web => { let m = null, error = null; try { m = messages(web); } catch (e) { error = e.message; } let s = null; try { s = await system(web); } catch {} return { messages: m, messagesError: error, system: s, checkedAt: new Date().toISOString() }; },
  getCcuPrograms: async web => ({ programs: await programs(web) })
};
const POST = { runCcuProgram: runProgram, setCcuProgramNote: setProgramNote };

async function handle(web, req, res, u, auth) {
  if (await require('./geraete-bilder').handle(web, req, res, u, auth)) return true;
  if (u.pathname !== '/api/') return false;
  if (await require('./ccu-verbindung').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-anlernen').handle(web, req, res, u, auth)) return true;
  if (await require('./geraete-loeschen').handle(web, req, res, u, auth)) return true;
  if (await require('./netzspeicher').handle(web, req, res, u, auth)) return true;
  if (await require('./automationen').handle(web, req, res, u, auth)) return true;
  if (await require('./login-alert').handle(web, req, res, u, auth)) return true;
  if (await require('./tasmota').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-neustart').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-ssh').handle(web, req, res, u, auth)) return true;
  if (await require('./jeep-wecker').handle(web, req, res, u, auth)) return true;
  if (await require('./jeep-fernsteuerung').handle(web, req, res, u, auth)) return true;
  if (await require('./entfeuchter').handle(web, req, res, u, auth)) return true;
  if (await require('./batterie-waechter').handle(web, req, res, u, auth)) return true;
  if (await require('./jeep-laden').handle(web, req, res, u, auth)) return true;
  if (await require('./tasmota-wache').handle(web, req, res, u, auth)) return true;
  if (await require('./meldungen-aus').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-detail').handle(web, req, res, u, auth)) return true;
  if (await require('./jeep-wache').handle(web, req, res, u, auth)) return true; // WhatsApp-Hinweise, Nachtschloss, Fahrzeugzustand
  if (await require('./verknuepfungen').handle(web, req, res, u, auth)) return true;
  if (await require('./geraete-verwaltung').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-firewall').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-sso').handle(web, req, res, u, auth)) return true;
  if (await require('./raeume').handle(web, req, res, u, auth)) return true;
  if (await require('./zeit-standort').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-netzwerk').handle(web, req, res, u, auth)) return true;
  if (await require('./wochenprogramm').handle(web, req, res, u, auth)) return true;
  if (await require('./benutzer').handle(web, req, res, u, auth)) return true;
  if (await require('./geraeteparameter').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-software').handle(web, req, res, u, auth)) return true;
  if (await require('./ccu-sicherung').handle(web, req, res, u, auth)) return true;
  if (await require('./systemzustand').handle(web, req, res, u, auth)) return true; // Ampel-Seite „Systemzustand“ (CCU3, WD, Sicherungen, Dienste, Geräte)
  if (await require('./geraet-merken').handle(web, req, res, u, auth)) return true;
  if (await require('./wetter').handle(web, req, res, u, auth)) return true;
  if (await require('./sc-freiburg').handle(web, req, res, u, auth)) return true; // Handy-Seite „⚽ SC“ (News, Spiele, Tabelle)
  if (await require('./favoriten').handle(web, req, res, u, auth)) return true;
  if (await require('./assistent').handle(web, req, res, u, auth)) return true;
  if (await require('./letzte-werte').handle(web, req, res, u, auth)) return true;
  if (await require('./jeep-standort').handle(web, req, res, u, auth)) return true;
  if (await require('./ecovacs').handle(web, req, res, u, auth)) return true;  const method = u.searchParams.get('method');
  const send = (status, data) => web.sendJson(res, status, data);
  try {
    if (Object.hasOwn(GET, method)) { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await GET[method](web)); return true; }
    if (Object.hasOwn(POST, method)) {
      if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
      if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
      send(200, await POST[method](web, await require('./web-security').body(req))); return true;
    }
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : 'Anfrage an die Zentrale fehlgeschlagen' }); return true; }
  return false;
}
module.exports = { handle, decode, MESSAGE_TYPES, SCRIPT_PROGRAMS, _internal: { messages, programs, system, runProgram, setProgramNote, noteBytes, rega, readJson, cached, invalidate } };
