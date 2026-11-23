'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {execFile,execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {promisify}=require('node:util');
const {build}=require('./wechat-build.cjs');
const source=path.resolve(__dirname,'../miniprogram');

function findCli(){
  if(process.platform!=='win32')return '';
  try{
    const paths=execFileSync('where.exe',['cli.bat'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/);
    return paths.find(file=>file&&fs.existsSync(file))||'';
  }catch{return '';}
}

function prepareNative(directory,port){
  fs.mkdirSync(directory,{recursive:true});
  const apiBase='http://127.0.0.1:'+port;
  const appId=process.env.JIUYING_ROLE_TRIAL_APPID||'touristappid';
  const fingerprint=createHash('sha256').update(apiBase+'\n'+appId).update(fs.readFileSync(require.resolve('./wechat-build.cjs')));
  const files=fs.readdirSync(source,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile())
    .map(entry=>path.join(entry.parentPath,entry.name)).sort();
  for(const file of files)fingerprint.update(path.relative(source,file)+'\n').update(fs.readFileSync(file));
  const project=path.join(directory,'native-project-'+fingerprint.digest('hex').slice(0,12));
  if(!fs.existsSync(path.join(project,'build-manifest.json'))){
    const staging=fs.mkdtempSync(path.join(directory,'native-build-'));
    build({environment:'development',target:'simulator',apiBase,appId,out:staging,roleTrial:true});
    fs.renameSync(staging,project);
  }
  const cli=findCli();
  const command=Buffer.from('& $env:JIUYING_TRIAL_CLI open --project $env:JIUYING_TRIAL_PROJECT; exit $LASTEXITCODE','utf16le').toString('base64');
  let opening;
  return {project,open(){
    if(!cli)throw new Error('未找到微信开发者工具命令行入口，请手动导入下方试用工程。');
    opening||=promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',command],{
      windowsHide:true,timeout:20000,maxBuffer:256*1024,encoding:'utf8',
      env:{...process.env,JIUYING_TRIAL_CLI:cli,JIUYING_TRIAL_PROJECT:project},
    }).catch(error=>{
      const output=(error.stdout||'')+'\n'+(error.stderr||'');
      if(!output.trim())throw new Error('微信开发者工具连接超时，请手动导入试用工程。');
      return {stdout:output,failed:true};
    }).then(({stdout,stderr,failed})=>{
      const output=stdout+'\n'+(stderr||'');
      if(/service port (?:is )?(?:disabled|closed)|服务端口.*关闭/i.test(output)){
        throw new Error('微信开发者工具的 CLI 服务端口已关闭，请手动导入试用工程。');
      }
      if(failed||/\b(?:error|failed)\b|失败|未登录/i.test(output.replace(/.*DeprecationWarning.*$/gm,''))){
        throw new Error('微信开发者工具未能打开试用工程，请检查工具登录状态或手动导入。');
      }
    }).finally(()=>{opening=null;});
    return opening;
  }};
}

module.exports={prepareNative};
