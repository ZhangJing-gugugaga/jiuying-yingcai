# 九盈英才双端前端重塑验收记录

变更留在现有 `jiuying-yingcai` 工作目录，基线为 `codex/jiuying-ux-rework` 的 `bdc8e8b` 与此前已交付的月报、账单和事项改动。沿用原生微信小程序、总部 Web、现有接口和数据库。

## 页面和交互

| 范围 | 整理内容 | 源码 |
| --- | --- | --- |
| 小程序全局 | 20 路由共享蓝白主题、字号、金额、卡片、状态和表单。四个原生 Tab 提供选中标记，继续为底部安全区留空间。窄屏双列字段改为堆叠。 | `miniprogram/styles/`、`miniprogram/custom-tab-bar/`、`miniprogram/app.json` |
| 访客 | 公开首页以查找网点为主操作，直达集团业务、集团介绍、全域地图、联系总部和加盟商登录。业务卡读取已发布内容，缺封面用业务名称首字。网点搜索先于地图和列表模式选择。 | `miniprogram/pages/home/`、`miniprogram/pages/outlets/` |
| 加盟商 | 工作台先显示待处理事项，再显示日常办理和经营概况。登录显示当前认证步骤，账号和帮助在「我的」分区展示。 | `miniprogram/pages/home/`、`miniprogram/pages/login/`、`miniprogram/pages/profile/` |
| 办理详情 | 月报首屏标出网点和月份。账单突出范围和待付合计。我的事项仅在待处理视图显示月度核验快捷入口。位置核验和客服突出本页办理对象和主操作。 | `miniprogram/pages/{report,fees,tasks,messages,location,support}/` |
| 总部 | 统一分组侧栏、身份栏、工作台、表格和详情面板。先显示待办，再显示经营数据。首次激活独立，可返回日常登录。移动菜单可按 Escape 关闭、恢复焦点，展开时把背景内容设为不可交互。 | `admin-web/{app.js,index.html,styles.css,workspace.css}` |
| 报送状态 | 总部网点表显示当前月报所查月份，读取授权范围内的最新版本。没有记录显示「暂无提交记录」，分页范围未覆盖时引导查看经营月报，已撤销版本有明确标签。 | `admin-web/app.js` |

以上改动使用现有命令、角色权限、通知和业务对象。网点表新增的是既有月报列表接口的月份和最新版本参数，减少了与当前视图无关的查询结果。服务费依旧读取服务端待付合计，金额和结算口径沿用基线。无需数据库迁移或新增依赖。若要回退，保留本轮前的前端文件或从已发布源代码恢复小程序和总部构建即可，数据库与业务记录可继续使用。

## 首次重塑验证

| 验证 | 实际证据 |
| --- | --- |
| Node 全量 | `node --test --test-concurrency=4 tests/*.test.cjs` 511/511，日志 `execution/frontend-redesign-node-verified.log`。默认并发两次出现测试进程序列化通信错误，受影响测试独立通过，以有限并发运行完整测试集。 |
| 语法与样式 | `node scripts/check-syntax.cjs` 检查 129 项。静态校验、四 Tab 安全区检查及 `git diff --check` 通过。 |
| 总部桌面和手机 | Chrome 1440、390 与 320 CSS px 检查。登录、工作台、月报、费用和侧栏共 7 张截图在 `execution/frontend-redesign-chrome/`。320 px 验证费用和客服，无整页横向溢出，余额表允许在表格容器内滚动。 |
| 总部业务回归 | Chrome 17/17 套件通过，按文件逐个执行，日志见 `execution/frontend-redesign-browser-matrix/`。新增断言覆盖月报月份和缺少记录提示、移动端侧栏、Escape、焦点恢复与背景锁定。 |
| 微信官方编译 | 最终开发构建 20 页 WXML 与 WXSS 通过。证据为 `execution/frontend-redesign-compile-final/compiler-result.json`。生产剥离构建通过，使用占位 AppID 和 HTTPS 地址验证构建产物。 |
| 微信运行 | 测试 AppID `wx2946ac0b9ece8923` 的 `execution/wechat-frontend-redesign-final` 已导入官方开发者工具。项目停在「信任并运行」，页面路径为空。CLI 报告服务端口关闭。模拟器交互 0/20，键盘、长文本、布局和实际业务按钮待验。 |

