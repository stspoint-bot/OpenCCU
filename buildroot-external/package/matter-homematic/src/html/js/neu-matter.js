'use strict';
// Seiten der Matter-Bridge: Übersicht (data-page="uebersicht"), Apple Home, Räume, Systemvariablen in Matter.
// Gleiche Bridge-Schnittstellen wie die bisherige Startseite.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, check, msg, task, confirmDialog, stat, table, toggle } = NEU;
  const page = document.documentElement.dataset.page;

  function uebersicht() {
    // Aufgeteilt (Wunsch Thomas): Übersicht = Zentrale + Wetter; Apple Home (Matter) als eigene Seite (CCU-Schnittstellen: neu-system.js).
    const main = page === 'applehome' ? shell({ title: 'Apple Home (Matter)', eyebrow: 'Matter-Bridge', lead: 'Kopplung mit Apple Home und Zustand der Matter-Bridge.' })
      : shell({ title: 'Übersicht', eyebrow: 'CCU3 Matter', lead: 'Zentrale und Wetter auf einen Blick.' });
    // Apple Home
    const state = h('span', { class: 'tag', text: 'Status wird geladen …' }), manual = h('div', { class: 'mono', style: 'font-size:26px;letter-spacing:2px;color:#176c60;font-weight:600', text: '–' });
    const passcode = h('b', { class: 'mono', text: '–' }), discriminator = h('b', { class: 'mono', text: '–' }), bridgeName = h('b', { text: '–' });
    const qr = h('div', {}, h('div', { class: 'empty', text: 'QR-Code wird geladen …' })), qrText = h('div', { class: 'mono muted', style: 'font-size:11px;overflow-wrap:anywhere' });
    const steps = h('ol', { class: 'steps' }, ...['App „Home“ öffnen, oben auf + → „Gerät hinzufügen“ tippen.', 'QR-Code scannen – oder „Weitere Optionen …“ wählen und den Kopplungscode eintippen.', 'Hinweis „Nicht zertifiziertes Gerät“ mit „Trotzdem hinzufügen“ bestätigen, Raum wählen, fertig.'].map(t => h('li', {}, h('span', { text: t }))));
    const paired = h('div', { class: 'notice', hidden: true, text: 'Die Bridge ist bereits mit einem Haushalt gekoppelt. Weitere Personen in Apple Home über „Personen einladen“ hinzufügen – nicht erneut mit diesem Code koppeln.' });
    const home = h('section', { class: 'panel' }, h('div', { class: 'grid2', style: 'gap:0' },
      h('div', { class: 'panel-body', style: 'padding:24px 26px' }, h('h2', { style: 'font-size:20px', text: 'Mit Apple Home verbinden' }), h('p', { class: 'muted', text: 'Die Zentrale meldet sich über Matter als Bridge. Freigegebene Homematic-Geräte erscheinen in der Home-App auf iPhone, iPad und Mac.' }), state,
        h('div', { class: 'card', style: 'margin:16px 0;background:#f6faf7;border-color:#cfe2d7' }, h('span', { class: 'muted', text: 'Kopplungscode für die Home-App' }), manual),
        h('div', { class: 'row', style: 'gap:24px;margin-bottom:14px' }, h('span', {}, 'Setup-Code ', passcode), h('span', {}, 'Discriminator ', discriminator), h('span', {}, 'Bridge ', bridgeName)), steps, paired),
      h('div', { style: 'background:#f9fbf9;border-left:1px solid #e3e9e6;padding:24px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center' }, qr, qrText, h('small', { class: 'muted', text: 'Mit der Kamera der Home-App scannen. Der Code gehört nur zu dieser Zentrale.' }))));
    // Übersicht: statt eigener Zustandskacheln eine Ampelzeile (neu-systemzustand.js, Wunsch Thomas 13.10.2026: doppelte Anzeigen raus)
    const stats = h('div', { class: 'stats' }), ccuStats = h('div'), services = h('a', { href: '/services.html', class: 'muted' });
    if (page === 'applehome') main.append(services, home, stats);
    else main.append(
      panel('Zentrale', 'Zustand von CCU3, WD und Geräten auf einen Blick', ccuStats, h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '/automationen.html', text: 'Automationen' }), h('a', { class: 'btn', href: '/anlernen.html', text: '＋ Neues Gerät anlernen' }), h('a', { class: 'btn', href: '/zentrale.html', text: 'Gerätemeldungen' }))),
      h('div', { id: 'wetter-uebersicht' }));
    const fmtManual = c => { const s = String(c || '').replace(/\D/g, ''); return s.length === 11 ? s.replace(/(\d{4})(\d{3})(\d{4})/, '$1-$2-$3') : s.length === 21 ? s.replace(/(\d{4})(\d{3})(\d{4})(\d{5})(\d{5})/, '$1-$2-$3-$4-$5') : c || '–'; };
    async function pairing() {
      try {
        const p = await api('getPairingInfo', undefined, { errorField: false });
        if (!p || p.error || !p.qrPairingCode) { state.className = 'tag'; state.textContent = 'Kopplungsdaten nicht verfügbar – Bridge startet noch'; return; }
        state.className = 'tag ' + (p.commissioned ? 'ok' : 'warn'); state.textContent = p.commissioned ? 'Gekoppelt – Bridge ist in Apple Home (bzw. einer Matter-App) eingebunden' : 'Noch nicht gekoppelt – bereit zum Hinzufügen';
        steps.hidden = !!p.commissioned; paired.hidden = !p.commissioned;
        manual.textContent = fmtManual(p.manualPairingCode); manual.title = 'Ohne Bindestriche eingeben: ' + String(p.manualPairingCode || '').replace(/\D/g, '');
        qr.replaceChildren(NEU.qrSvg(p.qrPairingCode, 'Matter-QR-Code für Apple Home')); qrText.textContent = p.qrPairingCode;
      } catch (e) { state.textContent = 'Kopplungsdaten nicht lesbar: ' + e.message; }
    }
    async function status() {
      try {
        const s = await api('getBridgeStatus');
        stats.replaceChildren(stat('CCU-Verbindung', s.ccuConnected ? 'Verbunden' : 'Getrennt', s.ccuHost || '', s.ccuConnected ? 'ok' : 'bad'), stat('Geräte in Matter', String(s.deviceCount ?? '–'), (s.endpointCount ?? '–') + ' Matter-Endpunkte'), stat('Matter-Port', String(s.matterPort ?? '–'), 'UDP im Heimnetz'), stat('Laufzeit', NEU.fmtDuration(s.uptime), 'seit dem letzten Bridge-Start'));
        passcode.textContent = s.passcode ?? '–'; discriminator.textContent = s.discriminator ?? '–'; bridgeName.textContent = s.bridgeName || '–';
      } catch (e) { stats.replaceChildren(h('div', { class: 'notice bad', text: 'Bridge-Status nicht verfügbar: ' + e.message })); }
    }
    async function serviceLine() {
      try {
        const d = await api('getServiceStatus', undefined, { errorField: false }), off = d.services.filter(r => r.status === 'offline' && !r.warningIgnored).length, unk = d.services.filter(r => ['unknown', 'pending'].includes(r.status) && !r.warningIgnored).length;
        services.className = 'notice ' + (off || d.error ? 'bad' : unk ? 'warn' : ''); services.style.display = 'flex'; services.style.textDecoration = 'none';
        services.textContent = d.error ? 'Dienstprüfung fehlgeschlagen – Details' : !d.checkedAt ? 'Dienstprüfung läuft …' : off ? off + ' Dienste/Geräte offline' + (unk ? ' · ' + unk + ' nicht prüfbar' : '') + ' – Details' : unk ? unk + ' Dienste/Geräte nicht prüfbar – Details' : 'Alle Dienste online – Status und WhatsApp';
      } catch { services.textContent = ''; }
    }
    if (page === 'applehome') { pairing(); status(); serviceLine(); setInterval(() => { if (!document.hidden) status(); }, 5000); setInterval(() => { if (!document.hidden) { pairing(); serviceLine(); } }, 30000); }
    else window.mhZustandKachel?.(ccuStats);
  }

  // Räume (eigene Raumliste der Bridge): anlegen, umbenennen, löschen – und wie bei den Gewerken die Geräte direkt
  // zuordnen (Wunsch Thomas, 12.10.2026): je Raum die Geräte, „＋ Gerät hinzufügen“, ✕ zum Entfernen (ganzes Gerät).
  function raeume() {
    const main = shell({ title: 'Räume', eyebrow: 'Zuhause', lead: 'Räume anlegen, umbenennen und löschen – und die Geräte direkt hier zuordnen (oder in der Geräteverwaltung beim Gerät).' });
    const name = h('input', { maxlength: 64, placeholder: 'Name des neuen Raums', 'aria-label': 'Neuer Raum' }), add = h('button', { class: 'btn primary', type: 'button', text: 'Raum anlegen' });
    const out = h('p', { class: 'msg', role: 'status' }), list = h('div', { class: 'gw-list' });
    main.append(h('div', { class: 'notice', text: 'Apple-Home-Räume stellst du in der Home-App ein; sie bleiben davon getrennt.' }),
      panel('Neuer Raum', null, h('div', { class: 'gw-row gw-new' }, name, add)), panel('Räume', null, out, list));
    let geraete = [];
    const label = d => d.name + (d.rooms.length > 1 ? ' (' + d.rooms.length + ' Räume)' : '');
    async function loadDevices() {
      const [gv, all, rz] = await Promise.all([api('getGeraeteVerwaltung'), api('getDevices').catch(() => ({ devices: [] })), api('getRaumZuordnung').catch(() => ({ assign: {} }))]);
      const assign = rz.assign || {}, roomsOf = new Map();
      for (const [adr, room] of Object.entries(assign)) { if (!room) continue; const dev = adr.includes('@') ? adr : adr.split(':')[0]; if (!roomsOf.has(dev)) roomsOf.set(dev, new Set()); roomsOf.get(dev).add(room); }
      geraete = [...gv.devices.filter(d => !d.central).map(d => ({ address: d.address, name: d.name, rooms: [...(roomsOf.get(d.address) || [])] })),
        ...(all.devices || []).filter(d => d.provider).map(d => ({ address: d.address, name: d.name || d.address, rooms: [...(roomsOf.get(d.address) || [])] }))]
        .sort((x, y) => x.name.localeCompare(y.name, 'de'));
    }
    async function assignRoom(address, room) { await api('setGeraetRaumGewerk', { address, room }); }
    function render(rooms) {
      list.replaceChildren(...(rooms.length ? rooms.map(r => {
        const input = h('input', { value: r.name, maxlength: 64, 'aria-label': 'Raumname' }), save = h('button', { class: 'btn small', type: 'button', text: 'Umbenennen' }), del = h('button', { class: 'btn small danger', type: 'button', text: 'Löschen' });
        save.addEventListener('click', () => { const n = input.value.trim(); if (!n || n === r.name) return; task(save, out, async () => { await api('setRoomName', { originalName: r.originalName, name: n }); await load(); return 'Raum umbenannt.'; }); });
        input.addEventListener('keydown', e => { if (e.key === 'Enter') save.click(); });
        del.addEventListener('click', async () => { if (!await confirmDialog({ title: 'Raum „' + r.name + '“ löschen?', text: 'Alle Geräte in diesem Raum verlieren die Zuordnung.', confirm: 'Löschen', danger: true })) return; task(del, out, async () => { await api('deleteRoom', { originalName: r.originalName }); await load(); return 'Raum gelöscht.'; }); });
        const mine = geraete.filter(d => d.rooms.includes(r.name));
        const chips = h('div', { class: 'gw-chips' }, ...mine.map(d => { const c = h('button', { class: 'gw-chip', type: 'button', title: 'Aus „' + r.name + '“ entfernen (ganzes Gerät)', text: label(d) + ' ✕' }); c.addEventListener('click', () => task(c, out, async () => { await assignRoom(d.address, ''); await load(); return d.name + ' hat keinen Raum mehr.'; })); return c; }));
        const pick = h('select', { class: 'gw-pick', 'aria-label': 'Gerät zu ' + r.name + ' hinzufügen' }, h('option', { value: '', text: '＋ Gerät hinzufügen …' }),
          ...geraete.filter(d => !d.rooms.includes(r.name)).map(d => h('option', { value: d.address, text: d.name + (d.rooms.length ? ' (bisher ' + d.rooms.join(', ') + ')' : '') })));
        pick.addEventListener('change', () => { if (!pick.value) return; const d = geraete.find(x => x.address === pick.value); task(null, out, async () => { await assignRoom(d.address, r.name); await load(); return d.name + ' → ' + r.name + '.'; }); });
        return h('div', { class: 'gw-card' }, h('div', { class: 'gw-row' }, input, h('span', { class: 'muted gw-count', text: mine.length + ' Gerät(e)' }), save, del), chips, pick);
      }) : [h('div', { class: 'empty', text: 'Keine Räume vorhanden.' })]));
    }
    async function load() {
      try { await loadDevices(); render((await api('getRooms')).rooms || []); }
      catch (e) { msg(out, 'Räume konnten nicht geladen werden: ' + e.message, 'bad'); }
    }
    add.addEventListener('click', () => { if (!name.value.trim()) { name.focus(); return; } task(add, out, async () => { await api('createRoom', { name: name.value.trim() }); name.value = ''; await load(); return 'Raum angelegt.'; }); });
    name.addEventListener('keydown', e => { if (e.key === 'Enter') add.click(); });
    load();
  }

  function variablen() {
    const main = shell({ title: 'Systemvariablen', eyebrow: 'Matter-Bridge', lead: 'Logik-Systemvariablen (wahr/falsch) der CCU als Ein/Aus-Schalter in Apple Home. Änderungen an der CCU werden etwa alle 30 Sekunden übernommen.' });
    const search = h('input', { type: 'search', placeholder: 'Systemvariablen suchen …', 'aria-label': 'Suchen' }), out = h('p', { class: 'msg', role: 'status' }), list = h('div');
    main.append(panel('Logik-Systemvariablen', null, h('div', { class: 'row' }, h('div', { style: 'flex:1 1 260px' }, search)), out, list));
    let vars = [];
    function render() {
      const q = search.value.trim().toLowerCase(), rows = vars.filter(v => !q || (v.name || '').toLowerCase().includes(q) || String(v.id).includes(q));
      list.replaceChildren(rows.length ? table(['In Apple Home', 'Name', 'ID', 'Wert'], rows.map(v => {
        const box = h('input', { type: 'checkbox', checked: !!v.exposed, 'aria-label': v.name + ' freigeben' });
        box.addEventListener('change', async () => { box.disabled = true; try { await api('setSystemVariableExposed', { id: String(v.id), exposed: box.checked }); v.exposed = box.checked; } catch (e) { box.checked = !!v.exposed; msg(out, e.message, 'bad'); } finally { box.disabled = false; } });
        return h('tr', {}, h('td', {}, toggle(box)), h('td', {}, h('b', { text: v.name || v.id })), h('td', { class: 'mono', text: String(v.id) }), h('td', {}, h('span', { class: 'tag ' + (v.value ? 'ok' : ''), text: v.value ? 'wahr' : 'falsch' })));
      })) : h('div', { class: 'empty', text: vars.length ? 'Keine passenden Variablen.' : 'Keine Logik-Systemvariablen gefunden.' }));
    }
    search.addEventListener('input', render);
    api('getSystemVariables').then(d => { vars = d.sysvars || d.variables || []; render(); }).catch(e => msg(out, e.message, 'bad'));
  }

  ({ uebersicht, raeume, variablen }[page] || uebersicht)();
});
