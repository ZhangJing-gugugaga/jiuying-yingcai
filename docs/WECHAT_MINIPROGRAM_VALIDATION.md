# 微信原生小程序整改验证记录

> 历史资料。下文的“当前”“本轮”及验收数字均指报告出具时的版本。查阅 [V4.1 交接说明](handoff/00-开发交接总说明.md)了解现行范围及验收进度。

历史记录，适用于 2026-11-18 的 V3 整改阶段 18 页副本。报告保留当时的命令、结果与后续真机计划。V3.3 的 19 页及平台验收证据见 [V3.3 当前发布状态](V3.3当前发布状态.md)。

验证日期：2026-11-18。工作区：`jiuying-yingcai-remediation`。只修改本轮副本，旧 V3 源目录保持不动。

## 实际状态

| 层次 | 本轮结果 | 证据与边界 |
| --- | --- | --- |
| 原生工程与环境构建 | 通过 | 18 页 JS/WXML/WXSS，开发/测试/生产独立生成；生产物理移除开发角色模块与入口 |
| 静态事件、路由、JSON、JS、隐私声明检查 | 通过 | `scripts/wechat-validate.cjs`，不是微信编译 |
| 官方 WXML/WXSS 编译器 | 通过 | `wcc.exe`、`wcsc.exe` 均退出 0；`execution/wechat-validation/compiler-result.json` |
| 原生 Page → HTTP → SQLite | 29/29 通过 | 原 16 项测试保留，新 13 项整改测试；平台设备 API 用桥接，后端及数据库真实运行 |
| 源 WXML/WXSS 视觉回归 | 20 个视图无横向溢出 | `execution/native-preview/verification.json`；浏览器转换只作视觉检查 |
| 完整微信 IDE 导入与模拟器 | 未完成 | CLI 已实际执行，阻断于工具服务端口关闭；无成功导入/模拟器记录 |
| 微信真机、平台审核、生产支付联调 | 未执行 | 尚缺真实 AppID、HTTPS 域名、平台凭证及设备；不使用测试夹具冒充真实联通 |

## 官方工具来源与完整性

初始 `Get-Command`、安装注册表和常见安装路径均未发现微信开发者工具。随后只使用官方页面及其脚本指向的腾讯 CDN：

- 下载页面：<https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html>
- 官方页面脚本发现的版本表：<https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json>
- 稳定版本：`2.02.2609250`，版本表发布日期 `2026-11-06`。
- 下载地址：<https://devtools.wxqcloud.qq.com.cn/WechatWebDev/release/be1ec64cf6184b0fa64091919793f068/wechat_devtools_2.02.2609250_win32_x64.exe>
- 文件大小：196,823,688 字节。
- SHA-256：`6AF4ACB487883F4335206171E13B9B42A27BA2B8434EE3FE83A5F43D5D49F9B8`。
- `Get-AuthenticodeSignature` 状态 `Valid`；发布者 `Tencent Technology (Shenzhen) Company Limited`。
- 静默安装到 `execution/wechat-tools/devtools`，安装进程实际退出码 0。安装包和工具二进制不进入源码发布 ZIP。

已运行 `cli.bat --help`，确认官方 CLI 可执行。`cli.bat open --project <绝对原生目录> --port 9421 --lang zh` 与 `islogin` 返回 `IDE service port disabled`；记录在 `execution/wechat-validation/cli-attempt.txt`。未修改安全设置、未扫码登录、未上传源码。为此次检查启动的隐藏工具进程已退出，原有个人微信不受影响。

工具内官方编译器的版本：WXML core `v0.5vv_20211229_syb_scopedata`，CLI `20230804`；WXSS `v0.4me_20200724_db`。这只是所下载稳定版捆绑的编译器标识，不代表工具整体版本过旧。二进制逐一 SHA-256、调用参数、输出字节数见 `compiler-result.json`。

## 先失败、修复、再验证

