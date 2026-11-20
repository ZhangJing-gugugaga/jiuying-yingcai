const api=require('../../utils/api');

const confirmationPending='正在确认支付结果，请稍后刷新。';
const paymentResults={success:'支付成功',failed:'支付未完成',closed:'支付未完成',cancelled:'已取消支付'};

function moneyFromCents(value){
 if(!Number.isSafeInteger(value))return '';
 const digits=String(Math.abs(value)).padStart(3,'0');
 const whole=digits.slice(0,-2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return (value<0?'-':'')+whole+'.'+digits.slice(-2);
}

function paymentScope(page,matches){
 const token=()=>typeof wx.getStorageSync==='function'?api.session()?.token:undefined;
 const serial=page._serial,initialToken=token();
 return ()=>!page._paymentHidden&&page._serial===serial&&initialToken===token()&&matches();
}

async function checkout(billId,attempt,onPending,isCurrent){
 const response=await api.prepay(billId);
 if(!isCurrent())return null;
 attempt.paymentId=response.paymentId;
 onPending({id:attempt.paymentId,billId,status:'pending'});
 try{
  await new Promise((resolve,reject)=>wx.requestPayment({...response.requestPayment,success:resolve,fail:reject}));
 }catch(error){
  attempt.notice=/cancel/i.test(error.errMsg||error.message||'')?'已取消支付':'支付未完成';
 }
 if(!isCurrent())return null;
 return api.queryPayment(attempt.paymentId);
}

function paymentNotice(payment,attempt={}){
 return paymentResults[payment?.status]||(attempt.notice?attempt.notice+'。':'')+confirmationPending;
}

module.exports={checkout,moneyFromCents,paymentNotice,paymentScope,confirmationPending,paymentResults};
