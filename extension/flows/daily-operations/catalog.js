import { TEMU_SELLER_OPERATIONS } from "../temu/seller-operations/routes.js";

const globalTemu = "https://agentseller.temu.com";
const europeanTemu = "https://agentseller-eu.temu.com";

export const dailySources = {
  orders: {
    name: "方果订单", platform: "方果", module: "订单", url: "https://fangguo.com/business/order",
    sections: [
      "全部", "待整理", "待推送", "已反审", "已锁单", "工厂待审", "生产中", "提前发货", "已打包",
      "作废", "部分发货", "已发货", "退款中", "关闭", "外部发货", "售后草稿", "售后已提交", "售后完成",
    ],
    translations: [
      "all", "To be organized", "Pending push", "The case has been reviewed.", "Orders have been locked",
      "Factory pending audit", "In production", "Early delivery", "Packaged", "invalid", "Partial shipment",
      "Shipped", "Refund in progress", "closure", "External shipping", "After-sales draft",
      "After-sales service has been submitted.", "After-sales service completed",
    ],
  },
  refunds: {
    name: "Temu 退货退款", platform: "Temu", module: "退货退款", url: globalTemu + "/mmsos/return-refund-list.html",
    sections: ["全部", "待处理", "已申请", "包裹已寄出", "平台审核中", "已退款", "已拒绝", "已取消"],
    header: "售后单号",
    fields: /^(售后单号|售后单类型|国家\/地区|退货\/退款原因|订单号\/订单状态|操作节点|售后单状态)$/u,
  },
  chat: {
    name: "Temu 待回复", platform: "Temu", module: "客服", url: europeanTemu + "/chat-app/index",
    sections: ["待回复消息"],
  },
  violations: {
    name: "Temu 违规信息", platform: "Temu", module: "违规信息", url: europeanTemu + "/mmsos/mall-appeal.html",
    sections: ["订单违规", "店铺违规"], header: "违规编号",
    fields: /违规编号|违规类型|违规状态|处理进度|时间|涉及站点|限制状态|违规原因/u,
  },
  funds: {
    name: "Temu 资金限制", platform: "Temu", module: "资金限制", url: europeanTemu + "/labor/limited/list",
    sections: ["限制记录"], header: "限制原因",
    fields: /^(限制原因|.*限制金额(?:\([A-Z]+\))?|限制金额说明)$/u,
  },
  campaigns: {
    name: "Temu 营销活动", platform: "Temu", module: "营销活动", mode: "campaigns",
    url: TEMU_SELLER_OPERATIONS["temu-campaign-data"].href,
    sections: ["邀约活动", "直降促销活动", "专属补贴活动"],
  },
  traffic: {
    name: "Temu 商品流量", platform: "Temu", module: "商品流量", mode: "analytics",
    url: europeanTemu + "/main/flux-analysis", sections: ["近1日", "近7日"],
  },
  sales: {
    name: "Temu 销量分析", platform: "Temu", module: "销量分析", mode: "analytics",
    url: europeanTemu + "/main/data-center/goods-data", sections: ["销量概览"],
  },
  market: {
    name: "Temu 今日大盘数据", platform: "Temu", module: "今日大盘数据", mode: "analytics",
    url: europeanTemu + "/main/act/data", sections: ["今日大盘"],
  },
};

export const dailySelectionKey = "pagelens.dailyOperations.selection.v1";

export function dailyPlan(selection, source = "all") {
  return Object.fromEntries(Object.entries(dailySources).flatMap(([id, config]) => {
    if (source !== "all" && id !== source) return [];
    const sections = selection == null ? config.sections :
      config.sections.filter(section => Object.hasOwn(selection, id) &&
        Array.isArray(selection[id]) && selection[id].includes(section));
    return sections.length ? [[id, [...sections]]] : [];
  }));
}

export function savedDailyPlan(selection) {
  if (selection == null) return dailyPlan();
  if (selection.version === 2) return dailyPlan(selection.sources);
  // Existing choices used the old catalog. Newly added sources start checked.
  const additions = Object.fromEntries(Object.entries(dailySources)
    .filter(([, config]) => config.mode).map(([id, config]) => [id, config.sections]));
  return dailyPlan({ ...additions, ...selection });
}

export function dailySectionName(id, section) {
  const { platform, module } = dailySources[id];
  return [platform, module, section].join(" › ");
}

export function dailySourceForUrl(href) {
  try {
    const url = new URL(href);
    if (url.username || url.password) return undefined;
    return Object.keys(dailySources).find(key => dailySources[key].url === url.origin + url.pathname);
  } catch { return undefined; }
}
