import { matchesFlowTarget, runFlow } from "../../../../lib/flow/runtime.js";
import { createPtcToolCaller } from "./tool-adapter.js";

const READY =
  '.product-basic-info .edit-row :is(textarea,[contenteditable="true"]):not([disabled],[readonly])';
const TAB_READY_TIMEOUT = 18000;
const MAX_CONCURRENT = 2;

export function imagePathsFor(input) {
  const variants = Array.isArray(input?.variant?.options) ? input.variant.options : [input?.variant];
  return [...new Set([input?.imagePath, ...variants.map((item) => item?.imagePath)]
    .filter((path) => typeof path === "string" && path.trim()))];
}

async function waitForTab(tabs, tabId, flowId, shopId, signal) {
  const deadline = Date.now() + TAB_READY_TIMEOUT;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const tab = await tabs.get(tabId);
    if (tab.status === "complete" && tab.url && tab.url !== "about:blank") {
      if (matchesFlowTarget(flowId, tab.url, shopId)) return tab;
      throw new Error("标签没有停在当前店铺的新增商品页，请检查 Shopee 登录。");
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("Shopee 新增商品页加载超时。");
}

export async function runProductBatch({
  flow, shopId, sourceTab, products, uploadApproved, signal, onJob,
  prepareInput, completeChart, createAttributeAdvisor, tabs = chrome.tabs, replay = runFlow, createCall = createPtcToolCaller,
}) {
  const source = await tabs.get(sourceTab.id);
  if (source.id !== sourceTab.id || source.windowId !== sourceTab.windowId ||
      !matchesFlowTarget(flow.id, source.url, shopId)) {
    throw new Error("源标签或店铺已变化。");
  }
  const url = new URL(flow.path, flow.origin);
  url.searchParams.set("cnsc_shop_id", shopId);
  let next = 0;

  async function work(index) {
    const product = products[index];
    const { input } = product;
    let tabId = null;
    let receipt;
    try {
      signal.throwIfAborted();
      const approvedPaths = new Set(imagePathsFor(input));
      if ((approvedPaths.size || input.sizeChartImagePath || input.sizeChart != null) && !uploadApproved) {
        throw new Error("请先确认本次图片和尺码表的处理。");
      }
      if (input.shopId != null && String(input.shopId) !== shopId) {
        throw new Error("目录商品的店铺与当前店铺不一致。");
      }
      const needsChart = input.sizeChartImagePath && input.sizeChart == null;
      if (needsChart && !prepareInput) throw new Error("当前未能解析尺码图。");
      if (needsChart) onJob(index, { phase: "preparing" });
      const prepared = needsChart ? await prepareInput(product, signal) : input;
      signal.throwIfAborted();
      if (needsChart && prepared?.sizeChart == null) throw new Error("尺码图解析未返回数据。");
      onJob(index, { phase: "opening" });
      const created = await tabs.create({ windowId: source.windowId, url: url.href, active: false });
      if (!Number.isInteger(created?.id)) throw new Error("Chrome 没有返回已创建标签的编号。");
      tabId = created.id;
      onJob(index, { tabId });
      const tab = await waitForTab(tabs, tabId, flow.id, shopId, signal);
      const confirmUpload = ({ tabId: requestedTab, paths }) => uploadApproved &&
        requestedTab === tabId && paths?.length === 1 && approvedPaths.has(paths[0]);
      const call = createCall({
        tabId, url: tab.url, signal, confirmUpload,
        adviseAttributes: createAttributeAdvisor?.(product, signal),
        completeChart: prepared.sizeChart && uploadApproved && completeChart
          ? requirements => completeChart(product, requirements)
          : undefined,
      });
      const ready = await call("wait_for", { tabId, selector: READY, timeoutMs: 12000 });
      signal.throwIfAborted();
      if (ready?.ok !== true) throw new Error(ready?.error || "没有读到 Shopee 新增商品表单。");
      receipt = await replay({
        flowId: flow.id, tabId, input: {
          ...prepared, shopId, completeMissingSizeChart: Boolean(prepared.sizeChart && uploadApproved),
          completeMissingAttributes: Boolean(createAttributeAdvisor),
        }, signal, call,
        onStep: ({ step, tool }) => onJob(index, { phase: "running", step, tool }),
      });
    } catch (error) {
      receipt = signal.aborted
        ? { status: "cancelled" }
        : { status: "needs-review", code: "batch-product-error", details: error?.message || String(error) };
    }
    onJob(index, { phase: receipt.status, tabId, receipt });
  }

  await Promise.all(Array.from({ length: Math.min(products.length, MAX_CONCURRENT) }, async () => {
    while (next < products.length) {
      const index = next++;
      await work(index);
    }
  }));
}
