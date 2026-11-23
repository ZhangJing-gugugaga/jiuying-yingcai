const api=require('./api');const fmt=require('./format');
const {track}=require('./track');
const {go,reLaunch,requiresMember,memberLoginUrl,isTabPage,syncTabBar,nativeSessionLoginUrl}=require('./navigation');
const publicPages = new Set(['home', 'outlets', 'outlet', 'support', 'profile', 'discover', 'service-detail', 'messages']);
const targets={
 report:'report',report_missing:'report',report_returned:'report',exemption_review:'report',reports:'reports',
 bills:'fees',fees:'fees',billing:'fees',bill_unpaid:'fees',bill_overdue:'fees',
 location:'location',location_missing:'location',requests:'requests',support:'support',support_sla:'support',
 agreements:'agreements',refundRequests:'finance',invoiceRequests:'finance',offlinePayments:'finance',
 metric_anomaly:'dashboard',no_data:'dashboard',dashboard:'dashboard',outlets:'outlet',outlet:'outlet',cooperation:'discover',
 training:'training',training_material_returned:'training',join:'join'
};
function canOpenRecord(record){return !record.linkUnavailable&&record.title!=='消费者投诉待协助核实'&&(!!record.taskId||Object.hasOwn(targets,record.target||record.kind||record.type));}
function pageName(page) {
 const route = page.route || (typeof getCurrentPages === 'function' ? getCurrentPages().at(-1)?.route : '');
 return route?.split('/')[1] || '';
}
function redirectBeforeLoad(page, url, session, isPublic) {
 if(page._loadScope){
  page._serial=(page._serial||0)+1;
  page._loadScope=null;
  page.setData({loading:false,hasLoaded:false,state:null,pagers:{},session,isPublic});
 }
 reLaunch(url);
}
function define(options){const specs=(options.collections||[]).map(c=>typeof c==='string'?{name:c}:c);return {
  data:{busy:false,loading:false,hasLoaded:false,error:'',state:null,session:null,isPublic:false,pagers:{},outletSearch:'',...options.data},
  onLoad(query){this.query=query||{};if(options.load)options.load.call(this,query||{});},
  async onShow(){
    const name = pageName(this);
    const current = api.session();
    syncTabBar(this, current);
    const nativeLogin = nativeSessionLoginUrl(current);
    if (nativeLogin) return redirectBeforeLoad(this, nativeLogin, null, false);
    const pending = isTabPage(name) ? wx.getStorageSync('jyyc.route.' + name) : null;
    if (pending) {
      wx.removeStorageSync('jyyc.route.' + name);
      this.query = pending;
      options.load?.call(this, pending);
    }
    const query = this.query || {};
    const visitor = !current || current.role === 'public';
    const redirect = name === 'reports' && visitor ? '/pages/home/index' :
      requiresMember(name, query) && visitor ? memberLoginUrl(name, query) :
      !current && !publicPages.has(name) ? '/pages/login/index' : '';
    if (redirect) return redirectBeforeLoad(this, redirect, current, visitor);
    if(name==='home')track('open_home','opened');
    await this.refresh();
  },
  onUnload(){this._serial=(this._serial||0)+1;this._mutation=null;options.onUnload?.call(this);},
  async onPullDownRefresh(){try{await this.refresh();}finally{wx.stopPullDownRefresh?.();}},
  async refresh(){
    const current=api.session();
    const nativeLogin=nativeSessionLoginUrl(current);
    if(nativeLogin)return redirectBeforeLoad(this,nativeLogin,null,false);
    const serial=(this._serial||0)+1;
    this._serial=serial;
    const scope=JSON.stringify([current?.role==='public'?'':current?.token||'',current?.role==='public'?'':current?.role||'',this.query?.scope||'']);
    const scopeChanged=this._loadScope&&this._loadScope!==scope;
    this._loadScope=scope;
    this.setData({loading:true,error:'',session:current,
      ...(scopeChanged?{hasLoaded:false,state:null,pagers:{},isPublic:!current||current.role==='public'}:{})});
    try{
    if (!current && publicPages.has(pageName(this))) {
      this.setData({ isPublic: true });
      const session = await api.ensureVisitor();
      if (serial !== this._serial) return;
      const nativeLogin = nativeSessionLoginUrl(api.session());
      if (nativeLogin) return redirectBeforeLoad(this, nativeLogin, null, false);
      this.setData({ session });
    }
    const meta=await api.request(options.summary?'/api/state':'/api/context','GET',undefined,{},true,this);if(serial!==this._serial)return;
    this.setData({state:fmt.decorate(meta),session:api.session(),isPublic:meta.actor==='public',pagers:{}});
    syncTabBar(this, this.data.session);
    if(options.summary){if(options.loaded)await options.loaded.call(this,this.data.state);}
    else {for(const spec of specs){
        if(spec.visible&&!spec.visible.call(this))continue;
        await this.fetchCollection(spec.name,true,serial,false);
        if(serial!==this._serial)return;
        const selected=this.query.outlet;
        if(spec.name==='outlets'&&this.query.scope!=='public'&&!this.data.isPublic&&selected&&selected!=='all'&&!this.data.state.outlets.some(x=>x.id===selected)){
          const item=await api.detail('outlets',selected);
          if(serial!==this._serial)return;
          this.setData({state:fmt.decorate({...this.data.state,outlets:[item,...this.data.state.outlets]})});
        }
      }
      if(options.loaded)await options.loaded.call(this,this.data.state);
    }
    }catch(e){if(serial===this._serial)this.setData({error:e.message});}
    finally{if(serial===this._serial)this.setData({loading:false,...(!this.data.error?{hasLoaded:true}:{})});}
  },
  async fetchCollection(name,reset=false,serial=this._serial,notify=true){const spec=specs.find(x=>x.name===name);if(!spec)return;const prior=this.data.pagers[name];if(!reset&&(prior?.loading||prior&&!prior.hasMore))return;
    const errorKey=spec.errorKey||'error';
    this.setData({['pagers.'+name]:{...prior,loading:true}});try{const filters=typeof spec.filters==='function'?spec.filters.call(this):spec.filters||{};const offset=reset?0:prior?.nextOffset||0;const result=await api.collection(name,{...filters,...(name==='outlets'&&this.data.outletSearch?{q:this.data.outletSearch}:{}),limit:spec.limit??50,offset},this);if(serial!==this._serial)return;
      const state={...this.data.state};const old=name==='supportChats'?state.support.chats:name==='supportTickets'?state.support.tickets:state[name]||[];const items=reset?result.items:[...old,...result.items.filter(x=>!old.some(y=>y.id===x.id))];
      if(name==='supportChats'||name==='supportTickets')state.support={...state.support,[name==='supportChats'?'chats':'tickets']:items};else state[name]=items;
      this.setData({state:fmt.decorate(state),['pagers.'+name]:{total:result.total,loaded:result.offset+result.items.length,nextOffset:result.offset+result.limit,hasMore:result.hasMore,loading:false},[errorKey]:''});spec.metadata?.call(this,result);if(notify&&options.loaded)await options.loaded.call(this,this.data.state);
    }catch(e){if(serial===this._serial)this.setData({['pagers.'+name]:{...prior,loading:false},[errorKey]:e.message});throw e;}},
  async more(e){try{await this.fetchCollection(e.currentTarget.dataset.collection);}catch{}},
  async reloadCollection(name){try{await this.fetchCollection(name,true);}catch{}},
  async outletSearch(e){this.setData({outletSearch:e.detail.value});await this.refresh();},
  input(e){this._dirty=true;this.setData({['form.'+e.currentTarget.dataset.field]:e.detail.value});},
  nav(e){go(e.currentTarget.dataset.page,e.currentTarget.dataset.query||'');},
  async mutate(command,payload,success='已保存。',options){
    if(this.data.busy)return;
    const attempt={}, token=api.session()?.token;
    let serial=this._serial;
    this._mutation=attempt;
    const current=()=>this._mutation===attempt&&serial===this._serial&&token===api.session()?.token;
    this.setData({busy:true,error:''});
    try{
      const result=await api.command(command,payload,options?.retryKey?{retryKey:options.retryKey}:undefined);
      if(!current())return null;
      const title=typeof success==='function'?success(result):success;
      wx.showToast({title,icon:title.length>7?'none':'success'});
      this._dirty=false;
      const update=this.refresh();
      serial=this._serial;
      await update;
      return current()?result:null;
    }catch(error){
      if(current()){
        this.setData({error:error.message});
        options?.onError?.(error);
      }
      return null;
    }finally{
      if(this._mutation===attempt){this._mutation=null;this.setData({busy:false});}
    }
  },
  ...Object.fromEntries(Object.entries(options).filter(([k])=>!['data','load','loaded','collections','summary','onUnload'].includes(k)))
};}
async function openRecord(record,{returnStatus,returnPage,onSuccess,onSettled,isCurrent=()=>true}={}){
 if(!canOpenRecord(record))return;
 const open=(page,query)=>isCurrent()?go(page,query,()=>{
   if(isCurrent()){track('task_click','opened');onSuccess?.();}
 },onSettled):false;
 const notice=record.id?.startsWith('msg-');
 let r=record;
 if(r.taskId&&(!notice||!r.target||!(r.recordId||r.outlet&&r.month)))r=await api.detail('businessTasks',r.taskId);
 let target=r.target||r.kind||r.type,id=r.recordId||r.ticketId;
 if(target==='join'&&id){
   const result=await api.request('/api/onboarding/applications?'+api.query({id}));
   if(!result.items.some(item=>item.id===id))throw new Error('当前账号无法查看这份加盟申请。');
   return open('join',api.query({id}));
 }
 if (targets[target] === 'training') {
   id = id || r.businessId;
   if (!id || !r.outlet) throw new Error('此培训记录暂时无法打开，请从培训页重新查看。');
   const source = await api.request('/api/training/records/' + encodeURIComponent(id) + '?' + api.query({ outlet: r.outlet }));
   return open('training', api.query({ outlet: source.outletId, id: source.id }));
 }
 if(notice&&['reports','location'].includes(target)&&id===r.outlet)id=null;
 if(target==='reports'){
   if(r.settlementId&&r.month){
     const settlement=await api.detail('settlements',r.settlementId);
     if(r.outlet)await api.detail('outlets',r.outlet);
     return open('dashboard',api.query({period:settlement.month,outlet:r.outlet}));
   }
   if(r.reportId)id=r.reportId;
   else if(id?.startsWith('req-')){
     const request=await api.detail('requests',id);
     if(request.type==='reportRevoke')id=request.data?.reportId;
   }
   if(id?.startsWith('rpt-')){
     const report=await api.detail('reports',id);
     return open('report',api.query({outlet:report.outlet,month:report.month,id:report.id}));
   }
   if(id?.startsWith('exempt-')){
     const exemption=await api.detail('exemptions',id);
     return open('report',api.query({outlet:exemption.outlet,month:exemption.month}));
   }
 }
 if((target==='requests'&&id&&(notice||id.startsWith('req-')))||(target==='location'&&id?.startsWith('req-'))){
   const request=await api.detail('requests',id);
   return open('requests',api.query({outlet:request.outlet,id,type:request.type}));
 }
 if(target==='location'&&id?.startsWith('loc-'))r={...r,...await api.detail('verifications',id)};
 const params={outlet:r.outlet,month:r.month,id};
 if(target==='cooperation')return open('discover',api.query({section:'cooperation',id}));
 if(target==='outlets'||target==='outlet'){
  const outlet=notice?id||r.outlet:r.outlet||id;
  if(notice&&outlet)await api.detail('outlets',outlet);
  return outlet?open('outlet',api.query({id:outlet})):open('outlets');
 }
 if(notice&&(target==='support'||target==='support_sla')&&id){
  const source=await api.detail(id.startsWith('chat-')?'supportChats':'supportTickets',id);
  return open('support',api.query({outlet:source.outlet,id:source.id,returnStatus,
   returnPage:returnPage==='tasks'?'tasks':undefined,returnNoticeId:returnStatus?record.id:undefined}));
 }
 if(notice&&['reports','location'].includes(target)&&r.outlet&&!id)await api.detail('outlets',r.outlet);
 const route=target==='reports'&&r.month?'report':targets[target];
 if(route==='dashboard')params.period=r.month;
 const financeType={refundRequests:'refund',invoiceRequests:'invoice',offlinePayments:'offline'}[target];
 if(financeType)params.type=financeType;
 if(notice&&(route==='fees'||financeType)){
  const applicationId=r.refundRequestId||id;
  const type=financeType||(/^(refund|invoice|offline)-/.exec(applicationId||'')||[])[1];
  if(type){
   const collection={refund:'refundRequests',invoice:'invoiceRequests',offline:'offlinePayments'}[type];
   const source=await api.detail(collection,applicationId);
   return open('finance',api.query({id:source.id,type}));
  }
  if(id?.startsWith('fee-')){
   const proposal=await api.detail('feeProposals',id);
   return open('finance',api.query({outlet:proposal.outlet,month:proposal.offsetMonth,feeProposalId:proposal.id}));
  }
  const paymentId=r.paymentId||(id?.startsWith('pay-')?id:null);
  const correctionId=id?.startsWith('bc-')?id:null;
  const related=paymentId?await api.detail('payments',paymentId):correctionId?await api.detail('billCorrections',correctionId):null;
  const billId=related?.billId||r.billId||id;
  if(billId){
   const bill=await api.detail('bills',billId);
   return open('finance',api.query({outlet:bill.outlet,month:bill.month,ledgerBillId:bill.id,
    section:paymentId?'payments':correctionId?'corrections':undefined,ledgerRecordId:related?.id}));
  }
 }
 if(route==='fees'&&id&&/^(refund|invoice|offline)-/.test(id)){
  params.type=id.startsWith('refund-')?'refund':id.startsWith('invoice-')?'invoice':'offline';
  return open('finance',api.query(params));
 }
 if(route)return open(route,route==='reports'?'':api.query(params));
 throw new Error('暂时无法打开此事项，请联系总部客服。');
}
module.exports={define,go,api,fmt,openRecord,canOpenRecord};
