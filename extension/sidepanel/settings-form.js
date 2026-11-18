import { $ } from "./dom.js";
import { renderLibraryStatus } from "./library-ui.js";
import { skillsOn, syncSkillFolderControls } from "./model-line.js";
import { renderNativeHostStatus } from "./native-host-ui.js";
import { settingsPage } from "./panel-refs.js";
import { renderSkillFolderStatus } from "./skill-folder-ui.js";
import { hydrateSkillFolderStatus, renderShortcutList } from "./slash-menu.js";
import { state } from "./state.js";
import { fieldBlock, renderTextProviders } from "./text-providers-ui.js";
import { applyUiTheme } from "./theme.js";
import { LOOP_ENGINE_ID } from "../lib/agent/loop-kernel.js";
import { IRREVERSIBLE_ITEMS, normalizeIrreversibleActions } from "../lib/agent/trust/irreversible.js";
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

function renderSettingsForm() {
  renderTextProviders();
  $("mm-same").checked = state.settings.multimodalSameAsText;
  $("mm-fields").innerHTML = fieldBlock("multimodal", state.settings.multimodal);
  $("mm-fields").classList.toggle("hidden", state.settings.multimodalSameAsText);
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
  document.querySelectorAll("[data-test]").forEach((btn) => {
    if (btn.dataset.settingBound) return;
    btn.dataset.settingBound = "true";
    btn.addEventListener("click", () => runTest(btn.dataset.test));
  });
}

function writeField(el) {
  const [group, key] = el.dataset.k.split(".");
  if (!state.settings[group]) state.settings[group] = {};
  if (key === "durationFactor") state.settings[group][key] = Number(el.value) || 1;
  else if (key === "summaryInputTokens") state.settings[group][key] = Number(el.value) || 200000;
  else if (key === "bufferSegments" || key === "bufferSeconds") state.settings[group][key] = Number(el.value) || 5;
  else state.settings[group][key] = el.value;
  if (key === "preset") {
    const preset = presetsFor(group).find((p) => p.id === el.value);
    if (preset) {
      state.settings[group].baseUrl = preset.baseUrl || "";
      const input = document.querySelector(`[data-k="${group}.baseUrl"]`);
      if (input) input.value = preset.baseUrl || "";
    }
  }
}

async function runTest(group) {
  const status = document.querySelector(`[data-test-status="${group}"]`);
  const model = group === "multimodal" && state.settings.multimodalSameAsText
    ? state.settings.text
    : state.settings[group];
  if (!isModelReady(model)) {
    status.textContent = "请先填满 base_url、model_name、api_key";
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
  renderSettingsForm,
  bindSettingFields,
  writeField,
  runTest,
};
