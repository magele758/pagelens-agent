// This function is serialized by chrome.scripting. Keep its helpers inside it.
export async function temuControls(request) {
  const ORIGIN = "https://agentseller.temu.com";
  const PATH = "/goods/edit";
  const WRAPPER = '[class*="ST_outerWrapper_"]';
  const HEAD = '[class*="ST_head_"]';
  const FORM_CONTROLS = 'input,textarea,select,[role="combobox"],[role="radio"],[role="checkbox"],[contenteditable="true"]';
  const MENU = '[data-testid="beast-core-portal"] [role="listbox"],[class*="ST_dropdown_"] [role="listbox"]';
  const LABEL = 'label,[data-field-label],[class*="Form_itemLabelContent_"]';
  const MODAL = 'dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]';
  const MAX_FIELDS = 100;
  const MAX_OPTIONS = 400;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clean = (value, limit = 300) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, limit);
  const key = (value) => clean(value, 1000).normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
  const fail = (code, message, changed = false) => ({ ok: false, code, message, ...(changed ? { changed } : {}) });
  const scope = request.scope || {};
  const validPage = () => window === window.top && location.origin === ORIGIN && location.pathname === PATH &&
    scope.href === location.href;
  const visible = (element) => Boolean(element?.isConnected && element.getClientRects().length &&
    !element.closest('[hidden],[inert],[aria-hidden="true"]') &&
    getComputedStyle(element).visibility !== "hidden" && (getComputedStyle(element).opacity || "1") !== "0");
  const blocked = () => Array.from(document.querySelectorAll(MODAL)).some(visible);
  const editable = (input) => !input.disabled && !input.closest('[aria-disabled="true"],[aria-readonly="true"],[class*="ST_disabled_"]') &&
    /^(?:text|search)$/.test(input.type);
  const groups = (element) => {
    const result = [];
    for (let node = element.parentElement, i = 0; node && i < 14; node = node.parentElement, i++) {
      if (node.matches("body,main")) break;
      if (/^[A-Za-z_][A-Za-z0-9_[\].:-]{1,110}$/.test(node.id) && document.getElementById(node.id) === node) result.push(node);
    }
    return result;
  };
  const labelText = (node) => clean(node?.textContent).replace(/^[*＊]\s*/u, "").replace(/[：:]$/u, "");

  function labelFor(input, group) {
    const parent = /^minorSpec\.(\d+)\.selectedRootSpecId$/u.exec(group.id);
    if (parent) return `父规格 ${Number(parent[1]) + 1}`;
    const fixed = {
      productOriginCode: "商品产地", manufacturingLocation: "制造地点",
      shipmentLimitSecond: "承诺发货时效", freightTemplateId: "运费模板",
    }[group.id];
    if (fixed) return fixed;
    if (/^productSkuMap\.[\w-]*\.sensitiveAttr$/u.test(group.id)) return "敏感属性";
    if (/^productSkuMap\.[\w-]*\.productSkuMultiPack\.skuClassification$/u.test(group.id)) return "SKU 分类";
    const aria = clean(input.getAttribute("aria-label"));
    if (aria) return aria;
    const ids = clean(input.getAttribute("aria-labelledby")).split(/\s+/);
    const fromIds = ids.map((id) => labelText(document.getElementById(id))).filter(Boolean).join(" ");
    if (fromIds) return fromIds;
    for (const label of group.querySelectorAll(LABEL)) {
      const name = labelText(label);
      if (name && !label.closest(WRAPPER) && !label.querySelector("input,select,textarea")) return name;
    }
    let child = group;
    for (let depth = 0; depth < 3 && child.parentElement; depth++, child = child.parentElement) {
      if (child.parentElement.querySelectorAll(WRAPPER).length > 1) break;
      const sibling = child.previousElementSibling;
      const label = sibling?.matches(LABEL) ? sibling : sibling?.querySelector(LABEL);
      if (labelText(label)) return labelText(label);
    }
    const header = group.closest("td")?.closest("table")?.tHead?.rows[0]?.cells[group.closest("td")?.cellIndex];
    return labelText(header);
  }

  function info(input) {
    if (!input || !visible(input) || !editable(input)) return null;
    const wrapper = input.closest(WRAPPER);
    if (!wrapper || input.closest(HEAD)?.closest(WRAPPER) !== wrapper) return null;
    for (const group of groups(wrapper)) {
      if (/^(?:page_container_id|sku_table_node|root|app)$/i.test(group.id)) continue;
      const selector = `[id="${group.id}"] ${WRAPPER} ${HEAD} input`;
      const candidates = Array.from(document.querySelectorAll(selector)).filter((node) => visible(node) && editable(node));
      if (candidates.length !== 1 || candidates[0] !== input) continue;
      const label = labelFor(input, group);
      if (!label || /密码|验证码|安全码|动态口令|\b(?:password|captcha|passcode|otp)\b/i.test(label)) continue;
      const item = group.closest('[data-testid="beast-core-form-item"],[class*="Form_item_"]');
      const required = input.required || input.getAttribute("aria-required") === "true" ||
        /^(?:productOriginCode|manufacturingLocation|shipmentLimitSecond|freightTemplateId)$/u.test(group.id) ||
        /^productSkuMap\.[\w-]*\.sensitiveAttr$/u.test(group.id) ||
        Boolean((item || group).querySelector('[class*="Form_required"],[class*="itemLabelRequired"],[data-required="true"]'));
      const multiple = Boolean(wrapper.querySelector('[class*="ST_selectValueMultiple_"]') || input.getAttribute("aria-multiselectable") === "true");
      const locator = { adapter: "temu-select", tag: "input", type: input.type, role: "combobox", selector, label };
      const selected = [...wrapper.querySelectorAll('[class*="ST_selectValueSingle_"],[class*="ST_selectValueMultipleItem_"]')]
        .filter(visible).map(node => clean(node.textContent)).filter(Boolean);
      return { input, wrapper, field: {
        key: group.id, kind: "select", label, locator, required: Boolean(required), multiple, value: multiple ? selected : selected[0] || "",
        constraints: { ...(required ? { required: true } : {}), ...(multiple ? { multiple: true } : {}) }, options: [],
      } };
    }
    return null;
  }

  function scan() {
    const candidates = Array.from(document.querySelectorAll(`${WRAPPER} ${HEAD} input`)).filter(visible);
    const order = new Map(Array.from(document.querySelectorAll(FORM_CONTROLS), (element, index) => [element, index]));
    const controls = [];
    const unsupported = [];
    for (const input of candidates) {
      const candidate = info(input);
      if (candidate) {
        candidate.field.order = order.get(input);
        controls.push(candidate);
      }
      else if (editable(input)) unsupported.push({ label: clean(input.getAttribute("aria-label") || input.placeholder || "未命名下拉"), kind: "custom-select", reason: "无法唯一定位此下拉控件。" });
    }
    return { controls: controls.slice(0, MAX_FIELDS), unsupported: unsupported.slice(0, MAX_FIELDS) };
  }

  function locate(field) {
    const locator = field?.locator;
    if (locator?.adapter !== "temu-select" || typeof locator.selector !== "string") return null;
    try {
      const matches = Array.from(document.querySelectorAll(locator.selector)).map(info).filter(Boolean)
        .filter((candidate) => candidate.field.locator.selector === locator.selector && key(candidate.field.label) === key(locator.label));
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  const menus = () => Array.from(document.querySelectorAll(MENU)).filter(visible);
  const nonAction = 'a,button,input,select,textarea,label,summary,[role="button"],[role="tab"],[role="link"],[role="option"],[contenteditable="true"]';
  function neutralTitle() {
    const titles = Array.from(document.querySelectorAll('#page_container_id [class*="STP_stepsItemTitle_"]'))
      .filter((node) => clean(node.textContent) === "基本信息" && visible(node) && !node.closest(nonAction) && !node.querySelector(nonAction));
    return titles.length === 1 ? titles[0] : null;
  }
  const containsOptions = (menu) => Boolean(menu.querySelector('[role="option"]'));

  async function poll(pick, ms = 280) {
    const deadline = Date.now() + ms;
    do {
      if (!validPage() || blocked()) return null;
      const value = pick();
      if (value) return value;
      await wait(20);
    } while (Date.now() < deadline);
    return null;
  }

  async function open(control) {
    if (!validPage() || blocked() || menus().length || !control?.input?.isConnected) return null;
    const { input, wrapper } = control;
    const boundary = input.closest(HEAD) || wrapper;
    const rect = boundary.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (rect.width && rect.height && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      typeof document.elementFromPoint === "function") {
      const hit = document.elementFromPoint(x, y);
      if (hit && !wrapper.contains(hit) && !hit.contains(wrapper)) return null;
    }
    const findMenu = () => {
      const openMenus = menus();
      const ids = [input, input.closest(HEAD), wrapper].flatMap((node) =>
        clean(node?.getAttribute("aria-controls") || node?.getAttribute("aria-owns")).split(/\s+/)).filter(Boolean);
      const associated = openMenus.filter((menu) => ids.some((id) => menu.id === id || document.getElementById(id)?.contains(menu)));
      if (associated.length === 1) return associated[0];
      return openMenus.length === 1 && wrapper.contains(document.activeElement) ? openMenus[0] : null;
    };
    input.focus({ preventScroll: true });
    let menu = findMenu();
    if (!menu) {
      await wait(0);
      menu = findMenu();
    }
    if (!menu && !menus().length && validPage() && !blocked()) {
      input.click();
      menu = await poll(findMenu, 350);
    }
    if (!menu && !menus().length && validPage() && !blocked()) {
      const head = input.closest(HEAD);
      if (head && head.closest(WRAPPER) === wrapper) {
        head.click();
        menu = await poll(findMenu, 1400);
      }
    }
    return menu;
  }

  async function close(control, menu) {
    if (!validPage() || !menu || !visible(menu)) return true;
    const input = control.input;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    if (visible(menu) && input === document.activeElement) input.blur();
    if (visible(menu) && menu.contains(document.activeElement)) document.activeElement.blur();
    if (visible(menu)) {
      // The product page's static heading is the usual click-away target.
      const outside = neutralTitle() || document.body;
      const rect = outside.getBoundingClientRect();
      const eventOptions = { bubbles: true, cancelable: true, composed: true,
        clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0 };
      const Pointer = globalThis.PointerEvent || MouseEvent;
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        if (!visible(menu)) break;
        const EventType = type.startsWith("pointer") ? Pointer : MouseEvent;
        outside.dispatchEvent(new EventType(type, { ...eventOptions, pointerType: "mouse", isPrimary: true }));
        await wait(0);
      }
    }
    if (visible(menu)) {
      const sink = document.createElement("span");
      sink.tabIndex = -1;
      sink.style.cssText = "position:fixed;width:0;height:0;top:0;left:0;pointer-events:none";
      document.body.append(sink);
      try {
        sink.focus({ preventScroll: true });
        await wait(0);
      } finally {
        sink.remove();
      }
    }
    if (visible(menu)) await poll(() => !visible(menu), 220);
    if (visible(menu) && validPage() && !blocked() && menus().length === 1) {
      const head = input.closest(HEAD);
      if (head?.closest(WRAPPER) === control.wrapper && visible(head)) {
        head.click();
        await poll(() => !visible(menu), 180);
      }
    }
    return !visible(menu);
  }

  function choices(menu) {
    return Array.from(menu.querySelectorAll('[role="option"]')).filter(visible).map((element) => {
      const label = clean(element.textContent, 500);
      const value = clean(element.getAttribute("data-value") || element.getAttribute("value") || label, 1000);
      const aliases = Array.from(element.querySelectorAll("span,[aria-label]"))
        .map((node) => clean(node.getAttribute("aria-label") || node.textContent)).filter(Boolean);
      const status = element.getAttribute("data-checked") ?? element.getAttribute("aria-selected");
      const disabled = element.matches('[data-disabled="true"],[aria-disabled="true"],[disabled],a[href]') ||
        Boolean(element.querySelector('a[href]'));
      return { element, label, value, aliases, status, disabled };
    }).filter((entry) => entry.label);
  }

  function observed(control, menu, rows = choices(menu)) {
    const multiple = control.field.constraints.multiple || menu.getAttribute("aria-multiselectable") === "true";
    return {
      ...control.field,
      constraints: { ...control.field.constraints, ...(multiple ? { multiple: true } : {}) },
      options: rows.slice(0, MAX_OPTIONS).map(({ label, value, disabled }) => ({ label, value, ...(disabled ? { disabled } : {}) })),
    };
  }

  function pickOption(rows, value) {
    const normalized = key(value);
    const direct = rows.filter((entry) => key(entry.value) === normalized || key(entry.label) === normalized);
    const matches = direct.length ? direct : rows.filter((entry) => entry.aliases.some((alias) => key(alias) === normalized));
    if (matches.length !== 1 || matches[0].disabled) return null;
    return matches[0];
  }

  async function probe(control) {
    const menu = await open(control);
    if (!menu) return fail("MENU_UNAVAILABLE", "无法安全打开该下拉选项列表。");
    let result;
    let closed;
    try {
      await poll(() => containsOptions(menu), 1400);
      const rows = choices(menu);
      const field = observed(control, menu, rows);
      result = { ok: true, field, options: field.options };
    } finally {
      closed = await close(control, menu);
    }
    return closed ? result : fail("MENU_STILL_OPEN", "Temu 的选项菜单尚未关闭。");
  }

  function checkValues(control, value) {
    const multiple = Boolean(control.field.constraints.multiple);
    const values = multiple ? value : [value];
    if (!Array.isArray(values) || values.some((item) => (typeof item !== "string" && typeof item !== "number") || !key(item)) ||
      values.length > MAX_OPTIONS || new Set(values.map(key)).size !== values.length) {
      return fail("INPUT_TYPE", multiple ? "此多选下拉需要不重复的选项数组。" : "此下拉需要一个选项名称或选项值。");
    }
    if (!values.length && control.field.constraints.required) return fail("INPUT_REQUIRED", "当前下拉至少需要一个选项。");
    return { ok: true, values, multiple };
  }

  async function select(control, field, value) {
    const checked = checkValues(control, value);
    if (!checked.ok) return checked;
    let menu = await open(control);
    if (!menu) return fail("MENU_UNAVAILABLE", "无法安全打开该下拉选项列表。");
    let changed = false;
    let live = control;
    const same = (first, second) => key(first.value) === key(second.value) && key(first.label) === key(second.label);
    const selected = (rows) => rows.filter((row) => row.status === "true" || row.status === "checked");
    try {
      await poll(() => containsOptions(menu), 1400);
      const rows = choices(menu);
      const snapshot = observed(control, menu, rows);
      const desired = checked.values.map((item) => pickOption(rows, item));
      if (desired.some((choice) => !choice) ||
        desired.some((choice, index) => desired.slice(0, index).some((earlier) => same(earlier, choice)))) {
        return fail("OPTION_MISSING", "下拉列表没有唯一匹配的可选值。请使用当前页面显示的完整选项名称。");
      }
      const prior = selected(rows);
      if (checked.multiple && rows.some((row) => row.status == null)) {
        return fail("SELECTION_UNVERIFIED", "此多选下拉没有公开可读的选中状态，需要手动确认。");
      }
      if (!checked.multiple && key(control.field.value) === key(desired[0]?.label) ||
          prior.length === desired.length && desired.every((choice) => prior.some((row) => same(choice, row)))) {
        return { ok: true, status: "unchanged", observed: snapshot };
      }
      const unwanted = checked.multiple ? prior.filter((row) => !desired.some((choice) => same(row, choice))) : [];
      if (unwanted.some((row) => row.disabled)) return fail("OPTION_DISABLED", "当前包含无法取消的选项。");
      const wanted = desired.filter((row) => !prior.some((choice) => same(row, choice)));
      for (const choice of [...wanted, ...unwanted]) {
        if (!validPage() || blocked()) return fail("PAGE_CHANGED", "页面或弹窗发生变化，已停止填写。", changed);
        if (!visible(menu)) {
          live = locate(field);
          menu = live && await open(live);
        }
        const current = menu && choices(menu).filter((row) => same(row, choice));
        if (current?.length !== 1 || current[0].disabled) return fail("OPTION_CHANGED", "下拉选项已变化。", changed);
        current[0].element.click();
        changed = true;
        await wait(25);
      }
      if (!validPage() || blocked()) return fail("PAGE_CHANGED", "页面或弹窗发生变化，请检查填写结果。", changed);
      live = locate(field);
      if (!live) return fail("READBACK_MISMATCH", "选择后无法重新定位此字段。", changed);
      if (!checked.multiple && key(live.field.value) === key(desired[0]?.label)) {
        return { ok: true, status: "filled", observed: snapshot };
      }
      if (!visible(menu)) menu = await open(live);
      const verified = menu && await poll(() => {
        const actual = selected(choices(menu));
        return actual.length === desired.length && desired.every((option) => actual.some((row) => same(option, row)));
      }, 900);
      if (!verified) return fail("READBACK_MISMATCH", "平台未确认目标选项，请检查下拉当前值。", changed);
      return { ok: true, status: "filled", observed: snapshot };
    } finally {
      await close(live || control, menu);
    }
  }

  if (!validPage()) return fail("PAGE_CHANGED", "当前 Temu 商品草稿已变化。");
  if (!document.body || blocked()) return fail("MODAL_BLOCKED", "目标表单未就绪或有弹窗遮挡。");
  if (request.kind === "inspect") {
    const { controls, unsupported } = scan();
    return { ok: true, fields: controls.map(({ field }) => field), unsupported };
  }

  const { field, value } = request;
  const control = locate(field);
  if (!control) return fail("FIELD_MISSING", "无法在当前 Temu 表单唯一定位这个下拉控件。");
  if (request.kind === "probe") return probe(control);
  if (request.kind === "select") return select(control, field, value);
  return fail("ACTION_UNSUPPORTED", "无效的 Temu 控件操作。");
}
