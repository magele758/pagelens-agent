import { shopeeExampleInput } from "../example-input.js";
import { listFlows, runFlow } from "../../../../lib/flow/runtime.js";
import { ensureOptionalAccess } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { imagePathsFor } from "./batch-run.js";
import { bindPtcBatch } from "./batch-ui.js";
import { createPtcToolCaller } from "./tool-adapter.js";
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
  ["unexpected-open-menu", "页面有展开的菜单。"],
  ["cover-count-unknown", "无法读取当前主图数量。"],
  ["cover-already-present", "当前表单已有主图，请先核对。"],
  ["cover-readback", "主图上传后未通过回读。"],
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

function duration(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
}

function receiptText(receipt) {
  const rows = (receipt.skuRows || []).map((row) => [
    row.option, row.price == null ? "" : `¥${row.price}`, row.quantity == null ? "" : `库存 ${row.quantity}`, row.sku,
    row.imageUploaded ? "SKU 图已上传并核对" : row.imageVerified ? "已有 SKU 图已核对" : "",
  ].filter(Boolean).join(" · "));
  const chart = receipt.sizeChart;
  const chartRow = chart && `尺码表${chart.reused ? "已复用" : "已保存并选中"} · ${chart.unit} · ${chart.rows} 行 · ${chart.name}`;
  const estimated = chart?.estimatedColumns?.length ? `AI 估算列 · ${chart.estimatedColumns.join("、")}` : "";
  return [receipt.category, receipt.coverUploaded ? "商品主图已上传并核对" : "", ...rows, chartRow, estimated].filter(Boolean).join("\n");
}

function errorText(receipt) {
  return [REASONS.get(receipt.code) || receipt.code, detailsText(receipt.details)].filter(Boolean).join("\n");
}