最终开发构建清单 SHA256 为 `e90903cdd974ef942ebb48d7940fcf559980c58c3cafe3893f42bd0a12272246`。隔离后端地址为 `127.0.0.1:18952`。

## 模拟器复验顺序

1. 公众首页进入服务网点，切换地图与列表、筛选境外网点，打开网点详情，再返回完成加盟商测试登录。
2. 从工作台或通知进入指定网点的退回月报。测试窄屏长名称、键盘、草稿、重提、旧版本和总部待办。
3. 查看服务费、指定网点和账期、原账单，再回到通知检查筛选恢复。从待我处理打开月度位置核验。
4. 核对剩余路由的页面、底部导航安全区和空态。按既有权限分别进入客服、账号、培训、服务协议及经营看板。

## 第二轮验收与修复

| 场景 | 复现结果 | 修复后的行为 |
| --- | --- | --- |
| 总部长页面滚动后切换功能 | 手机宽度下滚动 400 像素后，菜单离开视口。通过菜单更换页面后，键盘焦点落回页面容器。 | 手机顶部保留菜单，切页回到顶部且焦点进入目标标题。320 和 390 像素宽度用 Chrome 触控模式复测，结果和截图位于 `execution/frontend-acceptance-fixes-visual/`。 |
| 小程序切换账单网点时请求失败 | 页面已经清空前一网点的账单和金额。上下文请求在网点列表返回前失败时，选择器仍显示旧网点。 | 选择器当即显示新网点，金额与操作等新范围核验成功后再恢复。费用回归用例注入上下文网络失败并验证重试。 |
| 账单历史进入付款凭证 | 历史页展示全部账期，底层跳转仍携带账单页先前选择的月份。 | 两个历史页都显示网点和全部账期。进入总览时携带历史范围，打开单笔原账单时携带该账单的网点、月份和单号。 |

实际修改在 `admin-web/app.js`、`admin-web/workspace.css`、`miniprogram/pages/fees/index.js` 和 `miniprogram/pages/fees/index.wxml`。追加回归覆盖位于 `tests/browser-phase-one-admin.cjs` 和 `tests/v342-native-fees.test.cjs`。改动沿用授权、账单及凭证接口，无新增服务调用。

复验构建在 `execution/wechat-ux-acceptance-final`，构建清单 SHA256 为 `de779470e5983090802367f36c06d2dee38864f9e06d4b5790bed03c62e3d794`。官方 WXML 与 WXSS 编译覆盖全部 20 路由，证据见 `execution/frontend-acceptance-final-wechat/compiler-result.json`。生产剥离构建使用占位 AppID 和 HTTPS 地址验证。

Node 全量 512/512，Chrome 17/17 套件。Node 日志在 `execution/frontend-acceptance-final-node.log`，Chrome 日志在 `execution/frontend-acceptance-fixes-browser/`。费用专项包含入口账期、原账单范围及 Mock 试付，事项和位置专项覆盖通知返回与目标网点。首次全量复跑发现凭证页通用入口也需要保留原账期，修正后全量通过。

开发者工具重开首次重塑工程后，显示「信任并运行」，页面路径为空。微信模拟器交互仍等待项目作者确认。使用复验构建执行界面测试时，隔离后端为 `127.0.0.1:18952`。

## 最终修订工程导入复核

开发者工具 2.02.2609250 Stable 已导入 `execution/wechat-ux-acceptance-final` 并打开确认页面。工程窗口核对到测试 AppID `wx2946ac0b9ece8923`。构建清单的 123 个文件中，122 个通过哈希比对。工具为 `project.config.json` 写入自身的设置，AppID、小程序目录和项目类型核对通过。窗口仍显示「信任并运行」，页面路径为空，模拟器交互仍为 0/20。

隔离 API 预检确认 Mock 后端可用，加盟商甲能读取退回月报原件、退回通知和未付账单。当前隔离库公开境外网点列表返回 0 条，可用于验证空状态。以下编号对应预检请求。

| 预检项目 | 结果 | 请求编号 |
| --- | --- | --- |
| 本地健康检查 | Mock 适配器，SQLite 已就绪 | `bee78f0d-fc91-4181-96e2-c021658d7986` |
| 株洲网点 2026-10 月报 | 已退回 | `a7b23e9d-d995-47bc-9480-e5630d6018e7` |
| 月报退回通知 | 可读取 | `9d88ad70-7d43-4507-b2e7-2f11e44f0f65` |
| 长沙网点 2026-09 账单 | 待支付 | `f9ad579b-31f4-4800-af62-0265ed7e1813` |
| 公开境外网点 | 0 条 | `6b6c45d9-2ede-4f7b-8185-0358c0e3bb86` |

