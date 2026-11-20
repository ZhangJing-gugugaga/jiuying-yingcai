const {define,go,api,fmt}=require('../../utils/page');
const {workContactBehavior}=require('../../utils/work-contacts');
const drafts=require('../../utils/business-drafts');

const categories=['投诉','售后问题','经营异常'];
const categoryValues=['complaint','aftersale','exception'];
const ratingOptions=[1,2,3,4,5];
const maxAttachments=3;
const serviceHoursFallback='客服服务时间请以总部通知为准。';
const formDefaults={title:'',description:'',contact:'',supplement:'',comment:''};
const ticketFields={title:120,description:2000,contact:2000};
const attachmentId=/^file-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const unmatchedReply='暂未匹配到已发布知识；可选择转人工，具体费用和时限以已确认协议、账单及制度为准。';
const humanRequestText='希望咨询人工客服';
const nextSteps={queued:'等待客服接单，您可以在此查看进度。',active:'客服正在处理，请留意这里的回复。',waiting:'请按客服回复补充资料。',closed:'本次处理已结束。'};

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
  const {id,title,description,status,createdAt,outlet,outletName,category,linkedTicketId,human,rating,attachmentIds=[]}=record;
  const recent=messages[messages.length-1];
  return {
    id,title,description,status,createdAt,outlet,outletName,category,linkedTicketId,human,rating,messages,attachmentIds,
    createdText:fmt.timeText(createdAt),
    statusText:status==='bot'?'在线咨询':fmt.label(status,'support'),statusTone:fmt.statusTone(status,'support'),
    recentProgress:recent?(recent.staff?'客服已回复':'已收到补充资料'):'',
    recentActivityAt:recent?.at||'',
    nextStep:nextSteps[status]||'',
    canRate:status==='closed'&&!!record.assignee&&!rating
  };
}

function previewImage(path){
  return new Promise((resolve,reject)=>wx.previewImage({
    current:path,urls:[path],success:resolve,fail:()=>reject(new Error('图片无法打开，请稍后重试。'))
  }));
}
function principal(){
  const session=api.session();
  return session?session.role+':'+session.subject:null;
}

function validDraft(draft) {
  if(!draft||!categoryValues.includes(draft.category)||typeof draft.outlet!=='string'||typeof draft.linkedId!=='string')return false;
  if(!Object.entries(ticketFields).every(([field,limit])=>typeof draft.form?.[field]==='string'&&draft.form[field].length<=limit))return false;
  const ids=draft.attachmentIds;
  return Array.isArray(ids)&&ids.length<=maxAttachments&&new Set(ids).size===ids.length&&ids.every(id=>typeof id==='string'&&attachmentId.test(id))&&
    (!draft.retryKey||typeof draft.retryKey==='string'&&/^wx-[a-z0-9-]{5,125}$/.test(draft.retryKey));
}

function outletOption(row) {
  return {...row,selectionName:[row.name,row.city,row.district].filter(Boolean).join(' · ')};
}

function linkedRecord(record) {
  const {id,outlet,outletName,title,createdText}=record;
  return {id,outlet,outletName,title,createdText};
}

