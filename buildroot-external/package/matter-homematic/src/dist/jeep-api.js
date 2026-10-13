'use strict';
// Integration adapter: call only AFTER existing WebSecurity auth/Origin/CSRF.
const {JeepService}=require('./jeep-service');
async function handle(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;
 if(!['jeepConnectionInfo','getJeepOverview','jeepSession','getJeepStatus','getJeepData','loginJeep','logoutJeep','refreshJeep','loadJeepData','saveJeepDisplay'].includes(method))return false;
 try{
  if(req.method!==(['jeepConnectionInfo','getJeepOverview','jeepSession','getJeepStatus','getJeepData'].includes(method)?'GET':'POST'))throw Object.assign(Error('Falsche Anfragemethode'),{status:405});
  const context=web.security.context(req),loginAllowed=context.secure||['127.0.0.1','::1'].includes(context.ip),protectedUrl=web.security.configSnapshot.read().web?.publicOrigin;
  if(method==='jeepConnectionInfo'){const session=web.security.session(req)?.session;web.sendJson(res,200,{admin:!!session&&!session.localBypass,loginAllowed,protectedUrl:typeof protectedUrl==='string'&&protectedUrl.startsWith('https://')?protectedUrl+'/jeep.html':null});return true;}
  if(method==='getJeepOverview'){
   // Thomas explicitly authorized only these three readings on the ordinary
   // LAN page. Never return the general vehicle object, VIN or source data.
   const state=web.jeepService?.public()||{connected:false,vehicles:[]};
   const numeric=(v,max=5000)=>{if(typeof v!=='number'&&typeof v!=='string')return null;if(typeof v==='string'&&!/^\d+(\.\d+)?$/.test(v))return null;const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max?n:null;};
   const unit=v=>['km','mi','KM','MI'].includes(v)?v.toLowerCase():null;
   const vehicles=state.vehicles.map((v,i)=>{const fuel=web.jeepService.rows[i]?.sources?.status?.data?.vehicleInfo?.fuel?.distanceToEmpty||{};return {name:'Jeep Fahrzeug '+(i+1),batteryPercent:numeric(v.batteryPercent,100),range:numeric(v.range),rangeUnit:unit(v.rangeUnit),fuelRange:numeric(fuel.value),fuelRangeUnit:unit(fuel.unit),vehicleUpdatedAt:v.vehicleUpdatedAt,stale:v.stale===true};});
   web.sendJson(res,200,{connected:state.connected===true,readOnly:true,vehicles,lastFetchedAt:state.lastFetchedAt||null});return true;
  }
  require('./tailscale-backup').requireAdmin(web,req);
  const connection=require('./jeep-connection').ensure(web);let data;
  if(method==='jeepSession')data={csrf:web.security.session(req).session.csrf,simulation:false,localConnectionTest:false,loginAllowed,protectedUrl:typeof protectedUrl==='string'&&protectedUrl.startsWith('https://')?protectedUrl+'/jeep.html':null};
  else if(method==='getJeepStatus')data=web.jeepService.public();
  else if(method==='getJeepData'){const vin=u.searchParams.get('vin');if(u.searchParams.getAll('vin').length!==1)throw Object.assign(Error('Ein Fahrzeug auswählen'),{status:400});data={...web.jeepService.detail(vin),selected:web.security.configSnapshot.read().jeepDisplay?.[vin]??null};}
  else{
   const p=await require('./web-security').body(req);
   if(method==='loadJeepData'||method==='saveJeepDisplay'){
    if(typeof p.vin!=='string'||!/^[A-HJ-NPR-Z0-9]{17}$/.test(p.vin))throw Object.assign(Error('Ungültiges Fahrzeug'),{status:400});
    const detail=web.jeepService.detail(p.vin);
    if(method==='loadJeepData'){if(Object.keys(p).some(k=>k!=='vin'))throw Object.assign(Error('Ungültige Abfrage'),{status:400});data={...await web.jeepService.loadDetails(p.vin),selected:web.security.configSnapshot.read().jeepDisplay?.[p.vin]??null};}
    else{
     if(Object.keys(p).some(k=>!['vin','fields'].includes(k))||!Array.isArray(p.fields)||p.fields.length>64||new Set(p.fields).size!==p.fields.length||p.fields.some(id=>typeof id!=='string'||!detail.fields.some(f=>f.id===id)))throw Object.assign(Error('Bis zu 64 verfügbare Werte auswählen'),{status:400});
     web.writeConfigPatch(c=>{c.jeepDisplay={...c.jeepDisplay,[p.vin]:p.fields};});data={saved:true,selected:p.fields};
    }
   }else if(method==='loginJeep'){
    if(!loginAllowed)throw Object.assign(Error('Für das Jeep-Passwort ist ein HTTPS-Zugang erforderlich. Der lokale PC-Lesetest bleibt verfügbar.'),{status:403});
    if(Object.keys(p).some(k=>!['email','password'].includes(k)))throw Object.assign(Error('Ungültige Anmeldung'),{status:400});
    const now=Date.now();web.jeepLoginAttempts||={since:now,count:0};if(now-web.jeepLoginAttempts.since>900000)web.jeepLoginAttempts={since:now,count:0};
    if(web.jeepLoginAttempts.count>=8)throw Object.assign(Error('Zu viele Jeep-Anmeldungen. Bitte 15 Minuten warten.'),{status:429});
    web.jeepLoginAttempts.count++;
    try{await web.jeepService.login(p.email,p.password);connection.save(p.email,p.password);data=web.jeepService.public({settled:true});}finally{p.password='';}
   }else{
    if(Object.keys(p).length)throw Object.assign(Error('Keine zusätzlichen Felder erlaubt'),{status:400});
    data=method==='logoutJeep'?connection.logout():await web.jeepService.refresh();
   }
  }
  web.sendJson(res,200,data);
 }catch(e){web.sendJson(res,e.status||502,{error:e.status?e.message:'Jeep-Daten konnten nicht abgerufen werden'});}
 return true;
}
module.exports={handle};
