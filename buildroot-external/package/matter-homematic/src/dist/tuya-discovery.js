'use strict';
const fs=require('node:fs'),os=require('node:os'),net=require('node:net');
const {validIp}=require('./smartplus');
function macFor(id){return /^\d{8}[a-f\d]{12}$/i.test(id)?id.slice(-12).toLowerCase():null;}
function neighbors(text){const map=new Map();for(const line of text.split('\n')){const parts=line.trim().split(/\s+/);if(parts.length<6||!validIp(parts[0])||parts[2]==='0x0'||!/^([a-f\d]{2}:){5}[a-f\d]{2}$/i.test(parts[3]))continue;const mac=parts[3].replaceAll(':','').toLowerCase();if(mac!=='000000000000')map.set(mac,parts[0]);}return map;}
function candidates(interfaces){const own=new Set(Object.values(interfaces).flat().map(i=>i.address)),prefixes=new Set();for(const [name,list]of Object.entries(interfaces)){if(/docker|veth|br-|tun|tap/i.test(name))continue;for(const i of list)if(!i.internal&&i.family==='IPv4'&&i.netmask==='255.255.255.0'&&validIp(i.address))prefixes.add(i.address.split('.').slice(0,3).join('.'));}return [...prefixes].slice(0,2).flatMap(prefix=>Array.from({length:254},(_,i)=>prefix+'.'+(i+1))).filter(ip=>!own.has(ip));}
class TuyaDiscovery{
 constructor({readArp=()=>fs.readFileSync('/proc/net/arp','utf8'),interfaces=os.networkInterfaces,connect=net.createConnection,now=Date.now}={}){this.readArp=readArp;this.interfaces=interfaces;this.connect=connect;this.now=now;this.last=-Infinity;this.sockets=new Set();this.stopped=false;}
 known(entries){let map;try{map=neighbors(this.readArp());}catch{return;}for(const e of entries){if(e.client.device.ip)continue;const mac=macFor(e.item.id),ip=mac&&map.get(mac);if(ip)e.client.device.ip=ip;}}
 async find(entries){if(this.stopped)return;this.known(entries);if(!entries.some(e=>!e.client.device.ip&&macFor(e.item.id))||this.now()-this.last<90000)return;this.last=this.now();const ips=candidates(this.interfaces());let cursor=0;
  const worker=async()=>{while(cursor<ips.length&&!this.stopped){const ip=ips[cursor++];await new Promise(resolve=>{let done=false,socket;const finish=()=>{if(done)return;done=true;if(socket){this.sockets.delete(socket);socket.destroy();}resolve();};try{socket=this.connect({host:ip,port:6668});this.sockets.add(socket);socket.setTimeout(300,finish);socket.once('connect',finish);socket.once('error',finish);socket.once('close',finish);}catch{finish();}});}};
  await Promise.all(Array.from({length:8},worker));if(!this.stopped)this.known(entries);
 }
 stop(){this.stopped=true;for(const s of this.sockets)s.destroy();this.sockets.clear();}
}
module.exports={TuyaDiscovery,macFor,neighbors,candidates};
