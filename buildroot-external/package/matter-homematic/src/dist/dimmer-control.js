'use strict';
async function capability(web,address){
 const c=web.deps.getConnector(),ch=c.getChannels().get(address),mapped=web.deps.getDevices().get(address);
 if(!ch||mapped?.matterDeviceType!=='DimmableLight'||!['DIMMER','DIMMER_VIRTUAL_RECEIVER'].includes(ch.type)||!['BidCos-RF','HmIP-RF','CUxD'].includes(ch.interface))return {allowed:false};
 web.dimmerCaps||=new Map();const old=web.dimmerCaps.get(address);if(old?.channel===ch&&old.until>Date.now())return old.promise;
 const entry={channel:ch,until:Infinity};
 entry.promise=(async()=>{try{const d=(await c.rpcCall(ch.interface,'getParamsetDescription',[address,'VALUES']))?.LEVEL;return {allowed:d?.TYPE==='FLOAT'&&(d.OPERATIONS&3)===3&&d.MIN===0&&d.MAX===1};}catch{return {allowed:false};}})().then(result=>{entry.until=Date.now()+(result.allowed?300000:5000);return result;});
 web.dimmerCaps.set(address,entry);return entry.promise;
}
async function handle(web,req,res,u){
 if(u.pathname!=='/api/'||u.searchParams.get('method')!=='setDimmerLevel')return false;
 const security=web.security;let address;
 try{
  if(req.method!=='POST')throw Object.assign(Error('POST erforderlich'),{status:405});
  const p=await require('./web-security').body(req);
  if(Object.keys(p).some(k=>!['address','percent'].includes(k))||typeof p.address!=='string'||!/^\w[\w-]{0,63}:\d{1,3}$/.test(p.address)||typeof p.percent!=='number'||!Number.isFinite(p.percent)||p.percent<0||p.percent>100)throw Object.assign(Error('Helligkeit muss zwischen 0 und 100 Prozent liegen'),{status:400});
  if(!web.deps.isCcuConnected())throw Object.assign(Error('CCU nicht verbunden'),{status:503});
  if(!(await capability(web,p.address)).allowed)throw Object.assign(Error('Kein bestätigter Dimmer mit schreibbarem LEVEL'),{status:403});
  if(security.pending.has(p.address)||security.pending.size>=4)throw Object.assign(Error('Auftrag läuft bereits; bitte warten'),{status:429});
  address=p.address;security.pending.add(address);const connector=web.deps.getConnector();
  await connector.setValue(address,'LEVEL',p.percent/100);
  let actual;try{actual=await connector.getValue(security.stateAddress(address),'LEVEL');}catch{}
  const valid=typeof actual==='number'&&Number.isFinite(actual)&&actual>=0&&actual<=1;
  const confirmed=valid&&Math.abs(actual-p.percent/100)<=0.005;
  if(valid)connector.handleEvent('matter-homematic-'+connector.getChannels().get(security.stateAddress(address))?.interface,security.stateAddress(address),'LEVEL',actual);
  web.sendJson(res,confirmed?200:202,{success:true,confirmed,percent:valid?Math.round(actual*100):null,message:confirmed?'Helligkeit von CCU bestätigt':'Befehl übergeben; Rückmeldung steht noch aus'});
 }catch(e){web.sendJson(res,e.status||502,{error:e.status?e.message:'Dimmerbefehl nicht bestätigt; Zustand vor erneutem Schalten prüfen'});}
 finally{if(address)security.pending.delete(address);}
 return true;
}
module.exports={capability,handle};
