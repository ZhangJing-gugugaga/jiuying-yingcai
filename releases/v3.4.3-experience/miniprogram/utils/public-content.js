const api = require('./api');

async function withPublicCover(record) {
  if (!record?.imageId) return record;
  try {
    const coverPath = await api.download('/api/files/' + encodeURIComponent(record.imageId));
    return { ...record, coverPath };
  } catch {
    return { ...record, coverUnavailable: true };
  }
}

function markCoverUnavailable(records, id) {
  return records.map(record => record.id === id
    ? { ...record, coverPath: '', coverUnavailable: true }
    : record);
}

module.exports = { withPublicCover, markCoverUnavailable };
