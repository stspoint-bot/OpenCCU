'use strict';
// Seite „Netzwerk“ (Wunsch Thomas, 12.10.2026): ersetzt die Netzwerkeinstellungen der alten OpenCCU.
// Anzeige der aktuellen Adresse; Ändern (DHCP oder feste Adresse) gilt nach dem nächsten Neustart der Zentrale.
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, field, msg, task, stat, confirmDialog } = NEU;
  const main = shell({ title: 'Netzwerk', eyebrow: 'System', lead: 'Adresse der Zentrale im Heimnetz. Im Normalfall bleibt alles, wie es ist – ändern nur, wenn sich Router oder Heimnetz ändern.' });
  const stats = h('div', { class: 'stats' }), out = h('p', { class: 'msg', role: 'status' });
  const f = { hostname: h('input', { type: 'text', maxlength: 63 }), mode: h('select', {}, h('option', { value: 'MANUAL', text: 'Feste Adresse (empfohlen)' }), h('option', { value: 'DHCP', text: 'Automatisch vom Router (DHCP)' })),
    ip: h('input', { type: 'text', inputmode: 'decimal' }), netmask: h('input', { type: 'text', inputmode: 'decimal' }), gateway: h('input', { type: 'text', inputmode: 'decimal' }), dns1: h('input', { type: 'text', inputmode: 'decimal' }), dns2: h('input', { type: 'text', inputmode: 'decimal' }) };
  const fixed = h('div', { class: 'form' }, field('IP-Adresse', f.ip), field('Netzmaske', f.netmask), field('Gateway (Router)', f.gateway), field('DNS-Server', f.dns1), field('Zweiter DNS-Server (optional)', f.dns2));
  const save = h('button', { class: 'btn primary', type: 'button', text: 'Speichern (gilt nach Neustart)' });
  main.append(stats, panel('Einstellung', '⚠ Eine falsche Adresse macht die Zentrale nach dem Neustart unerreichbar. Im Zweifel nichts ändern.', h('div', { class: 'form' }, field('Gerätename im Netz', f.hostname), field('Adresse', f.mode)), fixed, h('div', { class: 'actions' }, save), out));
  f.mode.addEventListener('change', () => { fixed.hidden = f.mode.value === 'DHCP'; });
  function render(d) {
    stats.replaceChildren(stat('Aktuelle Adresse', d.current.ip || '–', d.mode === 'DHCP' ? 'vom Router (DHCP)' : 'fest eingestellt', 'ok'), stat('Router', d.current.gateway || '–', 'Gateway'), stat('Gerätename', d.hostname || '–', d.mac ? 'MAC ' + d.mac : ''));
    f.hostname.value = d.hostname || ''; f.mode.value = d.mode; fixed.hidden = d.mode === 'DHCP';
    const c = d.configured, cur = d.current;
    f.ip.value = c.ip || cur.ip || ''; f.netmask.value = c.netmask || cur.netmask || '255.255.255.0'; f.gateway.value = c.gateway || cur.gateway || ''; f.dns1.value = c.dns1 || cur.dns1 || cur.gateway || ''; f.dns2.value = c.dns2 && c.dns2 !== '0.0.0.0' ? c.dns2 : '';
  }
  save.addEventListener('click', () => task(save, out, async () => {
    const p = { hostname: f.hostname.value.trim(), mode: f.mode.value, ip: f.ip.value.trim(), netmask: f.netmask.value.trim(), gateway: f.gateway.value.trim(), dns1: f.dns1.value.trim(), dns2: f.dns2.value.trim() };
    if (!await confirmDialog({ title: 'Netzwerk-Einstellung speichern?', danger: true, text: p.mode === 'DHCP' ? 'Die Zentrale holt sich nach dem nächsten Neustart ihre Adresse vom Router. Die Adresse kann sich dabei ändern.' : 'Nach dem nächsten Neustart ist die Zentrale unter ' + p.ip + ' erreichbar. Bitte genau prüfen.', confirm: 'Speichern' })) return 'Nicht geändert.';
    const r = await api('saveNetzwerk', p); render(r); return r.message;
  }, 'Wird gespeichert …'));
  api('getNetzwerk').then(render).catch(e => { msg(out, e.message, 'bad'); save.disabled = true; });
});
