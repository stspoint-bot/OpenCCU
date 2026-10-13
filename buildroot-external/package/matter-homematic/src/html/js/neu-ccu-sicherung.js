'use strict';
// Sicherung des kompletten Systems (CCU-Sicherung .sbk – Geräte, Einstellungen, Zusatzsoftware samt Matter-Bridge).
// Seit 12.10.2026 abends Teil der EINEN Seite „Sicherung & Wiederherstellung“ (Wunsch Thomas: nicht zwei Seiten):
// Zeitplan (alle X Tage um HH:MM), jede Sicherung automatisch auch auf die WD, Liste der letzten 3 auf der CCU und bis zu
// 10 auf der WD, Wiederherstellen per Klick (von der WD holen → prüfen → aktuellen Stand sichern → Schieberegler → einspielen).
// neu-sicherung.js ruft window.mhCcuSicherung(container) auf und stellt diesen Teil oben auf die Seite.
window.mhCcuSicherung = container => {
  const { h, api, panel, field, msg, task, confirmDialog, ensureSession, fmtDate, toggle } = NEU;
  const out = h('p', { class: 'msg', role: 'status' }), jobBox = h('p', { class: 'muted' }), wdBox = h('p', { class: 'muted' });
  const ccuList = h('div'), wdList = h('div');
  const make = h('button', { class: 'btn primary', type: 'button', text: 'Jetzt komplett sichern' });
  // Zeitplan
  const pl = { on: h('input', { type: 'checkbox' }), days: h('select', { 'aria-label': 'Abstand' }, [[1, 'jeden Tag'], [2, 'alle 2 Tage'], [3, 'alle 3 Tage'], [7, 'jede Woche'], [14, 'alle 2 Wochen'], [30, 'alle 30 Tage']].map(([v, t]) => h('option', { value: v, text: t }))), time: h('input', { type: 'time', value: '03:00' }) };
  const plSave = h('button', { class: 'btn', type: 'button', text: 'Zeitplan speichern' }), plInfo = h('p', { class: 'muted' }), plOut = h('p', { class: 'msg', role: 'status' });
  // Eigene Datei hochladen
  const file = h('input', { type: 'file', accept: '.sbk', 'aria-label': 'Sicherung (.sbk) wählen' }), up = h('button', { class: 'btn', type: 'button', text: 'Hochladen und prüfen', disabled: true });
  const bar = h('progress', { max: 100, value: 0, hidden: true, style: 'width:100%' });
  // ---- Überblick (Wunsch Thomas): was, wo, letzte, nächste, Prüfung – mit Ampel, aktualisiert sich jede Minute ----
  const ovBox = h('div', { class: 'cards' }), ovStand = h('p', { class: 'muted' });
  const AMPEL = { gruen: ['ok', '🟢'], gelb: ['warn', '🟡'], rot: ['bad', '🔴'], grau: ['', '⚪'] };
  const when = v => { if (v === null || v === undefined || v === '') return '–'; const t = typeof v === 'number' ? new Date(v * 1000) : new Date(v); return Number.isFinite(t.getTime()) ? t.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + ' Uhr' : '–'; };
  const PRUEF = { ok: 'in Ordnung ✓', falsch: 'FEHLER – Sicherung passt nicht', defekt: 'FEHLER – Sicherung beschädigt', unbekannt: 'noch nicht geprüft', laeuft: 'wird gerade geprüft …' };
  // Knopf je Kästchen (Wunsch Thomas): die Sicherung dieses Bereichs jetzt selbst auslösen
  const JETZT = { 'ccu3-komplett': ['Jetzt komplett sichern', 'Die Zentrale erstellt jetzt eine vollständige Sicherung (einige Minuten) und kopiert sie auf die WD. Alles läuft dabei normal weiter.'],
    ccu3: ['Bridge jetzt sichern', 'Die Matter-Bridge wird jetzt gesichert (etwa 1 Minute) und auf die WD kopiert. Alles läuft dabei normal weiter.'],
    'webseite-taeglich': ['Jetzt sichern', 'Die WD startet die tägliche Sicherung der Webseite in wenigen Sekunden.'],
    'webseite-komplett': ['Jetzt komplett sichern', 'Die WD startet die Komplettsicherung in wenigen Sekunden (dauert etwa 2 Minuten).'],
    wochenbericht: ['Bericht jetzt senden', 'Die WD schickt den Wochenbericht in wenigen Sekunden per WhatsApp.'] };
  const ovMsg = new Map();
  function card(ampel, title, rows, id) {
    const [cls, dot] = AMPEL[ampel] || AMPEL.grau, o = h('p', { class: 'msg', role: 'status', text: ovMsg.get(id) || '' });
    let btn = null;
    if (id && JETZT[id]) {
      btn = h('button', { class: 'btn small', type: 'button', text: '▶ ' + JETZT[id][0] });
      btn.addEventListener('click', async () => { if (!await confirmDialog({ title: JETZT[id][0] + '?', text: JETZT[id][1], confirm: JETZT[id][0] })) return; task(btn, o, async () => { const r = await api('starteSicherungJetzt', { id }); ovMsg.set(id, r.message); setTimeout(() => { loadOv(); load(); }, 3000); return r.message; }, 'Wird gestartet …'); });
    }
    return h('div', { class: 'card ov-card' }, h('div', { class: 'ov-head' }, h('b', { text: dot + ' ' + title }), h('span', { class: 'tag ' + cls, text: ampel === 'gruen' ? 'alles gut' : ampel === 'gelb' ? 'bitte ansehen' : ampel === 'rot' ? 'Handlungsbedarf' : 'unbekannt' })),
      h('dl', { class: 'ov-rows' }, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])), btn ? h('div', { class: 'actions' }, btn) : null, o);
  }
  function renderOv(o) {
    const cards = [], c = o.ccu, alterTage = c.letzte ? (Date.now() - Date.parse(c.letzte)) / 86400000 : Infinity;
    // Grund für Gelb/Rot in Worten (Thomas: „was ist mit bitte ansehen gemeint?“)
    const gruende = [!c.letzte && 'noch keine Sicherung', c.pruefung === 'falsch' && 'Prüfung fehlgeschlagen', c.pruefung === 'laeuft' && 'Prüfung läuft noch', c.pruefung === 'unbekannt' && 'neueste Sicherung noch nicht geprüft',
      c.aufWd === false && 'neueste Sicherung noch nicht auf der WD', !c.everyDays && 'kein Zeitplan eingeschaltet', c.everyDays && c.letzte && alterTage > c.everyDays * 1.5 && 'letzte Sicherung älter als geplant'].filter(Boolean);
    const ccuAmpel = !c.letzte || c.pruefung === 'falsch' ? 'rot' : gruende.length ? 'gelb' : 'gruen';
    cards.push(card(ccuAmpel, 'CCU3 – komplettes System', [['Grund', gruende.length ? gruende.join(' · ') : null],['Was', 'Geräte, Einstellungen, Zusatzsoftware samt Matter-Bridge und Apple-Home-Kopplung'], ['Wo', c.wo + (c.aufWd === false ? ' (neueste noch nicht auf der WD)' : '')], ['Letzte', when(c.letzte)], ['Nächste', c.everyDays ? when(c.naechste) : 'kein Zeitplan – unten einschalten'], ['Zeitplan', c.zeitplan], ['Prüfung', PRUEF[c.pruefung] || c.pruefung], ['Gerade', c.job]], 'ccu3-komplett'));
    const w = o.wd;
    if (!w.eingerichtet) cards.push(card('gelb', 'WD (Netzwerkspeicher)', [['Zustand', 'nicht verbunden – unten „WD (Netzwerkspeicher) verbinden“']]));
    else if (w.meldetSichNicht) cards.push(card('rot', 'WD (Netzwerkspeicher)', [['Zustand', 'WD meldet sich nicht' + (w.status?.erstelltText ? ' (letzte Meldung ' + w.status.erstelltText + ')' : '')], ['Hinweis', w.fehler]]));
    if (w.status) for (const b of w.status.bereiche) {
      const alt = w.meldetSichNicht, ueberfaellig = b.naechste && b.naechste * 1000 < Date.now() - 6 * 3600000;
      const amp = alt ? 'grau' : b.pruefung === 'falsch' || b.pruefung === 'defekt' ? 'rot' : b.pruefung === 'unbekannt' || b.stickErreichbar === false || ueberfaellig ? 'gelb' : 'gruen';
      const grundWd = [alt && 'WD meldet sich nicht', (b.pruefung === 'falsch' || b.pruefung === 'defekt') && 'Prüfung fehlgeschlagen', b.pruefung === 'unbekannt' && 'noch nicht geprüft', b.stickErreichbar === false && 'USB-Stick nicht erreichbar', ueberfaellig && 'geplante Sicherung überfällig'].filter(Boolean);
      const naechste = b.id === 'ccu3' ? (c.everyDays ? when(c.naechste) + ' (komplett) – Bridge-Sicherung vor jeder Installation' : 'Bridge-Sicherung vor jeder Installation') : (b.naechsteText || when(b.naechste));
      cards.push(card(amp, b.name || b.id, [['Grund', grundWd.length ? grundWd.join(' · ') : null], ['Was', b.inhalt], ['Wo', b.ort], ['Letzte', b.letzteText || when(b.letzte)], ['Ergebnis', b.ergebnis], ['Nächste', naechste], ['Rhythmus', b.rhythmus], ['Anzahl', b.anzahl !== null ? b.anzahl + (b.aufbewahrung ? ' (aufbewahrt: ' + b.aufbewahrung + ')' : '') : null], ['Prüfung', b.pruefung ? PRUEF[b.pruefung] : null], ['USB-Stick', b.stickErreichbar === false ? 'NICHT erreichbar' : b.stickFreiGB ? 'erreichbar, ' + b.stickFreiGB + ' GB frei' : null], ['Kopie auf Stick', b.kopieStick ? b.kopieStick + (b.kopienStick !== null ? ' – ' + b.kopienStick + ' vorhanden' : '') : null], ['Gerade', b.id === 'ccu3' ? c.bridgeJob : null], ['Auftrag', b.auftragText]], JETZT[b.id] ? b.id : null));
    }
    if (w.status?.wochenbericht) { const r = w.status.wochenbericht; cards.push(card('grau', 'Wochenbericht', [['Weg', r.weg], ['Rhythmus', r.rhythmus], ['Zuletzt', r.letzteText || '–'], ['Nächster', r.naechsteText], ['Auftrag', r.auftragText]], 'wochenbericht')); }
    ovBox.replaceChildren(...cards);
    ovStand.textContent = 'Stand: ' + new Date(o.jetzt).toLocaleTimeString('de-DE') + (w.status?.erstelltText ? ' · WD-Meldung von ' + w.status.erstelltText : '') + ' · aktualisiert sich jede Minute';
  }
  const loadOv = () => api('getSicherungsUeberblick').then(renderOv).catch(e => { ovStand.textContent = 'Überblick nicht lesbar: ' + e.message; });
  setInterval(() => { if (!document.hidden) loadOv(); }, 60000);
  container.append(panel('Überblick', 'Was gesichert wird, wo es liegt, wann zuletzt, wann als Nächstes und ob die Prüfung in Ordnung ist.', ovBox, ovStand),
    h('p', { class: 'notice' }, 'Zustand der WD (Speicher, Temperatur, Festplatte, Dienste, kompletter Bericht): ', h('a', { href: '/systemzustand.html', text: '🚦 Systemzustand → WD im Detail' })));
  container.append(
    panel('Komplettes System sichern', 'Sichert die ganze Zentrale (Geräte, Einstellungen, Zusatzsoftware samt Matter-Bridge und Apple-Home-Kopplung). Ist die WD verbunden, kommt jede Sicherung automatisch auch dorthin. Auf der CCU bleiben die letzten 3, auf der WD die neuesten 10.',
      h('div', { class: 'actions' }, make), jobBox, wdBox,
      h('h3', { text: 'Zeitplan' }), h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(pl.on, 'Automatisch sichern')), field('Wie oft', pl.days), field('Uhrzeit', pl.time)), h('div', { class: 'actions' }, plSave), plInfo, plOut),
    panel('Sicherungen & Wiederherstellen', 'Wiederherstellen: Sicherung wählen → sie wird (falls nötig) von der WD geholt und geprüft → vorher wird der jetzige Stand gesichert → nach der Rückfrage startet die Zentrale neu (5–10 Minuten).', out,
      h('h3', { text: 'Auf der CCU (letzte 3)' }), ccuList, h('h3', { text: 'Auf der WD (bis zu 10)' }), wdList,
      h('details', { class: 'more' }, h('summary', { text: 'Eigene .sbk-Datei hochladen' }), h('div', { class: 'row' }, file, up), bar)));
  let data = null, poll = null;
  const size = b => (b / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' MB';
  const fresh = () => data?.frischGesichert === true || (data?.files || []).some(f => f.kind === 'erstellt' && (f.heruntergeladen || f.aufWd) && Date.now() - Date.parse(f.at) < 2 * 3600000);
  // Einspielen mit Führung: fehlt eine frische Sicherung des jetzigen Stands, wird sie zuerst angeboten
  async function einspielen(f, o, btn) {
    if (!f.geprueft?.ok) { if (f.pruefungLaeuft) { msg(o, 'Die Prüfung läuft noch – bitte warten.', 'warn'); return; } task(btn, o, async () => { await api('pruefeCcuSicherung', { name: f.name }); await load(); return 'Wird zuerst geprüft (einige Minuten) – danach erneut „Wiederherstellen“.'; }, 'Prüfung wird gestartet …'); return; }
    if (!fresh()) {
      if (!await confirmDialog({ title: 'Erst den jetzigen Stand sichern', text: 'Beim Wiederherstellen ersetzt die Zentrale alles. Damit nichts verloren geht, wird jetzt zuerst der aktuelle Stand gesichert' + (data?.wd?.bereit ? ' und auf die WD kopiert' : ' (danach bitte herunterladen)') + '. Danach erneut „Wiederherstellen“ wählen.', confirm: 'Jetzt sichern' })) return;
      task(btn, o, async () => { data = await api('createCcuSicherung', { bestaetigt: true }); render(); return 'Aktueller Stand wird gesichert – danach erneut „Wiederherstellen“.'; }); return;
    }
    if (!await confirmDialog({ title: 'Sicherung einspielen?', danger: true, slider: true, confirm: 'Einspielen und neu starten', text: f.name + ' (' + fmtDate(f.at) + '): Die Zentrale ersetzt ALLE Einstellungen, Geräte und Zusatzsoftware durch den Stand dieser Sicherung und startet neu (5–10 Minuten). Währenddessen funktionieren Apple Home und Automationen nicht. Nicht vom Strom trennen.' })) return;
    task(btn, o, async () => { const r = await api('spieleCcuSicherungEin', { name: f.name, bestaetigt: true }); clearInterval(poll); make.disabled = true; msg(out, r.message, 'busy'); return 'Gestartet.'; }, 'Wird gestartet …');
  }
  function render() {
    const j = data.job || {}, w = data.wd || {}, p = data.plan || {};
    jobBox.textContent = j.state === 'running' ? '⏳ ' + j.message : j.state === 'done' ? '✔ ' + j.message : j.state === 'error' ? '⚠ ' + j.message : '';
    make.disabled = j.state === 'running' || data.restoring;
    wdBox.textContent = !w.bereit ? '⚠ WD nicht verbunden – Sicherungen bleiben nur auf der CCU (höchstens 3). WD unten unter „WD (Netzwerkspeicher) verbinden“ eintragen.' : w.laeuft ? '⏳ Wird mit der WD abgeglichen …' : w.fehler ? '⚠ ' + w.fehler : w.letzte ? '✔ Zuletzt auf die WD: ' + w.letzte.name + ' (' + fmtDate(w.letzte.at) + ')' : '✔ WD verbunden – jede Sicherung kommt automatisch auch dorthin.';
    if (!pl.on.dataset.loaded) { pl.on.checked = !!p.enabled; pl.days.value = String(p.everyDays || 7); pl.time.value = p.time || '03:00'; pl.on.dataset.loaded = '1'; }
    plInfo.textContent = p.enabled ? 'Nächste Sicherung: ' + (p.naechste ? fmtDate(p.naechste) : '–') + (p.letzte ? ' · letzte geplante: ' + fmtDate(p.letzte) : '') : 'Zeitplan aus – nur von Hand.';
    if (data.restoring) msg(out, 'Die Sicherung wird eingespielt – die Zentrale startet neu.', 'busy');
    ccuList.replaceChildren(...(data.files.length ? data.files.map(f => {
      const o = h('span', { class: 'msg', role: 'status' });
      const dl = h('a', { class: 'btn small', href: '/api/?method=downloadCcuSicherung&name=' + encodeURIComponent(f.name), download: f.name, text: '⬇ Herunterladen' }); dl.addEventListener('click', () => setTimeout(load, 4000));
      const rs = h('button', { class: 'btn small danger', type: 'button', text: 'Wiederherstellen …', disabled: data.restoring || j.state === 'running' }); rs.addEventListener('click', () => einspielen(f, o, rs));
      const del = h('button', { class: 'btn small', type: 'button', text: '✕', title: 'Von der Zentrale löschen' });
      del.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Sicherung löschen?', text: f.name + ' wird von der Zentrale gelöscht' + (f.heruntergeladen || f.aufWd ? '.' : ' – sie wurde noch NICHT heruntergeladen und liegt nicht auf der WD!'), confirm: 'Löschen', danger: true })) return; task(del, o, async () => { data = await api('loescheCcuSicherung', { name: f.name }); render(); return 'Gelöscht.'; }); });
      const tags = [h('span', { class: 'tag', text: f.kind }), f.aufWd ? h('span', { class: 'tag ok', text: 'auf der WD ✓' }) : w.bereit ? h('span', { class: 'tag warn', text: 'noch nicht auf der WD' }) : null, f.pruefungLaeuft ? h('span', { class: 'tag warn', text: '⏳ wird geprüft …' }) : f.geprueft ? h('span', { class: 'tag ' + (f.geprueft.ok ? 'ok' : 'bad'), title: f.geprueft.message || '', text: f.geprueft.ok ? 'geprüft ✓' : 'Prüfung fehlgeschlagen' }) : null];
      return h('div', { class: 'card' }, h('div', {}, h('b', { text: fmtDate(f.at) }), ' ', ...tags), h('div', { class: 'sub', text: f.name + ' · ' + size(f.size) }), h('div', { class: 'actions' }, rs, dl, del), o);
    }) : [h('div', { class: 'empty', text: 'Noch keine Sicherung auf der CCU.' })]));
    const local = new Set(data.files.map(f => f.name));
    wdList.replaceChildren(...(!w.bereit ? [h('p', { class: 'muted', text: 'WD nicht verbunden.' })] : w.lesefehler ? [h('p', { class: 'msg bad', text: 'WD nicht lesbar: ' + w.lesefehler })] : (w.files || []).length ? w.files.map(f => {
      const o = h('span', { class: 'msg', role: 'status' }), rs = h('button', { class: 'btn small danger', type: 'button', text: local.has(f.name) ? 'Liegt auch auf der CCU ↑' : 'Wiederherstellen …', disabled: local.has(f.name) || w.laeuft || data.restoring });
      rs.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Diese Sicherung wiederherstellen?', text: 'Die Sicherung vom ' + fmtDate(f.at) + ' wird von der WD auf die CCU geholt und geprüft (einige Minuten). Danach erscheint sie oben unter „Auf der CCU“ – dort „Wiederherstellen …“ wählen.', confirm: 'Von der WD holen' })) return; task(rs, o, async () => { const r = await api('holeCcuSicherungWd', { name: f.name }); await load(); return r.message; }, 'Wird gestartet …'); });
      return h('div', { class: 'card' }, h('div', {}, h('b', { text: fmtDate(f.at) }), ' ', h('span', { class: 'tag ok', text: 'WD' })), h('div', { class: 'sub', text: f.name + ' · ' + size(f.size) }), h('div', { class: 'actions' }, rs), o);
    }) : [h('p', { class: 'muted', text: 'Noch keine Sicherung auf der WD.' })]));
    clearInterval(poll); if (j.state === 'running' || data.files.some(x => x.pruefungLaeuft) || w.laeuft) poll = setInterval(() => load(), 5000);
  }
  async function load(wdNeu) { try { data = await api('getCcuSicherungen', undefined, wdNeu ? { query: { wd: '1' } } : undefined); render(); } catch (e) { msg(out, e.message, 'bad'); } }
  make.addEventListener('click', async () => {
    if (!await confirmDialog({ title: 'Komplett sichern?', text: 'Die Zentrale erstellt jetzt eine vollständige Sicherung (einige Minuten)' + (data?.wd?.bereit ? ' und kopiert sie auf die WD' : '') + '. Alles läuft dabei normal weiter.', confirm: 'Sichern' })) return;
    task(make, out, async () => { data = await api('createCcuSicherung', { bestaetigt: true }); render(); return 'Sicherung wird erstellt – diese Seite aktualisiert sich selbst.'; });
  });
  plSave.addEventListener('click', () => task(plSave, plOut, async () => { const r = await api('setCcuSicherungPlan', { enabled: pl.on.checked, everyDays: Number(pl.days.value), time: pl.time.value }); data = r; render(); return r.message; }, 'Wird gespeichert …'));
  file.addEventListener('change', () => { up.disabled = !file.files.length; });
  up.addEventListener('click', () => task(up, out, async () => {
    const f = file.files[0]; if (!f) throw Error('Bitte eine .sbk-Datei wählen.'); if (!/\.sbk$/i.test(f.name)) throw Error('Nur CCU-Sicherungen (.sbk).');
    const s = await ensureSession(); bar.hidden = false; bar.value = 0;
    // In Teilen zu 8 MB hochladen (der Webserver nimmt eine Anfrage höchstens 30 s lang an); Fortschritt je Teil
    const PART = 8 * 1048576; let id = '', r = null;
    const send = (startAt, blob) => new Promise((ok, no) => {
      const x = new XMLHttpRequest(); x.open('POST', '/api/?method=uploadCcuSicherung&datei=' + encodeURIComponent(f.name) + '&start=' + startAt + '&gesamt=' + f.size + (id ? '&id=' + id : ''));
      x.setRequestHeader('Content-Type', 'application/octet-stream'); x.setRequestHeader('X-CSRF-Token', s.csrf);
      x.upload.onprogress = e => { if (e.lengthComputable) bar.value = Math.round((startAt + e.loaded) / f.size * 100); };
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status === 200 ? ok(d) : no(Error(d.error || 'Hochladen fehlgeschlagen')); };
      x.onerror = () => no(Error('Hochladen abgebrochen')); x.send(blob);
    });
    try { for (let pos = 0; pos < f.size; pos += PART) { r = await send(pos, f.slice(pos, Math.min(f.size, pos + PART))); if (r.id) id = r.id; } } finally { bar.hidden = true; }
    file.value = ''; up.disabled = true; await load();
    return 'Hochgeladen. Die Datei wird jetzt geprüft (einige Minuten) – danach oben „Wiederherstellen …“ wählen.';
  }, 'Wird hochgeladen …'));
  load(true); loadOv();
};
