const api=require('../../utils/api');
const {go,reLaunch,nativeSessionLoginUrl}=require('../../utils/navigation');
/* DEV_ONLY_START */
const roleTrial=require('../../development/role-trial');
/* DEV_ONLY_END */

const applicationPath='/api/onboarding/applications';
const trackingKey='jyyc.joinTracking';
const statuses={pending:'待总部审核',returned:'需补充凭证',approved:'加盟申请已通过'};
const blank={name:'',mobile:'',organization:'',note:''};
const fields=new Set(Object.keys(blank));

Page({
  data:{statusLabels:statuses,applications:[],form:blank,formMode:'none',loading:true,busy:false,uploading:false,photo:null},
  onLoad(query){
    this.entryId=/^join-[a-f0-9-]{36}$/.test(query?.id||'')?query.id:'';
    this.id=this.entryId;
    this.loadNumber=0;
    this.applicationStarted=false;
  },
  onShow(){return this.refresh();},
  onUnload(){this.loadNumber+=1;this.unloaded=true;},
  scopeSession(session){
    const token=session?.token;
    if(this.sessionToken===token)return;
    const wasScoped=this.sessionToken!==undefined;
    this.sessionToken=token;
    if(!wasScoped)return;
    this.id=this.entryId;
    this.formVersion=null;
    this.applicationStarted=false;
    this.attempt=null;
    this.setData({guest:false,record:null,applications:[],form:blank,photo:null,config:null,
      formMode:'none',formError:'',showRecovery:false,trackingCode:'',recoveryError:'',busy:false,uploading:false});
  },
  isCurrent(token){
    return Boolean(token)&&!this.unloaded&&this.sessionToken===token&&api.session()?.token===token;
  },
  async refresh(){
    const load=++this.loadNumber;
    this.scopeSession(api.session());
    this.setData({loading:true,loadError:'',qrImage:'',qrError:false});
    try{
      /* DEV_ONLY_START */
      if(roleTrial.enabled&&roleTrial.mode()==='applicant')await roleTrial.enter('applicant');
      /* DEV_ONLY_END */
      const current=api.session()||await api.ensureVisitor();
      if(load!==this.loadNumber||current.token!==api.session()?.token)return;
      this.scopeSession(current);
      const loginUrl=nativeSessionLoginUrl(current);
      if(loginUrl){reLaunch(loginUrl);return;}
      const guest=current.role==='public';
      const result=await api.request(applicationPath+(this.id?'?'+api.query({id:this.id}):''));
      if(load!==this.loadNumber)return;
      if(!this.isCurrent(current.token))return this.refresh();
      const record=this.id?result.items[0]:result.items.length===1?result.items[0]:null;
      if(this.id&&!record)throw new Error('当前账号无法查看这份加盟申请。请核对账号或用申请查询码找回。');
      this.setData({guest,record:record||null,applications:result.items});
      this.fillRecord(record);
      /* DEV_ONLY_START */
      if(roleTrial.enabled&&guest&&roleTrial.mode()==='applicant'){
        this.setData({roleTrial:true});
        api.collection('messages',{status:'unread',limit:1},this).then(notices=>{
          if(this.isCurrent(current.token)&&load===this.loadNumber)this.setData({trialHasUnread:notices.total>0});
        }).catch(()=>{});
      }
      /* DEV_ONLY_END */
      if(guest&&record?.status==='returned'){
        this.setData({formMode:'supplement',config:null});
      }else if(guest&&!record&&!result.items.length){
        if(!this.applicationStarted){
          this.setData({formMode:'choose',config:null});
          return;
        }
        const previous=this.data.config;
        const config=await api.request('/api/onboarding/config');
        if(load!==this.loadNumber)return;
        if(!this.isCurrent(current.token))return this.refresh();
        const changed=previous?.enabled&&(!config.enabled||previous.qrFileId!==config.qrFileId||previous.payee!==config.payee);
        const formMode=changed||this.data.formMode==='payment_changed'?'payment_changed':config.enabled?'new':'closed';
        this.setData({config,formMode});
        if(formMode!=='new')return;
        try{
          const qrImage=await api.download('/api/files/'+encodeURIComponent(config.qrFileId));
          if(load===this.loadNumber&&this.isCurrent(current.token))this.setData({qrImage});
        }catch{
          if(load===this.loadNumber&&this.isCurrent(current.token))this.setData({qrError:true});
        }
      }else{
        this.setData({formMode:'none',config:null,photo:null});
      }
    }catch(error){
      if(load===this.loadNumber){
        this.scopeSession(api.session());
        this.setData({loadError:error.message,formMode:'none',record:null,applications:[]});
      }
    }finally{
      if(load===this.loadNumber)this.setData({loading:false});
    }
  },
  fillRecord(record){
    if(!record||record.status!=='returned'||this.formVersion===record.id+':'+record.version)return;
    this.formVersion=record.id+':'+record.version;
    this.setData({form:Object.fromEntries(Object.keys(blank).map(field=>[field,record[field]||''])),photo:null});
  },
  input(e){
    const field=e.currentTarget.dataset.field;
    if(fields.has(field))this.setData({['form.'+field]:e.detail.value});
  },
  proofScope(){
    const {formMode,record,config}=this.data;
    if(formMode==='supplement'&&record?.status==='returned')return record.id+':'+record.version;
    if(formMode==='new'&&config?.enabled)return JSON.stringify([config.qrFileId,config.payee]);
    return '';
  },
  async choosePhoto(event){
    const scope=this.proofScope();
    const session=api.session()?.token;
    if(this.data.loading||this.data.uploading||this.data.busy||!scope||!this.isCurrent(session)||
      this.data.formMode==='new'&&!this.data.qrImage)return;
    this.setData({uploading:true,formError:''});
    try{
      const record=this.data.formMode==='supplement'?this.data.record:null;
      let selected;
      /* DEV_ONLY_START */
      if(roleTrial.enabled&&event?.currentTarget.dataset.sample&&record){
        const tempFilePath=await api.download('/api/role-trial/proof');
        if(!this.isCurrent(session)||scope!==this.proofScope())return;
        selected={tempFilePath,type:'image/png'};
      }
      /* DEV_ONLY_END */
      const photo=await api.uploadPhoto({purpose:'onboarding-proof',sourceType:['album'],
        ...(record?{applicationId:record.id,applicationVersion:record.version}:{}),...(selected?{selected}:{})});
      if(this.isCurrent(session)&&scope===this.proofScope())this.setData({photo});
    }catch(error){if(this.isCurrent(session)&&scope===this.proofScope())this.showFormError(error);}
    finally{if(this.isCurrent(session))this.setData({uploading:false});}
  },
  preview(e){
    const path=e.currentTarget.dataset.image==='qr'?this.data.qrImage:this.data.photo?.preview;
    if(path)wx.previewImage({urls:[path]});
  },
  async submit(){
    const {form,photo,record,config,busy,uploading}=this.data;
    const session=api.session()?.token;
    if(this.data.loading||busy||uploading||!this.isCurrent(session)||!this.proofScope()||!this.data.guest||
      this.data.formMode==='new'&&!this.data.qrImage)return;
    const payload=Object.fromEntries(Object.entries(form).map(([field,value])=>[field,value.trim()]));
    let formError='';
    if(!payload.name)formError='请填写申请人姓名。';
    else if(!/^1[3-9]\d{9}$/.test(payload.mobile))formError='请填写有效的手机号。';
    else if(payload.organization.length<2)formError='请填写申请加盟的单位或主体名称。';
    else if(!photo)formError='请上传本次付款凭证。';
    if(formError){this.setData({formError});return;}
    Object.assign(payload,{fileId:photo.file.id},record?.status==='returned'?{id:record.id,version:record.version}:{qrFileId:config.qrFileId});
    const contents=JSON.stringify(payload);
    if(this.attempt?.contents!==contents)this.attempt={contents,key:api.newCommandKey()};
    this.setData({busy:true,formError:''});
    try{
      const result=await api.request(applicationPath,'POST',payload,{'Idempotency-Key':this.attempt.key});
      if(!this.isCurrent(session))return;
      this.id=result.id;
      this.remember(result.trackingCode);
      this.attempt=null;
      this.setData({record:result,formMode:'none',photo:null,showRecovery:false});
      wx.pageScrollTo?.({scrollTop:0,duration:150});
    }catch(error){if(this.isCurrent(session))this.showFormError(error);}
    finally{if(this.isCurrent(session))this.setData({busy:false});}
  },
  showFormError(error){
    if(this.data.formMode==='new'&&['收款信息已更新，请重新核对后提交','加盟申请暂未开放'].includes(error.message)){
      this.setData({formMode:'payment_changed',qrImage:'',formError:''});
    }else this.setData({formError:error.message});
  },
  remember(code){
    const session=api.session();
    if(code&&session?.role==='public'&&session.subject){
      try{wx.setStorageSync(trackingKey,{subject:session.subject,code});}catch{}
    }
  },
  showTracking(){
    const code=this.data.record?.trackingCode;
    if(code)wx.setClipboardData({data:code});
  },
  startApplication(){
    if(!this.data.guest||this.data.formMode!=='choose'||this.data.loading||this.data.busy)return;
    this.applicationStarted=true;
    this.setData({showRecovery:false,recoveryError:''});
    return this.refresh();
  },
  restartUnpaidApplication(){
    if(this.data.formMode!=='payment_changed'||this.data.loading||this.data.busy||this.data.uploading||
      !this.isCurrent(api.session()?.token))return;
    this.attempt=null;
    this.setData({config:null,photo:null,formMode:'none',formError:''});
    return this.refresh();
  },
  toggleRecovery(){
    if(!this.data.busy&&!this.data.uploading)this.setData({showRecovery:!this.data.showRecovery,recoveryError:''});
  },
  recoveryInput(e){this.setData({trackingCode:e.detail.value});},
  async recover(){
    if(this.data.loading||this.data.busy||this.data.uploading)return;
    const current=api.session();
    if(!current||!this.isCurrent(current.token))return;
    const saved=wx.getStorageSync?.(trackingKey);
    const trackingCode=this.data.trackingCode?.trim()||(current.subject&&saved?.subject===current.subject?saved.code:'');
    if(!trackingCode){this.setData({recoveryError:'请输入申请查询码。'});return;}
    this.setData({busy:true,recoveryError:''});
    try{
      const record=await api.request('/api/onboarding/recover','POST',{trackingCode});
      if(!this.isCurrent(current.token))return;
      this.id=record.id;
      this.applicationStarted=false;
      this.remember(record.trackingCode);
      this.setData({showRecovery:false,trackingCode:''});
      await this.refresh();
    }catch(error){if(this.isCurrent(current.token))this.setData({recoveryError:error.status===404?'申请查询码无效，请核对后重试。':error.message});}
    finally{if(this.isCurrent(current.token))this.setData({busy:false});}
  },
  openRecord(e){
    this.id=e.currentTarget.dataset.id;
    return this.refresh();
  },
  login(){
    const stage=this.data.record?.activationStatus;
    go('login',stage==='activated'||stage==='unavailable'?'':'mode=activate');
  },
  openWorkbench(){go('home');},
  contact(){go('support');},
  /* DEV_ONLY_START */
  trialNotices(){if(roleTrial.enabled)go('messages');},
  /* DEV_ONLY_END */
});
