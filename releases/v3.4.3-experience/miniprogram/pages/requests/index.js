const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');
const types=[
  {id:'newOutlet',name:'新增网点'},
  {id:'statusChange',status:'paused',name:'暂停营业'},
  {id:'statusChange',status:'open',name:'恢复营业'},
  {id:'statusChange',status:'closed',name:'关闭网点'},
  {id:'locationChange',name:'变更网点位置'},
  {id:'pauseFee',name:'申请暂停收费'},
  {id:'accountChange',change:'manager',name:'变更负责人'},
  {id:'accountChange',change:'mobile',name:'变更登记手机号'},
  {id:'enrollment',name:'调整招生业务适用情况'},
  {id:'exemptException',name:'免报财务事项'}
];
const historyLabels={'request.submit':'提交申请','request.supplement':'提交补充资料','review.request':'总部处理申请','location.review':'网点位置核验','report.revoke.request':'发起月报撤销申请','review.revoke':'处理月报撤销申请'};
const promptOutlet={id:'',name:'请选择申请网点'};
function canApplyPauseFee(row){
  return row.type==='statusChange'&&row.data?.status==='paused'&&Boolean(row.outlet)&&['pending','approved'].includes(row.status);
}
function canApplyPauseBusiness(row,outlets){
  return row.type==='pauseFee'&&['pending','approved'].includes(row.status)&&outlets.some(outlet=>outlet.id===row.outlet&&outlet.status==='open');
}
Page(define({collections:['outlets',{name:'requests',filters(){return {status:this.data.statusFilter,outlet:this.query.filterOutlet};}}],data:{statusFilter:'all',historyId:'',historyRows:[],historyError:'',historyLoading:false,historyMore:false,historyOffset:0,types,type:'newOutlet',typeIndex:0,outlets:[],outletIndex:0,requestRows:[],currentManager:'',form:{name:'',countryCode:'',province:'',city:'',district:'',address:'',phone:'',opening:'',from:'',to:'',reason:'',note:'',status:'paused',effectiveDate:fmt.date(),month:fmt.month(-1),managerName:'',mobile:''},applicable:true,coords:null,photo:null,preview:'',locating:false,uploadingPhoto:false},
load(q){
  const typeIndex=types.findIndex(x=>x.id===q.type&&(!q.change||x.change===q.change)&&(!q.status||x.status===q.status));
  if(typeIndex>=0){const selected=types[typeIndex];this.setData({type:selected.id,typeIndex,'form.status':selected.status||'paused'});}
},
async loaded(s){
  const serial=this._serial;
  const available=s.outlets.filter(x=>x.owner);
  const outlets=[promptOutlet,...available];
  const requested=this.query.outlet;
  const onlyOutlet=!this.data.outletSearch&&available.length===1&&!this.data.pagers.outlets?.hasMore;
  const outletIndex=requested?Math.max(0,outlets.findIndex(o=>o.id===requested)):onlyOutlet?1:0;
  this.setData({outlets,outletIndex});
  const id=this.query.id;
  let requests=s.requests;
  if(id){
    const record=s.requests.find(x=>x.id===id)||fmt.decorate({requests:[await api.detail('requests',id)],outlets}).requests[0];
    if(serial!==this._serial||id!==this.query.id)return;
    requests=[record,...s.requests.filter(x=>x.id!==id)];
    this.setData({'state.requests':requests});
  }
  const requestRows=requests.map(row=>({
    id:row.id,type:row.type,status:row.status,statusText:fmt.label(row.status,'request'),statusTone:fmt.statusTone(row.status,'request'),
    typeText:['statusChange','accountChange'].includes(row.type)?types.find(t=>t.id===row.type&&(row.type==='statusChange'?t.status===row.data?.status:t.change===(row.data?.change||'manager')))?.name||row.typeText:row.typeText,
    outletName:row.data?.name||(row.outletName!==row.outlet&&row.outlet?row.outletName:''),
    submittedText:fmt.timeText(row.createdAt),result:row.review,canApplyPauseFee:canApplyPauseFee(row),
    canApplyPauseBusiness:canApplyPauseBusiness(row,outlets)
  }));
  this.setData({requestRows},()=>{
    const selector=id?'#request-'+id:this.query.section==='history'?'#request-history':'';
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
  if(!this.data.busy&&row&&canApplyPauseFee(row))go('requests',api.query({type:'pauseFee',outlet:row.outlet}));
},
applyPauseBusiness(e){
  const row=this.data.state?.requests?.find(item=>item.id===e.currentTarget.dataset.id);
  if(!this.data.busy&&row&&canApplyPauseBusiness(row,this.data.outlets))go('requests',api.query({type:'statusChange',status:'paused',outlet:row.outlet}));
},
async loadCurrentManager(){
  const serial=this._serial;
  try{
    const {items}=await api.collection('accounts',{limit:1});
    if(serial===this._serial&&this.data.type==='accountChange')this.setData({currentManager:items[0]?.managerName||''});
  }catch{if(serial===this._serial)this.setData({currentManager:''});}
},
async showHistory(e){
  const id=e.currentTarget.dataset.id;
  if(this.data.historyId===id){this.setData({historyId:'',historyLoading:false,workContact:null});return;}
  this.setData({historyId:id,historyRows:[],historyError:'',historyMore:false,historyOffset:0,historyLoading:false,workContact:null});
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
async chooseType(e){
  const typeIndex=Number(e.detail.value),selected=types[typeIndex];
  if(this.data.busy||!selected||typeIndex===this.data.typeIndex)return;
  const values={typeIndex,type:selected.id,...(selected.status?{'form.status':selected.status}:{})};
  if(selected.id===this.data.type)this.setData(values);
  else this.resetEvidence({...values,supplementId:''});
  if(selected.id==='accountChange')await this.loadCurrentManager();
},
chooseOutlet(e){
  const outletIndex=Number(e.detail.value),outlet=this.data.outlets[outletIndex];
  if(this.data.busy||this.data.supplementId||!outlet||outletIndex===this.data.outletIndex)return;
  this.query.outlet=outlet.id;
  if(this.data.type==='locationChange')this.resetEvidence({outletIndex});
  else this.setData({outletIndex});
},
applicability(e){this.setData({applicable:e.detail.value});},
async locate(e){
  if(this.data.busy||this.data.loading||this.data.locating)return;
  const scope=this._captureScope;
  this.setData({coords:null,locating:true,error:''});
  try{
    const {coords,address}=await api.locate(e?.currentTarget?.dataset?.manual!=='false');
    if(scope===this._captureScope)this.setData({coords,'form.address':address||this.data.form.address,error:''});
  }catch(e){if(scope===this._captureScope)this.setData({error:e.message});}
  finally{if(scope===this._captureScope)this.setData({locating:false});}
},
async photo(){
  if(this.data.busy||this.data.loading||this.data.uploadingPhoto)return;
  const scope=this._captureScope;
  this.setData({photo:null,preview:'',uploadingPhoto:true,error:''});
  try{
    const {file,preview}=await api.uploadPhoto();
    if(scope===this._captureScope)this.setData({photo:file,preview,error:''});
  }catch(e){if(scope===this._captureScope)this.setData({error:e.message});}
  finally{if(scope===this._captureScope)this.setData({uploadingPhoto:false});}
},
async supplement(e){
  if(this.data.busy)return;
  const r=this.data.state.requests.find(x=>x.id===e.currentTarget.dataset.id);
  const typeIndex=types.findIndex(t=>t.id===r?.type&&(!t.status||t.status===r.data?.status)&&(!t.change||t.change===(r.data?.change||'manager')));
  if(typeIndex<0)return;
  let outlets=this.data.outlets,outletIndex=outlets.findIndex(o=>o.id===r.outlet);
  if(r.outlet&&outletIndex<0){
    try{outlets=[await api.detail('outlets',r.outlet),...outlets];outletIndex=0;}
    catch(e){this.setData({error:e.message});return;}
  }
  if(r.outlet)this.query.outlet=r.outlet;
  this._captureScope=(this._captureScope||0)+1;
  this.setData({supplementId:r.id,type:r.type,typeIndex,form:{...this.data.form,...r.data,reason:''},coords:r.data.coords||null,photo:r.data.photo||null,preview:'',locating:false,uploadingPhoto:false,applicable:r.data.applicable!==false,outlets,outletIndex:Math.max(0,outletIndex)});
  if(r.type==='accountChange')await this.loadCurrentManager();
  wx.pageScrollTo({scrollTop:0});
},
async submit(){if(this.data.loading||this.data.busy||this.data.locating||this.data.uploadingPhoto)return;const d={...this.data.form};if(this.data.supplementId&&!d.reason.trim())return this.setData({error:'请填写补充说明。'});const type=this.data.type,outlet=this.data.outlets[this.data.outletIndex]?.id;let data;
if(type==='newOutlet'){
  const countryCode=d.countryCode?.trim().toUpperCase()||'';
  if(countryCode&&!/^[A-Z]{2}$/.test(countryCode))return this.setData({error:'请填写两位国家或地区代码。'});
  const fields=['name','city','address','phone','opening'];
  if(!countryCode||countryCode==='CN')fields.push('province','district');
  if(fields.some(k=>!d[k]?.trim())||!this.data.coords||!this.data.photo)return this.setData({error:'请填写网点资料、确认地图位置并上传现场照片。'});
  data={...d,countryCode,coords:this.data.coords,photo:this.data.photo};
}
else {if(!outlet)return this.setData({error:'请选择申请网点。'});if(!d.reason.trim())return this.setData({error:'请填写申请原因。'});if(type==='locationChange'&&(!d.address.trim()||!this.data.coords||!this.data.photo))return this.setData({error:'请填写拟变更地址、确认地图位置并上传现场照片。'});data=type==='pauseFee'?{from:d.from,to:d.to,reason:d.reason}:type==='locationChange'?{address:d.address,coords:this.data.coords,photo:this.data.photo,reason:d.reason}:type==='enrollment'?{applicable:this.data.applicable,reason:d.reason}:type==='statusChange'?{status:d.status,effectiveDate:d.effectiveDate,reason:d.reason}:type==='exemptException'?{month:d.month,reason:d.reason}:{change:types[this.data.typeIndex].change,...(types[this.data.typeIndex].change==='mobile'?{}:{managerName:d.managerName}),mobile:d.mobile,reason:d.reason};}
const r=this.data.supplementId?await this.mutate('request.supplement',{id:this.data.supplementId,note:d.reason,data},'总部已收到您提交的资料。'):await this.mutate('request.submit',{type,outlet:type==='newOutlet'?null:outlet,data},type==='accountChange'?'申请已提交，总部核实后会通知您。':'已提交申请。');
if(!r?.result?.id)return;
const id=r.result.id;
this.query.id=id;
this.resetEvidence({supplementId:'','form.reason':''});
if(!this.data.requestRows.some(row=>row.id===id)){
  this.setData({statusFilter:'all'});
  await this.reloadCollection('requests');
}else{
  this._scrolledToRequest='#request-'+id;
  wx.pageScrollTo?.({selector:this._scrolledToRequest,duration:0});
}}
}));
