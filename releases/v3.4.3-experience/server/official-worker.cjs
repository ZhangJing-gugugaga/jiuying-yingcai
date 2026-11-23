'use strict';
function startOfficialWorker(service,{intervalMs=30000}={}){let pending=null,stopping=false;async function tick(){if(stopping||pending||!service.ready)return;pending=service.flush(1).catch(e=>console.error(JSON.stringify({event:'official_delivery_failure',code:e.code||'INTERNAL'}))).finally(()=>{pending=null;});await pending;}const timer=setInterval(tick,intervalMs);timer.unref();return {stop:async()=>{stopping=true;clearInterval(timer);await pending;}};}
module.exports={startOfficialWorker};
