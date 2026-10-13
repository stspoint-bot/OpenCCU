'use strict';
async function handleRuntime(web,req,res,u){
 const method=u.pathname==='/api/'?u.searchParams.get('method'):null;
 if(!['getDiagnostics'].includes(method))return false;
 if(req.method!=='GET'){web.sendJson(res,405,{error:'GET erforderlich'});return true;}
 const c=web.deps.getConnector(),memory=process.memoryUsage(),rpc=c.rpcEngine?.snapshot()||{};
 web.sendJson(res,200,{version:'0.19.1',uptimeSeconds:Math.floor(process.uptime()),memoryMiB:{rss:Math.round(memory.rss/1048576),heap:Math.round(memory.heapUsed/1048576)},discoveryComplete:!!web.deps.isDiscoveryComplete?.(),configReads:web.security.configSnapshot.loads,interfaces:Object.entries(c.config?.interfaces||{}).map(([name,value])=>({name,enabled:value.enabled===true,connected:c.clients.has(name)&&!c.failedInterfaces.has(name),retrying:c.failedInterfaces.has(name),...(rpc[name]||{})})),rpc});return true;
}
module.exports={handleRuntime};
