import { chooseTemuProductDirectory, createTemuSuggestionFilter, loadTemuProductDirectory, normalizeTemuListingInput, suggestTemuFields } from "../flows/temu/product-listing/input.js";
import { replayTemuListing } from "../flows/temu/product-listing/listing.flow.mjs";
import { isTemuCategoryPage } from "../flows/temu/product-listing/stage1.js";
import { createTemuListingToolCaller } from "../flows/temu/product-listing/tool-adapter.js";
import { loadTemuCategoryChildren, loadTemuOrigins, resolveTemuOrigin, searchTemuCategories } from "../flows/temu/product-listing/taxonomy.js";
import { suggestTemuCategory } from "../flows/temu/product-listing/category-suggestion.js";
import { openTemuWorkflowTab } from "../flows/temu/workflow-tab.js";
import { requireHostUrl, requireOptionalFeature } from "../lib/optional-permissions.js";
import { bindTemuListingSelect } from "./temu-listing-select.js";
import { prepareSizeChartInput, readProductImage } from "../flows/shopee/product-listing/sidepanel/product-directory.js";
import { suggestTemuSizeChart } from "../flows/temu/product-listing/size-chart-suggestion.js";
import { findTemuBatchResumeTabs, runTemuBatchPrefill, TEMU_BATCH_LIMIT } from "../flows/temu/product-listing/batch-run.js";

const startUrl = "https://agentseller.temu.com/goods/create/category";
const sitePreference = "pagelens.temu.listingSite";
const defaultOrigin = { country: "中国大陆", region: "浙江省" };
// Snapshot of the seller's Step 1 options. Replay verifies the choice against the current store.
const knownSites = [
  "美国站", "加拿大站", "英国站", "澳大利亚站、新西兰站", "欧盟地区", "墨西哥站", "瑞士站", "日本站", "沙特站",
  "阿联酋站", "科威特站", "挪威站", "智利站", "马来西亚站", "菲律宾站", "泰国站", "卡塔尔站", "约旦站", "阿曼站",
  "巴林站", "以色列站", "南非站", "塞尔维亚", "摩尔多瓦", "黑山", "冰岛", "波黑", "阿尔巴尼亚",
  "秘鲁", "哥伦比亚", "格鲁吉亚", "亚美尼亚", "阿塞拜疆", "乌克兰", "毛里求斯", "摩洛哥", "巴拿马站",
  "厄瓜多尔站", "斯里兰卡站", "越南站", "文莱站", "北马其顿", "吉尔吉斯斯坦站", "列支敦士登站",
];
const icon = name => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function field(id, label, { search, trail = false, hidden = false } = {}) {
  return `<div class="temu-field" id="temu-${id}" ${hidden ? "hidden" : ""}>
    <span class="temu-label" id="temu-${id}-label">${label}</span>
    <button class="temu-select-trigger" type="button" aria-labelledby="temu-${id}-label temu-${id}-value">
      <span id="temu-${id}-value"></span>${icon("chevron")}
    </button>
    <div class="temu-select-menu" id="temu-${id}-menu" hidden>
      ${search ? `<input type="search" aria-label="${search}" placeholder="${search}" autocomplete="off" />` : ""}
      ${trail ? '<nav class="temu-category-trail" aria-label="当前分类层级" hidden></nav>' : ""}
      <div class="temu-select-options"></div>
    </div>
  </div>`;
}

