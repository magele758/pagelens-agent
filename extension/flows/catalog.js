export const workflowPlatforms = [
  { id: "shopee", name: "Shopee", icon: "shopee.png", features: [
    { id: "product-listing", name: "商品上架", description: "单个或目录批量试填，支持主图、SKU 图和尺码表。" },
    { id: "campaign-data", name: "活动数据", description: "读取官方活动、商品提报和店铺促销，支持中文翻译和导出。" },
    { id: "campaign-draft", name: "活动表单试填", description: "试填折扣名称，查看活动时段和商品要求。" },
    { id: "voucher-data", name: "优惠券数据", description: "整理领取期限、折扣、使用量和状态，支持导出。" },
    { id: "voucher-draft", name: "优惠券表单试填", description: "试填店铺固定金额券，核对券码、门槛和数量。" },
  ] },
  { id: "temu", name: "Temu", icon: "temu.png", features: [] },
  { id: "amazon", name: "Amazon", icon: "amazon.png", features: [] },
  { id: "tiktok-shop", name: "TikTok Shop", icon: "tiktok-shop.png", features: [
    { id: "tiktok-mx-draft", name: "墨西哥商品草稿", skillName: "TikTok 墨西哥商品草稿",
      description: "打开草稿技能，在对话中补充商品链接后发送。" },
  ] },
];
