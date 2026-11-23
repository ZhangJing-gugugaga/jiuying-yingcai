const api=require('../../utils/api');
const {go,reLaunch,resumeAfterLogin,isStaffRole,nativeSessionLoginUrl}=require('../../utils/navigation');
/* DEV_ONLY_START */
const config=require('../../config');
const development=require('../../development/login');
const roleTrial=require('../../development/role-trial');
/* DEV_ONLY_END */

const wechatUnavailable='微信登录暂未开放，请使用已开通的登录方式。';
const smsUnavailable='手机验证码登录暂未开放，请使用账号登录。';
const unknownRole='当前账号权限无法识别，请核对账号或联系总部客服。';
const staffPortalPattern=/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?\/?$/i;
const signInErrors={
  INVALID_CREDENTIALS:'账号或密码不正确',
  ACTIVATION_INVALID:'激活码已失效，请联系总部重新领取。',
  ACCOUNT:'账号暂不可用，请联系总部客服。'
};
const activationFields=[
  {name:'activationToken',label:'激活码',placeholder:'请输入总部发放的激活码'},
  {name:'password',label:'设置登录密码',placeholder:'请设置 12–128 位密码'},
  {name:'confirmPassword',label:'确认登录密码',placeholder:'请再次输入密码'}
];

Page({
  data:{
    busy:false,error:'',mode:'methods',username:'',password:'',confirmPassword:'',
    activationToken:'',mobile:'',smsCode:'',challengeId:'',resendSeconds:0,
    wechatEnabled:false,smsEnabled:false,activationFields,activationField:'',visibleActivationFields:{},channelsLoading:true,
    staffPortalUrl:'',sessionCleanupPending:false,sessionCleanupRequired:false,sessionCleanupError:'',
    /* DEV_ONLY_START */
    development:false,smsMode:'',devCode:'',developerToolsExpanded:false,...development.data,
    /* DEV_ONLY_END */
  },
  /* DEV_ONLY_START */
  ...development.handlers,
  toggleDeveloperTools(){
    if(this.data.development&&!this.data.busy)this.setData({developerToolsExpanded:!this.data.developerToolsExpanded});
  },
  /* DEV_ONLY_END */
  onLoad(query) {
    this.next=query?.next;
    if(query?.mode==='activate')this.setData({mode:'activate'});
    if(query?.token)this.setData({activationToken:query.token,mode:'activate'});
    if(query?.mode==='activate'||query?.token)wx.setNavigationBarTitle?.({title:'首次激活'});
    if(query?.reason==='session-expired')this.setData({error:'登录已失效，请重新登录后继续。'});
  },
  onShow() {
    const current=api.session();
    const settings=this.loadSettings();
    if(nativeSessionLoginUrl(current))return Promise.all([this.finishSignIn(current),settings]);
    return settings;
  },
  async loadSettings() {
    try {
      const settings=await api.request('/api/config','GET',undefined,{Authorization:''});
      if(this._unloaded)return;
      let allowSms=settings.authCapabilities?.mode!=='mock';
      /* DEV_ONLY_START */
      allowSms=allowSms||config.development;
      this.setData({development:config.development&&settings.devLoginEnabled===true});
      /* DEV_ONLY_END */
      this.updateChannels({
        wechatEnabled:settings.authCapabilities?.wechat===true||settings.wechatLoginEnabled===true,
        smsEnabled:allowSms&&(settings.authCapabilities?.sms===true||settings.smsLoginEnabled===true),
        staffPortalUrl:typeof settings.staffPortalUrl==='string'&&staffPortalPattern.test(settings.staffPortalUrl)?settings.staffPortalUrl:''
      });
    } catch {
      if(this._unloaded)return;
      /* DEV_ONLY_START */
      this.setData({development:false});
      /* DEV_ONLY_END */
      this.updateChannels({wechatEnabled:false,smsEnabled:false,staffPortalUrl:''});
    }
  },
  updateChannels(channels) {
    const {mode}=this.data;
    const landing=channels.wechatEnabled||channels.smsEnabled?'methods':'password';
    if(mode==='sms'&&!channels.smsEnabled){
      this.setData({...channels,mode:landing,error:'',channelsLoading:false});
    }else this.setData({...channels,mode:mode==='methods'?landing:mode,channelsLoading:false});
  },
  input(e) {
    const field=e.currentTarget.dataset.field;
    this.setData({[field]:e.detail.value,...(this.data.mode==='activate'&&this.data.activationField
      &&(this.data.activationField===field||this.data.activationField==='confirmPassword'&&field==='password')
      ?{error:'',activationField:''}:{})});
    if(field==='mobile'){
      this.setData({challengeId:'',smsCode:''});
      /* DEV_ONLY_START */
      this.setData({devCode:'',smsMode:''});
      /* DEV_ONLY_END */
    }
  },
  mode(e) {
    const {mode:requested}=e.currentTarget.dataset;
    const {busy,channelsLoading,smsEnabled,wechatEnabled}=this.data;
    if(busy||!['methods','password','activate','sms'].includes(requested)||(requested==='sms'&&!smsEnabled))return;
    const mode=requested==='methods'&&!channelsLoading&&!smsEnabled&&!wechatEnabled?'password':requested;
    if(mode===this.data.mode)return;
    this.setData({mode,error:'',password:'',confirmPassword:'',activationField:'',visibleActivationFields:{}});
    wx.setNavigationBarTitle?.({title:mode==='activate'?'首次激活':'九盈英才'});
  },
  toggleActivationVisibility(e){
    const field=e.currentTarget.dataset.field;
    if(this.data.busy||this.data.mode!=='activate'||!activationFields.some(item=>item.name===field))return;
    this.setData({['visibleActivationFields.'+field]:!this.data.visibleActivationFields[field]});
  },
  async run(action,{browse=false}={}) {
    if(this.data.busy||this.data.sessionCleanupPending||this.data.sessionCleanupRequired||this.data.mode==='staff')return;
    this.setData({busy:true,error:'',activationField:'',visibleActivationFields:{},sessionCleanupError:''});
    try {
      const session=await action();
      if(this._unloaded)return;
      this.setData({password:'',confirmPassword:'',activationToken:'',smsCode:''});
      /* DEV_ONLY_START */
      this.setData({devCode:'',smsMode:''});
      /* DEV_ONLY_END */
      await this.finishSignIn(session,browse);
    } catch(e) {
      if(this._unloaded)return;
      const retainPassword=e.code==='NETWORK'||e.code==='INVALID_CREDENTIALS';
      this.setData({error:signInErrors[e.code]||e.message,
        activationField:this.data.mode==='activate'&&e.code==='ACTIVATION_INVALID'?'activationToken':'',
        ...(retainPassword?{}:{password:'',confirmPassword:''})});
    } finally {
      if(!this._unloaded)this.setData({busy:false});
    }
  },
  async finishSignIn(session,browse=false) {
    if(!session?.token||api.session()?.token!==session.token){
      this.setData({error:'登录状态已变化，请重新登录。'});
      return;
    }
    if(!nativeSessionLoginUrl(session)){
      /* DEV_ONLY_START */
      roleTrial.rememberMember(session);
      /* DEV_ONLY_END */
      const next=this.next;
      this.next=undefined;
      resumeAfterLogin(!browse&&session.role==='partner'?next:null);
      return;
    }
    const staff=isStaffRole(session.role);
    if(staff){
      this.next=undefined;
      wx.setNavigationBarTitle?.({title:'九盈英才'});
    }
    clearInterval(this.smsTimer);
    this.setData({
      ...(staff?{mode:'staff'}:{}),error:staff?'':unknownRole,username:'',password:'',confirmPassword:'',
      activationToken:'',mobile:'',challengeId:'',smsCode:'',resendSeconds:0
    });
    await this.endNativeSession(session);
  },
  async endNativeSession(session) {
    const {token}=session;
    if(this._endingToken===token)return;
    this._endingToken=token;
    this.setData({sessionCleanupPending:true,sessionCleanupRequired:false,sessionCleanupError:''});
    let loggedOut=false;
    try {
      ({loggedOut}=await api.logout({navigate:false,token}));
    } catch {} finally {
      if(this._endingToken===token){
        this._endingToken=null;
        if(!this._unloaded){
          const current=api.session();
          const required=current?.token===token;
          this.setData({sessionCleanupPending:false,sessionCleanupRequired:required,
            sessionCleanupError:required?'本机登录状态暂未清除，请重试。':!loggedOut&&!current?'本机已退出，服务器暂未确认会话结束。':''});
        }
      }
    }
  },
  retrySessionCleanup() {
    const current=api.session();
    if(nativeSessionLoginUrl(current))return this.endNativeSession(current);
    this.setData({sessionCleanupRequired:false,sessionCleanupError:''});
  },
  copyStaffPortal() {
    if(this.data.mode!=='staff'||!this.data.staffPortalUrl)return;
    wx.setClipboardData({data:this.data.staffPortalUrl,fail:()=>wx.showToast?.({title:'暂时无法复制地址，请重试。',icon:'none'})});
  },
  returnToPublic() {
    const current=api.session();
    if(this.data.sessionCleanupPending||nativeSessionLoginUrl(current))return;
    reLaunch(current?.role==='partner'?'/pages/home/index?scope=public':'/pages/home/index');
  },
  async passwordLogin() {
    const {username,password}=this.data;
    if(!username.trim()||!password)return this.setData({error:'请填写账号和密码。'});
    await this.run(()=>api.passwordLogin(username.trim(),password));
  },
  async activate() {
    const {activationToken,password,confirmPassword}=this.data;
    if(!activationToken.trim())return this.setData({activationField:'activationToken',error:'请输入总部发放的激活码。'});
    if(password.length<12||password.length>128){
      return this.setData({activationField:'password',error:password.length<12?'登录密码至少12位。':'登录密码最多128位。'});
    }
    if(password!==confirmPassword)return this.setData({activationField:'confirmPassword',error:'两次输入的密码不一致。'});
    await this.run(()=>api.activate(activationToken.trim(),password));
  },
  onUnload() {
    this._unloaded=true;
    clearInterval(this.smsTimer);
  },
  async wechatLogin() {
    if(!this.data.wechatEnabled)return;
    await this.run(async()=>{
      try {
        return await api.wechatLogin();
      } catch(e) {
        if(e.code==='WECHAT_UNBOUND')throw new Error('该微信账号尚未绑定负责人身份，请使用已登记的账号登录后联系总部办理绑定。');
        if(e.code==='REAL_ADAPTER_UNAVAILABLE')throw new Error(wechatUnavailable);
        throw e;
      }
    });
  },
  async sendSms() {
    const {mobile,busy,resendSeconds}=this.data;
    if(busy||resendSeconds)return;
    if(!/^1[3-9]\d{9}$/.test(mobile))return this.setData({error:'请输入有效的11位手机号。'});
    this.setData({busy:true,error:''});
    try {
      const response=await api.sendSms(mobile);
      if(this._unloaded)return;
      this.setData({resendSeconds:response.resendAfter||60});
      if(this.data.mobile===mobile){
        this.setData({challengeId:response.challengeId});
        /* DEV_ONLY_START */
        if(config.development)this.setData({smsMode:response.mode,devCode:response.mode==='mock'?response.devCode||'':''});
        /* DEV_ONLY_END */
      }
      clearInterval(this.smsTimer);
      this.smsTimer=setInterval(()=>{
        const seconds=Math.max(0,this.data.resendSeconds-1);
        this.setData({resendSeconds:seconds});
        if(!seconds)clearInterval(this.smsTimer);
      },1000);
    } catch(e) {
      this.setData({error:e.code==='REAL_ADAPTER_UNAVAILABLE'?smsUnavailable:e.message});
    } finally {
      this.setData({busy:false});
    }
  },
  async smsLogin() {
    const {challengeId,mobile,smsCode}=this.data;
    if(!challengeId||!/^\d{6}$/.test(smsCode))return this.setData({error:'请先获取验证码并填写6位验证码。'});
    await this.run(()=>api.verifySms(challengeId,mobile,smsCode));
  },
  async privacy() {
    try {
      await api.privacyContract();
    } catch(e) {
      this.setData({error:e.message});
    }
  },
  contact() {
    if(!this.data.busy)go('support');
  },
  applyForFranchise() {
    if(!this.data.busy)go('join');
  },
  async visitor() {
    const session=api.session();
    if(nativeSessionLoginUrl(session))return this.finishSignIn(session);
    if(session?.role==='partner')return go('discover','section=brand');
    await this.run(api.ensureVisitor,{browse:true});
  }
});
