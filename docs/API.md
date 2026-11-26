# 九盈英才 API 契约

本页按迭代记录接口约定，[OpenAPI 文件](openapi.json)标记为 V3.3。查询当前 V3.4.4 的入口、权限和新增模块时，同时参见[架构](ARCHITECTURE.md)与[服务端路由](../server/index.cjs)。

OpenAPI3.1见openapi.json；所有JSON成功{data,requestId}、失败{error:{code,message},requestId}，Bearer资源权限由服务端判定。命令POST /api/commands，{command,payload}，Idempotency-Key为8—128字符；同subject同键同请求重放，载荷变化409，当前授权重查。金额CNY元输入、最多两位小数，整数分运算；null不是0。

| 路径 | 用途与字段 |
|---|---|
| GET /api/config | 不含秘密的环境与可用登录入口 |
| POST /api/auth/password | username/password，本地scrypt密码身份 |
| POST /api/auth/activate | token/password，一次24小时激活码；成功撤销旧会话 |
| POST /api/auth/activation | 管理Bearer；actor/username?，返回一次激活码 |
| POST /api/auth/change-password | 当前Bearer，currentPassword/password，撤销旧会话 |
| POST /api/auth/visitor | 独立公众subject；无内部经营数据 |
| POST /api/auth/dev | 仅非production+mock；显式开发actor |
| POST /api/auth/wechat | code2session换身份并校验总部预建负责人有效绑定；无配置返回503 |
| POST /api/auth/logout | 撤销当前令牌 |
| GET /api/context | 身份/岗位能力/个人授权/上海业务日期，不含全集。加盟主体另含 `agency{level,isPrimary,parentOwner,childCount}` 与 `entitlements{month,items,services}`；后者来自当前生效协议快照，历史协议未声明 `services` 时为空数组 |
| GET /api/agency/progress | 一级代理专用。`month` 缺省为上一自然月，不得晚于当前月。只返回直属二级的网点报送状态、版本号、截止日和催报时间；不含营收、明细、附件或原单 ID。未设一级、非直属或当前协议声明服务但缺少 `agency_reporting` 时返回 403 |
| GET /api/collections/{collection}[/{id}] | 授权 SQL 分页或详情。limit 1–200，默认 50，offset 不小于 0。列表支持 status、month、outlet、owner、province、city、district、type、q。返回 items、total、offset、limit、hasMore。 |
| GET /api/state | 兼容旧快照，每集合最多200；新列表用collections继续翻页 |
| GET /api/dashboard | period YYYY-MM，kind month/quarter/year，mode settled/process，owner/outlet，limit/offset；全范围totals/partial与分页rows |
| GET /api/export | 同统计范围，format=csv/xlsx/pdf；原始二进制，限本人/manager，超1000网点拒绝 |
| POST /api/files / GET /api/files/{id} | 上传私有图片，单张上限 5 MiB。支持使用 `name`、`type`、`file` 的 multipart 表单，以及使用 `name`、`type`、`base64` 的兼容 JSON。下载按附件权限校验，返回文件字节。 |
| GET /health | 数据库与运行模式；productionReady不得据此推定上线 |
| GET /api/operations/health | manager专用，metrics数值、数据库quick_check、审计链验证及externalMode |

独立集合列表先校验访问范围，具有明确状态集合的查询再校验 `status`。省略、空值及 `all` 查全部。没有匹配记录时成功返回空列表，传入与该集合无关的状态返回 HTTP 400。指定 `includeStatusOptions=true` 时，有明确状态集合可返回可选值 `data.statusOptions`。审计等无此筛选的集合省略该字段。请求列表中的 `scope=location` 将结果限定为新增网点、位置变更，统计和分页使用同一范围。网点列表中的 `scope=public` 沿用原有公开投影。旧 `/api/state` 仍支持同一状态跨集合查询。

常见错误：400参数、401会话、403权限、404不可见记录、409状态/幂等/制度冲突、413大小或导出范围、415类型、429频控、503未配置/供应商不可用。外部参数错误/权限错误不自动重试。登录返回token/actor/role/subject/expiresAt/mode；岗位actor不是个人subject。

