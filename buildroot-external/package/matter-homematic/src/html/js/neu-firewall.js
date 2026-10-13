'use strict';
// Seite „Firewall“ (Wunsch Thomas, 12.10.2026): Firewall der Zentrale ansehen und ändern – ersetzt die Firewall-Einstellung
// der alten OpenCCU-Oberfläche. Schutz: Pflicht-Ports bleiben, nach dem Anwenden 90 s Zeit zum Bestätigen, sonst zurück.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task } = NEU;
  const main = shell({ title: 'Firewall', eyebrow: 'System', lead: 'Welche Geräte und Netze auf die Zentrale zugreifen dürfen. Änderungen werden sofort angewendet; bestätigst du sie nicht innerhalb von 90 Sekunden, stellt die Zentrale die vorherige Einstellung automatisch wieder her.' });
  const out = h('p', { class: 'msg', role: 'status' }), confirmBox = h('div', { class: 'notice warn', hidden: true });
  const mode = h('select', { 'aria-label': 'Modus' }, h('option', { value: 'MOST_OPEN', text: 'Offen (Ports offen, Dienste nach Einstellung) – empfohlen' }), h('option', { value: 'RESTRICTIVE', text: 'Streng (nur ausdrücklich freigegebene Ports)' }));
  const ips = h('textarea', { rows: 6, 'aria-label': 'Erlaubte Netze', spellcheck: 'false' });
  const portList = h('div', { class: 'fw-ports' }), newPort = h('input', { type: 'number', min: 1, max: 65535, placeholder: 'Port', 'aria-label': 'Neuer Port', style: 'max-width:120px' });
  const addPort = h('button', { class: 'btn small', type: 'button', text: 'Port hinzufügen' });
  const services = h('div', { class: 'form' }), save = h('button', { class: 'btn primary', type: 'button', text: 'Anwenden' }), ext = h('p', { class: 'muted' });
  main.append(confirmBox, out,
    panel('Modus und erlaubte Netze', 'Bei eingeschränktem Zugriff dürfen nur diese Adressen/Netze zugreifen. Ein Eintrag je Zeile, z. B. 192.168.0.0/16. 100.64.0.0/10 ist Tailscale (Fernzugriff).', h('div', { class: 'form' }, field('Modus', mode), h('div', { class: 'wide' }, field('Erlaubte Netze', ips))), ext),
    panel('Freigegebene Ports', 'Zusätzlich geöffnete Ports. Mit 🔒 markierte Ports brauchen Apple Home bzw. diese Oberfläche und bleiben immer offen.', portList, h('div', { class: 'row' }, newPort, addPort)),
    panel('Dienste der Zentrale', 'Voll = alle, Eingeschränkt = nur erlaubte Netze, Kein = gesperrt.', services),
    h('div', { class: 'actions' }, save));
  let data = null, ports = [];
  const LABEL = { full: 'Voll', restricted: 'Eingeschränkt', none: 'Kein Zugriff' };
  function renderPorts() {
    portList.replaceChildren(...ports.map(p => {
      const info = (data.userPorts.find(x => x.port === p) || {}).label || '', req = data.required.some(r => r.port === p);
      const chip = h('span', { class: 'tag' + (req ? ' ok' : ''), text: (req ? '🔒 ' : '') + p + (info ? ' · ' + info : '') });
      if (!req) { const x = h('button', { class: 'btn small', type: 'button', text: '✕', title: 'Port ' + p + ' entfernen', 'aria-label': 'Port ' + p + ' entfernen' }); x.addEventListener('click', () => { ports = ports.filter(q => q !== p); renderPorts(); }); chip.append(' ', x); }
      return chip;
    }));
  }
  function render(d) {
    data = d; mode.value = d.mode; ips.value = d.ips.join('\n'); ports = d.userPorts.map(p => p.port); renderPorts();
    services.replaceChildren(...d.services.map(s => { const sel = h('select', { 'aria-label': s.label, dataset: { id: s.id } }, ...['full', 'restricted', 'none'].map(a => h('option', { value: a, text: LABEL[a] }))); sel.value = s.access; return field(s.label + ' (Ports ' + s.ports.join(', ') + ')', sel); }));
    ext.textContent = d.externalAccess ? '⚠ Zugriff aus dem Internet ist in der CCU freigeschaltet (AllowExternalAccess).' : 'Zugriff aus dem Internet ist gesperrt (nur lokale Netze und Tailscale).';
    showPending(d.pending);
  }
  let tick = null;
  function showPending(p) {
    clearInterval(tick);
    if (!p) { confirmBox.hidden = true; return; }
    const keep = h('button', { class: 'btn primary', type: 'button', text: 'Funktioniert – behalten' }), back = h('button', { class: 'btn', type: 'button', text: 'Rückgängig' }), left = h('b');
    keep.addEventListener('click', () => task(keep, out, async () => { render(await api('confirmFirewall', {})); return 'Gespeichert. Die Firewall-Einstellung bleibt.'; }));
    back.addEventListener('click', () => task(back, out, async () => { render(await api('undoFirewall', {})); return 'Vorherige Einstellung wiederhergestellt.'; }));
    confirmBox.replaceChildren(h('p', {}, '🟠 Neue Firewall-Einstellung aktiv. Noch ', left, ' Sekunden zum Bestätigen – sonst automatisch zurück.'), h('div', { class: 'actions' }, keep, back));
    confirmBox.hidden = false;
    const until = Date.parse(p.until), upd = () => { const s = Math.max(0, Math.round((until - Date.now()) / 1000)); left.textContent = String(s); if (!s) { clearInterval(tick); setTimeout(load, 3000); } };
    upd(); tick = setInterval(upd, 1000);
  }
  addPort.addEventListener('click', () => { const p = Number(newPort.value); if (!Number.isInteger(p) || p < 1 || p > 65535) { msg(out, 'Port 1 bis 65535 eingeben.', 'bad'); return; } if (!ports.includes(p)) ports.push(p); ports.sort((a, b) => a - b); newPort.value = ''; renderPorts(); });
  save.addEventListener('click', () => task(save, out, async () => {
    const payload = { mode: mode.value, ips: ips.value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean), userPorts: ports, services: Object.fromEntries([...services.querySelectorAll('select')].map(s => [s.dataset.id, s.value])) };
    render(await api('saveFirewall', payload)); return 'Angewendet – bitte bestätigen.';
  }, 'Wird angewendet …'));
  async function load() { try { render(await api('getFirewall')); } catch (e) { msg(out, e.message, 'bad'); save.disabled = true; } }
  load();
});
