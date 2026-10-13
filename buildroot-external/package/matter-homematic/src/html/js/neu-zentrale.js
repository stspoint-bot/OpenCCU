'use strict';
// Seite „Gerätemeldungen“: was die Geräte melden (Batterie, Erreichbarkeit …) und wie es dem Funk geht.
// Die Meldungen stammen aus den Rückmeldungen der Geräte, die die Bridge selbst empfängt. Arbeitsspeicher, Speicher,
// Temperatur und Laufzeit der CCU3 stehen seit 13.10.2026 nur noch auf der Ampelseite „🚦 Systemzustand“ (Wunsch Thomas).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, stat, table, msg, fmtDate } = NEU;
  const main = shell({ title: 'Gerätemeldungen', eyebrow: 'Geräte', lead: 'Was deine Geräte gerade melden und wie es dem Funk geht. Wie es der CCU3 und der WD insgesamt geht, zeigt die Ampel unter „🚦 Systemzustand“.' });
  const stats = h('div', { class: 'stats' });
  const out = h('p', { class: 'msg', role: 'status' });
  const list = h('div');
  const refresh = h('button', { class: 'btn', type: 'button', text: 'Aktualisieren' });
  const checked = h('span', { class: 'muted' });
  main.append(stats, panel('Meldungen der Geräte', 'Batterie, Funkverbindung und Störungen. Eine Meldung verschwindet von selbst, sobald das Gerät wieder in Ordnung ist.', h('div', { class: 'actions' }, refresh, checked), out, list));

  const LEVEL = { bad: ['Dringend', 'color:var(--bad);background:var(--bad-soft)'], warn: ['Bald erledigen', 'color:var(--warn);background:var(--warn-soft)'], info: ['Hinweis', ''] };
  function render(data) {
    const s = data.system || {}, m = data.messages;
    const urgent = m ? m.filter(x => x.level === 'bad').length : 0;
    const radio = s.radio || [], radioDown = radio.filter(r => !r.connected);
    stats.replaceChildren(
      stat('Meldungen', m ? String(m.length) : '–', m ? (m.length ? (urgent ? urgent + ' dringend' : 'nichts Dringendes') : 'alles in Ordnung') : 'nicht lesbar', m ? (urgent ? 'bad' : m.length ? 'warn' : 'ok') : 'bad'),
      stat('Geräte', s.devices !== null && s.devices !== undefined ? String(s.devices) : '–', 'an der Zentrale angelernt'),
      stat('Funk', radio.length ? (radioDown.length ? 'gestört' : 'verbunden') : '–', radio.length ? (radioDown.length ? radioDown.map(r => r.name).join(', ') + ' nicht verbunden' : radio.map(r => r.name).join(', ')) : 'unbekannt', radioDown.length ? 'bad' : radio.length ? 'ok' : undefined),
      stat('Sendezeit Funk', s.dutyCycle !== null && s.dutyCycle !== undefined ? s.dutyCycle + ' %' : '–', 'Stand ' + new Date().toLocaleTimeString('de-DE') + ' · Limit 100 %', s.dutyCycle > 80 ? 'bad' : s.dutyCycle > 60 ? 'warn' : undefined));
    checked.textContent = 'Stand: ' + new Date(data.checkedAt).toLocaleTimeString('de-DE');
    if (!m) { list.replaceChildren(h('div', { class: 'notice bad', text: 'Meldungen konnten nicht gelesen werden: ' + (data.messagesError || 'unbekannt') })); return; }
    if (!m.length) { list.replaceChildren(h('div', { class: 'empty', text: 'Keine Meldungen. Alle Geräte sind in Ordnung.' })); return; }
    list.replaceChildren(table(['Meldung', 'Gerät', 'Was tun?', 'Bemerkt'], m.map(row => h('tr', {},
      h('td', {}, h('span', { class: 'tag', style: LEVEL[row.level][1], text: row.label }), h('span', { class: 'sub', text: LEVEL[row.level][0] })),
      h('td', {}, h('b', { text: row.device }), h('span', { class: 'sub', text: (row.room ? row.room + ' · ' : '') + row.address })),
      h('td', {}, row.type === 'UPDATE_PENDING' ? updateButton(row) : row.hint), h('td', { text: fmtDate(row.since) })))));
  }
  // „Geräte-Update steht bereit“: Klick installiert die Firmware (Schieberegler-Rückfrage; nur Geräte, nur Administratoren – prüft der Server)
  function updateButton(row) {
    const b = h('button', { class: 'btn small primary', type: 'button', text: '⬆ Update jetzt installieren' }), o = h('span', { class: 'msg', role: 'status' });
    b.addEventListener('click', async () => {
      if (!await NEU.confirmDialog({ title: 'Firmware installieren?', danger: true, slider: true, confirm: 'Installieren', text: row.device + ' (' + row.address + '): Die bereitliegende Firmware wird eingespielt. Das dauert einige Minuten, das Gerät ist währenddessen nicht bedienbar. Nicht stromlos machen; Batteriegeräte vorher kurz wecken.' })) return;
      b.disabled = true; NEU.msg(o, 'Update wird gestartet …', 'busy');
      try { const r = await NEU.api('startFirmwareUpdate', { address: row.address }); NEU.msg(o, r.message, 'ok'); } catch (e) { NEU.msg(o, e.message, 'bad'); b.disabled = false; }
    });
    return h('div', {}, h('div', { class: 'sub', text: 'Neue Firmware liegt bereit.' }), b, o);
  }
  let loading = false;
  async function load() {
    if (loading) return; loading = true; refresh.disabled = true;
    try { render(await api('getCcuOverview')); msg(out, ''); } catch (e) { msg(out, e.message, 'bad'); } finally { loading = false; refresh.disabled = false; }
  }
  refresh.addEventListener('click', load);
  load(); setInterval(() => { if (!document.hidden) load(); }, 15000);
});
