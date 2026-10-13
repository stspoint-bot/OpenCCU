'use strict';
// Jeep-Fernsteuerung: Klima, Motor-Fernstart, Türen (Wunsch Thomas, 12.10.2026).
// Befehle wie py-uconnect (jeep-cloud.js remoteCommand). Angeboten wird nur, was das Fahrzeug in seiner
// Dienstliste („services“: vehicleCapable und serviceEnabled) freigibt.
// Schutz:
// - Gleiche Uconnect-PIN wie „Fahrzeugdaten aktualisieren“ (jeep-pin.json, verschlüsselt). Wird sie abgelehnt,
//   ruht die Fernsteuerung UND das automatische Aktualisieren, bis eine neue PIN gespeichert ist (sonst PIN-Sperre).
// - Ein Befehl zur Zeit, je Fahrzeug höchstens alle 30 Sekunden; nichts wird automatisch wiederholt.
// - Automationen dürfen nur das Klima schalten. Motor-Fernstart und Türen nur von Hand auf der Jeep-Seite mit Bestätigung
//   (nie automatisch starten oder entriegeln; Freigabe dafür nur ausdrücklich durch Thomas).
//   Einzige Ausnahme (Freigabe Thomas 12.10.2026): das Nachtschloss (jeep-wache.js) darf abends VERRIEGELN (RDL) –
//   nie entriegeln, nie Motor; nur wenn Türen schon einmal von Hand bestätigt verriegelt wurden. Türen bleiben kein Automationsziel.
// - Ändern und Senden nur nach Anmeldung als CCU-Administrator.
const fs = require('node:fs'), path = require('node:path');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const GAP_MS = 20000; // 20 s zwischen Jeep-Befehlen (Wunsch Thomas: Knopf nach jedem Druck 20 s gesperrt)
// Ein Zeitplan aus Uconnect, vereinfacht wie in der Jeep-App. Beim Klimaplan ist endTime die Abfahrtszeit,
// cabinPriority „Über Ladezustand hinwegsetzen“, repeatSchedule „Wöchentlich wiederholen“ (mit App-Anzeige verglichen).
const TAGE = [['monday', 'Mo'], ['tuesday', 'Di'], ['wednesday', 'Mi'], ['thursday', 'Do'], ['friday', 'Fr'], ['saturday', 'Sa'], ['sunday', 'So']];
const PLANART = { CLIMATE: 'Klimaplan', CHARGE: 'Ladeplan', NONE: 'nicht belegt' };
const hhmm = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null;
function plan(p, i) {
  const type = typeof p?.scheduleType === 'string' && /^[A-Z_]{1,24}$/.test(p.scheduleType) ? p.scheduleType : 'NONE', days = isObject(p?.scheduledDays) ? p.scheduledDays : {};
  return { nr: i + 1, type, title: PLANART[type] || 'Plan „' + type + '“', active: p?.enableScheduleType === true, start: hhmm(p?.startTime), end: hhmm(p?.endTime),
    days: TAGE.filter(([k]) => days[k] === true).map(([, t]) => t), repeat: p?.repeatSchedule === true, cabinPriority: p?.cabinPriority === true, chargeToFull: p?.chargeToFull === true };
}

// Unveränderter Platz so, wie Uconnect ihn erwartet (Reihenfolge und Felder wie die v2-Zeitplanliste)
const rawPlan = x => ({ enableScheduleType: x?.enableScheduleType === true, scheduleType: typeof x?.scheduleType === 'string' && /^[A-Z_]{1,24}$/.test(x.scheduleType) ? x.scheduleType : 'NONE', startTime: hhmm(x?.startTime) || '00:00', endTime: hhmm(x?.endTime) || '00:00', chargeToFull: x?.chargeToFull === true, cabinPriority: x?.cabinPriority === true, scheduledDays: Object.fromEntries(TAGE.map(([k]) => [k, x?.scheduledDays?.[k] === true])), repeatSchedule: x?.repeatSchedule === true });
// Platz für „Klima sofort“: zuerst ein leerer, sonst der letzte ausgeschaltete; eingeschaltete Pläne werden nie benutzt
function freeSlot(list) { const empty = list.findIndex(x => !['CLIMATE', 'CHARGE'].includes(x?.scheduleType)); if (empty >= 0) return empty + 1; for (let i = list.length - 1; i >= 0; i--) if (list[i]?.enableScheduleType !== true) return i + 1; return 0; }
const SOFORT_MS = 20 * 60000, BACK_MS = 10 * 60000; // Abfahrt in ~20 min (gerundet auf 5 min), zurücksetzen 10 min nach der Abfahrt

