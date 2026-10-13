'use strict';
// Seite „Jeep“: Fahrzeugdaten (nur lesen), Datenauswahl und Matter-Freigabe in einem Skript.
// Gleiche Bridge-Schnittstellen wie die bisherigen drei Jeep-Skripte.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, confirmDialog } = NEU;
  const main = shell({ title: 'Jeep', eyebrow: 'Integrationen', crumb: 'Integrationen', lead: 'Batteriestand und Reichweiten deines Jeep Compass 4xe, dazu Fernsteuerung von Klima, Motor und Türen.' });
  const LONG = { signal: undefined };
  // Herstellermeldungen (Uconnect) auf Deutsch
  const JEEP_DE = { CHARGING: 'wird geladen', NOT_CHARGING: 'lädt nicht', CHARGE_FAULT: 'Ladefehler gemeldet', FULLY_CHARGED: 'voll geladen', CHARGE_COMPLETE: 'Laden abgeschlossen', CHARGING_COMPLETE: 'Laden abgeschlossen',
    WAITING_TO_CHARGE: 'wartet auf Ladestart', SCHEDULED: 'Laden geplant', CHARGE_SCHEDULED: 'Laden geplant', PLUGGED_IN: 'eingesteckt', PLUGGED: 'eingesteckt', UNPLUGGED: 'nicht eingesteckt', NOT_PLUGGED_IN: 'nicht eingesteckt', DISCONNECTED: 'nicht eingesteckt', CONNECTED: 'eingesteckt',
    LEVEL_1: 'Laden Stufe 1 (Haushaltssteckdose)', LEVEL_2: 'Laden Stufe 2 (Wallbox)', DC_FAST: 'Schnellladen (DC)', UNKNOWN: 'unbekannt', NONE: 'keine', TRUE: 'ja', FALSE: 'nein', ON: 'an', OFF: 'aus', OPEN: 'offen', CLOSED: 'geschlossen', LOCKED: 'verriegelt', UNLOCKED: 'entriegelt' };
  const call = (method, payload, query) => { const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 135000); return api(method, payload, { signal: ctrl.signal, query }).finally(() => clearTimeout(t)); };
  const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toLocaleString('de-DE') : 'nicht vom Fahrzeug geliefert'; };
  let admin = true, simulation = false, busy = false, loginAllowed = true;

  const mode = h('div', { class: 'notice', text: 'Verbindung wird geprüft …' });
  const conn = h('span', { class: 'tag', text: 'Status wird geladen …' }), lastFetch = h('span', { class: 'muted' });
  const email = h('input', { type: 'email', autocomplete: 'username', maxlength: 254, required: true }), password = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 256, required: true });
  const loginBtn = h('button', { class: 'btn primary', type: 'submit', text: 'Anmelden und Daten lesen' });
  const form = h('form', { class: 'form', hidden: true }, field('E-Mail der Jeep-App', email), field('Passwort der Jeep-App', password), h('div', { class: 'wide actions' }, loginBtn));
  const demo = h('button', { class: 'btn primary', type: 'button', hidden: true, text: 'Demo verbinden' });
  const refresh = h('button', { class: 'btn', type: 'button', disabled: true, text: 'Daten aktualisieren' }), logout = h('button', { class: 'btn danger', type: 'button', hidden: true, text: 'Bei Jeep abmelden' });
  const out = h('p', { class: 'msg', role: 'status' });
  const secure = h('div', { hidden: true }), adminLink = h('a', { class: 'btn', href: '/login.html?admin=1', hidden: true, text: 'Als CCU-Administrator anmelden' });
  const vehicles = h('div', { class: 'cards' });
  // Matter-Freigabe
  const matterList = h('div'), matterOut = h('p', { class: 'msg', role: 'status' });
  const matterPanel = panel('In Apple Home freigeben', 'Batteriestand ist ein Standard-Matter-Wert. Reichweiten sind eine Matter-Erweiterung; Apple Home zeigt sie nicht als normale Sensorkachel.', matterList, matterOut); matterPanel.hidden = true;
  // Datenauswahl
  const picker = h('select', { 'aria-label': 'Fahrzeug' }), loadData = h('button', { class: 'btn primary', type: 'button', text: 'Alle verfügbaren Daten abrufen' }), saveDisplay = h('button', { class: 'btn', type: 'button', text: 'Auswahl speichern' });
  const selectedCards = h('div', { class: 'cards' }), sourceStatus = h('p', { class: 'muted' }), search = h('input', { type: 'search', placeholder: 'z. B. battery, tyre, odometer' });
  const rows = h('tbody'), prev = h('button', { class: 'btn small', type: 'button', text: 'Zurück' }), next = h('button', { class: 'btn small', type: 'button', text: 'Weiter' }), pageInfo = h('span', { class: 'muted' });
  const size = h('select', { 'aria-label': 'Werte pro Seite' }, [10, 25, 50, 100].map(n => h('option', { value: n, text: n + ' pro Seite' }))), note = h('p', { class: 'msg', role: 'status' });
  const dataPanel = panel('Fahrzeugdaten auswählen', 'Bis zu 64 Werte für deine Anzeige. Weitere Daten werden nur auf Knopfdruck geladen.', h('div', { class: 'row' }, field('Fahrzeug', picker), loadData, saveDisplay), selectedCards,
    h('details', { class: 'more' }, h('summary', { text: 'Verfügbare Daten und Datenquellen' }), sourceStatus, field('Daten suchen', search), h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Anzeigen' }), h('th', { text: 'Quelle / Wert' }), h('th', { text: 'Inhalt' }))), rows)), h('div', { class: 'actions' }, prev, pageInfo, next, size)), note);
  dataPanel.hidden = true;
  // Fahrzeugdaten aktualisieren (Auto wecken) – alle X Stunden, ausschaltbar; PIN nur verschlüsselt auf der CCU
  const wk = { enabled: h('input', { type: 'checkbox' }), hours: h('select', {}, [2, 3, 4, 6, 8, 12, 24].map(n => h('option', { value: n, text: 'alle ' + n + ' Stunden' }))), pin: h('input', { type: 'password', inputmode: 'numeric', maxlength: 4, autocomplete: 'off', placeholder: '4 Ziffern' }) };
  // „Jetzt aktualisieren“ entfernt (13.10.2026): der Knopf „Daten aktualisieren“ oben weckt den Jeep jetzt selbst
  const wkSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), wkOut = h('p', { class: 'msg', role: 'status' }), wkState = h('p', { class: 'muted' });
  const wkPanel = panel('Fahrzeugdaten regelmäßig aktualisieren', 'Der Jeep meldet sich nur beim Fahren oder Laden. Hängt er am Ladekabel, weckt die Zentrale ihn im gewählten Abstand, damit er seinen Ladestand meldet – nur wenn die letzten Daten älter sind. Ohne Kabel lehnt Uconnect das ab; dann ändert sich der Akkustand kaum und der gemerkte Wert bleibt gültig. Dafür ist die Uconnect-PIN nötig.',
    h('div', { class: 'form' }, h('div', { class: 'wide' }, NEU.toggle(wk.enabled, 'Automatisch aktualisieren')), field('Abstand', wk.hours), field('Uconnect-PIN', wk.pin, 'Leer lassen, um die gespeicherte zu behalten. Wird nur verschlüsselt auf der CCU gespeichert.')),
    h('div', { class: 'actions' }, wkSave), wkState, wkOut);
  const wkShow = s => {
    wk.enabled.checked = s.enabled; wk.hours.value = String(s.hours); wk.pin.value = ''; wk.pin.placeholder = s.hasPin ? 'gespeichert – leer lassen' : '4 Ziffern';
    const r = s.lastResult;
    wkState.textContent = (s.pinRejected ? '⚠ Die PIN wurde abgelehnt – automatische Aktualisierung angehalten, bis eine neue PIN gespeichert wird. ' : '') + 'Letzte Fahrzeugmeldung: ' + (s.vehicleUpdatedAt ? new Date(s.vehicleUpdatedAt).toLocaleString('de-DE') : 'unbekannt') + ' · Ladekabel: ' + (s.pluggedIn === true ? 'eingesteckt' : s.pluggedIn === false ? 'nicht eingesteckt' : 'unbekannt') + (r ? ' · Letzter Weckversuch: ' + new Date(r.at).toLocaleString('de-DE') + ' – ' + r.message : '');
  };
  const wkLoad = () => api('getJeepRefresh').then(wkShow).catch(e => msg(wkOut, e.message, 'bad'));
  wkSave.addEventListener('click', async () => { wkSave.disabled = true; try { const p = { enabled: wk.enabled.checked, hours: Number(wk.hours.value) }; if (wk.pin.value) p.pin = wk.pin.value; const r = await api('saveJeepRefresh', p); wkShow(r); msg(wkOut, r.message, 'ok'); } catch (e) { msg(wkOut, e.message, 'bad'); } finally { wkSave.disabled = false; wk.pin.value = ''; } });
  // Fernsteuerung: Klima, Motor, Türen – nur was Uconnect für das Fahrzeug freigibt; gleiche PIN wie oben
  const fsList = h('div'), fsOut = h('p', { class: 'msg', role: 'status' }), fsState = h('p', { class: 'muted' });
  const fsPanel = panel('Fernsteuerung', 'Klima, Motor-Fernstart und Türen wie in der Jeep-App. Nutzt die oben gespeicherte Uconnect-PIN. Das Klima lässt sich auch in Automationen verwenden (z. B. bei Frost morgens vorheizen); Motor und Türen nur hier von Hand.', fsList, fsState, fsOut);
  const ASK = { motor: { true: 'Der Motor wird per Fernstart angelassen. Nur starten, wenn das Auto im Freien steht (nicht in einer geschlossenen Garage).' }, tueren: { false: 'Die Türen werden entriegelt.' } };
  // Nur der passende Knopf (Wunsch Thomas): nach „Klima ein“ steht nur noch „Klima aus“ da und umgekehrt; der neue Knopf
  // ist 15 Sekunden gesperrt, damit nicht mehrfach geklickt wird. Unbekannter Zustand → beide Knöpfe.
  const STATE_KEY = 'mh-jeep-fs', LOCK_MS = 20000; // gleich wie Bridge und Handy-Seite: 20 s nach jedem Befehl
  const memo = () => { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch { return {}; } };
  const remember = (vin, action, on) => { try { const m = memo(); m[vin + '|' + action] = { on, at: Date.now() }; localStorage.setItem(STATE_KEY, JSON.stringify(m)); } catch {} };
  function fsButtons(vin, action, a) {
    // Gemerkter Zustand gilt 20 Minuten (Klima/Motor schalten im Fahrzeug von selbst ab, Türen können per Schlüssel geändert werden).
    // Immer nur EIN Knopf (Wunsch Thomas): der nächste Schritt. Ohne bekannten Zustand: Einschalten bzw. Starten/Verriegeln.
    const m = memo()[vin + '|' + action], last = m && Date.now() - m.at < 20 * 60000 ? m : null, show = [last ? !last.on : true];
    return show.map(on => {
      const b = h('button', { class: 'btn' + (on ? ' primary' : ''), type: 'button', text: on ? a.on : a.off });
      const wait = last ? LOCK_MS - (Date.now() - last.at) : 0;
      if (wait > 0) { b.disabled = true; const base = b.textContent; const tick = () => { const s = Math.ceil((LOCK_MS - (Date.now() - last.at)) / 1000); if (s <= 0 || !b.isConnected) { b.disabled = false; b.textContent = base; return; } b.textContent = base + ' (' + s + ' s)'; setTimeout(tick, 1000); }; tick(); }
      b.addEventListener('click', () => fsRun(b, vin, action, on, a)); return b;
    });
  }
  // Uconnect-Dienste in Klartext (Kürzel der Uconnect-Schnittstelle; Unbekanntes bleibt als Kürzel stehen)
  const SERVICES = { REON: 'Motor-Fernstart', REOFF: 'Motor aus (Fernstart beenden)', RDL: 'Türen verriegeln', RDU: 'Türen entriegeln', RHL: 'Hupe und Licht', ROLIGHTS: 'Licht einschalten', RHLON: 'Hupe und Licht', VF: 'Fahrzeug orten', ROPRECOND: 'Klima/Vorklimatisierung', ROPRECOND_OFF: 'Klima aus', PRECONDITIONING: 'Klima/Vorklimatisierung', CNOW: 'Jetzt laden', DEEPREFRESH: 'Fahrzeugdaten aktualisieren', ROTRUNKUNLOCK: 'Kofferraum entriegeln', ROTRUNKLOCK: 'Kofferraum verriegeln', ROHVACON: 'Klima ein', ROHVACOFF: 'Klima aus', RCLIMATE: 'Klima', SVLA: 'Diebstahl-Ortung', STOLENVEHICLE: 'Diebstahl-Ortung', SOS: 'Notruf', ACN: 'Unfall-Notruf', BCALL: 'Pannenruf', ECALL: 'Notruf', VHR: 'Fahrzeugzustandsbericht', VHA: 'Fahrzeugzustand', TPMS: 'Reifendruck', ODOMETER: 'Kilometerstand', SEND_POI: 'Ziel ans Navi senden', SENDPOI: 'Ziel ans Navi senden', GEOFENCE: 'Bereichsalarm', SPEEDALERT: 'Geschwindigkeitsalarm', CURFEW: 'Ausgangszeit-Alarm', VALET: 'Parkservice-Alarm', WIFI: 'WLAN-Hotspot', CHARGESCHEDULE: 'Ladeplan', CHARGINGSTATUS: 'Ladestatus', EVCHARGE: 'Laden', ACCOUNT: 'Konto', REMOTE: 'Fernbedienung', REMOTEOPS: 'Fernbefehle', LOCATION: 'Standort', LASTKNOWNLOCATION: 'Letzter Standort', NOTIFICATIONS: 'Benachrichtigungen', ALERTS: 'Hinweise', DIAGNOSTICS: 'Diagnose', MAINTENANCE: 'Wartung', HORN: 'Hupe', LIGHTS: 'Licht' };
  function serviceText(code) { const c = String(code || '').toUpperCase(); return SERVICES[c] || SERVICES[c.replace(/[^A-Z]/g, '')] || ''; }
  function serviceTable(list) {
    const sorted = [...list].sort((x, y) => (serviceText(y.service) ? 1 : 0) - (serviceText(x.service) ? 1 : 0) || String(x.service).localeCompare(String(y.service)));
    return NEU.table(['Dienst', 'Kürzel', 'Im Fahrzeug', 'Freigegeben'], sorted.map(s => h('tr', {}, h('td', { text: serviceText(s.service) || '–' }), h('td', { class: 'mono', text: String(s.service || '') }),
      h('td', { text: s.vehicleCapable === true ? 'ja' : s.vehicleCapable === false ? 'nein' : String(s.vehicleCapable ?? '–') }), h('td', { text: s.serviceEnabled === true ? 'ja' : s.serviceEnabled === false ? 'nein' : String(s.serviceEnabled ?? '–') }))));
  }
  const fsShow = s => {
    fsList.replaceChildren(...s.vehicles.map(v => h('div', { class: 'card' }, h('strong', { text: v.name }),
      ...Object.entries(v.actions).map(([k, a]) => a.available
        ? h('div', {}, h('div', { class: 'row' }, h('span', { text: a.title }), ...fsButtons(v.vin, k, a)),
          a.viaPlan ? h('p', { class: 'muted', text: 'Dein Jeep nimmt Klima nur über Zeitpläne an: „Einschalten“ legt einen kurzzeitigen Klimaplan mit Abfahrt in ca. 20 Minuten an (ein freier oder ausgeschalteter Plan; aktive Pläne bleiben unberührt). Das Auto heizt bzw. kühlt bis dahin vor; der Plan wird danach automatisch zurückgesetzt. „Ausschalten“ setzt ihn sofort zurück.' }) :
          a.denied ? h('p', { class: 'muted', text: '⚠ Uconnect hat diesen Befehl zuletzt abgelehnt' + (a.deniedAt ? ' (' + new Date(a.deniedAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + ' Uhr)' : '') + (a.deniedReason ? ' – Begründung: ' + a.deniedReason : '') + '.' })
            : !a.confirmed ? h('p', { class: 'muted', text: 'Freigabe in der Uconnect-Liste nicht eindeutig – der Befehl wird trotzdem gesendet, Uconnect entscheidet.' + (a.automation ? ' Für Automationen einmal hier von Hand auslösen.' : '') }) : null)
        : h('p', { class: 'muted', text: a.title + ': nicht verfügbar' })),
      v.services?.length ? h('details', {}, h('summary', { text: 'Uconnect-Dienstliste (' + v.services.length + ')' }), serviceTable(v.services)) : null, scheduleBox(v.vin))));
    const r = s.last;
    fsState.textContent = (!s.connected ? 'Nicht mit Jeep verbunden. ' : '') + (!s.hasPin ? 'Noch keine Uconnect-PIN gespeichert (oben unter „Fahrzeugdaten regelmäßig aktualisieren“). ' : '') + (s.pinRejected ? '⚠ PIN abgelehnt – bitte oben eine neue PIN speichern. ' : '') + (s.klimaSofort ? (s.klimaSofort.gaveUp ? '⚠ Klima sofort: Plan ' + s.klimaSofort.nr + ' konnte nicht automatisch zurückgesetzt werden – bitte in der Jeep-App bzw. unten bei den Zeitplänen prüfen. ' : '🔥 Klima sofort läuft über einen kurzzeitigen Klimaplan (Plan ' + s.klimaSofort.nr + ', Abfahrt ' + s.klimaSofort.departure + ' Uhr); er wird danach automatisch zurückgesetzt. ') : '') + (r ? 'Letzter Befehl: ' + new Date(r.at).toLocaleString('de-DE') + ' (' + r.reason + ') – ' + r.message : '');
  };
  // Zeitpläne wie in der Jeep-App (Klima-/Ladeplan mit Abfahrtszeit) – anzeigen und bearbeiten (Wunsch Thomas 12.10.2026)
  const WOCHE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  function planCard(p, edit) {
    const facts = p.type === 'NONE' ? [] : [
      ...(p.type === 'CLIMATE' ? [['Abfahrtszeit', p.end ? p.end + ' Uhr' : '–'], ['Über Ladezustand hinwegsetzen', p.cabinPriority ? 'ja' : 'nein']]
        : [['Laden', (p.start || '–') + ' bis ' + (p.end || '–') + ' Uhr'], ['Bis voll laden', p.chargeToFull ? 'ja' : 'nein']]),
      ['Tage', p.days.length ? p.days.join(', ') : 'keine'], ['Wöchentlich wiederholen', p.repeat ? 'ja' : 'nein']];
    const btn = edit ? h('button', { class: 'btn small', type: 'button', text: p.type === 'NONE' ? 'Plan anlegen' : 'Bearbeiten' }) : null, card = h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: 'Plan ' + p.nr + ' · ' + p.title }), p.type === 'NONE' ? null : h('span', { class: 'tag ' + (p.active ? 'ok' : ''), text: p.active ? 'aktiv' : 'aus' })),
      ...facts.map(([k, v]) => h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'muted', text: k }), h('span', { text: v }))), btn ? h('div', { class: 'actions' }, btn) : null);
    btn?.addEventListener('click', () => card.replaceWith(planForm(p, edit)));
    return card;
  }
  // Formular wie in der Jeep-App: Art, aktiv, Abfahrtszeit bzw. Ladezeit, Tage, Optionen. Speichern sendet mit der Uconnect-PIN.
  function planForm(p, edit) {
    const type = h('select', {}, h('option', { value: 'CLIMATE', text: 'Klimaplan' }), h('option', { value: 'CHARGE', text: 'Ladeplan' })); type.value = p.type === 'CHARGE' ? 'CHARGE' : 'CLIMATE';
    const active = h('input', { type: 'checkbox', checked: p.type === 'NONE' || p.active }), end = h('input', { type: 'time', value: p.end && p.end !== '00:00' ? p.end : '07:30', required: true }), start = h('input', { type: 'time', value: p.start || '00:00' });
    const cabin = h('input', { type: 'checkbox', checked: p.type === 'NONE' || p.cabinPriority }), full = h('input', { type: 'checkbox', checked: p.chargeToFull }), repeat = h('input', { type: 'checkbox', checked: p.repeat });
    const days = WOCHE.map(t => h('input', { type: 'checkbox', checked: p.days.includes(t), 'aria-label': t }));
    const climate = h('div', {}, field('Abfahrtszeit', end, 'Der Klimaplan funktioniert möglicherweise nicht, wenn die Abfahrtszeit innerhalb von 15 Minuten liegt.'), check('Über Ladezustand hinwegsetzen (Klima auch im Energiesparmodus)', cabin));
    const charge = h('div', {}, field('Laden ab', start), check('Bis voll laden', full));
    const show = () => { const c = type.value === 'CLIMATE'; cabin.closest('label').hidden = !c; charge.hidden = c; climate.querySelector('label').firstChild.textContent = c ? 'Abfahrtszeit' : 'Laden bis'; };
    const out = h('p', { class: 'msg', role: 'status' }), save = h('button', { class: 'btn primary small', type: 'submit', text: 'Im Auto speichern' }), cancel = h('button', { class: 'btn small', type: 'button', text: 'Abbrechen' });
    const form = h('form', { class: 'card' }, h('b', { text: 'Plan ' + p.nr + ' bearbeiten' }), field('Art', type), NEU.toggle(active, 'Plan aktiv'), climate, charge,
      h('div', { class: 'field' }, h('span', { text: 'Tage' }), h('div', { class: 'row' }, ...WOCHE.map((t, i) => check(t, days[i])))), check('Wöchentlich wiederholen', repeat), h('div', { class: 'actions' }, save, cancel), out);
    type.addEventListener('change', show); show();
    cancel.addEventListener('click', () => form.replaceWith(planCard(p, edit)));
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const plan = { type: type.value, active: active.checked, start: type.value === 'CHARGE' ? start.value : '00:00', end: end.value, days: WOCHE.filter((t, i) => days[i].checked), repeat: repeat.checked, cabinPriority: cabin.checked, chargeToFull: full.checked };
      if (plan.active && !plan.days.length) return msg(out, 'Mindestens einen Tag wählen.', 'bad');
      if (!await confirmDialog({ title: 'Plan ' + p.nr + ' im Auto speichern?', text: (plan.type === 'CLIMATE' ? 'Klimaplan, Abfahrt ' + plan.end : 'Ladeplan ' + plan.start + '–' + plan.end) + ' Uhr, ' + (plan.days.join(', ') || 'keine Tage') + (plan.active ? ', aktiv' : ', aus') + '. Der Plan geht mit deiner Uconnect-PIN über die Uconnect-Cloud an das Auto.', confirm: 'Speichern' })) return;
      save.disabled = cancel.disabled = true; msg(out, 'Wird an das Auto gesendet …', 'busy');
      try { const r = await call('saveJeepZeitplan', { vin: edit.vin, nr: p.nr, plan }); msg(out, r.message + ' Die Anzeige aktualisiert sich, sobald das Auto den neuen Plan meldet (meist 2–5 Minuten).', 'ok'); edit.pending(); }
      catch (err) { msg(out, err.message, 'bad'); } finally { save.disabled = cancel.disabled = false; }
    });
    return form;
  }
  function scheduleBox(vin) {
    // Immer sichtbar (Wunsch Thomas: nicht einklappen) – gelesen aus der Fahrzeugmeldung, die die Bridge ohnehin hat (keine Cloud-Abfrage)
    const o = h('div', { class: 'muted', text: 'Wird gelesen …' }), box = h('div', { class: 'jeep-plaene' }, h('h3', { text: 'Zeitpläne im Auto (Klima / Laden mit Abfahrtszeit)' }),
      h('p', { class: 'muted', text: 'Wie in der Jeep-App. „Bearbeiten“ sendet den Plan mit deiner Uconnect-PIN an das Auto; die Anzeige folgt, sobald das Auto sich gemeldet hat.' }), o);
    const load = async () => {
      try {
        const r = await api('getJeepZeitplaene', undefined, { query: { vin } }), edit = r.source === 'Fahrzeugmeldung' ? { vin, pending: () => [150000, 330000].forEach(ms => setTimeout(load, ms)) } : null;
        o.replaceChildren(...(r.plans.length ? [h('div', { class: 'cards' }, ...r.plans.map(p => planCard(p, edit)))] : [h('span', { text: 'Keine Zeitpläne gespeichert.' })]),
          h('p', { class: 'muted', text: 'Quelle: ' + r.source + (r.vehicleUpdatedAt ? ' vom ' + time(r.vehicleUpdatedAt) : '') + (edit ? '' : ' – bearbeiten geht erst, wenn das Auto seine Pläne gemeldet hat.') }));
      } catch (e) { o.textContent = e.message; }
    };
    load();
    return box;
  }
  const fsLoad = () => api('getJeepRemote').then(fsShow).catch(e => msg(fsOut, e.message, 'bad'));
  async function fsRun(btn, vin, action, on, a) {
    const text = ASK[action]?.[on];
    if (!await confirmDialog({ title: (on ? a.on : a.off) + '?', text: (text ? text + ' ' : '') + 'Der Befehl geht über die Uconnect-Cloud an das Fahrzeug.', confirm: on ? a.on : a.off, danger: !!text })) return;
    btn.disabled = true; msg(fsOut, 'Befehl wird gesendet …');
    try { const r = await call('runJeepRemote', { vin, action, on }); remember(vin, action, on); fsShow(r.status); msg(fsOut, r.message, 'busy'); if (r.status?.last?.state === 'waiting') waitConfirm(r.status.last.at); else msg(fsOut, r.message, 'ok'); } catch (e) { msg(fsOut, e.message, 'bad'); fsLoad(); } finally { btn.disabled = false; }
  }
  // Auf die Bestätigung vom Fahrzeug warten: höchstens 75 s, alle 4 s nachsehen, danach keine Dauerabfrage
  function waitConfirm(at) {
    const end = Date.now() + 75000;
    const tick = async () => {
      let s; try { s = await api('getJeepRemote'); } catch { s = null; }
      const l = s?.last; if (s) fsShow(s);
      if (l && l.at === at && l.state !== 'waiting') { msg(fsOut, l.message, l.state === 'confirmed' ? 'ok' : l.state === 'failed' ? 'bad' : 'warn'); return; }
      if (Date.now() < end) setTimeout(tick, 4000); else msg(fsOut, '⚠ Noch keine Rückmeldung vom Fahrzeug. Später „Letzter Befehl“ ansehen.', 'warn');
    };
    setTimeout(tick, 4000);
  }

  // Standort mit Karte auch auf dem PC (Wunsch Thomas) – gleiche Quelle wie die Handy-Seite; Klick zeigt die Route in Apple Karten
  const posBody = h('div'), posOut = h('p', { class: 'msg', role: 'status' }), posBtn = h('button', { class: 'btn small', type: 'button', text: 'Standort aktualisieren' });
  const posPanel = panel('Standort', 'Wo der Jeep zuletzt gemeldet wurde (Uconnect, höchstens alle 5 Minuten neu gefragt). Karte © OpenStreetMap-Mitwirkende.', posBody, h('div', { class: 'actions' }, posBtn), posOut);
  async function posLoad(fresh) {
    try {
      const p = await api('getJeepStandort', undefined, fresh ? { query: { neu: '1' } } : {}), m = p.map, route = 'https://maps.apple.com/?daddr=' + p.lat.toFixed(6) + ',' + p.lon.toFixed(6) + '&dirflg=w', imgs = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) imgs.push(h('img', { src: '/api/?method=getJeepKarte&x=' + (m.x + dx) + '&y=' + (m.y + dy), alt: '', decoding: 'async' }));
      const t = new Date(p.at || p.readAt);
      posBody.replaceChildren(h('p', {}, h('b', { text: p.address || 'Adresse nicht ermittelbar' })), h('p', { class: 'muted', text: 'Stand: ' + (Number.isFinite(t.getTime()) ? t.toLocaleString('de-DE') : 'unbekannt') + (p.approx ? ' · ungefähr' : '') }),
        h('a', { class: 'jeep-map', href: route, target: '_blank', rel: 'noopener', 'aria-label': 'Route zum Jeep in Apple Karten' }, h('div', { class: 'jeep-tiles' }, ...imgs), h('span', { class: 'jeep-pin', text: '🚙', style: 'left:' + ((256 + m.px) / 768 * 100).toFixed(2) + '%;top:' + ((256 + m.py) / 768 * 100).toFixed(2) + '%' })),
        h('a', { class: 'btn small primary', href: route, target: '_blank', rel: 'noopener', text: '🧭 Route zum Jeep' }));
      msg(posOut, '', 'ok');
    } catch (e) { posBody.replaceChildren(); msg(posOut, e.message, 'bad'); }
  }
  posBtn.addEventListener('click', () => posLoad(true));
  // Fahrzeugzustand (Kilometerstand, Reifendruck, Wartung, Ladekosten) und Jeep-Wache (WhatsApp-Hinweise, Nachtschloss) – Wunsch Thomas 12.10.2026
  const zsBox = h('div'), zsPanel = panel('Fahrzeugzustand', 'Aus der Fahrzeugmeldung, die die Zentrale ohnehin alle 5 Minuten holt (keine Zusatzabfrage). Ladekosten aus „Jeep laden“ (Zähler der Steckdose × Strompreis).', zsBox);
  const jw = { frost: h('input', { type: 'checkbox' }), gaveUp: h('input', { type: 'checkbox' }), notPlugged: h('input', { type: 'checkbox' }), notPluggedTime: h('input', { type: 'time' }), low: h('input', { type: 'checkbox' }), tyres: h('input', { type: 'checkbox' }), nightLock: h('input', { type: 'checkbox' }), nightLockTime: h('input', { type: 'time' }) };
  const jwSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), jwOut = h('p', { class: 'msg', role: 'status' }), jwState = h('p', { class: 'muted' }), jwLog = h('div');
  const jwPanel = panel('Hinweise per WhatsApp und Nachtschloss', 'Jeder Hinweis kommt höchstens einmal (kein Dauer-Melden) und lässt sich einzeln abschalten. „Ladung beginnt/beendet“ meldet weiterhin „Jeep laden“ (Seite Automationen).',
    h('div', { class: 'form' },
      h('div', { class: 'wide' }, NEU.toggle(jw.frost, 'Frostschutz heizt vor („Jeep heizt vor, fertig um …“)')),
      h('div', { class: 'wide' }, NEU.toggle(jw.gaveUp, '„Klima sofort“-Plan ließ sich nicht zurücksetzen')),
      h('div', { class: 'wide' }, NEU.toggle(jw.notPlugged, 'Abends am Ladeplatz, aber nicht eingesteckt')), field('Prüfen um', jw.notPluggedTime, 'Einmal je Abend, innerhalb von 30 Minuten ab dieser Uhrzeit.'),
      h('div', { class: 'wide' }, NEU.toggle(jw.low, 'Akku niedrig (Warnschwelle wie „Akku niedrig“, Standard 20 %)')),
      h('div', { class: 'wide' }, NEU.toggle(jw.tyres, 'Reifendruck-Warnung des Fahrzeugs')),
      h('div', { class: 'wide' }, NEU.toggle(jw.nightLock, 'Nachts automatisch verriegeln')), field('Verriegeln um', jw.nightLockTime, 'Nur verriegeln, nie entriegeln. Nur wenn der Jeep am Ladeplatz steht, die Zündung aus ist und er seit seiner letzten Fahrt nicht schon bestätigt verriegelt wurde. Einmal je Nacht, kein Wiederholen.')),
    h('div', { class: 'actions' }, jwSave), jwState, jwOut, h('details', { class: 'more' }, h('summary', { text: 'Letzte Ereignisse' }), jwLog));
  const de2 = (v, n = 2) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });
  function jwShow(d) {
    for (const k of ['frost', 'gaveUp', 'notPlugged', 'low', 'tyres', 'nightLock']) jw[k].checked = d.settings[k] === true;
    jw.notPluggedTime.value = d.settings.notPluggedTime; jw.nightLockTime.value = d.settings.nightLockTime;
    jwState.textContent = d.ladeplatz ? '' : '⚠ Noch kein Ladeplatz festgelegt (Seite Automationen → „Jeep laden“). Ohne Ladeplatz gibt es weder Nachtschloss noch den Hinweis „nicht eingesteckt“.';
    jwLog.replaceChildren(d.log.length ? h('ul', {}, d.log.slice(0, 15).map(l => h('li', { text: new Date(l.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + ' – ' + l.text }))) : h('p', { class: 'muted', text: 'Noch keine Ereignisse.' }));
    const row = (k, v) => h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'muted', text: k }), h('span', { text: v }));
    const cards = d.vehicles.map(v => h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: v.name }), h('span', { class: 'tag ' + (v.tyres.some(t => t.warning) ? 'warn' : 'ok'), text: v.tyres.some(t => t.warning) ? 'Reifendruck prüfen' : 'Reifen in Ordnung' })),
      row('Kilometerstand', v.odometerKm !== null ? v.odometerKm.toLocaleString('de-DE') + ' km' : 'nicht geliefert'),
      row('Nächste Wartung', v.serviceKm !== null && v.serviceKm > 0 ? 'in ' + v.serviceKm.toLocaleString('de-DE') + ' km' + (v.serviceDays !== null ? ' bzw. ' + v.serviceDays + ' Tagen' : '') : v.serviceDays !== null ? 'in ' + v.serviceDays + ' Tagen' : v.serviceKm === 0 ? 'Fahrzeug meldet 0 km – Serviceanzeige im Auto prüfen' : 'nicht geliefert'),
      ...v.tyres.map(t => row('Reifen ' + t.pos, (t.bar !== null ? de2(t.bar) + ' bar · ' : '') + t.status + (t.warning ? ' ⚠' : ''))),
      row('Türen', v.lockedConfirmed ? (v.lockedConfirmed.locked ? 'verriegelt' : 'entriegelt') + ' (bestätigt ' + new Date(v.lockedConfirmed.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + ')' : 'kein bestätigter Befehl'),
      h('small', { class: 'muted', text: 'Fahrzeugmeldung: ' + time(v.updatedAt) })));
    const c = d.costs, months = c?.months || [];
    cards.push(h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: 'Ladekosten' }), h('span', { class: 'tag', text: c?.priceEur ? de2(c.priceEur, 4) + ' €/kWh' : 'kein Strompreis' })),
      ...(months.length ? months.slice(0, 6).map(m => row(m.month.slice(5) + '/' + m.month.slice(0, 4), de2(m.kWh) + ' kWh' + (m.costEur !== null ? ' · ' + de2(m.costEur) + ' €' : ''))) : [h('p', { class: 'muted', text: 'Noch keine Ladungen aufgezeichnet (Seite Automationen → „Jeep laden“, Steckdose wählen).' })])));
    // Verbrauchsdiagramme wie unter Automationen → „Jeep laden“ (Wunsch Thomas 13.10.2026): je Monat und je Ladung
    const charts = c ? [NEU.jeepMonatChart(months), NEU.jeepLadungenChart(c.sessions || [])].filter(Boolean) : [];
    zsBox.replaceChildren(h('div', { class: 'cards' }, cards), ...(charts.length ? [h('div', { style: 'margin-top:12px' }, charts)] : []));
  }
  const jwLoad = () => api('getJeepWache').then(jwShow).catch(e => msg(jwOut, e.message, 'bad'));
  jwSave.addEventListener('click', async () => { jwSave.disabled = true; try { const p = { notPluggedTime: jw.notPluggedTime.value, nightLockTime: jw.nightLockTime.value }; for (const k of ['frost', 'gaveUp', 'notPlugged', 'low', 'tyres', 'nightLock']) p[k] = jw[k].checked; const r = await api('saveJeepWache', p); jwShow(r); msg(jwOut, r.message, 'ok'); } catch (e) { msg(jwOut, e.message, 'bad'); } finally { jwSave.disabled = false; } });
  main.append(mode, secure,
    panel('Verbindung', 'Mit E-Mail und Passwort der Jeep-App anmelden. Die Zugangsdaten werden verschlüsselt auf der CCU gespeichert; nach einem Neustart verbindet sich Jeep automatisch. „Abmelden“ entfernt den Zugang.', h('div', { class: 'row' }, conn, lastFetch), form, h('div', { class: 'actions' }, demo, refresh, logout, adminLink), out,
      h('p', { class: 'muted', text: 'Automatischer Abruf alle fünf Minuten. „Daten aktualisieren“ weckt den Jeep, damit er frische Daten schickt – am Ladekabel per „Fahrzeugdaten aktualisieren“, ohne Kabel per „Fahrzeug finden“ (dafür muss unten die Uconnect-PIN hinterlegt sein).' })),
    vehicles, zsPanel, posPanel, wkPanel, fsPanel, jwPanel, matterPanel, dataPanel,
    panel('Wenn die Anmeldung nicht klappt', null, h('p', { class: 'muted', text: 'Zuerst prüfen, ob die Anmeldung mit denselben Angaben in der Jeep-App klappt; Bestätigungen dort erledigen. Der Lesezugriff nutzt eine inoffizielle Uconnect-Schnittstelle.' }), h('a', { class: 'btn', href: 'https://myuconnect.jeep.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Jeep-Konto öffnen ↗' })));

  NEU.ensureSession().then(s => { if (s.admin) { wkLoad(); fsLoad(); jwLoad(); if (!simulation) posLoad(false); else posPanel.hidden = true; } else wkPanel.hidden = fsPanel.hidden = posPanel.hidden = zsPanel.hidden = jwPanel.hidden = true; }).catch(() => { wkPanel.hidden = fsPanel.hidden = posPanel.hidden = zsPanel.hidden = jwPanel.hidden = true; });
  function render(d) {
    conn.className = 'tag ' + (d.connected ? 'ok' : ''); conn.textContent = (simulation ? 'Simulation · ' : '') + (d.connected ? 'mit Jeep angemeldet' : 'nicht angemeldet');
    form.hidden = d.connected || !admin || !loginAllowed || simulation; logout.hidden = !d.connected || !admin; demo.hidden = !simulation || d.connected;
    refresh.disabled = !d.connected || busy || d.busy;
    lastFetch.textContent = d.lastFetchedAt ? 'Letzter Abruf: ' + time(d.lastFetchedAt) : 'Noch keine Fahrzeugdaten abgerufen.';
    vehicles.replaceChildren(...(d.vehicles || []).map(v => {
      const charge = v.charging ? JEEP_DE[v.charging] || 'Herstellermeldung: ' + v.charging : 'nicht geliefert';
      const facts = [...(admin ? [['Ladestatus', charge]] : []), ['Elektrische Reichweite', v.range !== null && v.rangeUnit ? v.range + ' ' + v.rangeUnit : 'nicht geliefert'], ...(!admin ? [['Reichweite mit Kraftstoff', v.fuelRange !== null && v.fuelRangeUnit ? v.fuelRange + ' ' + v.fuelRangeUnit : 'nicht geliefert']] : []), ['Fahrzeugmeldung', time(v.vehicleUpdatedAt)], ...(admin && v.vin ? [['Fahrgestellnummer', v.vin]] : [])];
      return h('article', { class: 'card' }, h('div', { class: 'card-head' }, h('b', { text: v.name }), h('span', { class: 'tag ' + (v.stale ? 'warn' : 'ok'), text: v.stale ? 'älterer Datenstand' : 'aktuell' })),
        h('div', { style: 'font-size:34px;font-weight:500', text: v.batteryPercent === null ? '–' : v.batteryPercent + ' %' }),
        v.batteryPercent !== null ? h('progress', { max: 100, value: v.batteryPercent, 'aria-label': 'Batterieladung', style: 'width:100%;accent-color:#176c60' }) : h('span', { class: 'muted', text: 'Ladezustand nicht geliefert' }),
        h('div', {}, facts.map(([k, val]) => h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'muted', text: k }), h('span', { text: val })))),
        h('small', { class: 'muted', text: v.stale ? 'Älterer oder unbekannter Datenstand – kein aktueller Livewert.' : 'Fahrzeugmeldung höchstens 15 Minuten alt.' }));
    }));
    if (d.connected && !(d.vehicles || []).length) vehicles.append(h('div', { class: 'empty', text: 'Angemeldet, aber keine Fahrzeuge im Konto gefunden.' }));
    if (d.error) msg(out, d.error, 'bad');
    stateChanged(d);
  }
  async function status() { return render(await call(admin ? 'getJeepStatus' : 'getJeepOverview')); }
  async function action(fn) {
    if (busy) return; busy = true; loginBtn.disabled = refresh.disabled = demo.disabled = logout.disabled = true; msg(out, 'Jeep-Abfrage läuft …', 'busy');
    try { render(await fn()); msg(out, simulation ? 'Demo-Verbindung geprüft. Keine echten Fahrzeugdaten.' : 'Abfrage abgeschlossen. Der Datenstand stammt vom Fahrzeug.', 'ok'); }
    catch (e) { msg(out, e.name === 'AbortError' ? 'Zeitlimit erreicht. Erst Status prüfen, dann erneut anmelden.' : e.message, 'bad'); }
    finally { busy = false; loginBtn.disabled = demo.disabled = logout.disabled = false; try { await status(); } catch {} }
  }
  form.addEventListener('submit', e => { e.preventDefault(); const p = { email: email.value, password: password.value }; password.value = ''; action(() => call('loginJeep', p)); });
  demo.addEventListener('click', () => action(() => call('loginJeep', { email: 'demo@example.invalid', password: 'DEMO' })));
  // „Daten aktualisieren“ weckt den Jeep (DEEPREFRESH, Wunsch Thomas 13.10.2026) und holt danach die Daten; nach 2 Minuten
  // automatisch noch einmal, weil das Auto seine neue Meldung erst dann schickt. Geht Wecken nicht (kein Ladekabel, keine PIN),
  // wird die zuletzt gespeicherte Meldung gelesen und der Grund genannt.
  let nachholen = null;
  refresh.addEventListener('click', async () => {
    if (!admin) return action(() => call('getJeepOverview'));
    if (busy) return;
    let weck; refresh.disabled = true; msg(out, 'Jeep wird geweckt …', 'busy');
    try { weck = await call('runJeepRefresh', {}); } catch (e) { weck = { fehler: e.message }; }
    await action(() => call('refreshJeep', {}));
    if (weck.fehler) msg(out, 'Jeep nicht geweckt: ' + weck.fehler + ' Angezeigt wird die zuletzt gespeicherte Meldung.', 'warn');
    else {
      msg(out, (weck.weg === 'VF' ? 'Jeep ohne Ladekabel über „Fahrzeug finden“ geweckt.' : 'Jeep geweckt.') + ' Er schickt seine neuen Daten (auch den Türstatus) in etwa 1–2 Minuten – die Seite holt sie dann automatisch.', 'ok');
      clearTimeout(nachholen); nachholen = setTimeout(() => action(() => call('refreshJeep', {})), 120000);
    }
    try { wkLoad(); } catch {}
  });
  logout.addEventListener('click', async () => { if (await confirmDialog({ title: 'Bei Jeep abmelden?', text: 'Der gespeicherte Jeep-Zugang wird entfernt; die automatische Anmeldung endet.', confirm: 'Abmelden', danger: true })) action(() => call('logoutJeep', {})); });

  // ---- Matter-Freigabe ----
  let matterBusy = false;
  async function matter() {
    if (matterBusy) return;
    try {
      const d = await call('getJeepMatterDevices'); matterPanel.hidden = false;
      matterList.replaceChildren(...(d.devices.length ? d.devices.map(dev => {
        const box = h('input', { type: 'checkbox', checked: dev.exposed });
        box.addEventListener('change', async () => { if (matterBusy) return; matterBusy = true; box.disabled = true; msg(matterOut, 'Freigabe wird angewendet …', 'busy'); try { await call('setJeepExposed', { address: dev.address, exposed: box.checked }); msg(matterOut, 'Freigabe gespeichert und angewendet.', 'ok'); } catch (e) { box.checked = dev.exposed; msg(matterOut, e.message, 'bad'); } finally { matterBusy = false; await matter(); } });
        return NEU.toggle(box, dev.name);
      }) : [h('p', { class: 'muted', text: 'Zuerst bei Jeep anmelden und Fahrzeugdaten abrufen.' })]));
    } catch (e) { msg(matterOut, e.message, 'bad'); }
  }

  // ---- Datenauswahl ----
  const SOURCES = { vehicle: 'Fahrzeug', status: 'Fahrzeugzustand', remote: 'Türen / Fenster', location: 'Standort', health: 'Zustandsbericht', maintenance: 'Wartung', notifications: 'Meldungen', stolenStatus: 'Diebstahlstatus', subscription: 'Dienste', chargeSchedule: 'Ladepläne', lastTrip: 'Letzte Fahrt', trips: 'Fahrten', imageMetadata: 'Bildinformationen' };
  const NAMES = { stateOfCharge: 'Batteriestand (%)', chargingStatus: 'Ladestatus', plugInStatus: 'Ladekabel', batteryVoltage: '12-V-Batteriespannung', odometer: 'Kilometerstand', distanceToEmpty: 'Reichweite', latitude: 'Breitengrad', longitude: 'Längengrad', tyrePressure: 'Reifendruck', timestamp: 'Meldungszeitpunkt', timeStamp: 'Meldungszeitpunkt', value: 'Wert', unit: 'Einheit' };
  const label = x => x.id.includes('/vehicleInfo/fuel/distanceToEmpty/') ? 'Reichweite mit Kraftstoff' + (x.id.endsWith('/unit') ? ' → Einheit' : '') : x.id.includes('/evInfo/battery/distanceToEmpty/') ? 'Elektrische Reichweite' + (x.id.endsWith('/unit') ? ' → Einheit' : '') : x.label.split(' → ').map(s => NAMES[s] || s).join(' → ');
  const show = v => v === null ? 'nicht geliefert' : typeof v === 'boolean' ? (v ? 'Ja' : 'Nein') : typeof v === 'string' && JEEP_DE[v] ? JEEP_DE[v] : String(v);
  let vin = '', fields = [], selected = new Set(), page = 0, dirty = false, dataBusy = false, connected = false;
  function cards() { selectedCards.replaceChildren(...fields.filter(x => selected.has(x.id)).map(x => h('div', { class: 'stat' }, h('span', { text: label(x) }), h('strong', { class: 'small', style: 'overflow-wrap:anywhere', text: show(x.value) })))); }
  function table() {
    const q = search.value.toLocaleLowerCase('de'), per = Number(size.value), match = fields.filter(x => (label(x) + ' ' + x.label + ' ' + (SOURCES[x.source] || x.source)).toLocaleLowerCase('de').includes(q));
    page = Math.min(page, Math.max(0, Math.ceil(match.length / per) - 1));
    rows.replaceChildren(...match.slice(page * per, (page + 1) * per).map(x => {
      const box = h('input', { type: 'checkbox', checked: selected.has(x.id), 'aria-label': label(x) + ' anzeigen' });
      box.addEventListener('change', () => { if (box.checked) { if (selected.size >= 64) { box.checked = false; msg(note, 'Bis zu 64 Anzeigen auswählen.', 'bad'); return; } selected.add(x.id); } else selected.delete(x.id); dirty = true; cards(); msg(note, 'Auswahl geändert – anschließend speichern.'); });
      return h('tr', {}, h('td', {}, box), h('td', { text: (SOURCES[x.source] || x.source) + ' · ' + label(x) }), h('td', { style: 'overflow-wrap:anywhere', text: show(x.value) }));
    }));
    pageInfo.textContent = (match.length ? 'Seite ' + (page + 1) + ' von ' + Math.ceil(match.length / per) : 'Keine passenden Werte') + ' · ' + match.length + ' Werte';
    prev.disabled = page === 0; next.disabled = (page + 1) * per >= match.length;
  }
  function data(v) {
    fields = v.fields || [];
    if (!dirty) selected = new Set(v.selected === null ? fields.filter(x => /stateOfCharge|chargingStatus|distanceToEmpty.*value/.test(x.id)).slice(0, 3).map(x => x.id) : v.selected || []);
    sourceStatus.textContent = Object.entries(v.sources || {}).map(([k, s]) => (SOURCES[k] || k) + ': ' + (s.available ? 'geliefert' : s.reason || 'nicht verfügbar')).join(' · ');
    msg(note, v.truncated ? 'Große Antworten wurden auf 2.000 Felder begrenzt.' : 'Angezeigt werden die vom Jeep-Zugang gelieferten Felder.');
    cards(); table();
  }
  async function loadCached() { if (!vin) return; try { data(await call('getJeepData', undefined, { vin })); } catch (e) { msg(note, e.message, 'bad'); } }
  async function job(fn) { if (dataBusy) return; dataBusy = true; loadData.disabled = saveDisplay.disabled = true; try { await fn(); } catch (e) { msg(note, e.name === 'AbortError' ? 'Zeitlimit erreicht. Keine automatische Wiederholung.' : e.message, 'bad'); } finally { dataBusy = false; loadData.disabled = saveDisplay.disabled = false; } }
  picker.addEventListener('change', () => { vin = picker.value; dirty = false; page = 0; loadCached(); });
  loadData.addEventListener('click', () => job(async () => { msg(note, 'Datenquellen werden gelesen …', 'busy'); data(await call('loadJeepData', { vin })); }));
  saveDisplay.addEventListener('click', () => job(async () => { await call('saveJeepDisplay', { vin, fields: [...selected] }); dirty = false; msg(note, 'Auswahl gespeichert.', 'ok'); }));
  search.addEventListener('input', () => { page = 0; table(); }); size.addEventListener('change', () => { page = 0; table(); });
  prev.addEventListener('click', () => { page--; table(); }); next.addEventListener('click', () => { page++; table(); });

  let previous = null;
  function stateChanged(d) {
    if (previous !== d.connected) { previous = d.connected; matter(); }
    if (!admin) { dataPanel.hidden = true; return; }
    dataPanel.hidden = !d.connected || !(d.vehicles || []).length;
    if (!d.connected) { connected = false; vin = ''; fields = []; selected.clear(); cards(); table(); return; }
    const changed = !connected || !(d.vehicles || []).some(v => v.vin === vin); connected = true;
    if (changed && !dataBusy) { picker.replaceChildren(...d.vehicles.map(v => h('option', { value: v.vin, text: v.name + ' · ' + String(v.vin).slice(-6) }))); vin = picker.value; dirty = false; loadCached(); }
  }

  (async () => {
    try {
      const info = await call('jeepConnectionInfo');
      admin = info.admin !== false; simulation = info.simulation === true;
      if (info.protectedUrl) {
        const target = new URL(info.protectedUrl);
        if (target.protocol === 'https:' && !target.username && !target.password && !target.search && !target.hash) {
          const url = new URL('/login.html?admin=1', target.origin).href; adminLink.href = url;
          // Kein QR-Code mehr (Wunsch Thomas): Angemeldete sehen ihn nicht, alle anderen nur den Hinweis zur Administrator-Anmeldung.
        }
      }
      if (!admin) { mode.textContent = (simulation ? 'SIMULATION · ' : '') + 'Batteriestand und Reichweiten'; adminLink.hidden = !secure.hidden; await status(); setInterval(() => { if (!busy && !document.hidden) status().catch(() => {}); }, 15000); return; }
      const s = await call('jeepSession'); simulation = s.simulation === true; loginAllowed = s.loginAllowed !== false;
      mode.textContent = simulation ? 'SIMULATION – keine Verbindung zum Fahrzeug' : s.localConnectionTest ? 'Jeep-Lesetest auf diesem PC' : 'Jeep-Fahrzeugdaten · nur Lesezugriff';
      mode.className = 'notice' + (simulation ? ' warn' : '');
      if (!loginAllowed) msg(out, 'Für die Jeep-Anmeldung ist ein HTTPS-Zugang erforderlich.', 'bad');
      await status(); setInterval(() => { if (!busy && !document.hidden) status().catch(() => {}); }, 15000);
    } catch (e) { msg(out, e.message + ' Bei Zugriff über die CCU zuerst als Administrator anmelden.', 'bad'); adminLink.hidden = false; }
  })();
});
