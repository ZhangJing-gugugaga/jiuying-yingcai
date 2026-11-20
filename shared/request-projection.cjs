'use strict';

const {safeNote}=require('./audit-redaction.cjs');
const base=['id','outlet','owner','status','createdAt','type','policyPending'];
const submittedFields={
 newOutlet:['name','countryCode','province','city','district','address','phone','opening','note','locationStatus','createdOutletId'],
 locationChange:['address','reason','locationStatus'],
 pauseFee:['from','to','reason'],
 statusChange:['status','effectiveDate','reason'],
 enrollment:['applicable','reason'],
 exemptException:['month','reason'],
 accountChange:['change','managerName','mobile','reason'],
 reportRevoke:['reportId','month','version']
};
const financial=new Set(['pauseFee','exemptException','reportRevoke']);
const reviewActions=new Set(['review.request','review.revoke','location.review']);

function pick(row,keys){
 return Object.fromEntries(keys.filter(key=>Object.hasOwn(row||{},key)).map(key=>[key,structuredClone(row[key])]));
}
function defaultNote(row){
 if(row.type==='reportRevoke')return ({pending:'撤销申请待复核，当前月报仍有效。',approved:'原月报审批已撤销，请查看月报版本。',returned:'复核保留原有效月报。'})[row.status]||'请查看月报版本。';
 if(row.policyPending===true&&row.status==='approved')return '待集团确认生效规则，原数据未改变。';
 if(row.type==='accountChange'&&row.status==='approved'){
  if(row.identityChanged===false)return '账号登记信息未变化。';
  if(row.data?.change==='mobile')return '登记手机号已更新，请重新激活账号。';
  return '负责人绑定已更新，新负责人须重新激活。';
 }
 return ({approved:'申请已通过。',returned:'申请已退回，可查看说明后重新提交。',supplement:'请核对申请资料后补充提交。',pending:'申请已提交，请关注处理进度。'})[row.status]||'申请状态已更新。';
}
function canReadReviewNote(actor,author){
 return actor==='manager'||actor===author;
}
function reviewNote(row,actor,roles){
 const visible=role=>canReadReviewNote(actor,role)&&(!roles||roles.includes(role));
 const entries=(row.trail||[]).filter(item=>reviewActions.has(item.action));
 const latest=entries.at(-1);
 const author=row.reviewRole||latest?.actor||(row.type==='reportRevoke'?'finance':null);
 const note=visible(author)&&row.reviewNote||entries.findLast(item=>visible(item.actor))?.note;
 return note?safeNote(note):undefined;
}
function projectRequest(row,actor,owner){
 const data=pick(row.data,(submittedFields[row.type]||[]).filter(key=>row.data?.[key]===null||['string','number','boolean'].includes(typeof row.data?.[key])));
 const isLocation=['newOutlet','locationChange'].includes(row.type);
 if(isLocation&&(owner||['manager','location'].includes(actor))){
  if(row.data?.coords)data.coords=pick(row.data.coords,['lat','lng','source','coordinateSystem','accuracy']);
  if(row.data?.photo)data.photo=pick(row.data.photo,['id','name','type','size','url']);
 }
 const common={...pick(row,base),data,publicNote:row.publicNote||defaultNote(row)};
 if(owner)return common;
 if(actor==='manager'){
  Object.assign(common,pick(row,['outcome','policy','initiator','trail']));
  Object.assign(data,pick(row.data,['evidenceReference','locationReviewedBy','locationReviewedAt','originalValues']));
  if(row.type==='reportRevoke')Object.assign(data,pick(row.data,['reason']));
 }else if(actor==='finance'&&financial.has(row.type)){
  Object.assign(data,pick(row.data,['originalValues']));
  if(row.type==='reportRevoke')Object.assign(data,pick(row.data,['reason']));
 }else if(actor==='location'&&isLocation)Object.assign(data,pick(row.data,['locationReviewedBy','locationReviewedAt']));
 const visibleReview=reviewNote(row,actor),financeNote=reviewNote(row,actor,['finance']);
 const internalNote=reviewNote(row,actor,['ops','manager','location']);
 if(visibleReview)common.reviewNote=visibleReview;
 if(financeNote)common.financeReviewNote=financeNote;
 if(internalNote)common.internalReviewNote=internalNote;
 return common;
}
function setPublicNote(row,value,check,label='申请人可见说明'){
 if(value==null||value===''){delete row.publicNote;return;}
 check(typeof value==='string'&&value.trim().length>0&&value.length<=800,'INPUT',label+'须1—800字');
 row.publicNote=safeNote(value);
}
const locationStatus={pending:'已提交，等待总部核验',approved:'位置已核验',exception:'位置待核实，请补充说明'};
const legacyLocationStatus={'位置资料待专员核验':'pending','位置核验通过':'approved','位置异常，请解释补件':'exception'};
function verificationNotice(message){
 const snapshot=message.verificationOutcome;
 const status=snapshot?.status||legacyLocationStatus[message.title];
 const view=pick(message,['id','outlet','owner','status','createdAt','target','read','recordId','taskId','month']);
 view.title=locationStatus[status]||'位置核验状态已更新';
 view.body=typeof snapshot?.publicNote==='string'&&snapshot.publicNote?snapshot.publicNote:
  status==='exception'?'请补充实际经营地址或现场证明。':'请查看该次核验记录。';
 return view;
}
function requestNotice(message,row){
 if(!row&&message.target==='location'&&message.recordId?.startsWith('loc-'))return verificationNotice(message);
 if(!row&&message.target==='reports'&&message.title==='收入更正待财务复核')return {...structuredClone(message),title:'财务复核中'};
 if(!row&&message.target!=='requests'&&!(message.target==='location'&&message.recordId?.startsWith('req-')))return structuredClone(message);
 const view=pick(message,['id','outlet','owner','status','createdAt','target','read','recordId','taskId','reportId','month']);
 const submitted=message.title==='申请已提交';
 const recorded=message.requestOutcome;
 const legacyStatus=({'总部已发起撤销复核':'pending','总部已撤销月报审批':'approved','总部保留原有效月报':'returned','位置异常，请解释补件':'supplement','申请处理结果：approved':'approved','申请处理结果：returned':'returned','申请处理结果：supplement':'supplement'})[message.title];
 const status=typeof recorded?.status==='string'?recorded.status:legacyStatus;
 const safeSnapshot=row&&status?{...row,status}:row;
 const knownTitles=['总部已发起撤销复核','总部已撤销月报审批','总部保留原有效月报','位置核验通过','位置异常，请解释补件'];
 view.title=submitted?'申请已提交':knownTitles.includes(message.title)?message.title:'业务申请处理进度已更新';
 view.body=submitted?'申请已提交，请关注处理进度。':recorded&&typeof recorded.publicNote==='string'?recorded.publicNote:message.title==='位置核验通过'?'位置核验通过，申请进入后续处理。':safeSnapshot?defaultNote(safeSnapshot):'请打开业务申请查看处理进度。';
 return view;
}

module.exports={projectRequest,setPublicNote,defaultNote,requestNotice,canReadReviewNote};
