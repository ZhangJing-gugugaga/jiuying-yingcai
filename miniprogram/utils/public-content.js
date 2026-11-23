const api = require('./api');

function retainPublicCover(record, previous) {
  if (record?.imageId && previous?.coverPath && record.id === previous.id && record.imageId === previous.imageId) {
    return { ...record, coverPath: previous.coverPath };
  }
  return record;
}

async function withPublicCover(record) {
  if (!record?.imageId) return record;
  try {
    const coverPath = await api.download('/api/files/' + encodeURIComponent(record.imageId), { publishedCover: true });
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

module.exports = { withPublicCover, markCoverUnavailable, retainPublicCover };
