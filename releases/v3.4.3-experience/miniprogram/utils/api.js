const config=require('../config');
const {reLaunch}=require('./navigation');
const pending=new Map();
const genericError='操作未成功，请稍后重试；如问题持续，请联系总部客服。';
function errorText(error={}){
 const {code,status}=error;
 const known={
  NETWORK:'网络连接失败，请检查网络后重试。',
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
  RATE_LIMIT:'操作过于频繁，请稍后重试。'
 };
 if(Object.hasOwn(known,code))return known[code];
 if(status===403)return '当前账号暂无权限查看此内容。';
 if(status===404)return '该记录可能已更新，请刷新后查看最新状态。';
 if(status>=500)return '暂时无法获取信息，请稍后重试。';
 const message=typeof error.message==='string'?error.message.trim():'';
 const internal=/(?:[a-z][a-z0-9]*[_-][a-z0-9_-]+|\b(?:API|Mock|SDK|MCP|Token|SQL(?:ite)?|JSON|HTTPS?|GCJ|RSA|Adapter|Session|localhost|loopback|idempotency|requestId|id)\b|适配器|接口未配置|服务端配置|错误码|测试参数|岗位编码|令牌|会话|签名|证书)/i;
 if(status>=400&&status<500&&message.length<=180&&/[\u3400-\u9fff]/.test(message)&&!internal.test(message)&&!/\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/.test(message)
  &&!/[\r\n<>]/.test(message))return message;
 return genericError;
}

