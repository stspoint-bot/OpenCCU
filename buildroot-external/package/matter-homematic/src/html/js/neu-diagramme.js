'use strict';
// Seite „Diagramme“: Verlauf der aufgezeichneten Messwerte je Gerät (eigene SVG-Grafik, ohne Bibliothek).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg } = NEU;
  const main = shell({ title: 'Diagramme', eyebrow: 'Zuhause', lead: 'Verlauf von Temperatur, Luftfeuchte, Helligkeit, Schaltzuständen und – bei Steckdosen mit Messung (Tasmota, Smart Life) – Leistung, Spannung und Strom. Aufgezeichnet wird automatisch – auf der CCU (14 Tage) und, wenn eingeschaltet, auf der WD (länger).' });
  const device = h('select', { 'aria-label': 'Gerät' }), range = h('select', { 'aria-label': 'Zeitraum' }, [[24, 'Letzte 24 Stunden'], [72, 'Letzte 3 Tage'], [168, 'Letzte 7 Tage'], [336, 'Letzte 14 Tage'], [720, 'Letzte 30 Tage (WD)'], [2208, 'Letzte 3 Monate (WD)']].map(([v, t]) => h('option', { value: v, text: t })));
  const out = h('p', { class: 'msg', role: 'status' }), charts = h('div'), source = h('p', { class: 'muted' });
  // Aufzeichnung (früher eigene Seite „Netzwerkspeicher“; der WD-Zugang selbst steht nur noch unter „Sicherung & Wiederherstellung“)
  const every = h('select', { 'aria-label': 'Messabstand' }, [[5, 'alle 5 Minuten'], [10, 'alle 10 Minuten'], [15, 'alle 15 Minuten'], [30, 'alle 30 Minuten'], [60, 'stündlich']].map(([v, t]) => h('option', { value: v, text: t })));
  const local = h('input', { type: 'checkbox' }), recSave = h('button', { class: 'btn', type: 'button', text: 'Speichern' }), recOut = h('p', { class: 'msg', role: 'status' }), recInfo = h('p', { class: 'muted' });
  const recPanel = panel('Aufzeichnung', 'Wie oft Messwerte gespeichert werden. Mit verbundener WD liegen sie zusätzlich dort (länger als 14 Tage).', h('div', { class: 'form' }, NEU.field('Messabstand', every), h('div', { class: 'wide' }, NEU.check('Auch auf der CCU speichern (letzte 14 Tage)', local))), recInfo, h('div', { class: 'actions' }, recSave, h('a', { class: 'btn', href: '/backup-storage.html', text: 'WD-Zugang einrichten' })), recOut);
  main.append(panel('Verlauf', null, h('div', { class: 'form' }, NEU.field('Gerät', device), NEU.field('Zeitraum', range)), source, out, charts), recPanel);
  let rec = null;
  api('getNetStorage').then(d => { rec = d.settings; every.value = String(rec.intervalMinutes || 10); local.checked = rec.recordLocal !== false; recInfo.textContent = rec.enabled ? 'WD verbunden: ' + rec.host + ' / ' + rec.share : 'Keine WD verbunden – Messwerte nur auf der CCU.'; }).catch(() => { recPanel.hidden = true; });
  recSave.addEventListener('click', () => NEU.task(recSave, recOut, async () => {
    if (!rec) throw Error('Einstellungen noch nicht geladen.');
    // Gleiche Speicherung wie der WD-Zugang; Passwort bleibt erhalten (leer = unverändert)
    const r = await api('saveNetStorage', { enabled: rec.enabled, host: rec.host, share: rec.share, folder: rec.folder, user: rec.user, password: '', intervalMinutes: Number(every.value), recordLocal: local.checked });
    rec = r.settings || rec; return 'Aufzeichnung gespeichert.';
  }, 'Wird gespeichert …'));
  const ns = 'http://www.w3.org/2000/svg', el = (t, a) => { const e = document.createElementNS(ns, t); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
  function chart(s, hours) {
    const W = 720, H = 220, L = 46, R = 12, T = 12, B = 28, pts = s.points.map(([t, v]) => [Date.parse(t), v]);
    const t1 = Date.now(), t0 = t1 - hours * 3600000, step = /Ein\/Aus/.test(s.metric);
    let lo = Math.min(...pts.map(p => p[1])), hi = Math.max(...pts.map(p => p[1])); if (step) { lo = 0; hi = 1; } if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.08; if (!step) { lo -= pad; hi += pad; }
    // Nachkommastellen nach Wertebereich: Strom in A (z. B. 0,102) braucht mehr Stellen als Leistung in W.
    const digits = hi - lo < 0.5 ? 3 : hi - lo < 2 ? 2 : 1;
    const x = t => L + (t - t0) / (t1 - t0) * (W - L - R), y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': s.metric + ' Verlauf', style: 'width:100%;height:auto' });
    for (let i = 0; i <= 4; i++) { const v = lo + (hi - lo) * i / 4, yy = y(v); svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: '#e3e9e6' })); const tx = el('text', { x: L - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#738487' }); tx.textContent = step ? (v >= 0.5 ? (i === 4 ? 'Ein' : '') : (i === 0 ? 'Aus' : '')) : v.toLocaleString('de-DE', { maximumFractionDigits: digits }); svg.append(tx); }
    for (let i = 0; i <= 4; i++) { const t = t0 + (t1 - t0) * i / 4, tx = el('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', 'font-size': 10, fill: '#738487' }); tx.textContent = new Date(t).toLocaleString('de-DE', hours > 48 ? { day: '2-digit', month: '2-digit', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' }); svg.append(tx); }
    let d = ''; pts.forEach(([t, v], i) => { if (step && i) d += `H${x(t).toFixed(1)}`; d += `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`; });
    svg.append(el('path', { d, fill: 'none', stroke: '#176c60', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const last = pts.at(-1), vals = pts.map(p => p[1]);
    const summary = step ? 'zuletzt ' + (last[1] ? 'Ein' : 'Aus') : 'aktuell ' + last[1].toLocaleString('de-DE') + ' ' + s.unit + ' · min ' + Math.min(...vals).toLocaleString('de-DE') + ' · max ' + Math.max(...vals).toLocaleString('de-DE');
    return h('div', { class: 'card', style: 'margin-bottom:16px' }, h('div', { class: 'card-head' }, h('b', { text: s.metric + (s.unit ? ' (' + s.unit + ')' : '') }), h('span', { class: 'muted', text: summary })), svg);
  }
  let loaded = false;
  async function load() {
    try {
      const d = await api('getHistory', undefined, { query: { address: device.value || '', hours: range.value } });
      if (!loaded) {
        // Aktuelle Geräte oben; was es nicht mehr gibt oder nichts mehr liefert, steht gesammelt unter „Archiv“
        const opt = x => h('option', { value: x.address, text: x.name + (x.room && x.room !== x.name ? ' · ' + x.room : '') + (x.archiv ? (x.gone ? ' (gibt es nicht mehr)' : ' (keine neuen Werte)') : '') });
        const akt = d.devices.filter(x => !x.archiv), arch = d.devices.filter(x => x.archiv);
        device.replaceChildren(...(d.devices.length ? [...akt.map(opt), ...(arch.length ? [h('optgroup', { label: '📦 Archiv (' + arch.length + ')' }, ...arch.map(opt))] : [])] : [h('option', { value: '', text: 'Noch keine Aufzeichnungen' })]));
        loaded = true; if (d.devices.length) return load();
      }
      source.textContent = d.source === 'wd' ? 'Daten von der WD (bis ' + d.maxDays + ' Tage).' : 'Daten von der CCU (letzte ' + (d.maxDays || 14) + ' Tage)' + (d.sourceError ? ' – WD gerade nicht erreichbar: ' + d.sourceError : '.');
      if (Number(range.value) > d.hours) msg(out, 'Längere Zeiträume gibt es nur mit eingeschalteter WD-Aufzeichnung. Gezeigt: letzte ' + Math.round(d.hours / 24) + ' Tage.', 'warn'); else out.textContent = '';
      charts.replaceChildren(...(d.series.length ? d.series.filter(s => s.points.length).map(s => chart(s, d.hours)) : [h('div', { class: 'empty', text: d.devices.length ? 'Für diesen Zeitraum liegen keine Werte vor.' : 'Noch keine Aufzeichnungen. Die erste Messung erfolgt wenige Minuten nach dem Start der Bridge.' })]));
    } catch (e) { msg(out, e.message, 'bad'); }
  }
  device.addEventListener('change', load); range.addEventListener('change', load);
  load();
});
