import { requireHostUrl } from "../../../lib/optional-permissions.js";
import { geekbiSettingsKey, geekbiConfigured } from "../../../integrations/geekbi/client.js";
import { requestGeekbi } from "../../../integrations/geekbi/runtime.js";
import { europeanSites, sourcingParams, imageSearchParams, normalizeCandidates, podKeywords, reviewPod,
  candidateReviewPrompt, imageCheckPrompt, readPodCdn, resizePodImage, podImageData, productForCandidate, saveCandidate, mapPodJobs } from "./service.js";
import { generatePodImage, imageChoices, podImagePreference, resolvePodImageModel } from "./image-model.js";
import { readPodDirectory, saveArtwork, saveProductKit } from "./directory.js";
import { createKit, estimatedPodProgress, kitTasks, kitViews, makeKitPlan, runKitTasks } from "./product-kit.js";
import { resolveSizeChartModel } from "../../../lib/size-chart.mjs";

function el(tag, label, className) {
  const node = document.createElement(tag);
  if (label != null) node.textContent = label;
  if (className) node.className = className;
  return node;
}
function action(label, invoke, { disabled = false, primary = false } = {}) {
  const node = el("button", label, primary ? "primary" : "secondary");
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", invoke);
  return node;
}
const iconPaths = {
  detail: '<path d="M6 3h9l3 3v15H6z M9 10h6 M9 14h6 M9 17h4"/>',
  reference: '<path d="m12 3 2.3 4.7 5.2.8-3.7 3.6.9 5.1-4.7-2.4-4.7 2.4.9-5.1-3.7-3.6 5.2-.8z"/>',
  base: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6 M16 8h.01"/>',
  generate: '<path d="m3 21 14-14 M14 10l3 3 M6 3v6 M3 6h6 M19 14v6 M16 17h6 M19 3v4 M17 5h4"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  save: '<path d="M12 3v12 M7 10l5 5 5-5 M4 16v4h16v-4"/>',
  clear: '<path d="m6 6 12 12 M18 6 6 18"/>',
};
function iconAction(icon, label, invoke, options) {
  const node = action(null, invoke, options);
  node.classList.add("pod-icon-action");
  node.title = node.ariaLabel = label;
  node.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[icon]}</svg>`;
  return node;
}

function check(label, value, change, compact = false) {
  const wrap = el("label", null, "pod-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => change(input.checked));
  const text = el("span", label);
  if (compact) {
    wrap.classList.add("pod-card-title");
    text.title = label;
  }
  wrap.append(input, text);
  return wrap;
}
async function requirePodHost(url) {
  const denied = await requireHostUrl(url, { userGesture: true });
  if (denied) throw new Error(denied);
}

const format = value => Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
const pct = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%` : "—";

function historyChart(history) {
  const points = (Array.isArray(history) ? history : []).filter(item => item.createTime && Number.isFinite(item.weekSold))
    .sort((a, b) => String(a.createTime).localeCompare(String(b.createTime))).slice(-14);
  if (!points.length) return el("p", "接口未返回可绘制的周销量历史。", "hint");
  const chart = el("div", null, "pod-chart");
  chart.setAttribute("aria-label", "周销量历史");
  const max = Math.max(1, ...points.map(point => point.weekSold));
  for (const point of points) {
    const date = String(point.createTime).slice(5, 10);
    const row = el("div", null, "pod-chart-row");
    const bar = el("progress");
    bar.max = max;
    bar.value = point.weekSold;
    bar.setAttribute("aria-label", `${date} 周销量`);
    row.append(el("span", date), bar, el("strong", format(point.weekSold)));
    chart.append(row);
  }
  return chart;
}