// on = erster Befehl, off = zweiter. Bei mehreren Paaren zuerst das, das das Fahrzeug freigibt; lehnt Uconnect es ab,
// werden die übrigen Paare der Reihe nach versucht (wie die Ersatzbefehle von py-uconnect; Thomas 12.10.2026: Klima geht
// in der Jeep-App auch ohne Ladekabel). Das zuletzt erfolgreiche Paar wird gemerkt und künftig zuerst benutzt.
const ACTIONS = Object.freeze({
  klima: { title: 'Klima', channel: 1, automation: true, pairs: [['ROPRECOND', 'ROPRECOND_OFF'], ['ROHVACON', 'ROHVACOFF'], ['ROCOMFORTON', 'ROCOMFORTOFF']], on: 'Klima einschalten', off: 'Klima ausschalten' },
  motor: { title: 'Motor-Fernstart', channel: 2, automation: false, pairs: [['REON', 'REOFF']], on: 'Motor starten', off: 'Motor abstellen' },
  tueren: { title: 'Türen', channel: 3, automation: false, pairs: [['RDL', 'RDU']], on: 'Türen verriegeln', off: 'Türen entriegeln' },
  // Lichter (Dienst ROLIGHTS laut Dienstliste von Thomas' Jeep, 12.10.2026): Uconnect kennt nur „kurz blinken lassen“, kein Dauer-An/Aus
  licht: { title: 'Lichter', channel: 4, automation: false, pairs: [['ROLIGHTS', 'ROLIGHTS']], on: 'Lichter blinken lassen', off: 'Lichter blinken lassen' }
});

// Uconnect liefert die Kennzeichen nicht immer als echtes true (12.10.2026: alle Befehle galten als „nicht freigegeben“,
// obwohl die Jeep-App sie anbietet). Darum großzügig lesen; die eigentliche Prüfung macht Uconnect beim Befehl.
const yes = v => v === true || v === 1 || (typeof v === 'string' && /^(true|y|yes|1|enabled|active)$/i.test(v.trim()));
const serviceList = row => { const list = row?.sources?.vehicle?.data?.services; return Array.isArray(list) ? list.filter(s => isObject(s) && typeof s.service === 'string') : null; };
function services(row) {
  return new Set((serviceList(row) || []).filter(s => yes(s.vehicleCapable) && yes(s.serviceEnabled)).map(s => s.service));
}
// Klima über Zeitplan: Fahrzeug gibt Zeitpläne (CPPLUS) frei, aber keinen der Klima-Direktbefehle (Thomas' Jeep, 12.10.2026)
const viaPlan = row => { const have = services(row); return have.has('CPPLUS') && !ACTIONS.klima.pairs.some(([a, b]) => have.has(a) || have.has(b)); };
// Befehlspaar für eine Aktion: confirmed = laut Dienstliste freigegeben. Sonst trotzdem anbieten (wie die App) –
// lehnt Uconnect ab, kommt eine klare Meldung; Automationen nur mit bestätigter Freigabe oder nach erfolgreichem Befehl.
function pairFor(row, action, okSet) {
  const def = ACTIONS[action];
  if (!def) return null;
  const have = services(row), listed = new Set((serviceList(row) || []).map(s => s.service));
  for (const [on, off] of def.pairs) if (have.has(on) || have.has(off)) return { on, off, confirmed: true };
  const learned = !!okSet?.has(row?.vin + ':' + action);
  for (const [on, off] of def.pairs) if (listed.has(on) || listed.has(off)) return { on, off, confirmed: learned };
  const [on, off] = def.pairs[0];
  return { on, off, confirmed: learned };
}
// Kurzfassung der Dienstliste zur Fehlersuche (nur Namen und Kennzeichen, keine Zugangsdaten).
const flag = v => typeof v === 'boolean' || typeof v === 'number' ? v : typeof v === 'string' ? v.slice(0, 20) : null;
const summary = row => (serviceList(row) || []).slice(0, 200).map(s => ({ service: s.service.slice(0, 40), vehicleCapable: flag(s.vehicleCapable), serviceEnabled: flag(s.serviceEnabled) }));

const wecker = web => require('./jeep-wecker')._test.wecker(web);
const readPin = web => require('./jeep-wecker')._test.readPin(web);

