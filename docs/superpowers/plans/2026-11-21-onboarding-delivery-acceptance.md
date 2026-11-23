# 九盈英才加盟申请、身份入口与网点验收

本轮可交给集团使用隔离账号试跑。真实收款、真实短信、真实微信身份和独立试用验收仍待完成。隔离数据库仅使用测试凭证，款项未发生流转。

## 已交付的用户流程

| 流程 | 结果 | 主要文件 |
| --- | --- | --- |
| 登录与激活 | 登录页优先展示已配置的微信和手机验证码。首次激活使用总部给个人签发的一次性码。服务端从账号绑定识别加盟商、一级管理员、总管理员。加盟商进入小程序，管理员的审批和管理工作在总部 Web 办理。 | `miniprogram/pages/login/`、既有 `server/auth.cjs` |
| 加盟申请 | 访客可从首页或登录页进入申请。总管理员发布固定企业收款码，申请人核对收款方并从相册上传付款截图。总管理员核对企业账户到账凭据后审批。退回可在原申请补交，获批创建待激活账号。 | `miniprogram/pages/join/`、`server/onboarding.cjs`、`server/index.cjs`、`server/file-access.cjs`、`database/029_onboarding.sql`、`admin-web/onboarding.js` |
| 通知 | 申请人和获批账号各自在自己的消息范围内收到结果。首页和工作台以红点提示未读，通知可以打开同一笔加盟申请。查询码用于换设备后找回原记录和通知。 | `miniprogram/pages/home/`、`miniprogram/pages/tasks/`、`miniprogram/utils/page.js`、`miniprogram/utils/navigation.js` |
| 我的网点 | 列表分为网点资料、办理状态和快捷办理。私有详情分为月报与账单、位置核验、营业状态与申请、网点资料、历史和总部支持。详情入口已绑定所选网点。 | `miniprogram/pages/outlets/`、`miniprogram/pages/outlet/` |
| 既有审批结果 | 停费审批后继续显示待核算费用、待财务复核、待抵扣或已抵扣。实际抵扣后可回到对应账单。运营审批、财务复核和账务处理沿用原有角色和制度。 | `server/repository.cjs`、`shared/request-projection.cjs`、`miniprogram/pages/requests/`、`admin-web/app.js` |

## 微信模拟器与总部网页联合记录

微信开发者工具 2.02.2609250 Stable。开发构建连到本机隔离端口 `18957`，使用既有测试 AppID。操作由模拟器界面点击、输入和滚动完成。总部的同一笔审核由 Chrome 操作真实页面并写入同一个 SQLite 数据库。

| 实际操作 | 观察到的结果 | 请求编号 |
| --- | --- | --- |
| 访客进入加盟申请 | 开关关闭时显示暂未开放。隔离测试主体发布不可付款的测试图后，页面显示收款方并下载图片。 | `f5a77d79-0039-4ec9-9953-4abaffcb3f05`、`29f378b4-bd6e-4ef1-a71f-30d0d3bf9c42` |
| 填写表单并上传 | 未上传时在按钮旁提示补充截图。通过系统文件选择器上传图片后，页面可预览并提交。提交后显示「待总部审核」。 | `bf32ef5d-38d6-46bd-9b73-e8f915301ae4`、`83534316-b0f9-4343-9db7-19e54158e410` |
| 总管理员审核同一笔申请 | 审核人打开付款凭证，使用隔离到账编号完成审批。记录 `join-cb1de311-20e8-4c86-9153-d17b399394ef` 状态改为已通过，版本为 1。生成待激活账号，服务费实收流水数为 0。 | `670c5813-cfa3-4f8c-a3b3-ab7ae78ff0f6`、`3d17413a-f3e2-4afc-9753-4947898cae52` |
| 从红点进入通知并返回原申请 | 首页通知入口出现红点，列表显示「加盟申请已通过」。查看详情进入原记录，显示登录与激活入口。 | `0c31bed0-9c95-47b6-a3fc-27e9275eedad`、`435d02ed-758e-4214-a8cc-1cec6b4b272b`、`2a451643-a217-43bd-9ec1-7b7dbf29665f` |
| 从登录页进入首次激活、再切换手机号 | 激活页有单独入口。完成测试短信挑战后进入三网点加盟商工作台。角色签发、激活和一次性限制由接口和 Chrome 回归覆盖。 | `ed887544-2c0a-4572-bbe5-4a2c9ff6a6f8`、`f7e91dca-df16-43ad-a80a-3bb285c7cd7d` |
| 查看我的网点与位置核验 | 网点列表显示办理状态和快捷入口。打开衡阳示范网点 C，按区显示月报、账单、核验和申请。点击「月度位置核验」保持同一网点和 2026-11 月。 | `87ac6c96-5552-42ef-a276-6d35d103e281`、`64456379-5e4f-4e63-9447-778887f06a49` |

