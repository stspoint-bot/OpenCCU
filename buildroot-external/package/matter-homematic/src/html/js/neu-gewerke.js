'use strict';
// Seite „Gewerke“ (Wunsch Thomas, 12.10.2026): eigene Liste der Gewerke (z. B. Licht, Heizung, Sicherheit) anlegen,
// umbenennen und löschen – und die Geräte direkt hier zuordnen (Auswahlliste, ✕ zum Entfernen).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg, task, confirmDialog } = NEU;
  const main = shell({ title: 'Gewerke', eyebrow: 'Zuhause', lead: 'Gewerke ordnen Geräte nach Zweck (Licht, Heizung, Sicherheit …). Geräte direkt hier zuordnen oder in der Geräteverwaltung beim Gerät.' });
  const name = h('input', { type: 'text', maxlength: 40, placeholder: 'Neues Gewerk, z. B. Garten', 'aria-label': 'Neues Gewerk' }), add = h('button', { class: 'btn primary', type: 'button', text: 'Anlegen' });
  const out = h('p', { class: 'msg', role: 'status' }), list = h('div', { class: 'gw-list' });
  main.append(panel('Neues Gewerk', null, h('div', { class: 'gw-row gw-new' }, name, add), out), panel('Gewerke', null, list));
  let geraete = [], zuordnung = {};
  // Alle Geräte: CCU-Geräte (Geräteverwaltung) und Integrationen (Geräteliste)
  async function loadDevices() {
    const [gv, all, rz] = await Promise.all([api('getGeraeteVerwaltung'), api('getDevices').catch(() => ({ devices: [] })), api('getRaumZuordnung').catch(() => ({ assign: {} }))]);
    zuordnung = { ...(gv.gewerkJe || {}) };
    geraete = [...gv.devices.filter(d => !d.central).map(d => ({ address: d.address, name: d.name, room: (d.rooms || [])[0] || '' })),
      ...(all.devices || []).filter(d => d.provider).map(d => ({ address: d.address, name: d.name || d.address, room: (rz.assign || {})[d.address] || '' }))]
      .sort((a, b) => (a.room || '~').localeCompare(b.room || '~', 'de') || a.name.localeCompare(b.name, 'de'));
  }
  const label = d => (d.room ? d.room + ' · ' : '') + d.name;
  async function assign(address, gewerk) { await api('setGeraetRaumGewerk', { address, gewerk }); if (gewerk) zuordnung[address] = gewerk; else delete zuordnung[address]; }
  function render(d) {
    list.replaceChildren(...(d.liste.length ? d.liste.map(g => {
      const input = h('input', { type: 'text', maxlength: 40, value: g.name, 'aria-label': 'Name des Gewerks' }), ren = h('button', { class: 'btn small', type: 'button', text: 'Umbenennen' }), del = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen' });
      ren.addEventListener('click', () => task(ren, out, async () => { const v = input.value.trim(); if (!v || v === g.name) return 'Keine Änderung.'; render(await api('saveGewerke', { action: 'rename', name: g.name, newName: v })); await refresh(); return '„' + g.name + '“ heißt jetzt „' + v + '“.'; }));
      del.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Gewerk löschen?', text: '„' + g.name + '“ wird gelöscht' + (g.geraete ? ' und bei ' + g.geraete + ' Gerät(en) entfernt' : '') + '.', confirm: 'Löschen', danger: true })) return; task(del, out, async () => { render(await api('saveGewerke', { action: 'delete', name: g.name })); await refresh(); return 'Gelöscht.'; }); });
      // Geräte dieses Gewerks
      const mine = geraete.filter(x => zuordnung[x.address] === g.name);
      const chips = h('div', { class: 'gw-chips' }, ...mine.map(x => { const c = h('button', { class: 'gw-chip', type: 'button', title: 'Aus „' + g.name + '“ entfernen', text: label(x) + ' ✕' }); c.addEventListener('click', () => task(c, out, async () => { await assign(x.address, ''); await refresh(); return label(x) + ' entfernt.'; })); return c; }));
      const pick = h('select', { class: 'gw-pick', 'aria-label': 'Gerät zu ' + g.name + ' hinzufügen' }, h('option', { value: '', text: '＋ Gerät hinzufügen …' }), ...geraete.filter(x => zuordnung[x.address] !== g.name).map(x => h('option', { value: x.address, text: label(x) + (zuordnung[x.address] ? ' (bisher ' + zuordnung[x.address] + ')' : '') })));
      pick.addEventListener('change', () => { if (!pick.value) return; const x = geraete.find(y => y.address === pick.value); task(null, out, async () => { await assign(x.address, g.name); await refresh(); return label(x) + ' → ' + g.name + '.'; }); });
      return h('div', { class: 'gw-card' }, h('div', { class: 'gw-row' }, input, h('span', { class: 'muted gw-count', text: mine.length + ' Gerät(e)' }), ren, del), chips, pick);
    }) : [h('div', { class: 'empty', text: 'Noch keine Gewerke.' })]));
  }
  async function refresh() { await loadDevices(); render(await api('getGewerke')); }
  add.addEventListener('click', () => task(add, out, async () => { const v = name.value.trim(); if (!v) throw Error('Bitte einen Namen eingeben.'); render(await api('saveGewerke', { action: 'add', name: v })); name.value = ''; await refresh(); return '„' + v + '“ angelegt.'; }));
  name.addEventListener('keydown', e => { if (e.key === 'Enter') add.click(); });
  refresh().catch(e => msg(out, e.message, 'bad'));
});
