import { listFlows } from "../../../../lib/flow/runtime.js";
import { $ } from "../../../../sidepanel/dom.js";
import { bindPtcBatch } from "./batch-ui.js";
import { mountProductListingDialog } from "./dialog.js";

const STEPS = [
  ["bind-page", "核对页面和店铺"],
  ["basic", "填写商品名称和描述"],
  ["category", "选择类目"],
  ["category-attributes", "填写联动属性"],
  ["image", "上传商品主图"],
  ["sales", "填写规格、SKU 与图片"],
  ["shipping", "填写运费并回读"],
  ["size-chart", "填写并核对尺码表"],
  ["submit-create", "创建全球商品"],
  ["submit-publish", "确认店铺上架"],
];
const STEP_LABELS = new Map(STEPS);
const REASONS = new Map([
  ["page-changed", "目标页面或店铺已变化。"],
  ["modal", "页面出现弹窗。"],
  ["page-validation", "页面提示校验错误。"],
  ["required-fields-remain", "页面仍有必填项待补。"],
  ["different-category", "表单已选择其他类目。"],
  ["category-option-missing", "推荐列表没有唯一匹配的类目。"],
  ["category-not-ready", "类目联动表单还未确认。"],
  ["category-control-changed", "推荐类目控件已变化。"],
  ["required-attribute-missing", "待填写新的必填属性。"],
  ["attribute-changed", "属性控件已变化。"],
  ["attribute-option-changed", "属性下拉选项未匹配。"],
  ["attribute-readback", "属性未通过回读校验。"],
  ["attribute-advice-unavailable", "上品助手暂时无法补齐商品属性。"],
  ["attribute-advice-not-approved", "请允许已配置的 AI 分析本次商品。"],
  ["unexpected-open-menu", "页面有展开的菜单。"],
  ["cover-count-unknown", "无法读取当前主图数量。"],
  ["cover-already-present", "当前表单已有主图，请先核对。"],
  ["cover-readback", "主图上传后未通过回读。"],
  ["gallery-cover-unverified", "主图仍在处理中，请检查商品图片。"],
  ["gallery-upload-unverified", "有商品图片尚未上传完成，请检查缩略图。"],
  ["different-variant", "表单中已有其他商品规格。"],
  ["sku-row-not-unique", "未找到唯一匹配的 SKU 行。"],
  ["sku-readback", "实际 SKU 行未通过回读。"],
  ["sku-image-control-missing", "未找到该规格的图片控件。"],
  ["sku-image-readback", "规格图片未通过回读。"],
  ["sku-image-already-present", "该规格已有图片，请先核对。"],
  ["variants-already-enabled", "页面已启用规格。"],
  ["control-missing", "页面中缺少操作控件。"],
  ["control-changed", "操作控件已变化。"],
  ["field-missing", "页面中缺少商品字段。"],
  ["field-kind-changed", "商品字段类型发生变化。"],
  ["readback-mismatch", "字段回读未通过。"],
  ["permission-denied", "Chrome 未授予此站点访问权限。"],
  ["upload-denied", "此主图尚未获同意上传。"],
  ["flow-busy", "此标签已有流程正在运行。"],
  ["batch-product-error", "无法完成该商品。"],
  ["batch-tabs-not-closed", "有工作标签未关闭。"],
  ["batch-submit-unknown", "提交结果待核实。"],
]);
const LABELS = { label: "属性", choice: "选项", category: "类目", recommendations: "页面推荐类目", option: "规格选项", key: "字段",
  expected: "预期", actual: "当前", text: "提示", error: "工具错误", message: "提示" };

function detailsText(value, depth = 0) {
  if (value == null || value === "" || depth > 2) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).slice(0, 300);
  if (Array.isArray(value)) return value.slice(0, 5).map((item) => detailsText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  return Object.entries(value).filter(([key]) => Object.hasOwn(LABELS, key)).map(([key, raw]) => {
    const text = detailsText(raw, depth + 1);
    return text ? `${LABELS[key]} ${text}` : "";
  }).filter(Boolean).join("\n");
}

