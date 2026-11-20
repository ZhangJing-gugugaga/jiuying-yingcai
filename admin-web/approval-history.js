import { taskDate } from './tasks.js';

const COLLECTIONS = new Set([
  'reports', 'requests', 'verifications', 'adjustments', 'feeProposals',
  'summaryAdjustments', 'billCorrections', 'exemptions', 'supportTickets', 'supportChats'
]);
const LIMIT = 20;

export function approvalHistory({ api, esc, button, empty, modal, roles, metrics, pair }) {
  const pages = new WeakMap();
  const collectionName = key => ({ 'support.tickets': 'supportTickets', 'support.chats': 'supportChats' }[key] || key);
  const available = key => COLLECTIONS.has(collectionName(key));
  const trigger = (key, id) => id && available(key) ? button('审批与处理历史', 'approval-open', {
    collection: collectionName(key), id
  }) : '';
  const mount = (key, id) => id && available(key) ? `<section class="approval-history" data-approval-collection="${esc(collectionName(key))}" data-approval-id="${esc(id)}" aria-label="审批与处理历史"><h3>审批与处理历史</h3><div class="approval-body" aria-live="polite"><p role="status">正在读取处理记录…</p></div></section>` : '';

  function eventMarkup(event) {
    const role = roles[event.role] || event.role;
    const actor = event.actorName || event.actorId;
    const by = [actor, event.actor || role].filter(Boolean);
    const unique = [...new Set(by)].join(' · ');
    const meta = [
      event.version != null ? 'V' + event.version : null,
      event.result ? '结果 · ' + event.result : null,
      event.next ? '下一步 · ' + event.next : null
    ].filter(Boolean);
    const photoIds = [...new Set([event.raw?.before?.photoId, event.raw?.after?.photoId].filter(id => typeof id === 'string' && id))];
    const attachments = photoIds.length ? '<div class="actions approval-attachments">' +
      photoIds.map(id => button('查看核验附件', 'view-photo', { id })).join('') + '</div>' : '';
    const difference = Object.entries(event.raw?.after?.correctionDiff || {});
    const diff = difference.length ? `<details><summary>查看版本差异</summary>${difference.map(([key, values]) => pair(metrics[key] || key, String(values.before ?? '未填') + ' → ' + String(values.after ?? '未填'))).join('')}</details>` : '';
    const raw = event.raw && (event.objectType !== 'requests' || event.auditId) ? `<details><summary>查看原始审计</summary><pre class="audit">${esc(JSON.stringify(event.raw, null, 2))}</pre></details>` : '';
    return `<li><div class="approval-event"><b>${esc(event.label || event.action)}</b><time datetime="${esc(event.at)}">${esc(taskDate(event.at))}</time></div>${unique ? `<small>${esc(unique)}</small>` : ''}${meta.length ? `<div class="approval-meta">${meta.map(value => `<span>${esc(value)}</span>`).join('')}</div>` : ''}${event.note ? `<p>${esc(event.note)}</p>` : ''}${event.publicNote&&event.publicNote!==event.note ? pair('申请人可见说明',event.publicNote) : ''}${attachments}${diff}${raw}</li>`;
  }

  async function load(element, offset = 0) {
    if (!element) return;
    const body = element.querySelector('.approval-body');
    const { approvalCollection: collection, approvalId: id } = element.dataset;
    if (!available(collection) || !id) return;
    const revision = { offset };
    pages.set(element, revision);
    body.innerHTML = '<p role="status">正在读取处理记录…</p>';
    try {
      const query = new URLSearchParams({ limit: LIMIT, offset });
      if (collection === 'reports') query.set('lineage', '1');
      const data = await api('/approval-history/' + encodeURIComponent(collection) + '/' + encodeURIComponent(id) + '?' + query);
      if (!element.isConnected || pages.get(element) !== revision) return;
      body.innerHTML = data.items.length ? `<ol class="timeline">${data.items.map(eventMarkup).join('')}</ol>` : empty('暂无可显示的审批与处理记录。');
      if (data.offset > 0 || data.hasMore) body.innerHTML += `<div class="pagination approval-pagination">${data.offset > 0 ? button('较新记录','approval-page',{offset:Math.max(0, data.offset-LIMIT)}) : ''}${data.hasMore ? button('较早记录','approval-page',{offset:data.offset+LIMIT}) : ''}</div>`;
    } catch (error) {
      if (!element.isConnected || pages.get(element) !== revision) return;
      const denied = error.status === 403 || error.status === 404;
      const text = denied ? '当前账号无权查看此记录的审批历史。' : error.message + (error.requestId ? ' · 请求编号 ' + error.requestId : '');
      body.innerHTML = `<p class="form-error" role="alert">${esc(text)}</p>${denied ? '' : button('重试','approval-page',{offset})}`;
    }
  }

  function open(key, id) {
    if (!available(key) || !id) return;
    modal('审批与处理历史', mount(key, id));
    return load(document.querySelector('#modal .approval-history'));
  }

  return { trigger, mount, load, open };
}
