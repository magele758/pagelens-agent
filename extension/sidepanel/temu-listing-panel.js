import { loadTemuProductDirectory, normalizeTemuListingInput, suggestTemuFields } from "../flows/temu/product-listing/input.js";
import { replayTemuListing } from "../flows/temu/product-listing/listing.flow.mjs";
import { isTemuCategoryPage } from "../flows/temu/product-listing/stage1.js";
import { createTemuListingToolCaller } from "../flows/temu/product-listing/tool-adapter.js";
import { searchTemuCategories, loadTemuOrigins } from "../flows/temu/product-listing/taxonomy.js";
import { requireHostUrl, requireOptionalFeature } from "../lib/optional-permissions.js";

const startUrl = "https://agentseller.temu.com/goods/create/category";

export function bindTemuListingPanel({ getTargetTab, getSettings, isAgentBusy, onBack }) {
  const dialog = document.createElement("dialog");
  dialog.className = "temu-listing-dialog";
  dialog.setAttribute("aria-labelledby", "temu-listing-title");
  dialog.innerHTML = `
    <header><h2 id="temu-listing-title">Temu 商品上架</h2><button type="button" data-action="close">关闭</button></header>
    <p id="temu-listing-page" role="status"></p>
    <a href="${startUrl}" target="_blank" rel="noopener">打开 Temu 新建商品页</a>
    <div class="temu-listing-source">
      <label for="temu-products-path">商品目录</label>
      <div class="temu-listing-row">
        <input id="temu-products-path" type="text" placeholder="商品或批量目录的绝对路径" />
        <button type="button" data-action="load">读取目录</button>
      </div>
      <select id="temu-product-item" aria-label="目录中的商品" hidden></select>
      <details>
        <summary>使用或补充 JSON</summary>
        <textarea id="temu-product-json" rows="4" aria-label="商品 JSON"
          placeholder='{"title":"商品名称","temu":{"origin":{"country":"产地"},"handlingTime":"发货时效","freightTemplate":"运费模板"}}'></textarea>
        <p>选择目录商品后，JSON 可补充 Temu 字段。图片从已读取的目录选取。</p>
      </details>
      <label for="temu-listing-site">经营站点</label>
      <input id="temu-listing-site" type="text" placeholder="如 美国站" />
      <label for="temu-listing-category">商品类目</label>
      <input id="temu-listing-category" type="text" list="temu-category-options" placeholder="搜索，或输入以 &gt; 分隔的完整类目" autocomplete="off" />
      <datalist id="temu-category-options"></datalist>
      <label for="temu-listing-origin">商品产地</label>
      <input id="temu-listing-origin" type="text" list="temu-origin-options" placeholder="按实填写" />
      <datalist id="temu-origin-options"></datalist>
      <label for="temu-listing-region">产地省份或地区</label>
      <input id="temu-listing-region" type="text" list="temu-region-options" placeholder="按需选择省份或地区" />
      <datalist id="temu-region-options"></datalist>
      <label class="temu-listing-check"><input id="temu-listing-ai" type="checkbox" /> 允许将商品资料和表单候选发给已配置的 AI 模型</label>
      <label class="temu-listing-check"><input id="temu-listing-upload" type="checkbox" /> 上传这件商品目录中的图片</label>
    </div>
    <p>进入第二步时 Temu 会分配新草稿。试填完成后可在商品页核对。</p>
    <div id="temu-listing-message" role="status" aria-live="polite"></div>
    <ul id="temu-listing-issues"></ul>
    <footer><button type="button" data-action="back">返回工作流</button><button type="button" data-action="run">开始试填</button><button type="button" data-action="stop" hidden>停止</button></footer>`;
  document.body.append(dialog);
  const find = id => dialog.querySelector(`#${id}`);
  const action = name => dialog.querySelector(`[data-action="${name}"]`);
  const message = find("temu-listing-message");
  const issues = find("temu-listing-issues");
  const path = find("temu-products-path");
  const picker = find("temu-product-item");
  const category = find("temu-listing-category");
  const country = find("temu-listing-origin");
  const region = find("temu-listing-region");
  const site = find("temu-listing-site");
  let products = [];
  let origins = [];
  let run;
  let loadedPath = "";
  let searchedCategory = "";

  function options(target, values) {
    target.replaceChildren(...values.map(value => Object.assign(document.createElement("option"), { value })));
  }

  function tell(text, error = false) {
    message.textContent = text;
    message.toggleAttribute("data-error", error);
  }

  function selected() {
    return loadedPath === path.value.trim() ? products[Number(picker.value)]?.input : undefined;
  }

  function showRegions() {
    options(find("temu-region-options"), origins.find(row => row.country === country.value.trim())?.regions || []);
  }

  picker.addEventListener("change", () => {
    const product = selected();
    if (!product) return;
    category.value = product.categoryPath.join(" > ");
    site.value = product.sites[0] || "美国站";
    country.value = product.origin?.country || "";
    region.value = product.origin?.region || "";
    showRegions();
    tell(`已读取 ${product.mainImages.length} 张主图、${product.detailImages.length} 张详情图和 ${product.skus.length} 个 SKU。`);
  });
  path.addEventListener("input", () => { picker.hidden = path.value.trim() !== loadedPath || !products.length; });
  country.addEventListener("input", showRegions);
  category.addEventListener("input", async () => {
    const query = category.value.trim();
    searchedCategory = query;
    if (!query) return options(find("temu-category-options"), []);
    try {
      const rows = await searchTemuCategories(query);
      if (searchedCategory === query) options(find("temu-category-options"), rows.map(row => row.path.join(" > ")));
    } catch { /* 手动输入的类目仍会在 Temu 页面校验。 */ }
  });

  action("load").addEventListener("click", async () => {
    const currentPath = path.value.trim();
    action("load").disabled = true;
    try {
      const denied = await requireOptionalFeature("nativeMessaging", { userGesture: true });
      if (denied) throw new Error(denied);
      const result = await loadTemuProductDirectory(currentPath);
      if (currentPath !== path.value.trim()) return;
      loadedPath = currentPath;
      products = result.products;
      picker.replaceChildren(...products.map(({ title }, index) =>
        Object.assign(document.createElement("option"), { value: String(index), textContent: title })));
      picker.hidden = !products.length;
      if (products.length) picker.dispatchEvent(new Event("change"));
      if (result.issues.length || !products.length) {
        tell(result.issues.map(item => `${item.folder}：${item.error}`).join("。") || "目录中没有可用商品。", true);
      }
    } catch (error) {
      tell(error.message, true);
    } finally {
      action("load").disabled = false;
    }
  });

  function prepareInput() {
    const edited = find("temu-product-json").value.trim();
    const base = selected();
    const raw = edited ? JSON.parse(edited) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("请提供商品 JSON 对象。");
    const normalized = normalizeTemuListingInput({ ...base, ...raw, title: raw.title || base?.title, temu: raw.temu });
    const overlayAttributes = normalized.listingAttributes;
    const filled = { ...base };
    for (const [key, value] of Object.entries(normalized)) {
      if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
      filled[key] = value;
    }
    filled.listingAttributes = { ...base?.listingAttributes, ...overlayAttributes };
    for (const key of ["mainImages", "detailImages", "variantImages", "sizeChartImagePath"]) filled[key] = base?.[key];
    for (const key of ["skus", "variantGroups"]) filled[key] = base?.[key]?.length ? base[key] : normalized[key];
    filled.sites = [site.value.trim() || normalized.sites[0] || base?.sites[0]].filter(Boolean);
    filled.categoryPath = category.value.trim() ? category.value.split(/\s*[>＞›»]\s*/u).map(s => s.trim()).filter(Boolean) : normalized.categoryPath;
    const namedCountry = country.value.trim();
    if (namedCountry) filled.origin = { country: namedCountry, region: region.value.trim() };
    return filled;
  }

  action("run").addEventListener("click", async () => {
    if (run || isAgentBusy?.()) return tell("请等当前任务结束后再试。", true);
    const signal = (run = new AbortController()).signal;
    action("run").disabled = true;
    action("stop").hidden = false;
    issues.replaceChildren();
    try {
      const input = prepareInput();
      if (!input.sites.length || !input.categoryPath.length) throw new Error("请选择经营站点和完整商品类目。");
      const tab = await getTargetTab();
      if (!isTemuCategoryPage(tab?.url)) throw new Error("请切到 Temu 新建商品的第 1 步，再开始试填。");
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
      } catch (error) {
        if (!/cannot access|missing host permission/iu.test(error?.message || "")) throw error;
        const permission = await requireHostUrl(startUrl, { tabId: tab.id, userGesture: true });
        if (permission) throw new Error(permission);
      }
      signal.throwIfAborted();
      const approved = find("temu-listing-upload").checked;
      const useModel = find("temu-listing-ai").checked;
      const imagePaths = new Set([...(input.mainImages || []), ...(input.detailImages || []), ...(input.variantImages || []), input.sizeChartImagePath]);
      const call = createTemuListingToolCaller({
        tabId: tab.id, url: tab.url, signal,
        confirmUpload: ({ paths }) => approved && paths.every(file => imagePaths.has(file)),
      });
      const result = await replayTemuListing({
        tabId: tab.id, input, call, signal,
        suggestFields: (product, schema, { signal }) =>
          suggestTemuFields(product, schema, { signal, settings: getSettings?.(), useModel }),
        onStep: ({ label, completed }) => tell(`${label} · 已核对 ${completed.length} 项`),
      });
      const completed = result.items.filter(item => /^(?:filled|verified|unchanged)$/u.test(item.status)).length;
      tell(`试填${result.missing.length || result.issues.length ? "待核对" : "已完成"}，已核对 ${completed} 项，必填待补 ${result.missing.length} 项。`, result.status === "needs-review");
      const receipts = [...result.issues.map(({ label, message }) => `${label}：${message}`), ...result.missing.map(({ label }) => `待填：${label}`)];
      issues.replaceChildren(...[...new Set(receipts)].map(textContent => Object.assign(document.createElement("li"), { textContent })));
    } catch (error) {
      tell(signal.aborted ? "试填已停止。" : error.message || "Temu 试填失败。", !signal.aborted);
    } finally {
      run = undefined;
      action("run").disabled = false;
      action("stop").hidden = true;
    }
  });

  action("stop").addEventListener("click", () => run?.abort());
  action("close").addEventListener("click", () => dialog.close());
  action("back").addEventListener("click", () => { dialog.close(); onBack?.(); });
  dialog.addEventListener("close", () => run?.abort());
  site.value = "美国站";
  return async function open() {
    if (!dialog.open) dialog.showModal();
    const tab = await getTargetTab();
    find("temu-listing-page").textContent = isTemuCategoryPage(tab?.url) ? "当前页是 Temu 新建商品第 1 步。" : "请先打开 Temu 新建商品页。";
    if (!origins.length) {
      loadTemuOrigins().then(rows => {
        origins = rows;
        options(find("temu-origin-options"), origins.map(row => row.country));
        showRegions();
      }).catch(() => {});
    }
    return true;
  };
}
