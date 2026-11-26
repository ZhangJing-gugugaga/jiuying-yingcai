'use strict';
const path=require('node:path');const {openStore}=require('../server/storage.cjs');
const development=process.env.NODE_ENV!=='production';
const dbPath=process.env.DB_PATH||path.resolve(__dirname,'../var/local.db');
const store=openStore(dbPath,{seed:development,productionRuntime:development?false:undefined});
try{console.log(JSON.stringify({database:dbPath,migrations:store.db.prepare('SELECT * FROM schema_migrations').all(),developmentSeed:development}));}
finally{store.close();}