原有35条月报/申请/定位/支付Mock/账号/汇总/客服命令在OpenAPI逐条保留，加35条新增命令共70条。需要真实状态条件的约束仍由服务器校验，不能仅依赖Schema。兼容字段intro用于content.update，key扩展brand/services/news/cases/cooperation。

cooperation.submit输入company/name/contact（各1—200字）、message（1—2000字）、privacyConsented必须true；公众/加盟商按subject隔离、同一处理中留言防重。cooperation.update由ops/manager输入id/status/note，submitted→received→contacted→closed依次进行，提交者不见内部processingNote。public.profile可选publicCoords=null或有效{lat,lng,coordinateSystem:'GCJ-02'}，只能显式授权发布，不复制内部GPS。

图片除大小/MIME外经过sharp单帧解码、2000万像素限制、两并发、10秒超时、最长边4096重编码并去元数据，记录变换版本。不能将其称完整病毒扫描。

工单照片上传时加可选参数 `purpose=support-ticket`。创建工单的 `support.ticket` 命令可带 `attachmentIds`，最多三个不同的上传返回 ID，省略为空。提交前，照片仅允许同一上传账号下载。工单创建及图片绑定在同一个事务中完成。提交后，当前会话须有原工单的读取权限，下载响应设为私有且禁止缓存。同一请求的幂等重放返回原工单，已绑定的图片用于另一工单时返回 409。工单只保存上传 ID。其他业务和公开素材入口不可引用工单照片。

## 配置、服务协议和账单

|命令|角色|输入|结果集合/规则|
|---|---|---|---|
|policy.configure|manager|name,effectiveFrom,reason；可选 reportDueDay/locationDueDay(1—28或null)、anomalyPercent(正数或null)、noDataMonths(正整数或null)、slaMinutes{complaint,aftersale,exception}(正整数或null)|policies；不可变版本，新版本替代生效，不擅设未配置阈值|
|plan.publish|manager|name,amount,serviceEntity,collectionEntity,invoiceEntity,terms,reason；可选 services（monthly_report、agency_reporting、location_verification、service_fee、training、priority_support）|pricePlans；固定整月月费，发布后不可改，新发布即新版本。主体用集团确认的完整名称。services写入价格版本快照，历史协议按原快照执行|
|agreement.create|manager|outlet,planId,startMonth,endMonth,billDay,dueDay,reference,reason|agreements；billDay/dueDay 1—28且dueDay>=billDay，同网点有效月份不能重叠；每一整月，未知首月折算不自动处理|
|billing.generate|finance/manager|agreementId,month|bills；须在协议范围和账单日之后，按协议快照整月金额；同网点同月已有有效账单阻断；重复同协议月份返回同账单|
|billing.correct.propose|manager/ops|billId,amount,reason|billCorrections pending；金额0表示作废，无收款时重开新单，旧单保留；有实收须先完成退款与冲红|
|billing.correct.review|finance|id,decision(approve/return),note|billCorrections approved/returned；必须另一自然人审核；批准保留原账单reversed并关联replacementBillId，拒绝不变账|
|fee.adjust.propose|manager/ops|adjustmentId,amount,offsetMonth,serviceUntil(日期或null),reason|feeProposals pending；明确人工核算金额与抵扣月；amount为抵扣金额，不推算停费天数；serviceUntil必须显式null或确认日期|
|fee.adjust.review|finance|id,decision(approve/return),note|feeProposals approved/returned；独立复核后原adjustments变approved，未来生成对应月份账单才扣减；已生成账单必须走纠错，不悄悄改账|

## 分级代理与下级报送

