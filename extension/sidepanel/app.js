import "./panel-log.js";
import { bindWindowMail } from "./window-mail.js";
import { allowCurrentSite, renderAllowCurrentSite } from "./allow-current-site.js";
import { bindMxApprovalPanel } from "./mx-approval-panel.js";
import { createAgentGatewayPanel } from "./agent-gateway-panel.js";
import { captureTab, lastUserAskedForSkill, resumeInterruptedRun, sendPrompt } from "./agent-loop.js";
import {
  closeClipModal,
  closeClipViewModal,
  dismissRecallBanner,
  openClipViewModal,
  submitClipModal,
} from "./clippings-ui.js";
import { bindComposer, consumePending, renderAttach } from "./composer.js";
import { $, on } from "./dom.js";
import {
  exportAll,
  flashStatus,
  importAllToLibrary,
  importCurrentToLibrary,
  openHistoryView,
  renderHistory,
} from "./history.js";
import { updateHitlBadge } from "./hitl-ui.js";
import { paintLibraryStatus, refreshLibraryStatus } from "./library-ui.js";
import { onComposerChipAction, renderComposerChip } from "./media-chrome.js";
import { createMessageScroll } from "./message-scroll.js";
import { renderMessages, renderSkills } from "./messages.js";
import {
  applyUiFont,
  renderModelLine,
  setModelLineMeta,
  skillsOn,
  syncComposerHints,
  syncSkillFolderControls,
} from "./model-line.js";
import { copyText, nativeInstallCommand, paintNativeHostStatus, refreshNativeHost } from "./native-host-ui.js";
import { bindMessageScroll, bindSettingsPage, messageScroll, settingsPage } from "./panel-refs.js";
import { initReviewView } from "./review-view.js";
import { classifyAgentPrompt, continueAgentPrompt } from "./panel-bridge.js";
import { abortAllSideChats, applySession, downloadText, persistSession, resolveWindowId, setView, startNewSession } from "./session.js";
import { renderSettingsForm } from "./settings-form.js";
import { createSettingsPage } from "./settings-page.js";
import { initSideChat } from "./sidechat-ui.js";
import { applyFolderPathsFromInputs, paintSkillFolderStatus } from "./skill-folder-ui.js";
import {
  clearSkillsCache,
  ensureSkillsMeta,
  hideSlashMenu,
  hydrateSkillFolderStatus,
  renderShortcutList,
  slash,
} from "./slash-menu.js";
import { state } from "./state.js";
import { pickTargetTab, refreshTab } from "./tab-context.js";
import { applyUiTheme, bindThemeEditor } from "./theme.js";
import { delegatePanel, trustPanel } from "./trust-runtime.js";
import { bindWorkflowCatalog } from "./workflow-catalog.js";
import { bindGeekbiSettings } from "../integrations/geekbi/settings.js";
import { bindTemuPod } from "../flows/temu/pod/panel.js";
import { bindDailyOperations } from "../skill-components/daily-operations/panel.js";
import { bindWorkflowShortcuts } from "./workflow-shortcuts.js";
import { bindTemuListingPanel } from "./temu-listing-panel.js";
import { bindTemuSellerOperationsPanel } from "../flows/temu/seller-operations/panel.js";
import { bindProductCapturePanel } from "./product-capture-panel.js";
import { bindSheinListingPanel } from "../flows/shein/product-listing/sidepanel/listing-panel.js";
import { replaySheinListing } from "../flows/shein/product-listing/runtime.js";
import { bindShopeeMarketingPanel } from "../flows/shopee/marketing-panel.js";
import { bindPtcFlow } from "../flows/shopee/product-listing/sidepanel/flow-ui.js";
import { skillCommandText } from "../lib/slash.js";
import { ACTIVITY_KEY, clearActivity, readActivity } from "../lib/agent/inbox-activity.js";
import { isResumableRun } from "../lib/agent/context.js";
import { DELEGATE_STORAGE_KEY } from "../lib/agent/delegate.js";
import { APPROVAL_STORAGE_KEY } from "../lib/agent/trust/approval-queue.js";
import { debugLog, exportDebugLogFresh } from "../lib/debug-log.js";
import { testLangfuseConnection } from "../lib/langfuse.js";
import { clearSavedHandle, pickLibraryFolder, setLibraryPath, syncPackToLibrary } from "../lib/library.js";
import { initMarkdown } from "../lib/markdown.js";
import { loadActiveSession, stashWindowHint, takeWindowHint } from "../lib/sessions.js";
import { clearSkillFolderHandle, pickSkillFolder, setSkillFolderPath, skillFolderStatus } from "../lib/skill-folder.js";
import {
  applyOptionalLocalSettings,
  defaultSettings,
  isModelReady,
  loadSettings,
  modifySettings,
  normalizeSettings,
  resolveModel,
} from "../lib/storage.js";

