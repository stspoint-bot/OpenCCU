'use strict';
const crypto = require('node:crypto');
const {SmartlifeCloud, validateCredentials} = require('./smartlife-cloud');

// Cloud replies are cached device readings, not evidence of a new measurement.
// Resolve codes through the imported schema; never guess a LAN datapoint ID.
function readingsFromStatus(profile, status) {
  if (profile?.kind !== 'sensor' || !Array.isArray(status) || status.length > 255) {
    throw Error('Ungültige Sensor-Statusantwort');
  }
  const values = Object.create(null);
  for (const [key, allowed] of Object.entries({
    temperature: ['va_temperature', 'temp_current'],
    humidity: ['va_humidity', 'humidity_value'],
  })) {
    const field = profile.readings?.[key];
    if (!field || !allowed.includes(field.code)) continue;
    const matches = status.filter(dp => dp?.code === field.code);
    const raw = matches.length === 1 ? matches[0].value : undefined;
    const scale = field.scale ?? 0;
    if (typeof raw !== 'number' || !Number.isFinite(raw) ||
        !Number.isInteger(scale) || scale < 0 || scale > 3 ||
        !Number.isFinite(field.min) || !Number.isFinite(field.max) ||
        raw < field.min || raw > field.max) continue;
    const value = raw / 10 ** scale;
    if (key === 'temperature' ? value >= -273.15 && value <= 327.67 : value >= 0 && value <= 100) {
      values[key] = value;
    }
  }
  return values;
}

class SensorCloud {
  constructor({credentials, entries, apply, notice = () => {},
    cloudFactory = options => new SmartlifeCloud(options), now = Date.now} = {}) {
    this.credentials = credentials;
    this.entries = entries;
    this.apply = apply;
    this.notice = notice;
    this.cloudFactory = cloudFactory;
    this.now = now;
    this.stopped = false;
    this.running = null;
    this.session = null;
    this.abort = new AbortController();
  }

  start() {
    if (this.timer || this.stopped) return;
    this.poll().catch(() => {});
    this.timer = setInterval(() => this.poll().catch(() => {}), 300000);
    this.timer.unref();
  }

  poll() {
    if (this.stopped) return Promise.resolve();
    // Share one round: interval/manual calls cannot compete for the token.
    if (this.running) return this.running;
    this.running = this.round().finally(() => { this.running = null; });
    return this.running;
  }

  async round() {
    const entries = this.entries().filter(e => e.item?.profile?.kind === 'sensor').slice(0, 128);
    if (!entries.length) return;
    const cloud = this.cloudFactory({signal: this.abort.signal});
    try {
      const stored = this.credentials();
      validateCredentials(stored);
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(stored)).digest('hex');
      cloud.credentials = {...stored};
      cloud.deadline = this.now() + 120000;
      if (!this.session || this.session.fingerprint !== fingerprint || this.session.expires <= this.now()) {
        this.session = null;
        const token = await cloud.request('/v1.0/token?grant_type=1');
        if (this.stopped) return;
        if (typeof token?.access_token !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(token.access_token) ||
            !Number.isInteger(token.expire_time) || token.expire_time < 60 || token.expire_time > 86400) {
          throw Error('Ungültige Tuya-Sitzung');
        }
        this.session = {fingerprint, token: token.access_token, expires: this.now() + (token.expire_time - 30) * 1000};
      }
      cloud.token = this.session.token;
      let next = 0;
      const worker = async () => {
        while (!this.stopped && next < entries.length) {
          const entry = entries[next++];
          try {
            const id = entry.item.id;
            if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw Error('Ungültige Sensor-ID');
            const detail = await cloud.request('/v1.0/devices/' + id);
            if (!detail || typeof detail.online !== 'boolean') throw Error('Ungültiger Sensor-Onlinestatus');
            const status = detail.online ? await cloud.request('/v1.0/devices/' + id + '/status') : [];
            const values = readingsFromStatus(entry.item.profile, status);
            if (!this.stopped) await this.apply(entry, {
              online: detail.online && Number.isFinite(values.temperature),
              values, queriedAt: this.now(),
            });
          } catch {
            if (!this.stopped) await this.apply(entry, {online: false, failed: true, queriedAt: this.now(), values: {}});
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch {
      this.session = null;
      if (!this.stopped) {
        for (const entry of entries) await this.apply(entry, {online: false, failed: true, queriedAt: this.now(), values: {}});
        this.notice('Smart-Life-Sensorabfrage fehlgeschlagen; gespeicherte Zugänge, Projektberechtigungen und Verbindung prüfen');
      }
    } finally {
      cloud.token = null;
      if (cloud.credentials) cloud.credentials.accessSecret = '';
      cloud.credentials = null;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.session = null;
    this.abort.abort();
  }
}

module.exports = {SensorCloud, readingsFromStatus};
