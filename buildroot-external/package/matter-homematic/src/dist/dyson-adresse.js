'use strict';
// Dyson: letzte bekannte Adresse merken (13.10.2026, gleicher Fehler wie bei Smart Life, Wunsch Thomas „bei allen Integrationen prüfen“).
// Der Original-Dienst (dyson.js, unverändert) löscht bei einem Verbindungsabbruch die IP und findet den Dyson danach nur über die
// mDNS-Suche wieder – antwortet der Dyson darauf nicht zuverlässig, bliebe er offline, obwohl seine Adresse bekannt ist.
// Dieser Baustein legt sich um die Suche des laufenden Dienstes: was die Suche nicht findet, bekommt die zuletzt gesehene Adresse
// (nur private Heimnetz-Adressen; eine falsche Adresse scheitert harmlos an der Dyson-Anmeldung). Gemerkt in dyson-lan-cache.json.
const fs = require('node:fs'), path = require('node:path');
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/;
let timer = null;
function wrap(web, dyson, file) {
  const d = dyson?.discovery; if (!d || typeof d.find !== 'function' || d.__letzteAdresse) return false;
  let mem = {}; try { const r = JSON.parse(fs.readFileSync(file, 'utf8')); for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && PRIVATE.test(v)) mem[k] = v; } catch {}
  const save = () => { try { require('./durable-storage').atomicJson(file, mem); } catch {} };
  const orig = d.find.bind(d);
  d.find = async serials => {
    const found = await orig(serials);
    let changed = false;
    for (const [s, ip] of found) if (PRIVATE.test(ip) && mem[s] !== ip) { mem[s] = ip; changed = true; }
    for (const s of serials || []) if (!found.has(s) && mem[s]) found.set(s, mem[s]);
    if (changed) save();
    return found;
  };
  // auch aktuell verbundene Geräte merken (falls sie seit dem Start nie gesucht werden mussten)
  try { for (const e of dyson.public?.() || []) if (e.ip && PRIVATE.test(e.ip) && mem[e.id] !== e.ip) { mem[e.id] = e.ip; save(); } } catch {}
  d.__letzteAdresse = true; return true;
}
// Der Dyson-Dienst startet erst nach der Bridge; daher jede Minute nachsehen, bis er da ist (danach nur noch bei Neustart des Dienstes)
function start(web) {
  if (timer) return;
  const file = web.deps?.configPath ? path.join(path.dirname(web.deps.configPath), 'dyson-lan-cache.json') : null;
  const tick = () => { try { const dy = web.deps.getDyson?.(); if (dy && file) wrap(web, dy, file); } catch {} };
  tick(); timer = setInterval(tick, 60000); timer.unref?.();
}
module.exports = { start, _test: { wrap, stop: () => { clearInterval(timer); timer = null; } } };
