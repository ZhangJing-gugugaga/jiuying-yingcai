# 九盈英才

九盈英才连接公众、加盟商和集团总部。公众通过微信小程序查询服务和网点，加盟商办理月报、位置核验、账单与工单，总部通过 Web 分派、审批和结算。两个客户端共用 Node.js API 和 SQLite 数据库。

当前版本为 V3.4.4 四入口版，包含分级代理报送。页面入口见[页面结构](docs/PAGE-STRUCTURE.md)，当前进度和遗留问题见[待办](TODO.md)。

## 本地启动

首次使用 Node.js `>=24.19.0 <25`，在仓库根目录执行 `npm ci`。平时用 PowerShell 启动后端。

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
powershell -NoProfile -File .\start.ps1
```

打开 [总部 Web](http://127.0.0.1:8787/)。默认开发库是 `var/local.db`，服务状态可看 [/health](http://127.0.0.1:8787/health)。

微信开发者工具选择「导入项目」，目录选 **[miniprogram/](miniprogram/)**，即仓库下含 `app.json` 和 `project.config.json` 的子目录。已经打开该目录时，直接点「编译」。小程序默认连接同一个本地服务 `http://127.0.0.1:8787`。

## 开发入口

| 工作 | 文档 |
| --- | --- |
| 确认一期范围和角色权限 | [产品规格](docs/PROJECT-SPEC.md) |
| 定位页面、接口和数据 | [页面结构](docs/PAGE-STRUCTURE.md) · [架构](docs/ARCHITECTURE.md) |
| 修改界面 | [视觉与交互](DESIGN.md) · [组件规范](docs/COMPONENT-GUIDELINES.md) |
| 日常开发和调试 | [协作约定](AGENTS.md) · [开发流程](docs/DEVELOPMENT.md) |
| 准备发布或复查进度 | [部署手册](docs/DEPLOYMENT.md) · [当前待办](TODO.md) · [变更记录](CHANGELOG.md) |

完整入口及历史附件情况见[文档索引](docs/README.md)。