## 11 月 21 日微信模拟器实测与缺陷修复

本节更新上述导入检查的状态。已经通过开发者工具的正常项目确认运行。测试使用原测试 AppID、Pixel 9 模拟器及 `127.0.0.1:18952` 的隔离数据和 Mock 支付。最终构建位于 `execution/wechat-ux-live-approved`，构建清单 SHA256 为 `e97984f24d44770998e1c9472482357d5b0a30787273c68ea8f7410915ead3bc`。开发者工具沿用已导入目录 `execution/wechat-ux-acceptance-final`，分批同步构建后复验；项目私有设置由工具维护。

| 实测问题 | 修改文件 | 界面复验 |
| --- | --- | --- |
| 工作台普通按钮被微信注入的 184px 默认宽度挤占，待办文字过窄且第三个业务入口超出内边距。 | `miniprogram/pages/home/index.wxml`、`miniprogram/pages/home/index.wxss` | 三个快捷入口完整显示，待办标题和网点、月份有足够空间，操作仍可点击。 |
| 退回月报点「修改并重新提交」后，表单滚动到首个字段，当前网点、月份和退回原因在上方。 | `miniprogram/pages/report/index.wxml`、`miniprogram/pages/report/index.wxss` | 进入表单立即看到株洲网点、2026 年 10 月和总部原因。恢复的草稿仍显示经营说明。 |
| 自定义导航未取得页面的主题值，底层卡片和按钮透过导航，选中提示不清。 | `miniprogram/custom-tab-bar/index.wxss` | 导航为实色，访客和加盟商选中样式可见，滚到底后最后一个按钮可以完整操作。 |
| 从付款凭证进模拟支付再查付款账单会叠加两个账单详情，返回出现重复页面。 | `miniprogram/pages/fees/index.js` | 11 月隔离账单付款成功后回到原详情。继续返回是原费用页，再返回进入工作台。不同单号及指定凭证仍按业务记录打开。 |
| 经营月报筛选胶囊也继承了原生 184px 宽度，第四个被裁切，填报主按钮缩水。 | `miniprogram/styles/components.wxss`、`miniprogram/pages/reports/index.wxss` | 四个筛选完整显示，点击「已通过」仍能查到 V2。填报按钮在卡片内占满可用宽度。 |

关联回归在 `tests/native-visual-system.test.cjs`、`tests/v342-native-fees.test.cjs`。修改沿用已有页面路由、业务接口、版本规则和权限。数据库无迁移，金额和结算口径未调整，无新增依赖或外部调用。可用上一份源包还原上述页面和公用样式，隔离测试记录仍可读取。

### 业务结果与请求证据

