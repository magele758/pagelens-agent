/** Updates the selected listing sites in the SHEIN inventory dialog, then reads the saved values back. */
export async function sheinStockPage({ href, categoryPath, rows } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const text = node => clean(node?.innerText ?? node?.textContent);
  const stockArea = '[class*="supplyInfoTable--"]';
  const category = '[class*="spmp_style__commodityCategoryItem--"] [class*="spmp_style__categoryInfo--"]';
  const overlay = '.so-modal.so-modal-show,.soui-modal-wrapper,.so-dialog,dialog[open],[role="alertdialog"],[aria-modal="true"]';
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).opacity !== "0");
  const scan = (scope, selector) => [...(scope?.querySelectorAll(selector) || [])].filter(visible);
  const one = values => values.length === 1 ? values[0] : null;
  const button = (scope, label) => scan(scope, 'button,[role="button"]').filter(node => text(node) === label);
  const active = node => visible(node) && !node.closest(':disabled,[aria-disabled="true"]');
  const activeOverlays = () => scan(document, overlay);
  const noOtherOverlay = (own) => activeOverlays().every(node => own && (node.contains(own) || own.contains(node)));
  const items = [];
  const fail = (code, message) => ({ ok: false, code, message, items, issues: [{ label: "库存", code, message }] });
  const expected = Array.isArray(categoryPath) && categoryPath.every(value => typeof value === "string") ? categoryPath.map(clean) : [];
  const routeMatches = () => {
    const [route, search = ""] = location.hash.slice(1).split("?");
    return window === window.top && location.href === href && location.origin === "https://sellerhub.shein.com" &&
      location.pathname === "/" && route === "/spmp/commoditiesInfo" && new URLSearchParams(search).getAll("mode").join("|") === "add";
  };
  const categoryMatches = () => {
    const current = text(one(scan(document, category))).split(/\s*>\s*/u).filter(Boolean);
    return expected.length > 0 && expected.every(Boolean) && JSON.stringify(expected) === JSON.stringify(current);
  };
  const onPage = () => routeMatches() && categoryMatches();

  if (!routeMatches()) return fail("PAGE_CHANGED", "SHEIN 新建商品页面已切换。");
  if (!categoryMatches()) return fail("CATEGORY_CHANGED", "当前 SHEIN 商品分类与库存资料不一致。");
  if (!Array.isArray(rows) || rows.length > 80) return fail("STOCK_INPUT_INVALID", "库存资料须为不超过 80 项的数组。");
  const requests = [];
  const keys = new Set();
  for (const row of rows) {
    if (!Array.isArray(row?.options) || !row.options.length || row.options.length > 3 ||
        row.options.some(value => typeof value !== "string" || !clean(value) || clean(value).length > 90) ||
        typeof row.siteLabel !== "string" || !clean(row.siteLabel) || clean(row.siteLabel).length > 50 ||
        !["number", "string"].includes(typeof row.quantity) || !/^\d+$/u.test(clean(row.quantity)) || !Number.isSafeInteger(Number(clean(row.quantity)))) {
      return fail("STOCK_INPUT_INVALID", "每项库存须指定完整规格、页面站点名称及非负整数数量。");
    }
    const options = row.options.map(clean);
    const siteLabel = clean(row.siteLabel);
    const key = JSON.stringify([options, siteLabel]);
    if (keys.has(key)) return fail("STOCK_INPUT_INVALID", "库存资料有相同的规格和站点，请保留唯一数量。");
    keys.add(key);
    requests.push({ options, siteLabel, quantity: Number(clean(row.quantity)), key });
  }
  if (!requests.length) return { ok: true, items, issues: [] };
  if (!noOtherOverlay()) return fail("MODAL_BLOCKED", "请关闭当前 SHEIN 弹窗后再维护库存。");

  const skuLabel = cell => text(cell).split(/\s*(?:SKC|SKU)\s*:/iu)[0].trim();
  const matchRow = (row, { options }) => options.every((name, index) => name === skuLabel(row.cells[index]));
  const area = one(scan(document, stockArea).filter(node => !node.parentElement.closest(stockArea)));
  const sourceRows = scan(area, "tbody tr").filter(row => row.cells.length > 1);
  if (!area || requests.some(request => sourceRows.filter(row => matchRow(row, request)).length !== 1)) {
    return fail("STOCK_ROW_NOT_FOUND", "当前商品销售表没有唯一匹配的库存规格行。");
  }
  function sourceButton() {
    const section = one(scan(document, stockArea).filter(node => !node.parentElement.closest(stockArea)));
    const all = button(section, "编辑库存").filter(active);
    if (all.length === 1) return all[0];
    const related = [...new Set(requests.flatMap(request => {
      const row = one(scan(section, "tbody tr").filter(candidate => matchRow(candidate, request)));
      return row ? button(row, "编辑库存").filter(active) : [];
    }))];
    return related.length === 1 && requests.every(request => related[0].closest("tr") && matchRow(related[0].closest("tr"), request))
      ? related[0] : null;
  }

  function ownedPanel() {
    const titles = scan(document, ".so-modal.so-modal-show .so-modal-panel .so-card-header.so-modal-title").filter(node => text(node) === "库存维护");
    const panel = one(titles)?.closest(".so-modal-panel");
    return panel && noOtherOverlay(panel) ? panel : null;
  }

  function readModal() {
    const panel = ownedPanel();
    if (!panel) return null;
    const headersFor = table => scan(table, "thead th").filter(header => header.closest("table") === table);
    const headerTable = one(scan(panel, "table").filter(table => {
      const headers = headersFor(table);
      return headers.length > 1 && text(headers.at(-1)) === "库存" && text(headers[0]) === "颜色";
    }));
    if (!headerTable) return null;
    const tableGroup = headerTable.closest(".so-table") || headerTable;
    if (!panel.contains(tableGroup)) return null;
    const bodies = scan(tableGroup, "tbody").filter(body => tableGroup === headerTable
      ? body.closest("table") === headerTable
      : body.closest(".so-table") === tableGroup);
    const simpleBodies = bodies.filter(body => body.closest(".so-table-simple-body")?.closest(".so-table") === tableGroup);
    const body = one(simpleBodies.length ? simpleBodies : bodies);
    const confirm = one(button(panel, "确定"));
    const cancel = one(button(panel, "取消"));
    return body && confirm && cancel ? { panel, body, confirm, cancel, specCount: headersFor(headerTable).length - 1 } : null;
  }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waited(read, timeout = 1800) {
    const deadline = Date.now() + timeout;
    do {
      if (!onPage()) return null;
      const found = read();
      if (found) return found;
      await delay(60);
    } while (Date.now() < deadline);
    return null;
  }
  async function open() {
    const control = sourceButton();
    if (!control || !onPage() || !noOtherOverlay()) return null;
    control.click();
    const first = await waited(readModal);
    if (!first) return null;
    await delay(130);
    const second = readModal();
    return onPage() && first.panel === second?.panel ? second : null;
  }

  function siteInput(modal, request) {
    if (modal?.specCount !== request.options.length) return null;
    const row = one(scan(modal?.body, "tr").filter(candidate => candidate.closest("tbody") === modal.body && matchRow(candidate, request)));
    const cell = row?.cells[row.cells.length - 1];
    if (!cell || row.cells.length <= request.options.length) return null;
    const candidates = scan(cell, 'input[placeholder="请输入"]').filter(node => active(node) && !node.readOnly && /^(?:number|text)$/u.test(node.type));
    const siteLabels = [cell, ...scan(cell, "label,span,div,p")].filter(node => text(node) === request.siteLabel &&
      ![...node.children].some(child => text(child) === request.siteLabel));
    return one(candidates.filter(input => {
      for (let scope = input.parentElement; scope && cell.contains(scope); scope = scope.parentElement) {
        if (candidates.filter(other => scope.contains(other)).length > 1) break;
        if (siteLabels.some(label => scope.contains(label))) return true;
      }
      return false;
    }));
  }

  const matchesQuantity = (control, amount) => control && /^\d+$/u.test(clean(control.value)) && Number(control.value) === amount;
  const resolveInputs = () => {
    const modal = readModal();
    const controls = requests.map(request => siteInput(modal, request));
    return modal && controls.every(Boolean) && new Set(controls).size === controls.length ? { ...modal, controls } : null;
  };
  const withinBounds = (control, amount) => ["min", "max"].every(attr => {
    const value = control.getAttribute(attr);
    return !value?.trim() || !Number.isFinite(Number(value)) || (attr === "min" ? amount >= Number(value) : amount <= Number(value));
  });
  async function close() {
    const cancel = one(button(ownedPanel(), "取消"));
    if (onPage() && active(cancel)) cancel.click();
    return waited(() => noOtherOverlay());
  }

  if (!sourceButton()) return fail("STOCK_CONTROL_MISSING", "没有唯一匹配的 SHEIN 编辑库存按钮。");
  if (!await open()) {
    if (ownedPanel()) await close();
    return fail("STOCK_DIALOG_MISSING", "未打开可确认的 SHEIN 库存维护弹窗。");
  }
  try {
    const initial = resolveInputs();
    if (!initial) return fail("STOCK_TARGET_MISSING", "弹窗内未找到与资料一致的唯一规格及站点库存输入框。");
    if (requests.some((request, index) => !withinBounds(initial.controls[index], request.quantity))) {
      return fail("STOCK_OUT_OF_RANGE", "所填数量超出 SHEIN 库存输入框的范围。");
    }
    const changed = requests.map((request, index) => !matchesQuantity(initial.controls[index], request.quantity));
    if (changed.some(Boolean)) {
      for (const [index, request] of requests.entries()) {
        if (!changed[index]) continue;
        const input = resolveInputs()?.controls[index];
        if (!input || !onPage() || !withinBounds(input, request.quantity)) return fail("STOCK_TARGET_CHANGED", "库存输入框已变化。");
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (!setValue) return fail("STOCK_CONTROL_MISSING", "无法写入 SHEIN 库存输入框。");
        input.focus({ preventScroll: true });
        if (document.activeElement !== input) return fail("STOCK_CONTROL_MISSING", "SHEIN 未将焦点放在目标库存输入框。");
        const value = String(request.quantity);
        input.select();
        const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, value);
        if (!inserted) {
          setValue.call(input, value);
          input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (input.isConnected) input.blur();
        let stableSince = 0;
        if (!await waited(() => {
          if (!matchesQuantity(resolveInputs()?.controls[index], request.quantity)) {
            stableSince = 0;
            return false;
          }
          stableSince ||= Date.now();
          return Date.now() - stableSince >= 300;
        })) {
          return fail("STOCK_READBACK_MISMATCH", "SHEIN 没有保留所填库存，已停止本次编辑。");
        }
      }
      const ready = resolveInputs();
      if (!onPage() || !ready || !active(ready.confirm) ||
          !requests.every((request, index) => matchesQuantity(ready.controls[index], request.quantity))) {
        return fail("STOCK_READBACK_MISMATCH", "未核对到所有待确认的库存数量。");
      }
      ready.confirm.click();
      if (!await waited(() => noOtherOverlay()) || !await open()) {
        return fail("STOCK_SAVE_UNVERIFIED", "确认后无法重新打开库存维护核对数量。");
      }
    }
    const verified = await waited(() => {
      const modal = resolveInputs();
      return modal && requests.every((request, index) => matchesQuantity(modal.controls[index], request.quantity)) ? modal : null;
    }, 2600);
    if (!verified) {
      return fail("STOCK_SAVE_UNVERIFIED", "重新读取的库存与试填数量不一致。");
    }
    for (const [index, request] of requests.entries()) {
      items.push({ key: `stock:${request.key}`, label: `${request.options.join(" / ")} · ${request.siteLabel}库存`,
        status: changed[index] ? "verified" : "unchanged", value: request.quantity });
    }
    if (!await close()) return fail("STOCK_DIALOG_OPEN", "库存已核对，但库存弹窗仍打开，请检查当前页面。");
    return { ok: true, items, issues: [] };
  } finally {
    if (ownedPanel()) await close();
  }
}
