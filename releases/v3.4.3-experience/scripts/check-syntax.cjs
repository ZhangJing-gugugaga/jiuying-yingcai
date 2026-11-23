'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');let checked=0;
function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,item.name);if(item.isDirectory())walk(full);else if(/\.(?:cjs|mjs|js)$/.test(item.name)){const result=spawnSync(process.execPath,['--check',full],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr||result.error?.message||'Syntax check failed');process.exit(1);}checked++;}else if(item.name.endsWith('.json')){JSON.parse(fs.readFileSync(full,'utf8'));checked++;}}}
for(const dir of ['server','shared','miniprogram','admin-web','database','scripts'])walk(path.join(root,dir));
console.log(JSON.stringify({status:'passed',checked,check:'JavaScript syntax and JSON parsing; not WeChat compiler'}));
