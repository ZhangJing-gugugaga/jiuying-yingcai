'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const { collectComponentEntries, collectTemplateImports, collectTemplateScripts } = require('./wechat-components.cjs');
const { collectStyleImports } = require('./wechat-compile.cjs');

const packageRoot = path.dirname(require.resolve('tdesign-miniprogram/package.json'));
const source = path.join(packageRoot, 'miniprogram_dist');
const target = path.resolve(__dirname, '../miniprogram/vendor/tdesign');
const iconStyle = 'icon/icon.wxss';
const fontSha256 = '3d5d09090aee9684369066e306b5e488349748b5953be56a71e0820496677764';
const roots = ['badge', 'button', 'cell', 'cell-group', 'empty', 'grid', 'grid-item', 'icon', 'input'].map(name => name + '/' + name);

function generate(fontFile, check) {
  const previousStyle = path.join(target, iconStyle);
  const embedded = fontFile ? '' : fs.readFileSync(previousStyle, 'utf8').match(/data:font\/woff;base64,([^)]*)/)?.[1];
  const font = fontFile ? fs.readFileSync(fontFile) : Buffer.from(embedded || '', 'base64');
  if (createHash('sha256').update(font).digest('hex') !== fontSha256) throw Error('TDesign 图标字体校验失败');
  const entries = collectComponentEntries(source, [], roots);
  const templates = collectTemplateImports(source, entries.map(entry => entry + '.wxml'));
  const styles = entries.map(entry => entry + '.wxss');
  const files = new Map();
  for (const entry of entries) {
    const script = entry + '.js';
    const { outputFiles } = buildSync({
      absWorkingDir: source,
      entryPoints: [script],
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2017',
      alias: { tslib: path.join(source, 'miniprogram_npm/tslib/index.js') },
      legalComments: 'inline',
      minify: true,
      write: false
    });
    files.set(script, Buffer.from(outputFiles[0].contents));
  }
  const wxsFiles = collectTemplateScripts(source, templates);
  for (const file of [...entries.map(entry => entry + '.json'), ...templates, ...wxsFiles, ...styles, ...collectStyleImports(source, styles)]) {
    let content = fs.readFileSync(path.join(source, file));
    if (file === iconStyle) {
      const upstream = content.toString('utf8');
      if (!upstream.includes('https://tdesign.gtimg.com/icon/0.4.6/fonts/t.woff')) throw Error('TDesign 图标字体版本已变更');
      content = Buffer.from(upstream.replace(/src:url\(https:\/\/tdesign\.gtimg\.com\/icon\/[^;]+;/,
        "src:url(data:font/woff;base64," + font.toString('base64') + ") format('woff');"));
    }
    files.set(file, content);
  }
  files.set('LICENSE', fs.readFileSync(path.join(packageRoot, 'LICENSE')));
  for (const [file, content] of files) {
    const output = path.join(target, file);
    if (check) {
      if (!fs.existsSync(output) || !content.equals(fs.readFileSync(output))) throw Error('组件产物与锁定版本不一致: ' + file);
      continue;
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, content);
  }
  const actual = fs.readdirSync(target, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(target, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
  if (actual.some(file => !files.has(file))) throw Error('组件目录存在未登记文件');
  console.log(JSON.stringify({ components: entries.length, files: files.size, bytes: [...files.values()].reduce((sum, file) => sum + file.length, 0), checked: check }));
}

try {
  const args = process.argv.slice(2);
  const fontIndex = args.indexOf('--font');
  generate(fontIndex < 0 ? null : args[fontIndex + 1], args.includes('--check'));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
