'use strict';
const crypto=require('node:crypto');
const ENDPOINTS=Object.freeze({eu:'https://openapi.tuyaeu.com','eu-west':'https://openapi-weaz.tuyaeu.com',us:'https://openapi.tuyaus.com','us-east':'https://openapi-ueaz.tuyaus.com',cn:'https://openapi.tuyacn.com',in:'https://openapi.tuyain.com',sg:'https://openapi-sg.iotbing.com'});
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(id);
function validateCredentials(p){
  if(!p||Object.keys(p).some(k=>!['accessId','accessSecret','uid','region'].includes(k))||typeof p.accessId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(p.accessId)||typeof p.accessSecret!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(p.accessSecret)||!validId(p.uid)||!Object.hasOwn(ENDPOINTS,p.region))throw Object.assign(Error('Tuya Access ID, Access Secret, verknüpfte App-UID und Rechenzentrum prüfen'),{status:400});
}
function signature({accessId,accessSecret,token='',timestamp,nonce,path,method='GET',body=''}){
  const hash=crypto.createHash('sha256').update(body).digest('hex');
  const toSign=method+'\n'+hash+'\n\n'+path;
  return crypto.createHmac('sha256',accessSecret).update(accessId+token+timestamp+nonce+toSign).digest('hex').toUpperCase();
}
function schemaFromSpecifications(spec){
  if(!spec||typeof spec!=='object'||Array.isArray(spec))return [];
  if(spec.functions!==undefined&&(!Array.isArray(spec.functions)||spec.functions.length>255))throw Error('Ungültige Tuya-Funktionsliste');
  if(Array.isArray(spec.status)&&spec.status.length>255)throw Error('Tuya-Statusliste zu groß');
  const used=new Set();
  return [...(spec.functions||[]).map(dp=>({...dp,mode:'rw'})),...(Array.isArray(spec.status)?spec.status.map(dp=>({...dp,mode:'ro'})):[])].flatMap(dp=>{
    const id=Number(dp.dp_id??dp.dpId),type={Boolean:'bool',Integer:'value',Enum:'enum',String:'string',Json:'string',bool:'bool',value:'value',enum:'enum',string:'string'}[dp.type];
    if(!Number.isInteger(id)||id<1||id>255||used.has(id)||!type||typeof dp.code!=='string')return [];
    let values;try{values=typeof dp.values==='string'?JSON.parse(dp.values):dp.values;}catch{return [];}
    if(values===undefined)values={};
    if(!values||typeof values!=='object'||Array.isArray(values))return [];
    used.add(id);
    // The cloud instruction set establishes write access. IDs come from Tuya;
    // never infer LAN DP numbers from the order of functions or example devices.
    return [{id,code:dp.code,mode:dp.mode,property:{min:values.min,max:values.max,step:values.step,scale:values.scale,unit:values.unit,range:values.range,type}}];
  });
}
class SmartlifeCloud{
  constructor({fetchImpl=fetch,now=Date.now,nonce=()=>crypto.randomUUID(),signal}={}){this.fetch=fetchImpl;this.now=now;this.nonce=nonce;this.signal=signal;this.credentials=null;this.token=null;}
  async request(path){
    if(!this.credentials||!path.startsWith('/v1.')||/[\r\n]/.test(path))throw Error('Ungültige Tuya-Anfrage');
    if(this.now()>=this.deadline)throw Error('Smart-Life-Übernahme hat zu lange gedauert; erneut versuchen');
    const {accessId,accessSecret,region}=this.credentials,timestamp=String(this.now()),nonce=this.nonce(),token=this.token||'';
    const headers={client_id:accessId,t:timestamp,nonce,sign_method:'HMAC-SHA256',sign:signature({accessId,accessSecret,token,timestamp,nonce,path})};if(token)headers.access_token=token;
    const timeout=AbortSignal.timeout(Math.max(1,Math.min(12000,this.deadline-this.now())));
    let response;try{response=await this.fetch(ENDPOINTS[region]+path,{method:'GET',redirect:'error',headers,signal:this.signal?AbortSignal.any([this.signal,timeout]):timeout});}catch{throw Error('Tuya-Dienst nicht erreichbar; Rechenzentrum und Verbindung prüfen');}
    if(!response.ok)throw Error('Tuya-Dienst meldet HTTP '+response.status);
    if(!response.body)throw Error('Leere Tuya-Antwort');
    const reader=response.body.getReader(),chunks=[];let length=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2097152)throw Error('Tuya-Antwort zu groß');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
    let data;try{data=JSON.parse(Buffer.concat(chunks).toString());}catch{throw Error('Ungültige Tuya-Antwort');}
    if(!data||data.success!==true){const code=String(data?.code||'UNKNOWN').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40);throw Object.assign(Error('Tuya-Abfrage fehlgeschlagen ('+code+'). Projektberechtigungen, Kontoverknüpfung und Rechenzentrum prüfen.'),{code});}
    return data.result;
  }
  async discover(credentials){
    validateCredentials(credentials);
    // An instance owns one token; overlapping imports must not overwrite it.
    if(this.credentials)throw Object.assign(Error('Smart-Life-Übernahme läuft bereits'),{status:429});
    this.credentials={...credentials};this.deadline=this.now()+240000;
    try{
      const session=await this.request('/v1.0/token?grant_type=1');
      if(typeof session?.access_token!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(session.access_token))throw Error('Ungültige Tuya-Sitzung');this.token=session.access_token;
      const found=new Map();
      for(let page=1;page<=4;page++){
        const list=await this.request('/v1.0/users/'+encodeURIComponent(credentials.uid)+'/devices?from=home&page_no='+page+'&page_size=50');
        if(!Array.isArray(list)||list.length>128)throw Error('Ungültige Smart-Life-Geräteliste');
        let added=0;
        for(const device of list){if(!validId(device?.id)||found.has(device.id))continue;if(found.size>=128)throw Error('Maximal 128 Smart-Life-Geräte');found.set(device.id,device);added++;}
        if(list.length<50)break;
        if(!added||page===4)throw Error('Smart-Life-Geräteliste konnte nicht vollständig gelesen werden');
      }
      const devices=[];
      for(const item of found.values()){
        if(item.sub===true){devices.push({devId:item.id,name:item.name,unsupported:'Zigbee-/Bluetooth-Untergerät benötigt ein Gateway'});continue;}
        const detail=typeof item.local_key==='string'?item:await this.request('/v1.0/devices/'+encodeURIComponent(item.id));
        if(detail?.sub===true||typeof detail?.local_key!=='string'||!/^[\x20-\x7e]{16}$/.test(detail.local_key)){devices.push({devId:item.id,name:item.name,unsupported:'Kein lokaler WLAN-Geräteschlüssel verfügbar'});continue;}
        const spec=await this.request('/v1.1/devices/'+encodeURIComponent(item.id)+'/specifications');
        if(!spec||typeof spec!=='object'||Array.isArray(spec))throw Error('Ungültige Tuya-Gerätespezifikation');
        devices.push({devId:item.id,name:detail.name||item.name,online:detail.online===true,category:spec.category||detail.category,localKey:detail.local_key,schema:schemaFromSpecifications(spec)});
      }
      return devices;
    }finally{this.token=null;if(this.credentials)this.credentials.accessSecret='';this.credentials=null;}
  }
}
module.exports={SmartlifeCloud,ENDPOINTS,signature,schemaFromSpecifications,validateCredentials};