模拟器截图在本次操作记录中，独立保存了总部同一笔申请的审核截图到本机 `execution/business-status-browser/onboarding/01-isolated-application-approved.png`。请求日志在本机 `execution/business-status-logs/onboarding-simulator-api.log`。本轮未逐键复跑全部 21 页。模拟器显示一条自定义底栏共享样式选择器警告，实测底栏背景、选中态和跳转正常。

## 实际验证

| 验证方式 | 结果 |
| --- | --- |
| `node --test --test-concurrency=4 tests/*.test.cjs` | 522 项全部通过。加盟申请回归覆盖权限、关闭时拒绝上传、截图归属、重复凭证、重复请求、审批退回、原记录复提、旧版本审批拒绝、到账编号去重、找回通知和新账号激活。 |
| `node tests/browser-onboarding.cjs`、`node tests/browser-phase-one-admin.cjs` | 两套总部 Chrome 回归通过。包含高权菜单、上传预览、实际审核结果和审核已提交但响应丢失后的重试。 |
| `node tests/browser-v34-finance.cjs` | Chrome 复验月报更正、财务复核、重结算，以及停费逐阶段到实际抵扣的账单入口。 |
| `browser-v343-task-routing.cjs`、`browser-v343-work-contacts.cjs`、`browser-v343-approval-export.cjs`、`browser-round2.cjs`、`browser-remediation.cjs` | 隔离 Chrome 岗位交接、业务分派、工作电话、授权导出、位置核验与资料补充回归通过。浏览器定位使用控制坐标。 |
| `node scripts/wechat-build.cjs` 与 `node scripts/wechat-compile.cjs` | 开发与生产构建通过，腾讯 WXML/WXSS 编译覆盖 21 页。生产构建去除开发账户、测试验证码和模拟支付入口。 |
| `node database/migrate.cjs` | 隔离 SQLite 应用 29 号迁移，重复启动仍为 29 项。新增表和索引与现有账号、附件和消息表兼容。 |
| `node scripts/check-syntax.cjs`、`node scripts/style-audit.cjs`、`git -c core.whitespace=cr-at-eol diff --check` | 语法、公共样式审查和差异空白检查通过。 |

## 数据、兼容性与试用前置

- 加盟缴费由业务人员凭企业账户到账记录核实，审批时填写唯一到账凭据。付款截图使用既有的图片净化和权限检查，并与普通工单及公开素材隔离。加盟审批不会生成咨询服务费实收，不涉及金额算法和账期变更。
- 沿用现有 SQLite、日志和测试技术栈，无新依赖。新增成本主要是存储付款截图及必要的图片校验。运营和财务仍按原角色处理各自业务。
- 29 号迁移为增量，正式部署需先备份，后运行迁移。若要回退应用，可先停用收款入口再切回原代码，保留已提交申请、账号和审核数据。运行中的测试库、收款样例和凭证不随源码包分发。
- 内部试跑路径为「公众首页 → 申请加盟 → 上传隔离截图 → 总部 Web／业务审批／加盟申请 → 审核 → 小程序通知 → 查看原申请」。网点路径为「用隔离号登录 → 我的网点 → 查看详情 → 月度位置核验」。
- 正式放行分三项验证。用集团的正式 AppID 和短信服务验证已绑定账号。由总管理员配置企业真实收款码，集团财务确认到账核对和凭据留存步骤。发布前用未参与开发的集团人员复跑申请、激活、网点办理、授权回收并验证迁移与备份。这三项目前尚未执行。
