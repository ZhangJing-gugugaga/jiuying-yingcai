# 九盈英才五项前端整改执行计划包

历史实施计划。停用或换码后补件已有 [HTTP 回归](../../../web/tests/onboarding.test.cjs)及迁移 030。首店入口、逐店月报、网点卡和总部身份分流已有源码及专项用例。表中的逐项验收标准继续用于候选包复验，具体待执行场景见[当前待办](../../../TODO.md#现版回归与交付待办)。

**目标**　让已付款的加盟申请可以安全补交，让加盟商进入小程序后知道第一步、能逐店看清月报状态，并让总部人员进入对应管理端。

**基线**　`codex/jiuying-ux-rework` 当前交付版。原 ZIP 为 `execution/jiuying-onboarding-and-outlets-source.zip`，SHA256 为 `aada525cf7d6ee2732b4c2308ef825ebc01fa464a2233fec70e106670956fc02`。上次在隔离环境逐页打开 21 页，重点业务通过，Node 522 项通过。本计划在此基线上补齐五个已识别的缺口，验收结果以实施后的复验为准。[上轮逐页验收与截图](2026-11-21-onboarding-21-pages-replay.md)

**实现方式**　继续使用原生 WXML/WXSS、Node.js 24、SQLite 和总部 Web。保留已确认的蓝白视觉、四个加盟商底部入口和既有业务制度。范围限定为五项，后台只配合调整必要的鉴权、数据投影和提示。正式支付依然关闭。全部改动在同一隔离工作树交付。

## 一、现状与执行顺序

| 顺序 | 工作包 | 已知情况与影响 | 调整范围 |
| --- | --- | --- | --- |
| 1 | W01 已付款后补交 | 退回页重复展示收款码。隔离 HTTP 已复现停用收款码后，旧申请重新上传和用已上传凭证补交都返回 409，申请卡在需补充状态。 | 小程序、上传、加盟服务、增量迁移、总部停用提示 |
| 2 | W02 激活后的第一步 | 新账号为 0 家网点，首页主区仍显示核验、费用和看板。新增网点入口需要自行去网点列表找。 | 加盟商工作台，复用新增网点和申请详情 |
| 3 | W03 月报可定位到网点 | 模拟器显示「应报 3 家、已提交 0 家」，列表却为空。汇总是独立统计，待填行依赖已经生成的待办。 | 小程序月报列表和一个按月读取的服务端投影 |
| 4 | W04 网点列表减负 | 验收已确认网点和跳转正确。列表每家同时放三条业务状态和四个快捷按钮，浏览多店时不易比较。 | 私有网点列表和详情入口 |
| 5 | W05 登录后按身份引导 | 激活页已提示管理员去总部管理端，当前小程序登录成功处理只区分访客和已登录账号，未给总部人员明确去向。 | 登录页、原生会话和路由，按需复用总部 HTTPS 地址 |

W01 优先关闭业务阻断。W02 和 W03 可由不同负责人并行实施。W04、W05 在统一首页和月报展示规则后可并行。合并时 `server/index.cjs` 由接口负责人统一登记 W01、W03 及 W05 所需入口。`miniprogram/utils/api.js` 的上传和会话改动由同一负责人合并，先锁定 W01 的附件参数再叠加 W05 的会话清理。其他页面各由所属工作包负责。所有工作包通过验收后再统一打包。

## 二、分包修复办法

### W01｜停用或换码后，旧申请仍可补交

**现有证据**　`miniprogram/pages/join/index.wxml:22` 将首次申请和退回补交放在同一收款模块内。`server/index.cjs:224` 在上传前检查当前开关，`server/onboarding.cjs:95` 在提交时要求当前收款码。停用复现中，上传请求 `124f2781-11b2-4db1-a638-c313ba345687` 和旧申请补交请求 `4b3aa6ac-e127-4d0e-b3bf-aea4fade489c` 均失败。独立测试样本未发生真实付款。

**用户界面**　退回状态首屏展示「总部退回原因」「原申请单位」「原收款方」，主操作为「补交原付款截图」。这一状态省略收款码和付款引导，明确提示「请补充这笔付款的凭证，已付金额无需再次支付」。首次申请继续展示当前收款信息。用户此前已经付款但尚未创建申请，遇到收款信息变更时提示联系总部核对原收款，保留用户手里的截图和表单输入，不请求重复付款。旧申请允许补交时保持原来姓名、手机号及主体校验规则，原申请编号、原收款方和原收款码快照锁定。

**接口与数据**　复用 `POST /api/files` 和 `POST /api/onboarding/applications`。新申请仍要求收款启用及当前 `qrFileId` 匹配。补交上传增加成对参数 `applicationId`、`applicationVersion`，只用于 `purpose=onboarding-proof`。JSON 中版本为正整数。multipart 接受对应的正整数字符串，归一化后进行同一校验。申请编号沿用现有 `join-...` 规则。补交提交传 `id`、`version` 和现有 `fileId`、表单字段，补交分支从旧记录读取原收款信息。`version` 是用户进入补交时看的版本，服务端事务中重新校验本人访客、`returned` 状态、当前版本、文件归属及用途。写入仍更新原申请、版本加一、记录原审批链与新证据，不生成服务费实收。

采用 `database/030_onboarding_supplement_scope.sql` 增加归属待绑定的可空字段 `target_application_id` 和 `target_application_version`。`application_id` 仍只在提交后作为已归档归属。上线先迁移再部署，历史行为空并可读。新客户端补交只使用有目标归属的新图。旧客户端省略补交版本和目标时，仅在现行收款码仍启用、和原申请快照一致且申请归属及状态通过时沿用原补交入口。已绑定过的图、其他申请的暂存图、版本已变化、他人附件或他人申请都不可使用。照片解码后的写入事务再次检查会话及目标未变化，保留 5 MiB 限制、净化、限速、请求编号和原有幂等键。

实施涉及 `miniprogram/pages/join/index.js`、`index.wxml`、`index.wxss`、`miniprogram/utils/api.js`、`server/index.cjs`、`server/onboarding.cjs`、`server/file-access.cjs`、`admin-web/onboarding.js`、迁移 030。总部停用提示改为「暂停新的加盟收款申请，已有退回申请仍可补交」。

- [ ] 在 `tests/onboarding.test.cjs` 增加停用后补交、换码后补交、不同申请之间的附件隔离以及旧客户端同码兼容。先跑现行版，验证停用场景返回 409。
- [ ] 先扩展 SQLite 和上传合同，再拆新申请与补交两个服务分支，最后拆 WXML 的两种表单状态。失败时在相应按钮旁给出可处理的说明，网络重试保持同一个提交幂等键。
- [ ] 执行 `node --test tests/onboarding.test.cjs tests/support-attachments.test.cjs` 和 `node tests/browser-onboarding.cjs`。预期两种状态均可用，工单和其它图片用途无变化。
- [ ] 在微信模拟器提交 V1，总部退回，总部分别执行停用和换码，用两个隔离案例复跑。申请人不再看到付款动作，使用原收款方补交 V2。同一请求重试只有一条记录。总管理员通过并发起激活，申请 ID 不变，前后两张图可在隔离数据库追溯。
- [ ] 额外断言停用时新申请仍关、他人提交返回 403 或 404、重复或过期版本返回 409、月度服务费实收无变化。回退时保留新增可空列和已提交资料，停止写新版前先禁用新收款入口，并确认退回待补记录有可办理渠道。

### W02｜让新加盟商知道第一步及原申请在哪

**现有证据**　`miniprogram/pages/home/index.wxml:27` 的工作台不区分 0 网点和已有网点。上一轮 `home-newly-activated-partner.png` 显示 0 网点，但主区是核验、服务费及事项。`miniprogram/pages/outlets/index.wxml:115` 已有新增网点入口，可以直接复用。

**页面规则**　仅在成功读取的 `pagers.outlets.total === 0` 且当前角色为加盟商时加载首家网点状态。调用已有 `GET /api/collections/requests?type=newOutlet&limit=1`。其授权使用现有加盟商本人范围并按记录倒序读取。已有 `pending` 时主操作「查看申请进度」。最新为 `supplement` 或 `returned` 时主操作「查看原因并补充」，均使用原申请 `id` 打开 `pages/requests/index?id=...`。`approved` 但网点尚未出现在列表时提供「查看已通过申请」及刷新，避免误发新申请。成功且无申请记录时主操作「申请新增网点」，直达 `pages/requests/index?type=newOutlet`。查询失败显示「暂时无法确认申请进度，重新加载」，保留正常底栏和通知，不显示可误点的新申请按钮。账号切换后清空前一账号的加载结果。

这一状态用一个首页卡片呈现，标题「办理首家网点」。阶段说明使用「等待总部处理」「需要补充」「已审批」等业务词。0 网点的工作台收起无对象的看板、核验和费用主区，保留通知、我的网点和联系总部。有网点后自动恢复现有工作台，也不误隐藏已存在的业务待办。

实施涉及 `miniprogram/pages/home/index.js`、`index.wxml`、`index.wxss`，复用 `miniprogram/pages/requests/index.js` 的既有入口和返回。

- [ ] 在 `tests/ux-workbench-report.test.cjs` 或 `tests/ux-public-workbench-structure.test.cjs` 补上 0 网点无申请、待审、退回、加载失败、三网点和延迟响应账号切换断言。只读取属于本人且 `type=newOutlet` 的记录。
- [ ] 执行 `node --test tests/ux-workbench-report.test.cjs tests/ux-public-workbench-structure.test.cjs tests/phase-one-native-navigation.test.cjs`。预期首页能打开现有新建或原记录，历史账号工作台照常。
- [ ] 在模拟器从新激活账号首页一键打开表单，提交后返回首页显示申请进度。总部退回后回首页再打开同一 `id`。总部审批并生成首家网点后，返回刷新切回普通工作台。断网和加载态均不会把有网点用户当成 0 网点。

### W03｜汇总和逐店月报状态使用同一份数据

**现有证据**　`miniprogram/pages/reports/index.js:79` 只从 `report_missing` 待办生成待填行。`loadCoverage` 另读 `/api/dashboard`。隔离截图上 `2026-10` 有 3 家应报、0 家和空列表，用户无法分辨缺报与停业免报待核实。

**服务端修法**　增加 `GET /api/reports/worklist?month=YYYY-MM&outlet=all&status=all&limit=25&offset=0`，限定小程序加盟商读取已授权的私有网点。`outlet` 可传具体授权 ID。`status` 枚举 `all`、`action`、`reviewing`、`approved`，`limit` 1–50，`offset` 非负整数。复用 `server/repository.cjs` 的网点和月报授权查询、`shared/operations.cjs` 的 `reportMonthStatus`、`coverage` 和 `reportTiming`，以及 `shared/core.cjs` 的 `reportMonthBlock`。同月同授权集合一次读取关联月报、草稿、免报数据，批量查询后复用现有规则归类。分页只截列表，汇总为所选月份和网点的全量授权范围。用批量读取和稳定排序避免客户端每家店一次请求。原 `/api/dashboard`、`/api/reports/context`、总部流程和报告写入接口继续原样使用。

响应在现有 `data` 包装内返回 `{month, items, total, offset, limit, hasMore, summary}`。`summary` 使用既有 `expected`、`submitted`、`exempt` 数值并附加 `actionable`、`awaitingExemption`、`inReview`。每条 `items` 包含 `outletId`、`outletName`、`month`、`status`、`reason`、`reportId`、`latestVersion`、`effectiveVersion`、`dueOn`、`canSubmit`。`status` 限定为 `missing`、`draft`、`returned`、`pending`、`finance`、`approved`、`exemption_pending`、`exempt`、`not_required`、`not_open`。`action` 筛选对应 `missing`、`draft`、`returned`，包含用户需要先查看限制的记录。`reviewing` 对应 `pending`、`finance`、`exemption_pending`。`canSubmit` 复用现有编辑权限，`reason` 复用权限或月份原因，无值使用 `null`。月报状态不返回审计原文或金额。处理规则按下表落实。

| 情况 | 逐店状态和主操作 |
| --- | --- |
| 已结束月份的应报网点，既无有效提交也无草稿 | 「待填写」，打开该网点该月的编辑页。期限用既有报送规则。即使定时待办尚未生成，仍显示此行。 |
| 有本人草稿或上次提交退回 | 「草稿」或「待修改」，打开对应草稿或原退回版本。保留退回说明和仍生效的旧版本。 |
| 运营审核或财务复核进行中 | 「总部审核中」或「财务复核中」，查看对应版本。仍有效的旧版本作为次要说明。 |
| 已通过，或新版本撤销而旧版本仍有效 | 「已通过」，展示当前有效版本。对已撤销版本保留历史只读入口。撤销了唯一版本时按现有月份规则显示待处理状态。 |
| 整月停业未确认免报、已免报、无营业历史 | 分别显示「免报待核实」「已免报」「该月无需报送」。点击查看该网点当月说明，沿用现有申请权限。 |
| 当前月份、招生适用性待核实、权限不足 | 当前月提示未开放。招生核实未完成的可编辑范围依据现有接口。请求越权网点返回无权查看，保留月份及原已授权范围，不扩大到所有网点。 |

`pages/reports` 一次请求同时刷新网点状态、汇总和筛选。分页沿用同一查询键，切换月、店或筛选时清掉旧页，并以当前会话和加载序号拒收旧响应。筛选确为空时给出「所选范围没有该类月报」及查看全部操作，加载失败显示重试。修完后「填报经营月报」按钮仍复用已有编辑页，通用入口保留多网点显式选择。

实施涉及 `server/repository.cjs`、`server/index.cjs`、必要的 `shared/operations.cjs` 共享归类函数、`miniprogram/pages/reports/index.js`、`index.wxml`、`index.wxss`。不改总部统计口径、有效版本、月报表单、审计和提交审批规则。

- [ ] 扩充 `tests/phase-one-matters-report.test.cjs`、`tests/ux-workbench-report.test.cjs`。开局不用定时器，构造两家应报、一家整月停业，断言逐店行和汇总同源。补上旧有效版与新退回、已撤销、25 家以上分页、跨主体拒绝、旧月份响应后到。
- [ ] 执行 `node --test tests/phase-one-matters-report.test.cjs tests/ux-workbench-report.test.cjs tests/acceptance-business.test.cjs`。预期填报可定位到正确 `(outletId, month)`，官方结算值与历史读取保持通过。
- [ ] 模拟器用长沙、株洲、衡阳同一账号从月报 Tab 查看同一月份。应报行可直接填写，停业行可查看核实原因。切换店和月后表头、状态和点击结果一致。总部 Web 审核退回后，加盟商重新打开列表能从同一店和月进入原记录。

### W04｜私有网点列表看重点，网点详情保留完整分区

**现有证据**　`miniprogram/pages/outlets/index.wxml:88` 将同一家店的地址、三条状态和四个操作全铺在列表。现有 `includeSummary=true` 投影可继续使用，上一轮长沙账单、株洲核验、衡阳申请及客服的网点身份验证均通过。

**界面修法**　`我的网点` 每家卡片首屏保留名称、营业状态、短地区、至多一条当前需要办理的事项，以及最多一个业务操作。网点名或「查看网点详情」仍能进入详情。以现有状态枚举选出一条，规则为 `report.returned`、`location.exception`、`report.missing`、`location.missing`、`fee.unpaid` 或 `fee.partially_paid`，按该顺序优先。这个顺序只影响卡片展示。「免报待审核」「等待总部核验」可作为次要进度文案，不能显示成用户欠办。无需要办的事项时主入口是详情。移出列表的地址、核验、账单、申请和协议在详情对应区块都要有能点的入口。协议入口放地址资料 / 经营服务相关区块，使用原网点参数打开已有 `pages/agreements/index`。私有卡片的数据集 `dataset.id` 一律来自本行 ID，每个入口保留必要的 `month` 和 `scope`。公共目录、境外地图、收藏、地址和公开电话使用原逻辑。

实施涉及 `miniprogram/pages/outlets/index.js`、`index.wxml`、`index.wxss`、`miniprogram/pages/outlet/index.wxml`，按需改 `outlet/index.js` 中既有的 `action`。沿用公共字体、蓝白令牌和状态标签。不调整网点搜索和后端授权规则。

- [ ] 扩充 `tests/phase-one-outlet-support.test.cjs`，覆盖多种状态只选一项、无操作默认详情、权限外入口拒绝，及详情补回所有原快捷入口。执行 `node --test tests/phase-one-outlet-support.test.cjs tests/v342-public-outlet-map.test.cjs tests/native-visual-system.test.cjs`。
- [ ] 在 375 CSS 像素宽度，用三网点账号验证卡片无横向溢出，名称长时在卡片内折行，主要点击区的最小目标为 44 CSS 像素。检查列表两家以上可快速辨认，长文案不截掉网点名称。
- [ ] 从衡阳、株洲、长沙各点击一个业务主操作，并从详情依次验证月报、账单、核验、申请、客服和协议。截图与请求核对原网点，返回列表保持搜索与已加载范围。公众切换境外地图和详情时不出现私有状态或操作。

### W05｜三种身份有清楚的登录后去向

**现有证据**　`miniprogram/pages/login/index.js:81` 在成功后调用 `resumeAfterLogin`，按访客与其余账号分流。管理员手机端的正常行为不由激活页的一句说明解决。上轮验收已验证总管理员与一级管理员的总部权限，以及加盟商的小程序访问范围。

**页面和会话规则**　按登录接口返回的 `session.role` 分流，客户端不采信用户输入的角色或自填跳转地址。加盟商沿用受控的 `next`，有目标时回原网点、月份或记录，无目标返回工作台。访客继续返回公开首页。已知后台岗位识别后停留在确认视图「总部账号已确认，请在总部管理端办理审批」。在小程序内结束这一份后台会话，清本地账号上下文，不影响其他 PC 会话。一次性激活已经成功的账号照常用个人密码或已配置的渠道登录总部。若校验到后台岗位的旧会话，恢复或打开私有路由时同样回到此确认视图。未知角色显示权限异常提示，并留在登录页。编写单一导航守卫，避免多处触发底栏跳转。

延用 `POST /api/auth/logout`，它只撤销当前 token。扩展 `api.logout({navigate:false})` 时，原无参调用仍按现有方式回登录，受控分支只清理对应会话和个人草稿，避免延迟响应清掉后来登入的另一账号。管理端地址只从已验明属于集团且提供总部页面的生产 HTTPS 配置派生，优先使用现有部署的 `PUBLIC_ORIGIN`，没有明确可用地址时只显示总部管理端提示和「返回公众首页」。有可用地址时可复制并提示在浏览器打开。微信和手机验证码只展示当前已开通的方式，原有个人激活码的权限及一次性机制不变。

实施涉及 `miniprogram/pages/login/index.js`、`index.wxml`、`index.wxss`、`miniprogram/utils/navigation.js`、`miniprogram/utils/page.js`、`miniprogram/utils/api.js`。如需新增配置字段，统一接口负责人在 `server/index.cjs` 的 `/api/config` 增加可选 `staffPortalUrl`，正式 HTTPS 地址规范化，无配置返回 `null`，旧构建忽略该字段。总部登录页面及接口保持兼容。

- [ ] 在 `tests/phase-one-native-navigation.test.cjs` 增加个人激活成功后的三角色路径和后台岗位旧会话，确认小程序登录后没有进入加盟商私有页。测试受控 `next` 可恢复本人原月报，地址缺失和清理失败仍有明确反馈。
- [ ] 执行 `node --test tests/phase-one-native-navigation.test.cjs tests/external-auth.test.cjs tests/acceptance-permissions.test.cjs`，再执行 `node tests/browser-phase-one-admin.cjs` 和 `node tests/browser-onboarding.cjs`。预期加盟商仍只看到自己网点，一级管理员只有已授权审批，总管理员仍可核实并批准加盟。
- [ ] 使用三个隔离个人账号依次验证。小程序的加盟商回到原业务或工作台，两种后台账号显示明确去向。再用相同的后台账号在总部浏览器验证角色和本人任务，登录与退出不影响另一个端的独立会话。

## 三、综合验收与交付

| 验收单 | 操作和通过标准 | 必留证据 |
| --- | --- | --- |
| A01 补交异常 | 访客上传 → 总部退回 → 停用或换码 → 原申请补交 → 总管理员通过。通过前后 ID 不变，版本加一，原收款方和老截图不变，未生成服务费实收。 | 模拟器截图、两个版本和上传/审核请求编号、SQLite 归属、请求拒绝证据 |
| A02 首家网点 | 新账号激活 → 首页一键发起 → 返回看原申请状态 → 补件或通过 → 进入已有网点工作台。 | 首页四种状态截图、原申请与新店 ID |
| A03 月报 | 三网点在同一月份可分别确认应填、审核、免报核实。审核退回后能回到原网点、月份及版本。 | 汇总/逐店对照、授权范围、提交与审核记录 |
| A04 网点入口 | 三家店逐次打开各自详情和业务入口。收起列表后仍能访问原有的能力。检查长店名、列表返回、境外公开目录。 | 不同网点的选中态截图和页面请求 |
| A05 身份 | 三账号独立登录，分别验证原业务恢复和两个后台岗位的引导。总部重新登录时角色仍正确。审核、通知和退出互不串用。 | 三个身份的登录、激活、越权拒绝编号及界面 |

1. 执行受影响工作包的定向 Node 与 Chrome 回归，再跑 `node --test --test-concurrency=4 tests/*.test.cjs`、`node scripts/check-syntax.cjs`、`node scripts/style-audit.cjs`、`git -c core.whitespace=cr-at-eol diff --check`。以实际退出码和测试清单确认，无跳过或减弱关键断言。迁移 030 用旧库副本连续应用两次，核对历史付款附件仍可依原权限读取。
2. 用已有测试 AppID、隔离后端和独立构建目录运行 `node scripts/wechat-build.cjs` 与 `node scripts/wechat-compile.cjs`。另验证生产构建剥离开发登录和模拟付款。上线联调前保持真实收款关闭，真实微信短信和真机另记结果。
3. 最终构建在模拟器逐页打开 21 个已注册页面。每页留截图，五条重点用例留业务对象及请求编号。按需记录失败并改完后在同一最终构建复验。总部操作用真实 Web 界面，角色拒绝用实际 API，截图、运行记录和自动化结果分别列出。
4. 交付完整可编辑源码 ZIP、SHA256、五项验收状态、失败与复验记录。对 ZIP 做 CRC、独立解压和文件校验，排除测试库、凭证图片和密钥。只有五项均通过才建议在隔离环境组织下一轮集团独立走查。正式运行另需真实集团人员和平台联调验证。
