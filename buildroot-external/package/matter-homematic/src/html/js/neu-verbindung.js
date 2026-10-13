'use strict';
// Seite „Verbindung zur CCU“: Adresse der Box und Zugangsdaten eingeben, testen und speichern.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task, confirmDialog, stat, table } = NEU;
  const main = shell({ title: 'Verbindung zur CCU', eyebrow: 'System', crumb: 'System', lead: 'Mit welcher CCU (Box) die Matter-Bridge arbeitet und mit welchen Zugangsdaten. Läuft die Bridge direkt auf der CCU3, ist die Adresse 127.0.0.1.' });
  const stats = h('div', { class: 'stats' });
  const host = h('input', { required: true, maxlength: 253, autocomplete: 'off', spellcheck: 'false', placeholder: '127.0.0.1 oder 192.168.…' });
  const port = h('input', { type: 'number', min: 1, max: 65535, value: 80, required: true });
  const user = h('input', { maxlength: 64, autocomplete: 'username', spellcheck: 'false', placeholder: 'z. B. Admin' });
  const pass = h('input', { type: 'password', maxlength: 256, autocomplete: 'current-password' });
  const show = h('input', { type: 'checkbox' }); show.addEventListener('change', () => { pass.type = show.checked ? 'text' : 'password'; });
  const testBtn = h('button', { class: 'btn', type: 'button', text: 'Verbindung testen' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Speichern' });
  const out = h('p', { class: 'msg', role: 'status' }), results = h('div'), adminNote = h('div');
  const form = h('form', { class: 'form' },
    field('Adresse der CCU', host, 'IP-Adresse oder Name, ohne „http://“.'), field('Port der CCU-Weboberfläche', port, 'Normalerweise 80.'),
    field('Benutzername der CCU', user, 'Ein CCU-Administratorkonto. Leer lassen, wenn in der CCU keine Anmeldung aktiv ist.'), field('Passwort', pass, 'Leer lassen, um das gespeicherte Passwort zu behalten.'),
    h('div', { class: 'wide' }, NEU.check('Passwort beim Tippen anzeigen', show)),
    h('div', { class: 'wide actions' }, testBtn, saveBtn));
  main.append(adminNote, stats,
    panel('Zugangsdaten', 'Das Passwort wird verschlüsselt auf der CCU gespeichert und nie wieder angezeigt.', form, out, results),
    panel('Wofür braucht die Bridge das?', null, h('ul', {}, h('li', { text: 'Gerätenamen und Räume aus der CCU lesen.' }), h('li', { text: 'Schaltbefehle aus Apple Home an Homematic und Homematic IP weitergeben.' }), h('li', { text: 'Servicemeldungen, Programme und Systemvariablen für die OpenCCU-Seiten.' })),
      h('p', { class: 'muted', text: 'Die Anmeldung an dieser Oberfläche selbst prüft weiterhin die CCU mit deinen eigenen Zugangsdaten. Die Matter-Kopplung mit Apple Home bleibt beim Ändern erhalten.' })));

  let admin = false;
  const input = () => ({ host: host.value.trim(), regaPort: Number(port.value), user: user.value.trim(), password: pass.value });
  function showSettings(s) {
    host.value = s.host; port.value = s.regaPort; user.value = s.user || '';
    pass.value = ''; pass.placeholder = s.hasPassword ? 'Gespeichert – leer lassen zum Beibehalten' : (s.plaintextPassword ? 'Bisher unverschlüsselt gespeichert – bitte neu eingeben' : 'Noch kein Passwort gespeichert');
    const ifaces = Object.entries(s.interfaces || {});
    const ok = ifaces.filter(([, v]) => v.enabled && v.connected).length, on = ifaces.filter(([, v]) => v.enabled).length;
    stats.replaceChildren(stat('Verbunden mit', s.runningHost || s.host, s.runningHost && s.runningHost !== s.host ? 'neue Adresse gilt nach Neustart' : 'aktuelle Adresse', s.runningHost && s.runningHost !== s.host ? 'warn' : 'ok'),
      stat('Schnittstellen', on ? ok + ' / ' + on : '–', 'verbunden / eingeschaltet', ok === on && on ? 'ok' : 'warn'),
      stat('Zugangsdaten', s.hasPassword ? 'gespeichert' : s.plaintextPassword ? 'unverschlüsselt' : 'keine', s.user ? 'Benutzer: ' + s.user : 'kein Benutzer', s.plaintextPassword && !s.hasPassword ? 'warn' : undefined));
  }
  function showResults(r) {
    results.replaceChildren(h('h3', { text: 'Testergebnis: ' + r.summary }),
      table(['Prüfung', 'Ergebnis'], [...r.checks.map(c => h('tr', {}, h('td', { text: c.label }), h('td', {}, h('span', { class: 'tag ' + (c.ok ? 'ok' : 'bad'), text: c.detail })))),
        h('tr', {}, h('td', { text: 'Anmeldung an der CCU' }), h('td', {}, h('span', { class: 'tag ' + (r.login.ok === true ? (r.login.admin ? 'ok' : 'warn') : r.login.ok === false ? 'bad' : ''), text: r.login.detail })))]),
      h('p', { class: 'muted', text: 'Nicht jeder Port muss offen sein: VirtualDevices gibt es nur, wenn sie in der CCU aktiviert sind. ReGa (8181) ist nur auf der CCU selbst erreichbar.' }));
  }
  testBtn.addEventListener('click', () => { if (!form.reportValidity()) return; task(testBtn, out, async () => { const r = await api('testCcuConnection', input()); showResults(r); return r.login.ok === false ? 'Anmeldung fehlgeschlagen – Zugangsdaten prüfen.' : 'Test abgeschlossen.'; }, 'Verbindung wird geprüft …'); });
  form.addEventListener('submit', e => {
    e.preventDefault(); if (!form.reportValidity()) return;
    task(saveBtn, out, async () => {
      const r = await api('saveCcuConnection', input()); pass.value = ''; showSettings(r.settings);
      if (r.restartRequired && await confirmDialog({ title: 'Bridge jetzt neu starten?', text: 'Die neue Adresse wird erst nach einem Neustart verwendet. Apple Home ist dabei etwa eine Minute nicht erreichbar; die Kopplung bleibt erhalten.', confirm: 'Jetzt neu starten' })) {
        const x = await api('restartBridge', {}); return x.message || 'Neustart ausgelöst.';
      }
      return r.message;
    }, 'Wird gespeichert …');
  });
  api('getCcuConnection').then(d => {
    admin = d.admin; showSettings(d.settings);
    if (!admin) {
      adminNote.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, 'Zum Ändern und Testen bitte als CCU-Administrator anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' }))));
      for (const el of form.querySelectorAll('input,button')) el.disabled = true;
    }
  }).catch(e => msg(out, e.message, 'bad'));
});
