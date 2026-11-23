# 九盈英才小程序视觉改版执行计划

以当前工作树为基线。参考图用于判断信息层次和视觉密度。公众首页保留集团、网点、登录、加盟申请和联系总部的实际入口。经营首页保留首家网点、待办、核验、账单和经营数据。设计使用九盈的蓝白色、原创建筑插画、淡色网格纹和 TDesign 图标。

## 工作包

1. 组件接入。锁定 TDesign 微信小程序版，整理页面级组件依赖和许可证，使小程序源码可直接导入。静态检查和微信官方编译必须包含页面声明的组件及传递依赖。
2. 首页。访客首屏显示集团、服务网点与加盟商登录。两项主入口之后是常用服务宫格和已发布业务。加盟商工作台保持待办优先，保留通知红点、原记录、经营办理和首店申请路径。
3. 业务界面。个人中心导航采用单元格，登录输入和主要按钮采用组件库。账单、月报、事项用同一视觉呈现无记录状态。保留提交、定位、支付、权限和数据核验逻辑。
4. 验收。检查组件使用声明、组件文件和编译输入。重点确认访客入口和加盟商入口范围、登录控件绑定、通知红点、已发布内容与原路由。微信官方编译、已有 Node 回归和微信模拟器检查分别记录。

## 验收命令

- `npm run wechat:vendor -- --check` 校验组件生成结果。
- `node scripts/wechat-validate.cjs` 检查 21 个注册路由及组件引用。
- `node scripts/wechat-build.cjs --out execution/tdesign-refresh/preview` 构建到独立目录。
- `node scripts/wechat-compile.cjs --project execution/tdesign-refresh/preview --tool-dir <现有官方开发者工具目录> --out execution/tdesign-refresh/compile` 检查官方编译。
- `node --test tests/*.test.cjs` 核对回归结果与改版前测试记录。