const NEW_WINDOW_HINT = "这是新任务窗口，这里的对话与原窗口分开保存。";

async function runExternalPrompt(id, prompt, signal) {
  const t0 = Date.now();
  let payload;
  try {
    const before = state.messages.length;
    signal.throwIfAborted();
    await sendPrompt(prompt, { signal, fromInbox: true });
    const bot = state.messages.slice(before).reverse().find((m) => m.role === "bot");
    const aborted = bot?.metrics?.finishReason === "abort";
    const steps = (bot?.trace || [])
      .filter((t) => t.kind === "tool")
      .map((t) => ({ name: t.name, ok: t.ok !== false, preview: String(t.preview || "").slice(0, 200) }));
    payload = {
      ok: Boolean(bot) && !bot.error && !aborted,
      summary: bot?.text || "",
      steps,
      error: !bot ? "Agent 没有产生回复" : aborted ? "任务被中止" : bot.error ? bot.text : "",
      code: aborted ? "ABORTED" : bot?.error ? "AGENT_FAILED" : "",
    };
  } catch (err) {
    payload = { ok: false, summary: "", steps: [], error: err?.message || String(err), code: "AGENT_FAILED" };
  }
  await chrome.runtime
    .sendMessage({ type: "pl.agentPrompt.done", id, ms: Date.now() - t0, ...payload })
    .catch(() => {});
}

function bindExternalPromptBridge() {
  let externalRun = null;
  const reply = (msg, windowId, sendResponse) => {
    if (msg?.type === "pl.agentPrompt.ping") {
      sendResponse({ ok: true, busy: state.busy || externalRun != null, windowId });
      return true;
    }
    if (msg?.type === "pl.agentPrompt.run") {
      if (state.busy || externalRun != null) {
        sendResponse({ ok: false, code: "AGENT_BUSY", error: "侧栏 Agent 正在执行其他任务" });
        return true;
      }
      sendResponse({ ok: true });
      externalRun = { id: String(msg.id), controller: new AbortController() };
      runExternalPrompt(externalRun.id, String(msg.prompt || ""), externalRun.controller.signal).finally(() => { externalRun = null; });
      return true;
    }
    if (msg?.type === "pl.agentPrompt.cancel" && externalRun && externalRun.id === msg.id) {
      externalRun.controller.abort();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const route = classifyAgentPrompt(sender?.id, chrome.runtime.id, state.windowId, msg);
    if (route === "ignore") return false;
    if (route === "handle") {
      reply(msg, state.windowId, sendResponse);
      return false;
    }
    continueAgentPrompt(msg, {
      resolveWindowId,
      sendResponse,
      onMatch(windowId) {
        if (!reply(msg, windowId, sendResponse)) sendResponse(undefined);
      },
    });
    return true;
  });
}

