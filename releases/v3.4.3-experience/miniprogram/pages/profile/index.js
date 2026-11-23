const {define,api}=require('../../utils/page');

Page(define({
  collections:[{name:'accounts',visible(){return !this.data.isPublic;}}],
  data:{managerName:'',organizationName:'',outletCount:null},
  async loaded(state) {
    const account=state.accounts.find(item=>item.actor===state.actor);
    if(!account){
      this.setData({managerName:'',organizationName:'',outletCount:null});
      return;
    }
    const serial=this._serial;
    const [organization,outlets]=await Promise.all([
      api.detail('organizations',account.owner),
      api.collection('outlets',{limit:1})
    ]);
    if(serial!==this._serial)return;
    this.setData({
      managerName:account.managerName||'',
      organizationName:organization.name||'',
      outletCount:outlets.total
    });
  },
  async privacy() {
    try {
      await api.privacyContract();
    } catch(e) {
      this.setData({error:e.message});
    }
  },
  logout() {
    wx.showModal({
      title:'退出登录',
      content:'确认退出当前账号吗？',
      success:result=>{if(result.confirm)api.logout();}
    });
  }
}));
