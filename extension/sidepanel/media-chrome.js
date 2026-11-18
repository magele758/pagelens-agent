import { renderAllowCurrentSite } from "./allow-current-site.js";
import { $ } from "./dom.js";
import { hostOf, renderSkills } from "./messages.js";
import { syncComposerHints } from "./model-line.js";
import { state } from "./state.js";
import { refreshTab, snapshotTab } from "./tab-context.js";

function setChipAction(el, label, tooltip) {
  if (!el) return;
  el.textContent = label;
  el.classList.remove("hidden");
  el.setAttribute("aria-label", tooltip);
  el.setAttribute("data-tooltip", tooltip);
}

function pageContextBits() {
  const tab = state.tab;
  if (!tab || !state.share) return state.share ? [] : ["不使用网页"];
  const bits = [];
  const host = hostOf(tab.url);
  if (host) bits.push(host);
  if (state.pack?.kind === "x") bits.push("已提取帖子");
  if (state.pack?.kind === "pdf") {
    bits.push("已提取 PDF");
    if (state.pack.pdfPages) bits.push(`${state.pack.pdfPages} 页`);
  } else if (state.pack?.pdfError) {
    bits.push("PDF 未抽出");
  }
  if (state.pack?.text) bits.push(`${state.pack.text.length} 字`);
  return bits;
}

function renderComposerChip() {
  const label = $("compose-chip-label");
  const chip = $("compose-chip");
  const clear = $("btn-clear-ref");
  const note = $("compose-note");
  const input = $("input");
  const ref = state.chatRef;
  const pageTitle = state.pack?.title || state.tab?.title || "当前网页";
  chip?.classList.toggle("is-ref", Boolean(ref));
  chip?.classList.toggle("is-off", !ref && !state.share);
  if (ref) {
    const kind = ref.kind === "summary" ? "摘要" : "文稿";
    if (label) label.textContent = `已引用：${ref.title} · ${kind}`;
    setChipAction(clear, "×", "移除引用");
    if (note) note.textContent = "视频引用";
    if (input && !input.value) input.placeholder = "针对已引用的视频内容提问…";
    return;
  }
  if (state.share) {
    if (label) label.textContent = `当前网页：${pageTitle}`;
    setChipAction(clear, "×", "去掉网页上下文");
    if (note) {
      const bits = pageContextBits();
      note.textContent = bits.length ? bits.join(" · ") : "当前网页";
    }
  } else {
    if (label) label.textContent = "未带网页";
    setChipAction(clear, "带上", "带上当前网页");
    if (note) note.textContent = "不使用网页，切到其他页会再带上";
  }
  if (input) syncComposerHints();
}

function clearChatRef() {
  state.chatRef = null;
  renderComposerChip();
}

function dismissPageContext() {
  state.share = false;
  state.dismissedPage = snapshotTab(state.tab);
  state.pack = null;
  $("recall-banner")?.classList.add("hidden");
  renderContext();
  renderComposerChip();
  renderSkills();
}

async function restorePageContext() {
  state.share = true;
  state.dismissedPage = null;
  renderComposerChip();
  if (typeof refreshTab === "function") await refreshTab();
  else {
    renderContext();
    renderSkills();
  }
}

function onComposerChipAction() {
  if (state.chatRef) {
    clearChatRef();
    return;
  }
  if (state.share) dismissPageContext();
  else restorePageContext();
}

function renderContext() {
  renderAllowCurrentSite($("btn-allow-current-site"), state.tab, state.settings);
  renderComposerChip();
}

export {
  renderComposerChip,
  restorePageContext,
  onComposerChipAction,
  renderContext,
};
