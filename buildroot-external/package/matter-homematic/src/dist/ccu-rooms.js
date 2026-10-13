'use strict';
// Räume (seit 12.10.2026 eigene Räume der Bridge, siehe raeume.js): gleiche Schnittstelle wie bisher (read/change/apply),
// damit Räume-Seite, Geräteseite, Jeep und Automationen unverändert weiterarbeiten. Die CCU (ReGa) wird nur noch einmal
// für die Übernahme gelesen (READ) und nie mehr beschrieben.
const decode=s=>s.replace(/%([0-9a-f]{2})/gi,(_,x)=>String.fromCharCode(parseInt(x,16)));
const quote=s=>{if(typeof s!=='string'||!s.trim()||s.length>64||['__proto__','prototype','constructor'].includes(s)||/[\x00-\x1f\x7f-\x9fĀ-￿]/.test(s))throw Object.assign(Error('Raumname muss 1–64 Zeichen enthalten (CCU-Zeichensatz Latin-1)'),{status:400});return '"'+s.trim().replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';};
const READ='! MH_ROOMS_READ\nWrite("{\\"rooms\\":[");string rid;boolean first=true;foreach(rid,dom.GetObject(ID_ROOMS).EnumUsedIDs()){object r=dom.GetObject(rid);if(r){if(!first){Write(",");}first=false;Write("{\\"id\\":" # rid # ",\\"name\\":\\"" # r.Name().UriEncode() # "\\",\\"channelIds\\":[");string cid;boolean cf=true;foreach(cid,r.EnumUsedIDs()){if(!cf){Write(",");}cf=false;Write(cid);}Write("]}");}}Write("],\\"channels\\":[");string did;boolean df=true;foreach(did,root.Devices().EnumUsedIDs()){object d=dom.GetObject(did);if(d){string chid;foreach(chid,d.Channels().EnumUsedIDs()){object c=dom.GetObject(chid);if(c){if(!df){Write(",");}df=false;Write("{\\"id\\":" # chid # ",\\"address\\":\\"" # c.Address().UriEncode() # "\\"}");}}}}Write("]}");';
class CcuRooms {
  constructor(connector) { this.connector=connector; this.busy=false; }
  async read() { const R=require('./raeume'); return R.view(await R.ensure(this.connector),this.connector); }
  async change(method,p) {
    if(this.busy) throw Object.assign(Error('Raumänderung läuft bereits'),{status:409});
    this.busy=true;
    try { const R=require('./raeume'); return R.view(await R.change(this.connector,method,p),this.connector); }
    finally { this.busy=false; }
  }
  apply(data,devices,channels) {
    const names=new Map(),addresses=new Map(data.channels.map(c=>[c.address,c.id]));
    for(const r of data.rooms) for(const id of r.channelIds) if(!names.has(id)) names.set(id,r.name);
    for(const collection of [devices,channels]) for(const [address,item] of collection) item.room=names.get(addresses.get(address))||'';
  }
}
module.exports={CcuRooms,READ,quote,decode};