|命令|角色|输入|结果集合/规则|
|---|---|---|---|
|agency.level|manager|owner,level(1/2/null),reason|organizations；写入 level 与 levelHistory。历史主体不改数据，level 缺失按未设置处理，不推断级别。降级或清空级别前须先解除相关直属关系；同级重复设置返回 409|
|agency.bind|manager|parentOwner,childOwner,replaceActive?,reason|agencyRelations；上级须一级、下级须二级且均为正常账号。同一二级只允许一条 active 关系；已有其他上级时须显式 replaceActive=true 才原子撤销旧关系并新建；自身绑定或循环返回 400/409。写入 trail 与审计|
|agency.unbind|manager|id 或 childOwner,reason|agencyRelations；active→revoked，保留 revokedAt/revokedBy/reason 和历史 trail。解绑后原一级的下级查询与催报立即失效|
|agency.urge|一级代理|childOwner,month,Idempotency-Key|messages；仅直属 active 二级，月份须早于当前月。对未报、逾期、草稿、退回的网点各生成一条 target=reports、带 outlet 与 month 的站内通知；同主体同月同日重复催报返回 409，无需催报返回 409。当前协议声明服务但缺少 agency_reporting 时返回 403|

进度读取与催报都只使用当前生效关系。一级读取直属二级的营收、原单、附件、导出或代填，仍按原主体范围拒绝；总部审核队列不变，二级从「我的事项」通知进入原网点与账期月报。

## 收款、退款、发票（凭证登记，不执行外部资金操作）

|命令|角色|输入|结果集合/规则|
|---|---|---|---|
|offline.submit|加盟商/finance/manager|billId,amount,reference,paidOn,reason|offlinePayments pending；外部流水reference唯一，同账单只允许一个待核验申请；不自动生成实收|
|offline.review|finance|id,decision(approve/return),note|offlinePayments approved/returned；独立复核，批准只登记全额且与未付账单相等的已核验实收，创建receipts(adapterMode=manual,externalReference)，账单paid|
|refund.request|加盟商/manager/finance|receiptId,amount,reason|refundRequests pending；不能超过实收减已完成和在途退款；禁止Mock实收作为真退款；已开票仍可申请但审核受发票冲红限制|
|refund.review|finance|id,decision(approve/return),note|refundRequests approved/returned；独立复核；已开票须先人工冲红，未开票申请须取消；批准不扣实收、不声称退款成功|
|refund.record|finance|id,reference,refundedOn,note|refundRequests recorded；仅批准后登记外部已完成退款凭证；reference唯一；账单仍保留paid与refundAmount，不自动重开欠款|
|invoice.request|加盟商/manager/finance|receiptId,amount,title,taxId,reason|invoiceRequests pending；不能超过净实收减已申请未取消未冲红金额，必须存在协议确认的开票主体|
|invoice.update|finance|id,status(issued/rejected/cancelled/red_pending/red_issued),note；issued需number,issuedOn；red_issued需redNumber,redOn|invoiceRequests；pending→issued/rejected/cancelled；issued→red_pending；red_pending→red_issued；票号唯一，保存真实外部凭证，退票不会自动退款|

## 周期任务、知识库与公开资料

|命令|角色|输入|结果集合/规则|
|---|---|---|---|
|jobs.run|manager/ops/finance|可选 today(必须等于服务端today)、limit(默认100,1—200)、cursor(默认0,非负)、outlet|jobRuns；每日每批jobKey唯一，重复扫描新事件及超时但相同taskKey不重复通知；返回processed/nextCursor/createdTasks/attempts。上月缺报、本月位置、逾期账单、客服SLA和显式阈值异常。外部微信消息仍由真实适配器负责|
|task.update|manager/对应岗位|id,status(open/in_progress/resolved),note；可选assignee(有效staff subject)|businessTasks；消息已读不完成待办；报送/支付等事实自动使相关待办resolved，异常需人工解释；普通用户不可自行结清催缴任务|
|faq.save|manager/support|可选id；question,answer,keywords(字符串数组),published(布尔),reason|faqEntries；公开仅已发布，按关键词答复公开FAQ，客服无内部财务读取权|
|public.profile|manager/ops|outlet,title,description,services(字符串数组),contact,address,published(布尔),reason|publicProfiles；独立公开资料，不曝光内部坐标/负责人/消费者信息|
|content.update|manager|原字段兼容；key扩展brand/services/news/cases/cooperation|contents；仍明确发布/草稿|

## 批量导入、个人岗位与交接

