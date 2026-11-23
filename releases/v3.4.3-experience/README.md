# 九盈英才 · V3.4.3

包含 20 页微信原生小程序、总部 Web、Node.js 24 API 和 SQLite 迁移。V3.3 补齐微信与支付宝双渠道、账务汇总、历史月报重结算、公众号用户可见回复和五项业务公开发布。V3.4 补充经营数据待重结算状态、协议历史日期、导航失败恢复，以及位置、账号和客服流程。

当前发布状态只见源码 ZIP 同目录的《完整测试报告.md》，用《SHA256与独立验包记录.json》核对版本。docs 内既有 V3.3 与 V3.4 报告均为历史，见 [历史验收版本索引](docs/历史验收版本索引.md)。人工验收使用隔离数据库、Mock 支付和签名替身，本轮禁止真实商户调用、扣款与退款。详见 [交付与人工验证](docs/DELIVERY.md)。

## 本地启动

安装 Node.js >=24.19.0 且 <25，在本目录执行：

```powershell
npm ci
Copy-Item .env.example .env
powershell -NoProfile -File .\start.ps1
```

总部入口 http://127.0.0.1:8787，默认开发库 var/local.db。样本、开发角色和 Mock 支付有明确标记，不发生真实扣款。运行依赖 pdfkit 0.20.2、sharp 0.35.5 由锁文件固定；字体及许可随包保留。npm start 不自动读取 .env，可用启动脚本或 `node --env-file=.env server/index.cjs`。升级执行编号迁移，不删除数据库。

无样本内部密码身份：`powershell -NoProfile -File scripts/setup-admin.ps1 -Username headquarters -Name 总部管理员 -Database var/production.db`，交互输入至少 12 位密码。配置 production、独立 DB_PATH、ADAPTER_MODE=disabled、实际 HTTPS PUBLIC_ORIGIN，部署受控反向代理后启动。总部创建个人岗位并发一次激活码；公众或加盟商不能自选总部角色。

## 微信原生工程

开发模拟器可导入 miniprogram；touristappid 与回环 API 仅用于开发。测试/生产生成独立包：

```powershell
node scripts/wechat-build.cjs --environment development --target simulator --out dist/wechat-development
```

真机先通过环境变量配置真实 WECHAT_APP_ID 和 HTTPS WECHAT_API_BASE，再用 `--environment test --target device --out dist/wechat-test`；生产用 production。输出目录须为空，不能覆盖源码。非开发构建物理移除开发角色入口，开启域名校验；真机不接受 loopback。AppSecret/短信/支付密钥只放服务器，不进入小程序包。

当前原生工程注册 20 页，包含业务学习与培训。平台配置和人工验收路径见 [实战交接](docs/实战交接.md)，原始证据见当前源码 ZIP 同批交付的《实战全轮测试与验收报告.md》。

## 验证与资料

```powershell
npm test
node tests/browser.cjs
node tests/browser-round2.cjs
node tests/browser-remediation.cjs
node tests/browser-payments.cjs
node tests/browser-v32.cjs
node tests/browser-finance-ledger.cjs
node tests/browser-v33-monthly.cjs
node tests/browser-v33-content-support.cjs
node tests/browser-v34-finance.cjs
node tests/browser-v34-support.cjs
node scripts/v32-load.cjs
node scripts/wechat-validate.cjs
```

npm ci 安装锁定开发依赖 Playwright 1.62.1，浏览器脚本另需已安装 Google Chrome。可选用 PLAYWRIGHT_PATH 覆盖模块路径。微信设备 API 在 Node 测试中桥接，HTTP 和 SQLite 在本机运行。完整命令、退出码和原始日志路径见 [测试报告入口](docs/TEST_REPORT.md)。

微信 code2session/绑定、腾讯短信、微信支付 JSAPI/验签/解密/查单、公众号安全模式与回复 outbox 已有适配代码和边界测试，真实平台联调待办。订阅消息、地图地理编码、对象存储和病毒扫描待接入。详见 [上线资料清单](docs/上线资料清单.md)、[待确认规则](docs/PENDING_DECISIONS.md) 和 [平台阻断清单](docs/平台阻断清单.md)。

金额仍以元接口、整数分计算/持久化，null 与 0、不适用分开；未知首月/转让/多月预付分摊不推算。最终 ZIP 不含密钥、业务库、工具安装包或 node_modules，需重新解压 npm ci、迁移与测试后单独记录校验结果。
