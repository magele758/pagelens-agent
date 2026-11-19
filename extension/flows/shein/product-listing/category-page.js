/** Runs in the seller page. Keep the injected function self-contained. */
export async function sheinCategoryPage({ href, kind = "inspect", categoryPath, brand } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const route = url => url.pathname === "/" && /^#\/(?:spmc\/commodities-category|spmp\/commoditiesCategory)\/followsales-pro\/list\/?(?:\?|$)/u.test(url.hash);
  const onPage = () => window === window.top && href === location.href &&
    location.origin === "https://sellerhub.shein.com" && route(new URL(location.href));
  const fail = (code, message) => ({ ok: false, code, message });
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const enabled = node => visible(node) && !node.closest(':disabled,[aria-disabled="true"]');
  const label = node => clean(node?.innerText ?? node?.textContent);
  const matches = (scope, selector, predicate) => [...scope.querySelectorAll(selector)].filter(node => visible(node) && predicate(node));
  const texts = (scope, predicate) => matches(scope, "h1,h2,h3,button,[role=tab],label,span,div,p,li", node =>
    predicate(label(node)) && ![...node.children].some(child => visible(child) && predicate(label(child))));
  const one = nodes => nodes.length === 1 ? nodes[0] : null;
  const exact = text => value => value === text;
  const nextLabel = /^确认\s*[,，]\s*下一步$/u;
  const selectedLabel = /^(?:已选分类\s*:?|已选分类\s*:.*)$/u;
  const modalSelector = 'dialog[open],[role="alertdialog"],[aria-modal="true"]';
  const blocked = () => matches(document, modalSelector, () => true).length > 0;
  const nextButton = () => one(matches(document, 'button,[role="button"]', node => nextLabel.test(label(node))));
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wrapperSelector = '[class*="spmc_wrapper_"]';
  const panelsSelector = '[class*="spmc_panelWrapper_"]';
  const panelSelector = '[class*="spmc_panel_"]';
  const itemSelector = '[class*="spmc_item_"]';
  const itemLabelSelector = '[class*="spmc_itemContent_"]';
  const receiptSelector = '[class*="bottomAlert-"]';
  const selectedRow = node => node.matches('[class*="spmc_selected_"]');
  const brandField = () => one(matches(document, 'input[placeholder="请选择品牌"]', enabled));

  if (!onPage()) return fail("PAGE_CHANGED", "SHEIN 商品分类页已切换。");
  if (!["inspect", "select", "advance"].includes(kind)) return fail("ACTION_UNSUPPORTED", "不支持此 SHEIN 分类操作。");
  const requested = Array.isArray(categoryPath) ? categoryPath.map(clean) : [];
  if (categoryPath != null && (!Array.isArray(categoryPath) || requested.length > 8 ||
      categoryPath.some((value, index) => typeof value !== "string" || !requested[index] || requested[index].length > 90)) ||
      kind === "select" && !requested.length) {
    return fail("CATEGORY_PATH_INVALID", "请提供 SHEIN 页面显示的完整分类路径。");
  }
  if (brand != null && (typeof brand !== "string" || clean(brand).length > 120)) {
    return fail("BRAND_INVALID", "商品品牌须与 SHEIN 页面显示的名称一致。");
  }
  const requestedBrand = clean(brand);

  async function waitFor(read, timeout = 1500) {
    const deadline = Date.now() + timeout;
    do {
      if (!onPage() || blocked()) return null;
      const result = read();
      if (result) return result;
      await delay(60);
    } while (Date.now() < deadline);
    return null;
  }

  function layout() {
    const anchor = one(texts(document, exact("手动选择分类")));
    const panels = one(matches(document, panelsSelector, node => Boolean(node.closest(wrapperSelector))));
    const footer = one(matches(document, receiptSelector, node => texts(node, value => selectedLabel.test(value)).length > 0));
    const next = nextButton();
    if (!anchor || !panels || !footer || !next || !texts(document, exact("发布商品")).length) return null;
    return { panels, footer, next, scope: panels.closest(wrapperSelector) };
  }

  function categoryColumns({ panels }) {
    return matches(panels, panelSelector, column => column.closest(panelsSelector) === panels).map(column => ({
      column,
      options: matches(column, itemSelector, node => node.closest(panelSelector) === column).flatMap(node => {
        const content = one(matches(node, itemLabelSelector, () => true));
        const name = label(content);
        return name && name.length <= 90 ? [{ node, name }] : [];
      }),
    }));
  }

  function selectedPath(page, expected = [], columns = categoryColumns(page)) {
    const leaf = columns.at(-1);
    if (!leaf?.column.matches('[class*="spmc_lastPanel_"]')) return [];
    const observed = columns.map(({ options }) => one(options.filter(({ node }) => selectedRow(node)))?.name);
    if (observed.some(name => !name) || expected.length &&
        (expected.length !== observed.length || expected.some((name, index) => name !== observed[index]))) return [];
    const receipt = texts(page.footer, exact(observed.at(-1)));
    const breadcrumb = one(matches(page.scope, '[class*="spmc_result_"]', () => true));
    const names = [...breadcrumb?.children || []].filter(child => child.matches("span") && visible(child))
      .map(label).filter(value => value && !/^[>›»→/|]+$/u.test(value));
    return receipt.length === 1 && names.length === observed.length && names.every((name, index) => name === observed[index]) ? observed : [];
  }

  function view(page, expected = requested) {
    const columns = categoryColumns(page);
    const path = selectedPath(page, expected, columns);
    const currentBrand = clean(brandField()?.value);
    return { ok: true, status: path.length ? "selected" : "ready", selectedPath: path,
      options: columns.map(({ options }) => options.map(({ name }) => name)), canAdvance: Boolean(path.length && enabled(page.next)),
      ...(currentBrand && { brand: currentBrand }) };
  }

  const page = await waitFor(layout, 2600);
  if (!page) return fail(blocked() ? "MODAL_BLOCKED" : !onPage() ? "PAGE_CHANGED" : "CATEGORY_PAGE_MISSING",
    "未读取到 SHEIN 的手动选类目区域，请核对页面或关闭弹窗。");
  if (kind === "inspect") return view(page);

  if (kind === "select") {
    const entries = selectedPath(page, requested).length ? [] : [...requested.entries()];
    for (const [index, name] of entries) {
      const found = await waitFor(() => {
        const current = layout();
        if (!current) return null;
        const columns = categoryColumns(current);
        const choices = columns[index]?.options.filter(option => option.name === name) || [];
        return choices.length ? { choices, next: columns[index + 1]?.column } : null;
      });
      if (!found) return fail("CATEGORY_OPTION_MISSING", `第 ${index + 1} 级找不到分类「${name}」。`);
      const target = one(found.choices)?.node;
      if (!target) return fail("CATEGORY_AMBIGUOUS", `存在多个名为「${name}」的分类选项。`);
      if (!onPage() || blocked() || !enabled(target)) return fail("PAGE_CHANGED", "当前 SHEIN 分类选项已变化。");
      target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (!selectedRow(target)) target.click();
      await delay(100);
      if (index + 1 < requested.length) {
        const child = await waitFor(() => {
          const current = layout();
          if (!current) return null;
          const columns = categoryColumns(current);
          const child = columns[index + 1]?.column;
          const active = columns[index]?.options.some(option => option.name === name && selectedRow(option.node));
          return child && (active || child !== found.next) ? child : null;
        });
        if (!child) return fail("CATEGORY_BRANCH_MISSING", `选中「${name}」后，未核对到下一级分类。`);
      }
    }
    const selected = await waitFor(() => {
      const current = layout();
      return current && selectedPath(current, requested).length ? current : null;
    });
    if (!selected) return fail("CATEGORY_NOT_CONFIRMED", "SHEIN 未显示与输入一致的已选分类；请检查是否选择了末级分类。");
    if (requestedBrand) {
      const outcome = await selectBrand(requestedBrand);
      if (!outcome.ok) return outcome;
    }
    const receipt = layout();
    return receipt ? view(receipt) : fail("PAGE_CHANGED", "SHEIN 分类页已变化。");
  }

  const state = view(page);
  if (!state.selectedPath.length) return fail("CATEGORY_NOT_CONFIRMED", "请先在 SHEIN 选择完整的末级分类。");
  if (requestedBrand && state.brand !== requestedBrand) return fail("BRAND_MISSING", "请先在 SHEIN 选择并确认商品品牌。");
  if (!state.canAdvance || !onPage() || blocked()) return fail("NEXT_UNAVAILABLE", "SHEIN 尚未允许进入下一步。");
  page.next.click();
  return { ...state, status: "clicked" };

  async function selectBrand(wanted) {
    const menuSelector = '[role="listbox"],[class*="select-dropdown" i],[class*="select_menu" i]';
    const menus = () => matches(document, menuSelector, menu => !menu.closest('[aria-hidden="true"]'));
    const input = brandField();
    if (clean(input?.value) === wanted) return { ok: true };
    if (!input || menus().length) return fail("BRAND_MISSING", "请在 SHEIN 核对并手动选择商品品牌。");
    input.click();
    const menu = await waitFor(() => one(menus()));
    if (!menu) return fail("BRAND_MISSING", "未读取到 SHEIN 品牌选项。");
    const option = one(matches(menu, 'li,[role="option"]', node => enabled(node) && label(node) === wanted));
    if (option) option.click();
    const chosen = option && await waitFor(() => !visible(menu) && clean(input.value) === wanted);
    if (chosen) return { ok: true };
    if (input === document.activeElement) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return fail("BRAND_MISSING", `未核对到品牌「${wanted}」；请在 SHEIN 确认可用品牌。`);
  }
}
