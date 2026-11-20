const {reLaunch}=require('../../utils/navigation');
const {define,api}=require('../../utils/page');

Page(define({
  collections:[{name:'accounts',visible(){return !this.data.isPublic;}}],
  data:{
    bindings:null,wechatEnabled:false,smsEnabled:false,managerName:'',
    form:{currentPassword:'',password:'',confirmPassword:''}
  },
  async loaded(state) {
    const account=state.accounts.find(item=>item.actor===state.actor);
    if(!account){
      this.setData({bindings:null,wechatEnabled:false,smsEnabled:false,managerName:''});
      return;
    }
    const serial=this._serial;
    const [bindings,settings]=await Promise.all([
      api.request('/api/auth/bindings'),api.request('/api/config')
    ]);
    if(serial!==this._serial)return;
    this.setData({
      bindings,
      managerName:account.managerName,
      wechatEnabled:settings.authCapabilities?.wechat===true||settings.wechatLoginEnabled===true,
      smsEnabled:settings.authCapabilities?.sms===true||settings.smsLoginEnabled===true
    });
  },
  async bindWechat() {
    if(this.data.busy||!this.data.wechatEnabled||this.data.bindings?.wechatBound)return;
    this.setData({busy:true,error:'',actionArea:'wechat'});
    try {
      await api.bindWechat();
      wx.showToast({title:'微信已绑定',icon:'success'});
      await this.refresh();
    } catch(e) {
      this.setData({error:e.code==='REAL_ADAPTER_UNAVAILABLE'?'微信登录暂未开放，请使用其他已开通方式登录。':e.message});
    } finally {
      this.setData({busy:false});
    }
  },
  async changePassword() {
    if(this.data.busy)return;
    this.setData({actionArea:'password'});
    const {currentPassword,password,confirmPassword}=this.data.form;
    if(!currentPassword)return this.setData({error:'请输入当前密码。'});
    if(password.length<12)return this.setData({error:'新密码至少12位。'});
    if(password!==confirmPassword)return this.setData({error:'两次输入的新密码不一致。'});
    const cleared={currentPassword:'',password:'',confirmPassword:''};
    this.setData({busy:true,error:''});
    try {
      await api.request('/api/auth/change-password','POST',{currentPassword,password});
      wx.removeStorageSync('jyyc.session');
      this.setData({form:cleared});
      wx.showToast({title:'登录密码已更新，请使用新密码登录。',icon:'none'});
      reLaunch('/pages/login/index');
    } catch(e) {
      this.setData({error:e.message,form:cleared});
    } finally {
      this.setData({busy:false});
    }
  }
}));
