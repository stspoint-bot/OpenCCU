'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
// Linux requires the containing directory to be flushed after publishing a name.
// Windows does not expose directory fsync through this API.
function syncDirectory(directory){if(process.platform==='win32')return;const fd=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
// Flush the complete replacement before publishing it; readers see old or new JSON.
function atomicBytes(file,data){
 const temp=file+'.tmp-'+crypto.randomBytes(8).toString('hex');let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);syncDirectory(path.dirname(file));}
 finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function atomicJson(file,data){return atomicBytes(file,JSON.stringify(data,null,2));}
function createKey(file){let fd,created=false;
 try{fd=fs.openSync(file,'wx',0o600);created=true;fs.writeFileSync(fd,crypto.randomBytes(32));fs.fsyncSync(fd);syncDirectory(path.dirname(file));}
 catch(e){if(fd!==undefined){fs.closeSync(fd);fd=undefined;}if(created&&fs.existsSync(file))fs.unlinkSync(file);throw e;}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={atomicBytes,atomicJson,createKey,syncDirectory};
