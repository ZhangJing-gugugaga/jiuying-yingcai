const config=require('../config');
const {reLaunch,memberLoginUrl}=require('./navigation');
const {clear:clearReportRecovery}=require('./report-recovery');
const {clearAll:clearBusinessDrafts}=require('./business-drafts');
const {track,trackCommand}=require('./track');
const pending=new Map();
const activeReads=new Map();
const pageIds=new WeakMap();
let nextPageId=0;
const genericError='操作未成功，请稍后重试；如问题持续，请联系总部客服。';
const publicErrorVariants={
 INPUT:new Set(['请填写营业收入。','请输入登录名和密码','请输入有效手机号','请先上传现场照片','仅支持PNG/JPEG/WebP图片','附件须在5MB内','请重新选择照片后上传','工单最多可添加 3 张不同的图片','请使用原工单涉及的网点重新提交','评价为1—5分','不能核验未来月份','结束不得早于开始','招生不适用不能改值','请选择单字段更正或整份月报更正。','请填写单行学员姓名或培训编号',
  '申请人姓名格式无效','加盟主体格式无效','手机号格式无效','申请说明格式无效','请填写有效的手机号']),
 CONFLICT:new Set(['线下实收正在核验，请先完成核验','费用调整待核算，暂不可付款','该账单已有待确认支付订单','该支付尝试已结束，请刷新账单','账单不是待支付状态或已有实收','仅已核验的实收凭证可办理退款或开票','退款金额超出可退余额','请先申请更正有效版本','当前有效版本已变化，请重新发起核实','负责人身份已变化，请重新登录','密码已变更，请重新登录',
  '收款信息已更新，请重新核对后提交','该手机号已有加盟申请或账号，请联系总部核实','这张凭证已用于另一笔申请，请核对',
  '加盟申请暂未开放','原申请状态已更新，请重新查看']),
 INVALID_CREDENTIALS:new Set(['当前密码不正确','当前个人账号密码不正确','登录名或密码不正确','凭证已变化，请重新登录']),
 DUPLICATE:new Set(['已有待审核版本']),
};
function errorText(error={}){
 const {code,status}=error;
 const known={
  NETWORK:'网络连接失败，请检查网络后重试。',
  TIMEOUT:'本次连接超时，请检查网络后重试。',
  UNAUTHENTICATED:'登录已失效，请重新登录。',
  REAL_ADAPTER_UNAVAILABLE:'此服务暂未开放，请联系总部。',
  MOCK_DISABLED:'此服务暂未开放，请联系总部。',
  PAY_MERCHANT_MAPPING:'当前账单暂不可在线支付，请联系总部。',
  PAY_MERCHANT_MISMATCH:'当前账单暂不可在线支付，请联系总部。',
  PAY_CONTRACT_MISMATCH:'当前账单暂不可在线支付，请联系总部。',
  PAY_SIGNATURE:'正在确认支付结果，请稍后刷新。',
  PAY_PROVIDER_UNAVAILABLE:'正在确认支付结果，请稍后刷新。',
  PAY_PROVIDER_REJECTED:'正在确认支付结果，请稍后刷新。',
  PAY_RESPONSE:'正在确认支付结果，请稍后刷新。',
  PAY_MISMATCH:'付款结果有待核实，请联系总部。',
  PAY_BUSY:'正在确认支付结果，请稍后刷新。',
  RATE_LIMIT:'操作过于频繁，请稍后重试。',
  INVALID_CODE:'验证码无效或已过期，请重新获取。',
  INVALID_CREDENTIALS:'账号验证失败，请核对后重试。',
  ACTIVATION_INVALID:'激活码无效或已使用，请联系总部重新领取。',
  WECHAT_UNBOUND:'该微信尚未绑定，请先使用其他已开通的方式登录并完成绑定。',
  IDENTITY_BOUND:'该微信已绑定其他账号，请联系总部核实。',
  GPS_REQUIRED:'请在网点现场重新获取定位，再提交核验。',
  INVALID_IMAGE:'无法读取此照片，请换一张清晰的照片后重试。',
  UPLOAD_BUSY:'照片处理繁忙，请稍后再试。',
  ATTACHMENT_IN_USE:'此照片已随另一工单提交，请重新选择。',
  PAYLOAD_TOO_LARGE:'提交内容超过大小限制。照片请更换为 5 MB 以内的图片。',
 };
 const message=typeof error.message==='string'?error.message.trim():'';
 if(status>=400&&status<500&&Object.hasOwn(publicErrorVariants,code)&&publicErrorVariants[code].has(message))return message;
 if(Object.hasOwn(known,code))return known[code];
 if(status===403)return '当前账号暂无权限查看此内容。';
 if(status===404)return '该记录可能已更新，请刷新后查看最新状态。';
 if(status>=500)return '暂时无法获取信息，请稍后重试。';
 return genericError;
}

