/** The apparel editor renders SKC colors separately from its size selector. */
export async function temuApparelPage({ href, kind, key, value, alternate, allowOpened = false }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const blocked = () => [...document.querySelectorAll('[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const colorSelector = '[id^="productSkcList["][id$=".mainSpec[0]"]';
  const emptyColor = "选择或自定义颜色";
  const colorField = holder => {
    const inputs = [...holder?.querySelectorAll('input') || []].filter(node => visible(node) && /^(?:text|search)$/u.test(node.type));
    const exact = inputs.filter(node => node.placeholder === emptyColor);
    return exact.length === 1 ? exact[0] : !exact.length && inputs.length === 1 ? inputs[0] : null;
  };
  const colorComponent = '[class*="colour-spec-select_colorSpecSelect__"]';
  const colorPopover = '[class*="colour-spec-select_allItemContainer__"],[class*="colour-spec-select_searchContainer__"]';
  const colorOption = '[class*="colour-spec-select_selectItem__"]';
  const triggerSelector = '[class*="ST_head_"],[data-testid="beast-core-popover-trigger-wrapper"]';
  const colorWrapper = input => input?.closest(colorComponent) || input?.closest('[class*="ST_outerWrapper_"]');
  const visiblePopup = node => {
    if (!visible(node)) return false;
    const host = node.closest('[data-testid="beast-core-portal"]') || node;
    return [node, host].every(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (style.opacity || "1") !== "0" && style.pointerEvents !== "none" &&
        (!rect.width || !rect.height || rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth);
    });
  };
  const standardMenus = () => {
    const listboxes = [...document.querySelectorAll('[role="listbox"]')].filter(visiblePopup);
    const fallbacks = [...document.querySelectorAll('[class*="ST_dropdown_"]')].filter(menu => visiblePopup(menu) &&
      menu.querySelector('[role="option"],[data-testid="beast-core-select-option"]') && !listboxes.some(listbox => menu.contains(listbox)));
    return [...listboxes, ...fallbacks.filter(menu => !fallbacks.some(parent => parent !== menu && parent.contains(menu)))];
  };
  const nativeMenus = () => [...document.querySelectorAll(colorPopover)].filter(menu =>
    visiblePopup(menu) && (menu.closest('[data-testid="beast-core-portal"]') || root?.contains(menu)));
  const holders = () => [...root?.querySelectorAll(colorSelector) || []].filter(holder => visible(holder) &&
    /^productSkcList\[\d{1,3}\]\.mainSpec\[0\]$/u.test(holder.id) &&
    (colorField(holder)?.placeholder === emptyColor || selectedColor(holder)));
  const selectedColor = holder => {
    const input = colorField(holder);
    const selected = [...holder.querySelectorAll('[class*="ST_selectValueSingle_"]')].find(visible);
    if (selected) return clean(selected.textContent);
    if (!colorWrapper(input)) return clean(input?.value);
    // Temu changes this prompt to the saved color when a custom value is accepted.
    const prompt = clean(input.placeholder);
    return prompt && ![emptyColor, "请选择", "请选择颜色", "请输入"].includes(prompt) &&
      (!input.value || clean(input.value) === prompt) ? prompt : "";
  };
  const rows = () => holders().map(holder => ({
    key: holder.id,
    value: selectedColor(holder),
  }));
  const target = () => holders().find(row => row.id === key);
  const findAnchor = () => {
    const holder = target();
    const input = colorField(holder);
    const wrapper = colorWrapper(input);
    if (!wrapper || !input || input.disabled || input.closest('[aria-disabled="true"],[data-disabled="true"]')) return null;
    return { holder, input, wrapper, trigger: input.closest(triggerSelector) };
  };

  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "Temu 服装规格页已切换或有弹窗。");
  if (["composition-inspect", "composition-add", "composition-percentage"].includes(kind)) return composition();
  if (kind === "set-sizes") return setSizes();
  if (kind === "select-size-chart") return selectChart();
  if (kind === "inspect") return { ok: true, rows: rows() };
  if (kind === "color-target") return colorTarget();
  if (kind === "set-color") return setColor();
  if (kind !== "add-color") return fail("ACTION_UNSUPPORTED", "此操作不属于服装规格试填。");
  const before = holders();
  if (!before.length || before.length >= 20) return fail("SPEC_VALUES_NOT_RENDERED", "当前服装颜色表缺失或已达到试填上限。");
  const first = before[0];
  for (let area = first.parentElement, depth = 0; area && area !== root && depth < 10; area = area.parentElement, depth++) {
    const links = [...area.querySelectorAll('[class^="product-skc_specItem__"] a,a[class^="product-skc_specItem__"]')].filter(node => visible(node) &&
      !node.matches('[disabled],[aria-disabled="true"]') && /^\+\s*添加$/u.test(clean(node.textContent)) &&
      (!node.hasAttribute("href") || node.getAttribute("href") === "#"));
    if (links.length > 1) return fail("SPEC_VALUES_NOT_RENDERED", "服装颜色表内有多个添加入口。");
    if (links.length === 1 && before.every(holder => area.contains(holder))) {
      links[0].click();
      const deadline = Date.now() + 2200;
      do {
        if (!onPage() || blocked()) return fail("PAGE_CHANGED", "服装颜色页已切换。");
        const after = rows();
        if (after.length === before.length + 1 && after.some(row => !before.some(holder => holder.id === row.key))) {
          return { ok: true, status: "verified", rows: after };
        }
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      break;
    }
  }
  return fail("SPEC_VALUES_NOT_RENDERED", "添加后没有出现新的服装颜色行。");

  async function colorTarget() {
    const anchor = findAnchor();
    const resting = current => current?.wrapper.matches(colorComponent) && !selectedColor(current.holder) &&
      current.input.placeholder === emptyColor && !clean(current.input.value);
    const menuOpen = () => standardMenus().length || nativeMenus().length;
    if (menuOpen()) return fail("MENU_STILL_OPEN", "存在下拉选项打开，请关闭后再选择颜色。");
    if (!resting(anchor)) return fail("SPEC_CONTROL_MISSING", "当前颜色行没有可安全点按的空白输入框。");
    anchor.input.scrollIntoView?.({ block: "center", inline: "nearest" });
    let previousPoint;
    const deadline = Date.now() + 600;
    do {
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "准备点按服装颜色时页面已切换。");
      if (menuOpen()) return fail("MENU_STILL_OPEN", "存在下拉选项打开，请关闭后再选择颜色。");
      const current = findAnchor();
      if (!resting(current)) return fail("SPEC_CONTROL_MISSING", "当前颜色行的输入框已变化。");
      const rect = current.input.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (rect.width && rect.height && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
          (typeof document.elementFromPoint !== "function" || document.elementFromPoint(x, y) === current.input)) {
        if (previousPoint?.x === x && previousPoint.y === y && previousPoint.input === current.input) return { ok: true, x, y };
        previousPoint = { x, y, input: current.input };
      } else previousPoint = undefined;
      await new Promise(resolve => setTimeout(resolve, 40));
    } while (Date.now() < deadline);
    return fail("SPEC_CONTROL_MISSING", "颜色输入框被遮挡或仍在视口外。");
  }

  async function setColor() {
    if (typeof value !== "string" || !clean(value) || value.length > 80) return fail("VALUE_INVALID", "颜色值为空或超过长度限制。");
    const holder = target();
    const input = colorField(holder);
    if (!holder) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
    const wanted = clean(value);
    const alternateLabel = typeof alternate === "string" && alternate.length <= 80 ? clean(alternate) : "";
    const prior = selectedColor(holder);
    if (prior && (prior === wanted || prior === alternateLabel)) return { ok: true, status: "unchanged", value: prior };
    if (prior) return fail("SPEC_VALUES_OCCUPIED", "目标服装颜色行已有内容。");
    if (!input || input.disabled) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
    if (input.maxLength > 0 && value.length > input.maxLength) return fail("VALUE_INVALID", "颜色值超过 Temu 字数限制。");

    const setText = (control, text) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(control, text);
      control.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      if (control.isConnected && onPage()) control.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const wrapper = colorWrapper(input);
    if (allowOpened && !wrapper?.matches(colorComponent)) return fail("SPEC_CONTROL_MISSING", "当前颜色行已变化。");
    let committed = wanted;
    if (wrapper) {
      const picked = await pickColor();
      if (!picked.ok) return picked;
      committed = picked.value;
    } else {
      if (input.readOnly) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
      input.focus();
      setText(input, value);
      input.blur();
    }
    const deadline = Date.now() + 1900;
    let sawCommit = false;
    do {
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
      const current = target();
      const field = colorField(current);
      if (current && selectedColor(current) === committed &&
          field?.getAttribute("aria-invalid") !== "true" && field?.validity?.valid !== false) {
        if (sawCommit) return { ok: true, status: "filled", value: committed };
        sawCommit = true;
      } else sawCommit = false;
      await new Promise(resolve => setTimeout(resolve, 80));
    } while (Date.now() < deadline);
    return fail("READBACK_MISMATCH", "Temu 未保留输入的服装颜色。");

    async function pickColor() {
      const nativePopover = wrapper.matches(colorComponent);
      const menus = () => (nativePopover ? nativeMenus() : standardMenus()).filter(menu =>
        (target()?.contains(menu) || menu.closest('[data-testid="beast-core-portal"],[class*="ST_dropdown_"]')));
      let trustedMenu;
      const related = () => {
        const anchor = findAnchor();
        const visibleMenus = menus();
        if (!anchor || visibleMenus.length !== 1) return null;
        const ids = [anchor.input, anchor.trigger, anchor.wrapper].flatMap(node =>
          clean(node?.getAttribute("aria-controls") || node?.getAttribute("aria-owns")).split(/\s+/u)).filter(Boolean);
        const [menu] = visibleMenus;
        const owned = anchor.holder.contains(menu) || ids.some(id => menu.id === id || document.getElementById(id)?.contains(menu));
        if (allowOpened) {
          if (!nativePopover || standardMenus().some(other => other !== menu && !menu.contains(other) && !other.contains(menu))) return null;
          const active = document.activeElement;
          if (!anchor.wrapper.contains(active) && !((owned || trustedMenu === menu) && menu.contains(active))) return null;
          trustedMenu = menu;
          return menu;
        }
        // The color-specific portal was absent before opening this single pinned row.
        return owned || nativePopover || !ids.length &&
          (anchor.holder.contains(document.activeElement) || menu.contains(document.activeElement)) ? menu : null;
      };
      let menu;
      if (allowOpened) {
        menu = await waitFor(related, 1250);
        if (!menu && menus().length) return fail("MENU_STILL_OPEN", "无法确认已打开的颜色菜单属于当前行。");
      } else {
        if (!await waitFor(() => !menus().length && (!nativePopover || !standardMenus().length), 600)) {
          return fail("MENU_STILL_OPEN", "页面已有下拉选项打开。");
        }
        input.focus({ preventScroll: true });
        menu = await waitFor(related, 180);
        if (!menu && !menus().length && onPage() && !blocked()) {
          const anchor = findAnchor();
          (anchor?.trigger || anchor?.input)?.click();
          menu = await waitFor(related, 650);
        }
        if (!menu && !menus().length && onPage() && !blocked()) {
          const anchor = findAnchor();
          if (anchor?.trigger && anchor.input) anchor.input.click();
          menu = await waitFor(related, 800);
        }
      }
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
      if (!menu) return fail("COLOR_MENU_UNAVAILABLE", "Temu 没有打开当前服装颜色的选项列表。");

      function exactChoice() {
        const menu = related();
        const options = [...menu?.querySelectorAll(nativePopover ? colorOption :
          '[role="option"],[data-testid="beast-core-select-option"]') || []].filter(visible);
        for (const label of new Set([wanted, ...(alternateLabel ? [alternateLabel] : [])])) {
          const matches = options.filter(node => clean(node.textContent) === label);
          if (!matches.length) continue;
          if (matches.length !== 1) return false;
          const option = matches[0];
          if (!option.matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]') && !option.querySelector('a[href]')) {
            option.click();
            return { ok: true, value: label, selectedMenu: menu };
          }
          return false;
        }
        return null;
      }
      async function search(label, timeout) {
        const currentMenu = related();
        const editable = control => visible(control) && !control.readOnly && !control.disabled && /^(?:text|search)$/u.test(control.type);
        const inputs = [...currentMenu?.querySelectorAll("input") || []].filter(editable);
        const editor = inputs.length === 1 ? inputs[0] : !inputs.length && findAnchor()?.input;
        if (editor && editable(editor) && onPage() && !blocked()) {
          editor.focus({ preventScroll: true });
          if (editor.value !== label) setText(editor, label);
        }
        const until = Date.now() + timeout;
        do {
          if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
          const found = exactChoice();
          if (found !== null) return found;
          await new Promise(resolve => setTimeout(resolve, 60));
        } while (Date.now() < until);
        return null;
      }

      async function waitFor(find, timeout) {
        const deadline = Date.now() + timeout;
        do {
          if (!onPage() || blocked()) return null;
          const resolved = find();
          if (resolved) return resolved;
          await new Promise(resolve => setTimeout(resolve, 35));
        } while (Date.now() < deadline);
        return null;
      }

      async function finish(pick) {
        if (!pick.ok) return pick;
        const portal = pick.selectedMenu?.closest('[data-testid="beast-core-portal"]');
        const sameMenu = () => menus().find(mode => mode === pick.selectedMenu || portal?.contains(mode));
        if (!await waitFor(() => !sameMenu(), 420) && menus().length === 1) {
          const label = [...root.querySelectorAll('th,[role="columnheader"]')].filter(element =>
            visible(element) && /^\*?\s*色值$/u.test(clean(element.textContent)) && !element.querySelector('input,button,a'));
          const outside = label.length === 1 && label[0];
          if (outside) for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            if (!onPage() || blocked() || !sameMenu() || menus().length !== 1) break;
            const EventType = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
            outside.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
          }
        }
        if (!await waitFor(() => !sameMenu(), 650)) {
          return fail("MENU_STILL_OPEN", "已选色值，当前颜色菜单尚未收起。");
        }
        return { ok: true, value: pick.value };
      }
      let pick = alternateLabel ? await search(alternateLabel, 1000) : null;
      if (pick) return finish(pick);
      if (pick !== false) pick = await search(value, 1450);
      if (pick) return finish(pick);

      menu = related();
      const current = colorField(target());
      if (pick !== false && current && !current.readOnly && !current.disabled && current.placeholder === emptyColor &&
          clean(current.value) === wanted && onPage() && !blocked()) {
        current.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
        current.blur();
        // Complete the click-away on the page without invoking another form control.
        const neutral = [...root.querySelectorAll('[class*="STP_stepsItemTitle_"]')]
          .filter(node => visible(node) && !node.childElementCount && clean(node.textContent) === "基本信息" &&
            !node.closest('a,button,input,label,[role="button"],[role="link"],[tabindex]'));
        const outside = neutral.length === 1 ? neutral[0] : document.body;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          if (!onPage() || blocked()) return fail("PAGE_CHANGED", "确认自定义颜色时页面已切换。");
          const EventType = type.startsWith("pointer") ? globalThis.PointerEvent || MouseEvent : MouseEvent;
          outside.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true, pointerType: "mouse" }));
        }
        return { ok: true, value: wanted };
      }
      const active = document.activeElement;
      if (current && (findAnchor()?.wrapper.contains(active) || menu?.contains(active))) {
        active.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        active.blur();
      }
      if (visible(menu)) return fail("MENU_STILL_OPEN", "服装颜色下拉尚未关闭，请核对当前页。");
      return fail("SPEC_OPTION_MISSING", `Temu 没有唯一匹配的「${wanted}」颜色。`);
    }
  }

  async function selectChart() {
    const exact = (scope, selector, name) => {
      const matches = [...scope?.querySelectorAll(selector) || []].filter(node => visible(node) &&
        clean(node.textContent) === name && !node.disabled && !node.matches('[aria-disabled="true"],[data-disabled="true"]'));
      return matches.length === 1 ? matches[0] : null;
    };
    const picker = () => {
      const modals = [...document.querySelectorAll('[class*="MDL_inner_"],[aria-modal="true"]')].filter(visible)
        .filter(node => [...node.querySelectorAll("span,div,h2,h3")].some(label =>
          visible(label) && !label.childElementCount && clean(label.textContent) === "选择尺码表模板"));
      return modals.find(node => modals.every(other => other === node || other.contains(node))) || null;
    };
    async function waitFor(check) {
      const deadline = Date.now() + 1800;
      do {
        if (!onPage()) return null;
        const found = check();
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      return null;
    }
    if (typeof value !== "string" || !clean(value)) return fail("VALUE_INVALID", "需要提供准确的 Temu 尺码表模板名。");
    const target = exact(root, 'button,[role="button"]', "添加尺码表");
    if (!target) return fail("SIZE_CHART_MISSING", "当前服装页没有可用的添加尺码表按钮。");
    target.click();
    const modal = await waitFor(picker);
    if (!modal) return fail("SIZE_CHART_MISSING", "未打开选择尺码表模板弹窗。");
    let verified = false;
    try {
      const selector = exact(modal, '[data-testid="beast-core-input-suffix"]', "") ||
        (() => {
          const fields = [...modal.querySelectorAll('input[data-testid="beast-core-select-htmlInput"]')].filter(visible);
          return fields.length === 1 ? fields[0] : null;
        })();
      if (!selector) return fail("SIZE_CHART_MISSING", "尺码表模板列表控件尚未显示。");
      selector.click();
      const option = await waitFor(() => exact(document, '[role="option"],[data-testid="beast-core-select-option"]', clean(value)));
      if (!option || picker() !== modal) return fail("SIZE_CHART_MISSING", "Temu 没有唯一匹配的尺码表模板。");
      option.click();
      const selected = await waitFor(() => [...modal.querySelectorAll('input,[class*="ST_selectValueSingle_"]')]
        .some(node => visible(node) && clean(node.value || node.textContent) === clean(value)));
      const confirm = selected && exact(modal, 'button,[role="button"]', "确认");
      if (!confirm) return fail("READBACK_MISMATCH", "未能核对已选尺码表模板。");
      confirm.click();
      verified = Boolean(await waitFor(() => !picker()));
      return verified ? { ok: true, status: "verified" } : fail("READBACK_MISMATCH", "尺码表弹窗尚未关闭。");
    } finally {
      if (!verified && onPage() && picker() === modal) exact(modal, 'button,[role="button"]', "取消")?.click();
    }
  }

  async function setSizes() {
    const items = [];
    const finish = (code, message) => ({ ...fail(code, message), items });
    const sizeLabel = candidate => clean(candidate).replace(/\s*HOT$/iu, "").trim().toUpperCase();
    const aliases = {
      EXTRASMALL: "XS", XSMALL: "XS", SMALL: "S", MEDIUM: "M", LARGE: "L",
      EXTRALARGE: "XL", XLARGE: "XL", XXLARGE: "2XL", "2XLARGE": "2XL", XXL: "2XL",
      XXXLARGE: "3XL", "3XLARGE": "3XL", XXXL: "3XL", XXXXLARGE: "4XL", "4XLARGE": "4XL", XXXXL: "4XL",
    };
    const sizeKey = label => {
      const compact = label.replace(/[\s-]+/gu, "");
      return Object.hasOwn(aliases, compact) ? aliases[compact] : label;
    };
    const desired = Array.isArray(value?.sizes) ? value.sizes.map(sizeLabel) : [];
    if (!desired.length || desired.length > 20 || new Set(desired.map(sizeKey)).size !== desired.length || desired.some(size => !size)) {
      return finish("VALUE_INVALID", "需要提供不重复的实际尺码。");
    }
    const inputSelector = 'input[data-testid="beast-core-select-htmlInput"],input[readonly]';
    const systemInput = area => {
      const inputs = [...area?.querySelectorAll(inputSelector) || []].filter(visible);
      return inputs.length === 1 ? inputs[0] : null;
    };
    const region = () => {
      const candidates = [...root?.querySelectorAll('[data-testid="beast-core-form-item"]') || []]
        .filter(item => visible(item) && (/^[*＊]?\s*尺码\s*建议/u.test(clean(item.innerText || item.textContent)) ||
          [...item.querySelectorAll("label,span")].some(label => visible(label) && !label.childElementCount &&
            /^[*＊]?\s*尺码$/u.test(clean(label.textContent)))) &&
          systemInput(item) &&
          item.closest('[class^="product-skc_specItem__"]'));
      return candidates.length === 1 ? candidates[0] : null;
    };
    const controls = () => {
      const options = region()?.closest('[class^="product-skc_specItem__"]');
      return [...options?.querySelectorAll('input[type="checkbox"],[role="checkbox"]') || []].flatMap(node => {
        const label = node.closest("label") || [...(node.labels || [])].find(visible);
        const hit = visible(label) ? label : visible(node) ? node : null;
        if (!hit || node.disabled || node.getAttribute("aria-disabled") === "true") return [];
        if (node.matches('[role="checkbox"]') && hit.querySelector('input[type="checkbox"]') && node !== hit.querySelector('input[type="checkbox"]')) return [];
        const size = sizeLabel(node.getAttribute("aria-label") || hit.textContent || node.value);
        return size ? [{ size, hit, checked: node.checked ?? node.getAttribute("aria-checked") === "true" }] : [];
      });
    };
    async function waitFor(check, timeout = 2200) {
      const deadline = Date.now() + timeout;
      do {
        if (!onPage() || blocked()) return null;
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      return null;
    }
    const area = region();
    const input = systemInput(area);
    const systems = ["欧美尺码", "亚洲尺码"];
    const chosenSystem = () => {
      const currentArea = region();
      const field = systemInput(currentArea);
      const selected = [...currentArea?.querySelectorAll('[class*="ST_selectValueSingle_"]') || []].find(visible);
      return [clean(field?.value), clean(selected?.textContent), clean(field?.placeholder)].find(name => systems.includes(name));
    };
    const system = clean(value?.system || chosenSystem());
    if (!input || !systems.includes(system)) return finish("SPEC_CONTROL_MISSING", "请提供当前类目使用的 欧美尺码 或 亚洲尺码。");
    const prior = chosenSystem();
    if (prior && prior !== system) return finish("SPEC_VALUES_OCCUPIED", "页面已选用了不同的尺码体系。");
    if (prior !== system) {
      const options = () => [...document.querySelectorAll('[role="option"],[data-testid="beast-core-select-option"]')]
        .filter(node => visible(node) && (getComputedStyle(node).opacity || "1") !== "0");
      if (options().length) return finish("MENU_STILL_OPEN", "页面已有下拉选项打开。");
      const suffix = [...area.querySelectorAll('[data-testid="beast-core-input-suffix"]')].filter(visible);
      const head = input.closest('[class*="ST_head_"],[data-testid="beast-core-select-header"],[role="combobox"]');
      const trigger = suffix.length === 1 ? suffix[0] : area.contains(head) && visible(head) ? head : input;
      input.focus({ preventScroll: true });
      if (!await waitFor(() => options().length, 180) && onPage() && !blocked() && visible(trigger)) trigger.click();
      const option = await waitFor(() => {
        const matches = options().filter(node => clean(node.textContent) === system);
        return matches.length === 1 && !matches[0].matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]')
          ? matches[0] : null;
      });
      if (!option) return finish("SPEC_OPTION_MISSING", "没有唯一匹配的可用尺码体系。");
      option.click();
    }
    if (!await waitFor(() => chosenSystem() === system && controls().length > 0)) {
      return finish("SPEC_VALUES_NOT_RENDERED", "尚未核对尺码体系和它对应的可用尺码。");
    }
    items.push({ label: system, status: "verified" });
    const unmatched = [];
    for (const size of desired) {
      if (!onPage() || blocked()) return finish("PAGE_CHANGED", "填写服装尺码时页面已切换或有弹窗。");
      const current = controls();
      const exact = current.filter(entry => entry.size === size);
      const matches = exact.length ? exact : current.filter(entry => sizeKey(entry.size) === sizeKey(size));
      if (matches.length !== 1) {
        unmatched.push(size);
        continue;
      }
      const [match] = matches;
      if (match.checked) {
        items.push({ label: match.size, status: "unchanged" });
        continue;
      }
      match.hit.click();
      if (!await waitFor(() => {
        const readback = controls().filter(entry => entry.size === match.size);
        return readback.length === 1 && readback[0].checked;
      })) {
        return finish("READBACK_MISMATCH", `Temu 未确认选择「${match.size}」尺码。`);
      }
      items.push({ label: match.size, status: "filled" });
    }
    if (unmatched.length) return finish("SPEC_OPTION_MISSING", `Temu 没有唯一匹配的尺码：${unmatched.join("、")}。`);
    return { ok: true, status: "verified", items };
  }

  async function composition() {
    const holder = document.getElementById("productProperties[15]");
    if (!holder || !root?.contains(holder) || !visible(holder)) return fail("COMPOSITION_MISSING", "当前类目没有可核对的成分比例表。");
    const fields = () => [...holder.querySelectorAll("tbody tr")].flatMap(row => {
      const fields = [...row.querySelectorAll('input[placeholder="请输入"]')].filter(node =>
        visible(node) && !node.disabled && !node.readOnly && ["text", "number"].includes(node.type));
      const material = row.querySelectorAll('input[placeholder="请选择"]');
      if (fields.length !== 1 || material.length !== 1) return [];
      return [{ index: row.sectionRowIndex, field: fields[0] }];
    });
    const snapshot = () => fields().map(({ index, field }) => ({ index, percent: field.value }));
    if (kind === "composition-inspect") return { ok: true, rows: snapshot() };
    const completed = async (check) => {
      const deadline = Date.now() + 1600;
      do {
        await new Promise(resolve => setTimeout(resolve, 70));
        if (!onPage() || blocked()) return false;
        if (check()) return true;
      } while (Date.now() < deadline);
      return false;
    };
    if (kind === "composition-add") {
      const count = fields().length;
      const links = [...holder.querySelectorAll("a,button")].filter(node => visible(node) && !node.disabled &&
        !node.matches('[aria-disabled="true"]') && clean(node.textContent) === "添加" &&
        (!node.hasAttribute("href") || node.getAttribute("href") === "#"));
      if (count >= 8 || links.length !== 1) return fail("COMPOSITION_MISSING", "成分比例表没有唯一可用的添加按钮。");
      links[0].click();
      return await completed(() => fields().length === count + 1)
        ? { ok: true, rows: snapshot() } : fail("COMPOSITION_MISSING", "添加后未显示新成分行。");
    }
    if (!/^(?:\d+)(?:\.\d{1,2})?$/u.test(value) || Number(value) <= 0 || Number(value) > 100) {
      return fail("VALUE_INVALID", "成分百分比必须在 0 至 100 之间。");
    }
    const match = fields().filter(({ index }) => index === key);
    if (match.length !== 1) return fail("COMPOSITION_MISSING", "未找到唯一对应的成分百分比。");
    const [{ field }] = match;
    if (field.value && Number(field.value) === Number(value)) return { ok: true, status: "unchanged" };
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (field.isConnected && onPage()) field.dispatchEvent(new Event("change", { bubbles: true }));
    field.blur();
    return await completed(() => fields().some(({ index, field }) => index === key && field.value &&
      Number(field.value) === Number(value) && field.getAttribute("aria-invalid") !== "true"))
      ? { ok: true, status: "filled" } : fail("READBACK_MISMATCH", "成分百分比未能读回。");
  }
}
