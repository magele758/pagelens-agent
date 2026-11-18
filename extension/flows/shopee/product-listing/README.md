# Shopee 商品上架

在 Shopee 店铺的新增商品页打开 PageLens「工作流 → Shopee → 商品上架」。单商品模式接受 JSON 参数。目录批量模式读入带 `product.json` 的商品目录或其父目录，为每个商品打开独立标签，填写表单、上传已确认的图片并读回结果。试填完成后停在商品表单。

图片路径相对于商品目录。服装尺码图可命名为 `size.png`，或通过 `sizeChartImagePath` 指定。侧栏从图中提取数据，按页面必填列补全并标记估算，再创建或复用尺码表。也可直接提供结构化 `sizeChart`。上传图片、调用识图模型和保存尺码表前，侧栏会显示本次商品涉及的操作并让用户确认。

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