export function bindTemuListingPanel({
  getTargetTab, getSettings, isAgentBusy, onBack,
  chooseDirectory = chooseTemuProductDirectory, readDirectory = loadTemuProductDirectory, suggestCategory = suggestTemuCategory,
  fetchImpl = fetch, openTab = openTemuWorkflowTab, replay = replayTemuListing,
  runBatch = runTemuBatchPrefill, findResumeTabs = findTemuBatchResumeTabs,
  activateTab = tabId => chrome.tabs.update(tabId, { active: true }),
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "temu-listing-dialog";
  dialog.setAttribute("aria-labelledby", "temu-listing-title");
  dialog.innerHTML = `
    <header class="temu-listing-header">
      <button class="icon-btn" type="button" data-action="back" aria-label="返回工作流" title="返回工作流">${icon("back")}</button>
      <h2 id="temu-listing-title">Temu 商品上架</h2>
      <button class="icon-btn" type="button" data-action="close" aria-label="关闭" title="关闭">${icon("close")}</button>
    </header>
    <div class="temu-listing-body">
      <fieldset class="temu-listing-source" aria-label="商品资料">
        <div class="temu-field">
          <span class="temu-label">商品目录</span>
          <button class="temu-listing-action temu-directory-button" type="button" data-action="choose">
            ${icon("folder")}<span>选择商品目录</span>
          </button>
          <p id="temu-directory-summary" class="temu-hint" role="status">可选单个商品目录或包含多个商品的文件夹。</p>
          <details class="temu-directory-fallback">
            <summary>目录选择器不可用时</summary>
            <div>
              <input id="temu-directory-path" aria-label="本地商品目录" placeholder="粘贴本地商品目录路径" />
              <button class="temu-listing-action" type="button" data-action="read-directory">读取目录</button>
            </div>
          </details>
        </div>
        ${field("product-item", "目录中的商品", { search: "搜索商品", hidden: true })}
        ${field("listing-site", "经营站点", { search: "搜索站点" })}
        <div>
          ${field("listing-category", "商品类目", { search: "搜索商品类目", trail: true })}
          <p id="temu-category-hint" class="temu-hint" aria-live="polite"></p>
        </div>
        <div class="temu-listing-grid">
          ${field("listing-origin", "商品产地", { search: "搜索国家或地区" })}
          ${field("listing-region", "省份或地区", { search: "搜索省份或地区" })}
        </div>
        <label class="temu-listing-check" id="temu-upload-option" hidden><input id="temu-listing-upload" type="checkbox" />上传商品目录中的图片</label>
        <label for="temu-product-notes">补充商品描述</label>
        <textarea id="temu-product-notes" rows="3" maxlength="1800" placeholder="例如商品名称、材质、规格或用途"></textarea>
        <label class="temu-listing-check"><input id="temu-listing-ai" type="checkbox" />允许将商品资料和图片发送给已配置的模型，用于匹配类目和补齐表单</label>
      </fieldset>
      <div id="temu-listing-message" role="status" aria-live="polite"></div>
      <p id="temu-listing-result-detail" class="temu-hint" hidden></p>
      <ul id="temu-listing-issues"></ul>
      <ul id="temu-batch-results" aria-label="批量试填结果" hidden></ul>
    </div>
    <footer class="temu-listing-footer">
      <button class="temu-listing-action primary" type="button" data-action="run" disabled>开始上品</button>
      <button class="temu-listing-action" type="button" data-action="run-all" hidden>批量试填</button>
      <button class="temu-listing-action" type="button" data-action="resume-all" hidden>续填已打开商品</button>
      <button class="temu-listing-action" type="button" data-action="stop" hidden>停止</button>
    </footer>`;
  document.body.append(dialog);

  const find = id => dialog.querySelector(`#temu-${id}`);
  const action = name => dialog.querySelector(`[data-action="${name}"]`);
  const message = find("listing-message");
  const resultDetail = find("listing-result-detail");
  const issues = find("listing-issues");
  const batchResults = find("batch-results");
  const source = dialog.querySelector("fieldset");
  const directorySummary = find("directory-summary");
  const categoryHint = find("category-hint");
  const categoryTrail = dialog.querySelector(".temu-category-trail");
  const upload = find("listing-upload");
  const notes = find("product-notes");
  let products = [];
  let directoryRoot;
  let productIndex = 0;
  let origins;
  let originsPending;
  let chosenOrigin = { ...defaultOrigin };
  let chosenSite = knownSites[0];
  let chosenCategory;
  let manualCategory = false;
  let manualOrigin = false;
  let categoryRequest;
  let categoryTrailParts = [];
  let categoryQuery = 0;
  let categoryTimer;
  let notesTimer;
  let directoryRequest;
  let run;

  try {
    const saved = document.defaultView.localStorage.getItem(sitePreference);
    if (knownSites.includes(saved)) chosenSite = saved;
  } catch { /* The preference remains available in the current panel. */ }

  function tell(text, error = false) {
    message.textContent = text;
    message.toggleAttribute("data-error", error);
  }

  function select(id, label, placeholder, render) {
    return bindTemuListingSelect(find(id), { label, placeholder, search: render, onOpen: () => render("") });
  }

  function renderChoices(control, values, query, pick) {
    control.render(values.filter(label => label.toLowerCase().includes(query.toLowerCase()))
      .map(label => ({ key: label, label, pick: () => pick(label) })));
  }

  const site = select("listing-site", "经营站点", "选择站点", query => renderChoices(site, knownSites, query, value => {
    chosenSite = value;
    site.setValue(value);
    try { document.defaultView.localStorage.setItem(sitePreference, value); } catch { /* Keep the current selection. */ }
  }));
  site.setValue(chosenSite);

  const country = select("listing-origin", "商品产地", "选择产地", async query => {
    try {
      await ensureOrigins();
      if (!country.isOpen() || find("listing-origin").querySelector("input").value.trim() !== query) return;
      renderChoices(country, origins.filter(row =>
        !query || [row.country, ...row.aliases].some(name => name.toLowerCase().includes(query.toLowerCase()))
      ).map(row => row.country), "", value => {
        manualOrigin = true;
        setOrigin(value === defaultOrigin.country ? defaultOrigin : { country: value });
      });
    } catch {
      if (country.isOpen()) country.render([], "无法加载产地目录，请重新打开选择器。");
    }
  });
  const region = select("listing-region", "省份或地区", "选择省份或地区", async query => {
    try {
      await ensureOrigins();
      if (!region.isOpen() || find("listing-region").querySelector("input").value.trim() !== query) return;
      renderChoices(region, regions(), query, value => {
        manualOrigin = true;
        setOrigin({ ...chosenOrigin, region: value });
      });
    } catch {
      if (region.isOpen()) region.render([], "无法加载产地目录，请重新打开选择器。");
    }
  });

  function regions() {
    return origins?.find(row => row.country === chosenOrigin.country)?.regions || [];
  }

  function setOrigin(value) {
    chosenOrigin = { ...value };
    country.setValue(chosenOrigin.country);
    region.setValue(chosenOrigin.region);
    const unavailable = Boolean(origins && !regions().length);
    region.setDisabled(unavailable);
    if (unavailable) region.setValue("此产地无需选择");
  }
  setOrigin(defaultOrigin);

  function ensureOrigins() {
    if (origins) return Promise.resolve(origins);
    if (!originsPending) originsPending = loadTemuOrigins({ fetchImpl }).then(rows => {
      origins = rows;
      setOrigin(chosenOrigin);
      return rows;
    }).finally(() => { originsPending = undefined; });
    return originsPending;
  }

  const productItem = select("product-item", "目录中的商品", "选择商品", query => {
    productItem.render(products.flatMap(({ title }, index) => title.toLowerCase().includes(query.toLowerCase())
      ? [{ key: String(index), label: title, pick: () => setProduct(index) }]
      : []));
  });

  const category = bindTemuListingSelect(find("listing-category"), {
    label: "商品类目",
    placeholder: "选择类目",
    onOpen: () => {
      categoryTrailParts = (chosenCategory?.ids || []).slice(0, -1)
        .map((id, index) => ({ id, label: chosenCategory.path[index] }));
      showCategoryLevel("");
    },
    search: query => {
      clearTimeout(categoryTimer);
      ++categoryQuery;
      category.render([], "正在查找类目…");
      categoryTimer = setTimeout(() => showCategoryLevel(query), query ? 160 : 0);
    },
  });

  function syncRunButton() {
    action("run").disabled = Boolean(run || directoryRequest || !chosenCategory);
    const batch = action("run-all");
    batch.hidden = products.length < 2;
    batch.disabled = Boolean(run || directoryRequest || products.length > TEMU_BATCH_LIMIT);
    batch.textContent = products.length > TEMU_BATCH_LIMIT ? `每批最多 ${TEMU_BATCH_LIMIT} 件` : `批量试填 ${products.length} 件`;
    action("resume-all").hidden = batch.hidden || products.length > TEMU_BATCH_LIMIT;
    action("resume-all").disabled = batch.disabled;
  }

  function updateCategory(value) {
    chosenCategory = value;
    syncRunButton();
    const path = value?.path.join(" › ");
    category.setValue(path, value?.id || "");
  }

  function pickCategory(value) {
    manualCategory = true;
    categoryRequest?.abort();
    updateCategory(value);
    categoryHint.textContent = "";
  }

  function showTrail(searching) {
    categoryTrail.replaceChildren();
    categoryTrail.hidden = searching || !categoryTrailParts.length;
    if (categoryTrail.hidden) return;
    categoryTrail.append(...["全部类目", ...categoryTrailParts.map(part => part.label)].map((name, index) => {
      const bread = document.createElement("button");
      bread.type = "button";
      bread.textContent = name;
      bread.addEventListener("click", () => {
        categoryTrailParts = categoryTrailParts.slice(0, index);
        find("listing-category").querySelector("input").focus();
        void showCategoryLevel("");
      });
      return bread;
    }));
  }

  async function showCategoryLevel(query) {
    clearTimeout(categoryTimer);
    const revision = ++categoryQuery;
    const trail = categoryTrailParts;
    const ids = trail.map(part => part.id);
    showTrail(Boolean(query));
    category.render([], "正在加载类目…");
    try {
      const rows = query
        ? (await searchTemuCategories(query, { withIds: true, fetchImpl })).map(value => ({
          key: value.id, label: value.path.join(" › "), pick: () => pickCategory(value),
        }))
        : (await loadTemuCategoryChildren(ids, { fetchImpl })).map(node => ({
          key: node.id, label: node.label, branch: !node.leaf, pick: () => {
            if (node.leaf) {
              pickCategory({ id: node.id, ids: [...ids, node.id], path: [...trail.map(part => part.label), node.label] });
            } else {
              categoryTrailParts = [...trail, node];
              void showCategoryLevel("");
            }
          },
        }));
      if (revision === categoryQuery && category.isOpen()) category.render(rows, "没有匹配的商品类目。");
    } catch {
      if (revision === categoryQuery && category.isOpen()) category.render([], "无法加载类目，请重新打开选择器。");
    }
  }

  function selected() {
    return products[productIndex]?.input;
  }

  function sourceInput() {
    const description = notes.value.trim();
    const base = selected();
    if (!base && !description) throw new Error("请选择商品目录或填写商品描述。");
    const title = base?.title || description.split(/[\n。]/u)[0].slice(0, 100);
    const normalized = normalizeTemuListingInput({ ...base, title, description: base?.description || description });
    const filled = { ...base };
    filled.operatorNotes = description;
    for (const [key, value] of Object.entries(normalized)) {
      if (value == null || value === "" || (Array.isArray(value) && !value.length)) continue;
      filled[key] = value;
    }
    filled.attributes = { ...base?.attributes, ...normalized.attributes };
    filled.listingAttributes = { ...base?.listingAttributes, ...normalized.listingAttributes };
    for (const key of ["mainImages", "detailImages", "variantImages", "sharedGalleryImages", "sizeChartImagePath"]) {
      filled[key] = base?.[key] ?? normalized[key];
    }
    for (const key of ["skus", "variantGroups"]) filled[key] = base?.[key]?.length ? base[key] : normalized[key];
    return filled;
  }

  async function recommend() {
    categoryRequest?.abort();
    let product;
    try { product = sourceInput(); } catch { return; }
    const controller = new AbortController();
    categoryRequest = controller;
    const { signal } = controller;

    void ensureOrigins().then(rows => {
      if (signal.aborted || manualOrigin || !dialog.open) return;
      const exact = product.origin && resolveTemuOrigin(rows, product.origin);
      setOrigin(exact?.country === defaultOrigin.country ? { ...defaultOrigin, ...exact } : exact || defaultOrigin);
    }).catch(() => { /* Default display stays available while the packaged catalog retries. */ });

    if (manualCategory) return;
    updateCategory(undefined);
    categoryHint.textContent = "正在根据商品推荐类目…";
    try {
      const result = await suggestCategory(product, { settings: getSettings?.(), signal, fetchImpl, useModel: find("listing-ai").checked });
      if (signal.aborted || manualCategory || !dialog.open) return;
      updateCategory(result.category);
      categoryHint.textContent = result.source === "model" ? "AI 推荐，可修改。"
        : result.source === "provided" ? "已匹配商品资料中的类目。"
        : result.category ? "已按商品资料匹配，可修改。" : "暂无合适推荐，请从类目列表选择。";
    } catch {
      if (!signal.aborted && dialog.open) categoryHint.textContent = "类目推荐暂不可用，可手动选择。";
    }
  }

  function setProduct(index) {
    productIndex = index;
    const product = products[index];
    productItem.setValue(product.title, String(index));
    manualCategory = false;
    manualOrigin = false;
    setOrigin(defaultOrigin);
    updateCategory(undefined);
    const { mainImages, detailImages, variantImages, sizeChartImagePath } = product.input;
    const hasImages = mainImages.length + detailImages.length + variantImages.length > 0 || Boolean(sizeChartImagePath);
    find("upload-option").hidden = !hasImages;
    if (!hasImages) upload.checked = false;
    tell("");
    void recommend();
  }

  async function loadDirectory(read) {
    if (directoryRequest || run) return;
    const pending = { open: true };
    directoryRequest = pending;
    action("choose").disabled = true;
    action("read-directory").disabled = true;
    syncRunButton();
    tell("正在读取商品目录…");
    try {
      const result = await read();
      if (!result || !pending.open || !dialog.open) return;
      products = result.products;
      directoryRoot = result.root;
      productIndex = 0;
      find("product-item").hidden = products.length < 2;
      const name = result.directoryName || result.root?.split(/[/\\]/u).filter(Boolean).at(-1) || "本地目录";
      directorySummary.textContent = products.length === 1 ? products[0].title : `${name} · ${products.length} 件商品`;
      upload.checked = false;
      issues.replaceChildren();
      batchResults.replaceChildren();
      batchResults.hidden = true;
      if (products.length) {
        setProduct(0);
      } else {
        categoryRequest?.abort();
        categoryHint.textContent = "";
        manualCategory = manualOrigin = false;
        updateCategory(undefined);
        setOrigin(defaultOrigin);
        find("upload-option").hidden = true;
        upload.checked = false;
        tell("该目录没有可读取的商品资料。可以更换目录或填写商品描述。", true);
      }
      renderIssues(result.issues.map(item => `${item.folder}：${item.error}`));
    } catch (error) {
      if (pending.open && dialog.open) tell(error.message, true);
    } finally {
      directoryRequest = undefined;
      action("choose").disabled = false;
      action("read-directory").disabled = false;
      syncRunButton();
      action("choose").querySelector("span").textContent = products.length ? "更换商品目录" : "选择商品目录";
      if (message.textContent === "正在读取商品目录…") tell("");
    }
  }

  action("choose").addEventListener("click", () => void loadDirectory(chooseDirectory));
  action("read-directory").addEventListener("click", () => {
    const path = find("directory-path").value.trim();
    if (!path) return tell("请输入商品目录的绝对路径。", true);
    void loadDirectory(async () => {
      const denied = await requireOptionalFeature("nativeMessaging", { userGesture: true });
      if (denied) throw new Error(denied);
      return readDirectory(path);
    });
  });

  notes.addEventListener("input", () => {
    if (!manualCategory) {
      categoryRequest?.abort();
      updateCategory(undefined);
      categoryHint.textContent = "";
    }
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => void recommend(), 400);
  });
  find("listing-ai").addEventListener("change", () => void recommend());

  function renderIssues(receipts) {
    issues.replaceChildren(...[...new Set(receipts)].map(textContent => Object.assign(document.createElement("li"), { textContent })));
  }

  function issueMessages(result) {
    return [...(result?.issues || []).map(({ label, message }) => `${label}：${message}`),
      ...(result?.missing || []).map(({ label }) => `待填：${label}`)];
  }

  function prefillProduct(input, selectedProduct, { tab, signal, onStep, approved, useModel, root, resume }) {
    input.uploadImages = approved;
    const referenceImage = input.mainImages?.[0] || input.detailImages?.[0] || input.variantImages?.[0];
    const readSizeChart = useModel && selectedProduct && input.sizeChartImagePath
      ? async () => (await prepareSizeChartInput({ ...selectedProduct, input }, {
        root, signal, getSettings: getSettings ? async () => getSettings() : undefined,
      })).sizeChart
      : undefined;
    let imageRead;
    const readImage = useModel && selectedProduct && referenceImage ? () => imageRead ??= readProductImage({
      root, folder: selectedProduct.folder, path: referenceImage, asset: "main", signal,
    }) : undefined;
    const suggestSizeChart = useModel ? async (product, { sizes, signal }) => suggestTemuSizeChart(product, {
      sizes, signal, settings: await getSettings?.(), readImage,
    }) : undefined;
    const imagePaths = new Set([...(input.mainImages || []), ...(input.detailImages || []), ...(input.variantImages || []), input.sizeChartImagePath]);
    const call = createTemuListingToolCaller({
      tabId: tab.id, url: tab.url, signal,
      confirmUpload: ({ paths }) => approved && paths.every(file => imagePaths.has(file)),
      ...(resume && { resume: { ...resume, title: input.title, site: input.sites[0],
        categoryPath: input.categoryPath, categoryId: input.categoryId } }),
    });
    return replay({
      tabId: tab.id, input, call, signal, readSizeChart, suggestSizeChart,
      ...(resume && { resume: { href: resume.href } }),
      shouldSuggestField: createTemuSuggestionFilter(input, { useModel, visual: Boolean(readImage) }),
      suggestFields: (product, schema, { signal }) =>
        suggestTemuFields(product, schema, { signal, settings: getSettings?.(), useModel, readImage }),
      onStep,
    });
  }

  async function startBatch(active, config) {
    const { signal, useModel, site, resumeTabs } = config;
    const jobs = products.slice();
    const cards = jobs.map(({ title }) => {
      const item = document.createElement("li");
      const name = Object.assign(document.createElement("strong"), { textContent: title });
      const status = Object.assign(document.createElement("p"), { className: "temu-hint", textContent: "待试填" });
      const details = Object.assign(document.createElement("details"), { hidden: true });
      const summary = Object.assign(document.createElement("summary"), { textContent: "待核对项" });
      const issueList = document.createElement("ul");
      details.append(summary, issueList);
      const open = Object.assign(document.createElement("button"), {
        type: "button", className: "temu-listing-action", textContent: "查看商品页", hidden: true, disabled: true,
      });
      item.append(name, status, details, open);
      return { item, status, details, issueList, open };
    });
    batchResults.replaceChildren(...cards.map(card => card.item));
    batchResults.hidden = false;
    tell(resumeTabs ? "正在续填原商品标签…" : `正在打开 ${jobs.length} 个独立商品标签…`);
    const receipts = await runBatch({
      products: jobs, sourceTab: active, signal, resumeTabs,
      async runProduct(product, context) {
        const input = { ...product.input, sites: [site] };
        context.onStep({ label: "核对该商品的站点与类目…" });
        const result = await suggestCategory(input, { settings: getSettings?.(), signal, fetchImpl, useModel });
        if (!result.category) throw new Error("当前商品没有匹配的 Temu 类目。");
        input.categoryPath = result.category.path;
        input.categoryId = result.category.id;
        const origin = input.origin && resolveTemuOrigin(await ensureOrigins(), input.origin);
        input.origin = origin?.country === defaultOrigin.country ? { ...defaultOrigin, ...origin } : origin || { ...defaultOrigin };
        return prefillProduct(input, product, { ...config, ...context });
      },
      onJob(index, job) {
        const card = cards[index];
        card.status.textContent = [job.message || (job.status === "opening" ? "正在打开商品页…" : "待试填"),
          job.receipt?.sizeChart && `已关联尺码表「${job.receipt.sizeChart.name}」`].filter(Boolean).join(" · ");
        const messages = [...new Set(issueMessages(job.receipt))];
        card.issueList.replaceChildren(...messages.map(textContent =>
          Object.assign(document.createElement("li"), { textContent })));
        card.details.hidden = !messages.length;
        if (Number.isInteger(job.tabId)) {
          card.open.hidden = false;
          card.open.onclick = async () => {
            if (run) return;
            try { await activateTab(job.tabId); }
            catch { tell("此商品标签已关闭。", true); }
          };
        }
      },
    });
    const loaded = receipts.filter(job => job.receipt?.draftUrl).length;
    const completed = receipts.filter(job => job.status === "completed").length;
    const review = receipts.filter(job => job.status === "needs-review").length;
    tell(signal.aborted ? `已停止，保留 ${receipts.filter(job => job.tabId).length} 个标签。` :
      `已进入 ${loaded}/${jobs.length} 个商品表单，${completed} 件试填通过${review ? `，${review} 件待核对` : ""}。`, Boolean(review));
  }

  async function start(mode = "single") {
    const all = mode !== "single";
    if (run || directoryRequest || isAgentBusy?.()) return tell("请等当前任务结束后再试。", true);
    if (all && (products.length < 2 || products.length > TEMU_BATCH_LIMIT)) return;
    const signal = (run = new AbortController()).signal;
    for (const control of [site, category, country, region, productItem]) control.close();
    source.disabled = true;
    syncRunButton();
    action("stop").hidden = false;
    issues.replaceChildren();
    resultDetail.hidden = true;
    batchResults.hidden = !all;
    const config = { signal, approved: upload.checked, useModel: find("listing-ai").checked,
      root: directoryRoot, site: chosenSite };
    try {
      categoryRequest?.abort();
      clearTimeout(notesTimer);
      if (all) {
        const permission = await requireHostUrl(startUrl, { userGesture: true });
        if (permission) throw new Error(permission);
        const active = await getTargetTab();
        signal.throwIfAborted();
        if (mode === "resume") {
          if (!Number.isInteger(active?.windowId)) throw new Error("没有找到本次试填的 Chrome 窗口。");
          tell("正在核对当前窗口已打开的 Temu 商品…");
          config.resumeTabs = await findResumeTabs(products, active.windowId, signal);
        }
        await startBatch(active, config);
        return;
      }
      const input = sourceInput();
      if (!chosenCategory) throw new Error("请选择完整的商品类目。");
      input.sites = [chosenSite];
      input.categoryPath = chosenCategory.path;
      input.categoryId = chosenCategory.id;
      input.origin = { ...chosenOrigin };
      tell("正在打开 Temu 新建商品页…");
      const active = await getTargetTab();
      signal.throwIfAborted();
      let canAccess = false;
      if (isTemuCategoryPage(active?.url)) {
        canAccess = await chrome.scripting.executeScript({ target: { tabId: active.id }, func: () => true })
          .then(() => true, () => false);
      }
      if (!canAccess) {
        const permission = await requireHostUrl(startUrl, { userGesture: true, tabId: active?.id });
        if (permission) throw new Error(permission);
      }
      const tab = await openTab({ tab: active, href: startUrl, accepts: isTemuCategoryPage, signal });
      signal.throwIfAborted();
      const result = await prefillProduct(input, products[productIndex], {
        ...config, tab, onStep: ({ label }) => tell(label),
      });
      tell(result.status === "cancelled" ? "上品已停止。" : result.status === "needs-review"
        ? "请处理下方待核对事项。" : "商品资料已填写，请在 Temu 核对并发布。", result.status === "needs-review");
      const schemaHint = { cold: "已读取类目表单", warm: "已复用类目表单缓存", changed: "已更新类目表单缓存" }[result.schemaCache?.status];
      const details = [schemaHint, result.sizeChart &&
        `${result.sizeChart.created ? "已创建并关联" : "已关联"}尺码表「${result.sizeChart.name}」`].filter(Boolean);
      resultDetail.textContent = details.join(" · ");
      resultDetail.hidden = details.length === 0;
      renderIssues(issueMessages(result));
    } catch (error) {
      tell(signal.aborted ? "上品已停止。" : error.message || "暂时无法完成 Temu 上品。", !signal.aborted);
    } finally {
      run = undefined;
      source.disabled = false;
      syncRunButton();
      action("stop").hidden = true;
      for (const button of batchResults.querySelectorAll("button:not([hidden])")) button.disabled = false;
    }
  }
  action("run").addEventListener("click", () => void start());
  action("run-all").addEventListener("click", () => void start("batch"));
  action("resume-all").addEventListener("click", () => void start("resume"));

  function cancelPending() {
    for (const control of [site, category, country, region, productItem]) control.close();
    clearTimeout(categoryTimer);
    clearTimeout(notesTimer);
    if (directoryRequest) directoryRequest.open = false;
    categoryRequest?.abort();
    run?.abort();
  }

  function dismiss() {
    cancelPending();
    dialog.close();
  }

  action("stop").addEventListener("click", () => run?.abort());
  action("close").addEventListener("click", dismiss);
  action("back").addEventListener("click", () => { dismiss(); onBack?.(); });
  dialog.addEventListener("cancel", cancelPending);

  return async function open() {
    if (!dialog.open) {
      dialog.showModal();
      void ensureOrigins().catch(() => {});
      if (!chosenCategory && !manualCategory && (selected() || notes.value.trim())) void recommend();
    }
    return true;
  };
}
