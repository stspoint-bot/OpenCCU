
"use strict";

/**
 * Minimal HomeMatic BIN-RPC implementation used for CUxD.
 * CUxD exposes xmlrpc_bin:// on TCP 8701 and does not speak HTTP/XML-RPC.
 * This module intentionally has no external dependencies so the CCU addon
 * remains self-contained.
 */

const net = require("net");

function encodeString(value) {
  const b = Buffer.from(String(value), "utf8");
  const out = Buffer.alloc(8 + b.length);
  out.writeUInt32BE(0x03, 0);
  out.writeUInt32BE(b.length, 4);
  b.copy(out, 8);
  return out;
}

function encodeBool(value) {
  const out = Buffer.alloc(5);
  out.writeUInt32BE(0x02, 0);
  out.writeUInt8(value ? 1 : 0, 4);
  return out;
}

function encodeInteger(value) {
  // BIN-RPC integers are signed 32-bit values; never silently wrap a command.
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new RangeError("BIN-RPC integer outside signed 32-bit range");
  }
  const out = Buffer.alloc(8);
  out.writeUInt32BE(0x01, 0);
  out.writeInt32BE(value, 4);
  return out;
}

function encodeDouble(value) {
  if (!Number.isFinite(value)) throw new TypeError("BIN-RPC double must be finite");
  if (value === 0) {
    const out = Buffer.alloc(12);
    out.writeUInt32BE(0x04, 0);
    out.writeInt32BE(0, 4);
    out.writeInt32BE(0, 8);
    return out;
  }
  const exp = Math.floor(Math.log(Math.abs(value)) / Math.LN2) + 1;
  // Split the scale so subnormal and near-maximum doubles have finite intermediates.
  const base = Math.max(-1022, Math.min(1023, exp));
  const mantissa = Math.trunc((value / Math.pow(2, base) / Math.pow(2, exp - base)) * (1 << 30));
  const out = Buffer.alloc(12);
  out.writeUInt32BE(0x04, 0);
  out.writeInt32BE(mantissa, 4);
  out.writeInt32BE(exp, 8);
  return out;
}

function encodeData(value) {
  if (value === undefined || value === null) {
    throw new TypeError("BIN-RPC cannot encode null/undefined");
  }
  if (typeof value === "boolean") return encodeBool(value);
  if (typeof value === "string") return encodeString(value);
  if (typeof value === "number") {
    if (value && value.explicitDouble !== undefined) return encodeDouble(Number(value.explicitDouble));
    return Number.isInteger(value) ? encodeInteger(value) : encodeDouble(value);
  }
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "explicitDouble")) {
      return encodeDouble(Number(value.explicitDouble));
    }
    if (Array.isArray(value)) {
      const parts = value.map(encodeData);
      const out = Buffer.alloc(8);
      out.writeUInt32BE(0x100, 0);
      out.writeUInt32BE(parts.length, 4);
      return Buffer.concat([out, ...parts]);
    }
    const parts = [];
    for (const key of Object.keys(value)) {
      const kb = Buffer.from(key, "utf8");
      const kh = Buffer.alloc(4);
      kh.writeUInt32BE(kb.length, 0);
      parts.push(Buffer.concat([kh, kb, encodeData(value[key])]));
    }
    const out = Buffer.alloc(8);
    out.writeUInt32BE(0x101, 0);
    out.writeUInt32BE(parts.length, 4);
    return Buffer.concat([out, ...parts]);
  }
  throw new TypeError(`Unsupported BIN-RPC type: ${typeof value}`);
}

