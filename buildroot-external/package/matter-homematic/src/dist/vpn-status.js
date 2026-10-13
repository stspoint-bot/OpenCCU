'use strict';
const fs=require('node:fs'),{execFile}=require('node:child_process');
function status(){
 const file='/usr/local/addons/tspoint-tailscale/bin/tailscale';
 if(!fs.existsSync(file))return Promise.resolve({id:'tailscale',name:'Matter-Tailscale',status:'disabled',detail:'Add-on nicht installiert'});
 return new Promise(resolve=>execFile(file,['--socket=/var/run/tspoint-tailscale/tailscaled.sock','status','--json'],{timeout:4000,maxBuffer:1048576,encoding:'utf8'},(error,output)=>{
  let data;try{if(!error)data=JSON.parse(output);}catch{}
  const state=data?.BackendState;
  resolve({id:'tailscale',name:'Matter-Tailscale',status:state==='Running'?'online':['NeedsLogin','Stopped'].includes(state)?'disabled':'unknown',detail:state==='Running'?'Angemeldet · VPN verbunden':state==='Stopped'?'Angemeldet · VPN getrennt':state==='NeedsLogin'?'Nicht angemeldet':'VPN-Status nicht verfügbar',notifyEnabled:false});
 }));
}
module.exports={status};
