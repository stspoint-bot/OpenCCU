'use strict';
// Seite „Geräteverwaltung“ (Wunsch Thomas, 12.10.2026): alle Geräte mit den Zusatzangaben wie in der OpenCCU unter
// „Einstellungen → Geräte“ (Typ, Seriennummer, Schnittstelle, Kategorie, Übertragungsmodus, Gewerk, Raum, Firmware …)
// und aufklappbaren Kanälen. Nur anzeigen.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg, task, field } = NEU;
  const main = shell({ title: 'Geräteverwaltung', eyebrow: 'System', lead: 'Alle Geräte der Zentrale mit Typ, Seriennummer, Schnittstelle, Kategorie, Übertragungsmodus, Gewerk, Raum, Firmware und Funkempfang – wie in der alten CCU unter „Einstellungen → Geräte“. Ein Klick auf ein Gerät zeigt die Kanäle.' });
  const search = h('input', { type: 'search', placeholder: 'Suchen (Name, Typ, Seriennummer, Raum …)', 'aria-label': 'Geräte durchsuchen' });
  const room = h('select', { 'aria-label': 'Raum' }), iface = h('select', { 'aria-label': 'Interface' }), only = h('select', { 'aria-label': 'Zustand' });
  only.append(...[['', 'Alle Zustände'], ['problem', 'Nur mit Hinweis'], ['update', 'Firmware-Update verfügbar']].map(([v, t]) => h('option', { value: v, text: t })));
  const reload = h('button', { class: 'btn', type: 'button', text: 'Neu einlesen' });
  const out = h('p', { class: 'msg', role: 'status' }), list = h('div', { class: 'auto-list' }), stats = h('div', { class: 'stats' });
  main.append(stats, panel('Geräte', 'Gelesen aus der Zentrale (nur lesen, es wird nichts gefunkt).', h('div', { class: 'row' }, search, room, iface, only, reload), out, list));
  let data = null;
  const join = a => a && a.length ? a.join(', ') : '–';
  // Kanal-Typen der CCU auf Deutsch (unbekannte bleiben technisch, mit Tooltip)
  const CH_TYPES = { MAINTENANCE: 'Wartung', MULTI_MODE_INPUT_TRANSMITTER: 'Eingang (Wandschalter)', SWITCH_TRANSMITTER: 'Schaltzustand', SWITCH_VIRTUAL_RECEIVER: 'Schaltkanal', SWITCH_WEEK_PROFILE: 'Wochenprogramm',
    SWITCH: 'Schaltkanal', DIMMER_TRANSMITTER: 'Helligkeit (Zustand)', DIMMER_VIRTUAL_RECEIVER: 'Dimmkanal', DIMMER: 'Dimmkanal', DIMMER_WEEK_PROFILE: 'Wochenprogramm', KEY_TRANSCEIVER: 'Taste', KEY: 'Taste', VIRTUAL_KEY: 'Virtuelle Taste',
    MOTIONDETECTOR_TRANSCEIVER: 'Bewegungsmelder', MOTION_DETECTOR: 'Bewegungsmelder', PRESENCEDETECTOR_TRANSCEIVER: 'Präsenzmelder', SHUTTER_CONTACT: 'Fensterkontakt', SHUTTER_CONTACT_TRANSCEIVER: 'Fensterkontakt', ROTARY_HANDLE_SENSOR: 'Fenstergriff',
    HEATING_CLIMATECONTROL_TRANSCEIVER: 'Heizungsregelung', HEATING_CLIMATECONTROL_RECEIVER: 'Heizungsregelung (Empfang)', CLIMATECONTROL_FLOOR_TRANSCEIVER: 'Fußbodenheizung', CLIMATECONTROL_RT_TRANSCEIVER: 'Heizungsregelung', CLIMATECONTROL_REGULATOR: 'Regler', CLIMATE_TRANSCEIVER: 'Temperatur/Feuchte',
    WEATHER: 'Wetter', WEATHER_TRANSMIT: 'Temperatur/Feuchte', HEATING_CLIMATECONTROL_CL_RECEIVER: 'Heizung (Kühlung)', HEATING_KEY_RECEIVER: 'Heizung (Taste)', HEATING_SHUTTER_CONTACT_RECEIVER: 'Heizung (Fensterkontakt)', HEATING_ROOM_TH_RECEIVER: 'Heizung (Raumfühler)',
    BLIND_TRANSMITTER: 'Rollladen (Zustand)', BLIND_VIRTUAL_RECEIVER: 'Rollladenkanal', SHUTTER_TRANSMITTER: 'Rollladen (Zustand)', SHUTTER_VIRTUAL_RECEIVER: 'Rollladenkanal', BLIND: 'Rollladen', DOOR_LOCK_STATE_TRANSMITTER: 'Türschloss (Zustand)', DOOR_LOCK_RECEIVER: 'Türschloss',
    ACCESS_TRANSCEIVER: 'Zugang', ACCESS_RECEIVER: 'Zugang', ENERGIE_METER_TRANSMITTER: 'Energiezähler', POWERMETER: 'Energiezähler', CONDITION_POWER: 'Grenzwert Leistung', CONDITION_CURRENT: 'Grenzwert Strom', CONDITION_VOLTAGE: 'Grenzwert Spannung', CONDITION_FREQUENCY: 'Grenzwert Frequenz',
    SMOKE_DETECTOR: 'Rauchmelder', WATER_DETECTION_TRANSMITTER: 'Wassermelder', BRIGHTNESS_TRANSMITTER: 'Helligkeitssensor', ALARM_SWITCH_VIRTUAL_RECEIVER: 'Alarm', ACOUSTIC_SIGNAL_VIRTUAL_RECEIVER: 'Signalgeber', CENTRAL_KEY: 'Zentrale Taste', REMOTE_CONTROL: 'Fernbedienung', DEVICE_OPERATIONMODE: 'Betriebsart' };
  const chType = t => CH_TYPES[t] || (t ? t.replace(/_/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()) : '–');
  // Funkempfang in Worten (RSSI in dBm, näher an 0 = besser)
  const signal = v => v == null || Math.abs(v) >= 255 || v === 0 ? '–' : v >= -65 ? v + ' dBm (sehr gut)' : v >= -80 ? v + ' dBm (gut)' : v >= -90 ? v + ' dBm (schwach)' : v + ' dBm (sehr schwach)';
  function tags(d) {
    const t = [];
    if (d.unreach) t.push(['tag bad', 'nicht erreichbar']);
    if (d.lowBat) t.push(['tag warn', 'Batterie schwach']);
    if (d.sabotage) t.push(['tag bad', 'Sabotage']);
    if (d.dutyCycle) t.push(['tag warn', 'Sendelimit']);
    if (d.configPending) t.push(['tag', 'Konfiguration offen']);
    if (!d.ready) t.push(['tag warn', 'im Posteingang']);
    if (d.firmwareUpdate && !d.central) t.push(['tag warn', '⬆ Firmware-Update ' + d.firmware + ' → ' + d.firmwareUpdate + (d.firmwareState && d.firmwareState !== 'aktuell' ? ' (' + d.firmwareState + ')' : '')]);
    else if (d.firmwareState && !['aktuell', ''].includes(d.firmwareState)) t.push(['tag warn', 'Firmware: ' + d.firmwareState]);
    if (d.inAppleHome) t.push(['tag ok', 'Apple Home']);
    return t;
  }
  const problem = d => d.unreach || d.lowBat || d.sabotage || d.dutyCycle || d.configPending || !d.ready;
  function info(label, value) { return h('div', {}, h('span', { class: 'muted', text: label + ': ' }), h('span', { text: value || '–' })); }
  function render() {
    if (!data) return;
    for (const b of [...lives.keys()]) stopLive(b);
    const q = search.value.trim().toLowerCase();
    const items = data.devices.filter(d => (!q || [d.name, d.type, d.address, d.interface, ...d.rooms, ...d.functions, ...d.channels.map(c => c.name)].join(' ').toLowerCase().includes(q))
      && (!room.value || d.rooms.includes(room.value)) && (!iface.value || d.interface === iface.value)
      && (only.value !== 'problem' || problem(d)) && (only.value !== 'update' || d.firmwareUpdate))
      .sort((a, b) => String(shownName(a) || '').localeCompare(String(shownName(b) || ''), 'de', { sensitivity: 'base', numeric: true })); // alphabetisch (Wunsch Thomas)
    list.replaceChildren(...(items.length ? items.map(d => {
      const img = d.icon ? h('img', { class: 'dev-icon', src: '/geraet-bild/' + encodeURIComponent(d.icon), alt: '', width: 40, height: 40, loading: 'lazy' }) : h('span', { class: 'dev-icon' });
      const chRows = d.channels.map(c => h('tr', {},
        h('td', { class: 'mono', text: c.address }), h('td', { text: c.name }), h('td', { text: chType(c.type), title: c.type || '' }), h('td', { text: c.direction || '–' }),
        h('td', { text: c.aes ? 'Gesichert' : 'Standard' }), h('td', { text: join(c.functions) }), h('td', { text: join(c.rooms) }), h('td', { text: valueText(c.value), title: c.value ? c.value.key : '' })));
      const liveBox = h('div', { class: 'gv-live' }), wpBox = h('div', { class: 'gv-wp' });
      const det = h('details', { class: 'auto-item' },
        h('summary', {}, img, ' ', h('b', { text: shownName(d) }), h('span', { class: 'gv-dot', dataset: { dev: d.address }, title: 'Gerade betätigt', hidden: !(activity[d.address] > Date.now() - 30000) }), d.value ? h('span', { class: 'tag ok', text: valueText(d.value), title: d.value.channel }) : null, h('span', { class: 'muted', text: ' · ' + d.type + ' · ' + join(d.rooms) + (standOf(d.address) ? ' · ' + standOf(d.address) : '') }), ' ', ...tags(d).map(([c, t]) => h('span', { class: c, text: t }))),
        h('div', { class: 'auto-body' },
          h('div', { class: 'form' },
            info('Typenbezeichnung', d.type), info('Seriennummer', d.address), info('Funk-Schnittstelle', d.interface === 'HmIP-RF' ? 'Homematic IP (HmIP-RF)' : d.interface === 'BidCos-RF' ? 'Homematic (BidCos-RF)' : d.interface), info('Kategorie', d.category),
            info('Übertragungsmodus', d.transmission), info('Gewerk', join(d.functions)), info('Raum', join(d.rooms)),
            d.firmwareUpdate && !d.central ? h('div', {}, h('span', { class: 'muted', text: 'Firmware: ' }), h('span', { text: d.firmware + ' – ' }), fwLink(d)) : info('Firmware', d.firmware ? d.firmware + (d.firmwareUpdate ? ' – Update auf ' + d.firmwareUpdate + ' verfügbar' : ' (aktuell)') + (d.firmwareState && !['aktuell'].includes(d.firmwareState) ? ', ' + d.firmwareState : '') : ''), info('Stromversorgung', d.power),
            info('Funkempfang Gerät', signal(d.rssi)), info('Funkempfang Zentrale', signal(d.rssiPeer)), info('Betriebsspannung', d.voltage == null ? '' : String(d.voltage).replace('.', ',') + ' V')),
          werteArea(d.address),
          h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Kanal', 'Name', 'Typ', 'Kategorie', 'Übertragung', 'Gewerk', 'Raum', 'Wert'].map(t => h('th', { text: t })))), h('tbody', {}, ...chRows))),
          nameArea(d), placeArea(d), d.firmwareUpdate && !d.central ? firmwareArea(d) : null, wpBox, settingsArea(d), h('h3', { text: 'Live-Ansicht' }), liveBox, deleteArea(d)));
      det.addEventListener('toggle', () => { if (det.open) { startLive(d.address, liveBox); if (!wpBox.dataset.loaded && !d.central && ['HmIP-RF', 'BidCos-RF'].includes(d.interface)) { wpBox.dataset.loaded = '1'; loadWeek(d, wpBox); } } else stopLive(liveBox); });
      return det;
    }) : [h('div', { class: 'empty', text: data.devices.length ? 'Keine passenden Geräte.' : 'Keine Geräte gefunden.' })]));
  }
  // Gerät löschen (von der Geräteseite hierher verlegt, Wunsch Thomas): Werkseinstellung + aus der CCU entfernen,
  // mit Schieberegler-Rückfrage; nur für löschbare Funkgeräte (nicht Zentrale/intern), nur Administratoren (prüft der Server).
  // Namen ändern (Wunsch Thomas): gleiche Speicherung wie auf der Geräteseite (setDeviceName) – der Name gilt dort und in Apple Home.
  let rowsByDevice = new Map(), extraRows = [], extraRooms = {};
  // Integrationen je Firma (Wunsch Thomas): gleiche Möglichkeiten wie bei den CCU-Geräten – Name, Raum, Gewerk, aktueller Wert, Zustand
  const extrasBox = h('div'); main.append(extrasBox);
  const FIRMS = { tasmota: ['Tasmota', '/tasmota.html'], smartplus: ['SMART+ (LEDVANCE)', '/smartplus.html'], smartlife: ['Smart Life (Tuya)', '/smartlife.html'], dyson: ['Dyson', '/dyson.html'], jeep: ['Jeep', '/jeep.html'] };
  const RENAME = { jeep: d => ['setJeepName', { address: d.address }], tasmota: d => ['setTasmotaDevice', { id: d.id }], smartplus: d => ['setWifiDevice', { address: d.address }], smartlife: d => ['setWifiDevice', { address: d.address }], dyson: d => ['setWifiDevice', { address: d.address }] };
  // Messwerte mit „Stand“ (Wunsch Thomas): alle Werte, die das Gerät liefert, und von wann sie sind (getLetzteWerte)
  let werte = {};
  const loadWerte = () => api('getLetzteWerte').then(r => { werte = r.devices || {}; }).catch(() => {});
  const standText = iso => { const t = new Date(iso); if (!Number.isFinite(t.getTime())) return ''; const hm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'; return new Date().toDateString() === t.toDateString() ? 'heute ' + hm : t.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' }) + ' ' + hm; };
  const standOf = key => { const w = werte[key]; return w ? 'Stand: ' + (w.at ? standText(w.at) : (w.hint || 'unbekannt')) : ''; };
  function werteArea(key) {
    const w = werte[key]; if (!w) return null;
    return h('div', { class: 'werte' }, h('h3', { text: 'Messwerte' }), ...w.values.map(([k, v]) => h('div', { text: k + ': ' + v })), ...w.flags.map(f => h('span', { class: 'tag bad', text: f })), h('span', { class: 'sub', text: standOf(key) }));
  }
  function extraValue(d) { const s = d.currentState || {}; if (d.provider === 'jeep') return s.value == null ? '' : Number(s.value).toLocaleString('de-DE') + ' ' + (s.unit || ''); if (typeof s.on === 'boolean') return s.on ? 'Ein' : 'Aus'; const p = []; if (Number.isFinite(s.temperature)) p.push(s.temperature.toLocaleString('de-DE') + ' °C'); if (Number.isFinite(s.humidity)) p.push(s.humidity.toLocaleString('de-DE') + ' %'); if (Number.isFinite(s.power)) p.push(s.power.toLocaleString('de-DE') + ' W'); return p.join(' · '); }
  function extraItem(d) {
    const name = h('input', { type: 'text', maxlength: 64, value: d.name || '' }), saveName = h('button', { class: 'btn small primary', type: 'button', text: 'Name übernehmen' }), o = h('span', { class: 'msg', role: 'status' });
    saveName.addEventListener('click', () => task(saveName, o, async () => { const [m, p] = RENAME[d.provider](d); await api(m, { ...p, name: name.value.trim() }); await loadRows(); return 'Gespeichert.'; }, 'Wird gespeichert …'));
    const room = h('select', { 'aria-label': 'Raum' }, h('option', { value: '', text: 'Kein Raum' }), ...((data && data.raeume) || []).map(n => h('option', { value: n, text: n }))); room.value = extraRooms[d.address] || '';
    const gw = h('select', { 'aria-label': 'Gewerk' }, h('option', { value: '', text: 'Kein Gewerk' }), ...((data && data.gewerke) || []).map(n => h('option', { value: n, text: n }))); gw.value = (data && data.gewerkJe && data.gewerkJe[d.address]) || '';
    const savePlace = h('button', { class: 'btn small primary', type: 'button', text: 'Übernehmen' });
    savePlace.addEventListener('click', () => task(savePlace, o, async () => { await api('setGeraetRaumGewerk', { address: d.address, room: room.value, gewerk: gw.value }); await load(true); await loadRows(); return 'Gespeichert.'; }, 'Wird gespeichert …'));
    // Entfernen (wie auf der Tasmota-Seite): ganzes Tasmota-Gerät aus Oberfläche, Apple Home und Automationen; am Gerät selbst ändert sich nichts
    let removeBox = null;
    if (d.provider === 'tasmota') {
      const rm = h('button', { class: 'btn small danger', type: 'button', text: 'Gerät entfernen' });
      rm.addEventListener('click', async () => {
        if (!await NEU.confirmDialog({ title: '„' + (d.name || d.address) + '“ entfernen?', text: 'Das Tasmota-Gerät (mit allen Kanälen) verschwindet aus dieser Oberfläche, aus Apple Home und aus der Auswahl der Automationen. Am Gerät selbst wird nichts geändert.', confirm: 'Entfernen', danger: true })) return;
        task(rm, o, async () => { const t = await api('getTasmotaDevices'); const mac = (t.devices || []).find(x => x.id === d.id)?.mac; if (!mac) throw Error('Gerät nicht mehr vorhanden'); const r = await api('removeTasmota', { mac }); await loadRows(); return r.message || 'Entfernt.'; }, 'Wird entfernt …');
      });
      removeBox = h('div', {}, h('h3', { text: 'Entfernen' }), rm);
    }
    const val = extraValue(d), online = d.online === false ? h('span', { class: 'tag bad', text: 'offline' }) : null, home = d.exposed ? h('span', { class: 'tag ok', text: 'Apple Home' }) : null;
    return h('details', { class: 'auto-item' }, h('summary', {}, h('b', { text: d.name || d.address }), val ? h('span', { class: 'tag ok', text: val }) : null, h('span', { class: 'muted', text: ' · ' + (extraRooms[d.address] || 'kein Raum') + (standOf(d.address) ? ' · ' + standOf(d.address) : '') }), ' ', online, home),
      h('div', { class: 'auto-body' }, d.provider === 'jeep' ? null : werteArea(d.address), h('h3', { text: 'Name' }), h('div', { class: 'row' }, name, saveName), h('h3', { text: 'Raum und Gewerk' }), h('div', { class: 'row' }, field('Raum', room), field('Gewerk', gw), savePlace), o,
        h('p', { class: 'muted mono', text: d.address }), h('a', { class: 'btn small', href: FIRMS[d.provider]?.[1] || '#', text: 'Einstellungen bei ' + (FIRMS[d.provider]?.[0] || d.provider) }), removeBox));
  }
  function renderExtras() {
    const groups = new Map(); for (const d of extraRows) { if (!FIRMS[d.provider]) continue; if (!groups.has(d.provider)) groups.set(d.provider, []); groups.get(d.provider).push(d); }
    extrasBox.replaceChildren(...[...groups].map(([p, list]) => panel(FIRMS[p][0] + ' (' + list.length + ')', 'Geräte aus der Integration ' + FIRMS[p][0] + '.', h('div', { class: 'auto-list' }, ...list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de')).map(extraItem)))));
  }
  const loadRows = () => Promise.all([api('getDevices'), api('getRaumZuordnung').catch(() => ({ assign: {} }))]).then(([r, rz]) => { extraRows = (r.devices || []).filter(x => x.provider); extraRooms = rz.assign || {}; renderExtras(); rowsByDevice = new Map(); for (const x of r.devices || []) { if (x.provider) continue; const dev = String(x.address).split(':')[0]; if (!rowsByDevice.has(dev)) rowsByDevice.set(dev, []); rowsByDevice.get(dev).push(x); } render(); }).catch(() => {});
  loadRows();
  const shownName = d => d.name;
  // Ein Name für das ganze Gerät: Kanäle heißen danach „Name:Kanal“; die Einträge der Geräteseite (und Apple Home) bekommen
  // den Namen – bei einem Eintrag genau so, bei mehreren mit Kanalnummer.
  function nameArea(d) {
    const rows = rowsByDevice.get(d.address) || [];
    const input = h('input', { type: 'text', maxlength: 64, value: d.name, 'aria-label': 'Gerätename' }), save = h('button', { class: 'btn small primary', type: 'button', text: 'Name übernehmen' }), o = h('span', { class: 'msg', role: 'status' });
    save.addEventListener('click', () => task(save, o, async () => {
      const name = input.value.trim(); if (!name) throw Error('Bitte einen Namen eingeben.');
      await api('setGeraetName', { address: d.address, name });
      for (const x of rows) await api('setDeviceName', { address: x.address, name: rows.length === 1 ? name : name + ' ' + x.address.split(':')[1] });
      await load(true); await loadRows(); return 'Gespeichert' + (rows.length ? ' – auch in der Geräteliste' + (rows.length > 1 ? ' (' + rows.length + ' Einträge mit Kanalnummer)' : '') : '') + '.';
    }, 'Wird gespeichert …'));
    return h('div', { class: 'gv-names' }, h('h3', { text: 'Gerätename' }), h('div', { class: 'row' }, input, save), o,
      rows.length ? h('p', { class: 'muted', text: 'In der Geräteliste/Apple Home: ' + rows.map(x => x.name).join(', ') }) : null);
  }
  // Raum und Gewerk je Gerät (eigene Einstellung der Bridge; der Raum gilt für alle Kanäle des Geräts)
  function placeArea(d) {
    const room = h('select', { 'aria-label': 'Raum' }, h('option', { value: '', text: 'Kein Raum' }), ...(data.raeume || []).map(n => h('option', { value: n, text: n })));
    room.value = (d.rooms || [])[0] || '';
    const gw = h('select', { 'aria-label': 'Gewerk' }, h('option', { value: '', text: 'Kein Gewerk' }), ...(data.gewerke || []).map(n => h('option', { value: n, text: n })));
    gw.value = (d.functions || [])[0] || '';
    const save = h('button', { class: 'btn small primary', type: 'button', text: 'Übernehmen' }), o = h('span', { class: 'msg', role: 'status' });
    save.addEventListener('click', () => task(save, o, async () => { await api('setGeraetRaumGewerk', { address: d.address, room: room.value, gewerk: gw.value }); await load(true); return 'Gespeichert.'; }, 'Wird gespeichert …'));
    return h('div', { class: 'gv-place' }, h('h3', { text: 'Raum und Gewerk' }), h('div', { class: 'row' }, field('Raum', room), field('Gewerk', gw), save), o);
  }
  // Firmware-Update auf Klick (Wunsch Thomas): Schieberegler-Rückfrage, nur Geräte, nur Administratoren (prüft der Server)
  // Klick auf den Hinweis startet die Installation (gleiche Rückfrage wie der Knopf)
  function fwLink(d) { const a = h('button', { class: 'btn small primary', type: 'button', text: '⬆ Update auf ' + d.firmwareUpdate + ' installieren' }); a.addEventListener('click', () => fwInstall(d, a, null)); return a; }
  async function fwInstall(d, btn, o) {
    const ok = await NEU.confirmDialog({ title: 'Firmware installieren?', danger: true, slider: true, confirm: 'Installieren', text: d.name + ': Firmware ' + d.firmware + ' → ' + d.firmwareUpdate + '. Das Update dauert einige Minuten, das Gerät ist währenddessen nicht bedienbar. Gerät nicht stromlos machen. Batteriegeräte vorher kurz wecken (Taste drücken).' });
    if (!ok) return;
    btn.disabled = true; const out2 = o || h('span', { class: 'msg', role: 'status' }); if (!o) btn.after(out2); msg(out2, 'Update wird gestartet …', 'busy');
    try { const r = await api('startFirmwareUpdate', { address: d.address }); msg(out2, r.message, 'ok'); } catch (e) { msg(out2, e.message, 'bad'); btn.disabled = false; }
  }
  function firmwareArea(d) {
    const btn = h('button', { class: 'btn small primary', type: 'button', text: 'Firmware ' + d.firmwareUpdate + ' installieren …' }), o = h('p', { class: 'msg', role: 'status' });
    btn.addEventListener('click', async () => {
      const ok = await NEU.confirmDialog({ title: 'Firmware installieren?', danger: true, slider: true, confirm: 'Installieren', text: d.name + ': Firmware ' + d.firmware + ' → ' + d.firmwareUpdate + '. Das Update dauert einige Minuten, das Gerät ist währenddessen nicht bedienbar. Gerät nicht stromlos machen. Batteriegeräte vorher kurz wecken (Taste drücken).' });
      if (!ok) return;
      btn.disabled = true; msg(o, 'Update wird gestartet …', 'busy');
      try { const r = await api('startFirmwareUpdate', { address: d.address }); msg(o, r.message, 'ok'); } catch (e) { msg(o, e.message, 'bad'); btn.disabled = false; }
    });
    return h('div', { class: 'notice warn' }, h('p', { text: 'Neue Firmware ' + d.firmwareUpdate + ' liegt bereit (installiert: ' + d.firmware + ').' }), btn, o);
  }
  const valueText = v => !v ? '' : (VALUE_NAMES[v.key] ? VALUE_NAMES[v.key] + ' ' : '') + fmtVal(v.key, v.value);
  // Wochenprogramm (Wunsch Thomas): Schaltzeiten im Gerät selbst – laufen auch ohne CCU. Nur Administratoren (prüft der Server).
  const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], WD_ORDER = [1, 2, 3, 4, 5, 6, 0];
  async function loadWeek(d, box) {
    let found; try { found = (await api('getWochenprogramme', undefined, { query: { geraet: d.address } })).kanaele || []; } catch { return; }
    for (const k of found) {
      try { if (k.kind === 'heat') heatEditor(box, k); else weekEditor(box, await api('getWochenprogramm', undefined, { query: { kanal: k.kanal } })); }
      catch (e) { box.append(h('p', { class: 'muted', text: 'Wochenprogramm nicht lesbar: ' + e.message })); }
    }
  }
  // Heizprofil (Thermostate): je Tag Abschnitte „bis Uhrzeit → Temperatur“, letzter bis 24:00; Profilwahl P1…P6
  const WD_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  function heatEditor(box, k) {
    const wrap = h('div'), o = h('p', { class: 'msg', role: 'status' });
    box.append(h('h3', { text: 'Heizprofil (Wochenprogramm)' }), h('p', { class: 'muted', text: 'Je Tag: bis zu welcher Uhrzeit welche Temperatur gilt. Der letzte Abschnitt geht bis 24:00. Wird im Thermostat gespeichert und läuft auch ohne Zentrale.' }), wrap, o);
    let wp = null;
    const load = async profil => { wp = await api('getWochenprogramm', undefined, { query: { kanal: k.kanal, art: 'heat', iface: k.iface, ...(profil !== undefined ? { profil: String(profil) } : {}) } }); draw(); };
    function draw() {
      const days = wp.days;
      const prof = wp.profiles.length > 1 ? h('select', { 'aria-label': 'Profil' }, ...wp.profiles.map(p => h('option', { value: String(p), text: 'Profil ' + p }))) : null;
      if (prof) { prof.value = String(wp.profil); prof.addEventListener('change', () => task(null, o, async () => { await load(Number(prof.value)); return 'Profil ' + prof.value + ' geladen.'; }, 'Wird gelesen …')); }
      const dayBox = t => {
        const segs = days[t], rows = h('div', { class: 'heat-segs' });
        const redraw = () => rows.replaceChildren(...segs.map((s, i) => {
          const last = i === segs.length - 1;
          const bis = last ? h('span', { class: 'mono', text: '24:00' }) : h('input', { type: 'time', step: 300, value: s.bis, 'aria-label': 'bis Uhrzeit' });
          if (!last) bis.addEventListener('input', () => { s.bis = bis.value; });
          const temp = h('input', { type: 'number', min: 4.5, max: 30.5, step: 0.5, value: s.temp, style: 'max-width:80px', 'aria-label': 'Temperatur °C' }); temp.addEventListener('input', () => { s.temp = Number(temp.value); });
          const del = segs.length > 1 ? h('button', { class: 'btn small', type: 'button', text: '✕', title: 'Abschnitt entfernen' }) : null;
          if (del) del.addEventListener('click', () => { segs.splice(i, 1); segs[segs.length - 1].bis = '24:00'; redraw(); });
          return h('div', { class: 'row' }, h('span', { class: 'muted', text: 'bis' }), bis, temp, h('span', { class: 'muted', text: '°C' }), del);
        }));
        const add = h('button', { class: 'btn small', type: 'button', text: '＋ Abschnitt' });
        add.addEventListener('click', () => { if (segs.length >= wp.slots) return; const l = segs[segs.length - 1]; segs.splice(segs.length - 1, 0, { bis: '12:00', temp: l.temp }); redraw(); });
        const copy = h('button', { class: 'btn small', type: 'button', text: 'Auf alle Tage übernehmen' });
        copy.addEventListener('click', () => { for (let x = 0; x < 7; x++) if (x !== t) days[x] = segs.map(s => ({ ...s })); draw(); msg(o, WD_LONG[t] + ' auf alle Tage übernommen – noch nicht gespeichert.', 'ok'); });
        redraw();
        return h('details', { class: 'auto-item' }, h('summary', {}, h('b', { text: WD_LONG[t] }), h('span', { class: 'muted', text: ' · ' + segs.map(s => s.bis + ' ' + String(s.temp).replace('.', ',') + '°').join(' | ') })), h('div', { class: 'auto-body' }, rows, h('div', { class: 'actions' }, add, copy)));
      };
      const save = h('button', { class: 'btn small primary', type: 'button', text: 'Heizprofil speichern' });
      save.addEventListener('click', () => task(save, o, async () => {
        for (const t of Object.keys(days)) days[t].sort((a, b) => (a.bis === '24:00' ? 1 : b.bis === '24:00' ? -1 : a.bis.localeCompare(b.bis)));
        const r2 = await api('saveWochenprogramm', { kanal: wp.kanal, iface: wp.iface, profil: wp.profil, days });
        wp = r2; draw(); return r2.message;
      }, 'Wird ins Thermostat übertragen …'));
      wrap.replaceChildren(...(prof ? [h('div', { class: 'row' }, h('span', { class: 'muted', text: 'Profil:' }), prof)] : []), h('div', { class: 'auto-list' }, ...WD_ORDER.map(dayBox)), h('div', { class: 'actions' }, save));
    }
    load().catch(e => msg(o, 'Heizprofil nicht lesbar: ' + e.message, 'bad'));
  }
  function weekEditor(box, wp) {
    let entries = wp.entries.map(e => ({ days: e.days, mode: e.mode, time: e.time, offset: e.offset, level: e.level }));
    const rows = h('div'), o = h('p', { class: 'msg', role: 'status' }), add = h('button', { class: 'btn small', type: 'button', text: '＋ Schaltzeit' }), save = h('button', { class: 'btn small primary', type: 'button', text: 'Wochenprogramm speichern' });
    const draw = () => rows.replaceChildren(...(entries.length ? entries.map((e, i) => {
      const days = WD_ORDER.map(dn => { const c = h('input', { type: 'checkbox', checked: e.days.includes(dn), 'aria-label': WD[dn] }); c.addEventListener('change', () => { e.days = c.checked ? [...new Set([...e.days, dn])] : e.days.filter(x => x !== dn); }); return h('label', { class: 'check' }, c, h('span', { text: WD[dn] })); });
      const mode = h('select', { 'aria-label': 'Zeitpunkt' }, h('option', { value: 'time', text: 'Uhrzeit' }), h('option', { value: 'sunrise', text: 'Sonnenaufgang' }), h('option', { value: 'sunset', text: 'Sonnenuntergang' })); mode.value = e.mode;
      const time = h('input', { type: 'time', value: e.time, 'aria-label': 'Uhrzeit' }), off = h('input', { type: 'number', min: -120, max: 120, step: 1, value: e.offset || 0, style: 'max-width:90px', 'aria-label': 'Verschiebung in Minuten' });
      const lvl = wp.kind === 'switch' ? h('select', { 'aria-label': 'Schalten' }, h('option', { value: '100', text: 'Ein' }), h('option', { value: '0', text: 'Aus' })) : h('input', { type: 'number', min: 0, max: 100, step: 5, value: e.level, style: 'max-width:90px', 'aria-label': 'Helligkeit %' });
      lvl.value = String(e.level);
      const unit = h('span', { class: 'muted', text: 'Min.' });
      const sync = () => { time.hidden = mode.value !== 'time'; off.hidden = unit.hidden = mode.value === 'time'; };
      mode.addEventListener('change', () => { e.mode = mode.value; sync(); }); time.addEventListener('input', () => { e.time = time.value; }); off.addEventListener('input', () => { e.offset = Number(off.value) || 0; });
      lvl.addEventListener('change', () => { e.level = Number(lvl.value); }); lvl.addEventListener('input', () => { e.level = Number(lvl.value); });
      sync();
      const del = h('button', { class: 'btn small', type: 'button', text: '✕', title: 'Schaltzeit entfernen' }); del.addEventListener('click', () => { entries.splice(i, 1); draw(); });
      return h('div', { class: 'card' }, h('div', { class: 'checks' }, ...days), h('div', { class: 'row' }, mode, time, off, unit, lvl, wp.kind === 'dimmer' ? h('span', { class: 'muted', text: '%' }) : null, del));
    }) : [h('p', { class: 'muted', text: 'Noch keine Schaltzeiten.' })]));
    add.addEventListener('click', () => { if (entries.length >= wp.capacity) return; entries.push({ days: [1, 2, 3, 4, 5], mode: 'time', time: '07:00', offset: 0, level: 100 }); draw(); });
    save.addEventListener('click', () => task(save, o, async () => {
      const r2 = await api('saveWochenprogramm', { kanal: wp.kanal, entries: entries.map(e => ({ days: e.days, mode: e.mode, time: e.time || '00:00', offset: e.offset || 0, level: wp.kind === 'switch' ? (e.level >= 50 ? 100 : 0) : Math.max(0, Math.min(100, Math.round(e.level))) })) });
      entries = r2.entries.map(e => ({ days: e.days, mode: e.mode, time: e.time, offset: e.offset, level: e.level })); draw(); return r2.message;
    }, 'Wird ins Gerät übertragen …'));
    draw();
    box.append(h('h3', { text: 'Wochenprogramm (' + (wp.kind === 'switch' ? 'Schalten' : 'Dimmen') + ')' }), h('p', { class: 'muted', text: 'Wird im Gerät gespeichert und läuft auch ohne Zentrale. Höchstens ' + wp.capacity + ' Schaltzeiten. Bei Sonnenzeiten: Verschiebung in Minuten (minus = früher).' }), rows, h('div', { class: 'actions' }, add, save), o);
  }
  // Geräteeinstellungen (ersetzt die Gerätekonfiguration der alten CCU): auf Klick laden, nur geänderte Werte senden.
  function settingsArea(d) {
    if (d.central || !['HmIP-RF', 'BidCos-RF'].includes(d.interface)) return null;
    const box = h('div'), load = h('button', { class: 'btn small', type: 'button', text: 'Einstellungen laden' }), o = h('p', { class: 'msg', role: 'status' });
    load.addEventListener('click', () => task(load, o, async () => {
      const r = await api('getGeraeteParameter', undefined, { query: { adresse: d.address } }); load.hidden = true;
      box.replaceChildren(...(r.kanaele.length ? r.kanaele.map(k => paramPanel(k)) : [h('p', { class: 'muted', text: 'Dieses Gerät hat keine einstellbaren Werte.' })]));
      return '';
    }, 'Wird gelesen …'));
    return h('div', { class: 'gv-settings' }, h('h3', { text: 'Geräteeinstellungen' }), h('p', { class: 'muted', text: 'Einstellungen im Gerät selbst. Nur geänderte Werte werden gesendet; Batteriegeräte übernehmen sie beim nächsten Aufwachen (Taste drücken).' }), load, box, o);
  }
  function paramPanel(k) {
    const inputs = new Map(), o = h('p', { class: 'msg', role: 'status' }), save = h('button', { class: 'btn small primary', type: 'button', text: 'Speichern' });
    const row = p => {
      let el;
      if (p.type === 'BOOL') { el = h('input', { type: 'checkbox', checked: !!p.value }); }
      else if (p.type === 'ENUM' && p.list) { el = h('select', {}, ...p.list.map((x, i) => h('option', { value: String(i), text: x || String(i) }))); el.value = String(p.value); }
      else if (p.type === 'STRING') { el = h('input', { type: 'text', value: p.value ?? '', maxlength: 64 }); }
      else { el = h('input', { type: 'number', value: p.value, min: p.min, max: p.max, step: p.type === 'FLOAT' ? 'any' : 1, style: 'max-width:110px' }); }
      inputs.set(p.key, { el, p });
      const range = p.type === 'FLOAT' || p.type === 'INTEGER' ? ' (' + p.min + ' … ' + p.max + (p.unit ? ' ' + p.unit : '') + ')' : '';
      return h('tr', {}, h('td', {}, h('b', { text: p.name || p.key }), p.name ? h('div', { class: 'sub mono', text: p.key }) : null), h('td', {}, el), h('td', { class: 'muted', text: range }));
    };
    const known = k.params.filter(p => p.name), rest = k.params.filter(p => !p.name);
    save.addEventListener('click', () => task(save, o, async () => {
      const values = {};
      for (const [key, { el, p }] of inputs) {
        const v = p.type === 'BOOL' ? el.checked : p.type === 'ENUM' ? Number(el.value) : p.type === 'STRING' ? el.value : Number(el.value);
        if (p.type === 'STRING' ? v !== (p.value ?? '') : p.type === 'BOOL' ? v !== !!p.value : Math.abs(v - Number(p.value)) > 1e-9) values[key] = v;
      }
      if (!Object.keys(values).length) return 'Keine Änderung.';
      if (!await NEU.confirmDialog({ title: 'Einstellungen ins Gerät übertragen?', text: Object.keys(values).length + ' Wert(e) werden an ' + k.address + ' gesendet.', confirm: 'Übertragen' })) return 'Nicht übertragen.';
      const r = await api('saveGeraeteParameter', { address: k.address, values });
      for (const [key, x] of inputs) if (Object.hasOwn(values, key)) x.p.value = values[key];
      return r.message;
    }, 'Wird übertragen …'));
    const table = list => h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, ...list.map(row))));
    return h('div', { class: 'card' }, h('b', { text: k.address.includes(':') ? 'Kanal ' + k.address.split(':')[1] : 'Gerät' }),
      known.length ? table(known) : null,
      rest.length ? h('details', {}, h('summary', { text: 'Weitere Einstellungen (Expertenliste, ' + rest.length + ')' }), table(rest)) : null,
      h('div', { class: 'actions' }, save), o);
  }
  let deletable = null;
  api('getCcuDeviceList').then(r => { deletable = new Map((r.devices || []).filter(g => g.deletable).map(g => [g.address, g])); render(); }).catch(() => { deletable = new Map(); });
  function deleteArea(d) {
    const g = deletable && deletable.get(d.address); if (!g) return null;
    const btn = h('button', { class: 'btn small danger', type: 'button', text: 'Gerät löschen …' }), out2 = h('p', { class: 'msg', role: 'status' });
    const remove = async force => {
      const ok = await NEU.confirmDialog({ title: force ? 'Ohne Reset entfernen?' : 'Gerät löschen?', danger: true, slider: true, confirm: force ? 'Ohne Reset entfernen' : 'Löschen',
        text: d.name + ' (' + d.address + ') ' + (force ? 'wird nur aus der CCU entfernt. Das Gerät selbst behält seine Anlernung und muss später von Hand zurückgesetzt werden.' : 'wird auf Werkseinstellung zurückgesetzt und aus der CCU entfernt. Danach muss es neu angelernt werden. Batteriegeräte vorher kurz wecken (Taste drücken).') });
      if (!ok) return;
      btn.disabled = true; msg(out2, 'Gerät wird gelöscht … (bis zu 30 Sekunden)', 'busy');
      try { const r = await api('deleteCcuDevice', { address: d.address, force }); msg(out2, r.message || 'Gerät gelöscht.', 'ok'); setTimeout(() => load(true), 1500); }
      catch (e) { msg(out2, e.message, 'bad'); btn.disabled = false; if (!force && (e.status === 502 || /Werkseinstellung/.test(e.message))) { btn.textContent = 'Ohne Reset entfernen …'; btn.onclick = () => remove(true); } }
    };
    btn.addEventListener('click', () => remove(false));
    return h('div', { class: 'gv-delete' }, h('h3', { text: 'Gerät löschen' }), h('p', { class: 'muted', text: 'Setzt das Gerät auf Werkseinstellung zurück und entfernt es aus der CCU.' }), btn, out2);
  }
  // Live-Ansicht: Werte der Kanäle jede Sekunde (nur solange aufgeklappt und sichtbar); Tasten als Bild, die zuletzt
  // gedrückte leuchtet 2 Sekunden auf. Es wird nichts gefunkt – die Bridge hört nur mit.
  const lives = new Map();
  const VALUE_NAMES = { STATE: 'Zustand', LEVEL: 'Helligkeit', MOTION: 'Bewegung', ILLUMINATION: 'Helligkeit (Lux)', CURRENT_ILLUMINATION: 'Helligkeit (Lux)', ACTUAL_TEMPERATURE: 'Temperatur', HUMIDITY: 'Feuchte', LOW_BAT: 'Batterie schwach', UNREACH: 'nicht erreichbar', OPERATING_VOLTAGE: 'Spannung', RSSI_DEVICE: 'Empfang Gerät', RSSI_PEER: 'Empfang Zentrale', CONFIG_PENDING: 'Konfiguration offen', SET_POINT_TEMPERATURE: 'Soll-Temperatur', POWER: 'Leistung', ENERGY_COUNTER: 'Zähler', WINDOW_STATE: 'Fenster', LOW_BAT: 'Batterie schwach', LOWBAT: 'Batterie schwach', SABOTAGE: 'Sabotage', ERROR_CODE: 'Fehlercode', ERROR_OVERHEAT: 'Übertemperatur', ERROR_OVERLOAD: 'Überlast', ACTUAL_TEMPERATURE_STATUS: 'Temperatur (Status)', OPERATING_VOLTAGE_STATUS: 'Spannung (Status)', DUTY_CYCLE: 'Sendelimit', UPDATE_PENDING: 'Update wartet', INSTALL_TEST: 'Anlerntest', PROCESS: 'Vorgang', SECTION: 'Bereich', SECTION_STATUS: 'Bereich (Status)', WORKING: 'Arbeitet', LEVEL_STATUS: 'Helligkeit (Status)', CURRENT: 'Strom', VOLTAGE: 'Spannung', FREQUENCY: 'Frequenz', ENERGY_COUNTER_OVERFLOW: 'Zählerüberlauf', VALVE_STATE: 'Ventil (Status)', LEVEL_2: 'Lamellen', BOOST_MODE: 'Boost', SET_POINT_MODE: 'Betriebsart', PARTY_MODE: 'Party-Modus', WINDOW_OPEN: 'Fenster offen', ILLUMINATION_STATUS: 'Helligkeit (Status)', MOTION_DETECTION_ACTIVE: 'Bewegungserkennung aktiv', RESET_MOTION: 'Bewegung zurücksetzen', PRESENCE_DETECTION_STATE: 'Anwesenheit', CONFIG_PENDING: 'Konfiguration offen', DEVICE_IN_BOOTLOADER: 'Startmodus', RSSI_DEVICE: 'Empfang Gerät', TIME_OF_OPERATION: 'Betriebszeit', HUMIDITY_STATUS: 'Feuchte (Status)' };
  const fmtVal = (k, v) => typeof v === 'boolean' ? (v ? 'ja' : 'nein') : typeof v === 'number' ? (k === 'LEVEL' ? Math.round(v * 100) + ' %' : String(Math.round(v * 100) / 100).replace('.', ',')) : String(v);
  function renderLive(box, data) {
    const now = Date.parse(data.now), keys = data.channels.filter(c => c.key);
    const rocker = keys.length ? h('div', { class: 'gv-rocker', 'aria-label': 'Tasten' }, ...keys.map(c => {
      const ev = ['PRESS_LONG', 'PRESS_SHORT', 'PRESS_LONG_START'].map(k => c.events[k] && { k, at: Date.parse(c.events[k].at) }).filter(Boolean).sort((a, b) => b.at - a.at)[0];
      const hot = ev && now - ev.at < 2000;
      return h('div', { class: 'gv-key' + (hot ? ' hot' : '') }, h('b', { text: 'Taste ' + c.address.split(':')[1] }), h('span', { text: hot ? (ev.k === 'PRESS_SHORT' ? 'kurz gedrückt' : 'lang gedrückt') : ev ? 'zuletzt ' + new Date(ev.at).toLocaleTimeString('de-DE') : 'noch nicht gedrückt' }));
    })) : null;
    const rows = data.channels.flatMap(c => Object.entries(c.values).filter(([k]) => !/^PRESS_|^INSTALL_TEST|^ERROR_|^DUTY_CYCLE$|^UPDATE_PENDING$|^CONFIG_PENDING$/.test(k) || k === 'CONFIG_PENDING').map(([k, v]) =>
      h('tr', {}, h('td', { class: 'mono', text: c.address }), h('td', { text: VALUE_NAMES[k] || chType(k), title: k }), h('td', { text: fmtVal(k, v) }), h('td', { class: 'muted', text: c.events[k] ? new Date(c.events[k].at).toLocaleTimeString('de-DE') : '' }))));
    box.replaceChildren(rocker || h('p', { class: 'muted', text: 'Dieses Gerät hat keine Tasten.' }),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ...['Kanal', 'Wert', 'Aktuell', 'Geändert'].map(t => h('th', { text: t })))), h('tbody', {}, ...rows))),
      h('p', { class: 'muted', text: 'Aktualisiert ' + new Date(now).toLocaleTimeString('de-DE') + ' · Werte kommen von den Geräten, es wird nichts gesendet.' }));
  }
  function startLive(address, box) {
    stopLive(box); box.replaceChildren(h('p', { class: 'muted', text: 'Live-Werte werden gelesen …' }));
    const run = async () => { if (document.hidden) return; try { renderLive(box, await api('getGeraetLive', undefined, { query: { geraet: address } })); } catch (e) { box.replaceChildren(h('p', { class: 'muted', text: 'Live-Werte nicht verfügbar: ' + e.message })); } };
    run(); lives.set(box, setInterval(run, 1000));
  }
  function stopLive(box) { clearInterval(lives.get(box)); lives.delete(box); }
  // Grüner Punkt: Gerät wurde in den letzten 30 Sekunden betätigt (Taste, Schalten, Dimmen). Abfrage alle 3 s, nur bei sichtbarer Seite.
  const activity = {};
  async function pollActivity() {
    if (document.hidden) return;
    try {
      const r = await api('getGeraeteAktivitaet'), offset = Date.now() - Date.parse(r.now);
      for (const [dev, at] of Object.entries(r.active || {})) activity[dev] = Date.parse(at) + offset;
      for (const dot of list.querySelectorAll('.gv-dot')) dot.hidden = !(activity[dot.dataset.dev] > Date.now() - 30000);
    } catch {}
  }
  setInterval(pollActivity, 3000);
  function fill(sel, values, all) { const v = sel.value; sel.replaceChildren(h('option', { value: '', text: all }), ...values.map(x => h('option', { value: x, text: x }))); sel.value = values.includes(v) ? v : ''; }
  function showStats() {
    const ds = data.devices, p = ds.filter(problem).length, u = ds.filter(d => d.firmwareUpdate).length;
    stats.replaceChildren(NEU.stat('Geräte', String(ds.length), ds.reduce((n, d) => n + d.channels.length, 0) + ' Kanäle'),
      NEU.stat('Mit Hinweis', String(p), p ? 'Batterie, Erreichbarkeit, Konfiguration' : 'alles in Ordnung', p ? 'warn' : 'ok'),
      NEU.stat('Firmware-Updates', String(u), u ? 'verfügbar' : 'alles aktuell', u ? 'warn' : 'ok'));
    fill(room, [...new Set(ds.flatMap(d => d.rooms))].sort((a, b) => a.localeCompare(b, 'de')), 'Alle Räume');
    fill(iface, [...new Set(ds.map(d => d.interface))].sort(), 'Alle Schnittstellen');
  }
  async function load(fresh) {
    if (!data) list.replaceChildren(h('div', { class: 'empty', text: 'Geräte werden gelesen …' }));
    try { const w = loadWerte(); data = await api('getGeraeteVerwaltung', undefined, fresh ? { query: { neu: '1' } } : {}); await w; showStats(); render(); renderExtras(); msg(out, 'Stand: ' + new Date(data.readAt).toLocaleTimeString('de-DE'), 'ok'); }
    catch (e) { list.replaceChildren(h('div', { class: 'notice bad', text: 'Geräteliste nicht lesbar: ' + e.message })); }
  }
  for (const el of [search, room, iface, only]) el.addEventListener(el === search ? 'input' : 'change', render);
  reload.addEventListener('click', () => load(true));
  load(false);
});
