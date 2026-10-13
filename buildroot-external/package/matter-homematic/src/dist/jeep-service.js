'use strict';
const {JeepCloud,fail}=require('./jeep-cloud');
class JeepService{
 constructor({createClient=()=>new JeepCloud(),clock=()=>Date.now()}={}){this.createClient=createClient;this.clock=clock;this.client=null;this.connected=false;this.rows=[];this.lastAttempt=0;this.lastFetched=null;this.busy=false;this.error=null;this.generation=0;this.timer=null;}
 public({settled=false}={}){return {connected:this.connected,busy:this.busy&&!settled,vehicles:this.rows.map(({sources,details,...r})=>({...r,dataAvailable:!!details,stale:r.stale||!r.vehicleUpdatedAt||this.clock()-Date.parse(r.vehicleUpdatedAt)>900000})),lastFetchedAt:this.lastFetched,error:this.error,readOnly:true,passwordStored:this.passwordStored===true};}
 detail(vin){const row=this.rows.find(r=>r.vin===vin);if(!row)throw fail('Fahrzeug gehört nicht zur angemeldeten Sitzung',404);const d=row.details||{sources:row.sources||{},...require('./jeep-data').catalog(row.sources||{}),fetchedAt:row.fetchedAt};return {...d,sources:Object.fromEntries(Object.entries(d.sources).map(([k,{data,...meta}])=>[k,meta]))};}
 async loadDetails(vin){
  const row=this.rows.find(r=>r.vin===vin);if(!this.connected||!row)throw fail('Fahrzeug gehört nicht zur angemeldeten Sitzung',404);
  if(this.busy||this.clock()-(row.lastDetailsAttempt||0)<300000)throw fail('Weitere Daten höchstens alle fünf Minuten abrufen',429);
  this.busy=true;row.lastDetailsAttempt=this.clock();const generation=this.generation;
  try{const details=await this.client.details(row);if(generation!==this.generation)throw fail('Jeep-Verbindung wurde beendet',401);row.details=details;return this.detail(vin);}
  catch(e){if(generation===this.generation){this.error=e.status?e.message:'Weitere Fahrzeugdaten nicht abrufbar';if(e.status===401){this.client.close();this.client=null;this.connected=false;clearInterval(this.timer);this.timer=null;this.rows=this.rows.map(r=>({...r,stale:true}));}}throw e;}
  finally{this.busy=false;}
 }
 logout(){this.generation++;this.client?.close();this.client=null;this.connected=false;this.rows=[];this.lastFetched=null;this.error=null;clearInterval(this.timer);this.timer=null;return this.public();}
 async login(email,password){
  if(this.busy)throw fail('Jeep-Anmeldung oder Abfrage läuft bereits',429);
  this.logout();this.busy=true;const generation=this.generation,client=this.createClient();this.client=client;
  try{
   await client.login(email,password);const rows=await client.vehicles();
   if(generation!==this.generation)throw fail('Jeep-Anmeldung wurde beendet',401);
   this.rows=rows;this.connected=true;this.lastFetched=new Date(this.clock()).toISOString();this.lastAttempt=this.clock();
   this.timer=setInterval(()=>{if(this.connected&&!this.busy&&this.clock()-this.lastAttempt>=300000)this.refresh().catch(()=>{});},60000);this.timer.unref();return this.public({settled:true});
  }catch(e){if(generation===this.generation){this.logout();this.error=e.status?e.message:'Jeep-Anmeldung fehlgeschlagen';}throw e;}
  finally{this.busy=false;password='';}
 }
 async refresh(){
  if(!this.connected||!this.client)throw fail('Bitte zuerst mit dem Jeep-Konto anmelden',401);
  if(this.busy||this.clock()-this.lastAttempt<30000)throw fail('Bitte mindestens 30 Sekunden zwischen Abfragen warten',429);
  this.busy=true;this.lastAttempt=this.clock();const generation=this.generation;
  try{const rows=await this.client.vehicles();if(generation!==this.generation)throw fail('Jeep-Verbindung wurde beendet',401);for(const row of rows){const old=this.rows.find(r=>r.vin===row.vin);if(old?.details){const sources={...old.details.sources,...row.sources};row.details={...old.details,sources,...require('./jeep-data').catalog(sources)};}row.lastDetailsAttempt=old?.lastDetailsAttempt;}this.rows=rows;this.lastFetched=new Date(this.clock()).toISOString();this.error=null;return this.public({settled:true});}
  catch(e){if(generation===this.generation){this.error=e.status?e.message:'Jeep-Abfrage fehlgeschlagen';if(e.status===401){this.client.close();this.client=null;this.connected=false;clearInterval(this.timer);this.timer=null;}this.rows=this.rows.map(r=>({...r,stale:true}));}throw e;}
  finally{this.busy=false;}
 }
}
module.exports={JeepService};
