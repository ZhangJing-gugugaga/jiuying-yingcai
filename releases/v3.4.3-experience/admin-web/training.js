const recordStatuses = {
  in_progress: '学习中', submitted: '资料待审核', returned: '需补充资料',
  materials_approved: '资料已通过', completed: '培训已完成',
};
const courseStatuses = { draft: '草稿', published: '已发布', archived: '已归档' };
const reviewLabels = { return: '退回补充', accept: '通过资料审核', complete: '确认培训完成' };
const pathForRecord = id => '/training/records/' + encodeURIComponent(id);
const localTime = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '';

export function trainingDesk({ api, esc, empty, panel }) {
  const canOpen = role => role === 'manager' || role === 'regional';
  const keys = new Map();

  async function write(subject, path, body) {
    const fingerprint = subject + '|' + path + '|' + JSON.stringify(body);
    const key = keys.get(fingerprint) || crypto.randomUUID();
    if (!keys.has(fingerprint) && keys.size >= 40) keys.delete(keys.keys().next().value);
    keys.set(fingerprint, key);
    try {
      const result = await api(path, { method: 'POST', body, key });
      keys.delete(fingerprint);
      return result;
    } catch (error) {
      if (error.status >= 400 && error.status < 500) keys.delete(fingerprint);
      throw error;
    }
  }

  function mount(container, session) {
    const manager = session.actor === 'manager';
    const state = {
      courses: [], records: [], outlets: [], courseOffset: 0, recordOffset: 0,
      nextCourse: null, nextRecord: null, nextOutlet: null,
      grants: [], grantOffset: 0, nextGrant: null,
      materials: [], nextMaterial: null, recordId: '',
      history: [], nextHistory: null,
      outlet: '', status: '', banner: '', error: false,
    };
    let busy = false;

    function button(action, label, id = '', appearance = '') {
      return `<button type="button" class="button ${appearance}" data-training-action="${action}" data-id="${esc(id)}">${label}</button>`;
    }

    function banner(message, error = false) {
      state.banner = message;
      state.error = error;
      const target = container.querySelector('[data-training-banner]');
      if (!target) return;
      target.textContent = message;
      target.className = message ? 'notice' + (error ? '' : ' info') : '';
      target.setAttribute('role', error ? 'alert' : 'status');
    }

    async function loadCourses() {
      const page = await api('/training/courses?' + new URLSearchParams({ offset: state.courseOffset }));
      state.courses = page.items;
      state.nextCourse = page.nextOffset;
    }

    async function loadRecords() {
      const params = new URLSearchParams({ offset: state.recordOffset });
      if (state.outlet) params.set('outlet', state.outlet);
      if (state.status) params.set('status', state.status);
      const page = await api('/training/records?' + params);
      state.records = page.items;
      state.nextRecord = page.nextOffset;
    }

    async function loadOutlets(offset = 0) {
      const params = new URLSearchParams({ offset });
      const page = await api('/training/outlets?' + params);
      state.outlets = offset === 0 ? page.items : state.outlets.concat(page.items);
      state.nextOutlet = page.nextOffset;
    }

    async function loadMaterials(id, offset = 0) {
      const page = await api(pathForRecord(id) + '/materials?' + new URLSearchParams({ offset }));
      state.materials = offset === 0 ? page.items : state.materials.concat(page.items);
      state.nextMaterial = page.nextOffset;
    }

    async function loadHistory(id, offset = 0) {
      const page = await api(pathForRecord(id) + '/history?' + new URLSearchParams({ offset }));
      state.history = offset === 0 ? page.items : state.history.concat(page.items);
      state.nextHistory = page.nextOffset;
    }

    async function loadGrants() {
      const page = await api('/training/review-grants?' + new URLSearchParams({ offset: state.grantOffset }));
      state.grants = page.items;
      state.nextGrant = page.nextOffset;
    }

    function courseEditor(course = null) {
      return `<form data-training-form="${course ? 'edit-course' : 'course'}" data-id="${esc(course?.id)}" data-version="${esc(course?.version)}">
        <label class="field"><span>课程名称</span><input name="title" maxlength="100" required value="${esc(course?.title)}"></label>
        <label class="field"><span>课程内容</span><textarea name="content" rows="6" maxlength="8000" required>${esc(course?.content)}</textarea></label>
        <button class="button primary" type="submit">${course ? '保存修改' : '新建草稿'}</button>
      </form>`;
    }

    function courseCard(course) {
      return `<article class="record">
        <div class="record-top"><div><h3>${esc(course.title)}</h3><small>${esc(localTime(course.updatedAt))}</small></div>
          <span class="chip">${courseStatuses[course.status]}</span></div>
        <details><summary>查看课程内容</summary><p style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(course.content)}</p></details>
        ${course.status === 'draft' ? `<details><summary>编辑课程草稿</summary>${courseEditor(course)}</details>
          ${button('publish', '发布课程', course.id)}` : ''}
        ${course.status === 'published' ? button('archive', '归档课程', course.id) : ''}
      </article>`;
    }

    function row(record) {
      const selected = state.recordId === record.id;
      const reviewAction = record.status === 'submitted' ? ['accept', 'return']
        : record.status === 'materials_approved' ? ['complete'] : [];
      const materials = selected && state.materials.map(file => `<div class="actions">
        <span>第 ${file.revision} 次 · ${esc(file.name)} · ${esc(localTime(file.createdAt))}</span>
        ${button('file', '下载资料', file.id)}
      </div>`).join('');
      return `<article class="record" data-training-record="${esc(record.id)}">
        <div class="record-top"><div><h3>${esc(record.learner)}</h3><small>${esc(record.courseTitle)} · ${esc(record.outletName)}</small></div>
          <span class="chip">${recordStatuses[record.status]}</span></div>
        <p>更新于 ${esc(localTime(record.updatedAt))}</p>
        ${record.note ? `<p>网点可见说明 · ${esc(record.note)}</p>` : ''}
        ${record.reviewedBy ? `<p>经办账号 · ${esc(record.reviewedBy)}</p>` : ''}
        ${button('materials', selected ? '收起资料' : '查看学员资料', record.id)}
        ${selected ? `<section><h4>提交记录</h4>${materials || empty('该学员尚未提交培训资料。')}
          ${state.nextMaterial !== null ? button('more-materials', '查看更多记录', record.id) : ''}
          ${state.history.length ? `<h4>处理记录</h4>${state.history.map(event =>
            `<p>${recordStatuses[event.status]} · ${esc(localTime(event.createdAt))} · ${esc(event.reviewedBy)}<br>
              ${esc(event.note)}</p>`).join('')}` : ''}
          ${state.nextHistory !== null ? button('more-history', '查看更多处理记录', record.id) : ''}
          ${reviewAction.length ? `<form data-training-form="review" data-id="${esc(record.id)}" data-version="${record.version}">
            <label class="field"><span>处理决定</span><select name="action">${reviewAction.map(action =>
              `<option value="${action}">${reviewLabels[action]}</option>`).join('')}</select></label>
            <label class="field"><span>处理说明（网点可见）</span><textarea name="note" rows="3" maxlength="500" required></textarea></label>
            <button class="button primary" type="submit">保存处理结果</button>
          </form>` : ''}
        </section>` : ''}
      </article>`;
    }

    function pagination(type, offset, next) {
      return (offset ? button('previous-' + type, '上一页') : '') +
        (next !== null ? button('next-' + type, '下一页') : '');
    }

    function grantsPanel(outletItems) {
      return panel('培训审核授权', `<details${state.grants.length ? ' open' : ''}><summary>配置区域运营的培训审核范围</summary>
        <form data-training-form="grant" class="actions">
          <label class="field"><span>员工个人账号</span><input name="staffId" required maxlength="100" placeholder="按人员与交接中的账号填写"></label>
          <label class="field"><span>授权网点</span><select name="outletId" required><option value="">请选择网点</option>${outletItems}</select></label>
          <label class="field"><span>授权操作</span><select name="enabled"><option value="yes">授予</option><option value="no">撤销</option></select></label>
          <button class="button primary" type="submit">保存培训审核授权</button>
        </form>
        ${state.nextOutlet !== null ? button('more-outlets', '加载更多网点') : ''}
        <p>有效人员须已有该网点的区域审核权限。</p>
        ${state.grants.map(grant => `<article class="record">
          <div class="record-top"><strong>${esc(grant.staffName || grant.staffId)} · ${esc(grant.outletName || grant.outletId)}</strong>
          <span class="chip">${grant.enabled ? '已授权' : '已撤销'}</span></div>
          <small>${esc(grant.staffId)} · ${esc(localTime(grant.updatedAt))}</small>
        </article>`).join('') || empty('暂无区域培训审核授权。')}
        <div class="actions">${pagination('grant', state.grantOffset, state.nextGrant)}</div></details>`);
    }

    function render() {
      if (!container.isConnected) return;
      const outletItems = state.outlets.map(item => `<option value="${esc(item.id)}"${state.outlet === item.id ? ' selected' : ''}>
        ${esc(item.name || item.id)}</option>`).join('');
      container.innerHTML = `<p data-training-banner></p>
        ${manager ? panel('课程发布', `<details><summary>新建课程</summary>${courseEditor()}</details>${state.courses.map(courseCard).join('') ||
          empty('暂无课程。新增草稿并发布后，网点负责人可查看。')}
          <div class="actions">${pagination('course', state.courseOffset, state.nextCourse)}</div>`) : ''}
        ${panel('学员进度与资料审核', `<form data-training-form="filter" class="actions">
          <label class="field"><span>筛选网点</span><select name="outlet"><option value="">全部授权网点</option>${outletItems}</select></label>
          <label class="field"><span>筛选状态</span><select name="status">
            <option value="">全部状态</option>${Object.entries(recordStatuses).map(([value,label]) =>
              `<option value="${value}"${state.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          <button class="button" type="submit">筛选</button>
        </form>
        ${state.nextOutlet !== null ? button('more-outlets', '加载更多网点') : ''}
        ${state.records.map(row).join('') || empty('当前范围内暂无学员培训记录。')}
        <div class="actions">${pagination('record', state.recordOffset, state.nextRecord)}</div>`)}
        ${manager ? grantsPanel(outletItems) : ''}`;
      banner(state.banner, state.error);
    }

    async function refreshRecords() {
      await loadRecords();
      if (state.recordId && !state.records.some(record => record.id === state.recordId)) state.recordId = '';
    }

    async function run(source, operation, { redraw = true } = {}) {
      if (busy) return;
      busy = true;
      banner('');
      if (source) source.disabled = true;
      try {
        await operation();
        if (redraw) render();
      } catch (error) {
        banner(error.message, true);
      } finally {
        busy = false;
        if (source?.isConnected) source.disabled = false;
      }
    }

    container.addEventListener('submit', event => {
      const form = event.target.closest('[data-training-form]');
      if (!form) return;
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form));
      void run(event.submitter, async () => {
        if (form.dataset.trainingForm === 'filter') {
          state.outlet = payload.outlet;
          state.status = payload.status;
          state.recordOffset = 0;
          state.recordId = '';
          return loadRecords();
        }
        if (form.dataset.trainingForm === 'review') {
          const id = form.dataset.id;
          await write(session.subject, pathForRecord(id) + '/review', { ...payload, version: Number(form.dataset.version) });
          await Promise.all([refreshRecords(), loadHistory(id)]);
          return banner('处理结果已保存。');
        }
        if (form.dataset.trainingForm === 'grant') {
          await write(session.subject, '/training/review-grants', { ...payload, enabled: payload.enabled === 'yes' });
          state.grantOffset = 0;
          await loadGrants();
          return banner('培训审核授权已保存。');
        }
        const id = form.dataset.id;
        await write(session.subject, '/training/courses' + (id ? '/' + encodeURIComponent(id) : ''),
          id ? { ...payload, status: 'draft', version: Number(form.dataset.version) } : payload);
        state.courseOffset = 0;
        await loadCourses();
        banner('课程草稿已保存。');
      });
    });

    container.addEventListener('click', event => {
      const control = event.target.closest('[data-training-action]');
      if (!control) return;
      const action = control.dataset.trainingAction;
      const id = control.dataset.id;
      if (action === 'file') {
        return void run(control, async () => {
          const file = state.materials.find(item => item.id === id);
          if (!file) throw new Error('资料记录已更新，请刷新后下载。');
          const { blob } = await api('/training/materials/' + encodeURIComponent(id) + '/content', { binary: true });
          const href = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.download = file.name;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(href), 5000);
          banner('下载已开始。');
        }, { redraw: false });
      }
      void run(control, async () => {
        if (action === 'materials') {
          if (state.recordId === id) { state.recordId = ''; return; }
          await Promise.all([loadMaterials(id), loadHistory(id)]);
          state.recordId = id;
        } else if (action === 'more-materials') {
          await loadMaterials(id, state.nextMaterial);
        } else if (action === 'more-history') {
          await loadHistory(id, state.nextHistory);
        } else if (action === 'more-outlets') {
          await loadOutlets(state.nextOutlet);
        } else if (action === 'next-course' || action === 'previous-course') {
          state.courseOffset = action === 'next-course' ? state.nextCourse : Math.max(0, state.courseOffset - 25);
          await loadCourses();
        } else if (action === 'next-record' || action === 'previous-record') {
          state.recordOffset = action === 'next-record' ? state.nextRecord : Math.max(0, state.recordOffset - 25);
          state.recordId = '';
          await loadRecords();
        } else if (action === 'next-grant' || action === 'previous-grant') {
          state.grantOffset = action === 'next-grant' ? state.nextGrant : Math.max(0, state.grantOffset - 25);
          await loadGrants();
        } else if (action === 'publish' || action === 'archive') {
          const course = state.courses.find(course => course.id === id);
          if (!course) throw new Error('课程已更新，请刷新后重试。');
          await write(session.subject, '/training/courses/' + encodeURIComponent(id), {
            status: action === 'publish' ? 'published' : 'archived', version: course.version,
          });
          await loadCourses();
          banner(action === 'publish' ? '课程已发布。' : '课程已归档，已登记学员的记录继续保留。');
        } else if (action === 'retry') {
          await initialLoad();
        }
      });
    });

    async function initialLoad() {
      await Promise.all([loadOutlets(), loadRecords(), ...(manager ? [loadCourses(), loadGrants()] : [])]);
    }
    container.innerHTML = `<p data-training-banner role="status">正在读取培训信息…</p>${button('retry', '重新加载')}`;
    void run(null, initialLoad);
  }

  return { canOpen, mount };
}
