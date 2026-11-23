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

## Codex 小程序工具链

本项目的本机 Codex 配置使用 WaterTian 的 `wechat-devtools-mcp` 与同版 Skill（0.9.22）。项目级配置位于 `.codex/config.toml`，Skill 位于 `.agents/skills/wechat-devtools/`，MCP 和 Node.js 24.19.0 的本地运行环境位于 `var/wechat-codex/`。机器专用配置和运行产物保留在本机。Codex 从受信任的仓库目录开启会话后读取配置。先用 `codex mcp get wechat-devtools-mcp` 确认加载，再调用 `wechat_ide` 的 `status` 检查开发者工具和服务端口。

当前机器使用仓库内 Node.js 时，先在项目 PowerShell 会话运行下面一行，再按本页执行开发和测试命令。

```powershell
$env:Path = "$(Resolve-Path 'var/wechat-codex/node/node_modules/node/bin');$env:Path"
```

| 阶段 | 本项目入口 |
| --- | --- |
| 需求与开发 | 按[需求编号追溯](handoff/06-需求编号追溯.md)定位角色、对象和入口。修改原生小程序、总部 Web、共享逻辑或服务端后，使用本机 mock 数据验证。 |
| 自动化检查 | 使用本页的 Node 测试、包校验和总部 Chrome 回归。小程序增量先运行静态检查，生成独立模拟器包后用 `scripts/wechat-compile.cjs` 验证 WXML/WXSS 官方编译。 |
| 模拟器联调 | 用开发者工具导入当次生成目录，用 MCP 执行编译、操作页面并抓取日志和截图。项目默认路径指向 `miniprogram/` 便于开发，验收时把 `WECHAT_PROJECT_PATH` 指向当次输出目录后重开 Codex 会话。 |
| 真机与平台 | 按[构建与分发](REGISTRY.md)生成 test 真机包，使用授权 AppID、HTTPS API 与已登录的微信开发者工具生成预览码。扫码后记录真机结果。正式上传、提审和发布按[部署手册](DEPLOYMENT.md)执行。 |
| 部署与运行 | 使用项目已有的备份、SQLite 编号迁移、HTTPS 反向代理、健康检查及恢复流程。微信登录、短信、支付和公众号按目标环境实测。 |

小程序完整路由以 `scripts/wechat-validate.cjs` 的主包和分包清单为准。MCP 的 `list_pages` 当前只列主包页面。

四入口版优先按需求 01、10、C04、C05 验证访客从首页发起加盟申请、总部 Web 审核与退回补件、申请者重新提交及首次激活。每次结合页面、接口请求号和原单状态记录结果。

本机首次接入已通过 MCP 工具握手、556 项 Node 测试、总部 Chrome 回归、包校验及 21 个路由的官方 WXML/WXSS 编译。后续通过桌面操作打开模拟器首页并连接隔离 mock API，仓库根目录导入时复现 TDesign 组件和 SWC 运行时加载错误，加盟商登录界面未能渲染。MCP 的模拟器自动化仍受本地服务端口连接超时影响。验收使用独立构建目录，逐页实操与真机结果仍待补录。

同步 PR #1 后，V3.4.4 的开发构建和 21 个路由的官方 WXML/WXSS 编译通过。两个版本合计 19 项地图、月报、登录与状态反馈回归通过。此次未重新操作模拟器。

跨端联调按[办理与排错手册](handoff/09-跨端办理与排错.md)对照岗位操作、原单、状态和请求号。末节提供验收记录模板。
