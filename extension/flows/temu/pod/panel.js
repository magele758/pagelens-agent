import { requireHostUrl } from "../../../lib/optional-permissions.js";
import { geekbiSettingsKey, geekbiConfigured } from "../../../integrations/geekbi/client.js";
import { requestGeekbi } from "../../../integrations/geekbi/runtime.js";
import { europeanSites, sourcingParams, imageSearchParams, normalizeCandidates, podKeywords, reviewPod,
  candidateReviewPrompt, imageCheckPrompt, readPodCdn, resizePodImage, podImageData, productForCandidate, saveCandidate, mapPodJobs } from "./service.js";
import { generatePodImage, imageChoices, podImagePreference, resolvePodImageModel } from "./image-model.js";
import { readPodDirectory, saveArtwork } from "./directory.js";

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
function check(label, value, change) {
  const wrap = el("label", null, "pod-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => change(input.checked));
  wrap.append(input, document.createTextNode(label));
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
          <label class="field">编辑方式<select data-part="mode"><option value="print">新增或替换印花</option><option value="plain">去掉印花，生成纯色底图</option></select></label>
          <label class="field" data-part="themesField">原创印花主题（每行一个）
            <textarea rows="2" data-part="themes" maxlength="600" placeholder="例如伦敦河岸地图、纽约天际线"></textarea></label>
          <button type="button" class="primary" data-part="generate">批量富图</button>
        </div>
        <div data-part="localList" class="pod-list"></div>
      </section>
    </main><footer class="pod-footer"><p role="status" data-part="status"></p></footer>`;
  const zoom = el("dialog", null, "pod-zoom");
  zoom.setAttribute("aria-label", "图片核对");
  document.body.append(dialog, zoom);
  const find = name => dialog.querySelector(`[data-part="${name}"]`);
  const search = find("search");
  for (const word of podKeywords) dialog.querySelector("datalist").append(new Option(word, word));
  const setStatus = value => { find("status").textContent = value; };
  let providerReady = false;
  let sites = [];
  let candidates = [];
  let local = [];
  let searchLabel = "候选商品";
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

  function thumb(photo, label, onClick) {
    if (!photo) return el("span", "无图", "pod-empty-img");
    const node = el("button", null, "pod-thumb");
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
    find("generate").disabled = busy || !local.length || !activeModel()?.model;
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
    const cards = [];
    if (candidates.length) cards.push(check("勾选全部候选", count === candidates.length, selected => {
      for (const item of candidates) item.selected = selected;
      render();
    }));
    for (const item of candidates) {
      const card = el("article", null, "pod-card");
      const head = el("div", null, "pod-card-head");
      head.append(thumb(item.image, item.title));
      const title = el("div");
      const label = check(item.title, item.selected, checked => { item.selected = checked; refreshLimits(); find("resultCount").textContent =
        `已勾选 ${candidates.filter(candidate => candidate.selected).length}/${candidates.length}`; });
      title.append(label, el("small", item.categories || `${item.site.cnName} · ${item.id}`));
      head.append(title);
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
      } else options.append(action("查看详情", () => void detail(item), { disabled: busy || !providerReady }));
      if (item.image) options.append(action("加入富图", () => void execute("正在加载参考图…", async () => {
        const product = productForCandidate(item);
        await requirePodHost(item.image);
        const photo = await readPodCdn(item.image);
        const size = product.sizeChartImage ? await readPodCdn(product.sizeChartImage).catch(() => null) : null;
        local.push({ name: item.title, photo, product, size, selected: true, artworks: [] });
        switchView("directory");
      }), { disabled: busy }));
      card.append(options);
      cards.push(card);
    }
    find("candidateList").replaceChildren(...cards);
  }

  function generate(items) {
    return execute("正在开始富图…", async () => {
      const mode = find("mode").value;
      const themes = mode === "plain" ? ["纯色底图"] : [...new Set(find("themes").value.split(/\n/u).map(value => value.trim()).filter(Boolean))].slice(0, 5);
      if (!themes.length) throw new Error("请输入至少一个原创印花主题。");
      const model = activeModel();
      await requirePodHost(model.baseUrl);
      const tasks = items.flatMap(item => themes.map(theme => ({ item, theme })));
      const results = await mapPodJobs(tasks, 3, async ({ item, theme }) => {
        const photo = await generatePodImage(model, await resizePodImage(item.photo), theme, mode);
        const artwork = { photo, theme, model: model.model, approved: false };
        item.artworks.push(artwork);
        try { artwork.check = await compare(item, artwork); }
        catch (error) { artwork.error = error.message; }
        return artwork;
      }, (done, total) => setStatus(`富图与核对 ${done}/${total}`));
      const failed = results.filter(result => result.error);
      return `已生成 ${results.length - failed.length} 张，待人工核对。${failed.length ? ` ${failed.length} 张失败：${failed[0].error}` : ""}`;
    });
  }
  async function compare(item, artwork) {
    const photos = await Promise.all([item.photo, artwork.photo].map(photo => resizePodImage(photo, 1050)));
    return reviewPod(getSettings(), { prompt: imageCheckPrompt(artwork.theme), photos });
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
    const cards = [];
    if (local.length) cards.push(check("勾选全部商品", local.every(item => item.selected), value => {
      for (const item of local) item.selected = value;
      render();
    }));
    for (const item of local) {
      const card = el("article", null, "pod-card");
      const head = el("div", null, "pod-card-head");
      head.append(thumb(item.photo, item.name), check(item.name, item.selected, value => { item.selected = value; }));
      const options = el("div", null, "pod-actions");
      options.append(action("富图", () => void generate([item]), { disabled: busy || !activeModel()?.model }),
        action("原图找同款", () => void photoSearch(item.photo, item.name), { disabled: busy || !providerReady }),
        action("检查已有图", () => checkExisting(item), { disabled: busy }));
      card.append(head, options);
      for (const image of item.artworks) {
        const area = el("div", null, "pod-artwork");
        const title = el("div", null, "pod-card-head");
        title.append(thumb(image.photo, image.theme, () => magnify([["原图", item.photo], [image.theme, image.photo]])),
          el("strong", image.theme));
        area.append(title);
        if (image.check) area.append(el("p", [image.check.result, image.check.evidence].join(" · "), "pod-review"));
        if (image.error) area.append(el("p", image.error, "hint"));
        const controls = el("div", null, "pod-actions");
        const approval = check("已人工核对", image.approved, value => { image.approved = value; renderLocal(); });
        controls.append(
          action("AI 复核", () => void execute("正在核对两张图片…", async () => {
            image.check = await compare(item, image); image.error = "";
          }), { disabled: busy }),
          action("富图找同款", () => void photoSearch(image.photo, image.theme), { disabled: busy || !providerReady }),
          approval,
          action("保存", () => void saveArt(item, image), { disabled: busy || !image.approved, primary: true }));
        if (image.theme === "纯色底图") controls.append(action("用作新底图", () => {
          local.push({ ...item, photo: image.photo, artworks: [], selected: true });
          render();
        }, { disabled: busy || !image.approved }));
        area.append(controls);
        card.append(area);
      }
      cards.push(card);
    }
    find("localList").replaceChildren(...cards);
  }

  function render() {
    find("connection").textContent = providerReady ? "" : "极鲸云未启用，搜索、图搜和详情不可用。可在高级配置中启用。";
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
    for (const item of local) for (const photo of [item.photo, ...item.artworks.map(artwork => artwork.photo)]) {
      if (previews.has(photo)) { URL.revokeObjectURL(previews.get(photo)); previews.delete(photo); }
    }
    local = items.map(item => ({ ...item, selected: true, artworks: [] }));
    find("directoryName").textContent = `${folder.name} · ${local.length} 件`;
    return local.length ? "" : "目录没有可读的商品图。";
  });
  find("mode").onchange = () => { find("themesField").hidden = find("mode").value === "plain"; };
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
