'use strict';
// Only vehicle responses are accepted here, never account/auth responses.
const sensitive=k=>/(password|secret|token|credential|apikey|accesskey|sessionkey|authorization|cookie)/i.test(k)||/^(pin|pincode|key)$/i.test(k);
function sanitize(value,depth=0){
 if(depth>16)return '[Tiefe begrenzt]';
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value==='string'){
  if(/^Bearer\s+/i.test(value))return '[Zugangsdaten entfernt]';
  try{const url=new URL(value);if([...url.searchParams.keys()].some(k=>sensitive(k)||/^x-amz-/i.test(k))){url.search='';url.hash='';value=url.href+' [geschützte URL-Parameter entfernt]';}}catch{}
  return value.length>8192?value.slice(0,8192)+' [gekürzt]':value;
 }
 if(Array.isArray(value))return value.slice(0,2000).map(v=>sanitize(v,depth+1));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,2000).filter(([k])=>!sensitive(k)&&!['__proto__','constructor','prototype'].includes(k)).map(([k,v])=>[k,sanitize(v,depth+1)]));
 return null;
}
const escape=s=>String(s).replace(/~/g,'~0').replace(/\//g,'~1');
function catalog(sources){
 const fields=[];let bytes=0,truncated=false;
 function visit(value,path,source){
  if(fields.length>=2000||bytes>=524288||path.length>200){truncated=true;return;}
  if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))visit(v,path+'/'+escape(k),source);return;}
  const field={id:path,source,label:path.split('/').slice(2).map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~')).join(' → '),value};
  bytes+=Buffer.byteLength(JSON.stringify(field));if(bytes>524288){truncated=true;return;}fields.push(field);
 }
 for(const [name,result]of Object.entries(sources))if(result.available)visit(sanitize(result.data),'/'+escape(name),name);
 return {fields,truncated};
}
module.exports={sanitize,catalog};
