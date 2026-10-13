'use strict';
// Seite „Dienste & WhatsApp“: Ausfallmeldung per CallMeBot, Geräte bewusst ohne Ausfallwarnung, Warnung bei falschen
// Anmeldungen. Den Zustand der Dienste zeigt seit 13.10.2026 nur noch die Ampelseite „🚦 Systemzustand“ (Wunsch Thomas).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task, stat } = NEU;
  const main = shell({ title: 'Benachrichtigungen', eyebrow: 'System', crumb: 'System', lead: 'Die Bridge prüft etwa alle 30 Sekunden ihre Dienste und Geräte und kann dich bei einem Ausfall per WhatsApp informieren. Ob gerade alles läuft, zeigt die Ampel unter „🚦 Systemzustand“.' });
  const rows = h('div', {}, h('div', { class: 'empty', text: 'Wird geladen …' }));
  const out = h('p', { class: 'msg', role: 'status' });

  const enabled = h('input', { type: 'checkbox' }), phone = h('input', { type: 'tel', placeholder: '+491…', maxlength: 16, autocomplete: 'tel' });
  const key = h('input', { type: 'password', maxlength: 64, autocomplete: 'new-password', placeholder: 'Leer lassen, um gespeicherten Schlüssel zu behalten' });
  const delay = h('input', { type: 'number', min: 0, max: 3600, step: 1, value: 0, required: true });
  const keyState = h('p', { class: 'muted' }), delivery = h('p', { class: 'muted' });
  const save = h('button', { class: 'btn primary', type: 'submit', text: 'Speichern' }), test = h('button', { class: 'btn', type: 'button', text: 'Testnachricht senden' });
  const result = h('p', { class: 'msg', role: 'status' });
  const loginWatch = h('div', {}, h('div', { class: 'empty', text: 'Wird geladen …' }));
  async function loadLoginWatch() {
    try {
      const w = await api('getLoginWatch');
      loginWatch.replaceChildren(h('div', { class: 'stats' },
        stat('Falsche Anmeldungen', String(w.failures), 'in den letzten ' + w.windowHours + ' Stunden', w.failures > w.threshold ? 'bad' : w.failures ? 'warn' : 'ok'),
        stat('WhatsApp-Warnung', w.whatsappReady ? 'bereit' : 'nicht eingerichtet', w.whatsappReady ? 'ab dem ' + (w.threshold + 1) + '. Fehlversuch' : 'oben Nummer und Schlüssel speichern', w.whatsappReady ? 'ok' : 'warn'),
        stat('Letzte Warnung', w.lastAlert ? NEU.fmtDate(w.lastAlert) : 'noch keine', w.lastResult ? w.lastResult.message : '', w.lastResult && !w.lastResult.ok ? 'bad' : undefined)),
        h('p', { class: 'muted', text: 'Zusätzlich gilt weiterhin: höchstens 8 Anmeldeversuche je Gerät in 15 Minuten. Benutzernamen und Passwörter werden dabei nicht gespeichert.' }));
    } catch (e) { loginWatch.replaceChildren(h('div', { class: 'notice warn', text: e.status === 403 ? 'Nach Anmeldung als CCU-Administrator sichtbar.' : e.message })); }
  }
  loadLoginWatch();
  const form = h('form', { class: 'form' }, h('div', { class: 'wide' }, check('Ausfallmeldungen aktivieren', enabled)), field('Handynummer mit Landesvorwahl', phone), field('CallMeBot-API-Schlüssel', key), field('Ausfall melden nach (Sekunden, 0 = sofort)', delay), h('div', { class: 'wide' }, keyState), h('div', { class: 'wide actions' }, save, test));

  main.append(
    panel('WhatsApp bei einem Ausfall', null,
      h('div', { class: 'notice warn' }, h('span', {}, 'Zuerst die Nummer bei ', h('a', { href: 'https://www.callmebot.com/blog/free-api-whatsapp-messages/', target: '_blank', rel: 'noopener noreferrer', text: 'CallMeBot' }), ' freischalten. Nummer, Meldung und Schlüssel werden beim Versand an CallMeBot übertragen.')),
      form, result, delivery,
      h('details', { class: 'more' }, h('summary', { text: 'Wann wird gemeldet?' }),
        h('p', { text: 'Standard: sofort nach der ersten fehlgeschlagenen Prüfung; optional mit Wartezeit. Pro Gerät höchstens ein automatischer Versand innerhalb von sechs Stunden. Ausfälle derselben Prüfung werden gebündelt.' }),
        h('p', { text: 'Bei einem vollständigen CCU-, Bridge- oder Internetausfall kann diese CCU nichts senden. Eine unabhängige Überwachung braucht ein zweites Gerät.' }))),
    panel('Geräte ohne Ausfallwarnung', 'Geräte, die du bewusst ausschaltest (z. B. Steckdose im Winter), hier abhaken – dann kommt keine WhatsApp und die Ampel bleibt grün.', out, rows),
    panel('Warnung bei falschen Anmeldungen', 'Bei mehr als 10 falschen Anmeldungen an dieser Oberfläche innerhalb von 24 Stunden bekommst du eine WhatsApp-Nachricht an die oben gespeicherte Nummer.', loginWatch));

  let loaded = false, busy = false;
  async function load() {
    try {
      const d = await api('getServiceStatus', undefined, { errorField: false });
      // Nur Geräte, deren Ausfallwarnung man abschalten darf (WLAN-/Integrationsgeräte), mit Häkchen
      const ign = d.services.filter(r => r.canIgnoreWarning);
      rows.replaceChildren(...(ign.length ? ign.map(row => {
        const box = h('input', { type: 'checkbox', checked: row.warningIgnored === true });
        box.addEventListener('change', async () => { box.disabled = true; try { await api('saveOfflineWarning', { id: row.id, ignored: box.checked }); await load(); } catch (e) { box.checked = !box.checked; msg(out, e.message, 'bad'); } finally { box.disabled = false; } });
        return h('div', { class: 'row' }, check(row.name + ' – bewusst ausgeschaltet', box), row.status === 'offline' ? h('span', { class: 'tag ' + (row.warningIgnored ? '' : 'bad'), text: 'gerade offline' }) : null);
      }) : [h('div', { class: 'empty', text: 'Keine Geräte, deren Ausfallwarnung man abschalten kann.' })]));
      if (d.error) msg(out, 'Prüfung fehlgeschlagen: ' + d.error, 'bad');
      if (!loaded) { enabled.checked = d.settings.enabled; phone.value = d.settings.phone || ''; delay.value = d.settings.delaySeconds; loaded = true; }
      keyState.textContent = d.settings.hasKey ? 'API-Schlüssel ist gespeichert.' : 'Noch kein API-Schlüssel gespeichert.';
      delivery.textContent = (d.delivery && d.delivery.message) || 'Noch keine Versandbestätigung vorhanden.';
    } catch (e) { msg(out, 'Status nicht verfügbar: ' + e.message, 'bad'); }
  }
  form.addEventListener('submit', e => {
    e.preventDefault(); if (busy || !form.reportValidity()) return; busy = true;
    const p = { enabled: enabled.checked, phone: phone.value.trim(), apiKey: key.value.trim(), delaySeconds: Number(delay.value) }; key.value = '';
    task(save, result, async () => { try { await api('saveNotifications', p); await load(); return 'Einstellungen gespeichert.'; } finally { p.apiKey = ''; busy = false; } }, 'Wird gespeichert …');
  });
  test.addEventListener('click', () => { if (busy) return; busy = true; task(test, result, async () => { try { const r = await api('testNotification', {}); await load(); return r.message; } finally { busy = false; } }, 'Testnachricht wird gesendet …'); });
  load(); setInterval(() => { if (!document.hidden) load(); }, 30000);
});