| 场景 | 实际结果 | 请求编号 |
| --- | --- | --- |
| 访客浏览与登录 | 微信首页进入公开目录，筛选境外后显示空状态，可回到全部网点。通过首页登录开发测试账号，工作台显示本人三个网点。隔离库暂无已公开境外网点详情。 | 访客 `4b52573b-6965-4823-8a5d-792e38e8e9b1`，境外列表 `a88a3792-6f73-4772-a3c3-cd86a03da06c`，加盟商登录 `c2f5eee9-fa81-4f71-acca-fd632227fd7d` |
| 株洲示范网点 B 经营月报 | 微信界面打开退回原件，编辑并保存草稿，退出重进后经营说明恢复。重新提交产生 V2，运营队列收到同一网点和账期的任务。总部运营在 Web 审核通过。小程序从通知重开原单，显示 V2 当前有效、V1 历史退回、当月待结算。 | 草稿 `687139e4-fb7d-4f9f-8fe1-72482dbfa2c1`，重提 `536b148e-dab2-44fc-858c-f6af08275d4b`，总部任务 `675f717a-c667-4700-ac05-296d8d1cea92`，审核 `78110ea3-f201-483d-9aff-77916eaa8f11`，最终版本回查 `1de7bb67-f39d-487b-bb2b-e751eaef2e5e` |
| 隔离 Mock 付款 | 长沙示范网点 A 的 9 月 120 元与 11 月 1980 元测试账单分别走模拟微信付款。原单各显示已付、实收 1 笔、待付 0 元。11 月样例用于复验返回栈。财务接口按两个原单号回查均为已付。 | 9 月 Mock `00ff8fe2-61b8-4f4e-b082-c1e445e8d003`、财务回查 `21732942-c726-42a8-90bf-a77a8aeb8188`；11 月 Mock `16feab9e-89bf-402d-9c68-eb9119d2e3cc`、财务回查 `fbed0e79-3b30-425d-b7bf-36f9bee62bbd` |
| 在线咨询和正式工单 | 微信发送普通咨询、主动转人工后保持在咨询，另行填写并提交衡阳网点的工单。总部 Web 的咨询和工单各有记录。客服找到原单、接单并回复。加盟商从工作台待办打开同一工单见回复，工单留在处理中。 | 咨询 `39a19cd1-d07d-4fd9-a6f1-f957c9ce4cc5`，转人工 `883334f2-a6de-48d2-a7e3-6f632ffbe296`，建单 `d07c0733-0bc3-47a4-97e3-f5fbdfff4427`，接单 `aaaa7123-4ac8-416c-ad59-0fa662ec2bf0`，回复 `081b256f-22ed-4aba-be04-085e09c0176f`，原单回查 `bb45c289-07bf-4b9f-a9f0-bb6bad6fc028` |
| 位置、停费与其他入口 | 「我的事项」可打开月度位置核验，多网点不预选。选择衡阳后显示 11 月与待提交，缺少资料时在提交按钮附近提示。衡阳网点详情显示暂停营业，另有暂停收费表单并锁定所选网点。账号安全和服务协议可打开，分别检查脱敏手机号与所选网点的协议空态。 | 协议 `acb153a1-2d39-4480-b27a-c80c1f815d13`，账号绑定 `7148d51e-7eff-4a7b-beaa-4e5fb0bafedb` |

账单金额为隔离测试样例。原数据关联可由月报 V2 `rpt-a7e6103b-0936-48d6-be39-e5ebe419512a`、总部任务 `task-93fbb35a-671e-44a4-bb54-eb44b55bbd7a`、客服工单 `ticket-4a83a2b7-fe6e-4e28-86e0-97a50dfef24b` 及两笔账单 `bill-26d129e8-5923-417b-976e-242b662c2e07`、`bill-24ba1873-10f1-4178-bf5c-3b065a2487a0` 对照。请求流水在 `execution/native-task-journeys-server.log`。

模拟器截图保留在本轮操作记录。可按「复验月报四个筛选按钮在同一屏完整显示」「复验填写首屏保留网点、月份与退回原因」「确认 V2 成为当前有效版并保留 V1 历史」「确认返回十一月原账单并显示一笔实收」「从查看客服回复待办直达原工单」「将最终验收版留在可操作的公众首页」定位。

### 验证覆盖与试用结论

- 累计实际打开 18/20 个注册路由，包含 `home`、`login`、`outlets`、`outlet`、`reports`、`report`、`fees`、`requests`、`location`、`support`、`messages`、`profile`、`finance`、`tasks`、`discover`、`dashboard`、`agreements`、`security`。覆盖包括修补前的问题复现、受影响路径修复复验及未改动路径操作。页面统计为实际打开并完成列出的操作。
- `service-detail` 缺已发布业务样例，`training` 属于一期暂缓的入口，本轮均未通过模拟器打开。位置核验未提交 GPS 和照片，停费停在申请表单，客服未关闭与评价。正式结算、真实认证和真实支付未执行。
- `node --test --test-concurrency=4 tests/*.test.cjs` 517/517，见 `execution/frontend-live-approved-node.log`。总部 Chrome 专项复跑 4/4 套件，覆盖移动端、月报、财务和客服，见 `execution/frontend-live-browser`。官方 WXML 与 WXSS 20/20，见 `execution/frontend-live-approved-compiler/compiler-result.json`。开发与生产剥离构建、差异检查通过。生产构建检查使用占位 AppID 和 HTTPS 地址。
- 可以用隔离账号组织有陪同的核心流程试用。集团独立试用尚不能判定通过。下一批按三至五个工作包推进，包括已发布集团业务及境外网点、位置资料和独立停费跨端、遗留路由及客服后续、非开发人员独立走查。真机与正式平台能力单列。
