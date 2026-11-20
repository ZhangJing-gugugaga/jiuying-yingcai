const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');
const types=[
  {id:'newOutlet',name:'新增网点',materials:'网点资料、开业日期、地图位置和现场照片'},
  {id:'statusChange',status:'paused',name:'暂停营业',materials:'生效日期和暂停原因'},
  {id:'statusChange',status:'open',name:'恢复营业',materials:'生效日期和恢复原因'},
  {id:'statusChange',status:'closed',name:'关闭网点',materials:'生效日期和关闭原因'},
  {id:'locationChange',name:'变更网点位置',materials:'新地址、地图位置、现场照片和变更原因'},
  {id:'pauseFee',name:'申请暂停收费',materials:'暂停收费的起止日期和原因'},
  {id:'accountChange',change:'manager',name:'变更负责人',materials:'新负责人姓名、手机号和变更原因'},
  {id:'accountChange',change:'mobile',name:'变更登记手机号',materials:'新手机号和变更原因'},
  {id:'enrollment',name:'调整招生业务适用情况',materials:'招生业务适用情况和调整原因'},
  {id:'exemptException',name:'免报财务事项',materials:'事项月份和申请原因'}
];
const historyLabels={'request.submit':'已提交申请','request.supplement':'提交补充资料','review.request':'总部处理申请','location.review':'网点位置核验','report.revoke.request':'发起月报撤销申请','review.revoke':'处理月报撤销申请'};
function groupTypes(options){
  const groups=[
    {name:'网点经营',types:['newOutlet','statusChange','locationChange']},
    {name:'费用与报送',types:['pauseFee','enrollment','exemptException']},
    {name:'负责人账号',types:['accountChange']}
  ];
  return groups.map(group=>({name:group.name,options:options.map((option,index)=>({...option,index})).filter(option=>group.types.includes(option.id))}))
    .filter(group=>group.options.length);
}
const promptOutlet={id:'',name:'请选择申请网点',selectionName:'请选择申请网点'};
const initialForm=()=>({name:'',countryCode:'',province:'',city:'',district:'',address:'',phone:'',opening:'',from:'',to:'',reason:'',note:'',status:'paused',effectiveDate:fmt.date(),month:fmt.month(-1),managerName:'',mobile:''});
function canApplyPauseFee(row){
  return row.type==='statusChange'&&row.data?.status==='paused'&&Boolean(row.outlet)&&['pending','approved'].includes(row.status);
}
function canApplyPauseBusiness(row,outlets){
  return row.type==='pauseFee'&&['pending','approved'].includes(row.status)&&outlets.some(outlet=>outlet.id===row.outlet&&outlet.status==='open');
}
Page(define({collections:['outlets',{name:'requests',filters(){return {status:this.data.statusFilter,outlet:this.query.filterOutlet};}}],data:{viewMode:'list',statusFilter:'all',historyId:'',historyRows:[],historyError:'',historyLoading:false,historyMore:false,historyOffset:0,types,type:'newOutlet',typeIndex:0,boundOutlet:'',outlets:[],outletIndex:0,requestRows:[],currentManager:'',form:initialForm(),applicable:true,coords:null,photo:null,preview:'',locating:false,uploadingPhoto:false},
load(q){
  this._entryOutlet=!q.id&&q.type!=='newOutlet'&&(q.outlet&&q.outlet!=='all'?q.outlet:q.filterOutlet)||'';
  const boundOutlet=q.type==='locationChange'&&!q.filterOutlet?'':this._entryOutlet;
  if(boundOutlet)this.query={...q,outlet:boundOutlet,filterOutlet:boundOutlet};
  const availableTypes=boundOutlet?types.filter(type=>type.id!=='newOutlet'):types;
  const typeIndex=availableTypes.findIndex(x=>x.id===q.type&&(!q.change||x.change===q.change)&&(!q.status||q.type!=='statusChange'||x.status===q.status));
  this.setData({types:availableTypes,typeGroups:groupTypes(availableTypes),
    statusOptions:availableTypes.map((option,index)=>({...option,index})).filter(option=>option.id==='statusChange'),
    boundOutlet,viewMode:q.id?'detail':typeIndex>=0?'form':'list',historyId:q.id||'',canChangeType:false});
  if(typeIndex>=0){const selected=availableTypes[typeIndex];this.setData({type:selected.id,typeIndex,'form.status':selected.status||'paused'});}
},
async loaded(s){
  const serial=this._serial;
  const available=s.outlets.filter(x=>x.owner).map(x=>({...x,selectionName:fmt.outletOptionLabel(x)}));
  const outlets=[promptOutlet,...available];
  const requested=this.query.outlet;
  const onlyOutlet=!this.data.outletSearch&&available.length===1&&!this.data.pagers.outlets?.hasMore;
  const outletIndex=requested?Math.max(0,outlets.findIndex(o=>o.id===requested)):onlyOutlet?1:0;
  this.setData({outlets,outletIndex});
  const id=this.data.viewMode==='detail'?this.data.historyId||this.query.id:this.query.id;
  let requests=s.requests;
  if(id){
    const source=s.requests.find(x=>x.id===id)||await api.detail('requests',id);
    if(serial!==this._serial||id!==(this.data.viewMode==='detail'?this.data.historyId||this.query.id:this.query.id))return;
    if(source.outlet&&requested&&source.outlet!==requested)throw new Error('这条申请不属于当前网点，请从原消息重新打开。');
    const record=fmt.decorate({requests:[source],outlets}).requests[0];
    requests=[record,...s.requests.filter(x=>x.id!==id)];
    this.setData({'state.requests':requests});
  }
  const requestRows=requests.map(row=>({
    id:row.id,type:row.type,status:row.status,statusText:fmt.label(row.status,'request'),statusTone:fmt.statusTone(row.status,'request'),
    typeText:['statusChange','accountChange'].includes(row.type)?types.find(t=>t.id===row.type&&(row.type==='statusChange'?t.status===row.data?.status:t.change===(row.data?.change||'manager')))?.name||row.typeText:row.typeText,
    outletName:row.data?.name||(row.outletName!==row.outlet&&row.outlet?row.outletName:''),
    submittedText:fmt.timeText(row.createdAt),result:row.review,canApplyPauseFee:canApplyPauseFee(row),
    feeApproved:row.type==='pauseFee'&&row.status==='approved',
    canApplyPauseBusiness:canApplyPauseBusiness(row,outlets)
  }));
  this.setData({requestRows},()=>{
    const selector=this.data.viewMode==='detail'&&id?'#request-'+id:this.query.section==='history'&&this.data.viewMode==='list'?'#request-history':'';
    if(!selector||this._scrolledToRequest===selector)return;
    this._scrolledToRequest=selector;
    wx.pageScrollTo?.({selector,duration:0});
  });
  if(this.data.type==='accountChange')await this.loadCurrentManager();
  if(this.data.historyId&&this._historyRefreshSerial!==this._serial){
    this.setData({historyRows:[],historyLoading:false,historyOffset:0,historyMore:false});
    await Promise.all([this.loadHistory(),this.refreshWorkContact()]);
  }
},
...workContactBehavior(function(){
  const id=this.data.historyId;
  const record=id&&this.data.state?.requests?.find(row=>row.id===id);
  return record?.outlet?{outlet:record.outlet,recordType:'requests',recordId:id}:null;
}),
applyPauseFee(e){
  const row=this.data.state?.requests?.find(item=>item.id===e.currentTarget.dataset.id);
  if(!this.data.busy&&row&&canApplyPauseFee(row))go('requests',api.query({type:'pauseFee',outlet:row.outlet,filterOutlet:row.outlet}));
},
applyPauseBusiness(e){
  const row=this.data.state?.requests?.find(item=>item.id===e.currentTarget.dataset.id);
  if(!this.data.busy&&row&&canApplyPauseBusiness(row,this.data.outlets))go('requests',api.query({type:'statusChange',status:'paused',outlet:row.outlet,filterOutlet:row.outlet}));
},
async loadCurrentManager(){
  const serial=this._serial;
  try{
    const {items}=await api.collection('accounts',{limit:1});
    if(serial===this._serial&&this.data.type==='accountChange')this.setData({currentManager:items[0]?.managerName||''});
  }catch{if(serial===this._serial)this.setData({currentManager:''});}
},
beginRequest(){
  const {outlets,pagers,outletSearch}=this.data;
  this.query.outlet=this._entryOutlet;
  const single=outlets.length===2&&!pagers.outlets?.hasMore&&!outletSearch;
  const outletIndex=this._entryOutlet?Math.max(0,outlets.findIndex(row=>row.id===this._entryOutlet)):single?1:0;
  this._dirty=false;
  this.resetEvidence({viewMode:'chooseType',outletIndex,type:'',typeIndex:-1,form:initialForm(),applicable:true,canChangeType:true,error:''});
  wx.pageScrollTo?.({scrollTop:0,duration:0});
},
backToRecords(){
  const returnId=this.data.viewMode==='form'?this.data.supplementId:'';
  const goBack=()=>{
    this.query.id='';
    this._dirty=false;
    this.resetEvidence({viewMode:returnId?'detail':'list',historyId:returnId,historyLoading:false,supplementId:'',error:''});
    wx.pageScrollTo?.({scrollTop:0,duration:0});
    if(returnId)return this.showHistory({currentTarget:{dataset:{id:returnId}}});
    this.query.outlet=this._entryOutlet;
    return this.reloadCollection('requests');
  };
  return this.afterDiscard('放弃本次填写？','返回',goBack);
},
async showHistory(e){
  const id=e.currentTarget.dataset.id;
  const record=this.data.state?.requests?.find(row=>row.id===id);
  if(record){this.query.id=id;this.query.outlet=record.outlet||'';}
  this.setData({viewMode:'detail',historyId:id,historyRows:[],historyError:'',historyMore:false,historyOffset:0,historyLoading:false,workContact:null},()=>{
    wx.pageScrollTo?.({selector:'#request-'+id,duration:0});
  });
  await Promise.all([this.loadHistory(),this.refreshWorkContact()]);
},
async loadHistory(){
  const {historyId:id,historyOffset:offset,historyLoading}=this.data;
  if(!id||historyLoading)return;
  const serial=this._serial,request=(this._historySerial||0)+1;
  this._historySerial=request;
  this._historyRefreshSerial=serial;
  const isCurrent=()=>serial===this._serial&&request===this._historySerial&&this.data.historyId===id;
  this.setData({historyLoading:true,historyError:''});
  try{
    const response=await api.request('/api/approval-history/requests/'+encodeURIComponent(id)+'?'+api.query({limit:25,offset}));
    const items=response.items.map(event=>({
      id:event.id,label:historyLabels[event.action]||'申请进度已更新',at:fmt.timeText(event.at),note:event.note,
      result:event.action==='location.review'&&event.after?.locationStatus?fmt.label(event.after.locationStatus,'location'):event.after?.status?fmt.label(event.after.status,'request'):''
    }));
    if(isCurrent())this.setData({historyRows:[...this.data.historyRows,...items],historyMore:response.hasMore,historyOffset:offset+items.length});
  }catch(error){if(isCurrent())this.setData({historyError:error.message});}
  finally{if(isCurrent())this.setData({historyLoading:false});}
},
async filterStatus(e){this.query.id='';this.setData({statusFilter:e.currentTarget.dataset.status,historyId:'',historyLoading:false,workContact:null});await this.reloadCollection('requests');},
resetEvidence(values={}){
  this._captureScope=(this._captureScope||0)+1;
  this.setData({coords:null,photo:null,preview:'','form.address':'',locating:false,uploadingPhoto:false,...values});
},
async afterDiscard(title,confirmText,change){
  if(this.data.busy||this._discardPrompt)return;
  if(!this._dirty&&!this.data.coords&&!this.data.photo)return change();
  if(typeof wx.showModal!=='function')return this.setData({error:'无法确认是否放弃填写，已保留当前内容。'});
  const scope=this._captureScope,serial=this._serial;
  this._discardPrompt=true;
  try{
    const confirm=await new Promise(resolve=>wx.showModal({title,content:'当前未提交的内容将清空。',confirmText,cancelText:'继续填写',
      success:result=>resolve(result.confirm),fail:()=>resolve(false)}));
    if(confirm&&scope===this._captureScope&&serial===this._serial&&!this.data.busy){
      this._dirty=false;
      return change();
    }
  }finally{this._discardPrompt=false;}
},
chooseAgain(){
  if(!this.data.canChangeType||this.data.supplementId)return;
  return this.afterDiscard('更换办理事项？','更换',()=>{
    this.resetEvidence({viewMode:'chooseType',type:'',typeIndex:-1,form:initialForm(),applicable:true,error:''});
  });
},
pickRequestType(e){
  return this.chooseType({detail:{value:e.currentTarget.dataset.index}});
},
async chooseType(e){
  const typeIndex=Number(e.detail.value),selected=this.data.types[typeIndex];
  if(this.data.busy||!selected)return;
  if(this.data.viewMode==='form'&&this.data.supplementId&&this.data.type==='statusChange'&&selected.id==='statusChange'){
    this._dirty=true;
    this.setData({typeIndex,'form.status':selected.status});
    return;
  }
  if(this.data.viewMode!=='chooseType')return;
  this.resetEvidence({typeIndex,type:selected.id,viewMode:'form',supplementId:'',form:{...initialForm(),status:selected.status||'paused'},applicable:true,error:''});
  if(selected.id==='accountChange')await this.loadCurrentManager();
},
chooseOutlet(e){
  const outletIndex=Number(e.detail.value),outlet=this.data.outlets[outletIndex];
  if(this.data.busy||this.data.loading||this.data.locating||this.data.uploadingPhoto||this.data.boundOutlet||this.data.supplementId||!outlet||outletIndex===this.data.outletIndex)return;
  return this.afterDiscard('切换申请网点？','切换网点',()=>{
    this.query.outlet=outlet.id;
    const status=this.data.types[this.data.typeIndex]?.status||'paused';
    this.resetEvidence({outletIndex,form:{...initialForm(),status},applicable:true,error:''});
  });
},
applicability(e){this._dirty=true;this.setData({applicable:e.detail.value});},
async locate(e){
  if(this.data.viewMode!=='form'||this.data.busy||this.data.loading||this.data.locating||this._discardPrompt)return;
  const scope=this._captureScope;
  this.setData({coords:null,locating:true,error:''});
  try{
    const {coords,address}=await api.locate(e?.currentTarget?.dataset?.manual!=='false');
    if(scope===this._captureScope)this.setData({coords,'form.address':address||this.data.form.address,error:''});
  }catch(e){if(scope===this._captureScope)this.setData({error:e.message});}
  finally{if(scope===this._captureScope)this.setData({locating:false});}
},
async photo(){
  if(this.data.viewMode!=='form'||this.data.busy||this.data.loading||this.data.uploadingPhoto||this._discardPrompt)return;
  const scope=this._captureScope;
  this.setData({photo:null,preview:'',uploadingPhoto:true,photoProgress:null,error:''});
  try{
    const {file,preview}=await api.uploadPhoto({onProgress:photoProgress=>{
      if(scope===this._captureScope)this.setData({photoProgress});
    }});
    if(scope===this._captureScope)this.setData({photo:file,preview,error:''});
  }catch(e){if(scope===this._captureScope)this.setData({error:e.message});}
  finally{if(scope===this._captureScope)this.setData({uploadingPhoto:false});}
},
async supplement(e){
  if(this.data.busy)return;
  const r=this.data.state.requests.find(x=>x.id===e.currentTarget.dataset.id);
  const typeIndex=this.data.types.findIndex(t=>t.id===r?.type&&(!t.status||t.status===r.data?.status)&&(!t.change||t.change===(r.data?.change||'manager')));
  if(typeIndex<0)return;
  let outlets=this.data.outlets,outletIndex=outlets.findIndex(o=>o.id===r.outlet);
  if(r.outlet&&outletIndex<0){
    try{
      const row=await api.detail('outlets',r.outlet);
      outlets=[...outlets,{...row,selectionName:fmt.outletOptionLabel(row)}];
      outletIndex=outlets.length-1;
    }
    catch(e){this.setData({error:e.message});return;}
  }
  if(r.outlet)this.query.outlet=r.outlet;
  this._captureScope=(this._captureScope||0)+1;
  this.setData({viewMode:'form',supplementId:r.id,type:r.type,typeIndex,form:{...initialForm(),...r.data,reason:''},coords:r.data.coords||null,photo:r.data.photo||null,preview:'',locating:false,uploadingPhoto:false,applicable:r.data.applicable!==false,outlets,outletIndex:Math.max(0,outletIndex)});
  if(r.type==='accountChange')await this.loadCurrentManager();
  wx.pageScrollTo({scrollTop:0});
},
async submit(){if(this.data.viewMode!=='form'||this.data.loading||this.data.busy||this._discardPrompt||this.data.locating||this.data.uploadingPhoto)return;const d={...this.data.form};if(this.data.supplementId&&!d.reason.trim())return this.setData({error:'请填写补充说明。'});const type=this.data.type,outlet=this.data.outlets[this.data.outletIndex]?.id;let data;
if(type==='newOutlet'){
  const countryCode=d.countryCode?.trim().toUpperCase()||'';
  if(countryCode&&!/^[A-Z]{2}$/.test(countryCode))return this.setData({error:'请填写两位国家或地区代码。'});
  const fields=['name','city','address','phone','opening'];
  if(!countryCode||countryCode==='CN')fields.push('province','district');
  if(fields.some(k=>!d[k]?.trim())||!this.data.coords||!this.data.photo)return this.setData({error:'请填写网点资料、确认地图位置并上传现场照片。'});
  data={...d,countryCode,coords:this.data.coords,photo:this.data.photo};
}
else {if(!outlet||this.data.boundOutlet&&this.data.boundOutlet!==outlet)return this.setData({error:'请选择申请网点。'});if(!d.reason.trim())return this.setData({error:'请填写申请原因。'});if(type==='locationChange'&&(!d.address.trim()||!this.data.coords||!this.data.photo))return this.setData({error:'请填写拟变更地址、确认地图位置并上传现场照片。'});const change=this.data.types[this.data.typeIndex]?.change;data=type==='pauseFee'?{from:d.from,to:d.to,reason:d.reason}:type==='locationChange'?{address:d.address,coords:this.data.coords,photo:this.data.photo,reason:d.reason}:type==='enrollment'?{applicable:this.data.applicable,reason:d.reason}:type==='statusChange'?{status:d.status,effectiveDate:d.effectiveDate,reason:d.reason}:type==='exemptException'?{month:d.month,reason:d.reason}:{change,...(change==='mobile'?{}:{managerName:d.managerName}),mobile:d.mobile,reason:d.reason};}
const r=this.data.supplementId?await this.mutate('request.supplement',{id:this.data.supplementId,note:d.reason,data},'总部已收到您提交的资料。'):await this.mutate('request.submit',{type,outlet:type==='newOutlet'?null:outlet,data},type==='accountChange'?'申请已提交，总部核实后会通知您。':'已提交申请。');
if(!r?.result?.id)return;
const id=r.result.id;
this.query.id=id;
this.resetEvidence({supplementId:'','form.reason':''});
if(!this.data.requestRows.some(row=>row.id===id)){
  this.setData({statusFilter:'all'});
  await this.reloadCollection('requests');
  }
  await this.showHistory({currentTarget:{dataset:{id}}});
}
}));
