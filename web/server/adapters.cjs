'use strict';
const {fail}=require('../shared/core.cjs');
function adapters(env){const mode=env.ADAPTER_MODE||'mock';if(!['mock','real','disabled'].includes(mode))throw new Error('ADAPTER_MODE须为mock、real或disabled');if(env.NODE_ENV==='production'&&mode==='mock')throw new Error('生产 production 禁止Mock适配器');
 return {mode,assertCommand(command){if(command.startsWith('payment.')&&mode!=='mock')fail('REAL_ADAPTER_UNAVAILABLE','模拟付款命令仅开发模式可用；真实资金须通过已配置的服务端支付接口核验',503);},wechatLogin(){fail('REAL_ADAPTER_UNAVAILABLE','真实微信身份适配器未配置，未生成登录会话',503);},notify(){return mode==='mock'?{mode:'in_app',deliveredExternally:false}:fail('REAL_ADAPTER_UNAVAILABLE','真实订阅消息适配器未配置',503);},geocode(){fail('REAL_ADAPTER_UNAVAILABLE','运行时地理编码服务未配置；不伪造地图结果',503);}};
}
module.exports={adapters};
