const {monthText:labelMonth}=require('./format');

const sections=[
  {key:'report',title:'经营月报',labels:{missing:'待填写',pending:'总部审核中',finance:'财务复核中',returned:'待我修改',approved:'已通过',revoked:'已撤销',exempt:'已免报',exemption_pending:'免报待审核',not_required:'本月无需报送'}},
  {key:'location',title:'位置核验',labels:{missing:'待提交位置资料',pending:'等待总部核验',approved:'位置已核验',exception:'位置待核实',not_required:'本月无需核验'}},
  {key:'fee',title:'咨询服务费',labels:{missing:'暂无账单',unpaid:'待支付',partially_paid:'部分支付',paid:'已支付',settled_zero:'已结清',reversed:'已冲正',mixed:'账单状态不同，请查看账单'}}
];
const settlementLabels={settled:'已结算',unsettled:'尚未结算'};

function outletSummaryRows(summary){
  return sections.flatMap(({key,title,labels})=>{
    const record=summary?.[key];
    const monthText=labelMonth(record?.month);
    if(!monthText)return [];
    const settlement=key==='report'?settlementLabels[record.settlementStatus]:'';
    return [{key,title,monthText,statusText:[labels[record.status]||'暂不可查看',settlement].filter(Boolean).join(' · ')}];
  });
}

function outletSummaryStatus(key,status){
  return sections.find(section=>section.key===key)?.labels[status];
}

module.exports={outletSummaryRows,outletSummaryStatus};
