// Excluded physically from test/production environment builds.
const api=require('../utils/api');
module.exports={data:{actor:'partnerA',customActor:'',choices:[{id:'partnerA',name:'加盟商甲 · 多网点负责人'},{id:'partnerB',name:'加盟商乙 · 独立主体'},{id:'public',name:'消费者 · 公开网点与客服'}],index:0},handlers:{select(e){this.setData({index:Number(e.detail.value),actor:this.data.choices[Number(e.detail.value)].id});},customActor(e){this.setData({customActor:e.detail.value});},async enter(){await this.run(()=>api.login(this.data.customActor.trim()||this.data.actor));}}};
