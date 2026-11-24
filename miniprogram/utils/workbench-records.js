const {api,fmt,openRecord}=require('./page');

const types={
  report:{label:'经营月报',icon:'task',tone:'blue',target:'reports'},
  support:{label:'客服工单',icon:'service',tone:'violet',target:'support'},
  training:{label:'培训登记',icon:'education',tone:'green',target:'training'}
};
const trainingStatus={
  in_progress:['学习中','blue'],submitted:['审核中','blue'],returned:['需补件','amber'],
  materials_approved:['资料已通过','green'],completed:['已完成','green']
};
const tones={ok:'green',wait:'blue',red:'red',gray:'gray'};

function loadBusinessRecords(outlet,limit,offset,page){
  return api.request('/api/workbench/records?'+api.query({outlet,limit,offset}),'GET',undefined,{},false,page);
}

function businessRecord(record){
  const type=types[record.kind];
  const subject=record.kind==='report'?fmt.monthText(record.month):record.title;
  const [status,statusTone]=record.kind==='training'?(trainingStatus[record.status]||['状态暂不可查看','gray']):
    [fmt.label(record.status,type.target==='reports'?'report':'support'),tones[fmt.statusTone(record.status,record.kind)]||'gray'];
  const icon=record.kind==='report'&&record.status==='approved'?'task-checked':type.icon;
  return {...record,rowKey:record.kind+':'+record.id,icon,tone:type.tone,statusText:status,statusTone,
    displayTitle:[type.label,subject].filter(Boolean).join(' · '),timeText:fmt.timeText(record.occurredAt)};
}

function openBusinessRecord(record,options){
  if(!record||!Object.hasOwn(types,record.kind))return false;
  const {kind,id,outlet,month}=record;
  return openRecord({id,recordId:id,outlet,month,target:types[kind].target},options);
}

module.exports={loadBusinessRecords,businessRecord,openBusinessRecord};
