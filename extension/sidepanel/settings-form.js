import { $ } from "./dom.js";
import { renderLibraryStatus } from "./library-ui.js";
import { skillsOn, syncSkillFolderControls } from "./model-line.js";
import { renderNativeHostStatus } from "./native-host-ui.js";
import { settingsPage } from "./panel-refs.js";
import { renderSkillFolderStatus } from "./skill-folder-ui.js";
import { hydrateSkillFolderStatus, renderShortcutList } from "./slash-menu.js";
import { state } from "./state.js";
import { apiKeyLabel, fieldBlock, renderTextProviders, runCookieProbe } from "./text-providers-ui.js";
import { applyUiTheme } from "./theme.js";
import { LOOP_ENGINE_ID } from "../lib/agent/loop-kernel.js";
import { IRREVERSIBLE_ITEMS, normalizeIrreversibleActions } from "../lib/agent/trust/irreversible.js";
import { isCookieProxyModel, normalizeAuthMode } from "../lib/cookie-proxy.js";
import { testConnection } from "../lib/openai.js";
import { isModelReady, presetsFor } from "../lib/storage.js";

function renderIrreversibleList() {
  const box = $("irreversible-list");
  if (!box) return;
  const on = normalizeIrreversibleActions(state.settings.irreversibleActions);
  box.replaceChildren(
    ...IRREVERSIBLE_ITEMS.map((item) => {
      const label = document.createElement("label");
      label.className = "check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = on[item.id];
      input.addEventListener("change", () => {
        state.settings.irreversibleActions = { ...normalizeIrreversibleActions(state.settings.irreversibleActions), [item.id]: input.checked };
      });
      label.append(input, ` ${item.label}`);
      return label;
    }),
  );
}

function renderMultimodalFields() {
  const box = $("mm-fields");
  if (!box) return;
  box.innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  bindSettingFields();
}

function renderSettingsForm() {
  renderTextProviders();
  $("mm-same").checked = state.settings.multimodalSameAsText;
  $("mm-fields").innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  $("mm-fields").hidden = state.settings.multimodalSameAsText || Boolean(state.settings.multimodalRef);
  $("answer-lang").value = state.settings.answerLanguage;
  $("ui-font").value = state.settings.uiFont || "md";
  applyUiTheme(state.settings.uiTheme, state.settings.uiThemeColors);
  if ($("native-shell")) $("native-shell").checked = state.settings.nativeShell !== false;
  if ($("cdp-input")) $("cdp-input").checked = state.settings.cdpInput !== false;
  if ($("agent-bridge")) $("agent-bridge").checked = state.settings.agentBridgeEnabled === true;
  if ($("agent-inbox")) $("agent-inbox").checked = state.settings.agentInboxEnabled === true;
  if ($("hitl-mode")) $("hitl-mode").value = state.settings.hitlMode || "balanced";
  renderIrreversibleList();
  if ($("loop-engine-label")) $("loop-engine-label").textContent = LOOP_ENGINE_ID;
  if ($("skills-enabled")) $("skills-enabled").checked = skillsOn();
  if ($("daily-notes-folder")) $("daily-notes-folder").value = state.settings.dailyNotesFolder ?? "Daily";
  const lf = state.settings.langfuse || {};
  if ($("langfuse-enabled")) $("langfuse-enabled").checked = lf.enabled === true;
  if ($("langfuse-url")) $("langfuse-url").value = lf.baseUrl || "http://localhost:3000";
  if ($("langfuse-pk")) $("langfuse-pk").value = lf.publicKey || "";
  if ($("langfuse-sk")) $("langfuse-sk").value = lf.secretKey || "";
  if ($("langfuse-env")) $("langfuse-env").value = lf.environment || "development";
  if ($("langfuse-status")) {
    $("langfuse-status").textContent = "";
    $("langfuse-status").className = "status";
  }
  syncSkillFolderControls();
  renderLibraryStatus();
  renderSkillFolderStatus();
  hydrateSkillFolderStatus().catch(() => {});
  renderNativeHostStatus();
  renderShortcutList();
  bindSettingFields();
  settingsPage?.render();
}

