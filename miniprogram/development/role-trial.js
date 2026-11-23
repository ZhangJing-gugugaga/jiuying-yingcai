const config=require('../config');
const api=require('../utils/api');
const key='jyyc.roleTrialIdentity';
const enabled=config.development===true&&config.roleTrial===true;

function mode(){
  const stored=wx.getStorageSync(key);
  return stored?.base===config.apiBase?stored.mode:'';
}

async function enter(identity){
  const current=api.session();
  const stored=wx.getStorageSync(key);
  if(stored?.base===config.apiBase&&stored.mode===identity&&stored.subject===current?.subject&&
    Date.parse(current?.expiresAt)>Date.now())return current;
  const session=await (identity==='applicant'?api.trialApplicant():api.login('partnerA'));
  wx.setStorageSync(key,{base:config.apiBase,mode:identity,subject:session.subject});
  return session;
}

function rememberMember(session){
  if(enabled&&session?.role==='partner'){
    wx.setStorageSync(key,{base:config.apiBase,mode:'authenticated',subject:session.subject});
  }
}

function resume(){
  const selected=mode();
  if(selected==='authenticated')return api.session();
  return enter(selected||'partner');
}

module.exports={enabled,mode,enter,rememberMember,resume};
