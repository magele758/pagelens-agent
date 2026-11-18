
const ORIGIN = "https://agentseller.temu.com";
const CATEGORY_PATH = "/goods/create/category";
const EDIT_PATH = "/goods/edit";

export function isTemuCategoryPage(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && url.pathname === CATEGORY_PATH;
  } catch {
    return false;
  }
}

// Serialized and injected into the bound top-level document by chrome.scripting.
export async function temuStagePage({ kind, expectedHref, siteId, category = [], origin = [] }) {
  const originMode = kind === "origin";
  const path = originMode ? "/goods/edit" : "/goods/create/category";
  const onPage = () => location.origin === "https://agentseller.temu.com" && location.pathname === path && location.href === expectedHref;
  const clean = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const shown = (element) => Boolean(element?.isConnected && element.getClientRects().length &&
    !element.closest('[hidden],[aria-hidden="true"],[inert]') && getComputedStyle(element).visibility !== "hidden");
  const modal = () => [...document.querySelectorAll('dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]')].some(shown);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const unique = (items) => items.length === 1 ? items[0] : null;
  const fail = (message) => ({ ok: false, message });
  const groupSelector = '[data-testid="beast-core-select-header"],[class*="ST_head_"]';
  const optionSelector = '[role="option"],[data-testid="beast-core-select-option"]';
  const categorySearch = 'input[placeholder="搜索类目"]';

  async function until(get, timeout = 1800) {
    const end = Date.now() + timeout;
    do {
      if (!onPage() || modal()) return null;
      const value = get();
      if (value) return value;
      await pause(35);
    } while (Date.now() < end);
    return null;
  }

  function field(label, placeholder) {
    const tag = [...document.querySelectorAll('label,[data-field-label],[class*="Form_itemLabelContent_"],span,div')].find((element) =>
      shown(element) && element.childElementCount <= 1 && clean(element.textContent).replace(/^\*\s*/u, "") === label);
    for (let group = tag?.parentElement, depth = 0; group && depth < 7; group = group.parentElement, depth++) {
      const input = unique([...group.querySelectorAll('input')].filter((element) => shown(element) && (!placeholder || element.placeholder === placeholder)));
      if (input && !input.disabled) return { input, head: input.closest(groupSelector) || input };
    }
    return null;
  }

  function portalOptions() {
    const lists = [...document.querySelectorAll('[role="listbox"],[class*="ST_dropdown_"]')].filter(shown);
    return [...new Set(lists.flatMap((list) => [...list.querySelectorAll(optionSelector)].filter(shown)))];
  }

  function selected(field) {
    return clean(field.input.value || field.head.querySelector('[class*="ST_selectValue"]')?.textContent);
  }

  async function open(field) {
    let choices = portalOptions();
    if (choices.length) return choices;
    field.input.focus({ preventScroll: true });
    choices = portalOptions();
    if (!choices.length) {
      field.head.click();
      choices = await until(() => portalOptions().length && portalOptions(), 1100);
    }
    return choices || [];
  }

  async function close(field) {
    if (!portalOptions().length) return;
    field.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    field.input.blur();
    if (portalOptions().length) field.head.click();
    if (portalOptions().length) await until(() => !portalOptions().length, 400);
  }

  const categoryColumns = () => [...document.querySelectorAll(categorySearch)].filter(shown);

  function categoryOption(input, label) {
    for (let parent = input?.parentElement, depth = 0; parent && depth < 12; parent = parent.parentElement, depth++) {
      if (parent.querySelectorAll(categorySearch).length !== 1) break;
      const matches = [...parent.querySelectorAll('*')].filter((item) => item.childElementCount <= 3 &&
        clean(item.textContent) === clean(label) && shown(item) &&
        ![...item.children].some((node) => clean(node.textContent) === clean(label)));
      if (matches.length) return unique(matches);
    }
    return null;
  }

  function setSearch(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function pickedCategory(labels) {
    const exact = (element) => clean(element.textContent);
    const key = value => clean(value).replace(/\s+/gu, "").replace(/[＞›→]/gu, ">");
    const textNodes = [...document.querySelectorAll('div,span')].filter((element) => shown(element) && element.childElementCount <= 6);
    const picked = textNodes.some(element => key(exact(element)) === `已选分类:${key(labels.at(-1))}`);
    const trail = labels.map(key).join(">");
    const compact = textNodes.map(element => key(exact(element)));
    const displays = compact.some(value => value === trail || value === ">" + trail) ||
      labels.every(label => compact.includes(">" + key(label)));
    return displays && picked;
  }

  if (!onPage() || modal()) return fail("Temu 页面已切换或有弹窗挡住，请返回目标页面后重试。");

  if (originMode) {
    const matches = (entry, label) => clean(entry.textContent) === clean(label);
    for (const [index, labels] of origin.entries()) {
      const currentField = () => index === 0 ? field("商品产地", "请选择") : (() => {
        const input = unique([...document.querySelectorAll('input[placeholder="请选择省份"]')].filter(shown));
        return input && { input, head: input.closest(groupSelector) || input };
      })();
      const target = await until(currentField, 4000);
      if (!target) return fail("找不到当前类目的商品产地控件，请在 Temu 核对。");
      if (labels.some((label) => selected(target) === clean(label))) continue;
      const option = unique((await open(target)).filter((entry) => labels.some((label) => matches(entry, label))));
      if (!option) return fail(`Temu 当前找不到产地选项「${labels[0]}」。`);
      option.click();
      if (!await until(() => {
        const fresh = currentField();
        return fresh && labels.some((label) => selected(fresh) === clean(label));
      })) return fail(`Temu 尚未确认产地「${labels[0]}」。`);
    }
    return { ok: true };
  }

  const site = field("经营站点", "请选择");
  if (!site) return fail("未找到经营站点，请等 Temu 第一步加载后重试。");
  if (kind === "sites") {
    const names = (await open(site)).map((entry) => ({ label: clean(entry.textContent),
      selected: ["true", "checked"].includes(entry.getAttribute("aria-selected") || entry.getAttribute("data-checked")) || selected(site) === clean(entry.textContent),
      disabled: entry.matches('[aria-disabled="true"],[data-disabled="true"],[disabled]') }));
    await close(site);
    const sites = names.filter((entry) => entry.label && names.filter((other) => other.label === entry.label).length === 1)
      .map((entry) => ({ id: entry.label, ...entry }));
    return sites.length ? { ok: true, sites } : fail("经营站点列表未加载或没有可识别的选项。");
  }
  if (kind === "next") {
    const next = unique([...document.querySelectorAll('button')].filter((element) => shown(element) && !element.disabled && clean(element.textContent) === "下一步"));
    if (!next || selected(site) !== clean(siteId) || !pickedCategory(category)) return fail("经营站点或完整分类尚未确认，请先检查选择结果。");
    next.click();
    return { ok: true };
  }
  if (kind !== "select" || !category.length) return fail("请选择一个完整的商品类目。");

  if (selected(site) !== clean(siteId)) {
    const option = unique((await open(site)).filter((entry) => clean(entry.textContent) === clean(siteId) &&
      !entry.matches('[aria-disabled="true"],[data-disabled="true"],[disabled]')));
    if (!option) return fail(`该店铺当前没有可选的「${siteId}」。`);
    option.click();
    if (!await until(() => {
      const fresh = field("经营站点", "请选择");
      return fresh && selected(fresh) === clean(siteId);
    })) return fail(`Temu 尚未确认经营站点「${siteId}」。`);
  }
  if (!pickedCategory(category)) {
    for (const [index, label] of category.entries()) {
      const column = await until(() => categoryColumns()[index], 3500);
      if (!column) return fail(`当前站点尚未加载类目「${label}」所在层。`);
      const find = () => categoryOption(categoryColumns()[index], label);
      let option = find();
      if (!option) {
        setSearch(column, label);
        option = await until(find);
      }
      if (!option) return fail(`当前站点没有唯一匹配的类目「${label}」。`);
      option.click();
    }
  }
  return await until(() => pickedCategory(category)) ? { ok: true } : fail("Temu 未确认完整类目，请检查当前站点的分类是否已更新。");
}
