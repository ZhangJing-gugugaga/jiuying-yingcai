const labels={
 in_progress:'处理中',resolved:'已完成',completed:'已完成',published:'已发布',
 draft:'草稿',submitted:'已提交',pending:'待处理',approved:'已通过',rejected:'未通过',returned:'待我修改',
 amend:'待补充资料',supplement:'待补充资料',finance:'财务复核中',finance_pending:'财务复核中',pending_finance:'财务复核中',
 paid:'已支付',partially_paid:'部分支付',success:'支付成功',unpaid:'待支付',failed:'支付未完成',cancelled:'已取消支付',
 refunded:'已退款',refund_pending:'退款处理中',settled_zero:'已结清',reversed:'已冲正',void:'已作废',
 open:'营业中',operating:'营业中',preparing:'筹备中',paused:'暂停营业',suspended:'暂停营业',closed:'已关闭',
 active:'正常',locked:'已锁定',disabled:'已停用',frozen:'已冻结',expired:'已到期',terminated:'已终止',superseded:'历史版本',
 revoked:'已撤销',exempt:'已免报',exempted:'已免报',overdue:'逾期补报',exception:'位置待核实',
 pending_calculation:'费用核算中','待财务核算调整':'费用核算中',applied:'已抵扣',
 recorded:'已核验',issued:'已开票',red_pending:'发票处理中',red_issued:'发票已冲红',
 unread:'未读',read:'已读',queued:'等待客服接单',claimed:'处理中',waiting:'待补充资料',processing:'处理中',
 newOutlet:'新增网点',pauseFee:'申请暂停收费',locationChange:'变更网点位置',enrollment:'调整招生业务适用情况',
 statusChange:'营业状态变更',exemptException:'免报财务事项',accountChange:'负责人或登记手机号变更',reportRevoke:'月报撤销',
 complaint:'投诉',aftersale:'售后问题',exception_ticket:'经营异常'
};
const contextual={
 report:{pending:'总部审核中',pending_review:'总部审核中',returned:'待我修改',missing:'待填写'},
 request:{pending:'待总部处理',queued:'待总部处理',amend:'待补充材料',supplement:'待补充材料',returned:'未通过'},
 outlet:{open:'营业中',operating:'营业中'},
 location:{missing:'待提交位置资料',pending:'等待总部核验',location_pending:'等待总部核验',exception:'位置待核实',location_anomaly:'位置待核实',approved:'位置已核验',location_verified:'位置已核验',overdue:'已超过核验日期，等待总部处理'},
 task:{open:'待处理',in_progress:'处理中',resolved:'已完成',closed:'已完成'},
 payment:{pending:'正在确认支付结果，请稍后刷新。',stale:'正在确认支付结果，请稍后刷新。',closed:'付款已关闭'},
 finance:{pending:'待财务核验',supplement:'待补充资料',returned:'已退回',rejected:'已退回',recorded:'已完成'},
 refund:{pending:'待财务核验',approved:'退款处理中',recorded:'已退款',returned:'已退回'},
 invoice:{pending:'待财务核验',returned:'已退回',rejected:'已退回',cancelled:'已取消'},
 agreement:{active:'生效中',pending:'待生效',cancelled:'已取消'},
 support:{queued:'等待客服接单',active:'处理中',claimed:'处理中',pending:'处理中',waiting:'待补充资料',closed:'已完成',exception:'经营异常'}
};
const taskNames={
 report_review:'经营月报等待总部审核',report_returned:'经营月报待修改',request_review:'申请等待总部处理',
 request_supplement:'业务申请待补充材料',fee_calculation:'费用核算中',bill_unpaid:'咨询服务费待支付',
 support_reply:'查看客服回复',support_waiting:'补充客服工单资料',support_queue:'等待客服接单',
 report_missing:'经营月报待填写',location_missing:'网点位置待核验',bill_overdue:'咨询服务费待支付',
 exemption_review:'免报待确认',support_sla:'客服工单处理中',metric_anomaly:'经营数据待核实',no_data:'经营数据待核实',
 report_resettlement:'月报统计待更新',training_material_returned:'学员资料需补充'
};
const contexts={outlets:'outlet',reports:'report',requests:'request',bills:'bill',payments:'payment',adjustments:'adjustment',
 verifications:'location',businessTasks:'task',agreements:'agreement',offlinePayments:'finance',refundRequests:'refund',invoiceRequests:'invoice'};
