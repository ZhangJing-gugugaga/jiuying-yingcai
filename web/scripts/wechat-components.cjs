'use strict';

const fs = require('node:fs');
const path = require('node:path');

function componentDeclarations(root, entry) {
  const filename = path.join(root, entry + '.json');
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
  return Object.fromEntries(Object.entries(config.usingComponents || {}).map(([tag, target]) => {
    if (typeof target !== 'string' || !/^(\/|\.\.?\/)[\w./-]+$/.test(target)) {
      throw Error(entry + ' 组件必须声明本地路径 ' + tag);
    }
    const component = target.startsWith('/') ? path.resolve(root, '.' + target) : path.resolve(path.dirname(filename), target);
    const relative = path.relative(root, component);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw Error(entry + ' 组件位于小程序目录外 ' + tag);
    }
    return [tag, relative.split(path.sep).join('/')];
  }));
}

function collectComponentEntries(root, entries, declared = Object.values(componentDeclarations(root, 'app'))) {
  const components = new Set();
  function visit(entry) {
    if (components.has(entry)) return;
    for (const extension of ['.json', '.js', '.wxml', '.wxss']) {
      if (!fs.existsSync(path.join(root, entry + extension))) throw Error('组件缺文件: ' + entry + extension);
    }
    if (JSON.parse(fs.readFileSync(path.join(root, entry + '.json'), 'utf8')).component !== true) {
      throw Error('未声明 component: ' + entry);
    }
    components.add(entry);
    Object.values(componentDeclarations(root, entry)).forEach(visit);
  }
  declared.forEach(visit);
  for (const entry of entries) Object.values(componentDeclarations(root, entry)).forEach(visit);
  return [...components];
}

function collectTemplateImports(root, templates) {
  const files = new Set(templates);
  function visit(file) {
    const xml = fs.readFileSync(path.join(root, file), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const [, source] of xml.matchAll(/<(?:import|include)\s+src=["']([^"']+)["']/g)) {
      const target = source.startsWith('/') ? path.resolve(root, '.' + source) : path.resolve(root, path.dirname(file), source);
      const key = path.relative(root, target).split(path.sep).join('/');
      if (key === '..' || key.startsWith('../') || path.isAbsolute(key)) throw Error('WXML引用须位于小程序目录内: ' + source);
      if (files.has(key)) continue;
      files.add(key);
      visit(key);
    }
  }
  templates.forEach(visit);
  return [...files];
}

function collectTemplateScripts(root, templates) {
  const scripts = new Set();
  function visit(parent, source) {
    const file = path.posix.normalize(path.posix.join(path.posix.dirname(parent), source));
    if (scripts.has(file)) return;
    if (file.startsWith('../') || !file.endsWith('.wxs')) throw Error('无效的 WXS 引用: ' + file);
    scripts.add(file);
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, imported] of code.matchAll(/\brequire\(["']([^"']+)["']\)/g)) visit(file, imported);
  }
  for (const file of templates) {
    const xml = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, source] of xml.matchAll(/<wxs\b[^>]*?\ssrc=["']([^"']+)["']/g)) visit(file, source);
  }
  return [...scripts];
}

module.exports = { componentDeclarations, collectComponentEntries, collectTemplateImports, collectTemplateScripts };
