'use strict';
// Seite „SSH-Zugang“: SSH ein-/ausschalten und Zugangsschlüssel verwalten (nur CCU-Administratoren).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task, stat, table, toggle, confirmDialog } = NEU;
  const main = shell({ title: 'SSH-Zugang', eyebrow: 'System', crumb: 'System', lead: 'Fernwartung der Zentrale über SSH: ein- oder ausschalten und festlegen, welche Schlüssel sich anmelden dürfen.' });
  const stats = h('div', { class: 'stats' }), admin = h('div'), out = h('p', { class: 'msg', role: 'status' }), keysOut = h('p', { class: 'msg', role: 'status' });
  const enabled = h('input', { type: 'checkbox' });
  const list = h('div');
  const key = h('textarea', { rows: 3, maxlength: 16384, spellcheck: 'false', autocomplete: 'off', placeholder: 'ssh-ed25519 AAAA… name@gerät' });
  const label = h('input', { maxlength: 64, autocomplete: 'off', placeholder: 'z. B. Laptop Thomas' });
  const addBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Schlüssel eintragen' });
  // SSH-Passwort ändern (Benutzer root) – ersetzt die Funktion der alten Oberfläche
  const pw1 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 64, 'aria-label': 'Neues SSH-Passwort' }), pw2 = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 64, 'aria-label': 'Neues SSH-Passwort wiederholen' });
  const pwBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Passwort ändern' }), pwOut = h('p', { class: 'msg', role: 'status' });
  const pwForm = h('form', { class: 'form' }, field('Neues Passwort', pw1, '10 bis 64 Zeichen, mit Buchstaben und Ziffern.'), field('Neues Passwort wiederholen', pw2), h('div', { class: 'wide actions' }, pwBtn));
  pwForm.addEventListener('submit', e => { e.preventDefault(); task(pwBtn, pwOut, async () => {
    if (pw1.value !== pw2.value) throw Error('Die beiden Eingaben stimmen nicht überein.');
    if (!await confirmDialog({ title: 'SSH-Passwort ändern?', text: 'Danach gilt für die Anmeldung als „root“ per SSH nur noch das neue Passwort. Schlüssel funktionieren weiter.', confirm: 'Ändern' })) return 'Nicht geändert.';
    try { const r = await api('setSshPassword', { password: pw1.value }); show(r); return r.message; } finally { pw1.value = ''; pw2.value = ''; }
  }, 'Passwort wird geändert …'); });
  // ---- Neuen Schlüssel erzeugen und aktivieren (Wunsch Thomas, 12.10.2026) ----
  // Das Schlüsselpaar (ed25519) entsteht HIER im Browser (WebCrypto). Der private Schlüssel verlässt das Gerät nur als
  // heruntergeladene Datei; die Zentrale bekommt nur den öffentlichen Teil (addSshKey) und speichert nie etwas Privates.
  const genName = h('input', { maxlength: 64, autocomplete: 'off', placeholder: 'z. B. PC Thomas' }), genBtn = h('button', { class: 'btn primary', type: 'button', text: 'Schlüssel erzeugen und aktivieren' });
  const genOut = h('p', { class: 'msg', role: 'status' }), genFiles = h('div');
  const b64 = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const u32 = n => new Uint8Array([n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]), sstr = b => cat(u32(b.length), b), te = s => new TextEncoder().encode(s);
  // OpenSSH-Format („openssh-key-v1“, unverschlüsselt) – so wie ssh-keygen -t ed25519 es schreibt
  function opensshKeys(pub, seed, comment) {
    const pubBlob = cat(sstr(te('ssh-ed25519')), sstr(pub)), check = crypto.getRandomValues(new Uint8Array(4));
    let priv = cat(check, check, sstr(te('ssh-ed25519')), sstr(pub), sstr(cat(seed, pub)), sstr(te(comment)));
    const pad = []; for (let i = 1; (priv.length + pad.length) % 8; i++) pad.push(i); priv = cat(priv, new Uint8Array(pad));
    const all = cat(te('openssh-key-v1\0'), sstr(te('none')), sstr(te('none')), sstr(new Uint8Array(0)), u32(1), sstr(pubBlob), sstr(priv));
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\n' + b64(all).match(/.{1,70}/g).join('\n') + '\n-----END OPENSSH PRIVATE KEY-----\n';
    return { pem, pubLine: 'ssh-ed25519 ' + b64(pubBlob) + ' ' + comment };
  }
  const fileLink = (name, text, label) => { const a = h('a', { class: 'btn small primary', download: name, text: label }); a.href = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' })); return a; };
  genBtn.addEventListener('click', () => task(genBtn, genOut, async () => {
    const comment = (genName.value.trim() || 'CCU3-Schluessel').replace(/[^\w.@ +:-]/g, '').replace(/\s+/g, '-').slice(0, 48) || 'CCU3-Schluessel';
    let kp; try { kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); } catch { throw Error('Dieser Browser kann keine ed25519-Schlüssel erzeugen. Bitte einen aktuellen Chrome, Edge, Firefox oder Safari verwenden.'); }
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey), k = opensshKeys(fromB64url(jwk.x), fromB64url(jwk.d), comment);
    const r = await api('addSshKey', { key: k.pubLine, comment }); show(r);
    const datei = 'ccu3_' + comment.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    genFiles.replaceChildren(h('div', { class: 'notice warn' }, h('span', { text: 'Den privaten Schlüssel JETZT herunterladen und sicher aufbewahren – er wird nirgends gespeichert und kann nicht noch einmal angezeigt werden. Wer diese Datei hat, kommt auf die Zentrale.' })),
      h('div', { class: 'actions' }, fileLink(datei, k.pem, '⬇ Privater Schlüssel (' + datei + ')'), fileLink(datei + '.pub', k.pubLine + '\n', '⬇ Öffentlicher Schlüssel (.pub)')),
      h('ol', { class: 'steps' }, h('li', {}, h('span', { text: 'Windows: die Datei nach C:\\Users\\<dein Name>\\.ssh\\ legen.' })), h('li', {}, h('span', { text: 'Anmelden mit: ssh -i C:\\Users\\<dein Name>\\.ssh\\' + datei + ' root@' + location.hostname })), h('li', {}, h('span', { text: 'iPhone (z. B. App „Termius“): privaten Schlüssel dort importieren.' }))));
    genName.value = '';
    return r.message + (r.enabled ? '' : ' Hinweis: SSH ist gerade ausgeschaltet – oben einschalten, damit der Schlüssel benutzt werden kann.');
  }, 'Schlüssel wird erzeugt …'));
  const genPanel = panel('Neuen Schlüssel erzeugen und aktivieren', 'Erzeugt ein neues Schlüsselpaar direkt in diesem Browser und trägt den öffentlichen Teil sofort in der Zentrale ein. Den privaten Schlüssel lädst du herunter – nur er erlaubt die Anmeldung.', h('div', { class: 'form' }, field('Bezeichnung', genName, 'Für welches Gerät? z. B. „PC Thomas“.'), h('div', { class: 'wide actions' }, genBtn)), genOut, genFiles);
  const addForm = h('form', { class: 'form' }, field('Öffentlicher Schlüssel (Inhalt der .pub-Datei)', key, 'Nur den öffentlichen Schlüssel einfügen. Der private Schlüssel bleibt immer auf deinem Gerät.'), field('Bezeichnung', label, 'Damit du später weißt, wem der Schlüssel gehört.'), h('div', { class: 'wide actions' }, addBtn));
  main.append(admin, stats,
    panel('SSH ein- oder ausschalten', 'Ist SSH aus, kann sich niemand per SSH anmelden – auch nicht für Fernwartung oder Installationen per SSH.', h('div', { class: 'form' }, h('div', { class: 'wide' }, toggle(enabled, 'SSH-Zugang eingeschaltet'))), out),
    panel('Zugangsschlüssel', 'Wer einen dieser Schlüssel besitzt, kann sich ohne Passwort anmelden. Neue Schlüssel dürfen sich nur anmelden, nichts weiterleiten.', list, keysOut),
    genPanel,
    panel('Vorhandenen öffentlichen Schlüssel hinzufügen', null, addForm),
    panel('SSH-Passwort ändern', 'Passwort für die Anmeldung als „root“ per SSH. Es wird verschlüsselt in der Zentrale abgelegt und nirgends angezeigt.', pwForm, pwOut),
    panel('Gut zu wissen', null, h('ul', { class: 'steps' },
      h('li', {}, h('span', { text: 'Schlüssel sind sicherer als ein Passwort. Einen Schlüssel erzeugst du am PC mit „ssh-keygen -t ed25519“.' })),
      h('li', {}, h('span', { text: 'Das SSH-Passwort änderst du hier unter „SSH-Passwort ändern“.' })),
      h('li', {}, h('span', { text: 'Entfernst du einen Schlüssel, kann sich dessen Besitzer sofort nicht mehr anmelden.' })))));
  let isAdmin = false;
  function show(d) {
    enabled.checked = d.enabled; enabled.disabled = !isAdmin || !d.available;
    stats.replaceChildren(stat('SSH', d.enabled ? 'ein' : 'aus', d.available ? (d.running ? 'Dienst läuft' : 'Dienst läuft nicht') : 'auf diesem System nicht vorhanden', d.enabled ? (d.running ? 'ok' : 'warn') : undefined),
      stat('Schlüssel', String(d.keys.length), 'von höchstens ' + d.limits.keys));
    if (!d.available) out.replaceChildren(h('span', { text: 'Testumgebung: SSH gibt es nur auf der echten CCU3.' }));
    list.replaceChildren(d.keys.length ? table(['Bezeichnung', 'Art', 'Fingerabdruck', 'Rechte', ''], d.keys.map(k => {
      const del = h('button', { class: 'btn danger small', type: 'button', text: 'Entfernen', disabled: !isAdmin });
      del.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'Schlüssel „' + (k.comment || k.type) + '“ entfernen?', text: 'Wer diesen Schlüssel besitzt, kann sich danach nicht mehr per SSH anmelden.' + (d.keys.length === 1 ? ' Das ist der letzte Schlüssel – danach geht SSH nur noch mit Passwort.' : ''), confirm: 'Entfernen', danger: true })) return;
        task(del, keysOut, async () => { const r = await api('removeSshKey', { fingerprint: k.fingerprint }); show(r); return r.message; });
      });
      return h('tr', {}, h('td', { text: k.comment || '–' }), h('td', { text: k.type }), h('td', { class: 'mono', text: k.fingerprint }), h('td', { text: k.restricted ? 'nur Anmelden' : 'uneingeschränkt' }), h('td', {}, del));
    })) : h('p', { class: 'muted', text: 'Noch keine Schlüssel eingetragen.' }));
  }
  enabled.addEventListener('change', async () => {
    const want = enabled.checked;
    if (!want && !await confirmDialog({ title: 'SSH ausschalten?', text: 'Danach ist keine Anmeldung per SSH mehr möglich – auch keine Fernwartung oder Installation per SSH. Einschalten geht jederzeit wieder hier.', confirm: 'Ausschalten', danger: true })) { enabled.checked = true; return; }
    task(enabled, out, async () => { try { const r = await api('setSshEnabled', { enabled: want }); show(r); return r.message; } catch (e) { enabled.checked = !want; throw e; } }, want ? 'SSH wird eingeschaltet …' : 'SSH wird ausgeschaltet …');
  });
  addForm.addEventListener('submit', e => { e.preventDefault(); task(addBtn, keysOut, async () => {
    const p = { key: key.value }; if (label.value.trim()) p.comment = label.value.trim();
    const r = await api('addSshKey', p); key.value = ''; label.value = ''; show(r); return r.message; }, 'Schlüssel wird eingetragen …'); });
  NEU.ensureSession().then(s => {
    isAdmin = !!s.admin;
    if (!isAdmin) { admin.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, 'Den SSH-Zugang dürfen nur CCU-Administratoren sehen und ändern. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' })))); for (const el of main.querySelectorAll('input,textarea,button')) el.disabled = true; return; }
    api('getSshStatus').then(show).catch(e => msg(out, e.message, 'bad'));
  }).catch(e => msg(out, e.message, 'bad'));
});
