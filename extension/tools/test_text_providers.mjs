import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { PRESETS, isModelReady, normalizeSettings, resolveModel } from "../lib/storage.js";
import { createSettingsPage } from "../sidepanel/settings-page.js";
import {
  addProviderModel,
  enabledModelOptions,
  hasCustomMultimodal,
  hydrateTextCatalog,
  mergeScannedModels,
  modelsUrl,
  multimodalSlotFromRef,
  normalizeProvider,
  parseRemoteModelList,
  pickDefaultRef,
  pickMultimodalRef,
  pickSuggestedMultimodalRef,
  providerFromLegacyText,
  invertProviderModelsEnabled,
  setAllProviderModelsEnabled,
  setProviderModelEnabled,
  suggestProviderName,
  textSlotFromRef,
} from "../lib/text-providers.js";

assert.equal(modelsUrl("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
assert.equal(modelsUrl("https://api.openai.com/v1/models"), "https://api.openai.com/v1/models");
assert.equal(suggestProviderName("https://openrouter.ai/api/v1"), "Openrouter");
assert.equal(suggestProviderName("http://127.0.0.1:11434/v1"), "本地服务");

assert.deepEqual(
  parseRemoteModelList({ data: [{ id: "gpt-4o-mini", owned_by: "openai" }, { id: "gpt-4o-mini" }, "claude"] }),
  [{ id: "gpt-4o-mini", ownedBy: "openai" }, { id: "claude" }],
);
assert.deepEqual(parseRemoteModelList({ models: ["a", "b"] }), [{ id: "a" }, { id: "b" }]);

const merged = mergeScannedModels(
  [{ id: "keep", enabled: false, ownedBy: "old" }, { id: "gone", enabled: true }],
  [{ id: "keep", ownedBy: "new" }, { id: "fresh" }],
);
assert.equal(merged[0].id, "keep");
assert.equal(merged[0].enabled, false);
assert.equal(merged[0].ownedBy, "new");
assert.equal(merged[1].id, "fresh");
assert.equal(merged[1].enabled, true);
assert.equal(merged[2].id, "gone");

const legacy = providerFromLegacyText({
  preset: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
});
assert.equal(legacy.models[0].id, "gpt-4o-mini");
assert.equal(legacy.models[0].enabled, true);

const migrated = hydrateTextCatalog({}, {
  preset: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-x",
  model: "gpt-4o-mini",
  summaryInputTokens: 8000,
});
assert.equal(migrated.textProviders.length, 1);
assert.equal(migrated.textRef.modelId, "gpt-4o-mini");
assert.equal(migrated.text.model, "gpt-4o-mini");
assert.equal(migrated.text.apiKey, "sk-x");
assert.equal(migrated.text.summaryInputTokens, 8000);

const two = [
  { id: "p1", name: "A", preset: "custom", baseUrl: "https://a.example/v1", apiKey: "1", models: [{ id: "m1", enabled: true }, { id: "m2", enabled: false }] },
  { id: "p2", name: "B", preset: "custom", baseUrl: "https://b.example/v1", apiKey: "2", models: [{ id: "n1", enabled: true }] },
];
assert.deepEqual(enabledModelOptions(two).map((o) => o.modelId), ["m1", "n1"]);
assert.deepEqual(pickDefaultRef(two, { providerId: "p2", modelId: "n1" }), { providerId: "p2", modelId: "n1" });
assert.deepEqual(pickDefaultRef(two, { providerId: "p1", modelId: "m2" }), { providerId: "p1", modelId: "m1" });

const toggled = setProviderModelEnabled(two[0], "m2", true);
assert.equal(toggled.models[1].enabled, true);
const allOn = setAllProviderModelsEnabled(two[0], true);
assert.ok(allOn.models.every((m) => m.enabled), "select all");
const inverted = invertProviderModelsEnabled(allOn);
assert.ok(inverted.models.every((m) => !m.enabled), "invert all");
const partial = setAllProviderModelsEnabled(two[0], true, ["m2"]);
assert.equal(partial.models[0].enabled, true);
assert.equal(partial.models[1].enabled, true);
const added = addProviderModel(two[0], "m3");
assert.equal(added.models.at(-1).id, "m3");
assert.equal(added.models.at(-1).enabled, true);

const saved = normalizeSettings({
  text: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-d" },
});
assert.equal(saved.textProviders.length, 1);
assert.equal(saved.text.model, "deepseek-chat");
assert.equal(saved.textRef.modelId, "deepseek-chat");

for (const baseUrl of ["http://127.0.0.1:3425/v1", "http://localhost:11434/v1", "http://[::1]:3425/v1"]) {
  const local = normalizeSettings({ text: { baseUrl, model: "local-model", apiKey: "" } });
  assert.equal(isModelReady(local.text), true, "local models can be used without an API key");
  assert.equal(isModelReady({ ...local.text, model: "" }), false);
}
for (const baseUrl of ["https://api.tokenpony.cn/v1", "https://localhost.example/v1", "file:///tmp/model", "invalid"]) {
  assert.equal(isModelReady({ baseUrl, model: "model", apiKey: "" }), false);
}
assert.equal(isModelReady(saved.text), true);
assert.equal(isModelReady({ ...saved.text, apiKey: " " }), false);

const empty = normalizeSettings({});
assert.equal(empty.textProviders.length, 0);
assert.equal(empty.textRef, null);

const agentNode = PRESETS.find((preset) => preset.id === "ai-agent-node");
assert.ok(agentNode, "ai-agent-node preset exists");
assert.equal(agentNode.authMode, "cookie-proxy");
assert.equal(agentNode.baseUrl, "http://127.0.0.1:8811/api/model-proxy/v1");
assert.equal(suggestProviderName(agentNode.baseUrl, "ai-agent-node"), "ai-agent-node");

const cookieProvider = normalizeProvider({
  id: "cookie-node",
  preset: "ai-agent-node",
  authMode: "cookie-proxy",
  cookieUrl: " https://tango.example.com/session ",
  baseUrl: agentNode.baseUrl,
  models: ["proxy-model"],
});
assert.equal(cookieProvider.authMode, "cookie-proxy");
assert.equal(cookieProvider.cookieUrl, "https://tango.example.com/session");
assert.equal(cookieProvider.models[0].id, "proxy-model");

const apiKeyProvider = normalizeProvider({
  id: "openai-key",
  preset: "openai",
  authMode: "api-key",
  cookieUrl: "https://tango.example.com/session",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-x",
  models: [{ id: "gpt-4o-mini", enabled: true }],
});
assert.equal(apiKeyProvider.authMode, "api-key");

const hydratedCookie = hydrateTextCatalog({}, {
  preset: "ai-agent-node",
  baseUrl: agentNode.baseUrl,
  model: "proxy-model",
  apiKey: "",
  authMode: "cookie-proxy",
  cookieUrl: "https://tango.example.com/session",
});
assert.equal(hydratedCookie.textProviders[0].preset, "ai-agent-node");
assert.equal(hydratedCookie.text.authMode, "cookie-proxy");
assert.equal(hydratedCookie.text.cookieUrl, "https://tango.example.com/session");
assert.equal(hydratedCookie.textRef.modelId, "proxy-model");

const cookieSlot = textSlotFromRef(
  [cookieProvider, apiKeyProvider],
  { providerId: "cookie-node", modelId: "proxy-model" },
  {},
);
assert.equal(cookieSlot.authMode, "cookie-proxy");
assert.equal(cookieSlot.cookieUrl, "https://tango.example.com/session");
const apiKeySlot = textSlotFromRef(
  [cookieProvider, apiKeyProvider],
  { providerId: "openai-key", modelId: "gpt-4o-mini" },
  cookieSlot,
);
assert.equal(Object.hasOwn(apiKeySlot, "authMode"), false, "switching back to an API-key provider clears authMode");
assert.equal(Object.hasOwn(apiKeySlot, "cookieUrl"), false, "switching back to an API-key provider clears cookieUrl");

const cookieSettings = normalizeSettings({
  textProviders: [cookieProvider, apiKeyProvider],
  textRef: { providerId: "cookie-node", modelId: "proxy-model" },
  multimodal: {
    baseUrl: "https://vision.example/v1",
    model: "vl",
    authMode: "cookie-proxy",
    cookieUrl: "https://tango.example.com/session",
  },
});
assert.equal(cookieSettings.text.authMode, "cookie-proxy");
assert.equal(cookieSettings.text.cookieUrl, "https://tango.example.com/session");
assert.equal(cookieSettings.multimodal.authMode, "cookie-proxy");
assert.equal(cookieSettings.multimodal.cookieUrl, "https://tango.example.com/session");
assert.equal(isModelReady({
  authMode: "cookie-proxy",
  baseUrl: "https://gateway.example/v1",
  model: "remote-model",
  apiKey: "",
}), true, "remote https cookie-proxy is ready without an API key");
assert.equal(isModelReady({
  authMode: "cookie-proxy",
  baseUrl: "https://gateway.example/v1",
  cookieUrl: "https://tango.example.com/session",
  model: "remote-model",
  apiKey: "",
}), true);
assert.equal(isModelReady({
  authMode: "cookie-proxy",
  baseUrl: "https://gateway.example/v1",
  cookieUrl: "javascript:alert(1)",
  model: "remote-model",
}), false, "invalid cookieUrl is not ready");
assert.equal(isModelReady(cookieSettings.text), true);

const switched = normalizeSettings({
  ...cookieSettings,
  textRef: { providerId: "openai-key", modelId: "gpt-4o-mini" },
  multimodal: { ...cookieSettings.multimodal, authMode: "api-key", cookieUrl: "https://tango.example.com/session" },
});
assert.equal(Object.hasOwn(switched.text, "authMode"), false);
assert.equal(Object.hasOwn(switched.text, "cookieUrl"), false);
assert.equal(Object.hasOwn(switched.multimodal, "authMode"), false);
assert.equal(Object.hasOwn(switched.multimodal, "cookieUrl"), false);

// Provider-backed multimodal selection (multimodalRef)
const proxyCatalog = [
  normalizeProvider({
    id: "proxy-p1",
    name: "ai-agent-node",
    preset: "ai-agent-node",
    authMode: "cookie-proxy",
    baseUrl: "http://127.0.0.1:8811/api/model-proxy/v1",
    cookieUrl: "https://tango.example.com",
    apiKey: "",
    models: [
      { id: "deepseek-v4-flash", enabled: true },
      { id: "kimi-k3", enabled: true },
      { id: "disabled-vl", enabled: false },
    ],
  }),
  apiKeyProvider,
];

assert.deepEqual(
  pickSuggestedMultimodalRef(proxyCatalog, { providerId: "proxy-p1", modelId: "deepseek-v4-flash" }),
  { providerId: "proxy-p1", modelId: "kimi-k3" },
  "suggests a vision-capable model when unchecking multimodalSameAsText",
);
assert.deepEqual(
  pickMultimodalRef(proxyCatalog, { providerId: "proxy-p1", modelId: "kimi-k3" }),
  { providerId: "proxy-p1", modelId: "kimi-k3" },
);
assert.equal(pickMultimodalRef(proxyCatalog, { providerId: "proxy-p1", modelId: "disabled-vl" }), null);
assert.equal(hasCustomMultimodal({ baseUrl: "", model: "", apiKey: "" }), false);
assert.equal(hasCustomMultimodal({ baseUrl: "https://v.example/v1", model: "" }), true);

const mmBound = normalizeSettings({
  textProviders: proxyCatalog,
  textRef: { providerId: "proxy-p1", modelId: "deepseek-v4-flash" },
  multimodalSameAsText: false,
  multimodalRef: { providerId: "proxy-p1", modelId: "kimi-k3" },
});
assert.deepEqual(mmBound.multimodalRef, { providerId: "proxy-p1", modelId: "kimi-k3" });
assert.equal(mmBound.multimodal.model, "kimi-k3");
assert.equal(mmBound.multimodal.baseUrl, "http://127.0.0.1:8811/api/model-proxy/v1");
assert.equal(mmBound.multimodal.authMode, "cookie-proxy");
assert.equal(mmBound.multimodal.cookieUrl, "https://tango.example.com");
assert.equal(resolveModel(mmBound, "multimodal").model, "kimi-k3");
assert.equal(resolveModel({ ...mmBound, multimodalSameAsText: true }, "multimodal").model, "deepseek-v4-flash");

const mmSwitchedToApiKey = normalizeSettings({
  ...mmBound,
  multimodalRef: { providerId: "openai-key", modelId: "gpt-4o-mini" },
});
assert.equal(mmSwitchedToApiKey.multimodal.model, "gpt-4o-mini");
assert.equal(mmSwitchedToApiKey.multimodal.apiKey, "sk-x");
assert.equal(Object.hasOwn(mmSwitchedToApiKey.multimodal, "authMode"), false);
assert.equal(Object.hasOwn(mmSwitchedToApiKey.multimodal, "cookieUrl"), false);

const mmProviderUpdated = normalizeSettings({
  ...mmBound,
  textProviders: [
    { ...proxyCatalog[0], cookieUrl: "https://tango-new.example.com" },
    apiKeyProvider,
  ],
});
assert.equal(mmProviderUpdated.multimodal.cookieUrl, "https://tango-new.example.com", "multimodal stays synced with provider edits");

const mmProviderDeleted = normalizeSettings({
  ...mmBound,
  textProviders: [apiKeyProvider],
});
assert.equal(mmProviderDeleted.multimodalRef, null, "deleting referenced provider clears multimodalRef");

assert.equal(multimodalSlotFromRef(proxyCatalog, { providerId: "missing", modelId: "x" }), null);

// Settings page UI: multimodal model dropdown hides manual #mm-fields unless __custom__ is selected
{
  const html = await readFile(new URL("../sidepanel/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://fixture.invalid/" });
  const prevDoc = globalThis.document;
  const prevOption = globalThis.Option;
  const prevStorage = globalThis.localStorage;
  globalThis.document = dom.window.document;
  globalThis.Option = dom.window.Option;
  globalThis.localStorage = dom.window.localStorage;
  try {
    const root = dom.window.document.getElementById("view-settings");
    let currentSettings = structuredClone(mmBound);
    const changes = [];
    const page = createSettingsPage({
      root,
      getSettings: () => currentSettings,
      onModelChange() {},
      onMultimodalChange(value) {
        changes.push(value);
        if (value === "__custom__") {
          currentSettings = { ...currentSettings, multimodalRef: null };
        } else if (value.includes("::")) {
          const [providerId, modelId] = value.split("::");
          currentSettings = normalizeSettings({ ...currentSettings, multimodalRef: { providerId, modelId } });
        }
        page.refreshModels();
      },
    });
    const mmField = root.querySelector("#mm-model-field");
    const mmSelect = root.querySelector("#settings-mm-model");
    const mmFields = root.querySelector("#mm-fields");
    assert.equal(mmField.hidden, false);
    assert.equal(mmSelect.value, "proxy-p1::kimi-k3");
    assert.equal(mmFields.hidden, true, "manual multimodal form stays hidden when picking from configured providers");
    assert.ok([...mmSelect.options].some((o) => o.value === "proxy-p1::deepseek-v4-flash"));
    assert.ok([...mmSelect.options].some((o) => o.value === "__custom__"));

    mmSelect.value = "__custom__";
    mmSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.deepEqual(changes, ["__custom__"]);
    assert.equal(mmFields.hidden, false, "manual multimodal form appears when switching to custom mode");

    mmSelect.value = "openai-key::gpt-4o-mini";
    mmSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    assert.equal(mmSelect.value, "openai-key::gpt-4o-mini");
    assert.equal(mmFields.hidden, true, "manual form hides again after selecting a provider model");

    currentSettings = { ...currentSettings, multimodalSameAsText: true };
    page.refreshModels();
    assert.equal(mmField.hidden, true);
    assert.equal(mmFields.hidden, true);

    currentSettings = normalizeSettings({
      textProviders: proxyCatalog,
      multimodalSameAsText: false,
      multimodalRef: null,
      multimodal: { preset: "custom", baseUrl: "https://legacy.example/v1", model: "legacy-vl", apiKey: "k" },
    });
    page.render();
    assert.equal(mmField.hidden, false);
    assert.equal(mmSelect.value, "__custom__", "legacy standalone multimodal stays selected as custom");
    assert.equal(mmFields.hidden, false);
  } finally {
    globalThis.document = prevDoc;
    globalThis.Option = prevOption;
    globalThis.localStorage = prevStorage;
    dom.window.close();
  }
}

console.log("PASS text-providers");
