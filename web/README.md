# 总部 Web

本目录保存总部页面、样式和浏览器端 JavaScript。总部 Web 和微信小程序共用 `backend/` 的 API。Node 服务从本目录提供网页。

## 本地调试

按[项目启动说明](../README.md#本地启动)启动后端，打开 [总部 Web](http://127.0.0.1:8787/)。修改页面、样式或浏览器脚本后刷新页面。

| 文件 | 用途 |
| --- | --- |
| [index.html](index.html) | 网页入口 |
| [app.js](app.js) | 角色导航、业务界面和状态 |
| [client.js](client.js) | API 请求和会话 |
| [styles.css](styles.css) | 公共样式 |

涉及审批、账务或权限时，用隔离样本复验对应操作。浏览器回归入口为 `backend/tests/browser.cjs`。 [后端 README](../backend/README.md) · [API 契约](../docs/API.md)
