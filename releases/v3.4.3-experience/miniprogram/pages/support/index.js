const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');

const categories=['投诉','售后问题','经营异常'];
const categoryValues=['complaint','aftersale','exception'];
const serviceHoursFallback='客服服务时间请以总部通知为准。';
const formDefaults={title:'',description:'',contact:'',supplement:'',comment:''};
const unmatchedReply='暂未匹配到已发布知识；可选择转人工，具体费用和时限以已确认协议、账单及制度为准。';
const humanRequestText='希望咨询人工客服';

function supportRecord(record) {
  if(!record)return null;
  const messages=(record.messages||[]).map((message,index)=>{
    const staff=message.actor==='support'||message.actor==='manager';
    const text=message.actor==='faq'&&message.text===unmatchedReply
      ?'暂未找到相关答复，您可以选择转人工客服。具体费用和办理时限以已确认的协议、账单和规定为准。'
      :message.text;
    return {
      key:index,actorText:staff?'总部客服':message.actor==='faq'?'自动回复':'您',
      staff,customer:message.actor===api.session()?.actor,text,at:fmt.timeText(message.at)
    };
  });
  const {id,title,description,status,createdAt,outlet,outletName,category,linkedTicketId,human,rating}=record;
  const recent=messages[messages.length-1];
  return {
    id,title,description,status,createdAt,outlet,outletName,category,linkedTicketId,human,rating,messages,
    createdText:fmt.timeText(createdAt),
    statusText:status==='bot'?'在线咨询':fmt.label(status,'support'),statusTone:fmt.statusTone(status,'support'),
    recentProgress:recent?(recent.staff?'客服已回复':'已收到补充资料'):'',
    recentActivityAt:recent?.at||'',
    canRate:status==='closed'&&!!record.assignee&&!rating
  };
}