class Fernsteuerung {
  constructor(web, { now = () => Date.now() } = {}) {
    this.web = web; this.now = now; this.busy = false; this.lastAt = new Map(); this.last = null;
    // Befehle, die Uconnect schon einmal angenommen hat („VIN:aktion“), überdauern einen Neustart.
    this.file = web.deps?.configPath ? path.join(path.dirname(web.deps.configPath), 'jeep-fernsteuerung.json') : null;
    this.ok = new Set(); this.works = new Map(); this.denied = new Map(); // „VIN:aktion“ → { at, reason } der letzten Ablehnung (Zeitpunkt wie in der Jeep-App, Begründung von Uconnect)
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); for (const k of Array.isArray(d.ok) ? d.ok : []) if (typeof k === 'string' && k.length < 40) this.ok.add(k); } catch {}
    this.sofortFile = web.deps?.configPath ? path.join(path.dirname(web.deps.configPath), 'jeep-klima-sofort.json') : null; this.sofort = null;
    try { const v = JSON.parse(fs.readFileSync(this.sofortFile, 'utf8')); if (VIN.test(v?.vin) && Number.isInteger(v.nr) && v.nr >= 1 && v.nr <= 8 && isObject(v.backup) && Number.isFinite(v.until)) this.sofort = { vin: v.vin, nr: v.nr, backup: rawPlan(v.backup), until: v.until, departure: hhmm(v.departure), tries: Number.isInteger(v.tries) ? v.tries : 0, gaveUp: v.gaveUp === true }; } catch {}
  }
  remember(key) { if (this.ok.has(key)) return; this.ok.add(key); if (!this.file) return; try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ok: [...this.ok] }), { mode: 0o600 }); fs.renameSync(tmp, this.file); } catch {} }
  rows() { return (this.web.jeepService?.rows || []).filter(r => typeof r?.vin === 'string' && VIN.test(r.vin)); }
  vehicles() {
    const rows = this.rows();
    return rows.map((r, i) => ({ vin: r.vin, index: i + 1, name: rows.length > 1 ? 'Jeep Fahrzeug ' + (i + 1) : 'Jeep',
      actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, d]) => { const p = k === 'klima' && viaPlan(r) ? { confirmed: true, viaPlan: true } : pairFor(r, k, this.ok); return [k, { title: d.title, available: !!p, confirmed: !!p?.confirmed, viaPlan: !!p?.viaPlan, denied: this.denied.has(r.vin + ':' + k), deniedAt: this.denied.get(r.vin + ':' + k)?.at || null, deniedReason: this.denied.get(r.vin + ':' + k)?.reason || '', automation: d.automation, on: d.on, off: d.off }]; })),
      servicesKnown: !!serviceList(r), services: summary(r) }));
  }
  async run(vin, action, on, reason) {
    const svc = this.web.jeepService, def = ACTIONS[action];
    if (!def) throw fail('Unbekannte Aktion');
    if (typeof on !== 'boolean') throw fail('Ein oder Aus wählen');
    if (reason === 'Nachtschloss' && (action !== 'tueren' || on !== true)) throw fail('Nachtschloss darf nur verriegeln', 403);
    if (!svc?.connected || !svc.client) throw fail('Jeep ist nicht verbunden. Bitte zuerst auf der Jeep-Seite anmelden.', 409);
    const w = wecker(this.web);
    if (w.state.pinRejected) throw fail('Die Uconnect-PIN wurde abgelehnt. Bitte auf der Jeep-Seite eine neue PIN speichern.', 409);
    const pin = readPin(this.web);
    if (!pin) throw fail('Bitte zuerst auf der Jeep-Seite die Uconnect-PIN speichern.', 409);
    const row = this.rows().find(r => r.vin === vin);
    if (!row) throw fail('Fahrzeug gehört nicht zum angemeldeten Jeep-Konto', 404);
    if (action === 'klima' && viaPlan(row)) return this.klimaPlan(vin, on, reason);
    const pair = pairFor(row, action, this.ok), key = vin + ':' + action;
    if (!pair) throw fail(def.title + ': Dieses Fahrzeug gibt den Befehl laut Uconnect nicht frei.', 409);
    if ((reason === 'Automation' || reason === 'Nachtschloss') && !pair.confirmed) throw fail(def.title + ': erst einmal von Hand auf der Jeep-Seite auslösen, danach geht es auch per Automation.', 409);
    if (this.busy) throw fail('Es läuft bereits ein Jeep-Befehl', 429);
    const last = this.lastAt.get(vin) || 0;
    if (this.now() - last < GAP_MS) throw fail('Bitte 20 Sekunden zwischen Jeep-Befehlen warten', 429);
    this.busy = true; this.lastAt.set(vin, this.now());
    const text = on ? def.on : def.off, at = new Date(this.now()).toISOString();
    // Reihenfolge: zuletzt erfolgreiches Paar, dann das freigegebene, dann die übrigen
    const order = [this.works.get(key), pair.on, ...def.pairs.map(p => p[0])].filter((x, i, a) => x && a.indexOf(x) === i);
    const tried = [];
    try {
      let r = null, used = null;
      for (const first of order) {
        const p = def.pairs.find(x => x[0] === first); if (!p) continue;
        try { r = await svc.client.remoteCommand(vin, pin, on ? p[0] : p[1]); used = p; break; }
        catch (e) { if (!(e.status === 409 && /lehnt den Befehl/.test(e.message))) throw e; tried.push((on ? p[0] : p[1]) + (e.reason ? ': ' + e.reason : '')); }
      }
      if (!used) throw Object.assign(fail('Uconnect lehnt den Befehl für dieses Fahrzeug ab (versucht: ' + tried.join(' | ') + ').', 409), { reason: tried.join(' | ').slice(0, 300) });
      this.works.set(key, used[0]);
      this.denied.delete(key);
      const id = typeof r?.correlationId === 'string' && r.correlationId ? r.correlationId : null;
      this.last = { ok: true, at, reason, text, state: id ? 'waiting' : 'unknown', message: text + (id ? ': von Uconnect angenommen – warte auf Bestätigung vom Fahrzeug …' : ': von Uconnect angenommen. Das Fahrzeug führt den Befehl in der Regel innerhalb von 1–2 Minuten aus.') };
      if (id) this.confirm(svc.client, vin, id, key, this.last).then(s => { console.log('[jeep] ' + text + ' (' + reason + '): Fahrzeug ' + s); if (action === 'tueren') try { require('./jeep-schloss').confirmed(require('./jeep-matter').vehicleId(vin), on, s); } catch {} }).catch(() => {}); else this.remember(key);
      console.log('[jeep] ' + text + ' (' + reason + '): von Uconnect angenommen (' + used[on ? 0 : 1] + ')');
      if (action === 'tueren') try { require('./jeep-schloss').soon(); } catch {} // Türstatus nach 90 s nachlesen
      return this.last;
    } catch (e) {
      if (e.pinRejected) w.state.pinRejected = true;
      else if (e.status === 409 && /lehnt den Befehl/.test(e.message)) this.denied.set(key, { at, reason: e.reason || '' });
      this.last = { ok: false, at, reason, text, message: e.status ? e.message : 'Befehl fehlgeschlagen' };
      console.log('[jeep] ' + text + ' (' + reason + '): fehlgeschlagen – ' + this.last.message + (e.upstreamStatus ? ' (HTTP ' + e.upstreamStatus + ')' : ''));
      throw e.status ? e : fail('Jeep-Befehl fehlgeschlagen', 502);
    } finally { this.busy = false; }
  }
  // Echte Bestätigung vom Fahrzeug (Wunsch Thomas über „Fragen lösen“, 12.10.2026): nur nachfragen, nie wiederholen;
  // höchstens 60 s, alle 3 s. Ergebnis landet in last.state: confirmed / failed / timeout.
  async confirm(client, vin, id, key, entry) {
    const sleep = this.sleep || (ms => new Promise(r => setTimeout(r, ms))), until = this.now() + (this.confirmMs || 60000);
    let state = 'timeout';
    while (this.now() < until) {
      await sleep(this.pollMs || 3000);
      let s; try { s = typeof client.commandStatus === 'function' ? await client.commandStatus(vin, id) : 'pending'; } catch { s = 'pending'; }
      if (s === 'success') { state = 'confirmed'; break; }
      if (s === 'failure') { state = 'failed'; break; }
    }
    if (state === 'failed') this.denied.set(key, { at: new Date(this.now()).toISOString(), reason: 'vom Fahrzeug nicht ausgeführt' }); else this.remember(key);
    entry.state = state; entry.ok = state !== 'failed'; entry.doneAt = new Date(this.now()).toISOString();
    entry.message = entry.text + (state === 'confirmed' ? ': ✅ vom Fahrzeug bestätigt.' : state === 'failed' ? ': ❌ vom Fahrzeug abgelehnt bzw. nicht ausgeführt.' : ': ⚠ keine Rückmeldung vom Fahrzeug innerhalb von 60 Sekunden (Befehl wurde angenommen, Ausführung unbekannt).');
    return state;
  }
  // Zeitpläne wie in der Jeep-App (Klima-/Ladeplan mit Abfahrtszeit) – nur lesen.
  // Am echten Jeep geprüft (12.10.2026): Die Pläne der App stehen in der Fahrzeugmeldung (status → evInfo.schedules), die die
  // Bridge ohnehin alle 5 min abholt. /v2/ev/schedule/ lieferte nur leere Plätze, /v4 „500 DB operation error“ – darum wird die
  // Uconnect-Zeitplanliste nur noch gefragt, wenn die Fahrzeugmeldung keine Pläne enthält.
  async schedules(vin) {
    const svc = this.web.jeepService;
    if (!svc?.connected || !svc.client) throw fail('Jeep ist nicht verbunden. Bitte zuerst auf der Jeep-Seite anmelden.', 409);
    const row = typeof vin === 'string' ? this.rows().find(r => r.vin === vin) : null;
    if (!row) throw fail('Fahrzeug gehört nicht zum angemeldeten Jeep-Konto', 404);
    let list = row.sources?.status?.data?.evInfo?.schedules, source = 'Fahrzeugmeldung', at = row.vehicleUpdatedAt || null;
    if (!Array.isArray(list) || !list.length) {
      if (typeof svc.client.chargeSchedules !== 'function') throw fail('Zeitpläne werden nicht unterstützt', 501);
      let data; try { data = await svc.client.chargeSchedules(vin); } catch (e) { if (/^Zeitpläne nicht lesbar – versucht/.test(e.message || '')) throw fail(e.message.slice(0, 600), 502); throw fail('Zeitpläne nicht lesbar' + (e.upstreamStatus ? ' (HTTP ' + e.upstreamStatus + (e.upstreamReason ? ': ' + e.upstreamReason : '') + ')' : ''), e.upstreamStatus === 404 ? 404 : 502); }
      list = [data?.schedules, data?.chargeSchedules, data?.chargeSchedulesV4, data?.items].find(Array.isArray) || []; source = 'Uconnect-Zeitplanliste'; at = null;
    }
    return { readAt: new Date(this.now()).toISOString(), source, vehicleUpdatedAt: at, plans: list.slice(0, 8).map(plan) };
  }
  // Gemeinsame Vorprüfung für Zeitplan-Befehle: verbunden, PIN vorhanden und nicht gesperrt, eigenes Fahrzeug, Pläne bekannt
  planContext(vin) {
    const svc = this.web.jeepService;
    if (!svc?.connected || !svc.client) throw fail('Jeep ist nicht verbunden. Bitte zuerst auf der Jeep-Seite anmelden.', 409);
    if (typeof svc.client.setSchedules !== 'function') throw fail('Zeitpläne ändern wird nicht unterstützt', 501);
    if (wecker(this.web).state.pinRejected) throw fail('Die Uconnect-PIN wurde abgelehnt. Bitte auf der Jeep-Seite eine neue PIN speichern.', 409);
    const pin = readPin(this.web);
    if (!pin) throw fail('Bitte zuerst auf der Jeep-Seite die Uconnect-PIN speichern.', 409);
    const row = this.rows().find(r => r.vin === vin);
    if (!row) throw fail('Fahrzeug gehört nicht zum angemeldeten Jeep-Konto', 404);
    const list = row.sources?.status?.data?.evInfo?.schedules;
    if (!Array.isArray(list) || !list.length || list.length > 8) throw fail('Die Zeitpläne des Autos sind noch nicht bekannt. Bitte warten, bis sich das Auto gemeldet hat.', 409);
    return { svc, pin, row, list };
  }
  // Alle Plätze senden (CPPLUS) – gleiche Schutzregeln wie die Fernbefehle: ein Befehl zur Zeit, 20 s Abstand, PIN-Sperre, Protokoll
  async sendPlans(ctx, vin, schedules, text, reason) {
    const { svc, pin } = ctx, w = wecker(this.web);
    if (this.busy) throw fail('Es läuft bereits ein Jeep-Befehl', 429);
    if (this.now() - (this.lastAt.get(vin) || 0) < GAP_MS) throw fail('Bitte 20 Sekunden zwischen Jeep-Befehlen warten', 429);
    const at = new Date(this.now()).toISOString(), key = vin + ':zeitplan';
    this.busy = true; this.lastAt.set(vin, this.now());
    try {
      const r = await svc.client.setSchedules(vin, pin, schedules), id = typeof r?.correlationId === 'string' && r.correlationId ? r.correlationId : null;
      this.last = { ok: true, at, reason, text, state: id ? 'waiting' : 'unknown', message: text + (id ? ': von Uconnect angenommen – warte auf Bestätigung vom Fahrzeug …' : ': von Uconnect angenommen. Das Auto übernimmt ihn in der Regel innerhalb von 1–2 Minuten.') };
      if (id) this.confirm(svc.client, vin, id, key, this.last).then(s => console.log('[jeep] ' + text + ' (' + reason + '): Fahrzeug ' + s)).catch(() => {});
      console.log('[jeep] ' + text + ' (' + reason + '): von Uconnect angenommen (CPPLUS)');
      setTimeout(() => svc.refresh?.().catch(() => {}), 120000).unref?.(); // neue Fahrzeugmeldung mit dem geänderten Plan abholen
      return this.last;
    } catch (e) {
      if (e.pinRejected) w.state.pinRejected = true;
      this.last = { ok: false, at, reason, text, message: e.status ? e.message : 'Zeitplan speichern fehlgeschlagen' };
      console.log('[jeep] ' + text + ' (' + reason + '): fehlgeschlagen – ' + this.last.message + (e.upstreamStatus ? ' (HTTP ' + e.upstreamStatus + ')' : ''));
      throw e.status ? e : fail('Zeitplan speichern fehlgeschlagen', 502);
    } finally { this.busy = false; }
  }
  // Einen Zeitplan ändern (Wunsch Thomas 12.10.2026: „bearbeiten, so dass es übernommen wird“). Gesendet werden alle
  // Plätze aus der letzten Fahrzeugmeldung; nur der gewählte Platz wird ersetzt. Das Auto bestätigt über die correlationId.
  async saveSchedule(vin, nr, input, reason) {
    const ctx = this.planContext(vin), { list } = ctx;
    if (!Number.isInteger(nr) || nr < 1 || nr > list.length) throw fail('Plan ' + nr + ' gibt es nicht');
    const p = input, days = Array.isArray(p?.days) ? p.days : null;
    if (!isObject(p) || Object.keys(p).some(k => !['type', 'active', 'start', 'end', 'days', 'repeat', 'cabinPriority', 'chargeToFull'].includes(k))) throw fail('Ungültige Angaben');
    if (!['CLIMATE', 'CHARGE'].includes(p.type)) throw fail('Klimaplan oder Ladeplan wählen');
    if (!['active', 'repeat', 'cabinPriority', 'chargeToFull'].every(k => typeof p[k] === 'boolean')) throw fail('Ungültige Angaben');
    if (!hhmm(p.end) || (p.type === 'CHARGE' && !hhmm(p.start))) throw fail(p.type === 'CLIMATE' ? 'Abfahrtszeit als HH:MM angeben' : 'Start- und Endzeit als HH:MM angeben');
    if (!days || days.length > 7 || days.some(t => !TAGE.some(([, x]) => x === t)) || new Set(days).size !== days.length) throw fail('Ungültige Tage');
    if (p.active && !days.length) throw fail('Mindestens einen Tag wählen');
    if (this.sofort?.vin === vin && this.sofort.nr === nr) throw fail('Plan ' + nr + ' wird gerade für „Klima sofort“ benutzt. Bitte warten, bis er zurückgesetzt ist, oder Klima ausschalten.', 409);
    const schedules = list.map((x, i) => i === nr - 1
      ? { enableScheduleType: p.active, scheduleType: p.type, startTime: p.type === 'CHARGE' ? p.start : hhmm(x?.startTime) || '00:00', endTime: p.end, chargeToFull: p.type === 'CHARGE' && p.chargeToFull, cabinPriority: p.type === 'CLIMATE' && p.cabinPriority, scheduledDays: Object.fromEntries(TAGE.map(([k, t]) => [k, days.includes(t)])), repeatSchedule: p.repeat }
      : rawPlan(x));
    return this.sendPlans(ctx, vin, schedules, 'Zeitplan ' + nr + ' (' + PLANART[p.type] + ') speichern', reason);
  }
  // Klima sofort über einen einmaligen Klimaplan (Thomas 12.10.2026: Frostschutz am Morgen). Thomas' Jeep nimmt die
  // Direktbefehle ROPRECOND/ROHVACON/ROCOMFORTON nicht an (Dienstliste „not capable“, nie bestätigt), wohl aber Zeitpläne (CPPLUS).
  // Wie in der Jeep-App: Abfahrt in ~20 min (App: unter 15 min klappt es eventuell nicht), nur heute, nicht wiederholen,
  // „über Ladezustand hinwegsetzen“. Benutzt wird ein leerer oder ausgeschalteter Platz; sein alter Inhalt wird gesichert und
  // nach der Abfahrt (+10 min) bzw. bei „Klima aus“ zurückgeschrieben – gemerkt in jeep-klima-sofort.json (übersteht Neustarts).
  async klimaPlan(vin, on, reason) {
    const ctx = this.planContext(vin), { list } = ctx, s = this.sofort?.vin === vin ? this.sofort : null;
    if (!on) {
      if (!s) { this.last = { ok: true, at: new Date(this.now()).toISOString(), reason, text: 'Klima ausschalten', state: 'unknown', message: 'Klima ausschalten: „Klima sofort“ war nicht aktiv – nichts zu tun.' }; return this.last; }
      const r = await this.sendPlans(ctx, vin, list.map((x, i) => i === s.nr - 1 ? s.backup : rawPlan(x)), 'Klima aus (Plan ' + s.nr + ' zurückgesetzt)', reason);
      this.saveSofort(null); return r;
    }
    const nr = s ? s.nr : freeSlot(list);
    if (!nr) throw fail('Kein freier Zeitplan-Platz für „Klima sofort“: alle Pläne sind eingeschaltet. Bitte einen Plan ausschalten.', 409);
    const dep = new Date(Math.ceil((this.now() + SOFORT_MS) / 300000) * 300000), time = String(dep.getHours()).padStart(2, '0') + ':' + String(dep.getMinutes()).padStart(2, '0'), day = TAGE[(dep.getDay() + 6) % 7][0];
    const mine = { enableScheduleType: true, scheduleType: 'CLIMATE', startTime: '00:00', endTime: time, chargeToFull: false, cabinPriority: true, scheduledDays: Object.fromEntries(TAGE.map(([k]) => [k, k === day])), repeatSchedule: false };
    const r = await this.sendPlans(ctx, vin, list.map((x, i) => i === nr - 1 ? mine : rawPlan(x)), 'Klima sofort (Abfahrt ' + time + ' Uhr, Plan ' + nr + ')', reason);
    this.saveSofort({ vin, nr, backup: s ? s.backup : rawPlan(list[nr - 1]), until: dep.getTime() + BACK_MS, departure: time });
    r.message += ' Das Auto heizt bzw. kühlt bis zur Abfahrt um ' + time + ' Uhr; Plan ' + nr + ' wird danach automatisch zurückgesetzt.';
    try { require('./jeep-wache').event(this.web, 'vorheizen', { vin, departure: time, reason }); } catch {} // WhatsApp „Jeep heizt vor“ (nur Automation)
    return r;
  }
  saveSofort(v) { this.sofort = v; if (!this.sofortFile) return; try { if (!v) fs.rmSync(this.sofortFile, { force: true }); else { fs.writeFileSync(this.sofortFile + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(this.sofortFile + '.tmp', this.sofortFile); } } catch {} }
  // Zeitgeber (alle 5 min, auch nach einem Neustart): „Klima sofort“ nach der Abfahrt zurücksetzen. Klappt es nicht
  // (z. B. Auto nicht verbunden), beim nächsten Lauf erneut – höchstens 5 Versuche, dann Protokollzeile und Hinweis auf der
  // Jeep-Seite statt Schleife. Nie bei gesperrter PIN (keine weiteren PIN-Versuche).
  async sofortCheck() {
    const s = this.sofort; if (!s || s.gaveUp || this.now() < s.until || this.busy || wecker(this.web).state.pinRejected) return false;
    try { await this.klimaPlan(s.vin, false, 'automatisch zurücksetzen'); return true; }
    catch (e) {
      s.tries = (s.tries || 0) + 1;
      if (s.tries >= 5 || e.pinRejected) { s.gaveUp = true; this.saveSofort(s); console.log('[jeep] Klima sofort: Plan ' + s.nr + ' konnte nicht zurückgesetzt werden (' + (e.message || 'Fehler') + ') – bitte in der Jeep-App prüfen'); try { require('./jeep-wache').event(this.web, 'gaveUp', { vin: s.vin, nr: s.nr, until: s.until }); } catch {} }
      return false;
    }
  }
  status() { const svc = this.web.jeepService; return { connected: !!svc?.connected, hasPin: !!readPin(this.web), pinRejected: wecker(this.web).state.pinRejected, vehicles: this.vehicles(), klimaSofort: this.sofort ? { nr: this.sofort.nr, departure: this.sofort.departure, until: new Date(this.sofort.until).toISOString(), gaveUp: this.sofort.gaveUp === true } : null, last: this.last }; }
}
const instances = new WeakMap(); let lastWeb = null;
// Befehl aus Apple Home (Jeep-Türschloss, jeep-schloss.js): gleicher Weg wie von Hand (PIN, 30 s Abstand, Bestätigung)
let sofortTimer = null;
function attach(web) { lastWeb = web; try { require('./jeep-schloss').start(web); } catch {} try { require('./jeep-wache').start(web); } catch { console.error('[jeep-wache] Start fehlgeschlagen (Details ausgelassen)'); } if (!sofortTimer) { sofortTimer = setInterval(() => fern(web).sofortCheck().catch(() => {}), 300000); sofortTimer.unref?.(); } } // Türstatus alle 15 min lesen
async function fromMatter(vehicleHash, lock) {
  if (!lastWeb) throw fail('Jeep-Fernsteuerung noch nicht bereit', 503);
  const f = fern(lastWeb), row = f.rows().find(r => require('./jeep-matter').vehicleId(r.vin) === vehicleHash);
  if (!row) throw fail('Fahrzeug nicht gefunden', 404);
  return f.run(row.vin, 'tueren', lock === true, 'Apple Home');
}
// „Jeep vorheizen“ aus Apple Home/Siri (Schalter in jeep-schloss.js): Ein = Klima sofort, Aus = Plan zurücksetzen
async function fromMatterKlima(vehicleHash, on) {
  if (!lastWeb) throw fail('Jeep-Fernsteuerung noch nicht bereit', 503);
  const f = fern(lastWeb), row = f.rows().find(r => require('./jeep-matter').vehicleId(r.vin) === vehicleHash);
  if (!row) throw fail('Fahrzeug nicht gefunden', 404);
  return f.run(row.vin, 'klima', on === true, 'Apple Home');
}
// Läuft „Klima sofort“ gerade für dieses Fahrzeug (bis zur Abfahrt)? true/false; null = Fernsteuerung noch nicht bereit
function sofortAktiv(vehicleHash, now = Date.now()) {
  if (!lastWeb) return null;
  const s = fern(lastWeb).sofort;
  return !!s && !s.gaveUp && require('./jeep-matter').vehicleId(s.vin) === vehicleHash && now < s.until - BACK_MS;
}
function fern(web, options) { let f = instances.get(web); if (!f) { f = new Fernsteuerung(web, options); instances.set(web, f); } return f; }

