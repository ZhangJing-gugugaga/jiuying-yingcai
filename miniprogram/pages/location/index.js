const {define,api,fmt}=require('../../utils/page');
const drafts=require('../../utils/business-drafts');
const addressLimit=2000, explanationLimit=600;

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
    statusTone:superseded?'gray':fmt.statusTone(row.status,'location'),
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
  data:{outlets:[],outletNames:[],outletIndex:-1,outletId:'',month:'',form:{address:'',explanation:''},coords:null,photo:null,preview:'',markers:[],accuracy:'',capturedText:'',captureTimeLabel:'',history:[],monthStatus:'',submissionNotice:'',recordError:'',monthError:'',monthLoading:false,verificationNote:'',canSubmitEvidence:false,needsExplanation:false,gpsPermissionDenied:false,locationPermissionMessage:'',positionError:'',photoError:'',locating:false,uploadingPhoto:false,photoProgress:null,recoveryAvailable:false,draftNotice:'',recentDraft:null},
  load(q){this.setData({month:q.month||'',historyExpanded:q.section==='history',monthHistory:[]});},
  onHide(){this.persistDraft();},
  onUnload(){
    this.persistDraft();
    this._captureScope=(this._captureScope||0)+1;
  },
  async loaded(s){
    if(!this.data.month)this.setData({month:s.today.slice(0,7)});
    const serial=this._serial,id=this.query.id;
    let outlets=s.outlets.filter(o=>o.owner);
    let outlet=selectedOutlet(this,outlets);
    let recordError='',record;
    if(id){
      try{
        record=s.verifications.find(row=>row.id===id)||await api.detail('verifications',id);
        if(serial!==this._serial||id!==this.query.id)return;
        if(!this.query.outlet&&record?.outlet){
          outlet=outlets.find(row=>row.id===record.outlet);
          if(!outlet){
            const linkedOutlet=await api.detail('outlets',record.outlet);
            if(serial!==this._serial||id!==this.query.id)return;
            if(linkedOutlet.owner){outlet=linkedOutlet;outlets=[linkedOutlet,...outlets];}
          }
        }
      }catch(error){if(![403,404].includes(error.status))throw error;}
      if(serial!==this._serial||id!==this.query.id)return;
    }
    if(outlet&&!this.query.outlet&&id){
      this.query.outlet=outlet.id;
      if(!s.outlets.some(row=>row.id===outlet.id))this.setData({'state.outlets':outlets});
      if(!this.data.pagers.verifications){
        await this.fetchCollection('verifications',true,serial,false);
        if(serial!==this._serial||id!==this.query.id)return;
        s=this.data.state;
      }
    }
    const outletIndex=outlets.findIndex(row=>row.id===outlet?.id);
    if(outlet)this.query.outlet=outlet.id;
    let history=s.verifications.filter(x=>x.outlet===outlet?.id);
    if(id){
      if(outlet&&record?.outlet===outlet.id&&(!this.query.month||record.month===this.query.month)){
        history=[record,...history.filter(x=>x.id!==id)];
        if(!this.query.month)this.setData({month:record.month});
      }else recordError='暂时无法查看这条核验记录，请核对网点和月份后从原事项重新进入。';
    }
    const superseded=new Set(history.map(row=>row.previousId).filter(Boolean));
    this.setData({outlets,outletNames:['请选择网点',...outlets.map(fmt.outletOptionLabel)],outletIndex,outletId:outlet?.id||'',recordError,
      submissionNotice:'',history:history.map(row=>verificationRow(row,superseded.has(row.id)))});
    const token=api.session()?.token;
    if(this._formOutlet!==outlet?.id||this._formToken!==token){
      this._formOutlet=outlet?.id;
      this._formToken=token;
      this.resetEvidence({'form.address':outlet?.address||''});
    }
    const month=this.data.month,scope=this._captureScope;
    await this.updateMonthState(month);
    if(serial===this._serial&&!outlet&&!id&&!this.query.outlet){
      const draft=drafts.read('location',api.session());
      const allowed=outlets.find(row=>row.id===draft?.outlet);
      if(allowed&&/^\d{4}-(0[1-9]|1[0-2])$/.test(draft.month)&&draft.month<=s.today.slice(0,7)){
        this.setData({recentDraft:{outlet:allowed.id,month:draft.month,label:fmt.outletOptionLabel(allowed)+' · '+fmt.monthText(draft.month)}});
      }
    }
    if(serial!==this._serial||scope!==this._captureScope||id!==this.query.id||
      this._scrolledToVerification||(!id&&this.query.section!=='history')||recordError)return;
    this._scrolledToVerification=true;
    this.setData({},()=>wx.pageScrollTo?.({selector:id?'#verification-'+id:'#verification-history',duration:0}));
  },
  async updateMonthState(month){
    const {outletId:outlet,recordError}=this.data;
    const scope=this._captureScope,serial=this._serial;
    const attempt=(this._monthAttempt||0)+1;
    this._monthAttempt=attempt;
    this.persistDraft();
    this._draftContext=null;
    this.setData({recoveryAvailable:false,recentDraft:null});
    const current=()=>attempt===this._monthAttempt&&scope===this._captureScope&&serial===this._serial&&month===this.data.month&&outlet===this.data.outletId;
    const show=record=>{
      const needsExplanation=['exception','location_anomaly'].includes(record?.status);
      const active=['open','paused'].includes(this.data.outlets[this.data.outletIndex]?.status);
      const trail=Array.isArray(record?.trail)?record.trail:[];
      const fingerprint=JSON.stringify([record?.id||'',record?.status||'',trail.length,trail.at(-1)?.at||'']);
      this._draftContext={outlet,month,fingerprint};
      const saved=this.matchDraft();
      const canSubmitEvidence=!record||needsExplanation;
      this.setData({monthStatus:record?verificationProgress(record):active?'所选月份尚未提交核验资料':'',
        canSubmitEvidence,needsExplanation,verificationNote:needsExplanation?record.publicNote||'':'',
        recoveryAvailable:canSubmitEvidence&&!!saved&&!this.hasEvidence()});
      if(!canSubmitEvidence&&saved)drafts.clear('location');
    };
    if(!outlet||recordError){
      this.setData({monthHistory:[],monthStatus:'',monthLoading:false,monthError:'',canSubmitEvidence:false,needsExplanation:false,verificationNote:''});
      return;
    }
    if(month>this.data.state?.today?.slice(0,7)){
      this.setData({monthHistory:[],monthStatus:'所选月份尚未开始',monthLoading:false,monthError:'',canSubmitEvidence:false,needsExplanation:false,verificationNote:''});
      return;
    }
    this.setData({monthHistory:[],monthStatus:'',monthLoading:true,monthError:'',canSubmitEvidence:false,needsExplanation:false,verificationNote:''});
    try{
      const {items}=await api.collection('verifications',{outlet,month,limit:1});
      if(!current())return;
      const latest=items[0];
      if(latest){
        const row=verificationRow({...latest,outletName:latest.outletName||this.data.outlets[this.data.outletIndex]?.name},false);
        const earlier=this.data.history.filter(item=>item.id!==row.id).map(item=>item.id===latest.previousId?verificationRow(item,true):item);
        const linked=earlier.find(item=>item.id===this.query.id&&item.month===month);
        const monthHistory=linked?[linked,row]:[row];
        const history=[...monthHistory,...earlier.filter(item=>item.id!==linked?.id)];
        this.setData({history,monthHistory});
      }
      show(latest);
    }catch(error){
      if(current())this.setData({monthStatus:'',monthError:error.message,canSubmitEvidence:false,needsExplanation:false,verificationNote:''});
    }finally{if(current())this.setData({monthLoading:false});}
  },
  retryMonth(){return this.updateMonthState(this.data.month);},
  matchDraft(){
    const saved=drafts.read('location',api.session());
    const current=this._draftContext;
    if(!saved||!current||saved.outlet!==current.outlet||saved.month!==current.month)return null;
    if(saved.fingerprint!==current.fingerprint){drafts.clear('location');return null;}
    return typeof saved.address==='string'&&typeof saved.explanation==='string'?saved:null;
  },
  persistDraft(){
    const session=api.session();
    const {outletId,month,form,outlets,outletIndex,canSubmitEvidence}=this.data;
    const scope=this._draftContext;
    if(!scope||session?.token!==this._formToken||scope.outlet!==outletId||scope.month!==month||!canSubmitEvidence)return false;
    if(form.address===(outlets[outletIndex]?.address||'')&&!form.explanation.trim())return false;
    return drafts.save('location',session,{...scope,address:form.address.slice(0,addressLimit),explanation:form.explanation.slice(0,explanationLimit)});
  },
  saveRecovery(){
    const saved=this.persistDraft();
    this.setData({draftNotice:saved?'地址和说明已保存在本机。': '未保存草稿，请检查是否填写了地址修改或补充说明。'});
  },
  restoreRecovery(){
    if(!this.data.canSubmitEvidence||this.data.loading||this.data.monthLoading||this.data.busy||this.hasEvidence())return;
    const saved=this.matchDraft();
    if(!saved){this.setData({recoveryAvailable:false});return;}
    this.setData({form:{address:saved.address.slice(0,addressLimit),explanation:saved.explanation.slice(0,explanationLimit)},recoveryAvailable:false,
      draftNotice:'已恢复地址和说明。请重新确认位置并上传现场照片。'});
  },
  discardRecovery(){
    if(this.matchDraft())drafts.clear('location');
    this.setData({recoveryAvailable:false,draftNotice:''});
  },
  async resumeRecentDraft(){
    const {recentDraft}=this.data;
    const saved=drafts.read('location',api.session());
    if(!recentDraft||!saved||saved.outlet!==recentDraft.outlet||saved.month!==recentDraft.month||this.data.busy||this.data.loading)return;
    this.query={outlet:saved.outlet,month:saved.month};
    this.setData({month:saved.month,recentDraft:null});
    await this.refresh();
  },
  input(event){
    const field=event.currentTarget.dataset.field;
    if(!['address','explanation'].includes(field)||!this.data.canSubmitEvidence||this.data.loading||this.data.busy)return;
    this.setData({['form.'+field]:event.detail.value,recoveryAvailable:false,draftNotice:''});
  },
  toggleHistory(){this.setData({historyExpanded:!this.data.historyExpanded});},
  hasEvidence(){
    const {coords,photo,form,outlets,outletIndex}=this.data;
    return !!(coords||photo||form.explanation.trim()||form.address!==(outlets[outletIndex]?.address||''));
  },
  async confirmScopeChange(){
    if(this._scopePrompt)return false;
    if(typeof wx.showModal!=='function'){
      this.setData({scopeChangeError:'无法确认切换，已保留您填写的核验资料。'});
      return false;
    }
    const scope=this._captureScope,serial=this._serial;
    this._scopePrompt=true;
    try{
      const confirmed=await new Promise(resolve=>wx.showModal({title:'切换核验对象？',content:'切换时会尝试保存已填写的地址和说明。位置与照片需按新对象重新采集。',confirmText:'继续切换',cancelText:'继续填写',success:({confirm})=>resolve(confirm),fail:()=>resolve(false)}));
      return confirmed&&scope===this._captureScope&&serial===this._serial&&!this.data.busy;
    }catch{
      if(scope===this._captureScope&&serial===this._serial)this.setData({scopeChangeError:'无法确认切换，已保留您填写的核验资料。'});
      return false;
    }finally{this._scopePrompt=false;}
  },
  resetEvidence(values={}){
    this._captureScope=(this._captureScope||0)+1;
    this.setData({coords:null,photo:null,preview:'',markers:[],accuracy:'',capturedText:'',captureTimeLabel:'','form.explanation':'',gpsPermissionDenied:false,locationPermissionMessage:'',positionError:'',photoError:'',locating:false,uploadingPhoto:false,photoProgress:null,submissionNotice:'',previewUnavailable:false,errorArea:'',scopeChangeError:'',recoveryAvailable:false,draftNotice:'',recentDraft:null,...values});
  },
  async chooseOutlet(e){
    const outletIndex=Number(e.detail.value),outlet=this.data.outlets[outletIndex];
    if(this.data.busy||!outlet||outlet.id===this.data.outletId)return;
    if(this.hasEvidence()&&!await this.confirmScopeChange())return;
    this.persistDraft();
    this.query.outlet=outlet.id;
    this.query.id='';
    this._formOutlet=outlet.id;
    this.resetEvidence({outletIndex,outletId:outlet.id,'form.address':outlet.address,history:[],monthHistory:[],historyExpanded:false,monthStatus:'',recordError:'',canSubmitEvidence:false,needsExplanation:false});
    await this.refresh();
  },
  chooseOutletFromPicker(e){
    return this.chooseOutlet({detail:{value:Number(e.detail.value)-1}});
  },
  async chooseMonth(e,onUpdate){
    if(this.data.busy)return;
    const month=e.detail.value;
    if(this.data.month===month){onUpdate?.();return;}
    if(this.hasEvidence()&&!await this.confirmScopeChange())return;
    this.persistDraft();
    const address=this.data.outlets[this.data.outletIndex]?.address||'';
    this.query.id='';
    this.query.month=month;
    this.resetEvidence({month,monthHistory:[],historyExpanded:false,recordError:'','form.address':address});
    await this.updateMonthState(month);
    if(this.data.month===month)onUpdate?.();
  },
  supplementLocation(e){
    if(this.data.loading||this.data.busy||this.data.recordError)return;
    const record=this.data.history.find(row=>row.id===e.currentTarget.dataset.id&&row.needsExplanation);
    if(!record)return;
    return this.chooseMonth({detail:{value:record.month}},()=>{
      if(this.data.canSubmitEvidence&&this.data.needsExplanation)wx.pageScrollTo?.({selector:'#verification-form',duration:200});
    });
  },
  async locate(e){
    if(!this.data.canSubmitEvidence||this.data.busy||this.data.loading)return;
    const scope=this._captureScope,token=api.session()?.token;
    const attempt=(this._locationAttempt||0)+1;
    this._locationAttempt=attempt;
    const isCurrent=()=>scope===this._captureScope&&attempt===this._locationAttempt&&token===api.session()?.token;
    const manual=e.currentTarget.dataset.manual==='true';
    this.setData({coords:null,markers:[],accuracy:'',capturedText:'',captureTimeLabel:'',gpsPermissionDenied:false,locationPermissionMessage:'',positionError:'',locating:true,error:'',errorArea:'position'});
    try{
      const {coords,address}=await api.locate(manual);
      if(!isCurrent())return;
      this.setData({coords,accuracy:accuracyText(coords),capturedText:fmt.timeText(coords.capturedAt),captureTimeLabel:timeLabels[coords.source],
        markers:[{id:1,latitude:coords.lat,longitude:coords.lng,width:24,height:32,title:positionLabels[coords.source]}],'form.address':address||this.data.form.address,error:''});
    }catch(e){
      if(!isCurrent())return;
      this.setData({error:e.message,positionError:e.message});
      if(manual||typeof wx.getSetting!=='function'||typeof wx.openSetting!=='function')return;
      wx.getSetting({success:({authSetting})=>{
        if(isCurrent()&&authSetting?.['scope.userLocation']===false){
          const positionError='请在设置中允许使用位置信息，再获取当前位置。';
          this.setData({gpsPermissionDenied:true,error:positionError,positionError});
        }
      }});
    }finally{if(isCurrent())this.setData({locating:false});}
  },
  openLocationSettings(){
    if(!this.data.gpsPermissionDenied||typeof wx.openSetting!=='function')return;
    const scope=this._captureScope,attempt=this._locationAttempt,token=api.session()?.token;
    const isCurrent=()=>scope===this._captureScope&&attempt===this._locationAttempt&&token===api.session()?.token;
    wx.openSetting({
      success:({authSetting})=>{
        if(isCurrent()&&authSetting?.['scope.userLocation']===true)this.setData({gpsPermissionDenied:false,error:'',positionError:'',locationPermissionMessage:'位置权限已开启，请再次点击获取当前位置。'});
      },
      fail:()=>{
        const positionError='暂时无法打开位置设置，请重试。';
        if(isCurrent())this.setData({error:positionError,positionError});
      }
    });
  },
  async photo(){
    if(!this.data.canSubmitEvidence||this.data.busy||this.data.loading||this.data.uploadingPhoto)return;
    const scope=this._captureScope,token=api.session()?.token;
    const isCurrent=()=>scope===this._captureScope&&token===api.session()?.token;
    this.setData({photo:null,preview:'',previewUnavailable:false,uploadingPhoto:true,photoProgress:null,photoError:'',error:'',errorArea:'photo'});
    try{
      const {file,preview}=await api.uploadPhoto({onProgress:photoProgress=>{
        if(isCurrent()&&this.data.uploadingPhoto)this.setData({photoProgress});
      }});
      if(isCurrent())this.setData({photo:file,preview,previewUnavailable:false,error:''});
    }catch(e){if(isCurrent())this.setData({error:e.message,photoError:e.message});}
    finally{if(isCurrent())this.setData({uploadingPhoto:false});}
  },
  photoPreviewFailed(e){
    if(e.currentTarget.dataset.fileId===this.data.photo?.id)this.setData({previewUnavailable:true});
  },
  async submit(){
    if(this.data.loading||this.data.busy||this._scopePrompt||this.data.monthLoading||this.data.locating||this.data.uploadingPhoto)return;
    const {outletId:outlet,coords,photo,form,month}=this.data;
    this.setData({errorArea:'submit'});
    if(!outlet)return this.setData({error:'请先选择核验网点。'});
    if(!this.data.canSubmitEvidence)return;
    if(!form.address.trim())return this.setData({error:'请填写实际经营地址。'});
    if(!coords)return this.setData({error:'请获取现场定位，或手动确认地址后提交。'});
    if(!photo)return this.setData({error:'请上传现场照片。'});
    if(this.data.needsExplanation&&!form.explanation.trim())return this.setData({error:'请填写这次核验的补充说明。'});
    const scope=this._captureScope,token=api.session()?.token;
    const result=await this.mutate('location.submit',{outlet,month,coords,capturedAt:coords.capturedAt,address:form.address,photo,explanation:form.explanation},'位置资料已提交。');
    if(result&&scope===this._captureScope&&token===api.session()?.token){
      this.discardRecovery();
      this.resetEvidence({submissionNotice:this.data.monthStatus||verificationProgress(result.result)});
    }
  }
}));
