'use strict';
// Only repeat reads: repeating writes could trigger CCU programs twice.
// One temporary listener per connector, even during a scene with many actors.
const observers=new WeakMap();
function observe(connector,address,notify){
  if(typeof connector.on!=='function'||(typeof connector.off!=='function'&&typeof connector.removeListener!=='function'))return ()=>{};
  let group=observers.get(connector);
  if(group?.watchers.size>=64)return ()=>{};
  const iface=connector.getChannels?.()?.get?.(address)?.interface;
  if(!group){
    group={watchers:new Set()};
    group.listener=event=>{
      if(!event||event.key!=='STATE'||typeof event.value!=='boolean')return;
      for(const w of group.watchers)if(event.address===w.address&&(w.iface===undefined||event.interface===w.iface))w.notify(event.value);
    };
    connector.on('deviceEvent',group.listener);observers.set(connector,group);
  }
  const watcher={address,iface,notify};group.watchers.add(watcher);
  return ()=>{
    group.watchers.delete(watcher);
    if(!group.watchers.size){
      if(typeof connector.off==='function')connector.off('deviceEvent',group.listener);
      else connector.removeListener('deviceEvent',group.listener);
      observers.delete(connector);
    }
  };
}
async function readback(connector,address,requested,{sleep,signal}={}){
  if(typeof requested!=='boolean')return undefined;
  if(!connector||typeof connector.getValue!=='function')throw new TypeError('Connector getValue required');
  if(sleep!==undefined&&typeof sleep!=='function')throw new TypeError('sleep must be a function');
  if(signal!==undefined&&(!(signal instanceof AbortSignal)))throw new TypeError('signal must be an AbortSignal');
  if(signal?.aborted)return undefined;
  let lastEvent,sequence=0,wake,immediate=false;
  const started=performance.now();
  const detach=observe(connector,address,value=>{lastEvent=value;sequence++;if(value===requested)wake?.();});
  const abort=()=>wake?.();
  signal?.addEventListener('abort',abort,{once:true});
  function wait(ms){return new Promise((resolve,reject)=>{
    let timer,done=false;
    const finish=(failed=false,error)=>{if(done)return;done=true;clearTimeout(timer);wake=undefined;failed?reject(error):resolve();};
    wake=()=>finish();
    if(sleep)Promise.resolve().then(()=>sleep(ms)).then(()=>finish(),error=>finish(true,error));
    else timer=setTimeout(()=>finish(),ms);
  });}
  try{
    // One extra read at 500 ms closes the previous 750 ms blind interval.
    // Total scheduled pause stays at 1 s; at most four reads, never a write.
    for(const delay of [0,250,250,500]){
      if(signal?.aborted)return undefined;
      if(delay&&!immediate){await wait(delay);if(signal?.aborted)return undefined;if(lastEvent===requested)return requested;}
      // Do not multiply a slow/failed RPC timeout by four. The connector
      // owns the in-flight timeout; this budget prevents further read attempts.
      if(performance.now()-started>1500)return undefined;
      immediate=false;
      const before=sequence;
      try{
        const actual=await connector.getValue(address,'STATE');
        // Await any existing read before allowing the next write. An abandoned
        // RPC could otherwise overwrite newer feedback in the connector cache.
        if(signal?.aborted)return undefined;
        // Do not confirm a read snapshot contradicted by a newer radio event.
        if(sequence!==before&&lastEvent!==requested){lastEvent=undefined;continue;}
        if(typeof actual==='boolean'&&actual===requested)return actual;
        // A getValue already in flight may overwrite its cache with an old
        // snapshot. Await it, then reread immediately instead of publishing
        // an event-only confirmation while that stale read is still pending.
        immediate=sequence!==before&&lastEvent===requested;
        lastEvent=undefined;
      }catch{
        if(signal?.aborted)return undefined;
        if(sequence!==before&&lastEvent===requested)return requested;
        lastEvent=undefined;
      }
    }
    return undefined;
  }finally{signal?.removeEventListener('abort',abort);detach();wake?.();}
}
module.exports = {readback};