function session(){return wx.getStorageSync('jyyc.session')||null;}
function clearLocalDrafts(){clearReportRecovery();clearBusinessDrafts();}
function expireSession(token,stayPublic=false){
  const current=session();
  if(!token||current?.token!==token)return;
  pending.clear();
  wx.removeStorageSync('jyyc.session');
  clearLocalDrafts();
  if(current.role==='public'||stayPublic)return;
  const page=typeof getCurrentPages==='function'?getCurrentPages().at(-1):null;
  const route=/^pages\/([^/]+)\/index$/.exec(page?.route||'')?.[1];
  // Strip transient values. Navigation validates all destination parameters.
  const query=Object.fromEntries(Object.entries(page?.query||{}).filter(([,value])=>typeof value==='string'&&value));
  const login=memberLoginUrl(route,query);
  reLaunch(login+(login.includes('?')?'&':'?')+'reason=session-expired');
}
function base(){if(!config.apiBase)throw new Error('暂时无法获取信息，请稍后重试。');if((!config.development||config.target==='device')&&(!/^https:\/\//.test(config.apiBase)||/^https:\/\/(localhost|127\.|0\.|\[::1\])/.test(config.apiBase)))throw new Error('暂时无法获取信息，请稍后重试。');return config.apiBase;}
function key(){return 'wx-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);}
const guestReadPath=/^\/api\/(?:context|state|config|onboarding\/(?:config|applications)|collections\/(?:outlets|publicContents|faqEntries)(?:\/[^?]*)?)(?:\?|$)/;
const sharedReadPath=/^\/api\/(?:context|config|collections\/[^?]+|dashboard|tasks)(?:\?|$)/;
const activePage=()=>typeof getCurrentPages==='function'?getCurrentPages().at(-1):null;
function publicReadView(path,page){
  const route=/^pages\/([^/]+)\/index$/.exec(page?.route||'')?.[1];
  if(path.startsWith('/api/collections/outlets')&&!/[?&]scope=public(?:&|$)/.test(path))return false;
  return route==='service-detail'||(route==='discover'&&page.data?.section!=='cooperation'&&page.query?.section!=='cooperation')||
    (['home','outlets','outlet'].includes(route)&&page.query?.scope==='public');
}
function ownsForeground(page,serial){
  const foreground=activePage();
  return !page||(!foreground||foreground===page)&&serial===page._serial;
}
async function request(path,method='GET',data,headers={},retryGuest=true,page=activePage()){
  const credential=session();
  const usesSession=!Object.hasOwn(headers,'Authorization');
  const canRenewGuest=retryGuest&&method==='GET'&&guestReadPath.test(path)&&usesSession&&
    (credential?.role==='public'||publicReadView(path,page));
  const origin={page,serial:page?._serial,credential,usesSession,canRenewGuest};
  const send=()=>sendRequest(path,method,data,headers,origin);
  if(method!=='GET'||!sharedReadPath.test(path))return send();
  if(page&&!pageIds.has(page))pageIds.set(page,++nextPageId);
  const identity=JSON.stringify([base(),credential?.token,path,data,headers,page&&pageIds.get(page),origin.serial,canRenewGuest]);
  const current=activeReads.get(identity);
  if(current)return current;
  if(activeReads.size>=32)return send();
  const sent=send();
  activeReads.set(identity,sent);
  const clear=()=>{if(activeReads.get(identity)===sent)activeReads.delete(identity);};
  sent.then(clear,clear);
  return sent;
}
function sendRequest(path,method,data,headers,{page,serial,credential:s,usesSession,canRenewGuest}){
  return new Promise((resolve,reject)=>{
    const url=base()+path;
    const networkFailure=error=>{
      // Keep the same retry identity when a write times out after reaching the server.
      const timeout=/timeout|timed out/i.test(error?.errMsg||error?.message||'');
      reject(Object.assign(new Error(errorText({code:timeout?'TIMEOUT':'NETWORK'})),{code:'NETWORK',timeout}));
    };
    try{
      wx.request({
        url,method,data,timeout:15000,header:{'Content-Type':'application/json',...(s?{Authorization:'Bearer '+s.token}:{}),...headers},
        success(response){
          const {statusCode:status,data:raw}=response;
          const body=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
          if(status>=200&&status<300&&!body.error){
            if(method==='GET'&&usesSession&&s?.token&&s.token!==session()?.token){
              return reject(Object.assign(new Error('登录状态已变化，请刷新后查看。'),{code:'SESSION_CHANGED',requestId:body.requestId}));
            }
            if(Object.hasOwn(body,'data'))return resolve(body.data);
            return reject(Object.assign(new Error(genericError),{code:'INVALID_RESPONSE',status,requestId:body.requestId}));
          }
          const expired=status===401&&body.error?.code==='UNAUTHENTICATED';
          const canHandleExpiry=expired&&usesSession&&ownsForeground(page,serial);
          if(canHandleExpiry&&path!=='/api/auth/logout')expireSession(s?.token,canRenewGuest);
          const code=body.error?.code;
          const message=expired&&(s?.role==='public'||canRenewGuest)?'本次浏览已失效，请刷新页面后重试。':errorText({message:body.error?.message,code,status});
          const error=Object.assign(new Error(message),{code:code||'HTTP_'+status,status,requestId:body.requestId});
          if(canHandleExpiry&&canRenewGuest){
            return ensureVisitor().then(renewed=>{
              if(renewed.role!=='public'||session()?.token!==renewed.token||!ownsForeground(page,serial))throw error;
              return request(path,method,data,headers,false,page);
            }).then(resolve,reject);
          }
          reject(error);
        },
        fail:networkFailure,
      });
    }catch{
      networkFailure();
    }
  });
}
/* DEV_ONLY_START */
async function login(actor){if(!config.development)throw new Error('正式认证尚未配置');const s=await request('/api/auth/dev','POST',{actor});clearLocalDrafts();wx.setStorageSync('jyyc.session',s);pending.clear();return s;}
/* DEV_ONLY_END */
async function command(command,payload,{retryKey}={}){
  const identity=session()?.token||'',fingerprint=JSON.stringify([identity,command,payload]);
  const id=retryKey||pending.get(fingerprint)||key();pending.set(fingerprint,id);
  try{const result=await request('/api/commands','POST',{command,payload},{'Idempotency-Key':id});pending.delete(fingerprint);trackCommand(command,result);return result;}
  catch(e){if(e.status>=400&&e.status<500)pending.delete(fingerprint);throw e;}
}
async function logout({navigate=true,token=session()?.token}={}){
  if(session()?.token!==token)return {loggedOut:false,cleared:false};
  let loggedOut=false;
  try{
    if(token)loggedOut=(await request('/api/auth/logout','POST',{}, {Authorization:'Bearer '+token})).loggedOut===true;
  }catch{
    if(navigate&&session()?.token===token)wx.showToast?.({title:'已退出此设备。',icon:'none'});
  }
  if(session()?.token!==token)return {loggedOut,cleared:false};
  pending.clear();
  wx.removeStorageSync('jyyc.session');
  clearLocalDrafts();
  if(navigate)reLaunch('/pages/login/index');
  return {loggedOut,cleared:true};
}
function query(values){return Object.keys(values).filter(k=>values[k]!==undefined&&values[k]!==null&&values[k]!=='').map(k=>encodeURIComponent(k)+'='+encodeURIComponent(values[k])).join('&');}
function sendPhoto(filePath,fields,onProgress){
  const token=session()?.token;
  return new Promise((resolve,reject)=>{
    const task=wx.uploadFile({
      url:base()+'/api/files',filePath,name:'file',formData:fields,timeout:30000,
      header:token?{Authorization:'Bearer '+token}:{},
      success(response){
        const {statusCode:status}=response;
        let body;
        try{body=JSON.parse(response.data);}catch{return reject(new Error('上传结果暂时无法确认，请重新选择照片。'));}
        if(status===401&&body?.error?.code==='UNAUTHENTICATED')expireSession(token);
        if(status>=200&&status<300&&body?.data?.id)return resolve(body.data);
        const code=body?.error?.code;
        reject(Object.assign(new Error(errorText({status,code,message:body?.error?.message})),{status,code,requestId:body?.requestId}));
      },
      fail:()=>reject(new Error('照片上传中断，请检查网络后重试。')),
    });
    if(typeof onProgress==='function')task?.onProgressUpdate?.(({progress})=>{
      if(Number.isFinite(progress))onProgress(Math.max(0,Math.min(100,Math.round(progress))));
    });
  });
}
function readPhoto(filePath){
  return new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath,encoding:'base64',
    success:result=>resolve(result.data),fail:()=>reject(new Error('照片读取失败，请重新选择'))}));
}
async function uploadPhoto({purpose,onProgress,sourceType=['camera','album'],applicationId,applicationVersion,selected}={}){
  const start=session()?.token;
  const proof=purpose==='onboarding-proof';
  const photo=selected||await new Promise((resolve,reject)=>{
    const fail=()=>reject(new Error(proof?'未选择付款截图，请检查相册权限后重试。':'未选择照片，相机或相册权限可能未授权。'));
    if(proof&&typeof wx.chooseImage==='function'){
      wx.chooseImage({count:1,sourceType:['album'],sizeType:['original'],success:selection=>{
        const selected=selection.tempFiles?.[0];
        resolve({tempFilePath:selected?.path||selection.tempFilePaths?.[0],size:selected?.size});
      },fail});
    }else{
      wx.chooseMedia({count:1,mediaType:['image'],sourceType,sizeType:[proof?'original':'compressed'],
        success:selection=>resolve(selection.tempFiles?.[0]),fail});
    }
  });
  if(!photo?.tempFilePath||photo.size>5*1024*1024)throw new Error('请使用5MB以内的照片。');
  if(session()?.token!==start)throw new Error('账号已切换，请重新选择照片。');
  const format=photo.type=== 'image/png'?'png':/\.(png|webp)(?:\?|$)/i.exec(photo.tempFilePath)?.[1].toLowerCase()||'jpeg';
  const label=purpose==='support-ticket'?'工单照片':purpose==='onboarding-proof'?'付款凭证':'现场照片';
  const fields={name:label+'.'+(format==='jpeg'?'jpg':format),type:'image/'+format,...(purpose?{purpose}:{})};
  const target=applicationId?{applicationId,applicationVersion}:{};
  let file;
  if(typeof wx.uploadFile==='function'){
    file=await sendPhoto(photo.tempFilePath,{...fields,...(applicationId?{...target,applicationVersion:String(applicationVersion)}:{})},onProgress);
  }else{
    const base64=await readPhoto(photo.tempFilePath);
    if(session()?.token!==start)throw new Error('账号已切换，请重新选择照片。');
    file=await request('/api/files','POST',{...fields,...target,base64});
  }
  if(session()?.token!==start)throw new Error('账号已切换，无法使用这张照片。');
  return {file,preview:photo.tempFilePath};
}
function locate(manual=false){return new Promise((resolve,reject)=>{
  const success=r=>{
    const {latitude,longitude,accuracy}=r;
    if(!Number.isFinite(latitude)||Math.abs(latitude)>90||!Number.isFinite(longitude)||Math.abs(longitude)>180||
       (!manual&&accuracy!=null&&(!Number.isFinite(accuracy)||accuracy<0)))return reject(new Error('定位坐标或精度无效，请重试'));
    resolve({coords:{lat:latitude,lng:longitude,source:manual?'manual':'gps',coordinateSystem:'GCJ-02',accuracy:manual?null:accuracy??null,capturedAt:new Date().toISOString()},address:r.address||r.name||''});
  };
  const fail=()=>reject(new Error(manual?'地图选点未完成，请检查位置权限或重试':'未获得定位。请检查位置权限，或主动选择地图位置。'));
  if(manual)wx.chooseLocation({success,fail});else wx.getLocation({type:'gcj02',isHighAccuracy:true,success,fail});
});}
function download(path,{publishedCover=false}={},page=activePage(),retryGuest=true){return new Promise((resolve,reject)=>{
  const token=session()?.token;
  const serial=page?._serial;
  const publicFile=publishedCover&&/^\/api\/files\/file-[a-z0-9-]+$/i.test(path);
  wx.downloadFile({url:base()+path,header:{Authorization:'Bearer '+token},timeout:15000,success:r=>{
    if(r.statusCode===401){
      const error=new Error(publicFile?'封面暂时无法加载，请稍后重试。':'登录已失效，请重新登录。');
      if(!ownsForeground(page,serial))return reject(error);
      expireSession(token,publicFile);
      if(publicFile&&retryGuest)return ensureVisitor().then(renewed=>{
        if(renewed.role!=='public'||!ownsForeground(page,serial))throw error;
        return download(path,{publishedCover},page,false);
      }).then(resolve,reject);
      return reject(error);
    }
    if(r.statusCode!==200)return reject(Object.assign(new Error('文件下载失败'),{status:r.statusCode}));
    resolve(r.tempFilePath);
  },fail:()=>reject(new Error('下载中断，请重试'))});
});}
async function authenticate(path,data){const s=await request(path,'POST',data);if(!s?.token)throw new Error('暂时无法登录，请稍后重试。');clearLocalDrafts();wx.setStorageSync('jyyc.session',s);pending.clear();return s;}
const passwordLogin=(username,password)=>authenticate('/api/auth/password',{username,password});
const activate=(token,password)=>authenticate('/api/auth/activate',{token,password});
const visitor=()=>authenticate('/api/auth/visitor',{});
let visitorRequest;
function ensureVisitor() {
 const current = session();
 if (current) return Promise.resolve(current);
 if (!visitorRequest) {
  visitorRequest = request('/api/auth/visitor', 'POST', {}).then(result => {
   if (result?.role !== 'public' || !result.token) throw new Error('暂时无法浏览，请稍后重试。');
   const signedIn = session();
   if (signedIn) return signedIn;
   wx.setStorageSync('jyyc.session', result);
   return result;
  }).finally(() => { visitorRequest = null; });
 }
 return visitorRequest;
}
function collectionPath(name){
 return name==='businessTasks'&&session()?.role==='partner'?'/api/tasks':'/api/collections/'+encodeURIComponent(name);
}
async function collection(name,values={},page){const path=collectionPath(name);const filters=path==='/api/tasks'?{status:'all',...values,queue:'partner'}:values;const data=await request(path+'?'+query(filters),'GET',undefined,{},true,page);if(!Array.isArray(data?.items)||!Number.isInteger(data.total)||!Number.isInteger(data.offset)||typeof data.hasMore!=='boolean')throw new Error('暂时无法获取信息，请稍后重试。');return data;}
const detail=(name,id,filters={})=>{
  const suffix=query(filters);
  return request(collectionPath(name)+'/'+encodeURIComponent(id)+(suffix?'?'+suffix:''));
};
async function openDocument(path,fileType){if(!['xlsx','pdf'].includes(fileType))throw new Error('不支持的文件格式');const filePath=await download(path);await new Promise((resolve,reject)=>wx.openDocument({filePath,fileType,showMenu:true,success:resolve,fail:()=>reject(new Error('文档打开失败，请重试或检查微信版本'))}));return filePath;}
module.exports={session,base,request,passwordLogin,activate,visitor,ensureVisitor,collection,detail,command,newCommandKey:key,logout,query,uploadPhoto,locate,download,openDocument,errorText};

/* DEV_ONLY_START */
module.exports.login=login;
module.exports.trialApplicant=()=>authenticate('/api/role-trial/applicant',{});
/* DEV_ONLY_END */
function wxCode(){return new Promise((resolve,reject)=>wx.login({timeout:15000,success:r=>r.code?resolve(r.code):reject(new Error('微信登录未完成，请重试。')),fail:()=>reject(new Error('微信登录失败，请检查网络后重试'))}));}
async function wechatLogin(){return authenticate('/api/auth/wechat',{code:await wxCode()});}
async function bindWechat(){return request('/api/auth/wechat/bind','POST',{code:await wxCode()});}
const sendSms=mobile=>request('/api/auth/sms/send','POST',{mobile,purpose:'login'});
const verifySms=(challengeId,mobile,code)=>authenticate('/api/auth/sms/verify',{challengeId,mobile,code});
async function prepay(billId,options={}){const fingerprint=JSON.stringify([session()?.token,'payment-prepay',billId,options]),id=pending.get(fingerprint)||key();pending.set(fingerprint,id);try{const r=await request('/api/payments/prepay','POST',{billId,...options},{'Idempotency-Key':id});pending.delete(fingerprint);track('bill_pay','started');return r;}catch(e){if(e.status>=400&&e.status<500)pending.delete(fingerprint);throw e;}}
const queryPayment=id=>request('/api/payments/'+encodeURIComponent(id)+'/query','POST',{});
Object.assign(module.exports,{wxCode,wechatLogin,bindWechat,sendSms,verifySms,prepay,queryPayment});
/* DEV_ONLY_START */
module.exports.simulatePayment=(id,outcome)=>request('/api/payments/'+encodeURIComponent(id)+'/simulate','POST',{outcome});
/* DEV_ONLY_END */

const closePayment=id=>request('/api/payments/'+encodeURIComponent(id)+'/close','POST',{});
function privacyContract(){return new Promise((resolve,reject)=>{if(typeof wx.openPrivacyContract!=='function')return reject(new Error('当前微信版本不支持隐私指引，请更新微信或联系总部'));wx.openPrivacyContract({success:resolve,fail:()=>reject(new Error('隐私保护指引暂不可查看，请联系总部。'))});});}
Object.assign(module.exports,{closePayment,privacyContract});
