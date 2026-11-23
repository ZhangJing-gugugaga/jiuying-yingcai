const statuses = [['pending', '待审核'], ['returned', '已退回'], ['approved', '已通过'], ['all', '全部状态']];
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
const pageSize = 25;
const dateTime = new Intl.DateTimeFormat('zh-CN', {dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai'});
const formatDate = value => value && !Number.isNaN(Date.parse(value)) ? dateTime.format(new Date(value)) : '—';
const errorText = error => error.message + (error.requestId ? ' · 请求编号 ' + error.requestId : '');

export function onboardingDesk({api, session, active, heading, panel, pair, chip, empty, notice, select, field, area, button, submit, esc, modal, dialog, refresh, toast, trialRecord}) {
  let config, page, configError, pageError, pending, retry, previewUrl;
  let status = 'pending', offset = 0;
  const allowed = user => (user?.role || user?.actor) === 'manager';
  const current = user => session() === user && allowed(user) && active();
  const endpoint = id => '/onboarding/applications/' + encodeURIComponent(id);

  function releasePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
  }

  function reset() {
    releasePreview();
    config = page = configError = pageError = pending = retry = undefined;
    status = 'pending';
    offset = 0;
  }

  async function load(isCurrent) {
    const queries = new URLSearchParams({status, offset, limit: pageSize});
    const [configuration, applications] = await Promise.allSettled([
      api('/onboarding/config'), api('/onboarding/applications?' + queries),
    ]);
    if (!isCurrent()) return;
    config = configuration.value;
    configError = configuration.reason;
    page = applications.value;
    pageError = applications.reason;
  }

  function configuration() {
    if (configError) return notice(errorText(configError)) + button('重新加载', 'refresh');
    return (config?.enabled
      ? pair('状态', '收款码已启用') + pair('企业收款方', config.payee)
      : pair('状态', '收款码未启用')) + '<div class="actions">'
      + button(config?.enabled ? '更换企业收款码' : '设置企业收款码', 'onboarding-configure', {}, 'primary')
      + (config?.enabled ? button('查看企业收款码', 'onboarding-qr') + button('停用收款码', 'onboarding-disable') : '')
      + '</div>';
  }

  function list() {
    const filters = `<div class="list-controls"><div class="list-search">${select('onboardingStatus', '申请状态', statuses, status, 'data-onboarding-filter')}</div>${page ? `<div class="pagination">
      <span>共 <b>${page.total}</b> 条</span>
      <button type="button" class="button" data-action="onboarding-prev" aria-label="上一页" ${offset ? '' : 'disabled'}>←</button>
      <button type="button" class="button" data-action="onboarding-next" aria-label="下一页" ${page.hasMore ? '' : 'disabled'}>→</button>
      </div>` : ''}</div>`;
    if (pageError) return filters + notice(errorText(pageError)) + button('重新加载', 'refresh');
    if (!page?.items.length) return filters + empty('暂无符合当前状态的加盟申请。');
    return filters + `<div class="table-wrap"><table><thead><tr><th>申请人</th><th>申请单位</th><th>提交时间</th><th>状态</th><th>操作</th></tr></thead><tbody>${page.items.map(item => `<tr>
      <td>${esc(item.name)}</td><td>${esc(item.organization || '—')}</td><td>${esc(formatDate(item.submittedAt))}</td><td>${chip(item.status)}</td>
      <td>${button(item.status === 'pending' ? '审核申请' : '查看申请', 'onboarding-review', {id: item.id})}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function render() {
    return heading('加盟申请', '维护固定企业收款码，核实企业到账后审核申请。')
      + panel('企业收款码', configuration()) + panel('申请记录', list());
  }

  function show(title, content) {
    modal(title, content);
    return dialog().querySelector('#modalBody');
  }

  const markup = (action, content) => `<form data-onboarding-form="${action}">${content}</form>`;
  const preview = () => `<p data-onboarding-preview-feedback class="muted" role="status"></p><img data-onboarding-preview hidden style="max-width:100%;max-height:55vh" alt="">`;

  function setPreview(container, blob, alt, ready) {
    const image = container.querySelector('[data-onboarding-preview]');
    const feedback = container.querySelector('[data-onboarding-preview-feedback]');
    releasePreview();
    const url = URL.createObjectURL(blob);
    previewUrl = url;
    image.onload = () => {
      if (previewUrl !== url) return;
      feedback.textContent = '';
      ready?.();
    };
    image.onerror = () => {
      if (previewUrl !== url) return;
      feedback.textContent = '无法显示图片，请重新选择或刷新后重试。';
      image.hidden = true;
      releasePreview();
    };
    image.alt = alt;
    image.src = url;
    image.hidden = false;
  }

  async function loadImage(container, id, alt, ready) {
    const owner = session();
    const feedback = container.querySelector('[data-onboarding-preview-feedback]');
    feedback.textContent = '正在加载图片…';
    const open = () => current(owner) && feedback.isConnected && dialog().open;
    try {
      const result = await api('/files/' + encodeURIComponent(id), {binary: true});
      if (open()) setPreview(container, result.blob, alt, ready);
    } catch (error) {
      if (open()) feedback.textContent = '图片读取失败。' + errorText(error);
    }
  }

  function configure() {
    show('设置企业收款码', markup('configure',
      field('payee', '企业收款方', config?.payee || '', 'text', 'required maxlength="120"')
      + field('qrFile', '企业收款码图片', '', 'file', 'required accept="image/png,image/jpeg,image/webp"')
      + preview()
      + '<label class="check"><input type="checkbox" name="confirmed" required>我已核对企业收款方和收款码</label>'
      + submit('保存并启用')));
  }

  function activation(item) {
    const stage = item.activationStatus;
    const label = {not_issued:'待签发激活码', issued:'已签发，待激活', expired:'激活码已过期',
      activated:'账号已激活', unavailable:'账号暂不可用'}[stage] || '暂时无法确认开通状态';
    const canIssue = item.accountActor && ['not_issued','issued','expired'].includes(stage);
    return pair('账号开通状态', label)
      + (stage === 'issued' || stage === 'expired' ? pair('上次签发', formatDate(item.activationIssuedAt))
        + pair('有效期至', formatDate(item.activationExpiresAt)) : '')
      + (stage === 'issued' ? notice('重新签发会使当前激活码失效。', true) : '')
      + (canIssue ? button(stage === 'not_issued' ? '签发激活码' : '重新签发激活码', 'activation',
        {actor:item.accountActor, 'record-id':item.id}, 'primary') : '');
  }

  async function review(item) {
    const sample=item.id===trialRecord?.();
    const details = pair('申请人', item.name) + pair('手机号', item.mobile) + pair('申请单位', item.organization || '—')
      + pair('提交时间', formatDate(item.submittedAt)) + (item.payee ? pair('申请时的收款方', item.payee) : '')
      + (item.note ? pair('申请说明', item.note) : '') + (item.reviewedAt ? pair('审核时间', formatDate(item.reviewedAt)) : '')
      + (item.reviewNote ? pair('审核说明', item.reviewNote) : '')
      + (item.settlementReference ? pair(sample?'试用凭证号':'企业到账凭证号', item.settlementReference) : '');
    const controls = item.status === 'pending' ? markup('review',
      field('id', '', item.id, 'hidden') + field('version', '', item.version, 'hidden')
      + notice(sample?'本笔为隔离试用。核对样例截图后，可填写试用凭证号 TRIAL-20261121-01。':'请在企业账户核对到账记录，并填写唯一到账凭证号。', true)
      + field('settlementReference', sample?'试用凭证号':'企业到账凭证号', '', 'text', 'maxlength="100"')
      + area('note', '给申请人的审核说明（退回时必填）', '', 'maxlength="800"')
      + '<label class="check"><input type="checkbox" name="settled">'+(sample?'我已核对试用付款截图':'我已核实企业账户实际到账')+'</label>'
      + '<div class="form-actions"><button type="submit" class="button" value="return">退回补充</button><button type="submit" class="button primary" value="approve" disabled>通过审核</button></div>')
      : item.status === 'approved' ? activation(item) : '';
    const content = show('加盟申请详情', details + '<h3 class="section-title">付款截图</h3>' + preview() + controls);
    const approve = content.querySelector('button[value="approve"]');
    await loadImage(content, item.fileId, '申请人提交的付款截图', () => {
      if (approve) approve.disabled = false;
    });
  }

  async function action({action, id}) {
    if (!current(session())) return;
    if (action === 'onboarding-open-record') return openRecord(id);
    if (action === 'onboarding-prev' || action === 'onboarding-next') {
      offset = Math.max(0, offset + (action === 'onboarding-prev' ? -pageSize : pageSize));
      return refresh();
    }
    if (action === 'onboarding-configure') return configure();
    if (action === 'onboarding-disable') {
      return show('停用企业收款码', markup('disable', notice('停用后暂停新的加盟收款申请，已有退回申请仍可补交。') + submit('确认停用')));
    }
    if (action === 'onboarding-qr' && config?.qrFileId) {
      const content = show('企业收款码', pair('企业收款方', config.payee) + preview());
      return loadImage(content, config.qrFileId, '已启用的企业收款码');
    }
    const item = page?.items.find(record => record.id === id);
    if (action === 'onboarding-review' && item) return review(item);
  }

  async function openRecord(id) {
    const owner=session();
    if (!current(owner)) return;
    const result=await api('/onboarding/applications?id='+encodeURIComponent(id));
    if(current(owner)&&result.items[0])return review(result.items[0]);
  }

  function change(input) {
    if (input.hasAttribute('data-onboarding-filter')) {
      status = input.value;
      offset = 0;
      return refresh();
    }
    const form = input.closest('form[data-onboarding-form="configure"]');
    if (!form || !['qrFile', 'payee'].includes(input.name)) return;
    form.elements.confirmed.checked = false;
    if (input.name !== 'qrFile') return;
    const file = input.files?.[0];
    if (file && imageTypes.includes(file.type) && file.size > 0 && file.size <= 5 * 1024 * 1024) {
      form.dataset.uploadId = '';
      setPreview(form, file, '待启用的企业收款码');
    } else {
      releasePreview();
      form.querySelector('[data-onboarding-preview]').hidden = true;
      form.querySelector('[data-onboarding-preview-feedback]').textContent = '请选择5MB以内的 PNG、JPEG 或 WebP 图片。';
      input.value = '';
    }
  }

  async function saveConfig(form, owner) {
    const payee = form.elements.payee.value.trim();
    const file = form.elements.qrFile.files?.[0];
    if (!payee || !form.elements.confirmed.checked || !file || !imageTypes.includes(file.type) || !file.size || file.size > 5 * 1024 * 1024) {
      throw Error('请填写企业收款方，选择收款码并确认核对结果。');
    }
    if (!form.dataset.uploadId) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      if (!current(owner)) return;
      const uploaded = await api('/files', {method: 'POST', body: {name: file.name, type: file.type, base64: btoa(binary), purpose: 'onboarding-qr'}});
      form.dataset.uploadId = uploaded.id;
    }
    if (!current(owner)) return;
    await api('/onboarding/config', {method: 'POST', body: {qrFileId: form.dataset.uploadId, payee, confirmed: true}});
  }

  async function saveReview(form, decision) {
    if (!['approve', 'return'].includes(decision)) return;
    const note = form.elements.note.value.trim();
    const settlementReference = form.elements.settlementReference.value.trim();
    if (decision === 'return' && !note) throw Error('请填写退回原因。');
    if (decision === 'approve' && (!form.elements.settled.checked || settlementReference.length < 4 || settlementReference.length > 100)) {
      const sample = form.elements.id.value === trialRecord?.();
      throw Error(sample?'请核对试用付款截图，并填写 4 至 100 个字符的试用凭证号。':'请确认实际到账，并填写 4 至 100 个字符的到账凭证号。');
    }
    const path = endpoint(form.elements.id.value) + '/review';
    const body = {version: Number(form.elements.version.value), decision, note, ...(decision === 'approve' ? {settlementReference} : {})};
    const fingerprint = JSON.stringify({path, body});
    if (retry?.fingerprint !== fingerprint) retry = {fingerprint, key: crypto.randomUUID()};
    const result = await api(path, {method: 'POST', body, key: retry.key});
    if (retry?.fingerprint === fingerprint) retry = undefined;
    return result;
  }

  async function save(form, trigger) {
    const owner = session();
    if (!current(owner) || pending?.owner === owner || !trigger || trigger.disabled) return;
    const lock = {owner};
    pending = lock;
    const editable = Array.from(form.elements).filter(element => !element.disabled);
    editable.forEach(element => { element.disabled = true; });
    form.querySelector('[data-onboarding-error]')?.remove();
    const action = form.dataset.onboardingForm;
    const visible = () => current(owner) && form.isConnected && dialog().open;
    try {
      let result;
      if (action === 'configure') await saveConfig(form, owner);
      if (action === 'disable') await api('/onboarding/config', {method: 'POST', body: {enabled: false}});
      if (action === 'review') result = await saveReview(form, trigger.value);
      if (!current(owner)) return;
      if (visible()) {
        if (result?.status === 'approved') show('加盟申请已通过',
          notice('申请人已收到审核通知。请将一次性激活码交给申请人完成账号开通。', true) + activation(result));
        else dialog().close();
      }
      toast(({configure: '企业收款码已启用', disable: '企业收款码已停用', review: result?.status === 'approved' ? '加盟申请已通过' : '加盟申请已退回'})[action]);
      if (action === 'review') offset = 0;
      await refresh();
    } catch (error) {
      if (!visible()) return;
      const alert = document.createElement('div');
      alert.className = 'form-error';
      alert.dataset.onboardingError = '';
      alert.setAttribute('role', 'alert');
      alert.textContent = errorText(error);
      form.prepend(alert);
      if (error.status === 409 && action === 'review') await refresh();
    } finally {
      editable.forEach(element => { element.disabled = false; });
      if (pending === lock) pending = undefined;
    }
  }

  return {allowed, reset, load, render, action, openRecord, change, save, releasePreview};
}
