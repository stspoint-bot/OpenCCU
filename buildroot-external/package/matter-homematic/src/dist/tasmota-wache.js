'use strict';
// Onlineprüfung aller Tasmota-Geräte (Wunsch Thomas, 13.10.2026): ist ein Gerät 5 Minuten nicht erreichbar → einmal WhatsApp,
// wieder erreichbar → einmal WhatsApp. Je Gerät abschaltbar (Seite „Geräte (neu)“); Standard: an.
// Nur Auswertung des ohnehin laufenden Tasmota-Dienstes (keine zusätzlichen Abfragen ans Netz); Zustand übersteht Neustarts,
// damit ein dauerhaft ausgestecktes Gerät nicht nach jedem Bridge-Start erneut gemeldet wird.
const fs = require('node:fs'), path = require('node:path');
const fail = (m, s = 400) => Object.assign(Error(m), { status: s });
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);
const MAC = /^[a-f0-9]{12}$/;
const OFFLINE_MS = 5 * 60000;

const settings = web => { try { const c = web.security.configSnapshot.read().tasmotaWache; return { aus: isObject(c) && Array.isArray(c.aus) ? c.aus.filter(m => typeof m === 'string' && MAC.test(m)).slice(0, 64) : [] }; } catch { return { aus: [] }; } };
const watched = (web, mac) => !settings(web).aus.includes(mac);

class Wache {
  constructor(web, { now = () => Date.now(), timerMs = 30000, hosts, send } = {}) {
    this.web = web; this.now = now; this.timerMs = timerMs; this.timer = null; this.busy = false;
    this.hostsImpl = hosts || null; this.sendImpl = send || null; this.started = now();
    this.file = web.deps?.configPath ? path.join(path.dirname(web.deps.configPath), 'tasmota-wache-state.json') : null;
    this.state = { off: {}, warned: {} };
    try { const r = JSON.parse(fs.readFileSync(this.file, 'utf8')); for (const k of ['off', 'warned']) if (isObject(r[k])) this.state[k] = Object.fromEntries(Object.entries(r[k]).filter(([m, v]) => MAC.test(m) && (typeof v === 'number' || typeof v === 'boolean')).slice(0, 64)); } catch {}
  }
  save() { if (!this.file) return; try { require('./durable-storage').atomicJson(this.file, this.state); } catch {} }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick().catch(() => {}), this.timerMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  hosts() { try { return this.hostsImpl ? this.hostsImpl() : require('./tasmota')._test.publicList(this.web).hosts || []; } catch { return []; } }
  async whatsapp(text) { try { if (this.sendImpl) await this.sendImpl(text); else await this.web.security.monitor.send(text); } catch {} }
  stamp() { return new Date(this.now()).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const now = this.now(), list = this.hosts().filter(h => h && typeof h.mac === 'string' && MAC.test(h.mac)), seen = new Set();
      let changed = false;
      for (const h of list) {
        seen.add(h.mac);
        const name = String(h.name || h.ip || h.mac).slice(0, 60);
        if (h.online === true) {
          if (this.state.off[h.mac]) { delete this.state.off[h.mac]; changed = true; }
          if (this.state.warned[h.mac]) { delete this.state.warned[h.mac]; changed = true; if (watched(this.web, h.mac)) await this.whatsapp(`CCU3 · Tasmota\n${this.stamp()}\n„${name}“ ist wieder erreichbar.`); }
          continue;
        }
        // Nach dem Bridge-Start zählt die Zeit erst ab dem Start (sonst gälte jedes Gerät bis zur ersten Abfrage als offline)
        if (!this.state.off[h.mac]) { this.state.off[h.mac] = Math.max(now, this.started); changed = true; }
        if (!this.state.warned[h.mac] && watched(this.web, h.mac) && now - this.state.off[h.mac] >= OFFLINE_MS) {
          this.state.warned[h.mac] = true; changed = true;
          await this.whatsapp(`CCU3 · Tasmota\n${this.stamp()}\n„${name}“ seit ${Math.round((now - this.state.off[h.mac]) / 60000)} Minuten nicht erreichbar – ausgesteckt, ohne Strom oder WLAN-Problem?`);
        }
      }
      // Entfernte Geräte vergessen
      for (const k of ['off', 'warned']) for (const m of Object.keys(this.state[k])) if (!seen.has(m)) { delete this.state[k][m]; changed = true; }
      if (changed) this.save();
    } finally { this.busy = false; }
  }
  status() {
    const s = settings(this.web);
    return { hosts: this.hosts().filter(h => h && MAC.test(h.mac || '')).map(h => ({ mac: h.mac, name: h.name || '', online: h.online === true, onlineCheck: !s.aus.includes(h.mac), offlineSince: this.state.off[h.mac] ? new Date(this.state.off[h.mac]).toISOString() : null, gemeldet: !!this.state.warned[h.mac] })) };
  }
}
const instances = new WeakMap();
function wache(web, options) { let w = instances.get(web); if (!w) { w = new Wache(web, options); instances.set(web, w); } return w; }
function start(web, options) { const w = wache(web, options); w.start(); return w; }

async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (!['getTasmotaWache', 'setTasmotaOnlineCheck'].includes(method)) return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth || auth.session?.localBypass) { send(403, { error: 'Nur nach Anmeldung als CCU-Administrator möglich' }); return true; }
    if (method === 'getTasmotaWache') { if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; } send(200, wache(web).status()); return true; }
    if (req.method !== 'POST') { send(405, { error: 'POST erforderlich' }); return true; }
    const p = await require('./web-security').body(req);
    if (!isObject(p) || Object.keys(p).some(k => !['mac', 'enabled'].includes(k)) || typeof p.mac !== 'string' || !MAC.test(p.mac) || typeof p.enabled !== 'boolean') throw fail('Gerät und Ein/Aus angeben');
    if (!wache(web).hosts().some(h => h.mac === p.mac)) throw fail('Tasmota-Gerät nicht gefunden', 404);
    web.writeConfigPatch(c => { const aus = new Set(isObject(c.tasmotaWache) && Array.isArray(c.tasmotaWache.aus) ? c.tasmotaWache.aus.filter(m => MAC.test(m)) : []); if (p.enabled) aus.delete(p.mac); else aus.add(p.mac); c.tasmotaWache = { aus: [...aus].slice(0, 64) }; });
    send(200, { success: true, ...wache(web).status(), message: p.enabled ? 'Onlineprüfung an.' : 'Onlineprüfung aus – keine Meldung, wenn das Gerät nicht erreichbar ist.' });
  } catch (e) { send(e.status || 500, { error: e.status ? e.message : 'Tasmota-Onlineprüfung: Anfrage fehlgeschlagen' }); }
  return true;
}
module.exports = { handle, start, settings, _test: { Wache, wache, OFFLINE_MS, reset: web => { instances.get(web)?.stop(); instances.delete(web); } } };
