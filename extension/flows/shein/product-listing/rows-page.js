/** Serialized into the verified SHEIN add-product page. */
export async function sheinRowsPage({ href, categoryPath, kind = "inspect", rows = [], dimensions, upload } = {}) {
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const measureHeaders = { widthCm: "宽度", lengthCm: "长度", heightCm: "高度", diameterCm: "直径" };
  const editable = node => node && !node.disabled && !node.readOnly && node.getClientRects().length;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const one = values => values.length === 1 ? values[0] : undefined;
  const items = [];
  const issues = [];
  const category = () => one([...document.querySelectorAll('[class*="commodityCategoryItem--"] [class*="categoryInfo--"]')].filter(visible));
  const onPage = () => {
    if (window !== window.top || location.origin !== "https://sellerhub.shein.com" || location.href !== href ||
        !location.hash.startsWith("#/spmp/commoditiesInfo?") || new URLSearchParams(location.hash.split("?")[1]).get("mode") !== "add") return false;
    const actual = clean(category()?.textContent).split(/\s*[>›]\s*/u);
    return categoryPath?.length > 0 && actual.length === categoryPath.length && actual.every((name, index) => name === clean(categoryPath[index]));
  };
  const blocked = () => [...document.querySelectorAll('.so-modal-show .so-modal-panel,[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const live = () => onPage() && !blocked();
  if (!live()) return fail("SHEIN_EDIT_CONTEXT_CHANGED", "SHEIN 商品、类目或弹窗已变化。");

  const columns = table => [...table?.querySelectorAll('.so-table-head thead th') || []]
    .map(cell => visible(cell) ? clean(cell.innerText || cell.textContent) : "");
  const cellText = cell => clean((cell?.innerText || cell?.textContent || "").split(/\bSKC\s*[:：]/iu)[0]);
  const wrappers = () => [...document.querySelectorAll(".so-table")].filter(visible);
  const tableRows = table => [...table?.querySelectorAll("tbody tr") || []].filter(row =>
    visible(row) && row.closest(".so-table") === table && row.cells.length > 0);
  const tableFor = search => one(wrappers().filter(table => columns(table).some(search)));
  const refs = {
    supply: () => one(wrappers().filter(table => table.matches('[class*="supplyInfoTable--"]') && columns(table).some(h => /^价格\(USD\)/u.test(h)))),
    package: () => tableFor(h => /^含包装重量/u.test(h)),
    media: () => one(wrappers().filter(table => table.closest(".detail_img_container") && columns(table).includes("方形图"))),
    size: () => one(wrappers().filter(table => table.closest('[class*="sizeContentBox--"]') && columns(table).some(h => /\(cm\)/iu.test(h)))),
  };
  const partition = (table, row) => {
    const names = [];
    const headers = columns(table);
    for (const [index, title] of headers.entries()) {
      if (/^(?:颜色|规格|尺码|尺寸|尺寸大小|容量|款式|样式|Color|Size|Style)$/iu.test(title)) {
        const name = cellText(row.cells[index]);
        if (name) names.push(name);
      }
    }
    return names;
  };
  const rowFor = (table, opts) => one(tableRows(table).filter(row => {
    const names = partition(table, row);
    return names.length > 0 && names.length === opts.length && opts.every((opt, index) => names[index] === clean(opt));
  }));
  const writeable = (cell, selector = 'input:not([type="file"]),textarea') =>
    one([...cell?.querySelectorAll(selector) || []].filter(editable));
  const safeNumber = (value, { integer = false, zero = false } = {}) => {
    const amount = clean(value);
    return /^\d{1,8}(?:\.\d{1,3})?$/u.test(amount) && Number(amount) >= (zero ? 0 : 0.001) &&
      (!integer || Number.isInteger(Number(amount))) ? amount : "";
  };
  async function waitUntil(check, timeout = 2500) {
    const end = Date.now() + timeout;
    do {
      if (!live()) return false;
      if (check()) return true;
      await new Promise(resolve => setTimeout(resolve, 60));
    } while (Date.now() < end);
    return false;
  }
  async function write(field, value, label, options = {}) {
    if (value == null || clean(value) === "") return;
    const expected = options.numeric ? safeNumber(value, options) : clean(value);
    const agrees = node => options.numeric ? safeNumber(node.value, options) && Number(node.value) === Number(expected) : clean(node.value) === expected;
    const first = field();
    if (!expected || !first || first.maxLength >= 0 && expected.length > first.maxLength || !live()) {
      issues.push({ label, code: "SHEIN_ROW_FIELD", message: "缺少唯一控件或所给值不符合输入范围。" });
      return;
    }
    if (agrees(first)) {
      items.push({ label, status: "unchanged" });
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(first.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
    if (!setter) return;
    first.focus({ preventScroll: true });
    setter.call(first, expected);
    first.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    first.dispatchEvent(new Event("change", { bubbles: true }));
    first.blur();
    let agreedAt;
    if (await waitUntil(() => {
      const current = field();
      if (!current || !agrees(current)) { agreedAt = undefined; return false; }
      agreedAt ??= Date.now();
      return Date.now() - agreedAt >= 120;
    })) items.push({ label, status: "filled" });
    else issues.push({ label, code: "SHEIN_ROW_READBACK", message: "SHEIN 未回显写入值。" });
  }
  const rowInput = (role, options, header, selector) => {
    const table = refs[role]();
    const positions = columns(table).flatMap((text, index) => header.test(text) ? [index] : []);
    const row = table && rowFor(table, options);
    return positions.length === 1 && row && writeable(row.cells[positions[0]], selector);
  };

  const state = () => Object.fromEntries(Object.entries(refs).map(([key, find]) => {
    const table = find();
    return [key, table ? tableRows(table).map(row => partition(table, row)) : []];
  }));
  if (kind === "inspect") return { ok: true, tables: state() };

  if (kind === "upload") {
    const { role, options, files } = upload || {};
    if (!["detail", "square", "variant", "swatch"].includes(role) || !Array.isArray(options) || !options.length ||
        !Array.isArray(files) || !files.length || files.length > (role === "detail" ? 5 : 1)) {
      return fail("SHEIN_IMAGE_INPUT", "请为当前规格选择合适的 SHEIN 图片。");
    }
    const table = refs[role === "variant" ? "supply" : "media"]();
    const pattern = { detail: /^细节图/u, square: /^方形图/u, swatch: /^色块图/u, variant: /^SKU图/u }[role];
    const indices = table && columns(table).flatMap((header, index) => pattern.test(header) ? [index] : []);
    const findCell = () => table && indices?.length === 1 ? rowFor(table, options)?.cells[indices[0]] : undefined;
    const cell = findCell();
    const field = one([...cell?.querySelectorAll('input[type="file"]') || []].filter(node => !node.disabled &&
      visible(node.parentElement) && node.accept.includes("image/")));
    if (!field) return fail("SHEIN_IMAGE_TARGET", "未定位到规格对应的唯一图片上传位置。");

    const source = () => new Set([...findCell()?.querySelectorAll("img") || []].filter(visible)
      .map(image => image.getAttribute("src")).filter(src => src && /^(?:https?:|blob:)/iu.test(src)));
    const initial = source();
    if (initial.size && role !== "detail") return fail("SHEIN_IMAGE_OCCUPIED", "该图片位置已有内容，请先核对当前图片。");
    if (initial.size + files.length > (role === "detail" ? 5 : 1)) return fail("SHEIN_IMAGE_LIMIT", "图片数量超过当前位置的容量。");
    const transfer = new DataTransfer();
    for (const file of files) {
      if (!/^[^/\\\0]{1,140}\.(?:jpe?g|png)$/iu.test(String(file.name)) || !/^image\/(?:png|jpeg)$/u.test(file.type) ||
          typeof file.base64 !== "string" || file.base64.length > 12 * 1024 * 1024) return fail("SHEIN_IMAGE_FORMAT", "SHEIN 图片请使用 JPEG 或 PNG。");
      const bytes = Uint8Array.from(atob(file.base64), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    if (!live() || !field.isConnected || !findCell()?.contains(field)) return fail("SHEIN_IMAGE_TARGET", "图片位置已变化。");
    field.files = transfer.files;
    field.dispatchEvent(new Event("change", { bubbles: true }));
    if (!await waitUntil(() => [...source()].filter(src => !initial.has(src) && /^https?:/iu.test(src)).length >= files.length, 8500)) {
      return fail("SHEIN_IMAGE_READBACK", "未核对到 SHEIN 上传回显，请检查图片规格、平台提示和上传进度。");
    }
    return { ok: true, status: "verified" };
  }

  if (kind !== "fill") return fail("SHEIN_ACTION_UNSUPPORTED", "此 SHEIN 表单操作不可用。");
  for (const row of rows) {
    if (!live()) return fail("SHEIN_EDIT_CONTEXT_CHANGED", "SHEIN 商品、类目或弹窗已变化。");
    const options = row.options || [];
    if (!options.length) continue;
    const label = options.join(" / ");
    if (!rowFor(refs.supply(), options) && !rowFor(refs.package(), options)) {
      issues.push({ label, code: "SHEIN_SKU_MISSING", message: "当前表格未找到唯一对应规格。" });
      continue;
    }
    await write(() => rowInput("supply", options, /^价格\(USD\)/u), row.priceUsd, label + " 价格 (USD)", { numeric: true });
    await write(() => rowInput("supply", options, /^商家SKU/u), row.sellerSku, label + " 商家 SKU");
    await write(() => rowInput("package", options, /^含包装重量/u), row.weightG, label + " 包装重量 (g)", { numeric: true });
    for (const [key, prompt] of [["lengthCm", "长(最长边)"], ["widthCm", "宽(次长边)"], ["heightCm", "高(最短边)"]]) {
      await write(() => rowInput("package", options, /^含包装尺寸/u, `input[placeholder="${prompt}"]`), row[key], label + " 包装" + prompt, { numeric: true });
    }
  }
  if (dimensions) for (const [key, name] of Object.entries(measureHeaders)) {
    await write(() => {
      const table = refs.size();
      const row = table && one(tableRows(table));
      const index = table && columns(table).findIndex(header => header === name + " (cm)");
      return row && index >= 0 && writeable(row.cells[index]);
    }, dimensions[key], "产品" + name + " (cm)", { numeric: true });
  }
  return { ok: true, items, issues, tables: state() };
}
