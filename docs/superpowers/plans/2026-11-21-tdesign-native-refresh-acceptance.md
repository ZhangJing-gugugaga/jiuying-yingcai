# 九盈英才小程序 TDesign 视觉改版验收

## 交付效果

| 页面 | 改动 |
| --- | --- |
| 公众首页 | 浅蓝网格、细线弧纹和 3D 网点插画。查网点是主操作，集团业务和申请加盟各有一张大卡片。集团介绍、全域地图、联系总部与合作咨询进入同一组宫格。 |
| 加盟商工作台 | 待办和首家网点入口在主要位置。核验、咨询服务费和我的事项用不同色调的图标，通知使用红点。 |
| 登录、首次激活 | 使用 TDesign 输入框和主要提交按钮。账号、密码、激活码、验证码的条件、校验和提交函数仍由原页面控制。 |
| 个人中心 | 账号安全、集团介绍、问题帮助和总部客服改用带图标的单元格。 |
| 月报、账单及其他业务页 | 月报、账单、财务、通知、我的事项、集团、申请、核验和客服使用统一的 TDesign 空状态。筛选、原记录定位、附件、地图和业务操作使用原交互。 |

腾讯 TDesign 微信小程序版 1.18.0 以 MIT 许可接入。工程本地包含 11 个组件，约 751 KB（含图标字体），完整开发构建目录的主包文件合计约 1.35 MB（含清单与源配置，未计微信工具压缩）。首页原创 WebP 为 23,772 字节。图标和插画均从应用包读取。此轮无 API、数据库迁移、财务口径或运行服务成本变化。

图像使用内置图像生成工具制作。素材为一座蓝色玻璃拱门与白色建筑，配少量定位标记和浅蓝轨道，用于表达国内外网点分布。提示词为 “Create a premium original 1:1 commercial hero illustration asset for a Chinese group's mobile mini-program, no text whatsoever. Theme: a clear, recognizable service network across cities and overseas. One central floating porcelain-white building with a bold cobalt blue glass arch and one small azure location pin rising above, set on a small circular glass architectural base, two tiny blue satellite map pins connected with a fine path, elegant low-contrast thin orbital rings and soft contact shadows. Refined tangible 3D product photography quality, physically realistic matte ceramic with translucent blue glass, accent of very subtle warm amber for one small point, mostly snowy sky-blue monochrome. Clean editorial composition, three-quarter view, soft sunny studio lighting. Very pale ice blue seamless background (#e4f1ff feel) with soft edge vignette graduating paler, no strong frame; objects centered inside the middle 72 percent with generous space. Legible at small thumbnail size. No people, no map borders, no labels, no letters, no typography, no watermarks, no logos, no app UI. Standalone illustration only.”

组件与图标来源：[TDesign 微信小程序版](https://github.com/Tencent/tdesign-miniprogram) · [TDesign 图标](https://github.com/Tencent/tdesign-icons)

## 实际验证

| 检查 | 结果 |
| --- | --- |
| `npm run wechat:vendor -- --check` | 11 个组件、51 个生成文件均与锁定版本一致。 |
| `npm audit --parseable` | 0 项已报告漏洞。 |
| `node scripts/check-syntax.cjs`、`node scripts/style-audit.cjs`、`git diff --check` | 通过。 |
| `node scripts/wechat-build.cjs`、`node scripts/wechat-compile.cjs` | 开发与发布检查产物各 21 页通过官方 WXML/WXSS 编译，包含组件模板、WXS 和 WXSS。发布检查使用不可联通的样例 API 地址。 |
| 原生前端相关测试 | 131 项通过。组件专项验证按钮、输入框、宫格和单元格事件。 |
| `node --test --test-concurrency=4 tests/*.test.cjs` | 545 项中 537 通过、8 失败。失败项与改版前 542 项中的 8 项一致，涉及旧测试账号会话、位置核验、短信以及看板导出。 |
| 微信开发者工具 | 已观察到新版公众首页缩略图。隔离日志观察到公开内容请求 `e6709b2d-7586-488b-91c1-fc182853a491` 返回 200。 |
| 微信模拟器逐页交互 | 最新工程窗口处于最小化状态，项目列表打开操作未能恢复目标窗口。CLI 报告服务端口关闭。21 页逐页点击、登录输入实测及窄屏复验待完成。 |
| 真机、真实平台与集团人员独立试用 | 未执行。 |

## 文件和继续验收

- 页面可编辑源码在 `miniprogram`。组件安装和重新生成说明见 `miniprogram/README.md`。
- 制作过程的项目缩略图为 `execution/tdesign-refresh/wechat-home-thumbnail.png`。
- 最终开发构建为 `execution/tdesign-refresh/final-dev`。官方编译记录为 `execution/tdesign-refresh/final-official-dev/compiler-result.json` 和 `execution/tdesign-refresh/final-official-release/compiler-result.json`。
- 全量测试记录为 `execution/tdesign-refresh/node-verified.log`，改版前对照记录为 `execution/five-frontend-fixes/node-all.log`。
- 恢复先前已信任的 `execution/wechat-ux-acceptance-final`，使用隔离环境验证首页「查找服务网点」「全域地图」「集团业务」「申请加盟」，随后验证登录输入、个人中心跳转、工作台通知以及无记录状态。
