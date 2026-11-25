// Serialized into the seller tab. Commands here operate only on the configured list.
export function readDailyPage({ source, targetUrl, sections, translations, header, allowedFields, mode,
  action = "read", section, start, end, orderNumber, field, recordId, expectedAccount }) {
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
  if (mode === "analytics") return analytics();
  if (mode === "campaigns") return campaigns();
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

  function analytics() {
    const controls = nodes(document, "button,span,div,li");
    const labelsFor = name => controls.filter(node => text(node) === name &&
      ![...node.children].some(child => text(child) === name));
    if (source === "traffic" && action === "section") {
      const heading = unique(labelsFor("汇总分析"));
      const options = labelsFor(section);
      let target;
      for (let parent = heading?.parentElement, i = 0; parent && i < 10; parent = parent.parentElement, i++) {
        const local = options.filter(node => parent.contains(node));
        if (!local.length) continue;
        const control = unique(local);
        target = control?.closest("button,[role=tab],[role=radio]") || control;
        break;
      }
      if (!target || !enabled(target) || target.closest("a[href]") || target.form) {
        return failure("loading", "还没有定位到流量周期选项。");
      }
      target.click();
      return { ok: true };
    }
    if (action === "section") return { ok: true };
    if (action !== "read") return failure("unsupported", "不支持此经营分析操作。");

    if (source === "home") {
      const yesterday = section === "昨日流量";
      const metrics = yesterday
        ? ["商品访客数", "商品浏览量", "商品加购人数", "商品收藏人数", "商详支付买家数", "全部支付买家数"]
        : ["待发货", "已售罄", "低库存预警", "售罄影响交易额占比", "库存可售天数", "在售商品数",
          "今日销量", "近7日销量", "近30日销量", "近90日品质退货率"];
      const date = text(document.body).match(/昨日流量\s*统计日期\s*[:：]?\s*(\d{4}-\d{2}-\d{2})/u)?.[1];
      if (yesterday && !date) return failure("loading", "正在等待首页昨日流量的统计日期。");
      const records = metricRecords(metrics);
      if (records.length !== metrics.length) return failure("loading", "正在等待首页经营指标。");
      return metricSnapshot(records, yesterday ? date : undefined);
    }

    const metrics = source === "traffic"
      ? ["商品曝光量", "商品点击量", "支付订单数", "支付件数", "点击率", "点击订单转化率", "曝光订单转化率"]
      : source === "sales"
        ? ["今日总销量", "售罄健康分数", "无法报名活动商品数", "待反馈", "待补货", "未按期补货",
          "SKU售罄数&占比", "低库存预警SKU数&占比", "新增SKU售罄数&占比", "售罄影响GMV&占比"]
        : ["活动销量", "活动GMV", "活动商品数", "曝光用户数", "点击用户数", "点击转化率", "支付转化率"];
    const rawBody = text(document.body);
    const date = rawBody.match(source === "traffic"
      ? /统计时间\s*[:：]\s*北京时间\s*(\d{4}-\d{2}-\d{2}(?:\s*[~～至-]\s*\d{4}-\d{2}-\d{2})?)/u
      : /(?:最后|最近)更新时间\s*[:：]\s*(?:北京时间\s*)?(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?)/u)?.[1];
    if (!date) return failure("loading", "正在等待分析页面的统计时间。");

    const records = metricRecords(metrics);
    if (records.length < (source === "traffic" ? metrics.length : 2)) {
      return failure("loading", "正在等待对应周期的分析指标。");
    }
    return metricSnapshot(records, date);

    function metricSnapshot(records, date) {
      return { ok: true, account, records, total: records.length, next: false, more: false,
        meta: { ...(date && { date }), type: "metrics" } };
    }

    function metricRecords(metrics) {
      const normalize = value => value.replace(/\s+/gu, "");
      return metrics.flatMap(name => {
        const values = new Map();
        const measurable = /^(?:[¥￥$€])?\s*(?:[-+]?\d[\d,]*(?:\.\d+)?%?(?:\s*\(\s*\d+(?:\.\d+)?%\s*\))?|--|—|暂无数据|-)(?=\s|较|$)/u;
        for (const label of controls.filter(node => normalize(text(node)) === name &&
          ![...node.children].some(child => normalize(text(child)) === name))) {
          const found = [];
          for (let node = label.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
            const content = text(node);
            if (content.length > 220 || !normalize(content).startsWith(name)) break;
            let i = 0;
            for (let count = 0; count < name.length && i < content.length; i++) {
              if (!/\s/u.test(content[i])) count++;
            }
            const remainder = content.slice(i).trim();
            const value = remainder.match(measurable)?.[0];
            if (!value) continue;
            const compare = remainder.match(/较前[17]日|较昨日|较近7日/gu);
            if (source === "traffic" && !compare?.includes(section.replace("近", "较前"))) continue;
            found.push({ value, change: compare ? remainder.slice(value.length).trim().slice(0, 85) : "" });
            if (compare) break;
          }
          const candidate = found.at(-1);
          if (candidate) values.set(candidate.value, candidate);
        }
        if (values.size !== 1) return [];
        const { value, change } = values.values().next().value;
        return [{ id: name, fields: { 指标: name, 数值: value, ...(change && { 平台对比: change }) } }];
      });
    }
  }

  function campaigns() {
    const invitation = section === "邀约活动";
    const controlName = invitation ? "邀约详情" : "报名";
    const categoryNames = ["直降促销活动", "专属补贴活动"];
    const categoryCards = [];
    if (!invitation) {
      const labels = nodes(document, "span,div,h2,h3,h4").filter(node =>
        categoryNames.includes(text(node)) && ![...node.children].some(child => text(child) === text(node)));
      for (const label of labels) {
        const name = text(label);
        let card = label;
        while (card.parentElement && text(card.parentElement).length < 400 &&
          !categoryNames.some(other => name !== other && text(card.parentElement).includes(other))) {
          card = card.parentElement;
        }
        const parent = card.parentElement;
        if (parent && text(parent).length < 400 && categoryNames.every(category => text(parent).includes(category))) {
          categoryCards.push({ name, card, label });
        }
      }
      const current = unique(categoryCards.filter(item => item.name === section));
      const other = unique(categoryCards.filter(item => item.name !== section));
      if (!current || !other) return failure("loading", "正在定位活动类型。");
      const active = ({ card, label }) => {
        for (let node = label; node && card.contains(node); node = node.parentElement) {
          if (node.matches('[aria-selected=true],[aria-checked=true],[data-state=active]') ||
            /(?:^|[-_\s])(?:active|selected|checked)(?:$|[-_\s])/iu.test(String(node.className))) return true;
          const style = getComputedStyle(node);
          const rgb = style.borderTopColor?.match(/\d+/gu)?.map(Number);
          if (parseFloat(style.borderTopWidth) > 0 && rgb?.length >= 3 && rgb[2] > rgb[0] + 30 && rgb[2] > rgb[1] + 10) return true;
        }
        return false;
      };
      if (action === "section") {
        if (!active(current)) current.label.click();
        return { ok: true };
      }
      if (!active(current) || active(other)) return failure("loading", "正在核对活动类型是否已切换。");
    } else if (action === "section") return { ok: true };
    if (action !== "read" && action !== "campaign-open") return failure("unsupported", "不支持此活动操作。");

    const actions = nodes(document, 'button,a,[role="button"]').filter(node => text(node) === controlName);
    const rows = [];
    for (const control of actions) {
      let card = invitation ? control.parentElement : control.closest("tr");
      for (let depth = 0; card && depth < (invitation ? 7 : 1); depth++, card = card.parentElement) {
        const body = text(card);
        if (body.length > 1400 || (invitation && actions.filter(node => card.contains(node)).length !== 1)) break;
        const cells = [...card.children].filter(node => node.matches("td"));
        const dates = (invitation ? body : text(cells[1])).match(
          /\d{4}-\d{2}-\d{2}\s*[~～至-]\s*\d{4}-\d{2}-\d{2}|长期有效/u)?.[0];
        if (invitation && (!dates || !body.includes("邀约潜力商品") || !body.includes("活动详情"))) continue;
        if (!invitation && (cells.length !== 6 || !cells.at(-1).contains(control) || !dates)) break;
        const name = (invitation ? body.split("活动详情")[0] : text(cells[0])).replace(/\s+NEW$/iu, "").trim();
        if (!name) break;
        const id = JSON.stringify([name, dates.replace(/\s/gu, "")]);
        const discount = invitation ? body.match(/申报折扣\s*([≤≥<>]?\s*\d+(?:\.\d+)?\s*折)/u)?.[1] : text(cells[2]);
        const potential = body.match(/邀约潜力商品\s*(\d+\s*\/\s*\d+)/u)?.[1];
        const deadline = body.match(/\d+\s*(?:天|小时|分钟)后截止/u)?.[0];
        rows.push({ control, id, fields: { 活动名称: name, 活动周期: dates,
          ...(discount && { 申报条件: discount }), ...(potential && { 邀约潜力商品: potential }),
          ...(deadline && { 报名截止: deadline }),
          ...(!invitation && { 库存条件: text(cells[3]), 已报名: text(cells[4]) }),
        } });
        break;
      }
    }

    function validAction(node) {
      const href = node.getAttribute("href");
      if (!enabled(node) || node.form) return false;
      if (!href || href === "#" || /^javascript:void\(0\);?$/iu.test(href)) return true;
      try {
        const url = new URL(href, location.href);
        return url.origin === location.origin && /^\/activity\/marketing-activity(?:\/|$)/u.test(url.pathname);
      } catch {
        return false;
      }
    }

    if (action === "campaign-open") {
      if (account !== expectedAccount) return failure("account-changed", "当前店铺与报告中的店铺不同。");
      const row = unique(rows.filter(row => row.id === recordId && validAction(row.control)));
      if (!row) return failure("not-matched", "未找到唯一且可用的活动按钮，请在活动页确认。");
      row.control.click();
      return { ok: true };
    }
    const advertised = invitation ? null : text(document.body).match(/符合条件的活动数量\s*[:：]\s*([\d,]+)/u)?.[1];
    const total = advertised == null ? null : Number(advertised.replaceAll(",", ""));
    if (!rows.length && total !== 0) return failure("loading", "正在等待营销活动列表。");
    const counts = new Map();
    for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
    const records = [...new Map(rows.map(row => [row.id, {
      id: row.id, fields: row.fields,
      ...(counts.get(row.id) === 1 && validAction(row.control) && { action: controlName }),
    }])).values()];
    return { ok: true, account, records, total: total ?? records.length, next: false, more: false };
  }
}
