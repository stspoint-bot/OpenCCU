'use strict';
// Seite „Zeit & Standort“ (Wunsch Thomas, 12.10.2026): ersetzt „Zeit-/Positionseinstellung“ der alten OpenCCU.
// Zeitzone, Standort (für Sonnenauf-/untergang und Wetter), Zeitserver, aktuelle Uhrzeit und Abgleich. Nur Administratoren.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task, stat } = NEU;
  const main = shell({ title: 'Zeit & Standort', eyebrow: 'System', lead: 'Uhrzeit, Zeitzone und Standort der Zentrale. Der Standort bestimmt Sonnenauf- und -untergang für die Automationen und das Wetter. Er bleibt auf der Zentrale und wird nur als gerundete Koordinate an den Wetterdienst gegeben.' });
  const stats = h('div', { class: 'stats' }), out = h('p', { class: 'msg', role: 'status' }), out2 = h('p', { class: 'msg', role: 'status' });
  const ZONES = ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/Amsterdam', 'Europe/Brussels', 'Europe/Paris', 'Europe/Rome', 'Europe/Madrid', 'Europe/London', 'Europe/Lisbon', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Copenhagen', 'Europe/Oslo', 'Europe/Helsinki', 'Europe/Athens', 'Europe/Istanbul', 'UTC'];
  const list = h('datalist', { id: 'zeitzonen' }, ...ZONES.map(z => h('option', { value: z })));
  const f = { timezone: h('input', { type: 'text', list: 'zeitzonen', autocomplete: 'off', spellcheck: 'false' }), country: h('input', { type: 'text', maxlength: 64 }), city: h('input', { type: 'text', maxlength: 64 }),
    lat: h('input', { type: 'number', step: '0.000001', min: -90, max: 90 }), lon: h('input', { type: 'number', step: '0.000001', min: -180, max: 180 }) };
  const ntp = h('textarea', { rows: 4, spellcheck: 'false', 'aria-label': 'Zeitserver' });
  const save = h('button', { class: 'btn primary', type: 'button', text: 'Zeitzone und Standort speichern' }), saveNtp = h('button', { class: 'btn primary', type: 'button', text: 'Zeitserver speichern' });
  const here = h('button', { class: 'btn', type: 'button', text: 'Standort dieses Geräts übernehmen' });
  // Ortssuche: Ort eintippen → Land, Ort und Koordinaten werden automatisch eingetragen (bleiben änderbar).
  const q = h('input', { type: 'search', placeholder: 'Ort suchen, z. B. Rheinfelden', 'aria-label': 'Ort suchen' }), find = h('button', { class: 'btn', type: 'button', text: 'Suchen' }), hits = h('div');
  find.addEventListener('click', async () => {
    try { const r = await api('suchWetterOrt', undefined, { query: { name: q.value.trim() } });
      hits.replaceChildren(...(r.results.length ? r.results.map(x => { const b = h('button', { class: 'btn small', type: 'button', text: x.name + (x.region ? ' (' + x.region + ')' : '') }); b.addEventListener('click', () => { f.city.value = x.name; f.lat.value = x.lat; f.lon.value = x.lon; const parts = (x.region || '').split(', '); if (parts.length) f.country.value = parts[parts.length - 1]; hits.replaceChildren(); msg(out, 'Übernommen – bitte noch speichern.', 'ok'); }); return h('div', { style: 'margin:4px 0' }, b); }) : [h('p', { class: 'muted', text: 'Nichts gefunden.' })]));
    } catch (e) { msg(out, e.message, 'bad'); }
  });
  q.addEventListener('keydown', e => { if (e.key === 'Enter') find.click(); });
  main.append(stats, list,
    panel('Zeitzone und Standort', 'Breiten- und Längengrad als Dezimalzahl (Norden/Osten positiv). Ein ungefährer Ort genügt.', h('div', { class: 'row' }, q, find), hits, h('div', { class: 'form' }, field('Zeitzone', f.timezone), field('Land', f.country), field('Ort', f.city), field('Breitengrad', f.lat), field('Längengrad', f.lon)), h('div', { class: 'actions' }, save, here), out),
    panel('Zeitserver (NTP)', 'Die Zentrale stellt ihre Uhr automatisch über diese Server. Ein Server je Zeile.', ntp, h('div', { class: 'actions' }, saveNtp), out2));
  function render(d) { renderStats(d); fill(d); }
  function renderStats(d) {
    stats.replaceChildren(stat('Uhrzeit', d.localTime.split(', ')[1] || d.localTime, d.localTime.split(', ')[0] || ''),
      stat('Abgleich', d.sync && d.sync.offsetMs != null ? (Math.abs(d.sync.offsetMs) < 1 ? '< 1 ms' : d.sync.offsetMs.toLocaleString('de-DE') + ' ms') : '–', d.sync?.source ? 'Zeitserver ' + d.sync.source : 'Abweichung zur Atomzeit', d.sync ? 'ok' : undefined),
      stat('Sonnenaufgang', d.sun ? d.sun.rise : '–', 'heute'), stat('Sonnenuntergang', d.sun ? d.sun.set : '–', d.sun ? 'heute' : 'Standort fehlt', d.sun ? undefined : 'warn'));
  }
  function fill(d) {
    // Leere Felder automatisch vorbelegen (bleiben änderbar, erst „Speichern“ übernimmt sie).
    let browserZone = ''; try { browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    f.timezone.value = d.timezone || browserZone || 'Europe/Berlin'; f.country.value = d.country || ''; f.city.value = d.city || ''; f.lat.value = d.lat ?? ''; f.lon.value = d.lon ?? ''; ntp.value = (d.ntpServers && d.ntpServers.length ? d.ntpServers : ['0.de.pool.ntp.org', '1.de.pool.ntp.org', '2.de.pool.ntp.org', '3.de.pool.ntp.org']).join('\n');
  }
  save.addEventListener('click', () => task(save, out, async () => {
    const lat = Number(f.lat.value), lon = Number(f.lon.value);
    if (f.lat.value === '' || f.lon.value === '' || !Number.isFinite(lat) || !Number.isFinite(lon)) throw Error('Bitte Breiten- und Längengrad eingeben.');
    const r = await api('saveZeitStandort', { timezone: f.timezone.value.trim(), country: f.country.value, city: f.city.value, lat, lon }); render(r); return r.message;
  }, 'Wird gespeichert …'));
  saveNtp.addEventListener('click', () => task(saveNtp, out2, async () => { const r = await api('saveZeitserver', { servers: ntp.value.split(/[\s,]+/).filter(Boolean) }); render(r); return r.message; }, 'Wird gespeichert …'));
  here.addEventListener('click', () => {
    if (!navigator.geolocation) { msg(out, 'Dieser Browser kann den Standort nicht bestimmen.', 'bad'); return; }
    msg(out, 'Standort wird bestimmt …', 'busy');
    navigator.geolocation.getCurrentPosition(p => { f.lat.value = p.coords.latitude.toFixed(4); f.lon.value = p.coords.longitude.toFixed(4); msg(out, 'Übernommen – bitte noch speichern.', 'ok'); }, () => msg(out, 'Standort nicht verfügbar (Browser-Freigabe oder HTTPS nötig). Bitte von Hand eingeben.', 'bad'), { timeout: 15000 });
  });
  async function load() { try { render(await api('getZeitStandort')); } catch (e) { msg(out, e.message, 'bad'); save.disabled = saveNtp.disabled = true; } }
  load(); setInterval(() => { if (!document.hidden) api('getZeitStandort').then(renderStats).catch(() => {}); }, 60000);
});
