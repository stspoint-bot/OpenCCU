'use strict';

const validLevel=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
const online=bridge=>bridge.serverNode?.lifecycle.isOnline===true;

/** Keep physical LEVEL feedback separate from Matter's remembered on-level. */
function create({bridge,device,id,bridgedInfo,Endpoint,Device,BridgedInfo,OnOffServer,LevelControlServer,log,info=()=>{}}) {
  const initial=device.currentState.currentLevel;
  const on=typeof initial==='number'&&Number.isFinite(initial)&&initial>0;
  const remembered=on?Math.max(1,Math.min(254,initial)):254;
  class PhysicalDimmerOnOff extends OnOffServer.with('Lighting') {
    on(){const unchanged=this.state.onOff===true;super.on();if(unchanged)afterCommit({enabled:true},this.context);}
    off(){const unchanged=this.state.onOff===false;super.off();if(unchanged)afterCommit({enabled:false},this.context);}
  }
  const endpoint=new Endpoint(Device.with(BridgedInfo,PhysicalDimmerOnOff),{
    id,bridgedDeviceBasicInformation:bridgedInfo,
    onOff:{onOff:on},
    levelControl:{currentLevel:remembered,minLevel:1,maxLevel:254}
  });
  bridge.dimmerControls||=new Map();
  const control={endpoint,feedbackTransactions:new WeakSet(),OnOffServer,LevelControlServer,scheduled:false,requested:null,active:false,pendingTarget:null,queue:Promise.resolve()};
  bridge.dimmerControls.set(device.hmAddress,control);
  const ready=()=>online(bridge)&&bridge.matterEndpoints.get(device.hmAddress)===endpoint;
  function afterCommit(update,context) {
    // Changed attributes are forwarded by their committed event. Repeated
    // explicit commands have no such event, but must still wait for commit.
    context.transaction.addParticipants({postCommit(){schedule(update,context);}});
  }

  function schedule(update,context) {
    // Attribute events carry their originating transaction in this SDK.
    // Tag our feedback transaction, rather than muting unrelated commands
    // while a feedback update is merely waiting for the endpoint lock.
    if(control.feedbackTransactions.has(context?.transaction)||!ready())return;
    control.requested||={enabled:endpoint.state.onOff.onOff,level:endpoint.state.levelControl.currentLevel};
    Object.assign(control.requested,update);
    if(control.scheduled)return;
    control.scheduled=true;
    // OnOff and LevelControl react within one Matter transaction. Read its
    // final state once, rather than forwarding their intermediate attributes.
    setImmediate(()=>{
      control.scheduled=false;
      if(!ready())return;
      const request=control.requested;control.requested=null;
      const enabled=request.enabled;
      const level=request.level;
      if(typeof enabled!=='boolean'||!Number.isInteger(level)||level<1||level>254){
        log('Invalid Matter dimmer state; command refused');return;
      }
      const target=enabled?level/254:0;
      enqueue(target);
    });
  }
  function enqueue(target) {
    // One in-flight write and one latest unsent target: a slider must not
    // build an unbounded queue of obsolete intermediate radio commands.
    control.pendingTarget=target;
    if(control.active)return;
    control.active=true;
    control.queue=(async()=>{
      try {
        while(control.pendingTarget!==null&&ready()) {
          const requested=control.pendingTarget;control.pendingTarget=null;
          info(`Dimmer command requested: LEVEL=${requested}`);
          // Always send explicit Off even if old feedback still reports zero;
          // a preceding On can already be in flight. Never retry blindly.
          try{await bridge.ccuConnector.setValue(device.hmAddress,'LEVEL',requested);}
          catch{log('Dimmer command failed; physical state requires confirmation');}
        }
      }finally{control.active=false;control.pendingTarget=null;}
    })();
  }
  endpoint.events.onOff.onOff$Changed.on((value,_previous,context)=>schedule({enabled:value},context));
  endpoint.events.levelControl.currentLevel$Changed.on((value,_previous,context)=>{
    // The SDK can lower its remembered level while Off. This is NOT a request
    // to send a small positive LEVEL to the physical dimmer.
    if(endpoint.state.onOff.onOff===true)schedule({enabled:true,level:value},context);
  });
  return endpoint;
}

/** Apply both attributes from one authoritative CCU LEVEL; never echo a write. */
async function feedback(bridge,address,value) {
  if(!validLevel(value))return;
  const device=bridge.deviceMapper.getMappedDevice(address);
  if(!device)return;
  const level=value===0?0:Math.max(1,Math.min(254,Math.round(value*254)));
  device.currentState.currentLevel=level;
  device.currentState.onOff=value>0;
  const control=bridge.dimmerControls?.get(address);
  if(!control)return;
  await control.endpoint.act(async agent=>{
    const transaction=agent.context.transaction;
    // Match Endpoint.set's asynchronous locking protocol. Radio feedback
    // may arrive while a controller transaction owns either behavior.
    await transaction.begin();
    const onOff=agent.get(control.OnOffServer);
    const levelControl=agent.get(control.LevelControlServer);
    await transaction.addResources(onOff,levelControl);
    control.feedbackTransactions.add(transaction);
    onOff.state.onOff=value>0;
    // Matter DimmableLight has minLevel=1. Off is represented by onOff=false,
    // while physical LEVEL is exactly zero and the on-level remains remembered.
    if(level>0)levelControl.state.currentLevel=level;
  });
}

module.exports={create,feedback,validLevel};
