/** Edit only the independent details decoration dialog on a scoped, new Temu draft. */
export async function temuDecorationPage({ href, description = "", kind }) {
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const root = document.getElementById("page_container_id");
  const modalSelector = '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"]';
  const modalTitle = "详情页装修";
  const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
  const unique = items => items.length === 1 ? items[0] : null;
  const decoration = () => unique(modals().filter(node => [...node.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
    .some(heading => visible(heading) && heading.childElementCount === 0 && clean(heading.textContent) === modalTitle)));

  async function waitFor(resolve, interval = 30) {
    const deadline = Date.now() + 2800;
    do {
      if (!onPage()) return null;
      const result = resolve();
      if (result) return result;
      await new Promise(next => setTimeout(next, interval));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
  if (kind === "apply") return apply();
  if (modals().length) return fail("MODAL_BLOCKED", "页面已有弹窗，详情图文尚未开始试填。");
  if (typeof description !== "string" || description.length > 10000) {
    return fail("VALUE_INVALID", "商品详情文本超长。");
  }
  const button = unique([...root?.querySelectorAll('[class^="decoration_operate__"] button') || []]
    .filter(node => visible(node) && !node.disabled && clean(node.textContent) === "开始装修"));
  if (!button) return fail("DECORATION_MISSING", "当前类目没有可核对的详情图文装修入口。");
  button.click();
  const dialog = await waitFor(decoration);
  if (!dialog) return fail("DECORATION_UNVERIFIED", "详情页装修弹窗未出现。");
  if (!description.trim()) return { ok: true, status: "opened" };
  const textItem = unique([...dialog.querySelectorAll('[class^="side-left_sectionItem__"] span')]
    .filter(node => visible(node) && clean(node.textContent) === "文本"));
  if (!textItem) return fail("DECORATION_UNVERIFIED", "没有唯一匹配的装修文本组件。");
  const current = () => {
    const scoped = decoration();
    return scoped && unique([...scoped.querySelectorAll('textarea[placeholder="请输入"]')]
      .filter(node => visible(node) && !node.disabled && !node.readOnly));
  };
  if (current()) return fail("DECORATION_OCCUPIED", "详情图文已经有编辑内容，需要手动核对。");
  if (!onPage() || decoration() !== dialog) return fail("PAGE_CHANGED", "详情装修弹窗已切换。");
  textItem.click();
  const input = await waitFor(current);
  if (!input || input.value || input.maxLength >= 0 && description.length > input.maxLength) {
    return fail("DECORATION_UNVERIFIED", "详情文本编辑框缺失、已有内容或超出平台字数限制。");
  }
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set.call(input, description);
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  if (input.isConnected && onPage()) input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
  const verified = await waitFor(() => current()?.value === description);
  if (!verified) return fail("READBACK_MISMATCH", "平台未接受填写的详情图文。");
  return kind === "prepare" ? { ok: true, status: "opened" } : apply();

  async function apply() {
    const active = decoration();
    if (!active || modals().some(node => node !== active && !node.contains(active) && !active.contains(node))) {
      return fail("MODAL_BLOCKED", "详情装修弹窗不在前台，请先核对。");
    }
    if (description.trim() && ![...active.querySelectorAll('textarea[placeholder="请输入"]')].some(node =>
      visible(node) && node.value === description)) return fail("READBACK_MISMATCH", "详情图文内容已变化。");
    const save = unique([...active.querySelectorAll('[class^="footer_footer__"] button')]
      .filter(node => visible(node) && !node.disabled && clean(node.textContent) === "保存"));
    if (!save) return fail("DECORATION_UNVERIFIED", "找不到详情页装修弹窗内的保存按钮。");
    save.click();
    const closed = await waitFor(() => !decoration());
    return closed ? { ok: true, status: "verified" } : fail("DECORATION_UNVERIFIED", "详情页装修弹窗尚未关闭，请核对后继续。");
  }
}
