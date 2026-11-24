import { waitForTemu } from "../workflow-tab.js";
import { isTemuCategoryPage } from "./stage1.js";
import { isTemuDraftEditor, readTemuResumeCandidate } from "./tool-adapter.js";

export const TEMU_BATCH_LIMIT = 5;
const categoryPage = "https://agentseller.temu.com/goods/create/category";
const loadTimeout = 16000;

async function activateProductTab(tabs, tabId, windowId, signal, resume) {
  const accepts = resume ? href => href === resume.href : isTemuCategoryPage;
  const before = await tabs.get(tabId);
  signal?.throwIfAborted();
  if (before?.id !== tabId || before.windowId !== windowId ||
      !accepts(before.url) && !accepts(before.pendingUrl)) {
    throw new Error("该商品标签已离开原 Temu 页面。");
  }
  await tabs.update(tabId, { active: true });
  const deadline = Date.now() + loadTimeout;
  do {
    signal?.throwIfAborted();
    const tab = await tabs.get(tabId);
    signal?.throwIfAborted();
    if (tab?.id !== tabId || tab.windowId !== windowId || !tab.active ||
        tab.pendingUrl && !accepts(tab.pendingUrl)) {
      throw new Error("该商品标签已切换，请检查 Temu 登录状态。");
    }
    if (tab.status === "complete" && !tab.pendingUrl) {
      if (accepts(tab.url)) return tab;
      throw new Error("未进入预期的 Temu 商品页，请检查登录状态。");
    }
    await waitForTemu(signal, 160);
  } while (Date.now() < deadline);
  throw new Error("Temu 商品页加载超时。");
}

/** Finds a unique, incomplete editor for each title in the current window. */
export async function findTemuBatchResumeTabs(products, windowId, signal, api = chrome) {
  const titleKey = value => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const byTitle = new Map();
  for (const tab of await api.tabs.query({ windowId, url: "https://agentseller.temu.com/goods/edit*" })) {
    signal?.throwIfAborted();
    if (tab.pendingUrl || !isTemuDraftEditor(tab.url)) continue;
    const candidate = await readTemuResumeCandidate({ tabId: tab.id, href: tab.url, api, signal }).catch(() => null);
    if (!candidate?.ok) continue;
    const title = titleKey(candidate.title);
    byTitle.set(title, byTitle.has(title) ? null : { tabId: tab.id, href: tab.url, documentId: candidate.documentId });
  }
  signal?.throwIfAborted();
  return products.map(product => byTitle.get(titleKey(product.input.title)) || null);
}

/**
 * Opens one tab per product and retains every opened tab for review.
 * A single foreground replay at a time keeps seller-page controls and shared
 * material dialogs isolated across products.
 */
export async function runTemuBatchPrefill({
  products, sourceTab, signal, tabs = chrome.tabs, runProduct, onJob = () => {}, resumeTabs,
}) {
  if (!Array.isArray(products) || !products.length || products.length > TEMU_BATCH_LIMIT) {
    throw new Error(`一次可批量填写 1–${TEMU_BATCH_LIMIT} 件商品。`);
  }
  if (!Number.isInteger(sourceTab?.id) || !Number.isInteger(sourceTab.windowId) || typeof runProduct !== "function") {
    throw new Error("没有找到本次试填的 Chrome 窗口。");
  }
  signal?.throwIfAborted();
  const source = await tabs.get(sourceTab.id);
  if (source?.id !== sourceTab.id || source.windowId !== sourceTab.windowId) {
    throw new Error("本次试填的 Chrome 窗口已变化。");
  }
  if (resumeTabs) {
    const matched = resumeTabs.filter(Boolean);
    if (resumeTabs.length !== products.length || !matched.length ||
        matched.some(tab => !Number.isInteger(tab.tabId) || !isTemuDraftEditor(tab.href) || !tab.documentId) ||
        new Set(matched.map(tab => tab.tabId)).size !== matched.length ||
        new Set(matched.map(tab => new URL(tab.href).searchParams.get("productDraftId"))).size !== matched.length) {
      throw new Error("未找到和目录唯一匹配、尚未填写规格或上传图片的 Temu 商品标签。");
    }
  }

  const jobs = products.map(() => ({ status: "queued", tabId: null }));
  const ownedTabIds = new Set([source.id]);
  const update = (index, patch) => onJob(index, jobs[index] = { ...jobs[index], ...patch });
  const markError = (index, error) => signal?.aborted
    ? update(index, { status: "cancelled", message: "已停止。" })
    : update(index, { status: "needs-review", message: error?.message || "试填未完成，请查看商品标签。" });

  for (const index of products.keys()) {
    if (signal?.aborted) break;
    if (resumeTabs) {
      const existing = resumeTabs[index];
      if (existing) update(index, { status: "queued", tabId: existing.tabId });
      else markError(index, new Error("未找到唯一匹配、可安全续填的商品标签。"));
      continue;
    }
    update(index, { status: "opening" });
    try {
      const tab = await tabs.create({ url: categoryPage, windowId: source.windowId, active: false });
      if (!Number.isInteger(tab?.id) || ownedTabIds.has(tab.id)) {
        throw new Error("Chrome 没有返回独立的商品标签。");
      }
      ownedTabIds.add(tab.id);
      update(index, { status: "queued", tabId: tab.id });
    } catch (error) {
      markError(index, error);
    }
  }

  for (const [index, product] of products.entries()) {
    const { status, tabId } = jobs[index];
    if (status !== "queued") continue;
    try {
      signal?.throwIfAborted();
      const resume = resumeTabs?.[index];
      const tab = await activateProductTab(tabs, tabId, source.windowId, signal, resume);
      update(index, { status: "running", message: "正在填写 Temu 商品表单…" });
      const receipt = await runProduct(product, {
        tab, index, signal, resume, onStep: ({ label }) => update(index, { message: label }),
      });
      if (!["ready-for-review", "needs-review", "cancelled"].includes(receipt?.status)) {
        throw new Error("未取得此商品的试填结果。");
      }
      update(index, {
        status: receipt.status === "ready-for-review" ? "completed" : receipt.status, receipt,
        message: receipt.status === "cancelled" ? "已停止。" :
          receipt.status === "needs-review" ? "请查看待核对项。" : "试填完成，可在商品标签核对。",
      });
    } catch (error) {
      markError(index, error);
    }
  }
  return jobs;
}
