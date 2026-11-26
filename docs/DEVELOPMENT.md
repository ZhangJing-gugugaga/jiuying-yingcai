# 开发与验收流程

## 日常开发

按[项目 README](../README.md#本地启动)启动后端。总部 Web 打开 `http://127.0.0.1:8787/`。微信开发者工具打开仓库内的 [miniprogram/](../miniprogram/)，修改后在原项目编译。已添加多个同名项目时，从项目详情核对本地目录，以本仓库的 `miniprogram/` 为准。

| 改动 | 怎么验 |
| --- | --- |
| 文案、样式和页面交互 | 打开受影响页面。文案检查显示和换行，交互检查入口、结果和返回。 |
| 业务逻辑与接口 | 跑相关 Node 用例。涉及两个端时，用同一隔离库从正常入口联调。 |
| 权限、账务与迁移 | 按[项目约定](../AGENTS.md)核对对象范围、金额和旧数据。涉及分派时复验同岗经办人。 |
| 公共模块、跨端契约或整体验收 | 在 `backend/` 跑 `npm test`，按影响面补微信、总部 Web 和 [T01–T13](handoff/05-验收与开发协作.md) 场景。 |

下列检查在 `backend/` 按需运行。`node scripts/check-syntax.cjs` 检查 JS 和 JSON，`node scripts/wechat-validate.cjs` 检查小程序路由和文件，`node tests/browser.cjs` 跑总部主流程。记录实际做过的检查和待验证项。

## Codex 小程序工具链

手工调试直接使用微信开发者工具。需要 Codex 操作模拟器时，使用项目配置的 `wechat-devtools-mcp`，`WECHAT_PROJECT_PATH` 指向同一个 `miniprogram/`。连接异常时用 `wechat_ide status` 核对目录和服务端口。路由以 [app.json](../miniprogram/app.json) 为准。

## 版本与交付

用 Git 提交号定位待复验版本，有未提交改动时注明范围。日常迭代在同一模拟器项目完成交互和视觉检查。需要真机或发布产物时看[构建与分发](REGISTRY.md)，部署和上线由用户明确授权。历史实测见[验收记录](ui-prototype/acceptance.md)。