function bindSettingFields() {
  document.querySelectorAll("[data-k]").forEach((el) => {
    if (el.dataset.settingBound) return;
    el.dataset.settingBound = "true";
    el.addEventListener("change", () => writeField(el));
    el.addEventListener("input", () => writeField(el));
  });
  document.querySelectorAll("[data-probe-cookie]").forEach((btn) => {
    if (btn.dataset.settingBound) return;
    btn.dataset.settingBound = "true";
    btn.addEventListener("click", () => {
      const group = btn.dataset.probeCookie;
      const model = state.settings[group] || {};
      const status = document.querySelector(`[data-probe-status="${group}"]`);
      runCookieProbe(String(model.cookieUrl || "").trim() || String(model.baseUrl || "").trim(), status, btn);
    });
  });
  document.querySelectorAll("[data-test]").forEach((btn) => {
    if (btn.dataset.settingBound) return;
    btn.dataset.settingBound = "true";
    btn.addEventListener("click", () => runTest(btn.dataset.test));
  });
}

function writeField(el) {
  const [group, key] = el.dataset.k.split(".");
  const prevPreset = state.settings[group]?.preset;
  if (!state.settings[group]) state.settings[group] = {};
  if (group === "multimodal") state.settings.multimodalRef = null;
  if (key === "durationFactor") state.settings[group][key] = Number(el.value) || 1;
  else if (key === "summaryInputTokens") state.settings[group][key] = Number(el.value) || 200000;
  else if (key === "bufferSegments" || key === "bufferSeconds") state.settings[group][key] = Number(el.value) || 5;
  else if (key === "authMode") state.settings[group][key] = normalizeAuthMode(el.value);
  else state.settings[group][key] = el.value;
  if (key === "preset") {
    const presets = presetsFor(group);
    const preset = presets.find((p) => p.id === el.value);
    if (preset) {
      state.settings[group].baseUrl = preset.baseUrl || "";
      const input = document.querySelector(`[data-k="${group}.baseUrl"]`);
      if (input) input.value = preset.baseUrl || "";
      if (preset.authMode) setGroupAuthMode(group, preset.authMode);
      else if (isCookieProxyModel(state.settings[group]) && presets.find((p) => p.id === prevPreset)?.authMode) {
        setGroupAuthMode(group, "api-key");
      }
    }
  }
  if (key === "authMode") syncCookieFields(group);
}

function syncCookieFields(group) {
  const model = state.settings[group];
  const cookie = isCookieProxyModel(model);
  if (!cookie && model.cookieUrl) {
    model.cookieUrl = "";
    const input = document.querySelector(`[data-k="${group}.cookieUrl"]`);
    if (input) input.value = "";
  }
  const box = document.querySelector(`[data-cookie-proxy-fields="${group}"]`);
  if (box) box.hidden = !cookie;
  const label = document.querySelector(`[data-key-label="${group}"]`);
  if (label) label.textContent = apiKeyLabel(cookie);
  const status = document.querySelector(`[data-probe-status="${group}"]`);
  if (status) status.textContent = "";
}

function setGroupAuthMode(group, raw) {
  state.settings[group].authMode = normalizeAuthMode(raw);
  const select = document.querySelector(`[data-k="${group}.authMode"]`);
  if (select) select.value = state.settings[group].authMode;
  syncCookieFields(group);
}

async function runTest(group) {
  const status = document.querySelector(`[data-test-status="${group}"]`);
  const model = group === "multimodal" && state.settings.multimodalSameAsText
    ? state.settings.text
    : state.settings[group];
  if (!isModelReady(model)) {
    status.textContent = isCookieProxyModel(model)
      ? "请先填写有效的接口地址、模型 ID（及可选的 Cookie 提取地址）"
      : "请先填写接口地址、模型 ID 和 API 密钥";
    status.className = "status bad";
    return;
  }
  status.textContent = "测试中…";
  status.className = "status";
  try {
    const result = await testConnection(model);
    status.textContent = `可用 · ${result.ms}ms${result.note ? ` · ${result.note}` : ""}`;
    status.className = "status ok";
  } catch (err) {
    status.textContent = err.message || String(err);
    status.className = "status bad";
  }
}


export {
  renderIrreversibleList,
  renderMultimodalFields,
  renderSettingsForm,
  bindSettingFields,
  writeField,
  runTest,
};
