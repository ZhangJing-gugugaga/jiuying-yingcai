'use strict';
const labels={revenue:'营业收入（元）',orders:'有效订单（单）',traffic:'到店客流（人次）',enroll:'实际招生（人）'};
function reportRows(data,state,actor,history=[]){
 const keys=Object.keys(data.totals),rows=[['九盈英才 · 经营报告'],['期间',data.period,'周期',{month:'月度',quarter:'季度',year:'年度'}[data.kind],'数据层',data.mode==='settled'?'已结算范围':'过程数据'],['网点',...keys.map(k=>labels[k]),'覆盖月份'],...data.rows.map(r=>[r.name,...keys.map(k=>r[k]??'缺失 / 不适用'),r.coverage+'/'+r.expectedMonths])];
 const status=data.settlementStatus;
 if(status?.state==='pending_resettlement')rows.push([],['经营数据更新中',status.pendingMonths.join('、')]);
 if(status?.refreshingMonths?.length)rows.push([],['已结算数据更新中',status.refreshingMonths.join('、')]);
 if(status?.state==='resettled')rows.push([],['经营数据已更新',status.updatedMonths.join('、')]);
 const c=data.reportingCoverage;
 if(c)rows.push([],['报送覆盖'],['应报网点月',c.expected,'已提交',c.submitted],['待审核',c.pendingReview,'已通过',c.approved],['已免报',c.exempt,'逾期未报',c.overdue],['招生不适用',c.notApplicable,'招生待确认',c.awaitingEnrollment],['已结算',c.settled,'报送完整',c.complete?'是':'否'],['逾期补报',c.lateSubmitted,'逾期未核验免报',c.overdueExemptReview]);
 if(data.reportDeadlines)rows.push([],['报送月份','报送截止日期'],...Object.entries(data.reportDeadlines).map(([month,timing])=>[month,timing.dueOn||'待配置']));
 rows.push([],['近六月趋势',...keys.map(k=>labels[k])],...history.map(h=>[h.period,...keys.map(k=>h.totals[k]??'缺失')]));
 rows.push([],['经营说明'],...(state.reports||[]).filter(r=>r.current&&data.months.includes(r.month)&&data.rows.some(o=>o.outlet===r.outlet)).map(r=>[data.rows.find(o=>o.outlet===r.outlet).name,r.month,r.note||'未填写']));
 rows.push([],['异常提示']);const alerts=(state.businessTasks||[]).filter(t=>['report_missing','metric_anomaly','no_data','exemption_review'].includes(t.kind)&&t.status!=='resolved'&&data.months.includes(t.month)&&data.rows.some(o=>o.outlet===t.outlet));
 if(alerts.length)rows.push(...alerts.map(t=>{
  const timing=data.reportDeadlines?.[t.month];
  const title=({report_missing:timing?.late?'月报逾期未报':'月报待报送',metric_anomaly:'指标波动待核实',no_data:'长期缺数据待核实',exemption_review:timing?.late?'整月停业免报核验逾期':'整月停业待核验免报'})[t.kind];
  return [data.rows.find(o=>o.outlet===t.outlet).name,t.month,title,...(['report_missing','exemption_review'].includes(t.kind)?[timing?.dueOn||'待配置']:[])];
 }));else rows.push(['当前范围无未完成的已生成异常任务','—','阈值未配置或调度未执行不代表无异常']);
 if(actor==='manager')for(const k of keys)rows.push([],['独立排名',labels[k]],...data.rows.filter(r=>r[k]!=null).sort((a,b)=>b[k]-a[k]).map((r,i,ordered)=>[ordered.findIndex(x=>x[k]===r[k])+1,r.name,r[k]]));
 rows.push([],['口径说明','缺失或不适用不按零处理；范围以当前用户权限为准。'],['方法版本',data.methodVersion]);return rows;
}
async function exportXlsx(rows){const {xlsx}=await import('../../web/export.js');return Buffer.from(xlsx(rows));}
const exportPdf=require('./pdf-report.cjs');
module.exports={reportRows,exportXlsx,exportPdf};
