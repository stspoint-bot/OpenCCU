'use strict';
// SC Freiburg (Männer, 1. Bundesliga) für die Handy-Seite „⚽ SC“ (Wunsch Thomas, 13.10.2026).
// Quellen, kostenlos und ohne Anmeldung/Schlüssel:
//   – News: kicker-Teamnews als RSS (newsfeed.kicker.de/team/sc-freiburg)
//   – Spiele und Tabelle: OpenLigaDB (api.openligadb.de), nur Bundesliga-Spiele (bl1)
// Abruf nur, wenn die Seite geöffnet wird; Ergebnis 30 Minuten gemerkt (sparsam). Es wird nichts übertragen außer den festen Adressen.
const https = require('https');
const NEWS_URL = 'https://newsfeed.kicker.de/team/sc-freiburg';
const API = 'https://api.openligadb.de';
const TEAM_ID = 112, TEAM = 'SC Freiburg', CACHE_MS = 30 * 60000, MAX_BYTES = 512 * 1024;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000, headers: { 'User-Agent': 'CCU3-Matter-Bridge', Accept: '*/*' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(Error('Antwort ' + res.statusCode)); return; }
      let size = 0; const chunks = [];
      res.on('data', c => { size += c.length; if (size > MAX_BYTES) { req.destroy(Error('Antwort zu groß')); return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(Error('Zeitüberschreitung'))); req.on('error', reject);
  });
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? (() => { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; })() : ENT[e.toLowerCase()] ?? m)
  .replace(/<[^>]*>/g, ' ').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => { const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(xml); return m ? m[1] : ''; };
// RSS lesen: höchstens 15 Einträge; Links nur https://www.kicker.de (keine fremden Ziele auf der Seite)
function parseNews(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const it = m[1], title = decode(tag(it, 'title')).slice(0, 200), link = decode(tag(it, 'link')), at = Date.parse(decode(tag(it, 'pubDate')));
    if (!title) continue;
    out.push({ title, text: decode(tag(it, 'description')).slice(0, 300), link: /^https:\/\/(www\.)?kicker\.de\//.test(link) ? link.slice(0, 500) : '', at: Number.isFinite(at) ? new Date(at).toISOString() : null });
    if (out.length >= 15) break;
  }
  return out;
}
const season = (now = new Date()) => now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; // Saison beginnt im Juli
const result = m => { const r = (m.matchResults || []).find(x => x.resultTypeID === 2) || (m.matchResults || []).at(-1); return r && Number.isInteger(r.pointsTeam1) && Number.isInteger(r.pointsTeam2) ? [r.pointsTeam1, r.pointsTeam2] : null; };
const plain = m => ({ at: typeof m.matchDateTime === 'string' ? m.matchDateTime.slice(0, 19) : null, home: String(m.team1?.teamName || '').slice(0, 60), away: String(m.team2?.teamName || '').slice(0, 60),
  finished: m.matchIsFinished === true, score: result(m), matchday: String(m.group?.groupName || '').slice(0, 40) });
// Nur Bundesliga (Männer): letztes und nächste Spiele
function parseMatches(json) {
  const list = (Array.isArray(json) ? json : []).filter(m => m && m.leagueShortcut === 'bl1').map(plain).filter(m => m.at).sort((a, b) => a.at.localeCompare(b.at));
  const done = list.filter(m => m.finished), open = list.filter(m => !m.finished);
  return { last: done.slice(-3).reverse(), next: open.slice(0, 3) };
}
function parseTable(json) {
  const list = Array.isArray(json) ? json : [];
  return list.map((t, i) => ({ place: i + 1, team: String(t.teamName || '').slice(0, 60), short: String(t.shortName || '').slice(0, 30), points: t.points, matches: t.matches, won: t.won, draw: t.draw, lost: t.lost, goals: t.goals + ':' + t.opponentGoals, diff: t.goalDiff, own: t.teamInfoId === TEAM_ID || t.teamName === TEAM }))
    .filter(t => t.team && Number.isFinite(t.points));
}

class Sc {
  constructor({ now = Date.now, fetch = get } = {}) { this.now = now; this.fetch = fetch; this.cache = null; this.at = 0; this.busy = null; }
  async data(force = false) {
    if (!force && this.cache && this.now() - this.at < CACHE_MS) return this.cache;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const errors = [], s = season(new Date(this.now()));
      const safe = async (what, fn) => { try { return await fn(); } catch (e) { errors.push(what + ': ' + String(e.message || 'Fehler').slice(0, 60)); return null; } };
      const [news, matches, table] = await Promise.all([
        safe('News', async () => parseNews(await this.fetch(NEWS_URL))),
        safe('Spiele', async () => parseMatches(JSON.parse(await this.fetch(API + '/getmatchesbyteamid/' + TEAM_ID + '/2/3')))),
        safe('Tabelle', async () => parseTable(JSON.parse(await this.fetch(API + '/getbltable/bl1/' + s))))]);
      const prev = this.cache || {};
      const out = { team: TEAM, season: s + '/' + String(s + 1).slice(2), news: news || prev.news || [], last: matches?.last || prev.last || [], next: matches?.next || prev.next || [], table: table || prev.table || [],
        at: new Date(this.now()).toISOString(), errors, sources: 'News: kicker.de · Spiele und Tabelle: OpenLigaDB' };
      if (news || matches || table) { this.cache = out; this.at = this.now(); }
      return out;
    })().finally(() => { this.busy = null; });
    return this.busy;
  }
}
let instance = null;
const sc = options => instance || (instance = new Sc(options));
async function handle(web, req, res, u, auth) {
  const method = u.pathname === '/api/' ? u.searchParams.get('method') : null;
  if (method !== 'getScFreiburg') return false;
  const send = (s, d) => web.sendJson(res, s, d);
  try {
    if (!auth) { send(403, { error: 'Anmeldung erforderlich' }); return true; }
    if (req.method !== 'GET') { send(405, { error: 'GET erforderlich' }); return true; }
    send(200, await sc().data(u.searchParams.get('neu') === '1'));
  } catch { send(500, { error: 'SC Freiburg: Daten nicht abrufbar' }); }
  return true;
}
module.exports = { handle, parseNews, parseMatches, parseTable, season, _test: { Sc, reset: () => { instance = null; }, set: o => { instance = new Sc(o); } } };
