const { define, api, fmt } = require('../../utils/page');

const PREFIX = '/api/training';
const LABELS = {
  in_progress: '学习中', submitted: '资料待审核', returned: '需补充资料',
  materials_approved: '资料已通过', completed: '培训已完成',
};
const NEXT_STEP = {
  in_progress: '请按课程要求提交学员资料。',
  submitted: '资料已提交，等待总部审核。',
  returned: '请按退回原因重新上传资料。',
  materials_approved: '资料已通过，等待总部确认培训完成。',
  completed: '培训已完成，可查看已提交的资料和处理记录。',
};
const retryKeys = new Map();
const localMutation = async (route, body, identity) => {
  const scope = api.session()?.subject || '';
  const fingerprint = scope + '|' + route + '|' + identity;
  const key = retryKeys.get(fingerprint) || 'training-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  if (!retryKeys.has(fingerprint) && retryKeys.size >= 40) retryKeys.delete(retryKeys.keys().next().value);
  retryKeys.set(fingerprint, key);
  try {
    const result = await api.request(PREFIX + route, 'POST', body, { 'Idempotency-Key': key });
    retryKeys.delete(fingerprint);
    return result;
  } catch (error) {
    if (error.status >= 400 && error.status < 500) retryKeys.delete(fingerprint);
    throw error;
  }
};
const decorateRecord = record => ({
  ...record, label: LABELS[record.status] || '待确认',
  nextStep: NEXT_STEP[record.status] || '',
  mayUpload: ['in_progress', 'returned'].includes(record.status),
  statusStyle: record.status === 'completed' || record.status === 'materials_approved' ? 'ok'
    : record.status === 'returned' ? 'warn' : 'neutral',
  updatedText: fmt.dateText(record.updatedAt?.slice(0, 10)),
});
const putFirst = (records, record) => [record, ...records.filter(row => row.id !== record.id)];
async function readRecord(id, outlet) {
  const query = api.query({ outlet });
  return api.request(PREFIX + '/records/' + encodeURIComponent(id) + (query ? '?' + query : ''));
}
const chooseImage = () => new Promise((resolve, reject) => {
  wx.chooseMedia({
    count: 1, mediaType: ['image'], sourceType: ['album', 'camera'],
    sizeType: ['compressed'],
    success: result => resolve(result.tempFiles?.[0] || null),
    fail: error => /cancel/i.test(error.errMsg || '') ? resolve(null) : reject(new Error('无法选取图片，请检查相册或相机权限。')),
  });
});
const readBase64 = filePath => new Promise((resolve, reject) => {
  wx.getFileSystemManager().readFile({
    filePath, encoding: 'base64', success: result => resolve(result.data),
    fail: () => reject(new Error('图片读取失败，请重新选择。')),
  });
});
function materialPayload(base64) {
  if (base64.startsWith('iVBORw0KGgo')) return { name: '学员培训资料.png', type: 'image/png', base64 };
  if (base64.startsWith('/9j/')) return { name: '学员培训资料.jpg', type: 'image/jpeg', base64 };
  if (base64.startsWith('UklGR') && base64.slice(11, 16) === 'XRUJQ') {
    return { name: '学员培训资料.webp', type: 'image/webp', base64 };
  }
  throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
}

