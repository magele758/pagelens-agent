/** Edit the current SKU's stock in the pinned Temu draft and verify the row. */
export async function temuStockPage({ href, kind, key, value, warehouse }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const clean = text => String(text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const enabled = node => visible(node) && !node.matches(':disabled,[readonly]') && !node.closest('[aria-disabled="true"]');
  const unique = list => list.length === 1 ? list[0] : null;
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const modals = () => [...document.querySelectorAll(
    '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]',
  )].filter(visible);
  const exact = (node, text) => [...node.querySelectorAll("h1,h2,h3,div,span")].some(el =>
    visible(el) && !el.children.length && clean(el.textContent) === text);
  const activeStock = () => {
    return unique(modals().filter(node => node.matches('[data-testid="beast-core-modal-inner"]') &&
      [...node.children].some(child => child.matches('[class*="MDL_header_"]') && clean(child.textContent) === "填写库存")));
  };
  const onlyStock = dialog => dialog && modals().every(node => node === dialog || node.contains(dialog));
  const action = (dialog, label) => unique([...dialog.querySelectorAll('button,[role="button"]')]
    .filter(node => enabled(node) && clean(node.textContent) === label));
  const numeric = value => (typeof value === "string" || typeof value === "number") &&
    /^\d+$/u.test(clean(value)) && Number.isSafeInteger(Number(value));

  function columns(table, names) {
    const lastHeader = table.tHead?.rows[table.tHead.rows.length - 1];
    if (!lastHeader) return [];
    return [...lastHeader.cells].filter(cell => cell.colSpan === 1 && visible(cell) && names.some(name =>
      clean(cell.textContent) === name || exact(cell, name)));
  }

  function rowCell(row, header) {
    const before = [...header.parentElement.cells].slice(0, header.cellIndex);
    const column = before.reduce((total, cell) => total + cell.colSpan, 0);
    // The warehouse grid can span a SKU's color and size over its warehouses.
    let position = 0;
    const occupied = new Set();
    for (const previous of row.parentElement.rows) {
      position = 0;
      const offset = previous.sectionRowIndex;
      for (const cell of previous.cells) {
        while (occupied.has(offset + ":" + position)) position++;
        if (previous === row && position === column && cell.colSpan === 1) return cell;
        const until = cell.rowSpan ? offset + cell.rowSpan : row.parentElement.rows.length;
        for (let r = offset + 1; r < Math.min(until, row.sectionRowIndex + 1); r++) {
          for (let c = position; c < position + cell.colSpan; c++) occupied.add(r + ":" + c);
        }
        position += cell.colSpan;
      }
      if (previous === row) return null;
    }
    return null;
  }

  function listingCell() {
    if (!root) return null;
    return unique([...root.querySelectorAll(`[id="sku_stock_${key}"]`)].filter(visible));
  }

  function listingStock(cell) {
    const display = cell && unique([...cell.querySelectorAll('span[class^="sku-stock-input_stockView__"]')].filter(visible));
    const current = clean(display?.textContent);
    return numeric(current) ? current : undefined;
  }

  function modalInput(dialog) {
    const table = unique([...dialog.querySelectorAll('table[class^="performance-table_performanceTable__"]')].filter(node =>
      visible(node) && columns(node, ["当前库存"]).length === 1 && columns(node, ["发货仓"]).length === 1 &&
      columns(node, ["覆盖站点"]).length === 1));
    if (!table) return null;
    const [stock] = columns(table, ["当前库存"]);
    const [warehouseColumn] = columns(table, ["发货仓"]);
    const marker = unique([...table.querySelectorAll("tbody td")].filter(cell => visible(cell) && exact(cell, "当前sku")));
    if (!marker) return null;
    const row = marker.parentElement;
    // Refuse any SKU with more than one warehouse row. The listing summary does not verify a warehouse-level value.
    if (marker.rowSpan !== 1) return null;
    const depot = clean(rowCell(row, warehouseColumn)?.textContent);
    if (!depot || (warehouse != null && depot !== clean(warehouse))) return null;
    const cell = rowCell(row, stock);
    return cell && unique([...cell.querySelectorAll(
      'input[data-testid="beast-core-inputNumber-htmlInput"][placeholder="请输入"]',
    )].filter(enabled));
  }

  async function waitFor(check) {
    const deadline = Date.now() + 2200;
    do {
      if (!onPage()) return null;
      const outcome = check();
      if (outcome) return outcome;
      await new Promise(resolve => setTimeout(resolve, 55));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品草稿已切换。");
  if (modals().length) return fail("MODAL_BLOCKED", "当前页已有弹窗，暂不能操作 SKU 库存。");
  if (typeof key !== "string" || !/^[\w-]{1,80}$/u.test(key)) return fail("VALUE_INVALID", "未提供唯一的 SKU 标识。");
  const cell = listingCell();
  if (!cell) return fail("SKU_STOCK_CONTROL_MISSING", "未找到当前 SKU 的库存列。");
  const current = listingStock(cell);
  if (kind === "inspect") return { ok: true, value: current };
  if (kind !== "write" || !numeric(value)) return fail("VALUE_INVALID", "SKU 库存需要非负整数。");
  const desired = Number(value);
  if (current != null && Number(current) === desired) return { ok: true, status: "unchanged", value: current };

  const trigger = unique([...cell.querySelectorAll('svg[data-testid="beast-core-icon-edit"]')].filter(enabled));
  if (!trigger) return fail("SKU_STOCK_CONTROL_MISSING", "未找到当前 SKU 唯一的库存编辑入口。");
  trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  const dialog = await waitFor(activeStock);
  if (!onlyStock(dialog)) return modals().length ? fail("MODAL_BLOCKED", "当前页弹窗已变化。")
    : fail("SKU_STOCK_CONTROL_MISSING", "未能打开当前 SKU 的填写库存弹窗。");
  let sent = false;
  try {
    const input = await waitFor(() => onlyStock(dialog) && activeStock() === dialog && modalInput(dialog));
    if (!input) return fail("SKU_STOCK_WAREHOUSE_REQUIRED", "未找到当前 SKU 唯一可填写的发货仓库存，请核对站点与发货仓关系。");
    if (input.maxLength > 0 && String(desired).length > input.maxLength) return fail("VALUE_INVALID", "库存超出 Temu 输入范围。");
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(desired));
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (input.isConnected && onPage() && onlyStock(dialog)) input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
    const confirm = await waitFor(() => {
      if (!onlyStock(dialog) || activeStock() !== dialog) return null;
      const updated = modalInput(dialog);
      return numeric(updated?.value) && Number(updated.value) === desired && updated.validity?.valid !== false &&
        updated.getAttribute("aria-invalid") !== "true" && action(dialog, "确认");
    });
    if (!confirm) return fail("SKU_QUANTITY_UNVERIFIED", "库存未能通过弹窗校验，或当前发货仓已变化。");
    sent = true;
    confirm.click();
    const readback = await waitFor(() => {
      if (modals().length) return null;
      const verified = listingStock(listingCell());
      return verified != null && Number(verified) === desired && verified;
    });
    return readback == null ? fail("SKU_QUANTITY_UNVERIFIED", "库存确认后暂未从对应 SKU 行回读到指定数量。")
      : { ok: true, status: "verified", value: readback };
  } finally {
    if (!sent && onPage() && onlyStock(dialog) && activeStock() === dialog) action(dialog, "取消")?.click();
  }
}
