export function workContacts(c) {
 let revision=0;
 const {esc,field,select,pair,notice,modal,api,toast}=c;
 const contactEndpoint='/work-contacts/manage';
 const openButton=row=>row.role==='manager'?'': '<button type="button" data-work-contact-actor="'+esc(row.id)+'">工作电话</button>';
 const rowList=items=>items.length?items.map(row=>'<div class="record">'
  +pair('网点',row.outletName)+pair('工作电话',row.phone||'已撤回')
  +pair('状态',row.effective?(row.isDefault?'默认联系人 · 已公开':'已公开'):row.published?'当前授权不可用':'已撤回')
  +'<button type="button" data-edit-contact="'+esc(row.outlet)+'">选择此网点</button></div>').join('')
  :notice('此员工尚未配置工作电话。',true);

 async function open(actor, offset=0, outlet='') {
  const current=++revision;
  try {
   const result=await api(contactEndpoint+'?'+new URLSearchParams({actor,limit:12,offset}));
   if(current!==revision||c.session()?.actor!=='manager')return;
   const person=c.state().staffAccounts?.find(row=>row.id===actor);
   const currentRow=result.items.find(row=>row.outlet===outlet);
   const outletOptions=(c.state().outlets||[]).map(row=>'<option value="'+esc(row.id)+'">'+esc(row.name)+'</option>').join('');
   modal('员工公开工作电话',pair('个人账号',person?.name||actor)
    +notice('仅授权网点的加盟商可查看此号码。请在获得号码公开授权后发布。设置为默认联系人会替换这个网点原有的默认联系人。',true)
    +'<div data-work-contact-editor>'
    +'<form><label class="field">网点编号<input name="outlet" value="'+esc(outlet)+'" list="work-contact-outlets" maxlength="120" required>'
    +'<datalist id="work-contact-outlets">'+outletOptions+'</datalist></label>'
    +select('action','操作',[['publish','确认并发布'],['withdraw','撤回公开']],currentRow&&!currentRow.published?'withdraw':'publish')
    +'<div data-work-contact-publication>'+field('phone','工作电话号码',currentRow?.phone||'','tel','maxlength="40"')
    +'<label class="check"><input name="isDefault" type="checkbox" '+(currentRow?.isDefault?'checked':'')+'> 设为此网点默认联系人</label>'
    +'<label class="check"><input name="confirmed" type="checkbox"> 已核对工作号码，且获准向该网点公开</label></div>'
    +'<p class="muted" data-work-contact-status role="status" aria-live="polite"></p>'
    +'<button class="button primary" type="submit">保存工作电话设置</button></form>'
    +rowList(result.items)
    +'<div class="actions">'
    +(offset?'<button type="button" data-contact-offset="'+Math.max(0,offset-result.limit)+'">上一页</button>':'')
    +(result.hasMore?'<button type="button" data-contact-offset="'+(offset+result.limit)+'">下一页</button>':'')+'</div></div>');

   const editor=document.querySelector('[data-work-contact-editor]'),form=editor.querySelector('form');
   const sync=()=>{
    const publish=form.elements.action.value==='publish';
    form.querySelector('[data-work-contact-publication]').hidden=!publish;
    form.elements.phone.required=publish;
    form.elements.confirmed.required=publish;
   };
   sync();
   form.elements.action.addEventListener('change',sync);
   form.elements.outlet.addEventListener('change',()=>{
    const row=result.items.find(item=>item.outlet===form.elements.outlet.value.trim());
    form.elements.phone.value=row?.phone||'';
    form.elements.isDefault.checked=Boolean(row?.isDefault);
    form.elements.confirmed.checked=false;
   });
   editor.addEventListener('click',event=>{
    const selection=event.target.closest('[data-edit-contact]'),page=event.target.closest('[data-contact-offset]');
    if(selection)void open(actor,offset,selection.dataset.editContact);
    if(page)void open(actor,Number(page.dataset.contactOffset));
   });
   form.addEventListener('submit',async event=>{
    event.preventDefault();
    const submit=form.querySelector('button[type=submit]');
    if(submit.disabled)return;
    const status=form.querySelector('[data-work-contact-status]');
    const published=form.elements.action.value==='publish';
    const selected=form.elements.outlet.value.trim();
    const body={actor,outlet:selected,published,...(published?{phone:form.elements.phone.value.trim(),
     confirmed:form.elements.confirmed.checked,isDefault:form.elements.isDefault.checked}:{})};
    submit.disabled=true;
    status.textContent='正在保存…';
    try {
     const saved=await api(contactEndpoint,{method:'POST',body});
     if(current!==revision||!form.isConnected||!form.closest('dialog')?.open)return;
     toast(saved.published?'工作电话已发布':'已撤回此网点的电话号码');
     await open(actor,offset,selected);
    } catch(error) {
     status.textContent=error.message;
    } finally {
     submit.disabled=false;
    }
   });
  }catch(error){
   if(current===revision)toast(error.message);
  }
 }

 document.addEventListener('click',event=>{
  const action=event.target.closest('[data-work-contact-actor]');
  if(action&&c.session()?.actor==='manager')void open(action.dataset.workContactActor);
 });
 return {openButton};
}
