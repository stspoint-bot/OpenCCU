'use strict';
const fs=require('node:fs');
class ConfigSnapshot {
  constructor(file){this.file=file;this.signature='';this.value=null;this.loads=0;}
  read(){const s=fs.statSync(this.file),signature=[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');if(!this.value||signature!==this.signature){const value=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Ungültige Konfiguration');this.value=value;this.signature=signature;this.loads++;}return this.value;}
}
class RpcEngine {
  constructor(dispatch,{limit=128,queueTimeoutMs=10000}={}){this.dispatch=dispatch;this.limit=limit;this.queueTimeoutMs=queueTimeoutMs;this.lanes=new Map();this.shared=new Map();}
  lane(name){if(!this.lanes.has(name))this.lanes.set(name,{active:0,queue:[],completed:0,failed:0,coalesced:0,totalMs:0,lastSuccess:null,lastFailure:null});return this.lanes.get(name);}
  call(name,method,params){
    const lane=this.lane(name),share=['getParamsetDescription','listDevices'].includes(method),key=share?JSON.stringify([name,method,params]):null;
    if(key&&this.shared.has(key)){lane.coalesced++;return this.shared.get(key);}
    if(lane.queue.length>=this.limit)return Promise.reject(Object.assign(Error('RPC-Warteschlange voll; bitte später versuchen'),{status:503}));
    const promise=new Promise((resolve,reject)=>{const job={method,params,resolve,reject,priority:['setValue','getValue','init','ping'].includes(method)?0:1};job.timer=setTimeout(()=>{const index=lane.queue.indexOf(job);if(index>=0){lane.queue.splice(index,1);reject(Object.assign(Error('RPC-Wartezeit überschritten; Befehl nicht gesendet'),{status:503}));}},this.queueTimeoutMs);job.timer.unref();lane.queue.push(job);this.drain(name,lane);});
    if(key){this.shared.set(key,promise);promise.then(()=>this.shared.delete(key),()=>this.shared.delete(key));}
    return promise;
  }
  drain(name,lane){
    if(lane.active||!lane.queue.length)return;
    let index=lane.queue.findIndex(job=>job.priority===0);if(index<0)index=0;
    const job=lane.queue.splice(index,1)[0];clearTimeout(job.timer);lane.active=1;const start=Date.now();
    Promise.resolve().then(()=>this.dispatch(name,job.method,job.params)).then(result=>{lane.completed++;lane.lastSuccess=new Date().toISOString();job.resolve(result);},error=>{lane.failed++;lane.lastFailure=new Date().toISOString();job.reject(error);}).finally(()=>{lane.totalMs+=Date.now()-start;lane.active=0;this.drain(name,lane);});
  }
  snapshot(){return Object.fromEntries([...this.lanes].map(([name,l])=>[name,{active:l.active,queued:l.queue.length,completed:l.completed,failed:l.failed,coalesced:l.coalesced,averageMs:l.completed+l.failed?Math.round(l.totalMs/(l.completed+l.failed)):0,lastSuccess:l.lastSuccess,lastFailure:l.lastFailure}]));}
}
module.exports={ConfigSnapshot,RpcEngine};
