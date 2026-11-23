const api=require('./api');

const contactTitles={
 assigned:'经办人员工作电话',
 default:'本网点工作电话',
 support:'本网点客服工作电话',
 headquarters:'总部客服电话'
};
const phonePattern=/^\+?\d{5,15}$/;

function workContactBehavior(scopeForPage) {
 async function read(scope) {
  if(!scope?.outlet)return null;
  const {contact}=await api.request('/api/work-contacts?'+api.query(scope));
  if(!contact||!phonePattern.test(contact.phone)||!Object.hasOwn(contactTitles,contact.source))return null;
  return {...contact,title:contactTitles[contact.source]};
 }
 function scopeKey(scope){return scope?.outlet?api.query(scope):'';}
 function getScope(page){return page.data.isPublic?null:scopeForPage.call(page);}
 return {
  async refreshWorkContact(){
   const scope=getScope(this), key=scopeKey(scope), revision=(this._workContactRevision||0)+1, serial=this._serial;
   this._workContactRevision=revision;
   this.setData({workContact:null,workContactLoading:!!key,workContactDialing:false});
   if(!key)return;
   const current=()=>revision===this._workContactRevision&&serial===this._serial&&key===scopeKey(getScope(this));
   try{
    const workContact=await read(scope);
    if(current())this.setData({workContact});
   }catch(error){
    if(current())this.setData({workContact:null});
   }finally{
    if(current())this.setData({workContactLoading:false});
   }
  },
  async dialWorkContact(){
   const shown=this.data.workContact,scope=getScope(this),key=scopeKey(scope),serial=this._serial,revision=this._workContactRevision;
   if(!shown||!key||this.data.workContactLoading||this.data.workContactDialing)return;
   const current=()=>serial===this._serial&&revision===this._workContactRevision&&key===scopeKey(getScope(this));
   this.setData({workContactDialing:true});
   try{
    const fresh=await read(scope);
    if(!current())return;
    this.setData({workContact:fresh});
    if(!fresh||fresh.phone!==shown.phone||fresh.source!==shown.source){
     wx.showToast({title:fresh?'电话已更新，请重新点击拨打':'此号码已撤回，可使用在线咨询',icon:'none'});
     return;
    }
    wx.makePhoneCall({phoneNumber:fresh.phone,fail(error){
     if(!String(error?.errMsg||'').includes('cancel'))wx.showToast({title:'暂时无法打开拨号，请稍后重试',icon:'none'});
    }});
   }catch(error){
    if(current()){
     this.setData({workContact:null});
     wx.showToast({title:'暂时无法确认电话，请刷新后重试',icon:'none'});
    }
   }finally{
    if(current())this.setData({workContactDialing:false});
   }
  }
 };
}

module.exports={workContactBehavior};
