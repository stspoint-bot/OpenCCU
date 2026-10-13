'use strict';
// Seite „Automationen“: eigene Wenn-Dann-Regeln anlegen, ändern, testen und pausieren.
// Die Regeln laufen in der Bridge auf der CCU3 (Baustein dist/automationen.js).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, toggle, msg, task, stat, table, confirmDialog, fmtDate } = NEU;
  const main = shell({ title: 'Automationen', eyebrow: 'Eigene Programme', lead: 'Lege fest, was automatisch passieren soll: „Wenn … dann …“. Die Automationen laufen direkt auf der CCU3 – auch wenn kein Handy und kein Computer an ist.' });
  const adminNote = h('div'), stats = h('div', { class: 'stats' }), listBox = h('div'), listOut = h('p', { class: 'msg', role: 'status' });
  const editorBox = h('div'), logBox = h('div'), oldBox = h('div');
  const newBtn = h('button', { class: 'btn primary', type: 'button', text: '＋ Neue Automation' });
  const pauseAll = h('input', { type: 'checkbox', 'aria-label': 'Alle Automationen pausieren' });
  const listPanel = panel('Meine Automationen', 'Jede Automation kann einzeln pausiert und von Hand getestet werden.', h('div', { class: 'row' }, newBtn, toggle(pauseAll, 'Alle pausieren')), listOut, listBox);
  const oldDetails = h('details', { class: 'more' }, h('summary', { text: 'Bisherige Programme der Zentrale anzeigen' }), oldBox);
  // ---------- Entfeuchter (eigene Steuerung mit Duschen-Erkennung) ----------
  const ef = { enabled: h('input', { type: 'checkbox' }), light: h('select'), sensor: h('select'), sensorFallback: h('select'), actor: h('select'),
    onRh: h('input', { type: 'number', min: 30, max: 95, step: 1 }), offRh: h('input', { type: 'number', min: 25, max: 90, step: 1 }),
    useOutdoor: h('input', { type: 'checkbox' }), outdoorSensor: h('select'), onDelta: h('input', { type: 'number', min: 0.5, max: 15, step: 0.5 }), offDelta: h('input', { type: 'number', min: 0, max: 10, step: 0.5 }),
    minOnMin: h('input', { type: 'number', min: 0, max: 120, step: 1 }), minOffMin: h('input', { type: 'number', min: 0, max: 120, step: 1 }), maxOnMin: h('input', { type: 'number', min: 10, max: 720, step: 5 }),
    note: h('input', { type: 'text', maxlength: 200, placeholder: 'z. B. ersetzt CCU-Programm „Bad-Entfeuchter 1“' }) };
  const efSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), efOut = h('p', { class: 'msg', role: 'status' }), efNow = h('div', { class: 'stats' }), efLog = h('div');
  let efSettings = null;
  // Wie „Bisherige Programme der Zentrale“: Überschrift (mit Bemerkung und Zustand) bleibt stehen, Einstellungen zum Aufklappen (Zustand wird gemerkt).
  const efNote = h('span', { class: 'ef-note' }), efTag = h('span', { class: 'tag' });
  const efBox = h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {},
    h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(ef.enabled, 'Entfeuchter-Steuerung eingeschaltet')), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', ef.note)),
      field('Licht (Bedingung)', ef.light), field('Feuchtefühler im Bad', ef.sensor), field('Ersatzfühler', ef.sensorFallback, 'Gilt, wenn der Feuchtefühler nichts liefert (z. B. WLAN-Fühler offline oder Cloud-Zugang abgelaufen).'), field('Entfeuchter (Steckdose)', ef.actor),
      field('Einschalten ab (% Luftfeuchte)', ef.onRh), field('Ausschalten unter (% Luftfeuchte)', ef.offRh),
      h('div', { class: 'wide' }, check('Duschen über die Außenfeuchte erkennen', ef.useOutdoor)),
      field('Außenfühler', ef.outdoorSensor, 'Ein WLAN-Fühler draußen. Ist er nicht erreichbar, nimmt die Steuerung das Wetter von Open-Meteo.'),
      field('Duschen erkannt ab (g/m³ feuchter als draußen)', ef.onDelta, 'Normale Raumluft liegt etwa 2–3 g/m³ über draußen.'), field('Trocken unter (g/m³ über draußen)', ef.offDelta),
      field('Mindestlaufzeit (Minuten)', ef.minOnMin), field('Mindestpause (Minuten)', ef.minOffMin), field('Höchstlaufzeit am Stück (Minuten)', ef.maxOnMin)),
    h('div', { class: 'actions' }, efSave), efOut, efNow, h('details', { class: 'more' }, h('summary', { text: 'Letzte Schaltungen' }), efLog)));
  try { efBox.open = localStorage.getItem('ef-offen') === '1'; } catch {}
  efBox.addEventListener('toggle', () => { try { localStorage.setItem('ef-offen', efBox.open ? '1' : '0'); } catch {} });
  const efPanel = panel('Entfeuchter (Bad)', 'Licht an und feucht → Entfeuchter an; trocken → aus; bei Licht aus geht er nie an. „Duschen erkennen“ vergleicht die absolute Feuchte im Bad (g/m³) mit der Außenluft – das erkennt Duschen auch, wenn der %-Wert noch nicht hoch ist.', efBox);
  efPanel.querySelector('h2').append(efNote, ' ', efTag);
  // Batterie-Wächter: Aussehen wie „Bisherige Programme der Zentrale“, Bemerkung in der Überschrift.
  const bw = { enabled: h('input', { type: 'checkbox' }), time: h('input', { type: 'time' }), note: h('input', { type: 'text', maxlength: 200, placeholder: 'z. B. Ersatzbatterien im Keller' }) };
  const bwSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), bwRun = h('button', { class: 'btn', type: 'button', text: 'Jetzt prüfen und WhatsApp senden' }), bwOut = h('p', { class: 'msg', role: 'status' }), bwNow = h('div'), bwLog = h('div');
  const bwNote = h('span', { class: 'ef-note' }), bwTag = h('span', { class: 'tag' });
  const bwPanel = panel('Batterie-Wächter', 'Prüft alle Geräte mit Batterie. Ist eine Batterie schwach, kommt einmal am Tag zur gewählten Uhrzeit eine WhatsApp-Nachricht (Nummer und Schlüssel unter System → „Benachrichtigungen“). Ein Gerät wird erst nach 7 Tagen erneut gemeldet.', bwNow,
    h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {},
      h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(bw.enabled, 'Batterie-Wächter eingeschaltet')), field('Uhrzeit der täglichen Prüfung', bw.time), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', bw.note))),
      h('div', { class: 'actions' }, bwSave, bwRun), bwOut, h('details', { class: 'more' }, h('summary', { text: 'Letzte Nachrichten' }), bwLog))));
  bwPanel.querySelector('h2').append(bwNote, ' ', bwTag);
  // Jeep-Laden: Aussehen wie „Bisherige Programme der Zentrale“, Bemerkung in der Überschrift; Ladungen und Monatsverbrauch.
  const jl = { enabled: h('input', { type: 'checkbox' }), notify: h('input', { type: 'checkbox' }), socket: h('select', { 'aria-label': 'Jeep-Steckdose' }),
    stopBelowW: h('input', { type: 'number', min: 1, max: 3000, step: 10 }), stopAfterMin: h('input', { type: 'number', min: 1, max: 60, step: 1 }),
    startTimeoutSec: h('input', { type: 'number', min: 30, max: 600, step: 10 }), startW: h('input', { type: 'number', min: 1, max: 500, step: 1 }),
    retries: h('input', { type: 'number', min: 0, max: 3, step: 1 }), retryWaitSec: h('input', { type: 'number', min: 10, max: 300, step: 10 }),
    stopAtPercent: h('input', { type: 'number', min: 0, max: 100, step: 1 }), priceEur: h('input', { type: 'number', min: 0, max: 5, step: 0.0001 }), akkuKWh: h('input', { type: 'number', min: 3, max: 30, step: 0.1 }),
    note: h('input', { type: 'text', maxlength: 200, placeholder: 'z. B. ersetzt die alten CCU-Programme „Jeep …“' }),
    autoOn: h('input', { type: 'checkbox' }), awayOff: h('input', { type: 'checkbox' }), faultOn: h('input', { type: 'checkbox' }), radiusM: h('input', { type: 'number', min: 30, max: 2000, step: 10 }) };
  // Ladeplatz (Wunsch Thomas): aktueller Jeep-Standort ± Umkreis; eingesteckt dort → an, Jeep weg → aus
  const jlHome = h('p', { class: 'muted' }), jlHomeBtn = h('button', { class: 'btn small', type: 'button', text: '📍 Aktuellen Jeep-Standort als Ladeplatz übernehmen' });
  jlHomeBtn.addEventListener('click', () => task(jlHomeBtn, jlOut, async () => { const r = await api('setJeepLadeplatz', {}); jlShow(r); return r.message; }, 'Standort wird bei Uconnect gelesen …'));
  const jlSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), jlOut = h('p', { class: 'msg', role: 'status' }), jlNow = h('div', { class: 'stats' }), jlMonths = h('div'), jlSessions = h('div'), jlLog = h('div');
  const jlNote = h('span', { class: 'ef-note' }), jlTag = h('span', { class: 'tag' });
  const jlNum = ['stopBelowW', 'stopAfterMin', 'startTimeoutSec', 'startW', 'retries', 'retryWaitSec', 'stopAtPercent', 'priceEur', 'akkuKWh'];
  const jlPanel = panel('Jeep laden', 'Steckdose an → WhatsApp „Ladung beginnt“. Fließt innerhalb der Wartezeit kein Strom, gibt es einen neuen Versuch (aus, Pause, wieder an); bleibt es ohne Strom, geht sie aus. Beim Laden: Leistung länger unter der Grenze oder Akku 100 % → aus, mit WhatsApp über die geladenen kWh. Der Zähler der Steckdose ergibt den Monatsverbrauch.', jlNow,
    h('details', { class: 'more', open: true }, h('summary', { text: 'Monatsverbrauch (Diagramm)' }), jlMonths),
    h('details', { class: 'more', open: true }, h('summary', { text: 'Ladungen (Diagramm)' }), jlSessions),
    h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {},
      h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(jl.enabled, 'Ladesteuerung schaltet die Steckdose')), h('div', { class: 'wide' }, check('WhatsApp-Nachrichten senden', jl.notify)),        h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', jl.note)), field('Jeep-Steckdose (Tasmota mit Strommessung)', jl.socket),
        field('Ausschalten unter (W)', jl.stopBelowW, 'Ladeleistung, unter der die Ladung als beendet gilt.'), field('… wenn so lange darunter (Minuten)', jl.stopAfterMin),
        field('Wartezeit auf Strom nach dem Einschalten (Sekunden)', jl.startTimeoutSec), field('Strom fließt ab (W)', jl.startW),
        field('Neue Versuche, wenn kein Strom fließt (0–3)', jl.retries, 'Steckdose aus, Pause, wieder an. Beim neuen Versuch doppelte Wartezeit (mind. 2 Minuten). Nicht, wenn der Akku voll ist.'), field('Pause vor dem neuen Versuch (Sekunden)', jl.retryWaitSec),
        field('Ausschalten bei Akkustand (%; 0 = nie)', jl.stopAtPercent, 'Zählt nur mit einer Fahrzeugmeldung nach dem Einschalten.'), field('Strompreis (€/kWh)', jl.priceEur), field('Nutzbare Akkukapazität (kWh, geschätzt)', jl.akkuKWh, 'Der Jeep meldet nur den Akkustand in %, keine kWh. Compass 4xe: 11,4 kWh brutto, ca. 9,1 kWh nutzbar. Daraus werden „Im Akku“ und der Wirkungsgrad geschätzt.'),
        h('div', { class: 'wide' }, h('h3', { text: 'Ladeplatz' }), jlHome, jlHomeBtn),
        h('div', { class: 'wide' }, check('Automatisch einschalten, wenn der Jeep am Ladeplatz steht und „Ladekabel eingesteckt“ meldet (einmal je Einstecken)', jl.autoOn)),
        h('div', { class: 'wide' }, check('Ausschalten, wenn der Jeep nicht mehr am Ladeplatz steht', jl.awayOff)),
        h('div', { class: 'wide' }, check('Einschalten, wenn der Jeep am Ladeplatz einen Ladefehler meldet (Meldung höchstens 30 Minuten alt, einmal je Ladefehler)', jl.faultOn)), field('Umkreis um den Ladeplatz (m)', jl.radiusM, '30 bis 2000 m. Uconnect meldet den Standort nur, wenn das Auto Daten schickt.')),
      h('div', { class: 'actions' }, jlSave), jlOut, h('details', { class: 'more' }, h('summary', { text: 'Letzte Ereignisse' }), jlLog))));
  jlPanel.querySelector('h2').append(jlNote, ' ', jlTag);
  // Gang-Licht nach Bad: eigener Block (gleiche Regel wie in den Automationen, gespeichert über saveAutomation).
  // Vorschlag ohne feste Geräteadressen (läuft auf jeder CCU3): Gerät, dessen Name oder Raum passt – sonst leer.
  const BAD_RE = /\bbad\b|badezimmer/i, GANG_RE = /gang|flur|diele/i;
  const guess = (list, re) => (list.find(x => re.test(x.name || '') && re.test(x.room || '')) || list.find(x => re.test((x.name || '') + ' ' + (x.room || ''))))?.address || '';
  const GANG = 'Gang-Licht nach Bad', GANG_AUS = 'Ganglicht aus bei Badlicht an';
  const gl = { enabled: h('input', { type: 'checkbox' }), dark: h('input', { type: 'checkbox' }), off: h('input', { type: 'checkbox' }), from: h('select', { 'aria-label': 'Badlicht' }), to: h('select', { 'aria-label': 'Ganglicht' }),
    dur: h('input', { type: 'number', min: 1, max: 3600, step: 1, inputmode: 'numeric' }), note: h('input', { type: 'text', maxlength: 200, placeholder: 'z. B. nur nachts' }) };
  const glSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), glOut = h('p', { class: 'msg', role: 'status' }), glNow = h('p', { class: 'muted' });
  const glNote = h('span', { class: 'ef-note' }), glTag = h('span', { class: 'tag' });
  const glBox = h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {},
    h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(gl.enabled, 'Gang-Licht nach Bad eingeschaltet')), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', gl.note)),
      field('Badlicht (wenn es ausgeht …)', gl.from), field('Ganglicht (… geht dieses an)', gl.to), field('Wie lange an (Sekunden, frei eingeben)', gl.dur, 'Sekundengenau, 1 bis 3600. Danach geht es automatisch wieder aus.'),
      h('div', { class: 'wide' }, check('Nur wenn es dunkel ist (nach Sonnenuntergang bis Sonnenaufgang)', gl.dark)),
      h('div', { class: 'wide' }, check('Ganglicht ausschalten, wenn das Badlicht angeht (nur wenn das Ganglicht an ist)', gl.off))),
    h('div', { class: 'actions' }, glSave), glOut));
  const glPanel = panel('Gang-Licht nach Bad', 'Geht das Licht im Bad aus, schaltet das Ganglicht für die eingestellte Zeit ein und danach automatisch wieder aus. Geht das Badlicht an, wird ein eingeschaltetes Ganglicht ausgeschaltet. Der Bad-Schalter selbst schaltet das Badlicht direkt (ohne Zentrale).', glNow, glBox);
  glPanel.querySelector('h2').append(glNote, ' ', glTag);
  let glFilled = false;
  const glRule = () => data.rules.find(r => r.name === GANG) || null, glOffRule = () => data.rules.find(r => r.name === GANG_AUS) || null;
  function glShow() {
    const r = glRule(), a = r?.actions?.[0], dark = !!r?.conditions?.some(c => c.type === 'sun' && c.when === 'dark');
    glNote.textContent = r?.note ? ' – ' + r.note : ''; glTag.className = 'tag ' + (r?.enabled ? 'ok' : ''); glTag.textContent = r ? (r.enabled ? 'aktiv' : 'aus') : 'nicht angelegt';
    const st = r?.status || {};
    glNow.textContent = r ? 'Zuletzt: ' + (st.lastRun ? new Date(st.lastRun).toLocaleString('de-DE') : '–') + (st.lastResult ? ' · ' + st.lastResult : '') + (st.missing ? ' · ⚠ ' + st.missing : '') : 'Noch nicht eingerichtet – unter „Einstellungen anzeigen“ Geräte wählen und speichern.';
    if (glFilled && glBox.open) return; // beim Bearbeiten nichts überschreiben
    const lights = [...new Map(cat.sources.filter(x => x.kind === 'bool' && x.key === 'STATE').map(x => [x.address, x])).values()], targets = cat.targets.filter(x => x.switch);
    const opt = (sel, list, value, empty) => { sel.replaceChildren(h('option', { value: '', text: empty }), ...list.map(x => h('option', { value: x.address, text: (x.room ? x.room + ' · ' : '') + x.name + ' (' + x.address + ')' }))); sel.value = value || ''; };
    opt(gl.from, lights, r?.trigger?.address || guess(lights, BAD_RE), '– Badlicht wählen –'); opt(gl.to, targets, a?.address || guess(targets, GANG_RE), '– Ganglicht wählen –');
    gl.enabled.checked = r ? r.enabled : true; gl.dark.checked = r ? dark : true; gl.dur.value = a?.duration || 60; gl.note.value = r?.note || ''; gl.off.checked = r ? !!glOffRule()?.enabled : true;
    glFilled = cat.sources.length > 0;
  }
  glSave.addEventListener('click', () => task(glSave, glOut, async () => {
    const r = glRule(), dur = Number(gl.dur.value);
    if (!gl.from.value || !gl.to.value) throw Error('Bitte Badlicht und Ganglicht wählen.');
    if (!Number.isInteger(dur) || dur < 1 || dur > 3600) throw Error('Dauer: ganze Sekunden von 1 bis 3600 eingeben.');
    const rule = { ...(r ? { id: r.id } : {}), name: GANG, ...(gl.note.value.trim() ? { note: gl.note.value.trim() } : {}), enabled: gl.enabled.checked,
      trigger: { type: 'device', address: gl.from.value, key: 'STATE', op: 'off' }, conditions: gl.dark.checked ? [{ type: 'sun', when: 'dark' }] : [],
      actions: [{ type: 'switch', address: gl.to.value, on: true, duration: dur }] };
    let res = await api('saveAutomation', { rule });
    // Zweite Regel: Badlicht an → Ganglicht aus (nur wenn es an ist, spart Funkbefehle)
    const o = glOffRule();
    if (gl.off.checked) res = await api('saveAutomation', { rule: { ...(o ? { id: o.id } : {}), name: GANG_AUS, enabled: gl.enabled.checked, trigger: { type: 'device', address: gl.from.value, key: 'STATE', op: 'on' }, conditions: [{ type: 'device', address: gl.to.value, key: 'STATE', op: 'on' }], actions: [{ type: 'switch', address: gl.to.value, on: false }] } });
    else if (o) res = await api('deleteAutomation', { id: o.id });
    data = res; glFilled = false; renderList(); return 'Gespeichert.';
  }, 'Wird gespeichert …'));
  // Bad-Schalter und Gang-Bewegungsmelder: eigene Blöcke; dahinter normale Regeln mit festen Namen (in der Liste ausgeblendet).
  const BAD_T = ['Bad-Taste 1: Badlicht umschalten', 'Bad-Taste 2: Badlicht umschalten'], GANG_T = ['Gang-Taste 1: Ganglicht umschalten', 'Gang-Taste 2: Ganglicht umschalten'], GANG_B = 'Gang-Bewegung: Ganglicht 90 s';
  const BAD_B = 'Bad-Bewegung: Badlicht ein', GANG_W = 'Gang-Wandschalter: Ganglicht aus nach Zeit', GANG_WL = 'Gang-Wandschalter (lang): Ganglicht aus nach Zeit';
  const BLOCK_NAMES = new Set([...BAD_T, ...GANG_T, GANG_B, BAD_B, GANG_W, GANG_WL]);
  // Quelle eines Geräts mit bestimmter Rückmeldung (z. B. Bewegung am Tasten-Gerät, Wandschalter-Eingang am Lichtaktor)
  const sourceOf = (device, key) => cat.sources.find(s => deviceOf(s.address) === device && s.key === key)?.address || '';
  const findRule = n => data.rules.find(r => r.name === n) || null;
  const devOptions = (sel, list, value, empty) => { sel.replaceChildren(h('option', { value: '', text: empty }), ...list.map(x => h('option', { value: x.address, text: (x.room ? x.room + ' · ' : '') + x.name + ' (' + x.address + ')' }))); sel.value = value || ''; };
  const deviceOf = a => String(a || '').split(':')[0];
  // Tasten-Geräte: Quellen mit Taste kurz gedrückt, je Gerät einmal (Kanal 1 und 2 gehören zusammen)
  const keyDevices = () => [...new Map(cat.sources.filter(x => x.key === 'PRESS_SHORT').map(x => [deviceOf(x.address), { address: deviceOf(x.address), name: x.name.replace(/:\d+$/, ''), room: x.room }])).values()];
  async function saveRules(list) { let res = null; for (const [name, rule] of list) { const old = findRule(name); res = rule ? await api('saveAutomation', { rule: { ...(old ? { id: old.id } : {}), name, ...rule } }) : old ? await api('deleteAutomation', { id: old.id }) : res; if (res) data = res; } return res; }
  function block(title, sub, fields, onSave) {
    const save = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), out = h('p', { class: 'msg', role: 'status' }), now = h('p', { class: 'muted' }), note = h('span', { class: 'ef-note' }), tag = h('span', { class: 'tag' });
    const box = h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {}, h('div', { class: 'form' }, fields), h('div', { class: 'actions' }, save), out));
    const p = panel(title, sub, now, box); p.querySelector('h2').append(note, ' ', tag);
    save.addEventListener('click', () => task(save, out, async () => { await onSave(); renderList(); return 'Gespeichert.'; }, 'Wird gespeichert …'));
    return { panel: p, box, now, note, tag, filled: false };
  }
  const head = (b, r, text) => { b.note.textContent = r?.note ? ' – ' + r.note : ''; b.tag.className = 'tag ' + (r?.enabled ? 'ok' : ''); b.tag.textContent = r ? (r.enabled ? 'aktiv' : 'aus') : 'nicht eingerichtet'; const st = r?.status || {}; b.now.textContent = r ? text + ' · zuletzt: ' + (st.lastRun ? new Date(st.lastRun).toLocaleString('de-DE') : '–') + (st.missing ? ' · ⚠ ' + st.missing : '') : 'Noch nicht eingerichtet.'; };
  // Bad-Schalter
  const bs = { enabled: h('input', { type: 'checkbox' }), keys: h('select', { 'aria-label': 'Tasten' }), light: h('select', { 'aria-label': 'Badlicht' }), motion: h('input', { type: 'checkbox' }), motionMin: h('input', { type: 'number', min: 0, max: 120, step: 1, inputmode: 'numeric' }), note: h('input', { type: 'text', maxlength: 200 }) };
  const bsB = block('Bad-Schalter', 'Ein Druck auf eine Taste am Bad-Bewegungsmelder schaltet das Badlicht um (an ↔ aus). Auf Wunsch schaltet Bewegung das Badlicht ein.',
    [h('div', { class: 'wide' }, toggle(bs.enabled, 'Bad-Schalter eingeschaltet')), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', bs.note)), field('Tasten (Gerät)', bs.keys), field('Badlicht', bs.light),
      h('div', { class: 'wide' }, check('Bewegung am selben Gerät schaltet das Badlicht ein', bs.motion)),
      field('Nach Bewegung: Badlicht nach … Minuten aus', bs.motionMin, 'Jede neue Bewegung startet die Zeit neu. 0 = bleibt an.')],
    async () => {
      if (!bs.keys.value || !bs.light.value) throw Error('Bitte Tasten und Badlicht wählen.');
      const note = bs.note.value.trim() ? { note: bs.note.value.trim() } : {}, mot = sourceOf(bs.keys.value, 'MOTION');
      if (bs.motion.checked && !mot) throw Error('Das gewählte Tasten-Gerät hat keinen Bewegungsmelder.');
      const mm = Number(bs.motionMin.value || 0); if (!Number.isInteger(mm) || mm < 0 || mm > 120) throw Error('Minuten: ganze Zahl von 0 bis 120 eingeben.');
      await saveRules([...BAD_T.map((n, i) => [n, { ...note, enabled: bs.enabled.checked, trigger: { type: 'device', address: bs.keys.value + ':' + (i + 1), key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'toggle', address: bs.light.value }] }]),
        [BAD_B, bs.motion.checked ? { ...note, enabled: bs.enabled.checked, trigger: { type: 'device', address: mot, key: 'MOTION', op: 'on' }, conditions: [], actions: [{ type: 'switch', address: bs.light.value, on: true, ...(mm > 0 ? { duration: mm * 60 } : {}) }] } : null]]);
      bsB.filled = false;
    });
  function bsShow() {
    const r = findRule(BAD_T[0]); head(bsB, r, r ? 'Tasten ' + deviceOf(r.trigger.address) + ' → „' + nameOf(r.actions[0].address) + '“ umschalten' : '');
    if (bsB.filled && bsB.box.open) return;
    const kd = keyDevices(), sw = cat.targets.filter(x => x.switch);
    devOptions(bs.keys, kd, r ? deviceOf(r.trigger.address) : guess(kd, BAD_RE), '– Tasten wählen –'); devOptions(bs.light, sw, r?.actions[0]?.address || guess(sw, BAD_RE), '– Badlicht wählen –');
    bs.enabled.checked = r ? r.enabled : true; bs.note.value = r?.note || ''; bs.motion.checked = !!findRule(BAD_B); bs.motionMin.value = Math.round((findRule(BAD_B)?.actions?.[0]?.duration || 0) / 60); bsB.filled = cat.targets.length > 0;
  }
  // Gang-Bewegungsmelder
  const gb = { enabled: h('input', { type: 'checkbox' }), sensor: h('select', { 'aria-label': 'Bewegungsmelder' }), light: h('select', { 'aria-label': 'Ganglicht' }), dur: h('input', { type: 'number', min: 1, max: 3600, step: 1, inputmode: 'numeric' }), keys: h('input', { type: 'checkbox' }), wall: h('input', { type: 'number', min: 0, max: 60, step: 1, inputmode: 'numeric' }), note: h('input', { type: 'text', maxlength: 200 }) };
  const gbB = block('Gang-Bewegungsmelder', 'Bewegung im Gang → Ganglicht für die eingestellte Zeit an, danach automatisch aus. Die Tasten am Bewegungsmelder schalten das Ganglicht um.',
    [h('div', { class: 'wide' }, toggle(gb.enabled, 'Gang-Bewegungsmelder eingeschaltet')), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', gb.note)), field('Bewegungsmelder (Gerät)', gb.sensor), field('Ganglicht', gb.light),
      field('Wie lange an bei Bewegung (Sekunden)', gb.dur, 'Sekundengenau, 1 bis 3600.'), h('div', { class: 'wide' }, check('Tasten am Bewegungsmelder schalten das Ganglicht um', gb.keys)),
      field('Wandschalter: Ganglicht nach … Minuten aus', gb.wall, 'Gilt nur für die Schalter am Eingang des Lichtaktors (nicht für den Bewegungsmelder). 0 = nicht automatisch aus.')],
    async () => {
      const dur = Number(gb.dur.value), wallMin = Number(gb.wall.value || 0);
      if (!gb.sensor.value || !gb.light.value) throw Error('Bitte Bewegungsmelder und Ganglicht wählen.');
      if (!Number.isInteger(dur) || dur < 1 || dur > 3600) throw Error('Dauer: ganze Sekunden von 1 bis 3600 eingeben.');
      if (!Number.isInteger(wallMin) || wallMin < 0 || wallMin > 60) throw Error('Wandschalter: ganze Minuten von 0 bis 60 eingeben.');
      const wallSrc = sourceOf(deviceOf(gb.light.value), 'PRESS_SHORT');
      if (wallMin > 0 && !wallSrc) throw Error('Am gewählten Ganglicht ist kein Wandschalter-Eingang gefunden worden.');
      const note = gb.note.value.trim() ? { note: gb.note.value.trim() } : {}, on = gb.enabled.checked;
      // Nur der fest verdrahtete Schalter-Eingang am Lichtaktor startet die Minuten-Zeit; Bewegung und Funk haben eigene Regeln.
      const wallRule = wallMin > 0 ? { ...note, enabled: on, trigger: { type: 'device', address: wallSrc, key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'switch', address: gb.light.value, on: false, delay: wallMin * 60 }] } : null;
      await saveRules([[GANG_W, wallRule], [GANG_WL, null], [GANG_B, { ...note, enabled: on, trigger: { type: 'device', address: gb.sensor.value, key: 'MOTION', op: 'on' }, conditions: [], actions: [{ type: 'switch', address: gb.light.value, on: true, duration: dur }] }],
        ...GANG_T.map((n, i) => [n, gb.keys.checked ? { ...note, enabled: on, trigger: { type: 'device', address: deviceOf(gb.sensor.value) + ':' + (i + 1), key: 'PRESS_SHORT', op: 'event' }, conditions: [], actions: [{ type: 'toggle', address: gb.light.value }] } : null])]);
      gbB.filled = false;
    });
  function gbShow() {
    const r = findRule(GANG_B), a = r?.actions?.[0];
    head(gbB, r, r ? 'Bewegung → „' + nameOf(a.address) + '“ ' + (a.duration || 0) + ' s an' + (findRule(GANG_T[0]) ? ' · Tasten schalten um' : '') : '');
    if (gbB.filled && gbB.box.open) return;
    const sensors = [...new Map(cat.sources.filter(x => x.key === 'MOTION').map(x => [x.address, x])).values()];
    const gsw = cat.targets.filter(x => x.switch);
    devOptions(gb.sensor, sensors, r ? r.trigger.address : guess(sensors, GANG_RE), '– Bewegungsmelder wählen –'); devOptions(gb.light, gsw, a?.address || guess(gsw, GANG_RE), '– Ganglicht wählen –');
    const w = findRule(GANG_W); gb.wall.value = w ? Math.round((w.actions[0]?.delay || 0) / 60) : 0;
    gb.enabled.checked = r ? r.enabled : true; gb.dur.value = a?.duration || 90; gb.keys.checked = r ? !!findRule(GANG_T[0]) : true; gb.note.value = r?.note || ''; gbB.filled = cat.targets.length > 0;
  }
  // Sony laden: alle N Tage zur Uhrzeit für M Minuten an, danach automatisch aus (Regel „Sony laden“).
  const SONY = 'Sony laden';
  const sy = { enabled: h('input', { type: 'checkbox' }), target: h('select', { 'aria-label': 'Steckdose' }), every: h('input', { type: 'number', min: 1, max: 365, step: 1, inputmode: 'numeric' }),
    time: h('input', { type: 'time' }), minutes: h('input', { type: 'number', min: 1, max: 1440, step: 1, inputmode: 'numeric' }), note: h('input', { type: 'text', maxlength: 200, placeholder: 'z. B. Akku der Sony-Box' }) };
  const sySave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), syOut = h('p', { class: 'msg', role: 'status' }), syNow = h('p', { class: 'muted' });
  const syNote = h('span', { class: 'ef-note' }), syTag = h('span', { class: 'tag' });
  const syBox = h('details', { class: 'more' }, h('summary', { text: 'Einstellungen anzeigen' }), h('div', {},
    h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(sy.enabled, 'Sony laden eingeschaltet')), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Überschrift)', sy.note)),
      field('Steckdose', sy.target), field('Alle wie viele Tage', sy.every, '1 = jeden Tag'), field('Uhrzeit', sy.time), field('Wie lange an (Minuten)', sy.minutes, 'Danach geht die Steckdose automatisch aus.')),
    h('div', { class: 'actions' }, sySave), syOut));
  const syPanel = panel('Sony laden', 'Schaltet die Steckdose alle paar Tage zur gewählten Uhrzeit für die eingestellten Minuten ein und danach automatisch wieder aus.', syNow, syBox);
  syPanel.querySelector('h2').append(syNote, ' ', syTag);
  let syFilled = false;
  const syRule = () => data.rules.find(r => r.name === SONY) || null;
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function syShow() {
    const r = syRule(), a = r?.actions?.[0], t = r?.trigger, st = r?.status || {};
    syNote.textContent = r?.note ? ' – ' + r.note : ''; syTag.className = 'tag ' + (r?.enabled ? 'ok' : ''); syTag.textContent = r ? (r.enabled ? 'aktiv' : 'aus') : 'nicht eingerichtet';
    syNow.textContent = r ? `Alle ${t.everyDays} Tage um ${t.time} Uhr für ${Math.round((a?.duration || 0) / 60)} Minuten · zuletzt: ${st.lastRun ? new Date(st.lastRun).toLocaleString('de-DE') : '–'}${st.missing ? ' · ⚠ ' + st.missing : ''}` : 'Noch nicht eingerichtet – unter „Einstellungen anzeigen“ Tage, Uhrzeit und Minuten eintragen.';
    if (syFilled && syBox.open) return;
    const targets = cat.targets.filter(x => x.switch);
    sy.target.replaceChildren(h('option', { value: '', text: '– Steckdose wählen –' }), ...targets.map(x => h('option', { value: x.address, text: (x.room ? x.room + ' · ' : '') + x.name + ' (' + x.address + ')' })));
    sy.target.value = a?.address || (targets.find(x => /sony/i.test(x.name))?.address || '');
    sy.enabled.checked = r ? r.enabled : true; sy.every.value = t?.everyDays || ''; sy.time.value = t?.time || '18:45'; sy.minutes.value = a?.duration ? Math.round(a.duration / 60) : ''; sy.note.value = r?.note || '';
    syFilled = cat.targets.length > 0;
  }
  sySave.addEventListener('click', () => task(sySave, syOut, async () => {
    const r = syRule(), every = Number(sy.every.value), minutes = Number(sy.minutes.value);
    if (!sy.target.value) throw Error('Bitte die Steckdose wählen.');
    if (!Number.isInteger(every) || every < 1 || every > 365) throw Error('Alle wie viele Tage: 1 bis 365.');
    if (!/^\d\d:\d\d$/.test(sy.time.value)) throw Error('Bitte eine Uhrzeit eingeben.');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw Error('Minuten: 1 bis 1440.');
    const keepStart = r?.trigger?.everyDays === every ? r.trigger.startDate : today();
    const rule = { ...(r ? { id: r.id } : {}), name: SONY, ...(sy.note.value.trim() ? { note: sy.note.value.trim() } : {}), enabled: sy.enabled.checked,
      trigger: { type: 'time', time: sy.time.value, everyDays: every, startDate: keepStart }, conditions: [], actions: [{ type: 'switch', address: sy.target.value, on: true, duration: minutes * 60 }] };
    const res = await api('saveAutomation', { rule }); data = res; syFilled = false; renderList(); return `Gespeichert: alle ${every} ${every === 1 ? 'Tag' : 'Tage'} um ${sy.time.value} Uhr für ${minutes} Minuten (gezählt ab ${new Date(keepStart + 'T00:00:00').toLocaleDateString('de-DE')}).`;
  }, 'Wird gespeichert …'));
  const kw = v => v === null || v === undefined ? '–' : Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Ladungen als Säulen: kWh aus der Steckdose (Tasmota), darin heller die geschätzten kWh im Akku; Kosten darüber; letzte 15 Ladungen
  function jlChargeChart(sessions) {
    const list = sessions.filter(x => Number.isFinite(x.kWh) && x.kWh > 0).slice(0, 15).reverse(); if (!list.length) return null;
    const ns = 'http://www.w3.org/2000/svg', el = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt !== undefined) e.textContent = txt; return e; };
    const W = 720, H = 240, L = 44, R = 10, T = 30, B = 34, max = Math.max(...list.map(x => x.kWh), 1), step = (W - L - R) / list.length, bw = Math.min(40, step * 0.62);
    const y = v => T + (1 - v / max) * (H - T - B), svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Jeep Ladungen: Energie und Kosten', style: 'width:100%;height:auto' });
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: '#e3e9e6' }), el('text', { x: L - 6, y: yy + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#738487' }, v.toLocaleString('de-DE', { maximumFractionDigits: 1 }))); }
    svg.append(el('text', { x: L - 6, y: T - 14, 'text-anchor': 'end', 'font-size': 10, fill: '#738487' }, 'kWh'));
    list.forEach((x, i) => {
      const cx = L + step * i + step / 2, top = y(x.kWh), d = new Date(x.start), bat = Number.isFinite(x.batteryKWh) ? Math.min(x.batteryKWh, x.kWh) : null;
      const bar = el('rect', { x: cx - bw / 2, y: top, width: bw, height: Math.max(0, H - B - top), rx: 3, fill: '#176c60' });
      bar.append(el('title', {}, d.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + ': ' + kw(x.kWh) + ' kWh aus der Steckdose' + (bat !== null ? ', ≈ ' + kw(bat) + ' kWh im Akku (geschätzt)' : '') + (Number.isFinite(x.socStart) && Number.isFinite(x.socEnd) ? ', Akku ' + x.socStart + ' % → ' + x.socEnd + ' %' : '') + (x.costEur !== null && x.costEur !== undefined ? ', ' + kw(x.costEur) + ' €' : '')));
      svg.append(bar);
      if (bat !== null) svg.append(el('rect', { x: cx - bw / 2 + 4, y: y(bat), width: Math.max(2, bw - 8), height: Math.max(0, H - B - y(bat)), rx: 2, fill: '#8fc3b9' }));
      if (x.costEur !== null && x.costEur !== undefined) svg.append(el('text', { x: cx, y: top - 4, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 600, fill: '#176c60' }, kw(x.costEur) + ' €'));
      svg.append(el('text', { x: cx, y: H - 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#738487' }, d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })));
    });
    const sum = list.reduce((a, x) => a + x.kWh, 0), cost = list.reduce((a, x) => a + (x.costEur || 0), 0);
    return h('div', { class: 'card', style: 'margin-bottom:12px' }, h('div', { class: 'card-head' }, h('b', { text: 'Ladungen: Energie und Kosten' }), h('span', { class: 'muted', text: list.length + (list.length === 1 ? ' Ladung' : ' Ladungen') + ': ' + kw(sum) + ' kWh · ' + kw(cost) + ' €' })), svg,
      h('p', { class: 'muted', text: 'Dunkel: aus der Steckdose (Tasmota, gemessen). Hell: davon im Akku angekommen (geschätzt aus dem Akkustand des Jeep). Über der Säule die Kosten. Mit der Maus auf eine Säule zeigen für Details.' }));
  }
  // Monatsverbrauch als Säulen (kWh), Kosten darüber; letzte 12 Monate, laufender Monat heller (eigene SVG-Grafik wie „Diagramme“)
  function jlChart(months) {
    const list = months.slice(0, 12).reverse(); if (!list.length) return null;
    const ns = 'http://www.w3.org/2000/svg', el = (t, a, txt) => { const e = document.createElementNS(ns, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt !== undefined) e.textContent = txt; return e; };
    const W = 720, H = 240, L = 44, R = 10, T = 30, B = 34, max = Math.max(...list.map(m => m.kWh), 1), step = (W - L - R) / list.length, bw = Math.min(46, step * 0.62), cur = new Date().toISOString().slice(0, 7);
    const y = v => T + (1 - v / max) * (H - T - B), svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Jeep Monatsverbrauch und Kosten', style: 'width:100%;height:auto' });
    for (let i = 0; i <= 4; i++) { const v = max * i / 4, yy = y(v); svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: '#e3e9e6' }), el('text', { x: L - 6, y: yy + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#738487' }, v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 }))); }
    svg.append(el('text', { x: L - 6, y: T - 14, 'text-anchor': 'end', 'font-size': 10, fill: '#738487' }, 'kWh'));
    list.forEach((m, i) => {
      const cx = L + step * i + step / 2, top = y(m.kWh), running = m.month === cur;
      svg.append(el('rect', { x: cx - bw / 2, y: top, width: bw, height: Math.max(0, H - B - top), rx: 3, fill: running ? '#8fc3b9' : '#176c60' }, undefined));
      svg.lastChild.append(el('title', {}, m.month.slice(5) + '/' + m.month.slice(0, 4) + ': ' + kw(m.kWh) + ' kWh' + (m.costEur !== null ? ', ' + kw(m.costEur) + ' €' : '') + (running ? ' (laufender Monat)' : '')));
      svg.append(el('text', { x: cx, y: top - 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#22312d' }, kw(m.kWh) + ' kWh'));
      if (m.costEur !== null) svg.append(el('text', { x: cx, y: top - 3, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 600, fill: '#176c60' }, kw(m.costEur) + ' €'));
      svg.append(el('text', { x: cx, y: H - 14, 'text-anchor': 'middle', 'font-size': 10, fill: '#738487' }, m.month.slice(5) + '/' + m.month.slice(2, 4)));
    });
    const sum = list.reduce((a, m) => a + m.kWh, 0), cost = list.reduce((a, m) => a + (m.costEur || 0), 0);
    return h('div', { class: 'card', style: 'margin-bottom:12px' }, h('div', { class: 'card-head' }, h('b', { text: 'Verbrauch und Kosten je Monat' }), h('span', { class: 'muted', text: list.length + (list.length === 1 ? ' Monat' : ' Monate') + ': ' + kw(sum) + ' kWh · ' + kw(cost) + ' €' })), svg,
      h('p', { class: 'muted', text: 'Gemessen an der Jeep-Steckdose (Tasmota). Kosten mit dem eingestellten Strompreis; der laufende Monat ist heller.' }));
  }
  function jlShow(d) {
    const s = d.settings;
    jl.enabled.checked = s.enabled; jl.notify.checked = s.notify; jl.note.value = s.note || ''; for (const k of jlNum) jl[k].value = s[k];
    jl.autoOn.checked = !!s.autoOn; jl.awayOff.checked = !!s.awayOff; jl.faultOn.checked = !!s.faultOn; jl.radiusM.value = s.radiusM || 100;
    jlHome.textContent = (s.homeSet ? 'Ladeplatz: ' + (s.homeAddress || 'festgelegt') : 'Noch kein Ladeplatz festgelegt.') + ' · Ladekabel laut Jeep: ' + (d.plugged === true ? 'eingesteckt' : d.plugged === false ? 'nicht eingesteckt' : 'unbekannt');
    jl.autoOn.disabled = jl.awayOff.disabled = jl.faultOn.disabled = !s.homeSet;
    jl.socket.replaceChildren(h('option', { value: '', text: '– Steckdose wählen –' }), ...d.sockets.map(x => h('option', { value: x.address, text: x.name + ' – jetzt ' + (x.on ? 'an' : 'aus') + (x.power !== null ? ', ' + x.power + ' W' : '') }))); jl.socket.value = s.socket || '';
    jlNote.textContent = s.note ? ' – ' + s.note : ''; jlTag.className = 'tag ' + (s.enabled ? 'ok' : ''); jlTag.textContent = s.enabled ? 'aktiv' : 'aus';
    const n = d.now, cur = d.months[0];
    jlNow.replaceChildren(stat('Steckdose', n ? (n.online ? (n.on ? 'an' : 'aus') : 'offline') : '–', n && n.power !== null ? n.power + ' W' : ''), stat('Akku', d.percent ? d.percent.value + ' %' : '–', d.percent ? 'Meldung ' + new Date(d.percent.at).toLocaleString('de-DE') : ''),
      stat('Ladung läuft', d.session ? 'ja' : 'nein', d.session ? 'seit ' + new Date(d.session.start).toLocaleTimeString('de-DE') : ''), stat('Dieser Monat', cur ? kw(cur.kWh) + ' kWh' : '–', cur && cur.costEur !== null ? kw(cur.costEur) + ' €' : ''));
    jlMonths.replaceChildren(...(d.months.length ? [jlChart(d.months)].filter(Boolean) : []), d.months.length ? table(['Monat', 'Verbrauch', 'Kosten'], d.months.map(m => h('tr', {}, h('td', { text: m.month.slice(5) + '/' + m.month.slice(0, 4) }), h('td', { text: kw(m.kWh) + ' kWh' }), h('td', { text: m.costEur !== null ? kw(m.costEur) + ' €' : '–' })))) : h('p', { class: 'muted', text: 'Noch keine Aufzeichnung.' }));
    jlSessions.replaceChildren(...(d.sessions.length ? [jlChargeChart(d.sessions)].filter(Boolean) : []), d.sessions.length ? table(['Beginn', 'Ende', 'Akku', 'Aus der Steckdose', 'Im Akku (geschätzt)', 'Wirkungsgrad', 'Kosten', 'Grund'], d.sessions.map(x => h('tr', {}, h('td', { text: new Date(x.start).toLocaleString('de-DE') }), h('td', { text: new Date(x.end).toLocaleString('de-DE') }),
      h('td', { text: Number.isFinite(x.socStart) ? x.socStart + ' % → ' + (Number.isFinite(x.socEnd) ? x.socEnd + ' %' : '?') : '–' }), h('td', { text: x.kWh !== null && x.kWh !== undefined ? kw(x.kWh) + ' kWh' : '–' }),
      h('td', { text: Number.isFinite(x.batteryKWh) ? '≈ ' + kw(x.batteryKWh) + ' kWh' : '–' }), h('td', { text: Number.isFinite(x.efficiencyPct) ? x.efficiencyPct + ' %' + (Number.isFinite(x.lossKWh) ? ' (Verlust ' + kw(x.lossKWh) + ' kWh)' : '') : '–' }),
      h('td', { text: x.costEur !== null && x.costEur !== undefined ? kw(x.costEur) + ' €' + (Number.isFinite(x.costPerBatteryKWh) ? ' (' + kw(x.costPerBatteryKWh) + ' €/kWh im Akku)' : '') : '–' }), h('td', { text: x.reason })))) : h('p', { class: 'muted', text: 'Noch keine Ladung aufgezeichnet.' }));
    jlLog.replaceChildren(d.log.length ? table(['Zeit', 'Ereignis'], d.log.map(e => h('tr', {}, h('td', { text: new Date(e.at).toLocaleString('de-DE') }), h('td', { text: e.text })))) : h('p', { class: 'muted', text: 'Noch nichts.' }));
  }
  const jlLoad = () => api('getJeepLaden').then(jlShow).catch(e => msg(jlOut, e.message, 'bad'));
  jlSave.addEventListener('click', () => task(jlSave, jlOut, async () => {
    const p = { enabled: jl.enabled.checked, notify: jl.notify.checked, socket: jl.socket.value, note: jl.note.value, autoOn: jl.autoOn.checked, awayOff: jl.awayOff.checked, faultOn: jl.faultOn.checked, radiusM: Number(jl.radiusM.value) || 100 };
    for (const k of jlNum) p[k] = Number(jl[k].value);
    const r = await api('saveJeepLaden', p); jlShow(r); return r.message;
  }, 'Wird gespeichert …'));
  function bwShow(d) {
    const s = d.settings; bw.enabled.checked = s.enabled; bw.time.value = s.time; bw.note.value = s.note || '';
    bwNote.textContent = s.note ? ' – ' + s.note : ''; bwTag.className = 'tag ' + (s.enabled ? 'ok' : ''); bwTag.textContent = s.enabled ? 'aktiv' : 'aus';
    bwNow.replaceChildren(...[!d.whatsappReady ? h('div', { class: 'notice warn', text: 'WhatsApp ist noch nicht eingerichtet (System → Benachrichtigungen).' }) : null,
      d.weak.length ? h('p', {}, h('b', { text: 'Jetzt schwach: ' }), d.weak.map(x => x.device + (x.room ? ' (' + x.room + ')' : '')).join(', ')) : h('p', { class: 'muted', text: 'Zurzeit keine schwache Batterie.' })].filter(Boolean));
    bwLog.replaceChildren(d.log.length ? table(['Zeit', 'Ergebnis', 'Geräte'], d.log.slice().reverse().map(e => h('tr', {}, h('td', { text: new Date(e.at).toLocaleString('de-DE') }), h('td', { text: e.message + (e.manual ? ' (von Hand)' : '') }), h('td', { text: (e.devices || []).join(', ') })))) : h('p', { class: 'muted', text: 'Noch keine Nachricht.' }));
  }
  const bwLoad = () => api('getBatterie').then(bwShow).catch(e => msg(bwOut, e.message, 'bad'));
  bwSave.addEventListener('click', () => task(bwSave, bwOut, async () => { const r = await api('saveBatterie', { enabled: bw.enabled.checked, time: bw.time.value, note: bw.note.value }); bwShow(r); return r.message; }, 'Wird gespeichert …'));
  bwRun.addEventListener('click', () => task(bwRun, bwOut, async () => { const r = await api('runBatterie', {}); bwShow(r); return r.message; }, 'Wird geprüft …'));
  // Hinter jedem Eintrag der aktuelle Wert (z. B. „an“, „55 %“), damit man den richtigen Fühler erkennt.
  const nowText = x => x.kind === 'bool' ? (x.current ? ' – jetzt ' + (x.on || 'an') : ' – jetzt ' + (x.off || 'aus')) : x.kind === 'number' && Number.isFinite(x.current) ? ' – jetzt ' + String(x.current).replace('.', ',') + (x.unit ? ' ' + x.unit : '') : '';
  const fill = (sel, list, value, empty) => { sel.replaceChildren(h('option', { value: '', text: empty }), ...list.map(x => h('option', { value: x.address, text: (x.room ? x.room + ' · ' : '') + x.name + ' (' + x.address + ')' + nowText(x) }))); sel.value = value || ''; };
  function efShow(d) {
    const s = d.settings; efSettings = s;
    const lights = cat.sources.filter(x => x.kind === 'bool'), sensors = cat.sources.filter(x => x.kind === 'number' && /Luftfeuchte/.test(x.title)), actors = cat.targets.filter(x => x.switch);
    const uniq = l => [...new Map(l.map(x => [x.address, x])).values()];
    fill(ef.light, uniq(lights), s.light, '– Licht wählen –'); fill(ef.sensor, uniq(sensors), s.sensor, '– Fühler wählen –'); fill(ef.sensorFallback, uniq(sensors), s.sensorFallback, '– kein Ersatzfühler –'); fill(ef.actor, uniq(actors), s.actor, '– Steckdose wählen –');
    ef.enabled.checked = s.enabled; ef.useOutdoor.checked = s.useOutdoor; ef.note.value = s.note || '';
    efNote.textContent = s.note ? ' – ' + s.note : ''; efTag.className = 'tag ' + (s.enabled ? 'ok' : ''); efTag.textContent = s.enabled ? 'aktiv' : 'aus';
    api('getDevices').then(dv => { const list = (dv.devices || []).filter(x => ['smartlife', 'smartplus'].includes(x.provider) && Number.isFinite(x.currentState?.humidity)); ef.outdoorSensor.replaceChildren(h('option', { value: '', text: '– nur Wetter (Open-Meteo) –' }), ...list.map(x => h('option', { value: x.address, text: x.name + ' (' + x.currentState.temperature + ' °C, ' + x.currentState.humidity + ' %)' }))); ef.outdoorSensor.value = s.outdoorSensor || '';
      // WLAN-Fühler (Smart Life / SMART+) auch als Feuchtefühler im Bad wählbar (Wunsch Thomas: Bad-Sensor statt Wandthermostat)
      for (const sel of [ef.sensor, ef.sensorFallback]) { const have = new Set([...sel.options].map(o => o.value));
        sel.append(...list.filter(x => !have.has(x.address)).map(x => h('option', { value: x.address, text: (x.room ? x.room + ' · ' : '') + x.name + ' (WLAN) – jetzt ' + String(x.currentState.humidity).replace('.', ',') + ' %' }))); }
      ef.sensor.value = s.sensor || ''; ef.sensorFallback.value = s.sensorFallback || ''; }).catch(() => {});
    for (const k of ['onRh', 'offRh', 'onDelta', 'offDelta', 'minOnMin', 'minOffMin', 'maxOnMin']) ef[k].value = s[k];
    const v = d.values, f1 = x => x === null || x === undefined ? '–' : String(x).replace('.', ',');
    efNow.replaceChildren(stat('Licht', v ? (v.light ? 'an' : 'aus') : '–', v ? 'zuletzt ' + new Date(v.at).toLocaleTimeString('de-DE') : 'Steuerung aus'), stat('Bad', v ? f1(v.rh) + ' %' : '–', v ? (v.sensorUsed ? f1(v.ah) + ' g/m³ bei ' + f1(v.t) + ' °C · ' + (v.sensorUsed === 'Ersatzfühler' ? '⚠ Ersatzfühler (Hauptfühler liefert nichts)' : 'Hauptfühler') : '⚠ kein Fühler liefert Werte') : ''),
      stat('Außen', v?.outdoor ? f1(v.outdoor.rh) + ' %' : '–', v?.outdoor ? f1(v.outdoor.ah) + ' g/m³ (' + (v.outdoor.source || '') + ') · Unterschied ' + f1(v.diff) + ' g/m³' : 'keine aktuellen Außenwerte'), stat('Entfeuchter', v ? (v.actorOn ? 'an' : 'aus') : '–', ''));
    efLog.replaceChildren(d.log.length ? table(['Zeit', 'Aktion', 'Grund'], d.log.map(e => h('tr', {}, h('td', { text: new Date(e.at).toLocaleString('de-DE') }), h('td', { text: (e.on ? 'ein' : 'aus') + (e.confirmed ? '' : ' (nicht bestätigt)') }), h('td', { text: e.reason })))) : h('p', { class: 'muted', text: 'Noch keine Schaltungen.' }));
  }
  const efLoad = () => api('getEntfeuchter').then(efShow).catch(e => msg(efOut, e.message, 'bad'));
  efSave.addEventListener('click', () => task(efSave, efOut, async () => {
    const p = { enabled: ef.enabled.checked, light: ef.light.value, sensor: ef.sensor.value, sensorFallback: ef.sensorFallback.value, actor: ef.actor.value, useOutdoor: ef.useOutdoor.checked, outdoorSensor: ef.outdoorSensor.value, note: ef.note.value };
    for (const k of ['onRh', 'offRh', 'onDelta', 'offDelta', 'minOnMin', 'minOffMin', 'maxOnMin']) p[k] = Number(ef[k].value);
    const r = await api('saveEntfeuchter', p); efShow(r); return r.message;
  }, 'Wird gespeichert …'));
  setInterval(() => { if (!document.hidden && admin && efSettings?.enabled) efLoad(); }, 60000);
  // ---------- Assistent: Vorschläge je Gerät (offline) + KI hinter der „Mauer“ (nur Vorschlag, Speichern erst nach Prüfung im Editor) ----------
  const asText = h('textarea', { rows: 2, maxlength: 500, style: 'width:100%', placeholder: 'z. B. „Wenn ich abends den neuen Taster drücke, Gang und Bad aus“', 'aria-label': 'Was soll passieren?' });
  const asBtn = h('button', { class: 'btn primary', type: 'button', text: 'Vorschlag erstellen (KI)' }), asOut = h('p', { class: 'msg', role: 'status' }), asResult = h('div');
  const asDev = h('select', { 'aria-label': 'Gerät für Vorschläge' }), asSugg = h('div');
  const asPress = h('button', { class: 'btn', type: 'button', text: '👆 Taste drücken' }); let asTimer = null;
  const ki = { on: h('input', { type: 'checkbox' }), key: h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Schlüssel hier einfügen (wird verschlüsselt gespeichert)', 'aria-label': 'KI-Schlüssel' }), state: h('p', { class: 'muted' }) };
  const kiSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), kiRemove = h('button', { class: 'btn', type: 'button', text: 'Schlüssel löschen' }), kiOut = h('p', { class: 'msg', role: 'status' });
  const asPanel = panel('Assistent', 'Taste drücken und/oder in einem Satz beschreiben, was passieren soll – die KI füllt alles aus, du bestätigst mit einem Klick. Oder wähle ein Gerät und nimm einen fertigen Vorschlag. Gespeichert wird erst mit „Bestätigen“.',
    h('div', { class: 'row' }, asPress), field('Was soll passieren?', asText), h('div', { class: 'actions' }, asBtn), asOut, asResult,
    field('Fertige Vorschläge für ein Gerät (ohne KI, offline)', asDev), asSugg,
    h('details', { class: 'more' }, h('summary', { text: 'KI einrichten' }), h('div', {},
      h('p', { class: 'muted', text: 'Kostenlose Stufe von Google Gemini mit deinem eigenen Schlüssel (aistudio.google.com → API-Schlüssel). Die KI bekommt nur deinen Satz sowie Gerätenamen und -typen (keine Adressen, keine Passwörter) und kann nur einen Regelvorschlag liefern – nichts schalten, nichts speichern. Höchstens 20 Anfragen je Stunde.' }),
      h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(ki.on, 'KI-Vorschläge eingeschaltet')), h('div', { class: 'wide' }, field('Schlüssel (nur zum Eintragen – wird nie wieder angezeigt)', ki.key))),
      ki.state, h('div', { class: 'actions' }, kiSave, kiRemove), kiOut)));
  let kiInfo = null;
  function kiShow(k) { kiInfo = k; ki.on.checked = k.enabled; ki.key.value = ''; ki.state.textContent = k.hasKey ? 'Schlüssel vorhanden (verschlüsselt auf der CCU).' : 'Noch kein Schlüssel hinterlegt.'; asBtn.disabled = !(k.enabled && k.hasKey); asBtn.title = asBtn.disabled ? 'KI unten unter „KI einrichten“ einschalten und Schlüssel eintragen' : ''; }
  const kiLoad = () => api('getAssistent').then(r => kiShow(r.ki)).catch(() => {});
  kiSave.addEventListener('click', () => task(kiSave, kiOut, async () => { const p = { enabled: ki.on.checked }; if (ki.key.value.trim()) p.key = ki.key.value.trim(); const r = await api('saveAssistent', p); kiShow(r.ki); return r.message; }, 'Wird gespeichert …'));
  kiRemove.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Schlüssel löschen?', text: 'Der KI-Schlüssel wird von der CCU entfernt. Die festen Vorschläge funktionieren weiter.', confirm: 'Löschen' })) return; task(kiRemove, kiOut, async () => { const r = await api('saveAssistent', { removeKey: true, enabled: false }); kiShow(r.ki); return 'Schlüssel gelöscht.'; }, 'Wird gelöscht …'); });
  async function takeOver(rule) { try { cat = await api('getAutomationCatalog'); } catch {} openEditor(JSON.parse(JSON.stringify(rule))); msg(asOut, 'Vorschlag im Editor oben – bitte prüfen und speichern.', 'ok'); }
  // „Bis zum Klick alles machen“ (Wunsch Thomas 13.10.2026): fertiger Vorschlag → „Bestätigen & speichern“ (ein Klick);
  // nur wenn Auslöser und alle Ziele feststehen – sonst wie bisher erst in den Editor. Der Server prüft die Regel beim Speichern erneut.
  // dieselbe Vollständigkeitsprüfung wie im Editor (complete() unten: '' = vollständig)
  const ready = rule => { try { return complete({ conditions: [], actions: [], ...rule }) === ''; } catch { return false; } };
  function ruleCard(rule, extra) {
    const o = h('p', { class: 'msg', role: 'status' }), card = h('div', { class: 'card' });
    const ok = h('button', { class: 'btn primary', type: 'button', text: '✓ Bestätigen & speichern' });
    ok.addEventListener('click', () => task(ok, o, async () => { const res = await api('saveAutomation', { rule: { ...rule, enabled: rule.enabled !== false } }); data = res; renderList(); card.replaceChildren(h('p', { class: 'msg ok', text: '✓ Gespeichert und aktiv: „' + rule.name + '“' })); return ''; }, 'Wird gespeichert …'));
    const fertig = ready(rule), edit = h('button', { class: fertig ? 'btn' : 'btn primary', type: 'button', text: fertig ? 'Im Editor ändern' : 'Prüfen und übernehmen', onclick: () => takeOver(rule) });
    card.append(h('p', {}, h('b', { text: rule.name }), h('br'), sentence(rule)), extra || '', h('div', { class: 'actions' }, ...(fertig ? [ok, edit] : [edit])), fertig ? o : h('p',{ class: 'muted', text: 'Noch nicht alles festgelegt (z. B. welches Licht) – bitte im Editor ergänzen.' }));
    return card;
  }
  // Taste drücken: der zuletzt gedrückte Taster wird als Auslöser in den Satz übernommen (Knopf oben bei asPanel angelegt)
  asPress.addEventListener('click', () => {
    if (asTimer) return; const seit = Date.now(); let n = 0; asPress.textContent = '… warte auf Tastendruck (30 s)'; msg(asOut, 'Jetzt die Taste am Gerät drücken …', 'busy');
    asTimer = setInterval(async () => {
      const ende = (t, k) => { clearInterval(asTimer); asTimer = null; asPress.textContent = '👆 Taste drücken'; if (t) msg(asOut, t, k); };
      if (++n > 15) return ende('Kein Tastendruck erkannt. Bitte noch einmal – oder die Taste im Satz beschreiben.', 'warn');
      try { const r = await api('getGeraeteAktivitaet'), off = Date.now() - Date.parse(r.now);
        const hit = Object.entries(r.pressed || {}).filter(([, at]) => Date.parse(at) + off >= seit).sort((x, y) => y[1].localeCompare(x[1]))[0];
        const src = hit && cat.sources.find(s => s.address === hit[0] && s.key === 'PRESS_SHORT');
        if (src) { asText.value = 'Wenn „' + src.name + '“' + (src.room ? ' (' + src.room + ')' : '') + ' kurz gedrückt wird: ' + asText.value.replace(/^Wenn „[^“]*“( \([^)]*\))? kurz gedrückt wird: /, ''); ende('Erkannt: ' + src.name + '. Jetzt dahinter schreiben, was passieren soll.', 'ok'); asText.focus(); asText.setSelectionRange(asText.value.length, asText.value.length); }
      } catch {}
    }, 2000);
  });
  asBtn.addEventListener('click', () => task(asBtn, asOut, async () => {
    asResult.replaceChildren();
    const r = await api('askAssistent', { text: asText.value });
    if (r.rule) asResult.replaceChildren(ruleCard(r.rule, r.question ? h('p', { class: 'muted', text: 'Hinweis der KI: ' + r.question }) : null));
    else if (r.question) asResult.replaceChildren(h('div', { class: 'notice warn', text: 'Rückfrage der KI: ' + r.question + ' – bitte den Satz genauer formulieren.' }));
    return r.rule ? 'Vorschlag fertig – bitte bestätigen. Noch ist nichts gespeichert.' : 'Die KI braucht mehr Angaben.';
  }, 'KI denkt nach …'));
  function asDevices() {
    const byDev = new Map();
    for (const s of cat.sources) { const d = String(s.address).split(':')[0]; if (!byDev.has(d)) byDev.set(d, { device: d, name: String(s.name).replace(/:\d+$/, ''), room: s.room }); }
    const keep = asDev.value;
    asDev.replaceChildren(h('option', { value: '', text: '– Gerät wählen –' }), ...[...byDev.values()].sort((a, b) => (a.room || '~').localeCompare(b.room || '~', 'de') || a.name.localeCompare(b.name, 'de')).map(x => h('option', { value: x.device, text: (x.room ? x.room + ' · ' : '') + x.name })));
    asDev.value = keep || new URLSearchParams(location.search).get('assist') || '';
    if (asDev.value) asDev.dispatchEvent(new Event('change'));
  }
  asDev.addEventListener('change', async () => {
    asSugg.replaceChildren(); if (!asDev.value) return;
    try {
      const r = await api('suggestAutomation', undefined, { query: { device: asDev.value } });
      asSugg.replaceChildren(...(r.suggestions.length ? r.suggestions.map(s => h('div', {}, h('h4', { text: s.title }), ...s.rules.map(rule => ruleCard(rule)))) : [h('p', { class: 'muted', text: r.note || 'Für dieses Gerät gibt es noch keine fertigen Vorschläge – beschreibe oben in einem Satz, was passieren soll.' })]));
    } catch (e) { asSugg.replaceChildren(h('div', { class: 'notice bad', text: e.message })); }
  });
  main.append(adminNote, stats, editorBox, asPanel, listPanel, bsB.panel, glPanel, gbB.panel, syPanel, efPanel, jlPanel, bwPanel,
    panel('Verlauf', 'Die letzten ausgeführten Aktionen.', h('details', { class: 'more' }, h('summary', { text: 'Verlauf anzeigen' }), logBox)),
    panel('Bisherige Programme der Zentrale', 'Programme, die früher in der Zentrale angelegt wurden, laufen dort unverändert weiter. Schalten sie dieselben Geräte wie eine neue Automation, bitte nur eines von beiden aktiv lassen.', oldDetails));

  let admin = false, data = { rules: [], paused: false, engine: {} }, cat = { sources: [], targets: [] }, draft = null, timer = null;
  const DAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
  const DELAYS = [[0, 'sofort'], [5, 'nach 5 Sekunden'], [10, 'nach 10 Sekunden'], [30, 'nach 30 Sekunden'], [60, 'nach 1 Minute'], [120, 'nach 2 Minuten'], [300, 'nach 5 Minuten'], [600, 'nach 10 Minuten'], [1800, 'nach 30 Minuten'], [3600, 'nach 1 Stunde']];
  const DURATIONS = [[0, 'dauerhaft'], [30, 'für 30 Sekunden'], [60, 'für 1 Minute'], [120, 'für 2 Minuten'], [180, 'für 3 Minuten'], [300, 'für 5 Minuten'], [600, 'für 10 Minuten'], [900, 'für 15 Minuten'], [1800, 'für 30 Minuten'], [3600, 'für 1 Stunde'], [7200, 'für 2 Stunden']];
  const seconds = s => s % 3600 === 0 ? s / 3600 + (s === 3600 ? ' Stunde' : ' Stunden') : s % 60 === 0 ? s / 60 + (s === 60 ? ' Minute' : ' Minuten') : s + ' Sekunden';
  const num = v => String(v).replace('.', ',');

  // ---------- Texte ----------
  const source = (address, key) => cat.sources.find(s => s.address === address && s.key === key);
  const target = address => cat.targets.find(t => t.address === address);
  const nameOf = address => (cat.sources.find(s => s.address === address) || target(address) || {}).name || address;
  function testText(t, asState) {
    const s = source(t.address, t.key);
    if (t.op === 'above' || t.op === 'below') return `${s ? s.title : t.key} ${asState ? (t.op === 'above' ? 'ist über' : 'ist unter') : (t.op === 'above' ? 'steigt über' : 'fällt unter')} ${num(t.value)}${s && s.unit ? ' ' + s.unit : ''}`;
    const text = s ? (t.op === 'off' ? s.off : s.on) : t.key;
    return t.key === 'STATE' ? (asState ? 'ist ' : 'wird ') + text : text;
  }
  function daysText(days) {
    const set = new Set(days);
    if (set.size === 7) return 'jeden Tag';
    if (set.size === 5 && [1, 2, 3, 4, 5].every(d => set.has(d))) return 'Mo–Fr';
    if (set.size === 2 && set.has(6) && set.has(0)) return 'Sa und So';
    return DAYS.filter(([d]) => set.has(d)).map(([, n]) => n).join(', ');
  }
  function actionText(a) {
    const dur = a.duration ? ' für ' + seconds(a.duration) : '', del = a.delay ? ' (nach ' + seconds(a.delay) + ')' : '';
    if (a.type === 'switch') return `„${nameOf(a.address)}“ ${a.on ? 'einschalten' : 'ausschalten'}${dur}${del}`;
    if (a.type === 'toggle') return `„${nameOf(a.address)}“ umschalten (an ↔ aus)${del}`;
    if (a.type === 'dimmer') return a.percent === 0 ? `„${nameOf(a.address)}“ ausschalten${del}` : `„${nameOf(a.address)}“ auf ${a.percent} % stellen${dur}${del}`;
    return `„${nameOf(a.address)}“ auf ${num(a.temperature)} °C stellen${del}`;
  }
  function sentence(rule) {
    const t = rule.trigger;
    let text = t.type === 'time' ? `Wenn es ${t.time} Uhr ist (${t.everyDays ? (t.everyDays === 1 ? 'jeden Tag' : 'alle ' + t.everyDays + ' Tage') : daysText(t.days)})` : `Wenn „${nameOf(t.address)}“ meldet: ${testText(t, false)}`;
    for (const c of rule.conditions || []) text += c.type === 'outdoor' ? (c.at ? ` – nur wenn für ${c.at} Uhr ${c.op === 'below' ? 'unter' : 'über'} ${String(c.value).replace('.', ',')} °C vorhergesagt sind` : ` – nur wenn es draußen ${c.op === 'below' ? 'unter' : 'über'} ${String(c.value).replace('.', ',')} °C hat`) : c.type === 'firedToday' ? ` – nur wenn „${(data.rules.find(x => x.id === c.ruleId) || {}).name || 'die andere Regel'}“ heute schon lief` : c.type === 'time' ? ` – nur zwischen ${c.from} und ${c.to} Uhr` : c.type === 'sun' ? (c.when === 'dark' ? ' – nur wenn es dunkel ist (nach Sonnenuntergang)' : ' – nur wenn es hell ist (nach Sonnenaufgang)') : ` – nur wenn „${nameOf(c.address)}“: ${testText(c, true)}`;
    return text + ', dann ' + rule.actions.map(actionText).join(' und ') + '.';
  }

  // ---------- Liste ----------
  function renderStats() {
    const active = data.rules.filter(r => r.enabled).length, e = data.engine || {};
    const state = data.paused ? ['pausiert', 'alle Automationen angehalten', 'warn'] : e.graceSeconds > 0 ? ['startet', 'Schonfrist nach dem Start: noch ' + e.graceSeconds + ' s', 'warn'] : e.connected ? ['läuft', 'Zentrale verbunden' + (e.sun ? ' · Sonne ' + e.sun.rise + '–' + e.sun.set + ' Uhr' : '') + (e.dutyCycle != null ? ' · Funk ' + e.dutyCycle + ' %' + (e.dutyCycle >= 90 ? ' – automatisches Einschalten angehalten' : '') : ''), e.dutyCycle >= 80 ? 'warn' : 'ok'] : ['wartet', 'Zentrale nicht verbunden', 'bad'];
    stats.replaceChildren(stat('Automationen', String(data.rules.length), active + ' aktiv'), stat('Zustand', state[0], state[1], state[2]), stat('Schaltet später aus', String((e.pendingOff || []).length), (e.pendingOff || []).length ? (e.pendingOff || []).map(p => p.name).slice(0, 2).join(', ') : 'nichts geplant'));
    pauseAll.checked = data.paused === true;
  }
  const openRules = new Set();
  function renderList() {
    renderStats();
    newBtn.disabled = !admin || !!draft; pauseAll.disabled = !admin;
    glShow(); syShow(); bsShow(); gbShow();
    const rules = data.rules.filter(r => r.name !== GANG && r.name !== GANG_AUS && r.name !== SONY && !BLOCK_NAMES.has(r.name)); // „Gang-Licht nach Bad“ hat einen eigenen Block
    if (!rules.length) { listBox.replaceChildren(h('div', { class: 'empty', text: 'Noch keine weitere Automation angelegt. Mit „Neue Automation“ geht es los.' })); return; }
    listBox.replaceChildren(h('div', { class: 'auto-list' }, rules.map(rule => {
      const on = h('input', { type: 'checkbox', checked: rule.enabled, disabled: !admin, 'aria-label': rule.name + ' aktiv' });
      on.addEventListener('change', () => run(() => api('setAutomationEnabled', { id: rule.id, enabled: on.checked })));
      const edit = h('button', { class: 'btn small', type: 'button', text: 'Ändern', disabled: !admin || !!draft, onclick: () => openEditor(JSON.parse(JSON.stringify(rule))) });
      const test = h('button', { class: 'btn small', type: 'button', text: 'Testen', disabled: !admin });
      test.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Jetzt testen?', text: `Die Aktionen von „${rule.name}“ werden sofort ausgeführt – unabhängig von Auslöser und Bedingungen. Dabei werden echte Geräte geschaltet.`, confirm: 'Jetzt ausführen' })) return;
        run(() => api('runAutomation', { id: rule.id }), test);
      });
      const del = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen', disabled: !admin });
      del.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Automation löschen?', text: `„${rule.name}“ wird endgültig gelöscht.`, confirm: 'Löschen', danger: true })) return;
        run(() => api('deleteAutomation', { id: rule.id }), del);
      });
      const st = rule.status || {}, problem = rule.problem || st.missing;
      // Zugeklappt: nur Überschrift (Name, Bemerkung, Zustand); Pfeil klappt Einzelheiten auf. Offene bleiben beim Aktualisieren offen.
      const box = h('details', { class: 'auto-item', open: openRules.has(rule.id) },
        // Beschreibung in eigener Zeile unter Name und Zustand (Wunsch Thomas 13.10.2026: „das müsste separat stehen“)
        h('summary', {}, h('b', { text: rule.name }), ' ', h('span', { class: 'tag ' + (rule.enabled ? 'ok' : ''), text: rule.enabled ? 'aktiv' : 'pausiert' }), problem ? h('span', { class: 'tag bad', text: '⚠ Problem' }) : null, rule.note ? h('span', { class: 'auto-note muted', text: rule.note }) : null),
        h('div', { class: 'auto-body' }, h('p', { text: sentence(rule) }), problem ? h('p', { style: 'color:var(--bad)', text: '⚠ ' + problem }) : null,
          h('p', { class: 'muted' }, 'Zuletzt: ' + (st.lastRun ? fmtDate(st.lastRun) : '–') + (st.lastResult ? ' · ' + st.lastResult : '')),
          h('div', { class: 'row' }, toggle(on, rule.enabled ? 'aktiv' : 'pausiert'), edit, test, del)));
      box.addEventListener('toggle', () => { if (box.open) openRules.add(rule.id); else openRules.delete(rule.id); });
      return box;
    })));
  }
  function renderLog(log) {
    if (!log.length) { logBox.replaceChildren(h('div', { class: 'empty', text: 'Noch nichts ausgeführt.' })); return; }
    logBox.replaceChildren(table(['Zeit', 'Automation', 'Auslöser', 'Aktion', 'Ergebnis'], log.slice(0, 30).map(e => h('tr', {}, h('td', { text: fmtDate(e.at) }), h('td', { text: e.name || '–' }), h('td', { text: e.cause || '' }), h('td', { text: e.text || '' }),
      h('td', {}, h('span', { class: 'tag ' + (e.ok ? 'ok' : ''), style: e.ok ? undefined : 'color:var(--bad)', text: e.ok ? (e.confirmed ? 'bestätigt' : 'gesendet') : 'Fehler' }), e.error ? h('span', { class: 'sub', text: e.error }) : null)))));
  }
  async function run(fn, button) {
    await task(button, listOut, async () => { const r = await fn(); if (r && r.rules) data = r; renderList(); loadLog(); return r && r.message; });
    if (!data.rules) await load();
  }
  async function loadLog() { try { renderLog((await api('getAutomationLog')).log || []); } catch (e) { logBox.replaceChildren(h('div', { class: 'notice bad', text: e.message })); } }
  async function load() {
    clearTimeout(timer);
    try { data = await api('getAutomations'); if (!draft) renderList(); else renderStats(); await loadLog(); }
    catch (e) { listBox.replaceChildren(h('div', { class: 'notice bad', text: e.message })); }
    timer = setTimeout(() => { if (!document.hidden) load(); else timer = setTimeout(load, 15000); }, 15000);
  }
  pauseAll.addEventListener('change', () => run(() => api('setAutomationsPaused', { paused: pauseAll.checked })));

  // ---------- Assistent ----------
  function deviceSelect(items, value, label) {
    const groups = new Map();
    for (const it of items) { const room = it.room || 'Ohne Raum'; if (!groups.has(room)) groups.set(room, []); if (!groups.get(room).some(x => x.address === it.address)) groups.get(room).push(it); }
    const counts = new Map(); for (const list of groups.values()) for (const it of list) counts.set(it.name, (counts.get(it.name) || 0) + 1);
    const sel = h('select', { 'aria-label': label });
    // Suchfeld über der Auswahl (Wunsch Thomas): Anfangsbuchstaben/Namensteil, Raum oder Adresse grenzen die Liste ein.
    // Die Liste wird neu aufgebaut (ausgeblendete Einträge zeigt Safari auf dem iPhone sonst trotzdem an).
    const build = q => {
      const ql = q.trim().toLocaleLowerCase('de'), cur = sel.value || value, hit = (it, room) => !ql || it.address === cur || it.name.toLocaleLowerCase('de').includes(ql) || room.toLocaleLowerCase('de').includes(ql) || it.address.toLowerCase().includes(ql);
      const groupsShown = [...groups].map(([room, list]) => [room, list.filter(it => hit(it, room))]).filter(([, l]) => l.length);
      sel.replaceChildren(h('option', { value: '', text: ql ? (groupsShown.length ? 'Treffer wählen …' : 'Kein Gerät gefunden') : 'Bitte wählen …' }), ...groupsShown.map(([room, list]) => h('optgroup', { label: room }, list.map(it => h('option', { value: it.address, selected: it.address === cur, text: it.name + (counts.get(it.name) > 1 ? ' (' + it.address + ')' : '') })))));
      if (cur && !items.some(i => i.address === cur)) sel.append(h('option', { value: cur, selected: true, text: 'Nicht mehr vorhanden: ' + cur }));
    };
    build('');
    const search = h('input', { type: 'search', class: 'dev-search', placeholder: '🔍 suchen', 'aria-label': label + ' suchen', autocomplete: 'off' });
    search.addEventListener('input', () => build(search.value));
    // Suchfeld NEBEN der Auswahl (gleiche Höhe wie die übrigen Felder, Zeilen bleiben bündig)
    setTimeout(() => { if (!sel.parentNode || sel.parentNode.classList?.contains('dev-pick')) return; const wrap = h('div', { class: 'dev-pick' }); sel.parentNode.insertBefore(wrap, sel); wrap.append(search, sel); }, 0);
    return sel;
  }
  function choice(list, value, label) {
    const sel = h('select', { 'aria-label': label }, list.map(([v, t]) => h('option', { value: v, text: t, selected: v === value })));
    if (!list.some(([v]) => v === value)) sel.append(h('option', { value, selected: true, text: label + ': ' + seconds(value) }));
    return sel;
  }
  // Auswahl „Was meldet das Gerät?“ – für Auslöser (Wechsel) oder Bedingung (Zustand).
  function testFields(t, asState, redraw) {
    const device = deviceSelect(asState ? cat.sources.filter(s => s.kind !== 'event') : cat.sources, t.address, 'Gerät');
    device.addEventListener('change', () => { t.address = device.value; delete t.key; delete t.op; delete t.value; redraw(); });
    const options = [];
    for (const s of cat.sources.filter(x => x.address === t.address)) {
      if (s.kind === 'event') { if (!asState) options.push([s.key + '|event', s.on]); }
      else if (s.kind === 'bool') { const pre = s.key === 'STATE' ? (asState ? 'ist ' : 'wird ') : ''; options.push([s.key + '|on', pre + s.on], [s.key + '|off', pre + s.off]); }
      else options.push([s.key + '|above', `${s.title} ${asState ? 'ist über' : 'steigt über'} …`], [s.key + '|below', `${s.title} ${asState ? 'ist unter' : 'fällt unter'} …`]);
    }
    const current = t.key ? t.key + '|' + t.op : '';
    const what = h('select', { 'aria-label': 'Meldung', disabled: !t.address }, h('option', { value: '', text: t.address ? 'Bitte wählen …' : 'Zuerst Gerät wählen' }), options.map(([v, text]) => h('option', { value: v, text, selected: v === current })));
    what.addEventListener('change', () => { const [key, op] = what.value.split('|'); if (!key) { delete t.key; delete t.op; } else { t.key = key; t.op = op; } const s = source(t.address, key); if (op === 'above' || op === 'below') t.value = typeof t.value === 'number' ? t.value : Math.round(Number(s && s.current) || 0); else delete t.value; redraw(); });
    const out = [field('Gerät', device), field(asState ? 'Zustand' : 'Meldung', what)];
    if (t.op === 'above' || t.op === 'below') {
      const s = source(t.address, t.key) || {};
      const value = h('input', { type: 'number', step: '0.5', min: s.min, max: s.max, value: t.value, 'aria-label': 'Grenzwert' });
      value.addEventListener('input', () => { t.value = value.value === '' ? undefined : Number(value.value); preview(); });
      out.push(field('Grenzwert' + (s.unit ? ' (' + s.unit + ')' : ''), value, s.current !== undefined ? 'Aktuell: ' + num(s.current) + (s.unit ? ' ' + s.unit : '') : null));
    }
    return out;
  }
  let previewEl = null, saveBtn = null;
  function complete(rule) {
    const okTest = t => t.address && t.key && t.op && (!['above', 'below'].includes(t.op) || Number.isFinite(t.value));
    const t = rule.trigger;
    if (t.type === 'time' ? !(/^\d\d:\d\d$/.test(t.time || '') && t.days && t.days.length) : !okTest(t)) return 'Bitte den Auslöser („Wenn“) vollständig wählen.';
    for (const c of rule.conditions) if (c.type === 'outdoor' ? !(Number.isFinite(c.value) && ['above', 'below'].includes(c.op) && (c.at === undefined || /^\d\d:\d\d$/.test(c.at))) : c.type === 'firedToday' ? !c.ruleId : c.type === 'sun' ? !['dark', 'light'].includes(c.when) : c.type === 'time' ? !(/^\d\d:\d\d$/.test(c.from || '') && /^\d\d:\d\d$/.test(c.to || '')) : !okTest(c)) return 'Bitte die Bedingung vollständig wählen.';
    if (!rule.actions.length) return 'Bitte mindestens eine Aktion („Dann“) anlegen.';
    for (const a of rule.actions) if (!a.address || !a.type || (a.type === 'dimmer' && !Number.isInteger(a.percent)) || (a.type === 'thermostat' && !Number.isFinite(a.temperature))) return 'Bitte die Aktion („Dann“) vollständig wählen.';
    return '';
  }
  function preview() {
    if (!previewEl) return;
    const missing = complete(draft);
    previewEl.textContent = missing || sentence(draft);
    previewEl.className = 'notice' + (missing ? ' warn' : '');
    if (saveBtn) saveBtn.disabled = !!missing || !admin;
  }
  function actionFields(a, index, redraw) {
    const device = deviceSelect(cat.targets, a.address, 'Gerät');
    device.addEventListener('change', () => { const t = target(device.value); for (const k of Object.keys(a)) delete a[k]; a.address = device.value; if (t) { if (t.switch) { a.type = 'switch'; a.on = true; } else if (t.dimmer) { a.type = 'dimmer'; a.percent = 100; } else if (t.thermostat) { a.type = 'thermostat'; a.temperature = 21; } } redraw(); });
    const t = target(a.address), fields = [field('Gerät', device)];
    if (t && (a.type === 'switch' || a.type === 'toggle')) {
      const what = h('select', { 'aria-label': 'Aktion' }, h('option', { value: 'on', text: 'einschalten', selected: a.type === 'switch' && a.on }), h('option', { value: 'off', text: 'ausschalten', selected: a.type === 'switch' && !a.on }), h('option', { value: 'toggle', text: 'umschalten (an ↔ aus)', selected: a.type === 'toggle' }));
      what.addEventListener('change', () => { if (what.value === 'toggle') { a.type = 'toggle'; delete a.on; delete a.duration; } else { a.type = 'switch'; a.on = what.value === 'on'; if (!a.on) delete a.duration; } redraw(); });
      fields.push(field('Was', what));
    } else if (t && a.type === 'dimmer') {
      const percent = h('input', { type: 'number', min: 0, max: 100, step: 5, value: a.percent, 'aria-label': 'Helligkeit in Prozent' });
      percent.addEventListener('input', () => { a.percent = percent.value === '' ? undefined : Math.round(Number(percent.value)); if (!a.percent) delete a.duration; preview(); });
      percent.addEventListener('change', redraw);
      fields.push(field('Helligkeit (%)', percent, '0 = ausschalten'));
    } else if (t && a.type === 'thermostat') {
      const temp = h('input', { type: 'number', min: t.thermostat.min, max: t.thermostat.max, step: 0.5, value: a.temperature, 'aria-label': 'Temperatur' });
      temp.addEventListener('input', () => { a.temperature = temp.value === '' ? undefined : Number(temp.value); preview(); });
      fields.push(field('Temperatur (°C)', temp, `${num(t.thermostat.min)} bis ${num(t.thermostat.max)} °C`));
    }
    if (t) {
      const delay = choice(DELAYS, a.delay || 0, 'Wann');
      delay.addEventListener('change', () => { const v = Number(delay.value); if (v) a.delay = v; else delete a.delay; preview(); });
      fields.push(field('Wann', delay));
      if ((a.type === 'switch' && a.on) || (a.type === 'dimmer' && a.percent > 0)) {
        const dur = choice(DURATIONS, a.duration || 0, 'Wie lange');
        dur.addEventListener('change', () => { const v = Number(dur.value); if (v) a.duration = v; else delete a.duration; preview(); });
        fields.push(field('Wie lange', dur, 'Danach wird automatisch ausgeschaltet.'));
      }
    }
    const remove = h('button', { class: 'btn small', type: 'button', text: 'Aktion entfernen', disabled: draft.actions.length < 2, onclick: () => { draft.actions.splice(index, 1); redraw(); } });
    return h('div', { class: 'card' }, h('div', { class: 'form' }, fields), h('div', { class: 'actions' }, remove));
  }
  function templates() {
    const firstSource = (key, kind) => cat.sources.find(s => s.key === key && (!kind || s.title === kind));
    const light = cat.targets.find(t => t.switch) || cat.targets.find(t => t.dimmer), heat = cat.targets.find(t => t.thermostat);
    const lightAction = extra => light ? [{ ...(light.switch ? { type: 'switch', address: light.address, on: true } : { type: 'dimmer', address: light.address, percent: 100 }), ...extra }] : null;
    const list = [];
    const motion = firstSource('MOTION'), key = firstSource('PRESS_SHORT'), contact = firstSource('STATE', 'Fenster / Tür');
    if (motion && light) list.push(['Licht bei Bewegung', { name: 'Licht bei Bewegung', trigger: { type: 'device', address: motion.address, key: 'MOTION', op: 'on' }, actions: lightAction({ duration: 180 }) }]);
    if (light) list.push(['Zeitschaltung', { name: 'Zeitschaltung', trigger: { type: 'time', time: '18:00', days: [0, 1, 2, 3, 4, 5, 6] }, actions: lightAction({}) }]);
    if (contact && heat) list.push(['Fenster offen: Heizung runter', { name: 'Fenster offen: Heizung runter', trigger: { type: 'device', address: contact.address, key: 'STATE', op: 'on' }, actions: [{ type: 'thermostat', address: heat.address, temperature: Math.max(12, heat.thermostat.min) }] }]);
    if (key && light) list.push(['Taste schaltet Licht', { name: 'Taste schaltet Licht', trigger: { type: 'device', address: key.address, key: 'PRESS_SHORT', op: 'event' }, actions: lightAction({}) }]);
    return list;
  }
  function openEditor(rule) {
    draft = rule || { name: '', enabled: true, trigger: { type: 'device' }, conditions: [], actions: [{}] };
    draft.conditions ||= [];
    renderEditor(); renderList(); editorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function closeEditor() { draft = null; previewEl = null; saveBtn = null; editorBox.replaceChildren(); renderList(); }
  let rendering = false;
  // Beim Neuzeichnen verliert ein Feld den Fokus und meldet dabei evtl. selbst eine Änderung:
  // dieser verschachtelte Aufruf wird übersprungen (der Entwurf ist bereits aktuell).
  function renderEditor() { if (rendering || !draft) return; rendering = true; try { drawEditor(); } finally { rendering = false; } }
  function drawEditor() {
    const redraw = () => renderEditor();
    const isNew = !draft.id, t = draft.trigger;
    const kind = h('select', { 'aria-label': 'Art des Auslösers' }, h('option', { value: 'device', text: 'Ein Gerät meldet etwas', selected: t.type === 'device' }), h('option', { value: 'time', text: 'Zu einer Uhrzeit', selected: t.type === 'time' }));
    kind.addEventListener('change', () => { draft.trigger = kind.value === 'time' ? { type: 'time', time: '07:00', days: [1, 2, 3, 4, 5] } : { type: 'device' }; redraw(); });
    const when = [field('Auslöser', kind)];
    if (t.type === 'time') {
      const time = h('input', { type: 'time', value: t.time, 'aria-label': 'Uhrzeit' });
      time.addEventListener('input', () => { t.time = time.value; preview(); });
      const boxes = DAYS.map(([d, n]) => { const c = h('input', { type: 'checkbox', checked: t.days.includes(d) }); c.addEventListener('change', () => { t.days = c.checked ? [...new Set([...t.days, d])] : t.days.filter(x => x !== d); preview(); }); return check(n, c); });
      const quick = (text, days) => h('button', { class: 'btn small', type: 'button', text, onclick: () => { t.days = days; redraw(); } });
      when.push(field('Uhrzeit', time), h('div', { class: 'wide' }, h('div', { class: 'checks days' }, boxes), h('div', { class: 'row' }, quick('Jeden Tag', [0, 1, 2, 3, 4, 5, 6]), quick('Mo–Fr', [1, 2, 3, 4, 5]), quick('Sa und So', [6, 0]))));
    } else when.push(...testFields(t, false, redraw));
    const conds = draft.conditions.map((c, i) => {
      const type = h('select', { 'aria-label': 'Art der Bedingung' }, h('option', { value: 'time', text: 'Nur in einem Zeitraum', selected: c.type === 'time' }), h('option', { value: 'sun', text: 'Nur wenn es dunkel/hell ist (Sonne)', selected: c.type === 'sun' }), h('option', { value: 'device', text: 'Nur wenn ein Gerät …', selected: c.type === 'device' }), h('option', { value: 'outdoor', text: 'Nur bei Außentemperatur (z. B. Frost)', selected: c.type === 'outdoor' }), h('option', { value: 'firedToday', text: 'Nur wenn eine andere Regel heute schon lief', selected: c.type === 'firedToday' }));
      type.addEventListener('change', () => { draft.conditions[i] = type.value === 'time' ? { type: 'time', from: '22:00', to: '06:00' } : type.value === 'sun' ? { type: 'sun', when: 'dark' } : type.value === 'outdoor' ? { type: 'outdoor', op: 'below', value: 1 } : type.value === 'firedToday' ? { type: 'firedToday', ruleId: '' } : { type: 'device' }; redraw(); });
      const fields = [field('Bedingung', type)];
      if (c.type === 'time') for (const [k, label] of [['from', 'Von'], ['to', 'Bis']]) { const input = h('input', { type: 'time', value: c[k], 'aria-label': label }); input.addEventListener('input', () => { c[k] = input.value; preview(); }); fields.push(field(label, input)); }
      else if (c.type === 'sun') { const w = h('select', { 'aria-label': 'Dunkel oder hell' }, h('option', { value: 'dark', text: 'dunkel (Sonnenuntergang bis Sonnenaufgang)', selected: c.when === 'dark' }), h('option', { value: 'light', text: 'hell (Sonnenaufgang bis Sonnenuntergang)', selected: c.when === 'light' })); w.addEventListener('change', () => { c.when = w.value; preview(); }); fields.push(field('Es ist …', w, 'Sonnenzeiten aus „Zeit & Standort“.')); }
      else if (c.type === 'outdoor') { const op = h('select', { 'aria-label': 'unter oder über' }, h('option', { value: 'below', text: 'unter', selected: c.op === 'below' }), h('option', { value: 'above', text: 'über', selected: c.op === 'above' })), v = h('input', { type: 'number', step: '0.5', min: -40, max: 50, value: c.value, 'aria-label': 'Grad' }); op.addEventListener('change', () => { c.op = op.value; preview(); }); v.addEventListener('input', () => { c.value = Number(v.value); preview(); });
        // Jetzt oder laut Vorhersage zu einer Uhrzeit (z. B. Abfahrt 06:50)
        const when = h('select', { 'aria-label': 'Wann' }, h('option', { value: '', text: 'jetzt', selected: !c.at }), h('option', { value: 'at', text: 'laut Vorhersage um …', selected: !!c.at })), at = h('input', { type: 'time', value: c.at || '06:50', 'aria-label': 'Uhrzeit der Vorhersage', hidden: !c.at });
        when.addEventListener('change', () => { if (when.value) c.at = at.value || '06:50'; else delete c.at; at.hidden = !c.at; preview(); }); at.addEventListener('input', () => { if (c.at !== undefined) c.at = at.value; preview(); });
        fields.push(field('Außentemperatur', op), field('°C', v, 'Wetter von Open-Meteo; ohne aktuellen Wert wird nicht ausgelöst.'), field('Gemessen', h('div', { class: 'row' }, when, at), 'Vorhersage z. B. für die Abfahrtszeit; fehlt sie, zählt die aktuelle Temperatur.')); }
      else if (c.type === 'firedToday') { const sel = h('select', { 'aria-label': 'Regel' }, h('option', { value: '', text: '– Regel wählen –' }), ...data.rules.filter(x => x.id !== draft.id).map(x => h('option', { value: x.id, text: x.name, selected: x.id === c.ruleId }))); sel.addEventListener('change', () => { c.ruleId = sel.value; preview(); }); fields.push(field('Regel', sel, 'Z. B. „Aus“ nur, wenn „Ein“ heute ausgelöst hat.')); }
      else fields.push(...testFields(c, true, redraw));
      return h('div', { class: 'card' }, h('div', { class: 'form' }, fields), h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', text: 'Bedingung entfernen', onclick: () => { draft.conditions.splice(i, 1); redraw(); } })));
    });
    const addCond = h('button', { class: 'btn small', type: 'button', text: '＋ Bedingung („nur wenn …“)', disabled: draft.conditions.length >= 4, onclick: () => { draft.conditions.push({ type: 'time', from: '22:00', to: '06:00' }); redraw(); } });
    const addAction = h('button', { class: 'btn small', type: 'button', text: '＋ Weitere Aktion', disabled: draft.actions.length >= 8, onclick: () => { draft.actions.push({}); redraw(); } });
    const name = h('input', { type: 'text', maxlength: 64, value: draft.name, placeholder: 'z. B. Licht Flur bei Bewegung', 'aria-label': 'Name der Automation' });
    name.addEventListener('input', () => { draft.name = name.value; });
    const note = h('input', { type: 'text', maxlength: 200, value: draft.note || '', placeholder: 'z. B. ersetzt CCU-Programm „Bad Lichtschaltung“', 'aria-label': 'Bemerkung zur Automation' });
    note.addEventListener('input', () => { draft.note = note.value; });
    const out = h('p', { class: 'msg', role: 'status' });
    previewEl = h('div', { class: 'notice', role: 'status' });
    saveBtn = h('button', { class: 'btn primary', type: 'button', text: isNew ? 'Automation anlegen' : 'Änderung speichern' });
    saveBtn.addEventListener('click', () => task(saveBtn, out, async () => {
      if (!draft.name.trim()) throw Error('Bitte einen Namen eingeben.');
      const r = await api('saveAutomation', { rule: { ...(draft.id ? { id: draft.id } : {}), name: draft.name, ...(draft.note && draft.note.trim() ? { note: draft.note.trim() } : {}), enabled: draft.enabled !== false, trigger: draft.trigger, conditions: draft.conditions, actions: draft.actions } });
      data = r; closeEditor(); msg(listOut, r.message, 'ok'); loadLog(); return r.message;
    }, 'Wird gespeichert …'));
    const tpl = isNew ? templates() : [];
    editorBox.replaceChildren(panel(isNew ? 'Neue Automation' : 'Automation ändern', 'Drei Schritte: Wenn – Dann – Name. Unten steht der fertige Satz zum Gegenlesen.',
      tpl.length ? h('div', {}, h('p', { class: 'muted', text: 'Schnellstart mit einer Vorlage (danach anpassen):' }), h('div', { class: 'row' }, tpl.map(([label, rule]) => h('button', { class: 'btn small', type: 'button', text: label, onclick: () => { draft = { enabled: true, conditions: [], ...JSON.parse(JSON.stringify(rule)) }; redraw(); } })))) : null,
      h('h3', { text: '1. Wenn' }), h('div', { class: 'form' }, when), conds, h('div', { class: 'actions' }, addCond),
      h('h3', { text: '2. Dann' }), draft.actions.map((a, i) => actionFields(a, i, redraw)), h('div', { class: 'actions' }, addAction),
      h('h3', { text: '3. Name und speichern' }), h('div', { class: 'form' }, h('div', { class: 'wide' }, field('Name', name)), h('div', { class: 'wide' }, field('Bemerkung (erscheint in der Liste neben dem Namen)', note))), previewEl,
      h('div', { class: 'actions' }, saveBtn, h('button', { class: 'btn', type: 'button', text: 'Abbrechen', onclick: closeEditor })), out,
      !cat.targets.length ? h('div', { class: 'notice warn', text: 'Es wurde kein schaltbares Gerät gefunden. Geräte erscheinen hier, sobald die Zentrale verbunden ist.' }) : null));
    preview();
  }
  newBtn.addEventListener('click', async () => { try { cat = await api('getAutomationCatalog'); } catch (e) { msg(listOut, e.message, 'bad'); return; } openEditor(null); });

  // ---------- Bisherige Programme der Zentrale (nur ansehen und von Hand starten) ----------
  let oldLoaded = false;
  oldDetails.addEventListener('toggle', async () => {
    if (!oldDetails.open || oldLoaded) return; oldLoaded = true;
    oldBox.replaceChildren(h('div', { class: 'empty', text: 'Wird geladen …' }));
    try {
      const programs = (await api('getCcuPrograms')).programs || [], out = h('p', { class: 'msg', role: 'status' });
      if (!programs.length) { oldBox.replaceChildren(h('div', { class: 'empty', text: 'In der Zentrale sind keine Programme angelegt.' })); return; }
      oldBox.replaceChildren(out, h('div', { class: 'auto-list' }, programs.map(p => {
        const start = h('button', { class: 'btn small', type: 'button', text: 'Starten', disabled: !admin });
        start.addEventListener('click', async () => {
          if (!await confirmDialog({ title: 'Programm starten?', text: `„${p.name}“ wird jetzt in der Zentrale ausgeführt. Dabei können Geräte geschaltet werden.`, confirm: 'Jetzt starten' })) return;
          task(start, out, async () => (await api('runCcuProgram', { id: p.id })).message, 'Programm wird gestartet …');
        });
        // Zugeklappt: nur Überschrift (Name, Bemerkung, Zustand); Pfeil zeigt Einzelheiten und Bemerkung ändern.
        const short = s => s.length > 90 ? s.slice(0, 89) + '…' : s;
        const noteSpan = h('span', { class: 'muted', title: p.info || '', text: p.info ? ' – ' + short(p.info) : '' });
        const noteIn = h('input', { type: 'text', maxlength: 200, value: p.info || '', placeholder: 'Bemerkung (erscheint in der Überschrift)', 'aria-label': 'Bemerkung zu ' + p.name, disabled: !admin, style: 'flex:1;min-width:220px' });
        const saveNote = h('button', { class: 'btn small', type: 'button', text: 'Bemerkung speichern', disabled: !admin });
        saveNote.addEventListener('click', () => task(saveNote, out, async () => {
          const r = await api('setCcuProgramNote', { id: p.id, note: noteIn.value });
          p.info = noteIn.value.trim(); noteSpan.textContent = p.info ? ' – ' + short(p.info) : ''; noteSpan.title = p.info;
          return r.message;
        }, 'Wird gespeichert …'));
        return h('details', { class: 'auto-item' },
          h('summary', {}, h('b', { text: p.name }), noteSpan, ' ', h('span', { class: 'tag ' + (p.active ? 'ok' : ''), text: p.active ? 'aktiv' : 'inaktiv' })),
          h('div', { class: 'auto-body' }, h('p', { class: 'muted', text: 'Zuletzt ausgeführt: ' + (p.lastRun || '–') }),
            h('div', { class: 'row' }, noteIn, saveNote), h('div', { class: 'row', style: 'margin-top:8px' }, start)));
      })));
    } catch (e) { oldLoaded = false; oldBox.replaceChildren(h('div', { class: 'notice bad', text: 'Programme der Zentrale nicht lesbar: ' + e.message })); }
  });

  NEU.ensureSession().then(s => {
    admin = s.admin === true;
    if (!admin) adminNote.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, 'Zum Anlegen und Ändern bitte als CCU-Administrator anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' }))));
    return api('getAutomationCatalog').then(c => { cat = c; glFilled = syFilled = bsB.filled = gbB.filled = false; glShow(); syShow(); bsShow(); gbShow(); if (admin) { efLoad(); bwLoad(); jlLoad(); kiLoad(); asDevices(); } else efPanel.hidden = bwPanel.hidden = jlPanel.hidden = asPanel.hidden = true; }).catch(() => {});
  }).catch(() => {}).finally(load);
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
});
