'use strict';
// Configure transport only. Authentication always uses live CCU credentials.
const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { atomicJson } = require('./web-security');
try {
  const args = process.argv.slice(2); const arg = name => { const index=args.indexOf(name);return index<0?undefined:args[index+1]; };
  const file = arg('--config') || process.env.CONFIG_PATH || path.join(process.env.MATTER_HOMEMATIC_DATA_DIR || '/usr/local/etc/config/addons/matter-homematic','config.json');
  const origin = arg('--origin'); const host = arg('--bind') || '127.0.0.1'; const proxy = arg('--proxy');
  if (!origin || !proxy) throw Error('Usage: node web-config.js --origin https://tspoint.tplinkdns.com --proxy 127.0.0.1 [--bind 127.0.0.1] [--config path]');
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !net.isIP(host)) throw Error('HTTPS-Origin oder Bind-Adresse ungültig');
  const proxies = proxy.split(','); if (!proxies.length || proxies.some(ip=>!net.isIP(ip))) throw Error('Exakte Proxy-IP-Adressen erforderlich');
  const config = JSON.parse(fs.readFileSync(file,'utf8'));
  config.web = { ...config.web, enabled:true, host, port:config.web?.port || 8080, publicOrigin:url.origin, trustedProxies:proxies };
  atomicJson(file,config);
  console.log('Webzugriff gespeichert: '+url.origin+'; Dienst neu starten. Keine Zugangsdaten gespeichert.');
} catch(error) { console.error(error.message); process.exitCode=1; }
