'use strict';
// Seiten „SMART+“ und „Smart Life“ (data-provider="smartplus"|"smartlife"): Geräte aus dem
// Konto übernehmen, für Apple Home freigeben und lokal steuern. Gleiche Bridge-Schnittstellen.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task } = NEU;
  const life = document.documentElement.dataset.provider === 'smartlife';
  const M = m => life ? m.replace('Smartplus', 'Smartlife') : m;
  const main = shell(life
    ? { title: 'Smart Life', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'Smart-Life-WLAN-Leuchten, LED-Streifen, Steckdosen, Schalter und Temperaturfühler in Apple Home. Die Geräte bleiben in der Smart-Life-App eingerichtet.' }
    : { title: 'SMART+', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'LEDVANCE SMART+ WiFi-Leuchten und LED-Streifen in Apple Home. Die Geräte bleiben mit der SMART+-App verbunden.' });
  const sel = (opts, value) => h('select', {}, opts.map(([v, t]) => h('option', { value: v, text: t, selected: String(v) === String(value) })));
  const REGIONS = [['eu', 'Zentraleuropa'], ['eu-west', 'Westeuropa'], ['us', 'Westamerika'], ['us-east', 'Ostamerika'], ['cn', 'China'], ['in', 'Indien'], ['sg', 'Singapur']];
  const COUNTRIES = [['49', 'Deutschland'], ['43', 'Österreich'], ['41', 'Schweiz'], ['44', 'Großbritannien'], ['33', 'Frankreich'], ['31', 'Niederlande'], ['39', 'Italien'], ['34', 'Spanien'], ['1', 'USA / Kanada']];
  const f = life
    ? { accessId: h('input', { required: true, minlength: 8, maxlength: 128, autocomplete: 'off', spellcheck: 'false' }), secret: h('input', { type: 'password', required: true, minlength: 8, maxlength: 128, autocomplete: 'off' }), uid: h('input', { required: true, maxlength: 64, autocomplete: 'off', spellcheck: 'false' }), region: sel(REGIONS, 'eu') }
    : { username: h('input', { type: 'email', required: true, maxlength: 254, autocomplete: 'username' }), secret: h('input', { type: 'password', required: true, maxlength: 1024, autocomplete: 'off' }), country: sel(COUNTRIES, '49') };
  const expose = h('input', { type: 'checkbox', checked: true });
  const importBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Geräte übernehmen' }), savedBtn = h('button', { class: 'btn', type: 'button', text: 'Gespeicherte Zugangsdaten laden' });
  const importOut = h('p', { class: 'msg', role: 'status' });
  const form = h('form', { class: 'form' }, ...(life
    ? [field('Access ID (Tuya-Projektübersicht)', f.accessId), field('Access Secret (Tuya-Projektübersicht)', f.secret), field('UID (Devices → Link App Account)', f.uid), field('Rechenzentrum des Projekts', f.region)]
    : [field('E-Mail der SMART+-App', f.username), field('Passwort der SMART+-App', f.secret), field('Land des Kontos', f.country)]),
    h('div', { class: 'wide' }, check('Online-Geräte gleich für Apple Home freigeben', expose)), h('div', { class: 'wide actions' }, importBtn, savedBtn));
  const list = h('div', { class: 'cards' }), out = h('p', { class: 'msg', role: 'status' }), refresh = h('button', { class: 'btn', type: 'button', text: 'Aktualisieren' });
  const howto = life
    ? panel('1. Konto verknüpfen', 'Einmalig auf der Tuya-Entwicklerplattform.', h('ol', { class: 'steps' },
        h('li', {}, h('span', {}, 'Auf der ', h('a', { href: 'https://platform.tuya.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Tuya-Entwicklerplattform' }), ' ein Smart-Home-Cloud-Projekt anlegen und die Dienste für Geräteabfrage freigeben.')),
        h('li', {}, h('span', {}, 'Unter ', h('b', { text: 'Devices → Link App Account → Add App Account' }), ' den QR-Code mit der Smart-Life-App scannen.')),
        h('li', {}, h('span', { text: 'Access ID, Access Secret und die UID des verknüpften App-Kontos unten eintragen. Der „Project Code“ ist nicht die UID.' }))),
        h('p', { class: 'muted' }, 'Es werden Projektschlüssel verwendet, nicht dein App-Passwort. ', h('a', { href: 'https://developer.tuya.com/en/docs/developer/apply-cloud-api-key?id=Kff30z8sv62ah', target: '_blank', rel: 'noopener noreferrer', text: 'Tuya-Anleitung mit Bildern ↗' })))
    : null;
  main.append(...[howto,
    panel((life ? '2' : '1') + '. Geräte übernehmen', life ? 'Lampen und Steckdosen steuert die Bridge danach lokal im WLAN; Temperaturfühler können über die Cloud abgefragt werden.' : 'Die Bridge speichert die Geräteschlüssel, nicht dein Kontopasswort. Danach erfolgt die Steuerung lokal im WLAN.', form, importOut,
      h('p', { class: 'muted', text: life ? 'Nicht enthalten: Heizgeräte, Schlösser, Zigbee-/Bluetooth-Untergeräte. Batteriegeräte müssen für die lokale Abfrage wach sein.' : 'Die Anmeldung nutzt eine inoffizielle LEDVANCE-Schnittstelle und kann je nach Konto abgelehnt werden.' })),
    panel((life ? '3' : '2') + '. Deine Geräte', 'Freigeben und speichern – die Geräte erscheinen dann an der bereits gekoppelten Bridge in Apple Home. Dafür startet die Bridge kurz neu.', h('div', { class: 'actions' }, refresh, h('a', { class: 'btn', href: life ? '/smartplus.html' : '/smartlife.html', text: life ? 'Zu SMART+' : 'Zu Smart Life' })), out, list)].filter(Boolean));

  // Tuya-Zugang: Ablaufdatum eintragen → Erinnerung 14 Tage vorher per WhatsApp (Thomas 13.10.2026). Verlängern kann nur Thomas selbst.
  if (life) {
    const date = h('input', { type: 'date' }), saveDate = h('button', { class: 'btn', type: 'button', text: 'Speichern' }), dateOut = h('p', { class: 'msg', role: 'status' }), dateInfo = h('div');
    const showDate = s => { date.value = s.ablauf || ''; dateInfo.replaceChildren(s.ablauf ? h('div', { class: 'notice' + (s.bald ? ' bad' : ''), text: (s.tageRest < 0 ? '⚠ Abgelaufen am ' : s.bald ? '⚠ Läuft bald ab: ' : 'Gültig bis ') + s.ablauf.split('-').reverse().join('.') + (s.tageRest >= 0 ? ' (noch ' + s.tageRest + (s.tageRest === 1 ? ' Tag)' : ' Tage)') : '') }) : h('p', { class: 'muted', text: 'Noch kein Ablaufdatum eingetragen.' })); };
    saveDate.addEventListener('click', () => task(saveDate, dateOut, async () => { const r = await api('saveTuyaAblauf', { ablauf: date.value }); showDate(r); return r.message; }));
    main.append(panel('Tuya-Zugang (kostenlos, läuft regelmäßig ab)', 'Die Fühler ohne WLAN-Verbindung (z. B. Außenfühler, Bad Sensor) brauchen den Tuya-Zugang. Er läuft alle paar Monate ab und muss von Hand verlängert werden.',
      h('ol', { class: 'steps' }, h('li', {}, h('span', {}, 'Auf ', h('a', { href: 'https://iot.tuya.com/', target: '_blank', rel: 'noopener noreferrer', text: 'iot.tuya.com' }), ' anmelden → Cloud → Cloud Services → IoT Core: dort steht das Ablaufdatum.')), h('li', {}, h('span', { text: 'Das Datum hier eintragen. 14 Tage vorher kommt eine WhatsApp.' })), h('li', {}, h('span', { text: 'Verlängern mit „Extend Trial Period“ (kostenlos, Freigabe dauert etwa einen Tag), dann das neue Datum eintragen.' }))),
      dateInfo, h('div', { class: 'row' }, field('Tuya-Zugang gültig bis', date), saveDate), dateOut));
    api('getTuyaAblauf').then(showDate).catch(() => {});
  }
  async function loadSaved(show) {
    const d = await api('backupAccounts'), a = d.accounts && d.accounts[life ? 'smartlife' : 'smartplus'];
    if (!a || !Object.keys(a).length) { if (show) throw Error('Noch keine Zugangsdaten gespeichert'); return; }
    if (life) { if (a.accessId !== undefined) f.accessId.value = a.accessId; if (a.uid !== undefined) f.uid.value = a.uid; if (a.region !== undefined) f.region.value = a.region; }
    else { if (a.username !== undefined) f.username.value = a.username; if (a.countryCode !== undefined) f.country.value = a.countryCode; }
    if (a.hasSecret === true) { f.secret.required = false; f.secret.placeholder = 'Gespeichert – leer lassen zum Wiederverwenden'; }
    if (show) return 'Gespeicherte Zugangsdaten geladen.';
  }
  savedBtn.addEventListener('click', () => task(savedBtn, importOut, () => loadSaved(true)));
  form.addEventListener('submit', e => {
    e.preventDefault(); if (!form.reportValidity()) return;
    const p = life ? { accessId: f.accessId.value.trim(), accessSecret: f.secret.value, uid: f.uid.value.trim(), region: f.region.value } : { username: f.username.value, password: f.secret.value, countryCode: Number(f.country.value) };
    if (expose.checked) p.autoExposeOnline = true;
    f.secret.value = '';
    task(importBtn, importOut, async () => {
      try { const d = await api(M('importSmartplus'), p); f.secret.required = false; f.secret.placeholder = 'Gespeichert – leer lassen zum Wiederverwenden'; await load(true); return d.message + (d.unsupported ? ' ' + d.unsupported + ' Geräte nicht unterstützt.' : ''); }
      finally { if (life) p.accessSecret = ''; else p.password = ''; }
    }, 'Konto wird abgefragt; bitte warten …');
  });

  const hsvHex = (hue, s) => { const c = s / 100, x = c * (1 - Math.abs(hue / 60 % 2 - 1)), m = 1 - c, p = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x]; return '#' + p.map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join(''); };
  const hexHsv = hex => { const [r, g, b] = hex.match(/[a-f\d]{2}/gi).map(n => parseInt(n, 16) / 255), max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min; const hue = d === 0 ? 0 : max === r ? 60 * ((g - b) / d % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4); return { hue: (hue + 360) % 360, saturation: max ? d / max * 100 : 0 }; };
  let loading = false, pending = 0, drafts = [];
  function card(dev) {
    const caps = dev.capabilities || {}, st = dev.state || {}, cardMsg = h('p', { class: 'msg', role: 'status' });
    const controls = h('div', { class: 'row' });
    const send = async command => {
      if (controls.dataset.pending === 'true') return; controls.dataset.pending = 'true'; pending++;
      const inputs = [...controls.querySelectorAll('input,button,select')], was = inputs.map(i => i.disabled); inputs.forEach(i => { i.disabled = true; });
      try { const d = await api(M('controlSmartplus'), { id: dev.id, command }); msg(cardMsg, d.message, 'ok'); dev.state = d.state; }
      catch (e) { msg(cardMsg, e.message, 'bad'); } finally { inputs.forEach((i, n) => { i.disabled = was[n]; }); controls.dataset.pending = 'false'; pending--; }
    };
    if (caps.kind !== 'sensor') for (const [t, on] of [['Ein', true], ['Aus', false]]) { const b = h('button', { class: 'btn small' + (on ? ' primary' : ''), type: 'button', text: t, disabled: !dev.online }); b.addEventListener('click', () => send({ on })); controls.append(b); }
    // Eigener USB-Schalter der Steckdose (USB-Anschlüsse getrennt schaltbar)
    if (caps.usb) { const usbText = s => 'USB: ' + (s && s.usb === true ? 'an' : s && s.usb === false ? 'aus' : '?'), label = h('span', { class: 'muted', text: usbText(st) }); controls.append(label); for (const [t, usb] of [['USB ein', true], ['USB aus', false]]) { const b = h('button', { class: 'btn small', type: 'button', text: t, disabled: !dev.online }); b.addEventListener('click', () => send({ usb }).then(() => { label.textContent = usbText(dev.state); })); controls.append(b); } }
    if (caps.brightness) { const range = h('input', { type: 'range', min: 1, max: 100, value: Math.round(st.brightness || 100), disabled: !dev.online, 'aria-label': 'Helligkeit', style: 'accent-color:#176c60' }), val = h('span', { class: 'muted', text: range.value + ' %' }); range.addEventListener('input', () => { val.textContent = range.value + ' %'; }); range.addEventListener('change', () => send({ brightness: Number(range.value) })); controls.append(h('label', { class: 'row' }, 'Helligkeit', range, val)); }
    if (caps.color) { const color = h('input', { type: 'color', value: hsvHex(st.hue || 0, st.saturation || 0), disabled: !dev.online, 'aria-label': 'Farbe' }); color.addEventListener('change', () => send({ ...hexHsv(color.value), brightness: (dev.state && dev.state.brightness) || 100 })); controls.append(h('label', { class: 'row' }, 'Farbe', color)); }
    if (caps.temperature) { const t = h('input', { type: 'number', min: caps.minKelvin, max: caps.maxKelvin, step: 50, value: st.kelvin || caps.minKelvin, disabled: !dev.online, style: 'max-width:110px', 'aria-label': 'Weißtemperatur in Kelvin' }), b = h('button', { class: 'btn small', type: 'button', text: 'Weiß setzen', disabled: !dev.online }); b.addEventListener('click', () => { if (t.reportValidity()) send({ kelvin: Number(t.value) }); }); controls.append(h('label', { class: 'row' }, 'K', t), b); }
    if (caps.kind === 'cooler') for (const [key, title] of [['leftTarget', 'Soll links °C'], ['rightTarget', 'Soll rechts °C']]) { const r = caps.readings && caps.readings[key]; if (!r) continue; const div = 10 ** (r.scale || 0), i = h('input', { type: 'number', min: r.min / div, max: r.max / div, step: (r.step || 1) / div, value: st[key], disabled: !dev.online, style: 'max-width:90px', 'aria-label': title }), b = h('button', { class: 'btn small', type: 'button', text: 'Übernehmen', disabled: !dev.online }); b.addEventListener('click', () => { if (i.value !== '' && i.reportValidity()) send({ [key]: Number(i.value) }); }); controls.append(h('label', { class: 'row' }, title, i), b); }
    const unit = { humidity: ' %', power: ' W', voltage: ' V', current: ' A' };
    const readings = [['temperature', 'Temperatur'], ['humidity', 'Feuchtigkeit'], ['leftTemperature', 'Temperatur links'], ['rightTemperature', 'Temperatur rechts'], ['power', 'Leistung'], ['voltage', 'Spannung'], ['current', 'Strom']].filter(([k]) => caps.readings && caps.readings[k]).map(([k, t]) => t + ': ' + (Number.isFinite(st[k]) ? st[k] + (unit[k] || ' °C') : 'noch kein Messwert'));
    // Einstellungen
    const name = h('input', { value: dev.name, maxlength: 64, 'aria-label': 'Name' }), exposed = h('input', { type: 'checkbox', checked: dev.exposed }), monitor = h('input', { type: 'checkbox', checked: dev.onlineCheck !== false });
    const ip = h('input', { value: dev.ip || '', placeholder: '192.168.… (leer = automatisch)' }), version = sel(['3.1', '3.3', '3.4', '3.5'].map(v => [v, v]), dev.version);
    const kmin = caps.temperature ? h('input', { type: 'number', min: 2000, max: 10000, value: caps.minKelvin }) : null, kmax = caps.temperature ? h('input', { type: 'number', min: 2000, max: 10000, value: caps.maxKelvin }) : null;
    drafts.push(() => name.value !== dev.name || ip.value !== (dev.ip || '') || version.value !== dev.version || exposed.checked !== dev.exposed || monitor.checked !== (dev.onlineCheck !== false) || (kmin && (Number(kmin.value) !== caps.minKelvin || Number(kmax.value) !== caps.maxKelvin)));
    const save = h('button', { class: 'btn small primary', type: 'button', text: 'Einstellungen speichern' });
    save.addEventListener('click', () => task(save, cardMsg, async () => { const p = { id: dev.id, name: name.value, ip: ip.value.trim(), version: version.value, exposed: exposed.checked, onlineCheck: monitor.checked }; if (kmin) Object.assign(p, { minKelvin: Number(kmin.value), maxKelvin: Number(kmax.value) }); const d = await api(M('saveSmartplusDevice'), p); await load(true); return d.message; }, 'Wird gespeichert …'));
    const where = dev.online ? (dev.readingSource === 'cloud' ? 'über Cloud erreichbar' : 'im WLAN verbunden') : 'nicht erreichbar';
    let cloud = null;
    if (caps.kind === 'sensor' && dev.cloudQueriedAt) { const q = new Date(dev.cloudQueriedAt), m = new Date(dev.cloudMeasuredAt || ''); if (Number.isFinite(q.getTime())) cloud = h('small', { class: 'muted', text: (dev.cloudFailed ? 'Cloud-Abfrage fehlgeschlagen · ' : 'Cloud zuletzt abgefragt: ') + q.toLocaleString('de-DE') + (Number.isFinite(m.getTime()) ? ' · Messwert vom ' + m.toLocaleString('de-DE') : '') }); }
    return h('article', { class: 'card' },
      h('div', { class: 'card-head' }, h('b', { text: dev.name }), h('span', { class: 'tag ' + (dev.online ? 'ok' : 'bad'), text: where })),
      h('div', {}, h('span', { class: 'tag ' + (dev.exposed ? 'ok' : ''), text: dev.exposed ? 'in Apple Home' : 'nicht freigegeben' })),
      readings.length ? h('div', {}, readings.map(r => h('div', { text: r }))) : null, cloud,
      controls.children.length ? controls : null, cardMsg,
      h('details', { class: 'more' }, h('summary', { text: 'Name, Freigabe und Verbindung' }),
        field('Name', name), h('div', { class: 'checks' }, check('In Apple Home (Matter)', exposed), check('Online prüfen / WhatsApp bei Offline', monitor)),
        h('div', { class: 'form' }, field('WLAN-Adresse', ip), field('Geräteprotokoll', version), kmin ? field('Warmweiß laut Hersteller (K)', kmin) : null, kmax ? field('Kaltweiß laut Hersteller (K)', kmax) : null),
        h('div', { class: 'actions' }, save), h('small', { class: 'muted', text: 'Geräte-ID: ' + dev.id })),
      caps.kind === 'cooler' ? h('small', { class: 'muted', text: 'Kühlboxen benötigen ein lokal erreichbares Tuya-WLAN-Gerät; reine Bluetooth-Kühlboxen werden nicht unterstützt.' }) : null);
  }
  async function load(force) {
    if (loading || (!force && pending)) return; loading = true;
    try { const d = await api(M('getSmartplusDevices')); drafts = []; list.replaceChildren(...(d.devices.some(x => x.tuyaExpired) ? [h('div', { class: 'notice bad', text: '⚠ Der kostenlose Tuya-Zugang ist abgelaufen – Fühler ohne WLAN-Verbindung (z. B. Außenfühler, Bad Sensor) liefern keine Werte mehr. Kostenlos verlängern: iot.tuya.com → Cloud → Cloud Services → IoT Core → „Extend Trial Period“.' })] : []), ...(d.devices.length ? d.devices.map(card) : [h('div', { class: 'empty', text: 'Noch keine Geräte übernommen.' })])); }
    catch (e) { msg(out, e.message, 'bad'); } finally { loading = false; }
  }
  refresh.addEventListener('click', () => load(true));
  load(true); loadSaved(false).catch(() => {});
  // Keine automatische Neuanzeige, solange etwas bearbeitet wird.
  setInterval(() => { if (!document.hidden && !drafts.some(d => d()) && !(list.contains(document.activeElement) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName))) load(); }, 15000);
});
