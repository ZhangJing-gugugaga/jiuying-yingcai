'use strict';
const path=require('node:path'),{openStore}=require('../server/storage.cjs'),{backupDatabase,restoreBackup,verifyBackup}=require('../server/maintenance.cjs');
(async()=>{
 const [operation,file,target]=process.argv.slice(2);
 if(!file||!['create','verify','restore'].includes(operation))throw new Error('Usage: node scripts/backup.cjs create|verify|restore <backup-path> [new-restore-path]');
 if(operation==='restore'){if(!target)throw new Error('恢复必须指定全新数据库路径');console.log(JSON.stringify(restoreBackup(file,target)));return;}
 if(operation==='verify'){console.log(JSON.stringify(verifyBackup(file)));return;}
 const development=process.env.NODE_ENV!=='production';
 const store=openStore(process.env.DB_PATH||path.resolve(__dirname,'../var/local.db'),{seed:false,productionRuntime:development?false:undefined});
 try{console.log(JSON.stringify(await backupDatabase(store,file)));}finally{store.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
