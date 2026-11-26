'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { openTrialServer, trialApiRequest } = require('./role-trial.cjs');
const { build } = require('./wechat-build.cjs');

const root = path.resolve(__dirname, '..');
const reason = '本机隔离原型样本';
const services = [
  ['人才培养', '专业人才发展'],
  ['运营赋能', '校区高效运营'],
  ['咨询服务', '经营管理支持'],
  ['品牌支持', '品牌建设推广'],
  ['数字服务', '数字化提效'],
];

async function seed(trial) {
  const request = trialApiRequest(trial.url);
  const { token: manager } = await request('/auth/dev', { actor: 'manager' });
  const { token: partner } = await request('/auth/dev', { actor: 'partnerA' });
  const command = async (token, name, payload) => (await request('/commands', { command: name, payload }, token)).result;

  const cover = fs.readFileSync(path.join(root, '../miniprogram/assets/home-skyline.webp'));
  const file = await request('/files', { name: '隔离预览城市插画.webp', type: 'image/webp', base64: cover.toString('base64') }, manager);
  await command(manager, 'content.update', {
    key: 'brand', title: '九盈英才', imageId: file.id, published: true, reason,
    text: '本机演示。九盈英才为合作伙伴提供人才培养、校区运营、咨询与品牌支持。页面内容和业务数据均为验收样本。',
  });
  for (const [index, [title, summary]] of services.entries()) {
    await command(manager, 'content.service.save', { slot: index + 1, title, summary, body: summary + '。' + reason + '。', published: true, reason });
  }

  const preview = await command(manager, 'import.preview', {
    kind: 'outlets', reason,
    rows: [{ countryCode: 'SG', city: '新加坡', owner: 'p1', name: '新加坡示范网点', address: '新加坡 · 原型演示区域',
      phone: '0000', opening: '2026-11-10', enrollmentApplicable: false, status: 'open' }],
  });
  const imported = await command(manager, 'import.commit', { id: preview.id });
  await command(manager, 'public.profile', {
    outlet: 'cs', title: '长沙示范网点', description: reason, address: '长沙 · 原型演示区域',
    services: ['人才培养', '运营赋能'], published: true, reason,
    publicCoords: { lat: 28.23, lng: 112.94, coordinateSystem: 'GCJ-02' },
  });
  await command(manager, 'public.profile', {
    outlet: imported.createdIds[0], title: '新加坡示范网点', description: reason, address: '新加坡 · 原型演示区域',
    services: ['咨询服务'], published: true, reason,
    publicCoords: { lat: 1.29, lng: 103.85, coordinateSystem: 'WGS-84' },
  });

  const report = await command(partner, 'report.submit', {
    outlet: 'cs', month: '2026-10', revenue: 128600, orders: 356, traffic: 420, enroll: 42, note: reason,
  });
  await command(manager, 'review.report', {
    id: report.id, decision: 'return', note: '请核对本月营业收入与流水的差异。\n核实订单及到店客流后，请补充经营说明。',
  });

  const course = await request('/training/courses', { title: '第三期业务培训', content: reason }, manager);
  await request('/training/courses/' + course.id, { status: 'published' }, manager);
  const record = await request('/training/records', { courseId: course.id, outletId: 'cs', learner: '演示学员' }, partner);
  const training = '/training/records/' + record.id;
  const material = await request(training + '/materials', { name: '隔离预览材料.webp', type: 'image/webp', base64: cover.toString('base64') }, partner);
  await request(training + '/review', { action: 'return', version: material.version, note: '请补充完整培训资料。' }, manager);
}

async function startPrototypePreview({ port = 18975, appId = process.env.WECHAT_APP_ID } = {}) {
  const trial = await openTrialServer({ dbPath: ':memory:', port });
  const dist = path.join(root, 'dist');
  let project;
  async function stop() {
    try {
      await trial.stop();
    } finally {
      if (project && fs.existsSync(project)) {
        const target = fs.realpathSync(project);
        if (path.dirname(target) !== fs.realpathSync(dist)) throw new Error('Unexpected preview directory');
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }
  try {
    await seed(trial);
    fs.mkdirSync(dist, { recursive: true });
    project = fs.mkdtempSync(path.join(dist, 'ui-prototype-preview-'));
    build({ environment: 'development', target: 'simulator', apiBase: trial.url, appId, out: project });
    return { ...trial, project, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (require.main === module) {
  startPrototypePreview().then(trial => {
    console.log(JSON.stringify({ status: 'ready', apiBase: trial.url, project: trial.project }));
    process.once('SIGINT', () => trial.stop());
    process.once('SIGTERM', () => trial.stop());
  }).catch(error => {
    console.error(error.code === 'EADDRINUSE' ? '18975 已被占用。请保留现有预览进程，或结束它再重新启动。' : error.message);
    process.exitCode = 1;
  });
}

module.exports = { startPrototypePreview };
