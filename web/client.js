export function createClient({base='/api',token=()=>'',timeout=15000,onUnauthorized=()=>{},storage=null}={}){
 const pending=new Map();
 async function request(path,{method='GET',body,key,binary=false,ignoreUnauthorized=false}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try{
   const auth=token(),response=await fetch(base+path,{method,signal:controller.signal,headers:{...(body?{'Content-Type':'application/json'}:{}),...(auth?{Authorization:'Bearer '+auth}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
   if(binary&&response.ok)return {blob:await response.blob(),type:response.headers.get('Content-Type')};
   let value;try{value=await response.json()}catch{throw new Error('服务未返回有效数据，请稍后重试')}
   if(!response.ok){if(response.status===401&&!ignoreUnauthorized)onUnauthorized(auth);const error=new Error(value.error?.message||'请求失败');Object.assign(error,{code:value.error?.code,status:response.status,requestId:value.requestId});throw error}
   return value.data;
  }catch(error){if(error.name==='AbortError')throw new Error('请求超时。请保留表单并重试，重复提交会使用同一业务标识。');if(error instanceof TypeError)throw new Error('网络连接中断。请保留表单并重试。');throw error}finally{clearTimeout(timer)}
 }
 async function command(command,payload){
  // Scope recovery keys to the authenticated session and exact request payload.
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token()+'|'+JSON.stringify({command,payload})));
  const fingerprint=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const storageKey='jy-pending-commands';let saved={};try{saved=JSON.parse(storage?.getItem(storageKey)||'{}')}catch{}
  const key=pending.get(fingerprint)||saved[fingerprint]||crypto.randomUUID();pending.set(fingerprint,key);
  saved[fingerprint]=key;try{storage?.setItem(storageKey,JSON.stringify(saved))}catch{}
  const value=await request('/commands',{method:'POST',body:{command,payload},key});
  pending.delete(fingerprint);delete saved[fingerprint];try{storage?.setItem(storageKey,JSON.stringify(saved))}catch{}
  return value.result||value;
 }
 return {request,command};
}
