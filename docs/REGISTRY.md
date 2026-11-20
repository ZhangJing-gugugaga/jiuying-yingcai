# 工程注册、构建与分发

本项目随应用分发页面和组件。小程序[路由清单](../miniprogram/app.json)注册主包及分包；[自定义底栏](../miniprogram/custom-tab-bar/)按身份展示入口。总部 Web 模块随 Node 服务提供。新增小程序页面后核对路由注册、导航、权限及分包引用。

## 生成开发包

在项目根目录运行，输出选择新目录或空目录。

```powershell
node scripts/wechat-validate.cjs
node scripts/wechat-build.cjs --environment development --target simulator --out dist/wechat-development
```

在微信开发者工具中导入生成目录，核对 AppID、API 地址和第一条实际请求。真机包使用授权 AppID 和 HTTPS 域名，按[部署手册](DEPLOYMENT.md)选择 test 或 production。交付时记录构建环境、源码版本、产物摘要和实际验收结果。仓内 `scripts/package.py` 保留 V3.3 的文件清单及归档名，制作新版本源码包时需先更新清单。
