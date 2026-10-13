'use strict';
// Seite „Favoriten“: eigene Listen mit Geräten – aktueller Wert und Bedienung auf einen Blick (Wunsch Thomas, 12.10.2026).
// Bedienung über dieselben geprüften Wege wie die Geräteseite (einmal senden, Rückmeldung abwarten).
document.addEventListener('DOMContentLoaded', () => {
  const { h, api, shell, panel, msg, field, confirmDialog } = NEU;
  const main = shell({ title: 'Favoriten', eyebrow: 'Zuhause', lead: 'Deine wichtigsten Geräte in eigenen Listen – mit aktuellem Wert und direkter Bedienung.' });
  const out = h('p', { class: 'msg', role: 'status' }), lists = h('div');
  const editBtn = h('button', { class: 'btn', type: 'button', text: 'Listen bearbeiten', hidden: true });
  const importBtn = h('button', { class: 'btn', type: 'button', text: 'Aus der alten CCU übernehmen', hidden: true });
  main.append(h('div', { class: 'actions' }, editBtn, importBtn), out, lists);
  const PROVIDERS = { smartplus: 'controlSmartplus', smartlife: 'controlSmartlife', dyson: 'controlDyson', tasmota: 'controlTasmota' };
  let admin = false, data = { lists: [] }, devices = new Map(), wetter = null, editing = false, draft = null, timer = null;
  const de = (v, n = 1) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: n, maximumFractionDigits: n });
  const pill = (on, a, b) => h('span', { class: 'tag ' + (on ? 'ok' : ''), text: on ? a : b });
  const btn = (text, fn, cls = '') => { const b = h('button', { class: 'btn small ' + cls, type: 'button', text }); b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } catch (e) { msg(out, e.message, 'bad'); } finally { b.disabled = false; } }); return b; };
  const after = () => setTimeout(load, 1500);

  function label(addr) {
    if (addr === 'wetter') return { name: 'Wetter draußen', room: 'Open-Meteo' };
    const d = devices.get(addr); return d ? { name: d.name || addr, room: d.room || '' } : { name: addr, room: 'nicht (mehr) vorhanden' };
  }
  function valueAndControls(addr) {
    const box = h('div', { class: 'row' });
    if (addr === 'wetter') {
      const c = wetter?.current;
      box.append(h('span', { text: c ? [Number.isFinite(c.temperature) ? de(c.temperature) + ' °C' : '', Number.isFinite(c.humidity) ? de(c.humidity, 0) + ' %' : '', c.text || ''].filter(Boolean).join(' · ') : 'keine Wetterdaten' }));
      return box;
    }
    const d = devices.get(addr); if (!d) { box.append(h('span', { class: 'muted', text: '–' })); return box; }
    const st = d.currentState || {};
    if (d.provider === 'jeep') { box.append(h('b', { text: st.value === null || st.value === undefined ? 'kein Wert' : de(st.value, 0) + ' ' + (st.unit || '') })); return box; }
    if (d.provider) {
      const r = [Number.isFinite(st.temperature) ? de(st.temperature) + ' °C' : '', Number.isFinite(st.humidity) ? de(st.humidity, 0) + ' %' : '', Number.isFinite(st.power) ? de(st.power, 0) + ' W' : ''].filter(Boolean).join(' · ');
      if (r) box.append(h('span', { text: r }));
      if (d.online === false) { box.append(h('span', { class: 'tag bad', text: 'Offline' })); return box; }
      if ((d.capabilities || {}).kind !== 'sensor' && PROVIDERS[d.provider] && typeof st.on === 'boolean') {
        box.append(pill(st.on, 'Ein', 'Aus'), btn(st.on ? 'Ausschalten' : 'Einschalten', async () => { const r2 = await api(PROVIDERS[d.provider], { id: d.id, command: { on: !st.on } }); msg(out, r2.message || 'Übergeben.', 'ok'); after(); }, st.on ? '' : 'primary'));
      }
      return box;
    }
    if (d.thermostatControl && d.thermostatControl.allowed) {
      const t = d.thermostatState || {}, cap = d.thermostatControl, sp = Number.isFinite(t.setpoint) ? t.setpoint : null;
      box.append(h('span', { text: 'Ist ' + (Number.isFinite(t.temperature) ? de(t.temperature) + ' °C' : '–') + ' · Soll ' + (sp !== null ? de(sp) + ' °C' : '–') }));
      const set = v => async () => { const r2 = await api('setThermostatTemperature', { address: d.address, temperature: v }); msg(out, r2.message || 'Übergeben.', 'ok'); after(); };
      if (sp !== null) box.append(btn('−0,5', set(Math.max(cap.min, sp - 0.5))), btn('+0,5', set(Math.min(cap.max, sp + 0.5))));
      return box;
    }
    if (d.dimmerControl && d.dimmerControl.allowed) {
      const lvl = st.currentLevel, pct = typeof lvl === 'number' ? Math.round(lvl / 254 * 100) : null;
      box.append(h('span', { text: 'Helligkeit ' + (pct === null ? '–' : pct + ' %') }));
      for (const [t, p] of [['Aus', 0], ['50 %', 50], ['100 %', 100]]) box.append(btn(t, async () => { const r2 = await api('setDimmerLevel', { address: d.address, percent: p }); msg(out, r2.message || 'Übergeben.', 'ok'); after(); }));
      return box;
    }
    if (d.switchControl && d.switchControl.allowed) {
      const s = d.switchState;
      box.append(h('span', { class: 'tag ' + (s === true ? 'ok' : s === false ? '' : 'warn'), text: s === true ? 'Ein' : s === false ? 'Aus' : 'Unbekannt' }));
      box.append(btn(s === true ? 'Ausschalten' : 'Einschalten', async () => { const r2 = await api('setSwitchState', { address: d.address, state: s !== true }); msg(out, r2.message || 'Übergeben.', 'ok'); after(); }, s === true ? '' : 'primary'));
      return box;
    }
    if (Number.isFinite(st.localTemperature)) box.append(h('span', { text: de(st.localTemperature / 100) + ' °C' + (Number.isFinite(st.occupiedHeatingSetpoint) ? ' → ' + de(st.occupiedHeatingSetpoint / 100) + ' °C' : '') }));
    else if (Number.isFinite(st.measuredValue)) box.append(h('span', { text: de(st.measuredValue / 100) }));
    else if ('stateValue' in st) box.append(pill(!st.stateValue, 'Offen', 'Geschlossen'));
    else if ('occupancy' in st) box.append(pill((st.occupancy & 1) === 1, 'Bewegung', 'Ruhe'));
    else if ('onOff' in st) box.append(pill(!!st.onOff, 'Ein', 'Aus'));
    else box.append(h('span', { class: 'muted', text: '–' }));
    return box;
  }
  function render() {
    editBtn.hidden = importBtn.hidden = !admin || editing;
    if (editing) return renderEdit();
    if (!data.lists.length) { lists.replaceChildren(h('div', { class: 'empty', text: admin ? 'Noch keine Favoriten. Mit „Listen bearbeiten“ anlegen oder „Aus der alten CCU übernehmen“.' : 'Noch keine Favoriten angelegt.' })); return; }
    lists.replaceChildren(...data.lists.map(l => panel(l.name, null, l.items.length ? NEU.table(['Gerät', 'Wert / Bedienung'], l.items.map(a => { const n = label(a); return h('tr', {}, h('td', {}, h('b', { text: n.name }), n.room ? h('span', { class: 'sub', text: n.room }) : null), h('td', {}, valueAndControls(a))); })) : h('p', { class: 'muted', text: 'Leere Liste.' }))));
  }
  // ---------- Bearbeiten (nur Administrator) ----------
  function renderEdit() {
    const all = [...devices.values()].filter(d => d.address).sort((a, b) => (a.room || '~').localeCompare(b.room || '~', 'de') || (a.name || '').localeCompare(b.name || '', 'de'));
    const options = [{ address: 'wetter', name: 'Wetter draußen (Open-Meteo)', room: '' }, ...all];
    const save = btn('Speichern', async () => { const r = await api('saveFavoriten', { lists: draft }); data = { lists: r.lists }; editing = false; msg(out, r.message, 'ok'); render(); }, 'primary');
    const cancel = btn('Abbrechen', async () => { editing = false; render(); });
    const add = btn('＋ Neue Liste', async () => { draft.push({ name: 'Neue Liste', items: [] }); renderEdit(); });
    lists.replaceChildren(h('div', { class: 'actions' }, save, cancel, add), ...draft.map((l, i) => {
      const name = h('input', { value: l.name, maxlength: 40, 'aria-label': 'Name der Liste' }); name.addEventListener('input', () => { l.name = name.value; });
      const sel = h('select', { 'aria-label': 'Gerät hinzufügen' }, h('option', { value: '', text: '＋ Gerät hinzufügen …' }), options.filter(o => !l.items.includes(o.address)).map(o => h('option', { value: o.address, text: (o.room ? o.room + ' · ' : '') + (o.name || o.address) })));
      sel.addEventListener('change', () => { if (sel.value) { l.items.push(sel.value); renderEdit(); } });
      const move = (j, k) => { const x = l.items.splice(j, 1)[0]; l.items.splice(k, 0, x); renderEdit(); };
      return panel('Liste ' + (i + 1), null, h('div', { class: 'form' }, field('Name', name), field('Gerät hinzufügen', sel)),
        l.items.length ? NEU.table(['Gerät', ''], l.items.map((a, j) => { const n = label(a); return h('tr', {}, h('td', {}, h('b', { text: n.name }), n.room ? h('span', { class: 'sub', text: n.room }) : null), h('td', {}, h('div', { class: 'row' }, j ? btn('↑', async () => move(j, j - 1)) : null, j < l.items.length - 1 ? btn('↓', async () => move(j, j + 1)) : null, btn('Entfernen', async () => { l.items.splice(j, 1); renderEdit(); })))); })) : h('p', { class: 'muted', text: 'Noch keine Geräte.' }),
        h('div', { class: 'actions' }, i ? btn('Liste nach oben', async () => { draft.splice(i - 1, 0, draft.splice(i, 1)[0]); renderEdit(); }) : null,
          btn('Liste löschen', async () => { if (await confirmDialog({ title: 'Liste löschen?', text: '„' + l.name + '“ wird nach dem Speichern entfernt (die Geräte bleiben erhalten).', confirm: 'Löschen' })) { draft.splice(i, 1); renderEdit(); } })));
    }));
  }
  editBtn.addEventListener('click', () => { draft = JSON.parse(JSON.stringify(data.lists)); editing = true; render(); });
  importBtn.addEventListener('click', async () => { importBtn.disabled = true; try { const r = await api('importFavoriten', {}); data = { lists: r.lists }; msg(out, r.message, 'ok'); render(); } catch (e) { msg(out, e.message, 'bad'); } finally { importBtn.disabled = false; } });
  async function load() {
    clearTimeout(timer);
    try {
      const [f, d, w] = await Promise.all([api('getFavoriten'), api('getDevices'), api('getWetter').catch(() => null)]);
      if (!editing) data = f;
      devices = new Map((d.devices || []).filter(x => x.address).map(x => [x.address, x])); wetter = w;
      render();
    } catch (e) { lists.replaceChildren(h('div', { class: 'notice bad', text: 'Favoriten nicht lesbar: ' + e.message })); }
    timer = setTimeout(() => { if (!document.hidden && !editing) load(); else timer = setTimeout(load, 15000); }, 15000);
  }
  NEU.ensureSession().then(s => { admin = s.admin === true; }).catch(() => {}).finally(load);
});
