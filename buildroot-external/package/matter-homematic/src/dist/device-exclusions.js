'use strict';
const fs=require('node:fs');
const excluded=d=>d?.profile?.kind==='cooler';
function migrate(file){if(!fs.existsSync(file))return;const c=JSON.parse(fs.readFileSync(file,'utf8'));let changed=false;for(const p of ['smartlife','smartplus'])if(c[p]?.devices?.some(excluded)){c[p].devices=c[p].devices.filter(d=>!excluded(d));changed=true;}if(!changed)return;fs.writeFileSync(file+'.bak-without-cooler-'+Date.now(),fs.readFileSync(file),{flag:'wx',mode:0o600});require('./web-security').atomicJson(file,c);}
module.exports={excluded,migrate};