export function bindPtcFlow({ isAgentBusy, onReview, onBack, getTargetTab = activeTab } = {}) {
  const flow = listFlows().find(({ id }) => id === "shopee-listing");
  if (!flow) return;
  const dialog = mountProductListingDialog();
  const form = $("ptc-form");
  const input = $("ptc-input");
  const imagePath = $("ptc-image-path");
  const consentRow = $("ptc-consent-row");
  const consent = $("ptc-upload-consent");
  const consentText = $("ptc-consent-text");
  const target = $("ptc-target");
  const start = $("ptc-start");
  const stop = $("ptc-stop");
  const close = $("ptc-close");
  const back = $("ptc-back");
  const listingLink = $("ptc-product-link");
  const review = $("ptc-review");
  const sample = $("ptc-sample");
  const progress = $("ptc-progress");
  const result = $("ptc-result");
  const status = $("ptc-status");
  const singleMode = $("ptc-mode-single");
  const directoryMode = $("ptc-mode-directory");
  const singlePane = $("ptc-single-pane");
  const batchPane = $("ptc-batch-pane");
  let selectedTab = null;
  let tabRevision = 0;
  let local = null;
  let remote = null;
  let remoteProgress = Promise.resolve();
  let issue = null;
  let steps = new Map();
  let currentStep = "";
  const batch = bindPtcBatch({
    flow,
    getTarget: () => ({ tab: selectedTab, shopId: shopFor(selectedTab?.url, flow) }),
    isBlocked: () => local || remote?.status === "running" || isAgentBusy?.(),
    onChange: displayControls,
    onReview: onReview ? (problem) => {
      dialog.close();
      onReview(problem);
    } : null,
    stepLabel: (step) => STEP_LABELS.get(step),
    errorText,
    receiptText,
  });

  function showStatus(state, message) {
    status.dataset.state = state;
    status.textContent = message;
  }

  function showResult(text = "") {
    result.textContent = text;
    result.hidden = !text;
  }

  function selectedImage() {
    if (imagePath.value.trim()) return imagePath.value.trim();
    try {
      const path = JSON.parse(input.value)?.imagePath;
      return typeof path === "string" ? path.trim() : "";
    } catch { return ""; }
  }

  function consentActions(data, uploadPath) {
    return [
      imagePathsFor({ ...data, imagePath: uploadPath }).length > 0 && "上传本次指定的主图和 SKU 图",
      data?.sizeChart != null && data.completeMissingSizeChart === true && "必要时将尺码数据发给已配置的模型补齐必填值",
      data?.sizeChart != null && "为当前 Shopee 店铺选择或保存尺码表",
    ].filter(Boolean);
  }

  function currentConsentActions() {
    const uploadPath = selectedImage();
    try {
      return consentActions(JSON.parse(input.value), uploadPath);
    } catch {
      return consentActions(null, uploadPath);
    }
  }

  function displayControls() {
    const working = Boolean(local || remote?.status === "running" || batch.busy);
    const badTarget = !selectedTab?.id || Boolean(selectedTab.url && !shopFor(selectedTab.url, flow));
    start.disabled = working || badTarget;
    stop.hidden = !local;
    stop.disabled = Boolean(local?.signal.aborted);
    close.disabled = Boolean(local || batch.busy);
    review.hidden = working || !issue || typeof onReview !== "function";
    for (const control of [input, imagePath, sample, consent]) control.disabled = working;
    const actions = currentConsentActions();
    consentRow.hidden = !actions.length;
    consentText.textContent = actions.length ? `同意${actions.join("，并")}` : "";
    if (back) back.disabled = working;
    singleMode.disabled = directoryMode.disabled = working;
    batch.updateControls();
  }

  async function syncTarget() {
    const revision = ++tabRevision;
    const tab = await getTargetTab().catch(() => null);
    if (revision !== tabRevision) return;
    if (selectedTab?.id !== tab?.id || selectedTab?.url !== tab?.url) {
      consent.checked = false;
      batch.resetConsent();
    }
    selectedTab = tab;
    const shop = shopFor(tab?.url, flow);
    target.textContent = shop ? `卖家中心 · 当前店铺 ${shop}` : tab?.id && !tab.url
      ? "开始时由 Chrome 确认此站点的访问权限。"
      : "请打开 Shopee 卖家中心的「新增商品」页面。";
    if (listingLink) {
      const currentShop = shopFor(tab?.url, flow, { requireListing: false });
      const destination = new URL(currentShop ? flow.path : "/", flow.origin);
      if (currentShop) destination.searchParams.set("cnsc_shop_id", currentShop);
      listingLink.href = destination.href;
      listingLink.textContent = currentShop ? "打开当前店铺的新增商品页" : "打开 Shopee 卖家中心";
      listingLink.hidden = Boolean(shop || (tab?.id && !tab.url));
    }
    displayControls();
  }

  function useSample() {
    const product = { ...shopeeExampleInput };
    delete product.shopId;
    delete product.imagePath;
    const sampleShop = shopFor(selectedTab?.url, flow);
    input.value = JSON.stringify(sampleShop ? { shopId: sampleShop, ...product } : product, null, 2);
    imagePath.value = "";
    consent.checked = false;
    displayControls();
  }

  function resetProgress() {
    steps = new Map();
    currentStep = "";
    progress.replaceChildren();
    for (const [id, label] of STEPS) {
      const row = document.createElement("li");
      row.dataset.step = id;
      const title = document.createElement("span");
      title.textContent = label;
      const operation = document.createElement("span");
      operation.dataset.tool = "";
      row.append(title, operation);
      progress.append(row);
      steps.set(id, { row, operation });
    }
    progress.hidden = false;
  }

  function stepEvent({ step, tool }) {
    const item = steps.get(step);
    if (!item) return;
    if (currentStep && currentStep !== step) steps.get(currentStep).row.dataset.state = "done";
    currentStep = step;
    item.row.dataset.state = "running";
    item.operation.textContent = tool || "";
  }

  function settle(receipt, elapsed, tabId) {
    for (const id of Array.isArray(receipt.completed) ? receipt.completed : []) {
      const item = steps.get(id);
      if (item) item.row.dataset.state = "done";
    }
    const active = steps.get(receipt.step || currentStep);
    const took = duration(Number.isFinite(receipt.elapsedMs) ? receipt.elapsedMs : elapsed);
    if (receipt.status === "verified") {
      for (const item of steps.values()) item.row.dataset.state = "done";
      showStatus("verified", `已填写并核对 · ${took}`);
      showResult(receiptText(receipt));
      return;
    }
    if (receipt.status === "cancelled") {
      if (active) active.row.dataset.state = "blocked";
      showStatus("cancelled", `已停止 · ${took}`);
      return;
    }
    if (active) active.row.dataset.state = "blocked";
    const humanStep = STEP_LABELS.get(receipt.step || currentStep);
    const reason = REASONS.get(receipt.code);
    issue = { tabId, step: humanStep, code: receipt.code, details: detailsText(receipt.details) };
    showStatus("needs-review", `待处理 · ${[humanStep, reason].filter(Boolean).join(" · ") || "执行未完成"} · ${took}`);
    showResult([errorText(receipt), receiptText(receipt)].filter(Boolean).join("\n"));
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    void syncTarget().then(() => {
      if (!input.value.trim() && !local && !remote) useSample();
    });
    return true;
  }

  function showMode(directory) {
    singlePane.hidden = directory;
    batchPane.hidden = !directory;
    singleMode.setAttribute("aria-pressed", String(!directory));
    directoryMode.setAttribute("aria-pressed", String(directory));
    if (directory) void batch.previewSavedPath();
  }

  if (back && onBack) {
    back.hidden = false;
    back.addEventListener("click", () => {
      dialog.close();
      onBack();
    });
  }
  singleMode.addEventListener("click", () => showMode(false));
  directoryMode.addEventListener("click", () => showMode(true));
  sample.addEventListener("click", useSample);
  close.addEventListener("click", () => { if (!local && !batch.busy) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (local || batch.busy) event.preventDefault(); });
  const inputChanged = () => {
    consent.checked = false;
    displayControls();
  };
  input.addEventListener("input", inputChanged);
  imagePath.addEventListener("input", inputChanged);
  stop.addEventListener("click", () => {
    if (!local) return;
    local.abort();
    displayControls();
    showStatus("running", "正在停止，等待当前页面操作结束。");
  });

  review.addEventListener("click", async () => {
    const problem = issue;
    const tab = await getTargetTab().catch(() => null);
    if (!problem || problem.tabId !== tab?.id || !shopFor(tab.url, flow)) {
      showStatus("needs-review", "请返回发生异常的 Shopee 表单。");
      return;
    }
    dialog.close();
    onReview(problem);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (start.disabled) return;
    if (isAgentBusy?.()) {
      showStatus("needs-review", "PageLens Agent 正在执行其他任务。");
      return;
    }
    let data;
    try {
      data = JSON.parse(input.value);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    } catch {
      showStatus("needs-review", "商品参数需要是 JSON 对象。");
      return;
    }
    const uploadPath = selectedImage();
    const approvedPaths = new Set(imagePathsFor({ ...data, imagePath: uploadPath }));
    if (consentActions(data, uploadPath).length && !consent.checked) {
      showStatus("needs-review", "请确认本次上传图片或处理尺码表的授权。");
      consent.focus();
      return;
    }

    const originalTabId = selectedTab.id;
    const controller = new AbortController();
    local = controller;
    remote = null;
    issue = null;
    showResult();
    resetProgress();
    displayControls();
    showStatus("running", "正在核对当前 Shopee 标签页。");
    const began = performance.now();
    let receipt;
    try {
      const access = await ensureOptionalAccess({ url: flow.origin, tabId: originalTabId, userGesture: true, force: true });
      controller.signal.throwIfAborted();
      if (!access.granted && !access.required) {
        receipt = { status: "needs-review", code: "permission-denied", details: access.message };
        return;
      }
      const tab = await getTargetTab();
      const shopId = shopFor(tab?.url, flow);
      if (!shopId || tab.id !== originalTabId || (data.shopId && String(data.shopId) !== shopId)) {
        receipt = { status: "needs-review", code: "page-changed" };
        return;
      }
      selectedTab = tab;
      target.textContent = `卖家中心 · 当前店铺 ${shopId}`;
      const confirmUpload = ({ paths, tabId } = {}) => tabId === tab.id &&
        paths?.length === 1 && approvedPaths.has(paths[0]);
      const call = createPtcToolCaller({ tabId: tab.id, url: tab.url, signal: controller.signal, confirmUpload });
      const request = { ...data, shopId };
      if (uploadPath) request.imagePath = uploadPath;
      else delete request.imagePath;
      showStatus("running", "正在执行固定流程。");
      receipt = await runFlow({
        flowId: flow.id, tabId: tab.id, input: request, call,
        signal: controller.signal, onStep: stepEvent,
      });
    } catch (error) {
      receipt = controller.signal.aborted ? { status: "cancelled" } :
        { status: "needs-review", code: error?.code || "run-error", details: error?.message || String(error) };
    } finally {
      local = null;
      consent.checked = false;
      if (receipt) settle(receipt, performance.now() - began, originalTabId);
      displayControls();
    }
  });

  chrome.tabs.onActivated.addListener(() => { if (dialog.open) void syncTarget(); });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (dialog.open && tabId === selectedTab?.id && (change.url || change.status === "complete")) void syncTarget();
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chrome.runtime.id || message?.type !== "pl.flow.progress" ||
      message.source !== "gateway" || message.flowId !== flow.id || local || batch.busy) return false;
    remoteProgress = remoteProgress.then(async () => {
      if (local || batch.busy) return;
      if (remote?.runId !== message.runId) {
        if (message.status !== "running") return;
        const tab = await getTargetTab();
        if (!tab || tab.id !== message.tabId || !shopFor(tab.url, flow) || local || batch.busy) return;
        selectedTab = tab;
      }
      if (message.status === "running") {
        if (remote?.runId !== message.runId) {
          remote = { runId: message.runId, began: performance.now(), status: "running" };
          issue = null;
          resetProgress();
          showResult();
          showMode(false);
          open();
          showStatus("running", "正在执行外部发起的固定流程。");
        }
        stepEvent(message);
      } else if (remote?.runId === message.runId) {
        remote.status = message.status;
        settle(message, performance.now() - remote.began, message.tabId);
      }
      displayControls();
    }).catch(() => {});
    return false;
  });
  return open;
}
