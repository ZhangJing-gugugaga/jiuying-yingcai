const storageKey = 'jyyc.reportRecovery';
const maxAge = 2 * 60 * 60 * 1000;
const fieldLimits = { revenue: 24, orders: 24, traffic: 24, enroll: 24, note: 600 };

function clear(scope) {
  try {
    if (scope) {
      const saved = wx.getStorageSync(storageKey);
      if (!saved || saved.outlet !== scope.outlet || saved.month !== scope.month) return;
    }
    wx.removeStorageSync(storageKey);
  } catch { /* Local storage is optional. */ }
}

function accountScope(session) {
  if (!session?.subject || session.role === 'public' || !(Date.parse(session.expiresAt) > Date.now())) return '';
  return JSON.stringify([session.subject, session.expiresAt]);
}

// A change detector for the server snapshot, independent of authorization checks.
function revision({ draft, latestSubmittedVersion, currentApprovedVersion, enrollmentStatus }, editableFields) {
  const record = row => row && [row.id, row.status, row.revoked, row.correctionAllowed,
    ...Object.keys(fieldLimits).map(key => row[key])];
  const text = JSON.stringify([record(draft), record(latestSubmittedVersion), record(currentApprovedVersion), enrollmentStatus, editableFields]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return String(hash >>> 0);
}

function editableValues(form, editableFields) {
  return Object.fromEntries(Object.entries(fieldLimits).filter(([key]) => editableFields[key]).map(([key, limit]) => {
    const value = form[key];
    return [key, typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, limit) : ''];
  }));
}

function save(session, scope, form, editableFields) {
  const account = accountScope(session);
  if (!account || !scope?.outlet || !scope?.month || !scope?.revision) return;
  const values = editableValues(form, editableFields);
  if (Object.keys(values).length === 0) return;
  try { wx.setStorageSync(storageKey, { account, ...scope, savedAt: Date.now(), values }); } catch { /* The server draft remains usable. */ }
}

function read(session, scope, editableFields) {
  try {
    const saved = wx.getStorageSync(storageKey);
    if (!saved) return null;
    const now = Date.now();
    if (saved.account !== accountScope(session) || !Number.isFinite(saved.savedAt) || saved.savedAt > now || now - saved.savedAt > maxAge) {
      clear();
      return null;
    }
    if (saved.outlet !== scope.outlet || saved.month !== scope.month) return null;
    if (saved.revision !== scope.revision || !saved.values || !Object.values(editableFields).some(Boolean)) {
      clear();
      return null;
    }
    return editableValues(saved.values, editableFields);
  } catch { return null; }
}

module.exports = { clear, revision, save, read };
