'use strict';
const path=require('node:path'),{openStore}=require('../server/storage.cjs'),{initializeAdmin}=require('../server/bootstrap.cjs');
(async()=>{const store=openStore(process.env.DB_PATH||path.resolve(__dirname,'../var/production.db'),{seed:false});try{const result=await initializeAdmin(store,{username:process.env.ADMIN_INITIAL_USERNAME,password:process.env.ADMIN_INITIAL_PASSWORD,name:process.env.ADMIN_INITIAL_NAME});console.log(JSON.stringify(result));}finally{delete process.env.ADMIN_INITIAL_PASSWORD;store.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
