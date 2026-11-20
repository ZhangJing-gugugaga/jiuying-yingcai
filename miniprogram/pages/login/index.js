const api=require('../../utils/api');
const {go,resumeAfterLogin}=require('../../utils/navigation');
/* DEV_ONLY_START */
const config=require('../../config');
const development=require('../../development/login');
/* DEV_ONLY_END */

const wechatUnavailable='微信登录暂未开放，请使用已开通的登录方式。';
const smsUnavailable='手机验证码登录暂未开放，请使用账号登录。';
const signInErrors={
  INVALID_CREDENTIALS:'账号或密码不正确',
  ACTIVATION_INVALID:'激活码已失效，请联系总部重新领取。',
  ACCOUNT:'账号暂不可用，请联系总部客服。'
};

Page({
  data:{
    busy:false,error:'',mode:'password',username:'',password:'',confirmPassword:'',
    activationToken:'',mobile:'',smsCode:'',challengeId:'',resendSeconds:0,
    wechatEnabled:false,smsEnabled:false,activationVisible:false,methodsExpanded:false,
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
    if(query?.token)this.setData({activationToken:query.token,mode:'activate'});
    if(query?.reason==='session-expired')this.setData({error:'登录已失效，请重新登录后继续。'});
  },
  async onShow() {
    try {
      const settings=await api.request('/api/config');
      let allowSms=settings.authCapabilities?.mode!=='mock';
      /* DEV_ONLY_START */
      allowSms=allowSms||config.development;
      this.setData({development:config.development&&settings.devLoginEnabled===true});
      /* DEV_ONLY_END */
      this.updateChannels({
        wechatEnabled:settings.authCapabilities?.wechat===true||settings.wechatLoginEnabled===true,
        smsEnabled:allowSms&&(settings.authCapabilities?.sms===true||settings.smsLoginEnabled===true)
      });
    } catch {
      /* DEV_ONLY_START */
      this.setData({development:false});
      /* DEV_ONLY_END */
      this.updateChannels({wechatEnabled:false,smsEnabled:false});
    }
  },
  updateChannels(channels) {
    const {mode}=this.data;
    if(mode==='sms'&&!channels.smsEnabled){
      this.setData({...channels,mode:'password',error:'',methodsExpanded:false});
    }else this.setData({...channels,methodsExpanded:this.data.methodsExpanded&&(channels.smsEnabled||channels.wechatEnabled)});
  },
  input(e) {
    const field=e.currentTarget.dataset.field;
    this.setData({[field]:e.detail.value});
    if(field==='mobile'){
      this.setData({challengeId:'',smsCode:''});
      /* DEV_ONLY_START */
      this.setData({devCode:'',smsMode:''});
      /* DEV_ONLY_END */
    }
  },
  mode(e) {
    const {mode}=e.currentTarget.dataset;
    if(this.data.busy||mode===this.data.mode||!['password','activate','sms'].includes(mode))return;
    if(mode==='sms'&&!this.data.smsEnabled)return;
    this.setData({mode,error:'',password:'',confirmPassword:'',activationVisible:false,methodsExpanded:false});
  },
  toggleMethods(){
    if(this.data.busy||this.data.mode!=='password'||!(this.data.smsEnabled||this.data.wechatEnabled))return;
    this.setData({methodsExpanded:!this.data.methodsExpanded});
  },
  toggleActivationVisibility(){this.setData({activationVisible:!this.data.activationVisible});},
  async run(action,{browse=false}={}) {
    if(this.data.busy)return;
    this.setData({busy:true,error:''});
    try {
      await action();
      this.setData({password:'',confirmPassword:'',activationToken:'',smsCode:''});
      /* DEV_ONLY_START */
      this.setData({devCode:'',smsMode:''});
      /* DEV_ONLY_END */
      const next=api.session()?.role==='public'?null:this.next;
      this.next=undefined;
      resumeAfterLogin(browse?null:next);
    } catch(e) {
      const retainPassword=e.code==='NETWORK'||e.code==='INVALID_CREDENTIALS';
      this.setData({error:signInErrors[e.code]||e.message,...(retainPassword?{}:{password:'',confirmPassword:''})});
    } finally {
      this.setData({busy:false});
    }
  },
  async passwordLogin() {
    const {username,password}=this.data;
    if(!username.trim()||!password)return this.setData({error:'请填写账号和密码。'});
    await this.run(()=>api.passwordLogin(username.trim(),password));
  },
  async activate() {
    const {activationToken,password,confirmPassword}=this.data;
    if(!activationToken.trim())return this.setData({error:'请输入总部发放的激活码。'});
    if(password.length<12)return this.setData({error:'登录密码至少12位。'});
    if(password!==confirmPassword)return this.setData({error:'两次输入的密码不一致。'});
    await this.run(()=>api.activate(activationToken.trim(),password));
  },
  onUnload() {
    this._unloaded=true;
    clearInterval(this.smsTimer);
  },
  async wechatLogin() {
    await this.run(async()=>{
      try {
        await api.wechatLogin();
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
  async visitor() {
    const session=api.session();
    if(session&&session.role!=='public')return go('discover','section=brand');
    await this.run(api.ensureVisitor,{browse:true});
  }
});
