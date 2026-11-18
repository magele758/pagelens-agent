import { resolveWindowId } from "./session.js";
import { checkSmartRecall } from "./clippings-ui.js";
import { $ } from "./dom.js";
import { renderContext } from "./media-chrome.js";
import { renderSkills } from "./messages.js";
import { state } from "./state.js";
import { restrictedUrl } from "../lib/chrome.js";
import { requestTabHostAccess } from "../lib/optional-permissions.js";
import { loadTabPack } from "../lib/page-pack.js";

async function pickTargetTab() {
  const windowId = await resolveWindowId();
  const [active] = await chrome.tabs.query({ active: true, windowId });
  return active?.windowId === windowId ? active : null;
}

async function refreshTab({ interactive = false } = {}) {
  const tab = await pickTargetTab();
  if (!state.share && state.dismissedPage && tab && (tab.id !== state.dismissedPage.id || tab.url !== state.dismissedPage.url)) {
    state.share = true;
    state.dismissedPage = null;
  }
  const prevId = state.tab?.id;
  const prevUrl = state.tab?.url;
  const changed = tab?.id !== prevId || tab?.url !== prevUrl;

  const revision = ++state.pageRevision;
  state.tab = tab || null;

  if (!state.share || !tab || restrictedUrl(tab.url)) {
    state.pack = null;
    $("recall-banner")?.classList.add("hidden");
    renderContext();
    renderSkills();
    if (interactive && state.share && tab?.id && !tab.url) await requestTabHostAccess(tab.id);
    return;
  }

  if (changed) {
    state.pack = {
      title: tab.title || "",
      url: tab.url || "",
      text: "",
      quotes: [],
      video: null,
      loading: true,
      tab,
    };
    renderContext();
  }

  try {
    const result = await loadTabPack(tab.id, { interactive });
    if (revision !== state.pageRevision) return;
    if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
    state.pack = result || {
      title: tab.title,
      url: tab.url,
      text: "",
      quotes: [],
      video: null,
    };
  } catch {
    if (revision !== state.pageRevision) return;
    if (tab?.id !== state.tab?.id || tab?.url !== state.tab?.url) return;
    state.pack = {
      title: tab.title,
      url: tab.url,
      text: "",
      quotes: [],
      video: null,
    };
  }
  renderContext();
  renderSkills();
  if (tab?.url) {
    checkSmartRecall(tab.url).catch(() => {});
  } else {
    $("recall-banner")?.classList.add("hidden");
  }
}

function snapshotTab(tab) {
  if (!tab) return null;
  return { id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl, windowId: tab.windowId };
}

export {
  pickTargetTab,
  refreshTab,
  snapshotTab,
};
