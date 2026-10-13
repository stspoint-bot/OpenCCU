'use strict';
// Tasmota-Geräte als Matter-Geräte für Apple Home. Jeder freigegebene Schalter, Dimmer oder Fühler
// wird ein eigenes Gerät an der vorhandenen Bridge. Die Nummer eines Geräts bleibt über Neustarts
// gleich (gleiche Verwaltung wie bei allen anderen Geräten), die Kopplung wird nicht berührt.
//
// - Beim Start der Bridge und beim Abgleich wird nie geschaltet.
// - Ein Befehl aus Apple Home wird genau einmal an das Gerät gesendet. Schlägt er fehl, zeigt
//   Apple Home danach wieder den tatsächlichen Zustand.
// - Rückmeldungen des Geräts lösen keinen Befehl aus (kein Echo).
const { text, serial } = require('./matter-text');

class TasmotaMatter {
  constructor(bridge, matter, options = {}) {
    this.bridge = bridge; this.matter = matter;
    this.tasmota = options.tasmota || require('./tasmota');
    this.service = options.service || this.tasmota.getService();
    this.notice = options.notice || (() => { });
    this.entries = new Map(); this.stopped = false; this.queue = Promise.resolve(); this.onState = null;
  }
  async start() {
    this.onState = e => { this.apply(e).catch(() => { }); };
    this.service.on('state', this.onState);
    await this.reconcile(this.tasmota.hostsFrom(this.bridge.config));
  }
  // Was laut Geräteliste in Apple Home erscheinen soll.
  wanted(hosts) {
    const out = new Map();
    for (const h of hosts) {
      for (const r of h.relays) if (r.exposed) out.set(h.mac + '-' + r.n, { id: h.mac + '-' + r.n, kind: r.dimmer ? 'light' : 'plug', name: r.name });
      if (h.sensor?.exposed) out.set(h.mac + '-s', { id: h.mac + '-s', kind: 'sensor', name: h.sensor.name, temperature: h.sensor.temperature, humidity: h.sensor.humidity });
    }
    return out;
  }
  // Abgleich mit der Geräteliste – beim Start und bei jeder Änderung, nacheinander. Liefert, ob sich etwas änderte.
  reconcile(hosts) {
    const task = this.queue.then(() => this.reconcileNow(hosts));
    this.queue = task.catch(() => { });
    return task;
  }
  async reconcileNow(hosts) {
    if (this.stopped) return false;
    const wanted = this.wanted(hosts); let changed = false;
    const shape = w => [w.kind, !!w.temperature, !!w.humidity].join('|');
    for (const [id, entry] of [...this.entries]) {
      const w = wanted.get(id);
      if (w && shape(w) === shape(entry.item)) continue;
      this.entries.delete(id); clearTimeout(entry.timer); changed = true;
      for (const ep of [entry.endpoint, entry.humidityEndpoint]) if (ep) { try { await ep.delete(); } catch { this.notice('Tasmota: Matter-Gerät konnte nicht entfernt werden: ' + entry.item.name); } }
    }
    for (const [id, w] of wanted) {
      const existing = this.entries.get(id);
      if (existing) {
        if (existing.item.name !== w.name) { existing.item = w; changed = true; await this.rename(existing).catch(() => { }); }
        continue;
      }
      const entry = { item: w, id, endpoint: null, humidityEndpoint: null, syncing: 0, desired: {}, timer: null, sending: false };
      let endpoints;
      try { endpoints = this.build(entry); }
      catch { this.notice('Tasmota: Matter-Gerät konnte nicht angelegt werden: ' + w.name); continue; }
      // Ab hier gilt dieselbe Regel wie für alle Geräte: Ein Fehler beim Eintragen wird nicht übergangen.
      for (const ep of endpoints) await this.bridge.addEndpointWithStableNumber(ep);
      this.entries.set(id, entry); changed = true;
      const current = this.service.entry(id);
      if (current) await this.apply(current).catch(() => { });
    }
    if (this.bridge.config) this.bridge.config.tasmota = { devices: hosts };
    return changed;
  }
  info(entry, suffix = '', label = '') {
    return { vendorName: 'Tasmota', productName: text(entry.item.kind === 'sensor' ? 'Tasmota Fühler' : entry.item.kind === 'light' ? 'Tasmota Dimmer' : 'Tasmota Schalter'), nodeLabel: text(entry.item.name + label), serialNumber: serial('tasmota-' + entry.id + suffix), reachable: false };
  }
  build(entry) {
    const { Endpoint, devices, behaviors } = this.matter, w = entry.item, base = behaviors.BridgedDeviceBasicInformationServer;
    if (w.kind === 'sensor') {
      const made = [];
      if (w.temperature) { entry.endpoint = new Endpoint(devices.TemperatureSensorDevice.with(base), { id: 'tasmota-' + entry.id, bridgedDeviceBasicInformation: this.info(entry, '', w.humidity ? ' Temperatur' : ''), temperatureMeasurement: { measuredValue: null, minMeasuredValue: -4000, maxMeasuredValue: 12500 } }); made.push(entry.endpoint); }
      if (w.humidity) {
        const ep = new Endpoint(devices.HumiditySensorDevice.with(base), { id: 'tasmota-' + entry.id + '-humidity', bridgedDeviceBasicInformation: this.info(entry, '-humidity', w.temperature ? ' Feuchtigkeit' : ''), relativeHumidityMeasurement: { measuredValue: null, minMeasuredValue: 0, maxMeasuredValue: 10000 } });
        if (entry.endpoint) entry.humidityEndpoint = ep; else entry.endpoint = ep;
        entry.humidityOnly = !w.temperature; made.push(ep);
      }
      if (!made.length) throw Error('Fühler ohne Messwert');
      return made;
    }
    const options = { id: 'tasmota-' + entry.id, bridgedDeviceBasicInformation: this.info(entry), onOff: { onOff: false } };
    if (w.kind === 'light') options.levelControl = { currentLevel: 254, minLevel: 1, maxLevel: 254 };
    const endpoint = new Endpoint((w.kind === 'light' ? devices.DimmableLightDevice : devices.OnOffPlugInUnitDevice).with(base), options);
    endpoint.events.onOff.onOff$Changed.on(value => { if (this.service.entry(entry.id)?.state.on !== value) this.schedule(entry, { on: value }); });
    if (w.kind === 'light') endpoint.events.levelControl.currentLevel$Changed.on(value => {
      if (value === null || value <= 0) return;
      const percent = Math.max(1, Math.min(100, Math.round(value * 100 / 254)));
      if (this.service.entry(entry.id)?.state.brightness !== percent) this.schedule(entry, { brightness: percent });
    });
    entry.endpoint = endpoint;
    return [endpoint];
  }
  async rename(entry) {
    const w = entry.item;
    if (w.kind === 'sensor') {
      if (entry.humidityOnly) return entry.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: text(w.name) } });
      await entry.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: text(w.name + (entry.humidityEndpoint ? ' Temperatur' : '')) } });
      if (entry.humidityEndpoint) await entry.humidityEndpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: text(w.name + ' Feuchtigkeit') } });
      return;
    }
    await entry.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: text(w.name) } });
  }
  // Rückmeldung des Geräts → Matter. Löst nie einen Befehl aus.
  async apply(e) {
    const entry = e && this.entries.get(e.id); if (!entry || this.stopped) return;
    const s = e.state || {}, reach = { bridgedDeviceBasicInformation: { reachable: e.online === true } };
    entry.syncing++;
    try {
      if (entry.item.kind === 'sensor') {
        const t = { ...reach, temperatureMeasurement: { measuredValue: Number.isFinite(s.temperature) ? Math.round(s.temperature * 100) : null } };
        const h = { ...reach, relativeHumidityMeasurement: { measuredValue: Number.isFinite(s.humidity) ? Math.round(s.humidity * 100) : null } };
        if (entry.humidityOnly) await entry.endpoint.set(h);
        else { await entry.endpoint.set(t); if (entry.humidityEndpoint) await entry.humidityEndpoint.set(h); }
        return;
      }
      const update = { ...reach };
      if (typeof s.on === 'boolean') update.onOff = { onOff: s.on };
      if (entry.item.kind === 'light' && Number.isFinite(s.brightness) && s.brightness > 0) update.levelControl = { currentLevel: Math.max(1, Math.round(s.brightness * 254 / 100)) };
      await entry.endpoint.set(update);
    } finally { entry.syncing--; }
  }
  // Befehl aus Apple Home: kurz sammeln (Ein + Helligkeit kommen oft zusammen), dann einmal senden.
  schedule(entry, command) {
    if (entry.syncing || this.stopped || !this.entries.has(entry.id) || (this.bridge.serverNode && !this.bridge.serverNode.lifecycle.isOnline)) return;
    Object.assign(entry.desired, command);
    clearTimeout(entry.timer); entry.timer = setTimeout(() => { this.flush(entry).catch(() => { }); }, 150);
  }
  async flush(entry) {
    if (this.stopped || !this.entries.has(entry.id)) return;
    if (entry.sending) { entry.timer = setTimeout(() => { this.flush(entry).catch(() => { }); }, 150); return; }
    const d = entry.desired; entry.desired = {};
    const command = d.on === false ? { on: false } : Number.isFinite(d.brightness) ? { brightness: d.brightness } : d.on === true ? { on: true } : null;
    if (!command) return;
    entry.sending = true;
    try { await this.service.control(entry.id, command); }
    catch { this.notice('Tasmota: Befehl aus Apple Home nicht bestätigt: ' + entry.item.name); }
    finally { entry.sending = false; }
    // In jedem Fall den tatsächlichen Zustand zeigen.
    const current = this.service.entry(entry.id);
    if (current && !Object.keys(entry.desired).length) await this.apply(current).catch(() => { });
  }
  async stop() {
    this.stopped = true;
    if (this.onState) this.service.off('state', this.onState);
    for (const e of this.entries.values()) clearTimeout(e.timer);
    this.entries.clear();
  }
}
module.exports = { TasmotaMatter };
