# 九盈英才 21 页模拟器复验与隔离试用结论

历史验收记录。正文结果对应下述源码 ZIP。截图和原始日志所在的 execution/acceptance-21-pages 未随当前仓库交付，保留证据文件路径及请求号供追溯。当前验收任务见[开发计划](../../../TODO.md#现版回归与交付待办)。

**可以安排集团人员在现有隔离环境独立走查。** 21 个注册页均从实际用户入口点击打开。三种身份、同一笔加盟申请退回补交后通过、通知清零和多网点业务对象均完成重点复验。集团人员本轮尚未实际试用。正式微信、真实短信、企业收款及真机环境仍待验证。

## 源码与验收环境

- 使用上一轮完整源码 ZIP。SHA256 为 `aada525cf7d6ee2732b4c2308ef825ebc01fa464a2233fec70e106670956fc02`。验收前比对 425 个归档文件与正在运行的工作树，内容全部一致。
- 微信开发者工具 2.02.2609250 Stable，原有测试 AppID，模拟器项目 `execution/wechat-ux-acceptance-final`，后端 `127.0.0.1:18957`。总部 Chrome 操作和小程序连接同一个隔离 SQLite。
- 仅发布了隔离服务内容、培训记录及不可付款的收款样图。测试申请使用两张标注无真实付款的图片，不涉及真实交易或正式账簿。
- 本轮验收未发现需修复的业务阻断，沿用原源码 ZIP。开发者工具仍显示已记录的自定义底栏选择器警告，实测底栏渲染、切换和回退正常。

## 21 页逐页记录

表中请求为实际模拟器操作引发的代表性请求，状态均为 200。范围为逐页打开和表内交互，涉及付款、定位及改密的页面按隔离条件验证。

| 原生路由 | 界面操作与结果 | 模拟器截图 | 请求编号 |
| --- | --- | --- | --- |
| `pages/home/index` | 打开三网点工作台；从公众首页查看服务和通知；访客、新加盟商读完后均清除红点。 | 工作台（原记录：execution/acceptance-21-pages/screens/home-partner.png）、访客无红点（原记录：execution/acceptance-21-pages/screens/home-visitor-no-dot.png） | `07ecc5e8-e39c-4ae9-8b8e-be32e8f5c0b2` |
| `pages/login/index` | 切换到首次激活、返回登录并打开账号密码方式；获批加盟商用个人账号登录。 | 登录（原记录：execution/acceptance-21-pages/screens/login.png）、首次激活（原记录：execution/acceptance-21-pages/screens/login-activation.png） | `c43ede21-546f-473d-b904-f7ed974b91fa` |
| `pages/join/index` | 填写申请、上传两次不同图片，从通知重开原申请并验证补交与通过。 | 首版（原记录：execution/acceptance-21-pages/screens/join-pending-v1.png）、通过（原记录：execution/acceptance-21-pages/screens/join-approved-v2.png） | `6f72bd65-66bb-4d49-a5d4-2ba79e61e8cd` |
| `pages/outlets/index` | 网点 Tab 显示三家授权网点；滚动后分别点击长沙和株洲快捷入口。新获批账号进同一 Tab 显示 0 家。 | 三网点（原记录：execution/acceptance-21-pages/screens/outlets.png）、新账号（原记录：execution/acceptance-21-pages/screens/outlets-newly-activated-empty.png） | `524f14b0-11d7-4d7f-a132-33ef4bf667c6` |
| `pages/outlet/index` | 进入衡阳详情，展开其他事项和历史记录，核对营业状态、地址、办理和支持分区。 | 详情（原记录：execution/acceptance-21-pages/screens/outlet.png）、展开记录（原记录：execution/acceptance-21-pages/screens/outlet-expanded-history-hy.png） | `b6ff539a-efc8-4e5b-b3dd-16d1f88ab370` |
| `pages/reports/index` | 打开月报 Tab，看到 2026 年 10 月及列表状态，点击待填筛选。 | 月报列表（原记录：execution/acceptance-21-pages/screens/reports.png） | `7d2e21dc-5bde-441a-a326-7bf3b7ac5432` |
| `pages/report/index` | 从衡阳详情点击经营月报，显示衡阳、2026 年 10 月及该月停业提示。 | 衡阳月报（原记录：execution/acceptance-21-pages/screens/report-hy.png） | `a91329aa-7df8-45ac-b4a1-4b2fbb505caa` |
| `pages/fees/index` | 先打开衡阳账单，再从长沙快捷入口打开长沙账单。抬头与各自账单一致。 | 衡阳（原记录：execution/acceptance-21-pages/screens/fees-hy.png）、长沙（原记录：execution/acceptance-21-pages/screens/fees-cs.png） | 衡阳 `92c5a531-908e-4970-b55a-ab7800a510fb`，长沙 `b36e13c9-8117-430c-aeeb-51a8d6917504` |
| `pages/requests/index` | 从衡阳详情分别打开恢复营业和暂停收费，表单均锁定衡阳，业务类型分别显示。 | 恢复（原记录：execution/acceptance-21-pages/screens/requests-resume-hy.png）、停费（原记录：execution/acceptance-21-pages/screens/requests-pause-fee-hy.png） | 恢复 `ed66d27b-74da-464c-a0f7-7000648fb7ab`，停费 `64e042cb-e39c-4bc6-b30b-669609eaa8cb` |
| `pages/location/index` | 从衡阳点击核验记录，回到顶部仍为衡阳。打开株洲核验快捷入口，显示株洲地址及 2026 年 11 月。 | 衡阳（原记录：execution/acceptance-21-pages/screens/location-hy.png）、株洲（原记录：execution/acceptance-21-pages/screens/location-zz.png） | 衡阳 `e7587ce3-66b3-4526-b7bb-55514aa5a0c1`，株洲 `043c8515-e5a8-46d3-b25e-2ef5448521c8` |
| `pages/support/index` | 从衡阳的网点支持区联系总部，点击提交问题，工单预选衡阳。 | 工单网点（原记录：execution/acceptance-21-pages/screens/support-ticket-hy.png） | `3b7414eb-e838-4940-a024-ebb610db7a3c` |
| `pages/messages/index` | 访客从首页红点进入，打开退回通知、通过通知，再切到未读筛选并确认清零。 | 通过未读（原记录：execution/acceptance-21-pages/screens/messages-approved-unread.png）、未读清零（原记录：execution/acceptance-21-pages/screens/messages-unread-empty.png） | `5e858a0b-ba91-47aa-b52a-5de6e05e45ec`、`943de791-3636-4755-9a6a-972dc1ea9f50` |
| `pages/profile/index` | 点击我的 Tab 显示已登录账号与三家网点，安全和集团信息入口可打开。 | 我的（原记录：execution/acceptance-21-pages/screens/profile.png） | `3a07599a-1dd0-420f-b365-7fd9a0d561b6` |
| `pages/finance/index` | 在衡阳服务费列表点击查看账单，打开同一网点的 2026 年 11 月测试账单。 | 原账单（原记录：execution/acceptance-21-pages/screens/finance-hy.png） | `8cc47b76-5bcd-4d58-9991-e80aaf6b8f3d` |
| `pages/tasks/index` | 打开我的事项和通知筛选。三网点账号仍有未读时，标一条后红点保留。新加盟商标记最后一条后红点清除。 | 事项（原记录：execution/acceptance-21-pages/screens/tasks.png）、未读清零（原记录：execution/acceptance-21-pages/screens/tasks-new-partner-read.png） | 列表 `38fb9038-51f7-4c92-95be-1bbcd67301bd`，新加盟商标已读 `fdc37696-3038-43ae-981a-5330fdc7f865` |
| `pages/discover/index` | 通过我的进入集团与服务，切换五大业务，显示已发布的隔离样例。 | 集团业务（原记录：execution/acceptance-21-pages/screens/discover-services.png） | `481d7aee-34b5-4685-8834-b8ae536fe543` |
| `pages/service-detail/index` | 从已发布样例点查看详情，显示正确标题和正文，可返回原列表。 | 业务详情（原记录：execution/acceptance-21-pages/screens/service-detail.png） | `d0d50dd6-eab2-4880-bca6-fbce9ecbafbd` |
| `pages/dashboard/index` | 从工作台点击 9 月已结算数据，打开相同月份的经营看板及汇总。 | 经营看板（原记录：execution/acceptance-21-pages/screens/dashboard.png） | `220e786f-a6c4-4e4c-85ce-cddc70dbe673` |
| `pages/agreements/index` | 通过衡阳卡片点击服务协议，正确预选衡阳并展示无协议提示。 | 衡阳协议（原记录：execution/acceptance-21-pages/screens/agreements-hy.png） | `00230d97-7bcb-4886-b5c6-2826f5e97d02` |
| `pages/security/index` | 通过我的打开账号安全，查看脱敏手机号、绑定状态、改密表单。此轮未提交改密。 | 账号安全（原记录：execution/acceptance-21-pages/screens/security.png） | `3b82b877-7644-4e38-b33c-1654ce29e3dc` |
| `pages/training/index` | 从工作台已退回的待办点击补交资料，打开同一条株洲学员记录，显示退回意见和已提交材料。 | 学员记录（原记录：execution/acceptance-21-pages/screens/training.png） | `281ca927-be55-46dc-b08e-1dfd3c6f74b1` |

## 模拟器和总部联动

### 同一笔加盟申请退回、补交、通过

原申请 `join-74e5af9a-5399-4136-8f58-7b2d6d97df9c` 沿用至审核通过。首张图与补交图文件 ID、摘要均不同，两张均关联原申请。SQLite 记录显示版本 2、申请已通过、个人账号已激活，服务费实收流水为 0。

| 步骤 | 平台与结果 | 请求编号 |
| --- | --- | --- |
| 首次上传和提交 | 模拟器相册上传成功，提交后待总部审核，版本 1。 | 上传 `a497b442-fbc7-4dfd-a659-eee74ac44dd2`，提交 `6f72bd65-66bb-4d49-a5d4-2ba79e61e8cd` |
| 总管理员退回 | 总部 Chrome 网页预览首张图，填写原因退回。模拟器查看退回通知和原申请。 | `bc0f2ff8-5995-4267-82c0-06c1078e634a` |
| 补交新图 | 模拟器从通知打开同一申请，选第二张图，原申请恢复待审核，版本 2。 | 上传 `e621e816-0c7b-4444-99eb-d88fe77aea67`，提交 `d6af6303-b002-46e7-8da7-e5122df0b8fb` |
| 总管理员通过 | 总部 Chrome 网页预览替换后的图，使用隔离到账编号通过。模拟器打开通过通知可见原结果。 | `d65da7ec-745c-49a2-8331-0a9648f78618` |
| 通知清零 | 访客打开退回通知和通过通知后均记录已读。新加盟商标记本人最后一条通过通知已读，事项页和工作台红点均消失。 | 访客 `df988841-af7e-4938-96c0-3bbe2a7f5207`、`4b59cba2-ea48-4736-80d1-c86bc4474e06`，新加盟商 `fdc37696-3038-43ae-981a-5330fdc7f865` |

模拟器退回页（原记录：execution/acceptance-21-pages/screens/join-returned-v1.png） · 补交图片已选（原记录：execution/acceptance-21-pages/screens/join-second-proof-uploaded.png） · 总部预览补交图（原记录：execution/acceptance-21-pages/screens/hq-proof-approve.png） · 总部通过（原记录：execution/acceptance-21-pages/screens/hq-approved-after-supplement.png） · 新加盟商工作台无红点（原记录：execution/acceptance-21-pages/screens/home-new-partner-no-dot.png）

### 个人激活和资源权限

三个账号用本轮隔离服务的签发和激活接口注册，并尝试二次使用同一码。二次激活均被拒绝。随后使用实际个人凭证登录各自界面，直接请求补充验证资源权限。

| 身份 | 登录后的实际权限 | 激活和拒绝证据 |
| --- | --- | --- |
| 总管理员 | 总部 Chrome 可进入加盟申请，预览私有截图、退回、审核通过和签发个人码。 | 激活 `b89d6789-5ea0-4412-be38-26c481c9c37f`，重放 409 `708d02b1-162a-4b56-ac5e-b447b6b5bae3`，登录 `3f4be7af-cf73-435e-8ad2-19aed7286621` |
| 一级管理员，运营岗位 | 总部 Chrome 有月报审核入口，加盟申请和人员管理入口未出现。列表无加盟私有记录，调接口看补交图或审核均被拒绝。 | 激活 `b413148c-6efc-4ae5-a9b5-a66499e09d8d`，重放 409 `ddae4386-be85-44b0-8b18-ca01e95df5b1`，附件 403 `5fe0ba88-11be-404f-9d3d-8d08cc924da2`，审核 403 `8ff85b24-61c7-4067-9a0f-1d6ddfef297c` |
| 加盟商 | 小程序个人密码登录后仅看到本人获批结果和 0 家网点。请求未经授权的长沙、株洲、衡阳私有详情及衡阳账单均为 404，不能审核加盟或签发激活码。 | 激活 `c3494980-9f5a-4cc6-a6c1-4a4c4c3276db`，重放 409 `ca848a8d-20db-4b8c-8ef6-7e1a4c2e615a`，小程序登录 `c43ede21-546f-473d-b904-f7ed974b91fa`，审核 403 `a2042704-e1b7-42ee-9f68-b3de2a461c59` |

总管理员截图（原记录：execution/acceptance-21-pages/screens/hq-activated-manager.png） · 一级管理员截图（原记录：execution/acceptance-21-pages/screens/hq-activated-ops.png） · 新加盟商截图（原记录：execution/acceptance-21-pages/screens/home-newly-activated-partner.png） · 私有网点和账单拒绝详情（原记录：execution/acceptance-21-pages/outlet-denials.json） · 申请与两张图片的 SQLite 证据（原记录：execution/acceptance-21-pages/sqlite-evidence.json） · 完整请求日志（原记录：execution/acceptance-21-pages/request-log.ndjson）

## 交给集团的试用边界

本机隔离试用路径为「模拟器公众首页 → 申请加盟 → 相册上传隔离截图 → 总部 Web 的业务审批 → 加盟申请退回 → 小程序通知补交 → 总管理员通过 → 个人激活 → 我的网点」。三网点功能另用已有授权的隔离账号体验。涉及总部的操作分别使用一级管理员和总管理员个人账号。隔离服务只在本机提供，本轮尚未部署集团可远程访问的环境。

本轮无产品代码、金融口径、依赖和迁移变更。人工验收下一轮依次完成集团人员独立走查、正式微信和短信加真机联调、真实企业收款配置与财务复核。只有隔离样图和测试到账编号产生了本报告中的记录。

从归档独立解压目录执行 `node --test --test-concurrency=4 tests/*.test.cjs`，522 项通过，0 项失败或跳过。执行 `node scripts/wechat-validate.cjs` 与 `node scripts/check-syntax.cjs`，分别校验 21 个原生路由和 133 个语法检查对象。报告出具时逐项检查了 39 张原始截图与 43 个请求编号。Node 完整日志（原记录：execution/acceptance-21-pages/node-full.log）