Page(define({
  collections:['outlets','supportChats',{name:'supportTickets',filters(){return {status:this.data.statusFilter};}},'faqEntries'],
  data:{
    statusFilter:'all',tab:'chat',text:'',chat:null,chats:[],ticket:null,tickets:[],faqs:[],
    outlets:[],outletIndex:0,outletId:'',categoryIndex:0,categories,categoryValues,form:formDefaults,
    linkedTicket:null,rating:5,phoneNumber:'',serviceHours:'',returnStatus:'',openingHistory:false,
    pendingAction:'',actionArea:'',actionNotice:'',showTicketForm:false
  },
  load(q){
    this._historyRead=null;
    this.returnNoticeId=q.returnNoticeId;
    this.setData({returnStatus:['all','unread','read'].includes(q.returnStatus)?q.returnStatus:'',openingHistory:false,actionArea:'',actionNotice:'',
      outletId:q.outlet||'',outletIndex:0,workContact:null,
      ...(q.outlet&&!q.id?{tab:'chat',ticket:null,linkedTicket:null}:{})});
  },
  backToMessages(){
    const status=this.data.returnStatus;
    if(!status)return;
    go('messages',api.query({status,id:this.returnNoticeId}));
  },
  async loaded(state) {
    const support=state.support||{};
    const chats=(support.chats||[]).map(supportRecord);
    const tickets=(support.tickets||[]).map(supportRecord);
    const query=this.query,linkedId=query.id,serial=this._serial;
    const historyRead=this._historyRead,canRestoreSelection=!this.data.openingHistory;
    const chatLink=linkedId?.startsWith('chat-');
    const selectedChat=linkedId?(chatLink?linkedId:null):this.data.chat?.id;
    const selectedTicket=linkedId?(chatLink?null:linkedId):this.data.ticket?.id;
    const findRecord=async(records,name,id)=>id?(records.find(x=>x.id===id)||supportRecord(await api.detail(name,id))):null;
    if(linkedId)this.setData(chatLink?{chat:null,tab:'chat'}:{ticket:null,tab:'ticket',showTicketForm:false});
    const chat=canRestoreSelection?await findRecord(chats,'supportChats',selectedChat):null;
    const ticket=canRestoreSelection?await findRecord(tickets,'supportTickets',selectedTicket):null;
    if(serial!==this._serial||query!==this.query)return;
    const outlets=[{id:'',name:'请选择网点'},...state.outlets];
    const requestedOutlet=this.data.outletId;
    const outletIndex=Math.max(0,outlets.findIndex(item=>item.id===requestedOutlet));
    const hours=support.settings?.hours?.trim();
    this.setData({
      chats,tickets,outlets,outletIndex,faqs:state.faqEntries||[],
      ...(canRestoreSelection&&historyRead===this._historyRead?{chat:chat||chats[0]||null,ticket}:{}),
      phoneNumber:support.settings?.phone||'',
      serviceHours:!hours||hours==='待集团配置'?serviceHoursFallback:'客服服务时间：'+hours
    });
    if(linkedId)query.id='';
    await this.refreshWorkContact();
  },
  ...workContactBehavior(function(){
    const ticket=this.data.tab==='ticket'?this.data.ticket:null;
    if(ticket?.outlet)return {outlet:ticket.outlet,recordType:'supportTickets',recordId:ticket.id};
    const outlet=this.data.tab==='ticket'?this.data.linkedTicket?.outlet||this.data.outlets[this.data.outletIndex]?.id
      :this.data.outlets.find(row=>row.id===this.query.outlet)?.id;
    return outlet?{outlet}:null;
  }),
  async filterStatus(e) {
    if(this.data.pendingAction)return;
    this._historyRead=null;
    this.setData({statusFilter:e.currentTarget.dataset.status,ticket:null,openingHistory:false,actionArea:'',actionNotice:'',showTicketForm:false});
    await this.refresh();
  },
  loadChat(e) {
    return this.openHistory(e.currentTarget.dataset.id,'supportChats');
  },
  tab(e) {
    if(this.data.pendingAction)return;
    const {tab}=e.currentTarget.dataset;
    this._historyRead=null;
    this.setData({tab,openingHistory:false,actionArea:'',actionNotice:'',showTicketForm:false,
      ...(this.data.actionArea?{error:''}:{}),...(tab==='ticket'?{ticket:null}:{})});
    return this.refreshWorkContact();
  },
  text(e) {
    this.setData({text:e.detail.value});
  },
  category(e) {
    this.setData({categoryIndex:Number(e.detail.value)});
  },
  outlet(e) {
    const outletIndex=Number(e.detail.value);
    const outlet=this.data.outlets[outletIndex];
    if(!outlet||this.data.pendingAction||this.data.linkedTicket)return;
    this.setData({outletIndex,outletId:outlet.id});
    return this.refreshWorkContact();
  },
  rating(e) {
    this.setData({rating:Number(e.detail.value)+1});
  },
  async runSupportAction(area, name, perform) {
    const {busy,loading,openingHistory,pendingAction}=this.data;
    if(busy||loading||openingHistory||pendingAction)return;
    this.setData({pendingAction:name,actionArea:area,actionNotice:'',error:''});
    try {
      await perform();
    } catch {
      this.setData({error:'暂时无法确认处理结果，请刷新记录后再试。'});
    } finally {
      this.setData({pendingAction:''});
    }
  },
  send() {
    return this.runSupportAction('chat','send',async()=>{
      const {text,chat}=this.data;
      if(!text.trim())return this.setData({error:'请输入您想咨询的内容。'});
      const r=await this.mutate('support.chat',{...(chat&&chat.status!=='closed'?{id:chat.id}:{}),text,channel:'miniprogram'},'消息已发送');
      if(r)this.setData({...(this.data.text===text?{text:''}:{}),chat:supportRecord(r.result),actionNotice:'消息已发送。'});
    });
  },
  human() {
    return this.runSupportAction('chat','human',async()=>{
      let chat=this.data.chat;
      if(!chat||chat.status==='closed'){
        const created=await this.mutate('support.chat',{text:humanRequestText,channel:'miniprogram'},'咨询已建立');
        if(!created)return;
        chat=supportRecord(created.result);
        this.setData({chat});
      }
      const r=await this.mutate('support.human',{id:chat.id},'已请求人工客服');
      if(r)this.setData({chat:supportRecord(r.result),actionNotice:'已请求人工客服，请留意回复。'});
    });
  },
  prepareTicket() {
    const {busy,loading,openingHistory,pendingAction,form,text,chat}=this.data;
    if(busy||loading||openingHistory||pendingAction)return;
    const latest=chat?.messages.slice().reverse().find(message=>message.customer&&message.text!==humanRequestText);
    const description=form.description.trim()?form.description:text.trim()||latest?.text||'';
    const refresh=this.tab({currentTarget:{dataset:{tab:'ticket'}}});
    this.setData({'form.description':description,showTicketForm:true});
    wx.pageScrollTo?.({scrollTop:0,duration:0});
    return refresh;
  },
  closeTicketForm() {
    if(this.data.pendingAction)return;
    this.setData({linkedTicket:null,showTicketForm:false,actionArea:'',actionNotice:'',error:''});
    return this.refreshWorkContact();
  },
  create() {
    return this.runSupportAction('ticket','create',async()=>{
      const {form,outlets,outletIndex,categoryIndex,linkedTicket}=this.data;
      if(!form.title.trim()||!form.description.trim())return this.setData({error:'请填写问题标题和问题描述。'});
      const outlet=linkedTicket?linkedTicket.outlet:outlets[outletIndex]?.id;
      if(!outlet)return this.setData({error:'请选择涉及网点。'});
      const r=await this.mutate('support.ticket',{
        outlet,category:categoryValues[categoryIndex],title:form.title,description:form.description,
        contact:form.contact,channel:'miniprogram',...(linkedTicket?{linkedTicketId:linkedTicket.id}:{})
      },'工单已提交');
      if(r){
        const outletName=linkedTicket?.outletName||outlets[outletIndex]?.name;
        this.setData({tab:'ticket',showTicketForm:false,form:{...formDefaults},linkedTicket:null,ticket:supportRecord({...r.result,outletName}),actionNotice:'工单已提交。'});
        wx.pageScrollTo?.({scrollTop:0,duration:0});
        await this.refreshWorkContact();
      }
    });
  },
  open(e) {
    return this.openHistory(e.currentTarget.dataset.id,'supportTickets');
  },
  async openHistory(id,collection) {
    if(!id||this.data.busy||this.data.loading||this.data.pendingAction)return;
    const attempt={},serial=this._serial;
    this._historyRead=attempt;
    const current=()=>this._historyRead===attempt&&this._serial===serial;
    this.setData({openingHistory:true,error:'',actionArea:'',actionNotice:''});
    try {
      const raw=await api.detail(collection,id);
      if(!current())return;
      if(collection==='supportChats'){
        this.setData({chat:supportRecord(raw),tab:'chat'});
        await this.refreshWorkContact();
        return;
      }
      const previous=this.data.tickets.find(row=>row.id===raw.id);
      this.setData({ticket:supportRecord(raw),tab:'ticket',showTicketForm:false,rating:5,'form.comment':'','form.supplement':''});
      await this.refreshWorkContact();
      if(previous&&previous.status!==raw.status)await this.reloadCollection('supportTickets');
    } catch(error) {
      if(current())this.setData({error:error.message});
    } finally {
      if(this._historyRead===attempt)this.setData({openingHistory:false});
    }
  },
  async supplement() {
    if(this.data.openingHistory||this.data.ticket?.status!=='waiting')return;
    return this.runSupportAction('ticket','supplement',async()=>{
      const {supplement}=this.data.form;
      if(!supplement.trim())return this.setData({error:'请填写补充资料。'});
      const r=await this.mutate('support.supplement',{id:this.data.ticket.id,text:supplement},'补充资料已提交');
      if(r)this.setData({...(this.data.form.supplement===supplement?{'form.supplement':''}:{}),actionNotice:'补充资料已提交。'});
    });
  },
  async rate() {
    if(this.data.openingHistory)return;
    if(!this.data.ticket?.canRate)return;
    return this.runSupportAction('ticket','rate',async()=>{
      const r=await this.mutate('support.rate',{id:this.data.ticket.id,rating:this.data.rating,comment:this.data.form.comment},'评价已提交');
      if(r)this.setData({actionNotice:'评价已提交。'});
    });
  },
  link() {
    const ticket=this.data.ticket;
    if(this.data.openingHistory||ticket?.status!=='closed')return;
    const {id,outlet,outletName,category}=ticket;
    this.setData({linkedTicket:{id,outlet,outletName},categoryIndex:Math.max(0,categoryValues.indexOf(category)),ticket:null,showTicketForm:true,form:{...formDefaults,title:'原问题仍未解决'},actionArea:'',actionNotice:'',error:''});
    return this.refreshWorkContact();
  },
  cancelLink() {
    this.setData({linkedTicket:null});
    return this.refreshWorkContact();
  },
  async acknowledge(e) {
    if(this.data.openingHistory)return;
    const id=e.currentTarget.dataset.id;
    if(id)await this.mutate('support.ack',{id},'已查看客服回复');
  },
  phone() {
    if(this.data.phoneNumber)wx.makePhoneCall({phoneNumber:this.data.phoneNumber});
    else wx.showModal({title:'电话联系',content:'客服电话暂未公布，您可以使用在线咨询或提交服务工单。',showCancel:false});
  }
}));
