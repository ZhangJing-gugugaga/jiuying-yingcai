# 总部 Web 与共用 API

这里运行同一个 Node.js 服务。它提供总部页面，也为微信小程序提供 API。

## 本地运行

需要 Node.js `>=24.19.0 <25`。从仓库根目录执行：

```powershell
npm --prefix web ci
powershell -NoProfile -File .\web\start.ps1
```

首次安装或锁文件更新时运行 `npm ci`。日常启动运行第二条即可。

- 总部页面 [127.0.0.1:8787](http://127.0.0.1:8787/)
- 服务状态 [/health](http://127.0.0.1:8787/health)
- 默认开发库 `web/var/local.db`

需要改端口、模拟渠道或数据库时，参考 [.env.example](.env.example) 设置 `web/.env`。`start.ps1` 在 `web/` 下读取该文件，`DB_PATH` 使用绝对路径或相对 `web/` 的路径。已有 SQLite 库可以直接指向原文件。单独运行 `npm start` 或 `npm run migrate` 时，通过进程环境传入所需配置。

## 源码位置

| 路径 | 用途 |
| --- | --- |
| [admin-web/](admin-web/) | 总部页面与交互 |
| [server/](server/) | HTTP、鉴权、数据访问和后台作业 |
| [shared/](shared/) | 业务规则、状态转换和责任分派 |
| [database/](database/) | SQLite 迁移 |
| [tests/](tests/) | 业务、接口和前端回归 |
| [scripts/](scripts/) | 检查、构建和维护工具 |

## 本地检查

下列命令在 `web/` 内按改动范围选跑：

```powershell
node scripts/check-syntax.cjs
node --test tests/agency-service-fees.test.cjs
node tests/browser.cjs
npm test
```

第二条是运行单个业务测试的例子。浏览器回归需要本机 Chrome，`npm test` 运行全套 Node 测试。

[小程序调试](../miniprogram/README.md) · [API](../docs/API.md) · [迁移与部署](../docs/DEPLOYMENT.md)
