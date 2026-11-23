'use strict';
// Run the official compiler binaries supplied by an installed Tencent DevTools package.
// This proves WXML/WXSS compilation only, never IDE login, simulator or device behavior.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const {collectComponentEntries,collectTemplateImports,collectTemplateScripts}=require('./wechat-components.cjs');
const ROOT=path.resolve(__dirname,'..');

function collectStyleImports(project, pageStyles) {
  const visited = new Set(pageStyles);
  const imports = [];
  function visit(file) {
    const sourcePath = path.join(project, file);
    const css = fs.readFileSync(sourcePath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, imported] of css.matchAll(/@import\s+["']([^"']+)["']/g)) {
      const target = path.resolve(path.dirname(sourcePath), imported);
      const relative = path.relative(project, target);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw Error('WXSS引用须位于小程序目录内: ' + imported);
      }
      const key = relative.split(path.sep).join('/');
      if (visited.has(key)) continue;
      visited.add(key);
      imports.push(key);
      visit(key);
    }
  }
  for (const file of pageStyles) visit(file);
  return imports;
}

function compile({project=path.join(ROOT,'miniprogram'),toolDir=process.env.WECHAT_DEVTOOLS_PATH,out=path.join(ROOT,'execution','wechat-validation')}={}){
 if(!toolDir)throw Error('请设置WECHAT_DEVTOOLS_PATH为已验证的官方开发者工具安装目录');
 project=path.resolve(project);out=path.resolve(out);if(!out.startsWith(ROOT+path.sep)||out.startsWith(project+path.sep)||out===project)throw Error('输出须为工作区中独立于小程序的目录');
 const bin=path.join(path.resolve(toolDir),'resources','app.asar.unpacked','node_modules','wcc-exec');for(const name of ['wcc.exe','wcsc.exe'])if(!fs.existsSync(path.join(bin,name)))throw Error('官方编译器不存在: '+name);
 const staticCheck=require('./wechat-validate.cjs').validate(project);if(!staticCheck.valid)throw Error(staticCheck.errors.join('; '));
 fs.mkdirSync(out,{recursive:true});
 const app=JSON.parse(fs.readFileSync(path.join(project,'app.json')));
 const pages=staticCheck.routeManifest.routes, customTab=app.tabBar?.custom?['custom-tab-bar/index']:[];
 const components=[...customTab,...collectComponentEntries(project,[...pages,...customTab])];
 const entries=[...pages,...components];
 const rel=file=>path.relative(project,path.join(out,file)).split(path.sep).join('/');
 const pageStyles = ['app.wxss', ...entries.map(entry => entry + '.wxss')];
 const styleImports = collectStyleImports(project, pageStyles);
 const templates = collectTemplateImports(project,entries.map(entry => entry + '.wxml'));
 const commands = [
   { name: 'wcc.exe', output: 'wxml-compiled.js', args: [...templates, ...collectTemplateScripts(project,templates), '-o', rel('wxml-compiled.js')] },
   { name: 'wcsc.exe', output: 'wxss-compiled.js', args: ['-js', '-pc', String(pageStyles.length), ...pageStyles, ...styleImports, '-o', rel('wxss-compiled.js')] }
 ];
 const results=commands.map(c=>{const executable=path.join(bin,c.name),run=cp.spawnSync(executable,c.args,{cwd:project,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:5*1024*1024});const version=cp.spawnSync(executable,['--help'],{encoding:'utf8',windowsHide:true,timeout:10000}).stdout?.split(/\r?\n/)[0];const output=path.join(out,c.output);return {compiler:c.name,version,compilerSha256:crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'),arguments:c.args,exitCode:run.status,error:run.error?.message||null,stdout:run.stdout,stderr:run.stderr,output:c.output,outputBytes:fs.existsSync(output)?fs.statSync(output).size:0,passed:run.status===0&&fs.existsSync(output)&&fs.statSync(output).size>0};});
 const report={validatedAt:new Date().toISOString(),project:path.relative(ROOT,project).replaceAll('\\','/'),pages:pages.length,components,scope:'Official WXML/WXSS compiler only',wxmlWxssCompiled:results.every(x=>x.passed),ideCompiled:false,deviceTested:false,staticCheck,results};fs.writeFileSync(path.join(out,'compiler-result.json'),JSON.stringify(report,null,2));if(!report.wxmlWxssCompiled)throw Error('官方WXML/WXSS编译失败，详见compiler-result.json');return report;
}
if(require.main===module){try{const opts={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i+1])throw Error('参数须--name value');opts[process.argv[i].slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=process.argv[i+1];}const r=compile(opts);console.log(JSON.stringify({pages:r.pages,wxmlWxssCompiled:r.wxmlWxssCompiled,ideCompiled:false,deviceTested:false,results:r.results.map(x=>({compiler:x.compiler,exitCode:x.exitCode,outputBytes:x.outputBytes}))},null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={compile,collectStyleImports};
