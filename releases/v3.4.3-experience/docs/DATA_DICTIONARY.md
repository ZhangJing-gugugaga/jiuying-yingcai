# 数据字典与前向迁移

现有20业务表、003新增15表、007合作留言，009增加contentVersions，业务实体共37；每表id/owner/outlet/status/month/version/current/amount_cents/data/created_at，JSON保留领域细节，投影便于查询和约束。不是全字段关系规范化模型，多数关联由事务和业务校验保证。

| 迁移 | 改动与兼容影响 |
|---|---|
| 001 | 初始20业务表、users/settings/sessions/idempotency/files和唯一约束 |
| 002 | 将JSON amount:null的旧投影0修为SQL NULL，保留真实0；重复执行安全 |
| 003 | 15领域集合和外部流水/票号/jobKey唯一索引，旧表数据保留 |
| 004 | credentials、activation_tokens、auth_attempts、audit_chain、runtime_metrics及查询索引 |
| 005 | bill_period_unique改为status<>'reversed'部分唯一索引：同月保留冲正旧单且最多一张有效单；不能回退旧全量唯一索引 |
| 006 | 修复旧SLA任务的网点/taskKey，仍owner=null/internal=true；红票号全库唯一，发现历史重复须人工核实后前向修复，不静默删凭证 |
| 007 | cooperationRequests：submitted→received→contacted→closed，联系人与同意版本，按个人会话隔离 |
| 008 | file_metadata记录原图SHA/像素/变换版本；增加认证及汇总查询索引 |

schema_migrations逐版本记录。编号按序事务执行，失败ROLLBACK；后续迁移以database目录为准。005索引重建大表需维护窗口，应用回退保留新表/索引，不能删除财务凭证或重新创建旧账单约束。

| 集合 | 核心载荷/状态 |
|---|---|
| organizations/accounts/outlets | 主体、负责人、网点营业历史与私有核验；账户绑定版本；关闭不删除历史 |
| drafts/reports/exemptions | 四指标、说明、版本/current、dueOn/policyId/late；pending/finance/returned/approved；免报独立 |
| requests/verifications | 分类申请、位置核验、补件/异常；照片引用私有files |
| bills/payments/receipts/adjustments | unpaid/paid/reversed/settled_zero；Mock尝试、manual实收、待核算→approved→applied调整 |
| settlements/summaryAdjustments | 正式结算的reportIds，invalidated；源版本引用与字段调整/复核 |
| policies/pricePlans/agreements | 生效制度版本、整月价格和三个主体、不可变priceSnapshot、起止月/账单日/截止日 |
| billCorrections/feeProposals | 原值/新值、独立发起人与复核人、关联冲正新单/明确抵扣月和可空顺延 |
| offlinePayments | 外部reference、paidOn、金额，pending→approved/returned；批准产生manual receipt |
| refundRequests | pending→approved/returned→recorded；预留净额、外部退款reference/refundedOn，不冒充银行执行 |
| invoiceRequests | pending→issued/rejected/cancelled；issued→red_pending→red_issued；蓝红票号和日期留存 |
| businessTasks/jobRuns | taskKey、kind、role/assignee、recordId、dueOn/overdue；open/in_progress/resolved；有界作业批次游标/attempts |
| supportChats/supportTickets | 普通咨询/正式工单分开，个人assignee，协作/严重升级/评价/关联新单 |
| faqEntries/publicProfiles/contents | 草稿/发布，公开资料与内部位置独立；品牌/服务/新闻/案例/合作内容 |
| importBatches/staffAccounts/handovers | 逐行errors/validCount/createdIds，个人subject岗位与区域授权、交接moved记录 |
| cooperationRequests | 单位/联系人/联系方式/留言，privacyConsented与consentVersion；提交者不见内部processingNote |
| messages/audit | 通知read与业务任务分离；请求/自然人/岗位/动作/对象/时间，审计链独立 |

基础表：users为个人principal到role映射；sessions存令牌哈希、subject、绑定版本和期限；credentials存scrypt哈希/唯一用户名；activation_tokens只存激活码摘要和消费时间；auth_attempts持久失败窗口；idempotency按subject/key保存请求指纹；files存MIME/长度/摘要/私有BLOB。settings存配置，runtime_metrics存计数与调度游标，audit_chain存链式摘要。

金额为CNY元接口、整数分运算/投影，NULL与0严格区分。业务日上海时区、审计时间ISO；日期/自然月不是交易日历。财务数据为服务费/经营报送，不是证券或投资计算。

## 整改迁移009—013

| 迁移 | 数据与兼容 |
|---|---|
| 009_domain_remediation | contentVersions保存内容快照/版本；仅修正有newOutlet批准来源且未确认招生历史的旧默认值为pending/null；不回写原月报 |
| 010_external_identity | identity_bindings(provider,external_hash,actor,binding_version,encrypted_id)；sms_challenges手机号/验证码HMAC、状态/次数/到期/消费；authentication_resets保证换绑失效版本应用 |
| 011_wechat_pay | payment_provider_orders关联payments/bills/users，商户单号/商户/App/付款人摘要/整数分/预支付/渠道流水/到期；活动账单部分唯一；payment_idempotency按subject/key；payment_notifications回调ID/内容摘要去重 |
| 012_official_account | official_contacts加密外部身份/聊天引用/最后入站；official_inbound去重与已加密回复；official_outbox回复内容/状态/次数/错误/时间，和客服回复同事务 |
| 013_payment_reconciliation | query_attempts、next_query_at、last_query_at及due索引；旧creating/pending订单由有界worker继续核实，不修改已成功实收 |

业务JSON新增：outlets的enrollmentStatus/enrollmentHistory/enrollmentInitialStatus、confirmedLocation；reports的correctionType/correctionFields/correctionDiff及适用性快照；accounts的ownerHistory/authenticationResetVersion；staffAccounts.grants的有效期与撤权；contents的publishedSnapshot；settlements的reportingCoverage/coverageComplete。

支付状态：渠道creating/pending→success或closed；业务payments相应pending/success/cancelled。服务端验证成功后同事务更新账单、唯一receipt、通知/待办及审计。REAL不能用Mock命令确认。真实退款仍是申请/独立复核/外部已完成凭证登记，没有自动调用商户退款API。

公众号outbox：pending→sending→sent/failed/uncertain；超2分钟sending恢复为uncertain，不因超时宣称送达，不盲目重复发送。联系人不与小程序OpenID直接合并。外部密钥不进库；加密身份密钥备份与数据库恢复必须配套。

## V3.3 数据演进

| 变化 | 用途 |
| --- | --- |
| 016_payment_channels | 保留原支付单和回调表的行与主键，增加渠道、模拟/真实模式、人民币币种、合同与收款主体快照。新增退款单、退款通知和交易对账记录。 |
| 财务账簿 | 服务端按账单和全部有效关联实收、退款、应收计算整数分汇总。完整凭证集合与明细分页独立，退款不自动重开欠款。 |
| 历史月报重结 | 保留失效旧结算，关联影响网点、重结责任、新旧快照和处理历史。 |
| 公开栏与客服 | 按公开快照验证版本及文件范围。公众号处理加可重试、状态和平台返回字段。 |

发布前先备份并在隔离环境迁移。回退保留新增字段、表及业务记录，支付兼容限制见支付双渠道说明。
