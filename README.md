# 九盈英才

微信小程序供公众查询服务和网点，也供加盟商办理月报、核验、账单和工单。总部通过 Web 分派、审批与结算。两个端共用 Node.js API 和 SQLite。

| 目录 | 从这里开始 |
| --- | --- |
| [miniprogram/](miniprogram/README.md) | 微信开发者工具的项目目录 |
| [web/](web/README.md) | 总部 Web 页面与交互 |
| [backend/](backend/README.md) | 共用 API、数据库和测试 |
| [docs/](docs/README.md) | 产品、技术与验收文档 |

## 本地启动

需要 Node.js `>=24.19.0 <25`。首次从仓库根目录安装依赖：

```powershell
npm --prefix backend ci
```

仍在仓库根目录启动：

```powershell
powershell -NoProfile -File .\backend\start.ps1
```

打开[总部 Web](http://127.0.0.1:8787/)。微信开发者工具打开仓库内的 **`miniprogram/`**，在原窗口点「编译」。两个端默认连到同一个本地服务 `http://127.0.0.1:8787`。

## 常用文档

- [项目协作约定](AGENTS.md) · [开发流程](docs/DEVELOPMENT.md)
- [产品规格](docs/PROJECT-SPEC.md) · [页面结构](docs/PAGE-STRUCTURE.md) · [API](docs/API.md)
- [当前待办](TODO.md) · [变更记录](CHANGELOG.md)
