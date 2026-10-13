'use strict';

/** Native OnOff controls: send committed commands independently of old radio
 * feedback. Never keep an RPC promise inside the Matter transaction lock.
 */
function create({bridge,device,id,bridgedInfo,Endpoint,Device,BridgedInfo,OnOffServer,info=()=>{},log=()=>{}}) {
  class PhysicalSwitch extends OnOffServer {
    on(){const same=this.state.onOff===true;super.on();if(same)repeatAfterCommit(true,this.context);}
    off(){const same=this.state.onOff===false;super.off();if(same)repeatAfterCommit(false,this.context);}
  }
  const endpoint=new Endpoint(Device.with(BridgedInfo,PhysicalSwitch),{
    id,bridgedDeviceBasicInformation:bridgedInfo,onOff:{onOff:device.currentState.onOff===true}
  });
  bridge.switchControls||=new Map();
  const control={endpoint,OnOffServer,feedbackTransactions:new WeakSet(),scheduled:false,requested:null,active:false,pending:null,queue:Promise.resolve()};
  bridge.switchControls.set(device.hmAddress,control);
  const ready=()=>bridge.serverNode?.lifecycle.isOnline===true&&bridge.matterEndpoints.get(device.hmAddress)===endpoint;
  function repeatAfterCommit(value,context){context.transaction.addParticipants({postCommit(){schedule(value,context);}});}
  function schedule(value,context){
    if(typeof value!=='boolean'||control.feedbackTransactions.has(context?.transaction)||!ready())return;
    control.requested=value;
    if(control.scheduled)return;
    control.scheduled=true;
    setImmediate(()=>{
      control.scheduled=false;const target=control.requested;control.requested=null;
      if(!ready()||typeof target!=='boolean')return;
      control.pending=target;
      // A newer desired state supersedes verification of the previous command.
      // Only waits are interrupted; an in-flight RPC must settle first.
      control.readAbort?.abort();
      if(control.active)return;
      control.active=true;
      // OnOff is a desired state, not a pulse: keep one in-flight command
      // and the latest unsent target instead of building an obsolete backlog.
      control.queue=(async()=>{
        try{
          while(control.pending!==null&&ready()){
            const wanted=control.pending;control.pending=null;
            try{
              const mapping=bridge.deviceMapper.convertToHomematic(device.hmAddress,'onOff','onOff',wanted);
              if(!mapping){log('Switch command has no Homematic mapping');continue;}
              info(`Switch command requested: ${mapping.key}=${mapping.value}`);
              await bridge.ccuConnector.setValue(device.hmAddress,mapping.key,mapping.value);
              if(mapping.key==='STATE'&&control.pending===null){
                const channels=bridge.ccuConnector.getChannels();
                const source=bridge.findStateSourceChannel(device.hmAddress,channels.get(device.hmAddress)?.type,channels)||device.hmAddress;
                const controller=new AbortController();control.readAbort=controller;
                let actual;
                try{actual=await require('./switch-readback').readback(bridge.ccuConnector,source,wanted,{signal:controller.signal});}
                finally{control.readAbort=null;}
                if(controller.signal.aborted)continue;
                if(typeof actual==='boolean'&&ready())await feedback(bridge,device.hmAddress,actual);
                else if(ready())log('Switch command accepted; physical state not yet confirmed');
              }
            }
            catch{log('Switch command failed; physical feedback required. No automatic retry.');}
          }
        }finally{control.active=false;control.pending=null;}
      })();
    });
  }
  endpoint.events.onOff.onOff$Changed.on((value,_previous,context)=>schedule(value,context));
  return endpoint;
}

/** Tag exactly the feedback transaction; unrelated controller commands must
 * remain enabled even while this update waits for the endpoint lock.
 */
async function feedback(bridge,address,value){
  if(typeof value!=='boolean')return;
  const control=bridge.switchControls?.get(address),device=bridge.deviceMapper.getMappedDevice(address);
  if(!control||!device)return;
  device.currentState.onOff=value;
  if(control.endpoint.state.onOff.onOff===value)return;
  await control.endpoint.act(async agent=>{
    const transaction=agent.context.transaction;
    await transaction.begin();
    const onOff=agent.get(control.OnOffServer);
    await transaction.addResources(onOff);
    control.feedbackTransactions.add(transaction);
    onOff.state.onOff=value;
  });
}
module.exports={create,feedback};
