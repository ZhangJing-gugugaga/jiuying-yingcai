const {define,openRecord,canOpenRecord,api,fmt}=require('../../utils/page');

function taskTitle(row,month){
  switch(row.kind){
    case 'report_missing':return '请填写'+month+'经营月报';
    case 'report_returned':return '请修改'+month+'经营月报';
    case 'location_missing':return '请提交网点位置核验资料';
    case 'location_exception':return '请补充网点位置核验资料';
    case 'request_supplement':return row.outlet?'请补充业务申请材料':'请补充新增网点申请材料';
    case 'bill_unpaid':
    case 'bill_overdue':return '请查看咨询服务费账单';
    case 'support_waiting':return row.businessType==='supportChats'?'请补充咨询资料':'请补充客服工单资料';
    case 'training_material_returned':return '请补充学员培训资料';
    default:return row.typeText;
  }
}

Page(define({
  collections:[{name:'businessTasks',filters(){return {status:this.data.status};}}],
  data:{status:'open',taskRows:[]},
  async loaded(s){
    const id=this.query.id;
    const serial=this._serial;
    let tasks=s.businessTasks;
    if(id&&!tasks.some(row=>row.id===id)){
      const row=await api.detail('businessTasks',id);
      if(serial!==this._serial||id!==this.query.id)return;
      tasks=fmt.decorate({businessTasks:[row,...tasks]}).businessTasks;
      this.setData({'state.businessTasks':tasks});
    }
    this.setData({taskRows:tasks.map(row=>{
      const month=fmt.monthText(row.month);
      return {
        id:row.id,title:taskTitle(row,month),outletName:row.outletName!==row.outlet&&row.outlet?row.outletName:'',
        month,notifiedText:fmt.timeText(row.createdAt),dueText:fmt.dateText(row.dueAt)||fmt.dateText(row.dueOn),
        statusText:fmt.label(row.status,'task'),statusTone:fmt.statusTone(row.status,'task'),
        completed:row.status==='resolved'||row.status==='completed',canOpen:canOpenRecord(row)
      };
    })});
  },
  async status(e){
    this.query.id='';
    this.setData({status:e.currentTarget.dataset.status});
    await this.refresh();
  },
  async open(e){
    try{
      const row=this.data.state.businessTasks.find(x=>x.id===e.currentTarget.dataset.id);
      if(row)await openRecord(row);
    }catch(error){this.setData({error:error.message});}
  }
}));
