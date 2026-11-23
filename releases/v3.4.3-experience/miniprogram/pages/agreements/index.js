const {define,fmt}=require('../../utils/page');

Page(define({
 collections:['outlets','agreements','pricePlans'],
 data:{rows:[],publishedPlans:[]},
 loaded(s){
  const outlets=new Map(s.outlets.map(outlet=>[outlet.id,outlet]));
  const plans=new Map(s.pricePlans.map(plan=>[plan.id,plan]));
  const currentMonth=s.today?.slice(0,7);
  const rows=s.agreements.map(agreement=>{
   const plan=agreement.planSnapshot||agreement.priceSnapshot||plans.get(agreement.planId)||{};
   const outlet=outlets.get(agreement.outlet);
   const amount=agreement.amount??agreement.planSnapshot?.amount??agreement.priceSnapshot?.amount??plan.amount;
   const start=fmt.monthText(agreement.startMonth),end=fmt.monthText(agreement.endMonth);
   let status=agreement.status;
   if(status==='active'&&currentMonth&&start&&end){
    if(agreement.startMonth>currentMonth)status='pending';
    else if(agreement.endMonth<currentMonth)status='expired';
   }
   return {...agreement,plan,amountText:amount==null?'':fmt.money(amount),
    servicePeriod:start&&end?start+' 至 '+end:'',
    agreementStart:fmt.dateText(agreement.startOn),
    agreementEnd:fmt.dateText(agreement.endOn),
    billDay:Number.isInteger(agreement.billDay)&&agreement.billDay>=1&&agreement.billDay<=28?agreement.billDay:null,
    dueDay:Number.isInteger(agreement.dueDay)&&agreement.dueDay>=1&&agreement.dueDay<=28?agreement.dueDay:null,
    serviceUntil:fmt.dateText(outlet?.serviceUntil),
    statusText:fmt.label(status,'agreement'),statusTone:fmt.statusTone(status,'agreement')};
  });
  this.setData({rows,publishedPlans:s.pricePlans.filter(plan=>plan.status==='published')});
 }
}));
