'use strict';
const {DatabaseSync}=require('node:sqlite');const fs=require('node:fs');const path=require('node:path');const {createHash}=require('node:crypto');const core=require('../shared/core.cjs');
function openStore(dbPath,{seed=true,productionRuntime}={}){
 if(dbPath!==':memory:')fs.mkdirSync(path.dirname(path.resolve(dbPath)),{recursive:true});const db=new DatabaseSync(dbPath);
 if(productionRuntime!==undefined){
  try{
   const hasSettings=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
   const mode=hasSettings&&db.prepare("SELECT value FROM settings WHERE key='mode'").get();
   const isProduction=mode&&JSON.parse(mode.value)==='production';
   core.check(productionRuntime?isProduction:!isProduction,'CONFIG',productionRuntime?'生产环境须先在无样本新库运行setup-admin':'开发与测试运行时须使用独立数据库');
  }catch(error){db.close();throw error;}
 }
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
 db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
 const migrationDir=path.join(__dirname,'../database'),migrations=fs.readdirSync(migrationDir).filter(name=>/^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort((a,b)=>Number(a.slice(0,3))-Number(b.slice(0,3))),versions=new Set();
 for(const name of migrations){const version=Number(name.slice(0,3));if(versions.has(version)){db.close();throw new Error('Duplicate migration version: '+version);}versions.add(version);if(db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(version))continue;db.exec('BEGIN IMMEDIATE');try{db.exec(fs.readFileSync(path.join(migrationDir,name),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version,name.replace(/\.sql$/,''),new Date().toISOString());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');db.close();throw e;}}
 if(productionRuntime){
  try{
   const explicitTestRecords=db.prepare(`
    SELECT 1 FROM bills WHERE json_extract(data,'$.simulation')=1
    UNION ALL SELECT 1 FROM payments WHERE json_extract(data,'$.adapterMode') IN ('mock','sandbox','test')
    UNION ALL SELECT 1 FROM receipts WHERE json_extract(data,'$.adapterMode') IN ('mock','sandbox','test')
    UNION ALL SELECT 1 FROM refundRequests WHERE json_extract(data,'$.adapterMode') IN ('mock','sandbox','test')
    UNION ALL SELECT 1 FROM payment_provider_orders WHERE adapter_mode='mock' OR gateway_environment IN ('sandbox','test','mock')
    UNION ALL SELECT 1 FROM payment_refund_orders WHERE adapter_mode='mock'
    LIMIT 1`).get();
   core.check(!explicitTestRecords,'DATABASE_TEST_DATA','数据库存在明确标记的测试账务，须核对隔离库与正式库');
  }catch(error){db.close();throw error;}
 }
 const setting=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE settings.value<>excluded.value');
 const baselines=new WeakMap();
 function settings(){const s={};for(const r of db.prepare('SELECT key,value FROM settings').all())s[r.key]=JSON.parse(r.value);for(const k of core.COLLECTIONS)s[k]=[];return s;}
 function load(selection){const s=settings();for(const table of core.COLLECTIONS){const clause=selection?.[table];if(selection&&clause===undefined)continue;const {where='1',params=[],limit,offset=0}=clause||{};const query=`SELECT data FROM ${table} WHERE ${where} ORDER BY rowid${limit?' LIMIT ? OFFSET ?':''}`;s[table]=db.prepare(query).all(...params,...(limit?[limit,offset]:[])).map(x=>JSON.parse(x.data));}baselines.set(s,{draftIds:s.drafts.map(x=>x.id)});return s;}
 function sealAudit(){if(!db.prepare("SELECT name FROM sqlite_master WHERE name='audit_chain'").get())return;let last=db.prepare("SELECT value FROM runtime_metrics WHERE key='audit.lastRowid'").get()?.value||0;let previous=db.prepare('SELECT digest FROM audit_chain ORDER BY seq DESC LIMIT 1').get()?.digest||'0'.repeat(64);const rows=db.prepare('SELECT rowid,id,data FROM audit WHERE rowid>? ORDER BY rowid').all(last);const insert=db.prepare('INSERT OR IGNORE INTO audit_chain(record_id,previous_hash,digest,created_at) VALUES(?,?,?,?)');for(const row of rows){const digest=createHash('sha256').update(previous+'\n'+row.data).digest('hex');insert.run(row.id,previous,digest,new Date().toISOString());previous=digest;last=row.rowid;}if(rows.length)db.prepare("INSERT INTO runtime_metrics(key,value) VALUES('audit.lastRowid',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(last);}
 function save(s,{before}={}){for(const k of ['schemaVersion','today','mode','grants','supportSettings'])if(s[k]!==undefined)setting.run(k,JSON.stringify(s[k]));for(const table of core.COLLECTIONS){const rows=s[table]||[];if(!rows.length&&table!=='drafts')continue;const original=before?new Map((before[table]||[]).map(x=>[x.id,JSON.stringify(x)])):null;const stmt=db.prepare(`INSERT INTO ${table}(id,owner,outlet,status,month,version,current,amount_cents,data,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,outlet=excluded.outlet,status=excluded.status,month=excluded.month,version=excluded.version,current=excluded.current,amount_cents=excluded.amount_cents,data=excluded.data WHERE ${table}.data<>excluded.data`);for(const r of rows){const encoded=JSON.stringify(r);if(original?.get(r.id)===encoded)continue;stmt.run(r.id,r.owner||null,r.outlet||null,r.status||'active',r.month||null,r.version||null,r.current?1:0,r.amount==null?null:Math.round(r.amount*100),encoded,r.createdAt||new Date().toISOString());}if(table==='drafts'){const ids=new Set(rows.map(x=>x.id)),oldIds=before?.drafts.map(x=>x.id)||baselines.get(s)?.draftIds||[];for(const id of oldIds)if(!ids.has(id))db.prepare('DELETE FROM drafts WHERE id=?').run(id);}}
 for(const account of s.accounts||[])if(account.actor){db.prepare('INSERT OR IGNORE INTO users(actor,role,status) VALUES(?,?,?)').run(account.actor,'partner','active');if(account.authenticationResetVersion&&db.prepare("SELECT 1 FROM sqlite_master WHERE name='authentication_resets'").get()){const applied=db.prepare('SELECT applied_version FROM authentication_resets WHERE actor=?').get(account.actor)?.applied_version||0;if(account.authenticationResetVersion>applied){for(const table of ['credentials','sessions','activation_tokens','identity_bindings','sms_challenges'])db.prepare(`DELETE FROM ${table} WHERE actor=?`).run(account.actor);db.prepare('INSERT INTO authentication_resets VALUES(?,?) ON CONFLICT(actor) DO UPDATE SET applied_version=excluded.applied_version').run(account.actor,account.authenticationResetVersion);}}}
 for(const staff of s.staffAccounts||[])db.prepare('INSERT INTO users(actor,role,status,binding_version) VALUES(?,?,?,?) ON CONFLICT(actor) DO UPDATE SET role=excluded.role,status=excluded.status,binding_version=excluded.binding_version WHERE users.role<>excluded.role OR users.status<>excluded.status OR users.binding_version<>excluded.binding_version').run(staff.id,staff.role,staff.status,staff.bindingVersion||1);
 sealAudit();
 }
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
 if(seed&&!db.prepare("SELECT 1 FROM settings WHERE key='schemaVersion'").get())transaction(()=>{save(core.createState());for(const actor of core.ACTORS)db.prepare('INSERT OR IGNORE INTO users(actor,role,status) VALUES(?,?,?)').run(actor,actor,'active');});
 if(db.prepare("SELECT name FROM sqlite_master WHERE name='audit_chain'").get())transaction(sealAudit);
 return {db,load,save,settings,sealAudit,transaction,close:()=>db.close()};
}
module.exports={openStore};

