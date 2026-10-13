'use strict';
// Seite „Tasmota“: WLAN-Geräte mit Tasmota im Heimnetz finden, hinzufügen, benennen, schalten
// und für Apple Home freigeben. Alles lokal im Heimnetz, ohne Cloud und ohne Konto.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, toggle, msg, task, stat, confirmDialog } = NEU;
  const main = shell({ title: 'Tasmota', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'WLAN-Steckdosen, Schalter, Dimmer und Fühler mit Tasmota einbinden – direkt im Heimnetz, ohne Cloud.' });
  const adminNote = h('div'), stats = h('div', { class: 'stats' });
  const scanBtn = h('button', { class: 'btn primary', type: 'button', text: 'Im Heimnetz suchen' });
  const scanOut = h('p', { class: 'msg', role: 'status' }), scanList = h('div');
  const ip = h('input', { type: 'text', inputmode: 'decimal', maxlength: 15, placeholder: 'z. B. 192.168.50.70', autocomplete: 'off', 'aria-label': 'Adresse des Tasmota-Geräts' });
  const pw = h('input', { type: 'password', maxlength: 64, autocomplete: 'off', 'aria-label': 'Gerätepasswort (nur falls am Gerät gesetzt)' });
  const addBtn = h('button', { class: 'btn primary', type: 'button', text: 'Prüfen und hinzufügen' }), addOut = h('p', { class: 'msg', role: 'status' });
  const list = h('div'), listOut = h('p', { class: 'msg', role: 'status' });
  main.append(adminNote, stats,
    panel('1. Geräte finden', 'Die Zentrale fragt alle Adressen deines Heimnetzes einmal kurz ab. Das dauert etwa 15 Sekunden. An den Geräten wird dabei nichts verändert.', h('div', { class: 'actions' }, scanBtn), scanOut, scanList),
    panel('Oder: Adresse selbst eintragen', 'Die Adresse steht in der Tasmota-Oberfläche des Geräts oder in der Geräteliste deines Routers.', h('div', { class: 'form' }, field('Adresse (IP)', ip), field('Gerätepasswort', pw, 'Nur ausfüllen, wenn am Gerät eines gesetzt ist. Es wird verschlüsselt gespeichert.')), h('div', { class: 'actions' }, addBtn), addOut),
    panel('2. Meine Tasmota-Geräte', 'Namen vergeben, schalten und für Apple Home einschalten. Die Geräte stehen auch unter „Geräte“ und in den „Automationen“ bereit.', listOut, list),
    panel('Gut zu wissen', null, h('ul', { class: 'steps' },
      h('li', {}, h('span', { text: 'Das Gerät braucht die Tasmota-Firmware und muss im selben WLAN/Heimnetz sein wie die CCU3.' })),
      h('li', {}, h('span', { text: 'Wird direkt am Gerät geschaltet, zeigt die Oberfläche das nach wenigen Sekunden.' })),
      h('li', {}, h('span', { text: 'Bekommt ein Gerät vom Router eine neue Adresse, findet die Zentrale es selbst wieder. Sicherer ist eine feste Adresse im Router. Geräte mit Passwort werden nicht selbsttätig umgestellt: dann die neue Adresse oben eintragen.' })),
      h('li', {}, h('span', { text: 'Rollläden und Farblicht werden noch nicht unterstützt. Farblampen lassen sich schalten und dimmen.' })),
      h('li', {}, h('span', { text: 'Wird ein Gerät nicht gefunden, obwohl es im WLAN ist: In der Tasmota-Konsole des Geräts „SetOption128 1“ eingeben (erlaubt Befehle aus dem Heimnetz; das ist die Werkseinstellung).' })))));

  let admin = false, data = { devices: [], hosts: [] }, shown = '', timer = null, scanTimer = null, scanShown = '';
  const editing = new Set(), passwords = new Map();
  const pill = (on, a, b) => h('span', { class: 'tag ' + (on ? 'ok' : ''), text: on ? a : b });
  const reading = s => [Number.isFinite(s.temperature) ? s.temperature.toLocaleString('de-DE') + ' °C' : '', Number.isFinite(s.humidity) ? s.humidity.toLocaleString('de-DE') + ' %' : '', Number.isFinite(s.power) ? s.power.toLocaleString('de-DE') + ' W' : ''].filter(Boolean).join(' · ');

  async function add(address, password, button, out) {
    await task(button, out, async () => {
      try { const r = await api('addTasmota', password ? { ip: address, password } : { ip: address }); data = r; shown = ''; render(); refreshScan(); return r.message; }
      catch (e) { if (e.data && e.data.needsPassword) passwords.set(address, true); throw e; }
    }, 'Gerät wird geprüft …');
  }
  function partRow(d) {
    const name = h('input', { type: 'text', maxlength: 64, value: d.name, disabled: !admin, 'aria-label': 'Name für ' + d.name });
    name.addEventListener('focus', () => editing.add(d.id)); name.addEventListener('blur', () => editing.delete(d.id));
    const save = h('button', { class: 'btn small', type: 'button', text: 'Name speichern', disabled: !admin });
    save.addEventListener('click', () => task(save, listOut, async () => { const value = name.value.trim(); if (!value) throw Error('Bitte einen Namen eingeben.'); const r = await api('setTasmotaDevice', { id: d.id, name: value }); editing.delete(d.id); data = r; shown = ''; render(); return '„' + value + '“ gespeichert.'; }));
    const viaCuxd = !!d.cuxd && d.exposed !== true;
    const home = h('input', { type: 'checkbox', checked: d.exposed === true, disabled: !admin || viaCuxd, 'aria-label': d.name + ' in Apple Home' });
    home.addEventListener('change', () => task(home, listOut, async () => { try { const r = await api('setTasmotaDevice', { id: d.id, exposed: home.checked }); data = r; shown = ''; render(); return r.message; } catch (e) { home.checked = !home.checked; throw e; } }));
    const state = h('div', { class: 'row' }), s = d.state || {};
    if (!d.online) state.append(h('span', { class: 'tag bad', text: 'Offline' }));
    else if (d.kind === 'sensor') state.append(h('span', { text: reading(s) || 'Noch kein Messwert' }));
    else {
      // Ein/Aus als EIN Symbol-Knopf (Wunsch Thomas 13.10.2026): Glühbirne bei Dimmern, sonst Stecker; Klick schaltet um
      if (typeof s.on !== 'boolean') state.append(h('span', { class: 'tag warn', text: 'Unbekannt' }));
      const b = NEU.powerButton(d.kind === 'light' || d.capabilities?.brightness ? 'licht' : 'stecker', s.on === true, d.name);
      b.addEventListener('click', () => task(b, listOut, async () => { const r = await api('controlTasmota', { id: d.id, command: { on: s.on !== true } }); d.state = r.state; d.online = r.online; shown = ''; render(); return r.message; }, 'Wird geschaltet …'));
      state.append(b);
      if (d.capabilities && d.capabilities.brightness) {
        const level = h('input', { type: 'number', min: 1, max: 100, step: 1, value: Number.isFinite(s.brightness) ? s.brightness : 50, 'aria-label': 'Helligkeit in Prozent für ' + d.name, style: 'width:5.5em' });
        level.addEventListener('focus', () => editing.add(d.id + '#l')); level.addEventListener('blur', () => editing.delete(d.id + '#l'));
        const set = h('button', { class: 'btn small', type: 'button', text: 'Helligkeit setzen' });
        set.addEventListener('click', () => task(set, listOut, async () => { const v = Math.round(Number(level.value)); if (!(v >= 1 && v <= 100)) throw Error('Helligkeit: 1 bis 100 Prozent.'); const r = await api('controlTasmota', { id: d.id, command: { brightness: v } }); editing.delete(d.id + '#l'); d.state = r.state; d.online = r.online; shown = ''; render(); return r.message; }, 'Wird gedimmt …'));
        state.append(h('span', { class: 'muted', text: Number.isFinite(s.brightness) ? s.brightness + ' %' : '' }), level, set);
      }
      if (Number.isFinite(s.power)) state.append(h('span', { class: 'muted', text: s.power.toLocaleString('de-DE') + ' W' }));
    }
    const cuxdHint = viaCuxd ? h('p', { class: 'muted', text: 'Schon in Apple Home über das CUxD-Gerät ' + (d.cuxd.name ? '„' + d.cuxd.name + '“ (' + d.cuxd.address + ')' : d.cuxd.address) + '. Ein zweites Gerät würde dort doppelt erscheinen.' }) : null;
    return h('div', { class: 'form' }, field(d.kind === 'sensor' ? 'Name des Fühlers' : d.kind === 'light' ? 'Name des Dimmers' : 'Name des Schalters', name), h('div', { class: 'row' }, save, toggle(home, 'In Apple Home')), cuxdHint, state);
  }
  function hostCard(host) {
    const parts = data.devices.filter(d => d.mac === host.mac);
    const remove = h('button', { class: 'btn danger small', type: 'button', text: 'Entfernen', disabled: !admin });
    remove.addEventListener('click', async () => {
      if (!await confirmDialog({ title: '„' + host.name + '“ entfernen?', text: 'Das Gerät verschwindet aus dieser Oberfläche, aus Apple Home und aus der Auswahl der Automationen. Am Gerät selbst wird nichts geändert.', confirm: 'Entfernen', danger: true })) return;
      task(remove, listOut, async () => { const r = await api('removeTasmota', { mac: host.mac }); data = r; shown = ''; render(); refreshScan(); return r.message; });
    });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('b', { text: host.name }), h('span', { class: 'tag ' + (host.online ? 'ok' : 'bad'), text: host.online ? 'Online' : 'Offline' })),
      host.cuxd ? h('p', {}, h('span', { class: 'tag', text: 'CUxD ' + host.cuxd.address }), ' ', host.cuxd.name ? 'gehört zu „' + host.cuxd.name + '“' : 'gehört zu einem CUxD-Gerät') : null,
      h('p', { class: 'muted mono', text: host.ip + (host.version ? ' · Tasmota ' + host.version : '') + (host.password ? ' · mit Passwort' : '') }),
      !host.online && host.error ? h('div', { class: 'notice warn', text: 'Gerät ' + host.error + '.' }) : null,
      parts.length ? parts.map(partRow) : h('p', { class: 'muted', text: 'Dieses Gerät liefert nur Messwerte für Automationen.' }),
      h('div', { class: 'actions' }, remove));
  }
  function render() {
    const devices = data.devices || [], hosts = data.hosts || [];
    stats.replaceChildren(stat('Tasmota-Geräte', String(hosts.length), hosts.length ? 'eingebunden' : 'noch keine'), stat('Online', String(hosts.filter(x => x.online).length), 'von ' + hosts.length, hosts.some(x => !x.online) ? 'warn' : 'ok'), stat('In Apple Home', String(devices.filter(d => d.exposed).length), 'von ' + devices.length + ' Funktionen'));
    const signature = JSON.stringify([devices, hosts.map(x => [x.mac, x.ip, x.online, x.error, x.name]), admin]);
    if (editing.size || signature === shown) return;
    shown = signature;
    list.replaceChildren(hosts.length ? h('div', { class: 'cards' }, hosts.map(hostCard)) : h('div', { class: 'empty', text: 'Noch keine Tasmota-Geräte. Oben „Im Heimnetz suchen“ drücken.' }));
  }
  function renderScan(s) {
    if (s.running) msg(scanOut, 'Suche läuft … ' + s.done + ' von ' + (s.total || '?') + ' Adressen geprüft.', 'busy');
    else if (s.error) msg(scanOut, s.error, 'bad');
    else if (s.finishedAt) msg(scanOut, s.found.length ? s.found.length + ' Tasmota-Gerät(e) gefunden.' : 'Kein Tasmota-Gerät gefunden. Ist das Gerät im selben WLAN? Sonst unten die Adresse selbst eintragen.', s.found.length ? 'ok' : 'warn');
    scanBtn.disabled = !admin || s.running;
    const signature = JSON.stringify([s.found, s.running, admin, [...passwords.keys()]]);
    if (signature === scanShown || editing.has('scan')) return;
    scanShown = signature;
    const fresh = s.found.filter(f => !f.known && f.supported && !f.needsPassword);
    const cards = s.found.map(f => {
      const out = h('p', { class: 'msg', role: 'status' }), actions = h('div', { class: 'actions' });
      if (f.known) actions.append(h('span', { class: 'tag ok', text: 'schon eingebunden' }));
      else if (!f.supported) actions.append(h('span', { class: 'tag warn', text: 'wird nicht unterstützt' }));
      else {
        let secret = null;
        if (f.needsPassword || passwords.has(f.ip)) { secret = h('input', { type: 'password', maxlength: 64, autocomplete: 'off', 'aria-label': 'Gerätepasswort für ' + f.ip }); secret.addEventListener('focus', () => editing.add('scan')); secret.addEventListener('blur', () => editing.delete('scan')); actions.append(field('Gerätepasswort', secret)); }
        const b = h('button', { class: 'btn primary small', type: 'button', text: 'Hinzufügen', disabled: !admin });
        b.addEventListener('click', () => { if (secret && !secret.value) { msg(out, 'Bitte das Gerätepasswort eintragen.', 'bad'); return; } editing.delete('scan'); add(f.ip, secret ? secret.value : '', b, out); });
        actions.append(b);
      }
      return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: f.name }), h('span', { class: 'tag', text: f.ip })), h('p', { class: 'muted', text: f.summary + (f.version ? ' · Tasmota ' + f.version : '') }), actions, out);
    });
    const all = fresh.length >= 1 ? h('button', { class: 'btn primary', type: 'button', text: fresh.length === 1 ? 'Gefundenes Gerät hinzufügen' : 'Alle ' + fresh.length + ' neuen hinzufügen', disabled: !admin }) : null;
    if (all) all.addEventListener('click', () => task(all, scanOut, async () => { let ok = 0; const failed = []; for (const f of fresh) { try { data = await api('addTasmota', { ip: f.ip }); ok++; } catch (e) { failed.push(f.name + ': ' + e.message); } } shown = ''; render(); await refreshScan(); if (failed.length) throw Error(ok + ' hinzugefügt. Nicht hinzugefügt: ' + failed.join('; ')); return ok + ' Geräte hinzugefügt.'; }, 'Geräte werden hinzugefügt …'));
    const hint = fresh.length ? h('div', { class: 'notice warn', text: 'Gefundene Geräte sind noch nicht gespeichert. Erst mit „Hinzufügen“ stehen sie dauerhaft unter „Meine Tasmota-Geräte“.' }) : null;
    scanList.replaceChildren(cards.length ? h('div', {}, hint, all ? h('div', { class: 'actions' }, all) : null, h('div', { class: 'cards' }, cards)) : '');
  }
  async function refreshScan() {
    if (!admin) return;
    clearTimeout(scanTimer);
    try { const s = await api('getTasmotaScan'); renderScan(s); if (s.running) scanTimer = setTimeout(refreshScan, 1000); else if (s.finishedAt) load(true); }
    catch (e) { msg(scanOut, e.message, 'bad'); }
  }
  async function load(force) {
    clearTimeout(timer);
    if (document.hidden && !force) { timer = setTimeout(load, 5000); return; }
    try { data = await api('getTasmotaDevices'); render(); }
    catch (e) { msg(listOut, e.message, 'bad'); }
    timer = setTimeout(load, 4000);
  }
  scanBtn.addEventListener('click', () => task(scanBtn, scanOut, async () => { scanShown = ''; const r = await api('scanTasmota', {}); renderScan(r.scan); scanTimer = setTimeout(refreshScan, 1000); return 'Suche läuft …'; }, 'Suche wird gestartet …'));
  addBtn.addEventListener('click', async () => { const value = ip.value.trim(); if (!value) { msg(addOut, 'Bitte die Adresse des Geräts eintragen.', 'bad'); return; } await add(value, pw.value, addBtn, addOut); if (addOut.classList.contains('ok')) { ip.value = ''; pw.value = ''; } });
  NEU.ensureSession().then(s => { admin = s.admin === true; if (!admin) { adminNote.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, 'Zum Hinzufügen und Ändern bitte als CCU-Administrator anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' })))); scanBtn.disabled = true; addBtn.disabled = true; } }).catch(() => {}).finally(() => { load(true); refreshScan(); });
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearTimeout(scanTimer); }, { once: true });
});
