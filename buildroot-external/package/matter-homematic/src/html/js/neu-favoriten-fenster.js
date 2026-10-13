'use strict';
// Favoriten als schwebendes Fenster (Wunsch Thomas, 12.10.2026): auf jeder Seite über „★ Favoriten“ zu öffnen,
// frei verschiebbar (Titelleiste ziehen) und vergrößerbar (Ecke unten rechts). Position, Größe und offen/zu merkt sich
// der Browser. Werte und Bedienung wie auf der Seite „Favoriten“ (gleiche geprüfte Wege; Rechte prüft der Server).
// „⧉ eigenes Fenster“ (Wunsch Thomas: soll beim Seitenwechsel bleiben): öffnet /favoriten-fenster.html als echtes kleines
// Browserfenster – das lädt beim Wechsel der Hauptseite nicht neu und bleibt stehen.
document.addEventListener('DOMContentLoaded', () => {
  if (!window.NEU || location.pathname === '/favoriten.html' || location.pathname === '/login.html') return;
  const MOBIL = location.pathname === '/mobil.html'; // Handy-Startseite (Wunsch Thomas): Kacheln + Favoriten, als App-Symbol nutzbar
  const POPUP = MOBIL || location.pathname === '/favoriten-fenster.html'; // eigenständiges Fenster: Inhalt füllt die ganze Seite
  const { h, api } = NEU;
  const KEY = 'mh-fav-fenster';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
  const save = s => { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...s })); } catch {} };
  const PROVIDERS = { smartplus: 'controlSmartplus', smartlife: 'controlSmartlife', dyson: 'controlDyson', tasmota: 'controlTasmota' };
  const de = (v, n = 1) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });
  const st0 = load();
  const opener = h('button', { class: 'btn fav-opener', type: 'button', text: '★ Favoriten', title: 'Favoriten als Fenster öffnen' });
  const body = h('div', { class: 'fav-body' }), note = h('div', { class: 'fav-note' });
  const close = h('button', { class: 'fav-x', type: 'button', text: '✕', title: 'Schließen', 'aria-label': 'Favoriten schließen' });
  const detach = h('button', { class: 'fav-x', type: 'button', text: '⧉', title: 'In eigenem Fenster öffnen (bleibt beim Seitenwechsel)', 'aria-label': 'Favoriten in eigenem Fenster öffnen' });
  const bar = h('div', { class: 'fav-bar' }, h('b', { text: '★ Favoriten' }), h('a', { href: '/favoriten.html', text: 'bearbeiten', class: 'fav-link', target: POPUP && !MOBIL ? 'mh-haupt' : undefined }), POPUP ? null : detach, POPUP ? null : close);
  const win = h('section', { class: POPUP ? 'fav-float fav-popup' : 'fav-float', role: POPUP ? 'main' : 'dialog', 'aria-label': 'Favoriten', hidden: true }, bar, note, body);
  if (MOBIL) {
    // Große Kacheln für die wichtigsten Wege; „Volle Ansicht“ merkt sich der Tab (sonst landet das Handy immer hier)
    const tile = (href, icon, text, cls = '') => h('a', { class: 'mob-tile ' + cls, href }, h('span', { class: 'mob-ico', text: icon }), h('span', { text }));
    const full = tile('/index.html', '🖥', 'Volle Ansicht'); full.addEventListener('click', () => { try { sessionStorage.setItem('mh-desktop', '1'); } catch {} });
    const out = h('button', { class: 'mob-tile', type: 'button' }, h('span', { class: 'mob-ico', text: '⎋' }), h('span', { text: 'Abmelden' }));
    out.addEventListener('click', async () => { out.disabled = true; try { await api('webLogout', {}); } catch {} location.replace('/login.html'); });
    // ☰ (Wunsch Thomas): Geräte für die Handy-Seite auswählen – gespeichert als Favoritenliste „Handy“
    const menuBtn = h('button', { class: 'mob-menu', type: 'button', text: '☰', 'aria-label': 'Geräte für das Handy auswählen', 'aria-expanded': 'false' });
    // Versionsnummer klein unter dem Namen (Wunsch Thomas 13.10.2026)
    const ver = h('small', { class: 'mob-ver' });
    api('getBridgeStatus').then(s => { if (s.version) ver.textContent = 'Version ' + String(s.version).replace(/-ccu3-neu$/, ''); }).catch(() => {});
    const head = h('header', { class: 'mob-head' }, h('img', { src: '/img/icon-180.png', alt: '', width: 36, height: 36 }), h('div', { class: 'mob-titel' }, h('b', { text: 'CCU Matter' }), ver), menuBtn);
    const drawer = h('aside', { class: 'mob-drawer', hidden: true, 'aria-label': 'Geräte für das Handy' }), shade = h('div', { class: 'mob-shade', hidden: true });
    const openDrawer = async open => {
      drawer.hidden = shade.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('mob-locked', open);
      if (!open) return;
      drawer.replaceChildren(h('p', { class: 'muted', text: 'Geräte werden geladen …' }));
      try {
        const [f, d] = await Promise.all([api('getFavoriten'), api('getDevices')]);
        const lists = f.lists || [], mine = lists.find(l => l.name === 'Handy'), chosen = new Set(mine ? mine.items : lists.flatMap(l => l.items));
        const all = [{ address: 'wetter', name: 'Wetter', room: '' }, ...(d.devices || []).filter(x => x.address && x.name)].sort((a, b) => (a.room || '~').localeCompare(b.room || '~', 'de') || a.name.localeCompare(b.name, 'de'));
        const search = h('input', { type: 'search', placeholder: 'Gerät suchen …', 'aria-label': 'Gerät suchen' }), rows = h('div', { class: 'mob-pick' }), note2 = h('p', { class: 'msg', role: 'status' });
        const draw = () => { const q = search.value.trim().toLowerCase(); rows.replaceChildren(...all.filter(x => !q || (x.name + ' ' + (x.room || '')).toLowerCase().includes(q)).map(x => {
          const cb = h('input', { type: 'checkbox', checked: chosen.has(x.address) }); cb.addEventListener('change', () => { if (cb.checked) chosen.add(x.address); else chosen.delete(x.address); });
          return h('label', { class: 'mob-pick-row' }, cb, h('span', {}, h('b', { text: x.name }), x.room ? h('small', { text: ' · ' + x.room }) : null));
        })); };
        search.addEventListener('input', draw); draw();
        const save = h('button', { class: 'btn primary', type: 'button', text: 'Speichern' }), cancel = h('button', { class: 'btn', type: 'button', text: 'Schließen' });
        cancel.addEventListener('click', () => openDrawer(false));
        save.addEventListener('click', async () => { save.disabled = true; note2.textContent = 'Wird gespeichert …';
          try { const items = [...chosen].slice(0, 60), next = mine ? lists.map(l => l === mine ? { ...l, items } : l) : [...lists, { name: 'Handy', items }];
            await api('saveFavoriten', { lists: next.map(l => ({ ...(l.id ? { id: l.id } : {}), name: l.name, items: l.items })) }); openDrawer(false); refresh(); }
          catch (e) { note2.textContent = e.message; } finally { save.disabled = false; } });
        drawer.replaceChildren(h('h2', { text: 'Geräte auf dem Handy' }), h('p', { class: 'muted', text: 'Angehakte Geräte erscheinen auf der Handy-Seite (höchstens 60).' }), search, rows, note2, h('div', { class: 'mob-drawer-actions' }, cancel, save));
      } catch (e) { drawer.replaceChildren(h('p', { class: 'msg bad', text: e.message }), h('button', { class: 'btn', type: 'button', text: 'Schließen', onclick: () => openDrawer(false) })); }
    };
    menuBtn.addEventListener('click', () => openDrawer(drawer.hidden)); shade.addEventListener('click', () => openDrawer(false));
    // Wunsch Thomas: auf dem Handy nicht auf die großen PC-Seiten springen, wo es eine Handy-Seite gibt
    const tileAlle = tile('#alle', '💡', 'Alle Geräte'), tileJeep = tile('#jeep', '🚙', 'Jeep');
    const tiles = h('nav', { class: 'mob-tiles', 'aria-label': 'Schnellzugriff' }, tile('/anlernen.html', '＋', 'Gerät anlernen', 'primary'), tileAlle, tile('/automationen.html', '⚙', 'Automationen'), tileJeep, full, out);
    const page1 = h('section', { class: 'mob-page', 'aria-label': 'Meine Geräte' }, win), body2 = h('div', { class: 'fav-body' });
    const page2 = h('section', { class: 'mob-page', 'aria-label': 'Menü', hidden: true }, tiles, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '★ Alle Favoriten' }), h('a', { href: '/favoriten.html', text: 'bearbeiten', class: 'fav-link' })), body2));
    // Seite „Alle Geräte“ (Wunsch Thomas): jedes Gerät nur mit Namen und Bedienung, nach Räumen
    const body3 = h('div', { class: 'fav-body' }), page3 = h('section', { class: 'mob-page', 'aria-label': 'Alle Geräte', hidden: true }, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '📋 Alle Geräte' })), body3));
    // Seite „Wetter“ (Wunsch Thomas): dieselbe Wetteranzeige wie auf der Übersicht (neu-wetter.js füllt den Platzhalter)
    const wslot = document.getElementById('wetter-uebersicht') || h('div', { id: 'wetter-uebersicht' }), page4 = h('section', { class: 'mob-page mob-wetter', 'aria-label': 'Wetter', hidden: true }, wslot);
    // Seite „Jeep“ (Wunsch Thomas): Türen, Standort mit Adresse und Karte – eigene Meldezeile
    const jeepBody = h('div', { class: 'fav-body' }), page5 = h('section', { class: 'mob-page', 'aria-label': 'Jeep', hidden: true }, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '🚙 Jeep' })), h('p', { class: 'msg mob-note', role: 'status' }), jeepBody));
    window.mhJeepBody = jeepBody;
    // Seite „⚽ SC“ (Wunsch Thomas): SC Freiburg Männer, 1. Bundesliga – News, Spiele, Tabelle; geladen erst beim Öffnen
    const scBody = h('div', { class: 'fav-body' }), page6 = h('section', { class: 'mob-page', 'aria-label': 'SC Freiburg', hidden: true }, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '⚽ SC Freiburg' })), scBody));
    window.mhScBody = scBody;
    // Seite „🚦 Systemzustand“ (Wunsch Thomas 13.10.2026): Ampel für CCU3, WD, Sicherungen, Dienste, Geräte (neu-systemzustand.js);
    // der schmale Reiter zeigt gleich die aktuelle Ampelfarbe
    const szBody = h('div', { class: 'fav-body' }), page7 = h('section', { class: 'mob-page', 'aria-label': 'Systemzustand', hidden: true }, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '🚦 Systemzustand' })), szBody));
    const szTab = h('button', { class: 'mob-tab mob-tab-ampel', type: 'button', text: '🚦', 'aria-label': 'Systemzustand', title: 'Systemzustand' });
    // Seite „🧹 Saugroboter“ (Wunsch Thomas 13.10.2026): Zustand, Akku, Störungen und Knöpfe; schmaler Reiter wie die Ampel
    const svBody = h('div', { class: 'fav-body' }), page8 = h('section', { class: 'mob-page', 'aria-label': 'Saugroboter', hidden: true }, h('div', { class: 'fav-float fav-popup' }, h('div', { class: 'fav-bar' }, h('b', { text: '🧹 Saugroboter' })), h('p', { class: 'msg mob-note', role: 'status' }), svBody));
    window.mhSvBody = svBody;
    const svTab = h('button', { class: 'mob-tab mob-tab-ampel', type: 'button', text: '🧹', 'aria-label': 'Saugroboter', title: 'Saugroboter' });
    const pages = [page1, page3, page5, page8, page6, page4, page7, page2], tabs = [h('button', { class: 'mob-tab', type: 'button', text: '💡 Meine' }), h('button', { class: 'mob-tab', type: 'button', text: '📋 Alle' }), h('button', { class: 'mob-tab', type: 'button', text: '🚙 Jeep' }), svTab, h('button', { class: 'mob-tab', type: 'button', text: '⚽ SC' }), h('button', { class: 'mob-tab', type: 'button', text: '🌤 Wetter' }), szTab, h('button', { class: 'mob-tab', type: 'button', text: '☰ Menü' })];
    window.mhZustandAmpel?.(szTab);
    let cur = 0; const showPage = n => { cur = Math.max(0, Math.min(pages.length - 1, n)); pages.forEach((p, i) => { p.hidden = i !== cur; tabs[i].setAttribute('aria-pressed', String(i === cur)); }); try { sessionStorage.setItem('mh-mob-seite', String(cur)); } catch {} scrollTo(0, 0); if (pages[cur] === page5) window.mhJeepShow?.(); if (pages[cur] === page6) window.mhScShow?.(); if (pages[cur] === page8) window.mhSvShow?.(); else window.mhSvStop?.(); if (pages[cur] === page7) window.mhZustandShow?.(szBody); else szBody._sz?.stop(); };
    const show2 = second => showPage(second ? cur + 1 : cur - 1);
    tabs.forEach((b, i) => b.addEventListener('click', () => showPage(i)));
    tileAlle.addEventListener('click', e => { e.preventDefault(); showPage(pages.indexOf(page3)); });
    tileJeep.addEventListener('click', e => { e.preventDefault(); showPage(pages.indexOf(page5)); });
    window.mhMobBody3 = body3;
    // Wischen nach links/rechts wechselt die Seite (nur deutliche, waagerechte Bewegung)
    let sx = null, sy = 0; addEventListener('touchstart', e => { if (!drawer.hidden) return; sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    addEventListener('touchend', e => { if (sx === null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null; if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) show2(dx < 0); }, { passive: true });
    window.mhMobBody2 = body2;
    win.querySelector('.fav-bar b').textContent = '💡 Meine Geräte';
    document.title = 'CCU Matter'; document.body.classList.add('mob'); document.body.replaceChildren(head, page1, page3, page5, page8, page6, page4, page7, page2, h('nav', { class: 'mob-tabs', 'aria-label': 'Seiten' }, ...tabs), shade, drawer);
    showPage((() => { try { return Number(sessionStorage.getItem('mh-mob-seite')) || 0; } catch { return 0; } })());
  } else if (POPUP) { document.title = '★ Favoriten'; document.body.replaceChildren(win); } else document.body.append(opener, win);
  // Größe/Position anwenden (im sichtbaren Bereich halten)
  const place = () => {
    if (POPUP) return;
    const s = load(), w = Math.min(Math.max(s.w || 380, 260), innerWidth - 16), hgt = Math.min(Math.max(s.h || 420, 180), innerHeight - 16);
    const x = Math.min(Math.max(s.x ?? innerWidth - w - 24, 8), innerWidth - w - 8), y = Math.min(Math.max(s.y ?? 90, 8), innerHeight - 60);
    Object.assign(win.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: hgt + 'px' });
  };
  // Ziehen an der Titelleiste
  let drag = null;
  bar.addEventListener('pointerdown', e => { if (e.target.closest('button, a')) return; drag = { dx: e.clientX - win.offsetLeft, dy: e.clientY - win.offsetTop }; bar.setPointerCapture(e.pointerId); });
  bar.addEventListener('pointermove', e => { if (!drag) return; const x = Math.min(Math.max(e.clientX - drag.dx, 0), innerWidth - 80), y = Math.min(Math.max(e.clientY - drag.dy, 0), innerHeight - 40); win.style.left = x + 'px'; win.style.top = y + 'px'; });
  bar.addEventListener('pointerup', () => { if (!drag) return; drag = null; save({ x: win.offsetLeft, y: win.offsetTop }); });
  // Vergrößern (CSS resize) merken
  // Größe erst speichern, wenn sie von Hand geändert wurde (Ziehen an der Ecke endet mit pointerup am Fenster)
  win.addEventListener('pointerup', () => { if (win.hidden) return; const s = load(); if (Math.abs((s.w || 0) - win.offsetWidth) > 2 || Math.abs((s.h || 0) - win.offsetHeight) > 2) save({ w: win.offsetWidth, h: win.offsetHeight }); });
  addEventListener('resize', () => { if (!win.hidden) place(); });
  // Inhalt
  let devices = new Map(), wetter = null, timer = null, jeepUntil = 0;
  // Meldezeile: auf der Jeep-Seite deren eigene (sonst wäre die Meldung auf einer anderen Seite unsichtbar)
  const noteFor = b => b.closest('.mob-page')?.querySelector('.mob-note') || note;
  const ctl = (text, fn, cls = '', address = '') => { const b = h('button', { class: 'btn small ' + cls, type: 'button', text }); b.addEventListener('click', async () => { b.disabled = true; const n = noteFor(b); try { const r = await fn(n); n.textContent = r?.message || 'Übergeben.'; if (address && r?.confirmed === false && typeof r.requestedState === 'boolean') followSwitch(address, r.requestedState, n); else setTimeout(refresh, 1500); } catch (e) { n.textContent = e.message; } finally { b.disabled = false; } }); return b; };
  // Ein/Aus als Symbol (Wunsch Thomas 13.10.2026): der Knopf aus ctl() bekommt Aussehen und Beschriftung von NEU.powerButton
  const asIcon = (b, art, on, label) => { const p = NEU.powerButton(art, on === true, label); b.className = p.className; b.title = p.title; b.setAttribute('aria-label', p.getAttribute('aria-label')); b.replaceChildren(...p.childNodes); return b; };
  // Nach „Befehl an CCU übergeben; warte auf Rückmeldung“: Zustand nach 2, 5, 10 und 20 s nachlesen und die Meldung ersetzen
  // (vorher blieb die Wartemeldung stehen). Danach keine weitere Abfrage.
  function followSwitch(address, want, n) {
    const sent = n.textContent, name = devices.get(address)?.name || 'Gerät';
    [2000, 5000, 10000, 20000].forEach((ms, i, all) => setTimeout(async () => {
      if (n.textContent !== sent) return; // inzwischen andere Meldung → nichts überschreiben
      await refresh(); const s = devices.get(address)?.switchState;
      if (s === want) n.textContent = '✓ ' + name + ' ist ' + (want ? 'ein' : 'aus') + ' (von der CCU bestätigt).';
      else if (i === all.length - 1) n.textContent = '⚠ Keine Bestätigung von der CCU – ' + name + ' meldet ' + (s === true ? 'ein' : s === false ? 'aus' : 'unbekannt') + '. Bitte am Gerät prüfen.';
    }, ms));
  }
  // Meldezeile nach einem Jeep-Befehl: bis die Bestätigung vom Fahrzeug da ist (höchstens 75 s, alle 4 s) nachfragen und anzeigen
  function followJeep(at, out = note) {
    const until = Date.now() + 75000;
    const step = async () => {
      if (Date.now() > until) return;
      try { const last = (await api('getJeepRemote')).last; if (last && last.at === at) { out.textContent = last.message; if (last.state !== 'waiting') { setTimeout(refresh, 500); return; } } } catch { return; }
      setTimeout(step, 4000);
    };
    setTimeout(step, 4000);
  }
  // Handy-Seite „Jeep“: Türen (ein Knopf), Standort mit Adresse, Zeit und Karte (Kacheln über die Bridge), Apple Karten
  let jeepPos = null, jeepPosErr = '', jeepPosAt = 0, jeepLoading = false;
  async function loadJeepPos(fresh) {
    if (jeepLoading) return; jeepLoading = true; renderJeep();
    try { jeepPos = await api('getJeepStandort', undefined, fresh ? { query: { neu: '1' } } : {}); jeepPosErr = ''; } catch (e) { jeepPosErr = e.message; }
    jeepPosAt = Date.now(); jeepLoading = false; renderJeep();
  }
  let jeepVin = null, jeepPlans = null, jeepPlansErr = '';
  // Zeitpläne wie auf der Jeep-Seite (nur ansehen; Bearbeiten auf der Jeep-Seite) – aus der Fahrzeugmeldung, keine Cloud-Abfrage
  const loadPlans = () => jeepVin && api('getJeepZeitplaene', undefined, { query: { vin: jeepVin } }).then(r => { jeepPlans = r; jeepPlansErr = ''; renderJeep(); }).catch(e => { jeepPlansErr = e.message; renderJeep(); });
  window.mhJeepShow = () => { if (!jeepVin) api('getJeepRemote').then(s => { jeepVin = s.vehicles?.[0]?.vin || null; loadPlans(); renderJeep(); }).catch(() => {}); else loadPlans(); if (Date.now() - jeepPosAt > 300000) loadJeepPos(false); else renderJeep(); };
  // Lichter blinken lassen (Uconnect kennt kein Dauer-An/Aus); gleiche 20-s-Sperre wie die Türen
  function lightsButton() {
    const label = '💡 Lichter blinken lassen';
    const tick = () => { const left = Math.ceil((jeepUntil - Date.now()) / 1000); if (!b.isConnected) return; if (left > 0) { b.disabled = true; b.textContent = label + ' (' + left + ' s)'; setTimeout(tick, 1000); } else { b.disabled = false; b.textContent = label; } };
    const b = ctl(label, async () => { jeepUntil = Date.now() + 20000; try { return await api('runJeepRemote', { vin: jeepVin, action: 'licht', on: true }); } finally { setTimeout(tick, 0); } });
    setTimeout(tick, 50); return b;
  }
  const whenText = iso => { const t = new Date(iso); if (!Number.isFinite(t.getTime())) return 'unbekannt'; const hm = t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'; return new Date().toDateString() === t.toDateString() ? 'heute ' + hm : t.toLocaleDateString('de-DE') + ' ' + hm; };
  // Handy-Seite „🧹 Saugroboter“: Übersicht und Knöpfe (getEcovacs / controlEcovacs, gleiche Rechte wie auf der PC-Seite).
  // Solange die Seite offen ist, alle 10 s den Zustand der Bridge lesen (die Cloud fragt die Bridge selbst sparsam ab).
  let sv = null, svTimer = null, svBusy = false;
  async function loadSv() { try { sv = await api('getEcovacs'); } catch (e) { sv = { error: e.message }; } renderSv(); }
  window.mhSvShow = () => { loadSv(); clearInterval(svTimer); svTimer = setInterval(() => { if (!document.hidden && !svBusy) loadSv(); }, 10000); };
  window.mhSvStop = () => { clearInterval(svTimer); svTimer = null; };
  function renderSv() {
    const body = window.mhSvBody; if (!body) return;
    const note = body.closest('.mob-page')?.querySelector('.mob-note');
    if (!sv || sv.error && !sv.robot) { body.replaceChildren(h('p', { class: 'muted', text: sv?.error || 'Wird gelesen …' })); return; }
    if (!sv.connected) { body.replaceChildren(h('p', { class: 'muted', text: 'Saugroboter nicht verbunden. Das Konto verbindet ein Administrator am PC unter Integrationen → Saugroboter.' })); return; }
    const s = sv.state || {}, pct = v => Number.isFinite(v) ? v + ' %' : '–';
    const go = (label, action, cls, extra) => { const b = h('button', { class: 'btn ' + (cls || ''), type: 'button', text: label }); b.addEventListener('click', async () => {
      b.disabled = true; svBusy = true; if (note) note.textContent = 'Befehl wird gesendet …';
      try { const r = await api('controlEcovacs', { action, ...(extra || {}) }); if (note) note.textContent = r.message || 'Übergeben.'; setTimeout(loadSv, 3500); } catch (e) { if (note) note.textContent = e.message; } finally { b.disabled = false; svBusy = false; } }); return b; };
    const out = [];
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: sv.robot ? sv.robot.name : 'Saugroboter' }),
      h('div', { class: 'sv-status' }, h('b', { class: 'sv-zustand', text: s.label || 'unbekannt' }), h('span', { class: 'sv-akku' + (s.batteryLow ? ' bad' : ''), text: '🔋 ' + pct(s.battery) + (s.charging ? ' · lädt' : '') })),
      ...(s.errors || []).map(e => h('div', { class: 'notice bad', text: '⚠ ' + e.text })),
      h('p', { class: 'muted small', text: 'Stand: ' + whenText(sv.updatedAt) })));
    const running = ['cleaning', 'returning'].includes(s.state), paused = s.state === 'paused';
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Reinigung' }), h('div', { class: 'sv-knoepfe' },
      paused ? go('▶ Weiter', 'resume', 'primary') : running ? null : go('▶ Starten', 'start', 'primary'),
      running ? go('⏸ Pause', 'pause') : null,
      running || paused ? go('⏹ Stopp', 'stop') : null,
      s.state !== 'docked' ? go('🏠 Zur Station', 'home') : null,
      go('🔔 Finden', 'find'))));
    if ((sv.rooms || []).length) {
      const boxes = sv.rooms.map(r => h('input', { type: 'checkbox', value: String(r.id), 'aria-label': r.name }));
      const roomGo = h('button', { class: 'btn primary', type: 'button', text: 'Ausgewählte Räume reinigen' });
      roomGo.addEventListener('click', async () => { const ids = boxes.filter(x => x.checked).map(x => Number(x.value)); if (!ids.length) { if (note) note.textContent = 'Mindestens einen Raum auswählen.'; return; } roomGo.disabled = true; try { const r = await api('controlEcovacs', { action: 'rooms', rooms: ids, count: 1 }); if (note) note.textContent = r.message || 'Übergeben.'; setTimeout(loadSv, 3500); } catch (e) { if (note) note.textContent = e.message; } finally { roomGo.disabled = false; } });
      out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Räume' }), h('div', { class: 'sv-raeume' }, ...sv.rooms.map((r, i) => h('label', { class: 'row' }, boxes[i], h('span', { text: r.name })))), roomGo));
    }
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Station' }), h('div', { class: 'sv-knoepfe' },
      go('Absaugen', 'empty'), s.station === 'washing' ? go('Waschen beenden', 'washStop') : go('Mopp waschen', 'wash'), s.station === 'drying' ? go('Trocknen beenden', 'dryStop') : go('Mopp trocknen', 'dry'))));
    const wear = (sv.life || []).filter(l => Number.isFinite(l.percent) && l.percent < 10);
    if (sv.stats || wear.length) out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Übersicht' }),
      sv.stats ? h('p', { text: 'Letzte Reinigung: ' + sv.stats.area + ' m² in ' + sv.stats.minutes + ' Min (' + whenText(sv.stats.start) + ')' }) : null,
      ...wear.map(l => h('p', {}, h('span', { class: 'tag bad', text: 'bald wechseln' }), ' ' + l.name + ' (' + l.percent + ' %)'))));
    body.replaceChildren(...out);
  }
  // Handy-Seite „⚽ SC“: SC Freiburg (Männer, 1. Bundesliga). Daten holt die Bridge (kicker-News, OpenLigaDB), 30 min gemerkt.
  let sc = null, scErr = '', scLoading = false;
  async function loadSc(fresh) { if (scLoading) return; scLoading = true; renderSc(); try { sc = await api('getScFreiburg', undefined, fresh ? { query: { neu: '1' } } : {}); scErr = ''; } catch (e) { scErr = e.message; } scLoading = false; renderSc(); }
  window.mhScShow = () => { if (!sc || Date.now() - Date.parse(sc.at) > 30 * 60000) loadSc(false); else renderSc(); };
  const kickoff = iso => { const t = new Date(iso); return Number.isFinite(t.getTime()) ? t.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + ' · ' + t.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : ''; };
  function renderSc() {
    const body = window.mhScBody; if (!body) return;
    const out = [], upd = h('button', { class: 'btn small', type: 'button', text: scLoading ? 'Wird geladen …' : 'Aktualisieren', disabled: scLoading });
    upd.addEventListener('click', () => loadSc(true));
    if (!sc) { body.replaceChildren(h('p', { class: 'muted', text: scLoading ? 'Wird geladen …' : scErr || 'Noch nichts geladen.' }), upd); return; }
    const game = (m, label) => h('div', { class: 'sc-game' }, h('div', { class: 'muted small', text: label + ' · ' + [m.matchday, kickoff(m.at)].filter(Boolean).join(' · ') }),
      h('div', { class: 'sc-teams' }, h('span', { class: m.home === sc.team ? 'sc-own' : '', text: m.home }), h('b', { class: 'sc-score', text: m.score ? m.score.join(' : ') : '–:–' }), h('span', { class: m.away === sc.team ? 'sc-own' : '', text: m.away })));
    const games = [...sc.last.slice(0, 1).map(m => game(m, 'Letztes Spiel')), ...sc.next.map((m, i) => game(m, i ? 'Danach' : 'Nächstes Spiel'))];
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Spiele · Bundesliga ' + sc.season }), ...(games.length ? games : [h('p', { class: 'muted', text: 'Keine Spiele gefunden.' })])));
    const own = sc.table.findIndex(t => t.own), rows = sc.table.filter((t, i) => i < 3 || Math.abs(i - own) <= 2);
    if (sc.table.length) out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Tabelle' }),
      h('table', { class: 'sc-table' }, h('tbody', {}, ...rows.map(t => h('tr', { class: t.own ? 'sc-own' : '' }, h('td', { text: t.place + '.' }), h('td', { text: t.short || t.team }), h('td', { class: 'muted', text: t.matches + ' Sp.' }), h('td', { class: 'muted', text: t.goals }), h('td', { class: 'sc-pts' }, h('b', { text: String(t.points) }))))))));
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'News' }), ...(sc.news.length ? sc.news.map(n => h(n.link ? 'a' : 'div', { class: 'sc-news', ...(n.link ? { href: n.link, target: '_blank', rel: 'noopener' } : {}) },
      h('b', { text: n.title }), n.text ? h('span', { text: n.text }) : null, h('span', { class: 'muted small', text: n.at ? whenText(n.at) : '' }))) : [h('p', { class: 'muted', text: 'Keine News.' })])));
    out.push(h('p', { class: 'muted small', text: 'Stand: ' + whenText(sc.at) + ' · ' + sc.sources + (sc.errors.length ? ' · ⚠ ' + sc.errors.join(', ') : '') }), upd);
    body.replaceChildren(...out);
  }
  // Handy-Unterseite „Zeitpläne“: anzeigen und bearbeiten wie in der Jeep-App, ohne die große Jeep-Seite
  let jeepView = 'main', jeepEdit = null;
  const WOCHE = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const tageText = d => !Array.isArray(d) || !d.length ? 'keine Tage' : d.length === 7 ? 'täglich' : d.join(', ');
  const planText = p => (p.title || 'Plan ' + p.nr) + ' · ' + (p.type === 'CHARGE' ? (p.start || '–') + '–' + (p.end || '–') : 'Abfahrt ' + (p.end || '–')) + ' Uhr · ' + tageText(p.days);
  function planForm(p) {
    const lbl = (text, el) => h('label', { class: 'field' }, h('span', { text }), el), chk = (text, el) => h('label', { class: 'row' }, el, h('span', { text }));
    const type = h('select', {}, h('option', { value: 'CLIMATE', text: 'Klimaplan' }), h('option', { value: 'CHARGE', text: 'Ladeplan' })); type.value = p.type === 'CHARGE' ? 'CHARGE' : 'CLIMATE';
    const active = h('input', { type: 'checkbox', checked: p.type === 'NONE' || p.active }), end = h('input', { type: 'time', value: p.end && p.end !== '00:00' ? p.end : '07:30', required: true }), start = h('input', { type: 'time', value: p.start || '00:00' });
    const cabin = h('input', { type: 'checkbox', checked: p.type === 'NONE' || p.cabinPriority }), full = h('input', { type: 'checkbox', checked: p.chargeToFull }), repeat = h('input', { type: 'checkbox', checked: p.type === 'NONE' || p.repeat });
    const days = WOCHE.map(t => h('input', { type: 'checkbox', checked: (p.days || []).includes(t), 'aria-label': t }));
    const endLbl = lbl('Abfahrtszeit', end), startLbl = lbl('Laden ab', start), cabinLbl = chk('Klima auch im Energiesparmodus', cabin), fullLbl = chk('Bis voll laden', full);
    const show = () => { const c = type.value === 'CLIMATE'; endLbl.firstChild.textContent = c ? 'Abfahrtszeit' : 'Laden bis'; startLbl.hidden = fullLbl.hidden = c; cabinLbl.hidden = !c; };
    const out = h('p', { class: 'msg', role: 'status' }), save = h('button', { class: 'btn primary', type: 'submit', text: 'Im Auto speichern' }), cancel = h('button', { class: 'btn', type: 'button', text: 'Abbrechen' });
    const form = h('form', { class: 'fav-list jeep-planform' }, h('div', { class: 'fav-title', text: 'Plan ' + p.nr + (p.type === 'NONE' ? ' anlegen' : ' bearbeiten') }),
      lbl('Art', type), chk('Plan aktiv', active), endLbl, startLbl, cabinLbl, fullLbl,
      h('div', { class: 'field' }, h('span', { text: 'Tage' }), h('div', { class: 'jeep-tage' }, ...WOCHE.map((t, i) => chk(t, days[i])))), chk('Wöchentlich wiederholen', repeat),
      h('div', { class: 'actions' }, save, cancel), out);
    type.addEventListener('change', show); show();
    cancel.addEventListener('click', () => { jeepEdit = null; renderJeep(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const plan = { type: type.value, active: active.checked, start: type.value === 'CHARGE' ? start.value : '00:00', end: end.value, days: WOCHE.filter((t, i) => days[i].checked), repeat: repeat.checked, cabinPriority: cabin.checked, chargeToFull: full.checked };
      if (plan.active && !plan.days.length) { out.textContent = 'Mindestens einen Tag wählen.'; return; }
      if (!await NEU.confirmDialog({ title: 'Plan ' + p.nr + ' im Auto speichern?', text: planText({ ...plan, title: plan.type === 'CLIMATE' ? 'Klimaplan' : 'Ladeplan' }) + (plan.active ? ', aktiv' : ', aus') + '. Der Plan geht mit deiner Uconnect-PIN über die Uconnect-Cloud an das Auto.', confirm: 'Speichern' })) return;
      save.disabled = cancel.disabled = true; out.textContent = 'Wird an das Auto gesendet …';
      const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 135000);
      try {
        const r = await api('saveJeepZeitplan', { vin: jeepVin, nr: p.nr, plan }, { signal: ctrl.signal });
        out.textContent = (r?.message || 'Gesendet.') + ' Die Anzeige folgt, sobald das Auto den neuen Plan meldet (meist 2–5 Minuten).';
        [150000, 330000].forEach(ms => setTimeout(loadPlans, ms));
      } catch (err) { out.textContent = err.message; } finally { clearTimeout(t); save.disabled = cancel.disabled = false; }
    });
    return form;
  }
  function renderPlans(body) {
    const back = h('button', { class: 'btn small', type: 'button', text: '← Zurück zum Jeep' }); back.addEventListener('click', () => { jeepView = 'main'; jeepEdit = null; scrollTo(0, 0); renderJeep(); });
    const out = [h('div', { class: 'fav-row' }, back)];
    const plans = jeepPlans?.plans || [], canEdit = jeepPlans?.source === 'Fahrzeugmeldung';
    if (!plans.length) out.push(h('p', { class: 'muted', text: jeepPlansErr || (jeepPlans ? 'Keine Zeitpläne gespeichert.' : 'Wird gelesen …') }));
    for (const p of plans) {
      if (jeepEdit === p.nr) { out.push(planForm(p)); continue; }
      const btn = canEdit ? h('button', { class: 'btn small', type: 'button', text: p.type === 'NONE' ? 'Anlegen' : 'Bearbeiten' }) : null;
      btn?.addEventListener('click', () => { jeepEdit = p.nr; renderJeep(); });
      out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Plan ' + p.nr + (p.type === 'NONE' ? ' · frei' : ' · ' + (p.title || '')) }),
        p.type === 'NONE' ? null : h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: (p.type === 'CHARGE' ? 'Laden ' + (p.start || '–') + '–' + (p.end || '–') : 'Abfahrt ' + (p.end || '–')) + ' Uhr' }), h('span', { class: 'tag ' + (p.active ? 'ok' : ''), text: p.active ? 'aktiv' : 'aus' })),
        p.type === 'NONE' ? null : h('p', { class: 'muted', text: tageText(p.days) + (p.repeat ? ' · wöchentlich' : '') }),
        btn ? h('div', { class: 'fav-row' }, btn) : null));
    }
    if (jeepPlans) out.push(h('p', { class: 'muted small', text: 'Quelle: ' + jeepPlans.source + (jeepPlans.vehicleUpdatedAt ? ' vom ' + whenText(jeepPlans.vehicleUpdatedAt) : '') + (canEdit ? '' : ' – bearbeiten geht erst, wenn das Auto seine Pläne gemeldet hat.') }));
    body.replaceChildren(...out);
  }
  function renderJeep() {
    const body = window.mhJeepBody; if (!body) return;
    // Offenes Formular nicht durch die regelmäßige Aktualisierung überschreiben
    if (jeepView === 'plaene') return jeepEdit !== null && body.querySelector('.jeep-planform') ? undefined : renderPlans(body);
    const lock = [...devices.keys()].find(a => /^jeep@[a-f0-9]{24}-lock$/.test(a)), out = [];
    out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Türen' }), lock ? h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: 'Jeep Türen' }), value(lock)) : h('p', { class: 'muted', text: 'Türschloss nicht verfügbar (Jeep verbunden? Uconnect-PIN gespeichert?).' })));
    if (jeepVin) out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Lichter' }), h('div', { class: 'fav-row' }, lightsButton())));
    // Klima sofort (läuft beim Compass über einen kurzzeitigen Klimaplan, Abfahrt in ~20 min) – gleiche 20-s-Sperre
    if (jeepVin) {
      const label = '🔥 Klima sofort';
      const tick = () => { const left = Math.ceil((jeepUntil - Date.now()) / 1000); if (!kb.isConnected) return; if (left > 0) { kb.disabled = true; kb.textContent = label + ' (' + left + ' s)'; setTimeout(tick, 1000); } else { kb.disabled = false; kb.textContent = label; } };
      const kb = ctl(label, async () => { if (!await NEU.confirmDialog({ title: 'Klima jetzt einschalten?', text: 'Der Jeep heizt bzw. kühlt jetzt vor (über einen kurzzeitigen Klimaplan, etwa 20 Minuten). Der Plan wird danach automatisch zurückgesetzt.', confirm: 'Einschalten' })) return { message: 'Nicht eingeschaltet.' }; jeepUntil = Date.now() + 20000; try { return await api('runJeepRemote', { vin: jeepVin, action: 'klima', on: true }); } finally { setTimeout(tick, 0); setTimeout(loadPlans, 5000); } }, 'primary');
      setTimeout(tick, 50);
      out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Klima' }), h('div', { class: 'fav-row' }, kb)));
      const plans = (jeepPlans?.plans || []).filter(p => p.type !== 'NONE');
      // Wunsch Thomas: Zeitpläne auf einer eigenen Handy-Seite statt der großen Jeep-Seite
      const open = h('button', { class: 'btn small', type: 'button', text: '🗓 Zeitpläne ansehen & bearbeiten' }); open.addEventListener('click', () => { jeepView = 'plaene'; scrollTo(0, 0); renderJeep(); });
      out.push(h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: 'Zeitpläne' }),
        ...(plans.length ? plans.map(p => h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: planText(p) }), h('span', { class: 'tag ' + (p.active ? 'ok' : ''), text: p.active ? 'aktiv' : 'aus' }))) : [h('p', { class: 'muted', text: jeepPlansErr || (jeepPlans ? 'Keine Zeitpläne gespeichert.' : 'Wird gelesen …') })]),
        h('div', { class: 'fav-row' }, open)));
    }
    const pos = [h('div', { class: 'fav-title', text: 'Standort' })];
    if (jeepPos) {
      const m = jeepPos.map, imgs = [], route = 'https://maps.apple.com/?daddr=' + jeepPos.lat.toFixed(6) + ',' + jeepPos.lon.toFixed(6) + '&dirflg=w';
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) imgs.push(h('img', { src: '/api/?method=getJeepKarte&x=' + (m.x + dx) + '&y=' + (m.y + dy), alt: '', decoding: 'async' }));
      const pin = h('span', { class: 'jeep-pin', text: '🚙', style: 'left:' + ((256 + m.px) / 768 * 100).toFixed(2) + '%;top:' + ((256 + m.py) / 768 * 100).toFixed(2) + '%' });
      pos.push(h('p', { text: jeepPos.address || 'Adresse nicht ermittelbar' }), h('p', { class: 'muted', text: 'Stand: ' + whenText(jeepPos.at || jeepPos.readAt) + (jeepPos.approx ? ' · ungefähr' : '') }),
        // Tippen auf Karte oder Knopf (Wunsch Thomas): Apple Karten mit Route vom eigenen Standort zum Jeep (zu Fuß; in der App umstellbar)
        h('a', { class: 'jeep-map', href: route, target: '_blank', rel: 'noopener', 'aria-label': 'Route zum Jeep in Apple Karten' }, h('div', { class: 'jeep-tiles' }, ...imgs), pin), h('p', { class: 'muted small', text: 'Karte © OpenStreetMap-Mitwirkende · Tippen zeigt die Route' }),
        h('a', { class: 'btn small primary', href: route, target: '_blank', rel: 'noopener', text: '🧭 Route zum Jeep' }));
    } else pos.push(h('p', { class: 'muted', text: jeepLoading ? 'Standort wird gelesen …' : jeepPosErr || 'Noch kein Standort gelesen.' }));
    const upd = h('button', { class: 'btn small', type: 'button', text: jeepLoading ? 'Wird gelesen …' : 'Standort aktualisieren', disabled: jeepLoading });
    upd.addEventListener('click', () => loadJeepPos(true)); pos.push(upd);
    out.push(h('div', { class: 'fav-list' }, ...pos));
    body.replaceChildren(...out);
  }
  function value(addr) {
    const box = h('span', { class: 'fav-val' });
    if (addr === 'wetter') { const c = wetter?.current; box.append(c ? [Number.isFinite(c.temperature) ? de(c.temperature) + ' °C' : '', Number.isFinite(c.humidity) ? de(c.humidity, 0) + ' %' : ''].filter(Boolean).join(' · ') : '–'); return box; }
    const d = devices.get(addr); if (!d) { box.append('–'); return box; }
    const st = d.currentState || {};
    if (d.provider === 'jeep' && /-lock$/.test(d.address)) { // Jeep-Türschloss: Zustand + Zu/Auf (Auf mit Rückfrage)
      // Ein Knopf (Wunsch Thomas): verriegelt → „Aufschließen“ (mit Rückfrage), sonst „Abschließen“ (auch bei unbekanntem Zustand).
      // Nach jedem gesendeten Befehl 20 s gesperrt, mit Restzeit; die Sperre überdauert das Neuzeichnen der Seite.
      const locked = st.value === 'verriegelt' || st.lockGuess === 'verriegelt', label = locked ? 'Aufschließen' : 'Abschließen';
      const tick = () => { const left = Math.ceil((jeepUntil - Date.now()) / 1000); if (!b.isConnected) return; if (left > 0) { b.disabled = true; b.textContent = label + ' (' + left + ' s)'; setTimeout(tick, 1000); } else { b.disabled = false; b.textContent = label; } };
      const b = ctl(label, async n => {
        if (locked && !await NEU.confirmDialog({ title: 'Jeep aufschließen?', text: 'Die Türen des Jeep werden über die Uconnect-Cloud entriegelt.', confirm: 'Aufschließen', danger: true })) return { message: 'Abgebrochen.' };
        jeepUntil = Date.now() + 20000;
        try { const r = await api('setJeepSchloss', { address: d.address, lock: !locked }); if (r?.state === 'waiting') followJeep(r.at, n); return r; } finally { setTimeout(tick, 0); }
      }, 'primary');
      setTimeout(tick, 50);
      box.append(h('span', { class: 'muted', text: (st.value || 'Zustand unbekannt') + ' ', title: st.value ? '' : 'Die Jeep-Cloud meldet gerade keinen Türstatus' }), b); return box; }
    if (d.provider === 'jeep') { box.append(st.value == null ? '–' : de(st.value, 0) + ' ' + (st.unit || '')); return box; }
    if (d.provider) {
      if (d.online === false) { box.append(h('span', { class: 'tag bad', text: 'Offline' })); return box; }
      if ((d.capabilities || {}).kind !== 'sensor' && PROVIDERS[d.provider] && typeof st.on === 'boolean') box.append(asIcon(ctl('', () => api(PROVIDERS[d.provider], { id: d.id, command: { on: !st.on } })), (d.capabilities || {}).brightness || (d.capabilities || {}).kind === 'light' ? 'licht' : d.provider === 'dyson' ? 'luefter' : 'stecker', st.on, d.name));
      else box.append([Number.isFinite(st.temperature) ? de(st.temperature) + ' °C' : '', Number.isFinite(st.humidity) ? de(st.humidity, 0) + ' %' : ''].filter(Boolean).join(' · ') || '–');
      return box;
    }
    if (d.thermostatControl?.allowed) { const t = d.thermostatState || {}, cap = d.thermostatControl, sp = Number.isFinite(t.setpoint) ? t.setpoint : null; box.append((Number.isFinite(t.temperature) ? de(t.temperature) + ' °C' : '–') + (sp !== null ? ' → ' + de(sp) + ' °C ' : ' ')); if (sp !== null) box.append(ctl('−', () => api('setThermostatTemperature', { address: d.address, temperature: Math.max(cap.min, sp - 0.5) })), ctl('+', () => api('setThermostatTemperature', { address: d.address, temperature: Math.min(cap.max, sp + 0.5) }))); return box; }
    if (d.dimmerControl?.allowed) { const l = st.currentLevel, p = typeof l === 'number' ? Math.round(l / 254 * 100) : null; box.append(ctl(p ? p + ' %' : 'Aus', () => api('setDimmerLevel', { address: d.address, percent: p ? 0 : 100 }), p ? 'primary' : '')); return box; }
    if (d.switchControl?.allowed) { const s = d.switchState; box.append(asIcon(ctl('', () => api('setSwitchState', { address: d.address, state: s !== true }), '', d.address), /Light/.test(d.matterDeviceType || '') ? 'licht' : 'stecker', s === true, d.name)); return box; }
    if (Number.isFinite(st.localTemperature)) box.append(de(st.localTemperature / 100) + ' °C');
    else if ('stateValue' in st) box.append(st.stateValue ? 'Geschlossen' : 'Offen');
    else if ('occupancy' in st) box.append((st.occupancy & 1) ? 'Bewegung' : 'Ruhe');
    else box.append('–');
    return box;
  }
  async function refresh() {
    clearTimeout(timer); if (win.hidden) return;
    try {
      const [f, d, w] = await Promise.all([api('getFavoriten'), api('getDevices'), api('getWetter').catch(() => null)]);
      devices = new Map((d.devices || []).filter(x => x.address).map(x => [x.address, x])); wetter = w;
      const listNodes = ls => ls.map(l => h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: l.name }), ...l.items.map(a => { const dd = devices.get(a); return h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: a === 'wetter' ? 'Wetter' : dd?.name || a }), value(a)); })));
      if (MOBIL) { const mine = (f.lists || []).find(l => l.name === 'Handy'); body.replaceChildren(...(mine && mine.items.length ? listNodes([{ ...mine, name: '' }]) : [h('p', { class: 'muted', text: 'Noch keine Geräte ausgewählt – oben rechts auf ☰ tippen und Geräte anhaken.' })])); window.mhMobBody2?.replaceChildren(...((f.lists || []).filter(l => l.name !== 'Handy').length ? listNodes(f.lists.filter(l => l.name !== 'Handy')) : [h('p', { class: 'muted', text: 'Keine weiteren Favoriten.' })])); }
      if (MOBIL && window.mhMobBody3) { const all = [...devices.values()].filter(x => x.name).sort((a, b) => (a.room || '~').localeCompare(b.room || '~', 'de') || a.name.localeCompare(b.name, 'de')); const groups = new Map(); for (const x of all) { const g = x.room || 'Ohne Raum'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); } window.mhMobBody3.replaceChildren(...(all.length ? [...groups].map(([g, ls]) => h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: g }), ...ls.map(x => h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: x.name }), value(x.address))))) : [h('p', { class: 'muted', text: 'Keine Geräte.' })])); }
      if (MOBIL) renderJeep();
      const shown = MOBIL ? [] : f.lists || [];
      if (!MOBIL) body.replaceChildren(...(shown.length ? shown.map(l => h('div', { class: 'fav-list' }, h('div', { class: 'fav-title', text: l.name }), ...l.items.map(a => { const dd = devices.get(a); return h('div', { class: 'fav-row' }, h('span', { class: 'fav-name', text: a === 'wetter' ? 'Wetter' : dd?.name || a }), value(a)); }))) : [h('p', { class: 'muted', text: 'Noch keine Favoriten – unter „Favoriten“ anlegen.' })]));
    } catch (e) { note.textContent = 'Favoriten nicht lesbar: ' + e.message; }
    timer = setTimeout(() => { if (!document.hidden) refresh(); else timer = setTimeout(refresh, 15000); }, 15000);
  }
  if (POPUP) { win.hidden = false; refresh(); return; }
  const show = open => { win.hidden = !open; opener.hidden = open; save({ open }); if (open) { place(); refresh(); } else clearTimeout(timer); };
  opener.addEventListener('click', () => show(true)); close.addEventListener('click', () => show(false));
  // Eigenes Fenster: einmal benannt öffnen (ein zweiter Klick holt es nach vorn), schwebendes Fenster schließen
  detach.addEventListener('click', () => { const w = window.open('/favoriten-fenster.html', 'mh-favoriten', 'popup,width=' + Math.max(320, win.offsetWidth) + ',height=' + Math.max(360, win.offsetHeight)); if (w) { w.focus(); show(false); } else note.textContent = 'Der Browser hat das Fenster blockiert – bitte Pop-ups für diese Seite erlauben.'; });
  window.name = window.name || 'mh-haupt';
  if (st0.open) show(true);
});
