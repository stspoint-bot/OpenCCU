'use strict';
// Kleine Systemseiten: CCU-Schnittstellen & Diagnose, Wartung, Fernzugriff, Einstellungen. Welche Seite gebaut wird, steht in <html data-page="…">.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task, confirmDialog, stat } = NEU;
  const page = document.documentElement.dataset.page;

  const PAGES = {
    // „CCU-Schnittstellen & Diagnose“ (Wunsch Thomas 13.10.2026: beide Menüpunkte zusammengefasst): oben ein-/ausschalten,
    // darunter der Zustand der Verbindungen und der Geräteerkennung.
    diagnose() {
      const main = shell({ title: 'CCU-Schnittstellen & Diagnose', eyebrow: 'Für Fachleute', crumb: 'System', lead: 'Welche Funkschnittstellen der CCU die Bridge nutzt – und ob die Verbindungen dorthin stehen.' });
      const ifaces = h('div'), ifaceOut = h('p', { class: 'msg', role: 'status' });
      const stats = h('div', { class: 'stats' }), list = h('div'), out = h('p', { class: 'msg', role: 'status' });
      const refresh = h('button', { class: 'btn primary', type: 'button', text: 'Erneut prüfen' });
      main.append(panel('Schnittstellen ein-/ausschalten', 'Änderungen gelten nach einem Neustart der Bridge.', ifaces, ifaceOut),
        stats, panel('Verbindungen zur CCU', 'BidCos-RF (Homematic), HmIP-RF (Homematic IP) und virtuelle Geräte.', list, h('div', { class: 'actions' }, refresh), out));
      async function interfaces() {
        try {
          const d = await api('getInterfaces'), names = Object.keys(d.interfaces || {}).filter(n => n !== 'CUxD').sort(); let restart = false;
          ifaces.replaceChildren(...(names.length ? names.map(name => {
            const i = d.interfaces[name]; if (i.enabled !== i.active) restart = true;
            const box = h('input', { type: 'checkbox', checked: !!i.enabled });
            box.addEventListener('change', async () => {
              box.disabled = true;
              try {
                const r = await api('setInterfaceEnabled', { name, enabled: box.checked });
                if (r.restartRequired && await confirmDialog({ title: 'Bridge neu starten?', text: name + (box.checked ? ' eingeschaltet' : ' ausgeschaltet') + '. Jetzt neu starten, damit es wirkt? Apple Home ist kurz nicht erreichbar.', confirm: 'Neu starten' })) { const x = await api('restartBridge', {}); msg(ifaceOut, x.message || 'Neustart ausgelöst.', 'ok'); }
              } catch (e) { box.checked = !box.checked; msg(ifaceOut, e.message, 'bad'); } finally { box.disabled = false; interfaces(); }
            });
            return h('div', { style: 'margin:6px 0' }, NEU.toggle(box, name + '  · Port ' + i.port));
          }) : [h('p', { class: 'muted', text: 'Keine Schnittstellen eingerichtet.' })]));
          if (restart) msg(ifaceOut, 'Neustart nötig: Geänderte Schnittstellen gelten erst nach einem Neustart der Bridge.', 'bad');
        } catch (e) { msg(ifaceOut, e.message, 'bad'); }
      }
      interfaces();
      let controller = null;
      async function load() {
        if (controller) return; controller = new AbortController(); refresh.disabled = true; msg(out, 'Verbindung wird geprüft …', 'busy');
        const timer = setTimeout(() => controller && controller.abort(), 20000);
        try {
          const d = await api('getDiagnostics', undefined, { signal: controller.signal });
          stats.replaceChildren(stat('Version', String(d.version || '–')), stat('Laufzeit', NEU.fmtDuration(d.uptimeSeconds)), stat('Speicher der Bridge', d.memoryMiB && Number.isFinite(d.memoryMiB.rss) ? d.memoryMiB.rss + ' MiB' : '–'), stat('Geräteerkennung', d.discoveryComplete === true ? 'fertig' : d.discoveryComplete === false ? 'läuft' : 'unbekannt', '', d.discoveryComplete === true ? 'ok' : 'warn'));
          const ifaces = Array.isArray(d.interfaces) ? d.interfaces.slice(0, 64).filter(i => i && typeof i === 'object') : [];
          list.replaceChildren(ifaces.length ? NEU.table(['Schnittstelle', 'Zustand', 'Wartende Aufträge', 'RPC-Fehler'], ifaces.map(i => {
            const [label, kind] = i.enabled === false ? ['deaktiviert', ''] : i.retrying === true ? ['Wiederverbindung läuft', 'warn'] : i.connected === true ? ['verbunden', 'ok'] : ['nicht verbunden', 'bad'];
            return h('tr', {}, h('td', { text: String(i.name ?? '–') }), h('td', {}, h('span', { class: 'tag ' + kind, text: label })), h('td', { text: String(i.queued ?? 0) }), h('td', { text: String(i.failed ?? 0) }));
          })) : h('div', { class: 'empty', text: 'Keine Schnittstellen gemeldet.' }));
          msg(out, 'Geprüft um ' + new Date().toLocaleTimeString('de-DE'), 'ok');
        } catch (e) { msg(out, e.name === 'AbortError' ? 'Zeitüberschreitung. Bitte erneut prüfen.' : e.message, 'bad'); }
        finally { clearTimeout(timer); controller = null; refresh.disabled = false; }
      }
      refresh.addEventListener('click', load); window.addEventListener('pagehide', () => controller && controller.abort()); load();
    },

    wartung() {
      const main = shell({ title: 'Wartung & Neustart', eyebrow: 'System', crumb: 'System', lead: 'Neustart der Matter-Bridge, regelmäßiger Neustart der CCU3 und – nur im Notfall – Neueinrichtung der Matter-Kopplung.' });
      const out = h('p', { class: 'msg', role: 'status' });
      const restart = h('button', { class: 'btn primary', type: 'button', text: 'Bridge neu starten' });
      const reset = h('button', { class: 'btn danger', type: 'button', text: 'Matter-Kopplung zurücksetzen …' });
      let busy = false;
      async function run(method, payload) {
        if (busy) return; busy = true; restart.disabled = reset.disabled = true; msg(out, 'Auftrag wird übergeben …', 'busy');
        try { const d = await api(method, payload || {}); msg(out, d.message || 'Auftrag angenommen. Bitte den Dienststatus prüfen.', 'ok'); }
        catch (e) { msg(out, e.message, 'bad'); } finally { busy = false; restart.disabled = reset.disabled = false; }
      }
      restart.addEventListener('click', async () => { if (await confirmDialog({ title: 'Bridge neu starten?', text: 'Die Verbindung zu Apple Home wird für etwa eine Minute unterbrochen. Die Kopplung bleibt erhalten.', confirm: 'Neu starten' })) run('restartBridge'); });
      reset.addEventListener('click', async () => {
        if (await confirmDialog({ title: 'Matter-Kopplung wirklich zurücksetzen?', text: 'Alle Matter-Kopplungen zu Apple Home, Alexa und anderen Systemen werden gelöscht. Die Bridge muss danach in Apple Home neu hinzugefügt werden; Räume, Szenen und Automationen dort ggf. neu einrichten. Namen, Räume und Freigaben in der Bridge bleiben erhalten.', confirm: 'Kopplungen jetzt löschen', danger: true, slider: true }))
          { NEU.forget('pairing'); run('factoryReset', { confirmation: 'PAIRING ZURÜCKSETZEN' }); }
      });
      // Regelmäßiger Neustart der ganzen CCU3 (ersetzt das frühere Skript-Programm)
      const DAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
      const rbOn = h('input', { type: 'checkbox', 'aria-label': 'CCU3 regelmäßig neu starten' }), rbTime = h('input', { type: 'time', value: '04:00', 'aria-label': 'Uhrzeit des Neustarts' });
      const rbDays = DAYS.map(([value, text]) => ({ value, box: h('input', { type: 'checkbox', 'aria-label': 'Neustart am ' + text }), text }));
      const rbNotify = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Vorher WhatsApp-Hinweis senden' });
      const rbSave = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), rbNow = h('button', { class: 'btn danger', type: 'button', text: 'CCU3 jetzt neu starten …' });
      const rbOut = h('p', { class: 'msg', role: 'status' }), rbInfo = h('div', { class: 'stats' }), rbNote = h('div');
      const when = iso => iso ? new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
      function showReboot(d) {
        rbOn.checked = d.settings.enabled; rbTime.value = d.settings.time; rbNotify.checked = d.settings.notify;
        for (const x of rbDays) x.box.checked = d.settings.days.includes(x.value);
        rbInfo.replaceChildren(NEU.stat('Nächster Neustart', d.settings.enabled ? when(d.next) : 'aus', d.settings.enabled ? 'geplant' : 'nicht geplant', d.settings.enabled ? 'ok' : undefined), NEU.stat('Letzter Neustart', when(d.lastRun), d.lastResult ? d.lastResult.message : 'noch keiner über diese Seite', d.lastResult && !d.lastResult.ok ? 'warn' : undefined), NEU.stat('Läuft seit', NEU.fmtDuration(d.uptimeSeconds), 'seit dem letzten Start der CCU3'));
        rbNote.replaceChildren(d.settings.notify && !d.whatsappReady ? h('div', { class: 'notice warn', text: 'WhatsApp ist noch nicht eingerichtet (System → Dienste & WhatsApp). Der Neustart läuft trotzdem, nur ohne Hinweis.' }) : '');
      }
      async function loadReboot() {
        try { showReboot(await api('getScheduledReboot')); }
        catch (e) { rbSave.disabled = rbNow.disabled = true; rbNote.replaceChildren(h('div', { class: 'notice warn' }, h('span', {}, e.status === 403 ? 'Zum Einstellen bitte als CCU-Administrator anmelden. ' : e.message + ' '), e.status === 403 ? h('a', { class: 'btn small primary', href: '/login.html?admin=1', text: 'Anmelden' }) : null)); }
      }
      rbSave.addEventListener('click', () => NEU.task(rbSave, rbOut, async () => {
        const days = rbDays.filter(x => x.box.checked).map(x => x.value);
        if (rbOn.checked && !days.length) throw Error('Bitte mindestens einen Wochentag wählen.');
        const d = await api('saveScheduledReboot', { enabled: rbOn.checked, time: rbTime.value || '04:00', days, notify: rbNotify.checked }); showReboot(d); return d.message;
      }));
      rbNow.addEventListener('click', async () => {
        if (!await confirmDialog({ title: 'CCU3 jetzt neu starten?', text: 'Die ganze Zentrale startet neu. Funkgeräte, Automationen, Apple Home und diese Oberfläche sind etwa 3 Minuten nicht erreichbar. Die Kopplung mit Apple Home bleibt erhalten.', confirm: 'Jetzt neu starten', danger: true, slider: true })) return;
        NEU.task(rbNow, rbOut, async () => (await api('rebootCcuNow', { confirmation: 'CCU NEU STARTEN' })).message, 'Neustart wird ausgelöst …');
      });
      main.append(panel('Matter-Bridge neu starten', 'Hilft, wenn Geräte in Apple Home „Keine Antwort“ zeigen. Die Kopplung bleibt erhalten.', h('div', { class: 'actions' }, restart), out),
        panel('CCU3 regelmäßig neu starten', 'Startet die ganze Zentrale an den gewählten Tagen zur gewählten Uhrzeit neu. Am besten nachts. Vorher sichert die Zentrale ihren Stand.', rbNote, rbInfo,
          h('div', { class: 'form' }, h('div', { class: 'row' }, NEU.toggle(rbOn, 'Regelmäßig neu starten')), NEU.field('Uhrzeit', rbTime), h('div', { class: 'field' }, 'Wochentage', h('div', { class: 'row' }, rbDays.map(x => NEU.check(x.text, x.box)))), h('div', { class: 'row' }, NEU.toggle(rbNotify, 'Vorher WhatsApp-Hinweis senden'))),
          h('div', { class: 'actions' }, rbSave, rbNow), rbOut),
        swPanel(),
        panel('Verbindung mit Apple Home neu einrichten', 'Nur nötig, wenn die Bridge komplett neu gekoppelt werden soll.', h('div', { class: 'notice bad', text: 'Achtung: Deine Bridge ist mit Apple Home verbunden. Das Zurücksetzen trennt alle Geräte aus der Home-App.' }), h('div', { class: 'actions' }, reset)));
      loadReboot();
      // OpenCCU-Software und Herunterfahren (ersetzt die alte Wartungsseite)
      function swPanel() {
        const info = h('div', { class: 'stats' }), o = h('p', { class: 'msg', role: 'status' });
        const check = h('button', { class: 'btn', type: 'button', text: 'Jetzt prüfen' }), upd = h('button', { class: 'btn primary', type: 'button', text: 'Update installieren …', hidden: true }), off = h('button', { class: 'btn danger', type: 'button', text: 'Zentrale herunterfahren …' });
        const show = s => { info.replaceChildren(NEU.stat('Installiert', s.installed || '–', s.platform ? 'OpenCCU (' + s.platform + ')' : 'OpenCCU'), NEU.stat('Verfügbar', s.latest || '–', s.error || (s.updateAvailable ? 'neue Version' : 'aktuell'), s.updateAvailable ? 'warn' : 'ok')); upd.hidden = !s.updateAvailable; upd.textContent = 'Update auf ' + s.latest + ' installieren …'; };
        const load = fresh => api('getCcuSoftware', undefined, fresh ? { query: { neu: '1' } } : {}).then(show).catch(e => msg(o, e.message, 'bad'));
        check.addEventListener('click', () => NEU.task(check, o, async () => { await load(true); return 'Geprüft.'; }, 'Wird online geprüft …'));
        upd.addEventListener('click', async () => {
          if (!await confirmDialog({ title: 'OpenCCU-Update installieren?', danger: true, slider: true, confirm: 'Update starten', text: 'Die Zentrale legt vorher eine Sicherung an, spielt die neue OpenCCU-Version ein und startet neu. Das dauert etwa 10–20 Minuten; währenddessen sind Funk, Automationen und Apple Home nicht erreichbar. Nicht vom Strom trennen.' })) return;
          NEU.task(upd, o, async () => (await api('startCcuUpdate', { bestaetigt: true })).message, 'Update wird gestartet …');
        });
        off.addEventListener('click', async () => {
          if (!await confirmDialog({ title: 'Zentrale herunterfahren?', danger: true, slider: true, confirm: 'Herunterfahren', text: 'Die Zentrale schaltet sich aus. Funk, Automationen, Apple Home und diese Oberfläche sind danach nicht erreichbar. Zum Starten kurz vom Strom trennen und wieder verbinden.' })) return;
          NEU.task(off, o, async () => (await api('shutdownCcuNow', { bestaetigt: true })).message, 'Wird heruntergefahren …');
        });
        load(false);
        return panel('OpenCCU-Software und Herunterfahren', 'Version der Zentrale (online geprüft bei openccu.de). Abgesicherter Modus und Recovery-Modus gibt es nur noch per SSH (Notfall).', info, h('div', { class: 'actions' }, check, upd, off), o);
      }
    },

    fernzugriff() {
      // Einstellungsseite des Zusatzprogramms Matter-Tailscale direkt öffnen (Wunsch Thomas): braucht eine CCU-Sitzung,
      // die die Anmeldung als Administrator liefert; Ziel fest auf diese CCU (Port 80/443 über den Webserver der CCU, die alte Oberfläche ist abgeschaltet).
      function tsButton() {
        const b = h('button', { class: 'btn primary', type: 'button', text: 'Tailscale-Einstellungen öffnen', style: 'margin-top:8px' }), o = h('p', { class: 'msg', role: 'status' });
        b.addEventListener('click', async () => {
          const win = window.open('about:blank', '_blank'), base = location.protocol + '//' + location.hostname + '/addons/tspoint-tailscale/config.cgi?sid=';
          try {
            const r = await api('getTailscaleSeite'), url = r.direct && String(r.url || '').startsWith(base) ? r.url : null;
            if (!url || !/^@[A-Za-z0-9]{6,64}@$/.test(new URL(url).searchParams.get('sid') || '')) { if (win) win.close(); msg(o, r.hint || 'Bitte einmal ab- und wieder als Administrator anmelden, dann erneut klicken.', 'bad'); return; }
            if (win) { win.opener = null; win.location.replace(url); } else location.href = url;
          } catch (e) { if (win) win.close(); msg(o, e.message, 'bad'); }
        });
        return h('div', {}, b, o);
      }
      const main = shell({ title: 'Fernzugriff', eyebrow: 'System', crumb: 'System', lead: 'Von unterwegs sicher auf diese Oberfläche zugreifen – über ein privates VPN (Tailscale), ohne offene Ports im Router.' });
      const state = h('div', { class: 'stats' }, stat('VPN', '…', 'wird geprüft'));
      const address = location.origin;
      main.append(state,
        panel('So öffnest du die Oberfläche von unterwegs', null, h('ol', { class: 'steps' },
          h('li', {}, h('span', { text: 'Auf dem Handy die Tailscale-App einschalten (mit demselben Konto wie die CCU3).' })),
          h('li', {}, h('span', {}, 'Im Browser dieselbe Adresse wie zu Hause öffnen: ', h('b', { class: 'mono', text: address }))),
          h('li', {}, h('span', { text: 'Wie gewohnt anmelden. Die Verbindung läuft verschlüsselt durch das VPN; ohne eingeschaltetes VPN ist die Adresse von außen nicht erreichbar.' }))),
          h('p', { class: 'muted', text: 'Zum Testen zu Hause das WLAN am Handy ausschalten und die Adresse über Mobilfunk öffnen.' })),
        panel('Sicherheit', null, h('ul', {},
          h('li', { text: 'Es gibt keine Portfreigabe im Router und keine öffentliche Adresse. Zugriff haben nur Geräte, die in deinem Tailscale-Konto angemeldet sind.' }),
          h('li', { text: 'Die Anmeldung an dieser Oberfläche bleibt zusätzlich nötig. Nach mehreren falschen Versuchen wird gebremst; bei mehr als 10 falschen Anmeldungen in 24 Stunden kommt eine WhatsApp-Warnung (siehe „Dienste & WhatsApp“).' }),
          h('li', { text: 'Verlierst du ein Handy: im Tailscale-Konto das Gerät entfernen. Danach kommt es nicht mehr ins VPN.' })),
          h('div', { class: 'actions' }, h('a', { class: 'btn', href: '/services.html', text: 'Benachrichtigungen' }))),
        panel('Einmalige Einrichtung', 'Das VPN ist ein eigenes Zusatzprogramm der CCU3 (Matter-Tailscale) mit eigener Einstellungsseite.', h('ol', { class: 'steps' },
          h('li', {}, h('span', {}, 'Auf ', h('b', { text: 'Tailscale-Einstellungen öffnen' }), ' klicken (öffnet die Seite von Matter-Tailscale ohne zweite Anmeldung).'), tsButton()),
          h('li', {}, h('span', {}, 'Mit deinem Tailscale-Konto verbinden und ', h('b', { text: 'Nur CCU' }), ' wählen (empfohlen) oder ', h('b', { text: 'Gesamtes Heimnetz' }), '.')),
          h('li', {}, h('span', {}, 'In der Tailscale-Geräteverwaltung beim CCU-Eintrag ', h('b', { text: '⋯ → Edit route settings' }), ' die angebotene Route aktivieren. Ein grüner Punkt allein bestätigt noch keine Freigabe.')))),
        panel('Sichern und wiederherstellen', null, h('p', {}, 'In der Sicherung den Bereich ', h('b', { text: 'Tailscale – VPN-Anmeldung und Einstellungen' }), ' wählen. Auf einer anderen CCU bleibt deren eigene VPN-Identität erhalten.'), h('a', { class: 'btn', href: '/backup-storage.html', text: 'Zur Sicherung' })));
      api('getServiceStatus', undefined, { errorField: false }).then(d => {
        const vpn = (d.services || []).find(r => r.id === 'tailscale');
        const map = { online: ['verbunden', 'ok'], disabled: ['aus', 'warn'], offline: ['getrennt', 'bad'], unknown: ['unbekannt', 'warn'] };
        const [text, kind] = vpn ? (map[vpn.status] || map.unknown) : ['unbekannt', 'warn'];
        state.replaceChildren(stat('VPN', text, vpn ? vpn.detail : 'Status nicht verfügbar', kind), stat('Adresse dieser Oberfläche', location.host, 'zu Hause und über das VPN gleich'));
      }).catch(() => { state.replaceChildren(stat('VPN', 'unbekannt', 'Status nicht verfügbar', 'warn')); });
    }
  };
  (PAGES[page] || (() => shell({ title: 'Seite nicht gefunden' })))();
});
