"use strict";
function safeXml(raw){
 const xml=raw.toString("utf8");if(/<!DOCTYPE|<!ENTITY/i.test(xml))return false;
 let depth=0,count=0;for(const match of xml.matchAll(/<([^>]+)>/g)){
  const tag=match[1];if(tag.startsWith("?")||tag.startsWith("!"))continue;
  if(++count>200000)return false;if(tag.startsWith("/"))depth--;else if(!tag.endsWith("/"))depth++;
  if(depth<0||depth>40)return false;
 }return depth===0;
}
function validate(c,method,params,depth){
 if(typeof method!=="string"||method.length>80||!Array.isArray(params)||params.length>16||depth>1)throw Error("Invalid callback");
 if(method==="system.multicall"){
  if(depth||!Array.isArray(params[0])||params[0].length>256)throw Error("Callback batch limit");
  for(const call of params[0]){if(!call||call.methodName==="system.multicall")throw Error("Nested callback batch");validate(c,call.methodName,call.params,depth+1);}return;
 }
 if(["event","newDevices","deleteDevices","listDevices"].includes(method)){
  const iface=params[0];if(typeof iface!=="string"||!iface.startsWith("matter-homematic-"))throw Error("Invalid interface");
  const name=iface.slice(17);if(!Object.hasOwn(c.config.interfaces||{},name)&&!c.clients.has(name))throw Error("Unknown interface");
  if(c.config.interfaces?.[name]?.enabled===false)throw Error("Disabled interface");
 }
 if(method==="event"){
  const [,address,key,value]=params;if(params.length!==4||typeof address!=="string"||address.length>100||typeof key!=="string"||!/^[A-Z0-9_]{1,80}$/.test(key)||!["boolean","number","string"].includes(typeof value)||typeof value==="number"&&!Number.isFinite(value)||typeof value==="string"&&value.length>16384)throw Error("Invalid event");
 }
 if(method==="newDevices"||method==="deleteDevices"){
  if(!Array.isArray(params[1])||params[1].length>8192)throw Error("Invalid device list");
  for(const item of params[1]){const address=method==="newDevices"?item?.ADDRESS:item;if(typeof address!=="string"||address.length>100)throw Error("Invalid device address");}
 }
}
module.exports={safeXml,validate};