function shopFor(url, flow, { requireListing = true } = {}) {
  try {
    const page = new URL(url);
    const values = page.searchParams.getAll("cnsc_shop_id");
    return page.origin === flow.origin && (!requireListing || page.pathname === flow.path) &&
      !page.username && !page.password && values.length === 1 &&
      /^\d+$/.test(values[0]) ? values[0] : "";
  } catch { return ""; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function errorText(receipt) {
  return [REASONS.get(receipt.code) || "请检查商家后台的商品资料。", detailsText(receipt.details)].filter(Boolean).join("\n");
}

export function bindPtcFlow({ isAgentBusy, onReview, onBack, getTargetTab = activeTab, chooseDirectory, startBatch } = {}) {
  const flow = listFlows().find(({ id }) => id === "shopee-listing");
  if (!flow) return;
  const dialog = mountProductListingDialog();
  const target = $("ptc-target");
  const close = $("ptc-close");
  const back = $("ptc-back");
  const listingLink = $("ptc-product-link");
  const review = $("ptc-review");
  const result = $("ptc-result");
  const status = $("ptc-status");
  const batchPane = $("ptc-batch-pane");
  const remotePane = $("ptc-remote-pane");
  let selectedTab;
  let tabRevision = 0;
  let remote;
  let remoteProgress = Promise.resolve();
  let issue;

  const stepLabel = step => STEP_LABELS.get(step);
  const batch = bindPtcBatch({
    flow, chooseDirectory, startBatch,
    getTarget: () => ({ tab: selectedTab, shopId: shopFor(selectedTab?.url, flow) }),
    isBlocked: () => remote?.status === "running" || isAgentBusy?.(),
    onChange: displayControls,
    onReview: onReview ? problem => { dialog.close(); onReview(problem); } : null,
    stepLabel, errorText,
  });

  function displayControls() {
    close.disabled = back.disabled = batch.busy;
    review.hidden = !issue || typeof onReview !== "function";
    batch.updateControls();
  }

  async function syncTarget() {
    const revision = ++tabRevision;
    const tab = await getTargetTab().catch(() => null);
    if (revision !== tabRevision) return;
    if (selectedTab?.id !== tab?.id || selectedTab?.url !== tab?.url) batch.resetConsent();
    selectedTab = tab;
    const shop = shopFor(tab?.url, flow);
    target.textContent = shop ? `卖家中心 · 当前店铺 ${shop}` : tab?.id && !tab.url
      ? "开始时由 Chrome 确认此站点的访问权限。"
      : "请打开 Shopee 卖家中心的「新增商品」页面。";
    const currentShop = shopFor(tab?.url, flow, { requireListing: false });
    const destination = new URL(currentShop ? flow.path : "/", flow.origin);
    if (currentShop) destination.searchParams.set("cnsc_shop_id", currentShop);
    listingLink.href = destination.href;
    listingLink.textContent = currentShop ? "打开当前店铺的新增商品页" : "打开 Shopee 卖家中心";
    listingLink.hidden = Boolean(shop || (tab?.id && !tab.url));
    displayControls();
  }

  function showRemote(show) {
    batchPane.hidden = show;
    remotePane.hidden = !show;
    if (!dialog.open) dialog.showModal();
    void syncTarget();
  }

  if (onBack) {
    back.hidden = false;
    back.addEventListener("click", () => { dialog.close(); onBack(); });
  }
  close.addEventListener("click", () => { if (!batch.busy) dialog.close(); });
  dialog.addEventListener("cancel", event => { if (batch.busy) event.preventDefault(); });
  review.addEventListener("click", async () => {
    const tab = await getTargetTab().catch(() => null);
    if (!issue || issue.tabId !== tab?.id || !shopFor(tab.url, flow)) {
      status.textContent = "请返回发生异常的 Shopee 表单。";
      return;
    }
    dialog.close();
    onReview(issue);
  });

  chrome.tabs.onActivated.addListener(() => { if (dialog.open) void syncTarget(); });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (dialog.open && tabId === selectedTab?.id && (change.url || change.status === "complete")) void syncTarget();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || message?.type !== "pl.flow.progress" ||
      message.source !== "gateway" || message.flowId !== flow.id || batch.busy) return false;
    remoteProgress = remoteProgress.then(async () => {
      if (batch.busy) return;
      if (remote?.runId !== message.runId) {
        if (message.status !== "running") return;
        const tab = await getTargetTab();
        if (!tab || tab.id !== message.tabId || !shopFor(tab.url, flow) || batch.busy) return;
        selectedTab = tab;
        remote = { runId: message.runId, status: message.status };
        issue = null;
        showRemote(true);
      }
      remote.status = message.status;
      status.dataset.state = message.status;
      status.textContent = message.status === "running" ? stepLabel(message.step) || "正在填写商品…" :
        message.status === "verified" ? "商品资料已填写，请在 Shopee 核对并发布。" :
        message.status === "cancelled" ? "已停止。" : "还有需要处理的问题。";
      result.textContent = message.status === "needs-review" ? errorText(message) : "";
      result.hidden = !result.textContent;
      issue = message.status === "needs-review" ? { tabId: message.tabId, step: stepLabel(message.step),
        code: message.code, details: detailsText(message.details) } : null;
      displayControls();
    }).catch(() => {});
    return false;
  });

  return () => { showRemote(remote?.status === "running"); return true; };
}
