# 配置、迁移与部署

四入口版部署前备份 SQLite 数据库，使用项目迁移命令依次应用缺失的 029（加盟申请）、030（补件关联申请及版本）、031（公开网点照片用途登记）、032（月报提交人姓名快照）和 033（分级代理直属关系）。迁移 032 保留既有事件，历史姓名缺失时显示未留存；迁移 033 不改旧主体 data，缺少 level 时按未设置处理。小程序随源码提供 TDesign 组件，安装锁定依赖后可用 `npm run wechat:vendor -- --check` 校验。

Node >=24.19.0 <25，首次npm ci；pdfkit/sharp锁定，字体与许可证随包保留。默认开发样本只用于本机，不能复用为正式库。npm start不读取.env，使用start.ps1或node --env-file=.env server/index.cjs。

当前部署基线采用持久化 SQLite、Node.js 常驻服务与 HTTPS 反向代理。仓库交付的运行方式依赖常驻进程和持久磁盘。V4.1 验收范围与未完成项见[当前待办](../TODO.md)和[交接验收](handoff/05-验收与开发协作.md)。

## 初始化与网络

全新无样本库执行 `powershell -NoProfile -File scripts/setup-admin.ps1 -Username headquarters -Name 总部管理员 -Database var/production.db`，交互安全输入密码。设置NODE_ENV=production、DB_PATH、ADAPTER_MODE=disabled和精确HTTPS PUBLIC_ORIGIN，使用受控HTTPS反向代理、进程托管、最低权限数据库目录。HOST/PORT是内部监听，公网TLS与微信合法域名须另配置；mock模式仅绑定loopback。

无外部授权先运行内部密码/人工凭证流程。启用微信登录配置WECHAT_AUTH_MODE=real及AppID/Secret/IDENTITY_ENCRYPTION_KEY；短信SMS_PROVIDER=tencent及签名模板参数。启用支付需ADAPTER_MODE=real、WECHAT_PAY_ENABLED=1、商户RSA私钥、微信支付公钥ID/文件、32字节APIv3Key与HTTPS回调。公众号WECHAT_OFFICIAL_ENABLED=1，独立AppID/Secret/Token/EncodingAESKey和安全模式回调。完整密钥名见.env.example和上线资料清单。填入配置后仍要真实联调，不直接发布。

微信回调地址：POST /api/payments/notify；公众号GET/POST /api/wechat/official/callback。代理应保留原始请求体和支付签名头，不重写。请求来源限制与微信服务器签名是不同边界；不得为回调关闭验签。真实平台异常时保持订单/消息待核实，不能回落Mock成功。

## 原生构建

开发：`node scripts/wechat-build.cjs --environment development --target simulator --out dist/wechat-development`。真机先受控设置WECHAT_API_BASE为实际HTTPS origin及WECHAT_APP_ID，再用 `--environment test --target device --out dist/wechat-test`；生产用production。脚本拒绝loopback/HTTP/占位AppID，非开发包移除角色选择，urlCheck=true。输出目录不能覆盖源码或非空目录。原生secret只放服务器。

官方 wcc/wcsc、IDE 导入、模拟器交互与真机分别留证，见 [V4.1 综合验收报告](handoff/验收证据/V4.1原始综合验收报告.md)。生产需要合法 request/download 域名。当前照片用 wx.request JSON 上传，将来改用 wx.uploadFile 时再配置 uploadFile 合法域名。设备无法访问电脑 127.0.0.1。

## 迁移、备份与回退

`npm run migrate` 按 `database/` 中的 SQL 迁移编号执行并记录到 `schema_migrations`，先备份再升级。009 修复已知旧申请默认值并保留历史报表，010—013 扩展身份、支付、公众号及查单字段。005 冲正账单部分唯一索引不能回退为全量唯一约束。006 遇到重复红票历史会拒绝升级，须人工核实后前向修复。大库锁表与执行时长按目标维护窗口实测。

在隔离备份并确认 `DB_PATH` 后执行。正式标记的数据库要求迁移和备份创建命令显式处于 `NODE_ENV=production`，测试或未设置环境的命令会在修改源库前拒绝。备份校验及恢复到全新目标无需选择生产运行模式。`DB_PATH` 指定源库后：`node scripts/backup.cjs create <新备份.db>`；`verify <备份.db>`；`restore <备份.db> <全新恢复路径.db>`。VACUUM INTO一致性快照含manifest摘要/数量/迁移/审计链；不覆盖已有库。恢复验证后切流，快照之后的资金/消息外部副作用必须对账，不能靠还原库撤销。身份/公众号解密密钥随安全备份保管；换密钥需可解旧数据的专门迁移，不直接替换丢失。

## 后台作业与运行验证

常规业务调度按上海日期和明确协议/制度运行，SCHEDULER_ENABLED=0可显式关闭。真实支付worker每60秒最多1单，8次查单退避1/2/4/8/16/32/60/60分钟；只在过期且NOTPAY时关闭，失败/未知/次数用尽保留pending与last_error供人工。公众号worker每30秒最多1条pending，超过2分钟sending标uncertain，禁止盲重发。入口启用worker，停止时等待在途工作。

GET /health只说明进程/数据库，不是发布就绪；manager GET /api/operations/health含计数/耗时、数据库quick_check、审计链、支付及消息积压queues。告警接收人、阈值、磁盘与备份监控须部署设置。当前本机内存SQLite负载冒烟不是生产SLO。

发布前完成依赖安装、语法与全量测试、对应版本的总部 Chrome 回归、官方编译、微信模拟器和真机、真实身份与短信、支付及公众号联调、容量安全与恢复演练。最终 ZIP 须按新 SHA256 在独立目录验包。本轮真实支付和退款保持禁用。详见 [交接复验记录](handoff/验收证据/本轮复验记录.md) 和 [验收与开发协作](handoff/05-验收与开发协作.md)。
