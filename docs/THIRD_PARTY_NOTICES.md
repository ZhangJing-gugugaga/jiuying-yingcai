# 第三方依赖与字体

运行依赖由 `package-lock.json` 锁定精确内容，通过 `npm ci --ignore-scripts` 安装；源码包不内嵌 node_modules。审计证据见 `execution/dependency-audit.json`。安装后各依赖目录自带许可证；原生 sharp/libvips 二进制按目标平台由锁定的可选依赖安装，不交叉复制开发机二进制。

|组件|固定版本|许可|用途|
|---|---|---|---|
|pdfkit|0.20.2|MIT|服务端PDF文档|
|sharp|0.35.5|Apache-2.0|图片完整解码、去除元数据、受控重编码|
|playwright（开发验收依赖）|1.62.1|Apache-2.0|浏览器回归；不进入生产运行依赖|
|Noto Sans CJK SC Regular|Noto CJK Sans2.004|SIL OFL 1.1|PDF简体中文字体|

字体原始文件来自 [Noto CJK 官方版本](https://github.com/notofonts/noto-cjk/tree/Sans2.004)，路径 `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`，未修改；随包保留 `assets/fonts/OFL.txt`。字体未单独出售，PDF嵌入子集由PDFKit生成。

直接依赖源码和许可：[PDFKit](https://github.com/foliojs/pdfkit)、[sharp](https://github.com/lovell/sharp)。Playwright/Chrome仅用于验收，Python/Poppler用于交付打包及PDF外观检查，不是产品HTTP运行依赖。

无新增付费API或模型调用。运行成本来自Node服务、SQLite存储、图片CPU处理、中文字体约16.4MB磁盘与PDF内存；实际云主机、短信、支付与地图费用待选定服务商后核定。
