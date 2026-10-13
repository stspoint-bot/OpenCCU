'use strict';
// Recover a changed browser session without weakening CSRF validation or
// repeating an actuator command after an ambiguous network failure.
(()=>{
 const original=window.fetch.bind(window);let csrf='',refreshing;
 const valid=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\x00-\x20\x7f]/.test(value);
 function route(input,options){
  if(typeof input!=='string'&&!(input instanceof URL))return null;
  try{const url=new URL(input,location.href);if(url.origin!==location.origin)return null;
   return {url,method:String(options?.method||'GET').toUpperCase(),api:url.pathname==='/api/'||url.pathname.startsWith('/auth/')};
  }catch{return null;}
 }
 async function readSession(response){try{const value=await response.clone().json();if(valid(value.csrf))csrf=value.csrf;return value;}catch{return {};}}
 async function refresh(){
  if(!refreshing)refreshing=(async()=>{const response=await original('/api/?method=webSession',{cache:'no-store'});if(!response.ok)throw Error('Anmeldung erforderlich');const value=await readSession(response);if(!valid(value.csrf))throw Error('Sicherheitstoken fehlt');return value.csrf;})().finally(()=>{refreshing=undefined;});
  return refreshing;
 }
 function signed(options){const headers=new Headers(options?.headers||{});if(csrf)headers.set('X-CSRF-Token',csrf);return {...options,headers};}
 window.fetch=async(input,options)=>{
  const target=route(input,options),post=target?.api&&target.method==='POST';
  const response=await original(input,post?signed(options):options);
  if(target?.method==='GET'&&response.ok&&(target.url.pathname==='/auth/session'||target.url.searchParams.get('method')==='webSession'))await readSession(response);
  if(!post||response.status!==403||options?.signal?.aborted)return response;
  let error;try{error=await response.clone().json();}catch{return response;}
  if(error.error!=='CSRF-Token ungültig')return response;
  // Only reusable browser bodies can safely be replayed. Request streams are excluded.
  const body=options?.body;
  if(body!==undefined&&typeof body!=='string'&&!(body instanceof Blob)&&!(body instanceof FormData)&&!(body instanceof URLSearchParams))return response;
  try{await refresh();}catch{return response;}
  if(options?.signal?.aborted)return response;
  return original(input,signed(options)); // A single retry; no recursive fetch wrapper.
 };
})();
