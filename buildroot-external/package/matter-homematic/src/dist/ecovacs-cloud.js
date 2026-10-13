'use strict';
// Ecovacs-Cloud (Deebot-Saugroboter, Wunsch Thomas 13.10.2026): Anmeldung, Geräteliste, Befehle.
// Eigene Umsetzung des Protokolls, wie es die offenen Bibliotheken deebot-client (Home Assistant) und ecovacs-deebot.js
// beschreiben (kein fremder Code übernommen). Auf dem PC am echten Konto geprüft (Werkzeuge\ecovacs-auslesen.js, 13.10.2026).
// Geheimnisse: Konto-Passwort nur als MD5 (so meldet sich auch die Ecovacs-App an); Token bleibt im Speicher.
const crypto = require('node:crypto');
const md5 = s => crypto.createHash('md5').update(String(s)).digest('hex');
const fail = (message, status = 502, extra = {}) => Object.assign(Error(message), { status, ...extra });
const KEYS = Object.freeze({ client: ['1520391301804', '6c319b2a5cd3e66e39159c2e28f2fce9'], auth: ['1520391491841', '77ef58ce3afbe337da74aa8c5ab963a9'] });
const REALM = 'ecouser.net';
const UA = Object.freeze({ 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 5.1.1; A5010 Build/LMY48Z)' });
const sign = (params, extra, [key, secret]) => { const all = { ...extra, ...params }; return { ...params, authSign: md5(key + Object.keys(all).sort().map(k => k + '=' + all[k]).join('') + secret), authAppkey: key }; };

class EcovacsCloud {
  constructor({ country = 'DE', continent = 'eu', deviceId, fetchImpl = globalThis.fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
    if (!/^[a-f0-9]{32}$/.test(deviceId || '')) throw fail('Ecovacs: Geräte-Kennung fehlt', 500);
    if (!/^[A-Z]{2}$/.test(country) || !/^[a-z]{2}$/.test(continent)) throw fail('Ecovacs: Land ungültig', 500);
    const c = country.toLowerCase();
    this.loginUrl = `https://gl-${c}-api.ecovacs.com`; this.authUrl = `https://gl-${c}-openapi.ecovacs.com`; this.portalUrl = `https://portal-${continent}.ecouser.net`;
    this.country = country; this.deviceId = deviceId; this.fetch = fetchImpl; this.now = now; this.sleep = sleep; this.cred = null;
    this.meta = Object.freeze({ lang: 'EN', appCode: 'global_e', appVersion: '3.14.0', channel: 'google_play', deviceType: '1', country: c, deviceId });
  }
  async getJson(url, params) {
    const u = new URL(url); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    let r; try { r = await this.fetch(u, { signal: AbortSignal.timeout(30000) }); } catch { throw fail('Ecovacs-Server nicht erreichbar'); }
    if (!r.ok) throw fail('Ecovacs-Server antwortet nicht (' + r.status + ')');
    try { return JSON.parse(await r.text()); } catch { throw fail('Ecovacs-Antwort unlesbar'); }
  }
  data(json, what) {
    if (json?.code === '0000') return json.data;
    const code = String(json?.code || '');
    if (code === '1005' || code === '1010') throw fail('Ecovacs: E-Mail oder Passwort falsch', 401, { code, wrongPassword: true });
    if (code === '1012') throw fail('Ecovacs: Bestätigungscode falsch', 400, { code });
    if (code === '1013') throw fail('Ecovacs verlangt einen Bestätigungscode per E-Mail', 428, { code, needCode: true });
    throw fail('Ecovacs-Anmeldung fehlgeschlagen (' + what + ', Code ' + code + ')', 502, { code });
  }
  async priv(endpoint, params) {
    const now = this.now(), m = this.meta;
    const p = `/v1/private/${m.country}/${m.lang}/${m.deviceId}/${m.appCode}/${m.appVersion}/${m.channel}/${m.deviceType}/${endpoint}`;
    return this.data(await this.getJson(this.loginUrl + p, sign({ ...params, requestId: md5(String(now / 1000)), authTimespan: now, authTimeZone: 'GMT-8' }, m, KEYS.client)), endpoint);
  }
  async portal(path, body, query = {}) {
    const u = new URL(this.portalUrl + '/api/' + path); for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
    for (let i = 0; i < 3; i++) {
      let r; try { r = await this.fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', ...UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); } catch { throw fail('Ecovacs-Server nicht erreichbar'); }
      if (r.status === 502) { await this.sleep(10000); continue; } // Ecovacs antwortet gelegentlich mit 502 – kurz warten
      if (!r.ok) throw fail('Ecovacs-Server antwortet nicht (' + r.status + ')');
      try { return JSON.parse(await r.text()); } catch { throw fail('Ecovacs-Antwort unlesbar'); }
    }
    throw fail('Ecovacs-Server überlastet (502)');
  }
  async encrypt(account) {
    const list = await this.priv('common/getConfig', { keys: 'PUBLIC.KEY.CONFIG' });
    const entry = (Array.isArray(list) ? list : []).find(e => e?.key === 'PUBLIC.KEY.CONFIG');
    let key; try { key = crypto.createPublicKey({ key: Buffer.from(JSON.parse(entry.value).publicKey, 'base64'), format: 'der', type: 'spki' }); } catch { throw fail('Ecovacs-Schlüssel unlesbar'); }
    return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(account)).toString('base64');
  }
  async login(account, pwHash) { return this.complete(await this.priv('user/login', { account, password: pwHash })); }
  async requestCode(account) { await this.priv('user/sendEmailVerifyCode', { encryptEmail: await this.encrypt(account), verifyType: 'EMAIL_VERIFY_DEVICE', supportChar: 'N', isForce: 'N' }); }
  async verify(account, code) { return this.complete(await this.priv('user/verifyDevice', { encryptAccount: await this.encrypt(account), backUpEmail: '', verifyCode: String(code).trim(), model: 'Pixel 7', system: 'Android 14' })); }
  async complete(data) {
    if (!data || data.uid === undefined || !data.accessToken) throw fail('Ecovacs-Anmeldung: Antwort unvollständig');
    const uid = String(data.uid), accessToken = String(data.accessToken);
    const auth = this.data(await this.getJson(this.authUrl + '/v1/global/auth/getAuthCode', sign({ uid, accessToken, bizType: 'ECOVACS_IOT', deviceId: this.deviceId, authTimespan: this.now() }, { openId: 'global' }, KEYS.auth)), 'getAuthCode');
    for (let i = 0; i < 3; i++) {
      const r = await this.portal('users/user.do', { edition: 'ECOGLOBLE', userId: uid, token: String(auth?.authCode), realm: REALM, resource: this.deviceId, org: 'ECOWW', last: '', country: this.country, todo: 'loginByItToken' });
      if (r?.result === 'ok' && r.token) { this.cred = { userId: String(r.userId || uid), token: String(r.token), expiresAt: this.now() + Math.min(Number(r.last) || 604800000, 604800000) * 0.9 }; return true; }
      if (r?.error !== 'set token error.') throw fail('Ecovacs-Anmeldung abgelehnt');
    }
    throw fail('Ecovacs-Anmeldung fehlgeschlagen');
  }
  valid() { return !!this.cred && this.now() < this.cred.expiresAt; }
  authBody() { if (!this.valid()) throw fail('Ecovacs-Anmeldung abgelaufen', 401, { expired: true }); return { auth: { with: 'users', userid: this.cred.userId, realm: REALM, token: this.cred.token, resource: this.deviceId } }; }
  async devices() {
    const out = new Map();
    for (const [p, todo] of [['users/user.do', 'GetDeviceList'], ['appsvr/app.do', 'GetGlobalDeviceList']]) {
      const r = await this.portal(p, { userid: this.cred?.userId, todo, ...this.authBody() });
      if (r?.result === 'fail' && /token|auth/i.test(String(r.error))) { this.cred = null; throw fail('Ecovacs-Anmeldung abgelaufen', 401, { expired: true }); }
      for (const d of Array.isArray(r?.devices) ? r.devices : []) if (d && typeof d.did === 'string') out.set(d.did, { ...out.get(d.did), ...d });
    }
    return [...out.values()].map(d => ({ did: d.did, cls: String(d.class || ''), resource: String(d.resource || ''), company: String(d.company || ''), name: String(d.nick || d.deviceName || 'Saugroboter').slice(0, 64), model: String(d.deviceName || '').slice(0, 64), online: Number(d.status) === 1 }));
  }
  // Ein Befehl an den Roboter. Ergebnis: { ok, code, msg, data } – ok nur bei Rückmeldung „0“ vom Roboter.
  async command(dev, cmdName, args) {
    const payload = { header: { pri: '1', ts: this.now() / 1000, tzm: 480, ver: '0.0.50' } };
    if (args !== undefined) payload.body = { data: args };
    const r = await this.portal('iot/devmanager.do', { cmdName, payload, payloadType: 'j', td: 'q', toId: dev.did, toRes: dev.resource, toType: dev.cls, ...this.authBody() },
      { mid: dev.cls, did: dev.did, td: 'q', u: this.cred.userId, cv: '1.67.3', t: 'a', av: '1.3.1' });
    if (r?.ret === 'ok') { const b = r.resp?.body || {}; const code = Number(b.code); return { ok: code === 0, code, msg: String(b.msg || ''), data: b.data }; }
    const errno = Number(r?.errno);
    if (errno === 3 || /auth|token/i.test(String(r?.error || ''))) { this.cred = null; throw fail('Ecovacs-Anmeldung abgelaufen', 401, { expired: true }); }
    // 500 = Roboter hat nicht geantwortet (Befehl unbekannt oder Roboter schläft), 4200 = Roboter nicht erreichbar
    return { ok: false, code: errno || -1, msg: errno === 4200 ? 'Roboter nicht erreichbar' : errno === 500 ? 'keine Antwort vom Roboter' : String(r?.error || 'Fehler'), data: null, noAnswer: errno === 500 || errno === 4200 };
  }
}
module.exports = { EcovacsCloud, md5, sign, fail };
