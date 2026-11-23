# 九盈英才

九盈英才连接公众、加盟商和集团总部。公众通过微信小程序查询服务和网点，加盟商办理月报、位置核验、账单与工单，总部通过 Web 分派、审批和结算。两个客户端共用 Node.js API 和 SQLite 数据库。

当前源码采用 2026-11-23 接收的 **V3.4.4 四入口收拢版**。访客从首页申请加盟，总部 Web 核实到账、审核材料并签发激活码。启动前安装锁定依赖，数据库升级至迁移 030。历史 V4.1 交接基线和本次差异见[版本记录](CHANGELOG.md)。

V3.4.3 体验修订版可在独立目录构建和复验。其依赖、迁移与历史验收范围见[版本源码说明](releases/v3.4.3-experience/README.md)。

## 本地启动

安装 Node.js `>=24.19.0 <25` 和 npm。在项目根目录打开 PowerShell，使用本机隔离样本启动。

```powershell
node --version
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
powershell -NoProfile -File .\start.ps1
```

打开 [总部 Web](http://127.0.0.1:8787/) 或检查 [/health](http://127.0.0.1:8787/health)。默认开发库为 `var/local.db`。切换环境时核对 `DB_PATH`、端口与渠道模式。`start.ps1` 加载本地配置；单独使用 `npm start` 时通过进程环境提供配置。

## 开发入口

| 工作 | 文档 |
| --- | --- |
| 确认一期范围和角色权限 | [产品规格](docs/PROJECT-SPEC.md) |
| 定位页面、接口和数据 | [页面结构](docs/PAGE-STRUCTURE.md) · [架构](docs/ARCHITECTURE.md) |
| 修改界面 | [视觉与交互](DESIGN.md) · [组件规范](docs/COMPONENT-GUIDELINES.md) |
| 开发、提测与构建小程序 | [协作约定](AGENTS.md) · [开发流程](docs/DEVELOPMENT.md) · [构建与分发](docs/REGISTRY.md) |
| 准备发布或复查进度 | [部署手册](docs/DEPLOYMENT.md) · [当前待办](TODO.md) · [变更记录](CHANGELOG.md) |

完整入口及历史附件情况见[文档索引](docs/README.md)。
