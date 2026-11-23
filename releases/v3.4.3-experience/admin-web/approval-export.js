'use strict';

const permittedRoles = ['manager', 'ops', 'finance', 'regional', 'location'];

export function approvalExportUi({api, button, field, select, submit, form, notice, panel, pair, empty, esc, modal, heading, download, toast, roles, session}) {
  let model = null;
  let identity = null;
  let query = {q: '', offset: 0};

  function allowed(current) {
    return current && current.subject !== current.actor && permittedRoles.includes(current.actor);
  }

  async function load(isCurrent) {
    const subject = session()?.subject;
    if (identity !== subject) query = {q: '', offset: 0};
    const result = await api('/approval-exports?' + new URLSearchParams(query));
    if (isCurrent()) {
      identity = subject;
      model = result;
    }
  }

  const categoryLabel = key => model.categories[key]?.label || key;

  function fieldInputs(category, chosen, allowedKeys) {
    const options = model.categories[category]?.fields || [];
    return options.filter(([key]) => !allowedKeys || allowedKeys.includes(key)).map(([key, label]) =>
      '<label class="choice"><input type="checkbox" name="fields" value="' + esc(key) + '" ' +
      (chosen.includes(key) ? 'checked' : '') + '> ' + esc(label) + '</label>',
    ).join(' ');
  }

  function render() {
    const manager = model.canManage;
    const title = '审批表单导出';
    const header = heading(title, manager ? '按个人、网点和表单类型授予导出字段。' : '按已授权的网点及字段导出审批表单。',
      manager ? button('新增导出授权', 'approval-export-grant-new', {}, 'primary') : '');
    const search = form('approval-export-search', field('q', '搜索网点或账号', query.q, 'search', 'maxlength="100"') + submit('搜索'));
    const pagination = '<div class="pagination">' +
      (model.offset > 0 ? button('上一页', 'approval-export-page', {offset: Math.max(0, model.offset - model.limit)}) : '') +
      (model.hasMore ? button('下一页', 'approval-export-page', {offset: model.offset + model.limit}) : '') + '</div>';
    const rows = model.items.map((row, index) => {
      const category = model.categories[row.category];
      const labels = Object.fromEntries(category.fields);
      const actions = manager
        ? button('调整授权', 'approval-export-grant-edit', {index}) +
          (row.enabled ? button('撤销授权', 'approval-export-grant-revoke', {index}) : '')
        : button('下载审批表单', 'approval-export-download', {index}, 'primary');
      return '<tr><td>' + esc(row.outletName || row.outlet) + '</td><td>' + esc(categoryLabel(row.category)) +
        '</td>' + (manager ? '<td>' + esc(row.staffName || row.subject) + '<small>' + esc(roles[row.role] || row.role) + '</small></td>' : '') +
        '<td>' + esc(row.fields.map(key => labels[key] || key).join('、')) + '</td>' +
        (manager ? '<td>' + (row.enabled ? '已授权' : '已撤销') + '</td>' : '') + '<td><div class="actions">' + actions + '</div></td></tr>';
    }).join('');
    const table = rows ? '<div class="table-wrap"><table><thead><tr><th>网点</th><th>表单类型</th>' +
      (manager ? '<th>员工</th>' : '') + '<th>导出字段</th>' + (manager ? '<th>状态</th>' : '') +
      '<th>操作</th></tr></thead><tbody>' + rows + '</tbody></table></div>' :
      empty(query.q ? '本次搜索没有匹配的授权。' : manager ? '暂无导出授权。' : '暂无审批表单导出权限，请联系总管理员。');
    return header + panel(manager ? '导出授权管理' : '我的导出授权', search + table + pagination);
  }

  function optionRows(rows) {
    return rows.map(row => '<option value="' + esc(row.id) + '">' + esc(row.name || row.id) + '</option>').join('');
  }

  async function loadOptions(group, q = '') {
    const params = new URLSearchParams({group, q});
    return (await api('/approval-exports?' + params)).items;
  }

  function selector(group, name, label, rows) {
    const id = 'approval-export-' + group;
    return field(name, label, '', 'text', 'required maxlength="120" list="' + id + '" data-export-options="' + group + '"') +
      '<datalist id="' + id + '">' + optionRows(rows) + '</datalist>';
  }

  async function openGrant(row) {
    const current = session();
    const groups = row ? [] : await Promise.all(['staff','outlets'].map(group => loadOptions(group)));
    if (current !== session() || !model?.canManage) return;
    const chosen = row?.category || Object.keys(model.categories)[0];
    const controls = row
      ? pair('个人员工', row.staffName || row.subject) + pair('网点', row.outletName || row.outlet) + pair('表单类型', categoryLabel(chosen)) +
        field('subject', '', row.subject, 'hidden') + field('outlet', '', row.outlet, 'hidden') + field('category', '', chosen, 'hidden')
      : selector('staff', 'subject', '个人账号或姓名搜索', groups[0]) + selector('outlets', 'outlet', '网点编号或名称搜索', groups[1]) +
        select('category', '表单类型', Object.entries(model.categories).map(([key, data]) => [key, data.label]),
          chosen, 'data-export-category');
    modal(row ? '调整审批表单授权' : '新增审批表单授权', form('approval-export-save',
      controls + '<fieldset><legend>获准导出的字段</legend><div data-export-fields>' +
      fieldInputs(chosen, row?.fields || []) + '</div></fieldset>' +
      notice('先选人员和网点，再明确勾选字段。授权只用于一个网点，保存后立即生效。', true) + submit('保存导出授权')));
  }

  function revoke(row) {
    modal('撤销审批表单授权', form('approval-export-save',
      pair('个人员工', row.staffName || row.subject) + pair('网点与表单', (row.outletName || row.outlet) + ' · ' + categoryLabel(row.category)) +
      field('subject', '', row.subject, 'hidden') + field('outlet', '', row.outlet, 'hidden') +
      field('category', '', row.category, 'hidden') + field('enabled', '', 'false', 'hidden') +
      notice('确认后，该员工在此网点的对应表单导出权限立即撤销。', true) + submit('确认撤销授权')));
  }

  function openDownload(row) {
    const category = model.categories[row.category];
    modal('下载审批表单', form('approval-export-file',
      pair('网点与表单', (row.outletName || row.outlet) + ' · ' + category.label) +
      field('outlet', '', row.outlet, 'hidden') + field('category', '', row.category, 'hidden') +
      (row.category === 'requests' ? '' : field('month', '报告或核验月份', '', 'month')) +
      select('status', '处理状态', [['','全部状态'],...category.statuses]) +
      '<div class="form-grid">' + field('from', '提交日期起（北京时间）', '', 'date') +
      field('to', '提交日期止（北京时间）', '', 'date') + '</div>' +
      '<fieldset><legend>选择导出字段</legend><div>' + fieldInputs(row.category, row.fields, row.fields) + '</div></fieldset>' +
      notice('单次下载覆盖当前所选网点。超过 1000 行请缩小范围。', true) + submit('下载 CSV')));
  }

  function action(data) {
    if (data.action === 'approval-export-page') {
      query.offset = Number(data.offset);
      return true;
    }
    if (data.action === 'approval-export-grant-new') return openGrant();
    const row = model.items[Number(data.index)];
    if (!row) throw Error('权限已更新，请刷新页面后重试');
    if (data.action === 'approval-export-grant-edit') return openGrant(row);
    if (data.action === 'approval-export-grant-revoke') return revoke(row);
    return openDownload(row);
  }

  async function submitAction(cmd, node, data) {
    if (cmd === 'approval-export-search') {
      query = {q: data.q, offset: 0};
      return 'refresh';
    }
    const fields = new FormData(node).getAll('fields');
    if (cmd === 'approval-export-save') {
      await api('/approval-exports/grants', {method: 'POST', body: {
        subject: data.subject.trim(), outlet: data.outlet.trim(), category: data.category, fields, enabled: data.enabled !== 'false',
      }});
      toast(data.enabled === 'false' ? '导出授权已撤销' : '导出授权已保存');
      return 'saved';
    }
    if (!fields.length) throw Error('请至少选择一个已授权字段');
    const query = new URLSearchParams(Object.entries({
      outlet: data.outlet, category: data.category, fields: fields.join(','),
      month: data.month, status: data.status, from: data.from, to: data.to,
    }).filter(([, value]) => value));
    const result = await api('/approval-exports/csv?' + query, {binary: true});
    download(result.blob, '九盈英才_审批表单.csv', result.type);
    toast('审批表单已导出');
    return 'downloaded';
  }

  async function change(node) {
    if (node.hasAttribute('data-export-category')) {
      node.form.querySelector('[data-export-fields]').innerHTML = fieldInputs(node.value, []);
      return true;
    }
    const group = node.dataset.exportOptions;
    if (!group) return false;
    const value = node.value.trim();
    const list = node.list;
    const rows = await loadOptions(group, value);
    if (node.isConnected && node.value.trim() === value && list) list.innerHTML = optionRows(rows);
    return true;
  }

  function reset() {
    identity = null;
    model = null;
    query = {q: '', offset: 0};
  }

  return {allowed, load, render, action, submitAction, change, reset};
}
