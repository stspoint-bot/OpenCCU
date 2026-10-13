'use strict';
// CCU3 Matter – gemeinsamer Rahmen der neuen Seiten: Menü (eine Quelle), Kopfzeile,
// Sitzung/CSRF, API-Aufrufe und sichere DOM-Bausteine. Kein innerHTML mit Daten,
// keine Inline-Skripte (die Content-Security-Policy der Bridge bleibt streng).
(function () {
  const ICON = {
    home: 'M3 9.5 10 3l7 6.5V17H3z', auto: 'M10 2 4 10h4l-1 6 6-8H9z', bell: 'M5 13V8a4 4 0 0 1 8 0v5l1.5 1.5h-11zM7.5 16a1.5 1.5 0 0 0 3 0', plus: 'M9 4v10M4 9h10', devices: 'M2 4h14v10H2zM5 9h1M8 7h6M8 11h4', rooms: 'M3 6h12v9H3zM5 6V4h8v2',
    vars: 'M3 5h12M3 9h12M3 13h12', ccu: 'M3 3h12v12H3zM6 7h6M6 11h4', plug: 'M6 2v4M12 2v4M4 6h10v3a5 5 0 0 1-10 0zM9 14v3',
    system: 'M9 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM9 1v3M9 14v3M1 9h3M14 9h3',
    lock: 'M4 8h10v8H4zM6 8V5a3 3 0 0 1 6 0v3M9 11v2', help: 'M9 1a8 8 0 1 0 0 16A8 8 0 0 0 9 1zM7 7a2 2 0 1 1 3 1.7c-.6.4-1 .8-1 1.5M9 13v.5'
  };
  // Menü nach Aufgaben (Wunsch Thomas 13.10.2026: modern, nichts doppelt, Verwandtes beieinander). Reihenfolge = Häufigkeit:
  // erst bedienen (Zuhause), dann automatisieren, dann Geräte/Integrationen einrichten, zuletzt System, Zugang und Fachleute.
  // Höchstens 6 Einträge je Gruppe; jede Seite genau einmal.
  const MENU = [
    { label: 'Übersicht', href: '/index.html', icon: 'home' },
    { group: 'Zuhause', icon: 'rooms', items: [
      { label: 'Favoriten', href: '/favoriten.html' },
      { label: 'Geräte', href: '/geraete.html' },
      { label: 'Räume', href: '/raeume.html' },
      { label: 'Gewerke', href: '/gewerke.html' },
      { label: 'Diagramme', href: '/diagramme.html' },
      { label: 'Wetter', href: '/wetter.html' }
    ] },
    { group: 'Automationen', icon: 'auto', items: [
      { label: 'Regeln & Bausteine', href: '/automationen.html' },
      { label: 'Direkte Verknüpfungen', href: '/verknuepfungen.html' }
    ] },
    { group: 'Geräte', icon: 'devices', items: [
      { label: 'Neues Gerät anlernen', href: '/anlernen.html' },
      { label: 'Geräteverwaltung', href: '/geraeteverwaltung.html' },
      { label: 'Gerätemeldungen', href: '/zentrale.html' },
      { label: 'Apple Home (Matter)', href: '/apple-home.html' }
    ] },
    { group: 'Integrationen', icon: 'plug', items: [
      { label: 'Jeep', href: '/jeep.html' }, { label: 'Saugroboter', href: '/ecovacs.html' }, { label: 'Tasmota', href: '/tasmota.html' },
      { label: 'Smart Life', href: '/smartlife.html' }, { label: 'SMART+', href: '/smartplus.html' }, { label: 'Dyson', href: '/dyson.html' }
    ] },
    { group: 'System', icon: 'bell', items: [
      { label: 'Systemzustand', href: '/systemzustand.html' },
      { label: 'Sicherung & Wiederherstellung', href: '/backup-storage.html' },
      { label: 'Benachrichtigungen', href: '/services.html' },
      { label: 'Wartung & Neustart', href: '/maintenance.html' },
      { label: 'Einrichtung (neue CCU3)', href: '/einrichtung.html' }
    ] },
    { group: 'Zugang & Sicherheit', icon: 'lock', items: [
      { label: 'Benutzer & Konto', href: '/konto.html' },
      { label: 'Fernzugriff (VPN)', href: '/remote-access.html' },
      { label: 'Firewall', href: '/firewall.html' },
      { label: 'SSH-Zugang', href: '/ssh.html' },
      { label: 'Anmelden als Administrator', href: '/login.html?admin=1' }
    ] },
    { group: 'Für Fachleute', icon: 'system', items: [
      { label: 'Verbindung zur CCU', href: '/verbindung.html' },
      { label: 'CCU-Schnittstellen & Diagnose', href: '/diagnostics.html' },
      { label: 'Netzwerk', href: '/netzwerk.html' },
      { label: 'Zeit & Standort', href: '/zeit.html' }
    ] },
    { label: 'Hilfe', href: '/hilfe.html', icon: 'help' }
  ];

  // ---------- DOM ----------
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), path = document.createElementNS(ns, 'path');
    svg.setAttribute('width', '18'); svg.setAttribute('height', '18'); svg.setAttribute('viewBox', '0 0 18 18'); svg.setAttribute('fill', 'none'); svg.setAttribute('aria-hidden', 'true');
    path.setAttribute('d', ICON[name] || ICON.ccu); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.5'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path); return svg;
  }
  function msg(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }

  // ---------- API ----------
  let session = null;
  async function ensureSession() {
    if (session) return session;
    const r = await fetch('/api/?method=webSession', { cache: 'no-store' });
    if (r.status === 401) { location.replace('/login.html'); throw Error('Anmeldung erforderlich'); }
    if (!r.ok) throw Error('Sitzung nicht verfügbar (' + r.status + ')');
    session = await r.json(); return session; // session-fetch.js übernimmt den CSRF-Schlüssel
  }
  async function api(method, payload, options = {}) {
    if (payload !== undefined) await ensureSession();
    const init = payload === undefined ? { cache: 'no-store', signal: options.signal } : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify(payload), signal: options.signal };
    const query = options.query ? '&' + new URLSearchParams(options.query).toString() : '';
    const r = await fetch('/api/?method=' + encodeURIComponent(method) + query, init);
    if (r.status === 401) { location.replace('/login.html'); throw Error('Anmeldung erforderlich'); }
    let data = null; try { data = await r.json(); } catch { throw Error('Unerwartete Antwort (' + r.status + ')'); }
    if (!r.ok || (data && data.error && options.errorField !== false)) throw Object.assign(Error((data && data.error) || 'Anfrage fehlgeschlagen (' + r.status + ')'), { status: r.status, data });
    return Object.assign(data || {}, { _status: r.status });
  }

  // Leistung: unveränderliche bzw. selten geänderte Kopfdaten pro Browser-Tab kurz merken.
  async function remembered(key, ttl, fn) {
    try { const raw = sessionStorage.getItem('neu-cache-' + key); if (raw) { const v = JSON.parse(raw); if (Date.now() - v.at < ttl) return v.data; } } catch {}
    const data = await fn();
    try { sessionStorage.setItem('neu-cache-' + key, JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  }
  function forget(key) { try { sessionStorage.removeItem('neu-cache-' + key); } catch {} }

  // Mehrfachauslösung verhindern: Knopf sperren, Meldung setzen, Fehler anzeigen.
  async function task(button, out, fn, busyText = 'Wird ausgeführt …') {
    if (button && button.disabled) return;
    if (button) button.disabled = true;
    if (out) msg(out, busyText, 'busy');
    try { const text = await fn(); if (out) msg(out, text || 'Erledigt.', 'ok'); }
    catch (e) { if (out) msg(out, e.message, 'bad'); }
    finally { if (button) button.disabled = false; }
  }


  // Sitzung bei Bedienung aktiv halten (die Bridge meldet nach 15 Minuten ohne Aktion ab).
  let lastActivity = 0;
  async function activity() {
    if (Date.now() - lastActivity < 60000) return; lastActivity = Date.now();
    try { await api('webActivity', {}); } catch {}
  }
  document.addEventListener('pointerdown', activity, { passive: true });
  document.addEventListener('keydown', activity, { passive: true });

  // Eine einzige Live-Verbindung (Server-Sent Events) je Seite; Handler je Ereignistyp.
  let stream = null; const streamHandlers = {};
  function events(handlers) {
    for (const [type, fn] of Object.entries(handlers)) (streamHandlers[type] ||= []).push(fn);
    if (!stream) ensureSession().then(() => {
      stream = new EventSource('/events');
      for (const type of ['ready', 'state', 'dimmer', 'thermostat']) stream.addEventListener(type, e => { let data = {}; try { data = JSON.parse(e.data); } catch {} for (const fn of streamHandlers[type] || []) fn(data); });
      stream.onerror = () => { for (const fn of streamHandlers.error || []) fn(); };
      window.addEventListener('pagehide', () => stream && stream.close(), { once: true });
    }).catch(() => {});
  }
  // ---------- Dialoge ----------
  function confirmDialog({ title, text, confirm = 'Bestätigen', danger = false, slider = false }) {
    return new Promise(resolve => {
      const range = slider ? h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0, 'aria-label': 'Zum Freigeben ganz nach rechts schieben' }) : null;
      const ok = h('button', { class: 'btn ' + (danger ? 'danger solid' : 'primary'), type: 'button', text: confirm });
      const cancel = h('button', { class: 'btn', type: 'button', text: 'Abbrechen' });
      const hint = slider ? h('p', { class: 'muted', text: 'Regler ganz nach rechts schieben, um freizugeben.' }) : null;
      const dlg = h('dialog', { 'aria-label': title }, h('div', { class: 'dlg-head' }, h('h2', { text: title })), h('div', { class: 'dlg-body' }, h('p', { text }), range, hint), h('div', { class: 'dlg-actions' }, cancel, ok));
      let done = false;
      // Direkt auflösen statt auf das „close“-Ereignis zu warten (wird nicht in jedem Browserzustand zugestellt).
      const finish = result => { if (done) return; done = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(result); };
      if (range) { ok.disabled = true; range.addEventListener('input', () => { ok.disabled = range.value !== '100'; hint.textContent = range.value === '100' ? 'Freigegeben.' : 'Regler ganz nach rechts schieben, um freizugeben.'; }); }
      ok.addEventListener('click', () => { if (range && range.value !== '100') return; finish(true); });
      cancel.addEventListener('click', () => finish(false));
      dlg.addEventListener('cancel', () => finish(false));
      dlg.addEventListener('close', () => finish(false));
      document.body.append(dlg); dlg.showModal(); cancel.focus();
    });
  }

  // ---------- Rahmen ----------
  function shell({ title, eyebrow, lead, crumb }) {
    const here = location.pathname;
    const isCurrent = href => href === here || (href === '/index.html' && here === '/');
    const link = item => {
      return h('a', { href: item.href, 'aria-current': isCurrent(item.href) ? 'page' : undefined }, item.icon ? icon(item.icon) : null, item.label);
    };
    const nav = h('nav', { class: 'nav', id: 'main-nav', 'aria-label': 'Hauptmenü' });
    for (const entry of MENU) {
      if (!entry.group) { nav.append(link(entry)); continue; }
      const open = entry.items.some(i => isCurrent(i.href));
      let remembered = false; try { remembered = sessionStorage.getItem('neu-menu-' + entry.group) === 'open'; } catch {}
      const details = h('details', { open: open || remembered }, h('summary', {}, icon(entry.icon), entry.group), h('div', {}, entry.items.map(link)));
      details.addEventListener('toggle', () => { try { sessionStorage.setItem('neu-menu-' + entry.group, details.open ? 'open' : 'closed'); } catch {} });
      nav.append(details);
    }
    const homeState = h('span', { text: 'Apple Home: wird geprüft …' }), homeDot = h('span', { class: 'dot grey' });
    const version = h('span', { class: 'muted' });
    const side = h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('home')), h('div', {}, h('b', {}, 'CCU3 ', h('span', { text: 'Matter' })), h('small', { text: 'Homematic-Zentrale' }))),
      h('button', { class: 'btn small menu-btn', type: 'button', 'aria-controls': 'main-nav', 'aria-expanded': 'false', text: '☰ Menü', onclick: e => { const open = side.classList.toggle('open'); e.currentTarget.setAttribute('aria-expanded', String(open)); e.currentTarget.textContent = open ? '✕ Schließen' : '☰ Menü'; } }),
      nav, h('div', { class: 'side-foot' }, h('div', {}, homeDot, homeState), h('div', {}, version)));
    const status = h('span', { class: 'pill' }, h('span', { class: 'dot grey' }), 'Sitzung wird geprüft …');
    const logout = h('button', { class: 'btn small', type: 'button', text: 'Abmelden' });
    const content = h('div', { class: 'content' }, eyebrow ? h('div', { class: 'eyebrow', text: eyebrow }) : null, h('h1', { text: title }), lead ? h('p', { class: 'lead', text: lead }) : null);
    const page = h('main', { class: 'page', id: 'inhalt' }, h('div', { class: 'topbar' }, h('div', { class: 'crumb' }, h('span', { text: 'CCU3 Matter / ' }), (crumb ? crumb + ' / ' : '') + title), h('div', { class: 'top-tools' }, status, logout)), content);
    document.title = title + ' · CCU3 Matter';
    document.body.prepend(h('a', { class: 'sr-only', href: '#inhalt', text: 'Zum Inhalt springen' }), h('div', { class: 'app' }, side, page));
    // Menü bleibt nach einem Klick an seiner Stelle (jede Seite lädt neu und begänne sonst wieder oben).
    // Nur messen, wenn das Menü sichtbar ist (zugeklapptes Handy-Menü oder verdeckter Tab hätten Höhe 0).
    const restoreNav = () => {
      if (!nav.clientHeight) return;
      try {
        const y = Number(sessionStorage.getItem('neu-nav-scroll'));
        if (y > 0) nav.scrollTop = y;
        const cur = nav.querySelector('[aria-current="page"]'), r = nav.getBoundingClientRect(), b = cur?.getBoundingClientRect();
        if (b && (b.top < r.top || b.bottom > r.bottom)) nav.scrollTop += b.top - r.top - (nav.clientHeight - b.height) / 2;
      } catch {}
    };
    const keepNav = () => { if (nav.clientHeight) try { sessionStorage.setItem('neu-nav-scroll', String(Math.round(nav.scrollTop))); } catch {} };
    restoreNav(); requestAnimationFrame(restoreNav); addEventListener('load', restoreNav);
    nav.addEventListener('click', keepNav); addEventListener('pagehide', keepNav);

    ensureSession().then(s => {
      status.replaceChildren(h('span', { class: 'dot' }), s.admin ? 'Als CCU-Administrator angemeldet' : 'Lokal angemeldet');
      // Schon als Administrator angemeldet: Menüpunkt „Anmelden als Administrator“ ausblenden (Wunsch Thomas)
      if (s.admin) for (const a of nav.querySelectorAll('a[href="/login.html?admin=1"]')) a.hidden = true;
      // Bewohner/Gast (eigene Benutzer): nur Ansehen/Bedienen – Einstellungsseiten im Menü ausblenden (der Server sperrt sie ohnehin)
      if (!s.admin && s.role) { const keep = new Set(['/hilfe.html', '/index.html', '/favoriten.html', '/wetter.html', '/geraete.html', '/geraeteverwaltung.html', '/raeume.html', '/diagramme.html', '/automationen.html', '/verknuepfungen.html', '/zentrale.html', '/konto.html']); for (const a of nav.querySelectorAll('a[href]')) if (!keep.has(a.getAttribute('href'))) a.hidden = true; for (const g of nav.querySelectorAll('details, .nav-group')) if (![...g.querySelectorAll('a[href]')].some(a => !a.hidden)) g.hidden = true; status.replaceChildren(h('span', { class: 'dot' }), 'Angemeldet als ' + (s.user || '') + (s.role === 'gast' ? ' (Gast)' : ' (Bewohner)')); }
    }).catch(e => { status.replaceChildren(h('span', { class: 'dot red' }), e.message); });
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      try { await api('webLogout', {}); location.replace('/login.html'); }
      catch (e) { status.replaceChildren(h('span', { class: 'dot red' }), e.message); logout.disabled = false; }
    });
    remembered('pairing', 30000, () => api('getPairingInfo', undefined, { errorField: false }).then(p => ({ commissioned: p && p.commissioned === true, qrPairingCode: !!(p && p.qrPairingCode) }))).then(p => {
      const linked = p && p.commissioned === true;
      homeDot.className = 'dot ' + (linked ? '' : p && p.qrPairingCode ? 'amber' : 'grey');
      homeState.textContent = linked ? 'Apple Home: gekoppelt' : p && p.qrPairingCode ? 'Apple Home: nicht gekoppelt' : 'Apple Home: unbekannt';
    }).catch(() => { homeState.textContent = 'Apple Home: unbekannt'; });
    remembered('version', 300000, () => api('getBridgeStatus').then(s => ({ version: s.version }))).then(s => { version.textContent = s.version ? 'Version ' + s.version : ''; }).catch(() => {});
    return content;
  }

  function panel(title, sub, ...body) {
    return h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('div', {}, h('h2', { text: title }), sub ? h('p', { text: sub }) : null)), h('div', { class: 'panel-body' }, ...body));
  }
  function field(label, input, hint) { return h('label', { class: 'field' }, label, input, hint ? h('small', { text: hint }) : null); }
  function check(label, input) { return h('label', { class: 'check' }, input, h('span', { text: label })); }
  function toggle(input, label) { return h('label', { class: 'row' }, h('span', { class: 'switch' }, input, h('span')), label ? h('span', { text: label }) : null); }
  function stat(label, value, sub, kind) { return h('div', { class: 'stat' + (kind ? ' ' + kind : '') }, h('span', { text: label }), h('strong', { class: String(value).length > 9 ? 'small' : undefined, text: value }), sub ? h('small', { text: sub }) : null); }
  function table(headers, rows) { return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map(t => h('th', { text: t })))), h('tbody', {}, rows))); }
  function qrSvg(text, label) {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM), b = 3, size = qr.size + b * 2, ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'), bg = document.createElementNS(ns, 'rect'), fg = document.createElementNS(ns, 'path');
    let d = ''; for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + b},${y + b}h1v1h-1z`;
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label || 'QR-Code');
    bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff'); fg.setAttribute('d', d); fg.setAttribute('fill', '#172e32');
    svg.append(bg, fg); return h('div', { class: 'qr' }, svg);
  }
  const fmtDuration = s => { s = Math.max(0, Math.round(Number(s) || 0)); const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} T ${hh} Std` : hh ? `${hh} Std ${m} Min` : `${m} Min`; };
  const fmtDate = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE'); };

  window.NEU = { h, icon, msg, api, ensureSession, events, task, remembered, forget, confirmDialog, shell, panel, field, check, toggle, stat, table, qrSvg, fmtDuration, fmtDate, MENU };
})();