|命令|角色|输入|结果集合/规则|
|---|---|---|---|
|import.preview|manager|kind(accounts/outlets),rows(1—200行),reason|importBatches preview；每行errors数组、validCount/errorCount；有错误禁止提交。accounts每行name,managerName,mobile；outlets每行owner,name,province,city,district,address,phone,opening,status(preparing/open/paused),enrollmentApplicable(布尔)；坐标暂null待核验，不虚构真实坐标|
|import.commit|manager|id|importBatches committed；提交时再次查重复/主体有效性；事务一次性创建所有行，保留createdIds；同batch重复提交返回原记录|
|staff.create|manager|subject(3—80字母数字_-),name,role(ops/manager/finance/location/support/regional),reason；regional必填grants{outlets,metrics,reviewOutlets}|staffAccounts active；subject是自然人principal，actor永远是岗位role，不能创建密码/伪造登录|
|staff.update|manager|id,status(active/disabled),reason；可选name,role,grants|staffAccounts；禁用有个人待办者必须先交接，禁止禁用自己；bindingVersion递增使会话撤销|
|staff.handover|manager|fromSubject,toSubject,reason|handovers completed；两人同岗位且接收人active，转移未结束客服单/聊天和businessTasks，停用离任者并递增bindingVersion；保留每条转移记录和原操作者|

### 认证/集成要点

新增集合：`policies,pricePlans,agreements,billCorrections,feeProposals,offlinePayments,refundRequests,invoiceRequests,businessTasks,jobRuns,faqEntries,publicProfiles,importBatches,staffAccounts,handovers,cooperationRequests`；003与007迁移采用现有id/owner/outlet/status/month/version/current/amount_cents/data/created_at投影。

`staffAccounts.id=subject=principal` 对应 users.actor 中个人登录主体，`staffAccounts.role` 对应会话actor。命令ctx为 `{subject:个人主体,requestId,now?:ISO,today?:日期}`。认证层必须每次会话检查staff状态/role/bindingVersion；领域亦复核已有staff subject的状态和角色。regional个人授权优先于旧全局s.grants；`aggregate`新增可选第四参数ctx。support.claim把assignee设为ctx.subject||actor，后续仅该个人或严重升级manager处理。相同role的另一个人没有自动接管权。只有now时按Asia/Shanghai推导today；显式today用于可信测试/作业时钟。

`core.view(state,actor,ctx)` 输出新增集合。manager可见全部；finance仅财务/任务/已发布公开资料/政策；ops可见协议价格政策、纠错提案和业务任务；加盟商仅本人协议/账单/财务申请/非内部任务；public只公开FAQ和网点资料；support只自己的客服及客服任务；regional仅个人授权范围。审计记录保留actor和subject，账户手机脱敏。

### 可执行口径与未配置项

整月协议与费用提案是人工明确确认的业务事实；partialMonthRule/transferRule默认null，不预设首月、跨月退款收入归属、自动税额或停费折算。线下实收、退款、发票均保留外部reference，系统不宣称调用银行/微信/税务。配置版本和协议价快照用于追溯，历史账单不随新价回写。

月报新增 `policyId,dueOn,late`；采用已生效政策，明确未配置截止时late=null；没有新政策时保留旧版次月5日规则兼容。SLA以自然分钟计算首响，尚不编造工作日历；无新政策时兼容support.settings.sla，新政策的null不被旧设置覆盖。

businessTasks.kind 为 report_missing/exemption_review/location_missing/bill_overdue/support_sla/metric_anomaly/no_data，字段outlet/month/role/recordId/dueOn/overdue/status/assignee。缺报/位置recordId可null，账单逾期指向账单，客服超时指向工单；消费者客服任务仅总部可见，加盟商不收到隐私细节。正常业务事实完成会自动resolved，已读通知不会结清待办。


位置待办是派生集合 locationTasks，按当前上海业务月份先在 SQL 筛选未核验网点再分页，total 与 hasMore 对应同一范围；status=missing/pending/exception/all，已批准不属于待办，approved 查询返回空。可按 owner/outlet/省市区/q 筛选，历史月份须走 verifications 集合。

图片上传的 bytes 与 file_metadata 原子提交，异步清洗后再次校验会话；授权读取旧图片时补做清洗与元数据，失败不返回原始危险内容。返回 data 含 id/name/type/size/url/sanitized/width/height。

