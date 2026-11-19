import { sheinCategoryPage } from "./category-page.js";
import { sheinEditorPage } from "./editor-page.js";
import { sheinVariantPage } from "./variant-page.js";
import { sheinRowsPage } from "./rows-page.js";
import { sheinStockPage } from "./stock-page.js";

const sellerOrigin = "https://sellerhub.shein.com";
export const sheinCategoryUrl = sellerOrigin + "/#/spmc/commodities-category/followsales-pro/list?externalSystem=spmp&last_page=page_commodities_list";
const editorPath = "/spmp/commoditiesInfo";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (code, message) => ({ ok: false, code, message });
const clean = value => typeof value === "string" ? value.trim() :
  typeof value === "number" && Number.isFinite(value) ? String(value) : "";
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const english = value => /[a-z]/iu.test(clean(value)) && !/\p{Script=Han}/u.test(clean(value)) ? clean(value) : "";
const key = value => clean(value).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const optionKey = value => ({ color: "颜色", colour: "颜色", size: "尺码" })[key(value)] || key(value);

function route(href) {
  try {
    const parsed = new URL(href);
    if (parsed.origin !== sellerOrigin || parsed.username || parsed.password || parsed.pathname !== "/") return "";
    const [path, query] = parsed.hash.slice(1).split("?");
    if (["/spmc/commodities-category/followsales-pro/list", "/spmp/commoditiesCategory/followsales-pro/list"].includes(path)) return "category";
    if (path === editorPath && new URLSearchParams(query).get("mode") === "add") return "editor";
    if (path === editorPath + "/add") return "opening";
    return "seller";
  } catch {
    return "";
  }
}

export function normalizeSheinListingInput(raw) {
  const seller = object(raw?.shein);
  const path = seller.categoryPath ?? raw?.categoryPath;
  const categoryPath = (Array.isArray(path) ? path : clean(path).split(/[>›＞]/u)).map(clean).filter(Boolean);
  const origin = clean(seller.origin ?? raw?.origin?.country ?? raw?.origin ?? raw?.countryOfOrigin);
  const brand = clean(seller.brand);
  const groups = seller.variantGroups ?? raw?.variantGroups ?? (raw?.variant?.name ? [raw.variant] : []);
  const variantGroups = array(groups).flatMap(group => {
    const name = clean(group?.name);
    const options = array(group?.options).flatMap(option => {
      const source = clean(option?.value ?? option?.name ?? option);
      const value = clean(option?.sheinValue) || source;
      return value ? [{ value, source, imagePath: clean(option?.imagePath) }] : [];
    });
    return name && options.length ? [{ name, options }] : [];
  });
  const suppliedSkus = array(seller.skus ?? raw?.skus);
  const packaging = object(seller.package ?? raw?.package);
  const skus = suppliedSkus.map(row => {
    const byName = new Map(Object.entries(object(row?.options)).map(([name, value]) => [optionKey(name), clean(value)]));
    const options = Array.isArray(row?.options) ? row.options.map(clean) : variantGroups.map(group => {
      const source = byName.get(optionKey(group.name));
      return group.options.find(option => key(option.source) === key(source))?.value || source || "";
    });
    return { options, sellerSku: clean(row?.sellerSku ?? row?.sku), priceUsd: clean(row?.priceUsd ?? seller.priceUsd),
      quantity: row?.quantity ?? row?.stock, siteLabel: clean(row?.stockSite),
      weightG: clean(row?.weightG ?? packaging.weightG), lengthCm: clean(row?.lengthCm ?? packaging.lengthCm),
      widthCm: clean(row?.widthCm ?? packaging.widthCm), heightCm: clean(row?.heightCm ?? packaging.heightCm),
      imagePath: clean(row?.imagePath) };
  });
  if (!skus.length && variantGroups.length && variantGroups.every(group => group.options.length === 1)) {
    skus.push({ options: variantGroups.map(group => group.options[0].value), sellerSku: clean(seller.skuCode),
      priceUsd: clean(seller.priceUsd), quantity: seller.quantity, siteLabel: clean(seller.stockSite), ...packaging });
  }
  return {
    englishTitle: clean(seller.englishTitle ?? raw?.englishTitle) || english(raw?.title),
    englishDescription: clean(seller.englishDescription ?? raw?.englishDescription) || english(raw?.description),
    sellerSku: clean(seller.sellerSku ?? seller.supplierCode ?? raw?.sellerSku ?? raw?.sku),
    origin: /^(?:进口|imported|unknown|未知)$/iu.test(origin) ? "" : origin,
    brand: /^(?:无品牌|nobrand|unbranded)$/iu.test(brand) ? "" : brand,
    categoryPath,
    attributes: { ...object(raw?.attributes), ...object(seller.attributes) },
    variantGroups, skus, sites: array(seller.sites).map(clean).filter(Boolean), dimensions: object(seller.dimensions),
  };
}

function pageOption(value, group) {
  return group?.matches?.find(match => key(match.requested) === key(value))?.value ||
    group?.values?.find(name => key(name) === key(value)) || value;
}

