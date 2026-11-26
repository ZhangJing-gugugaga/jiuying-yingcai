# 小程序构建与分发

日常调试直接打开 [miniprogram/](../miniprogram/)，入口和后端启动见[项目 README](../README.md#本地启动)。微信开发者工具在原项目编译即可。路由和分包在 [app.json](../miniprogram/app.json) 登记。

## 真机和发布构建

需要真机验证或微信发布时，从已验源码执行 `scripts/wechat-build.cjs`，按[部署手册](DEPLOYMENT.md#原生构建)选择环境、授权 AppID 和 HTTPS 地址。记录 Git 提交号及实际测试结果。需要核对编译错误时，用 `scripts/wechat-compile.cjs` 检查 WXML/WXSS。

Git 仓库用于源码交接。需要离线交付时，等交互和视觉验证完成后归档一次，并从解压目录做启动冒烟。旧版源码归档见[历史验收索引](历史验收版本索引.md)。
