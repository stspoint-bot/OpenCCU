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
  // Neue Verknüpfung (nur Administratoren): erst Sender (Taster/Schalter), dann passender Empfänger (Aktor)
  const newBox = h('div');
  function label(c) { return c.name + (c.room ? ' · ' + c.room : '') + ' (' + c.address + ')'; }
  async function buildNew() {
    let cand; try { cand = (await api('getLinkCandidates')).channels; admin = true; } catch { admin = false; return; }
    const senders = cand.filter(c => c.source.length), out2 = h('p', { class: 'msg', role: 'status' });
    const snd = h('select', { 'aria-label': 'Sender' }, h('option', { value: '', text: 'Sender wählen (Taster, Schalter, Melder) …' }), ...senders.map((c, i) => h('option', { value: String(i), text: label(c) })));
    const rcv = h('select', { 'aria-label': 'Empfänger', disabled: true }, h('option', { value: '', text: 'zuerst Sender wählen' }));
    const nm = h('input', { type: 'text', maxlength: 60, placeholder: 'Name (freiwillig)', 'aria-label': 'Name der Verknüpfung' });
    const add = h('button', { class: 'btn primary', type: 'button', text: 'Verknüpfung anlegen', disabled: true });
    let matches = [];
    snd.addEventListener('change', () => {
      const s = senders[Number(snd.value)];
      matches = s ? cand.filter(c => c.interface === s.interface && c.address !== s.address && c.target.some(x => s.source.includes(x))) : [];
      rcv.replaceChildren(h('option', { value: '', text: !s ? 'zuerst Sender wählen' : matches.length ? 'Empfänger wählen …' : 'kein passender Empfänger' }), ...matches.map((c, i) => h('option', { value: String(i), text: label(c) })));
      rcv.disabled = !matches.length; add.disabled = true;
    });
    rcv.addEventListener('change', () => { add.disabled = !rcv.value; });
    add.addEventListener('click', async () => {
      const s = senders[Number(snd.value)], t = matches[Number(rcv.value)]; if (!s || !t) return;
      if (!await confirmDialog({ title: 'Verknüpfung anlegen?', confirm: 'Anlegen', text: '„' + s.name + '“ soll „' + t.name + '“ direkt schalten. Die CCU überträgt das an die Geräte; Batteriegeräte ggf. kurz wecken (Taste drücken).' })) return;
      task(add, out2, async () => { data = await api('addDirectLink', { interface: s.interface, sender: s.address, receiver: t.address, name: nm.value.trim() }); showStats(); render(); nm.value = ''; return 'Angelegt: „' + s.name + '“ → „' + t.name + '“.'; }, 'Wird angelegt …');
    });
    newBox.replaceChildren(panel('Neue Verknüpfung', 'Nur passende Kanäle werden angeboten. Die Verknüpfung wird im Gerät gespeichert und funktioniert danach auch ohne CCU.', h('div', { class: 'row' }, snd, rcv), h('div', { class: 'row' }, nm, add), out2));
  }
  main.append(newBox);
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
