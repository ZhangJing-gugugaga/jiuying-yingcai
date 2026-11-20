const {define,fmt,api,go}=require('../../utils/page');
const {withPublicCover,markCoverUnavailable}=require('../../utils/public-content');
const {publicShare,groupShare}=require('../../utils/public-share');
const sections=[
 {id:'brand',name:'集团介绍'},{id:'services',name:'五大业务'},{id:'outlets',name:'服务网点'},
 {id:'faq',name:'常见问题'},{id:'contact',name:'联系总部'},{id:'cooperation',name:'合作咨询'},
 {id:'news',name:'集团动态'},{id:'cases',name:'服务案例'},
];
const articleSections=['brand','news','cases'];
const primarySections=sections.filter(({id})=>['brand','services','faq','cooperation'].includes(id));
const secondarySections=sections.filter(({id})=>['news','cases'].includes(id));
const cooperationLabels={submitted:'已提交',received:'已接收',contacted:'已联系',closed:'已结束'};
const discover=define({collections:['publicContents',{
 name:'faqEntries',visible(){return this.data.section==='faq';}
},{name:'cooperationRequests',visible(){return this.data.section==='cooperation';},filters(){return {status:this.data.cooperationStatus};}}],data:{sections,primarySections,secondarySections,selectedCooperation:null,section:'brand',articles:[],showArticles:true,serviceRows:[],noPublishedServices:false,faqs:[],cooperationRows:[],cooperationStatus:'all',cooperationNotice:'',privacyConsented:false,form:{company:'',name:'',contact:'',message:''}},load(q){if(sections.some(x=>x.id===q.section))this.setData({section:q.section});},async loaded(s){
 const serial=this._serial;
 const id=this.data.section==='cooperation'?this.query.id:'';
 if(id&&!s.cooperationRequests?.some(x=>x.id===id)){
  const selected=await api.detail('cooperationRequests',id);
  if(serial!==this._serial||this.query.id!==id||this.data.section!=='cooperation')return;
  s={...s,cooperationRequests:[selected,...(s.cooperationRequests||[])]};
  this.setData({state:s});
 }
 await this.renderContent(s);
},
async renderContent(state){
 const s=state||{},serial=this._serial,section=this.data.section,contents=s.publicContents||[],render=(this._contentRender||0)+1;
 this._contentRender=render;
 const serviceRows=section==='services'?Array.from({length:5},(_,i)=>{
  const slot=i+1,record=contents.find(x=>x.key==='service-'+slot);
  return record?{...record,slot,available:true}:{slot,available:false};
 }):[];
 const articles=contents.filter(x=>x.key===section);
 const cooperationRows=(s.cooperationRequests||[]).map(x=>({...x,dateText:fmt.timeText(x.createdAt),
  statusText:cooperationLabels[x.status]||fmt.label(x.status)}));
 const selectedCooperation=section==='cooperation'?(cooperationRows.find(x=>x.id===this.query.id)||null):null;
 this.setData({articles,showArticles:articleSections.includes(section),serviceRows,
  noPublishedServices:!serviceRows.some(row=>row.available),faqs:(s.faqEntries||[]).filter(item=>item.status==='published'),
  cooperationRows,selectedCooperation});
 if(![...articles,...serviceRows].some(row=>row.imageId))return;
 const [withArticleCovers,withServiceCovers]=await Promise.all([
  Promise.all(articles.map(withPublicCover)),Promise.all(serviceRows.map(withPublicCover))
 ]);
 if(this._serial===serial&&this._contentRender===render)this.setData({articles:withArticleCovers,serviceRows:withServiceCovers});
},
...publicShare(function(){return groupShare(this.data.section);},function(){return this.data.section!=='cooperation';}),
async selectSection(e){
 const section=e.currentTarget.dataset.section;
 if(!sections.some(x=>x.id===section)||section===this.data.section)return;
 this.setData({section,error:''},()=>wx.pageScrollTo?.({scrollTop:0,duration:200}));
 this.updatePublicShareMenu();
 if(section==='faq'||section==='cooperation'||this.data.loading||!this.data.state)return this.refresh();
 return this.renderContent(this.data.state);
},
coverFailed(e){
 const id=e.currentTarget.dataset.id;
 this.setData({articles:markCoverUnavailable(this.data.articles,id),serviceRows:markCoverUnavailable(this.data.serviceRows,id)});
},
openService(e){const id=e.currentTarget.dataset.id;if(this.data.serviceRows.some(row=>row.available&&row.id===id))go('service-detail',api.query({id}));},
consent(e){this.setData({privacyConsented:e.detail.value===true});},
showCooperation(){wx.pageScrollTo?.({selector:'#cooperation-current',duration:200});},
async filterCooperation(e){this.query.id='';this.setData({cooperationStatus:e.currentTarget.dataset.status});await this.reloadCollection('cooperationRequests');},
async submitCooperation(){
 if(this.data.busy)return;
 this.setData({cooperationNotice:''});
 const f=this.data.form;
 if(!this.data.privacyConsented)return this.setData({error:'请先阅读并同意合作联系说明。'});
 const company=f.company.trim(),name=f.name.trim(),contact=f.contact.trim(),message=f.message.trim();
 if(!company||company.length>200||!name||name.length>200||!message||message.length>2000){
  return this.setData({error:'请填写企业或机构名称、联系人和合作需求。名称和联系人各最多200字，合作需求最多2000字。'});
 }
 if(!/^\+?[0-9][0-9\s()-]{5,29}$/.test(contact)||contact.replace(/\D/g,'').length<6){
  return this.setData({error:'请填写可接听的联系电话，可以包含区号。'});
 }
 const result=await this.mutate('cooperation.submit',{company,name,contact,message,privacyConsented:true},response=>{
  this.query.id=response.result?.id||'';
  this.setData({cooperationStatus:'all'});
  return '已提交';
 });
 if(result)this.setData({form:{company:'',name:'',contact:'',message:''},privacyConsented:false,
  cooperationNotice:'您的合作意向已提交，请留意后续联系。'});
 if(result&&this.data.selectedCooperation)wx.nextTick?.(()=>this.showCooperation());
}
});
const refresh=discover.refresh;
discover.refresh=function(){
  this.updatePublicShareMenu();
  this.setData({state:null,pagers:{},articles:[],showArticles:articleSections.includes(this.data.section),
    serviceRows:[],noPublishedServices:false,faqs:[],cooperationRows:[],selectedCooperation:null});
  return refresh.call(this);
};
Page(discover);
