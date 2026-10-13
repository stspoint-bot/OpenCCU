'use strict';
// Systemzustand als Ampel (Wunsch Thomas 13.10.2026): PC-Seite /systemzustand.html und Handy-Reiter „🚦 Zustand“
// (mobil.html, über window.mhZustandShow). Daten: /api/?method=getSystemzustand (dist/systemzustand.js).
// 🟢 gut · 🟡 nicht so gut (beobachten) · 🔴 schlecht (dafür kommt auch eine WhatsApp).
(function () {
  const { h, api, msg } = window.NEU;
  const LICHT = { ok: '🟢', hinweis: '🟡', warnung: '🔴', fehler: '🔴' };
  const RANG = { fehler: 0, warnung: 1, hinweis: 2, ok: 3 };
  const GESAMT = {
    gruen: ['🟢', 'Alles in Ordnung', 'CCU3, WD, Sicherungen, Dienste und Geräte laufen normal.'],
    gelb: ['🟡', 'Nicht ganz rund', 'Nichts Dringendes – ein paar Punkte bitte im Auge behalten.'],
    rot: ['🔴', 'Problem', 'Mindestens ein Punkt braucht Aufmerksamkeit. Dafür kommt auch eine WhatsApp.']
  };
  const BEREICHE = ['CCU3', 'WD', 'Sicherungen', 'Dienste & Integrationen', 'Geräte', 'Internet'];
  const ICON = { CCU3: '🏠', WD: '💾', Sicherungen: '🗄', 'Dienste & Integrationen': '🔌', Geräte: '💡', Internet: '🌐' };
  const uhr = t => t ? new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr' : '–';
  const schlimmste = list => list.reduce((a, p) => RANG[p.stufe] < RANG[a] ? p.stufe : a, 'ok');
  const zeile = p => h('li', { class: 'sz-zeile sz-' + p.stufe }, h('span', { class: 'sz-licht', 'aria-hidden': 'true', text: LICHT[p.stufe] }),
    h('span', { text: p.text }), h('span', { class: 'sz-sr', text: ' (' + ({ ok: 'gut', hinweis: 'nicht so gut', warnung: 'schlecht', fehler: 'schlecht' })[p.stufe] + ')' }));

  // Gemeinsame Darstellung für PC und Handy
  function render(box, d, { kompakt, knopf } = {}) {
    const [licht, titel, text] = GESAMT[d.ampel] || GESAMT.gelb, z = d.zaehler || {};
    const offen = d.punkte.filter(p => p.stufe !== 'ok').sort((a, b) => RANG[a.stufe] - RANG[b.stufe]);
    const kopf = h('div', { class: 'sz-kopf sz-' + d.ampel },
      h('div', { class: 'sz-gross', 'aria-hidden': 'true', text: licht }),
      h('div', {}, h('h2', { text: titel }), h('p', { text: text }),
        h('p', { class: 'sz-zahlen' }, h('span', { text: '🟢 ' + (z.ok || 0) + ' gut' }), h('span', { text: '🟡 ' + (z.hinweis || 0) + ' beobachten' }), h('span', { text: '🔴 ' + ((z.warnung || 0) + (z.fehler || 0)) + ' Problem' })),
        h('p', { class: 'muted', text: 'Letzte Prüfung ' + uhr(d.erstellt) + (d.naechste ? ' · nächste automatisch ' + uhr(d.naechste) : '') }),
        knopf ? h('div', { class: 'actions sz-knopf' }, ...knopf) : null));
    const teile = [kopf];
    if (offen.length) teile.push(h('section', { class: 'sz-offen' }, h('h3', { text: 'Bitte ansehen' }), h('ul', { class: 'sz-liste' }, offen.map(zeile))));
    const gruppen = h('div', { class: kompakt ? 'sz-gruppen kompakt' : 'sz-gruppen' });
    for (const b of BEREICHE) {
      const list = d.punkte.filter(p => p.bereich === b).sort((x, y) => RANG[x.stufe] - RANG[y.stufe]);
      if (!list.length) continue;
      const s = schlimmste(list), gut = list.filter(p => p.stufe === 'ok').length;
      gruppen.append(h('details', { class: 'sz-gruppe sz-' + s, open: !kompakt && s !== 'ok' },
        h('summary', {}, h('span', { class: 'sz-licht', 'aria-hidden': 'true', text: LICHT[s] }), h('b', { text: (ICON[b] || '') + ' ' + b }),
          h('small', { text: gut === list.length ? 'alles gut (' + gut + ')' : gut + ' von ' + list.length + ' gut' })),
        h('ul', { class: 'sz-liste' }, list.map(zeile))));
    }
    teile.push(gruppen);
    // Festplatten-Scan der WD (Wunsch Thomas): letzter Scan, Ergebnis, nächster – und selbst auslösen
    const l = d.langtest;
    if (l) {
      const out = h('p', { class: 'msg', role: 'status' }), btn = h('button', { class: 'btn small', type: 'button', text: '🔍 Festplatte jetzt prüfen', disabled: l.laeuftProzent !== null });
      btn.addEventListener('click', async () => {
        if (!await NEU.confirmDialog({ title: 'Festplatte jetzt prüfen?', text: 'Die WD-Festplatte prüft sich selbst Stück für Stück (nur lesen, etwa 4,5 Stunden). Webseite und Sicherungen laufen dabei normal weiter, nur etwas langsamer.', confirm: 'Scan starten' })) return;
        btn.disabled = true; msg(out, 'Auftrag wird gestellt …', 'busy');
        try { const r = await api('festplattenScanStarten', {}); msg(out, r.message, 'ok'); } catch (e) { msg(out, e.message, 'bad'); btn.disabled = false; }
      });
      const rows = [
        ['Letzter Scan', l.laeuftProzent !== null ? 'läuft gerade – noch ' + l.laeuftProzent + ' %' : (l.letzterAbschluss ? l.letzterAbschluss + ' Uhr' : 'noch keiner')],
        ['Ergebnis', l.laeuftProzent !== null ? 'kommt nach dem Scan' : l.ergebnis === 'Completed without error' ? 'ohne Fehler ✓' : (l.ergebnis || '–')],
        ['Zuletzt gestartet', l.letzterStart ? l.letzterStart + ' Uhr' : ''], ['Nächster Scan', l.laeuftProzent !== null ? '' : l.naechster], ['Rhythmus', l.rhythmus],
        ['Knopf zuletzt', l.auftrag]
      ].filter(([, v]) => v);
      teile.push(h('section', { class: 'sz-scan sz-' + (l.laeuftProzent !== null ? 'ok' : l.stufe) },
        h('h3', {}, h('span', { 'aria-hidden': 'true', text: (l.laeuftProzent !== null ? '⏳' : LICHT[l.stufe] || '🟡') + ' ' }), 'Festplatten-Scan (WD)'),
        l.text ? h('p', { text: l.text }) : null,
        h('dl', { class: 'ov-rows' }, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
        h('div', { class: 'actions' }, btn), out));
    }
    const info = [d.aufraeumen ? 'Letztes Aufräumen CCU3: ' + d.aufraeumen : '', d.wdWartung ? 'Letztes Aufräumen WD: ' + d.wdWartung : ''].filter(Boolean);
    if (info.length && !kompakt) teile.push(h('p', { class: 'muted sz-info' }, ...info.flatMap((t, i) => i ? [h('br'), t] : [t])));
    box.replaceChildren(...teile);
  }

  function anzeige(box, out, opts) {
    let timer = null, laedt = false;
    const laden = async () => {
      if (laedt) return; laedt = true;
      try { render(box, await api('getSystemzustand'), opts); msg(out, ''); }
      catch (e) { msg(out, 'Zustand nicht abrufbar: ' + e.message, 'bad'); }
      finally { laedt = false; }
    };
    const pruefen = async btn => {
      btn.disabled = true; msg(out, 'Wird geprüft … (dauert etwa 10 Sekunden)', 'busy');
      try { render(box, await api('systemzustandPruefen', {}), opts); msg(out, 'Neu geprüft.', 'ok'); }
      catch (e) { msg(out, e.message, 'bad'); } finally { btn.disabled = false; }
    };
    const start = () => { laden(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) laden(); }, 60000); };
    return { laden, pruefen, start, stop: () => clearInterval(timer) };
  }

  // ---- Handy (mobil.html): Reiter füllt den Körper erst beim Öffnen ----
  window.mhZustandShow = body => {
    if (!body.dataset.sz) {
      body.dataset.sz = '1';
      const box = h('div', { class: 'sz' }), out = h('p', { class: 'msg', role: 'status' });
      const btn = h('button', { class: 'btn small', type: 'button', text: '↻ Jetzt prüfen' });
      const a = anzeige(box, out, { kompakt: true, knopf: [btn, out] }); btn.addEventListener('click', () => a.pruefen(btn));
      body.replaceChildren(box, out); body._sz = a;
    }
    body._sz.start();
  };

  // Schmaler Handy-Reiter zeigt die aktuelle Ampelfarbe (alle 5 Minuten aktualisiert)
  window.mhZustandAmpel = btn => {
    const set = async force => { if (document.hidden && !force) return; try { const d = await api('getSystemzustand'); const g = GESAMT[d.ampel] || GESAMT.gelb; btn.textContent = g[0]; btn.setAttribute('aria-label', 'Systemzustand: ' + g[1]); btn.title = 'Systemzustand: ' + g[1]; } catch { btn.textContent = '🚦'; } };
    set(true); setInterval(() => set(), 300000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) set(); });
  };

  // Ampelzeile auf der Übersicht (index.html): ersetzt die früheren Zustandskacheln, Link auf die Ampelseite
  window.mhZustandKachel = slot => {
    const KL = { gruen: 'notice', gelb: 'notice warn', rot: 'notice bad' };
    const set = async force => {
      if (document.hidden && !force) return;
      try {
        const d = await api('getSystemzustand'), g = GESAMT[d.ampel] || GESAMT.gelb, z = d.zaehler || {};
        const offen = d.punkte.filter(p => p.stufe !== 'ok').sort((a, b) => RANG[a.stufe] - RANG[b.stufe]);
        slot.replaceChildren(h('a', { class: KL[d.ampel] || 'notice warn', href: '/systemzustand.html', style: 'display:flex;gap:12px;align-items:center;text-decoration:none;color:inherit' },
          h('span', { 'aria-hidden': 'true', style: 'font-size:34px;line-height:1', text: g[0] }),
          h('span', {}, h('b', { text: 'Systemzustand: ' + g[1] }), h('br'),
            h('span', { text: offen.length ? offen.slice(0, 2).map(p => LICHT[p.stufe] + ' ' + p.text).join(' · ') + (offen.length > 2 ? ' · und ' + (offen.length - 2) + ' weitere' : '')
              : '🟢 ' + (z.ok || 0) + ' Prüfpunkte gut – CCU3, WD, Sicherungen, Dienste und Geräte' }),
            h('br'), h('small', { class: 'muted', text: 'Letzte Prüfung ' + uhr(d.erstellt) + ' · Details ansehen →' }))));
      } catch (e) { slot.replaceChildren(h('a', { class: 'notice warn', href: '/systemzustand.html', text: '🚦 Systemzustand nicht abrufbar (' + e.message + ') – Seite öffnen' })); }
    };
    set(true); setInterval(() => set(), 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) set(); });
  };

  // ---- WD im Detail (von der Sicherungsseite hierher verschoben, 13.10.2026; Wunsch Thomas 12.10.: „Übersicht für die WD mit
  // Speicher, Temperatur und sonst Wichtigem“). Daten: getSicherungsUeberblick → wd.system (nur Administrator). ----
  const KARTE = { gruen: ['ok', '🟢'], gelb: ['warn', '🟡'], rot: ['bad', '🔴'], grau: ['', '⚪'] };
  const STUFE_AMPEL = { ok: 'gruen', hinweis: 'gelb', warnung: 'gelb', fehler: 'rot' };
  const zahl = (v, e, n = 1) => v === null || v === undefined ? null : Number(v).toLocaleString('de-DE', { maximumFractionDigits: n }) + (e ? ' ' + e : '');
  const karte = (ampel, titel, rows) => { const [cls, dot] = KARTE[ampel] || KARTE.grau;
    return h('div', { class: 'card ov-card' }, h('div', { class: 'ov-head' }, h('b', { text: dot + ' ' + titel }), h('span', { class: 'tag ' + cls, text: ampel === 'gruen' ? 'alles gut' : ampel === 'gelb' ? 'bitte ansehen' : ampel === 'rot' ? 'Handlungsbedarf' : 'unbekannt' })),
      h('dl', { class: 'ov-rows' }, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== '').flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))); };
  function wdDetail(box, stand) {
    const laden = async () => {
      let w; try { w = (await api('getSicherungsUeberblick')).wd; } catch (e) { box.replaceChildren(h('p', { class: 'muted', text: e.status === 403 ? 'Nach Anmeldung als CCU-Administrator sichtbar.' : 'WD-Bericht nicht lesbar: ' + e.message })); stand.textContent = ''; return; }
      const s = w.system;
      if (!w.eingerichtet) { box.replaceChildren(karte('gelb', 'WD', [['Zustand', 'nicht verbunden']])); stand.textContent = ''; return; }
      if (!s || w.systemAlt) { box.replaceChildren(karte('rot', 'WD', [['Zustand', 'WD meldet sich nicht' + (s?.erstelltText ? ' (letzte Meldung ' + s.erstelltText + ')' : '')]])); stand.textContent = ''; return; }
      const c = [karte(STUFE_AMPEL[s.zustandWd] || 'grau', 'WD gesamt' + (s.modell ? ' – ' + s.modell : ''), [['Zustand', { ok: 'alles in Ordnung', hinweis: 'Hinweis', warnung: 'Warnung', fehler: 'Fehler' }[s.zustandWd] || 'unbekannt'], ['Hinweise', s.hinweise.length ? s.hinweise.join(' · ') : null], ['Adresse', s.netz?.ip], ['Fernzugang (Tailscale)', s.netz ? (s.netz.tailscale ? 'verbunden' : 'nicht verbunden') : null]])];
      for (const p of s.platten) c.push(karte(p.smart === 'fehler' ? 'rot' : p.smart === 'warnung' || (p.belegtProzent ?? 0) >= 90 || (p.defekteSektoren ?? 0) > 0 ? 'gelb' : p.smart === 'ok' ? 'gruen' : 'grau', 'Festplatte' + (p.name ? ' ' + p.name : ''),
        [['Speicher', p.gesamtGB !== null ? zahl(p.freiGB, 'GB') + ' frei von ' + zahl(p.gesamtGB, 'GB') + (p.belegtProzent !== null ? ' (' + zahl(p.belegtProzent, '%', 0) + ' belegt)' : '') : null], ['Gesundheit (SMART)', { ok: 'in Ordnung', warnung: 'Warnung', fehler: 'FEHLER', unbekannt: 'unbekannt' }[p.smart] || null], ['Defekte Sektoren', p.defekteSektoren !== null ? String(p.defekteSektoren) : null], ['Temperatur', zahl(p.temperaturC, '°C', 0)], ['Betriebsstunden', zahl(p.betriebsstunden, 'h', 0)]]));
      if (s.stick) c.push(karte(s.stick.erreichbar === false ? 'rot' : s.stick.erreichbar ? 'gruen' : 'grau', 'USB-Stick (Sicherungen)', [['Zustand', s.stick.erreichbar === false ? 'NICHT erreichbar' : s.stick.erreichbar ? 'erreichbar' : 'unbekannt'], ['Speicher', s.stick.gesamtGB !== null ? zahl(s.stick.freiGB, 'GB') + ' frei von ' + zahl(s.stick.gesamtGB, 'GB') : null]]));
      c.push(karte((s.systemTemperaturC ?? 0) >= 88 ? 'rot' : 'gruen', 'System', [['Prozessor-Temperatur', s.systemTemperaturC !== null ? zahl(s.systemTemperaturC, '°C', 0) + ' (normal bis etwa 80 °C, Warnung ab 88 °C)' : null], ['Auslastung', zahl(s.cpuLast1, '', 2)], ['Freier Arbeitsspeicher', zahl(s.ramFreiMB, 'MB', 0)], ['Läuft seit', s.laufzeitTage !== null ? zahl(s.laufzeitTage, 'Tagen', 1) : null], ['Letzter Neustart', s.letzterNeustartText], ['Firmware', s.firmware ? s.firmware + (s.updateVerfuegbar === null ? ' (Updates nur über die WD-Oberfläche)' : s.updateVerfuegbar ? ' – Update verfügbar' : ' – aktuell') : null]]));
      if (s.dienste.length) c.push(karte(s.dienste.some(d => d.laeuft === false) ? 'rot' : 'gruen', 'Dienste', s.dienste.map(d => [d.name, d.laeuft === true ? '✔ läuft' : d.laeuft === false ? '✖ läuft NICHT' : 'unbekannt'])));
      const bericht = s.punkte.length ? h('details', { class: 'more' }, h('summary', { text: 'Kompletter Zustandsbericht der WD (' + s.punkte.length + ' Punkte' + (s.punkte.some(p => p.stufe !== 'ok') ? ', ' + s.punkte.filter(p => p.stufe !== 'ok').length + ' mit Hinweis' : '') + ')' }),
        NEU.table(['', 'Bereich', 'Punkt', 'Ergebnis'], s.punkte.map(p => h('tr', {}, h('td', { text: LICHT[p.stufe] || '⚪' }), h('td', { text: p.bereich || '' }), h('td', { text: p.name || '' }), h('td', { text: p.text || '' }))))) : null;
      box.replaceChildren(h('div', { class: 'cards' }, ...c), bericht || '');
      stand.textContent = 'WD-Meldung von ' + (s.erstelltText || '–') + ' · aktualisiert sich jede Minute';
    };
    laden(); setInterval(() => { if (!document.hidden) laden(); }, 60000);
  }

  // ---- PC-Seite ----
  if (location.pathname !== '/systemzustand.html') return;
  const main = NEU.shell({ title: 'Systemzustand', eyebrow: 'System', crumb: 'System', lead: 'Ampel für CCU3, WD, Sicherungen, Dienste und Geräte – auf einen Blick. 🟢 gut · 🟡 beobachten · 🔴 Problem (dafür kommt auch eine WhatsApp).' });
  const box = h('div', { class: 'sz' }), out = h('p', { class: 'msg', role: 'status' });
  const btn = h('button', { class: 'btn', type: 'button', text: '↻ Jetzt prüfen' });
  const a = anzeige(box, out, { knopf: [btn, out] }); btn.addEventListener('click', () => a.pruefen(btn));
  main.append(NEU.panel('Zustand', 'Wird alle 15 Minuten automatisch geprüft; diese Seite aktualisiert sich jede Minute.', box, h('div', {}, out)));
  const wdBox = h('div', {}, h('p', { class: 'muted', text: 'Wird geladen …' })), wdStand = h('p', { class: 'muted' });
  main.append(NEU.panel('💾 WD im Detail', 'Speicher, Temperatur, Firmware, Dienste und der komplette Zustandsbericht, den die WD alle 5 Minuten meldet.', wdBox, wdStand));
  a.start(); wdDetail(wdBox, wdStand);
})();
