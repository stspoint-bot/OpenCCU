'use strict';
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
function profile(device){
 let schema=device.schema;try{if(typeof schema==='string')schema=JSON.parse(schema);}catch{schema=[];}
 if(!Array.isArray(schema))return null;
 const find=codes=>{const dp=schema.find(d=>codes.includes(d.code)&&['rw','wr'].includes(String(d.mode).toLowerCase()));if(!dp||!Number.isInteger(Number(dp.id))||Number(dp.id)<1||Number(dp.id)>255)return null;return {...dp.property,id:String(dp.id),code:dp.code};};
 const on=find(['switch_led']),brightness=find(['bright_value_v2','bright_value']),color=find(['colour_data_v2','colour_data']),temperature=find(['temp_value_v2','temp_value']),mode=find(['work_mode']);
 if(!on||on.type!=='bool')return null;
 const numeric=dp=>dp&&dp.type==='value'&&Number.isFinite(dp.min)&&Number.isFinite(dp.max)&&dp.min>=0&&dp.max>dp.min&&dp.max<=10000;
 const validColor=color&&color.type==='string'&&mode&&Array.isArray(mode.range)&&mode.range.includes('colour');
 const validTemp=numeric(temperature)&&mode&&Array.isArray(mode.range)&&mode.range.includes('white');
 return {on,brightness:numeric(brightness)?brightness:null,color:validColor?color:null,temperature:validTemp?temperature:null,mode:mode||null,minKelvin:2700,maxKelvin:6500};
}
function hsvToRgb(h,s,v){const c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;let rgb=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];return rgb.map(a=>Math.round((a+m)*255));}
function decodeColor(raw,dp){
 if(typeof raw!=='string')return null;
 if(/^[a-f\d]{12}$/i.test(raw))return {hue:parseInt(raw.slice(0,4),16),saturation:parseInt(raw.slice(4,8),16)/10,brightness:parseInt(raw.slice(8,12),16)/10};
 if(/^[a-f\d]{14}$/i.test(raw))return {hue:parseInt(raw.slice(6,10),16),saturation:parseInt(raw.slice(10,12),16)/255*100,brightness:parseInt(raw.slice(12,14),16)/255*100};
 return null;
}
function encodeColor(h,s,v,dp){const hex=(n,len)=>Math.round(n).toString(16).padStart(len,'0');
 if(dp.format==='hsv12'||(!dp.format&&dp.code==='colour_data_v2'))return hex(h,4)+hex(s*10,4)+hex(v*10,4);
 return hsvToRgb(h,s/100,v/100).map(n=>hex(n,2)).join('')+hex(h,4)+hex(s/100*255,2)+hex(v/100*255,2);
}
function decode(dps,p){
 const state={};if(typeof dps[p.on.id]==='boolean')state.on=dps[p.on.id];
 const mode=dps[p.mode?.id];
 const observedColor=p.color&&decodeColor(dps[p.color.id],p.color);
 if(observedColor&&observedColor.hue<=360&&observedColor.saturation<=100&&observedColor.brightness<=100)state.colorFormat=dps[p.color.id].length===12?'hsv12':'rgb14';
 if(p.brightness&&Number.isFinite(dps[p.brightness.id]))state.brightness=clamp((dps[p.brightness.id]-p.brightness.min)/(p.brightness.max-p.brightness.min)*99+1,1,100);
 if(p.color&&(mode==='colour'||!mode)){const c=decodeColor(dps[p.color.id],p.color);if(c&&c.hue<=360&&c.saturation<=100&&c.brightness<=100)Object.assign(state,c,{mode:'colour'});}
 if(p.temperature&&Number.isFinite(dps[p.temperature.id]))state.kelvin=Math.round(p.minKelvin+clamp((dps[p.temperature.id]-p.temperature.min)/(p.temperature.max-p.temperature.min),0,1)*(p.maxKelvin-p.minKelvin));
 if(mode==='white')state.mode='white';return state;
}
function encode(command,p,state={}){
 const fail=()=>{throw Object.assign(Error('Ungültiger oder nicht unterstützter Lichtwert'),{status:400});};
 if(!command||typeof command!=='object'||Array.isArray(command)||!Object.keys(command).length||Object.keys(command).some(k=>!['on','brightness','hue','saturation','kelvin'].includes(k)))fail();
 for(const [key,value]of Object.entries(command)){if(key==='on'){if(typeof value!=='boolean')fail();}else if(typeof value!=='number'||!Number.isFinite(value))fail();}
 const dps={};if(Object.hasOwn(command,'on'))dps[p.on.id]=command.on;
 if(Object.hasOwn(command,'brightness')&&(command.brightness<1||command.brightness>100||(!p.brightness&&!p.color)))fail();
 const color=Object.hasOwn(command,'hue')||Object.hasOwn(command,'saturation');
 if(color&&(!p.color||Object.hasOwn(command,'kelvin')))fail();
 if(Object.hasOwn(command,'hue')&&(command.hue<0||command.hue>360))fail();if(Object.hasOwn(command,'saturation')&&(command.saturation<0||command.saturation>100))fail();
 if(color||(Object.hasOwn(command,'brightness')&&state.mode==='colour'&&p.color)){
 const hue=command.hue??state.hue,sat=command.saturation??state.saturation,bright=command.brightness??state.brightness;
 if(![hue,sat,bright].every(Number.isFinite))throw Object.assign(Error('Lichtstatus noch nicht bekannt; erneut abfragen'),{status:409});
 dps[p.mode.id]='colour';dps[p.color.id]=encodeColor(hue,sat,bright,{...p.color,format:state.colorFormat});
 }else if(Object.hasOwn(command,'brightness')){
 if(!p.brightness)fail();dps[p.brightness.id]=Math.round(p.brightness.min+(command.brightness-1)/99*(p.brightness.max-p.brightness.min));
 }
 if(Object.hasOwn(command,'kelvin')){
 if(!p.temperature||command.kelvin<p.minKelvin||command.kelvin>p.maxKelvin)fail();
 dps[p.mode.id]='white';dps[p.temperature.id]=Math.round(p.temperature.min+(command.kelvin-p.minKelvin)/(p.maxKelvin-p.minKelvin)*(p.temperature.max-p.temperature.min));
 }
 return dps;
}
module.exports={profile,decode,encode,encodeColor,decodeColor,hsvToRgb};
