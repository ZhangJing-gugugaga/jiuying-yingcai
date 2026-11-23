const {define,api,fmt}=require('../../utils/page');

function verificationText(status){
  if(['pending','location_pending'].includes(status))return '已提交，等待总部核验';
  if(['exception','location_anomaly'].includes(status))return '位置待核实，请补充说明';
  return fmt.label(status,'location');
}

function verificationProgress({status,coords}){
  if(['pending','location_pending'].includes(status)){
    return coords?.source==='manual'?'地址资料已提交，等待总部核验。现场定位尚未完成。':'资料已提交，等待总部核验';
  }
  if(['exception','location_anomaly'].includes(status))return '需补充资料，按总部意见重新提交';
  if(['approved','location_verified'].includes(status))return '总部核验已通过';
  return verificationText(status);
}

function accuracyText(coords){
  return coords?.source==='gps'&&Number.isFinite(coords.accuracy)&&coords.accuracy>=0?coords.accuracy+' 米':'';
}

const positionLabels={gps:'现场定位',manual:'地图选点'};
const timeLabels={gps:'定位时间',manual:'选点时间'};

function selectedOutlet(page, outlets=(page.data.state?.outlets||[]).filter(outlet=>outlet.owner)){
  const id=page.query.outlet;
  if(id&&id!=='all')return outlets.find(outlet=>outlet.id===id);
  if(outlets.length===1&&!page.data.pagers.outlets?.hasMore&&!page.data.outletSearch)return outlets[0];
}

function verificationRow(row,superseded){
  const assessment=row.assessment;
  const showDistance=row.coords?.source==='gps'&&['within_threshold','outside_threshold'].includes(assessment?.result)
    &&Number.isFinite(assessment.thresholdMeters)&&assessment.thresholdMeters>=0&&Number.isFinite(assessment.distanceMeters)&&assessment.distanceMeters>=0;
  return {
    ...row,monthText:fmt.monthText(row.month),statusText:superseded?'已补交，原记录保留':verificationText(row.status),
    statusTone:fmt.statusTone(superseded?'superseded':row.status,'location'),
    distanceText:showDistance?'与登记位置相差约'+Math.round(assessment.distanceMeters)+'米':'',
    accuracyText:accuracyText(row.coords),capturedText:fmt.timeText(row.capturedAt||row.coords?.capturedAt),
    positionText:positionLabels[row.coords?.source]||'',captureTimeLabel:timeLabels[row.coords?.source]||'采集时间',
    needsExplanation:!superseded&&['exception','location_anomaly'].includes(row.status)
  };
}

