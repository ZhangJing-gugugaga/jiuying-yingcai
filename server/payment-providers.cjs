'use strict';

const {check} = require('../shared/core.cjs');
const {wechatPay} = require('./wechat-pay.cjs');
const {alipayAdapter} = require('./alipay.cjs');

function mockAdapter(enabled, channel) {
 const merchantId='local-simulation-'+channel, appId='local-test-'+channel;
 return {
  ready:enabled, merchantId, appId, gatewayEnvironment:'mock',
  config() { check(enabled,'MOCK_DISABLED','当前环境禁止模拟支付',403); },
  clientParams() { return {}; },
  async prepay() { return {prepayId:'simulation'}; },
  trade(order,state='NOTPAY') {
   return {out_trade_no:order.out_trade_no, trade_state:state, transaction_id:'mock-'+order.out_trade_no,
    trade_type:channel==='wechat'?'JSAPI':'WAP', success_time:new Date().toISOString(), appid:appId, mchid:merchantId,
    amount:{total:order.amount_cents,currency:order.currency}};
  },
  refundResult(refund,order,state) {
   return {id:refund.id,tradeNo:order.out_trade_no,reference:state==='success'?'mock-refund-'+refund.id:undefined,
    amount:refund.amount_cents,currency:refund.currency,state,merchantId,appId};
  }
 };
}

function paymentProviders(env,fetcher) {
 const mock = env.NODE_ENV !== 'production' && (!env.ADAPTER_MODE || env.ADAPTER_MODE === 'mock');
 const wechat = {...wechatPay(env,fetcher),merchantId:env.WECHAT_MCH_ID,appId:env.WECHAT_APP_ID};
 return {real:{wechat,alipay:alipayAdapter(env,fetcher)},mock:{wechat:mockAdapter(mock,'wechat'),alipay:mockAdapter(mock,'alipay')}};
}

module.exports = {paymentProviders};
