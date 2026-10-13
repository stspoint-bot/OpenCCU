'use strict';
// The file transport is the sole owner of rotation. Never append stdout to its
// pathname via a second permanent shell descriptor.
function attach(logger){
 if(process.env.MH_TEST_EXPORTS==='1'||process.stdout.__mhCapture)return;
 process.stdout.__mhCapture=true;
 const queue=[];let bytes=0,dropped=0,scheduled=false,waiting=false;
 function flush(){scheduled=false;if(waiting)return;
  if(dropped){queue.push({level:'warn',message:'Logspitzen begrenzt: '+dropped+' Einträge verworfen'});dropped=0;}
  let count=0;while(queue.length&&count++<32){const row=queue.shift();bytes=Math.max(0,bytes-Buffer.byteLength(row.message));
   if(!logger.write(row)){waiting=true;logger.once('drain',()=>{waiting=false;schedule();});break;}
  }if(queue.length&&!waiting)schedule();
 }
 function schedule(){if(!scheduled&&!waiting){scheduled=true;setImmediate(flush);}}
 for(const [stream,level] of [[process.stdout,'info'],[process.stderr,'warn']]){
  let partial='';
  stream.write=function(chunk,encoding,callback){
   const cb=typeof encoding==='function'?encoding:callback;
   let text=Buffer.isBuffer(chunk)?chunk.toString(typeof encoding==='string'?encoding:'utf8'):String(chunk);
   text=(partial+text).replace(/\x1b\[[0-9;]*m/g,'');const lines=text.split('\n');partial=lines.pop().slice(-16384);
   for(const line of lines){const message=line.slice(0,16384);if(!message)continue;const size=Buffer.byteLength(message);if(bytes+size>262144){dropped++;continue;}bytes+=size;queue.push({level,message});}
   schedule();if(cb)process.nextTick(cb);return true;
  };
 }
}
module.exports={attach};