## V3.1 新增与变更契约（优先于上述历史兼容说明）

OpenAPI现有33路径、34操作、66个commands，逐一与源码命令集合比对。真实支付走专用路由，旧payment.start/payment.resolve只供Mock并拒绝真实订单。

| 方法/路径 | 输入及结果 |
|---|---|
| POST /api/auth/wechat | {code}；服务端code2session，仅有效绑定映射到已创建负责人，未绑定403 WECHAT_UNBOUND；不接受角色选择 |
| POST /api/auth/wechat/bind | Bearer负责人、{code}；已有微信跨主体绑定409；异步后重验身份，返回wechatBound |
| GET /api/auth/bindings | wechatBound、smsMobileMasked；不返回OpenID或session_key |
| POST /api/auth/sms/send | {mobile,purpose?:login}；challengeId/expiresIn=300/resendAfter=60/mode；仅开发Mock可能返回devCode |
| POST /api/auth/sms/verify | {challengeId,code,mobile?}；单次使用、5次错误上限、5分钟有效，返回登录会话；手机号须总部预建 |
| GET /api/reports/context | outlet、month；draft、currentApprovedVersion、latestSubmittedVersion、historyVersions、enrollmentStatus；无网点权限403 |
| POST /api/payments/prepay | Bearer本人、{billId}和8—128字符Idempotency-Key；返回paymentId/requestPayment，客户端交wx.requestPayment |
| POST /api/payments/{id}/query | 空 JSON，本人、财务或管理层。返回 payment、bill、providerTradeState。查实待对账的付款时返回 reconciliationRequired。 |
| POST /api/payments/{id}/close | 空 JSON，先验签查单。到期且 NOTPAY 才向渠道关单，到期且确认查无交易时释放本地订单。核验 SUCCESS 时按资金事实处理。 |
| GET /api/payments/exceptions | 财务与管理层。limit 为 1–100（默认 25）、offset 为非负整数（默认 0）。返回 items、offset、nextOffset。 |
| GET /api/payment-refunds/requests/{refundRequestId} | 财务与管理层。返回退款申请、已审核整数分金额、对应付款渠道、可发起标志和既有渠道单。 |
| POST /api/payments/notify | 无Bearer，以Wechatpay四签名头和原始JSON验签/AES-GCM解密；成功204无响应体；错误保持未入账 |
| GET/POST /api/wechat/official/callback | GET签名校验回显；POST安全模式XML、msg_signature/timestamp/nonce；返回加密XML或success，不包装JSON |
| GET /api/wechat/official/delivery | chatId；本人接单客服/manager最多50条outbox状态，含failed/uncertain错误码 |
| POST /api/wechat/official/dispatch | manager、空JSON；处理1条pending，不重发uncertain |

业务新增commands：enrollment.confirm(outlet,applicable,effectiveMonth,reason)由manager/ops确认；location.baseline.confirm(outlet,coords,reference,reason)仅专岗；grant.revoke(id,reason)仅manager；content.service.save(slot 1—5,title,body,summary?,imageId?,published,reason)仅manager；support.ack(id)仅会话/工单所有者。

report.draft只必填outlet/month，空数值保留null，已填写仍校验；report.submit完整校验。report.correct增加correctionType=field/full与fields，field必须一个合法字段。V1批准、V2待审时V1仍有效。招生pending不默认N/A；enrollmentHistory按effectiveMonth取适用性。

location.submit增加capturedAt，coords保留source/coordinateSystem/accuracy（含0）；manual不能批准为现场GPS。policy.configure增加可空locationThresholdMeters，不配置不能自动判断距离异常。只有GCJ-02同坐标系且已有专岗confirmedLocation才按haversine-v1计算。公众仅publicLocation(latitude/longitude/coordinateSystem/precision)，不默认返回phone/contact/内部coords。位置任务权限仅本人、manager、location；旧运营/财务可见描述不再适用。

