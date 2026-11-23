const { define, api, fmt } = require('../../utils/page');
const recovery = require('../../utils/report-recovery');

const fieldNames = { revenue: '营业收入', orders: '有效完成订单', traffic: '到店客流', enroll: '实际招生人数', note: '经营说明' };
const fields = Object.keys(fieldNames);
const emptyForm = Object.fromEntries(fields.map(field => [field, '']));
const readOnlyFields = Object.fromEntries(fields.map(field => [field, false]));
const numericFields = fields.filter(field => field !== 'note');
const units = { orders: '单', traffic: '人次', enroll: '人' };
const confirmationContent = '提交后，本次内容将进入总部审核。确认提交吗？';
const leaveMessage = '还有内容尚未保存。请返回保存草稿，或确认放弃后离开。';
const notices = {
  current_month: '当前月份暂未开放填报，请查看总部公布的报送安排。',
  future_month: '当前月份暂未开放填报，请查看总部公布的报送安排。',
  exempt: '该网点本月已由总部确认免报。',
  full_pause: '本月整月暂停营业。请联系总部核验免报。',
  no_operation: '本月无营业记录，无需填报。',
  reviewing: '月报已提交，等待总部审核。',
  correction_required: '本月月报已审核通过。如需修改，请提交更正申请。',
  read_only: '当前账号仅可查看。',
  unavailable: '暂时无法获取信息，请稍后重试。',
  enrollment_pending: '招生业务适用情况待总部确认。',
};

function missingDetails(values, applicable) {
  const missingFields = numericFields.filter(field => (field !== 'enroll' || applicable) &&
    (values[field] === '' || values[field] == null)).map(field => fieldNames[field]);
  return { missingFields, missingFieldsText: missingFields.join('、') };
}

function fieldError(field, value) {
  if (value === '' || value == null) return '请填写' + fieldNames[field];
  try {
    fmt.reportDraft({ [field]: value });
    return '';
  } catch (error) {
    return error.message;
  }
}

function version(record) {
  if (!record) return null;
  return {
    ...record,
    statusText: record.revoked ? '已撤销' : fmt.label(record.status,'report'),
    statusTone: fmt.statusTone(record.revoked ? 'revoked' : record.status,'report'),
    review: record.publicNote || record.reviewNote || record.review || '',
    differences: Object.entries(record.correctionDiff || {}).filter(([field])=>Object.hasOwn(fieldNames,field)).map(([field, diff]) => ({
      field,
      label: fieldNames[field],
      before: diff.before === null ? '不适用' : String(diff.before ?? '—'),
      after: diff.after === null ? '不适用' : String(diff.after ?? '—'),
    })),
  };
}

function confirmModal(options) {
  return new Promise(resolve => {
    try {
      wx.showModal({ ...options, success: resolve, fail: () => resolve(null) });
    } catch (_) {
      resolve(null);
    }
  });
}

