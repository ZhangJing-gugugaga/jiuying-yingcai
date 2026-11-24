// All financial effects are server commands. This module only renders validated inputs.
import {workContacts} from './work-contacts.js';

export function operations(c){
 const contacts=workContacts(c);
 const {esc,field,select,area,form,submit,button,pair,notice,empty,panel,chip,heading,fmt}=c;
 const configs={
  contracts:{title:'协议与定价',sub:'价格版本、整月协议与自然月账单，保留每一次确认。',icon:'report',tabs:[['agreements','服务协议'],['pricePlans','价格版本']],roles:['manager','ops','finance'],actions:[['plan.publish','发布价格方案',['manager']],['agreement.create','签订服务协议',['manager']],['billing.generate','生成月度账单',['manager','finance']]]},
  financeops:{title:'财务处理',sub:'从核验到复核，每一笔业务都可回溯。',icon:'wallet',tabs:[['offlinePayments','线下款'],['refundRequests','退款'],['invoiceRequests','发票'],['billCorrections','账单纠错'],['feeProposals','费用调整'],['receipts','实收流水']],roles:['manager','ops','finance'],actions:[['offline.submit','登记线下款',['manager','finance']],['refund.request','发起退款申请',['manager','finance']],['invoice.request','申请开票',['manager','finance']],['billing.correct.propose','提出账单纠错',['manager','ops']],['fee.adjust.propose','提出费用调整',['manager','ops']]]},
  team:{title:'人员与交接',sub:'个人账号承接岗位权限，业务交接保留原始责任记录。',icon:'users',tabs:[['staffAccounts','总部人员'],['handovers','交接记录'],['taskRoutingRules','自动分派']],roles:['manager'],actions:[['staff.create','新增总部人员',['manager']],['staff.handover','办理业务交接',['manager']],['routing.set','配置自动分派',['manager']]]},
  operations:{title:'周期与规则',sub:'处理日常待办与合作联络，按已确认制度推进每一步。',icon:'check',tabs:[['businessTasks','业务待办'],['cooperationRequests','合作留言'],['policies','规则版本'],['jobRuns','运行记录']],roles:['manager','ops','finance','support','location','regional'],actions:[['jobs.run','运行周期检查',['manager','ops','finance']],['policy.configure','发布规则版本',['manager']]]},
  knowledge:{title:'知识与公开资料',sub:'维护真实、清晰的服务说明；发布内容与内部档案分开。',icon:'chat',tabs:[['faqEntries','常见问题'],['publicProfiles','公开网点']],roles:['manager','ops','support'],actions:[['faq.save','新增常见问题',['manager','support']],['public.profile','维护公开网点',['manager','ops']]]},
  imports:{title:'批量导入',sub:'下载模板，逐行核验，确认无误后一次提交。',icon:'download',tabs:[['importBatches','导入批次']],roles:['manager'],actions:[['import.preview','导入并校验',['manager']]]}
 };
 const state=()=>c.state(),role=()=>c.session()?.role||c.session()?.actor;
 const financeRole=()=>['finance','manager'].includes(role());
 const allowedTabs=cfg=>cfg.tabs.filter(t=>!(role()==='ops'&&['offlinePayments','refundRequests','invoiceRequests','receipts'].includes(t[0]))&&!(t[0]==='cooperationRequests'&&!['manager','ops'].includes(role())));
 const collection=()=>{const cfg=configs[c.ui().page];return cfg?(c.ui().opTab&&allowedTabs(cfg).some(t=>t[0]===c.ui().opTab)?c.ui().opTab:allowedTabs(cfg)[0][0]):null};
 const verifiedReceipt=row=>row?.status==='success'&&row.adapterMode!=='mock';
 const isAssignableStaff=staff=>staff.status==='active'&&staff.activated===true;
 const options=(key,label,predicate)=>[['','请选择'],...(state()[key]||[]).filter(row=>(key!=='receipts'||verifiedReceipt(row))&&(!predicate||predicate(row))).map(x=>[x.id,label?label(x):x.name||x.title||x.id])];
 const choice=(n,label,key,value='',fn,predicate)=>`<label class="field">${esc(label)}<input name="${n}" value="${esc(value)}" list="list-${n}" required placeholder="选择记录或输入完整编号"><datalist id="list-${n}">${options(key,fn,predicate).filter(x=>x[0]).map(([id,name])=>`<option value="${esc(id)}">${esc(name)}</option>`).join('')}</datalist><small>可输入完整编号，权限与状态在提交时核验。</small></label>`;
 const localDateTime=v=>v?new Date(new Date(v).getTime()-new Date(v).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
 const reason=()=>area('reason','依据与说明','','required minlength="3" maxlength="1000"');
 const amount=(label='金额（人民币元）',v='',min='0.01')=>field('amount',label,v,'number',`required min="${min}" step="0.01"`);
 const date=(n,label,v='')=>field(n,label,v,'date','required');
 const month=(n,label,v='')=>field(n,label,v,'month','required');
 const bool=(n,label,v=false)=>select(n,label,[['false','草稿 / 不公开'],['true','发布 / 公开']],String(v));
 const id=(v)=>field('id','',v,'hidden');
 const recordButton=(cmd,text,r,key)=>button(text,'op-form',{cmd,id:r.id,...(key?{collection:key}:{})},'soft');
 const displayRecord=(key,row)=>key==='stage'?routeLabel(row.kind,row.assigneeRole)
  :key==='assigneeUserId'?state().staffAccounts?.find(staff=>staff.id===row.assigneeUserId)?.name||row.assigneeUserId
  :display(key,row[key]);
 const review=(cmd,r)=>role()==='finance'&&r.status==='pending'?recordButton(cmd,'复核处理',r,({ 'offline.review':'offlinePayments', 'billing.correct.review':'billCorrections', 'fee.adjust.review':'feeProposals', 'refund.review':'refundRequests' })[cmd]):'';
 const columns={agreements:[['outlet','网点'],['planId','价格版本'],['startMonth','开始月'],['endMonth','结束月']],pricePlans:[['name','方案名称'],['version','版本'],['amount','整月费用'],['invoiceEntity','开票主体']],staffAccounts:[['name','姓名'],['subject','登录账号'],['role','岗位']],handovers:[['fromSubject','原负责人'],['toSubject','接收人'],['createdAt','交接时间']],offlinePayments:[['billId','账单'],['amount','登记金额'],['reference','外部流水']],refundRequests:[['receiptId','实收流水'],['amount','申请金额'],['reference','退款凭证']],invoiceRequests:[['title','开票抬头'],['amount','金额'],['number','发票号码']],billCorrections:[['billId','原账单'],['amount','更正金额'],['replacementBillId','替换账单']],feeProposals:[['adjustmentId','调整来源'],['amount','抵扣金额'],['offsetMonth','抵扣月份']],businessTasks:[['title','业务事项'],['outlet','网点'],['dueOn','截止日期'],['assignee','办理人']],policies:[['name','制度名称'],['version','版本'],['effectiveFrom','生效日期']],jobRuns:[['jobKey','批次'],['today','检查日期'],['createdAt','运行时间']],faqEntries:[['question','问题'],['answer','答复'],['updatedAt','更新时间']],publicProfiles:[['title','名称'],['outlet','关联网点'],['updatedAt','更新时间']],importBatches:[['kind','数据类型'],['validCount','有效行'],['errorCount','错误行']],receipts:[['billId','账单'],['amount','实收金额'],['adapterMode','登记来源'],['externalReference','外部凭证']]};
 const routingOptions=()=>state().routingOptions||[];
 const routeLabel=(kind,role)=>routingOptions().find(option=>option.kind===kind&&option.role===role)?.label||kind;
 columns.taskRoutingRules=[['outlet','网点'],['stage','业务阶段'],['assigneeUserId','个人负责人']];
 const taskNames={report_review:'月报待审核',report_returned:'月报退回待修改',request_review:'业务申请待审批',request_supplement:'申请待补充材料',fee_calculation:'停费待财务核算',support_reply:'客服回复待查看',report_missing:'上月月报待报送',exemption_review:'停业月份待核验免报',location_missing:'本月位置待核验',bill_overdue:'逾期账单待处理',support_sla:'客服响应超时',metric_anomaly:'经营指标待复核',no_data:'连续缺数待核实'};
 const display=(k,v)=>v==null?'—':k==='amount'?'¥ '+fmt(v,'revenue'):k==='outlet'?c.name(v):k==='role'?(c.roles[v]||v):k==='kind'?(taskNames[v]||v):k==='published'?(v?'已发布':'草稿'):typeof v==='object'?JSON.stringify(v):String(v);
 columns.businessTasks[0]=['kind','业务事项'];
 columns.cooperationRequests=[['company','合作单位'],['name','联系人'],['contact','联系方式'],['createdAt','留言时间']];
 function rowActions(key,r){let a=button('详情','record-detail',{collection:key,id:r.id});
  if(key==='staffAccounts')a+=contacts.openButton(r)+recordButton('staff.update','权限 / 状态',r)+button('签发激活码','activation',{actor:r.subject||r.id})+button('登记登录手机号','staff-login-mobile',{actor:r.subject||r.id})+(r.role==='regional'?recordButton('grant.revoke','撤销区域授权',r):'');
  if(key==='taskRoutingRules')a+=recordButton('routing.set','编辑规则',r);
  if(key==='agreements'&&['manager','finance'].includes(role()))a+=recordButton('billing.generate','生成账单',r);
  if(key==='offlinePayments')a+=review('offline.review',r);if(key==='billCorrections')a+=review('billing.correct.review',r);if(key==='feeProposals')a+=review('fee.adjust.review',r);
  if(key==='refundRequests'){
   a+=review('refund.review',r);
   if(financeRole()&&['approved','recorded'].includes(r.status))a+=button('处理退款','channel-refund-open',{id:r.id},'soft');
   const receipt=state().receipts?.find(row=>row.id===r.receiptId);
   if(role()==='finance'&&r.status==='approved'&&verifiedReceipt(receipt)&&receipt.adapterMode==='manual')a+=recordButton('refund.record','登记退款凭证',r,key);
  }
  if(key==='invoiceRequests'&&role()==='finance'&&['pending','issued','red_pending'].includes(r.status))a+=recordButton('invoice.update','登记票据状态',r,key);
  if(key==='faqEntries'&&['manager','support'].includes(role()))a+=recordButton('faq.save','编辑',r);
  if(key==='publicProfiles'&&['manager','ops'].includes(role()))a+=recordButton('public.profile','编辑公开资料',r);
  if(key==='cooperationRequests'&&['manager','ops'].includes(role())&&['submitted','received','contacted'].includes(r.status))a+=recordButton('cooperation.update',({submitted:'受理留言',received:'登记联系',contacted:'完成并关闭'})[r.status],r);
  if(key==='businessTasks'&&r.status!=='resolved')a+=button('打开待办队列','nav',{page:'tasks'},'soft');
  if(key==='importBatches'&&r.status==='preview'&&r.errorCount===0)a+=recordButton('import.commit','确认导入',r);
  return `<div class="row-actions">${a}</div>`;
 }
 function render(){const cfg=configs[c.ui().page],key=collection(),rows=state()[key]||[];
  return heading(cfg.title,cfg.sub)+`<div class="operation-banner"><span class="operation-seal">${c.I(cfg.icon)}</span><div><b>${c.ui().page==='financeops'?'账务清晰，凭证有据':'让每一个流程，都有清晰的下一步'}</b><p>${c.ui().page==='financeops'?'核验渠道退款、登记线下资金与票据凭证。':'必填资料由业务人员明确确认，系统保留版本、处理人和操作时间。'}</p></div></div><div class="workspace-toolbar"><div class="tabs">${allowedTabs(cfg).map(([k,n])=>`<button data-action="op-tab" data-tab="${k}" class="${key===k?'active':''}">${n}</button>`).join('')}</div><div class="actions">${cfg.actions.filter(x=>x[2].includes(role())).map(([cmd,label],i)=>button(label,'op-form',{cmd},i?'':'primary','plus')).join('')}${c.ui().page==='financeops'&&financeRole()?button('支付对账异常','payment-exceptions',{},'soft'):''}</div></div>`+(c.ui().page==='imports'?notice('模板支持 UTF-8 CSV 或 JSON，单批最多200行。预览不写入业务记录，提交时重新校验。',true):'')+c.pageControls()+`<section class="panel"><div class="panel-head"><h3>${cfg.tabs.find(t=>t[0]===key)[1]}</h3><small>按授权范围展示 · 记录可追溯</small></div>${rows.length?`<div class="table-wrap"><table><thead><tr>${(columns[key]||[]).map(([,t])=>`<th>${t}</th>`).join('')}<th>状态</th><th>操作</th></tr></thead><tbody>${rows.map(r=>`<tr>${(columns[key]||[]).map(([k])=>`<td class="cell-${k}"><span title="${esc(displayRecord(k,r))}">${esc(displayRecord(k,r))}</span>${k===(columns[key][0][0])?`<small>${esc(r.id)}</small>`:''}</td>`).join('')}<td>${key==='businessTasks'&&r.status==='open'?'<span class="pill warn">待办理</span>':chip(r.status||((r.published===true)?'published':'draft'))}</td><td>${rowActions(key,r)}</td></tr>`).join('')}</tbody></table></div>`:c.collectionEmpty('暂无'+cfg.tabs.find(t=>t[0]===key)[1]+'记录。')}</section>`;
 }
 function grants(r={}){const g=r.grants||{outlets:[],metrics:[],reviewOutlets:[]};return `<details class="grant-editor" ${r.role==='regional'?'open':''}><summary>区域岗位专属授权</summary><p class="muted">仅区域岗位使用。填写完整编号，以逗号分隔；不授予未勾选指标。</p>${field('grantOutlets','可见网点编号',(g.outlets||[]).join(','),'text','placeholder="cs, wh"')}${Object.entries(c.metrics).map(([k,n])=>`<label class="check"><input type="checkbox" name="grantMetrics" value="${k}" ${(g.metrics||[]).includes(k)?'checked':''}>${n}</label>`).join('')}${field('reviewOutlets','月报审核网点编号',(g.reviewOutlets||[]).join(','))}<div class="form-grid">${field('grantValidFrom','授权开始（本地时间，留空不限制）',localDateTime(g.validFrom),'datetime-local')}${field('grantValidUntil','授权截止（本地时间，留空不限制）',localDateTime(g.validUntil),'datetime-local')}</div></details>`}
 function fields(cmd,r={}){switch(cmd){
  case'plan.publish':return field('name','方案名称','','text','required')+amount('整月服务费（人民币元）')+field('serviceEntity','服务主体全称','','text','required')+field('collectionEntity','收款主体全称','','text','required')+field('invoiceEntity','开票主体全称','','text','required')+area('terms','已确认服务条款')+reason();
  case'agreement.create':return choice('outlet','网点','outlets')+choice('planId','价格版本','pricePlans')+`<div class="form-grid">${month('startMonth','协议开始月份')}${month('endMonth','协议结束月份')}${field('billDay','每月账单日','','number','required min="1" max="28"')}${field('dueDay','每月截止日','','number','required min="1" max="28"')}</div>`+field('reference','协议编号 / 核验凭据','','text','required')+reason();
  case'billing.generate':return choice('agreementId','生效协议','agreements',r.id||'')+month('month','生成账单月份',c.ui().period)+notice('仅对协议内的整月生成账单；账单日、已有账单与抵扣由服务器核验。');
  case'billing.correct.propose':return choice('billId','原账单','bills')+amount('更正后金额（0为作废）','','0')+reason();
  case'fee.adjust.propose':return choice('adjustmentId','已审批停费待核算记录','adjustments',r.id||'')+amount('人工确认抵扣金额')+month('offsetMonth','明确抵扣月份')+field('serviceUntil','已确认服务截止日（未确认留空）','','date')+reason();
  case'offline.submit':return choice('billId','未付账单','bills')+amount('已发生全额收款金额')+field('reference','真实外部流水编号','','text','required')+date('paidOn','实际收款日期')+reason();
  case'refund.request':return choice('receiptId','原实收流水','receipts')+amount('申请退款金额')+reason()+notice('审核通过后，按原付款方式办理退款。渠道退款由支付渠道确认，线下退款按实际凭证登记。');
  case'invoice.request':return choice('receiptId','原实收流水','receipts')+amount('申请开票金额')+field('title','发票抬头','','text','required')+field('taxId','纳税人识别号','','text','required')+reason();
  case'billing.correct.review':case'fee.adjust.review':case'offline.review':case'refund.review':return id(r.id)+pair('业务编号',r.id)+pair('金额（元）',r.amount)+select('decision','复核结果',[['approve','审核通过'],['return','退回处理']])+area('note','复核依据')+notice('必须由不同自然人复核；状态变化、金额与相关票据均在提交时再次核验。');
  case'refund.record':return id(r.id)+pair('已批准金额',r.amount)+field('reference','实际外部退款流水编号','','text','required')+date('refundedOn','实际退款日期')+area('note','凭证核验说明');
  case'invoice.update':{const choices=r.status==='pending'?[['issued','已在外部开票'],['rejected','驳回'],['cancelled','取消']]:r.status==='issued'?[['red_pending','申请冲红']]:[['red_issued','已在外部冲红']];return id(r.id)+select('status','票据状态',choices)+(r.status==='pending'?field('number','实际发票号码（开票必填）')+field('issuedOn','实际开票日期（开票必填）','','date'):r.status==='red_pending'?field('redNumber','实际红字票号码','','text','required')+date('redOn','实际冲红日期'):'')+area('note','处理依据')}
  case'routing.set':{
   const stage=r.id?r.kind+'|'+r.assigneeRole:'';
   const stageField=r.id?field('routeStage','',stage,'hidden')+pair('业务阶段',routeLabel(r.kind,r.assigneeRole))
    :select('routeStage','业务阶段',routingOptions().map(option=>[option.kind+'|'+option.role,option.label]));
   const outletField=r.id?field('outlet','',r.outlet,'hidden')+pair('网点',c.name(r.outlet)):choice('outlet','网点','outlets');
   return outletField+stageField+choice('assigneeUserId','已激活的在职个人账号','staffAccounts',r.assigneeUserId||'',staff=>staff.name+' / '+(c.roles[staff.role]||staff.role),isAssignableStaff)
    +bool('enabled','规则状态',r.status!=='disabled')+reason()
    +notice('从新提交的业务开始分派。已有待办可在对应队列进行分派或转派。接收人须已激活个人总部账号并属于对应岗位。',true);
  }
  case'staff.create':return field('subject','个人登录账号','','text','required pattern="[A-Za-z0-9_-]{3,80}" placeholder="例如 zhang_san"')+field('name','员工姓名','','text','required')+select('role','岗位',Object.entries(c.roles).filter(([k])=>['manager','ops','finance','location','support','regional'].includes(k)),'ops')+grants()+reason();
  case'staff.update':return id(r.id)+field('name','员工姓名',r.name,'text','required')+select('role','岗位',Object.entries(c.roles).filter(([k])=>['manager','ops','finance','location','support','regional'].includes(k)),r.role)+select('status','账号状态',[['active','正常'],['disabled','停用']],r.status)+grants(r)+reason();
  case'grant.revoke':return id(r.id)+pair('撤销对象',r.name||r.id)+reason()+notice('撤销该人员全部区域可见指标及审核权限，已有会话即时失效。');
  case'staff.handover':return choice('fromSubject','离任人账号','staffAccounts','',x=>x.name+' / '+x.role)+choice('toSubject','已激活的接收人账号（同岗位）','staffAccounts','',x=>x.name+' / '+x.role,isAssignableStaff)+reason()+notice('系统转移未结束客服及个人待办，停用离任账号并撤销旧会话。');
  case'policy.configure':return field('name','规则版本名称','','text','required')+date('effectiveFrom','生效日期')+`<div class="form-grid">${field('reportDueDay','月报截止日（未确认留空）','','number','min="1" max="28"')}${field('locationDueDay','位置核验截止日（未确认留空）','','number','min="1" max="28"')}${field('anomalyPercent','异常波动阈值 %（未确认留空）','','number','min="0.01" step="0.01"')}${field('locationThresholdMeters','已确认位置偏差阈值 / 米（未确认留空）','','number','min="0.01" step="0.01"')}${field('noDataMonths','连续缺数月数（未确认留空）','','number','min="1"')}${field('complaint','投诉首响时限 / 分钟','','number','min="1"')}${field('aftersale','售后首响时限 / 分钟','','number','min="1"')}${field('exception','异常首响时限 / 分钟','','number','min="1"')}</div>`+reason()+notice('留空代表未配置。系统不会将未确认阈值替换为默认制度。');
  case'jobs.run':return notice('使用服务器的 Asia/Shanghai 当前日期执行。单批最多200个对象，可按返回游标继续。',true)+field('limit','每批处理数量',100,'number','required min="1" max="200"')+field('cursor','起始游标',0,'number','required min="0"')+field('outlet','仅处理网点（选填）');
  case'task.update':return id(r.id)+pair('待办',r.title||r.type)+select('status','办理状态',[['open','待办理'],['in_progress','办理中'],['resolved','已解决']],r.status)+field('assignee','办理人账号（选填）',r.assignee||'')+area('note','办理依据')+notice('催报、付款等事实型待办须由相关业务完成，不能仅通过修改状态关闭。');
  case'faq.save':return (r.id?id(r.id):'')+field('question','常见问题',r.question||'','text','required')+area('answer','标准答复',r.answer||'')+field('keywords','关键词（逗号分隔）',(r.keywords||[]).join(','),'text','required')+bool('published','发布状态',r.status==='published')+reason();
  case'public.profile':return (r.id?field('outlet','',r.outlet,'hidden')+pair('关联网点',c.name(r.outlet)):choice('outlet','关联网点','outlets'))
   +field('title','公开网点名称',r.title||'','text','required')+area('description','公开介绍',r.description||'')
   +field('services','服务项目（逗号分隔）',(r.services||[]).join(','),'text','required')
   +field('contact','联系电话（内部保留，授权后才公开）',r.contact||'','text','required')
   +select('contactPublished','联系电话公开授权',[['false','不向公众展示'],['true','已获授权，公开此联系电话']],String(r.contactPublished===true))
   +field('businessHours','对外服务时间（选填）',r.businessHours||'','text','maxlength="160" placeholder="仅填写已确认可公开的服务时间"')
   +'<input type="hidden" name="imageId" value="'+esc(r.imageId||'')+'" data-original-image="'+esc(r.imageId||'')+'">'
   +'<div class="actions" data-content-cover-actions'+(r.imageId?'':' style="display:none"')+'>'
   +button('预览店照','view-photo',{id:r.imageId||''})
   +button('移除店照','content-cover-clear')+'<img data-cover-preview alt="公开店照" hidden style="max-width:100%;max-height:240px"></div>'
   +'<label class="field">公开店照（选填）<input id="outletPhoto" data-image-purpose="public-outlet-photo" type="file" accept="image/png,image/jpeg,image/webp"><small>请使用已获公开授权的店照，2MB 内 PNG、JPEG 或 WebP。保存并发布档案后公开。</small></label>'
   +field('address','公开服务地址',r.address||'','text','required')+bool('published','发布状态',r.status==='published')
   +`<h3 class="section-title">公开地区及地图位置</h3>`
   +field('countryCode','国家或地区代码（选填）',r.countryCode||'','text','maxlength="2" pattern="[A-Za-z]{2}" placeholder="例如 CN、SG。留空沿用档案"')
   +field('city','境外城市（选填）',r.countryCode&&r.countryCode!=='CN'?r.city:'','text','maxlength="100" placeholder="境外网点可填写公开城市"')
   +notice('请使用已核验且获授权的公开坐标。中国大陆使用 GCJ-02，境外使用 WGS-84。内部现场位置不会自动公开。',true)
   +select('publicCoordsMode','坐标授权操作',[['keep','保持当前授权（未设置则不公开）'],['publish','明确授权发布 / 更新经纬度'],['clear','撤销并清除已公开坐标']],'keep')
   +select('publicCrs','公开坐标基准',[['GCJ-02','GCJ-02（中国大陆）'],['WGS-84','WGS-84（境外）']],r.publicCoords?.coordinateSystem||(r.countryCode&&r.countryCode!=='CN'?'WGS-84':'GCJ-02'))
   +`<div class="form-grid">${field('publicLat','公开纬度（−90 至 90）',r.publicCoords?.lat??'','number','min="-90" max="90" step="any" placeholder="选择发布时必填"')}${field('publicLng','公开经度（−180 至 180）',r.publicCoords?.lng??'','number','min="-180" max="180" step="any" placeholder="选择发布时必填"')}</div>`+reason();
  case'cooperation.update':{const next=({submitted:['received','已受理'],received:['contacted','已联系'],contacted:['closed','已关闭']})[r.status];if(!next)throw Error('该合作留言已关闭，请刷新列表');return id(r.id)+pair('合作单位',r.company)+pair('联系人',r.name)+pair('联系方式',r.contact)+pair('合作留言',r.message)+select('status','下一步状态',[next])+area('note','跟进记录与处理依据')+notice('仅记录本次实际处理情况。系统按受理、联系、关闭顺序推进，跟进说明仅授权工作人员可见。',true)}
  case'import.preview':return select('kind','导入类型',[['accounts','加盟商账号'],['outlets','网点档案']])+`<div class="actions">${button('账号 CSV 模板','import-template',{kind:'accounts'},'','download')}${button('网点 CSV 模板','import-template',{kind:'outlets'},'','download')}</div><label class="field">选择 UTF-8 CSV / JSON 文件<input type="file" id="importFile" accept=".csv,.json,text/csv,application/json"></label>`+area('rows','导入数据（JSON数组，可编辑）','','required maxlength="200000" placeholder="上传模板文件后会自动填入；最多200行"')+reason();
  case'import.commit':return id(r.id)+pair('有效行数',r.validCount)+pair('错误行数',r.errorCount)+notice('确认后一次性创建记录。重复提交同一批次不会重复创建。',true);
  default:throw Error('暂不支持该操作表单');
 }}
 async function open(cmd,recordId,recordCollection){let r={};if(recordId){const key=recordCollection||collection();r=await c.api('/collections/'+encodeURIComponent(key)+'/'+encodeURIComponent(recordId))}const title=Object.values(configs).flatMap(x=>x.actions).find(x=>x[0]===cmd)?.[1]||{'staff.update':'人员权限与状态','grant.revoke':'撤销个人区域授权','billing.correct.review':'账单纠错复核','fee.adjust.review':'费用调整复核','offline.review':'线下收款复核','refund.review':'退款申请复核','refund.record':'登记已完成退款','invoice.update':'票据处理','task.update':'办理业务待办','cooperation.update':'合作留言跟进','import.commit':'确认批量导入'}[cmd]||'编辑记录';c.modal(title,form(cmd,fields(cmd,r)+submit(cmd==='import.preview'?'预览并逐行校验':cmd==='import.commit'?'确认导入':'确认提交')))}
 function normalize(cmd,d,f){const split=v=>String(v||'').split(/[,，\n]/).map(x=>x.trim()).filter(Boolean),num=v=>v===''||v==null?null:Number(v);
  if(cmd==='routing.set'){
   const [kind,assigneeRole]=String(d.routeStage||'').split('|');
   d.kind=kind;d.assigneeRole=assigneeRole;d.enabled=d.enabled==='true';
   delete d.routeStage;
  }
  if(cmd==='agreement.create'){d.billDay=Number(d.billDay);d.dueDay=Number(d.dueDay)}
  if(['staff.create','staff.update'].includes(cmd)){d.grants={outlets:split(d.grantOutlets),metrics:new FormData(f).getAll('grantMetrics'),reviewOutlets:split(d.reviewOutlets),validFrom:d.grantValidFrom?new Date(d.grantValidFrom).toISOString():null,validUntil:d.grantValidUntil?new Date(d.grantValidUntil).toISOString():null};delete d.grantOutlets;delete d.grantMetrics;delete d.reviewOutlets;delete d.grantValidFrom;delete d.grantValidUntil}
  if(cmd==='policy.configure'){for(const k of ['reportDueDay','locationDueDay','anomalyPercent','noDataMonths','locationThresholdMeters'])d[k]=num(d[k]);d.slaMinutes={complaint:num(d.complaint),aftersale:num(d.aftersale),exception:num(d.exception)};delete d.complaint;delete d.aftersale;delete d.exception}
  if(cmd==='fee.adjust.propose')d.serviceUntil=d.serviceUntil||null;
  if(cmd==='faq.save'){d.keywords=split(d.keywords);d.published=d.published==='true'}
  if(cmd==='public.profile'){
   d.contactPublished=d.contactPublished==='true';d.services=split(d.services);d.published=d.published==='true';
   const photo=f?.elements.imageId;
   if(photo&&photo.value===photo.dataset.originalImage)delete d.imageId;
   else if(Object.hasOwn(d,'imageId'))d.imageId=d.imageId||null;
   if(d.countryCode?.trim())d.countryCode=d.countryCode.trim().toUpperCase();else delete d.countryCode;
   if(!d.city?.trim())delete d.city;
   if(d.publicCoordsMode==='publish'){
    if(d.publicLat===''||d.publicLng===''||!Number.isFinite(Number(d.publicLat))||!Number.isFinite(Number(d.publicLng)))throw Error('发布公开地图位置须同时填写有效经度与纬度');
    const lat=Number(d.publicLat),lng=Number(d.publicLng);
    if(Math.abs(lat)>90||Math.abs(lng)>180)throw Error('公开纬度须在−90至90，经度须在−180至180之间');
    d.publicCoords={lat,lng,coordinateSystem:d.publicCrs};
   }else if(d.publicCoordsMode==='clear')d.publicCoords=null;
   delete d.publicCoordsMode;delete d.publicLat;delete d.publicLng;delete d.publicCrs;
  }
  if(cmd==='jobs.run'){d.limit=Number(d.limit);d.cursor=Number(d.cursor);if(!d.outlet)delete d.outlet}
  if(cmd==='task.update'&&!d.assignee)delete d.assignee;
  if(cmd==='import.preview'){try{d.rows=JSON.parse(d.rows)}catch{throw Error('导入数据不是有效 JSON，请检查模板内容')}if(!Array.isArray(d.rows)||!d.rows.length||d.rows.length>200)throw Error('导入须为1—200行记录数组')}
  return d;
 }
 const channelNames={wechat:'微信支付',alipay:'支付宝'};
 const refundStatuses={pending:'退款处理中',success:'已核验退款',failed:'渠道退款未成功'};
 const exceptionReasons={LATE_PAYMENT_SUCCESS:'关单后确认收款',PAYMENT_REFERENCE_CHANGED:'订单出现不同渠道流水',BILL_CHANGED:'账单或实收已变化',PAYMENT_REFERENCE_CONFLICT:'渠道流水与另一订单重复',
  PAY_CONTRACT_MISMATCH:'原协议的收款信息已变化',PAY_MERCHANT_MAPPING:'原收款主体配置需核对',PAY_MERCHANT_MISMATCH:'原收款主体与渠道商户需核对'};
 const money=cents=>'¥ '+(cents/100).toFixed(2);
 const refundPath=id=>'/payment-refunds/requests/'+encodeURIComponent(id);
 function showRefund(record,error){
  const order=record.order;
  const status=order?(order.manualReview?'待财务核对':refundStatuses[order.status]):record.requestStatus==='recorded'?'已登记凭证':'待办理';
  const action=order?.status==='pending'?button('查询渠道退款','channel-refund-query',{id:record.refundRequestId},'primary')
   :record.canStart?button('确认发起渠道退款','channel-refund-confirm',{id:record.refundRequestId},'primary')
   :!record.channel&&role()==='finance'&&record.requestStatus==='approved'
    ?recordButton('refund.record','登记退款凭证',{id:record.refundRequestId},'refundRequests'):'';
  c.modal('退款处理',pair('退款申请',record.refundRequestId)+pair('审核金额',money(record.amountCents))
   +pair('付款渠道',channelNames[record.channel]||'线下或历史付款')+pair('办理状态',status)
   +(order?pair('渠道退款单',order.id):'')
   +(record.canStart?notice('确认后将向原支付渠道发起已审核金额的退款。结果以渠道核验为准。',true):'')
   +(order?.manualReview||order?.status==='failed'?notice('请通过原商户平台核对退款单和最终凭证。',true):'')
   +(error?notice(error.message+(error.requestId?' · 请求编号 '+error.requestId:''),true):'')+action);
 }
 async function financeAction(data,trigger){
  if(data.action==='payment-exceptions'){
   const offset=Number(data.offset)||0,queue=await c.api('/payments/exceptions?'+new URLSearchParams({limit:25,offset}));
   const rows=queue.items.map(row=>'<div class="record">'+pair('异常原因',exceptionReasons[row.reason]||'待核对')
    +pair('支付订单',row.paymentId)+pair('关联账单',row.billId)+pair('渠道',channelNames[row.channel])
    +pair('渠道已收金额',money(row.amountCents))+pair('渠道凭证',row.providerReference)+pair('确认时间',row.paidAt)
    +pair('请求编号',row.requestId)+'</div>').join('');
   const paging=(offset?button('上一页','payment-exceptions',{offset:Math.max(0,offset-25)}):'')
    +(queue.nextOffset!==null?button('下一页','payment-exceptions',{offset:queue.nextOffset}):'');
   c.modal('支付对账异常',(rows||empty('暂无已核验但待对账的收款'))+paging);
   return;
  }
  if(data.action==='channel-refund-open'){showRefund(await c.api(refundPath(data.id)));return;}
  if(c.ui().busy)return;
  c.ui().busy=true;
  trigger.disabled=true;
  try{
   const record=await c.api(refundPath(data.id));
   if(data.action==='channel-refund-confirm'&&record.canStart){
    await c.api('/payments/'+encodeURIComponent(record.paymentId)+'/refund',{method:'POST',body:{refundRequestId:data.id},key:crypto.randomUUID()});
   }else if(data.action==='channel-refund-query'&&record.order?.status==='pending'){
    await c.api('/payment-refunds/'+encodeURIComponent(record.order.id)+'/query',{method:'POST',body:{}});
   }
   showRefund(await c.api(refundPath(data.id)));
  }catch(error){
   const record=await c.api(refundPath(data.id)).catch(()=>null);
   if(record)showRefund(record,error);
   else throw error;
  }finally{
   c.ui().busy=false;
   trigger.disabled=false;
  }
 }
 function recordMarkup(key,r){
  const names={id:'记录编号',status:'当前状态',createdAt:'创建时间',updatedAt:'更新时间',reason:'业务依据',note:'说明',subject:'个人主体',actor:'岗位',reference:'外部凭证',outlet:'网点',month:'业务月份',amount:'金额',requestId:'请求编号',company:'合作单位',name:'联系人',contact:'联系方式',message:'合作留言',processingNote:'内部跟进说明',handledBy:'处理人',consentedAt:'联络授权时间',consentVersion:'联络授权版本',publicCoords:'已授权公开坐标（GCJ-02）'};return Object.entries(r).filter(([k])=>!['trail','rows'].includes(k)).map(([k,v])=>pair(names[k]||columns[key]?.find(x=>x[0]===k)?.[1]||k,display(k,v))).join('');
 }
 function focusedActions(key,r){
  return ['offlinePayments','billCorrections','feeProposals','refundRequests','invoiceRequests'].includes(key)?rowActions(key,r):'';
 }
 async function detail(key,recordId){
  const r=await c.api('/collections/'+encodeURIComponent(key)+'/'+encodeURIComponent(recordId));
  const rows=Array.isArray(r.rows)?panel('逐行校验',r.rows.map((row,i)=>`<div class="validation-row ${row.errors?.length?'invalid':'valid'}"><b>第 ${i+1} 行</b><span>${esc(row.errors?.length?row.errors.map(e=>typeof e==='string'?e:JSON.stringify(e)).join('；'):'校验通过')}</span></div>`).join('')):'';
  const history=c.approval.mount(key,r.id);
  const trail=Array.isArray(r.trail)?`<h3 class="section-title">处理时间线</h3><ol class="timeline">${r.trail.map(t=>`<li><b>${esc(t.action||t.command||t.status||'业务处理')}</b><small>${esc(t.at||t.createdAt||'')} · ${esc(t.subject||t.by||t.actor||'')}</small><p>${esc(t.note||t.reason||'')}</p></li>`).join('')}</ol>`:'';
  c.modal('业务记录详情',recordMarkup(key,r)+rows+(history||trail));
  if(history)await c.approval.load(document.querySelector('#modal .approval-history'));
 }
 function template(kind){const keys=kind==='accounts'?['name','managerName','mobile']:['owner','name','countryCode','province','city','district','address','phone','opening','status','enrollmentApplicable'];c.download('\uFEFF'+keys.join(',')+'\r\n','九盈英才_'+kind+'_导入模板.csv','text/csv;charset=utf-8')}
 async function readFile(file){if(file.size>256*1024)throw Error('导入文件最大256KB');const text=(await file.text()).replace(/^\uFEFF/,'');let rows;if(file.name.toLowerCase().endsWith('.json')){rows=JSON.parse(text)}else{const table=parseCSV(text),keys=table.shift()||[];rows=table.filter(row=>row.some(Boolean)).map(row=>Object.fromEntries(keys.map((k,i)=>[k,k==='enrollmentApplicable'?(['true','1','是'].includes(row[i])?true:['false','0','否'].includes(row[i])?false:row[i]):row[i]||''])))}if(!Array.isArray(rows)||rows.length<1||rows.length>200)throw Error('模板须包含1—200行');document.querySelector('dialog textarea[name="rows"]').value=JSON.stringify(rows,null,2);c.toast('文件已读取，请提交预览并查看逐行校验结果')}
 return {configs,collection,render,open,normalize,detail,recordMarkup,focusedActions,template,readFile,financeAction};
}
export function parseCSV(text){const rows=[],row=[];let value='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++}else quoted=!quoted}else if(ch===','&&!quoted){row.push(value);value=''}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(value);rows.push(row.splice(0));value=''}else value+=ch}if(quoted)throw Error('CSV 引号未闭合');if(value||row.length){row.push(value);rows.push(row)}return rows}