function session(){return wx.getStorageSync('jyyc.session')||null;}
function expireSession(token){
  if(!token||session()?.token!==token)return;
  pending.clear();
  wx.removeStorageSync('jyyc.session');
  reLaunch('/pages/login/index');
}
function base(){if(!config.apiBase)throw new Error('暂时无法获取信息，请稍后重试。');if((!config.development||config.target==='device')&&(!/^https:\/\//.test(config.apiBase)||/^https:\/\/(localhost|127\.|0\.|\[::1\])/.test(config.apiBase)))throw new Error('暂时无法获取信息，请稍后重试。');return config.apiBase;}
function key(){return 'wx-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);}
function request(path,method='GET',data,headers={}){
  return new Promise((resolve,reject)=>{
    const s=session(),url=base()+path;
    const networkFailure=()=>reject(Object.assign(new Error(errorText({code:'NETWORK'})),{code:'NETWORK'}));
    try{
      wx.request({
        url,method,data,timeout:15000,header:{'Content-Type':'application/json',...(s?{Authorization:'Bearer '+s.token}:{}),...headers},
        success(response){
          const {statusCode:status,data:raw}=response;
          const body=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
          if(status>=200&&status<300&&!body.error){
            if(Object.hasOwn(body,'data'))return resolve(body.data);
            return reject(Object.assign(new Error(genericError),{code:'INVALID_RESPONSE',status,requestId:body.requestId}));
          }
          if(status===401&&body.error?.code==='UNAUTHENTICATED'&&path!=='/api/auth/logout')expireSession(s?.token);
          const code=body.error?.code;
          const error=new Error(errorText({message:body.error?.message,code,status}));
          reject(Object.assign(error,{code:code||'HTTP_'+status,status,requestId:body.requestId}));
        },
        fail:networkFailure,
      });
    }catch{
      networkFailure();
    }
  });
}
/* DEV_ONLY_START */
async function login(actor){if(!config.development)throw new Error('正式认证尚未配置');const s=await request('/api/auth/dev','POST',{actor});wx.setStorageSync('jyyc.session',s);pending.clear();return s;}
/* DEV_ONLY_END */
async function command(command,payload){
  const identity=session()?.token||'',fingerprint=JSON.stringify([identity,command,payload]);
  const id=pending.get(fingerprint)||key();pending.set(fingerprint,id);
  try{const result=await request('/api/commands','POST',{command,payload},{'Idempotency-Key':id});pending.delete(fingerprint);return result;}
  catch(e){if(e.status>=400&&e.status<500)pending.delete(fingerprint);throw e;}
}
async function logout(){try{await request('/api/auth/logout','POST',{});}catch(e){wx.showToast({title:'已退出此设备。',icon:'none'});}finally{pending.clear();wx.removeStorageSync('jyyc.session');reLaunch('/pages/login/index');}}
function query(values){return Object.keys(values).filter(k=>values[k]!==undefined&&values[k]!==null&&values[k]!=='').map(k=>encodeURIComponent(k)+'='+encodeURIComponent(values[k])).join('&');}
function uploadPhoto(){return new Promise((resolve,reject)=>wx.chooseMedia({count:1,mediaType:['image'],sourceType:['camera','album'],sizeType:['compressed'],success(r){
  const f=r.tempFiles[0];if(!f||f.size>5*1024*1024)return reject(new Error('请使用5MB以内的现场照片'));
  wx.getFileSystemManager().readFile({filePath:f.tempFilePath,encoding:'base64',success:async b=>{try{const png=/\.png(?:\?|$)/i.test(f.tempFilePath);const uploaded=await request('/api/files','POST',{name:'现场照片.'+(png?'png':'jpg'),type:png?'image/png':'image/jpeg',base64:b.data});resolve({file:uploaded,preview:f.tempFilePath});}catch(e){reject(e);}},fail:()=>reject(new Error('照片读取失败，请重新选择'))});
},fail:()=>reject(new Error('未选择照片；相机或相册权限可能未授权'))}));}
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
function checkDownloadSession(token) {
  if(session()?.token!==token)throw new Error('账号已切换，请重新下载。');
}
function download(path){return new Promise((resolve,reject)=>{
  const token=session()?.token;
  wx.downloadFile({url:base()+path,header:{Authorization:'Bearer '+token},timeout:15000,success:r=>{
    try{checkDownloadSession(token);}catch(error){return reject(error);}
    if(r.statusCode===401){expireSession(token);return reject(new Error('登录已失效，请重新登录。'));}
    if(r.statusCode!==200)return reject(new Error('文件下载失败'));
    resolve(r.tempFilePath);
  },fail:()=>reject(new Error('下载中断，请重试'))});
});}
async function authenticate(path,data){const s=await request(path,'POST',data);if(!s?.token)throw new Error('暂时无法登录，请稍后重试。');wx.setStorageSync('jyyc.session',s);pending.clear();return s;}
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
async function collection(name,values={}){const path=collectionPath(name);const filters=path==='/api/tasks'?{status:'all',...values,queue:'partner'}:values;const data=await request(path+'?'+query(filters));if(!Array.isArray(data?.items)||!Number.isInteger(data.total)||!Number.isInteger(data.offset)||typeof data.hasMore!=='boolean')throw new Error('暂时无法获取信息，请稍后重试。');return data;}
const detail=(name,id,filters={})=>{
  const suffix=query(filters);
  return request(collectionPath(name)+'/'+encodeURIComponent(id)+(suffix?'?'+suffix:''));
};
async function openDocument(path,fileType){
  if(!['xlsx','pdf'].includes(fileType))throw new Error('不支持的文件格式');
  const token=session()?.token;
  const filePath=await download(path);
  checkDownloadSession(token);
  await new Promise((resolve,reject)=>wx.openDocument({filePath,fileType,showMenu:true,success:resolve,fail:()=>reject(new Error('文档打开失败，请重试或检查微信版本'))}));
  return filePath;
}
module.exports={session,base,request,passwordLogin,activate,visitor,ensureVisitor,collection,detail,command,logout,query,uploadPhoto,locate,download,openDocument,errorText};

/* DEV_ONLY_START */
module.exports.login=login;
/* DEV_ONLY_END */
function wxCode(){return new Promise((resolve,reject)=>wx.login({timeout:15000,success:r=>r.code?resolve(r.code):reject(new Error('微信登录未完成，请重试。')),fail:()=>reject(new Error('微信登录失败，请检查网络后重试'))}));}
async function wechatLogin(){return authenticate('/api/auth/wechat',{code:await wxCode()});}
async function bindWechat(){return request('/api/auth/wechat/bind','POST',{code:await wxCode()});}
const sendSms=mobile=>request('/api/auth/sms/send','POST',{mobile,purpose:'login'});
const verifySms=(challengeId,mobile,code)=>authenticate('/api/auth/sms/verify',{challengeId,mobile,code});
async function prepay(billId,options={}){const fingerprint=JSON.stringify([session()?.token,'payment-prepay',billId,options]),id=pending.get(fingerprint)||key();pending.set(fingerprint,id);try{const r=await request('/api/payments/prepay','POST',{billId,...options},{'Idempotency-Key':id});pending.delete(fingerprint);return r;}catch(e){if(e.status>=400&&e.status<500)pending.delete(fingerprint);throw e;}}
const queryPayment=id=>request('/api/payments/'+encodeURIComponent(id)+'/query','POST',{});
Object.assign(module.exports,{wxCode,wechatLogin,bindWechat,sendSms,verifySms,prepay,queryPayment});
/* DEV_ONLY_START */
module.exports.simulatePayment=(id,outcome)=>request('/api/payments/'+encodeURIComponent(id)+'/simulate','POST',{outcome});
/* DEV_ONLY_END */

const closePayment=id=>request('/api/payments/'+encodeURIComponent(id)+'/close','POST',{});
function privacyContract(){return new Promise((resolve,reject)=>{if(typeof wx.openPrivacyContract!=='function')return reject(new Error('当前微信版本不支持隐私指引，请更新微信或联系总部'));wx.openPrivacyContract({success:resolve,fail:()=>reject(new Error('隐私保护指引暂不可查看，请联系总部。'))});});}
Object.assign(module.exports,{closePayment,privacyContract});
