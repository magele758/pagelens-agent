# SHEIN 商品试填

在已登录的 [SHEIN 卖家中心](https://sellerhub.shein.com/#/spmp/commdities/list) 打开 PageLens，选择「工作流 → SHEIN → 商品上架」或使用对话框上的快捷入口。面板会打开发布页。可提供完整类目路径，也可以在卖家中心手动选择末级类目。

选择包含 `product.json` 的商品目录，或在面板输入商品 JSON。字段名和选项取自当前 SHEIN 页面。以下示例中的属性及数值适用于演示，正式商品使用实际资料。

```json
{
  "title": "Insulated Travel Tumbler",
  "description": "Stainless steel travel tumbler with a sliding lid.",
  "sku": "EXAMPLE-CUP",
  "shein": {
    "categoryPath": ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"],
    "attributes": { "产品功能": ["无"] },
    "variantGroups": [{
      "name": "颜色",
      "options": [
        {"value": "黑色", "imagePath": "images/black/front.jpg", "squareImagePath": "images/black/square.jpg"},
        {"value": "粉色", "imagePath": "images/pink/front.jpg", "squareImagePath": "images/pink/square.jpg"}
      ]
    }],
    "sharedGalleryImages": ["images/shared/lid.jpg", "images/shared/side.jpg"],
    "sites": ["美国站"],
    "package": {"weightG": 340, "lengthCm": 22, "widthCm": 10, "heightCm": 10},
    "skus": [
      {"options": {"颜色": "黑色"}, "sellerSku": "EXAMPLE-CUP-BK", "priceUsd": 39.5, "quantity": 1, "imagePath": "images/black/front.jpg"},
      {"options": {"颜色": "粉色"}, "sellerSku": "EXAMPLE-CUP-PK", "priceUsd": 39.5, "quantity": 1, "imagePath": "images/pink/front.jpg"}
    ]
  }
}
```

- 商品目录有中文标题或描述时，可补充 `shein.englishTitle` 和 `shein.englishDescription`。
- 基础商品尺寸用 `shein.dimensions`，包装尺寸用 SKU 行里的 `lengthCm`、`widthCm`、`heightCm` 和 `weightG`。
- 为每个主规格登记首图 `imagePath` 和方形图 `squareImagePath`。有色块图时填写 `swatchImagePath`。各规格的「细节图」按自己的首图、共用细节图的顺序写入。共用图可登记在 `shein.sharedGalleryImages` 或 `detailImages`，试填最多带四张共用图。SKU 图使用对应 SKU 行的 `imagePath`。
- 图片路径相对于选中的商品目录。勾选本次上传后，PageLens 通过 SHEIN 原有上传控件上传，并按主规格或 SKU 核对页面回显。如果 SHEIN 已从同一首图生成对应方形图，核对后会复用。指定的方形图与已有图片不同、缺图或遇到平台拒收时，侧栏显示对应行和待处理原因。
- 首次试填请在卖家中心核对报告中的待填项目。工作流停在新建表单，提交由卖家页的「发布商品」完成。