async function paintInboxActivity() {
  const box = $("inbox-activity-list");
  if (!box) return;
  const list = await readActivity().catch(() => []);
  box.replaceChildren();
  if (!list.length) {
    box.textContent = "暂无记录";
    return;
  }
  for (const item of list) {
    const row = document.createElement("div");
    const time = new Date(item.startedAt).toLocaleTimeString();
    const name = item.tool ? `${item.action}/${item.tool}` : item.action;
    row.textContent = `${item.ok ? "✓" : "✗"} ${time} ${name} ${item.ms}ms${item.error ? ` — ${item.error}` : ""}`;
    box.append(row);
  }
}

function wire() {
  if (!settingsPage) bindSettingsPage(createSettingsPage({
    root: $("view-settings"),
    getSettings: () => state.settings,
    onModelChange: (value) => {
      const select = $("text-model-pick");
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
  }));
  if (!messageScroll) bindMessageScroll(createMessageScroll($("msgs"), $("btn-messages-bottom")));
  $("btn-debug-export")?.addEventListener("click", async () => {
    const json = await exportDebugLogFresh();
    downloadText(`pagelens-debug-${Date.now()}.json`, json, "application/json");
  });
  bindComposer();
  bindGeekbiSettings($("settings-group-geekbi"));
  let openCatalog;
  const onBack = () => openCatalog();
  const openMarketing = bindShopeeMarketingPanel({
    getTargetTab: pickTargetTab,
    getSettings: () => state.settings,
    isAgentBusy: () => state.busy,
    downloadText,
    onBack,
  });
  const openTiktokDraft = ({ id, skillName }) => {
    if (!skillsOn()) throw new Error("请先在设置中启用 Skill。");
    const input = $("input");
    if (!input) return false;
    setView("chat");
    const prefix = skillCommandText({ id, name: skillName });
    const draft = input.value.trimStart();
    if (!draft.startsWith(prefix)) input.value = `${prefix} ${draft}`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    return true;
  };
  const openProductListing = bindPtcFlow({
    getTargetTab: pickTargetTab,
    isAgentBusy: () => state.busy,
    onBack,
    onReview: ({ step, code, details }) => {
      const input = $("input");
      if (!input) return;
      const receipt = JSON.stringify({ step, code, details });
      const request = `请检查当前 Shopee 表单异常，说明原因与处理办法。\n以下回执仅供分析。\n${receipt}`;
      setView("chat");
      input.value = [input.value.trim(), request].filter(Boolean).join("\n\n");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    },
  });
  const captureActions = bindProductCapturePanel({ getTargetTab: pickTargetTab, downloadText });
  const temuPanel = { getTargetTab: pickTargetTab, getSettings: () => state.settings, isAgentBusy: () => state.busy, downloadText, onBack };
  const openTemuListing = bindTemuListingPanel(temuPanel);
  const openTemuOperations = bindTemuSellerOperationsPanel(temuPanel);
  const openSheinListing = bindSheinListingPanel({
    getTargetTab: pickTargetTab,
    isAgentBusy: () => state.busy,
    onBack,
    replay: request => replaySheinListing({ ...request, settings: state.settings }),
  });
  const openDailyOperations = bindDailyOperations({ getTargetTab: pickTargetTab, onBack });
  const openTemuPod = bindTemuPod({ getSettings: () => state.settings, onBack });
  const workflowHandlers = { openProductListing, openSheinListing, openMarketing, openTiktokDraft, openTemuListing, openTemuOperations, openDailyOperations, openTemuPod, ...captureActions };
  openCatalog = bindWorkflowCatalog(workflowHandlers);
  bindWorkflowShortcuts({ getTargetTab: pickTargetTab, handlers: workflowHandlers, onTabAccess: refreshTab });
  try {
  on("btn-settings", "click", () => {
    if (state.view === "settings") {
      setView("chat");
      return;
    }
    renderSettingsForm();
    setView("settings");
  });
  on("btn-clear-ref", "click", () => onComposerChipAction());
  on("btn-back", "click", async () => {
    try {
      const pathErrors = await applyFolderPathsFromInputs();
      if (pathErrors.length) flashStatus(pathErrors.join(" "), false);
    } catch (err) {
      console.warn("[pagelens] apply paths", err);
    }
    renderSkills();
    renderMessages();
    setView("chat");
  });
  on("btn-add-shortcut", "click", () => {
    if (!Array.isArray(state.settings.shortcuts)) state.settings.shortcuts = [];
    state.settings.shortcuts.push({ id: crypto.randomUUID(), label: "", prompt: "" });
    renderShortcutList();
  });
  on("btn-new", "click", () => {
    startNewSession();
  });
  on("btn-history", "click", () => {
    if (state.view === "history") {
      setView("chat");
      return;
    }
    openHistoryView();
  });
  on("btn-new-window", "click", async () => {
    const status = $("hist-status");
    try {
      const win = await chrome.windows.create({ type: "normal", focused: true });
      const hint = stashWindowHint(win.id, NEW_WINDOW_HINT).catch((err) => console.warn("[pagelens] window hint", err));
      try {
        await chrome.sidePanel.open({ windowId: win.id });
        status.textContent = "已打开新任务窗口。";
      } catch {
        status.textContent = "新窗口已打开。点击新窗口的 PageLens 图标即可开始任务。";
      }
      await hint;
    } catch (err) {
      status.textContent = `新建窗口失败：${err.message || err}`;
    }
  });
  on("btn-hist-back", "click", () => {
    setView("chat");
  });
  on("btn-export-all-md", "click", () => exportAll("md"));
  on("btn-export-all-json", "click", () => exportAll("json"));
  on("btn-import-all-obsidian", "click", () => importAllToLibrary());
  on("btn-obsidian", "click", () => importCurrentToLibrary());
  on("btn-clip-cancel", "click", () => closeClipModal());
  on("btn-clip-cancel-x", "click", () => closeClipModal());
  on("btn-clip-confirm", "click", () => submitClipModal());
  on("btn-recall-open", "click", () => openClipViewModal());
  on("btn-recall-dismiss", "click", () => dismissRecallBanner());
  on("btn-clip-view-close", "click", () => closeClipViewModal());
  on("btn-clip-view-done", "click", () => closeClipViewModal());
  initReviewView();
  on("hist-q", "input", () => {
    state.histQuery = $("hist-q").value;
    renderHistory();
  });
  on("btn-library-pick", "click", async () => {
    const el = $("library-status");
    try {
      const picked = await pickLibraryFolder();
      if ($("library-path")) $("library-path").value = "";
      state.library = { configured: true, granted: true, mode: "picker", name: picked.name, path: "" };
      paintLibraryStatus(state.library, `已选择 ${picked.name}`);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  on("btn-library-path", "click", async () => {
    const el = $("library-status");
    const raw = $("library-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintLibraryStatus(state.library, "正在验证路径…");
      const next = await setLibraryPath(raw);
      state.library = next;
      paintLibraryStatus(state.library);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("library-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-library-path")?.click();
    }
  });
  on("btn-library-reauth", "click", async () => {
    const el = $("library-status");
    try {
      await refreshLibraryStatus({ request: true });
      if (state.library?.granted) {
        if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
        return;
      }
      const picked = await pickLibraryFolder();
      if ($("library-path")) $("library-path").value = "";
      state.library = { configured: true, granted: true, mode: "picker", name: picked.name, path: "" };
      paintLibraryStatus(state.library, `已重新授权 · ${picked.name}`);
      renderModelLine();
      if (state.pack?.captionsStatus === "ready") syncPackToLibrary(state.pack).catch(() => {});
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  on("btn-library-clear", "click", async () => {
    await clearSavedHandle();
    if ($("library-path")) $("library-path").value = "";
    state.library = { configured: false, granted: false, name: "", path: "", mode: "" };
    paintLibraryStatus(state.library, "已清除（磁盘上的文件还在）");
    renderModelLine();
  });
  $("btn-skills-pick")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    try {
      const picked = await pickSkillFolder();
      if ($("skill-path")) $("skill-path").value = "";
      state.skillFolder = { configured: true, granted: true, mode: "picker", name: picked.name, path: "", count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已选择 ${picked.name}，输入 / 时再扫描`);
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-skills-path")?.addEventListener("click", async () => {
    const el = $("skill-folder-status");
    const raw = $("skill-path")?.value.trim() || "";
    if (!raw) {
      if (el) {
        el.textContent = "先填绝对路径或 ~ 路径。";
        el.className = "status bad";
      }
      return;
    }
    try {
      paintSkillFolderStatus(state.skillFolder, "正在验证路径…");
      const next = await setSkillFolderPath(raw);
      state.skillFolder = { ...next, count: 0 };
      clearSkillsCache();
      paintSkillFolderStatus(state.skillFolder, `已设置 ${next.path}，输入 / 时再扫描`);
    } catch (err) {
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("skill-path")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("btn-skills-path")?.click();
    }
  });
  $("btn-skills-reauth")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    const el = $("skill-folder-status");
    try {
      const res = await skillFolderStatus({ request: true });
      if (!res?.granted) {
        const picked = await pickSkillFolder();
        state.skillFolder = { configured: true, granted: true, mode: "picker", name: picked.name, path: "", count: 0 };
      }
      clearSkillsCache();
      await hydrateSkillFolderStatus();
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (el) {
        el.textContent = err.message || String(err);
        el.className = "status bad";
      }
    }
  });
  $("btn-skills-refresh")?.addEventListener("click", async () => {
    if (!skillsOn()) return;
    await ensureSkillsMeta({ force: true, timeoutMs: 15000, request: true });
  });
  $("btn-skills-clear")?.addEventListener("click", async () => {
    await clearSkillFolderHandle();
    if ($("skill-path")) $("skill-path").value = "";
    state.skillFolder = { configured: false, granted: false, name: "", path: "", mode: "", count: 0 };
    clearSkillsCache();
    paintSkillFolderStatus(state.skillFolder, "已清除（磁盘上的 skill 还在）");
    renderModelLine();
  });
  $("skills-enabled")?.addEventListener("change", (e) => {
    state.settings.skillsEnabled = e.target.checked;
    clearSkillsCache();
    if (!e.target.checked) hideSlashMenu();
    syncSkillFolderControls();
    paintSkillFolderStatus(state.skillFolder);
    renderModelLine();
  });
  $("daily-notes-folder")?.addEventListener("input", (event) => {
    state.settings.dailyNotesFolder = event.target.value;
  });
  on("btn-save", "click", async () => {
    const button = $("btn-save");
    button.disabled = true;
    try {
      if ($("daily-notes-folder")) {
        state.settings.dailyNotesFolder = $("daily-notes-folder").value.trim();
      }
      if ($("langfuse-enabled")) {
        if (!state.settings.langfuse) state.settings.langfuse = {};
        state.settings.langfuse.enabled = $("langfuse-enabled").checked;
        if ($("langfuse-url")) state.settings.langfuse.baseUrl = $("langfuse-url").value.trim();
        if ($("langfuse-pk")) state.settings.langfuse.publicKey = $("langfuse-pk").value.trim();
        if ($("langfuse-sk")) state.settings.langfuse.secretKey = $("langfuse-sk").value.trim();
        if ($("langfuse-env")) state.settings.langfuse.environment = $("langfuse-env").value.trim();
      }
      const pathErrors = await applyFolderPathsFromInputs();
      const form = {
        skillsEnabled: state.settings.skillsEnabled,
        dailyNotesFolder: state.settings.dailyNotesFolder,
        langfuse: state.settings.langfuse,
        shortcuts: state.settings.shortcuts,
        answerLanguage: state.settings.answerLanguage,
        uiFont: state.settings.uiFont,
        multimodalSameAsText: state.settings.multimodalSameAsText,
        multimodal: state.settings.multimodal,
        jev: state.settings.jev,
        nativeShell: state.settings.nativeShell,
        cdpInput: state.settings.cdpInput,
        agentBridgeEnabled: state.settings.agentBridgeEnabled,
        agentInboxEnabled: state.settings.agentInboxEnabled,
        hitlMode: state.settings.hitlMode,
        irreversibleActions: state.settings.irreversibleActions,
      };
      state.settings = await modifySettings((latest) => ({
        ...latest,
        skillsEnabled: form.skillsEnabled,
        dailyNotesFolder: form.dailyNotesFolder,
        langfuse: {
          ...latest.langfuse,
          enabled: form.langfuse?.enabled,
          baseUrl: form.langfuse?.baseUrl,
          publicKey: form.langfuse?.publicKey,
          secretKey: form.langfuse?.secretKey,
          environment: form.langfuse?.environment,
        },
        shortcuts: form.shortcuts,
        answerLanguage: form.answerLanguage,
        uiFont: form.uiFont,
        multimodalSameAsText: form.multimodalSameAsText,
        multimodal: form.multimodal,
        jev: form.jev,
        nativeShell: form.nativeShell,
        cdpInput: form.cdpInput,
        agentBridgeEnabled: form.agentBridgeEnabled,
        agentInboxEnabled: form.agentInboxEnabled,
        hitlMode: form.hitlMode,
        irreversibleActions: form.irreversibleActions,
      }));
      applyUiFont(state.settings.uiFont);
      renderModelLine();
      renderShortcutList();
      if (pathErrors.length) {
        $("save-status").textContent = `设置已保存，路径未生效：${pathErrors.join(" ")}`;
        $("save-status").className = "status bad";
        return;
      }
      $("save-status").textContent = "已保存到本机";
      $("save-status").className = "status ok";
      settingsPage?.refreshSummary();
    } catch (error) {
      $("save-status").textContent = "保存失败，请重试：" + (error.message || String(error));
      $("save-status").className = "status bad";
    } finally { button.disabled = false; }
  });
  $("langfuse-enabled")?.addEventListener("change", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.enabled = e.target.checked;
  });
  $("langfuse-url")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.baseUrl = e.target.value.trim();
  });
  $("langfuse-pk")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.publicKey = e.target.value.trim();
  });
  $("langfuse-sk")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.secretKey = e.target.value.trim();
  });
  $("langfuse-env")?.addEventListener("input", (e) => {
    if (!state.settings.langfuse) state.settings.langfuse = {};
    state.settings.langfuse.environment = e.target.value.trim();
  });
  $("btn-langfuse-test")?.addEventListener("click", async () => {
    const status = $("langfuse-status");
    if (!status) return;
    status.textContent = "连接测试中…";
    status.className = "status";
    const cfg = {
      baseUrl: $("langfuse-url")?.value?.trim() || state.settings?.langfuse?.baseUrl,
      publicKey: $("langfuse-pk")?.value?.trim() || state.settings?.langfuse?.publicKey,
      secretKey: $("langfuse-sk")?.value?.trim() || state.settings?.langfuse?.secretKey,
    };
    const res = await testLangfuseConnection(cfg);
    status.textContent = res.message;
    status.className = res.ok ? "status ok" : "status bad";
  });
  on("mm-same", "change", (e) => {
    state.settings.multimodalSameAsText = e.target.checked;
    $("mm-fields").hidden = e.target.checked;
  });
  on("answer-lang", "change", (e) => {
    state.settings.answerLanguage = e.target.value;
  });
  bindThemeEditor(state);
  on("ui-font", "change", (e) => {
    state.settings.uiFont = e.target.value;
    applyUiFont(state.settings.uiFont);
  });
  $("native-shell")?.addEventListener("change", (e) => {
    state.settings.nativeShell = e.target.checked;
    paintNativeHostStatus(state.nativeHost);
    renderModelLine();
  });
  $("cdp-input")?.addEventListener("change", (e) => {
    state.settings.cdpInput = e.target.checked;
  });
  on("btn-allow-current-site", "click", async (event) => {
    const button = event.currentTarget;
    const origin = button.dataset.origin;
    button.disabled = true;
    try {
      await allowCurrentSite(origin, state.windowId);
      flashStatus(`${origin} 已加入白名单`, true);
    } catch (error) {
      flashStatus(error.message, false);
    } finally {
      button.disabled = false;
    }
  });
  $("agent-bridge")?.addEventListener("change", (e) => {
    state.settings.agentBridgeEnabled = e.target.checked;
  });
  $("agent-inbox")?.addEventListener("change", (e) => {
    state.settings.agentInboxEnabled = e.target.checked;
  });
  $("hitl-mode")?.addEventListener("change", (e) => {
    state.settings.hitlMode = e.target.value;
    updateHitlBadge();
  });
  trustPanel.bind();
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[APPROVAL_STORAGE_KEY]) trustPanel.render();
    if (area === "session" && changes[`pl.contextMenu.${state.windowId}`]?.newValue) consumePending().catch(() => {});
    if (area === "session" && changes[DELEGATE_STORAGE_KEY]) delegatePanel.render();
    if (area === "local" && changes[ACTIVITY_KEY]) paintInboxActivity();
    if (area === "local" && changes.settings?.newValue) {
      state.settings = normalizeSettings(changes.settings.newValue);
      renderAllowCurrentSite($("btn-allow-current-site"), state.tab, state.settings);
      applyUiFont(state.settings.uiFont);
      applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
      renderModelLine();
      if (state.view === "settings") renderSettingsForm();
    }
  });
  trustPanel.render();
  delegatePanel.render();
  $("hitl-badge")?.addEventListener("click", () => {
    state.sessionHitlOverride = false;
    state.settings.hitlMode = "balanced";
    modifySettings((latest) => ({ ...latest, hitlMode: "balanced" }))
      .then((saved) => {
        state.settings.hitlMode = saved.hitlMode;
      })
      .catch(() => {});
    updateHitlBadge();
    if ($("hitl-mode")) $("hitl-mode").value = "balanced";
  });
  $("btn-native-copy-id")?.addEventListener("click", async () => {
    try {
      await copyText(chrome.runtime.id);
      paintNativeHostStatus(state.nativeHost, "已复制扩展 ID");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-copy-install")?.addEventListener("click", async () => {
    try {
      await copyText(nativeInstallCommand());
      paintNativeHostStatus(state.nativeHost, "已复制安装命令");
    } catch (err) {
      paintNativeHostStatus(state.nativeHost, err.message || String(err));
    }
  });
  $("btn-native-test")?.addEventListener("click", async () => {
    await refreshNativeHost();
  });
  $("btn-inbox-poll")?.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "pl.agentInbox.poll" }).catch(() => {});
    await paintInboxActivity();
  });
  $("btn-inbox-clear")?.addEventListener("click", async () => {
    await clearActivity();
    await paintInboxActivity();
  });
  paintInboxActivity();
  bindExternalPromptBridge();
  bindMxApprovalPanel($("settings-group-mx-approval"));
  createAgentGatewayPanel({
    root: $("view-settings"),
    copyText,
    onGatewayChanged: (enabled) => {
      state.settings.agentGatewayEnabled = enabled;
    },
  });
  document.addEventListener("pointerdown", (e) => {
    if (!slash.open) return;
    const menu = $("slash-menu");
    const input = $("input");
    if (menu?.contains(e.target) || input?.contains(e.target)) return;
    hideSlashMenu();
  });
  on("btn-shot", "click", async () => {
    const shot = await captureTab();
    if (!shot) return;
    state.image = shot;
    renderAttach();
  });
  on("btn-clear-attach", "click", () => {
    state.image = null;
    renderAttach();
  });
  chrome.tabs?.onActivated?.addListener(({ windowId }) => {
    if (windowId === state.windowId) refreshTab();
  });
  chrome.tabs?.onUpdated?.addListener((tabId, info, tab) => {
    if (tab.windowId === state.windowId && tab.active && (info.status === "complete" || info.title || info.url)) {
      refreshTab();
    }
  });
  window.addEventListener("pagehide", () => {
    persistSession();
    abortAllSideChats();
    state.recordAbort?.abort();
    state.workAbort?.abort();
  });
  initSideChat();
  } catch (err) {
    console.error("[pagelens] wire rest", err);
  }
}

function markWired() {
  document.documentElement.dataset.pagelensWired = "1";
  const line = $("model-line");
  if (line) line.dataset.pagelensBoot = "1";
}

setTimeout(() => {
  if (document.documentElement.dataset.pagelensWired) return;
  const line = $("model-line");
  if (!line || line.dataset.pagelensBoot) return;
  line.textContent = "侧栏脚本未启动。请在侧栏空白处右键→检查，看 [pagelens] 日志（不要看 chrome://extensions 的 Service Worker）。";
}, 3000);

async function boot() {
  console.info("[pagelens] boot");
  try {
    let windowId = null;
    try {
      windowId = await resolveWindowId();
    } catch (err) {
      console.warn("[pagelens] resolveWindowId", err);
      windowId = await resolveWindowId().catch((retryErr) => {
        console.warn("[pagelens] resolveWindowId retry", retryErr);
        return null;
      });
    }
    try {
      initMarkdown(windowId);
    } catch (err) {
      console.warn("[pagelens] initMarkdown", err);
    }
    if (windowId != null) {
      try {
        bindWindowMail(windowId);
      } catch (err) {
        console.warn("[pagelens] bindWindowMail", err);
      }
    }
    try {
      state.settings = (await applyOptionalLocalSettings()) || (await loadSettings());
      applyUiFont(state.settings.uiFont);
    } catch (err) {
      console.error("[pagelens] boot settings", err);
      state.settings = defaultSettings();
    }
    applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
    wire();
    markWired();
    renderComposerChip();
    syncComposerHints();
    renderModelLine();
    updateHitlBadge();
    renderSkills();
    renderMessages();
    console.info("[pagelens] wired");
  } catch (err) {
    console.error("[pagelens] boot ui", err);
    try {
      bindComposer();
      markWired();
    } catch (bindErr) {
      console.error("[pagelens] bindComposer", bindErr);
    }
    setModelLineMeta("启动失败：" + (err?.message || err));
  }
  refreshLibraryStatus().catch((err) => console.warn("[pagelens] library", err));
  refreshNativeHost({ silent: true }).catch(() => {});
  try {
    const active = await loadActiveSession(await resolveWindowId());
    debugLog("session.boot", {
      windowId: state.windowId,
      sessionId: active?.id || null,
      restored: Boolean(active?.messages?.length),
    });
    if (active?.messages?.length) {
      applySession(active);
      renderMessages();
    }
  } catch (err) {
    console.warn("[pagelens] session", err);
  }
  if (state.windowId != null) {
    takeWindowHint(state.windowId)
      .then((hint) => { if (hint) flashStatus(hint, true); })
      .catch((err) => console.warn("[pagelens] window hint", err));
  }
  refreshTab().catch((err) => console.warn("[pagelens] tab", err));
  consumePending().catch(() => {});
  if (!isModelReady(resolveModel(state.settings, "text"))) {
    console.warn("[pagelens] boot no-model");
    try {
      renderSettingsForm();
    } catch (err) {
      console.warn("[pagelens] settings form", err);
    }
    setView("settings");
    return;
  }
  if (isResumableRun(state.run) && skillsOn() && lastUserAskedForSkill()) {
    resumeInterruptedRun().catch((err) => console.warn("[pagelens] resume", err));
  } else if (state.run) {
    state.run = null;
    persistSession();
  }
}

boot().catch((err) => {
  console.error("[pagelens] boot", err);
  try {
    bindComposer();
    markWired();
  } catch {
    /* ignore */
  }
  setModelLineMeta("启动失败：" + (err?.message || err));
});