Page(define({
  collections:['outlets','supportChats',{name:'supportTickets',filters(){return {status:this.data.statusFilter};}},'faqEntries'],
  data:{
    statusFilter:'all',tab:'home',text:'',chat:null,chats:[],ticket:null,tickets:[],faqs:[],
    outlets:[],outletIndex:0,outletId:'',categoryIndex:0,categories,categoryValues,form:formDefaults,
    linkedTicket:null,rating:5,ratingOptions,maxAttachments,attachments:[],attachmentProgress:null,ticketPreviews:{},
    phoneNumber:'',serviceHours:'',returnStatus:'',openingHistory:false,
    pendingAction:'',actionArea:'',actionNotice:'',showTicketForm:false,draftAvailable:false,draftPending:false,draftUnavailable:false,draftPrompt:false
  },
  load(q){
    this._historyRead=null;
    this._ticketDraftOrigin=null;
    this._draftToken=api.session()?.token;
    this._ticketRetryKey='';
    this._ticketDraftMemory=null;
    this._attachmentPrincipal=principal();
    this._attachmentView={};
    this._thumbnailRead=null;
    this.returnNoticeId=q.returnNoticeId;
    this.returnPage=q.returnPage==='tasks'?'tasks':'messages';
    const tab=q.id?(q.id.startsWith('chat-')?'chat':'ticket'):'home';
    this.setData({returnStatus:['all','unread','read'].includes(q.returnStatus)?q.returnStatus:'',openingHistory:false,actionArea:'',actionNotice:'',
      tab,statusFilter:'all',outletId:q.outlet||'',outletIndex:0,outletSearch:'',workContact:null,
      chat:null,chats:[],ticket:null,tickets:[],linkedTicket:null,showTicketForm:false,text:'',form:{...formDefaults},categoryIndex:0,rating:5,
      attachments:[],attachmentProgress:null,ticketPreviews:{},draftAvailable:false,draftPending:false,draftUnavailable:false,draftPrompt:false});
    this.updateLeaveAlert();
  },
  onUnload(){
    this._attachmentView=null;
    this._thumbnailRead=null;
  },
  backToMessages(){
    if(this.data.pendingAction)return;
    const status=this.data.returnStatus;
    if(!status)return;
    const page=this.returnPage;
    const reopen=()=>go(page,api.query({section:page==='tasks'?'notices':undefined,status,id:this.returnNoticeId}));
    const source=typeof getCurrentPages==='function'?getCurrentPages().at(-2):null;
    if(source?.route==='pages/'+page+'/index'&&wx.navigateBack){
      wx.navigateBack({delta:1,fail:reopen});
    }else reopen();
  },
  async loaded(state) {
    const support=state.support||{};
    const chats=(support.chats||[]).map(supportRecord);
    const tickets=(support.tickets||[]).map(supportRecord);
    const query=this.query,linkedId=query.id,serial=this._serial;
    const sessionPrincipal=principal();
    const token=api.session()?.token;
    const principalChanged=this._attachmentPrincipal!==sessionPrincipal;
    if(principalChanged||this._draftToken!==token){
      this._attachmentPrincipal=sessionPrincipal;
      this._draftToken=token;
      this._thumbnailRead=null;
      this._ticketDraftOrigin=null;
      this._ticketRetryKey='';
      this._ticketDraftMemory=null;
      this.setData({attachments:[],attachmentProgress:null,ticketPreviews:{},...(principalChanged?{chat:null,ticket:null}:{}),text:'',linkedTicket:null,
        showTicketForm:false,form:{...formDefaults},draftAvailable:false,draftPending:false,draftUnavailable:false,draftPrompt:false});
      this.updateLeaveAlert();
    }
    const historyRead=this._historyRead,canRestoreSelection=!this.data.openingHistory;
    const chatLink=linkedId?.startsWith('chat-');
    const selectedChat=linkedId?(chatLink?linkedId:null):this.data.chat?.id;
    const selectedTicket=linkedId?(chatLink?null:linkedId):this.data.ticket?.id;
    const findRecord=async(records,name,id)=>id?(records.find(x=>x.id===id)||supportRecord(await api.detail(name,id))):null;
    if(canRestoreSelection&&(linkedId||selectedTicket)){
      this.setData(chatLink?{chat:null,tab:'chat'}:{ticket:null,tab:'ticket',showTicketForm:false});
    }
    const chat=canRestoreSelection?await findRecord(chats,'supportChats',selectedChat):null;
    const ticket=canRestoreSelection?await findRecord(tickets,'supportTickets',selectedTicket):null;
    if(serial!==this._serial||query!==this.query||(linkedId&&linkedId!==query.id))return;
    if(linkedId&&ticket&&query.outlet&&ticket.outlet!==query.outlet)throw new Error('这条工单不属于当前网点，请从原通知重新打开。');
    const outlets=[{id:'',name:'请选择网点',selectionName:'请选择网点'},...state.outlets.map(outletOption)];
    const requestedOutlet=this.data.outletId;
    const selectedOutlet=this.data.outlets.find(row=>row.id===requestedOutlet);
    if(this._ticketRetryKey&&selectedOutlet&&!outlets.some(row=>row.id===requestedOutlet))outlets.push(selectedOutlet);
    const outletIndex=Math.max(0,outlets.findIndex(item=>item.id===requestedOutlet));
    const hours=support.settings?.hours?.trim();
    this.setData({
      chats,tickets,outlets,outletIndex,faqs:state.faqEntries||[],
      ...(canRestoreSelection&&historyRead===this._historyRead?{chat,ticket}:{}),
      phoneNumber:support.settings?.phone||'',
      serviceHours:!hours||hours==='待集团配置'?serviceHoursFallback:'客服服务时间：'+hours
    });
    if(canRestoreSelection&&historyRead===this._historyRead)this.loadTicketPreviews(ticket);
    if(linkedId)query.id='';
    this.refreshDraftOffer();
    await this.refreshWorkContact();
  },
  ...workContactBehavior(function(){
    if(!['chat','ticket'].includes(this.data.tab))return null;
    const ticket=this.data.tab==='ticket'?this.data.ticket:null;
    if(ticket?.outlet)return {outlet:ticket.outlet,recordType:'supportTickets',recordId:ticket.id};
    const outlet=this.data.tab==='ticket'?this.data.linkedTicket?.outlet||this.data.outlets[this.data.outletIndex]?.id
      :this.data.outlets.find(row=>row.id===this.query.outlet)?.id;
    return outlet?{outlet}:null;
  }),
  async filterStatus(e) {
    if(this.data.pendingAction)return;
    this._historyRead=null;
    this._thumbnailRead=null;
    this.setData({statusFilter:e.currentTarget.dataset.status,ticket:null,ticketPreviews:{},openingHistory:false,actionArea:'',actionNotice:'',showTicketForm:false});
    await this.refresh();
  },
  backToTicketList() {
    this.query.id='';
    return this.tab({currentTarget:{dataset:{tab:'ticket'}}});
  },
  loadChat(e) {
    return this.openHistory(e.currentTarget.dataset.id,'supportChats');
  },
  tab(e) {
    if(this.data.pendingAction)return;
    const {tab}=e.currentTarget.dataset;
    if(!['home','chat','chatHistory','faq','ticket'].includes(tab))return;
    this.query.id='';
    this._historyRead=null;
    this._thumbnailRead=null;
    this.setData({tab,openingHistory:false,actionArea:'',actionNotice:'',showTicketForm:false,ticket:null,ticketPreviews:{},linkedTicket:null,error:'',draftPrompt:false});
    this.refreshDraftOffer();
    return this.refreshWorkContact();
  },
  text(e) {
    this.setData({text:e.detail.value});
    this.updateLeaveAlert();
  },
  input(e) {
    const field=e.currentTarget.dataset.field;
    if(!Object.hasOwn(formDefaults,field))return;
    const ticketField=Object.hasOwn(ticketFields,field);
    if(ticketField&&(!this.data.showTicketForm||this.data.pendingAction||this.data.draftPending))return;
    const value=ticketField?String(e.detail.value).slice(0,ticketFields[field]):e.detail.value;
    if(this.data.form[field]===value)return;
    this.setData({['form.'+field]:value});
    if(ticketField)this.persistTicketDraft();
    this.updateLeaveAlert();
  },
  updateLeaveAlert() {
    const {text,form,attachments,draftAvailable}=this.data;
    const hasTicketDraft=Object.keys(ticketFields).some(field=>form[field].trim())||attachments.length>0;
    const unsent=[text,form.supplement,form.comment].some(value=>typeof value==='string'&&value.trim())||
      hasTicketDraft&&(!draftAvailable||!!this._ticketDraftMemory);
    if(unsent===Boolean(this._leaveAlert))return;
    this._leaveAlert=unsent;
    if(unsent)wx.enableAlertBeforeUnload?.({message:'还有内容尚未提交，离开此页会丢失。'});
    else wx.disableAlertBeforeUnload?.({});
  },
  category(e) {
    const categoryIndex=Number(e.detail.value);
    if(!this.data.showTicketForm||this.data.pendingAction||this.data.draftPending||!categoryValues[categoryIndex])return;
    this.setData({categoryIndex});
    this.persistTicketDraft();
  },
  outlet(e) {
    const outletIndex=Number(e.detail.value);
    const outlet=this.data.outlets[outletIndex];
    if(!outlet||!this.data.showTicketForm||this.data.pendingAction||this.data.draftPending||this.data.linkedTicket)return;
    const changed=outlet.id!==this.data.outletId;
    this.setData({outletIndex,outletId:outlet.id,...(changed&&this.data.attachments.length
      ?{attachments:[],actionArea:'ticket',actionNotice:'网点已切换，请重新添加新网点的图片。'}:{})});
    this.persistTicketDraft();
    this.updateLeaveAlert();
    return this.refreshWorkContact();
  },
  rating(e) {
    const score=Number(e.currentTarget.dataset.score);
    if(this.data.ticket?.canRate&&!this.data.pendingAction&&ratingOptions.includes(score))this.setData({rating:score});
  },
  async loadTicketPreviews(ticket) {
    const token=api.session()?.token;
    if(!ticket?.attachmentIds.length||!token)return;
    if(this._thumbnailRead?.id===ticket.id&&this._thumbnailRead.token===token)return;
    const attempt={id:ticket.id,token};
    this._thumbnailRead=attempt;
    this.setData({ticketPreviews:{}});
    const images=await Promise.allSettled(ticket.attachmentIds.map(id=>api.download('/api/files/'+encodeURIComponent(id))));
    if(this._thumbnailRead!==attempt)return;
    if(this.data.ticket?.id!==ticket.id||api.session()?.token!==token){
      this._thumbnailRead=null;
      return;
    }
    this.setData({ticketPreviews:Object.fromEntries(ticket.attachmentIds.flatMap((id,index)=>images[index].status==='fulfilled'?[[id,images[index].value]]:[]))});
    if(images.some(image=>image.status==='rejected'))this._thumbnailRead=null;
  },
  pickAttachment() {
    if(!this.data.showTicketForm||this.data.draftPending||this.data.attachments.length>=maxAttachments)return;
    return this.runSupportAction('ticket','attach',async()=>{
      const outlet=this.data.linkedTicket?.outlet||this.data.outlets[this.data.outletIndex]?.id;
      if(!outlet)return this.setData({error:'请先选择问题涉及的网点。'});
      const token=api.session()?.token;
      const view=this._attachmentView;
      const linkedId=this.data.linkedTicket?.id;
      if(!token)return this.setData({error:'请刷新页面后再添加图片。'});
      const isCurrent=()=>view===this._attachmentView&&api.session()?.token===token&&this.data.showTicketForm&&
        this.data.linkedTicket?.id===linkedId&&outlet===(this.data.linkedTicket?.outlet||this.data.outletId);
      this.setData({attachmentProgress:null});
      try {
        const {file,preview}=await api.uploadPhoto({purpose:'support-ticket',onProgress:progress=>{
          if(isCurrent())this.setData({attachmentProgress:progress});
        }});
        if(isCurrent()){
          this.setData({attachments:[...this.data.attachments,{id:file.id,preview}]});
          this.persistTicketDraft();
        }
      } catch(error) {
        if(isCurrent())this.setData({error:error.message||'图片上传失败，请重试。'});
      } finally {
        if(isCurrent())this.setData({attachmentProgress:null});
      }
    });
  },
  removeAttachment(e) {
    if(!this.data.showTicketForm||this.data.pendingAction||this.data.draftPending)return;
    this.setData({attachments:this.data.attachments.filter(image=>image.id!==e.currentTarget.dataset.id)});
    this.persistTicketDraft();
    this.updateLeaveAlert();
  },
  previewDraftAttachment(e) {
    const image=this.data.attachments.find(row=>row.id===e.currentTarget.dataset.id);
    if(!image||principal()!==this._attachmentPrincipal)return;
    return this.runSupportAction('ticket','preview',async()=>{
      try{await previewImage(image.preview);}catch(error){this.setData({error:error.message});}
    });
  },
  previewTicketAttachment(e) {
    const id=e.currentTarget.dataset.id;
    const ticket=this.data.ticket;
    if(!ticket?.attachmentIds.includes(id))return;
    return this.runSupportAction('ticket','preview',async()=>{
      const token=api.session()?.token;
      try {
        const path=await api.download('/api/files/'+encodeURIComponent(id));
        if(api.session()?.token===token&&this.data.ticket?.id===ticket.id)await previewImage(path);
      } catch {
        if(api.session()?.token===token&&this.data.ticket?.id===ticket.id)this.setData({error:'暂时无法查看图片，请刷新工单后再试。'});
      }
    });
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
      this.updateLeaveAlert();
    }
  },
  send() {
    return this.runSupportAction('chat','send',async()=>{
      const {text,chat}=this.data;
      if(!text.trim())return this.setData({error:'请输入您想咨询的内容。'});
      const r=await this.mutate('support.chat',{...(chat&&chat.status!=='closed'?{id:chat.id}:{}),text,channel:'miniprogram'},'消息已发送');
      if(r){
        this.setData({tab:'chat',...(this.data.text===text?{text:''}:{}),chat:supportRecord(r.result),actionNotice:'消息已发送。'});
      }
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
  readTicketDraft() {
    const session=api.session();
    if(!this._draftToken||this._draftToken!==session?.token)return null;
    const draft=this._ticketDraftMemory||drafts.read('support',session);
    return validDraft(draft)?draft:null;
  },
  refreshDraftOffer() {
    const draft=this.readTicketDraft();
    this.setData({draftAvailable:!!draft,draftPending:!!(this._ticketRetryKey||draft?.retryKey),...(draft?{}:{draftUnavailable:false})});
  },
  ticketDraftSnapshot() {
    const {form,outletId,linkedTicket,categoryIndex,attachments}=this.data;
    return {
      outlet:linkedTicket?.outlet||outletId,
      linkedId:linkedTicket?.id||'',
      category:categoryValues[categoryIndex],
      form:{title:form.title,description:form.description,contact:form.contact},
      attachmentIds:attachments.map(image=>image.id),
      retryKey:this._ticketRetryKey
    };
  },
  persistTicketDraft() {
    const session=api.session();
    if(!this.data.showTicketForm||!session?.token||session.token!==this._draftToken)return false;
    const draft=this.ticketDraftSnapshot();
    const meaningful=draft.linkedId||draft.outlet||draft.category!==categoryValues[0]||draft.attachmentIds.length||
      Object.values(draft.form).some(value=>value.trim());
    if(!meaningful){
      drafts.clear('support');
      this._ticketDraftMemory=null;
      this.refreshDraftOffer();
      return true;
    }
    const saved=drafts.save('support',session,draft);
    this._ticketDraftMemory=saved?null:draft;
    this.setData({draftAvailable:true,draftPending:!!draft.retryKey});
    return saved;
  },
  async restoreTicketDraft() {
    return this.runSupportAction('draft','restoreDraft',async()=>{
      const draft=this.readTicketDraft();
      if(!draft){
        this.refreshDraftOffer();
        return this.setData({error:'草稿已失效，请重新填写。',actionArea:''});
      }
      const view=this._attachmentView,serial=this._serial,token=this._draftToken;
      const current=()=>view===this._attachmentView&&serial===this._serial&&token===api.session()?.token;
      this.setData({draftUnavailable:false});
      let outlet,linked;
      try {
        [outlet,linked]=await Promise.all([
          draft.outlet?api.detail('outlets',draft.outlet):null,
          draft.linkedId?api.detail('supportTickets',draft.linkedId):null
        ]);
      }catch(error){
        const unavailable=error.status===403||error.status===404;
        if(current())this.setData({draftUnavailable:unavailable,error:unavailable?'草稿涉及的网点或关联工单已无法查看。':error.message});
        return;
      }
      if(!current())return;
      if((draft.outlet&&outlet?.id!==draft.outlet)||(draft.linkedId&&(linked?.id!==draft.linkedId||linked.outlet!==draft.outlet||linked.status!=='closed'))){
        return this.setData({draftUnavailable:true,error:'草稿涉及的网点或关联工单已变化，请查看最新记录。'});
      }
      let attachments;
      try{
        attachments=await Promise.all(draft.attachmentIds.map(async id=>({id,preview:await api.download('/api/files/'+encodeURIComponent(id))})));
      }catch(error){
        const unavailable=error.status===403||error.status===404;
        if(current())this.setData({draftUnavailable:unavailable,error:unavailable?'草稿中的图片已无法查看。':'暂时无法恢复已上传的图片，请检查网络后重试。'});
        return;
      }
      if(!current())return;
      const outlets=this.data.outlets.slice();
      if(outlet&&!outlets.some(row=>row.id===outlet.id))outlets.push(outletOption(outlet));
      const outletIndex=Math.max(0,outlets.findIndex(row=>row.id===draft.outlet));
      this.query.id='';
      this._historyRead=null;
      this._thumbnailRead=null;
      this._ticketDraftOrigin='restored';
      this._ticketRetryKey=draft.retryKey||'';
      const {title,description,contact}=draft.form;
      this.setData({tab:'ticket',ticket:null,showTicketForm:true,linkedTicket:linked?linkedRecord(supportRecord(linked)):null,
        form:{...formDefaults,title,description,contact},outlets,outletIndex,outletId:draft.outlet,
        categoryIndex:categoryValues.indexOf(draft.category),attachments,ticketPreviews:{},draftPrompt:false,draftPending:!!draft.retryKey,
        actionArea:'ticket',actionNotice:'已恢复工单草稿。'});
      wx.pageScrollTo?.({scrollTop:0,duration:0});
      await this.refreshWorkContact();
    });
  },
  discardTicketDraft() {
    if(this.data.busy||this.data.loading||this.data.openingHistory||this.data.pendingAction)return;
    const pending=!!(this.readTicketDraft()?.retryKey||this._ticketRetryKey);
    if(pending&&!this.data.draftUnavailable)return;
    const session=api.session();
    if(!this._draftToken||this._draftToken!==session?.token)return;
    drafts.clear('support');
    if(drafts.read('support',session))return this.setData({actionArea:'draft',error:'本机暂时无法清除草稿，请稍后重试。'});
    this._ticketDraftMemory=null;
    this._ticketDraftOrigin=null;
    this._ticketRetryKey='';
    this.setData({'form.title':'','form.description':'','form.contact':'',attachments:[],linkedTicket:null,
      actionArea:'draft',actionNotice:pending?'已清除本机待确认记录。请以工单列表为准。':'已放弃工单草稿。',error:'',draftPrompt:false});
    this.refreshDraftOffer();
    this.updateLeaveAlert();
  },
  prepareTicket() {
    const {busy,loading,openingHistory,pendingAction,form,text,chat,tab}=this.data;
    if(busy||loading||openingHistory||pendingAction)return;
    const isChat=tab==='chat';
    const origin=isChat?chat?.id||'new-chat':'general';
    const sameDraft=this._ticketDraftOrigin===origin;
    if(this.readTicketDraft()&&(!sameDraft||this._ticketRetryKey)){
      this.setData({draftPrompt:true});
      this.refreshDraftOffer();
      wx.pageScrollTo?.({scrollTop:0,duration:0});
      return;
    }
    const draft=sameDraft?form:formDefaults;
    const latest=isChat?chat?.messages.slice().reverse().find(message=>message.customer&&message.text!==humanRequestText):null;
    const description=draft.description.trim()?draft.description:isChat?text.trim()||latest?.text||'':'';
    if(!sameDraft){
      this._ticketRetryKey='';
      const outletIndex=Math.max(0,this.data.outlets.findIndex(row=>row.id===this.query.outlet));
      this.setData({outletIndex,outletId:this.data.outlets[outletIndex]?.id||'',categoryIndex:0,attachments:[]});
    }
    this._ticketDraftOrigin=origin;
    const refresh=this.tab({currentTarget:{dataset:{tab:'ticket'}}});
    this.setData({form:{...draft,description},showTicketForm:true});
    if(description&&!sameDraft)this.persistTicketDraft();
    this.updateLeaveAlert();
    wx.pageScrollTo?.({scrollTop:0,duration:0});
    return refresh;
  },
  closeTicketForm() {
    if(this.data.pendingAction)return;
    this.setData({...(this.data.linkedTicket?{attachments:[]}:{}),linkedTicket:null,showTicketForm:false,actionArea:'',actionNotice:'',error:''});
    this.refreshDraftOffer();
    return this.refreshWorkContact();
  },
  create() {
    if(!this.data.showTicketForm||!this._draftToken||this._draftToken!==api.session()?.token)return;
    return this.runSupportAction('ticket','create',async()=>{
      const {form,outlets,outletIndex,linkedTicket}=this.data;
      if(!form.title.trim()||!form.description.trim())return this.setData({error:'请填写问题标题和问题描述。'});
      const outlet=linkedTicket?linkedTicket.outlet:outlets[outletIndex]?.id;
      if(!outlet)return this.setData({error:'请选择涉及网点。'});
      const token=this._draftToken,session=api.session();
      const firstAttempt=!this._ticketRetryKey;
      if(firstAttempt){
        this._ticketRetryKey=api.newCommandKey();
        if(!this.persistTicketDraft()&&drafts.read('support',session)){
          drafts.clear('support');
          if(drafts.read('support',session)){
            this._ticketRetryKey='';
            this.persistTicketDraft();
            return this.setData({error:'本机暂无法更新草稿，请释放存储空间后重试。'});
          }
        }
      }
      const {category,linkedId,attachmentIds,retryKey}=this.ticketDraftSnapshot();
      const r=await this.mutate('support.ticket',{
        outlet,category,title:form.title,description:form.description,contact:form.contact,channel:'miniprogram',
        ...(linkedId?{linkedTicketId:linkedId}:{}),...(attachmentIds.length?{attachmentIds}:{})
      },'工单已提交',{retryKey,onError:error=>{
        if(firstAttempt&&([400,403,404].includes(error.status)||error.code==='ATTACHMENT_IN_USE')){
          this._ticketRetryKey='';
          this.persistTicketDraft();
        }else if(!firstAttempt&&(error.status===403||error.status===404)){
          this.setData({showTicketForm:false,draftPrompt:true,draftUnavailable:true,actionArea:'draft',form:{...formDefaults},attachments:[],linkedTicket:null});
        }
      }});
      if(r&&token===api.session()?.token){
        if(drafts.read('support',session)?.retryKey===retryKey)drafts.clear('support');
        this._ticketRetryKey='';
        this._ticketDraftMemory=null;
        this._ticketDraftOrigin=null;
        const outletName=linkedTicket?.outletName||outlets[outletIndex]?.name;
        const ticket=supportRecord({...r.result,outletName});
        this.setData({tab:'ticket',showTicketForm:false,form:{...formDefaults},linkedTicket:null,ticket,attachments:[],error:'',actionNotice:'工单已提交。'});
        this.refreshDraftOffer();
        this.loadTicketPreviews(ticket);
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
      const ticket=supportRecord(raw);
      this.setData({ticket,tab:'ticket',showTicketForm:false,rating:5,'form.comment':'','form.supplement':''});
      this.loadTicketPreviews(ticket);
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
    if(this.data.openingHistory||this.data.pendingAction||ticket?.status!=='closed')return;
    if(this.readTicketDraft()){
      this.setData({draftPrompt:true});
      this.refreshDraftOffer();
      wx.pageScrollTo?.({scrollTop:0,duration:0});
      return;
    }
    this._ticketRetryKey='';
    this._ticketDraftOrigin=ticket.id;
    this.setData({linkedTicket:linkedRecord(ticket),categoryIndex:Math.max(0,categoryValues.indexOf(ticket.category)),ticket:null,showTicketForm:true,form:{...formDefaults,title:'原问题仍未解决'},attachments:[],actionArea:'',actionNotice:'',error:''});
    this.persistTicketDraft();
    this.updateLeaveAlert();
    return this.refreshWorkContact();
  },
  cancelLink() {
    if(this.data.pendingAction||this.data.draftPending)return;
    this.setData({linkedTicket:null,attachments:[]});
    this.persistTicketDraft();
    this.updateLeaveAlert();
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
