'use strict';
// WXML/event/route/schema checks only. This is never WeChat compilation evidence.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const { getNativeRoutes, isInside } = require('./wechat-routes.cjs');
const { collectComponentEntries, componentDeclarations } = require('./wechat-components.cjs');
const TAGS=new Set(['view','text','label','button','input','textarea','form','block','template','picker','switch','map','image','scroll-view','checkbox','checkbox-group','radio','radio-group','navigator','loading','icon','cover-view','cover-image']);

function packageReferences(file, contents) {
 const extension=path.extname(file);
 if(extension==='.js'){
  return Array.from(contents.matchAll(/\brequire\(\s*["']([./][^"']+)["']\s*\)/g),match=>match[1]);
 }
 if(extension==='.wxml'){
  const markup=contents.replace(/<!--[\s\S]*?-->/g,'');
  return Array.from(markup.matchAll(/<(?:import|include|wxs|image|cover-image)\b[^>]*?\ssrc=["']([^"']+)["']/g),match=>match[1]);
 }
 if(extension==='.wxss'){
  const css=contents.replace(/\/\*[\s\S]*?\*\//g,'');
  return Array.from(css.matchAll(/@import\s+["']([^"']+)["']|\burl\(\s*["']?([^"'\s)]+)["']?\s*\)/g),match=>match[1]||match[2]);
 }
 return [];
}

function checkPackageReferences(root, files, subpackages, errors) {
 if(!subpackages.length)return;
 const relative=file=>path.relative(root,file).split(path.sep).join('/');
 const owner=file=>subpackages.find(item=>isInside(item.root,file));
 for(const file of files){
  if(!/\.(js|wxml|wxss)$/.test(file))continue;
  const source=relative(file),sourcePackage=owner(source);
  const references=packageReferences(file,fs.readFileSync(file,'utf8'));
  for(const reference of references){
   if(/^(?:[\w+-]+:|\/\/)|{{/.test(reference))continue;
   const target=relative(reference.startsWith('/')?path.resolve(root,'.'+reference):path.resolve(path.dirname(file),reference));
   const targetPackage=owner(target);
   if(sourcePackage!==targetPackage&&(targetPackage||sourcePackage?.independent)){
    errors.push('分包不能同步引用: '+source+' -> '+target);
   }
  }
 }
}

function readWxml(file,registered,ancestors=new Set()){
 const stack=new Set([...ancestors,file]);
 return fs.readFileSync(file,'utf8').replace(/<!--[\s\S]*?-->|<include\s+src=["']([^"'<>]+)["']\s*\/>/g,(tag,relative)=>{
  if(!relative)return tag;
  const target=path.resolve(path.dirname(file),relative);
  if(!registered.has(target)||stack.has(target))throw new Error('WXML引用必须指向已注册且无循环的页面 '+relative);
  return readWxml(target,registered,stack);
 });
}
function validate(directory,{production=false}={}){const root=path.resolve(directory),errors=[],warnings=[],files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else files.push(p);}}walk(root);
 let app,project;try{app=JSON.parse(fs.readFileSync(path.join(root,'app.json')));project=JSON.parse(fs.readFileSync(path.join(root,'project.config.json')));}catch(e){return {valid:false,errors:['工程JSON无效: '+e.message],warnings,wechatCompiled:false};}if(project.compileType!=='miniprogram'||project.miniprogramRoot!=='./')errors.push('compileType或miniprogramRoot错误');
 let routeManifest;
 try{routeManifest=getNativeRoutes(app);}catch(e){return {valid:false,errors:[...errors,e.message],warnings,wechatCompiled:false};}
 const {routes,mainPages,subpackages}=routeManifest;
 checkPackageReferences(root,files,subpackages,errors);
 const tabItems=app.tabBar?.list||[];
 for(const tab of tabItems){
  if(!mainPages.includes(tab.pagePath))errors.push('tab必须是主包页面: '+tab.pagePath);
  for(const key of ['iconPath','selectedIconPath'])if(tab[key]&&!fs.existsSync(path.join(root,tab[key])))errors.push('tab图标缺失: '+tab[key]);
 }
 const customTab=app.tabBar?.custom?'custom-tab-bar/index':null;
 const uiEntries=[...routes,...(customTab?[customTab]:[])];
 let declarations={};
 try{
  const components=collectComponentEntries(root,uiEntries);
  const shared=componentDeclarations(root,'app');
  declarations=Object.fromEntries([...uiEntries,...components].map(entry=>[entry,{...shared,...componentDeclarations(root,entry)}]));
  for(const [entry,tags] of Object.entries(declarations)){
   const owner=subpackages.find(item=>isInside(item.root,entry));
   for(const target of Object.values(tags)){
    const dependency=subpackages.find(item=>isInside(item.root,target));
    if(owner!==dependency&&(dependency||owner?.independent))errors.push('分包不能引用组件: '+entry+' -> '+target);
   }
  }
 }catch(error){errors.push(error.message);}
 const registeredWxml=new Set(routes.map(route=>path.join(root,route+'.wxml')).filter(file=>file.startsWith(root+path.sep)));
 for(const route of [...routes,...(customTab?[customTab]:[])]){const component=route===customTab;for(const ext of ['.js','.json','.wxml','.wxss'])if(!fs.existsSync(path.join(root,route+ext)))errors.push('缺文件: '+route+ext);if(errors.some(x=>x.includes('缺文件: '+route)))continue;let def;try{if(component&&JSON.parse(fs.readFileSync(path.join(root,route+'.json'),'utf8')).component!==true)throw new Error('自定义底栏必须声明 component');const code=fs.readFileSync(path.join(root,route+'.js'),'utf8');new vm.Script(code);const sandbox={Page:d=>def=d,Component:d=>def=d.methods,require:rel=>require(path.resolve(root,path.dirname(route),rel)),wx:{},console};vm.runInNewContext(code,sandbox);}catch(e){errors.push(route+' JS: '+e.message);continue;}let xml;try{xml=readWxml(path.join(root,route+'.wxml'),registeredWxml);}catch(e){errors.push(route+' '+e.message);continue;}if(/{{[^}]*&(?:amp|lt|gt);[^}]*}}/.test(xml))errors.push(route+' WXML表达式不允许HTML实体，须原生运算符');const stack=[];for(const t of xml.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<\/?([a-z][\w-]*)(?:\s[^>]*?)?\s*\/?>/gi)){if(!TAGS.has(t[1])&&!Object.hasOwn(declarations[route]||{},t[1]))errors.push(route+' 未声明的组件 '+t[1]);if(t[0].startsWith('</')){if(stack.pop()!==t[1])errors.push(route+' 标签不平衡 '+t[1]);}else if(!t[0].endsWith('/>'))stack.push(t[1]);}if(stack.length)errors.push(route+' 未闭合标签');for(const [,h]of xml.matchAll(/(?:bind|catch)(?::)?[\w-]+="([A-Za-z_]\w*)"/g))if(typeof def?.[h]!=='function')errors.push(route+' 事件缺失 '+h);for(const [,target]of xml.matchAll(/data-page="([a-z-]+)"/g))if(!routes.includes('pages/'+target+'/index'))errors.push(route+' 未注册目标 '+target);for(const [,v]of xml.matchAll(/wx:(?:if|elif|for)="([^"]*)"/g))if(!v.startsWith('{{')||!v.endsWith('}}'))errors.push(route+' WXML指令表达式未绑定');if(/<web-view|<iframe|<script/i.test(xml))errors.push(route+' 禁用WebView/HTML');
 }
 for(const file of files){if(file.endsWith('.js'))try{new vm.Script(fs.readFileSync(file,'utf8'));}catch(e){errors.push('JS语法无效 '+path.relative(root,file)+': '+e.message);}if(file.endsWith('.json'))try{JSON.parse(fs.readFileSync(file,'utf8'));}catch{errors.push('JSON无效 '+path.relative(root,file));}if(file.endsWith('.wxss'))for(const [,rel]of fs.readFileSync(file,'utf8').matchAll(/@import\s+["']([^"']+)["']/g))if(!fs.existsSync(path.resolve(path.dirname(file),rel)))errors.push('WXSS引用丢失 '+rel);}
 const allJS=files.filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(x,'utf8')).join('\n');for(const name of ['getLocation','chooseLocation'])if(allJS.includes('wx.'+name)&&!app.requiredPrivateInfos?.includes(name))errors.push('定位隐私声明缺失 '+name);if(production){if(project.setting?.urlCheck!==true)errors.push('非开发构建必须urlCheck:true');if(project.appid==='touristappid')errors.push('非开发构建禁止touristappid');if(/partnerA|partnerB|customActor|\/api\/auth\/dev/.test(allJS))errors.push('构建中仍有开发身份代码');}
 warnings.push('静态校验不替代微信开发者工具编译、模拟器、真机或平台审核');return {valid:errors.length===0,pages:routes.length,routeManifest,files:files.length,errors,warnings,wechatCompiled:false};}
if(require.main===module){const root=process.argv[2]||path.resolve(__dirname,'../miniprogram');const result=validate(root,{production:process.argv.includes('--production')});console.log(JSON.stringify(result,null,2));if(!result.valid)process.exitCode=1;}
module.exports={validate,readWxml,nativeWxmlTags:TAGS};

