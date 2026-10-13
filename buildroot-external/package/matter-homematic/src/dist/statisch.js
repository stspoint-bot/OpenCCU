'use strict';
// Schnellere Oberfläche (13.10.2026, Systemdurchgang „Stabilität und Schnelligkeit“): Der Bridge-Kern liefert Skripte/Styles
// unkomprimiert und mit „no-cache“ aus – jeder Seitenwechsel lud alles neu (alle Skripte zusammen ~620 KB).
// Dieser Baustein übernimmt nur Dateien MIT Versionsnummer (?v=…, wechselt bei jeder Installation) aus dem Oberflächenordner:
// gzip (einmal gepackt, im Speicher gehalten) und „private, max-age=7 Tage, immutable“ → der Browser lädt sie bis zur nächsten
// Version nicht erneut. HTML-Seiten und Dateien ohne ?v bleiben beim Kern (immer frisch). Nur nach Anmeldung (Aufruf aus ccu-zentrale).
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json' };
const PACK = new Set(['.js', '.css', '.svg', '.json']);
const MAX_FILE = 2 * 1048576, MAX_CACHE = 80;
const cache = new Map();
function rootOf(web) { return path.resolve(web.staticDir || path.join(__dirname, '..', 'html')); }
function load(file) {
  const st = fs.statSync(file); if (!st.isFile() || st.size > MAX_FILE) return null;
  const key = file + '|' + st.mtimeMs + '|' + st.size, hit = cache.get(file);
  if (hit && hit.key === key) return hit;
  const raw = fs.readFileSync(file), ext = path.extname(file).toLowerCase();
  const gz = PACK.has(ext) && raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null;
  const entry = { key, raw, gz: gz && gz.length < raw.length ? gz : null, etag: '"' + st.size.toString(36) + '-' + Math.round(st.mtimeMs).toString(36) + '"', type: TYPES[ext] };
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(file, entry); return entry;
}
function handle(web, req, res, u) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!u.searchParams.has('v') || !/^\/(js|css|img|bilder|fonts)\/[A-Za-z0-9._\/-]{1,120}$/.test(u.pathname) || u.pathname.includes('..')) return false;
  const ext = path.extname(u.pathname).toLowerCase(); if (!TYPES[ext]) return false;
  const root = rootOf(web), file = path.resolve(root, '.' + u.pathname);
  if (!file.startsWith(root + path.sep)) return false;
  let e; try { e = load(file); } catch { return false; } if (!e) return false;
  const headers = { 'Content-Type': e.type, 'Cache-Control': 'private, max-age=604800, immutable', 'ETag': e.etag, 'Vary': 'Accept-Encoding', 'X-Content-Type-Options': 'nosniff' };
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, headers); res.end(); return true; }
  const gzip = e.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const body = gzip ? e.gz : e.raw; if (gzip) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = String(body.length);
  res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body); return true;
}
module.exports = { handle, _test: { cache, load } };
