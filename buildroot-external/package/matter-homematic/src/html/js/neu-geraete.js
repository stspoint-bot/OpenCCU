'use strict';
// Seite „Geräte“: alle Kanäle der Bridge – Freigabe für Apple Home, Namen, CCU-Räume, Bedienung
// (Schalter, Dimmer, Heizung, WLAN-Geräte), Onlineprüfung. Ersetzt die 13 Einzelskripte der alten
// Startseite und nutzt dieselben Bridge-Schnittstellen.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, confirmDialog, toggle } = NEU;
  const main = shell({ title: 'Geräte', eyebrow: 'Matter-Bridge', lead: 'Welche Geräte in Apple Home erscheinen, wie sie heißen, in welchem Raum sie sind – und direkte Bedienung.' });
  const out = h('p', { class: 'msg', role: 'status' }), alert = h('div', { class: 'notice warn', hidden: true, text: 'Neustart nötig: Diese Freigabe wird erst nach einem Neustart der Bridge wirksam (System → Wartung).' });
  const search = h('input', { type: 'search', placeholder: 'Name, Adresse, Typ oder Raum suchen …', 'aria-label': 'Geräte suchen' });
  const f = { unnamed: h('input', { type: 'checkbox', checked: true }), offline: h('input', { type: 'checkbox' }), cuxd: h('input', { type: 'checkbox' }), unmapped: h('input', { type: 'checkbox' }), del: h('input', { type: 'checkbox' }), defaultExposed: h('input', { type: 'checkbox' }) };
  const unnamedLabel = h('span', { text: 'Unbenannte Kanäle ausblenden' });
  const total = h('span', { class: 'tag' }), body = h('tbody'), pager = h('div', { class: 'actions' });
  const sortBtn = (key, label) => { const b = h('button', { class: 'btn small', type: 'button', text: label }); b.addEventListener('click', () => { sort = { key, dir: sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc' }; render(); }); return b; };
  const sortName = sortBtn('name', 'Name'), sortRoom = sortBtn('room', 'Raum');
  // Kopfzeile: bei „Löschen-Funktion anzeigen“ steht die Spalte „Löschen“ ganz vorn (vor „In Apple Home“).
  const COLS = ['In Apple Home', 'Name', 'Zustand / Bedienung', 'Raum', 'Typ', 'Aufzeichnen', 'Online prüfen'];
  const headRow = h('tr', {}, COLS.map(t => h('th', { text: t })));
  const unmappedBox = h('div', { hidden: true }), deleteBox = h('div', { hidden: true }), keysBox = h('div', { hidden: true }), newBox = h('div', { hidden: true });
  main.append(alert, newBox,
    panel('Alle Geräte', null,
      h('div', { class: 'row' }, h('div', { style: 'flex:1 1 280px' }, search), total, h('a', { class: 'btn primary', href: '/anlernen.html', text: '＋ Neues Gerät anlernen' })),
      h('div', { class: 'checks' }, h('label', { class: 'check' }, f.unnamed, unnamedLabel), check('Offline-Geräte ausblenden', f.offline), check('Nicht zugeordnete Kanäle zeigen', f.unmapped), h('a', { href: '/geraeteverwaltung.html', text: 'Geräte löschen → Geräteverwaltung' })),
      h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Sortieren:' }), sortName, sortRoom),
      out,
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, headRow), body)),
      pager),
    keysBox, unmappedBox, deleteBox);
  // Taster & Fernbedienungen: Funkgeräte ohne eigene Zeile oben (kein Schalt-/Messkanal, z. B. Wandtaster HmIP-WRC2).
  // Sie haben keine Apple-Home-Kachel, lassen sich aber in den Automationen als Auslöser („Taste gedrückt“) nutzen.
  let keysAt = 0;
  async function renderKeys(force) {
    if (!force && Date.now() - keysAt < 60000) return;
    keysAt = Date.now();
    let list = []; try { list = (await api('getCcuDeviceList')).devices || []; } catch { keysBox.hidden = true; return; }
    const shown = new Set(devices.map(x => String(x.address || '').split(':')[0]));
    // Neu angelernt (letzte 3 Stunden): oben auf der Seite, auch Geräte ohne eigene Zeile
    const fresh = list.filter(g => g.newSince).sort((a, b) => b.newSince.localeCompare(a.newSince));
    newBox.hidden = !fresh.length;
    if (fresh.length) newBox.replaceChildren(panel('Neu angelernt (letzte 3 Stunden)', 'Gerade über „Neue Geräte anlernen“ übernommen. Name und Raum lassen sich in der Liste unten bzw. unter „Taster & Fernbedienungen“ finden.',
      NEU.table(['Name', 'Typ', 'Raum', 'Adresse', 'Angelernt', ''], fresh.map(g => h('tr', {}, h('td', {}, h('b', { text: g.name || g.type })), h('td', {}, h('span', { class: 'tag', text: g.type || '–' })), h('td', { text: g.room || '–' }), h('td', { class: 'mono', text: g.address }), h('td', { text: new Date(g.newSince).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' }),
        h('td', {}, h('a', { class: 'btn small primary', href: '/automationen.html?assist=' + encodeURIComponent(g.address), text: 'Einrichten (Assistent)' })))))));
    const rest = list.filter(g => g.deletable && !shown.has(g.address));
    // Taster & Fernbedienungen als eigene Zeilen in der Tabelle (Wunsch Thomas) statt einer Extra-Box
    keyRows = rest.map(g => ({ address: g.address + ':1', keyBase: g.address, keyDevice: true, name: g.name || g.type || g.address, hmDeviceType: g.type, matterDeviceType: 'GenericSwitch', room: ownRooms.assign[g.address + ':1'] || '', exposed: false }));
    devices = devices.filter(x => !x.keyDevice).concat(keyRows); keysBox.hidden = true; scheduleRender(); return;
    keysBox.replaceChildren(panel('Taster & Fernbedienungen', 'Funkgeräte ohne Schalt- oder Messfunktion (z. B. Wandtaster). Sie erscheinen nicht als Kachel in Apple Home, lassen sich aber unter „Automationen“ als Auslöser „Taste gedrückt“ verwenden.',
      NEU.table(['Name', 'Typ', 'Raum', 'Adresse', ''], rest.map(g => h('tr', {}, h('td', {}, h('b', { text: g.name || g.type })), h('td', {}, h('span', { class: 'tag', text: g.type || '–' })), h('td', { text: g.room || '–' }), h('td', { class: 'mono', text: g.address }),
        h('td', {}, h('a', { class: 'btn small', href: '/automationen.html?assist=' + encodeURIComponent(g.address), text: 'Einrichten (Assistent)' })))))));
  }

  let keyRows = [], ownRooms = { assign: {} }, devices = [], rooms = [], channels = [], cux = { settings: {}, states: new Map(), error: '' };
  let sort = { key: 'name', dir: 'asc' }, page = 0, size = 25, loading = false, retry = null;
  const editing = new Set(); // Adressen mit ungespeicherten Namen
  const PROVIDERS = { smartplus: 'controlSmartplus', smartlife: 'controlSmartlife', dyson: 'controlDyson', tasmota: 'controlTasmota' };
  const cuxId = a => (/^((?:CUX)[A-Za-z0-9_-]{1,60}):\d{1,3}$/i.exec(a || '') || [])[1];
  const hasName = d => !!d.name && !!d.address && !d.name.includes(d.address);
  const offline = d => d.provider ? d.online === false : cuxId(d.address) ? (cux.states.get('cux:' + cuxId(d.address)) || {}).status === 'offline' : d.onlineStatus === 'offline';
  function extraCuxd(d) {
    const a = d.address || ''; if (d.interface !== 'CUxD' && !/^CUX/i.test(a)) return false;
    const m = /:(\d+)$/.exec(a); if (!m) return false;
    const base = a.slice(0, m.index).toUpperCase(); let first;
    for (const c of [...devices, ...channels]) { const x = /^(.*):(\d+)$/.exec(c.address || ''); if (!x || x[1].toUpperCase() !== base) continue; const n = Number(x[2]); if (first === undefined || (n > 0 && (first === 0 || n < first))) first = n; }
    return Number(m[1]) !== first;
  }
  const post = (method, p) => api(method, p);
  // Gerätebilder der CCU: Geräteadresse → Bilddatei (einmal laden; ohne Bilder geht alles weiter)
  let icons = {};
  api('getDeviceIcons').then(r => { icons = r.icons || {}; if (Object.keys(icons).length) scheduleRender(); }).catch(() => {});
  const exposedSet = new Map(); // gerade umgeschaltete Freigaben, bis die Bridge sie bestätigt

  // ---------- Zellen ----------
  function exposeCell(d) {
    if (d.keyDevice) return h('span', { class: 'muted', text: '–', title: 'Taster haben keine eigene Kachel in Apple Home; in den Automationen als Auslöser nutzbar.' });
    const box = h('input', { type: 'checkbox', checked: !!d.exposed, 'aria-label': d.name + ' in Apple Home freigeben' });
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        const r = d.provider === 'jeep' ? await post('setJeepExposed', { address: d.address, exposed: box.checked }) : d.provider === 'tasmota' ? await post('setTasmotaDevice', { id: d.id, exposed: box.checked }) : d.provider ? await post('setWifiDevice', { address: d.address, exposed: box.checked }) : await post('setDeviceExposed', { address: d.address, exposed: box.checked });
        d.exposed = box.checked; exposedSet.set(d.address, { value: box.checked, until: Date.now() + 20000 }); alert.hidden = !/restart|neustart/i.test(r.message || '');
      } catch (e) { box.checked = !!d.exposed; msg(out, e.message, 'bad'); } finally { box.disabled = false; }
    });
    return toggle(box);
  }
  function nameCell(d) {
    const input = h('input', { value: d.name || d.address, maxlength: 64, 'aria-label': 'Name', style: 'min-width:180px' });
    const save = h('button', { class: 'btn small primary', type: 'button', text: 'Speichern', hidden: true });
    const original = d.name || d.address;
    const changed = () => { const c = input.value.trim() !== original; save.hidden = !c; if (c) editing.add(d.address); else editing.delete(d.address); };
    const store = async () => {
      const name = input.value.trim(); if (!name) { input.value = original; changed(); return; } if (name === original) return;
      save.disabled = input.disabled = true;
      try { const r = d.keyDevice ? await post('setGeraetName', { address: d.keyBase, name }) : d.provider === 'jeep' ? await post('setJeepName', { address: d.address, name }) : d.provider === 'tasmota' ? await post('setTasmotaDevice', { id: d.id, name }) : d.provider ? await post('setWifiDevice', { address: d.address, name }) : await post('setDeviceName', { address: d.address, name }); d.name = r.name || name; d.customName = true; editing.delete(d.address); msg(out, '„' + d.name + '“ gespeichert.', 'ok'); render(); }
      catch (e) { msg(out, 'Name konnte nicht gespeichert werden: ' + e.message, 'bad'); save.disabled = input.disabled = false; }
    };
    input.addEventListener('input', changed); input.addEventListener('keydown', e => { if (e.key === 'Enter') store(); if (e.key === 'Escape') { input.value = original; changed(); } });
    save.addEventListener('click', store);
    // Gerätebild wie in der alten CCU-Oberfläche (nur CCU-Geräte, deren Typ die CCU kennt)
    const file = !d.provider && typeof d.address === 'string' ? icons[d.address.split(':')[0]] : null;
    // CUxD-Geräte und Tasmota-Steckdosen: eigenes Bild im CCU-Stil (die CCU hat dafür keins)
    const cux = !file && (d.provider === 'tasmota' || /^CUX\d/.test(String(d.address || '')));
    const src = file ? '/geraet-bild/' + encodeURIComponent(file) : cux ? '/img/cuxd-geraet.svg' : null;
    const img = src ? h('img', { class: 'dev-icon', src, alt: '', width: 40, height: 40, loading: 'lazy' }) : h('span', { class: 'dev-icon' });
    return h('div', {}, h('div', { class: 'row', style: 'flex-wrap:nowrap' }, img, input, save), d.provider === 'jeep' ? h('span', { class: 'sub', text: 'Jeep · Messwert (nur lesen)' }) : d.customName ? h('span', { class: 'sub', text: 'eigener Name' }) : null);
  }
  const pill = (on, a, b) => h('span', { class: 'tag ' + (on ? 'ok' : ''), text: on ? a : b });
  // Art des Geräts in Worten für die Spalte „Typ“ (Wunsch Thomas): Lichtschalter, Steckdose, Dimmer, Thermostat …
  const KINDS = { OnOffLight: 'Lichtschalter', DimmableLight: 'Dimmer', ColorTemperatureLight: 'Dimmer', ExtendedColorLight: 'Farblicht', OnOffPlugInUnit: 'Steckdose', DimmablePlugInUnit: 'Dimmer',
    Thermostat: 'Thermostat', TemperatureSensor: 'Temperaturfühler', HumiditySensor: 'Feuchtefühler', OccupancySensor: 'Bewegungsmelder', ContactSensor: 'Fensterkontakt',
    WindowCovering: 'Rollladen', DoorLock: 'Türschloss', GenericSwitch: 'Taster', LightSensor: 'Lichtsensor', AirPurifier: 'Luftreiniger', Fan: 'Lüfter', WaterLeakDetector: 'Wassermelder', SmokeCoAlarm: 'Rauchmelder' };
  const PROVIDER_KINDS = { tasmota: 'Steckdose', jeep: 'Fahrzeug', dyson: 'Luftreiniger', wetter: 'Wetter' };
  function kindLabel(d) {
    if (d.keyDevice) return 'Taster / Fernbedienung';
    if (d.thermostatControl?.allowed) return 'Thermostat';
    if (d.dimmerControl?.allowed) return 'Dimmer';
    return PROVIDER_KINDS[d.provider] || KINDS[d.matterDeviceType] || (d.switchControl?.allowed ? 'Schalter' : d.matterDeviceType || d.hmChannelType || 'Gerät');
  }
  // Ein Schalt-Knopf (Wunsch Thomas): zeigt Ein/Aus und schaltet beim Klick um. Zustand unbekannt → Klick schaltet ein.
  function onOffButton(state, run) {
    const on = state === true, off = state === false;
    const b = h('button', { class: 'btn small onoff' + (on ? ' primary' : ''), type: 'button', text: on ? 'Ein' : off ? 'Aus' : 'Unbekannt', title: on ? 'Klicken zum Ausschalten' : 'Klicken zum Einschalten', 'aria-pressed': on ? 'true' : 'false' });
    b.addEventListener('click', () => run(!on, b));
    return b;
  }
  // Messwerte des Geräts untereinander (wie bei den Smart-Life-Steckdosen) mit „Stand“ – von wann die Werte sind.
  let werte = {};
  const standText = iso => { const t = new Date(iso); if (!Number.isFinite(t.getTime())) return ''; const hm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr', today = new Date().toDateString() === t.toDateString(); return today ? 'heute ' + hm : t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + hm; };
  function valuesBlock(d) {
    if (d.provider === 'jeep') return null; // Jeep zeigt Wert und Cloud-Zeit schon selbst
    const w = werte[d.provider ? d.address : String(d.address || '').split(':')[0]]; if (!w) return null;
    return h('div', { class: 'werte' }, ...w.values.map(([k, v]) => h('div', { text: k + ': ' + v })), ...w.flags.map(f => h('span', { class: 'tag bad', text: f })),
      h('span', { class: 'sub', text: w.at ? 'Stand: ' + standText(w.at) : 'Stand: ' + (w.hint || 'unbekannt') }));
  }
  function stateCell(d) { const box = stateControl(d), w = d.keyDevice ? null : valuesBlock(d); if (!w) return box; return h('div', {}, box, w); }
  function stateControl(d) {
    if (d.keyDevice) return h('a', { class: 'btn small', href: '/automationen.html?assist=' + encodeURIComponent(d.keyBase), text: 'Einrichten (Assistent)' });
    const st = d.currentState || {}, box = h('div', { class: 'row', dataset: { state: d.address } });
    if (offline(d)) { box.append(h('span', { class: 'tag bad', text: 'Offline' })); return box; }
    if (Number.isFinite(d.linkedPower)) box.append(h('span', { class: 'tag', title: 'Leistung laut Tasmota-Steckdose', text: d.linkedPower.toLocaleString('de-DE') + ' W' }));
    if (d.provider === 'jeep') { const t = new Date(st.timestamp); box.append(h('div', {}, h('b', { text: st.value === null || st.value === undefined ? 'Kein Messwert' : Number(st.value).toLocaleString('de-DE') + ' ' + (st.unit || '') }), h('span', { class: 'sub', text: (st.stale ? 'Letzter gespeicherter Wert' : 'Cloud-Daten') + (Number.isFinite(t.getTime()) ? ' · ' + t.toLocaleString('de-DE') : '') }))); return box; }
    if (d.provider) {
      if ((d.capabilities || {}).kind !== 'sensor' && PROVIDERS[d.provider]) box.append(onOffButton(st.on, (on, b) => wifiControl(d, { on }, b)));
      if (d.wifiUrl) box.append(h('a', { class: 'btn small', href: d.wifiUrl, text: 'Mehr' }));
      return box;
    }
    if (d.thermostatControl && d.thermostatControl.allowed) {
      const t = d.thermostatState || {}, b = h('button', { class: 'btn small', type: 'button', text: 'Ist ' + (Number.isFinite(t.temperature) ? t.temperature.toFixed(1) + ' °C' : '–') + ' · Soll ' + (Number.isFinite(t.setpoint) ? t.setpoint.toFixed(1) + ' °C' : '–') });
      b.addEventListener('click', () => thermostatDialog(d)); box.append(b); return box;
    }
    if (d.dimmerControl && d.dimmerControl.allowed) {
      const lvl = st.currentLevel, pct = typeof lvl === 'number' && lvl >= 0 && lvl <= 254 ? Math.round(lvl / 254 * 100) : null;
      const b = h('button', { class: 'btn small' + (pct > 0 ? ' primary' : ''), type: 'button', text: 'Helligkeit ' + (pct === null ? '–' : pct + ' %') }); b.addEventListener('click', () => dimmerDialog(d)); box.append(b); return box;
    }
    if (d.switchControl && d.switchControl.allowed) {
      box.append(onOffButton(d.switchState, on => switchControl(d, on, box)));
      return box;
    }
    // reine Anzeige (Sensoren, Rollläden, Kontakte …)
    if ('onOff' in st) box.append(pill(!!st.onOff, 'Ein', 'Aus'));
    else if ('currentPositionLiftPercent100ths' in st) box.append(h('span', { text: Math.max(0, Math.min(100, Math.round(100 - (st.currentPositionLiftPercent100ths || 0) / 100))) + ' % offen' }));
    else if ('occupancy' in st) box.append(pill((st.occupancy & 1) === 1, 'Bewegung', 'Ruhe'));
    else if ('stateValue' in st) box.append(pill(!st.stateValue, 'Offen', 'Geschlossen'));
    else if ('lockState' in st) box.append(pill(st.lockState === 1, 'Verriegelt', 'Offen'));
    else if (Number.isFinite(st.localTemperature)) box.append(h('span', { text: (st.localTemperature / 100).toFixed(1) + ' °C' + (Number.isFinite(st.occupiedHeatingSetpoint) ? ' → ' + (st.occupiedHeatingSetpoint / 100).toFixed(1) + ' °C' : '') }));
    else if (Number.isFinite(st.measuredValue)) box.append(h('span', { text: (st.measuredValue / 100).toFixed(1) }));
    else box.append(h('span', { class: 'muted', text: '–' }));
    if (d.matterDeviceType === 'WindowCovering') {
      const sel = h('select', { 'aria-label': 'Lamellen', style: 'max-width:170px' }, h('option', { value: 'auto', text: 'Automatisch (' + (d.hasTilt ? 'mit Lamellen' : 'nur Höhe') + ')', selected: d.tiltOverride === null || d.tiltOverride === undefined }), h('option', { value: 'true', text: 'Mit Lamellen', selected: d.tiltOverride === true }), h('option', { value: 'false', text: 'Nur Höhe', selected: d.tiltOverride === false }));
      sel.addEventListener('change', async () => { const tilt = sel.value === 'auto' ? null : sel.value === 'true'; sel.disabled = true; try { await post('setDeviceTilt', { address: d.address, tilt }); d.tiltOverride = tilt; alert.hidden = false; } catch (e) { msg(out, e.message, 'bad'); } finally { sel.disabled = false; } });
      box.append(sel);
    }
    return box;
  }
  function roomCell(d) {
    // WLAN-, Tasmota-, Dyson- und Jeep-Einträge: Räume aus der eigenen Raumliste der Bridge
    if (d.provider || d.keyDevice) {
      const cur = ownRooms.assign[d.address] || '';
      const sel = h('select', { 'aria-label': 'Raum für ' + d.name, style: 'min-width:150px' }, h('option', { value: '', text: 'Kein Raum' }), h('option', { value: '__new', text: '＋ Neuer Raum …' }), rooms.map(r => h('option', { value: r.originalName, text: r.name })));
      sel.value = cur && rooms.some(r => r.originalName === cur) ? cur : '';
      sel.addEventListener('change', async () => {
        let target = sel.value; sel.disabled = true;
        try {
          if (target === '__new') { const name = await askRoomName(); if (!name) { sel.value = cur; return; } if (!rooms.some(r => r.name === name)) await post('createRoom', { name }); target = name; }
          await post('setGeraetRaum', { address: d.address, room: target }); msg(out, 'Raum gespeichert.', 'ok'); await load(true);
        } catch (e) { msg(out, e.message, 'bad'); sel.value = cur; }
        finally { sel.disabled = false; }
      });
      return sel;
    }
    const sel = h('select', { 'aria-label': 'Raum für ' + d.name, style: 'min-width:150px', title: 'Ändert die CCU-Raumzuordnung. Eine neue Auswahl ersetzt alle bisherigen.' },
      h('option', { value: '', text: 'Kein Raum' }), h('option', { value: '__new', text: '＋ Neuer Raum …' }), rooms.map(r => h('option', { value: r.originalName, text: r.name })));
    if (d.roomId && !rooms.some(r => r.originalName === d.roomId)) sel.append(h('option', { value: d.roomId, text: d.room }));
    sel.value = d.roomId || '';
    if (d.ccuRooms && d.ccuRooms.length > 1) { sel.append(h('option', { value: '__multi', disabled: true, text: d.ccuRooms.join(', ') + ' (mehrere)' })); sel.value = '__multi'; }
    sel.addEventListener('change', async () => {
      let target = sel.value; sel.disabled = true;
      try {
        if (target === '__new') {
          const name = await askRoomName(); if (!name) { sel.value = d.roomId || ''; return; }
          if (!rooms.some(r => r.name === name)) await post('createRoom', { name }); target = name;
        }
        await post('setDeviceRoom', { address: d.address, room: target }); msg(out, 'Raum gespeichert.', 'ok'); await load(true);
      } catch (e) { msg(out, e.message, 'bad'); sel.value = d.ccuRooms && d.ccuRooms.length > 1 ? '__multi' : d.roomId || ''; }
      finally { sel.disabled = false; }
    });
    return sel;
  }
  function typeCell(d) {
    // Nur die Art in Worten (Wunsch Thomas); technische Angaben stehen in der Geräteverwaltung und im Hinweis.
    return h('span', { text: kindLabel(d), title: [d.hmChannelType || d.hmDeviceType, d.matterDeviceType, d.address].filter(Boolean).join(' · ') });
  }
  // Aufzeichnen für die Diagramme (auf der CCU und – falls eingeschaltet – auf der WD); Standard: ja.
  let recordOff = new Set();
  const loadRecording = () => api('getNetStorage').then(r => { recordOff = new Set(r.recordOff || []); }).catch(() => {});
  function recordCell(d) {
    if (d.keyDevice) return h('span', { class: 'muted', text: '–' });
    const box = h('input', { type: 'checkbox', checked: !recordOff.has(d.address), 'aria-label': d.name + ' aufzeichnen' });
    box.addEventListener('change', async () => {
      box.disabled = true;
      try { const r = await post('setRecording', { address: d.address, record: box.checked }); recordOff = new Set(r.recordOff || []); }
      catch (e) { box.checked = !box.checked; msg(out, e.message, 'bad'); } finally { box.disabled = false; }
    });
    return toggle(box);
  }
  function onlineCell(d) {
    if (d.keyDevice) return h('span', { class: 'muted', text: '–' });
    const id = cuxId(d.address);
    if (id) {
      const box = h('input', { type: 'checkbox', checked: (cux.settings[id] || {}).enabled === true }), state = cux.states.get('cux:' + id);
      const info = h('span', { class: 'sub', text: cux.error || (!box.checked ? 'Prüfung aus' : state ? ({ online: 'Online · ', offline: 'Offline · ', unknown: 'Nicht prüfbar · ' }[state.status] || '') + state.detail : 'IP wird aus PARAM9 gelesen …') });
      box.addEventListener('change', async () => { box.disabled = true; try { const r = await post('saveCuxCheck', { address: d.address, enabled: box.checked }); cux.settings = r.cuxChecks || cux.settings; await loadCux(); render(); } catch (e) { box.checked = !box.checked; msg(out, e.message, 'bad'); } finally { box.disabled = false; } });
      return h('div', {}, check('Online prüfen', box), info);
    }
    if (d.provider === 'tasmota') return h('span', { class: 'muted', text: d.online ? 'Online' : 'Offline', title: 'Tasmota-Geräte werden laufend abgefragt.' });
    if (d.provider && d.provider !== 'jeep') {
      const box = h('input', { type: 'checkbox', checked: !!d.onlineCheck });
      box.addEventListener('change', async () => { box.disabled = true; try { await post('setWifiDevice', { address: d.address, onlineCheck: box.checked }); d.onlineCheck = box.checked; } catch (e) { box.checked = !box.checked; msg(out, e.message, 'bad'); } finally { box.disabled = false; } });
      return check('Online prüfen / WhatsApp', box);
    }
    return h('span', { class: 'muted', text: '–' });
  }

  // ---------- Bedienung ----------
  const pending = new Map();
  async function switchControl(d, on, box) {
    for (const b of box.querySelectorAll('button')) b.disabled = true;
    const req = { state: on, confirmed: false }; pending.set(d.address, req);
    const note = h('span', { class: 'muted', text: 'Wird geschaltet …' }); box.append(note);
    try {
      const r = await post('setSwitchState', { address: d.address, state: on });
      if (r.confirmed && typeof r.state === 'boolean') { d.switchState = r.state; req.confirmed = true; }
      if (!req.confirmed) note.textContent = r.message || 'Befehl übergeben; Rückmeldung steht aus.';
      else render();
    } catch (e) { note.textContent = e.message; for (const b of box.querySelectorAll('button')) b.disabled = false; }
  }
  // Nach einem WLAN-Befehl nur den Statusspeicher nachlesen (nie den Befehl wiederholen).
  const LISTS = { smartplus: 'getSmartplusDevices', smartlife: 'getSmartlifeDevices', dyson: 'getDysonDevices', tasmota: 'getTasmotaDevices' };
  async function pollProvider(provider) {
    try {
      const r = await api(LISTS[provider]); if (!Array.isArray(r.devices)) return;
      for (const item of r.devices) { const d = devices.find(x => x.provider === provider && x.id === item.id); if (!d) continue; if (typeof item.online === 'boolean') d.online = item.online; if (item.state) d.currentState = { ...d.currentState, ...item.state }; }
      render();
    } catch {}
  }
  async function wifiControl(d, command, button) {
    button.disabled = true;
    try {
      const r = await post(PROVIDERS[d.provider], { id: d.id, command }); if (typeof r.online === 'boolean') d.online = r.online; if (r.state) d.currentState = { ...d.currentState, ...r.state }; msg(out, r.message || 'Befehl übergeben.', 'ok'); render();
      for (const delay of [1000, 3000]) setTimeout(() => pollProvider(d.provider), delay);
    } catch (e) { msg(out, e.message, 'bad'); button.disabled = false; }
  }
  function dialog(title, ...content) {
    const close = h('button', { class: 'btn', type: 'button', text: 'Schließen' });
    const dlg = h('dialog', { 'aria-label': title }, h('div', { class: 'dlg-head' }, h('h2', { text: title })), h('div', { class: 'dlg-body' }, ...content), h('div', { class: 'dlg-actions' }, close));
    const done = () => { if (dlg.open) dlg.close(); dlg.remove(); };
    close.addEventListener('click', done); dlg.addEventListener('cancel', done);
    document.body.append(dlg); dlg.showModal(); return dlg;
  }
  function dimmerDialog(d) {
    const lvl = (d.currentState || {}).currentLevel, cur = typeof lvl === 'number' ? Math.round(lvl / 254 * 100) : 50;
    const range = h('input', { type: 'range', min: 0, max: 100, step: 1, value: cur, style: 'width:100%;accent-color:#176c60', 'aria-label': 'Helligkeit' }), val = h('b', { text: cur + ' %' }), note = h('p', { class: 'msg', role: 'status' });
    range.addEventListener('input', () => { val.textContent = range.value + ' %'; });
    const set = async percent => { for (const b of dlg.querySelectorAll('button,input')) b.disabled = true; msg(note, 'Wird eingestellt …', 'busy'); try { const r = await post('setDimmerLevel', { address: d.address, percent }); if (typeof r.percent === 'number' && r.confirmed) { d.currentState = { ...d.currentState, currentLevel: Math.round(r.percent / 100 * 254), onOff: r.percent > 0 }; } msg(note, r.message || 'Übergeben.', 'ok'); render(); } catch (e) { msg(note, e.message, 'bad'); } finally { for (const b of dlg.querySelectorAll('button,input')) b.disabled = false; } };
    const btn = (t, fn, cls) => { const b = h('button', { class: 'btn ' + (cls || ''), type: 'button', text: t }); b.addEventListener('click', fn); return b; };
    const dlg = dialog(d.name, h('p', {}, 'Helligkeit: ', val), range, h('div', { class: 'actions' }, btn('Ein (100 %)', () => set(100)), btn('Aus', () => set(0)), btn('Übernehmen', () => set(Number(range.value)), 'primary')), note);
  }
  function thermostatDialog(d) {
    const cap = d.thermostatControl, t = d.thermostatState || {};
    const input = h('input', { type: 'number', min: cap.min, max: cap.max, step: cap.step || 0.5, value: Number.isFinite(t.setpoint) ? t.setpoint : '', required: true, style: 'max-width:140px' }), note = h('p', { class: 'msg', role: 'status' });
    const apply = h('button', { class: 'btn primary', type: 'button', text: 'Übernehmen' });
    apply.addEventListener('click', async () => {
      if (!input.reportValidity() || input.value === '') return; apply.disabled = true; msg(note, 'Solltemperatur wird übergeben …', 'busy');
      try { const r = await post('setThermostatTemperature', { address: d.address, temperature: Number(input.value) }); if (r.confirmed && typeof r.setpoint === 'number') d.thermostatState = { ...t, setpoint: r.setpoint }; msg(note, r.message || 'Übergeben.', 'ok'); render(); }
      catch (e) { msg(note, e.message, 'bad'); } finally { apply.disabled = false; }
    });
    dialog(d.name, h('p', { text: 'Aktuell: ' + (Number.isFinite(t.temperature) ? t.temperature.toFixed(1) + ' °C' : 'unbekannt') }), field('Solltemperatur (°C)', input), h('div', { class: 'actions' }, apply), note);
  }
  function askRoomName() {
    return new Promise(resolve => {
      const input = h('input', { maxlength: 64, required: true, 'aria-label': 'Name des neuen Raums' }), ok = h('button', { class: 'btn primary', type: 'button', text: 'Anlegen' });
      const dlg = dialog('Neuer CCU-Raum', field('Name des Raums', input), h('div', { class: 'actions' }, ok));
      let done = false; const finish = v => { if (done) return; done = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(v); };
      ok.addEventListener('click', () => { if (input.value.trim()) finish(input.value.trim()); else input.reportValidity(); });
      input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
      dlg.querySelector('.dlg-actions .btn').addEventListener('click', () => finish(null)); dlg.addEventListener('cancel', () => finish(null));
      input.focus();
    });
  }

  // ---------- Liste ----------
  function filtered() {
    const q = search.value.trim().toLowerCase();
    let list = devices.filter(d => f.cuxd.checked || !extraCuxd(d));
    unnamedLabel.textContent = 'Unbenannte Kanäle ausblenden (' + devices.filter(d => !hasName(d)).length + ')';
    if (f.unnamed.checked) list = list.filter(hasName);
    if (f.offline.checked) list = list.filter(d => !offline(d));
    if (q) list = list.filter(d => [d.name, d.address, d.hmChannelType, d.matterDeviceType, d.room].some(v => (v || '').toLowerCase().includes(q)));
    const cmp = new Intl.Collator('de', { sensitivity: 'base', numeric: true }).compare;
    return list.sort((a, b) => cmp(a[sort.key] || '', b[sort.key] || '') * (sort.dir === 'asc' ? 1 : -1) || cmp(a.address, b.address));
  }
  function render() {
    if (editing.size) return; // ungespeicherte Namen nicht überschreiben
    const list = filtered(), pages = Math.max(1, Math.ceil(list.length / size)); page = Math.min(page, pages - 1);
    total.textContent = list.length === devices.length ? devices.length + ' Geräte' : list.length + ' von ' + devices.length + ' Geräten';
    sortName.textContent = 'Name ' + (sort.key === 'name' ? (sort.dir === 'asc' ? '↑' : '↓') : '⇅'); sortRoom.textContent = 'Raum ' + (sort.key === 'room' ? (sort.dir === 'asc' ? '↑' : '↓') : '⇅');
    const rows = list.slice(page * size, (page + 1) * size);
    const del = f.del.checked, delSeen = new Set();
    headRow.replaceChildren(...(del ? ['Löschen', ...COLS] : COLS).map(t => h('th', { text: t })));
    // Löschen-Knopf je CCU-Gerät (einmal pro Gerät, nicht für WLAN- oder Jeep-Einträge)
    const delCell = d => {
      const base = String(d.address || '').split(':')[0];
      if (d.provider || /^CUX/i.test(base) || !base || delSeen.has(base)) return h('td', {});
      delSeen.add(base);
      const b = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen', title: 'Gerät auf Werkseinstellung setzen und aus der CCU entfernen' });
      b.addEventListener('click', () => removeDevice({ address: base, name: d.name, type: d.hmDeviceType }, false, b));
      return h('td', {}, b);
    };
    body.replaceChildren(...(rows.length ? rows.map(d => h('tr', {}, del ? delCell(d) : null, h('td', {}, exposeCell(d)), h('td', {}, nameCell(d)), h('td', {}, stateCell(d)), h('td', {}, roomCell(d)), h('td', {}, typeCell(d)), h('td', {}, recordCell(d)), h('td', {}, onlineCell(d)))) : [h('tr', {}, h('td', { colspan: 7, class: 'empty', text: devices.length ? 'Keine passenden Geräte.' : 'Keine Geräte gefunden.' }))]));
    const prev = h('button', { class: 'btn small', type: 'button', text: 'Zurück', disabled: page === 0 }), next = h('button', { class: 'btn small', type: 'button', text: 'Weiter', disabled: page >= pages - 1 });
    const per = h('select', { 'aria-label': 'Geräte pro Seite', style: 'max-width:140px' }, [10, 25, 50, 100].map(n => h('option', { value: n, text: n + ' pro Seite', selected: n === size })));
    prev.addEventListener('click', () => { page--; render(); }); next.addEventListener('click', () => { page++; render(); }); per.addEventListener('change', () => { size = Number(per.value); page = 0; render(); });
    pager.replaceChildren(prev, h('span', { class: 'muted', text: 'Seite ' + (page + 1) + ' von ' + pages }), next, per);
    renderUnmapped();
  }
  function renderUnmapped() {
    unmappedBox.hidden = !f.unmapped.checked; if (!f.unmapped.checked) return;
    const mapped = new Set(devices.map(d => d.address)), list = channels.filter(c => !mapped.has(c.address) && (f.cuxd.checked || !extraCuxd(c)));
    unmappedBox.replaceChildren(panel('Nicht zugeordnete Kanäle', 'Kanäle der CCU, für die es (noch) keinen Matter-Gerätetyp gibt.', list.length ? NEU.table(['Adresse', 'Typ', 'Name', 'Werte', 'Online prüfen'], list.map(c => h('tr', {}, h('td', { class: 'mono', text: c.address }), h('td', {}, h('span', { class: 'tag', text: c.type || '–' })), h('td', { text: c.name || '' }), h('td', { class: 'muted', text: Object.keys(c.values || {}).join(', ') || '–' }), h('td', {}, onlineCell(c))))) : h('div', { class: 'empty', text: 'Keine nicht zugeordneten Kanäle.' })));
  }
  // ---------- Geräte löschen (Werkseinstellung + aus der CCU entfernen) ----------
  let ccuList = null;
  async function removeDevice(g, force, btn) {
    const ok = await NEU.confirmDialog({
      title: force ? 'Ohne Reset entfernen?' : 'Gerät löschen?', danger: true, slider: true, confirm: force ? 'Ohne Reset entfernen' : 'Löschen',
      text: (g.name || g.type) + ' (' + g.address + ') ' + (force ? 'wird nur aus der CCU entfernt. Das Gerät selbst behält seine Anlernung und muss später von Hand zurückgesetzt werden.' : 'wird auf Werkseinstellung zurückgesetzt und aus der Liste entfernt. Danach muss es neu angelernt werden.')
    });
    if (!ok) return;
    btn.disabled = true; msg(out, 'Gerät wird gelöscht … (bis zu 30 Sekunden)', 'busy');
    try {
      const r = await post('deleteCcuDevice', { address: g.address, force });
      msg(out, r.message || 'Gerät gelöscht.', 'ok'); ccuList = null; await renderDelete(); load(true);
    } catch (e) {
      msg(out, e.message, 'bad');
      if (!force && (e.status === 502 || /Werkseinstellung/.test(e.message))) { btn.disabled = false; btn.textContent = 'Ohne Reset entfernen …'; btn.onclick = () => removeDevice(g, true, btn); } else btn.disabled = false;
    }
  }
  async function renderDelete() {
    deleteBox.hidden = !f.del.checked; if (!f.del.checked) return;
    if (!ccuList) { try { ccuList = (await api('getCcuDeviceList')).devices || []; } catch (e) { deleteBox.replaceChildren(panel('Geräte löschen', null, h('p', { class: 'msg bad', text: 'Geräteliste nicht lesbar: ' + e.message }))); return; } }
    // Hier nur noch Geräte ohne eigene Zeile oben (z. B. Taster) – die übrigen haben den Knopf in der Tabelle.
    const shownDev = new Set(devices.map(x => String(x.address || '').split(':')[0]));
    const others = ccuList.filter(g => g.deletable && !shownDev.has(g.address));
    deleteBox.hidden = !others.length; if (!others.length) return;
    const rows = others.map(g => {
      const btn = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen', disabled: !g.deletable, title: g.deletable ? '' : 'Die Zentrale kann nicht gelöscht werden.' });
      btn.addEventListener('click', () => removeDevice(g, false, btn));
      return h('tr', {}, h('td', {}, h('b', { text: g.name || g.type || g.address })), h('td', {}, h('span', { class: 'tag', text: g.type || '–' })), h('td', { class: 'mono', text: g.address }), h('td', { text: g.label }), h('td', { text: g.room || '–' }), h('td', {}, btn));
    });
    deleteBox.replaceChildren(panel('Weitere Geräte löschen', 'Geräte ohne eigene Zeile oben (z. B. Taster und Fernbedienungen). „Löschen“ setzt das Gerät auf Werkseinstellung zurück und entfernt es aus der CCU. Batteriegeräte vorher kurz wecken (Taste drücken).',
      others.length ? NEU.table(['Name', 'Typ', 'Adresse', 'Funk', 'Raum', ''], rows) : h('p', { class: 'muted', text: 'Keine Geräte gefunden.' })));
  }
  async function loadCux() {
    try { const d = await api('getServiceStatus', undefined, { errorField: false }); cux = { settings: d.cuxChecks || {}, states: new Map((d.services || []).map(s => [s.id, s])), error: d.error || '' }; }
    catch (e) { cux.error = 'Status nicht verfügbar: ' + e.message; }
  }
  // Auf der echten CCU kommen viele Zustandsmeldungen pro Sekunde. Würde die Tabelle bei jeder neu gebaut,
  // wäre ein Schalter beim Loslassen der Maus schon ersetzt und der Klick ginge ins Leere.
  // Deshalb: Neuaufbau höchstens etwa einmal pro Sekunde und nie während/kurz nach einem Klick in der Tabelle.
  let renderTimer = null, holdUntil = 0;
  const holding = () => Date.now() < holdUntil || (body.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName) && document.activeElement.type !== 'checkbox');
  body.addEventListener('pointerdown', () => { holdUntil = Date.now() + 1500; }, true);
  body.addEventListener('keydown', () => { holdUntil = Date.now() + 1500; }, true);
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function run() { if (holding()) { renderTimer = setTimeout(run, 400); return; } renderTimer = null; render(); }, 1000);
  }
  async function load(force) {
    if (loading || (!force && (editing.size || holding() || (body.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) || document.querySelector('dialog[open]')))) return;
    loading = true;
    try {
      try { rooms = (await api('getRooms')).rooms || []; } catch {}
      try { ownRooms = await api('getRaumZuordnung'); } catch {}
      try { werte = (await api('getLetzteWerte')).devices || {}; } catch {}
      const d = await api('getDevices');
      devices = d.devices || []; f.defaultExposed.checked = d.defaultExposed !== false;
      // Tasmota-Steckdosen, die zu einem CUxD-Gerät gehören: nur einmal zeigen (als CUxD-Gerät mit Leistung).
      for (const t of devices.filter(x => x.provider === 'tasmota' && x.cuxd)) { const target = devices.find(x => x.address === t.cuxd.address + ':1'); if (!target) continue; target.linkedPower = t.currentState?.power; target.linkedTasmota = t.address; t.hiddenByCuxd = true; }
      devices = devices.filter(x => !x.hiddenByCuxd).concat(keyRows.map(x => ({ ...x, room: ownRooms.assign[x.address] || '' })));
      for (const x of devices) if (x.provider && Object.hasOwn(ownRooms.assign || {}, x.address)) x.room = ownRooms.assign[x.address] || '';
      // Homematic-Geräte, die die Zentrale als „nicht erreichbar“ meldet: als Offline zeigen (ohne Schaltknopf).
      try { const unreach = new Set(((await api('getCcuOverview')).messages || []).filter(m => m.type === 'UNREACH').map(m => m.address)); for (const x of devices) if (!x.provider && unreach.has(String(x.address).split(':')[0])) x.onlineStatus = 'offline'; } catch {}
      for (const x of devices) { const s = exposedSet.get(x.address); if (s) { if (Date.now() > s.until || x.exposed === s.value) exposedSet.delete(x.address); else x.exposed = s.value; } }
      if (d.loading && !devices.length) { total.textContent = 'Geräte werden erkannt …'; body.replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'empty', text: 'CCU-Geräte werden erkannt … (bei vielen Geräten bis zu einer Minute)' }))); clearTimeout(retry); retry = setTimeout(() => load(true), 2000); return; }
      render(); renderKeys(force).catch(() => {});
    } catch (e) { body.replaceChildren(h('tr', {}, h('td', { colspan: 7, class: 'empty', text: 'Geräte konnten nicht geladen werden: ' + e.message }))); }
    finally { loading = false; }
  }
  search.addEventListener('input', () => { page = 0; render(); });
  for (const k of ['unnamed', 'offline']) f[k].addEventListener('change', () => { page = 0; render(); });
  f.cuxd.addEventListener('change', () => { try { localStorage.setItem('mh-show-extra-cuxd-first-only', String(f.cuxd.checked)); } catch {} page = 0; render(); });
  f.unmapped.addEventListener('change', async () => { if (f.unmapped.checked && !channels.length) { try { channels = (await api('getChannels')).channels || []; } catch (e) { msg(out, e.message, 'bad'); } } renderUnmapped(); });
  f.del.addEventListener('change', () => { ccuList = null; render(); renderDelete(); });
  f.defaultExposed.addEventListener('change', async () => {
    const value = f.defaultExposed.checked;
    if (value && !await confirmDialog({ title: 'Neue Geräte automatisch freigeben?', text: 'Neu angelernte Homematic-Geräte erscheinen dann automatisch in Apple Home.', confirm: 'Einschalten' })) { f.defaultExposed.checked = false; return; }
    f.defaultExposed.disabled = true;
    try { await post('setDefaultExposed', { defaultExposed: value }); alert.hidden = false; msg(out, 'Gespeichert.', 'ok'); } catch (e) { f.defaultExposed.checked = !value; msg(out, e.message, 'bad'); } finally { f.defaultExposed.disabled = false; }
  });
  NEU.events({
    ready: () => load(true),
    state: e => { const d = devices.find(x => x.address === e.address); if (!d || typeof e.state !== 'boolean') return; d.switchState = e.state; if (d.currentState) d.currentState.onOff = e.state; pending.delete(e.address); scheduleRender(); },
    dimmer: e => { const d = devices.find(x => x.address === e.address); if (!d || typeof e.percent !== 'number') return; d.currentState = { ...d.currentState, currentLevel: Math.round(e.percent / 100 * 254), onOff: e.percent > 0 }; scheduleRender(); },
    thermostat: e => { const d = devices.find(x => x.address === e.address); if (!d) return; d.thermostatState = { ...(d.thermostatState || {}), ...(Number.isFinite(e.temperature) ? { temperature: e.temperature } : {}), ...(Number.isFinite(e.setpoint) ? { setpoint: e.setpoint } : {}) }; scheduleRender(); }
  });
  Promise.all([loadCux(), loadRecording()]).then(() => load(true));
  setInterval(() => { if (!document.hidden) load(); }, 15000);
  setInterval(() => { if (!document.hidden) loadCux().then(() => render()); }, 30000);
});