// ---------- Automationen: Klima und Motor als schaltbare Ziele „JEEP-<Fahrzeug>:<Kanal>“ ----------
const ADDRESS = /^JEEP-(\d{1,2}):(\d)$/;
function automation(web) {
  const part = address => {
    const m = ADDRESS.exec(typeof address === 'string' ? address : ''); if (!m) return null;
    const v = fern(web).vehicles().find(x => x.index === Number(m[1])), action = Object.keys(ACTIONS).find(k => ACTIONS[k].channel === Number(m[2]));
    if (!v || !action || !ACTIONS[action].automation || !v.actions[action].confirmed) return null;
    return { v, action };
  };
  const nameOf = x => x.v.name + ' ' + ACTIONS[x.action].title;
  return {
    owns: address => typeof address === 'string' && address.startsWith('JEEP-'),
    has: address => !!part(address),
    name: address => { const x = part(address); return x ? nameOf(x) : 'Jeep ' + address; },
    sources: () => [],
    targets() {
      const out = [];
      for (const v of fern(web).vehicles()) for (const [k, d] of Object.entries(ACTIONS)) if (d.automation && v.actions[k].confirmed) out.push({ address: 'JEEP-' + v.index + ':' + d.channel, name: v.name + ' ' + d.title, room: 'Jeep', switch: true, dimmer: false, thermostat: null });
      return out;
    },
    capabilities: address => part(address) ? { switch: true, dimmer: false, thermostat: null } : null,
    value: () => undefined,
    // „confirmed“ bleibt false: Uconnect nimmt den Befehl nur an, eine Rückmeldung des Fahrzeugs gibt es nicht sofort.
    async switch(address, on) { const x = part(address); if (!x) throw fail('Jeep-Funktion nicht verfügbar (nicht verbunden oder nicht freigegeben)', 409); await fern(web).run(x.v.vin, x.action, on, 'Automation'); return { confirmed: false }; },
    async dimmer() { throw fail('Jeep lässt sich nicht dimmen', 403); },
    async thermostat() { throw fail('Kein Thermostat', 403); }
  };
}

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getJeepRemote', 'runJeepRemote', 'getJeepZeitplaene', 'saveJeepZeitplan', 'setJeepSchloss'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    const f = fern(web);
    if (method === 'getJeepRemote') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, f.status()); return true; }
    if (method === 'getJeepZeitplaene') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, await f.schedules(u.searchParams.get('vin'))); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (method === 'saveJeepZeitplan') {
      if (!isObject(p) || Object.keys(p).some(k => !['vin', 'nr', 'plan'].includes(k)) || typeof p.vin !== 'string' || !VIN.test(p.vin)) throw fail('Ungültige Angaben');
      send(200, { success: true, ...(await f.saveSchedule(p.vin, p.nr, p.plan, 'von Hand')), plans: await f.schedules(p.vin) }); return true;
    }
    // Handy-Seite (Wunsch Thomas): Jeep-Türschloss per Geräteadresse jeep@<kennung>-lock bedienen
    if (method === 'setJeepSchloss') {
      if (!isObject(p) || Object.keys(p).some(k => !['address', 'lock'].includes(k)) || typeof p.address !== 'string' || typeof p.lock !== 'boolean') throw fail('Ungültige Angaben');
      const m = /^jeep@([a-f0-9]{24})-lock$/.exec(p.address); if (!m) throw fail('Ungültige Angaben');
      const row = f.rows().find(r => require('./jeep-matter').vehicleId(r.vin) === m[1]); if (!row) throw fail('Fahrzeug gehört nicht zum angemeldeten Jeep-Konto', 404);
      const r = await f.run(row.vin, 'tueren', p.lock, 'von Hand'); const S = require('./jeep-schloss'); S.hold(m[1], p.lock ? S.LOCKED : S.UNLOCKED);
      send(200, { success: true, ...r }); return true;
    }
    if (!isObject(p) || Object.keys(p).some(k => !['vin', 'action', 'on'].includes(k)) || typeof p.vin !== 'string' || !VIN.test(p.vin) || !Object.hasOwn(ACTIONS, p.action) || typeof p.on !== 'boolean') throw fail('Ungültige Angaben');
    const r = await f.run(p.vin, p.action, p.on, 'von Hand');
    send(200, { success: true, ...r, status: f.status() });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Jeep-Fernsteuerung: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, automation, attach, fromMatter, fromMatterKlima, sofortAktiv, fern, ACTIONS, _test: { fern, pairFor, services, reset: web => instances.delete(web) } };
