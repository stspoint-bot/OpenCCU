'use strict';
// Seite „Wetter“ (Wunsch Thomas, 12.10.2026): aktuelles Wetter und Vorhersage (24 Stunden, 5 Tage) von Open-Meteo,
// mit animierten Wetterbildern. Kein zusätzlicher Abruf – die Bridge holt die Werte ohnehin alle 30 Minuten.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg } = NEU;
  // Auf der Übersicht (Wunsch Thomas) unter „Zentrale“ eingebettet, sonst eigene Seite.
  let slot = document.getElementById('wetter-uebersicht');
  // Handy-Seite (Wunsch Thomas): Wetter als eigene Seite – Platzhalter anlegen, die Handy-Seite setzt ihn auf Seite „Wetter“
  if (!slot && location.pathname === '/mobil.html') { slot = h('div', { id: 'wetter-uebersicht' }); document.body.append(slot); }
  const main = slot || shell({ title: 'Wetter', eyebrow: 'Zuhause', lead: 'Aktuelles Wetter und Vorhersage für den Standort der Zentrale (Open-Meteo, kostenlos).' });
  const hero = h('div', { class: 'w-hero' }), hours = h('div', { class: 'w-hours' }), days = h('div'), out = h('p', { class: 'msg', role: 'status' });
  // Ort wählen (Wunsch Thomas): eigene Orte anlegen und auswählen, welcher angezeigt wird.
  const ortSel = h('select', { 'aria-label': 'Angezeigter Ort', style: 'max-width:240px' }), ortEdit = h('button', { class: 'btn small', type: 'button', text: 'Orte verwalten' });
  const ortBox = h('div', { class: 'card', hidden: true }), ortOut = h('p', { class: 'msg', role: 'status' });
  const ortRow = h('div', { class: 'row', style: 'margin-bottom:10px' }, h('span', { class: 'muted', text: 'Ort:' }), ortSel, ortEdit);
  let orte = [], aktiv = '';
  const saveOrte = async (list, ort) => { const r = await api('saveWetter', { orte: list, ort }); orte = r.settings.orte; aktiv = r.settings.ort; fillOrte(); render(r); };
  function fillOrte() {
    ortSel.replaceChildren(h('option', { value: '', text: 'Standort der Zentrale' }), ...orte.map(o => h('option', { value: o.name, text: o.name })));
    ortSel.value = aktiv;
    const q = h('input', { type: 'search', placeholder: 'Ort suchen, z. B. Rheinfelden', 'aria-label': 'Ort suchen', style: 'flex:1 1 220px' }), find = h('button', { class: 'btn small', type: 'button', text: 'Suchen' }), results = h('div');
    find.addEventListener('click', async () => {
      try { const r = await api('suchWetterOrt', undefined, { query: { name: q.value.trim() } });
        results.replaceChildren(...(r.results.length ? r.results.map(x => { const b = h('button', { class: 'btn small', type: 'button', text: '＋ ' + x.name + (x.region ? ' (' + x.region + ')' : '') }); b.addEventListener('click', () => saveOrte([...orte.filter(o => o.name !== x.name), { name: x.name, lat: x.lat, lon: x.lon }], aktiv).then(() => msg(ortOut, x.name + ' hinzugefügt.', 'ok')).catch(e => msg(ortOut, e.message, 'bad'))); return h('div', { style: 'margin:4px 0' }, b); }) : [h('p', { class: 'muted', text: 'Nichts gefunden.' })]));
      } catch (e) { msg(ortOut, e.message, 'bad'); }
    });
    q.addEventListener('keydown', e => { if (e.key === 'Enter') find.click(); });
    ortBox.replaceChildren(h('b', { text: 'Eigene Orte' }), ...orte.map(o => { const x = h('button', { class: 'btn small', type: 'button', text: '✕', title: o.name + ' entfernen' }); x.addEventListener('click', () => saveOrte(orte.filter(y => y.name !== o.name), aktiv === o.name ? '' : aktiv).catch(e => msg(ortOut, e.message, 'bad'))); return h('div', { class: 'row' }, h('span', { text: o.name }), x); }),
      h('div', { class: 'row', style: 'margin-top:8px' }, q, find), results, ortOut);
  }
  ortSel.addEventListener('change', () => saveOrte(orte, ortSel.value).catch(e => { msg(out, e.message, 'bad'); ortSel.value = aktiv; }));
  ortEdit.addEventListener('click', () => { ortBox.hidden = !ortBox.hidden; });
  main.append(ortRow, ortBox, hero, out, panel('Nächste 24 Stunden', 'Temperatur und Regenwahrscheinlichkeit je Stunde.', hours), panel('Nächste Tage', 'Tiefst- und Höchsttemperatur, Regenwahrscheinlichkeit.', days));
  // Wetterart aus dem WMO-Code
  const kind = c => c == null ? 'cloud' : c <= 1 ? 'clear' : c === 2 ? 'partly' : c === 3 ? 'cloud' : c <= 48 ? 'fog' : c <= 67 || (c >= 80 && c <= 82) ? 'rain' : c <= 86 ? 'snow' : 'storm';
  // Animierte Szene als SVG-Elemente (feste Bausteine)
  const s = (tag, attrs = {}, kids = []) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); e.append(...kids); return e; };
  const SUN = () => s('g', { class: 'w-sun' }, [s('g', { class: 'w-rays' }, [0, 45, 90, 135, 180, 225, 270, 315].map(a => s('line', { x1: 50, y1: 12, x2: 50, y2: 5, transform: `rotate(${a} 50 30)` }))), s('circle', { cx: 50, cy: 30, r: 12 })]);
  const MOON = () => [s('g', { class: 'w-moon' }, [s('path', { d: 'M56 16a15 15 0 1 0 10 26a12 12 0 1 1-10-26z' })]),
    ...[[20, 14, 1.4], [80, 10, 1.2], [30, 34, 1], [84, 40, 1.3]].map(([cx, cy, r], i) => s('circle', { class: 'w-star d' + (i + 1), cx, cy, r }))];
  const CLOUD = cls => s('path', { class: 'w-cloud ' + cls, d: 'M28 62h44a12 12 0 0 0 0-24a17 17 0 0 0-32-5a13 13 0 0 0-12 29z' });
  const DROPS = () => [26, 38, 50, 62, 74].map((x, i) => s('line', { class: 'w-drop d' + (i % 4 + 1), x1: x, y1: 66, x2: x - 2, y2: 72 }));
  const FLAKES = () => [28, 40, 52, 64, 76].map((x, i) => s('circle', { class: 'w-flake d' + (i % 4 + 1), cx: x, cy: 68, r: 1.8 }));
  const BOLT = () => s('polygon', { class: 'w-bolt', points: '52,56 44,70 50,70 46,80 58,64 52,64 56,56' });
  const FOG = () => [44, 54, 64].map((y, i) => s('line', { class: 'w-fogline d' + (i + 1), x1: 18, y1: y, x2: 82, y2: y }));
  function scene(k, day, size) {
    const sky = () => day === false ? MOON() : [SUN()];
    const body = k === 'clear' ? sky() : k === 'partly' ? [...sky(), CLOUD('w-front')] : k === 'cloud' ? [CLOUD('w-back'), CLOUD('w-front')] : k === 'fog' ? [CLOUD('w-back'), ...FOG()]
      : k === 'rain' ? [CLOUD('w-front'), ...DROPS()] : k === 'snow' ? [CLOUD('w-front'), ...FLAKES()] : [CLOUD('w-dark'), BOLT(), ...DROPS()];
    return h('div', { class: 'w-scene ' + (day === false ? 'night' : 'day') }, s('svg', { viewBox: '0 0 100 82', width: size, height: Math.round(size * 0.82), 'aria-hidden': 'true' }, body));
  }
  const fmt = (v, unit, digits = 0) => v == null ? '–' : (digits ? v.toFixed(digits).replace('.', ',') : Math.round(v)) + unit;
  const hhmm = iso => iso ? iso.slice(11, 16) : '–';
  const fact = (label, value) => h('div', { class: 'w-fact' }, h('div', { class: 'w-fact-l', text: label }), h('div', { class: 'w-fact-v', text: value }));
  function render(d) {
    const c = d.current, fc = d.forecast || { hours: [], days: [] }, today = fc.days[0];
    if (!c) { hero.className = 'w-hero grey'; hero.replaceChildren(h('div', { text: d.error || 'Noch keine Wetterdaten – der erste Abruf erfolgt kurz nach dem Start.' })); return; }
    const k = kind(c.code), night = c.day === false;
    hero.className = 'w-hero ' + (night ? 'night' : k === 'storm' ? 'storm' : ['cloud', 'fog', 'rain', 'snow'].includes(k) ? 'grey' : 'sunny');
    hero.replaceChildren(scene(k, c.day, 200), h('div', {},
      h('div', { class: 'w-temp', text: fmt(c.temperature, '°', 0) }),
      h('div', { class: 'w-text', text: (c.text || '') + (c.apparent != null ? ' · gefühlt ' + fmt(c.apparent, '°') : '') }),
      today ? h('div', { class: 'w-sub', text: 'Heute ' + fmt(today.min, '°') + ' bis ' + fmt(today.max, '°') + (today.rain != null ? ' · Regen ' + today.rain + ' %' : '') }) : null,
      h('div', { class: 'w-facts' },
        fact('Luftfeuchte', fmt(c.humidity, ' %')), fact('Wind', fmt(c.wind, ' km/h')), fact('Luftdruck', fmt(c.pressure, ' hPa')),
        fact('Wolken', fmt(c.cloud, ' %')), fact('Niederschlag', fmt(c.precipitation, ' mm', 1)),
        today ? fact('Sonne', hhmm(today.sunrise) + ' – ' + hhmm(today.sunset)) : null)));
    hours.replaceChildren(...(fc.hours.length ? fc.hours.map(x => {
      const hr = Number(x.time.slice(11, 13)), isDay = today?.sunrise && today?.sunset ? hr >= Number(today.sunrise.slice(11, 13)) && hr < Number(today.sunset.slice(11, 13)) : true;
      return h('div', { class: 'w-hour' }, h('div', { class: 'muted', text: x.time.slice(11, 16) }), scene(kind(x.code), isDay, 44), h('b', { text: fmt(x.temperature, '°') }), h('div', { class: 'w-rain', text: x.rain ? '💧 ' + x.rain + ' %' : ' ' }));
    }) : [h('div', { class: 'empty', text: 'Vorhersage folgt mit dem nächsten Abruf.' })]));
    const all = fc.days.flatMap(x => [x.min, x.max]).filter(v => v != null), lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
    days.replaceChildren(...fc.days.map((x, i) => {
      const bar = h('span'); if (x.min != null && x.max != null) { bar.style.left = ((x.min - lo) / span * 100) + '%'; bar.style.width = Math.max(4, (x.max - x.min) / span * 100) + '%'; }
      const name = i === 0 ? 'Heute' : i === 1 ? 'Morgen' : new Date(x.date + 'T12:00').toLocaleDateString('de-DE', { weekday: 'long' });
      return h('div', { class: 'w-day' }, h('div', {}, h('b', { text: name }), h('div', { class: 'muted', text: x.text })), scene(kind(x.code), true, 40),
        h('div', { class: 'w-minmax' }, h('span', { text: fmt(x.min, '°') }), h('div', { class: 'w-range' }, bar), h('span', { text: fmt(x.max, '°') })), h('div', { class: 'w-rain', text: x.rain != null ? '💧 ' + x.rain + ' %' : '' }));
    }));
    msg(out, d.error ? d.error : 'Stand: ' + (d.at ? new Date(d.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : '–') + ' · ' + (d.location?.name || 'Standort der Zentrale') + ' · ' + d.source, d.error ? 'warn' : 'ok');
  }
  let first = true;
  async function load() { try { const d = await api('getWetter'); if (first) { orte = d.settings?.orte || []; aktiv = d.settings?.ort || ''; fillOrte(); first = false; } render(d); } catch (e) { msg(out, 'Wetter nicht lesbar: ' + e.message, 'bad'); } }
  load(); setInterval(() => { if (!document.hidden) load(); }, 5 * 60000);
});
