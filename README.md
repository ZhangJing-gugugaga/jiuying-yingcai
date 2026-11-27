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

常规联调只需启动一次后端。Chrome 打开[总部 Web](http://127.0.0.1:8787/)，微信开发者工具在原 `miniprogram/` 项目点「编译」。两个前端默认使用同一服务 8787。

### 本机集团隔离试用

Chrome 打开[隔离总部 Web](http://127.0.0.1:18876/)。小程序先退出当前账号，在微信开发者工具调试器 Console 执行 `wx.setStorageSync('jyyc.simulator.environment', 'group-review')`，点「编译」后登录隔离账号。要恢复常规联调，退出隔离账号，执行 `wx.removeStorageSync('jyyc.simulator.environment')` 并再次编译。这个选择仅保存在当前模拟器。真机和发布包沿用独立构建配置。

如需重启本机已有的隔离后端，从仓库根目录指定试用库：

```powershell
$env:DB_PATH = (Resolve-Path .\var\group-review\trial.db).Path
$env:PORT = "18876"
$env:HOST = "127.0.0.1"
$env:ADAPTER_MODE = "mock"
$env:SCHEDULER_ENABLED = "0"
node .\backend\server\index.cjs
```

## 常用文档

- [项目协作约定](AGENTS.md) · [开发流程](docs/DEVELOPMENT.md)
- [产品规格](docs/PROJECT-SPEC.md) · [页面结构](docs/PAGE-STRUCTURE.md) · [API](docs/API.md)
- [当前待办](TODO.md) · [变更记录](CHANGELOG.md)
