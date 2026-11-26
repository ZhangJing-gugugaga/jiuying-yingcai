const {define,api,fmt}=require('../../utils/page');
const SERVICE_LABELS={monthly_report:'经营月报',agency_reporting:'下级报送与催报',location_verification:'位置核验',service_fee:'服务费与账单',training:'培训资料',priority_support:'优先客服'};

function outletPicker(rows,selected){
 const outletOptions=[{id:'',label:'全部网点'},...rows.map(outlet=>({...outlet,label:fmt.outletOptionLabel(outlet)}))];
 if(selected&&!rows.some(row=>row.id===selected))outletOptions.unshift({id:null,label:'所选网点待核验'});
 return {outletOptions,outletIndex:Math.max(0,outletOptions.findIndex(row=>row.id===selected))};
}

const page=define({
 collections:[{name:'outlets',metadata(){
  this.setData(outletPicker(this.data.state.outlets,this.data.selectedOutlet));
 }},{name:'agreements',filters(){return this.agreementScope();}},'pricePlans'],
 data:{selectedOutlet:'',outletIndex:0,outletOptions:[],rows:[],agreementGroups:[],publishedPlans:[],expandedAgreement:'',expandedPlan:''},
 load(q){
  const selectedOutlet=q.outlet==='all'?'':q.outlet||'';
  this.setData({selectedOutlet,expandedAgreement:q.id||'',...outletPicker([],selectedOutlet)});
 },
 agreementScope(){return {outlet:this.data.selectedOutlet,id:this.query.id};},
 async selectOutlet(e){
  const selected=this.data.outletOptions[Number(e.detail.value)];
  if(!selected||selected.id===null)return;
  this.query={outlet:selected.id};
  this.setData({selectedOutlet:selected.id,expandedAgreement:''});
  await this.refresh();
 },
 toggleAgreement(e){
  const {id}=e.currentTarget.dataset;
  this.setData({expandedAgreement:this.data.expandedAgreement===id?'':id});
 },
 togglePlan(e){
  const {id}=e.currentTarget.dataset;
  this.setData({expandedPlan:this.data.expandedPlan===id?'':id});
 },
 async loaded(s){
  const outlets=new Map(s.outlets.map(outlet=>[outlet.id,outlet]));
  const plans=new Map(s.pricePlans.map(plan=>[plan.id,plan]));
  const currentMonth=s.today?.slice(0,7);
  const serial=this._serial;
  const exactId=this.query.id;
  let selectedOutlet=this.data.selectedOutlet,agreements=s.agreements;
  if(exactId){
   const agreement=agreements.find(row=>row.id===exactId)||await api.detail('agreements',exactId);
   if(serial!==this._serial)return;
   if(selectedOutlet&&agreement.outlet!==selectedOutlet)throw new Error('协议不属于所选网点，请从原入口重新打开。');
   selectedOutlet=agreement.outlet;
   agreements=[agreement];
  }
  if(selectedOutlet&&!outlets.has(selectedOutlet)){
   this.setData({rows:[],agreementGroups:[],publishedPlans:[]});
   const outlet=await api.detail('outlets',selectedOutlet).catch(error=>{
    throw new Error('暂无法核验所选网点，请重试或重新选择。',{cause:error});
   });
   if(serial!==this._serial)return;
   outlets.set(outlet.id,outlet);
  }
  const rows=agreements.map(agreement=>{
   const plan=agreement.planSnapshot||agreement.priceSnapshot||plans.get(agreement.planId)||{};
   const outlet=outlets.get(agreement.outlet);
   const amount=agreement.amount??agreement.planSnapshot?.amount??agreement.priceSnapshot?.amount??plan.amount;
   const start=fmt.monthText(agreement.startMonth),end=fmt.monthText(agreement.endMonth);
   let status=agreement.status;
   if(status==='active'&&currentMonth&&start&&end){
    if(agreement.startMonth>currentMonth)status='pending';
    else if(agreement.endMonth<currentMonth)status='expired';
   }
   return {...agreement,plan,isCurrent:status==='active',outletLabel:outlet?fmt.outletOptionLabel(outlet):agreement.outletName,
    amountText:amount==null?'':fmt.money(amount),
    serviceNames:(plan.services||[]).map(code=>SERVICE_LABELS[code]).filter(Boolean).join('、'),
    servicePeriod:start&&end?start+' 至 '+end:'',
    agreementStart:fmt.dateText(agreement.startOn),
    agreementEnd:fmt.dateText(agreement.endOn),
    billDay:Number.isInteger(agreement.billDay)&&agreement.billDay>=1&&agreement.billDay<=28?agreement.billDay:null,
    dueDay:Number.isInteger(agreement.dueDay)&&agreement.dueDay>=1&&agreement.dueDay<=28?agreement.dueDay:null,
    serviceUntil:fmt.dateText(outlet?.serviceUntil),
    statusText:fmt.label(status,'agreement'),statusTone:fmt.statusTone(status,'agreement')};
  });
  const agreementGroups=[
   {key:'active',title:'当前服务协议',rows:rows.filter(row=>row.isCurrent)},
   {key:'other',title:'其他协议',rows:rows.filter(row=>!row.isCurrent)},
  ];
  this.setData({rows,agreementGroups,selectedOutlet,...outletPicker([...outlets.values()],selectedOutlet),
   publishedPlans:s.pricePlans.filter(plan=>plan.status==='published')});
 }
});
Page({...page,async refresh(){
 this.setData({rows:[],agreementGroups:[],publishedPlans:[]});
 const pending=page.refresh.call(this);
 const serial=this._serial;
 await pending;
 if(serial!==this._serial||!this.data.error)return;
 const {selectedOutlet,outletOptions,outletIndex}=this.data;
 if(selectedOutlet&&outletOptions[outletIndex]?.id!==selectedOutlet){
  this.setData({error:'暂无法核验所选网点。请重试，或重新选择网点。'+this.data.error});
 }
}});
