'use strict';
const crypto=require('node:crypto');
// Matter Basic Information strings are limited to 32 bytes. Do not split UTF-8.
function text(value,maxBytes=32){let result='',size=0;for(const char of String(value??'')){const bytes=Buffer.byteLength(char);if(size+bytes>maxBytes)break;result+=char;size+=bytes;}return result;}
// Preserve existing short serials; hash longer values without changing endpoint IDs.
function serial(value){const original=String(value);return Buffer.byteLength(original)<=32?original:crypto.createHash('sha256').update(original).digest('hex').slice(0,32);}
module.exports={text,serial};