export function bindTemuPod({ getSettings, onBack }) {
  const dialog = el("dialog", null, "pod-dialog");
  dialog.setAttribute("aria-label", "Temu 选品与富图");
  dialog.innerHTML = `
    <header class="pod-header"><button type="button" class="pod-icon" data-part="back" aria-label="返回工作流">←</button>
      <h2>Temu 选品与富图</h2><button type="button" class="pod-icon" data-part="close" aria-label="关闭">×</button></header>
    <div class="pod-views" aria-label="选品与富图视图">
      <button type="button" class="secondary" data-part="research">市场选品</button>
      <button type="button" class="secondary" data-part="local">目录富图</button>
    </div>
    <main class="pod-body">
      <p class="hint" data-part="connection"></p>
      <section data-part="market">
        <form class="pod-form" data-part="search">
          <label class="field">男装关键词<input name="keyword" list="pod-keywords" type="search" required maxlength="140" value="men's hoodie"></label>
          <datalist id="pod-keywords"></datalist>
          <div class="pod-grid">
            <label class="field">站点<select name="site" aria-label="欧洲站点"></select></label>
            <label class="field">排序<select name="sort"><option value="sales">周销量</option><option value="growth">周增长率</option></select></label>
            <label class="field">最低周销量<input name="weekSoldMin" type="number" min="0" value="1"></label>
            <label class="field">最低周增长率（%）<input name="growth" type="number" step="any" placeholder="不限"></label>
          </div>
          <button type="submit" class="primary" data-part="searchButton">搜索商品</button>
        </form>
        <div class="pod-section-heading"><h3 data-part="resultsTitle">候选商品</h3><span data-part="resultCount"></span></div>
        <div class="pod-actions">
          <button type="button" class="secondary" data-part="analyze">AI 分析主图</button>
          <button type="button" class="primary" data-part="save">保存已勾选</button>
        </div>
        <div data-part="candidateList" class="pod-list"></div>
      </section>
      <section data-part="directory" hidden>
        <div class="pod-actions"><button type="button" class="secondary" data-part="choose">选择商品目录</button>
          <span data-part="directoryName" class="hint">未选择</span></div>
        <div class="pod-form">
          <label class="field">富图模型<select data-part="models"></select></label>
          <div class="pod-reference" data-part="reference"></div>
          <label class="field">编辑方式<select data-part="mode"><option value="print">新增或替换印花</option><option value="plain">去掉印花，生成纯色底图</option><option value="kit">生成商品套图与 SKC</option></select></label>
          <label class="field" data-part="strengthField">印花裂变幅度<select data-part="strength"><option value="standard">标准 · 保留原印花构图</option><option value="advanced">进阶 · 重新设计印花</option></select></label>
          <label class="field" data-part="themesField">原创印花主题（每行一个）
            <textarea rows="2" data-part="themes" maxlength="600" placeholder="例如伦敦河岸地图、纽约天际线"></textarea></label>
          <label class="field" data-part="referenceNotesField" hidden>参考图补充要求（可选）
            <textarea rows="2" data-part="referenceNotes" maxlength="600" placeholder="例如保留横向拼色，浅蓝色块放在胸口"></textarea></label>
          <div class="pod-kit-form" data-part="kitSettings" hidden>
            <div class="pod-grid">
              <label class="field">已有图的角度<select data-part="sourceView"></select></label>
              <label class="field">SKC 数量<input type="number" min="1" max="12" value="3" data-part="skcCount"></label>
            </div>
            <div class="pod-kit-switches">
              <label class="settings-switch"><input type="checkbox" role="switch" data-part="recolor" checked>改变颜色</label>
              <label class="settings-switch"><input type="checkbox" role="switch" data-part="redesign" checked>改变印花</label>
            </div>
            <label class="field" data-part="colorField">颜色（逗号分隔，可选）
              <input data-part="kitColors" maxlength="180" placeholder="例如黑色、浅粉色；留空自动配色"></label>
            <label class="field" data-part="baseColorField" hidden>底图颜色（可选）
              <input data-part="baseColor" maxlength="12" placeholder="例如黑色"></label>
            <label class="field" data-part="designField">印花（逗号分隔，可选）
              <input data-part="kitDesigns" maxlength="360" placeholder="留空按原图微调；填写后按指定主题改印花"></label>
            <label class="field">尺码（无尺码表时使用，可选）
              <input data-part="kitSizes" maxlength="150" placeholder="沿用商品尺码，缺失时默认 S、M、L、XL"></label>
          </div>
          <button type="button" class="primary" data-part="generate">批量富图</button>
        </div>
        <div data-part="localList" class="pod-list"></div>
      </section>
    </main><footer class="pod-footer">
      <div class="pod-progress" data-part="progressArea" hidden>
        <label for="pod-estimated-progress" data-part="progressText"></label>
        <progress id="pod-estimated-progress" data-part="progress" max="100"></progress>
      </div><p role="status" data-part="status"></p>
    </footer>`;
  const zoom = el("dialog", null, "pod-zoom");
  zoom.setAttribute("aria-label", "图片核对");
  document.body.append(dialog, zoom);
  const find = name => dialog.querySelector(`[data-part="${name}"]`);
  const search = find("search");
  for (const [value, label] of Object.entries(kitViews)) find("sourceView").append(new Option(label, value));
  for (const word of podKeywords) dialog.querySelector("datalist").append(new Option(word, word));
  const setStatus = value => { find("status").textContent = value; };
  let providerReady = false;
  let sites = [];
  let candidates = [];
  let local = [];
  let searchLabel = "候选商品";
  let styleReference;
  let busy = false;
  let view = "market";
  const previews = new WeakMap();

  function src(photo) {
    if (!photo || typeof photo === "string") return photo;
    if (!previews.has(photo)) previews.set(photo, URL.createObjectURL(photo));
    return previews.get(photo);
  }

  function magnify(items) {
    const header = el("div", null, "pod-section-heading");
    header.append(el("h3", "图片核对"), action("关闭", () => zoom.close()));
    zoom.replaceChildren(header);
    for (const [label, photo] of items) {
      if (!photo) continue;
      const figure = el("figure");
      const img = el("img");
      img.alt = label;
      img.src = src(photo);
      figure.append(el("figcaption", label), img);
      zoom.append(figure);
    }
    zoom.showModal();
  }

  function thumb(photo, label, onClick, large = false) {
    const imageClass = large ? " pod-large-img" : "";
    if (!photo) return el("span", "无图", "pod-empty-img" + imageClass);
    const node = el("button", null, "pod-thumb" + imageClass);
    node.type = "button";
    node.title = node.ariaLabel = label;
    const img = el("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = src(photo);
    node.append(img);
    node.addEventListener("click", onClick || (() => magnify([[label, photo]])));
    return node;
  }

  function selectReference(item) {
    if (styleReference?.id !== item.id || styleReference?.site?.siteId !== item.site.siteId) find("referenceNotes").value = "";
    styleReference = item;
    switchView("directory");
  }

  function switchView(next) {
    view = next;
    find("market").hidden = next !== "market";
    find("directory").hidden = next !== "directory";
    find("research").setAttribute("aria-pressed", String(next === "market"));
    find("local").setAttribute("aria-pressed", String(next === "directory"));
  }

  function selectedSite() {
    const site = sites.find(item => item.siteId === Number(search.elements.site.value));
    if (!site) throw new Error("尚未读取到欧洲站点。");
    return site;
  }

  async function loadSites() {
    if (sites.length || !providerReady) return;
    const { data } = await requestGeekbi("sites");
    sites = europeanSites(data);
    search.elements.site.replaceChildren(...sites.map(item => new Option(item.cnName, String(item.siteId))));
    const preferred = sites.find(item => item.name === "Germany");
    if (preferred) search.elements.site.value = String(preferred.siteId);
  }

  function activeModel() {
    const value = find("models").value;
    const ref = value ? JSON.parse(value) : null;
    return resolvePodImageModel(getSettings(), ref);
  }

  function refreshLimits() {
    find("searchButton").disabled = busy || !providerReady;
    find("analyze").disabled = busy || !candidates.some(candidate => candidate.selected && candidate.image);
    find("save").disabled = busy || !candidates.some(candidate => candidate.selected);
    find("generate").disabled = busy || !local.some(item => item.selected) || !activeModel()?.model;
    find("choose").disabled = busy;
  }

  async function execute(start, task, success) {
    if (busy) return;
    busy = true;
    setStatus(start);
    render();
    try {
      const summary = await task();
      setStatus(summary || success || "已完成。");
    } catch (error) {
      setStatus(error?.name === "AbortError" ? "已取消。" : error?.message || "暂时无法完成。");
    } finally { busy = false; render(); }
  }

  async function trackGeneration(label, tasks, run) {
    const running = new Map();
    let done = 0;
    const update = () => {
      const percent = estimatedPodProgress(done, [...running.values()], tasks.length, Date.now());
      find("progress").value = percent;
      find("progressText").textContent = `${label} · 预计 ${percent}% · 已处理 ${done}/${tasks.length}`;
    };
    const tracked = tasks.map((task, index) => ({ ...task, run: async () => {
      running.set(index, Date.now());
      update();
      try { return await task.run(); }
      finally { running.delete(index); done++; update(); }
    } }));
    find("progressArea").hidden = false;
    update();
    const timer = setInterval(update, 750);
    try { return await run(tracked); }
    finally { clearInterval(timer); find("progressArea").hidden = true; }
  }

  function listSearch(data, site, origin, cached) {
    candidates = normalizeCandidates(data.list, site).map(item => ({ ...item, selected: true }));
    searchLabel = origin;
    switchView("market");
    return `${cached ? "已读缓存" : "已查询"} · 本页 ${data.list?.length || 0} 条，筛出 ${candidates.length} 条男装候选。`;
  }

  function photoSearch(photo, label) {
    return execute("正在准备图搜…", async () => {
      await loadSites();
      const site = selectedSite();
      const { data, cached } = await requestGeekbi("image", imageSearchParams(site.siteId),
        await podImageData(await resizePodImage(photo)));
      return listSearch(data, site, `图搜 · ${label}`, cached);
    });
  }

  function detail(candidate) {
    return execute("正在读取商品详情…", async () => {
      const { data, cached } = await requestGeekbi("detail", { goodsId: candidate.id, regionId: candidate.site.regionId });
      candidate.detail = data;
      return cached ? "已读取详情缓存。" : "商品详情已读取。";
    });
  }

  function renderCandidates() {
    find("resultsTitle").textContent = searchLabel;
    const count = candidates.filter(item => item.selected).length;
    find("resultCount").textContent = candidates.length ? `已勾选 ${count}/${candidates.length}` : "";
    const grid = el("div", null, "pod-product-grid");
    const all = candidates.length ? check("勾选全部候选", count === candidates.length, selected => {
      for (const item of candidates) item.selected = selected;
      render();
    }) : null;
    for (const item of candidates) {
      const card = el("article", null, "pod-card");
      const head = el("div", null, "pod-card-head");
      const label = check(item.title, item.selected, checked => {
        item.selected = checked;
        refreshLimits();
        const checkedCount = candidates.filter(candidate => candidate.selected).length;
        find("resultCount").textContent = `已勾选 ${checkedCount}/${candidates.length}`;
        if (all) all.querySelector("input").checked = checkedCount === candidates.length;
      }, true);
      const origin = el("small", `${item.site.cnName} · ${item.id}`);
      origin.title = item.categories || origin.textContent;
      head.append(thumb(item.image, item.title, undefined, true), label, origin);
      const metrics = el("dl", null, "pod-metrics");
      for (const [name, value] of [["周销量", format(item.raw.weekSold)], ["周增长", pct(item.raw.weekSoldRate)],
        ["30 日销量", format(item.raw.monthSold)], ["最低价", item.raw.minPrice == null ? "—" : `${item.site.currency} ${format(item.raw.minPrice)}`]]) {
        const box = el("div"); box.append(el("dt", name), el("dd", value)); metrics.append(box);
      }
      card.append(head, metrics);
      if (item.review) card.append(el("p", [item.review.result, item.review.evidence, item.review.design].filter(Boolean).join(" · "), "pod-review"));
      if (item.error) card.append(el("p", item.error, "hint"));
      const options = el("div", null, "pod-actions");
      if (item.detail) {
        const details = el("details");
        details.open = true;
        details.append(el("summary", "详情与趋势"), historyChart(item.detail.history));
        const data = item.detail.goods || {};
        details.append(el("p", [data.description, data.brand, data.goodsNameCn].filter(Boolean).join(" · ") ||
          "本条详情主要提供销量、价格和历史。", "hint"));
        for (const image of [...(Array.isArray(data.images) ? data.images : []),
          ...(Array.isArray(data.detailImages) ? data.detailImages : []), data.sizeChartImage].filter(
          url => typeof url === "string" && /^https:\/\/(?:[a-z0-9.-]+\.)?kwcdn\.com\//iu.test(url))) {
          options.append(thumb(image, "详情图片"));
        }
        card.append(details);
      } else options.append(iconAction("detail", "查看详情", () => void detail(item), { disabled: busy || !providerReady }));
      if (item.image) options.append(iconAction("reference", "设为印花参考", () => void execute("正在读取市场参考图…", async () => {
        await requirePodHost(item.image);
        const photo = await resizePodImage(await readPodCdn(item.image), 900);
        selectReference({ ...item, photo });
      }), { disabled: busy }), iconAction("base", "加为商品底图", () => void execute("正在加载参考图…", async () => {
        const product = productForCandidate(item);
        await requirePodHost(item.image);
        const photo = await readPodCdn(item.image);
        const size = product.sizeChartImage ? await readPodCdn(product.sizeChartImage).catch(() => null) : null;
        local.push({ name: item.title, photo, product, size, selected: true, artworks: [] });
        switchView("directory");
      }), { disabled: busy }));
      card.append(options);
      grid.append(card);
    }
    find("candidateList").replaceChildren(...(all ? [all, grid] : []));
  }

  function generate(items) {
    if (find("mode").value === "kit") return generateKits(items);
    return execute("正在开始富图…", async () => {
      const mode = find("mode").value;
      const trend = mode === "print" && styleReference;
      const themes = mode === "plain" ? ["纯色底图"] : trend
        ? [find("referenceNotes").value.trim()]
        : [...new Set(find("themes").value.split(/\n/u).map(value => value.trim()).filter(Boolean))].slice(0, 5);
      if (!themes.length) throw new Error("请选择一个市场印花参考，或输入原创印花主题。");
      const model = activeModel();
      const strength = find("strength").value;
      await requirePodHost(model.baseUrl);
      const referencePhoto = trend?.photo;
      const evidence = trend ? {
        id: trend.id, title: trend.title, site: trend.site.cnName, weekSold: trend.raw.weekSold,
        weekSoldRate: trend.raw.weekSoldRate, url: trend.url || productForCandidate(trend).source.url,
      } : undefined;
      const tasks = items.flatMap(item => themes.map(theme => ({ run: async () => {
        const photo = await generatePodImage(model, await resizePodImage(item.photo), theme, mode, { strength, referencePhoto });
        const artwork = { photo, theme: theme || "参考图富图", model: model.model, approved: false, evidence, referencePhoto };
        item.artworks.push(artwork);
        try { artwork.check = await compare(item, artwork); }
        catch (error) { artwork.error = error.message; }
        return artwork;
      } })));
      const results = await trackGeneration("富图与核对", tasks, tracked => mapPodJobs(tracked, 3, task => task.run()));
      const failed = results.filter(result => result.error);
      return `已生成 ${results.length - failed.length} 张，待人工核对。${failed.length ? ` ${failed.length} 张失败：${failed[0].error}` : ""}`;
    });
  }
  function generateKits(items, retry = false) {
    return execute(retry ? "正在重试未完成素材…" : "正在准备商品套图…", async () => {
      const model = activeModel();
      await requirePodHost(model.baseUrl);
      const settings = getSettings();
      const vision = resolveSizeChartModel(settings) ?? settings.text;
      const plan = retry ? null : makeKitPlan({
        source: find("sourceView").value, count: Number(find("skcCount").value),
        recolor: find("recolor").checked, redesign: find("redesign").checked,
        originalColor: find("baseColor").value, colorList: find("kitColors").value,
        designList: find("kitDesigns").value, sizeList: find("kitSizes").value,
      });
      if (vision?.baseUrl) await requireHostUrl(vision.baseUrl, { interactive: false });
      const tasks = items.flatMap(item => {
        if (!retry) item.kit = createKit(item, plan);
        item.kit.reviewed = false;
        return kitTasks(item, item.kit, model, settings);
      });
      if (!tasks.length) return "图片和尺码表都已生成。";
      const results = await trackGeneration("生成套图与尺码", tasks, runKitTasks);
      const failed = results.filter(result => result.error).length;
      return `已处理 ${items.length} 件商品 · 完成 ${results.length - failed}/${results.length} 项${failed ? ` · ${failed} 项待重试` : " · 请核对套图与尺码"}。`;
    });
  }

  function chooseKitSize(item) {
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.onchange = () => {
      const photo = file.files[0];
      if (!photo) return;
      item.size = photo;
      item.sizeOverride = true;
      item.kit.size = undefined;
      item.kit.sizesReviewed = false;
      void generateKits([item], true);
    };
    file.click();
  }

  function saveKit(item) {
    return execute("请选择套图保存目录…", async () => {
      const folder = await window.showDirectoryPicker({ id: "pagelens-pod-output", mode: "readwrite" });
      const name = await saveProductKit(folder, item, item.kit);
      return `已保存到 ${folder.name}/${name}。${item.kit.size ? "" : "尺码表仍待补充。"}`;
    });
  }

  function renderKit(item) {
    const kit = item.kit;
    const area = el("div", null, "pod-artwork");
    area.append(el("strong", "商品套图"));
    const images = el("div", null, "pod-kit-photos");
    for (const [key, label] of Object.entries(kitViews)) {
      const tile = el("figure");
      tile.append(thumb(kit.photos[key], label, undefined, true), el("figcaption", label));
      images.append(tile);
    }
    area.append(images, el("strong", `SKC · ${kit.variants.length} 款`));
    const variants = el("div", null, "pod-kit-photos");
    for (const variant of kit.variants) {
      const tile = el("figure");
      const name = el("figcaption", variant.label);
      name.title = variant.label;
      tile.append(thumb(variant.photo, variant.label, undefined, true), name);
      variants.append(tile);
    }
    area.append(variants, el("p", "除 SKC 主图外，其余三张共用原款图。生成的未见角度及细节需对照实物。", "hint"));
    if (new Set(kit.variants.map(variant => variant.color)).size !== kit.variants.length) {
      area.append(el("p", "同色印花保留为独立 SKC。Temu 类目若要求色值唯一，试填时需先为这些款式分配不同的有效规格。", "hint"));
    }
    if (kit.size) {
      const details = el("details");
      const { chart, source } = kit.size;
      const label = { structured: "商品资料", image: "AI 解析", estimated: "AI 估算 · 待核" }[source];
      details.append(el("summary", `尺码表 · ${label} · ${chart.unit} · ${chart.rows.length} 行`));
      const scroll = el("div", null, "pod-kit-size-scroll");
      const table = el("table");
      const head = el("thead");
      const headings = el("tr");
      for (const column of chart.columns) headings.append(el("th", column));
      head.append(headings);
      const body = el("tbody");
      for (const values of chart.rows) {
        const row = el("tr");
        for (const column of chart.columns) row.append(el("td", values[column]));
        body.append(row);
      }
      table.append(head, body);
      scroll.append(table);
      details.append(scroll);
      if (source === "estimated") details.append(check("已核对估算尺码", kit.sizesReviewed, value => {
        kit.sizesReviewed = value;
        updateSave();
      }));
      area.append(details);
    } else area.append(el("p", "尺码表待补充。", "hint"));
    for (const [key, error] of Object.entries(kit.errors)) area.append(el("p", `${kitViews[key] || (key === "size" ? "尺码表" : key.toUpperCase())} · ${error}`, "hint"));
    const controls = el("div", null, "pod-actions");
    const complete = Object.keys(kitViews).every(key => kit.photos[key]) && kit.variants.every(variant => variant.photo);
    const save = iconAction("save", "保存商品套图", () => void saveKit(item), { primary: true });
    const updateSave = () => { save.disabled = busy || !complete || !kit.reviewed || kit.size?.source === "estimated" && !kit.sizesReviewed; };
    updateSave();
    if (Object.keys(kit.errors).length) controls.append(action("重试缺项", () => void generateKits([item], true), { disabled: busy }));
    controls.append(action("选择尺码图", () => chooseKitSize(item), { disabled: busy }));
    if (complete) controls.append(check("已核对套图", kit.reviewed, value => { kit.reviewed = value; updateSave(); }));
    controls.append(save);
    area.append(controls);
    return area;
  }

  async function compare(item, artwork) {
    const sources = [item.photo, artwork.photo];
    if (artwork.referencePhoto) sources.push(artwork.referencePhoto);
    const photos = await Promise.all(sources.map(photo => resizePodImage(photo, 1050)));
    return reviewPod(getSettings(), { prompt: imageCheckPrompt(artwork.theme, { hasReference: Boolean(artwork.referencePhoto) }), photos });
  }

  function checkExisting(item) {
    const file = el("input");
    file.type = "file";
    file.accept = "image/*";
    file.onchange = () => {
      const photo = file.files[0];
      if (!photo) return;
      void execute("正在核对已有图…", async () => {
        const artwork = { photo, theme: photo.name.replace(/\.[^.]+$/u, ""), approved: false };
        item.artworks.push(artwork);
        try { artwork.check = await compare(item, artwork); }
        catch (error) { artwork.error = error.message; }
        return "请核对原图和对照图。";
      });
    };
    file.click();
  }

  function saveArt(item, artwork) {
    return execute("请选择保存目录…", async () => {
      const folder = await window.showDirectoryPicker({ id: "pagelens-pod-output", mode: "readwrite" });
      const name = await saveArtwork(folder, item, artwork);
      return `已保存到 ${folder.name}/${name}。`;
    });
  }

  function renderLocal() {
    const grid = el("div", null, "pod-product-grid");
    const all = local.length ? check("勾选全部商品", local.every(item => item.selected), value => {
      for (const item of local) item.selected = value;
      render();
    }) : null;
    for (const item of local) {
      const card = el("article", null, "pod-card");
      const head = el("div", null, "pod-card-head");
      head.append(thumb(item.photo, item.name, undefined, true), check(item.name, item.selected, value => {
        item.selected = value;
        if (all) all.querySelector("input").checked = local.every(product => product.selected);
        refreshLimits();
      }, true));
      const options = el("div", null, "pod-actions");
      options.append(iconAction("generate", "富图", () => void generate([item]), { disabled: busy || !activeModel()?.model }),
        iconAction("search", "原图找同款", () => void photoSearch(item.photo, item.name), { disabled: busy || !providerReady }),
        iconAction("check", "检查已有图", () => checkExisting(item), { disabled: busy }));
      const evidence = item.product?.marketResearch;
      if (evidence?.site?.cnName && evidence.market?.goodsId) {
        options.append(iconAction("reference", "设为印花参考", () => void execute("正在准备本地市场参考…", async () => {
          selectReference({ id: evidence.market.goodsId, title: item.name, site: evidence.site, raw: evidence.market,
            image: item.photo, photo: await resizePodImage(item.photo, 900), url: item.product.source?.url });
          item.selected = false;
        }), { disabled: busy }));
      }
      card.append(head, options);
      if (item.kit) card.append(renderKit(item));
      for (const image of item.artworks) {
        const area = el("div", null, "pod-artwork");
        const title = el("div", null, "pod-card-head");
        title.append(thumb(image.photo, image.theme, () => magnify([["原图", item.photo],
          ["印花参考", image.referencePhoto], [image.theme, image.photo]]), true),
          el("strong", image.theme));
        area.append(title);
        if (image.evidence) area.append(el("p", `市场依据 · ${image.evidence.site} · 周销量 ${format(image.evidence.weekSold)}`, "hint"));
        if (image.check) area.append(el("p", [image.check.result, image.check.evidence].join(" · "), "pod-review"));
        if (image.error) area.append(el("p", image.error, "hint"));
        const controls = el("div", null, "pod-actions");
        const approval = check("已人工核对", image.approved, value => { image.approved = value; renderLocal(); });
        controls.append(
          iconAction("check", "AI 复核", () => void execute("正在核对商品图…", async () => {
            image.check = await compare(item, image); image.error = "";
          }), { disabled: busy }),
          iconAction("search", "富图找同款", () => void photoSearch(image.photo, image.theme), { disabled: busy || !providerReady }),
          approval,
          iconAction("save", "保存", () => void saveArt(item, image), { disabled: busy || !image.approved, primary: true }));
        if (image.theme === "纯色底图") controls.append(iconAction("base", "用作新底图", () => {
          local.push({ ...item, photo: image.photo, artworks: [], selected: true });
          render();
        }, { disabled: busy || !image.approved }));
        area.append(controls);
        card.append(area);
      }
      grid.append(card);
    }
    find("localList").replaceChildren(...(all ? [all, grid] : []));
  }

  function render() {
    find("connection").textContent = providerReady ? "" : "极鲸云未启用，搜索、图搜和详情不可用。可在高级配置中启用。";
    const reference = find("reference");
    reference.replaceChildren(el("strong", "市场印花参考"));
    if (styleReference) {
      const item = styleReference;
      const preview = el("div", null, "pod-reference-preview");
      const label = el("div", null, "pod-reference-label");
      const title = el("span", item.title);
      title.title = item.title;
      label.append(title, el("small", `${item.site.cnName} · 周销量 ${format(item.raw.weekSold)}`));
      preview.append(thumb(item.image, item.title), label,
        iconAction("clear", "清除参考", () => { styleReference = undefined; render(); }, { disabled: busy }));
      reference.append(preview);
    } else reference.append(el("small", "可以在市场选品结果中指定一件参考款。"));
    const mode = find("mode").value;
    for (const key of ["reference", "strengthField"]) find(key).hidden = mode !== "print";
    find("themesField").hidden = mode !== "print" || Boolean(styleReference);
    find("referenceNotesField").hidden = mode !== "print" || !styleReference;
    find("kitSettings").hidden = mode !== "kit";
    find("generate").textContent = mode === "kit" ? "批量生成商品套图" : "批量富图";
    find("colorField").hidden = !find("recolor").checked;
    find("baseColorField").hidden = find("recolor").checked;
    find("designField").hidden = !find("redesign").checked;
    find("skcCount").disabled = busy || !find("recolor").checked && !find("redesign").checked;
    for (const key of ["mode", "models", "sourceView", "recolor", "redesign", "kitColors", "baseColor", "kitDesigns", "kitSizes"]) {
      find(key).disabled = busy;
    }
    refreshLimits();
    renderCandidates();
    renderLocal();
  }

  find("back").onclick = () => { dialog.close(); onBack?.(); };
  find("close").onclick = () => dialog.close();
  find("research").onclick = () => switchView("market");
  find("local").onclick = () => switchView("directory");
  search.onsubmit = event => {
    event.preventDefault();
    void execute("正在查询欧洲站商品…", async () => {
      await loadSites();
      const site = selectedSite();
      const fields = Object.fromEntries(new FormData(search));
      const { data, cached } = await requestGeekbi("search", sourcingParams({ ...fields, siteId: site.siteId }));
      return listSearch(data, site, `关键词 · ${fields.keyword}`, cached);
    });
  };
  find("analyze").onclick = () => void execute("正在分析男装主图…", async () => {
    const selected = candidates.filter(item => item.selected && item.image);
    await requirePodHost(selected[0]?.image);
    const results = await mapPodJobs(selected, 4, async item => {
      item.review = await reviewPod(getSettings(), { prompt: candidateReviewPrompt(item),
        photos: [await resizePodImage(await readPodCdn(item.image), 900)] });
      item.error = "";
      if (item.review.result === "不适合") item.selected = false;
    }, (done, total) => setStatus(`AI 分析 ${done}/${total}`));
    results.forEach((result, index) => { if (result.error) selected[index].error = result.error; });
    return `已分析 ${results.filter(result => !result.error).length} 件，请核对照片和勾选项。`;
  });
  find("save").onclick = () => void execute("请选择导出目录…", async () => {
    const firstImage = candidates.find(item => item.selected && item.image)?.image;
    const folder = await window.showDirectoryPicker({ id: "pagelens-pod-output", mode: "readwrite" });
    if (firstImage) await requireHostUrl(firstImage, { interactive: false });
    const results = await mapPodJobs(candidates.filter(item => item.selected), 3, item => saveCandidate(folder, item));
    const saved = results.filter(item => item.value).length;
    const incomplete = results.filter(item => item.value?.failed.length).length;
    return `已保存 ${saved} 件到 ${folder.name}。${incomplete ? ` ${incomplete} 件有图片下载失败。` : ""}${saved < results.length ? ` ${results.length - saved} 件写入失败。` : ""}`;
  });
  find("choose").onclick = () => void execute("请选择参考图或商品目录…", async () => {
    const folder = await window.showDirectoryPicker({ id: "pagelens-pod-input", mode: "read" });
    const items = await readPodDirectory(folder);
    for (const item of local) for (const photo of [item.photo, ...item.artworks.map(artwork => artwork.photo),
      ...Object.values(item.kit?.photos || {}), ...(item.kit?.variants || []).map(variant => variant.photo)]) {
      if (previews.has(photo)) { URL.revokeObjectURL(previews.get(photo)); previews.delete(photo); }
    }
    local = items.map(item => ({ ...item, selected: true, artworks: [] }));
    find("directoryName").textContent = `${folder.name} · ${local.length} 件`;
    return local.length ? "" : "目录没有可读的商品图。";
  });
  find("mode").onchange = render;
  find("recolor").onchange = render;
  find("redesign").onchange = render;
  find("models").onchange = () => {
    const value = find("models").value;
    void chrome.storage.local.set({ [podImagePreference]: value });
    render();
  };
  find("generate").onclick = () => {
    const products = local.filter(item => item.selected);
    if (!products.length) { setStatus("请勾选要富图的商品。"); return; }
    void generate(products);
  };

  return async () => {
    const settings = await chrome.storage.local.get([geekbiSettingsKey, podImagePreference]);
    const connected = geekbiConfigured(settings[geekbiSettingsKey]);
    if (providerReady !== connected) sites = [];
    providerReady = connected;
    const models = find("models");
    const current = getSettings().text?.model;
    models.replaceChildren(new Option(current ? `当前模型 · ${current}` : "请在设置中配置图片模型", ""),
      ...imageChoices(getSettings()).map(({ providerId, modelId, name }) =>
        new Option(name, JSON.stringify({ providerId, modelId }))));
    const saved = settings[podImagePreference];
    if (Array.from(models.options).some(item => item.value === saved)) models.value = saved;
    switchView(view);
    render();
    if (!dialog.open) dialog.showModal();
    if (providerReady && !sites.length && !busy) void execute("正在读取欧洲站点…", loadSites);
    return true;
  };
}
