'use strict';
// Seite „Neue Geräte anlernen“: Anlernmodus starten, neues Gerät benennen, einem Raum zuordnen
// und für Apple Home freigeben – alles in dieser Oberfläche.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, toggle, msg, task, stat } = NEU;
  const main = shell({ title: 'Neue Geräte anlernen', eyebrow: 'Geräte', crumb: 'Geräte', lead: 'Homematic- und Homematic-IP-Geräte mit der CCU3 verbinden, benennen und in Apple Home bereitstellen.' });
  const stats = h('div', { class: 'stats' });
  const iface = h('select', { 'aria-label': 'Funkschnittstelle' }, h('option', { value: 'all', text: 'Homematic IP und Homematic' }), h('option', { value: 'HmIP-RF', text: 'Nur Homematic IP' }), h('option', { value: 'BidCos-RF', text: 'Nur Homematic (BidCos)' }));
  const seconds = h('select', { 'aria-label': 'Dauer' }, [[60, '1 Minute'], [120, '2 Minuten'], [180, '3 Minuten'], [300, '5 Minuten']].map(([v, t]) => h('option', { value: v, text: t, selected: v === 120 })));
  const startBtn = h('button', { class: 'btn primary', type: 'button', text: 'Anlernmodus starten' }), stopBtn = h('button', { class: 'btn', type: 'button', text: 'Anlernmodus beenden', disabled: true });
  const out = h('p', { class: 'msg', role: 'status' }), fresh = h('div'), freshOut = h('p', { class: 'msg', role: 'status' }), adminNote = h('div');
  main.append(adminNote, stats,
    panel('1. Anlernmodus starten', 'Die CCU3 sucht dann für die gewählte Zeit nach neuen Geräten.', h('div', { class: 'form' }, field('Funkschnittstelle', iface), field('Dauer', seconds)), h('div', { class: 'actions' }, startBtn, stopBtn), out),
    panel('2. Gerät in den Anlernmodus bringen', null, h('ol', { class: 'steps' },
      h('li', {}, h('span', { text: 'Homematic IP: Batterie einlegen bzw. Isolierstreifen ziehen, oder die Systemtaste kurz drücken – die LED blinkt orange.' })),
      h('li', {}, h('span', { text: 'Homematic (BidCos): die Anlerntaste (Config-Taste) kurz drücken – die LED blinkt.' })),
      h('li', {}, h('span', { text: 'Gerät nah an die CCU3 halten (1–2 m). Nach etwa 15 Sekunden erscheint es unten.' })))),
    panel('3. Neues Gerät einrichten', 'Namen vergeben, Raum wählen und für Apple Home einschalten. Mit „Fertig“ verschwindet das Gerät aus dieser Liste; es bleibt unter „Geräte“ erreichbar.', freshOut, fresh),
    panel('WLAN-Geräte mit Tasmota', 'Steckdosen, Schalter, Dimmer und Fühler mit Tasmota-Firmware werden nicht angelernt, sondern im Heimnetz gesucht.', h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/tasmota.html', text: 'Tasmota-Geräte hinzufügen' }))),
    keyPanel());
  // Anlernen per Seriennummer und Schlüssel (ersetzt „Geräte anlernen“ der alten CCU)
  function keyPanel() {
    const sgtin = h('input', { type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: '3014-F711-A000-…', 'aria-label': 'SGTIN' }), key = h('input', { type: 'text', maxlength: 40, autocomplete: 'off', spellcheck: 'false', placeholder: '32 Zeichen vom Aufkleber', 'aria-label': 'Gerätekey' });
    const serial = h('input', { type: 'text', maxlength: 10, autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. MEQ1234567', 'aria-label': 'Seriennummer' });
    const goIp = h('button', { class: 'btn primary', type: 'button', text: 'Homematic IP mit Schlüssel anlernen' }), goHm = h('button', { class: 'btn', type: 'button', text: 'Homematic per Seriennummer anlernen' }), o = h('p', { class: 'msg', role: 'status' });
    goIp.addEventListener('click', () => task(goIp, o, async () => { const r = await api('startInstallWithKey', { sgtin: sgtin.value, key: key.value }); key.value = ''; load(); return r.message; }, 'Wird gestartet …'));
    goHm.addEventListener('click', () => task(goHm, o, async () => { const r = await api('startInstallWithKey', { serial: serial.value }); load(); return r.message; }, 'Wird angelernt …'));
    return panel('Anlernen per Seriennummer und Schlüssel', 'Für Geräte, die einen Schlüssel vom Aufkleber verlangen (Homematic IP: SGTIN und KEY) oder für Homematic-Geräte per Seriennummer. Der Schlüssel wird nur zum Anlernen gesendet und nicht gespeichert.',
      h('div', { class: 'form' }, field('SGTIN (Homematic IP)', sgtin), field('Gerätekey / KEY', key)), h('div', { class: 'actions' }, goIp),
      h('div', { class: 'form' }, field('Seriennummer (Homematic)', serial)), h('div', { class: 'actions' }, goHm), o);
  }

  let timer = null, busy = false, admin = false, rooms = [], rows = [], shown = '';
  const editing = new Set();
  function deviceCard(dev) {
    const mine = rows.filter(r => typeof r.address === 'string' && r.address.startsWith(dev.address + ':') && !r.provider);
    const done = h('button', { class: 'btn primary small', type: 'button', text: 'Fertig', disabled: !admin });
    done.addEventListener('click', () => task(done, freshOut, async () => { const r = await api('finishNewDevice', { address: dev.address }); shown = ''; await load(true); return r.message; }));
    const lines = mine.map(row => {
      const name = h('input', { type: 'text', maxlength: 64, value: row.name || '', 'aria-label': 'Name für ' + row.address, disabled: !admin });
      name.addEventListener('focus', () => editing.add(row.address)); name.addEventListener('blur', () => editing.delete(row.address));
      const save = h('button', { class: 'btn small', type: 'button', text: 'Name speichern', disabled: !admin });
      save.addEventListener('click', () => task(save, freshOut, async () => { const value = name.value.trim(); if (!value) throw Error('Bitte einen Namen eingeben.'); const r = await api('setDeviceName', { address: row.address, name: value }); row.name = r.name || value; return '„' + row.name + '“ gespeichert.'; }));
      const room = h('select', { 'aria-label': 'Raum für ' + row.address, disabled: !admin }, h('option', { value: '', text: 'Ohne Raum' }), rooms.map(r => h('option', { value: r.name, text: r.name, selected: (row.roomId || row.room) === r.name })));
      room.addEventListener('change', () => task(room, freshOut, async () => { await api('setDeviceRoom', { address: row.address, room: room.value }); row.room = row.roomId = room.value; return 'Raum gespeichert.'; }));
      const home = h('input', { type: 'checkbox', checked: row.exposed === true, disabled: !admin, 'aria-label': row.address + ' in Apple Home' });
      home.addEventListener('change', () => task(home, freshOut, async () => { await api('setDeviceExposed', { address: row.address, exposed: home.checked }); row.exposed = home.checked; return home.checked ? 'In Apple Home eingeschaltet.' : 'Aus Apple Home entfernt.'; }));
      return h('div', { class: 'form' }, field('Name' + (mine.length > 1 ? ' (' + row.address + ')' : ''), name), field('Raum', room), h('div', { class: 'row' }, save, toggle(home, 'In Apple Home')));
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: dev.type || 'Neues Gerät' }), h('span', { class: 'tag ok', text: 'neu' })), h('p', { class: 'muted mono', text: dev.address + ' · ' + (dev.label || dev.interface) }),
      lines.length ? lines : h('p', { class: 'muted', text: dev.channels ? 'Dieses Gerät hat nichts, was sich hier schalten oder anzeigen lässt (z. B. Fernbedienung oder Taster). Es kann aber als Auslöser in „Automationen“ dienen.' : 'Das Gerät wird noch eingelesen …' }),
      h('div', { class: 'actions' }, done));
  }
  function renderStatus(d) {
    // Eine Kachel für den Funk (Homematic IP + Homematic BidCos zusammengefasst)
    const ifs = d.interfaces || [], off = ifs.filter(i => !i.connected), active = ifs.filter(i => i.connected && i.remaining > 0);
    const radio = off.length === ifs.length ? ['nicht verbunden', 'Schnittstellen prüfen', 'bad']
      : active.length ? [Math.max(...active.map(i => i.remaining)) + ' s', 'Anlernmodus aktiv: ' + active.map(i => i.label).join(' + '), 'warn']
      : [off.length ? 'teilweise' : 'bereit', ifs.map(i => i.label + ': ' + (!i.connected ? 'nicht verbunden' : i.error ? 'Status unbekannt' : 'Anlernmodus aus')).join(' · '), off.length ? 'warn' : 'ok'];
    stats.replaceChildren(stat('Funk (Homematic IP + BidCos)', radio[0], radio[1], radio[2]),
      stat('Neue Geräte', d.recent ? String(d.recent.length) : '–', d.recent ? (d.recent.length ? 'bitte einrichten' : 'keine') : 'nicht lesbar', d.recent && d.recent.length ? 'warn' : undefined));
    stopBtn.disabled = !active.length || !admin;
    const signature = JSON.stringify([d.recent, rows.map(r => [r.address, r.name, r.roomId || r.room, r.exposed]), rooms.map(r => r.name), admin, active.length > 0]);
    if (!editing.size && signature !== shown) {
      shown = signature;
      if (!d.recent) fresh.replaceChildren(h('div', { class: 'notice bad', text: 'Neue Geräte nicht lesbar: ' + (d.recentError || 'unbekannt') }));
      else if (!d.recent.length) fresh.replaceChildren(h('div', { class: 'empty', text: active.length ? 'Warte auf neue Geräte …' : 'Keine neuen Geräte. Zuerst oben den Anlernmodus starten.' }));
      else fresh.replaceChildren(h('div', { class: 'cards' }, d.recent.map(deviceCard)));
    }
    clearTimeout(timer); timer = setTimeout(load, active.length ? 2000 : 10000);
  }
  async function load(force) {
    if (busy || (document.hidden && !force)) { clearTimeout(timer); timer = setTimeout(load, 5000); return; }
    try {
      const d = await api('getInstallStatus');
      if (d.recent && d.recent.length && !editing.size) { const [devs, rs] = await Promise.all([api('getDevices'), api('getRooms').catch(() => ({ rooms: [] }))]); rows = devs.devices || []; rooms = rs.rooms || []; }
      renderStatus(d);
    } catch (e) { msg(out, e.message, 'bad'); clearTimeout(timer); timer = setTimeout(load, 10000); }
  }
  startBtn.addEventListener('click', () => task(startBtn, out, async () => { busy = true; try { const r = await api('startInstallMode', { interface: iface.value, seconds: Number(seconds.value) }); return r.message; } finally { busy = false; await load(true); } }, 'Anlernmodus wird gestartet …'));
  stopBtn.addEventListener('click', () => task(stopBtn, out, async () => { busy = true; try { const r = await api('stopInstallMode', { interface: 'all' }); return r.message; } finally { busy = false; await load(true); } }, 'Wird beendet …'));
  NEU.ensureSession().then(s => { admin = s.admin === true; if (!admin) { adminNote.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, 'Zum Anlernen bitte als CCU-Administrator anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' })))); startBtn.disabled = true; } }).catch(() => {}).finally(() => load(true));
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
});
