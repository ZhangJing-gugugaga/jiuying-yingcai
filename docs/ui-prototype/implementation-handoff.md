# 原型改版实施交接

首个可评审页面为**公众首页**。它能用已发布的内容验证品牌头图、业务磁贴和窄屏换行，也能从两个地域入口检查第一次目录查询。第二个样板选**退回月报**，用同一网点和月份复核长原因、字段错误、草稿恢复及键盘展开；两页评审通过后再推广公共样式。任务状态见[开发计划](../../TODO.md)，预期和证据见[验收单](acceptance.md)。

| 批次 / 工作 | 实现入口与依赖 | 供评审的产出 |
| --- | --- | --- |
| ① 公众首页及地域跳转 · UX-05、06 | [首页模板](../../miniprogram/pages/home/index.wxml)与[页面逻辑](../../miniprogram/pages/home/index.js)复用已发布业务、集团简介及拨号配置。更新[网点目录](../../miniprogram/pages/outlets/index.js)的初始筛选与 tab 参数交接。先备齐一个境内、一个境外的已发布样本。 | 对照图 1 的标准宽度、窄屏及缺图首页；从两个入口取得各自首个列表请求。A01、A02、A08 |
| ② 月报组件样板 · UX-04 → UX-01 | 从[月报办理页](../../miniprogram/pages/report/index.wxml)调整摘要、退回提示、字段与操作区；复用[公共样式](../../miniprogram/app.wxss)和现行校验、保存、提交、更正逻辑。用一份真实结构的退回样本走总部原单。 | 对照图 3 的退回月报、键盘展开及错误画面；保留重新提交前后同一原单的证据。A06、A08 |
| ③ 工作台与我的事项 · UX-07、08、02 | [工作台](../../miniprogram/pages/home/index.js)按所选授权网点读取待办总数、最多四条待办和三条最近业务记录；完整记录列表沿用同一网点并分页。复用[事项路由](../../miniprogram/pages/tasks/matters.js)与[角色底栏](../../miniprogram/custom-tab-bar/index.js)。 | 对照图 2 的零店、多店、待办读取失败与有已办样本。检查最近业务记录的排序、分页和原单跳转，并复核事项与通知的筛选恢复。A03、A04、A08、A09 |
| ④ 目录与网点详情 · UX-09 | 在[列表](../../miniprogram/pages/outlets/index.wxml)及[详情](../../miniprogram/pages/outlet/index.wxml)区分公开与授权字段，沿用已有分页和地图失败返回。复用第①批的地域入口。 | 图 3、4 对应的公开/私有目录、长店名、分页、地图错误返回及换主体结果。A02、A03、A05、A08 |
| ⑤ 激活、服务费与低频入口 · UX-10、03、08 | [加盟申请](../../miniprogram/pages/join/index.js)、[激活表单](../../miniprogram/pages/login/index.wxml)、[服务费](../../miniprogram/pages/fees/index.wxml)与[历史培训](../../miniprogram/pages/training/index.js)按原单、角色与办理条件进入。 | 激活两次输入不一致、成功后身份、账单返回和有/无培训记录的入口对照。A07、A09、A10 |
| ⑥ 复验与签收 · UX-11 | 用独立包从正常入口走完整链路，再按现有授权 AppID、HTTPS 服务和设备复核真机能力。 | 逐项记录 A01–A10，分别标记代码检查、开发者工具和真机结果，附失败步骤和复测包标识。 |

## 交付依赖

设计交付两幅首页的布局与裁切，给出长名称、缺图和大字号示例；素材责任方确认可发布的标识、照片、热线、地址与官方微信。[素材使用与缺省处理](design-contract.md)

前端复用原生组件、现有 TDesign 登记项和共享样式。若工作台要启用单店选择或跨业务历史，开发先提供对应接口的授权范围、分页总数、业务时间与目标 ID 样例。若需要新接口，在服务端落实授权，完成双主体与同岗分派验收。[组件输入、状态与事件](../COMPONENT-GUIDELINES.md)

## 提测与版本核对

### 本机原型预览

在仓库根目录按 README 装好依赖。若游客 AppID 导入失败，启动前把获准用于本机模拟器的 AppID 配到当前 PowerShell 会话的 `WECHAT_APP_ID`。运行以下命令并保持进程打开。

~~~powershell
node scripts/prototype-preview.cjs
~~~

看到 `status: ready` 后，在微信开发者工具的项目管理器选择「导入」，将「目录」设为输出的 `project`，选择「不使用云服务」。首页会读取五项已发布业务、集团简介与演示封面。国内和境外入口分别打开长沙和新加坡样本。从「加盟商登录」打开「开发工具」，选择「加盟商甲 · 多网点负责人」，点「使用测试身份」。在工作台选择长沙网点可查看退回月报和培训补件。

每次启动生成新的 `dist/ui-prototype-preview-*`，通过 `127.0.0.1:18975` 连接内存数据库和模拟渠道。停止进程即清空业务样本。原先导入的根目录工程使用 `127.0.0.1:8787`，新预览需导入启动输出的目录。

### 构建与证据

1. 从[快速开始](../../README.md)配置 Node、依赖与隔离数据库，以[需求追溯](../handoff/06-需求编号追溯.md)查角色与权限。记录当前提交号及未提交的前端改动。
2. 在仓库根目录执行以下命令。每次构建选择新的输出目录，最后两条使用同一个包路径。官方编译需要已安装的开发者工具和对应的 WECHAT_DEVTOOLS_PATH。

~~~powershell
npm test
node scripts/wechat-validate.cjs
$uiBuild = "dist/ui-review-$(Get-Date -Format yyyyMMdd-HHmmss)"
node scripts/wechat-build.cjs --environment development --target simulator --out $uiBuild
node scripts/wechat-compile.cjs --project $uiBuild
~~~

3. 导入上述输出目录，核对开发者工具显示的项目路径、环境、API 和第一条实际请求，再从首页操作一项本批新增行为，例如境外入口首请求的地域值。保存构建清单或摘要，并关联对应提交和 UI 截图。[构建与分发](../REGISTRY.md)
4. 在[验收单](acceptance.md)填写已执行的用例。定位、地图、真实登录、附件和外部渠道按可用设备独立复验，记录仍缺的设备或配置。历史业务实测仅用于对比改版前后的结果。
