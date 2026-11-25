# 九盈英才原生办理流程执行与验收

历史验收记录。现版已使用部分 TDesign 组件，并已有退回月报、服务费和事项的模拟器证据。后续继续验证组件实际事件、候选包与真机结果，见[当前任务状态](../../../TODO.md#四图原型任务状态)。

## 本轮状态

基线为 `codex/jiuying-ux-rework` 的 `bdc8e8b`。月报、咨询服务费和我的事项已在当前工作目录实施。专项、Node 全量、总部 Chrome 主回归、静态检查和微信官方 WXML/WXSS 编译均通过。微信模拟器当前等待项目作者确认，界面验收未完成。

| 工作包 | 改动 | 验收结果 |
| --- | --- | --- |
| 退回月报 | 从通知打开指定只读版本，首屏固定显示网点和月份。旧通知可进入当前月报。版本编号收在历史，保留重提确认和草稿保护。 | Page 处理函数连接隔离 HTTP/SQLite。三网点账号打开株洲网点原记录，修改客流 25 至 26 后仅生成一个 V2 待审版本及一个运营审核任务。重开旧通知后仍可查阅 V1，并查看 V2。 |
| 咨询服务费 | 首屏对齐所选网点、账期和待付合计。账期筛选和历史记录一次展开一组。 | Page 处理函数连接隔离 HTTP/SQLite。切换筛选与历史时保留账单范围和合计。原账单、权限范围、付款结果待确认及合计接口失败路径通过既有测试。 |
| 我的事项 | 已完成事项具有独立标题和返回通知入口。通知仅在通知视图高亮。 | Page 处理函数验证从已读通知进入历史后返回，已读筛选保留。既有测试验证按原通知定位和通知已读后待办仍然有效。 |

## 修改文件

| 目录 | 文件 |
| --- | --- |
| `miniprogram/pages/report/` | `index.js`、`index.wxml`、`index.wxss` |
| `miniprogram/pages/fees/` | `index.js`、`index.wxml`、`index.wxss` |
| `miniprogram/pages/tasks/` | `index.wxml`，旧消息路径继续引用这一模板 |
| `tests/` | `phase-one-matters-report.test.cjs`、`v342-native-fees.test.cjs`、`native-visual-system.test.cjs` |

月报从原通知记录 ID 进入既有网点及月份上下文，写请求仍交由现有权限、校验、状态和幂等逻辑处理。费用使用 `/api/finance/summary` 的整数分待付汇总。接口、权限、金额口径和数据库沿用基线，无迁移和新增依赖。费用首屏复用现有汇总请求，未引入额外请求。

## 实际验证

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node --test` 执行月报、事项、账单与视觉相关 6 个测试文件 | 50/50 | `execution/native-task-journeys-targeted.log` |
| `npm.cmd test` | 510/510 | `execution/native-task-journeys-node.log` |
| `node tests/browser.cjs` | 总部 Chrome 主回归 13 个检查点全部通过 | `execution/native-task-journeys-chrome-final.log` |
| `node tests/browser-v33-monthly.cjs`、`node tests/browser-finance-ledger.cjs` | 月报权限、重结算、逾期以及财务汇总、分页、导出和运营权限通过 | `execution/native-task-journeys-chrome-monthly.log`、`execution/native-task-journeys-chrome-ledger.log` |
| `node scripts/wechat-validate.cjs` | 20 路由，126 个文件，无静态校验错误 | 控制台 |
| `node scripts/style-audit.cjs` | 公共样式及四个 Tab 安全区通过 | 控制台 |
| `node scripts/wechat-compile.cjs` | 源码及最终隔离构建的 20 页官方编译通过 | `execution/native-task-journeys-compiled-build/compiler-result.json` |
| `node scripts/wechat-build.cjs` | 开发模拟器构建及生产剥离构建通过。生产构建用占位域名和 AppID 校验。 | `execution/wechat-task-journeys-final/build-manifest.json` |
| `git -c core.whitespace=cr-at-eol diff --check` | 通过 | 控制台 |

首次全量回归中的账单总额模板断言仍查找原卡片结构。已按新结构保留对授权范围、加载状态、指定账单和待付金额字段的断言，再跑全量通过。

## 微信界面验收

微信开发者工具 `2.02.2609250 Stable` 已通过界面导入 `execution/wechat-task-journeys-final`，窗口实际显示测试 AppID `wx2946ac0b9ece8923` 和该构建路径。构建清单 SHA256 为 `781d0f7d89d991b464f4ff11b8d592a7426f23e0a197d87439d91cce97c0acf8`。CLI 报告服务端口关闭，界面停在「信任并运行」。阻断截图见本轮开发者工具记录。当前业务界面操作覆盖 0/3。

导入后对构建清单的 123 项重新计算哈希，122 项一致。开发者工具向隔离构建的 `project.config.json` 写入默认设置，AppID、原生项目根、基础库版本及 `urlCheck` 原值一致。工具另生成私有配置，选择的模拟器基础库为 3.18.0。导入后的项目配置 SHA256 为 `c697f4edab8bebcaa1ea3749d8bfaa24335f9602aaa348e02567a18dd015b57b`。

隔离后端使用 `127.0.0.1:18952`。以下请求号来自隔离样本准备，可在本地后端日志核对。

| 测试样本 | 对象 | 请求号 |
| --- | --- | --- |
| 2026 年 10 月退回月报 | `rpt-54fbd4ea-11df-481e-b4e2-02aa05578b7c` | 退回 `4df14d30-94a9-40e7-be2a-cef920c5ab9c` |
| 该月报的退回通知 | `msg-98c970c9-21cc-4f3e-bbf5-89e934cb4589` | 读取 `b19e6bd9-131a-4f4b-a50c-2ef79d8912b9` |
| 2026 年 9 月隔离账单 | `bill-26d129e8-5923-417b-976e-242b662c2e07` | 生成 `8bdc3121-865c-4c9f-837e-e34ca47ebe90` |

## 待执行工作包及通过条件

1. **月报界面复验。** 使用加盟商测试身份从「我的事项」进入已准备的退回通知。确认株洲网点、2026 年 10 月和退回原因，修改客流为 26，保存草稿后退出重进，再重提。检查总部待审队列仅有对应 V2，回到旧通知仍能查看 V1。用窄屏和长网点名检查换行，操作键盘、确认层滚动和弱网重试。实际保留页面截图和请求号。
2. **账单与事项界面复验。** 在 2026 年 9 月长沙网点检查待付金额、切换筛选与历史、打开原账单并返回。随后在通知的「已读」筛选进入已完成事项，再返回确认筛选和标题。下一位验收者使用另一账号核对无权网点不可访问。
3. **组件引入评估。** 样板实操通过后，评估状态标签或空态是否能减少维护成本。需要可复现构建、蓝白样式、包体积和原生交互验证，再决定是否接入。当前仍使用原生组件。
