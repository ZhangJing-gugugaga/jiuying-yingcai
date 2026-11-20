'use strict';

function isRelativePath(value) {
  return typeof value === 'string' && !/[\\:?#\u0000]/.test(value) &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

function isInside(root, file) {
  return file === root || file.startsWith(root + '/');
}

function assertPageList(pages, field) {
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(isRelativePath) || new Set(pages).size !== pages.length) {
    throw Error(field + ' 必须是非空且无重复的相对页面路径数组');
  }
}

function getNativeRoutes(app) {
  const mainPages = app.pages;
  assertPageList(mainPages, 'pages');
  if (app.subpackages !== undefined && app.subPackages !== undefined) throw Error('分包只能声明一次');
  const { subPackages: legacySubpackages = [], subpackages = legacySubpackages } = app;
  if (!Array.isArray(subpackages)) throw Error('subpackages 必须是数组');
  const roots = [];
  const routes = [...mainPages];
  for (const subpackage of subpackages) {
    const root = subpackage?.root;
    if (!isRelativePath(root)) throw Error('分包根目录必须是小程序内的相对路径');
    if (roots.some(existing => isInside(existing, root) || isInside(root, existing))) {
      throw Error('分包根目录不能重复或重叠: ' + root);
    }
    const conflictingPage = mainPages.find(page => page.startsWith(root + '/'));
    if (conflictingPage) throw Error('主包页面不能位于分包根目录: ' + conflictingPage);
    assertPageList(subpackage.pages, '分包 ' + root + ' 的 pages');
    roots.push(root);
    routes.push(...subpackage.pages.map(page => root + '/' + page));
  }
  if (app.entryPagePath !== undefined && !mainPages.includes(app.entryPagePath)) {
    throw Error('entryPagePath 必须是主包页面: ' + app.entryPagePath);
  }
  return { routes, mainPages, subpackages };
}

module.exports = { getNativeRoutes, isInside };
