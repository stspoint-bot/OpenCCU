'use strict';
const {execFile}=require('node:child_process'),{validIp}=require('./smartplus');
const deviceId=address=>typeof address==='string'?/^((?:CUX)[A-Za-z0-9_-]{1,60}):\d{1,3}$/i.exec(address)?.[1]:null;
function ping(ip){return new Promise(resolve=>{if(!ip||!validIp(ip))return resolve(false);const args=process.platform==='win32'?['-n','1','-w','2000',ip]:['-c','1','-W','2',ip];execFile('ping',args,{timeout:4000,maxBuffer:8192,windowsHide:true},error=>resolve(!error));});}
function known(web,id){return [...(web.deps.getChannels?.()?.keys()||[]),...(web.deps.getDevices?.()?.keys()||[])].some(address=>deviceId(address)===id);}
function settings(web){return web.security.configSnapshot.read().cuxChecks||{};}
function publicSettings(web,monitor){return Object.fromEntries(Object.entries(settings(web)).map(([id,c])=>[id,{enabled:c.enabled===true,...(monitor.cuxIps?.get(id)?.value||{})}]));}
function save(web,monitor,p){
 const id=deviceId(p?.address);
 if(!id||!known(web,id)||Object.keys(p).some(k=>!['address','enabled'].includes(k))||typeof p.enabled!=='boolean')throw Object.assign(Error('CUxD-Gerät und Prüfauswahl prüfen'),{status:400});
 web.writeConfigPatch(c=>{c.cuxChecks={...(c.cuxChecks||{}),[id]:{enabled:p.enabled}};});monitor.generation=(monitor.generation||0)+1;monitor.incidents.delete('cux:'+id);monitor.cuxIps?.delete(id);return publicSettings(web,monitor);
}
function findIp(parameters){
 const collect=values=>new Set(values.flatMap(value=>typeof value==='string'?(value.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)||[]).filter(ip=>validIp(ip)):[]));
 const ips=collect(Object.entries(parameters||{}).filter(([key])=>/^PARAM9$/i.test(key)).map(([,value])=>value));
 return ips.size===1?{ip:[...ips][0]}:ips.size>1?{reason:'Mehrere IP-Adressen in PARAM9; keine eindeutige Zuordnung'}:{reason:'Keine lokale IPv4-Adresse in PARAM9'};
}
async function resolveIp(web,monitor,id){
 monitor.cuxIps||=new Map();const cached=monitor.cuxIps.get(id);if(cached&&monitor.now()-cached.at<60000)return cached.value;
 const channels=[...(web.deps.getChannels?.()?.keys()||[]),...(web.deps.getDevices?.()?.keys()||[])].filter(address=>deviceId(address)===id);
 const first=[...new Set(channels)].sort((a,b)=>Number(a.split(':')[1])-Number(b.split(':')[1])).find(a=>Number(a.split(':')[1])>0)||channels[0];
 let value={reason:'PARAM9 konnte nicht von der CCU gelesen werden'},read=false;
 for(const address of [id,first].filter(Boolean)){try{const result=findIp(await web.deps.getConnector().rpcCall('CUxD','getParamset',[address,'MASTER']));read=true;value=result;if(result.ip||result.reason.startsWith('Mehrere'))break;}catch{}}
 if(!read)value={reason:'PARAM9 konnte nicht von der CCU gelesen werden'};
 monitor.cuxIps.set(id,{at:monitor.now(),value});return value;
}
async function collect(web,monitor,probe=ping){
 const checks=Object.entries(settings(web)).filter(([id,c])=>known(web,id)&&c.enabled===true),rows=[];
 if(!checks.length)return rows;
 const start=monitor.cuxCursor||0,ordered=checks.slice(start).concat(checks.slice(0,start)),deadline=Date.now()+20000;
 let processed=0;
 for(const [id] of ordered){
  if(monitor.stopped||Date.now()>=deadline)break;
  const device=[...(web.deps.getDevices?.()?.values()||[])].find(d=>deviceId(d.address)===id);
  let timer;
  const expired={reason:'Prüfzeit überschritten; wird erneut geprüft'};
  const resolved=await Promise.race([resolveIp(web,monitor,id),new Promise(resolve=>{timer=setTimeout(()=>resolve(expired),Math.max(1,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
  if(monitor.stopped)break;
  let status='unknown';if(resolved.ip){let probeTimer;status=await Promise.race([probe(resolved.ip).then(ok=>ok?'online':'offline'),new Promise(resolve=>{probeTimer=setTimeout(()=>resolve('unknown'),4000);})]).finally(()=>clearTimeout(probeTimer));}
  if(settings(web)[id]?.enabled===true)rows.push({id:'cux:'+id,name:'CUxD · '+(device?.name||id),status,detail:resolved.ip?'IP '+resolved.ip+' · Ping · aus CCU-Parametern':resolved.reason});
  processed++;
 }
 monitor.cuxCursor=(start+processed)%checks.length;
 const seen=new Set(rows.map(row=>row.id));
 for(const [id] of checks){if(seen.has('cux:'+id)||settings(web)[id]?.enabled!==true)continue;const previous=monitor.rows?.find(row=>row.id==='cux:'+id);rows.push(previous?{...previous,status:'unknown',detail:previous.detail+' · wartet auf neue Prüfung'}:{id:'cux:'+id,name:'CUxD · '+id,status:'unknown',detail:'Wartet auf PARAM9-Prüfung'});}
 return rows;
}

module.exports={deviceId,ping,save,collect,publicSettings,findIp,resolveIp,settings};
