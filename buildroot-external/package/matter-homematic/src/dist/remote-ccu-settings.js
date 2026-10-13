'use strict';
// These are editable bookmarks/setup preferences, not routing or ACL changes.
// No server-side connections are made to user-supplied addresses.
function ipv4(value){
 if(typeof value!=='string'||!/^\d{1,3}(\.\d{1,3}){3}$/.test(value))return false;
 const octets=value.split('.');
 return octets.every(n=>String(Number(n))===n&&Number(n)<=255);
}
function privateOrTailnet(value){
 if(!ipv4(value))return false;
 const [a,b]=value.split('.').map(Number);
 // Host bits depend on the real netmask; .0 is valid for some hosts/tailnet IPs.
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127);
}
function validate(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['name','ip','vpnIp','scope'].includes(k)))throw Object.assign(Error('Ungültige Angaben zur zweiten CCU'),{status:400});
 const {name,ip,vpnIp='',scope}=value;
 if(typeof name!=='string'||!name.trim()||name.trim().length>64||/[\x00-\x1f\x7f]/.test(name)||!privateOrTailnet(ip)||!(vpnIp===''||privateOrTailnet(vpnIp)&&vpnIp.startsWith('100.'))||!['ccu','lan'].includes(scope))throw Object.assign(Error('Bitte Namen, gültige lokale CCU-IP und optional eine Tailscale-IP angeben'),{status:400});
 return {name:name.trim(),ip,vpnIp,scope};
}
async function handle(web,req,res,url){
 const method=url.pathname==='/api/'?url.searchParams.get('method'):null;
 if(!['getRemoteCcu','saveRemoteCcu'].includes(method))return false;
 if(req.method!==(method==='getRemoteCcu'?'GET':'POST')){web.sendJson(res,405,{error:'HTTP-Methode nicht erlaubt'});return true;}
 try{
  if(method==='saveRemoteCcu'){
   const value=validate(await require('./web-security').body(req));
   web.writeConfigPatch(config=>{config.ui={...config.ui,remoteCcu:value};});
  }
  const stored=web.security.configSnapshot.read().ui?.remoteCcu;
  web.sendJson(res,200,{settings:stored?validate(stored):{name:'Zweite CCU3',ip:'192.168.60.53',vpnIp:'',scope:'ccu'},routingChanged:false});
 }catch(error){web.sendJson(res,error.status||500,{error:error.status?error.message:'Angaben konnten nicht gespeichert werden'});}
 return true;
}
module.exports={ipv4,privateOrTailnet,validate,handle};