function encodeRequest(method, params = []) {
  const methodBytes = Buffer.from(method, "ascii");
  const payload = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(methodBytes.length, 0); return b; })(),
    methodBytes,
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(params.length, 0); return b; })(),
    ...params.map(encodeData)
  ]);
  const header = Buffer.alloc(8);
  header.write("Bin", 0, "ascii");
  header.writeUInt8(0, 3);
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function encodeResponse(value = "") {
  const body = encodeData(value);
  const header = Buffer.alloc(8);
  header.write("Bin", 0, "ascii");
  header.writeUInt8(1, 3);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function decodeData(buffer, offset = 0, depth = 0) {
  if (depth > 32) throw new Error("BIN-RPC nesting limit");
  if (buffer.length < offset + 4) throw new Error("Incomplete BIN-RPC value");
  const type = buffer.readUInt32BE(offset);
  offset += 4;

  if (type === 0x01) {
    if (buffer.length < offset + 4) throw new Error("Incomplete integer");
    return { value: buffer.readInt32BE(offset), offset: offset + 4 };
  }
  if (type === 0x02) {
    if (buffer.length < offset + 1) throw new Error("Incomplete boolean");
    return { value: buffer.readUInt8(offset) === 1, offset: offset + 1 };
  }
  if (type === 0x03) {
    if (buffer.length < offset + 4) throw new Error("Incomplete string length");
    const len = buffer.readUInt32BE(offset); offset += 4;
    if (buffer.length < offset + len) throw new Error("Incomplete string");
    return { value: buffer.subarray(offset, offset + len).toString("utf8"), offset: offset + len };
  }
  if (type === 0x04) {
    if (buffer.length < offset + 8) throw new Error("Incomplete double");
    const mantissa = buffer.readInt32BE(offset);
    const exponent = buffer.readInt32BE(offset + 4);
    if (exponent < -1073 || exponent > 1025) throw new Error("BIN-RPC double exponent limit");
    const base = Math.max(-1022, Math.min(1023, exponent));
    const value = (mantissa / (1 << 30)) * Math.pow(2, base) * Math.pow(2, exponent - base);
    if (!Number.isFinite(value)) throw new Error("BIN-RPC double must be finite");
    return { value, offset: offset + 8 };
  }
  if (type === 0x100 || type === 0x101) {
    if (buffer.length < offset + 4) throw new Error("Incomplete collection count");
    const count = buffer.readUInt32BE(offset); offset += 4;
    if (count > 8192) throw new Error("BIN-RPC collection limit");
    if (type === 0x100) {
      const arr = [];
      for (let i = 0; i < count; i++) {
        const r = decodeData(buffer, offset, depth + 1); arr.push(r.value); offset = r.offset;
      }
      return { value: arr, offset };
    }
    const obj = {};
    for (let i = 0; i < count; i++) {
      if (buffer.length < offset + 4) throw new Error("Incomplete struct key length");
      const len = buffer.readUInt32BE(offset); offset += 4;
      if (buffer.length < offset + len) throw new Error("Incomplete struct key");
      const key = buffer.subarray(offset, offset + len).toString("utf8"); offset += len;
      const r = decodeData(buffer, offset, depth + 1); Object.defineProperty(obj, key, {value:r.value, enumerable:true, configurable:true, writable:true}); offset = r.offset;
    }
    return { value: obj, offset };
  }
  throw new Error(`Unsupported BIN-RPC type 0x${type.toString(16)}`);
}

function decodeFrame(frame) {
  if (frame.length < 8 || frame.subarray(0, 3).toString("ascii") !== "Bin") {
    throw new Error("Invalid BIN-RPC frame");
  }
  const type = frame.readUInt8(3);
  const size = frame.readUInt32BE(4);
  if (size > 1048576) throw new Error("BIN-RPC frame limit");
  if (frame.length !== 8 + size) throw new Error("Invalid BIN-RPC frame length");
  const body = frame.subarray(8, 8 + size);

  if (type === 0) {
    let p = 0;
    if (body.length < 8) throw new Error("Incomplete BIN-RPC request");
    const methodLen = body.readUInt32BE(p); p += 4;
    if (!methodLen || methodLen > 80 || methodLen > body.length - 8) throw new Error("Invalid BIN-RPC method length");
    const method = body.subarray(p, p + methodLen).toString("ascii"); p += methodLen;
    const count = body.readUInt32BE(p); p += 4;
    if (count > 8192) throw new Error("BIN-RPC parameter limit");
    const params = [];
    for (let i = 0; i < count; i++) {
      const r = decodeData(body, p); params.push(r.value); p = r.offset;
    }
    if (p !== body.length) throw new Error("Trailing BIN-RPC request data");
    return { type, method, params };
  }
  if (type === 1 || type === 0xff) {
    const decoded = decodeData(body, 0);
    if (decoded.offset !== body.length) throw new Error("Trailing BIN-RPC response data");
    return { type, value: decoded.value };
  }
  throw new Error(`Unsupported BIN-RPC message type ${type}`);
}

function extractFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 8) {
    if (buffer.subarray(offset, offset + 3).toString("ascii") !== "Bin") {
      const idx = buffer.indexOf(Buffer.from("Bin"), offset + 1);
      if (idx < 0) return { frames, rest: buffer.subarray(Math.max(0, buffer.length - 2)) };
      offset = idx;
      continue;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (size > 1048576) throw new Error("BIN-RPC frame limit");
    const total = 8 + size;
    if (buffer.length - offset < total) break;
    frames.push(buffer.subarray(offset, offset + total));
    offset += total;
  }
  return { frames, rest: buffer.subarray(offset) };
}

