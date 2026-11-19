import { requireHostUrl } from "../../../../lib/optional-permissions.js";
import { $ } from "../../../../sidepanel/dom.js";
import { parseSheinProductJSON, productImagePaths, readSheinProductDirectory, readSheinProductImages } from "./product-directory.js";

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
    throw new Error("当前 Chrome 无法打开目录选择器，可以在此面板填写商品 JSON。");
  }
  return window.showDirectoryPicker({ id: "pagelens-shein-products", mode: "read" });
}

export function bindSheinListingPanel({
  getTargetTab, isAgentBusy, onBack, pickDirectory = pickSheinDirectory,
  authorize = requireHostUrl, openEditor, inspect, replay,
}) {
  const get = name => $(`shein-listing-${name}`);
  const dialog = get("dialog");
  const target = get("target");
  const status = get("status");
  const results = get("results");
  const product = get("product");
  const category = get("category");
  const upload = get("upload");
  const json = get("json");
  const stop = get("stop");
  const buttons = [get("open"), get("inspect"), get("run")];
  let targetTab;
  let products = [];
  let operation;
  let revision = 0;

  function report(message = "", state = "") {
    status.textContent = message;
    status.dataset.state = state;
  }

  function renderTarget() {
    const supported = isSheinTab(targetTab);
    target.textContent = supported ? "当前标签 · SHEIN 商家后台" : "请打开已登录的 SHEIN 商家后台。";
    get("link").hidden = supported;
    get("source").disabled = Boolean(operation);
    for (const button of buttons) button.disabled = Boolean(operation) || !supported;
    get("run").disabled ||= !products.length && !json.value.trim();
    stop.hidden = !operation;
  }

  function renderResults(lines = []) {
    const rows = lines.filter(line => typeof line === "string" && line.trim()).slice(0, 90);
    results.hidden = !rows.length;
    results.replaceChildren(...rows.map(line => Object.assign(document.createElement("li"), { textContent: line })));
  }

  const selectedProduct = () => products[Number(product.value)];

  function updateSelectedProduct() {
    const selected = selectedProduct();
    category.value = Array.isArray(selected?.input?.shein?.categoryPath) ? selected.input.shein.categoryPath.join(" > ") : "";
    get("upload-row").hidden = !selected || productImagePaths(selected.input).length === 0;
    upload.checked = false;
  }

  function selectedInput() {
    const directoryInput = selectedProduct()?.input ?? {};
    const supplement = json.value.trim() ? parseSheinProductJSON(json.value) : {};
    const combined = { ...directoryInput, ...supplement };
    for (const key of ["attributes", "shein"]) {
      if (directoryInput[key] && supplement[key] && typeof directoryInput[key] === "object" && typeof supplement[key] === "object") {
        combined[key] = { ...directoryInput[key], ...supplement[key] };
      }
    }
    if (typeof combined.title !== "string" || !combined.title.trim()) throw new Error("请选择商品目录，或在 JSON 中填写 title。");
    if (category.value.trim()) {
      const categoryPath = category.value.split(/[>›＞]/u).map(part => part.trim()).filter(Boolean);
      combined.categoryPath = categoryPath;
      combined.shein = { ...combined.shein, categoryPath };
    }
    return combined;
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
      if (dialog.open) renderTarget();
    }
  }

  async function withSeller(signal) {
    const tab = await getTargetTab();
    signal.throwIfAborted();
    targetTab = tab;
    if (!isSheinTab(tab)) throw new Error("当前标签已切换，请切回 SHEIN 商家后台。");
    const denied = await authorize(tab.url, { userGesture: true, tabId: tab.id });
    signal.throwIfAborted();
    if (denied) throw new Error(denied);
    return { tabId: tab.id, url: tab.url, signal };
  }

  get("pick").addEventListener("click", () => void run("正在读取商品目录…", async ({ signal, current }) => {
    const directory = await pickDirectory();
    if (!directory || !current()) return;
    const loaded = await readSheinProductDirectory(directory, { signal });
    if (!current()) return;
    products = loaded.products;
    product.replaceChildren(...products.map((entry, index) =>
      Object.assign(document.createElement("option"), { value: index, textContent: entry.title })));
    get("product-row").hidden = products.length < 2;
    const summary = get("directory-status");
    summary.hidden = !products.length;
    if (loaded.products.length) {
      summary.textContent = products.length === 1 ? products[0].title : `${loaded.name} · ${products.length} 件商品`;
      get("pick").textContent = "更换商品目录";
      json.value = "";
      report(loaded.issues.length ? "已导入可读取的商品。" : "");
    } else {
      get("pick").textContent = "选择商品目录";
      report("目录中没有可用的商品资料，请选择包含 product.json 的商品目录。", "needs-review");
    }
    updateSelectedProduct();
    renderResults(loaded.issues);
  }));
  json.addEventListener("input", renderTarget);
  product.addEventListener("change", updateSelectedProduct);

  get("open").addEventListener("click", () => void run("正在打开商品发布…", async ({ signal, current }) => {
    const outcome = await openEditor(await withSeller(signal));
    if (!current()) return;
    if (!outcome?.ok) return report(outcome?.message || "未能打开商品发布页。", "needs-review");
    report(outcome.message || "已打开商品发布页。", "verified");
  }));

  get("inspect").addEventListener("click", () => void run("正在读取当前表单…", async ({ signal, current }) => {
    const outcome = await inspect(await withSeller(signal));
    if (!current()) return;
    if (!outcome?.ok) return report(outcome?.message || "未能读取当前表单。", "needs-review");
    if (outcome.stage === "category" || Array.isArray(outcome.options) && outcome.options.some(Array.isArray)) {
      renderResults([
        ...(outcome.selectedPath?.length ? [`已选类目 · ${outcome.selectedPath.join(" › ")}`] : []),
        ...(outcome.options || []).map((options, index) => `第 ${index + 1} 级 · ${options.slice(0, 8).join("、")}${options.length > 8 ? `等 ${options.length} 项` : ""}`),
      ]);
      return report(outcome.message || "已读取类目。请填写完整路径，或直接在 SHEIN 选择。", "verified");
    }
    const fields = outcome.fields || [];
    renderResults(fields.map(field => `${field.label || field.key}${field.required ? "（必填）" : ""}`));
    report(outcome.message || `已识别 ${fields.length} 个表单字段。`, "verified");
  }));

  get("run").addEventListener("click", () => void run("正在核对商品资料…", async ({ signal, current }) => {
    const input = selectedInput();
    const uploadAllowed = upload.checked;
    upload.checked = false;
    const seller = await withSeller(signal);
    const selected = selectedProduct();
    const files = uploadAllowed && selected ? await readSheinProductImages(selected, { signal }) : { images: [], issues: [] };
    const outcome = await replay({ ...seller, input, images: files.images, onStep(progress) {
      if (current()) report(typeof progress === "string" ? progress : progress?.label, "running");
    } });
    if (!current()) return;
    const filled = (outcome?.items || []).filter(item => item?.label && ["filled", "verified", "unchanged"].includes(item.status));
    const issues = (outcome?.issues || []).map(issue => typeof issue === "string" ? issue :
      [issue?.label, issue?.message].filter(Boolean).join(" · "));
    renderResults([...files.issues, ...issues, ...filled.map(item => `已核对 · ${item.label}`)]);
    const state = outcome?.ok && !issues.length && !files.issues.length ? "verified" : "needs-review";
    report(outcome?.message || (state === "verified" ? `试填完成，已核对 ${filled.length} 项。` : `试填待核对，已核对 ${filled.length} 项。`), state);
  }));

  stop.addEventListener("click", () => {
    operation?.abort();
    report("操作已停止。");
  });
  function close() {
    revision++;
    operation?.abort();
    upload.checked = false;
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
