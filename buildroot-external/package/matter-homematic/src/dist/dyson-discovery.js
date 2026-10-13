'use strict';
const dgram=require('node:dgram'),os=require('node:os');
const {privateIp}=require('./dyson-mqtt');
const SERVICE='_dyson_mqtt._tcp.local';
const number=ip=>ip.split('.').reduce((n,p)=>(n*256+Number(p))>>>0,0);
function localSubnet(ip,own){return privateIp(ip)&&own.some(i=>{
 if(!i.netmask||!/^1+0*$/.test(number(i.netmask).toString(2).padStart(32,'0')))return false;
 const mask=number(i.netmask),address=number(ip),network=(number(i.address)&mask)>>>0;
 return ((address&mask)>>>0)===network&&address!==network&&address!==((network|(~mask))>>>0);
});}

// Use the already bundled Matter DNS codec rather than a second DNS parser.
class DysonDiscovery {
 constructor(dns,{interfaces=os.networkInterfaces,createSocket=dgram.createSocket}={}){this.dns=dns;this.interfaces=interfaces;this.createSocket=createSocket;this.stopped=false;this.active=new Set();}
 find(serials){
  if(this.stopped||!serials.length)return Promise.resolve(new Map());
  if(!Array.isArray(serials)||serials.length>32||serials.some(s=>!require('./dyson-profile').serialValid(s)))return Promise.resolve(new Map());
  const wanted=new Set(serials),found=new Map(),interfaces=this.interfaces();
  const eligible=Object.entries(interfaces).filter(([name])=>name==='eth0'||process.platform!=='linux'&&!/tun|tap|tailscale|docker|veth/i.test(name));
  const own=eligible.flatMap(([,list])=>list).filter(value=>!value.internal&&value.family==='IPv4'&&privateIp(value.address));
  if(!own.length)return Promise.resolve(found);
  return new Promise(resolve=>{
   let socket,done=false,timer;
   const services=new Map(),addresses=new Map();
   const finish=()=>{if(done)return;done=true;clearTimeout(timer);clearInterval(queryTimer);if(socket){this.active.delete(finish);try{socket.close();}catch{}}resolve(found);};
   let queryTimer;
   try{socket=this.createSocket({type:'udp4',reuseAddr:true});}catch{finish();return;}
   this.active.add(finish);
   const query=name=>{if(done||name.length>253)return;try{const data=this.dns.DnsCodec.encode({transactionId:0,messageType:0,queries:[{name,recordType:name===SERVICE?12:name.endsWith('.'+SERVICE)?33:1,recordClass:1,uniCastResponse:false}],answers:[],authorities:[],additionalRecords:[]});socket.send(data,5353,'224.0.0.251',()=>{});}catch{}};
   socket.on('error',finish);
   socket.on('message',(bytes,source)=>{
    if(done||bytes.length<12||bytes.length>8192||!localSubnet(source.address,own))return;
    if([4,6,8,10].reduce((sum,pos)=>sum+bytes.readUInt16BE(pos),0)>128)return;
    let message;try{message=this.dns.DnsCodec.decode(bytes);}catch{return;}if(!message||!Array.isArray(message.answers)||!Array.isArray(message.additionalRecords))return;
    for(const record of [...message.answers,...message.additionalRecords]){
     if(!record||record.recordClass!==1||typeof record.name!=='string'||record.ttl===0)continue;const name=record.name.toLowerCase();
     if(record.recordType===1&&typeof record.name==='string'&&localSubnet(record.value,own))addresses.set(name,record.value);
     if(record.recordType===12&&name===SERVICE&&typeof record.value==='string'){
      const instance=record.value.split('.')[0],serial=instance.slice(instance.indexOf('_')+1).toUpperCase();
      if(wanted.has(serial))query(record.value);
     }
     if(record.recordType===33&&name.endsWith('.'+SERVICE)&&record.value?.port===1883){
      const instance=record.name.split('.')[0],serial=instance.slice(instance.indexOf('_')+1).toUpperCase();
      if(wanted.has(serial)&&typeof record.value.target==='string'){services.set(serial,record.value.target.toLowerCase());query(record.value.target);}
     }
    }
    if(addresses.size>256||services.size>100){finish();return;}
    for(const [serial,target]of services){const ip=addresses.get(target);if(ip&&!own.some(i=>i.address===ip))found.set(serial,ip);}
    if(found.size===wanted.size)finish();
   });
   timer=setTimeout(finish,5000);
   socket.bind(5353,()=>{if(done)return;try{for(const i of own.slice(0,2))socket.addMembership('224.0.0.251',i.address);socket.setMulticastInterface(own[0].address);query(SERVICE);queryTimer=setInterval(()=>query(SERVICE),1500);}catch{finish();}});
  });
 }
 stop(){this.stopped=true;for(const finish of [...this.active])finish();this.active.clear();}
}
module.exports={DysonDiscovery,SERVICE};
