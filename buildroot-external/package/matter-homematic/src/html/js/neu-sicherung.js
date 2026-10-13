'use strict';
// Eine Seite „Sicherung & Wiederherstellung“ (data-page="speicher").
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task, confirmDialog, ensureSession, table } = NEU;
  const page = document.documentElement.dataset.page;
  const pw = (attrs = {}) => h('input', { type: 'password', maxlength: 256, autocomplete: 'new-password', ...attrs });
  const adminGate = async container => {
    const s = await ensureSession();
    if (s.admin) return true;
    container.prepend(h('div', { class: 'notice warn' }, h('span', {}, 'Für Sicherungen und Zugangsdaten einmal mit dem CCU-Administratorkonto anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Als Administrator anmelden' }))));
    for (const el of container.querySelectorAll('input,select,button')) el.disabled = true;
    return false;
  };
  const boxes = (root, list, checked) => { root.replaceChildren(...list.map(c => check(c.name + (Number.isInteger(c.devices) ? ' (' + c.devices + ' Geräte)' : '') + (c.note ? ' – ' + c.note : ''), h('input', { type: 'checkbox', value: c.id, checked })))); };
  const chosen = root => [...root.querySelectorAll('input:checked')].map(i => i.value);

  // „Wiederherstellen“ und „Zugangsdaten“ – seit 0.21.6 Teil der einen Seite „Sicherung & Wiederherstellung“.
  function wiederherstellen(container) {
    const file = h('input', { type: 'file', accept: '.tspoint-backup,application/json' }), rpass = pw({ autocomplete: 'off' });
    const inspect = h('button', { class: 'btn', type: 'button', text: 'Datei prüfen' }), summary = h('p', { class: 'muted' });
    const rcats = h('div', { class: 'checks' }), restore = h('button', { class: 'btn danger', type: 'button', text: 'Auswahl wiederherstellen …' });
    const confirmBox = h('div', { hidden: true }, h('div', { class: 'notice warn', text: 'Gleichnamige Einstellungen und Geräte mit derselben ID werden ersetzt; andere bleiben erhalten. Die Bridge startet danach neu, die Verbindung zu Apple Home baut sich wieder auf. Vorher wird automatisch eine Rücksicherung auf der CCU erstellt.' }), rcats, h('div', { class: 'actions' }, restore));
    const restoreOut = h('p', { class: 'msg', role: 'status' });
    const acc = { accessId: h('input', { maxlength: 128, autocomplete: 'off' }), accessSecret: pw({ maxlength: 128, autocomplete: 'off' }), uid: h('input', { maxlength: 64, autocomplete: 'off' }),
      region: h('select', {}, [['eu', 'Mitteleuropa'], ['eu-west', 'Westeuropa'], ['us', 'Westamerika'], ['us-east', 'Ostamerika'], ['cn', 'China'], ['in', 'Indien'], ['sg', 'Singapur']].map(([v, t]) => h('option', { value: v, text: t }))),
      spUser: h('input', { maxlength: 254, autocomplete: 'off' }), spPass: pw({ maxlength: 1024, autocomplete: 'off' }), country: h('input', { type: 'number', min: 1, max: 999, value: 49 }),
      ccuUser: h('input', { maxlength: 64, autocomplete: 'off' }), ccuPass: pw({ autocomplete: 'off' }) };
    const saveAcc = h('button', { class: 'btn', type: 'button', text: 'Zugangsdaten verschlüsselt speichern' }), accOut = h('p', { class: 'msg', role: 'status' });
    let backup = null;
    const forget = () => { backup = null; confirmBox.hidden = true; rcats.replaceChildren(); summary.textContent = ''; };
    file.addEventListener('change', forget); rpass.addEventListener('input', forget);
    const restorePanel = panel('5. Wiederherstellen', 'Sicherungsdatei (.tspoint-backup) wählen – z. B. von der WD oder aus dem Verlauf heruntergeladen –, prüfen, Bereiche wählen, dann bewusst wiederherstellen.', h('div', { class: 'form' }, field('Sicherungsdatei', file), field('Sicherungspasswort', rpass)), h('div', { class: 'actions' }, inspect), summary, confirmBox, restoreOut,
      h('p', { class: 'muted' }, h('a', { href: '/api/?method=backupRecovery', text: 'Stand vor der letzten Wiederherstellung herunterladen' })));
    restorePanel.id = 'wiederherstellen';
    container.append(restorePanel,
      panel('Zugangsdaten für künftige Sicherungen', 'Nur nötig für früher verworfene Zugänge. Ändert weder Konten noch die laufende Gerätesteuerung.',
        h('details', { class: 'more' }, h('summary', { text: 'Zugangsdaten hinterlegen' }),
          h('h3', { text: 'Smart Life / Tuya' }), h('div', { class: 'form' }, field('Access ID', acc.accessId), field('Access Secret', acc.accessSecret), field('UID des App-Kontos', acc.uid), field('Rechenzentrum', acc.region)),
          h('h3', { text: 'SMART+' }), h('div', { class: 'form' }, field('E-Mail / Benutzername', acc.spUser), field('App-Passwort', acc.spPass), field('Kontoland (49 = Deutschland)', acc.country)),
          h('h3', { text: 'CCU-Zugang' }), h('div', { class: 'form' }, field('Benutzername', acc.ccuUser), field('Passwort', acc.ccuPass)),
          h('div', { class: 'actions' }, saveAcc), accOut)),
      panel('Gut zu wissen', null, h('p', { class: 'muted', text: 'Der Bereich Tailscale sichert Anmeldung, VPN-Schlüssel und die Auswahl „Nur CCU“/„Gesamtes Heimnetz“ verschlüsselt; die Identität wird nur auf derselben CCU wiederhergestellt. Die Bereichs-Sicherung enthält keine Apple-Home-/Matter-Kopplung – dafür „Vollständige CCU3-Sicherung“ mit anhaken.' })));
    inspect.addEventListener('click', () => task(inspect, restoreOut, async () => {
      forget(); const f = file.files[0]; if (!f) throw Error('Eine Sicherungsdatei auswählen'); if (f.size > 3 * 1024 * 1024) throw Error('Sicherungsdatei zu groß');
      let data; try { data = JSON.parse(await f.text()); } catch { throw Error('Datei ist keine gültige Sicherung'); }
      const preview = await api('inspectBackup', { backup: data, password: rpass.value });
      backup = data; boxes(rcats, preview.categories, true); summary.textContent = 'Version ' + preview.version + ' · erstellt ' + NEU.fmtDate(preview.created); confirmBox.hidden = false;
      return 'Datei geprüft. Bereiche auswählen.';
    }, 'Datei wird geprüft …'));
    restore.addEventListener('click', async () => {
      if (!backup) { msg(restoreOut, 'Zuerst die Datei prüfen', 'bad'); return; }
      const selected = chosen(rcats); if (!selected.length) { msg(restoreOut, 'Mindestens einen Bereich auswählen', 'bad'); return; }
      if (!await confirmDialog({ title: 'Wiederherstellen?', text: 'Die ausgewählten Bereiche werden ersetzt und die Bridge startet neu. Möglichst im Heimnetz ausführen.', confirm: 'Jetzt wiederherstellen', danger: true, slider: true })) return;
      task(restore, restoreOut, async () => { const d = await api('restoreBackup', { backup, password: rpass.value, selected, confirm: true }); forget(); rpass.value = ''; return d.message; }, 'Wird wiederhergestellt …');
    });
    saveAcc.addEventListener('click', () => task(saveAcc, accOut, async () => {
      const d = await api('saveBackupAccounts', { accounts: { smartlife: { accessId: acc.accessId.value.trim(), accessSecret: acc.accessSecret.value, uid: acc.uid.value.trim(), region: acc.region.value }, smartplus: { username: acc.spUser.value.trim(), password: acc.spPass.value, countryCode: Number(acc.country.value) }, ccu: { username: acc.ccuUser.value.trim(), password: acc.ccuPass.value } } });
      acc.accessSecret.value = acc.spPass.value = acc.ccuPass.value = ''; return d.message;
    }, 'Wird gespeichert …'));
    ensureSession().then(s => { if (!s.admin) return; return api('backupAccounts').then(d => {
      const a = d.accounts || {};
      if (a.smartlife) { for (const k of ['accessId', 'uid', 'region']) if (a.smartlife[k] !== undefined) acc[k].value = a.smartlife[k]; if (a.smartlife.hasSecret) acc.accessSecret.placeholder = 'Gespeichert – leer lassen zum Beibehalten'; }
      if (a.smartplus) { if (a.smartplus.username !== undefined) acc.spUser.value = a.smartplus.username; if (a.smartplus.countryCode) acc.country.value = a.smartplus.countryCode; if (a.smartplus.hasSecret) acc.spPass.placeholder = 'Gespeichert – leer lassen zum Beibehalten'; }
      if (a.ccu) { if (a.ccu.username !== undefined) acc.ccuUser.value = a.ccu.username; if (a.ccu.hasSecret) acc.ccuPass.placeholder = 'Gespeichert – leer lassen zum Beibehalten'; }
    }); }).catch(e => msg(accOut, e.message, 'bad'));
  }
  function speicher() {
    const main = shell({ title: 'Sicherung & Wiederherstellung', eyebrow: 'System', crumb: 'System', lead: 'Eine Seite für alles: das komplette System sichern – von Hand oder nach Zeitplan, automatisch auch auf die WD – und per Klick wiederherstellen.' });
    const target = h('select', {}, h('option', { value: 'wd', text: 'WD (Netzwerkspeicher) im Heimnetz' }), h('option', { value: 'download', text: 'Nur auf diesem Gerät herunterladen' }));
    // Google
    const gState = h('p', { role: 'status', text: 'Anmeldung wird geprüft …' }), gClient = h('input', { autocomplete: 'off', maxlength: 240 }), gSecret = pw({ placeholder: 'Gespeichert – leer lassen zum Beibehalten' });
    const gLogin = h('button', { class: 'btn primary', type: 'button', text: 'Mit Google Drive verbinden' }), gLogout = h('button', { class: 'btn danger', type: 'button', hidden: true, text: 'Google-Verbindung entfernen' });
    const gFolder = h('a', { class: 'btn', target: '_blank', rel: 'noopener noreferrer', hidden: true, text: 'Sicherungsordner in Google Drive ↗' });
    const gCode = h('input', { readonly: true, 'aria-label': 'Google-Bestätigungscode', class: 'mono', style: 'font-size:20px;letter-spacing:2px;max-width:260px' }), gQr = h('div'), gOpen = h('a', { target: '_blank', rel: 'noopener noreferrer', class: 'btn', text: 'Google-Seite öffnen ↗' });
    const gCodeBox = h('div', { hidden: true }, h('p', { text: 'QR-Code mit dem Handy scannen oder die Google-Seite öffnen und diesen Code eingeben:' }), gCode, h('div', { style: 'margin:12px 0' }, gQr), gOpen, h('p', { class: 'muted', text: 'Die Freigabe bestätigst du selbst bei Google. Dein Google-Passwort wird hier nicht eingegeben.' }));
    const google = panel('Google Drive verbinden', 'Google erhält ausschließlich verschlüsselte Sicherungsdateien.', gState,
      h('details', { class: 'more' }, h('summary', { text: 'Einmalige Google-Einrichtung' }),
        h('ol', { class: 'steps' }, ...['Ein eigenes Google-Cloud-Projekt anlegen (z. B. „Matter-CCU-Backup“).', 'Im Projekt die Google Drive API aktivieren.', 'Unter Google Auth Platform App-Angaben und Zielgruppe konfigurieren; im Testbetrieb das eigene Konto als Testnutzer eintragen.', 'Einen OAuth-Client vom Typ „TVs und Geräte mit eingeschränkter Eingabe“ erstellen.', 'Client-ID und Client-Secret unten eintragen. Angefordert wird nur drive.file.'].map(t => h('li', {}, h('span', { text: t })))),
        h('p', { class: 'muted', text: 'Im Google-Testmodus können Anmeldungen nach sieben Tagen ablaufen; für Dauerbetrieb den Veröffentlichungsstatus bei Google abschließen.' }),
        h('div', { class: 'form' }, field('Client-ID', gClient), field('Client-Secret', gSecret))),
      h('div', { class: 'actions' }, gLogin, gLogout, gFolder), gCodeBox);
    // WD (Netzwerkspeicher): Zugang direkt hier – eigener Menüpunkt entfällt (Wunsch Thomas, 11.10.2026)
    const wd = { host: h('input', { maxlength: 253, autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. 192.168.50.15', required: true }), share: h('input', { maxlength: 80, autocomplete: 'off', placeholder: 'z. B. ccu3-sicherung', required: true }),
      user: h('input', { maxlength: 64, autocomplete: 'off', spellcheck: 'false', placeholder: 'z. B. ccu3', required: true }), pass: pw({ maxlength: 256, autocomplete: 'new-password' }), folder: h('input', { maxlength: 64, value: 'ccu3', autocomplete: 'off', required: true }) };
    const wdHistory = h('input', { type: 'checkbox', checked: true });
    const wdTest = h('button', { class: 'btn', type: 'button', text: 'Verbindung testen' }), wdSave = h('button', { class: 'btn primary', type: 'submit', text: 'WD-Zugang speichern' }), wdOut = h('p', { class: 'msg', role: 'status' }), wdSteps = h('div');
    let wdLoaded = null;
    const wdForm = h('form', { class: 'form' }, field('Adresse der WD (interne IP)', wd.host, 'Am besten im Router fest vergeben.'), field('Name der Freigabe', wd.share, 'Genau so schreiben wie auf der WD (Groß-/Kleinschreibung).'),
      field('Benutzer', wd.user), field('Passwort', wd.pass, 'Leer lassen, um das gespeicherte zu behalten. Wird verschlüsselt auf der CCU gespeichert.'), field('Ordner auf der Freigabe', wd.folder, 'Sicherungen landen in <Ordner>/sicherungen; je Art bleiben die neuesten 10.'),
      h('div', { class: 'wide' }, check('Diagramm-Daten auf der WD speichern und von dort laden (Ordner <Ordner>/verlauf)', wdHistory)),
      h('div', { class: 'wide actions' }, wdTest, wdSave));
    const wdPanel = panel('WD (Netzwerkspeicher) verbinden', 'Die CCU legt die verschlüsselten Sicherungen direkt auf der WD im Heimnetz ab – ohne Cloud.', wdForm, wdOut, wdSteps);
    const wdInput = () => ({ enabled: wdHistory.checked, host: wd.host.value.trim(), share: wd.share.value.trim(), folder: wd.folder.value.trim() || 'ccu3', user: wd.user.value.trim(), password: wd.pass.value, intervalMinutes: wdLoaded ? wdLoaded.intervalMinutes : 10, recordLocal: wdLoaded ? wdLoaded.recordLocal : true });
    const wdShow = d => { const s = d.settings; wdLoaded = s; wdHistory.checked = s.enabled || !s.host; wd.host.value = s.host; wd.share.value = s.share; wd.user.value = s.user; wd.folder.value = s.folder; wd.pass.value = ''; wd.pass.placeholder = s.hasPassword ? 'Gespeichert – leer lassen zum Beibehalten' : 'Noch kein Passwort gespeichert'; };
    wdTest.addEventListener('click', () => { if (!wdForm.reportValidity()) return; task(wdTest, wdOut, async () => {
      const r = await api('testNetStorage', wdInput()); wd.pass.value = '';
      wdSteps.replaceChildren(table(['Prüfung', 'Ergebnis'], r.steps.map(s => h('tr', {}, h('td', { text: s.label }), h('td', {}, h('span', { class: 'tag ' + (s.ok === true ? 'ok' : s.ok === false ? 'bad' : 'warn'), text: s.ok === true ? 'in Ordnung' : s.ok === false ? (s.detail || 'fehlgeschlagen') : (s.detail || 'nicht geprüft') }))))));
      return r.message; }, 'WD wird geprüft …'); });
    wdForm.addEventListener('submit', e => { e.preventDefault(); if (!wdForm.reportValidity()) return; task(wdSave, wdOut, async () => { const r = await api('saveNetStorage', wdInput()); wdShow(r); return 'WD-Zugang gespeichert.'; }, 'Wird gespeichert …'); });
    api('getNetStorage').then(wdShow).catch(e => msg(wdOut, e.message, 'bad'));
    // Manuelle Sicherung
    const native = h('input', { type: 'checkbox' }), nativeHint = h('p', { class: 'muted' }), cats = h('div', { class: 'checks' }), spass = pw({ minlength: 10 });
    const run = h('button', { class: 'btn primary', type: 'button', text: 'Jetzt sichern' }), out = h('p', { class: 'msg', role: 'status' }), files = h('div');
    // Zeitplan
    const sc = { enabled: h('input', { type: 'checkbox' }), target: h('select', {}, h('option', { value: 'wd', text: 'WD (Netzwerkspeicher) im Heimnetz – direkt von der CCU' })),
      frequency: h('select', {}, h('option', { value: 'daily', text: 'Täglich' }), h('option', { value: 'weekly', text: 'Wöchentlich' }), h('option', { value: 'hourly', text: 'Alle gewählten Stunden' })),
      time: h('input', { type: 'time', value: '03:00', required: true }), weekday: h('select', {}, ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'].map((d, i) => h('option', { value: i, text: d }))),
      hours: h('input', { type: 'number', min: 1, max: 168, step: 1, value: 24, required: true }), zone: h('select', {}, h('option', { value: 'Europe/Berlin', text: 'Deutschland (Sommerzeit automatisch)' }), h('option', { value: 'UTC', text: 'UTC' })),
      rotate: h('input', { type: 'checkbox' }), copies: h('input', { type: 'number', min: 1, max: 10, value: 2, step: 1, required: true }), native: h('input', { type: 'checkbox' }), cats: h('div', { class: 'checks' }),
      password: pw({ minlength: 10, placeholder: 'Gespeichert: leer lassen zum Beibehalten' }) };
    const fWeekday = field('Wochentag', sc.weekday), fHours = field('Stundenabstand', sc.hours), fTime = field('Uhrzeit', sc.time);
    const scSave = h('button', { class: 'btn primary', type: 'submit', text: 'Zeitplan speichern' }), scOut = h('p', { class: 'msg', role: 'status' }), scInfo = h('p', { class: 'muted' });
    const scForm = h('form', {}, h('div', { class: 'form' }, h('div', { class: 'wide' }, check('Automatische Sicherung einschalten', sc.enabled)), field('Speicherziel', sc.target), field('Wie oft?', sc.frequency), fTime, fWeekday, fHours, field('Zeitzone', sc.zone)),
      h('h3', { text: 'Umfang' }), check('Vollständige CCU3-Sicherung mit erstellen', sc.native), sc.cats,
      h('div', { class: 'form' }, field('Sicherungspasswort für den Zeitplan', sc.password, 'Wird verschlüsselt auf der CCU gespeichert; zur Wiederherstellung weiterhin nötig.')),
      h('div', { class: 'actions' }, scSave));
    const history = h('div');
    const body = h('div', {},
      panel('1. Speicherziel', null, h('div', { class: 'form' }, field('Speicherziel', target)), h('p', { class: 'muted', text: 'Sicherungen gehen auf die WD. Eine Kopie bleibt zusätzlich auf der CCU (Verlauf unten) und kann heruntergeladen werden.' })),
      google,
      panel('2. Jetzt sichern', 'Die vollständige CCU-Sicherung enthält auch Zusatzsoftware, Matter-Kopplungen und Einstellungen. Die Bereiche darunter erlauben eine gezielte Wiederherstellung.', check('Vollständige CCU3-Sicherung mit erstellen', native), nativeHint, cats, h('div', { class: 'form' }, field('Sicherungspasswort (mind. 10 Zeichen)', spass, 'Wird nicht gespeichert und zur Wiederherstellung benötigt.')), h('div', { class: 'actions' }, run), out, files),
      panel('3. Regelmäßige Sicherung', 'Die CCU führt den Zeitplan selbst aus; ein verpasster Termin wird einmal nachgeholt.', scForm, scOut, scInfo),
      panel('4. Sicherungsverlauf auf der CCU', 'Bis zu zehn verschlüsselte Sicherungen bleiben auf der CCU, auch wenn ein Upload scheitert. Lokale Dateien ersetzen keine Kopie außerhalb der CCU.', history),
      panel('So stellst du die vollständige CCU-Sicherung wieder her', null, h('p', { class: 'muted', text: 'Die CCU-Datei „.sbk.enc“ zuerst mit dem Sicherungspasswort entschlüsseln und die „.sbk“ in der OpenCCU unter Einstellungen → Systemsteuerung → Sicherheit → Backup einspielen. Eine vollständige Rücksicherung startet die CCU neu; diese Seite führt sie nicht automatisch aus.' })));
    // Oben: komplettes System (neu-ccu-sicherung.js) und WD-Zugang; die bisherigen Nur-Bridge-Sicherungen eingeklappt darunter
    const ccu = h('div'); if (typeof window.mhCcuSicherung === 'function') window.mhCcuSicherung(ccu);
    main.append(ccu, wdPanel, h('details', { class: 'more', id: 'bridge-sicherung', open: location.hash === '#wiederherstellen' }, h('summary', { text: 'Nur die Matter-Bridge sichern (verschlüsselt, auch Google Drive) – für Fachleute' }), body));
    wiederherstellen(body);
    if (location.hash === '#wiederherstellen') setTimeout(() => document.getElementById('wiederherstellen')?.scrollIntoView(), 300);

    const showGoogle = () => { google.hidden = true; };
    target.addEventListener('change', showGoogle); sc.target.addEventListener('change', showGoogle); showGoogle();
    const scFields = () => { const f = sc.frequency.value; fWeekday.hidden = f !== 'weekly'; fHours.hidden = f !== 'hourly'; fTime.hidden = f === 'hourly'; };
    sc.frequency.addEventListener('change', scFields);
    let pollTimer, jobTimer, lastActivity = 0;
    function renderHistory(list) {
      if (!list || !list.length) { history.replaceChildren(h('div', { class: 'empty', text: 'Noch keine lokalen Sicherungen vorhanden.' })); return; }
      history.replaceChildren(table(['Erstellt', 'Ergebnis', 'Dateien', ''], [...list].reverse().map(job => {
        const remove = job.state === 'running' ? null : h('button', { class: 'btn small danger', type: 'button', text: 'Lokal entfernen' });
        if (remove) remove.addEventListener('click', async () => {
          if (!await confirmDialog({ title: 'Lokale Sicherungsdateien entfernen?', text: 'Die Dateien werden auf der CCU endgültig gelöscht. Vorher herunterladen oder die Kopie auf der WD prüfen. Die Cloud-Kopie bleibt erhalten.', confirm: 'Endgültig entfernen', danger: true })) return;
          remove.disabled = true; try { await api('deleteCloudBackup', { id: job.id, confirmation: 'LOKAL ENTFERNEN ' + job.id }); await status(); } catch (e) { msg(out, e.message, 'bad'); remove.disabled = false; }
        });
        return h('tr', {}, h('td', { text: NEU.fmtDate(job.created) }), h('td', { class: 'muted', text: job.message }),
          h('td', {}, (job.files || []).map(f => h('div', {}, h('a', { href: f.download, text: f.label + ' herunterladen' }), f.url ? h('span', {}, ' · ', h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: 'Drive ↗' })) : null))), h('td', {}, remove));
      })));
    }
    async function status() {
      const d = await api('getBackupStorage');
      gState.textContent = d.google.needsReconnect ? 'Google-Anmeldung abgelaufen oder widerrufen. Bitte erneut verbinden.' : d.google.connected ? 'Google-Verbindung gespeichert. Der Zugriff wird beim Sichern geprüft.' : 'Noch keine Google-Verbindung gespeichert.';
      gLogin.hidden = !!d.google.connected; gLogout.hidden = !d.google.hasStoredConnection;
      if (!gClient.value) gClient.value = d.google.clientId || '';
      gFolder.hidden = !d.google.folderUrl; if (d.google.folderUrl) gFolder.href = d.google.folderUrl;
      native.disabled = sc.native.disabled = !d.nativeAvailable;
      if (!native.dataset.init) { native.checked = !!d.nativeAvailable; native.dataset.init = '1'; }
      nativeHint.textContent = d.nativeAvailable ? 'Native CCU-Sicherung verfügbar.' : 'Eine vollständige CCU-Sicherung ist nur auf der CCU möglich.';
      const list = Object.entries(d.categories).map(([id, name]) => ({ id, name }));
      if (!cats.children.length) boxes(cats, list, true);
      if (!sc.cats.children.length) boxes(sc.cats, list, false);
      renderHistory(d.history || []);
      const job = d.job;
      if (job) {
        msg(out, job.message, job.state === 'running' ? 'busy' : job.state === 'complete' ? 'ok' : undefined); run.disabled = job.state === 'running';
        if (['complete', 'partial'].includes(job.state)) files.replaceChildren(...job.files.map(f => h('p', {}, h('a', { href: f.url || f.download, target: f.url ? '_blank' : undefined, rel: f.url ? 'noopener noreferrer' : undefined, text: f.label + ' · ' + f.name }))));
        if (job.state === 'running') { if (Date.now() - lastActivity > 60000) { lastActivity = Date.now(); await api('webActivity', {}); } clearTimeout(jobTimer); jobTimer = setTimeout(() => status().catch(e => msg(out, e.message, 'bad')), 5000); }
      }
      return d;
    }
    async function schedule() {
      const d = await api('getBackupSchedule', undefined, { errorField: false }), c = d.config;
      sc.enabled.checked = c.enabled; sc.target.value = 'wd'; // einziges Ziel (Google/iCloud entfernt) sc.frequency.value = c.frequency; sc.time.value = c.time; sc.weekday.value = c.weekday; sc.hours.value = c.intervalHours; sc.zone.value = c.timeZone;
      sc.native.checked = c.includeCcu; sc.rotate.checked = c.rotateLocal === true; sc.copies.value = c.localCopies ?? 2;
      for (const i of sc.cats.querySelectorAll('input')) i.checked = c.selected.includes(i.value);
      sc.password.placeholder = d.hasPassword ? 'Passwort gespeichert – leer lassen zum Beibehalten' : 'Mindestens 10 Zeichen';
      msg(scOut, d.error || (c.enabled ? 'Zeitplan aktiv.' : 'Zeitplan ausgeschaltet.'), d.error ? 'bad' : c.enabled ? 'ok' : undefined);
      scInfo.textContent = [d.last ? 'Letzter Lauf: ' + NEU.fmtDate(d.last.at) + ' · ' + d.last.message : '', c.enabled && d.next ? 'Nächster Termin: ' + d.next : ''].filter(Boolean).join(' · ');
      scFields(); showGoogle();
    }
    gLogin.addEventListener('click', () => task(gLogin, null, async () => {
      try {
        const d = await api('startGoogleBackupLogin', { clientId: gClient.value.trim(), clientSecret: gSecret.value }); gSecret.value = '';
        gCode.value = d.userCode; gOpen.href = d.verificationUrl; gQr.replaceChildren(NEU.qrSvg(d.verificationUrl, 'Google-Anmeldeseite als QR-Code')); gCodeBox.hidden = false; gState.textContent = 'Bitte den Code bei Google bestätigen.';
        const poll = async () => { try { const n = await api('pollGoogleBackupLogin', {}); if (n.connected) { gCodeBox.hidden = true; await status(); return; } pollTimer = setTimeout(poll, n.interval * 1000); } catch (e) { gState.textContent = e.message; } };
        pollTimer = setTimeout(poll, d.interval * 1000);
      } catch (e) { gState.textContent = e.message; }
    }));
    gLogout.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Google-Verbindung entfernen?', text: 'Automatische Sicherungen nach Google Drive sind danach nicht mehr möglich. Bereits hochgeladene Dateien bleiben in Google Drive.', confirm: 'Entfernen', danger: true })) return;
      try { clearTimeout(pollTimer); await api('disconnectGoogleBackup', {}); gCodeBox.hidden = true; await status(); } catch (e) { gState.textContent = e.message; }
    });
    run.addEventListener('click', () => task(run, out, async () => {
      const p = { selected: chosen(cats), includeCcu: native.checked, password: spass.value, destination: target.value === 'download' ? 'download' : 'wd' };
      if (p.password.length < 10) throw Error('Sicherungspasswort mit mindestens 10 Zeichen eingeben');
      try { await api('createCloudBackup', p); } finally { p.password = ''; spass.value = ''; }
      files.replaceChildren(); await status(); return 'Sicherung gestartet.';
    }, 'Sicherung wird gestartet …'));
    scForm.addEventListener('submit', e => { e.preventDefault(); if (!scForm.reportValidity()) return; task(scSave, scOut, async () => {
      const config = { enabled: sc.enabled.checked, frequency: sc.frequency.value, time: sc.time.value, weekday: Number(sc.weekday.value), intervalHours: Number(sc.hours.value), timeZone: sc.zone.value, destination: 'wd', includeCcu: sc.native.checked, rotateLocal: false, localCopies: Number(sc.copies.value), selected: chosen(sc.cats) };
      await api('saveBackupSchedule', { config, password: sc.password.value }); sc.password.value = ''; await schedule(); return 'Zeitplan gespeichert.';
    }, 'Wird gespeichert …'); });
    window.addEventListener('pagehide', () => { clearTimeout(pollTimer); clearTimeout(jobTimer); }, { once: true });
    // Wie bisher: ohne Vorab-Sperre laden; lehnt die Bridge ab, Anmeldelink anzeigen.
    status().then(schedule).catch(e => { msg(out, e.message, 'bad'); body.prepend(h('div', { class: 'notice warn' }, h('span', {}, 'Bitte als CCU-Administrator anmelden. ', h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' })))); });
  }
  speicher();
});
