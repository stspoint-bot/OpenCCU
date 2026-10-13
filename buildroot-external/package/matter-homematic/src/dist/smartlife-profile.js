'use strict';
const light=require('./smartplus-light');
// Leistungsmessung (cur_power/cur_voltage/cur_current) nur mit bestätigtem Datenpunkt, passender Einheit und plausiblem Bereich; nie geraten. Strom in A wie bei Tasmota (Diagramme).
const meter=schema=>{const readings={};for(const [key,code,units,top]of [['power','cur_power',['','w'],100000],['voltage','cur_voltage',['','v'],1000],['current','cur_current',['','ma'],100000]]){const d=schema.find(d=>d&&d.code===code),f=d&&d.property;if(!f||f.type!=='value'||!Number.isInteger(Number(d.id))||Number(d.id)<1||Number(d.id)>255||!Number.isFinite(f.min)||!Number.isFinite(f.max)||f.min<0||f.max<=f.min||!Number.isInteger(f.scale||0)||(f.scale||0)<0||(f.scale||0)>3||f.max/10**(f.scale||0)>top||!units.includes(String(f.unit||'').toLowerCase()))continue;readings[key]=key==='current'?{...f,id:String(d.id),code,scale:(f.scale||0)+3,unit:'A'}:{...f,id:String(d.id),code};}return Object.keys(readings).length?readings:null;};
function profile(device){
  if(!device||typeof device!=='object'||Array.isArray(device)||device.unsupported)return null;
  if(['wsdcg','xbx'].includes(device.category)&&Array.isArray(device.schema)){
    const field=(code,writable=false)=>{const d=device.schema.find(d=>d&&d.code===code&&(!writable||d.mode==='rw'));return d&&Number.isInteger(Number(d.id))&&Number(d.id)>=1&&Number(d.id)<=255?{...d.property,id:String(d.id),code:d.code}:null;};
    const numeric=f=>f&&f.type==='value'&&Number.isFinite(f.min)&&Number.isFinite(f.max)&&f.min<f.max&&Number.isInteger(f.scale||0)&&(f.scale||0)>=0&&(f.scale||0)<=3;
    if(device.category==='wsdcg'){
      const temperature=field('va_temperature')||field('temp_current'),humidity=field('va_humidity')||field('humidity_value');
      if(!numeric(temperature)||['f','°f','℉'].includes(String(temperature.unit||'').toLowerCase()))return null;
      if(temperature.min/10**(temperature.scale||0)<-273.15||temperature.max/10**(temperature.scale||0)>327.67)return null;
      const readings={temperature};if(numeric(humidity)&&humidity.min>=0&&humidity.max/10**(humidity.scale||0)<=100)readings.humidity=humidity;
      return {kind:'sensor',on:null,readings,brightness:null,color:null,temperature:null,mode:null};
    }
    const on=field('switch',true);if(on?.type!=='bool')return null;
    const extra={};for(const [key,code]of Object.entries({leftTarget:'l_temp_set',rightTarget:'r_temp_set',leftTemperature:'l_temp_current',rightTemperature:'r_temp_current'})){const f=field(code,key.endsWith('Target'));if(numeric(f))extra[key]=f;}
    return {kind:'cooler',on,extra,brightness:null,color:null,temperature:null,mode:null};
  }
  const lighting=light.profile(device);if(lighting)return {...lighting,kind:'light'};
  if(!['cz','kg','pc'].includes(device.category)||!Array.isArray(device.schema))return null;
  const switches=device.schema.filter(d=>/^switch(?:_\d+)?$/.test(d.code)&&d.property?.type==='bool'&&['rw','wr'].includes(d.mode));
  // A multi-outlet strip must not be silently reduced to its first switch.
  if(switches.length!==1)return null;
  const dp=switches[0];if(!Number.isInteger(dp.id)||dp.id<1||dp.id>255)return null;
  const readings=meter(device.schema),usbs=device.schema.filter(d=>/^switch_usb\d*$/.test(d.code)&&d.property?.type==='bool'&&['rw','wr'].includes(d.mode)),usb=usbs.length===1&&Number.isInteger(usbs[0].id)&&usbs[0].id>=1&&usbs[0].id<=255?{id:String(usbs[0].id),code:usbs[0].code,type:'bool'}:null; // eigener USB-Schalter (genau einer, sonst keiner)
  return {kind:device.category==='kg'?'switch':'plug',on:{id:String(dp.id),code:dp.code,type:'bool'},...(readings?{readings}:{}),...(usb?{usb}:{}),brightness:null,color:null,temperature:null,mode:null,minKelvin:2700,maxKelvin:6500};
}
module.exports={profile};
