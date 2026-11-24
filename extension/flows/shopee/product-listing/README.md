# Shopee 商品上架

在 Shopee 店铺的新增商品页打开 PageLens「工作流 → Shopee → 商品上架」。选择一件商品或最多 30 件商品的父目录。点击「创建商品」会创建全球商品。点击「创建并上架」会继续确认店铺及价格，然后提交店铺上架。

默认同时处理 5 个标签，并发数量可设为 1–10。已处理的工作标签会关闭，释放的位置立即开始下一件。侧栏显示创建状态及核对到的商品编号。遇到提交结果不确定时，先在卖家后台核对，同一货号的未确认提交不会自动重发。

侧栏在上传图片、识别尺码图或保存尺码表前显示所需授权。另可允许已配置的 AI 分析商品资料和主图。AI 优先匹配该店铺核对过的类目，也可结合关键词与当前页面的选项寻找类目。联动属性按实时选项填写和核对。未解决的属性会留待最终核对，流程继续尝试填写图片、规格和 SKU。图片缩略图加载完成后才会标记上传成功。

图片路径相对于商品目录。`imagePath` 指定主图，`galleryImages` 支持另外最多 8 张商品图片，规格图由各 SKU 的 `imagePath` 指定。服装尺码图可命名为 `size.png`，或通过商品导出数据中的 `sizeChartImagePath` 指定。侧栏从图中提取数据，按页面必填列补全并标记估算，再创建或复用尺码表。导出数据也可直接提供结构化 `sizeChart`。

## 排查入口

| 现象 | 先看 |
| --- | --- |
| 提示未打开目标店铺或页面 | [页面匹配规则](definition.js) |
| 目录读不到商品或图片 | [目录参数准备](sidepanel/product-directory.js)、[本机目录读取](../../../../native/product-directory.mjs) |
| 某件商品没有打开标签或任务停在队列里 | [批量调度](sidepanel/batch-run.js)、[批量状态与回执](sidepanel/batch-ui.js) |
| 类目、下拉、规格行或 SKU 图没有填上 | [页面识别](page-state.mjs)、[表单回放](listing.flow.mjs) |
| 尺码图识别或补全失败 | [尺码解析](../../../lib/size-chart.mjs)、[尺码图 Skill](../../../skills/size-chart-image/SKILL.md) |
| 尺码表选项、填行或保存失败 | [尺码表页面操作](page-size-chart.mjs) |
| 侧栏或外部调用的权限及回执异常 | [侧栏页面工具](sidepanel/tool-adapter.js)、[外部桥接工具](bridge-tools.js) |

在仓库根目录运行该功能的回归测试。

```sh
node scripts/run-tests.mjs shopee/product-listing
```