class BinRpcClient {
  constructor(options) {this.host=options.host;this.port=options.port;this.responseTimeout=options.responseTimeout||8000;this.socket=null;this.queue=[];this.pending=null;this.connecting=null;this.closed=false;}
  connect(){
    if(this.closed)return Promise.reject(new Error("BIN-RPC client closed"));
    if(this.socket&&!this.socket.destroyed&&!this.connecting)return Promise.resolve();
    if(this.connecting)return this.connecting;
    const socket=net.createConnection({host:this.host,port:this.port});this.socket=socket;let buffer=Buffer.alloc(0);
    this.connecting=new Promise((resolve,reject)=>{
      let established=false;const timer=setTimeout(()=>fail(new Error("BIN-RPC connect timed out")),this.responseTimeout);
      const fail=err=>{if(this.socket!==socket)return;clearTimeout(timer);this.socket=null;this.connecting=null;socket.destroy();if(!established)reject(err);this._abort(err);};
      socket.once("connect",()=>{if(this.socket!==socket)return;established=true;clearTimeout(timer);this.connecting=null;resolve();this._pump();});
      socket.on("error",fail);socket.on("close",()=>fail(new Error("BIN-RPC connection closed")));
      socket.on("data",chunk=>{
        if(this.socket!==socket)return;
        try {
          if(buffer.length+chunk.length>2097152)throw new Error("BIN-RPC buffer limit");
          buffer=Buffer.concat([buffer,chunk]);const parsed=extractFrames(buffer);buffer=parsed.rest;
          // Consume the whole received batch before sending the next request.
          for(const frame of parsed.frames){const msg=decodeFrame(frame);if(msg.type!==1&&msg.type!==255)throw new Error("Unexpected BIN-RPC response");const item=this.pending;if(!item)throw new Error("Unsolicited BIN-RPC response");this.pending=null;clearTimeout(item.timer);if(msg.type===255)item.reject(new Error("BIN-RPC remote fault"));else item.resolve(msg.value);}
          this._pump();
        }catch(err){fail(err);}
      });
    });return this.connecting;
  }
  _abort(err){if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(err);this.pending=null;}this.queue.splice(0).forEach(q=>q.reject(err));}
  async methodCall(method,params=[]){await this.connect();return new Promise((resolve,reject)=>{if(this.closed||!this.socket||this.socket.destroyed)return reject(new Error("BIN-RPC connection closed"));if(this.queue.length>=256)return reject(new Error("BIN-RPC queue limit"));this.queue.push({method,params,resolve,reject});this._pump();});}
  _pump(){if(!this.socket||this.socket.destroyed||this.pending||!this.queue.length)return;const socket=this.socket,item=this.queue.shift();let frame;try{frame=encodeRequest(item.method,item.params);}catch(err){item.reject(err);this._pump();return;}
    this.pending=item;const abort=err=>{if(this.socket!==socket)return;this.socket=null;this.connecting=null;socket.destroy();this._abort(err);};
    item.timer=setTimeout(()=>abort(new Error("BIN-RPC "+item.method+" timed out")),this.responseTimeout);
    socket.write(frame,err=>{if(err)abort(err);});
  }
  close(){this.closed=true;const socket=this.socket;this._abort(new Error("BIN-RPC client closed"));socket?.destroy();}
}
function createClient(options){return new BinRpcClient(options);}
class BinRpcServer {
 constructor(options={},handler){this.options=options;this.handler=handler;this.sockets=new Set();this.server=net.createServer(socket=>{
  if(options.accept&&!options.accept(socket.remoteAddress)){socket.destroy();return;}
  this.sockets.add(socket);let buffer=Buffer.alloc(0),inflight=0;
  socket.setTimeout(90000,()=>socket.destroy());socket.on("error",()=>{});socket.on("close",()=>this.sockets.delete(socket));
  socket.on("data",chunk=>{try{if(buffer.length+chunk.length>2097152)throw new Error("BIN-RPC buffer limit");buffer=Buffer.concat([buffer,chunk]);const parsed=extractFrames(buffer);buffer=parsed.rest;
   for(const frame of parsed.frames){const msg=decodeFrame(frame);if(msg.type!==0||++inflight>32)throw new Error("BIN-RPC request limit");Promise.resolve().then(()=>this.handler(msg.method,msg.params)).then(result=>{if(!socket.destroyed)socket.write(encodeResponse(result===undefined?"":result));},()=>{if(!socket.destroyed)socket.write(encodeResponse({faultCode:-32500,faultString:"Invalid callback"}));}).catch(()=>socket.destroy()).finally(()=>inflight--);}
  }catch{socket.destroy();}});
 });this.server.maxConnections=32;}
 listen(port,host=this.options.host||"127.0.0.1",cb){this.server.listen(port,host,cb);return this.server;}
 close(cb){for(const socket of this.sockets)socket.destroy();return this.server.close(cb);}
}

module.exports = {
  createClient,
  createServer: (options, handler) => new BinRpcServer(options, handler),
  encodeRequest,
  encodeResponse,
  decodeFrame
};