Page(define({
  collections:['outlets',{
    name:'verifications',
    visible(){return !!selectedOutlet(this);},
    filters(){return {outlet:selectedOutlet(this)?.id};}
  }],
  data:{outlets:[],outletNames:[],outletIndex:-1,outletId:'',month:fmt.month(),form:{address:'',explanation:''},coords:null,photo:null,preview:'',markers:[],accuracy:'',capturedText:'',captureTimeLabel:'',history:[],monthStatus:'',submissionNotice:'',recordError:'',canSubmitEvidence:false,needsExplanation:false,gpsPermissionDenied:false,locationPermissionMessage:'',locating:false,uploadingPhoto:false},
  load(q){if(q.month)this.setData({month:q.month});},
  async loaded(s){
    const outlets=s.outlets.filter(o=>o.owner);
    const outlet=selectedOutlet(this,outlets);
    const outletIndex=outlets.findIndex(row=>row.id===outlet?.id);
    if(outlet)this.query.outlet=outlet.id;
    const currentHistory=s.verifications.filter(x=>x.outlet===outlet?.id);
    let history=currentHistory;
    let recordError='';
    const id=this.query.id;
    if(id&&outlet){
      const serial=this._serial;
      let record=history.find(x=>x.id===id);
      if(!record){
        try{record=await api.detail('verifications',id);}
        catch(error){if(![403,404].includes(error.status))throw error;}
      }
      if(serial!==this._serial||id!==this.query.id)return;
      if(record?.outlet===outlet.id&&(!this.query.month||record.month===this.query.month)){
        history=[record,...history.filter(x=>x.id!==id)];
        if(!this.query.month)this.setData({month:record.month});
      }else recordError='暂时无法查看这条核验记录，请核对网点和月份后从原事项重新进入。';
    }
    const superseded=new Set(history.map(row=>row.previousId).filter(Boolean));
    this.setData({outlets,outletNames:['请选择网点',...outlets.map(row=>row.name)],outletIndex,outletId:outlet?.id||'',recordError,
      submissionNotice:'',history:history.map(row=>verificationRow(row,superseded.has(row.id)))},()=>{
      if(id&&recordError)return;
      if(id||this.query.section==='history')this.scrollToVerification(id);
    });
    this.updateMonthState(this.data.month,currentHistory);
    if(this._formOutlet!==outlet?.id){
      this._formOutlet=outlet?.id;
      this.resetEvidence({'form.address':outlet?.address||''});
    }
  },
  updateMonthState(month,rows=this.data.state?.verifications||[],onUpdate){
    const outlet=this.data.outletId;
    const latest=rows.find(row=>row.outlet===outlet&&row.month===month);
    const today=this.data.state?.today;
    const status=this.data.outlets[this.data.outletIndex]?.status;
    const waiting=outlet&&['open','paused'].includes(status)&&month===today?.slice(0,7)&&!this.data.pagers.verifications?.hasMore;
    const needsExplanation=['exception','location_anomaly'].includes(latest?.status);
    this.setData({
      monthStatus:latest?verificationProgress(latest):waiting?'等待提交现场核验资料':'',
      canSubmitEvidence:!!outlet&&!this.data.recordError&&(!latest||needsExplanation),
      needsExplanation
    },onUpdate);
  },
  scrollToVerification(id){
    const selector=id?'#verification-'+id:'#verification-history';
    if(this._scrolledToVerification===selector)return;
    this._scrolledToVerification=selector;
    wx.pageScrollTo?.({selector,duration:0});
  },
  resetEvidence(values={},onUpdate){
    this._captureScope=(this._captureScope||0)+1;
    this.setData({coords:null,photo:null,preview:'',markers:[],accuracy:'',capturedText:'',captureTimeLabel:'','form.explanation':'',gpsPermissionDenied:false,locationPermissionMessage:'',locating:false,uploadingPhoto:false,submissionNotice:'',...values},onUpdate);
  },
  async chooseOutlet(e){
    const outletIndex=Number(e.detail.value),outlet=this.data.outlets[outletIndex];
    if(this.data.busy||!outlet||outlet.id===this.data.outletId)return;
    this.query.outlet=outlet.id;
    this.query.id='';
    this._formOutlet=outlet.id;
    this.resetEvidence({outletIndex,outletId:outlet.id,'form.address':outlet.address,history:[],monthStatus:'',recordError:'',canSubmitEvidence:false,needsExplanation:false});
    await this.refresh();
  },
  chooseOutletFromPicker(e){
    return this.chooseOutlet({detail:{value:Number(e.detail.value)-1}});
  },
  chooseMonth(e,onUpdate){
    if(this.data.busy)return;
    if(this.data.month===e.detail.value){onUpdate?.();return;}
    this.query.id='';
    this.query.month=e.detail.value;
    this.resetEvidence({month:e.detail.value,recordError:''});
    this.updateMonthState(e.detail.value,undefined,onUpdate);
  },
  supplementLocation(e){
    if(this.data.loading||this.data.busy||this.data.recordError)return;
    const record=this.data.history.find(row=>row.id===e.currentTarget.dataset.id&&row.needsExplanation);
    if(!record)return;
    this.chooseMonth({detail:{value:record.month}},()=>wx.pageScrollTo({selector:'#verification-form',duration:200}));
  },
  async locate(e){
    if(!this.data.canSubmitEvidence||this.data.busy||this.data.loading)return;
    const scope=this._captureScope;
    const attempt=(this._locationAttempt||0)+1;
    this._locationAttempt=attempt;
    const isCurrent=()=>scope===this._captureScope&&attempt===this._locationAttempt;
    const manual=e.currentTarget.dataset.manual==='true';
    this.setData({coords:null,markers:[],accuracy:'',capturedText:'',captureTimeLabel:'',gpsPermissionDenied:false,locationPermissionMessage:'',locating:true,error:''});
    try{
      const {coords,address}=await api.locate(manual);
      if(!isCurrent())return;
      this.setData({coords,accuracy:accuracyText(coords),capturedText:fmt.timeText(coords.capturedAt),captureTimeLabel:timeLabels[coords.source],
        markers:[{id:1,latitude:coords.lat,longitude:coords.lng,width:24,height:32,title:positionLabels[coords.source]}],'form.address':address||this.data.form.address,error:''});
    }catch(e){
      if(!isCurrent())return;
      this.setData({error:e.message});
      if(manual||typeof wx.getSetting!=='function'||typeof wx.openSetting!=='function')return;
      wx.getSetting({success:({authSetting})=>{
        if(isCurrent()&&authSetting?.['scope.userLocation']===false)this.setData({gpsPermissionDenied:true,error:'请在设置中允许使用位置信息，再获取当前位置。'});
      }});
    }finally{if(isCurrent())this.setData({locating:false});}
  },
  openLocationSettings(){
    if(!this.data.gpsPermissionDenied||typeof wx.openSetting!=='function')return;
    const scope=this._captureScope,attempt=this._locationAttempt;
    const isCurrent=()=>scope===this._captureScope&&attempt===this._locationAttempt;
    wx.openSetting({
      success:({authSetting})=>{
        if(isCurrent()&&authSetting?.['scope.userLocation']===true)this.setData({gpsPermissionDenied:false,error:'',locationPermissionMessage:'位置权限已开启，请再次点击获取当前位置。'});
      },
      fail:()=>{if(isCurrent())this.setData({error:'暂时无法打开位置设置，请重试。'});}
    });
  },
  async photo(){
    if(!this.data.canSubmitEvidence||this.data.busy||this.data.loading||this.data.uploadingPhoto)return;
    const scope=this._captureScope;
    this.setData({photo:null,preview:'',uploadingPhoto:true,error:''});
    try{
      const {file,preview}=await api.uploadPhoto();
      if(scope===this._captureScope)this.setData({photo:file,preview,error:''});
    }catch(e){if(scope===this._captureScope)this.setData({error:e.message});}
    finally{if(scope===this._captureScope)this.setData({uploadingPhoto:false});}
  },
  async submit(){
    if(this.data.loading||this.data.busy||this.data.locating||this.data.uploadingPhoto)return;
    const {outletId:outlet,coords,photo,form,month}=this.data;
    if(!outlet)return this.setData({error:'请先选择核验网点。'});
    if(!this.data.canSubmitEvidence)return;
    if(!coords||!photo||!form.address.trim())return this.setData({error:'请填写实际经营地址、确认位置并上传现场照片。'});
    if(this.data.needsExplanation&&!form.explanation.trim())return this.setData({error:'请填写这次核验的补充说明。'});
    const result=await this.mutate('location.submit',{outlet,month,coords,capturedAt:coords.capturedAt,address:form.address,photo,explanation:form.explanation},'位置资料已提交。');
    const record=result?.result;
    if(!record?.id||this.data.outletId!==outlet||this.data.month!==month)return;
    this.query.id=record.id;
    this.query.month=month;
    const needsExplanation=['exception','location_anomaly'].includes(record.status);
    const history=this.data.history.some(row=>row.id===record.id)?this.data.history:[
      verificationRow({...record,outletName:this.data.outlets[this.data.outletIndex]?.name},false),
      ...this.data.history.map(row=>row.id===record.previousId?verificationRow(row,true):row)
    ];
    this.resetEvidence({history,submissionNotice:verificationProgress(record),canSubmitEvidence:needsExplanation,needsExplanation},()=>this.scrollToVerification(record.id));
  }
}));
