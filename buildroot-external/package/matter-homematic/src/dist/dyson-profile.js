'use strict';
const crypto = require('node:crypto');
const TYPES = new Set(['469','475','455','520','438','438E','438K','438M','527','527E','527K','527M','358','358E','358K','358M','664']);
const MODELS = {TP01:'475',TP02:'475',DP01:'469',DP02:'469',TP04:'438',TP07:'438',TP09:'438',TP11:'438',PC1:'438',HP02:'455',HP04:'527',HP07:'527',HP09:'527',PH01:'358',PH02:'358',PH03:'358',PH04:'358',BP02:'664',BP03:'664',BP04:'664'};
const serialValid = value => typeof value==='string' && /^[A-Z0-9]{3}-[A-Z]{2}-[A-Z0-9]{8,24}$/.test(value);
const fail = message => Object.assign(Error(message), {status:400});
function deviceType(raw) {
  if (!raw || typeof raw!=='object') return null;
  let type = typeof raw.type==='string' && TYPES.has(raw.type) ? raw.type : raw.ProductType;
  type = MODELS[type] || type;
  if (!TYPES.has(type)) return null;
  if (['438','527','358'].includes(type)) {
    const variant = typeof raw.variant==='string' ? raw.variant.toUpperCase() : typeof raw.Version==='string' && raw.Version.startsWith(type) ? raw.Version[3] : '';
    if (['E','K','M'].includes(variant) && TYPES.has(type+variant)) type+=variant;
  }
  return type;
}
function wifiCredentials(ssid, password) {
  const match = typeof ssid==='string' && /^DYSON-([A-Z0-9]{3}-[A-Z]{2}-[A-Z0-9]{8,24})-(\d{3}[A-Z]?)$/.exec(ssid);
  const type = match?.[2]==='455A' ? '455' : match?.[2];
  if (!match || !TYPES.has(type) || typeof password!=='string' || !password || password.length>128) throw fail('Dyson-WLAN-Aufkleber prüfen; nicht die Zugangsdaten des Heimnetzes verwenden.');
  return {id:match[1],type,credential:crypto.createHash('sha512').update(password).digest('base64')};
}
function localCredential(encoded) {
  if (typeof encoded!=='string' || encoded.length>4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw fail('Ungültige lokale Dyson-Zugangsdaten');
  const bytes=Buffer.from(encoded,'base64');
  if (!bytes.length || bytes.length%16) throw fail('Ungültige lokale Dyson-Zugangsdaten');
  const key=Buffer.from(Array.from({length:32},(_,i)=>i+1));
  const decipher=crypto.createDecipheriv('aes-256-cbc',key,Buffer.alloc(16));
  let credential;
  try {credential=JSON.parse(Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8')).apPasswordHash;} catch {throw fail('Dyson-Geräteschlüssel konnte nicht gelesen werden');}
  if (typeof credential!=='string' || credential.length<16 || credential.length>256 || /[\x00-\x1f]/.test(credential)) throw fail('Ungültiger Dyson-Geräteschlüssel');
  return credential;
}
const field=(raw,key)=>Array.isArray(raw?.[key]) ? raw[key][1] : raw?.[key];
function state(raw,type,previous={}) {
  const result={...previous};
  const link=['469','475','455'].includes(type), power=field(raw,link?'fmod':'fpwr');
  if (link ? ['FAN','AUTO','OFF'].includes(power) : ['ON','OFF'].includes(power)) result.on=link?power!=='OFF':power==='ON';
  const speed=field(raw,'fnsp');
  if (typeof speed==='string' && /^00(0[1-9]|10)$/.test(speed)) result.speed=Number(speed);
  else if (speed==='AUTO') result.speed=null;
  const auto=field(raw,link?'fmod':'auto');
  if (link && ['AUTO','FAN','OFF'].includes(auto)) result.auto=auto==='AUTO';
  else if (!link && ['ON','OFF'].includes(auto)) result.auto=auto==='ON';
  const oscillation=field(raw,'oson');
  if (['ON','OFF','OION','OIOF'].includes(oscillation)) result.oscillation=['ON','OION'].includes(oscillation);
  const night=field(raw,'nmod');if(['ON','OFF'].includes(night))result.night=night==='ON';
  return result;
}
function command(input,type,raw={}) {
  if (!TYPES.has(type) || !input || Array.isArray(input) || typeof input!=='object' || !Object.keys(input).length || Object.keys(input).some(k=>!['on','speed','auto','oscillation','night'].includes(k))) throw fail('Ungültiger Dyson-Auftrag');
  for(const key of ['on','auto','oscillation','night'])if(Object.hasOwn(input,key)&&typeof input[key]!=='boolean')throw fail('Ungültige Dyson-Auswahl');
  if(Object.hasOwn(input,'speed')&&(!Number.isInteger(input.speed)||input.speed<1||input.speed>10))throw fail('Dyson-Stufe muss 1–10 sein');
  if(Object.hasOwn(input,'speed')&&input.auto===true)throw fail('Manuelle Stufe und Automatik getrennt einstellen');
  if(input.on===false&&(Object.hasOwn(input,'speed')||Object.hasOwn(input,'auto')))throw fail('Ausschalten und Geschwindigkeit/Automatik getrennt einstellen');
  const link=['469','475','455'].includes(type),out={};
  if(Object.hasOwn(input,'on'))out[link?'fmod':'fpwr']=input.on?(link?'FAN':'ON'):'OFF';
  if(Object.hasOwn(input,'auto'))out[link?'fmod':'auto']=link?(input.auto?'AUTO':'FAN'):(input.auto?'ON':'OFF');
  if(Object.hasOwn(input,'speed')){out.fnsp=String(input.speed).padStart(4,'0');out[link?'fmod':'fpwr']=link?'FAN':'ON';if(!link)out.auto='OFF';}
  if(Object.hasOwn(input,'oscillation')){
    const old=field(raw,'oson');
    if(!['ON','OFF','OION','OIOF'].includes(old))throw fail('Oszillation wurde von diesem Gerät noch nicht bestätigt');
    out.oson=['OION','OIOF'].includes(old)?(input.oscillation?'OION':'OIOF'):(input.oscillation?'ON':'OFF');
  }
  if(Object.hasOwn(input,'night'))out.nmod=input.night?'ON':'OFF';
  // Fan control must never resume a previously selected heating mode.
  if((type==='455'||type.startsWith('527'))&&(out.fmod==='FAN'||out.fmod==='AUTO'||out.fpwr==='ON')){
    if(!['OFF','HEAT'].includes(field(raw,'hmod')))throw fail('Ventilatorbetrieb dieses Hot+Cool-Geräts wurde noch nicht bestätigt');
    out.hmod='OFF';
  }
  // Older Link firmware uses a complete configuration envelope. Preserve only
  // confirmed, validated settings; never reset filter life or change the timer.
  if(link){
    const unchanged={};
    for(const [key,valid] of [['fmod',v=>['FAN','AUTO','OFF'].includes(v)],['fnsp',v=>v==='AUTO'||/^00(0[1-9]|10)$/.test(v)],['oson',v=>['ON','OFF'].includes(v)],['nmod',v=>['ON','OFF'].includes(v)],['rhtm',v=>['ON','OFF'].includes(v)],['qtar',v=>/^000[1-4]$/.test(v)]]){
      const value=field(raw,key);if(typeof value==='string'&&valid(value))unchanged[key]=value;
    }
    return {...unchanged,...out,sltm:'STET',rstf:'STET'};
  }
  return out;
}
function validateDevices(devices,keys){
 if(!Array.isArray(devices)||devices.length>32||!keys||typeof keys!=='object'||Array.isArray(keys))throw fail('Ungültige Dyson-Geräteliste');
 const ids=new Set();
 for(const d of devices){
  if(!d||typeof d!=='object'||Array.isArray(d)||!serialValid(d.id)||ids.has(d.id)||!TYPES.has(d.type)||typeof d.name!=='string'||!d.name.trim()||d.name.length>64||/[\x00-\x1f]/.test(d.name)||typeof d.exposed!=='boolean'||(d.onlineCheck!==undefined&&typeof d.onlineCheck!=='boolean')||typeof keys[d.id]!=='string'||keys[d.id].length<16||keys[d.id].length>256||/[\x00-\x1f]/.test(keys[d.id]))throw fail('Ungültige Dyson-Gerätedaten');
  ids.add(d.id);
 }
 return devices;
}
module.exports={validateDevices,TYPES,MODELS,serialValid,deviceType,wifiCredentials,localCredential,state,command,field};
