const imageUrl = '/assets/public-share.png';
const menus = ['shareAppMessage', 'shareTimeline'];
const directory = { title: '九盈英才服务网点', path: '/pages/outlets/index?scope=public', query: 'scope=public' };
const publicSections = new Set(['brand', 'services', 'outlets', 'faq', 'contact', 'news', 'cases']);
const validId = value => typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value);

function publicShare(resolve, visible) {
  return {
    updatePublicShareMenu() {
      const menu = visible.call(this) ? wx.showShareMenu : wx.hideShareMenu;
      menu?.call(wx, { menus, fail() {} });
    },
    onShareAppMessage() {
      const { title, path } = resolve.call(this);
      return { title, path, imageUrl };
    },
    onShareTimeline() {
      const { title, query } = resolve.call(this);
      return { title, query, imageUrl };
    },
  };
}

function groupShare(section) {
  const query = 'section=' + (publicSections.has(section) ? section : 'brand');
  return { title: '九盈英才集团与业务服务', path: '/pages/discover/index?' + query, query };
}

function outletShare(record) {
  if (!validId(record?.id)) return directory;
  const query = 'scope=public&id=' + encodeURIComponent(record.id);
  return { title: record.name || directory.title, path: '/pages/outlet/index?' + query, query };
}

function serviceShare(record) {
  if (!validId(record?.id) || record.status !== 'published') return groupShare('services');
  const query = 'id=' + encodeURIComponent(record.id);
  return { title: record.title || '九盈英才集团业务', path: '/pages/service-detail/index?' + query, query };
}

module.exports = { publicShare, directory, groupShare, outletShare, serviceShare };
