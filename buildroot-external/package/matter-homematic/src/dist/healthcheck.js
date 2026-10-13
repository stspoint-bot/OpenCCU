"use strict";
const fs=require('node:fs'),http=require('node:http'),https=require('node:https');
const file=process.argv[2],deadline=Date.now()+Math.max(1,Math.min(180,Number(process.argv[3])||120))*1000;
async function probe(){
 const config=JSON.parse(fs.readFileSync(file,'utf8')),web=config.web||{},secure=web.tls?.enabled===true,port=web.port||8080;
 return new Promise(resolve=>{
  const req=(secure?https:http).get({host:'127.0.0.1',port,path:'/api/?method=webAuthInfo',headers:(web.trustedProxies||[]).includes('127.0.0.1')&&web.publicOrigin?{host:new URL(web.publicOrigin).host,'x-forwarded-proto':'https'}:{host:'127.0.0.1:'+port},rejectUnauthorized:false,timeout:1500},res=>{
   let data='';res.on('data',chunk=>{data+=chunk;if(data.length>8192){req.destroy();resolve(false);}});res.on('end',()=>{try{const value=JSON.parse(data);resolve(res.statusCode===200&&value.protocol==='mh-web-auth-v1'&&value.version===require('../package.json').version.replace(/-openccu-ccu3$/, '')&&(process.argv[4]==='--web-ready'||value.matterReady===true));}catch{resolve(false);}});res.on('error',()=>resolve(false));
  });req.on('timeout',()=>req.destroy());req.on('error',()=>resolve(false));
 });
}
(async()=>{do{try{if(await probe())return;}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<deadline);process.exitCode=1;})();
