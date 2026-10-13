'use strict';
// Seite „Verknüpfungen“: direkte Geräteverknüpfungen im Klartext (im Gerät gespeichert, z. B. Wandschalter → Licht).
// Gruppiert nach Raum, mit Suche und Hinweis, was ohne CCU weiter funktioniert. Administratoren können Verknüpfungen
// anlegen (nur passende Kanäle wählbar) und löschen (Schieberegler-Rückfrage, Sicherung auf der CCU).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg, task, confirmDialog } = NEU;
  const main = shell({ title: 'Verknüpfungen', eyebrow: 'Zuhause', lead: 'Direkte Verknüpfungen zwischen Geräten, z. B. „Wandschalter schaltet Licht“. Sie sind im Gerät selbst gespeichert und funktionieren auch, wenn CCU, Bridge oder WLAN ausfallen.' });
  const search = h('input', { type: 'search', placeholder: 'Suchen (Gerät, Raum …)', 'aria-label': 'Verknüpfungen durchsuchen' });
  const reload = h('button', { class: 'btn', type: 'button', text: 'Neu einlesen' });
  const out = h('p', { class: 'msg', role: 'status' }), list = h('div'), stats = h('div', { class: 'stats' });
  main.append(stats, panel('Alle Verknüpfungen', 'Gelesen direkt aus den Funkschnittstellen der CCU.',
    h('div', { class: 'row' }, search, reload), out, list));
  let data = null, admin = false;
  // Neue Verknüpfung als Assistent in 3 Schritten (Wunsch Thomas 13.10.2026: leicht und verständlich).
  // 1. Womit schalten? – Taste am Gerät drücken (wird erkannt) oder aus der Liste wählen
  // 2. Was schalten? – nur passende Geräte, nach Raum, Art in Worten; die mehrfachen internen Kanäle eines Aktors sind gebündelt
  // 3. Passt das? – ein Satz, Name, Anlegen. Nur Administratoren (der Server prüft das ebenfalls).
  const newBox = h('div');
  const SENDER_ART = { KEY_TRANSCEIVER: 'Taste', KEY: 'Taste', MULTI_MODE_INPUT_TRANSMITTER: 'Wandschalter-Eingang', REMOTE_CONTROL: 'Fernbedienung', MOTIONDETECTOR_TRANSCEIVER: 'Bewegungsmelder', MOTION_DETECTOR: 'Bewegungsmelder', PRESENCEDETECTOR_TRANSCEIVER: 'Präsenzmelder', SHUTTER_CONTACT: 'Fensterkontakt', SHUTTER_CONTACT_TRANSCEIVER: 'Fensterkontakt', ROTARY_HANDLE_SENSOR: 'Fenstergriff', ROTARY_HANDLE_TRANSCEIVER: 'Fenstergriff', SMOKE_DETECTOR: 'Rauchmelder', WATER_DETECTION_TRANSMITTER: 'Wassermelder', SWITCH_TRANSMITTER: 'Schaltzustand', CLIMATECONTROL_FLOOR_TRANSCEIVER: 'Heizung', HEATING_CLIMATECONTROL_TRANSCEIVER: 'Heizung (Wandthermostat)' };
  const EMPF_ART = { SWITCH_VIRTUAL_RECEIVER: 'Licht / Schalter', SWITCH: 'Licht / Schalter', DIMMER_VIRTUAL_RECEIVER: 'Dimmer', DIMMER: 'Dimmer', BLIND_VIRTUAL_RECEIVER: 'Rollladen / Jalousie', SHUTTER_VIRTUAL_RECEIVER: 'Rollladen', BLIND: 'Rollladen', HEATING_CLIMATECONTROL_RECEIVER: 'Heizung', CLIMATECONTROL_RT_TRANSCEIVER: 'Heizkörper', ACOUSTIC_SIGNAL_VIRTUAL_RECEIVER: 'Signalgeber', ALARM_SWITCH_VIRTUAL_RECEIVER: 'Alarm', DOOR_LOCK_RECEIVER: 'Türschloss' };
  const art = (c, map) => map[c.channelType] || (c.channelType ? c.channelType.replace(/_/g, ' ').toLowerCase() : 'Kanal');
  const nr = c => Number(String(c.address).split(':')[1]), geraet = c => String(c.address).split(':')[0];
  const VIRTUELL = /^(BidCoS-RF|HmIP-RCV-1|[A-Z0-9]*VIR)/i;
  // Aufeinanderfolgende gleichartige Empfangskanäle eines Geräts (z. B. Aktor 4/5/6) sind ein Ausgang → nur den ersten zeigen
  const buendeln = list => list.filter(c => !list.some(o => geraet(o) === geraet(c) && o.channelType === c.channelType && nr(o) === nr(c) - 1));
  async function buildNew() {
    let cand; try { cand = (await api('getLinkCandidates')).channels; admin = true; } catch { admin = false; return; }
    const senders = cand.filter(c => c.source.length && !VIRTUELL.test(c.address));
    const st = { sender: null, receiver: null, alle: false }, out2 = h('p', { class: 'msg', role: 'status' }), body = h('div', { class: 'vk-assist' });
    let lauscht = null;
    const stop = () => { clearInterval(lauscht); lauscht = null; };
    const karte = (c, map, onPick, aktiv) => { const b = h('button', { class: 'vk-karte' + (aktiv ? ' an' : ''), type: 'button' }, h('b', { text: c.name }), h('span', { class: 'muted', text: art(c, map) + (c.room ? ' · ' + c.room : '') })); b.addEventListener('click', () => onPick(c)); return b; };
    const nachRaum = (list, map, onPick, aktivAddr) => { const g = new Map(); for (const c of list) { const r = c.room || 'Ohne Raum'; if (!g.has(r)) g.set(r, []); g.get(r).push(c); }
      return [...g].sort((x, y) => x[0].localeCompare(y[0], 'de')).map(([r, cs]) => h('div', { class: 'vk-raum' }, h('h4', { text: r }), h('div', { class: 'vk-karten' }, ...cs.map(c => karte(c, map, onPick, c.address === aktivAddr))))); };
    const kopf = (n, text) => h('div', { class: 'vk-schritt' }, h('span', { class: 'vk-nr', text: String(n) }), h('b', { text }));
    function zeigen() {
      const teile = [];
      // Schritt 1
      teile.push(kopf(1, 'Womit willst du schalten?'));
      if (st.sender) {
        const zur = h('button', { class: 'btn small', type: 'button', text: 'ändern' }); zur.addEventListener('click', () => { st.sender = st.receiver = null; zeigen(); });
        teile.push(h('p', { class: 'vk-gewaehlt' }, h('span', { text: '✓ ' + st.sender.name + ' – ' + art(st.sender, SENDER_ART) + (st.sender.room ? ' · ' + st.sender.room : '') + ' ' }), zur));
      } else {
        const druck = h('button', { class: 'btn primary', type: 'button', text: lauscht ? '… warte auf Tastendruck (30 s)' : '👆 Taste am Gerät drücken' }), hinweis = h('p', { class: 'muted', text: 'Am einfachsten: Knopf drücken, dann kurz die gewünschte Taste am Schalter oder an der Fernbedienung drücken – die Seite erkennt sie.' });
        druck.addEventListener('click', () => {
          if (lauscht) return; const seit = Date.now(); let n = 0; msg(out2, 'Jetzt die Taste am Gerät drücken …', 'busy'); druck.textContent = '… warte auf Tastendruck (30 s)';
          lauscht = setInterval(async () => {
            if (++n > 15) { stop(); msg(out2, 'Kein Tastendruck erkannt. Bitte noch einmal oder aus der Liste wählen.', 'warn'); zeigen(); return; }
            try { const r = await api('getGeraeteAktivitaet'), off = Date.now() - Date.parse(r.now);
              const treffer = Object.entries(r.pressed || {}).filter(([, at]) => Date.parse(at) + off >= seit).sort((x, y) => y[1].localeCompare(x[1]));
              const c = treffer.map(([addr]) => senders.find(s => s.address === addr)).find(Boolean);
              if (c) { stop(); st.sender = c; msg(out2, 'Erkannt: ' + c.name + ' (' + art(c, SENDER_ART) + ').', 'ok'); zeigen(); }
            } catch {}
          }, 2000);
        });
        teile.push(h('div', { class: 'row' }, druck), hinweis, h('details', { class: 'vk-liste' }, h('summary', { text: 'Oder aus der Liste wählen (' + senders.length + ')' }), ...nachRaum(senders, SENDER_ART, c => { stop(); st.sender = c; zeigen(); })));
      }
      // Schritt 2
      if (st.sender) {
        const s = st.sender, alle = cand.filter(c => c.interface === s.interface && c.address !== s.address && c.target.some(x => s.source.includes(x)) && !VIRTUELL.test(c.address));
        const passend = st.alle ? alle : buendeln(alle);
        teile.push(kopf(2, 'Was soll „' + s.name + '“ schalten?'));
        if (st.receiver) {
          const zur = h('button', { class: 'btn small', type: 'button', text: 'ändern' }); zur.addEventListener('click', () => { st.receiver = null; zeigen(); });
          teile.push(h('p', { class: 'vk-gewaehlt' }, h('span', { text: '✓ ' + st.receiver.name + ' – ' + art(st.receiver, EMPF_ART) + (st.receiver.room ? ' · ' + st.receiver.room : '') + ' ' }), zur));
        } else if (!passend.length) teile.push(h('p', { class: 'muted', text: 'Zu diesem Gerät passt kein Empfänger. (Direkt verknüpfen lassen sich nur Geräte derselben Funkart – Homematic IP mit Homematic IP.)' }));
        else {
          const mehr = h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: st.alle }), h('span', { class: 'muted', text: 'Alle Kanäle zeigen (für Fachleute)' }));
          mehr.querySelector('input').addEventListener('change', e => { st.alle = e.target.checked; zeigen(); });
          teile.push(...nachRaum(passend, EMPF_ART, c => { st.receiver = c; zeigen(); }), mehr);
        }
      }
      // Schritt 3
      if (st.sender && st.receiver) {
        const nm = h('input', { type: 'text', maxlength: 60, value: (st.sender.name + ' → ' + st.receiver.name).slice(0, 60), 'aria-label': 'Name der Verknüpfung' });
        const add = h('button', { class: 'btn primary', type: 'button', text: 'Verknüpfung anlegen' });
        add.addEventListener('click', () => task(add, out2, async () => {
          const s = st.sender, r = st.receiver;
          data = await api('addDirectLink', { interface: s.interface, sender: s.address, receiver: r.address, name: nm.value.trim() }); showStats(); render();
          st.sender = st.receiver = null; zeigen(); return 'Angelegt: „' + s.name + '“ schaltet jetzt „' + r.name + '“ – direkt per Funk, auch ohne CCU. Batteriegeräte übernehmen es beim nächsten Tastendruck.';
        }, 'Wird in die Geräte übertragen …'));
        teile.push(kopf(3, 'Passt das so?'), h('div', { class: 'vk-satz' }, h('b', { text: '„' + st.sender.name + '“' }), h('span', { text: ' schaltet ' }), h('b', { text: '„' + st.receiver.name + '“' })),
          h('p', { class: 'muted', text: 'Die Verknüpfung wird in beiden Geräten gespeichert und funktioniert danach auch ohne CCU, Bridge oder WLAN. Ein kurzer Druck schaltet um, langer Druck dimmt bzw. fährt (je nach Gerät).' }),
          NEU.field('Name (freiwillig)', nm), h('div', { class: 'actions' }, add));
      }
      body.replaceChildren(...teile);
    }
    zeigen();
    newBox.replaceChildren(kiBox(cand, senders), panel('Neue Verknüpfung', 'In drei Schritten: womit, was, fertig.', body, out2));
  }
  // KI-Assistent (Wunsch Thomas 13.10.2026): Taste drücken und/oder einen Satz schreiben – die KI füllt alles aus, du bestätigst nur.
  // Die KI macht nur Verknüpfungsvorschläge (geprüft auf der CCU); angelegt wird erst mit „Bestätigen“.
  function kiBox(cand, senders) {
    const text = h('textarea', { rows: 2, maxlength: 500, style: 'width:100%', placeholder: 'z. B. „soll das Ganglicht schalten“ oder „Taste oben am Wandtaster Bad schaltet das Badlicht“', 'aria-label': 'Was soll die Taste schalten?' });
    const druck = h('button', { class: 'btn', type: 'button', text: '👆 Taste drücken' }), go = h('button', { class: 'btn primary', type: 'button', text: '✨ KI ausfüllen lassen' });
    const o = h('p', { class: 'msg', role: 'status' }), gewaehlt = h('p', { class: 'vk-gewaehlt', hidden: true }), result = h('div'), hint = h('p', { class: 'muted' });
    let sender = null, timer = null;
    const zeigeSender = () => { gewaehlt.hidden = !sender; if (sender) { const weg = h('button', { class: 'btn small', type: 'button', text: 'entfernen' }); weg.addEventListener('click', () => { sender = null; zeigeSender(); }); gewaehlt.replaceChildren(h('span', { text: '✓ Taste: ' + sender.name + (sender.room ? ' · ' + sender.room : '') + ' ' }), weg); } };
    druck.addEventListener('click', () => {
      if (timer) return; const seit = Date.now(); let n = 0; druck.textContent = '… warte auf Tastendruck (30 s)'; msg(o, 'Jetzt die Taste am Gerät drücken …', 'busy');
      timer = setInterval(async () => {
        const ende = t => { clearInterval(timer); timer = null; druck.textContent = '👆 Taste drücken'; if (t) msg(o, t[0], t[1]); };
        if (++n > 15) return ende(['Kein Tastendruck erkannt. Bitte noch einmal – oder die Taste im Satz beschreiben.', 'warn']);
        try { const r = await api('getGeraeteAktivitaet'), off = Date.now() - Date.parse(r.now);
          const c = Object.entries(r.pressed || {}).filter(([, at]) => Date.parse(at) + off >= seit).sort((x, y) => y[1].localeCompare(x[1])).map(([a]) => senders.find(s => s.address === a)).find(Boolean);
          if (c) { sender = c; zeigeSender(); ende(['Erkannt: ' + c.name + '. Jetzt schreiben, was sie schalten soll.', 'ok']); text.focus(); }
        } catch {}
      }, 2000);
    });
    go.addEventListener('click', () => task(go, o, async () => {
      result.replaceChildren();
      const r = await api('askVerknuepfung', { text: text.value, ...(sender ? { sender: sender.address } : {}) });
      if (!r.receivers) { result.replaceChildren(h('div', { class: 'notice warn', text: 'Rückfrage der KI: ' + r.question + ' – bitte genauer beschreiben.' })); return 'Die KI braucht mehr Angaben.'; }
      const nm = h('input', { type: 'text', maxlength: 60, value: r.name || '', 'aria-label': 'Name der Verknüpfung' });
      const ok = h('button', { class: 'btn primary', type: 'button', text: '✓ Bestätigen' }), nein = h('button', { class: 'btn', type: 'button', text: 'Verwerfen' }), ro = h('p', { class: 'msg', role: 'status' });
      nein.addEventListener('click', () => { result.replaceChildren(); msg(o, 'Verworfen – nichts angelegt.', 'ok'); });
      ok.addEventListener('click', () => task(ok, ro, async () => {
        for (const rc of r.receivers) data = await api('addDirectLink', { interface: r.interface, sender: r.sender.address, receiver: rc.address, name: nm.value.trim() });
        showStats(); render(); result.replaceChildren(); text.value = ''; sender = null; zeigeSender();
        msg(o, 'Angelegt: „' + r.sender.name + '“ schaltet jetzt ' + r.receivers.map(x => '„' + x.name + '“').join(' und ') + ' – direkt per Funk, auch ohne CCU. Batteriegeräte übernehmen es beim nächsten Tastendruck.', 'ok'); return '';
      }, 'Wird in die Geräte übertragen …'));
      result.replaceChildren(h('div', { class: 'card' },
        h('div', { class: 'vk-satz' }, h('b', { text: '„' + r.sender.name + '“' }), h('span', { text: ' schaltet ' }), ...r.receivers.flatMap((x, i) => [i ? h('span', { text: ' und ' }) : null, h('b', { text: '„' + x.name + '“' + (x.room ? ' (' + x.room + ')' : '') })])),
        r.question ? h('p', { class: 'muted', text: 'Hinweis der KI: ' + r.question }) : null, NEU.field('Name', nm), h('div', { class: 'actions' }, ok, nein), ro));
      return 'Vorschlag fertig – bitte bestätigen. Noch ist nichts angelegt.';
    }, 'KI denkt nach …'));
    api('getAssistent').then(x => { const k = x.ki; go.disabled = !(k.enabled && k.hasKey); hint.replaceChildren(...(go.disabled ? ['Die KI ist noch nicht eingerichtet: ', h('a', { href: '/automationen.html#ki', text: 'Automationen → Assistent → KI einrichten' }), ' (kostenloser Google-Schlüssel). Der Drei-Schritte-Assistent unten geht auch ohne KI.'] : ['Die KI sieht nur Namen, Räume und Kanalarten (keine Adressen), schlägt nur Verknüpfungen vor und legt nichts selbst an. Höchstens 20 Anfragen je Stunde.'])); }).catch(() => {});
    return panel('✨ Mit KI verknüpfen', 'Taste drücken (oder im Satz beschreiben), schreiben was sie schalten soll – die KI füllt alles aus, du bestätigst nur.', h('div', { class: 'row' }, druck), gewaehlt, NEU.field('Was soll passieren?', text), h('div', { class: 'actions' }, go), o, result, hint);
  }
  stats.after(newBox); // Assistent oben, direkt unter den Zahlen (leicht zu finden)
  function delButton(l) {
    const b = h('button', { class: 'btn small danger', type: 'button', text: 'Verknüpfung löschen' }), o = h('span', { class: 'msg', role: 'status' });
    b.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Verknüpfung löschen?', danger: true, slider: true, confirm: 'Löschen', text: sentence(l) + ' – wird aus den Geräten entfernt. Die Einstellungen werden vorher auf der CCU gesichert (verknuepfungen-sicherung.json).' })) return;
      task(b, o, async () => { data = await api('removeDirectLink', { interface: l.interface, sender: l.sender, receiver: l.receiver }); showStats(); render(); return 'Gelöscht.'; }, 'Wird gelöscht …');
    });
    return h('div', { class: 'row' }, b, o);
  }
  function kind(l) {
    if (l.virtual) return ['tag warn', 'virtuelle CCU-Taste', 'Wird von der CCU ausgelöst (z. B. Programm oder alte Oberfläche) – braucht die CCU.'];
    if (l.internal) return ['tag ok', 'im Gerät', 'Eingang und Schaltkanal im selben Gerät (Wandschalter am Aktor) – funktioniert immer, auch ohne CCU.'];
    return ['tag ok', 'Gerät → Gerät', 'Sender und Empfänger sprechen direkt per Funk – funktioniert ohne CCU.'];
  }
  function sentence(l) {
    const s = l.internal ? 'Eingang/Taster von „' + l.senderName + '“' : '„' + l.senderName + '“';
    return s + ' schaltet „' + l.receiverName + '“' + (l.receiverRoom ? ' (' + l.receiverRoom + ')' : '');
  }
  function render() {
    if (!data) return;
    const q = search.value.trim().toLowerCase();
    const items = data.links.filter(l => !q || [l.senderName, l.receiverName, l.senderRoom, l.receiverRoom, l.sender, l.receiver, l.name, l.description].join(' ').toLowerCase().includes(q));
    const groups = new Map();
    for (const l of items) { const g = l.receiverRoom || 'Ohne Raum'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(l); }
    list.replaceChildren(...(items.length ? [...groups].map(([room, ls]) => h('div', { style: 'margin-bottom:16px' }, h('h3', { text: room + ' (' + ls.length + ')' }), h('div', { class: 'auto-list' }, ls.map(l => {
      const [cls, tag, hint] = kind(l), unknown = l.unknown === true;
      return h('details', { class: 'auto-item' },
        h('summary', {}, h('b', { text: sentence(l) }), l.name ? h('span', { class: 'ef-note', text: ' – ' + l.name }) : null, ' ', h('span', { class: cls, text: tag }), unknown ? h('span', { class: 'tag bad', text: '⚠ Gerät unbekannt' }) : null),
        h('div', { class: 'auto-body' },
          h('p', { class: 'muted', text: hint }),
          l.description ? h('p', { text: 'Beschreibung: ' + l.description }) : null,
          h('p', { class: 'muted mono', text: 'Sender ' + l.sender + (l.senderRoom ? ' · ' + l.senderRoom : '') + ' → Empfänger ' + l.receiver + ' · ' + l.interface }),
          unknown ? h('p', { style: 'color:var(--bad)', text: 'Eines der beiden Geräte ist der CCU nicht (mehr) bekannt. Die Verknüpfung ist vermutlich ein Überbleibsel und kann gelöscht werden.' }) : null,
          admin ? delButton(l) : null));
    })))) : [h('div', { class: 'empty', text: data.links.length ? 'Keine passenden Verknüpfungen.' : 'Keine direkten Verknüpfungen vorhanden.' })]));
  }
  function showStats() {
    const ls = data.links, inDev = ls.filter(l => l.internal).length, virt = ls.filter(l => l.virtual).length;
    stats.replaceChildren(NEU.stat('Verknüpfungen', String(ls.length), 'insgesamt'), NEU.stat('Ohne CCU funktionsfähig', String(ls.length - virt), inDev + ' im Gerät, ' + (ls.length - virt - inDev) + ' Gerät → Gerät', 'ok'),
      NEU.stat('Brauchen die CCU', String(virt), virt ? 'virtuelle CCU-Tasten' : 'keine', virt ? 'warn' : 'ok'));
  }
  async function load() {
    list.replaceChildren(h('div', { class: 'empty', text: 'Verknüpfungen werden gelesen …' }));
    try { data = await api('getDirectLinks'); showStats(); render(); msg(out, data.errors?.length ? 'Nicht alles lesbar: ' + data.errors.join('; ') : 'Stand: ' + new Date(data.readAt).toLocaleTimeString('de-DE'), data.errors?.length ? 'warn' : 'ok'); }
    catch (e) { list.replaceChildren(h('div', { class: 'notice bad', text: 'Verknüpfungen nicht lesbar: ' + e.message })); }
  }
  search.addEventListener('input', render);
  reload.addEventListener('click', load);
  load(); buildNew().then(render);
});
