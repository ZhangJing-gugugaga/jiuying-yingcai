// Generated device packages replace this source-only simulator configuration.
const {development}=require('./config/environments');
const isolated=typeof wx!=='undefined'&&wx.getStorageSync?.('jyyc.simulator.environment')==='group-review';
module.exports=isolated?{...development,apiBase:'http://127.0.0.1:18876'}:development;
