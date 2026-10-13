'use strict';
// Seite „Saugroboter“ (Ecovacs Deebot, ecovacs.js): bedienen, Räume, Einstellungen, Apple Home, Konto.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, qrSvg } = NEU;
  const main = shell({ title: 'Saugroboter', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'Ecovacs-Saugroboter über die Ecovacs-Cloud – bedienen, Räume reinigen, Station, Einstellungen und Apple Home.' });
  const out = h('p', { class: 'msg', role: 'status' });
  const statusBox = h('div'), controls = h('div', { class: 'row' }), station = h('div', { class: 'row' });
  const roomsBox = h('div', { class: 'checks' }), roomCount = h('select', { 'aria-label': 'Durchgänge' }, [h('option', { value: '1', text: '1 Durchgang' }), h('option', { value: '2', text: '2 Durchgänge' })]);
  const roomBtn = h('button', { class: 'btn primary', type: 'button', text: 'Ausgewählte Räume reinigen' }), roomNames = h('div', { class: 'form' });
  const settingsBox = h('div', { class: 'form' }), lifeBox = h('div'), statsBox = h('div', { class: 'muted' });
  const matterBox = h('div'), accountBox = h('div'), logBox = h('ul', { class: 'muted' });
  const pStatus = panel('Zustand und Bedienung', null, statusBox, controls, h('h3', { text: 'Station' }), station, out);
  const pRooms = panel('Räume', 'Räume auswählen und reinigen. In Apple Home erscheinen dieselben Räume zur Auswahl.', roomsBox, h('div', { class: 'row' }, roomCount, roomBtn), h('details', { class: 'more' }, h('summary', { text: 'Räume umbenennen (nur Administrator)' }), roomNames));
  const pSettings = panel('Einstellungen', 'Wird direkt an den Roboter geschickt und zurückgelesen.', settingsBox);
  const pLife = panel('Verschleißteile und Statistik', null, lifeBox, statsBox);
  const pMatter = panel('In Apple Home', 'Der Saugroboter ist ein eigenes Matter-Gerät mit eigenem Kopplungscode (die Bridge bleibt unverändert).', matterBox);
  const pAccount = panel('Ecovacs-Konto', 'E-Mail und Passwort der Ecovacs-Home-App. Gespeichert wird nur eine Prüfsumme des Passworts – verschlüsselt auf der CCU.', accountBox);
  const pLog = panel('Protokoll', 'Letzte Befehle und Meldungen.', logBox);
  const pCam = panel('Kamera', null, h('p', { class: 'muted', text: 'Das Kamerabild des Roboters läuft über einen eigenen Ecovacs-Weg und wird getrennt geprüft. Apple Home zeigt Kameras über Matter derzeit nicht an.' }));
  main.append(pStatus, pRooms, pSettings, pLife, pMatter, pAccount, pLog, pCam);

  let data = null, busy = 0, loading = false;
  const op = async (button, method, payload, target = out) => {
    if (button && button.disabled) return null; if (button) button.disabled = true; busy++;
    try { const r = await api(method, payload); msg(target, r.message || 'Erledigt.', 'ok'); return r; }
    catch (e) { msg(target, e.message, 'bad'); return null; } finally { if (button) button.disabled = false; busy--; }
  };
  const btn = (text, action, primary, extra) => { const b = h('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', text }); b.addEventListener('click', async () => { if (await op(b, 'controlEcovacs', { action, ...(extra || {}) })) setTimeout(() => load(true), 3500); }); return b; };
  const pct = v => Number.isFinite(v) ? v + ' %' : '–';
  const when = t => t ? new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';

  function renderStatus(d) {
    const s = d.state || {}, r = d.robot;
    statusBox.replaceChildren(...[
      h('div', { class: 'card-head' }, h('b', { text: r ? r.name + ' · ' + r.model : 'Saugroboter' }), h('span', { class: 'tag ' + (d.connected ? 'ok' : 'bad'), text: d.connected ? 'verbunden' : 'nicht verbunden' })),
      d.connected ? h('p', {}, h('b', { text: s.label || 'unbekannt' }), ' · Akku ' + pct(s.battery) + (s.charging ? ' (lädt)' : ''), h('span', { class: 'muted', text: ' · Stand ' + when(d.updatedAt) })) : h('p', { class: 'muted', text: d.error || 'Unten im Bereich „Ecovacs-Konto“ anmelden.' }),
      ...(s.errors || []).map(e => h('div', { class: 'notice bad', text: '⚠ ' + e.text })),
      d.connected && d.error ? h('div', { class: 'notice bad', text: d.error }) : null].filter(Boolean));
    const on = d.connected;
    controls.replaceChildren(...(on ? [
      s.state === 'paused' ? btn('Weiter', 'resume', true) : btn('Reinigung starten', 'start', true),
      ['cleaning', 'returning'].includes(s.state) ? btn('Pause', 'pause') : null,
      ['cleaning', 'paused', 'returning'].includes(s.state) ? btn('Stopp', 'stop') : null,
      !['docked'].includes(s.state) ? btn('Zur Station', 'home') : null,
      btn('Roboter finden (Ton)', 'find')] : []).filter(Boolean));
    station.replaceChildren(...(on ? [
      btn('Absaugen', 'empty'),
      s.station === 'washing' ? btn('Waschen beenden', 'washStop') : btn('Mopp waschen', 'wash'),
      s.station === 'drying' ? btn('Trocknen beenden', 'dryStop') : btn('Mopp trocknen', 'dry')] : [h('span', { class: 'muted', text: '–' })]));
  }
  function renderRooms(d) {
    const keep = new Set([...roomsBox.querySelectorAll('input:checked')].map(i => Number(i.value)));
    roomsBox.replaceChildren(...(d.rooms.length ? d.rooms.map(r => check(r.name, h('input', { type: 'checkbox', value: String(r.id), checked: keep.has(r.id) }))) : [h('span', { class: 'muted', text: d.connected ? 'Räume werden gelesen …' : '–' })]));
    roomBtn.disabled = !d.connected || !d.rooms.length;
    if (!roomNames.contains(document.activeElement)) roomNames.replaceChildren(...d.rooms.map(r => {
      const inp = h('input', { value: r.name, maxlength: 32, 'aria-label': 'Name für Raum ' + r.id, disabled: !d.admin }), save = h('button', { class: 'btn small', type: 'button', text: 'Speichern', disabled: !d.admin });
      save.addEventListener('click', async () => { if (await op(save, 'ecovacsRoomName', { id: r.id, name: inp.value.trim() })) load(true); });
      return h('div', { class: 'row' }, field('Raum ' + r.id + ' (Ecovacs: ' + r.ecovacsName + ')', inp), save);
    }));
  }
  function renderSettings(d) {
    if (settingsBox.contains(document.activeElement)) return;
    const st = d.settings || {}, admin = d.admin && d.connected;
    const sel = (label, key, options, hint) => { if (st[key] === undefined) return null; const s = h('select', { disabled: !admin }, options.map(([v, t]) => h('option', { value: String(v), text: t, selected: st[key] === v }))); s.addEventListener('change', () => op(s, 'ecovacsSetting', { key, value: Number(s.value) }).then(() => load(true))); return field(label, s, hint); };
    const tog = (label, key) => { if (st[key] === undefined) return null; const i = h('input', { type: 'checkbox', checked: st[key] === 1, disabled: !admin }); i.addEventListener('change', () => op(i, 'ecovacsSetting', { key, value: i.checked ? 1 : 0 }).then(() => load(true))); return check(label, i); };
    settingsBox.replaceChildren(...[
      sel('Saugstärke', 'speed', d.speeds.map(x => [x.value, x.label])),
      sel('Wassermenge (Wischen)', 'water', d.waters.map(x => [x.value, x.label])),
      sel('Durchgänge', 'cleanCount', [[1, '1'], [2, '2']]),
      sel('Mopp waschen alle', 'washInterval', [[10, '10 Minuten'], [15, '15 Minuten'], [25, '25 Minuten']]),
      sel('Trocknungsdauer', 'dryingDuration', [[120, '2 Stunden'], [180, '3 Stunden'], [240, '4 Stunden']]),
      sel('Lautstärke', 'volume', Array.from({ length: 11 }, (_, i) => [i, String(i)])),
      h('div', { class: 'checks wide' }, tog('Automatisch absaugen', 'autoEmpty'), tog('Hinderniserkennung (Kamera)', 'trueDetect'), tog('Teppich-Turbo', 'carpetBoost'), tog('Kindersicherung', 'childLock')),
      d.block ? h('p', { class: 'muted wide', text: 'Ruhezeit (Nicht stören): ' + (d.block.enable ? d.block.start + ' bis ' + d.block.end + ' Uhr' : 'aus') + ' – ändern in der Ecovacs-App.' }) : null,
      !d.admin ? h('p', { class: 'muted wide', text: 'Einstellungen ändern nur Administratoren.' }) : null].filter(Boolean));
  }
  function renderLife(d) {
    lifeBox.replaceChildren(...(d.life.length ? d.life.map(l => h('div', { class: 'row' }, h('span', { text: l.name + ': ' }), h('b', { text: pct(l.percent) }), l.percent !== null && l.percent < 10 ? h('span', { class: 'tag bad', text: 'bald wechseln' }) : null)) : [h('span', { class: 'muted', text: 'Keine Angaben vom Roboter.' })]));
    statsBox.textContent = [d.stats ? 'Letzte Reinigung: ' + d.stats.area + ' m² in ' + d.stats.minutes + ' Min (' + when(d.stats.start) + ')' : '', d.total ? 'Gesamt: ' + d.total.count + ' Reinigungen, ' + d.total.area + ' m², ' + d.total.hours + ' Stunden' : ''].filter(Boolean).join(' · ');
  }
  function renderMatter(d) {
    const m = d.matter || {}, toggle = h('input', { type: 'checkbox', checked: m.enabled, disabled: !d.admin || (!d.connected && !m.enabled) });
    toggle.addEventListener('change', async () => { if (await op(toggle, 'ecovacsMatter', { enabled: toggle.checked })) load(true); else toggle.checked = !toggle.checked; });
    const parts = [check('Saugroboter in Apple Home anbieten', toggle)];
    if (m.enabled) {
      parts.push(h('p', {}, h('span', { class: 'tag ' + (m.running ? 'ok' : 'bad'), text: m.running ? 'läuft (Port ' + m.port + ')' : m.starting ? 'startet …' : 'läuft nicht' }), m.commissioned ? h('span', { class: 'tag ok', text: ' in Apple Home gekoppelt' }) : null, m.error ? h('span', { class: 'muted', text: ' ' + m.error }) : null));
      if (m.firewallBlocked) parts.push(h('div', { class: 'notice bad' }, '🟠 Die CCU-Firewall ist eingeschränkt und Port ' + m.port + ' ist nicht freigegeben – Apple Home erreicht den Saugroboter so nicht. ', h('a', { href: '/firewall.html', text: 'Firewall öffnen und Port ' + m.port + ' hinzufügen' })));
      if (m.qrPairingCode) parts.push(h('div', { class: 'row' }, qrSvg(m.qrPairingCode, 'Matter-QR-Code Saugroboter'), h('div', {}, h('p', { text: 'Apple Home → + → Gerät hinzufügen → diesen Code scannen.' }), h('p', {}, 'Code zum Eintippen: ', h('b', { text: m.manualPairingCode || '' })))));
    }
    matterBox.replaceChildren(...parts);
  }
  function renderAccount(d) {
    if (accountBox.contains(document.activeElement)) return;
    if (!d.admin) { accountBox.replaceChildren(h('p', { class: 'muted', text: d.connected ? 'Verbunden.' : 'Nur ein Administrator kann das Konto verbinden.' })); return; }
    const res = h('p', { class: 'msg', role: 'status' });
    if (d.connected) { const lo = h('button', { class: 'btn', type: 'button', text: 'Abmelden' }); lo.addEventListener('click', async () => { if (await op(lo, 'ecovacsLogout', {}, res)) load(true); }); const rf = h('button', { class: 'btn', type: 'button', text: 'Alles neu lesen' }); rf.addEventListener('click', async () => { if (await op(rf, 'ecovacsRefresh', {}, res)) load(true); }); accountBox.replaceChildren(h('p', { text: 'Angemeldet als ' + (d.account || '') }), h('div', { class: 'row' }, rf, lo), res); return; }
    if (d.needCode) {
      const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 10 }), b = h('button', { class: 'btn primary', type: 'submit', text: 'Code bestätigen' });
      const f = h('form', { class: 'form' }, field('Code aus der Ecovacs-E-Mail', code), h('div', { class: 'wide actions' }, b), res);
      f.addEventListener('submit', async e => { e.preventDefault(); if (await op(b, 'ecovacsCode', { code: code.value.trim() }, res)) { document.activeElement?.blur(); load(true); }; });
      accountBox.replaceChildren(h('div', { class: 'notice', text: '🟠 Ecovacs hat dir einen Code per E-Mail geschickt (neues Gerät). Bitte hier eintragen.' }), f); return;
    }
    const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxlength: 254 }), pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 }), b = h('button', { class: 'btn primary', type: 'submit', text: 'Verbinden' });
    const f = h('form', { class: 'form' }, field('E-Mail (Ecovacs-Konto)', email), field('Passwort', pw, 'Tippst du selbst; nur eine Prüfsumme wird verschlüsselt gespeichert.'), h('div', { class: 'wide actions' }, b), res);
    f.addEventListener('submit', async e => { e.preventDefault(); const r = await op(b, 'ecovacsLogin', { account: email.value.trim(), password: pw.value }, res); pw.value = ''; if (r) { document.activeElement?.blur(); load(true); }; });
    accountBox.replaceChildren(f);
  }
  roomBtn.addEventListener('click', async () => {
    const ids = [...roomsBox.querySelectorAll('input:checked')].map(i => Number(i.value));
    if (!ids.length) { msg(out, 'Mindestens einen Raum auswählen.', 'bad'); return; }
    if (await op(roomBtn, 'controlEcovacs', { action: 'rooms', rooms: ids, count: Number(roomCount.value) })) setTimeout(() => load(true), 3500);
  });
  async function load(force) {
    if (loading || (!force && busy)) return; loading = true;
    try {
      data = await api('getEcovacs');
      renderStatus(data); renderRooms(data); renderSettings(data); renderLife(data); renderMatter(data); renderAccount(data);
      logBox.replaceChildren(...(data.log || []).map(l => h('li', { text: when(l.at) + ' – ' + l.text })));
      pRooms.hidden = pSettings.hidden = pLife.hidden = !data.connected;
    } catch (e) { msg(out, e.message, 'bad'); } finally { loading = false; }
  }
  load(true); const timer = setInterval(() => { if (!document.hidden) load(); }, 10000); window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
});
