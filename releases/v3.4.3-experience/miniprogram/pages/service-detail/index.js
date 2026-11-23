const {define,api}=require('../../utils/page');
const {withPublicCover}=require('../../utils/public-content');

const page=define({
 data:{service:null,coverPath:'',coverUnavailable:false},
 async loaded(){
  const serial=this._serial;
  if(!this.query.id)throw new Error('该业务资料不存在或尚未发布。');
  let service;
  try{
   service=await api.detail('publicContents',this.query.id);
  }catch(error){
   if(error.code==='NOT_FOUND')throw new Error('该业务资料不存在或尚未发布。');
   throw error;
  }
  if(serial!==this._serial)return;
  if(!/^service-[1-5]$/.test(service.key||''))throw new Error('该业务资料不存在或尚未发布。');
  this.setData({service});
  if(!service.imageId)return;
  const result=await withPublicCover(service);
  if(serial===this._serial)this.setData({coverPath:result.coverPath||'',coverUnavailable:result.coverUnavailable===true});
 },
 coverFailed(){
  this.setData({coverPath:'',coverUnavailable:true});
 }
});
const refresh=page.refresh;
page.refresh=function(){
 this.setData({service:null,coverPath:'',coverUnavailable:false});
 return refresh.call(this);
};
Page(page);
