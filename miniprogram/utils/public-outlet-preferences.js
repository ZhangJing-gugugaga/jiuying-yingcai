const favoriteKey = 'jyyc.public.outletFavorites';
const recentKey = 'jyyc.public.outletSearches';
const favoriteLimit = 12;
const recentLimit = 5;
const isOutletId = id => typeof id === 'string' && /^[a-z0-9_-]{1,128}$/i.test(id);
const isSearchTerm = term => typeof term === 'string' && /^[\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z .·-]{0,39}$/.test(term);

function read(key, validate, limit) {
  try {
    const values = wx.getStorageSync(key);
    return Array.isArray(values) ? [...new Set(values.filter(validate))].slice(0, limit) : [];
  } catch {
    return [];
  }
}

function favorites() {
  return read(favoriteKey, isOutletId, favoriteLimit);
}

function changeFavorite(id, remove = false) {
  const previous = favorites();
  if (!isOutletId(id)) return previous;
  const next = previous.filter(value => value !== id);
  if (!remove) {
    if (next.length >= favoriteLimit) throw new Error('最多可收藏12家网点，请先取消一项收藏。');
    next.unshift(id);
  }
  wx.setStorageSync(favoriteKey, next);
  return next;
}

function recentSearches() {
  return read(recentKey, isSearchTerm, recentLimit);
}

function addRecentSearch(term) {
  const previous = recentSearches();
  if (!isSearchTerm(term)) return previous;
  const next = [term, ...previous.filter(value => value.toLowerCase() !== term.toLowerCase())].slice(0, recentLimit);
  try {
    wx.setStorageSync(recentKey, next);
  } catch {
    return previous;
  }
  return next;
}

function clearRecentSearches() {
  wx.removeStorageSync(recentKey);
}

module.exports = { favorites, changeFavorite, recentSearches, addRecentSearch, clearRecentSearches };
