'use strict';
const {deviceType,serialValid,localCredential}=require('./dyson-profile');
const HOST='https://appapi.cp.dyson.com';
const fail=(message,status=502)=>Object.assign(Error(message),{status});
class DysonCloud {
  constructor({fetchImpl=fetch}={}){this.fetch=fetchImpl;}
  async request(method,path,{data,token}={}){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try {
      const res=await this.fetch(HOST+path,{method,redirect:'error',signal:controller.signal,headers:{'User-Agent':'android client',...(data?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(data?{body:JSON.stringify(data)}:{})});
      if(res.status===429)throw fail('Dyson begrenzt Anfragen. Bitte später erneut versuchen.',429);
      if([400,401,403].includes(res.status))throw fail('Dyson hat die Anmeldung abgelehnt. Konto, Passwort und Code prüfen.',401);
      if(!res.ok)throw fail('Dyson-Dienst ist derzeit nicht verfügbar');
      let length=0;const chunks=[];
      for await(const chunk of res.body){length+=chunk.length;if(length>1048576){controller.abort();throw fail('Dyson-Antwort ist zu groß');}chunks.push(chunk);}
      try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail('Dyson hat keine gültigen Daten geliefert');}
    }catch(error){if(error.status)throw error;throw fail('Dyson konnte nicht erreicht werden. Internetverbindung prüfen.');}
    finally{clearTimeout(timer);}
  }
  async begin(email,country){
    if(typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof country!=='string'||!/^[A-Z]{2}$/.test(country)||country==='CN')throw fail('E-Mail-Adresse und Land prüfen',400);
    await this.request('GET','/v1/provisioningservice/application/Android/version');
    const status=await this.request('POST','/v3/userregistration/email/userstatus?country='+country,{data:{email}});
    if(status?.accountStatus!=='ACTIVE')throw fail('Das Dyson-Konto ist nicht aktiv',400);
    const result=await this.request('POST','/v3/userregistration/email/auth?country='+country+'&culture=en-US',{data:{email}});
    if(typeof result?.challengeId!=='string'||!result.challengeId||result.challengeId.length>512)throw fail('Dyson hat keinen gültigen Bestätigungsvorgang geliefert');
    return {email,country,challengeId:result.challengeId,expires:Date.now()+10*60000};
  }
  async finish(challenge,password,code){
    if(!challenge||!Number.isFinite(challenge.expires)||challenge.expires<Date.now())throw fail('Dyson-Anmeldung abgelaufen. Code erneut anfordern.',400);
    if(typeof password!=='string'||!password||password.length>256||typeof code!=='string'||!/^\d{4,12}$/.test(code))throw fail('Dyson-Passwort und Bestätigungscode erforderlich',400);
    const auth=await this.request('POST','/v3/userregistration/email/verify',{data:{email:challenge.email,password,challengeId:challenge.challengeId,otpCode:code}});
    if(auth?.tokenType!=='Bearer'||typeof auth.token!=='string'||!auth.token||auth.token.length>8192||/[\r\n]/.test(auth.token))throw fail('Dyson hat keinen gültigen Zugang bestätigt');
    await this.request('GET','/v1/provisioningservice/application/Android/version');
    const raw=await this.request('GET','/v2/provisioningservice/manifest',{token:auth.token});
    if(!Array.isArray(raw)||raw.length>100)throw fail('Ungültige Dyson-Geräteliste');
    const devices=[];let unsupported=0;const seen=new Set();
    for(const value of raw){const type=deviceType(value);if(!type||!serialValid(value.Serial)||!value.LocalCredentials){unsupported++;continue;}
      if(seen.has(value.Serial))throw fail('Dyson lieferte doppelte Gerätekennungen');seen.add(value.Serial);
      devices.push({id:value.Serial,type,name:typeof value.Name==='string'?value.Name.slice(0,64):'Dyson '+value.Serial,credential:localCredential(value.LocalCredentials)});
    }
    return {devices,unsupported};
  }
}
module.exports={DysonCloud,HOST};