async function encodeImage({ file, name }) {
  if (!file?.size || file.size > 8 * 1024 * 1024 || !/^image\/(?:jpeg|png)$/u.test(file.type)) {
    throw new Error("请使用 8 MB 以内的 JPEG 或 PNG 图片。");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return { name: name || file.name, type: file.type, base64: btoa(binary) };
}

function requireTab(tab, expected) {
  if (!Number.isInteger(tab?.id) || !route(tab.url) || tab.active === false || expected && tab.url !== expected) {
    throw new Error("当前 SHEIN 标签或页面已切换，请在目标页重新试填。");
  }
  return tab;
}

async function currentTab(tabId, expected, api, signal) {
  signal?.throwIfAborted();
  const tab = requireTab(await api.tabs.get(tabId), expected);
  signal?.throwIfAborted();
  return tab;
}

async function pageCall(api, tab, func, request, signal) {
  await currentTab(tab.id, tab.url, api, signal);
  const [entry] = await api.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    func,
    args: [{ ...request, href: tab.url }],
  });
  signal?.throwIfAborted();
  return entry?.result ?? fail("NO_PAGE_RESULT", "未收到 SHEIN 页面返回结果。");
}

async function waitForPage(api, tabId, stage, signal, fallback) {
  const deadline = Date.now() + 12000;
  do {
    signal?.throwIfAborted();
    const tab = await api.tabs.get(tabId);
    if (tab?.active === false || tab?.url && !["about:blank", "chrome://newtab/"].includes(tab.url) && !route(tab.url)) {
      throw new Error("SHEIN 标签已切换或已退出登录，请返回卖家后台重试。");
    }
    if (route(tab?.url) === stage && tab.status !== "loading") {
      return requireTab(tab);
    }
    await wait(120);
  } while (Date.now() < deadline);
  throw new Error(fallback);
}

async function editorCall(api, tab, request, signal) {
  const deadline = Date.now() + 8000;
  do {
    const result = await pageCall(api, tab, sheinEditorPage, request, signal);
    if (result.code !== "EDITOR_NOT_READY" || Date.now() >= deadline) return result;
    await wait(150);
  } while (true);
}

export async function openSheinListingEditor({ tabId, url, signal, useActiveTab = false, api = chrome } = {}) {
  const tab = await currentTab(tabId, url, api, signal);
  if (["category", "editor"].includes(route(tab.url))) {
    return { ok: true, stage: route(tab.url), tabId, url: tab.url };
  }
  const created = useActiveTab ? await api.tabs.update(tabId, { url: sheinCategoryUrl }) :
    await api.tabs.create({ url: sheinCategoryUrl, openerTabId: tabId, active: true });
  const next = await waitForPage(api, created.id, "category", signal, "未能打开 SHEIN 商品发布分类页。");
  return { ok: true, stage: "category", tabId: next.id, url: next.url, message: "已打开 SHEIN 商品发布分类页。" };
}

export async function inspectSheinListing({ tabId, url, signal, api = chrome } = {}) {
  const tab = await currentTab(tabId, url, api, signal);
  const stage = route(tab.url);
  if (stage === "category") return { ...await pageCall(api, tab, sheinCategoryPage, { kind: "inspect" }, signal), stage };
  if (stage === "editor") return { ...await editorCall(api, tab, { kind: "inspect" }, signal), stage };
  return fail("WORKFLOW_PAGE_REQUIRED", "请先打开 SHEIN 商品发布页，再读取当前分类或表单。");
}

