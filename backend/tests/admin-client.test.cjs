'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
async function serve(handler,fn){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await fn('http://127.0.0.1:'+s.address().port)}finally{await new Promise(r=>s.close(r))}}
test('admin retains the command key after a lost response and clears it after success',async()=>{
 const {createClient}=await import('../../web/client.js');let seen=[],count=0;
 await serve((req,res)=>{seen.push(req.headers['idempotency-key']);req.resume();req.on('end',()=>{if(++count===1)return req.socket.destroy();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:{result:{id:'one'}}}))})},async base=>{const c=createClient({base,token:()=>'',timeout:500});await assert.rejects(c.command('staff.create',{name:'Test'}));assert.equal((await c.command('staff.create',{name:'Test'})).id,'one');await c.command('staff.create',{name:'Test'});assert.equal(seen[0],seen[1]);assert.notEqual(seen[1],seen[2])})
});
test('admin reports bounded request timeout with recoverable message',async()=>{
 const {createClient}=await import('../../web/client.js');await serve((req,res)=>{setTimeout(()=>res.end('{}'),80)},async base=>{const c=createClient({base,timeout:15});await assert.rejects(c.request('/slow'),/超时/)});
});
test('admin errors retain request id and server error code',async()=>{
 const {createClient}=await import('../../web/client.js');await serve((req,res)=>{res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'CONFLICT',message:'状态已变化'},requestId:'request-123'}))},async base=>{await assert.rejects(createClient({base}).request('/conflict'),e=>e.code==='CONFLICT'&&e.requestId==='request-123'&&e.message.includes('状态已变化'))});
});
test('retry metadata never persists token or financial payload',async()=>{
 const {createClient}=await import('../../web/client.js');const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 await serve(req=>req.socket.destroy(),async base=>{await assert.rejects(createClient({base,token:()=> 'private-session-token',storage}).command('refund.request',{reason:'private-financial-reason'}));const persisted=[...values.values()].join('');assert.ok(persisted.length>0);assert.equal(persisted.includes('private-session-token'),false);assert.equal(persisted.includes('private-financial-reason'),false)});
});
test('CSV import reads quoted cells and rejects malformed files',async()=>{
 const {parseCSV}=await import('../../web/operations.js');assert.deepEqual(parseCSV('name,address\r\n"店,一","A""B"\r\n'),[['name','address'],['店,一','A"B']]);assert.throws(()=>parseCSV('name\n"unfinished'),/引号/);
});
