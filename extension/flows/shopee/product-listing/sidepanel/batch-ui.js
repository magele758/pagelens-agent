import { matchesFlowTarget } from "../../../../lib/flow/runtime.js";
import { ensureOptionalAccess } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { imagePathsFor, runProductBatch } from "./batch-run.js";
import { chooseShopeeProductDirectory, completeDirectorySizeChartInput, directoryAttributeAdvice, loadProductDirectory, prepareSizeChartInput } from "./product-directory.js";

const STATUS = new Map([
  ["pending", "待执行"],
  ["preparing", "正在解析尺码图"],
  ["opening", "正在打开表单"],
  ["running", "正在填写"],
  ["verified", "已填写并核对"],
  ["needs-review", "待处理"],
  ["cancelled", "已停止"],
]);

function newButton(text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary mini";
  button.textContent = text;
  return button;
}

export function bindPtcBatch({
  flow, getTarget, isBlocked, onChange, onReview, stepLabel, errorText,
  chooseDirectory = chooseShopeeProductDirectory, startBatch = runProductBatch,
}) {
  const form = $("ptc-batch-form");
  const scan = $("ptc-load-directory");
  const manualDirectory = $("ptc-manual-directory");
  const manualLoad = $("ptc-load-manual-directory");
  const start = $("ptc-batch-start");
  const stop = $("ptc-batch-stop");
  const consent = $("ptc-batch-upload-consent");
  const consentRow = $("ptc-batch-consent-row");
  const consentText = $("ptc-batch-consent-text");
  const ai = $("ptc-batch-ai-consent");
  const aiRow = $("ptc-batch-ai-row");
  const status = $("ptc-batch-status");
  const importIssues = $("ptc-batch-import-issues");
  const items = $("ptc-batch-jobs");
  let products = [];
  let jobs = [];
  let selectedRoot = "";
  let reading = false;
  let run = null;
  let lastShop = "";

  function setStatus(kind, text) {
    status.dataset.state = kind;
    status.textContent = text;
  }

  function consentActions() {
    const hasChart = products.some(({ input }) => input.sizeChart != null || input.sizeChartImagePath);
    const hasChartWithCover = products.some(({ input }) => (input.sizeChart != null || input.sizeChartImagePath) && input.imagePath);
    return [
      products.some(({ input }) => imagePathsFor(input).length) && "将下方商品的主图、详情图和 SKU 图上传到当前 Shopee 店铺",
      products.some(({ input }) => input.sizeChartImagePath && input.sizeChart == null) && "用已配置的识图模型解析尺码图",
      hasChart && (hasChartWithCover
        ? "在需估算缺少的测量值时，将该商品主图发给已配置的识图模型"
        : "在需要时由模型估算缺少的必填尺码值"),
      hasChart && "为当前 Shopee 店铺选择或创建尺码表",
    ].filter(Boolean);
  }

  function updateControls() {
    const busy = Boolean(reading || run);
    const { tab, shopId } = getTarget();
    const actions = consentActions();
    scan.disabled = busy || isBlocked();
    manualLoad.disabled = scan.disabled || !manualDirectory.value.trim();
    manualDirectory.disabled = busy;
    start.disabled = busy || isBlocked() || !selectedRoot || !products.length || !tab?.id ||
      Boolean(tab.url && !shopId) ||
      actions.length > 0 && !consent.checked;
    consent.disabled = busy;
    consentRow.hidden = !selectedRoot || !actions.length;
    consentText.textContent = actions.length ? `同意${actions.join("，并")}` : "";
    ai.disabled = busy;
    aiRow.hidden = !selectedRoot;
    stop.hidden = !run;
    stop.disabled = Boolean(run?.signal.aborted);
  }

  function clearPreview() {
    products = [];
    jobs = [];
    selectedRoot = "";
    lastShop = "";
    consent.checked = false;
    ai.checked = false;
    importIssues.textContent = "";
    importIssues.hidden = true;
    items.replaceChildren();
    items.hidden = true;
  }

  function paintJob(job, showLinks = false) {
    job.node.dataset.state = job.phase;
    const label = STATUS.get(job.phase) || "";
    job.progress.textContent = [label, !job.receipt && stepLabel(job.step)].filter(Boolean).join(" · ");
    job.details.textContent = job.receipt?.status === "needs-review" ? errorText(job.receipt) : "";
    job.details.hidden = !job.details.textContent;
    job.inspect.hidden = !showLinks || !job.tabId;
    job.review.hidden = !showLinks || !job.tabId || !onReview || job.phase !== "needs-review";
  }

  function addJob({ title }) {
    const row = document.createElement("li");
    row.className = "ptc-batch-job";
    const name = document.createElement("strong");
    name.textContent = title;
    const progress = document.createElement("p");
    progress.className = "ptc-batch-progress";
    const details = document.createElement("p");
    details.className = "ptc-batch-details";
    const actions = document.createElement("div");
    actions.className = "ptc-actions";
    const inspect = newButton("查看表单");
    const review = newButton("检查异常");
    actions.append(inspect, review);
    row.append(name, progress, details, actions);
    const job = { node: row, progress, details, inspect, review, phase: "pending", tabId: null };
    async function showTab(askAgent) {
      try {
        const tab = await chrome.tabs.get(job.tabId);
        if (!matchesFlowTarget(flow.id, tab?.url, lastShop)) {
          setStatus("needs-review", "该标签已离开本次任务的 Shopee 表单。");
          return;
        }
        await chrome.tabs.update(job.tabId, { active: true });
        if (askAgent) onReview({
          tabId: job.tabId, step: stepLabel(job.receipt?.step || job.step),
          code: job.receipt?.code, details: errorText(job.receipt),
        });
      } catch {
        setStatus("needs-review", "这个商品的 Shopee 标签已关闭。");
      }
    }
    inspect.addEventListener("click", () => { void showTab(false); });
    review.addEventListener("click", () => { void showTab(true); });
    paintJob(job);
    items.append(row);
    return job;
  }

  async function importDirectory(load, message) {
    if (reading || run || isBlocked()) return;
    reading = true;
    setStatus("running", message);
    onChange();
    try {
      const loaded = await load();
      if (!loaded) {
        setStatus("idle", "");
        return;
      }
      clearPreview();
      products = loaded.products || [];
      const issues = Array.isArray(loaded.issues) ? loaded.issues : [];
      if (issues.length) {
        importIssues.textContent = issues.map((issue) => typeof issue === "string" ? issue :
          [issue.folder, issue.message || issue.error].filter(Boolean).join(" · ")).join("\n").replaceAll("product.json", "商品资料文件");
        importIssues.hidden = !importIssues.textContent;
      }
      if (!products.length) {
        setStatus("needs-review", "没有可读取的商品。请选择 PageLens 导出的商品目录。");
        return;
      }
      selectedRoot = loaded.root;
      jobs = products.map(addJob);
      items.hidden = false;
      scan.textContent = "更换商品目录";
      setStatus("ready", `已读入 ${products.length} 个商品${issues.length ? `，另有 ${issues.length} 个目录待处理` : ""}。`);
    } catch (error) {
      setStatus("needs-review", (error?.message || String(error)).replaceAll("product.json", "商品资料文件"));
    } finally {
      reading = false;
      onChange();
    }
  }
  scan.addEventListener("click", () => void importDirectory(chooseDirectory, "正在选择商品目录…"));
  manualDirectory.addEventListener("input", updateControls);
  manualDirectory.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    manualLoad.click();
  });
  manualLoad.addEventListener("click", () => {
    if (!manualLoad.disabled) void importDirectory(() => loadProductDirectory(manualDirectory.value), "正在读取商品目录…");
  });

  consent.addEventListener("change", updateControls);
  stop.addEventListener("click", () => {
    if (!run) return;
    run.abort();
    setStatus("running", "正在停止批量任务。");
    updateControls();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (start.disabled) return;
    const { tab: sourceTab, shopId: originalShop } = getTarget();
    const uploadApproved = consent.checked;
    const modelApproved = ai.checked;
    const root = selectedRoot;
    if (!sourceTab || consentActions().length && !uploadApproved) return;
    const controller = new AbortController();
    run = controller;
    lastShop = "";
    for (const job of jobs) {
      Object.assign(job, { phase: "pending", tabId: null, receipt: null, step: "", tool: "" });
      paintJob(job);
    }
    setStatus("running", `正在填写 ${products.length} 个商品…`);
    onChange();
    try {
      const access = await ensureOptionalAccess({ url: flow.origin, tabId: sourceTab.id, userGesture: true, force: true });
      controller.signal.throwIfAborted();
      if (!access.granted && !access.required) throw new Error(access.message || "Chrome 未授予此站点访问权限。");
      const [current] = await chrome.tabs.query({ active: true, windowId: sourceTab.windowId });
      if (current?.id !== sourceTab.id || !matchesFlowTarget(flow.id, current?.url, originalShop || undefined)) {
        throw new Error("当前标签或店铺已变化，请返回 Shopee 新增商品页后重试。");
      }
      const shopId = new URL(current.url).searchParams.get("cnsc_shop_id");
      lastShop = shopId;
      await startBatch({
        flow, shopId, sourceTab, products, uploadApproved, signal: controller.signal,
        prepareInput: (product, signal) => prepareSizeChartInput(product, { root, signal }),
        completeChart: (product, requirements) => completeDirectorySizeChartInput(product, { ...requirements, root }),
        createAttributeAdvisor: modelApproved ? (product, signal) => directoryAttributeAdvice(product, { root, signal }) : undefined,
        onJob(index, event) {
          const job = jobs[index];
          Object.assign(job, event);
          if (event.receipt) job.tool = "";
          paintJob(job);
        },
      });
      const done = jobs.filter((job) => job.phase === "verified").length;
      const blocked = jobs.filter((job) => job.phase === "needs-review").length;
      const stopped = jobs.filter((job) => job.phase === "cancelled").length;
      const summary = [
        `已填写并核对 ${done}/${jobs.length}`, blocked ? `待处理 ${blocked}` : "",
        stopped ? `已停止 ${stopped}` : "",
      ].filter(Boolean).join(" · ");
      setStatus(blocked ? "needs-review" : stopped ? "cancelled" : "verified", summary);
    } catch (error) {
      setStatus(controller.signal.aborted ? "cancelled" : "needs-review",
        controller.signal.aborted ? "已停止。" : error?.message || String(error));
    } finally {
      run = null;
      consent.checked = false;
      ai.checked = false;
      for (const job of jobs) paintJob(job, true);
      onChange();
    }
  });

  return {
    get busy() { return Boolean(run || reading); },
    resetConsent: () => { consent.checked = ai.checked = false; },
    updateControls,
  };
}