1. 新回归先复现环境生成缺失、tabBar 错用 navigateTo、部分草稿被完整校验拒绝、当前有效版本缺失、GPS accuracy=0 丢失；没有删除或放宽原有断言。
2. 真实支付桥接回归先证明旧 `pay` 会调用模拟确认命令；修复为预支付 → `wx.requestPayment` → 服务端查单。取消或失败也仅查单，不确认或伪造实收。
3. 官方 WXML 编译首次退出 2：`pages/agreements/index.wxml:1:1523: Bad attr wx:if ... unexpected ; at pos17`。原因是 `{{ }}` 内使用 `&amp;&amp;`，原有浏览器转换会解码，微信编译器不会。
4. 只在 WXML 表达式内恢复原生运算符 `&&`；正文实体不变。新增静态回归拒绝表达式内 HTML 实体。随后所有 18 页官方 WXML 编译退出 0，WXSS 编译退出 0。
5. `tests/miniprogram-v3.test.cjs` 的密码单测使用 HTTPS 测试 URL，匹配新增非开发环境约束；账号/密码/令牌不落存储的原断言全部保留。报表新 context 同步同网点同月 `state.reports` 兼容旧调用，不恢复全量 state 依赖。

6. 客服追加回归先复现“处理中”使用 claimed 导致接单 active 工单不可见、向 closed 咨询续写旧记录。修复筛选为 active，详情与消息角色中文展示；closed 咨询再次发送/转人工先创建新记录并选择返回结果，旧咨询保持关闭，正式工单关闭规则不变。两项 Page → HTTP → SQLite 回归通过。

## 已执行命令

```powershell
node --test tests/miniprogram*.test.cjs
node scripts/wechat-validate.cjs
node scripts/wechat-compile.cjs --tool-dir execution/wechat-tools/devtools
node scripts/wechat-build.cjs --environment development --target simulator --out execution/wechat-validation/development-package-final3
node scripts/wechat-compile.cjs --tool-dir execution/wechat-tools/devtools --project execution/wechat-validation/development-package-final3 --out execution/wechat-validation/generated-compile-final3
node execution/native-preview/render.cjs
```

环境生成与视觉命令分别生成可导入的最终开发环境目录 `execution/wechat-validation/development-package-final3` 和 20 张源码视觉截图（18 页、额外有效版/待审版对照及合作留言）。视觉中的业务样本来自隔离内存 SQLite，明确为验收数据，不写正式库，不保存访问 token。真实设备定位、摄像头、文件打开、微信登录与支付 SDK 的最终表现仍需真机验证。

## 环境生成、AppID 与域名

源目录 `config.js` 仅指向 `config/environments.js` 的 development/simulator。本地开发可使用 `http://127.0.0.1:8787` 和 `touristappid`；手机不能用此地址访问电脑。导入源目录只用于开发模拟器。

测试或生产必须生成独立目录，不能只改 UI 开关：

```powershell
$env:WECHAT_API_BASE = 'https://由集团提供的真实API域名'
$env:WECHAT_APP_ID = '由集团提供的真实微信AppID'
node scripts/wechat-build.cjs --environment test --target device --out dist/wechat-test
node scripts/wechat-build.cjs --environment production --target device --out dist/wechat-production
```

命令中的中文为说明占位，不可照抄运行；脚本拒绝无效 AppID、HTTP、localhost/127.0.0.0/8/::1 等 loopback、带账户信息或路径的 API base、非空输出及覆盖源目录。`project.config.example.json` 是真实 AppID 模板；构建生成 `compileType=miniprogram`、`miniprogramRoot=./`、`urlCheck=true`。`test` 和 `production` 都不包含 `development/`、角色选择 WXML、`partnerA/partnerB/customActor` 或 `/api/auth/dev` 调用。构建测试的 `wx1234567890abcdef`/`example.test` 仅验证代码路径，不是正式 AppID 或部署地址。

构建不打包服务端、数据库、私钥、AppSecret、支付密钥或短信密钥。`config.js` 仅含环境名、目标、API origin 与开发标记。`build-manifest.json` 给出文件散列和静态检查，明确 `wechatCompiled:false`；要取得官方编译证据需单独执行 `wechat-compile.cjs`。