function label(value,context){
 const custom=contextual[context];
 if(custom&&Object.hasOwn(custom,value))return custom[value];
 return Object.hasOwn(labels,value)?labels[value]:value?'状态暂不可查看':'—';
}
const statusTones={
 ok:new Set(['approved','paid','success','refunded','settled_zero','open','operating','active','recorded','issued','applied','completed','resolved','published','location_verified','exempt','exempted']),
 wait:new Set(['pending','pending_review','submitted','in_progress','partially_paid','unpaid','draft','preparing','amend','supplement','finance','finance_pending','pending_finance','refund_pending','red_pending','pending_calculation','待财务核算调整','queued','claimed','waiting','processing','missing','received','location_pending']),
 red:new Set(['returned','rejected','overdue','exception','location_anomaly','failed','revoked'])
};
function statusTone(status,context){
 if(context==='refund'&&status==='approved'||context==='task'&&status==='open'||context==='support'&&status==='active')return 'wait';
 if(['support','task'].includes(context)&&status==='closed')return 'ok';
 return Object.keys(statusTones).find(tone=>statusTones[tone].has(status))||'gray';
}
function taskLabel(value){return Object.hasOwn(taskNames,value)?taskNames[value]:'业务事项待处理';}
function businessDate(value){
 if(typeof value!=='string')return '';
 if(/^\d{4}-\d{2}-\d{2}$/.test(value)){
  const time=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?value:'';
 }
 if(!/^\d{4}-\d{2}-\d{2}T/.test(value))return '';
 const time=Date.parse(value);
 return Number.isFinite(time)?new Date(time+8*3600000).toISOString().slice(0,10):'';
}
function monthText(value){const match=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(value||'');return match?match[1]+'年'+match[2]+'月':'';}
function dateText(value){const current=businessDate(value);return current?monthText(current.slice(0,7))+current.slice(8)+'日':'';}
function timeText(value){
 if(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)){
  const time=Date.parse(value);
  if(Number.isFinite(time))return dateText(value)+' '+new Date(time+8*3600000).toISOString().slice(11,16);
 }
 return dateText(value);
}
function money(value){
 if(value===null||value===undefined||value==='')return '—';
 const amount=Number(value);
 if(!Number.isFinite(amount)||Math.abs(amount)>=1e21)return '—';
 const [whole,fraction]=amount.toFixed(2).split('.');
 return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+fraction;
}
function month(offset=0){const d=new Date();const local=new Date(d.getTime()+8*3600000);const m=new Date(Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+offset,1));return m.getUTCFullYear()+'-'+String(m.getUTCMonth()+1).padStart(2,'0');}
function date(){return new Date(Date.now()+8*3600000).toISOString().slice(0,10);}
function addMonth(period,offset){const d=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5))-1+offset,1));return d.toISOString().slice(0,7);}
// growth-v1 display: missing, incomplete and zero-base periods are not comparable.
function change(current,previous,incomplete=false){if(incomplete||current===null||current===undefined||previous===null||previous===undefined||previous===0)return '不可比';const percent=(current-previous)/previous*100;return (percent>0?'+':'')+percent.toFixed(1)+'%';}
function reportInput(d,applicable=true){
  if(!/^\d+(\.\d{1,2})?$/.test(String(d.revenue)))throw new Error('营业收入必填，支持人民币元、最多两位小数');
  for(const [key,name] of [['orders','有效完成订单'],['traffic','到店客流'],...(applicable?[['enroll','实际招生人数']]:[])])
    if(!/^\d+$/.test(String(d[key])))throw new Error(name+'须填写非负整数');
  const result={revenue:Number(d.revenue),orders:Number(d.orders),traffic:Number(d.traffic),enroll:applicable?Number(d.enroll):null,note:String(d.note||'').trim()};
  if(!Number.isSafeInteger(Math.round(result.revenue*100))||['orders','traffic',...(applicable?['enroll']:[])].some(k=>!Number.isSafeInteger(result[k])))throw new Error('输入金额或数量超出安全范围');return result;
}
function reportDraft(d,applicable=true){const result={note:String(d.note||'').trim()};for(const k of ['revenue','orders','traffic','enroll']){const raw=d[k];if(raw===undefined)continue;if(raw===null||raw===''){result[k]=null;continue;}const valid=k==='revenue'?/^\d+(\.\d{1,2})?$/:/^\d+$/;if(!valid.test(String(raw)))throw new Error(k==='revenue'?'营业收入最多两位小数':'已填写的数量须为非负整数');const value=Number(raw);if(!Number.isSafeInteger(k==='revenue'?Math.round(value*100):value))throw new Error('输入超出安全范围');result[k]=value;}if(!applicable)result.enroll=null;return result;}
function decorate(state){const s={outlets:[],reports:[],requests:[],bills:[],payments:[],receipts:[],adjustments:[],verifications:[],exemptions:[],messages:[],accounts:[],drafts:[],support:{chats:[],tickets:[],settings:{}},...state};
  const name=id=>s.outlets.find(o=>o.id===id)?.name||(id?'所属网点':'—');
  for(const k of ['outlets','reports','requests','bills','payments','receipts','adjustments','verifications','messages','accounts','agreements','pricePlans','offlinePayments','refundRequests','invoiceRequests','businessTasks'])s[k]=(Array.isArray(s[k])?s[k]:[]).map(x=>({...x,review:x.publicNote||x.reviewNote||x.review||'',statusText:x.revoked?'已撤销':label(x.status,contexts[k]),statusTone:statusTone(x.revoked?'revoked':x.status,contexts[k]),typeText:k==='businessTasks'?taskLabel(x.kind):label(x.kind||x.type),outletName:x.outletName||name(x.outlet),amountText:money(x.amount),revenueText:money(x.revenue),enrollText:x.enroll===null?'不适用':x.enroll}));
  return s;
}
function outletOptionLabel(outlet){
  const area=[...new Set([outlet.city||outlet.province,outlet.district].filter(Boolean))].join(' ');
  return [outlet.name,area||outlet.address].filter(Boolean).join(' · ');
}
module.exports={outletOptionLabel,label,statusTone,taskLabel,money,month,date,addMonth,change,reportInput,reportDraft,decorate,monthText,dateText,timeText};
