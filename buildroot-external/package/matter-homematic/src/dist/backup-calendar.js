'use strict';
const ZONES=new Set(['Europe/Berlin','UTC']);
const DAY=86400000;
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['enabled','frequency','time','weekday','intervalHours','timeZone','destination','selected','includeCcu','rotateLocal','localCopies'].includes(k)))throw Error('Ungültiger Backup-Zeitplan');
 // Einzelne, verständliche Meldungen (vorher eine Sammelmeldung). Bereiche: so viele, wie es Sicherungsbereiche gibt.
 const labels=require('./backup').labels,areas=Object.keys(labels).length;
 if(typeof value.enabled!=='boolean'||!['hourly','daily','weekly'].includes(value.frequency)||!Number.isInteger(value.weekday)||value.weekday<0||value.weekday>6||!Number.isInteger(value.intervalHours)||value.intervalHours<1||value.intervalHours>168)throw Error('Häufigkeit prüfen (stündlich: 1–168 Stunden Abstand)');
 if(typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)||!ZONES.has(value.timeZone))throw Error('Uhrzeit (z. B. 03:00) und Zeitzone prüfen');
 if(!['google','download','icloud-pc','wd'].includes(value.destination))throw Error('Speicherziel prüfen');
 if(typeof value.includeCcu!=='boolean'||!Array.isArray(value.selected)||value.selected.length>areas||new Set(value.selected).size!==value.selected.length||value.selected.some(k=>typeof k!=='string'))throw Error('Sicherungsumfang prüfen');
 if(!value.includeCcu&&!value.selected.length)throw Error('Bitte mindestens einen Bereich oder die vollständige CCU-Sicherung auswählen');
 if(value.selected.some(k=>!Object.hasOwn(labels,k)))throw Error('Unbekannter Sicherungsbereich');
 const rotateLocal=value.rotateLocal??false,localCopies=value.localCopies??2;
 if(typeof rotateLocal!=='boolean'||!Number.isInteger(localCopies)||localCopies<1||localCopies>10||rotateLocal&&value.destination!=='google')throw Error('Lokale Aufbewahrung prüfen; automatische Freigabe nur mit Google Drive');
 return {...value,rotateLocal,localCopies,selected:[...value.selected]};
}
const formats=new Map();
function local(now,timeZone){
 if(!Number.isFinite(now)||now<Date.UTC(2024,0,1)||!ZONES.has(timeZone))throw Error('CCU-Uhrzeit oder Zeitzone ungültig');
 let formatter=formats.get(timeZone);if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone,calendar:'gregory',numberingSystem:'latn',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formats.set(timeZone,formatter);}
 const fields=Object.fromEntries(formatter.formatToParts(new Date(now)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 return {day:Date.UTC(fields.year,fields.month-1,fields.day),minute:fields.hour*60+fields.minute};
}
function slot(config,now,anchor){
 if(config.frequency==='hourly'){
  if(!Number.isFinite(now)||!Number.isFinite(anchor)||now<Date.UTC(2024,0,1))throw Error('CCU-Uhrzeit ungültig');
  const period=config.intervalHours*3600000,index=Math.max(0,Math.floor((now-anchor)/period));
  return {key:'h:'+index,nextText:new Date(anchor+(index+1)*period).toISOString()};
 }
 const current=local(now,config.timeZone),parts=config.time.split(':').map(Number),minute=parts[0]*60+parts[1];
 let day=current.day;
 if(config.frequency==='daily'){if(current.minute<minute)day-=DAY;}
 else{const difference=(new Date(day).getUTCDay()-config.weekday+7)%7;day-=difference*DAY;if(difference===0&&current.minute<minute)day-=7*DAY;}
 const next=day+(config.frequency==='weekly'?7:1)*DAY;
 return {key:(config.frequency==='weekly'?'w:':'d:')+new Date(day).toISOString().slice(0,10),nextText:new Date(next).toISOString().slice(0,10)+' '+config.time+' ('+config.timeZone+')'};
}
module.exports={validate,local,slot};
