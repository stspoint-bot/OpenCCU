'use strict';
// A deliberately limited MQTT 3.1 transport for Dyson's local protocol.
// No offline command queue or automatic retransmission of physical commands.
const net=require('node:net'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const MAX=65536;
const privateIp=ip=>net.isIP(ip)===4 && (ip.startsWith('10.')||ip.startsWith('192.168.')||/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
function word(value){const bytes=Buffer.alloc(2);bytes.writeUInt16BE(value);return bytes;}
function string(value){const bytes=Buffer.from(value,'utf8');if(bytes.length>1024||value.includes('\0'))throw Error('Invalid MQTT field');return Buffer.concat([word(bytes.length),bytes]);}
function packet(header,body=Buffer.alloc(0)){
 if(body.length>MAX)throw Error('MQTT packet too large');
 let length=body.length;const digits=[];do{let n=length%128;length=Math.floor(length/128);digits.push(n|(length?128:0));}while(length);
 return Buffer.concat([Buffer.from([header,...digits]),body]);
}
class DysonMqtt extends EventEmitter {
 constructor({host,serial,credential,type,connect=net.createConnection,timeoutMs=8000}){
  super();if(!privateIp(host)||!/^[A-Z0-9-]{1,40}$/.test(serial)||!/^\d{3}[EKM]?$/.test(type)||typeof credential!=='string'||!credential||credential.length>256)throw Error('Invalid local Dyson connection');
  Object.assign(this,{host,serial,credential,type,connectSocket:connect,timeoutMs});
  this.statusTopic=type+'/'+serial+'/status/current';this.commandTopic=type+'/'+serial+'/command';this.buffer=Buffer.alloc(0);this.pending=new Map();this.nextId=2;this.closed=false;this.ready=false;
 }
 connect(){
  if(this.socket||this.closed)return Promise.reject(Error('Dyson connection already used'));
  return new Promise((resolve,reject)=>{
   this.completeConnect=(error)=>{clearTimeout(this.connectTimer);this.completeConnect=null;error?reject(error):resolve(this);};
   this.connectTimer=setTimeout(()=>this.fail('Dyson connection timeout'),this.timeoutMs);
   try{this.socket=this.connectSocket({host:this.host,port:1883});}catch{this.fail('Dyson connection failed');return;}
   this.socket.on('error',()=>this.fail('Dyson connection failed'));
   this.socket.on('close',()=>this.fail('Dyson connection closed'));
   this.socket.on('data',data=>{try{this.receive(data);}catch{this.fail('Invalid Dyson MQTT response');}});
   this.socket.once('connect',()=>{
    try{const id='mhb'+crypto.randomBytes(9).toString('hex');
      this.write(0x10,Buffer.concat([string('MQIsdp'),Buffer.from([3,0xc2]),word(30),string(id),string(this.serial),string(this.credential)]));
    }catch{this.fail('Dyson connection failed');}
   });
  });
 }
 write(header,body){if(this.closed||!this.socket||this.socket.destroyed)throw Error('Dyson connection closed');if(this.socket.writableLength>MAX)throw Error('Dyson write buffer full');this.socket.write(packet(header,body));}
 receive(chunk){
  if(this.closed)return;
  if(chunk.length+this.buffer.length>2*MAX)throw Error('Dyson receive buffer full');
  this.buffer=Buffer.concat([this.buffer,chunk]);
  while(this.buffer.length>=2){
   let length=0,position=1,multiplier=1,complete=false;
   for(let i=0;i<4;i++){if(position>=this.buffer.length)return;const digit=this.buffer[position++];length+=(digit&127)*multiplier;if(length>MAX)throw Error('Dyson packet too large');if(!(digit&128)){complete=true;break;}multiplier*=128;}
   if(!complete)throw Error('Invalid MQTT length');if(this.buffer.length<position+length)return;
   const header=this.buffer[0],body=this.buffer.subarray(position,position+length);this.buffer=this.buffer.subarray(position+length);
   this.handle(header,body);
  }
 }
 handle(header,body){
  const type=header>>4;
  if(type===2){
   if(header!==0x20||body.length!==2||body[0]!==0||body[1]!==0||this.connack)throw Error('MQTT authentication rejected');
   this.connack=true;this.write(0x82,Buffer.concat([word(1),string(this.statusTopic),Buffer.from([0])]));return;
  }
  if(type===9){
   if(header!==0x90||!this.connack||this.ready||body.length!==3||body.readUInt16BE(0)!==1||body[2]!==0)throw Error('Invalid MQTT subscription acknowledgment');
   this.ready=true;this.completeConnect?.();
   this.heartbeat=setInterval(()=>{try{if(this.pingPending){this.fail('Dyson keepalive timeout');return;}this.pingPending=true;this.write(0xc0);}catch{this.fail('Dyson keepalive failed');}},15000);this.heartbeat.unref();return;
  }
  if(!this.ready)throw Error('MQTT response before subscription');
  if(type===13){if(header!==0xd0||body.length)throw Error('Invalid MQTT ping');this.pingPending=false;return;}
  if(type===4){
   if(header!==0x40||body.length!==2)throw Error('Invalid MQTT acknowledgment');
   const id=body.readUInt16BE(0),pending=this.pending.get(id);if(pending){clearTimeout(pending.timer);this.pending.delete(id);pending.resolve();}return;
  }
  if(type!==3)throw Error('Unsupported MQTT packet');
  const qos=(header>>1)&3;
  if(qos>1||body.length<2)throw Error('Unsupported MQTT publication');
  const length=body.readUInt16BE(0);let position=2+length;
  if(position>body.length)throw Error('Invalid MQTT topic');
  const topic=new TextDecoder('utf-8',{fatal:true}).decode(body.subarray(2,position));
  if(qos===1){if(position+2>body.length)throw Error('Missing MQTT packet ID');const id=body.readUInt16BE(position);if(!id)throw Error('Invalid MQTT packet ID');position+=2;this.write(0x40,word(id));}
  if(topic!==this.statusTopic)return;
  const payload=body.subarray(position);if(payload.length>16384)throw Error('Dyson message too large');
  this.emit('message',payload);
 }
 publish(value,{ack=false}={}){
  if(!this.ready||this.closed)return Promise.reject(Error('Dyson not connected'));
  const payload=Buffer.from(JSON.stringify(value));if(payload.length>4096)return Promise.reject(Error('Dyson command too large'));
  if(!ack){try{this.write(0x30,Buffer.concat([string(this.commandTopic),payload]));return Promise.resolve();}catch(error){return Promise.reject(error);}}
  if(this.pending.size>=4)return Promise.reject(Error('Dyson command queue full'));
  let id=this.nextId;do{id=id%65535+1;}while(this.pending.has(id));this.nextId=id;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Dyson command acknowledgment timeout'));},this.timeoutMs);
   this.pending.set(id,{resolve,reject,timer});
   try{this.write(0x32,Buffer.concat([string(this.commandTopic),word(id),payload]));}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });
 }
 fail(message,destroy=true){
  if(this.closed)return;this.closed=true;this.ready=false;clearTimeout(this.connectTimer);clearInterval(this.heartbeat);
  this.completeConnect?.(Error(message));
  for(const value of this.pending.values()){clearTimeout(value.timer);value.reject(Error('Dyson connection lost'));}this.pending.clear();
  if(destroy)this.socket?.destroy();this.buffer=Buffer.alloc(0);this.credential='';this.emit('offline');
 }
 stop(){
  if(this.closed)return;const socket=this.socket;
  try{if(this.ready)this.write(0xe0);socket?.end();}catch{}
  this.fail('Dyson connection stopped',false);
  const timer=setTimeout(()=>socket?.destroy(),250);timer.unref();socket?.once('close',()=>clearTimeout(timer));
 }
}
module.exports={DysonMqtt,packet,string,word,privateIp};