Page(define({
  collections: [{ name: 'outlets', visible() { return this.data.session?.role === 'partner'; } }],
  data: {
    tab: 'courses', courses: [], records: [], courseNext: null, recordNext: null,
    outlets: [], outletIndex: 0, selectedOutletId: '', selectedCourse: '', canEnroll: false, isPartner: false,
    recordId: '', materials: [], materialsNext: null, learner: '',
    history: [], historyNext: null, historyLoading: false,
    uploadDraft: null, recordsLoading: false, materialsLoading: false, coursesLoading: false,
    selecting: false, trainingError: '', trainingNotice: '',
  },
  load(query) {
    if (query.id) this.setData({ tab: 'records' });
  },
  async loaded(state) {
    if (this.data.session?.role !== 'partner') {
      this._learnerDrafts?.clear();
      this.setData({ isPartner: false, courses: [], records: [], recordId: '', materials: [], history: [], uploadDraft: null });
      this.updateLeaveWarning();
      return;
    }
    const serial = this._serial;
    const requestedOutlet = this.query.outlet || this.data.selectedOutletId;
    const requestedRecord = this.query.id;
    let ownedOutlets = state.outlets.filter(outlet => outlet.owner);
    let record;
    let detailError = '';
    if (requestedRecord) {
      try {
        record = await readRecord(requestedRecord, requestedOutlet);
        if (serial !== this._serial) return;
        if (!ownedOutlets.some(outlet => outlet.id === record.outletId)) {
          const outlet = await api.detail('outlets', record.outletId);
          if (serial !== this._serial) return;
          ownedOutlets = [outlet, ...ownedOutlets];
        }
      } catch (error) {
        if (serial !== this._serial) return;
        record = null;
        detailError = error.status === 404 ? '这条培训记录暂不可查看，请从通知或学员进度重新打开。' : error.message;
      }
    }
    const selectedId = record?.outletId || requestedOutlet ||
      (!requestedRecord && ownedOutlets.length === 1 && !this.data.pagers.outlets?.hasMore ? ownedOutlets[0].id : '');
    const selected = ownedOutlets.find(outlet => outlet.id === selectedId);
    const outlets = ownedOutlets.length ? [{ id: '', name: '请选择网点' }, ...ownedOutlets] : [];
    const outletIndex = Math.max(0, outlets.findIndex(outlet => outlet.id === selected?.id));
    this.setData({
      isPartner: true, outlets, outletIndex, selectedOutletId: selected?.id || '',
      canEnroll: Boolean(selected && selected.status !== 'closed'),
      trainingError: detailError,
    });
    if (detailError || (this.data.recordId && !record)) this.resetRecordPanel('');
    if (record) {
      this.query.outlet = record.outletId;
      if (this.data.recordId !== record.id) this.resetRecordPanel(record.id);
      this.setData({ records: putFirst(this.data.records, decorateRecord(record)) });
    }
    if (detailError) {
      this.setData({ records: [], recordNext: null });
      return;
    }
    await Promise.all([this.fetchCourses(true), this.fetchRecords(true, record)]);
    if (record && serial === this._serial && this.data.recordId === record.id) {
      await Promise.all([this.fetchMaterials(true), this.fetchHistory(true)]);
    }
  },
  selectTab(event) {
    const tab = event.currentTarget.dataset.tab;
    if (tab !== 'courses' && tab !== 'records' || this.data.busy || this.data.selecting) return;
    this.setData({ tab, trainingError: '', trainingNotice: '' });
  },
  async onPullDownRefresh() {
    try {
      if (!this.data.busy && !this.data.selecting && !this.data.loading) await this.refresh();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  async selectOutlet(event) {
    if (this.data.busy || this.data.selecting || this.data.loading) return;
    const outletIndex = Number(event.detail.value);
    const outlet = this.data.outlets[outletIndex];
    if (!outlet || outlet.id === this.data.selectedOutletId) return;
    if (!await this.confirmDiscardMaterial()) {
      this.setData({ outletIndex: this.data.outletIndex });
      return;
    }
    this.query.outlet = outlet.id;
    delete this.query.id;
    this.resetRecordPanel('');
    this.setData({ outletIndex, selectedOutletId: outlet.id, canEnroll: Boolean(outlet.id && outlet.status !== 'closed'),
      records: [], recordNext: null,
      learner: this.learnerDraft(outlet.id, this.data.selectedCourse), trainingError: '', trainingNotice: '' });
    await this.fetchRecords(true);
  },
  async fetchCourses(reset) {
    if (!reset && (this.data.coursesLoading || this.data.courseNext == null)) return;
    const serial = (this._coursesSerial || 0) + 1;
    this._coursesSerial = serial;
    try {
      this.setData({ coursesLoading: true });
      const result = await api.request(PREFIX + '/courses?' + api.query({ offset: reset ? 0 : this.data.courseNext }));
      if (serial !== this._coursesSerial) return;
      this.setData({ courses: reset ? result.items : this.data.courses.concat(result.items), courseNext: result.nextOffset });
    } catch (error) {
      if (serial === this._coursesSerial) this.setData({ trainingError: error.message });
    } finally {
      if (serial === this._coursesSerial) this.setData({ coursesLoading: false });
    }
  },
  async fetchRecords(reset, featured) {
    if (!reset && (this.data.recordsLoading || this.data.recordNext == null)) return;
    const serial = (this._recordsSerial || 0) + 1;
    this._recordsSerial = serial;
    const outlet = this.data.selectedOutletId;
    if (!outlet) {
      this.setData({ records: [], recordNext: null, recordsLoading: false });
      return;
    }
    try {
      this.setData({ recordsLoading: true });
      const result = await api.request(PREFIX + '/records?' + api.query({
        outlet, offset: reset ? 0 : this.data.recordNext,
      }));
      if (serial !== this._recordsSerial) return;
      const items = result.items.map(decorateRecord);
      const current = this.data.records;
      const rows = reset ? items : current.concat(items.filter(item => !current.some(row => row.id === item.id)));
      const currentRecord = featured && rows.find(row => row.id === featured.id && row.version >= featured.version);
      this.setData({ records: featured ? putFirst(rows, currentRecord || decorateRecord(featured)) : rows, recordNext: result.nextOffset });
    } catch (error) {
      if (serial === this._recordsSerial) this.setData({ trainingError: error.message });
    } finally {
      if (serial === this._recordsSerial) this.setData({ recordsLoading: false });
    }
  },
  moreCourses() { return this.fetchCourses(false); },
  moreRecords() { return this.fetchRecords(false); },
  openCourse(event) {
    if (this.data.busy) return;
    const selectedCourse = event.currentTarget.dataset.id;
    const next = this.data.selectedCourse === selectedCourse ? '' : selectedCourse;
    this.setData({ selectedCourse: next, learner: this.learnerDraft(this.data.selectedOutletId, next), trainingError: '', trainingNotice: '' });
  },
  learnerDraft(outlet, course) {
    return this._learnerDrafts?.get(outlet + '|' + course) || '';
  },
  learnerInput(event) {
    if (!this.data.selectedCourse) return;
    this._learnerDrafts ||= new Map();
    this._learnerDrafts.set(this.data.selectedOutletId + '|' + this.data.selectedCourse, event.detail.value);
    this.setData({ learner: event.detail.value });
    this.updateLeaveWarning();
  },
  async begin(event) {
    if (this.data.busy || this.data.loading || !this.data.canEnroll) return;
    const learner = this.data.learner.trim();
    if (!learner) return this.setData({ trainingError: '请填写学员姓名或培训编号。' });
    const body = { courseId: event.currentTarget.dataset.id, outletId: this.data.selectedOutletId, learner };
    try {
      this.setData({ busy: true, trainingError: '', trainingNotice: '' });
      const record = await localMutation('/records', body, JSON.stringify(body));
      this._learnerDrafts?.delete(body.outletId + '|' + body.courseId);
      this.query.outlet = record.outletId;
      this.query.id = record.id;
      this.resetRecordPanel(record.id);
      this.setData({ learner: '', tab: 'records', records: putFirst(this.data.records, decorateRecord(record)),
        trainingNotice: '学员已登记，可以提交培训资料。' });
      wx.pageScrollTo?.({ scrollTop: 0, duration: 0 });
      await this.fetchRecords(true, record);
    } catch (error) {
      this.setData({ trainingError: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  resetRecordPanel(recordId) {
    this._materialsSerial = (this._materialsSerial || 0) + 1;
    this._historySerial = (this._historySerial || 0) + 1;
    this.setData({ recordId, materials: [], uploadDraft: null, materialsNext: null,
      history: [], historyNext: null, historyLoading: false, materialsLoading: false });
    this.updateLeaveWarning();
  },
  updateLeaveWarning() {
    const hasLearnerDraft = this._learnerDrafts && Array.from(this._learnerDrafts.values()).some(value => value.trim());
    const message = this.data.uploadDraft ? '资料未提交，返回将放弃所选图片。'
      : hasLearnerDraft ? '学员信息尚未登记，返回将放弃填写。' : '';
    if (message) wx.enableAlertBeforeUnload?.({ message });
    else wx.disableAlertBeforeUnload?.({});
  },
  async confirmDiscardMaterial() {
    const draft = this.data.uploadDraft;
    if (!draft) return true;
    if (this._confirmingDiscard || typeof wx.showModal !== 'function') return false;
    const serial = this._serial;
    const token = api.session()?.token;
    this._confirmingDiscard = true;
    try {
      const confirmed = await new Promise(resolve => wx.showModal({
        title: '资料未提交',
        content: '切换后将放弃已选图片，确定继续吗？',
        confirmText: '放弃',
        cancelText: '继续填写',
        success: result => resolve(result.confirm),
        fail: () => resolve(false),
      }));
      return confirmed && this.data.uploadDraft === draft && this._serial === serial && api.session()?.token === token;
    } finally {
      this._confirmingDiscard = false;
    }
  },
  async openMaterials(event) {
    if (this.data.busy || this.data.selecting || this.data.loading) return;
    const id = event.currentTarget.dataset.id;
    if (!this.data.records.some(record => record.id === id)) return;
    const recordId = id === this.data.recordId ? '' : id;
    if (!await this.confirmDiscardMaterial()) return;
    this.query.id = recordId;
    this.resetRecordPanel(recordId);
    this.setData({ trainingError: '', trainingNotice: '' });
    if (recordId) await Promise.all([this.fetchMaterials(true), this.fetchHistory(true)]);
  },
  async fetchMaterials(reset) {
    if (!this.data.recordId || !reset && (this.data.materialsLoading || this.data.materialsNext == null)) return;
    const serial = (this._materialsSerial || 0) + 1;
    this._materialsSerial = serial;
    const route = '/records/' + this.data.recordId + '/materials?' + api.query({ offset: reset ? 0 : this.data.materialsNext });
    try {
      this.setData({ materialsLoading: true });
      const result = await api.request(PREFIX + route);
      if (serial !== this._materialsSerial) return;
      this.setData({ materials: reset ? result.items : this.data.materials.concat(result.items), materialsNext: result.nextOffset });
    } catch (error) {
      if (serial === this._materialsSerial) this.setData({ trainingError: error.message });
    } finally {
      if (serial === this._materialsSerial) this.setData({ materialsLoading: false });
    }
  },
  moreMaterials() { return this.fetchMaterials(false); },
  async fetchHistory(reset) {
    if (!this.data.recordId || !reset && (this.data.historyLoading || this.data.historyNext == null)) return;
    const serial = (this._historySerial || 0) + 1;
    this._historySerial = serial;
    const route = '/records/' + this.data.recordId + '/history?' + api.query({ offset: reset ? 0 : this.data.historyNext });
    try {
      this.setData({ historyLoading: true });
      const result = await api.request(PREFIX + route);
      if (serial !== this._historySerial) return;
      const items = result.items.map(item => ({ ...item, label: LABELS[item.status], date: fmt.dateText(item.createdAt?.slice(0, 10)) }));
      this.setData({ history: reset ? items : this.data.history.concat(items), historyNext: result.nextOffset });
    } catch (error) {
      if (serial === this._historySerial) this.setData({ trainingError: error.message });
    } finally {
      if (serial === this._historySerial) this.setData({ historyLoading: false });
    }
  },
  moreHistory() { return this.fetchHistory(false); },
  async chooseMaterial() {
    if (this.data.busy || this.data.selecting || !this.data.recordId) return;
    const recordId = this.data.recordId;
    if (!this.data.records.some(record => record.id === recordId && record.mayUpload)) return;
    try {
      this.setData({ selecting: true, trainingError: '', trainingNotice: '' });
      const file = await chooseImage();
      if (!file || this.data.recordId !== recordId) return;
      if (!file.tempFilePath || file.size > 5 * 1024 * 1024) throw new Error('请选择不超过 5 MB 的图片。');
      this.setData({ uploadDraft: { filePath: file.tempFilePath, recordId } });
      this.updateLeaveWarning();
    } catch (error) {
      this.setData({ trainingError: error.message });
    } finally {
      this.setData({ selecting: false });
    }
  },
  async submitMaterial() {
    const draft = this.data.uploadDraft;
    if (this.data.busy || this.data.selecting || this._confirmingDiscard || !draft || draft.recordId !== this.data.recordId ||
      !this.data.records.some(record => record.id === draft.recordId && record.mayUpload)) return;
    const serial = this._serial;
    const token = api.session()?.token;
    const isCurrent = () => this._serial === serial && this.data.recordId === draft.recordId && api.session()?.token === token;
    try {
      this.setData({ busy: true, trainingError: '', trainingNotice: '' });
      const base64 = await readBase64(draft.filePath);
      if (!isCurrent()) return;
      const result = await localMutation('/records/' + draft.recordId + '/materials', materialPayload(base64), draft.filePath);
      if (!isCurrent()) return;
      this.setData({ uploadDraft: null, records: this.data.records.map(row => row.id === result.id ? decorateRecord(result) : row),
        trainingNotice: '资料已提交，等待审核。' });
      this.updateLeaveWarning();
      await this.fetchMaterials(true);
    } catch (error) {
      this.setData({ trainingError: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  async viewMaterial(event) {
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    try {
      this.setData({ busy: true, trainingError: '' });
      const path = await api.download(PREFIX + '/materials/' + id + '/content');
      await new Promise((resolve, reject) => wx.previewImage({
        urls: [path], current: path, success: resolve, fail: () => reject(new Error('图片无法打开，请稍后重试。')),
      }));
    } catch (error) {
      this.setData({ trainingError: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  onUnload() {
    this._serial = (this._serial || 0) + 1;
    this._coursesSerial = (this._coursesSerial || 0) + 1;
    this._recordsSerial = (this._recordsSerial || 0) + 1;
    this._materialsSerial = (this._materialsSerial || 0) + 1;
    this._historySerial = (this._historySerial || 0) + 1;
  },
}));
