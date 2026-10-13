'use strict';
// Seite „Dyson“: Geräte aus MyDyson übernehmen und als Matter-Lüfter steuern.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task } = NEU;
  const main = shell({ title: 'Dyson', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'WLAN-Ventilatoren und Luftreiniger von Dyson in Apple Home – Steuerung lokal im Heimnetz.' });
  const out = h('p', { class: 'msg', role: 'status' });
  // Konto-Anmeldung in zwei Schritten
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, maxlength: 254 });
  const country = h('select', {}, [['DE', 'Deutschland'], ['AT', 'Österreich'], ['CH', 'Schweiz'], ['GB', 'Großbritannien'], ['US', 'USA'], ['FR', 'Frankreich'], ['IT', 'Italien'], ['ES', 'Spanien'], ['AU', 'Australien']].map(([v, t]) => h('option', { value: v, text: t })));
  const start = h('button', { class: 'btn primary', type: 'submit', text: 'Bestätigungscode anfordern' });
  const login = h('form', { class: 'form' }, field('MyDyson-E-Mail', email), field('Land des Kontos', country), h('div', { class: 'wide actions' }, start));
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 256 });
  const code = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', required: true, pattern: '[0-9]{4,12}', maxlength: 12 });
  const finishBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Anmelden und Geräte übernehmen' });
  const verify = h('form', { class: 'form', hidden: true }, field('Dyson-Passwort', password, 'Wird nicht gespeichert.'), field('Code aus der Dyson-E-Mail', code), h('div', { class: 'wide actions' }, finishBtn));
  const accountOut = h('p', { class: 'msg', role: 'status' });
  // WLAN-Aufkleber
  const wName = h('input', { required: true, maxlength: 64 }), ssid = h('input', { required: true, placeholder: 'DYSON-ABC-DE-12345678-475', autocomplete: 'off' }), wPass = h('input', { type: 'password', required: true, maxlength: 128, autocomplete: 'off' });
  const wBtn = h('button', { class: 'btn', type: 'submit', text: 'Dyson-Gerät übernehmen' });
  const wifi = h('form', { class: 'form' }, field('Gerätename', wName), field('Dyson-WLAN-Name', ssid), field('Passwort vom Dyson-Aufkleber', wPass, 'Das Geräte-WLAN-Passwort vom Aufkleber, nicht das deines Routers.'), h('div', { class: 'wide actions' }, wBtn));
  const list = h('div', { class: 'cards' }), refresh = h('button', { class: 'btn', type: 'button', text: 'Aktualisieren' });
  main.append(
    panel('1. Geräte aus deinem MyDyson-Konto übernehmen', 'Pure Cool Link, Pure Cool, Hot+Cool, Humidity+Cool und Big+Quiet mit WLAN. Das Gerät muss in MyDyson eingerichtet sein.', login, verify, accountOut,
      h('details', { class: 'more' }, h('summary', { text: 'Alternative für ältere Geräte: WLAN-Aufkleber' }), wifi),
      h('p', { class: 'muted', text: 'Benötigt eine CCU-Administrator-Anmeldung. Das Kontopasswort wird nicht gespeichert; lokale Geräteschlüssel werden verschlüsselt aufbewahrt.' })),
    panel('2. Geräte und Steuerung', 'Angezeigt werden bestätigte Rückmeldungen der Geräte. Ein übergebener Auftrag ist noch keine Bestätigung.', h('div', { class: 'actions' }, refresh), out, list));

  let busy = 0, loading = false;
  const op = async (button, method, data, target = out) => {
    if (button.disabled) return null; button.disabled = true; busy++;
    try { const r = await api(method, data); msg(target, r.message || 'Gespeichert.', 'ok'); return r; }
    catch (e) { msg(target, e.message, 'bad'); return null; } finally { button.disabled = false; busy--; }
  };
  login.addEventListener('submit', async e => { e.preventDefault(); if (await op(start, 'startDysonLogin', { email: email.value.trim(), country: country.value }, accountOut)) { verify.hidden = false; password.focus(); } });
  verify.addEventListener('submit', async e => { e.preventDefault(); const r = await op(finishBtn, 'finishDysonLogin', { password: password.value, code: code.value.trim() }, accountOut); password.value = ''; if (r) { code.value = ''; verify.hidden = true; load(); } });
  wifi.addEventListener('submit', async e => { e.preventDefault(); const r = await op(wBtn, 'addDysonWifi', { ssid: ssid.value.trim(), password: wPass.value, name: wName.value.trim() }, accountOut); wPass.value = ''; if (r) load(); });

  function card(d) {
    const name = h('input', { value: d.name, maxlength: 64, required: true, 'aria-label': 'Name für ' + d.name });
    const exposed = h('input', { type: 'checkbox', checked: d.exposed }), online = h('input', { type: 'checkbox', checked: d.onlineCheck });
    const save = h('button', { class: 'btn small primary', type: 'submit', text: 'Speichern' });
    const form = h('form', {}, field('Name', name), h('div', { class: 'checks' }, check('In Apple Home (Matter)', exposed), check('Onlineprüfung / WhatsApp', online)), save);
    const dirty = () => name.value !== d.name || exposed.checked !== d.exposed || online.checked !== d.onlineCheck;
    form.dataset.dirty = 'false'; form.addEventListener('input', () => { form.dataset.dirty = String(dirty()); });
    form.addEventListener('submit', async e => { e.preventDefault(); if (await op(save, 'saveDysonDevice', { id: d.id, name: name.value.trim(), exposed: exposed.checked, onlineCheck: online.checked })) { form.dataset.dirty = 'false'; load(true); } });
    const send = (button, command) => op(button, 'controlDyson', { id: d.id, command }).then(() => load(true));
    const btn = (text, command, primary) => { const b = h('button', { class: 'btn small' + (primary ? ' primary' : ''), type: 'button', text, disabled: !d.online }); b.addEventListener('click', () => send(b, command)); return b; };
    const speed = h('select', { 'aria-label': 'Stufe für ' + d.name, disabled: !d.online }, Array.from({ length: 10 }, (_, i) => h('option', { value: i + 1, text: 'Stufe ' + (i + 1), selected: (d.state.speed || 1) === i + 1 })));
    const speedBtn = h('button', { class: 'btn small', type: 'button', text: 'Stufe setzen', disabled: !d.online }); speedBtn.addEventListener('click', () => send(speedBtn, { speed: Number(speed.value) }));
    const st = d.state || {};
    const state = typeof st.on === 'boolean' ? (st.on ? 'Ein' : 'Aus') : 'Unbekannt';
    const readings = [Number.isFinite(st.temperature) ? st.temperature + ' °C' : '', Number.isFinite(st.humidity) ? st.humidity + ' % Luftfeuchte' : ''].filter(Boolean).join(' · ');
    return h('article', { class: 'card' },
      h('div', { class: 'card-head' }, h('b', { text: d.name }), h('span', { class: 'tag ' + (d.online ? 'ok' : 'bad'), text: d.online ? 'online' : 'offline' })),
      h('div', { class: 'muted' }, 'Modell ' + d.type + (d.ip ? ' · ' + d.ip : '') + (d.online ? '' : ' · Adresse wird automatisch gesucht')),
      h('div', {}, h('b', { text: 'Zustand: ' + state }), st.auto ? ' · Automatik' : '', Number.isFinite(st.speed) ? ' · Stufe ' + st.speed : '', readings ? h('div', { class: 'muted', text: readings }) : null),
      d.controlStatus && d.controlStatus.confirmed === false ? h('div', { class: 'notice bad', text: d.controlStatus.message }) : null,
      h('div', { class: 'row' }, st.on !== true ? btn('Einschalten', { on: true }, true) : null, st.on !== false ? btn('Ausschalten', { on: false }) : null, btn('Automatik', { on: true, auto: true }),
        d.capabilities && d.capabilities.oscillation ? btn(st.oscillation ? 'Oszillation aus' : 'Oszillation ein', { oscillation: !st.oscillation }) : null,
        d.capabilities && d.capabilities.night ? btn(st.night ? 'Nachtmodus aus' : 'Nachtmodus ein', { night: !st.night }) : null),
      h('div', { class: 'row' }, speed, speedBtn),
      d.capabilities && d.capabilities.matterOscillation ? h('small', { class: 'muted', text: 'Oszillation ist auch in Apple Home verfügbar.' }) : null,
      h('details', { class: 'more' }, h('summary', { text: 'Name und Freigabe' }), form));
  }
  async function load(force) {
    const editing = [...list.querySelectorAll('form')].some(f => f.dataset.dirty === 'true') || list.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (loading || (!force && (busy || editing))) return; loading = true;
    try { const r = await api('getDysonDevices'); list.replaceChildren(...(r.devices.length ? r.devices.map(card) : [h('div', { class: 'empty', text: 'Noch keine Dyson-Geräte eingerichtet.' })])); }
    catch (e) { msg(out, e.message, 'bad'); } finally { loading = false; }
  }
  refresh.addEventListener('click', () => load(true));
  load(true); const timer = setInterval(() => { if (!document.hidden) load(); }, 5000); window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
});
