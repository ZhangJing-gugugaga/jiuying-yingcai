'use strict';
function startPaymentWorker(service,{intervalMs=60000}={}) {
 let pending=null,stopping=false;
 async function tick(){if(stopping||pending||!service.ready)return;pending=service.reconcile(1).catch(e=>console.error(JSON.stringify({event:'payment_reconciliation_failure',code:e.code||'INTERNAL'}))).finally(()=>{pending=null;});await pending;}
 const timer=setInterval(tick,intervalMs);timer.unref();
 return {stop:async()=>{stopping=true;clearInterval(timer);await pending;}};
}
module.exports={startPaymentWorker};
