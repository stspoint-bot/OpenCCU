'use strict';
// An off command supersedes previously queued speed/auto commands.
function merge(previous,input){
 if(input.on===false)return {...input};
 if(previous.on===false&&input.on!==true){const safe={...previous,...input,on:false};delete safe.speed;delete safe.auto;return safe;}
 const next={...previous,...input};
 if(Object.hasOwn(input,'speed')){delete next.auto;if(next.on===false)delete next.on;}
 if(Object.hasOwn(input,'auto')){delete next.speed;if(next.on===false)delete next.on;}
 if(previous.on===false&&input.on===undefined&&!Object.hasOwn(input,'speed')&&!Object.hasOwn(input,'auto'))next.on=false;
 return next;
}
module.exports={merge};