export async function replaySheinListing({ tabId, url, input, images = [], signal, onStep, useActiveTab, api = chrome } = {}) {
  const product = normalizeSheinListingInput(input);
  const report = label => onStep?.({ label });
  const fields = [];
  const items = [];
  const issues = [];
  let tab = await currentTab(tabId, url, api, signal);
  const outcome = (error, label) => {
    if (error) issues.push({ label, code: error.code, message: error.message });
    return { ok: !error, url: tab.url, fields, items, issues };
  };

  if (!["category", "editor"].includes(route(tab.url))) {
    report("打开 SHEIN 商品发布分类页");
    const opened = await openSheinListingEditor({ tabId, url, signal, useActiveTab, api });
    if (!opened.ok) return outcome(opened, "商品发布");
    tab = await currentTab(opened.tabId, opened.url, api, signal);
  }
  if (route(tab.url) === "category") {
    report("核对 SHEIN 商品类目");
    const expected = { categoryPath: product.categoryPath, brand: product.brand };
    const category = await pageCall(api, tab, sheinCategoryPage, {
      ...expected, kind: product.categoryPath.length ? "select" : "inspect",
    }, signal);
    if (!category.ok) return outcome(category, "商品类目");
    if (!category.selectedPath?.length || !category.canAdvance) {
      return outcome(fail("CATEGORY_NOT_CONFIRMED", "请在 SHEIN 选择末级类目，或在 PageLens 填写完整分类路径。"), "商品类目");
    }
    const advanced = await pageCall(api, tab, sheinCategoryPage, { ...expected, kind: "advance" }, signal);
    if (!advanced.ok) return outcome(advanced, "商品类目");
    tab = await waitForPage(api, tab.id, "editor", signal, "SHEIN 未进入发布表单，请核对类目和品牌。");
    product.categoryPath = category.selectedPath;
    items.push({ label: category.selectedPath.join(" › "), status: "verified" });
  } else if (!product.categoryPath.length) {
    const current = await editorCall(api, tab, { kind: "inspect" }, signal);
    if (!current.ok) return outcome(current, "商品类目");
    product.categoryPath = current.categoryPath || [];
  }
  report("试填基础信息和当前类目属性");
  const result = await editorCall(api, tab, { kind: "fill", input: product }, signal);
  if (!result.ok) return outcome(result, "商品表单");
  fields.push(...result.fields || []);
  items.push(...result.items || []);
  issues.push(...result.issues || []);
  for (const field of fields.filter(field => field.required && !field.value?.length)) {
    if (!issues.some(issue => issue.label === field.label)) issues.push({ label: field.label, code: "REQUIRED", message: "待填" });
  }
  const pinned = { categoryPath: product.categoryPath };
  report("填写商品规格和上架站点");
  const variant = await pageCall(api, tab, sheinVariantPage, { ...pinned, kind: "fill", input: product }, signal);
  if (!variant.ok) return outcome(variant, "商品规格");
  items.push(...variant.items || []);
  issues.push(...variant.issues || []);
  if (!variant.groups?.some(group => group.values.length)) {
    issues.push({ label: "主规格", code: "REQUIRED", message: "请填写商品主规格和规格值。" });
  }
  const activeSites = (variant.sites || []).filter(site => site.checked).map(site => site.name);
  if (!activeSites.length) issues.push({ label: "上架站点", code: "REQUIRED", message: "请指定当前商品的上架站点。" });
  const rows = product.skus.filter(row => row.options.length && row.options.every(Boolean)).map(row => ({
    ...row,
    options: row.options.map((name, index) => pageOption(name, variant.groups?.[index])),
  }));
  const rowIds = rows.map(row => row.options.map(key).join("\0"));
  if (rowIds.length !== new Set(rowIds).size) return outcome(fail("SKU_DUPLICATE", "存在规格完全相同的多行 SKU，请核对资料。"), "SKU");
  report("填写价格、包装和产品尺寸");
  const table = await pageCall(api, tab, sheinRowsPage, { ...pinned, kind: "fill", rows, dimensions: product.dimensions }, signal);
  if (!table.ok) return outcome(table, "SKU 表格");
  items.push(...table.items || []);
  issues.push(...table.issues || []);
  const stock = rows.filter(row => row.quantity !== undefined && row.quantity !== null && row.quantity !== "").map(row => ({
    options: row.options, quantity: row.quantity, siteLabel: row.siteLabel || (activeSites.length === 1 ? activeSites[0].replace(/站$/u, "") : ""),
  }));
  if (stock.length) {
    report("填写并核对各规格库存");
    const inventory = await pageCall(api, tab, sheinStockPage, { ...pinned, rows: stock }, signal);
    if (inventory.ok) {
      items.push(...inventory.items || []);
      issues.push(...inventory.issues || []);
    } else issues.push({ label: "库存", code: inventory.code, message: inventory.message });
  }
  const media = table.tables?.media || [];
  const tasks = [];
  const withRole = (...names) => images.filter(image => names.includes(image.role));
  if (images.length && media.length === 1 && media[0].length) {
    for (const image of withRole("detail", "main").slice(0, 5)) tasks.push({ role: "detail", options: media[0], image });
    for (const role of ["square", "swatch"]) if (withRole(role).length === 1) {
      tasks.push({ role, options: media[0], image: withRole(role)[0] });
    }
  }
  for (const row of rows.filter(row => row.imagePath)) {
    const matched = withRole("variant").filter(image => image.path === row.imagePath || !image.path && image.name === row.imagePath.split("/").at(-1));
    if (matched.length === 1) tasks.push({ role: "variant", options: row.options, image: matched[0] });
  }
  if (images.length && !tasks.length) issues.push({ label: "商品图片", code: "MEDIA_MAPPING_REQUIRED", message: "未找到图片与规格的唯一对应关系。" });
  for (const { role, options, image } of tasks) {
    const label = options.join(" / ") + " · " + image.name;
    report("上传并核对 SHEIN 图片");
    let file;
    try { file = await encodeImage(image); }
    catch (error) { issues.push({ label, code: "IMAGE_FORMAT", message: error.message }); continue; }
    const uploaded = await pageCall(api, tab, sheinRowsPage, { ...pinned, kind: "upload", upload: { role, options, files: [file] } }, signal);
    if (uploaded.ok) items.push({ label, status: "verified" });
    else issues.push({ label, code: uploaded.code, message: uploaded.message });
  }
  await currentTab(tab.id, tab.url, api, signal);
  return outcome();
}
