import { requireHostUrl } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { productImagePaths, readSheinProductDirectory, readSheinProductImages } from "./product-directory.js";

function isSheinTab(tab) {
  try {
    const url = new URL(tab?.url);
    return Number.isInteger(tab.id) && url.origin === "https://sellerhub.shein.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function pickSheinDirectory() {
  if (typeof window.showDirectoryPicker !== "function") {
    throw new Error("当前 Chrome 无法打开目录选择器，可以直接输入商品描述。");
  }
  return window.showDirectoryPicker({ id: "pagelens-shein-products", mode: "read" });
}

async function currentTabAccess(tab) {
  try {
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: () => location.href });
    return result?.result === tab.url;
  } catch {
    return false;
  }
}

export function bindSheinListingPanel({
  getTargetTab, isAgentBusy, onBack, pickDirectory = pickSheinDirectory,
  authorize = requireHostUrl, probeAccess = currentTabAccess, replay,
}) {
  const get = name => $(`shein-listing-${name}`);
  const dialog = get("dialog");
  const target = get("target");
  const status = get("status");
  const results = get("results");
  const product = get("product");
  const category = get("category");
  const upload = get("upload");
  const assist = get("ai");
  const description = get("description");
  const notes = () => description.value.trim().slice(0, 1800);
  const stop = get("stop");
  let targetTab;
  let products = [];
  let operation;
  let revision = 0;
  const customerText = value => typeof value === "string" ? value.replaceAll("试填", "填写") : "";

  function report(message = "", state = "") {
    status.textContent = customerText(message);
    status.dataset.state = state;
  }

  function renderTarget() {
    const supported = isSheinTab(targetTab);
    target.hidden = supported || !targetTab;
    target.textContent = "切回已登录的 SHEIN 商家后台后即可开始上品。";
    get("link").hidden = supported;
    get("source").disabled = Boolean(operation);
    get("run").disabled = Boolean(operation) || !supported || (!selectedProduct() && !notes());
    stop.hidden = !operation;
    stop.disabled = Boolean(operation?.signal.aborted);
  }

  function renderResults(lines = []) {
    const rows = [...new Set(lines.map(customerText).filter(line => line.trim()))].slice(0, 90);
    results.hidden = !rows.length;
    results.replaceChildren(...rows.map(line => Object.assign(document.createElement("li"), { textContent: line })));
  }

  const selectedProduct = () => products[Number(product.value)];

  function renderCategory(path) {
    const parts = Array.isArray(path) ? path : typeof path === "string" ? path.split(/[>›＞]/u) : [];
    const trail = parts.filter(part => typeof part === "string" && part.trim()).map(part => part.trim()).join(" › ");
    category.hidden = !trail;
    category.textContent = trail ? `类目 ${trail}` : "";
  }

  function updateSelectedProduct() {
    const input = selectedProduct()?.input;
    renderCategory(input?.shein?.categoryPath ?? input?.categoryPath);
    upload.checked = false;
    assist.checked = false;
    get("upload-row").hidden = !input || productImagePaths(input).length === 0;
    renderTarget();
  }

  function buildInput(selected, operatorNotes) {
    if (selected?.input) return operatorNotes ? { ...selected.input, operatorNotes } : selected.input;
    if (!operatorNotes) throw new Error("请选择商品目录或输入商品描述。");
    const lead = operatorNotes.split(/[。\r\n]/u, 1)[0].trim();
    return { title: (lead || operatorNotes).slice(0, 160), description: operatorNotes, operatorNotes };
  }

  async function run(label, action) {
    if (operation || isAgentBusy?.()) return report("请等当前任务完成。", "needs-review");
    const controller = new AbortController();
    const { signal } = controller;
    const current = () => dialog.open && !signal.aborted;
    operation = controller;
    renderTarget();
    renderResults();
    report(label, "running");
    try {
      await action({ signal, current });
    } catch (error) {
      if (current()) report(error.name === "AbortError" ? "" : error.message || "操作失败，请重试。",
        error.name === "AbortError" ? "" : "needs-review");
    } finally {
      operation = undefined;
      if (dialog.open) {
        if (signal.aborted) report("操作已停止。");
        renderTarget();
      }
    }
  }

  async function withSeller(signal) {
    const tab = await getTargetTab();
    signal.throwIfAborted();
    targetTab = tab;
    if (!isSheinTab(tab)) throw new Error("当前标签已切换，请切回 SHEIN 商家后台。");
    if (await probeAccess(tab)) {
      signal.throwIfAborted();
      return { tabId: tab.id, url: tab.url, signal, useActiveTab: true };
    }
    const denied = await authorize(tab.url, { userGesture: true, tabId: tab.id });
    signal.throwIfAborted();
    if (denied) throw new Error(denied);
    return { tabId: tab.id, url: tab.url, signal };
  }

  get("pick").addEventListener("click", () => void run("正在读取商品目录…", async ({ signal, current }) => {
    const directory = await pickDirectory();
    if (!current()) return;
    if (!directory) return report();
    const loaded = await readSheinProductDirectory(directory, { signal });
    if (!current()) return;
    const hadSelection = Boolean(selectedProduct());
    products = loaded.products;
    product.replaceChildren(...products.map((entry, index) =>
      Object.assign(document.createElement("option"), { value: index, textContent: entry.title })));
    get("product-row").hidden = products.length < 2;
    const summary = get("directory-status");
    summary.hidden = !products.length;
    if (loaded.products.length) {
      summary.textContent = products.length === 1 ? products[0].title : `${loaded.name} · ${products.length} 件商品`;
      get("pick").textContent = "更换商品目录";
      if (hadSelection) description.value = "";
      report(loaded.issues.length ? "已导入可读取的商品。" : "");
    } else {
      get("pick").textContent = "选择商品目录";
      report("目录中没有可读取的商品资料。请选择商品目录，或输入商品描述。", "needs-review");
    }
    updateSelectedProduct();
    renderResults(loaded.issues);
  }));
  description.addEventListener("input", renderTarget);
  product.addEventListener("change", () => {
    description.value = "";
    report();
    renderResults();
    updateSelectedProduct();
  });

  get("run").addEventListener("click", () => void run("正在核对商品资料…", async ({ signal, current }) => {
    const selected = selectedProduct();
    const input = buildInput(selected, notes());
    const uploadAllowed = upload.checked;
    const allowAI = assist.checked;
    upload.checked = false;
    const seller = await withSeller(signal);
    const files = selected && (uploadAllowed || allowAI) ? await readSheinProductImages(selected, { signal }) : { images: [], issues: [] };
    const outcome = await replay({ ...seller, input, images: uploadAllowed ? files.images : [], allowAI,
      referenceImages: allowAI ? files.images : [], onStep(progress) {
        if (!current()) return;
        if (progress?.categoryPath) renderCategory(progress.categoryPath);
        report(typeof progress === "string" ? progress : progress?.label, "running");
      },
    });
    if (!current()) return;
    if (outcome?.categoryPath) renderCategory(outcome.categoryPath);
    const issues = (outcome?.issues || []).map(issue => typeof issue === "string" ? issue :
      [issue?.label, issue?.message].filter(Boolean).join(" · "));
    renderResults([...files.issues, ...issues]);
    const state = outcome?.ok && !issues.length && !files.issues.length ? "verified" : "needs-review";
    report(state === "verified" ? "商品资料已填写，请在 SHEIN 核对并发布。" :
      outcome?.message || "还有需要处理的问题，请查看下方提示。", state);
  }));

  stop.addEventListener("click", () => {
    operation?.abort();
    report("正在停止…", "running");
    renderTarget();
  });
  function close() {
    revision++;
    operation?.abort();
    upload.checked = false;
    assist.checked = false;
    if (dialog.open) dialog.close();
  }
  get("close").addEventListener("click", close);
  get("back").addEventListener("click", () => { close(); onBack?.(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });

  return async function openSheinListing() {
    const opening = ++revision;
    targetTab = undefined;
    report();
    renderResults();
    renderTarget();
    if (!dialog.open) dialog.showModal();
    try {
      const tab = await getTargetTab();
      if (opening === revision && dialog.open) {
        targetTab = tab;
        renderTarget();
      }
    } catch (error) {
      if (opening === revision && dialog.open) report(error.message || "暂时无法读取当前标签。", "needs-review");
    }
    return true;
  };
}
