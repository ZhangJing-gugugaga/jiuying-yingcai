# 共用后端

Node.js 服务为总部 Web 和微信小程序提供 API，同时从同级 `web/` 提供总部网页。

## 本地运行

需要 Node.js `>=24.19.0 <25`。从仓库根目录执行：

```powershell
npm --prefix backend ci
powershell -NoProfile -File .\backend\start.ps1
```

首次安装或锁文件更新时运行第一条。日常启动运行第二条。

- 总部页面 [127.0.0.1:8787](http://127.0.0.1:8787/)
- 服务状态 [/health](http://127.0.0.1:8787/health)
- 默认开发库 `backend/var/local.db`

需要改端口、渠道或数据库时，参考 [.env.example](.env.example) 设置 `backend/.env`。`start.ps1` 在 `backend/` 下读取该文件。已有数据库可以用 `DB_PATH` 的绝对路径或相对 `backend/` 的路径接入。单独执行 `npm start` 或 `npm run migrate` 时，通过进程环境提供配置。

## 代码与检查

| 目录 | 用途 |
| --- | --- |
| [server/](server/) | HTTP、鉴权、数据访问和后台作业 |
| [shared/](shared/) | 业务规则、状态转换和责任分派 |
| [database/](database/) | SQLite 迁移 |
| [tests/](tests/) | API、业务、总部 Web 和小程序回归 |
| [scripts/](scripts/) | 检查、构建和维护工具 |

在 `backend/` 按影响范围运行相应检查。`node scripts/check-syntax.cjs` 检查语法，`node tests/browser.cjs` 运行总部主流程（需要本机 Chrome），`npm test` 运行全量 Node 测试。

[总部 Web](../web/README.md) · [微信小程序](../miniprogram/README.md) · [迁移与部署](../docs/DEPLOYMENT.md)
