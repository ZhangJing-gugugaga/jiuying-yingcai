# 开发与验收流程

1. 按[快速开始](../README.md)安装锁定依赖。每位开发者使用独立 DB_PATH 和本机端口，隔离环境设置 ADAPTER_MODE=mock。
2. 从[追溯表](handoff/06-需求编号追溯.md)选取业务链路，明确发起方、经办岗位、原对象、预期数据变化和异常路径。
3. 同步核对小程序、总部 Web 和服务端契约。针对改动测试成功、无权访问、重复提交及存量记录。
4. 在根目录执行以下基础检查。涉及 Web 时运行对应 Chrome 场景；涉及小程序时构建后在开发者工具操作实际页面。
   
```powershell
node scripts/check-syntax.cjs
npm test
node scripts/wechat-validate.cjs
node scripts/verify-package.cjs
node tests/browser.cjs
```

按[角色用例 T01–T13](handoff/05-验收与开发协作.md)记录测试账号角色、对象、月份、预期与实测、截图和请求号。版本交付走[构建与分发](REGISTRY.md)，目标环境操作见[部署手册](DEPLOYMENT.md)。

跨端联调按[办理与排错手册](handoff/09-跨端办理与排错.md)对照岗位操作、原单、状态和请求号。末节提供验收记录模板。
