// Source defaults are for the local DevTools simulator only. Generate device builds with scripts/wechat-build.cjs.
module.exports={
  development:{environment:'development',target:'simulator',apiBase:'http://127.0.0.1:8787',development:true},
  test:{environment:'test',target:'device',apiBase:'',development:false},
  production:{environment:'production',target:'device',apiBase:'',development:false}
};

