/** Read and operate the material picker only while the new Temu draft remains open. */
export async function temuMediaPage({ href, kind, key, filenames = [], previous = [], baseline, added }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const modalSelector = '[class*="MDL_inner_"]';
  const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
  const unique = items => items.length === 1 ? items[0] : null;
  const withTitle = text => unique(modals().filter(node => [...node.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
    .some(heading => visible(heading) && heading.childElementCount === 0 && clean(heading.textContent) === text)));
  const picker = () => withTitle("素材中心");
  const decoration = () => withTitle("详情页装修");
  const isImageArea = key => key === "noCostumeCarouselImgsI18n.common" ||
    /^productSkuMap\.[\w-]*\.previewImgsI18n\.common$/u.test(key || "");

  function selected(dialog) {
    const candidates = [...dialog.querySelectorAll("span,div,p")].filter(node => visible(node) && node.childElementCount <= 3)
      .map(node => /已选\s*(\d+)\s*个\s*[，,]?\s*可选\s*(\d+)\s*个/u.exec(clean(node.textContent)))
      .filter(Boolean);
    const counts = [...new Set(candidates.map(match => match[1]))];
    return counts.length === 1 ? Number(counts[0]) : null;
  }

  async function waitFor(check) {
    const deadline = Date.now() + 2500;
    do {
      if (!onPage()) return null;
      const state = check();
      if (state) return state;
      await new Promise(resolve => setTimeout(resolve, 70));
    } while (Date.now() < deadline);
    return null;
  }

  if (!onPage()) return fail("PAGE_CHANGED", "Temu 商品页已切换。");
  const detail = key === "decoration-images";
  if (!detail && !isImageArea(key)) return fail("UPLOAD_CONTROL_MISSING", "图片目标不属于当前商品轮播或 SKU 预览图。");
  if (kind === "open") {
    const opened = detail ? await openDetails() : openListing();
    if (!opened.ok) return opened;
    if (!await waitFor(picker)) return fail("UPLOAD_CONTROL_MISSING", "没有打开当前图片区域对应的素材中心。");
  }

  const dialog = picker();
  const known = decoration();
  if (!dialog || modals().some(node => node !== dialog && (!detail || node !== known))) {
    return fail("MODAL_BLOCKED", "素材中心页面已变化。");
  }
  if (kind === "cancel") {
    const button = unique([...dialog.querySelectorAll('button,[role="button"]')].filter(node =>
      visible(node) && !node.disabled && clean(node.textContent) === "取消"));
    if (!button) return fail("UPLOAD_UNVERIFIED", "素材中心暂时不能关闭。");
    button.click();
    return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");
  }
  const count = selected(dialog);
  if (count == null) return fail("UPLOAD_UNVERIFIED", "无法核对素材中心已选图片数。");
  if (kind === "open" || kind === "inspect") {
    const input = unique([...dialog.querySelectorAll('[class*="UPD_outerWrapper_"] input[type="file"]')].filter(node => !node.disabled));
    if (!input) {
      return fail("UPLOAD_CONTROL_MISSING", "素材中心没有唯一可用的本地图片上传控件。");
    }
    const parts = [];
    for (let node = input; node && node !== document.body; node = node.parentElement) {
      parts.unshift(`${node.localName}:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`);
    }
    const selector = `body > ${parts.join(" > ")}[type="file"]`;
    return { ok: true, selector, count, multiple: input.multiple,
      knownMedia: mediaCards(dialog).map(({ identity, filename }) => ({ identity, filename })) };
  }
  if (kind === "select-new") {
    if (!filenames.length || new Set(filenames).size !== filenames.length || count !== baseline) {
      return fail("UPLOAD_UNVERIFIED", "当前素材选择或上传文件名与计划不一致。");
    }
    const existing = new Set(previous.map(card => card.identity));
    const find = name => unique(mediaCards(dialog).filter(card => card.filename === name && !existing.has(card.identity)));
    const missing = filenames.filter(name => !find(name));
    if (missing.length) return fail("UPLOAD_PENDING", "尚未出现所有新上传的素材卡片。");
    for (const [index, name] of filenames.entries()) {
      const current = find(name);
      if (!onPage() || picker() !== dialog || !current) return fail("UPLOAD_UNVERIFIED", "新上传的素材卡片已变化。");
      current.target.click();
      if (!await waitFor(() => picker() === dialog && selected(dialog) === baseline + index + 1)) {
        return fail("UPLOAD_UNVERIFIED", "没有核对到刚上传的图片进入选择列表。");
      }
    }
    return { ok: true, count: selected(dialog) };
  }
  if (kind !== "confirm") return fail("ACTION_UNSUPPORTED", "此操作不属于图片上传流程。");
  if (count !== baseline + added) return fail("UPLOAD_UNVERIFIED", "本次上传的新图片尚未全部选中。");
  const button = unique([...dialog.querySelectorAll('button,[role="button"]')]
    .filter(node => visible(node) && !node.disabled && !node.matches('[aria-disabled="true"]') && clean(node.textContent) === "确认"));
  if (!button) return fail("UPLOAD_CONTROL_MISSING", "找不到素材中心内可用的确认按钮。");
  button.click();
  return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");

  function mediaCards(dialog) {
    if (!filenames.length) return [];
    const names = new Set(filenames);
    const found = new Map();
    for (const label of dialog.querySelectorAll('span,div,p,[title]')) {
      if (!visible(label) || label.childElementCount > 1) continue;
      const filename = clean(label.getAttribute("title") || label.textContent).replace(/\.(?:jpe?g|png|webp)$/iu, "");
      if (!names.has(filename)) continue;
      for (let card = label.parentElement, depth = 0; card && card !== dialog && depth < 6; card = card.parentElement, depth++) {
        const image = unique([...card.querySelectorAll("img[src]")].filter(node => visible(node) &&
          /^https?:\/\//iu.test(node.src) && !node.closest('a[href]') && !node.matches('[class*="icon" i]')));
        if (!image) continue;
        const url = new URL(image.currentSrc || image.src);
        const identity = clean(card.getAttribute("data-material-id") || card.getAttribute("data-id")) ||
          url.origin + url.pathname;
        found.set(filename + "\0" + identity, { filename, identity, target: image });
        break;
      }
    }
    return [...found.values()];
  }

  function openListing() {
    if (modals().length) return fail("MODAL_BLOCKED", "当前商品页已有弹窗。");
    const root = document.getElementById("page_container_id");
    const holder = document.getElementById(key);
    const label = holder && unique([...holder.querySelectorAll('[class^="upload-trigger_wrap__"],[class^="upload-trigger_wrap__"] *')]
      .filter(node => visible(node) && clean(node.textContent) === "素材中心" && ![...node.children].some(child => clean(child.textContent) === "素材中心")));
    if (!holder || !root?.contains(holder) || !label) return fail("UPLOAD_CONTROL_MISSING", "找不到当前图片区域的素材中心入口。");
    label.click();
    return { ok: true };
  }

  async function openDetails() {
    const active = decoration();
    if (!active || modals().length !== 1) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台。");
    const item = unique([...active.querySelectorAll('[class^="side-left_sectionItem__"] span')]
      .filter(node => visible(node) && clean(node.textContent) === "图片"));
    if (!item) return fail("UPLOAD_CONTROL_MISSING", "找不到详情装修图片组件。");
    item.click();
    const add = await waitFor(() => unique([...active.querySelectorAll('button,a,[role="button"],span')]
      .filter(node => visible(node) && clean(node.textContent) === "从素材中心添加" &&
        ![...node.children].some(child => clean(child.textContent) === "从素材中心添加"))));
    if (!add || active !== decoration()) return fail("UPLOAD_CONTROL_MISSING", "找不到详情装修的素材中心入口。");
    add.click();
    return { ok: true };
  }
}
