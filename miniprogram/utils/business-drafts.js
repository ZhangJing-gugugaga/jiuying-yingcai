const kinds = ['location', 'support'];
const prefix = 'jyyc.localDraft.';
const maximumAge = 2 * 60 * 60 * 1000;

function owner(session) {
  if (!session?.subject || !session.role || !(Date.parse(session.expiresAt) > Date.now())) return '';
  return JSON.stringify([session.subject, session.role, session.expiresAt]);
}

function clear(kind) {
  if (!kinds.includes(kind)) return;
  try { wx.removeStorageSync(prefix + kind); } catch { /* Storage may be unavailable. */ }
}

function clearAll() {
  kinds.forEach(clear);
}

function read(kind, session) {
  if (!kinds.includes(kind)) return null;
  try {
    const entry = wx.getStorageSync(prefix + kind);
    if (!entry) return null;
    const age = Date.now() - entry.savedAt;
    if (!owner(session) || entry.owner !== owner(session) || !Number.isFinite(entry.savedAt) || age < 0 || age > maximumAge ||
        !entry.value || typeof entry.value !== 'object' || Array.isArray(entry.value)) {
      clear(kind);
      return null;
    }
    return entry.value;
  } catch { return null; }
}

function save(kind, session, value) {
  const scope = owner(session);
  if (!kinds.includes(kind) || !scope || (kind === 'location' && session.role === 'public') ||
      !value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > 16000) return false;
    wx.setStorageSync(prefix + kind, { owner: scope, savedAt: Date.now(), value: JSON.parse(serialized) });
    return true;
  } catch { return false; }
}

module.exports = { clear, clearAll, read, save };
