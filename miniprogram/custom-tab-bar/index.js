const api = require('../utils/api');
const { go, tabBarView } = require('../utils/navigation');

function refresh() {
  const page = typeof getCurrentPages === 'function' ? getCurrentPages().at(-1) : null;
  const name = /^pages\/([^/]+)\/index$/.exec(page?.route || '')?.[1];
  if (name) this.setData(tabBarView(name, api.session()));
}

Component({
  data: tabBarView('home', null),
  lifetimes: { attached: refresh },
  pageLifetimes: { show: refresh },
  methods: {
    choose(event) {
      const key = event.currentTarget.dataset.key;
      if (key === this.data.selected || !this.data.items.some(item => item.key === key)) return;
      const role = api.session()?.role;
      const member = role && role !== 'public';
      const query = member && key === 'home' ? 'scope=workbench' : member && key === 'outlets' ? 'scope=private' : '';
      go(key, query);
    },
  },
});