集团需在微信小程序后台配置与 HTTPS 证书一致的 request、downloadFile 合法域名。当前照片经 `wx.request` JSON 上传，因此使用 request 域名；将来改 `wx.uploadFile` 时还需 uploadFile 域名。文件下载与导出使用同源 Bearer 鉴权。不能为真机或生产关闭域名/TLS 校验，也不能把 127.0.0.1 写成手机服务器地址。正式 AppID 的归属与权限需后台核验，格式校验无法证明归属。

## 原生数据流与口径

- 密码/单次令牌/SMS/微信登录均由服务端返回已建档身份。`wx.login` 只传一次性 code，未绑定明确返回 `WECHAT_UNBOUND`；账户安全用已认证会话绑定微信。短信手机号必须是总部登记号码，挑战绑定手机号、单次使用和限流由后端执行；仅开发 Mock 显示 `devCode` 且注明未真实发短信。
- 微信支付由配置能力控制入口。真实支付创建有幂等键；SDK 返回后只查单，到账以服务端通知验签/查询结果为准。到期关闭先经后端查单，未到期或已支付不能关闭。模拟按钮只出现在 mock adapter。
- 草稿未填数值保持 null，显式清空仍为空；正式报送完整校验。招生 pending 不再默认为适用，界面可保存草稿、禁止提交。
- 月报 `GET /api/reports/context` 明确当前有效版、最新提交版、草稿和历史。单字段与整版更正输入明确，差异按服务端 before/after 展示，不自行推断严重程度。
- GPS 记录 `source/coordinateSystem/accuracy/capturedAt`，0 米精度不丢失；手动选点清楚标明非现场 GPS 证据。偏差结论、基准与阈值直接展示服务端 assessment。
- 覆盖指标直接展示 reportingCoverage，免报扣除应报，零值、缺失、待审核、待确认分别表达；没有增加前端金融计算。公开地图优先 publicLocation，只在已授权私有页面兼容内部坐标。
- tabBar 深链通过 switchTab 与一次性查询存储投递；客服已读与业务完成分开，明确“已查看回复”调用 support.ack。所有列表仍有分页，不恢复首页全量 state 读取。

## 隐私配置与人工验收

登录页与“我的”提供 `wx.openPrivacyContract` 入口；后台未配置或微信版本不支持时明确提示，不伪造正式隐私协议。`app.json` 声明 `getLocation/chooseLocation` 及主动定位用途，不后台追踪。集团上线前需在小程序后台配置隐私保护指引：手机号用于已建档身份验证；精确定位/精度/采集时间和照片用于主动位置核验；联系方式与留言仅用于本次合作联系；经营/付款记录按职责授权访问。保留期限、联系人和删除/更正处理规则必须由集团确认后发布。

人工验收顺序：

1. 在已安装官方工具中由操作人开启 CLI 服务端口或手动导入生成目录；使用合法 AppID 登录。保留导入、编译、模拟器页面及控制台结果，不用本文件的静态结果代替。
2. 配置 HTTPS 服务并从真机请求；确认生产包没有开发角色入口，错误身份无法读取其他网点。
3. 验证短信登录、重复/过期验证码、未绑定微信、绑定后微信登录、改密注销旧会话；确认日志无明文凭证。
4. 只填收入保存草稿并重进恢复；招生待确认时不可提交；V1 通过、V2 待审时两版并存，差异可见，正式统计仍取有效版。
5. 真机获取 GPS/手动选点/拒绝权限、上传照片、查看采集时间与偏差标记；公众地图只含授权公开位置。
6. 微信支付测试商户验证成功、取消、网络中断、查询中、到期关闭及重复通知；对账确认只产生一次实收。核对账单金额与当前版本，不能只凭 SDK success 判已收款。
7. 实机逐页检查 tabBar 深链、客服确认回复、200 条后的分页、XLSX/PDF 打开、隐私指引和公共空态。

原生修改无独立数据库迁移；依赖同版本服务端 auth/reportContext/payment/coverage 契约与其迁移。回滚须使用兼容后端，不能回退后端删除新增业务记录。无模型调用或新运行依赖；前端认证与主动查单由用户触发；服务端对未确认支付执行有限后台核实，每 60 秒至多扫描 1 单、每单至多 8 轮退避，无新增短信自动推送；列表每次 50 条。
