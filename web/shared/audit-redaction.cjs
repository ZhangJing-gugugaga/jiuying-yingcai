'use strict';

function safeNote(value){
 if(typeof value!=='string')return '';
 return value.slice(0,2000)
  .replace(/(?<!\d)(1\d{2})\d{4}(\d{4})(?!\d)/g,'$1****$2')
  .replace(/(?<!\d)\d{17}[\dXx](?!\d)/g,'[证件号码已脱敏]')
  .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g,'[电子邮箱已脱敏]')
  .replace(/\bBearer\s+[\w.~-]+/gi,'Bearer [已脱敏]')
  .replace(/((?:api[_ -]?key|access[_ -]?token|password|密钥|密码|令牌)\s*[:=：]\s*)[^\s，；,;]+/gi,'$1[已脱敏]');
}

module.exports={safeNote};
