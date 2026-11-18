/** The apparel editor renders SKC colors separately from its size selector. */
export async function temuApparelPage({ href, kind, key, value }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const clean = value => String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
  const blocked = () => [...document.querySelectorAll('[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"]')].some(visible);
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const colorSelector = '[id^="productSkcList["][id$=".mainSpec[0]"]';
  const holders = () => [...root?.querySelectorAll(colorSelector) || []].filter(holder => visible(holder) &&
    /^productSkcList\[\d{1,3}\]\.mainSpec\[0\]$/u.test(holder.id) &&
    holder.querySelector('input[placeholder="选择或自定义颜色"]'));
  const rows = () => holders().map(holder => ({
    key: holder.id,
    value: clean(holder.querySelector('[class*="ST_selectValueSingle_"]')?.textContent ||
      holder.querySelector('input[placeholder="选择或自定义颜色"]')?.value),
  }));

  if (!onPage() || blocked()) return fail("PAGE_CHANGED", "Temu 服装规格页已切换或有弹窗。");
  if (["composition-inspect", "composition-add", "composition-percentage"].includes(kind)) return composition();
  if (kind === "set-sizes") return setSizes();
  if (kind === "select-size-chart") return selectChart();
  if (kind === "inspect") return { ok: true, rows: rows() };
  if (kind === "set-color") {
    if (typeof value !== "string" || !clean(value) || value.length > 80) return fail("VALUE_INVALID", "颜色值为空或超过长度限制。");
    const holder = holders().find(row => row.id === key);
    const input = holder?.querySelector('input[placeholder="选择或自定义颜色"]');
    if (!input || !visible(input) || input.disabled || input.readOnly) return fail("SPEC_CONTROL_MISSING", "服装颜色输入已变化。");
    const prior = rows().find(row => row.key === key)?.value;
    if (prior === clean(value)) return { ok: true, status: "unchanged" };
    if (prior) return fail("SPEC_VALUES_OCCUPIED", "目标服装颜色行已有内容。");
    if (input.maxLength > 0 && value.length > input.maxLength) return fail("VALUE_INVALID", "颜色值超过 Temu 字数限制。");
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (input.isConnected && onPage()) input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }));
    input.blur();
    const deadline = Date.now() + 1900;
    do {
      await new Promise(resolve => setTimeout(resolve, 120));
      if (!onPage() || blocked()) return fail("PAGE_CHANGED", "填写服装颜色时页面已切换。");
      const current = holders().find(row => row.id === key)?.querySelector('input[placeholder="选择或自定义颜色"]');
      if (rows().find(row => row.key === key)?.value === clean(value) &&
          current && current.getAttribute("aria-invalid") !== "true" && current.validity?.valid !== false) {
        return { ok: true, status: "filled" };
      }
    } while (Date.now() < deadline);
    return fail("READBACK_MISMATCH", "Temu 未保留输入的服装颜色。");
  }
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
    const sizeKey = candidate => clean(candidate).replace(/\s*HOT$/iu, "").trim().toUpperCase();
    const desired = Array.isArray(value?.sizes) ? value.sizes.map(sizeKey) : [];
    if (!desired.length || desired.length > 20 || new Set(desired).size !== desired.length || desired.some(size => !size)) {
      return finish("VALUE_INVALID", "需要提供不重复的实际尺码。");
    }
    const region = () => {
      const candidates = [...root?.querySelectorAll('[data-testid="beast-core-form-item"]') || []]
        .filter(item => visible(item) && /^[*＊]?\s*尺码\s*建议/u.test(clean(item.innerText || item.textContent)) &&
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
        const size = sizeKey(node.getAttribute("aria-label") || hit.textContent || node.value);
        return size ? [{ size, hit, checked: node.checked ?? node.getAttribute("aria-checked") === "true" }] : [];
      });
    };
    async function waitFor(check) {
      const deadline = Date.now() + 2200;
      do {
        if (!onPage() || blocked()) return null;
        const result = check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 60));
      } while (Date.now() < deadline);
      return null;
    }
    const area = region();
    const input = area?.querySelector('input[data-testid="beast-core-select-htmlInput"]');
    const system = clean(value?.system || input?.value);
    if (!input || !["欧美尺码", "亚洲尺码"].includes(system)) return finish("SPEC_CONTROL_MISSING", "请提供当前类目使用的 欧美尺码 或 亚洲尺码。");
    if (clean(input.value) !== system && !controls().length) {
      const options = () => [...document.querySelectorAll('[role="option"],[data-testid="beast-core-select-option"]')].filter(visible);
      if (options().length) return finish("MENU_STILL_OPEN", "页面已有下拉选项打开。");
      const suffix = area.querySelectorAll('[data-testid="beast-core-input-suffix"]');
      if (suffix.length !== 1 || !visible(suffix[0])) return finish("SPEC_CONTROL_MISSING", "没有找到服装尺码体系下拉入口。");
      suffix[0].click();
      const option = await waitFor(() => {
        const matches = options().filter(node => clean(node.textContent) === system &&
          !node.matches('[aria-disabled="true"],[data-disabled="true"],[disabled],a[href]'));
        return matches.length === 1 ? matches[0] : null;
      });
      if (!option) return finish("SPEC_OPTION_MISSING", "没有唯一匹配的可用尺码体系。");
      option.click();
    } else if (clean(input.value) && clean(input.value) !== system) {
      return finish("SPEC_VALUES_OCCUPIED", "页面已选用了不同的尺码体系。");
    }
    if (!await waitFor(() => controls().length > 0)) return finish("SPEC_VALUES_NOT_RENDERED", "尺码体系下没有显示可用尺码。");
    items.push({ label: system, status: "verified" });
    for (const size of desired) {
      const matches = controls().filter(entry => entry.size === size);
      if (matches.length !== 1) return finish("SPEC_OPTION_MISSING", `Temu 没有唯一匹配的「${size}」尺码。`);
      if (matches[0].checked) { items.push({ label: size, status: "unchanged" }); continue; }
      matches[0].hit.click();
      if (!await waitFor(() => controls().some(entry => entry.size === size && entry.checked))) {
        return finish("READBACK_MISMATCH", `Temu 未确认选择「${size}」尺码。`);
      }
      items.push({ label: size, status: "filled" });
    }
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
