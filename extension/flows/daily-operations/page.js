// Serialized into the seller tab. Commands here operate only on the configured list.
export function readDailyPage({ source, targetUrl, sections, translations, header, allowedFields, action = "read", section, start, end, orderNumber, field }) {
  const target = new URL(targetUrl);
  const failure = (code, error) => ({ ok: false, code, error });
  if (window !== window.top || location.origin !== target.origin || location.pathname !== target.pathname) {
    return failure("page-changed", "页面已跳转，请核对登录状态。");
  }
  const text = (node) => String(node?.innerText ?? node?.textContent ?? "").replace(/\s+/gu, " ").trim();
  const shown = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest("[hidden],[inert],[aria-hidden=true]") && getComputedStyle(node).visibility !== "hidden");
  const nodes = (root, selector) => [...root.querySelectorAll(selector)].filter(shown);
  const unique = items => items.length === 1 ? items[0] : null;
  const enabled = node => node && !node.disabled && !node.closest("[aria-disabled=true],[disabled]") &&
    !/(?:^|[ _-])disabled(?:$|[ _-])/iu.test(String(node.className));
  const accountNodes = source === "orders" ? ".avatar-box .name-line"
    : source === "chat" ? '[class*="mall-item--selected"] [class*="info_name"]'
    : '[class*="account-info_mallInfo__"],._Wrz4-O9w';

  if (nodes(document, 'input[type="password"]').length) return failure("login-required", "需要在 Chrome 登录此平台。");
  const dialogSelector = 'dialog[open],[role=dialog],[aria-modal=true],.el-dialog,[data-testid="beast-core-modal-container"],[class*="MDL_inner_"]';
  const dialogs = nodes(document, dialogSelector).filter(node =>
    !(source === "orders" && node.matches(".el-picker__popper")) && !nodes(node, dialogSelector).length);
  if (dialogs.length) {
    if (action !== "dismiss") return failure("dialog-open", "页面上有弹窗，正在核对关闭图标。");
    const popup = dialogs.at(-1);
    const selector = '.el-dialog__headerbtn,[aria-label="关闭此对话框"],button[aria-label="Close"],button[aria-label="关闭"],[data-testid="beast-core-modal-close"],[class*="MDL_closeIcon_"],[class*="MDL_closeBtn_"]';
    const icons = nodes(popup, selector).filter(node => enabled(node) &&
      !node.closest("a[href]") && !node.form && /^(?:[×✕✖])?$/u.test(text(node)));
    const close = unique(icons.filter(node => !icons.some(parent => parent !== node && parent.contains(node))));
    if (!close) return failure("popup-unrecognized", "弹窗的关闭图标无法唯一定位，请关闭后重试。");
    close.click();
    return { ok: true, dismissed: true };
  }
  if (action === "dismiss") return { ok: true };

  const account = unique([...new Set(nodes(document, accountNodes).map(text).filter(Boolean))]);
  if (!account) return failure("loading", "正在核对商家账号。");
  const statusText = (node, name) => {
    const value = text(node);
    return value === name || value.startsWith(name) && /^\s*\(?[\d,]+\)?$/u.test(value.slice(name.length));
  };
  function locateSection(name) {
    const alias = translations?.[sections.indexOf(name)];
    const candidates = source === "orders" ? nodes(document, ".state-wrap .state")
      : source === "chat" ? nodes(document, '[class*="conv-list_panel-wrapper_left_label__"]')
      : nodes(document, '[data-testid="beast-core-tab-itemLabel"]');
    return unique(candidates.filter(node => statusText(node, name) || alias && statusText(node, alias)));
  }
  const selector = locateSection(section);
  function hasSelected(node) {
    if (!node) return false;
    if (source === "orders") return node.classList.contains("active");
    return node.getAttribute("aria-selected") === "true" ||
      /(?:^|\s)TAB_(?:active|lineLabelActive)_/u.test(node.className);
  }
  if (action === "section") {
    if (!selector) return source === "funds" ? { ok: true } : failure("loading", "还没有找到指定页签。");
    if (source === "chat") {
      const group = selector.closest('[class*="conv-list_panel-wrapper__"]');
      if (!group?.querySelector('[class*="right_icon--active"]')) selector.click();
    } else if (!hasSelected(selector)) selector.click();
    return { ok: true };
  }

  if (source === "orders" && (action === "focus-filter" || action === "search")) {
    const range = nodes(document, ".date-picker input.el-range-input");
    const search = unique(nodes(document, "button").filter(node =>
      /^(?:[\uE000-\uF8FF]\s*)?(?:搜索|search)$/iu.test(text(node)) && enabled(node)));
    const payment = nodes(document, ".el-select__selected-item").some(node => /^(付款时间|Payment time)$/iu.test(text(node)));
    if (!payment || range.length !== 2 || !search) return failure("loading", "还没有定位到付款时间筛选。");
    const number = orderNumber && unique(nodes(document, "input").filter(input => /^(订单号，|Order numbers,)/u.test(input.placeholder)));
    if (orderNumber && !number) return failure("loading", "还没有定位到订单号筛选。");
    if (action === "focus-filter") {
      const entry = { start: [range[0], start], end: [range[1], end], orderNumber: [number, orderNumber] }[field];
      if (!entry?.[0] || !entry?.[1] || entry[0].readOnly || !enabled(entry[0])) return failure("filter-unverified", "付款日期或订单号控件不可用。");
      const [input, value] = entry;
      if (input.value === value) return { ok: true, unchanged: true };
      input.click();
      input.focus();
      input.select();
      if (document.activeElement !== input || input.selectionStart !== 0 || input.selectionEnd !== input.value.length) {
        return failure("filter-unverified", "未能核对付款日期或订单号的输入焦点。");
      }
      return { ok: true, value };
    }
    if (number && number.value !== orderNumber) return failure("filter-unverified", "订单号未回显。");
    if (range[0].value !== start || range[1].value !== end) return failure("filter-unverified", "付款时间未回显。");
    search.click();
    return { ok: true };
  }

  if (nodes(document, '.el-loading-mask,[aria-busy=true],[class*="SPIN_spinning_"]').some(n =>
    getComputedStyle(n).opacity !== "0")) return failure("loading", "正在加载列表。");
  if (source !== "funds" && source !== "chat" && !hasSelected(selector)) return failure("loading", "正在核对页签。");
  const scroller = source === "orders" ? unique(nodes(document, ".dynamic-scroller-ref.vue-recycle-scroller")) : null;
  const nextNodes = nodes(document, source === "orders" ? ".el-pagination button.btn-next"
    : '[data-testid="beast-core-pagination-next"],[data-testid="beast-core-pagination"] button[aria-label="下一页"]');
  const next = unique(nextNodes.filter(enabled));
  if (action === "order-sort" && source === "orders") {
    const label = unique(nodes(scroller || document, ".vue-recycle-scroller__slot div").filter(node =>
      /^(付款时间|Payment time)$/iu.test(text(node)) &&
      node.querySelector(":scope > p > i.icon-shouqi") &&
      node.querySelector(":scope > p > i.icon-xiala-baise")));
    const icons = [label?.querySelector(":scope > p > i.icon-shouqi"), label?.querySelector(":scope > p > i.icon-xiala-baise")];
    const current = icons.findIndex(icon => icon?.classList.contains("!text-primary"));
    if (current < 0 || !icons.every(icon => shown(icon) && enabled(icon))) return { ok: true };
    const index = field === "ascending" ? 0 : field === "descending" ? 1 : 1 - current;
    if (index !== current) icons[index].click();
    return { ok: true, previousSort: current === 0 ? "ascending" : "descending" };
  }
  if (action === "expand-order-list" && source === "orders") {
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return { ok: true };
    // Give the virtual list more room in the temporary collector tab so it reuses fewer rows.
    scroller.style.setProperty("min-height", Math.min(scroller.scrollHeight + 40, 7000) + "px");
    return { ok: true };
  }
  if (action === "scroll") {
    if (!scroller) return failure("list-changed", "订单滚动区域已变化。");
    scroller.scrollTop += Math.max(1, Math.floor(scroller.clientHeight * 0.5));
    return { ok: true };
  }
  if (action === "next") {
    if (!next || next.closest("a[href]") || next.form) return failure("page-changed", "下一页控件已变化。");
    next.click();
    return { ok: true };
  }
  if (action !== "read") return failure("unsupported", "无效的采集操作。");

  if (source === "chat") {
    const parent = selector?.closest('[class*="conv-list_panel-wrapper__"]')?.nextElementSibling;
    if (!parent?.matches('[class*="conv-list_panel-content__"]')) return failure("loading", "正在读取待回复列表。");
    const wrap = text(parent);
    const blank = nodes(parent, "div,span").some(node => /^(暂无会话|没有更多会话了)$/u.test(text(node)));
    const rows = nodes(parent, '[class*="conv-item_conv-item__"]');
    if (!rows.length && !blank) return { ...failure("chat-collapsed", "正在展开待回复列表。"), account };
    const records = rows.map(row => {
      const name = text(row.querySelector('[class*="name_name__"]'));
      const time = text(row.querySelector('[class*="msg-time_msg-time__"]'));
      const message = text(row.querySelector('[class*="msg-content_msg-content__"]'));
      const identity = row.getAttribute("data-conversation-id") || [name, time, message].join("|");
      return { id: identity, fields: { 会话: name, 时间: time, 最新消息: message.slice(0, 1000) } };
    });
    return { ok: true, account, records, total: records.length, next: false, more: rows.length > 0 && !/没有更多会话了/u.test(wrap) };
  }

  if (source === "orders") {
    const paidRange = nodes(document, ".date-picker input.el-range-input").map(input => input.value);
    if (start && (paidRange[0] !== start || paidRange[1] !== end)) return failure("filter-unverified", "付款时间筛选已变化。");
    const page = Number(text(document.querySelector(".el-pagination .el-pager .is-active"))) || 1;
    const totalLabel = text(document.querySelector(".el-pagination__total"));
    const totalMatch = totalLabel.match(/^(?:共(?:有)?|A total of)\s*([\d,]+)\s*(?:条|items)/iu);
    const blank = nodes(document, "div,span").some(n => /^(数据为空|暂无数据|Data is empty)$/iu.test(text(n)));
    if (!scroller && !blank) return failure("loading", "正在等待订单列表。");
    const origin = scroller?.getBoundingClientRect().top ?? 0;
    const rows = nodes(scroller || document, ".virtual-table-row-tr").filter(row =>
      !scroller || !row.closest(".vue-recycle-scroller__item-view") ||
      row.getBoundingClientRect().bottom + scroller.scrollTop >= origin);
    const records = rows.flatMap(row => {
      const cells = nodes(row, ".virtual-table-row-td");
      const id = text(cells[3]).match(/\bPO[-–]\d{2,4}[-–][\d\s]{7,}/iu)?.[0]?.replace(/\s+/gu, "") ||
        text(cells[3]).match(/^\d{8,}(?:-\d{4,})*/u)?.[0];
      if (!id) return [];
      return [{ id, fields: { 订单号: id, 店铺: text(cells[2]), 订单状态: text(cells[4]), 付款时间: text(cells[5]) } }];
    });
    // DOM row count excludes virtual spacers and product detail rows.
    const observed = rows.filter(row => nodes(row, ".virtual-table-row-td").length >= 10).length;
    if (!records.length && !blank) return failure("order-unreadable", "订单表已显示，但还未识别到订单号。");
    return { ok: true, account, records, total: totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : blank ? 0 : null,
      page, invalidRows: observed > records.length, next: Boolean(next), more: Boolean(scroller &&
        scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2) };
  }

  const heads = nodes(document, 'thead[data-testid="beast-core-table-middle-thead"]');
  const full = heads.filter(thead => [...thead.querySelectorAll("th")].some(cell => text(cell) === header));
  const head = full.sort((a, b) => b.querySelectorAll("th").length - a.querySelectorAll("th").length)[0];
  if (!head) return failure("loading", "正在等待目标列表的表头。");
  const names = [...head.querySelectorAll("th")].map(text);
  const columns = new RegExp(allowedFields, "u");
  const table = head.closest('[data-testid="beast-core-table"]');
  const tbody = unique(nodes(table || document, 'tbody[data-testid="beast-core-table-middle-tbody"]'));
  const body = tbody || unique(nodes(table || document, '[data-testid="beast-core-table-middle-body"]'));
  if (!body) return failure("loading", "正在等待目标表格的内容。");
  const empty = nodes(table || body, 'div,span').some(node => /^(暂无数据|暂无记录)$/u.test(text(node)));
  const items = nodes(body, "tr").map(row => [...row.children].filter(el => el.tagName === "TD"));
  const records = items.flatMap(cells => {
    if (cells.length !== names.length) return [];
    const fields = Object.fromEntries(names.flatMap((name, i) =>
      columns.test(name) ? [[name, text(cells[i]).slice(0, 3500)]] : []));
    const id = fields[header]?.split(/[\s：:]/u)[0];
    return id ? [{ id: source === "funds" ? fields[header] : id, fields }] : [];
  });
  const totalMatch = text(document.body).match(/共有?\s*([\d,]+)\s*条/u);
  const total = totalMatch ? Number(totalMatch[1].replaceAll(",", "")) : empty ? 0 : null;
  const pageNode = nodes(document, '[class*="PGT_pagerItemActive_"],[aria-current="page"]').find(n => /^\d+$/u.test(text(n)));
  if (!records.length && !empty && total !== 0) return failure("loading", "正在等待目标列表结果。");
  return { ok: true, account, records, total, page: Number(text(pageNode)) || 1,
    invalidRows: items.length > records.length && !empty, next: Boolean(next), more: false };
}
