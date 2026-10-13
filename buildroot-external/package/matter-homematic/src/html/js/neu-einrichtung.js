'use strict';
// Seite „Einrichtung (neue CCU3)“ (Wunsch Thomas, 12.10.2026): alles, was bei einer neu aufgesetzten CCU3 einzutragen ist –
// in sinnvoller Reihenfolge, je Schritt: was eintragen, Adresse der Seite, Knopf „Öffnen“ und ob es schon erledigt ist.
// Nur lesen: der Zustand kommt aus denselben Abfragen wie die jeweiligen Seiten; Geheimnisse werden nie angezeigt.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, task } = NEU;
  // Direkt eintragen (Wunsch Thomas): kleine Formulare mit denselben Speicher-Abfragen wie die Fachseiten.
  // Passwörter/Schlüssel tippt der Benutzer selbst; sie werden nach dem Senden geleert und nie wieder angezeigt.
  const inp = (attrs = {}) => h('input', { autocomplete: 'off', spellcheck: 'false', ...attrs });
  function quick(fields, buttons, hint) {
    const out = h('p', { class: 'msg', role: 'status' }), btns = buttons.map(([text, run, cls]) => { const b = h('button', { class: 'btn small ' + (cls || ''), type: 'button', text }); b.addEventListener('click', () => task(b, out, async () => { try { const m = await run(); setTimeout(() => window.mhSetupRun?.(), 300); return m || 'Gespeichert.'; } finally { for (const [, el] of fields) if (el.type === 'password') el.value = ''; } }, 'Wird ausgeführt …')); return b; });
    return h('details', { class: 'more setup-form' }, h('summary', { text: fields.length ? '✎ Hier eintragen' : 'Per Knopf erledigen' }), hint ? h('p', { class: 'muted small', text: hint }) : null, fields.length ? h('div', { class: 'form' }, ...fields.map(([label, el]) => field(label, el))) : null, h('div', { class: 'actions' }, ...btns), out);
  }
  const need = (el, what) => { const v = el.value.trim(); if (!v) throw Error('Bitte ' + what + ' eintragen.'); return v; };
  const FORMS = {
    zeit: () => { let tz = 'Europe/Berlin'; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz; } catch {}
      const f = { tz: inp({ value: tz }), city: inp({ placeholder: 'Ort' }), country: inp({ value: 'DE', maxlength: 2 }), lat: inp({ inputmode: 'decimal', placeholder: 'z. B. 47,61' }), lon: inp({ inputmode: 'decimal', placeholder: 'z. B. 7,66' }) };
      const geo = () => new Promise((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => { f.lat.value = p.coords.latitude.toFixed(4); f.lon.value = p.coords.longitude.toFixed(4); ok('Standort des Geräts übernommen – jetzt speichern.'); }, () => no(Error('Standort nicht freigegeben – bitte von Hand eintragen.')), { timeout: 15000 }) : no(Error('Kein Standort verfügbar.')));
      const n = el => Number(String(el.value).replace(',', '.'));
      return quick([['Zeitzone', f.tz], ['Ort', f.city], ['Land (2 Buchstaben)', f.country], ['Breitengrad', f.lat], ['Längengrad', f.lon]],
        [['📍 Standort dieses Geräts', geo], ['Speichern', async () => { if (!Number.isFinite(n(f.lat)) || !Number.isFinite(n(f.lon)) || f.lat.value === '' || f.lon.value === '') throw Error('Bitte Breiten- und Längengrad eintragen.'); return (await api('saveZeitStandort', { timezone: need(f.tz, 'die Zeitzone'), country: f.country.value.trim(), city: f.city.value.trim(), lat: n(f.lat), lon: n(f.lon) })).message; }, 'primary']]); },
    whatsapp: () => { const f = { phone: inp({ type: 'tel', placeholder: '+49…', maxlength: 16 }), key: inp({ type: 'password', placeholder: 'CallMeBot-Schlüssel' }) };
      return quick([['Handynummer mit Landesvorwahl', f.phone], ['CallMeBot-API-Schlüssel', f.key]],
        [['Speichern', async () => { const p = { enabled: true, phone: need(f.phone, 'die Handynummer'), apiKey: f.key.value.trim(), delaySeconds: 0 }; await api('saveNotifications', p); return 'WhatsApp gespeichert.'; }, 'primary'], ['Testnachricht', async () => (await api('testNotification', {})).message]],
        'Den CallMeBot-Schlüssel bekommst du kostenlos über die Anleitung auf callmebot.com (WhatsApp). Schlüssel leer lassen = gespeicherten behalten.'); },
    wd: () => { const f = { host: inp({ placeholder: 'z. B. 192.168.50.10' }), share: inp({ value: 'ccu3-sicherung' }), folder: inp({ value: 'ccu3' }), user: inp({ placeholder: 'WD-Benutzer' }), pass: inp({ type: 'password', autocomplete: 'new-password' }) };
      api('getNetStorage').then(d => { const s = d?.settings; if (!s) return; if (s.host) f.host.value = s.host; if (s.share) f.share.value = s.share; if (s.folder) f.folder.value = s.folder; if (s.user) f.user.value = s.user; if (s.hasPassword) f.pass.placeholder = 'gespeichert – leer lassen'; }).catch(() => {});
      const p = () => ({ enabled: true, host: need(f.host, 'die Adresse der WD'), share: need(f.share, 'die Freigabe'), folder: f.folder.value.trim() || 'ccu3', user: need(f.user, 'den Benutzer'), password: f.pass.value, intervalMinutes: 10, recordLocal: true });
      return quick([['Adresse der WD', f.host], ['Freigabe', f.share], ['Unterordner', f.folder], ['Benutzer', f.user], ['Passwort', f.pass]],
        [['Verbindung testen', async () => { const r = await api('testNetStorage', p()); const bad = (r.steps || []).filter(s => s.ok === false).map(s => s.label + ': ' + (s.detail || 'fehlgeschlagen')); return r.message + (bad.length ? ' – ' + bad.join('; ') : ''); }], ['Speichern', async () => (await api('saveNetStorage', p())).message, 'primary']],
        'Freigabe und Benutzer vorher in der WD-Oberfläche anlegen (öffentlicher Zugriff aus).'); },
    jeep: () => { const f = { email: inp({ type: 'email', autocomplete: 'username' }), pass: inp({ type: 'password', autocomplete: 'current-password' }) };
      return quick([['E-Mail der Jeep-App', f.email], ['Passwort der Jeep-App', f.pass]], [['Mit Jeep verbinden', async () => { const p = { email: need(f.email, 'die E-Mail'), password: f.pass.value }; if (!p.password) throw Error('Bitte das Passwort eintragen.'); f.pass.value = ''; try { await api('loginJeep', p); } finally { p.password = ''; } return 'Mit Jeep verbunden.'; }, 'primary']]); },
    pin: () => { const pin = inp({ type: 'password', inputmode: 'numeric', maxlength: 4, placeholder: '4 Ziffern' });
      return quick([['Uconnect-PIN', pin]], [['PIN speichern', async () => { if (!/^\d{4}$/.test(pin.value)) throw Error('Die PIN hat 4 Ziffern.'); const cur = await api('getJeepRefresh').catch(() => ({})); const r = await api('saveJeepRefresh', { enabled: cur.enabled !== false, hours: Number(cur.hours) || 4, pin: pin.value }); pin.value = ''; return r.message; }, 'primary']]); },
    smartlife: () => { const f = { id: inp({ placeholder: 'Access ID' }), secret: inp({ type: 'password', placeholder: 'Access Secret' }), uid: inp({ placeholder: 'UID des App-Kontos' }), region: h('select', {}, [['eu', 'Zentraleuropa'], ['eu-west', 'Westeuropa'], ['us', 'Westamerika'], ['us-east', 'Ostamerika'], ['cn', 'China'], ['in', 'Indien'], ['sg', 'Singapur']].map(([v, t]) => h('option', { value: v, text: t }))) };
      return quick([['Access ID', f.id], ['Access Secret', f.secret], ['UID', f.uid], ['Rechenzentrum', f.region]], [['Geräte übernehmen', async () => { const p = { accessId: need(f.id, 'die Access ID'), accessSecret: f.secret.value, uid: need(f.uid, 'die UID'), region: f.region.value, autoExposeOnline: true }; f.secret.value = ''; try { return (await api('importSmartlife', p)).message; } finally { p.accessSecret = ''; } }, 'primary']],
        'Aus der Tuya-Entwicklerplattform (Projektübersicht und Devices → Link App Account). Secret leer lassen = gespeichertes verwenden.'); },
    smartplus: () => { const f = { user: inp({ type: 'email', autocomplete: 'username' }), pass: inp({ type: 'password' }) };
      return quick([['E-Mail der SMART+-App', f.user], ['Passwort der SMART+-App', f.pass]], [['Geräte übernehmen', async () => { const p = { username: need(f.user, 'die E-Mail'), password: f.pass.value, countryCode: 49, autoExposeOnline: true }; f.pass.value = ''; try { return (await api('importSmartplus', p)).message; } finally { p.password = ''; } }, 'primary']]); },
    // Ein-Klick-Schritte (Wunsch Thomas): ohne Eingabe, nur ein Knopf
    sicherung: () => quick([], [['Jetzt eine Sicherung erstellen', async () => { await api('createCcuSicherung', { bestaetigt: true }); return 'Sicherung wird erstellt (dauert einige Minuten) – Herunterladen auf der Seite „CCU-Sicherung“.'; }, 'primary']]),
    ladeplatz: () => quick([], [['📍 Aktuellen Jeep-Standort als Ladeplatz übernehmen', async () => (await api('setJeepLadeplatz', {})).message, 'primary']], 'Nur drücken, während der Jeep an seinem Ladeplatz steht. Danach unter Automationen → Jeep laden die Häkchen für automatisch ein/aus setzen.'),
    ki: () => { const key = inp({ type: 'password', placeholder: 'Gemini-Schlüssel' });
      return quick([['Gemini-API-Schlüssel', key]], [['Speichern und einschalten', async () => { const r = await api('saveAssistent', { enabled: true, key: need(key, 'den Schlüssel') }); key.value = ''; return r.message || 'KI eingerichtet.'; }, 'primary']], 'Kostenlos auf aistudio.google.com → „Get API key“.'); }
  };
  const main = shell({ title: 'Einrichtung (neue CCU3)', eyebrow: 'System', lead: 'Alles, was nach dem Aufsetzen einer neuen CCU3 eingetragen werden muss – Schritt für Schritt mit Adresse und Knopf. Grün = erledigt.' });
  const get = (m, q) => (q ? api(m, undefined, { query: q }) : api(m)).catch(() => null);
  const len = v => Array.isArray(v) ? v.length : 0;
  // [Gruppe, Titel, was eintragen, Seite, Zustandsprüfung (true = erledigt, false = offen, null = von Hand prüfen)]
  const STEPS = [
    ['Grundlagen', 'Als Administrator anmelden', 'Mit dem Administrator-Zugang der CCU anmelden (oben rechts). Ohne Anmeldung sind die meisten Einstellungen gesperrt.', '/login.html?admin=1', async () => { const s = await NEU.ensureSession().catch(() => null); return s ? s.admin === true : null; }],
    ['Grundlagen', 'Zeit & Standort', 'Zeitzone und Standort (Ort/PLZ) – für Sonnenauf-/-untergang, Wetter und „nur wenn dunkel“.', '/zeit.html', async () => { const d = await get('getZeitStandort'); return d ? Number.isFinite(d.lat) && Number.isFinite(d.lon) && !!d.timezone : null; }],
    ['Grundlagen', 'Netzwerk prüfen', 'Feste IP-Adresse der CCU (z. B. 192.168.50.22), Gateway, DNS. Nur ändern, wenn nötig.', '/netzwerk.html', null],
    ['Grundlagen', 'Benutzer anlegen', 'Eigene Benutzer für Familie/Handy mit passender Rolle (Ansehen/Bedienen). Passwörter tippt jeder selbst.', '/konto.html#benutzer', async () => { const d = await get('getBenutzer'); return d ? len(d.users || d.benutzer) > 0 : null; }],
    ['Apple Home', 'Bridge mit Apple Home koppeln', 'In der Home-App „Gerät hinzufügen“ und den QR-Code bzw. Kopplungscode dieser Seite scannen. Nur einmal nötig.', '/apple-home.html', async () => { const d = await get('getBridgeStatus'); if (!d) return null; const f = d.commissioned ?? d.paired ?? (Number.isFinite(d.fabricCount) ? d.fabricCount > 0 : Number.isFinite(d.fabrics) ? d.fabrics > 0 : null); return typeof f === 'boolean' ? f : null; }],
    ['Zuhause', 'Geräte anlernen', 'Homematic-(IP-)Geräte anlernen; danach Namen vergeben.', '/anlernen.html', null],
    ['Zuhause', 'Räume und Gewerke', 'Räume anlegen und Geräte zuordnen; Gewerke (Licht, Heizung …) zuordnen.', '/raeume.html', async () => { const d = await get('getRaumZuordnung'); return d ? Object.keys(d.assign || {}).length > 0 || len(d.rooms) > 0 : null; }],
    ['Zuhause', 'Handy-Seite einrichten', 'Auf dem iPhone /mobil.html öffnen, „Zum Home-Bildschirm“ hinzufügen und über ☰ die Geräte auswählen.', '/mobil.html', async () => { const d = await get('getFavoriten'); return d ? (d.lists || []).some(l => l.name === 'Handy' && len(l.items)) : null; }],
    ['Benachrichtigung & Sicherung', 'WhatsApp (Dienste & WhatsApp)', 'Handynummer mit Landesvorwahl und CallMeBot-API-Schlüssel; „Testnachricht“ senden. Wird für Ausfall-, Anmelde- und Lade-Meldungen genutzt.', '/services.html', async () => { const d = await get('getServiceStatus'); const s = d?.settings; return s ? !!(s.enabled && s.phone && s.hasKey) : null; }],
    ['Benachrichtigung & Sicherung', 'WD (Netzspeicher) verbinden', 'Adresse der WD, Freigabe (z. B. ccu3-sicherung), Benutzer und Passwort – Passwort tippst du selbst. „Verbindung testen“.', '/backup-storage.html', async () => { const d = await get('getNetStorage'); const s = d?.settings || d; return s ? !!(s.enabled && s.host) : null; }],
    ['Benachrichtigung & Sicherung', 'Komplette Sicherung & Zeitplan', 'Erste Sicherung des kompletten Systems erstellen und einen Zeitplan einschalten; mit verbundener WD kommt jede Sicherung automatisch auch dorthin.', '/backup-storage.html', async () => { const d = await get('getCcuSicherungen'); return d ? len(d.sicherungen || d.files || d.list) > 0 : null; }],
    ['Zugang & Sicherheit', 'Firewall', 'Zugriffe auf Heimnetz beschränken (Voreinstellung prüfen).', '/firewall.html', null],
    ['Zugang & Sicherheit', 'Fernzugriff (Tailscale)', 'Tailscale anmelden, damit Handy und Kurzbefehle auch unterwegs die CCU erreichen.', '/remote-access.html', null],
    ['Zugang & Sicherheit', 'SSH-Zugang', 'SSH ein/aus; für Notfälle und Installationen.', '/ssh.html', null],
    ['Integrationen', 'Tasmota-Steckdosen', 'Steckdosen suchen bzw. IP eintragen, Namen und Räume vergeben, in Apple Home freigeben.', '/tasmota.html', async () => { const d = await get('getTasmotaDevices'); return d ? len(d.hosts || d.devices) > 0 : null; }],
    ['Integrationen', 'Smart Life', 'Tuya-Zugang (Access ID/Secret, Region) einmal eintragen, „Geräte übernehmen“. Danach steuert die Bridge lokal.', '/smartlife.html', async () => { const d = await get('getSmartlifeDevices'); return d ? len(d.devices) > 0 : null; }],
    ['Integrationen', 'SMART+ (LEDVANCE)', 'Lampen übernehmen (lokal, wie Smart Life).', '/smartplus.html', async () => { const d = await get('getSmartplusDevices'); return d ? len(d.devices) > 0 : null; }],
    ['Integrationen', 'Dyson', 'Dyson-Konto verbinden, Gerät übernehmen.', '/dyson.html', async () => { const d = await get('getDysonDevices'); return d ? len(d.devices) > 0 : null; }],
    ['Jeep', 'Jeep-Konto verbinden', 'E-Mail und Passwort der Jeep-App (tippst du selbst) – danach verbindet sich die Bridge nach jedem Neustart automatisch.', '/jeep.html', async () => { const d = await get('getJeepOverview'); return d ? d.connected === true : null; }],
    ['Jeep', 'Uconnect-PIN speichern', '4-stellige PIN der Jeep-App (tippst du selbst) – für Türen, Klima, Lichter und das Aktualisieren der Fahrzeugdaten.', '/jeep.html', async () => { const d = await get('getJeepRefresh'); return d ? d.hasPin === true : null; }],
    ['Jeep', 'Ladeplatz festlegen', 'Den Ort, an dem der Jeep lädt (± 100 m) – für „automatisch ein, wenn eingesteckt“ und „aus, wenn weggefahren“.', '/automationen.html', async () => { const d = await get('getJeepLaden'); return d?.settings ? d.settings.homeSet === true : null; }],
    ['Jeep', 'Jeep laden (Steckdose, Ladeplatz, Strompreis)', 'Jeep-Steckdose wählen, Strompreis (z. B. 0,3088 €/kWh naturenergie), „Ladeplatz übernehmen“ wenn der Jeep zu Hause steht, Häkchen für automatisch ein/aus.', '/automationen.html', async () => { const d = await get('getJeepLaden'); const s = d?.settings; return s ? !!(s.socket && s.homeSet) : null; }],
    ['Komfort', 'KI-Assistent', 'Kostenlosen Gemini-Schlüssel eintragen (aistudio.google.com → „Get API key“). Optional.', '/automationen.html', async () => { const d = await get('getAssistent'); return d ? d.ki?.hasKey === true : null; }],
    ['Komfort', 'Automationen', 'Eigene Regeln anlegen oder Vorlagen nutzen (Licht bei Bewegung, Zeitschaltung …).', '/automationen.html', null]
  ];
  const sum = h('p', { class: 'muted' }), groups = new Map();
  for (const [g] of STEPS) if (!groups.has(g)) groups.set(g, h('div', { class: 'setup-list' }));
  main.append(panel('Stand', 'Grün = erledigt, Grau = noch offen, „von Hand prüfen“ = lässt sich nicht automatisch erkennen.', sum, h('button', { class: 'btn small', type: 'button', text: 'Neu prüfen', onclick: () => run() })),
    ...[...groups].map(([g, box]) => panel(g, null, box)));
  const origin = location.origin;
  const FORM_OF = { 'Zeit & Standort': 'zeit', 'WhatsApp (Dienste & WhatsApp)': 'whatsapp', 'WD (Netzspeicher) verbinden': 'wd', 'Jeep-Konto verbinden': 'jeep', 'Uconnect-PIN speichern': 'pin', 'Smart Life': 'smartlife', 'SMART+ (LEDVANCE)': 'smartplus', 'KI-Assistent': 'ki', 'Komplette Sicherung & Zeitplan': 'sicherung', 'Ladeplatz festlegen': 'ladeplatz' };
  // Einmal aufbauen (Eingaben bleiben stehen); „Neu prüfen“ und jedes Speichern aktualisieren nur die Zustände.
  const tags = [];
  STEPS.forEach(([g, title, what, href, check], i) => {
    const tag = h('span', { class: 'tag', text: check ? 'wird geprüft …' : 'von Hand prüfen' }); tags.push([tag, check]);
    groups.get(g).append(h('div', { class: 'setup-step' },
      h('div', { class: 'setup-head' }, h('b', { text: (i + 1) + '. ' + title }), tag),
      h('p', { text: what }),
      h('div', { class: 'row' }, h('code', { class: 'mono', text: origin + href }), h('a', { class: 'btn small', href, text: 'Seite öffnen' })),
      FORM_OF[title] ? FORMS[FORM_OF[title]]() : null));
  });
  async function run() {
    let done = 0, open = 0; sum.textContent = 'Wird geprüft …';
    await Promise.all(tags.map(async ([tag, check]) => {
      if (!check) return;
      let v = null; try { v = await check(); } catch {}
      if (v === true) { tag.className = 'tag ok'; tag.textContent = '✓ erledigt'; done++; } else if (v === false) { tag.className = 'tag'; tag.textContent = 'offen'; open++; } else { tag.className = 'tag'; tag.textContent = 'von Hand prüfen'; }
    }));
    sum.textContent = done + ' erledigt · ' + open + ' offen · ' + STEPS.length + ' Schritte';
  }
  window.mhSetupRun = run;
  run();
});
