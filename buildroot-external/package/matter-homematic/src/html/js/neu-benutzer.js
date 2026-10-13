'use strict';
// Seite „Benutzer & Konto“ (Wunsch Thomas 13.10.2026: „Benutzer“ und „Mein Konto“ zusammengeführt):
// oben das eigene Konto (Passwort, gemerkte Geräte) für alle; darunter nur für Administratoren die Benutzerverwaltung.
// Passwörter tippt jeder selbst; sie werden nur als Hash gespeichert und nie angezeigt.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task, confirmDialog, table, fmtDate } = NEU;
  const ROLLEN = { admin: 'Administrator – darf alles', bewohner: 'Bewohner – Geräte bedienen, nichts einstellen', gast: 'Gast – nur ansehen' };
  const pw = label => h('input', { type: 'password', autocomplete: 'new-password', minlength: 10, maxlength: 128, 'aria-label': label });
  const main = shell({ title: 'Benutzer & Konto', eyebrow: 'Zugang & Sicherheit', lead: 'Dein Konto und – für Administratoren – wer sich an dieser Oberfläche anmelden darf. Die Anmeldung als CCU-Administrator bleibt immer als Notzugang.' });

  // ---------- Mein Konto ----------
  const who = h('p', { class: 'muted' }), old = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Altes Passwort' }), neu = pw('Neues Passwort'), neu2 = pw('Neues Passwort wiederholen');
  const save = h('button', { class: 'btn primary', type: 'button', text: 'Passwort ändern' }), out = h('p', { class: 'msg', role: 'status' });
  const pwForm = h('div', {}, h('div', { class: 'form' }, field('Altes Passwort', old), field('Neues Passwort', neu, 'Mindestens 10 Zeichen, Buchstaben und Ziffern.'), field('Wiederholen', neu2)), h('div', { class: 'actions' }, save));
  main.append(panel('Mein Konto', null, who, pwForm, out));
  // Gemerkte Geräte („30 Tage angemeldet lassen“): ansehen und einzeln entfernen (z. B. verlorenes Handy)
  const gList = h('div'), gOut = h('p', { class: 'msg', role: 'status' });
  main.append(panel('Gemerkte Geräte', 'Geräte, die beim Anmelden „30 Tage angemeldet lassen“ gewählt haben. Entfernen meldet das Gerät sofort ab.', gOut, gList));
  const gLoad = () => api('getGemerkteGeraete').then(d => gList.replaceChildren(d.geraete.length ? table(['Gerät', 'Benutzer', 'Zuletzt benutzt', 'Gültig bis', ''], d.geraete.map(g => {
    const rm = h('button', { class: 'btn small danger', type: 'button', text: 'Entfernen' });
    rm.addEventListener('click', () => task(rm, gOut, async () => { await api('loescheGemerktesGeraet', { id: g.id }); await gLoad(); return 'Entfernt.'; }));
    return h('tr', {}, h('td', {}, h('b', { text: g.label }), g.diesesGeraet ? h('span', { class: 'tag ok', text: 'dieses Gerät' }) : null), h('td', { text: g.user }), h('td', { text: fmtDate(g.lastUsed) }), h('td', { text: fmtDate(g.expires) }), h('td', {}, rm));
  })) : h('div', { class: 'empty', text: 'Keine gemerkten Geräte.' }))).catch(e => msg(gOut, e.message, 'bad'));
  gLoad();
  api('getEigenesKonto').then(k => {
    who.textContent = k.user ? 'Angemeldet als „' + k.user + '“ (' + k.rolle + ').' : 'Angemeldet als CCU-Administrator – dieses Passwort wird in der CCU geändert.';
    pwForm.hidden = !k.user;
  }).catch(() => {});
  save.addEventListener('click', () => task(save, out, async () => { if (neu.value !== neu2.value) throw Error('Die neuen Passwörter stimmen nicht überein.'); const r = await api('setEigenesPasswort', { old: old.value, password: neu.value }); old.value = neu.value = neu2.value = ''; return r.message; }));

  // ---------- Benutzerverwaltung (nur Administratoren; der Server prüft das ebenfalls) ----------
  const uOut = h('p', { class: 'msg', role: 'status' }), list = h('div', { class: 'auto-list' });
  const name = h('input', { type: 'text', maxlength: 32, autocomplete: 'off', 'aria-label': 'Benutzername' }), role = h('select', { 'aria-label': 'Rolle' }, ...Object.entries(ROLLEN).map(([k, t]) => h('option', { value: k, text: t })));
  const p1 = pw('Passwort'), p2 = pw('Passwort wiederholen'), add = h('button', { class: 'btn primary', type: 'button', text: 'Benutzer anlegen' });
  role.value = 'bewohner';
  const adminBox = h('div', { hidden: true }, panel('Neuer Benutzer', 'Das Passwort gibt die Person am besten selbst ein (mindestens 10 Zeichen, Buchstaben und Ziffern). Danach kann sie es oben unter „Mein Konto“ ändern.',
    h('div', { class: 'form' }, field('Benutzername', name, '3–32 Zeichen: Buchstaben, Ziffern, Punkt, Strich'), field('Rolle', role), field('Passwort', p1), field('Wiederholen', p2)), h('div', { class: 'actions' }, add)), uOut, panel('Benutzer', null, list));
  main.append(adminBox);
  function render(d) {
    list.replaceChildren(...(d.users.length ? d.users.map(u => {
      const sel = h('select', { 'aria-label': 'Rolle von ' + u.name }, ...Object.entries(ROLLEN).map(([k, t]) => h('option', { value: k, text: t }))); sel.value = u.role;
      sel.addEventListener('change', () => task(null, uOut, async () => { render(await api('saveBenutzer', { action: 'role', name: u.name, role: sel.value })); return 'Rolle von „' + u.name + '“ geändert.'; }));
      const np = pw('Neues Passwort'), setpw = h('button', { class: 'btn small', type: 'button', text: 'Passwort setzen' }), del = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen' });
      setpw.addEventListener('click', () => task(setpw, uOut, async () => { render(await api('saveBenutzer', { action: 'password', name: u.name, password: np.value })); np.value = ''; return 'Passwort von „' + u.name + '“ gesetzt.'; }));
      del.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Benutzer löschen?', text: '„' + u.name + '“ kann sich danach nicht mehr anmelden.', confirm: 'Löschen', danger: true })) return; task(del, uOut, async () => { render(await api('saveBenutzer', { action: 'delete', name: u.name })); return 'Gelöscht.'; }); });
      return h('details', { class: 'auto-item' }, h('summary', {}, h('b', { text: u.name }), ' ', h('span', { class: 'tag', text: u.rolle }), h('span', { class: 'muted', text: u.lastLogin ? ' · zuletzt ' + new Date(u.lastLogin).toLocaleString('de-DE') : ' · noch nie angemeldet' })),
        h('div', { class: 'auto-body' }, h('div', { class: 'row' }, field('Rolle', sel), field('Neues Passwort', np), setpw, del)));
    }) : [h('div', { class: 'empty', text: 'Noch keine eigenen Benutzer. Angemeldet wird bisher nur als CCU-Administrator.' })]));
  }
  add.addEventListener('click', () => task(add, uOut, async () => {
    if (p1.value !== p2.value) throw Error('Die Passwörter stimmen nicht überein.');
    const r = await api('saveBenutzer', { action: 'add', name: name.value.trim(), role: role.value, password: p1.value }); p1.value = p2.value = ''; name.value = ''; render(r); return 'Benutzer angelegt.';
  }));
  // CCU-Administrator-Passwort (Wunsch Thomas 13.10.2026): bei einer neuen CCU ohne Passwort hier setzen; ein vorhandenes wird nie überschrieben
  const ccuBox = h('div'), cOut = h('p', { class: 'msg', role: 'status' });
  adminBox.prepend(ccuBox);
  function ccuShow(st) {
    if (!st.admin) { ccuBox.replaceChildren(); return; }
    if (st.hasPassword) { ccuBox.replaceChildren(panel('CCU-Administrator', null, h('p', {}, h('span', { class: 'tag ok', text: 'Passwort gesetzt' }), h('span', { class: 'muted', text: ' Ändern nur über die CCU-Oberfläche (Einstellungen → Benutzerverwaltung).' })), cOut)); return; }
    const a = pw('Neues CCU-Passwort'), b = pw('Wiederholen'), go = h('button', { class: 'btn primary', type: 'button', text: 'Passwort setzen' });
    go.addEventListener('click', () => task(go, cOut, async () => { if (a.value !== b.value) throw Error('Die Passwörter stimmen nicht überein.'); const r = await api('setCcuAdminPasswort', { password: a.value }); a.value = b.value = ''; ccuShow(r.hasPassword ? { admin: true, hasPassword: true } : st); return r.message; }));
    ccuBox.replaceChildren(panel('CCU-Administrator ohne Passwort', 'Achtung: Der Benutzer „Admin“ der CCU hat noch kein Passwort – jeder im Heimnetz kann sich anmelden. Bitte jetzt ein Passwort setzen (10 bis 64 Zeichen, Buchstaben und Ziffern, keine Leerzeichen, keine Umlaute, kein " und kein \\). Es gilt danach für die Anmeldung hier und in der CCU.',
      h('div', { class: 'form' }, field('Neues Passwort', a), field('Wiederholen', b)), h('div', { class: 'actions' }, go), cOut));
  }
  // Nur wer die Liste lesen darf (Administrator), sieht die Verwaltung; Bewohner/Gäste sehen nur ihr Konto
  api('getBenutzer', undefined, { errorField: false }).then(d => { adminBox.hidden = false; render(d); api('getCcuAdmin', undefined, { errorField: false }).then(ccuShow).catch(() => {}); }).catch(() => { adminBox.hidden = true; });
  // Alte Adresse /benutzer.html: Anker zur Verwaltung
  if (location.hash === '#benutzer') setTimeout(() => adminBox.scrollIntoView(), 600);
});