staff grants增加validFrom/validUntil精确ISO时间，撤权立即影响SQL total/详情/统计/幂等。support.settings增加可空phone，电话来源记录不启用录音。content.update新增body/summary/imageId并要求显式published，保留intro/text兼容；publishedSnapshot隔离未发布草稿，contentVersions留历史，禁止将加盟商照片作为公开封面。

Dashboard新增reportingCoverage(expected/submitted/pendingReview/approved/exempt/overdue/notApplicable/awaitingEnrollment/notRequired/settled/complete)，免报单列不补0；settlement保存覆盖快照。导出成功写export.generated审计，包含范围/格式/行数/方法版本/requestId。公开/内部字段隔离必须由服务端实施。

供应商请求有超时与响应体边界；微信/腾讯/商户/公众号代码已实现，正式环境联调待验。订阅消息/地理编码另外仍未接。生产未配置能力明确拒绝，不回落Mock。

公开电话：public.profile新增contactPublished布尔值，默认false；只有明确发布且contactPublished=true才返回publicProfiles.contact。outlets.phone仍不默认公开，未授权电话不得从其他字段旁路披露。

已发布公开网点目录和详情也会返回明确授权的 contact。public.profile 接受可选的 businessHours，用于记录经确认的对外服务时间，最长 160 字。省略该字段沿用已有资料，传入空字符串清除。只有已发布的公开资料会返回服务时间。

## V3.3 契约

- 支付保留旧微信 prepay、query、close 和 notify 路径，新增 channel、simulation、双渠道回调、退款及按笔对账。详情见《微信支付与支付宝双渠道接口说明》和 OpenAPI。支付正式渠道按协议、账单和配置的实际商户核对。
- 财务 GET /api/finance/summary、/api/finance/bills/{id}、/api/finance/export、/api/finance/catch-up 使用同一账簿。金额字段后缀 Cents 表示整数分，投影依本人、财务和管理层。账单列表同一合计与独立流水分页并存。
- 账单详情可传 `section` 和可选的 `recordId`。其中 `section` 默认 `receipts`，支持 `lineage`、`credits`、`corrections`、`receipts`、`payments`、`offlinePayments`、`refundRequests`、`invoiceRequests`。传入 `recordId` 时，响应的 `selectedRecord` 是同一授权账单与分类下的指定记录，分页和总数保持原有含义；找不到关联则返回 404。
- `location.review` 的 `note` 保留内部核验依据。可选的 `publicNote` 最长 800 字，供申请人或加盟商在相应详情、消息及审批历史中查看。历史核验消息未单独记录对外说明时展示按状态生成的固定正文。
- 加盟商退款申请和账单详情投影中的 `customerReference` 为可对外展示的退款凭证号，`reference` 兼容已有读取方。总部保留原始对账及去重引用。支付结果通知的 `paymentId` 与渠道退款通知的 `refundRequestId` 用于打开具体记录，相关详情继续按当前登录主体校验。
- 月报 settle 支持 taskId，历史重结沿用同一统计快照。报送截止状态由同一服务端解析，导出保留迟报和覆盖相关字段。
- 内容 GET /api/collections/publicContents[/{id}] 仅授权发布资料。content.publication 支持 withdraw、restore 和版本并发校验。主内容指令增加可选 expectedVersion。
- support.management 支持可选 customerReply。note 属内部处理，显式 customerReply 才进入访客消息和相应渠道送达队列。

## V3.3 复验版月报版本摘要

GET /api/collections/reports 支持 includeVersionNumbers=true。已授权列表记录会追加 versionNumbers，其中 effective 为当前有效版本号，latest 为同一主体、同一网点和自然月最新提交版本号。不存在时返回 null。摘要不取决于历史页的 limit 或状态筛选。未请求此字段的现有调用沿用原结果结构。历史详情沿用既有授权投影，旧版本可能仅返回摘要。

GET /api/collections/reports 可加 latestOnly=true。查询只纳入同一主体、同一网点和自然月的最新提交版本，再按状态筛选并计算总数和分页。经营月报的「待我修改」使用 status=returned&latestOnly=true。省略 latestOnly 或设为 false 时继续提供全部符合条件的历史，当前有效版本和历史详情的权限及口径不变。
