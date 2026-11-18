import { NATIVE_HOST_NAME } from "../../lib/native-host.js";
import { isMxSellerManageReturn, runMxDraftJob, runMxDraftRead } from "./tiktok-mx-editor.mjs";

const tools = new Set(["open_tab", "list_tabs", "close_tab", "run_js", "reload_tab", "activate_tab",
  "wait_for", "upload_file", "trusted_type", "press_keys", "navigate_tab"]);
const seller = "https://seller.tiktokshopglobalselling.com";
const productId = /^\d{12,22}$/;
export function japaneseSourceId(value) {
  const page = new URL(value);
  const match = page.pathname.match(/^\/jp\/pdp\/(?:[^/]+\/)?(\d{12,22})\/?$/);
  if (page.origin !== "https://shop.tiktok.com" || page.username || page.password || !match)
    throw Error("Expected a Japanese TikTok Shop product link");
  return match[1];
}

export function allowedDraftUrl(value, sourceId) {
  const u = new URL(value);
  if (u.origin === "https://shop.tiktok.com") return japaneseSourceId(u.href) === sourceId;
  return u.origin === seller && u.searchParams.get("shop_region") === "MX" &&
    (/^\/product\/(create|edit-draft\/\d+)$/.test(u.pathname) || (u.pathname === "/product/manage" && u.searchParams.get("tab") === "draft"));
}

export function repairDraftRequest({ sourceId, draftId, repair, queries }) {
  if (![sourceId, draftId].every(id => typeof id === "string" && productId.test(id)))
    throw Error("Expected numeric source and draft IDs for TikTok draft repair");
  if (repair !== "attributes" && repair !== "category") throw Error("Expected repair mode attributes or category");
  if (queries !== undefined && (repair !== "category" || !Array.isArray(queries) || !queries.length ||
      queries.length > 6 || !queries.every(query => typeof query === "string" && query.trim() && query.length <= 35)))
    throw Error("Category queries must contain one to six nonempty search terms of at most 35 characters");
  return { sourceId, draftId, repair, ...(queries !== undefined && { queries }) };
}

export function createDraftTransport(sourceId, call, tabUrl, { draftId } = {}) {
  if (draftId !== undefined && (typeof draftId !== "string" || !productId.test(draftId))) throw Error("Invalid repair draft ID");
  const repairUrl = draftId && `${seller}/product/edit-draft/${draftId}?shop_region=MX`;
  const allowedDestination = value => repairUrl ? value === repairUrl : allowedDraftUrl(value, sourceId);
  const owned = new Set();
  async function dispatch(tool, args) {
    if (!tools.has(tool) || (repairUrl && tool === "upload_file")) throw Error("Unexpected draft tool " + tool);
    if (tool === "navigate_tab" && !allowedDestination(args.url)) throw Error("Unexpected draft destination");
    if (tool === "open_tab") {
      const background = args.backgroundUrls || [];
      if ((repairUrl && background.length) || ![args.url, ...background].every(allowedDestination) ||
          (args.groupWithTab != null && !owned.has(args.groupWithTab))) throw Error("Unexpected draft destination");
    } else if (tool !== "list_tabs" && !owned.has(args.tabId)) throw Error("Tab outside draft task");
    else if (tool !== "list_tabs" && (repairUrl || tool !== "close_tab")) {
      const currentUrl = await tabUrl(args.tabId);
      const reopening = tool === "navigate_tab" && isMxSellerManageReturn(currentUrl) &&
        /^\/product\/edit-draft\/\d+$/.test(new URL(args.url).pathname);
      const cleanup = repairUrl && tool === "close_tab" && isMxSellerManageReturn(currentUrl);
      if (!reopening && !cleanup && !allowedDestination(currentUrl)) throw Error("Task tab navigated outside draft workflow");
    }
    const reply = await call(tool, args);
    if (!reply.ok) throw Error(reply.error?.message || JSON.stringify(reply.error));
    if (tool === "open_tab") for (const id of [reply.result.tabId, ...(reply.result.backgroundTabIds || [])]) owned.add(id);
    if (tool === "list_tabs") return { ...reply, result: reply.result.filter(t => owned.has(t.id) &&
      (!repairUrl || t.url === repairUrl || isMxSellerManageReturn(t.url))) };
    if (tool === "close_tab") owned.delete(args.tabId);
    return reply;
  }
  return async job => {
    if (job.action === "bridge_call") return (await dispatch(job.request.tool, job.request.args)).result;
    if (!owned.has(job.tabId)) throw Error("Unowned editor");
    if (repairUrl && (job.action !== "read_mx_draft" || job.url !== repairUrl)) throw Error("Unexpected repair action or draft URL");
    if (job.action === "fill_mx_draft") return runMxDraftJob(job, dispatch, tabUrl);
    if (["read_mx_draft", "refresh_mx_draft_list"].includes(job.action)) return runMxDraftRead(job, dispatch, tabUrl);
    throw Error("Unexpected draft action");
  };
}

export async function runNativeDraft(job, bridge) {
  const { rate } = job;
  const repairing = String(job.action || "").trim() === "ptc_repair_mx_draft";
  const repair = repairing ? repairDraftRequest(job) : null;
  const sourceId = repair?.sourceId ?? (job.sourceUrl ? japaneseSourceId(job.sourceUrl) : job.sourceId);
  if (job.sourceId != null && job.sourceId !== sourceId) throw Error("Conflicting source identities");
  if (repair && job.token != null) throw Error("TikTok draft repair does not accept a token");
  if (!repair && (job.token != null || typeof sourceId !== "string" || !productId.test(sourceId) || !Number.isFinite(rate) || rate <= 0))
    throw Error("Expected a local draft request with a source ID and conversion rate");
  const opening = repair ? { type: "mx.repair", ...repair } : { type: "mx.create", sourceId, rate };
  let step = 0;
  const execute = createDraftTransport(sourceId, (tool, args) => bridge.call({ id: job.id + "." + ++step, tool, args }),
    async id => { const t = await chrome.tabs.get(id); return t.url || t.pendingUrl; }, { draftId: repair?.draftId });
  const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(Error("Native draft timed out; reconcile its receipt before retrying")), 300000);
      port.onDisconnect.addListener(() => reject(Error(chrome.runtime.lastError?.message || "Draft host disconnected")));
      port.onMessage.addListener(msg => {
        if (msg.type === "mx.done") {
          if (msg.ok) resolve(msg.result);
          else reject(Error(msg.error));
        } else if (msg.type === "mx.tool") {
          execute(msg.job).then(result => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: true, result }),
            e => port.postMessage({ type: "mx.tool_result", seq: msg.seq, ok: false, error: e.message })).catch(() => {});
        }
      });
      port.postMessage(opening);
    });
  } finally { clearTimeout(timer); port.disconnect(); }
}
