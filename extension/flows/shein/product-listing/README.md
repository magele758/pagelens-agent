# SHEIN 商品试填

在已登录的 [SHEIN 卖家中心](https://sellerhub.shein.com/#/spmp/commdities/list) 打开 PageLens，选择「工作流 → SHEIN → 商品上架」或使用对话框上的快捷入口。面板会打开发布页。可提供完整类目路径，也可以在卖家中心手动选择末级类目。

选择包含 `product.json` 的商品目录，或在面板输入商品 JSON。字段名和选项取自当前 SHEIN 页面。以下示例中的属性及数值适用于演示，正式商品使用实际资料。

```json
{
  "title": "Insulated Travel Tumbler",
  "description": "Stainless steel travel tumbler with a sliding lid.",
  "sku": "EXAMPLE-CUP",
  "imagePath": "images/main.jpg",
  "shein": {
    "categoryPath": ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"],
    "attributes": { "产品功能": ["无"] },
    "variantGroups": [{"name": "颜色", "options": [{"value": "黑色"}]}],
    "sites": ["美国站"],
    "squareImagePath": "images/square.jpg",
    "skus": [{
      "options": {"颜色": "黑色"},
      "sellerSku": "EXAMPLE-CUP-BK",
      "priceUsd": 39.5,
      "quantity": 1,
      "weightG": 340,
      "lengthCm": 22,
      "widthCm": 10,
      "heightCm": 10,
      "imagePath": "images/black.jpg"
    }]
  }
}
```

- 商品目录有中文标题或描述时，可补充 `shein.englishTitle` 和 `shein.englishDescription`。
- 基础商品尺寸用 `shein.dimensions`，包装尺寸用 SKU 行里的 `lengthCm`、`widthCm`、`heightCm` 和 `weightG`。
- 单个主规格可从目录匹配主图、详情图、`squareImagePath` 与 `swatchImagePath`。SKU 图须在对应 SKU 行指定 `imagePath`。面板只在勾选本次上传时读取图片。多主规格的详情图与方形图需在卖家页核对补齐。
- 首次试填请在卖家中心核对报告中的待填项目。工作流停在新建表单，提交由卖家页的「发布商品」完成。
