'use strict';
const path=require('node:path');
const {Vault}=require('./smartplus');
const {JeepService}=require('./jeep-service');
// Thomas authorized persistent credentials and automatic restart login.
// Store only in the existing AES-256-GCM vault; never return secrets in status.
class JeepConnection {
 constructor(service,vault,{now=Date.now}={}) {
  this.service=service;this.vault=vault;this.now=now;this.stopped=false;
  this.retryAt=0;this.failures=0;this.blocked=false;this.pending=null;
  this.timer=setInterval(()=>this.restore().catch(()=>{}),60000);this.timer.unref();
 }
 async restore() {
  if(this.stopped||this.blocked||this.pending||this.service.busy||this.service.connected||this.now()<this.retryAt)return;
  let secret;
  try{secret=this.vault.read();}catch{this.blocked=true;this.service.error='Gespeicherter Jeep-Zugang nicht lesbar. Bitte erneut anmelden.';return;}
  if(typeof secret.email!=='string'||typeof secret.password!=='string'||!secret.email||!secret.password)return;
  this.service.passwordStored=true;
  this.pending=this.service.login(secret.email,secret.password);
  secret.password='';secret=null;
  try{await this.pending;this.failures=0;}
  catch(error){
   if(error.status===401||error.status===403){this.blocked=true;this.service.error='Jeep verlangt eine erneute Anmeldung oder Kontobestätigung.';}
   else {this.failures++;this.retryAt=this.now()+Math.min(1800000,60000*2**Math.min(this.failures,5));this.service.error='Jeep derzeit nicht erreichbar. Die Anmeldung wird automatisch erneut versucht.';}
  }finally{this.pending=null;}
 }
 save(email,password) {
  this.blocked=true; // Do not retry an old account if writing a replacement fails.
  this.vault.write({email,password});this.service.passwordStored=true;
  this.blocked=false;this.failures=0;this.retryAt=0;
 }
 logout() {
  this.vault.write({});this.blocked=true;this.service.passwordStored=false;
  return this.service.logout();
 }
 stop(){this.stopped=true;clearInterval(this.timer);this.service.logout();}
}
const connections=new Map();
function source(configPath,service) {
 const id=path.resolve(configPath);let connection=connections.get(id);
 if(!connection||connection.stopped){connection=new JeepConnection(service||new JeepService(),new Vault(path.join(path.dirname(id),'jeep-secrets.json')));connections.set(id,connection);}
 return connection;
}
function ensure(web) {
 if(!web.jeepConnection){
  web.jeepConnection=source(web.deps.configPath,web.jeepService);
  web.jeepService=web.jeepConnection.service;
 }
 return web.jeepConnection;
}
module.exports={JeepConnection,ensure,source};
