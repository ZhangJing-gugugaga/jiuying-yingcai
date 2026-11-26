# 工程架构与数据组织

微信小程序和总部 Web 通过 HTTP 访问同一 Node.js 服务。业务命令经身份与对象范围校验后更新 SQLite，页面经集合接口读取授权投影。

| 路径 | 职责 |
| --- | --- |
| `miniprogram/app.json`、`custom-tab-bar/`、`utils/navigation.js` | 注册页面与分包、访客/加盟商导航、深链和登录恢复 |
| `miniprogram/pages/` | 原生 Page、WXML、WXSS、页面配置和模块办理界面 |
| `miniprogram/utils/{api,page,business-drafts,report-recovery,track}.js` | HTTP、会话、页状态、重试键、短期草稿恢复与仅开发诊断 |
| `web/admin-web/app.js` 及审批、客服、财务、员工、导出等模块 | 总部 Web 和按身份开放的兼容界面 |
| `web/server/index.cjs`、`auth.cjs`、`repository.cjs`、`command-scope.cjs` | HTTP 契约、请求号、认证、SQL 数据可见性及写入范围 |
| `web/shared/core.cjs`、`operations.cjs`、`task-routing.cjs`、`responsibilities.cjs` | 业务状态转换、业务命令、角色校验、任务责任分派 |
| `web/server/storage.cjs`、`web/database/` | SQLite、迁移 001–033、事务、对象投影、授权和审计 |
| `web/server/{staff-login,work-contacts,approval-export,approval-history,training}.cjs` | 员工身份、公开工作号码、分项审批导出与审计、培训业务 |
| `web/server/{analytics,finance,payments,exports}.cjs` 与渠道模块 | 统计、财务台账、支付退款、导出、微信和支付宝的服务端适配 |
| `web/scripts/`、`web/tests/`、`docs/` | 本地、生产构建与备份、回归测试和既有业务记录 |

## 接口与数据

| 入口 | 契约要点 |
| --- | --- |
| `GET /api/config`、`/api/context` | 环境与可用渠道、角色、当前主体、授权和业务日期。配置决定前端入口 |
| `/api/auth/*` | 密码、激活、访客、微信、短信、账号安全及适用总部身份能力。服务端签发会话并核对状态、有效期和绑定版本 |
| `GET /api/collections/:name[/:id]` | 按授权过滤后分页，默认 50、最大 200；详情与列表按同一边界。组合筛选以实际字段契约为准 |
| `POST /api/commands` | JSON `{command, payload}`，带 `Idempotency-Key`。同主体同键的相同请求可复核前次处理，修改负载应使用新键 |
| `/api/tasks*`、`/api/reports/context` | 事项概览/列表/详情，报送资格、网点月份、状态及最近版本 |
| `/api/dashboard`、`/api/export`、`/api/finance/*` | 统计过程/正式层、授权导出、服务费汇总及台账 |
| `/api/files`、`/api/files/:id` | 图片上传/受权限保护的读取。附件用途、尺寸、图像解析及提交归属由后端校验 |
| `/api/work-contacts*`、`/api/approval-exports*`、`/api/training/*` | 授权工作号码、按字段导出管理与下载、既有培训业务 |
| `/api/payments/*`、`/api/wechat/official/*` | 在线支付、渠道查询和证据、公众号入站与回复。需受控渠道配置 |

正常 JSON 响应包含业务数据和请求编号。业务命令按当前对象状态处理，外部调用保持有限超时和重试。改动接口前核对小程序、总部 Web、相关脚本和测试；保留旧数据读取，结构变化使用新增的前向迁移。影响资金、结算、权限或历史数据时使用目标库的脱敏副本验证，带对账和回退步骤。 [API 契约](../docs/API.md) · [数据字典](../docs/DATA_DICTIONARY.md) · [服务端路由](../web/server/index.cjs)

原始需求、交接说明和验收证据集中在 [handoff](handoff/00-开发交接总说明.md)。
