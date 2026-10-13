'use strict';
const fs=require('node:fs'),{atomicJson}=require('./web-security');
const NAME='TSPoint-Bridge';
function migrateBridgeName(file){
 if(!fs.existsSync(file))return;
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Ungültige Bridge-Konfiguration');
 if(config.bridge?.name===NAME)return;
 fs.copyFileSync(file,file+'.bak-bridge-name-'+Date.now(),fs.constants.COPYFILE_EXCL);
 config.bridge={...(config.bridge||{}),name:NAME};atomicJson(file,config);
}
module.exports={NAME,migrateBridgeName};