const editor = define({
  collections: ['outlets'],
  data: {
    canEdit: false, canSubmit: false, canCorrect: false, switching: false, editNotice: '',
    form: { ...emptyForm }, editableFields: { ...readOnlyFields }, month: '', outlets: [], outletNames: [], outletIndex: -1, outletId: '',
    searchExpanded: false, historyExpanded: false, formExpanded: false, correctionExpanded: false, noteExpanded: false, hasDraft: false,
    applicable: false, enrollmentStatus: 'pending', timing: null, versions: [], current: null,
    currentApprovedVersion: null, latestSubmittedVersion: null, linkedVersion: null,
    versionUnavailable: false, currentAction: '', returnedReason: '', directReturnedEdit: false, submitting: false, inlineConfirmation: false,
    submitConfirmationContent: confirmationContent, showActionError: false, actionNotice: '',
    missingFields: [], missingFieldsText: '', fieldErrors: {}, confirmationRows: [],
    reason: '', correctionError: '', correctionType: 'field', correctionFieldIndex: 0, correctionOptions: [], recoveryAvailable: false,
  },

  load(query) {
    this.setData({ month: query.month || '' });
  },

  onHide() {
    if (!this._dirty || !this.data.canEdit || this._recoveryToken !== api.session()?.token) return;
    recovery.save(api.session(), this._recoveryScope, this.data.form, this.data.editableFields);
  },

  async loaded(state) {
    const outlets = state.outlets.filter(outlet => outlet.owner);
    const requested = this.query.outlet === 'all' ? '' : this.query.outlet;
    const singleOutlet = outlets.length === 1 && !this.data.outletSearch && !this.data.pagers.outlets?.hasMore;
    const outletIndex = requested ? outlets.findIndex(outlet => outlet.id === requested) : singleOutlet ? 0 : -1;
    const outletId = outlets[outletIndex]?.id || '';
    const month = this.data.month || fmt.addMonth(state.today.slice(0, 7), -1);
    if (outletId) this.query.outlet = outletId;
    this.query.month = month;
    this.setData({
      outlets, outletNames: ['请选择网点', ...outlets.map(fmt.outletOptionLabel)], outletIndex, outletId, month,
      ...(!outletId ? { canEdit: false, canSubmit: false, canCorrect: false, editableFields: { ...readOnlyFields } } : {}),
    });
    if (requested && !outletId) {
      this.setData({ error: '暂时无法查看指定网点，请从原事项重新进入。' });
      return;
    }
    await this.loadMonth();
  },

  async loadMonth() {
    const serial = this._serial;
    const token = api.session()?.token;
    const { outletId: outlet, month } = this.data;
    if (!outlet) return;
    const context = await api.request('/api/reports/context?' + api.query({ outlet, month }));
    if (serial !== this._serial || outlet !== this.data.outletId || month !== this.data.month || token !== api.session()?.token) return;
    const { timing } = context;
    const { canEdit: editAllowed = false, canSubmit: submitAllowed = false, canCorrect: correctionAllowed = false, reason } = context.eligibility || {
      reason: context.enrollmentStatus === 'pending' ? 'enrollment_pending' : 'unavailable',
    };
    const currentApprovedVersion = version(context.currentApprovedVersion);
    const latestSubmittedVersion = version(context.latestSubmittedVersion);
    const versions = context.historyVersions.map(record => {
      const row = version(record);
      return row.status === 'returned' && !row.revoked && row.id !== latestSubmittedVersion?.id
        ? { ...row, statusText: '历史退回记录', statusTone: 'gray' } : row;
    });
    const requestedVersion = this.query.id || this.query.reportId;
    const enterReturnedEditor = this.query.edit==='returned' && requestedVersion &&
      requestedVersion===latestSubmittedVersion?.id && latestSubmittedVersion.status==='returned' &&
      !latestSubmittedVersion.revoked && editAllowed;
    if (enterReturnedEditor) {
      delete this.query.id;
      delete this.query.reportId;
    }
    delete this.query.edit;
    const linkedId = enterReturnedEditor ? '' : requestedVersion;
    const linkedVersion = versions.find(record => record.id === linkedId) || null;
    const versionUnavailable = !!linkedId && !linkedVersion;
    const shownVersion = linkedId ? linkedVersion : latestSubmittedVersion;
    const returned = shownVersion?.status === 'returned' && !shownVersion.revoked && shownVersion.id === latestSubmittedVersion?.id;
    const returnedReason = returned ? shownVersion.review || '总部未填写说明，可联系总部了解详情。' : '';
    // A version link keeps its snapshot unless a return task names the latest editable version.
    let currentAction = '';
    if (linkedVersion) {
      if (latestSubmittedVersion && linkedVersion.id !== latestSubmittedVersion.id) currentAction = '查看当前月报';
      else if (editAllowed) currentAction = returned ? '修改并重新提交' : '前往当前月报';
      else if (correctionAllowed) currentAction = '办理月报更正';
    }
    const canEdit = !linkedId && editAllowed;
    const canSubmit = !linkedId && submitAllowed;
    const canCorrect = !linkedId && correctionAllowed;
    const enrollmentStatus = linkedVersion && !linkedVersion.summaryOnly
      ? linkedVersion.enrollmentStatus || (linkedVersion.enroll == null ? 'not_applicable' : 'applicable')
      : context.enrollmentStatus;
    const applicable = enrollmentStatus === 'applicable';
    const correctionFields = !linkedId && currentApprovedVersion?.correctionAllowed && currentApprovedVersion.correctionType === 'field'
      ? currentApprovedVersion.correctionFields : null;
    const editableFields = Object.fromEntries(fields.map(field => [field,
      canEdit && (!correctionFields || correctionFields.includes(field)) && (field !== 'enroll' || applicable),
    ]));
    this._recoveryScope = { outlet, month, revision: recovery.revision(context, editableFields) };
    if (token !== this._recoveryToken) this._dirty = false;
    this._recoveryToken = token;
    const recoveryAvailable = canEdit && !this._dirty && !!recovery.read(api.session(), this._recoveryScope, editableFields);
    const correctionOptions = fields.filter(field => field !== 'enroll' || applicable)
      .map(field => ({ field, label: fieldNames[field] }));
    const correctionFieldIndex = Math.min(this.data.correctionFieldIndex, correctionOptions.length - 1);
    const source = linkedId ? linkedVersion : canEdit && this._dirty ? this.data.form : context.draft || latestSubmittedVersion || currentApprovedVersion;
    const form = Object.fromEntries(fields.map(field => [field,
      (correctionFields && !correctionFields.includes(field) ? currentApprovedVersion[field] : source?.[field]) ?? '',
    ]));
    const editNotice = versionUnavailable ? '无法查看这份月报。请从月报列表或原通知重新打开。'
      : linkedVersion ? '' : notices[reason] || (correctionFields
      ? '本次仅需修改：' + correctionFields.map(field => fieldNames[field]).filter(Boolean).join('、')
      : canEdit?(timing?.late&&canSubmit?'已超过报送截止日期，仍可补报，提交后将标记为逾期。':'当前月份可以填写经营数据。'):'');
    this.setData({
      state: { ...this.data.state, reports: versions }, versions, current: latestSubmittedVersion,
      currentApprovedVersion, latestSubmittedVersion, linkedVersion, versionUnavailable, currentAction, returnedReason, enrollmentStatus, applicable, timing: timing || null,
      directReturnedEdit: !!(returned && canEdit && (enterReturnedEditor || this.data.directReturnedEdit)),
      monthDisplay:fmt.monthText(month),dueDisplay:fmt.dateText(timing?.dueOn),
      displayStatus:linkedId ? linkedVersion?.statusText || '' : reason==='exempt'?'已免报':latestSubmittedVersion?.statusText||(context.draft?'草稿':canEdit?'待填写':''),
      displayStatusTone:linkedId ? linkedVersion?.statusTone : reason==='exempt'?'ok':latestSubmittedVersion?.statusTone||(canEdit||context.draft?'wait':'gray'),
      hasDraft: !!context.draft, canEdit, canSubmit, canCorrect, editNotice, editableFields, correctionOptions, correctionFieldIndex, form, recoveryAvailable,
      ...(canEdit ? missingDetails(form, applicable) : { missingFields: [], missingFieldsText: '' }),
      noteExpanded: !!form.note || this.data.noteExpanded,
      formExpanded: this.data.formExpanded || canEdit && !recoveryAvailable,
    });
  },

  async changeScope(values, versionId) {
    const serial = this._serial;
    if (this.data.busy || this.data.loading || this.data.switching || this._confirming) return;
    this.setData({ switching: true });
    try {
      if (this._dirty) {
        const save = await confirmModal({
          title: '切换前保存修改？', content: '当前内容尚未保存。您可以保存草稿后离开，或放弃本次修改。',
          confirmText: '保存草稿', cancelText: '其他选项',
        });
        if (serial !== this._serial) return;
        if (!save) {
          this.actionFailure('无法打开确认窗口，您填写的内容已保留，请重试。');
          return;
        }
        if (save.confirm) {
          if (!await this.saveCurrentDraft(false)) return;
        } else if (save.cancel) {
          const discard = await confirmModal({
            title: '放弃未保存的修改？', content: '放弃后，本次未保存的修改将丢失。确认放弃吗？',
            confirmText: '放弃修改', cancelText: '继续编辑',
          });
          if (!discard) this.actionFailure('无法打开确认窗口，您填写的内容已保留，请重试。');
          if (!discard?.confirm) return;
          recovery.clear(this._recoveryScope);
        } else return;
      } else if (this.data.reason.trim()) {
        const discard = await confirmModal({
          title: '放弃未提交的更正原因？', content: '切换后需要重新填写更正原因。',
          confirmText: '放弃修改', cancelText: '继续编辑',
        });
        if (!discard?.confirm) return;
      }
      if (serial !== this._serial) return;
      this._dirty = false;
      delete this.query.id;
      delete this.query.reportId;
      if (versionId) this.query.id = versionId;
      if (values.outletId) this.query.outlet = values.outletId;
      if (values.month) this.query.month = values.month;
      this.setData({
        ...values, form: { ...emptyForm }, editableFields: { ...readOnlyFields }, enrollmentStatus: 'pending',
        applicable: false, timing: null, canEdit: false, canSubmit: false, canCorrect: false, editNotice: '', versions: [], current: null,
        currentApprovedVersion: null, latestSubmittedVersion: null, linkedVersion: null, versionUnavailable: false,
        currentAction: '', returnedReason: '', directReturnedEdit: false, reason: '', correctionError: '', showActionError: false, actionNotice: '', displayStatus: '', dueDisplay: '',
        historyExpanded: !!versionId, formExpanded: false, correctionExpanded: false, noteExpanded: false, hasDraft: false,
        missingFields: [], missingFieldsText: '', fieldErrors: {}, confirmationRows: [],
        correctionType: 'field', correctionFieldIndex: 0, recoveryAvailable: false,
      });
      this.updateLeaveWarning();
      await refreshPage.call(this);
    } finally {
      this.setData({ switching: false });
    }
  },

  async chooseOutlet(event) {
    const outletIndex = Number(event.detail.value);
    const outlet = this.data.outlets[outletIndex];
    if (outlet && outlet.id !== this.data.outletId) await this.changeScope({ outletIndex, outletId: outlet.id });
  },

  async chooseOutletFromPicker(event) {
    await this.chooseOutlet({ detail: { value: Number(event.detail.value) - 1 } });
  },

  async chooseMonth(event) {
    const month = event.detail.value;
    if (month !== this.data.month) await this.changeScope({ month });
  },

  input(event) {
    const field = event.currentTarget.dataset.field;
    if (this.data.loading || this.data.busy || this.data.switching || this._confirming || !this.data.editableFields[field]) return;
    if (String(this.data.form[field]) === String(event.detail.value)) return;
    this._dirty = true;
    this.setData({
      ['form.' + field]: event.detail.value,
      ...missingDetails({...this.data.form, [field]: event.detail.value}, this.data.applicable),
      ...(this.data.fieldErrors[field] ? { ['fieldErrors.' + field]: fieldError(field, event.detail.value) } : {}),
      ...(this.data.showActionError ? { error: '', showActionError: false } : {}),
      actionNotice: '',
      recoveryAvailable: false,
    });
    this.updateLeaveWarning();
  },

  blurField(event) {
    const { field } = event.currentTarget.dataset;
    if (!numericFields.includes(field) || !this.data.editableFields[field] || this._confirming) return;
    this.setData({ ['fieldErrors.' + field]: fieldError(field, this.data.form[field]) });
  },

  toggleNote() {
    this.setData({ noteExpanded: !this.data.noteExpanded });
  },

  restoreRecovery() {
    if (!this.data.canEdit || this.data.loading || this.data.busy || this.data.switching || this._recoveryToken !== api.session()?.token) return;
    const values = recovery.read(api.session(), this._recoveryScope, this.data.editableFields);
    this.setData({ recoveryAvailable: false });
    if (!values) return;
    this._dirty = true;
    const form = { ...this.data.form, ...values };
    this.setData({ form, ...missingDetails(form, this.data.applicable), fieldErrors: {}, noteExpanded: !!form.note });
    this.updateLeaveWarning();
    this.showReportFields();
  },

  discardRecovery() {
    recovery.clear(this._recoveryScope);
    this.setData({ recoveryAvailable: false });
  },

  updateLeaveWarning() {
    const pending = Boolean(this._dirty || this.data.reason.trim());
    if (pending === Boolean(this._leaveWarning)) return;
    this._leaveWarning = pending;
    if (pending) {
      const message = this._dirty ? leaveMessage : '更正原因尚未提交。确认放弃后离开？';
      wx.enableAlertBeforeUnload?.({ message });
    } else {
      wx.disableAlertBeforeUnload?.({});
    }
  },

  formValues(submitted = {}) {
    const { form, editableFields, currentApprovedVersion } = this.data;
    return Object.fromEntries(fields.map(field => [field, editableFields[field]
      ? (submitted[field] ?? form[field]) : currentApprovedVersion?.[field] ?? form[field],
    ]));
  },

  actionFailure(message) {
    this.setData({ error: message, showActionError: true, actionNotice: '' });
  },

  async writeReport(command, payload, success, refresh = true) {
    const serial = this._serial;
    this.setData({ busy: true, error: '', showActionError: false, correctionError: '', actionNotice: '' });
    try {
      let saved;
      try {
        saved = await api.command(command, payload);
      } catch (error) {
        if (serial === this._serial) {
          const message = error.status === 401 ? error.message : command === 'report.draft'
            ? '保存失败，您填写的内容已保留，请重试。' : error.code === 'NETWORK'
              ? '网络连接中断，暂未确认操作结果。填写内容已保留，请检查网络后重试。'
              : api.errorText(error);
          if (command === 'report.correct') this.setData({ correctionError: message });
          else this.actionFailure(message);
        }
        return null;
      }
      if (serial !== this._serial) return null;
      this._dirty = false;
      if (command === 'report.draft' || command === 'report.submit') this.discardRecovery();
      if (command !== 'report.draft') {
        this.setData({ canEdit: false, canSubmit: false, canCorrect: false, editableFields: { ...readOnlyFields }, reason: '' });
      }
      this.updateLeaveWarning();
      this.setData({ actionNotice: success });
      try {
        wx.showToast({ title: success, icon: success.length > 7 ? 'none' : 'success' });
      } catch (_) {
        // Keep the success notice next to the form even without a platform toast.
      }
      if (refresh) await refreshPage.call(this);
      return saved;
    } finally {
      this.setData({ busy: false });
    }
  },

  submit(event) {
    const { loading, busy, switching, outletId, month, canEdit, canSubmit, applicable, enrollmentStatus, editNotice } = this.data;
    if (loading || busy || switching || this._confirming) return;
    if (!outletId || !canSubmit) {
      const message = canEdit && enrollmentStatus === 'pending' ? notices.enrollment_pending : editNotice;
      this.actionFailure(message || '当前月报暂不可提交，请确认网点、月份和报送状态。');
      return;
    }

    // Taps use the same field state as draft saves. Older form events may include named values.
    const submitted = event?.detail?.value;
    const values = this.formValues(submitted && typeof submitted === 'object' ? submitted : undefined);
    let input;
    try {
      input = fmt.reportInput(values, applicable);
    } catch (error) {
      const errors = Object.fromEntries(numericFields.filter(field => field !== 'enroll' || applicable)
        .map(field => [field, fieldError(field, values[field])]).filter(([, message]) => message));
      this.setData({ fieldErrors: errors });
      this.actionFailure(error.message);
      const invalidField = Object.keys(errors)[0];
      if (invalidField) wx.pageScrollTo?.({ selector: '#report-field-' + invalidField, duration: 200 });
      return;
    }
    this._confirming = true;
    this._submission = { serial: this._serial, payload: { ...input, outlet: outletId, month } };
    const confirmationRows = numericFields.map(field => ({
      field, label: fieldNames[field],
      value: field === 'revenue' ? '¥' + fmt.money(input.revenue) : input[field] == null ? '不适用' : input[field] + ' ' + units[field],
    }));
    this.setData({ inlineConfirmation: true, confirmationRows, fieldErrors: {}, error: '', showActionError: false, actionNotice: '' });
  },

  async confirmSubmit() {
    const attempt = this._submission;
    if (!attempt || this.data.submitting) return;
    if (attempt.serial !== this._serial) {
      this.cancelSubmit();
      return;
    }
    this.setData({ inlineConfirmation: false, submitting: true });
    try {
      await this.writeReport('report.submit', attempt.payload, '经营月报已提交，等待总部审核。');
    } finally {
      this.clearSubmission();
    }
  },

  cancelSubmit() {
    if (!this.data.submitting) this.clearSubmission();
  },

  clearSubmission() {
    this._submission = null;
    this._confirming = false;
    this.setData({ busy: false, submitting: false, inlineConfirmation: false, confirmationRows: [] });
  },

  async draft() {
    if (this.data.loading || this.data.busy || this.data.switching || this._confirming) return;
    await this.saveCurrentDraft(true);
  },

  async saveCurrentDraft(refresh) {
    const { outletId, month, canEdit, applicable, editNotice } = this.data;
    if (!outletId || !canEdit) {
      this.actionFailure(editNotice || '当前月报暂不可保存草稿。');
      return null;
    }
    try {
      const input = fmt.reportDraft(this.formValues(), applicable);
      return await this.writeReport('report.draft', { ...input, outlet: outletId, month }, '已保存草稿', refresh);
    } catch (error) {
      this.actionFailure(error.message);
      return null;
    }
  },

  async continueReport() {
    const { currentAction } = this.data;
    if (!currentAction) return;
    await this.changeScope({});
    if (this.data.linkedVersion || this.data.error || this.data.recoveryAvailable) return;
    if (this.data.canEdit || currentAction === '查看当前月报') this.showReportFields();
    else if (this.data.canCorrect && currentAction === '办理月报更正') this.showCorrection();
  },

  showReportFields() {
    const { outletId, versionUnavailable, linkedVersion } = this.data;
    if (!outletId || versionUnavailable || linkedVersion?.summaryOnly) return;
    this.setData({ formExpanded: true }, () => wx.pageScrollTo?.({ selector: '#report-edit', duration: 250 }));
  },

  showCorrection() {
    if (!this.data.canCorrect) return;
    this.setData({ correctionExpanded: true }, () => wx.pageScrollTo?.({ selector: '#report-correct', duration: 250 }));
  },

  async selectVersion(event) {
    const id = event.currentTarget.dataset.id;
    if (id && id !== this.data.linkedVersion?.id && this.data.versions.some(record=>record.id===id)) {
      await this.changeScope({}, id);
    }
  },

  toggleOutletSearch() { this.setData({ searchExpanded: !this.data.searchExpanded }); },
  searchInput(event) { this.setData({ searchDraft: event.detail.value }); },
  searchOutlets(event) {
    if (this.data.loading || this.data.busy || this._confirming) return;
    const value = event.detail?.value ?? this.data.searchDraft ?? this.data.outletSearch;
    return this.outletSearch({ detail: { value: value.trim() } });
  },

  showVersions() {
    const historyExpanded = !this.data.historyExpanded;
    this.setData({ historyExpanded }, () => {
      if (historyExpanded) wx.pageScrollTo?.({ selector: '#report-history', duration: 250 });
    });
  },

  reason(event) {
    this.setData({ reason: event.detail.value, correctionError: '' });
    this.updateLeaveWarning();
  },
  correctionType(event) { this.setData({ correctionType: event.currentTarget.dataset.type }); },
  correctionField(event) { this.setData({ correctionFieldIndex: Number(event.detail.value) }); },

  async correct() {
    const { loading, busy, switching, canCorrect, currentApprovedVersion, correctionType, correctionOptions, correctionFieldIndex, reason } = this.data;
    if (loading || busy || switching || this._confirming || !canCorrect || !currentApprovedVersion) return;
    if (!reason.trim()) return this.setData({ correctionError: '请填写更正原因。' });
    const field = correctionOptions[correctionFieldIndex]?.field;
    await this.writeReport('report.correct', {
      id: currentApprovedVersion.id, reason: reason.trim(), correctionType, fields: correctionType === 'field' ? [field] : [],
    }, '已提交申请。');
  },
});

const refreshPage = editor.refresh;
editor.refresh = function () {
  if (!this.data.busy && !this.data.switching && !this._confirming) return refreshPage.call(this);
};

Page(editor);
