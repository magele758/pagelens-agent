/** Read and operate the material picker only while the new Temu draft remains open. */
export async function temuMediaPage({ href, kind, key, filenames = [], previous = [], expected = [], name, baseline, added }) {
  const onPage = () => window === window.top && location.origin === "https://agentseller.temu.com" &&
    location.pathname === "/goods/edit" && location.href === href;
  const clean = value => String(value ?? "").replace(/\s+/gu, " ").trim();
  const visible = node => Boolean(node?.isConnected && node.getClientRects().length &&
    !node.closest('[hidden],[inert],[aria-hidden="true"]') && getComputedStyle(node).visibility !== "hidden");
  const fail = (code, message) => ({ ok: false, code, message });
  const modalSelector = '[class*="MDL_inner_"],dialog[open],[role="alertdialog"],[aria-modal="true"],[data-testid="beast-core-modal-container"]';
  const modals = () => [...document.querySelectorAll(modalSelector)].filter(visible);
  const unique = items => items.length === 1 ? items[0] : null;
  const hasTitle = (node, text) => [...node.querySelectorAll('h1,h2,h3,[role="heading"],span,div')]
    .some(heading => visible(heading) && heading.childElementCount === 0 && clean(heading.textContent) === text);
  const withTitle = text => {
    const matches = modals().filter(node => hasTitle(node, text));
    return unique(matches.filter(node => !matches.some(other => node !== other && node.contains(other))));
  };
  const picker = () => withTitle("素材中心");
  const decoration = () => withTitle("详情页装修");
  const buttons = 'button,[role="button"]';
  const enabledButton = (area, label) => unique([...area.querySelectorAll(buttons)].filter(node =>
    visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" && clean(node.textContent) === label));
  const isOrdered = /^productSkcList\[\d{1,3}\]\.carouselImgsI18n\.common$/u.test(key || "");
  const isImageArea = key => key === "noCostumeCarouselImgsI18n.common" ||
    /^productSkuMap\.[\w-]*\.previewImgsI18n\.common$/u.test(key || "") ||
    isOrdered;

  function selected(dialog) {
    const candidates = [...dialog.querySelectorAll("span,div,p")].filter(node => visible(node) && node.childElementCount <= 3)
      .map(node => /已选\s*(\d+)\s*个\s*[，,]?\s*可选\s*(\d+)\s*个/u.exec(clean(node.textContent)))
      .filter(Boolean);
    const states = new Map(candidates.map(match => [`${match[1]}/${match[2]}`, { count: Number(match[1]), available: Number(match[2]) }]));
    return states.size === 1 ? states.values().next().value : null;
  }

  async function waitFor(check, timeout = 2500) {
    const deadline = Date.now() + timeout;
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
  const foreignModals = () => modals().filter(node => node !== dialog && !node.contains(dialog) &&
    (!detail || !known || (node !== known && !node.contains(known))));
  if (kind === "settle-upload" && dialog) return settleUpload();
  if (!dialog || foreignModals().length) {
    return fail("MODAL_BLOCKED", "素材中心页面已变化。");
  }
  if (kind === "cancel") {
    const button = enabledButton(dialog, "取消");
    if (!button) return fail("UPLOAD_UNVERIFIED", "素材中心暂时不能关闭。");
    button.click();
    return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");
  }
  const state = selected(dialog);
  if (!state) return fail("UPLOAD_UNVERIFIED", "无法核对素材中心已选图片数。");
  const { count, available } = state;
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
    return { ok: true, selector, count, available, multiple: input.multiple, ordered: isOrdered,
      knownMedia: mediaCards(dialog).map(receipt) };
  }
  if (kind === "select-new") {
    if (!filenames.length || filenames.length > available || new Set(filenames).size !== filenames.length || count !== baseline ||
        isOrdered && (expected.length !== filenames.length || new Set(expected.map(card => card.identity)).size !== expected.length)) {
      return fail("UPLOAD_UNVERIFIED", "当前素材选择或上传文件名与计划不一致。");
    }
    const existing = new Set(previous.map(card => card.identity));
    const approved = new Map(expected.map(card => [card.filename, card.identity]));
    const find = name => unique(mediaCards(dialog).filter(card => card.filename === name &&
      (approved.has(name) ? approved.get(name) === card.identity : !existing.has(card.identity))));
    const missing = filenames.filter(name => !find(name));
    if (missing.length) return fail("UPLOAD_PENDING", "尚未出现所有新上传的素材卡片。");
    const media = [];
    for (const [index, name] of filenames.entries()) {
      const current = find(name);
      if (!onPage() || picker() !== dialog || foreignModals().length || !current) return fail("UPLOAD_UNVERIFIED", "新上传的素材卡片已变化。");
      current.target.click();
      if (!await waitFor(() => picker() === dialog && !foreignModals().length && selected(dialog)?.count === baseline + index + 1)) {
        return fail("UPLOAD_UNVERIFIED", "没有核对到刚上传的图片进入选择列表。");
      }
      media.push(receipt(current));
    }
    return { ok: true, count: selected(dialog).count, ordered: isOrdered, media };
  }
  if (kind !== "confirm") return fail("ACTION_UNSUPPORTED", "此操作不属于图片上传流程。");
  if (count !== baseline + added) return fail("UPLOAD_UNVERIFIED", "本次上传的新图片尚未全部选中。");
  const button = enabledButton(dialog, "确认");
  if (!button) return fail("UPLOAD_CONTROL_MISSING", "找不到素材中心内可用的确认按钮。");
  button.click();
  return await waitFor(() => !picker()) ? { ok: true } : fail("UPLOAD_UNVERIFIED", "素材中心尚未关闭。");

  function receipt({ identity, filename, src }) {
    return { identity, filename, src };
  }

  async function settleUpload() {
    if (!name || !filenames.includes(name)) return fail("UPLOAD_UNVERIFIED", "上传文件与素材计划不一致。");
    const existing = new Set(previous.map(card => card.identity));
    let cropped = false;
    let saved = false;
    const outcome = await waitFor(() => {
      if (picker() !== dialog) return fail("MODAL_BLOCKED", "处理上传时素材中心已切换。");
      const alert = [...document.querySelectorAll('[role="alert"],[data-testid*="toast" i],[class*="Toast_content"]')]
        .filter(visible).map(node => clean(node.textContent))
        .find(message => /图片|裁剪/u.test(message) && /失败|不符合|不支持|超出|不能|无效/u.test(message));
      if (alert) return fail("UPLOAD_REJECTED", alert.slice(0, 180));
      const extra = foreignModals();
      // Temu may place the crop dialog in a portal or nest it within the picker.
      const crop = withTitle("裁剪") || withTitle("图片裁剪");
      const upload = withTitle("本地上传") || withTitle("上传图片");
      if (extra.some(node => ![crop, upload].some(owned => owned && (node === owned || node.contains(owned))))) {
        return fail("MODAL_BLOCKED", "上传时出现了无法识别的 Temu 弹窗。");
      }
      if (crop && crop !== dialog && crop !== known && !cropped) {
        const confirm = enabledButton(crop, "确认裁剪");
        if (confirm) {
          cropped = true;
          confirm.click();
        }
        return null;
      }
      const saveArea = crop || upload;
      if (saveArea && saveArea !== dialog && saveArea !== known && !saved) {
        const save = enabledButton(saveArea, "保存");
        if (save) {
          saved = true;
          save.click();
        }
        return null;
      }
      if (extra.length) return null;
      const lists = [...document.querySelectorAll('[class*="popover" i],[data-testid="beast-core-popover"]')].filter(node =>
        visible(node) && hasTitle(node, "上传列表"));
      const list = unique(lists.filter(node => !lists.some(other => node !== other && node.contains(other))));
      if (list) {
        const heading = unique([...dialog.querySelectorAll('h1,h2,h3,[role="heading"],span,div')].filter(node =>
          visible(node) && !list.contains(node) && !node.childElementCount && clean(node.textContent) === "素材中心"));
        if (heading) heading.click();
        return null;
      }
      const card = unique(mediaCards(dialog).filter(card => card.filename === name && !existing.has(card.identity)));
      return card && { ok: true, card: receipt(card) };
    }, 18000);
    return outcome || fail("UPLOAD_PENDING", "尚未核对到本次文件在素材中心生成的新图片。");
  }

  function mediaCards(dialog) {
    if (!filenames.length) return [];
    const names = new Set(filenames);
    const found = new Map();
    for (const label of dialog.querySelectorAll('span,div,p,[title],img[alt]')) {
      if (!visible(label)) continue;
      const labelText = label.getAttribute("title") || label.getAttribute("alt") ||
        (label.childElementCount <= 1 ? label.textContent : "");
      const filename = clean(labelText).replace(/\.(?:jpe?g|png|webp)$/iu, "");
      if (!names.has(filename)) continue;
      const start = label.querySelector("img") ? label : label.parentElement;
      for (let card = start, depth = 0; card && card !== dialog && depth < 6; card = card.parentElement, depth++) {
        const image = unique([...card.querySelectorAll("img[src]")].filter(node => visible(node) &&
          /^https:\/\//iu.test(node.src) && !node.closest('a[href]') && !node.matches('[class*="icon" i]')));
        if (!image) continue;
        const url = new URL(image.currentSrc || image.src);
        const src = url.origin + url.pathname;
        const identity = clean(card.getAttribute("data-material-id") || card.getAttribute("data-id")) || src;
        found.set(filename + "\0" + identity, { filename, identity, src, target: image });
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
    if (!active || modals().some(node => node !== active && !node.contains(active))) return fail("MODAL_BLOCKED", "详情装修弹窗不在前台。");
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
