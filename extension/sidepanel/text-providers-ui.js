import { $ } from "./dom.js";
import { renderModelLine } from "./model-line.js";
import { settingsPage } from "./panel-refs.js";
import { state } from "./state.js";
import { isCookieProxyModel, normalizeAuthMode, probeCookiesForUrl } from "../lib/cookie-proxy.js";
import { listRemoteModels } from "../lib/openai.js";
import { modifySettings, presetsFor } from "../lib/storage.js";
import {
  addProviderModel,
  hydrateTextCatalog,
  textSlotFromRef,
  invertProviderModelsEnabled,
  mergeScannedModels,
  newProviderId,
  normalizeProvider,
  setAllProviderModelsEnabled,
  setProviderModelEnabled,
  suggestProviderName,
} from "../lib/text-providers.js";

function fieldBlock(prefix, model, hints = {}) {
  const presetOpts = presetsFor(prefix).map(
    (p) => `<option value="${p.id}" ${p.id === model.preset ? "selected" : ""}>${p.name}</option>`,
  ).join("");
  const cookieProxy = isCookieProxyModel(model);
  return `
    <label class="field">预设
      <select data-k="${prefix}.preset">${presetOpts}</select>
    </label>
    <label class="field">认证方式
      <select data-k="${prefix}.authMode">${authModeOptions(cookieProxy ? "cookie-proxy" : "api-key")}</select>
    </label>
    <label class="field">接口地址
      <input data-k="${prefix}.baseUrl" type="url" value="${escapeAttr(model.baseUrl)}" placeholder="${escapeAttr(hints.baseUrl || "https://api.example.com/v1")}" />
    </label>
    <label class="field">模型 ID
      <input data-k="${prefix}.model" value="${escapeAttr(model.model)}" placeholder="${escapeAttr(hints.model || "gpt-4o-mini")}" />
    </label>
    ${cookieFields({
      wrapperAttr: `data-cookie-proxy-fields="${prefix}"`,
      inputAttr: `data-k="${prefix}.cookieUrl"`,
      buttonAttr: `data-probe-cookie="${prefix}"`,
      statusAttr: `data-probe-status="${prefix}"`,
      value: model.cookieUrl,
      hidden: !cookieProxy,
    })}
    <label class="field"><span data-key-label="${prefix}">${apiKeyLabel(cookieProxy)}</span>
      <input data-k="${prefix}.apiKey" type="password" value="${escapeAttr(model.apiKey)}" placeholder="${escapeAttr(hints.key || "sk-…")}" autocomplete="off" />
    </label>
    ${prefix === 'text' ? `<label class="field">视频总结：单次正文上限（token）
      <input data-k="text.summaryInputTokens" type="number" min="1000" max="2000000" step="1000" value="${Number(model.summaryInputTokens) || 200000}" />
      <small>默认 200,000；超过才分段。按中英文估算，不含提示词和输出。</small>
    </label>` : ''}
    <div class="row-btns">
      <button class="secondary" type="button" data-test="${prefix}">测试连接</button>
      <span class="status" data-test-status="${prefix}"></span>
    </div>
  `;
}

function authModeOptions(selected) {
  return [
    ["api-key", "API 密钥（Bearer）"],
    ["cookie-proxy", "Cookie 代理转发（ai-agent-node 等）"],
  ].map(([id, label]) => `<option value="${id}" ${id === selected ? "selected" : ""}>${label}</option>`).join("");
}

function apiKeyLabel(cookieProxy) {
  return cookieProxy ? "API 密钥（选填，Cookie 代理通常留空）" : "API 密钥";
}

function cookieFields({ wrapperAttr, inputAttr, buttonAttr, statusAttr, value, hidden }) {
  return `<div class="cookie-proxy-fields" ${wrapperAttr} ${hidden ? "hidden" : ""}>
      <label class="field">Cookie 提取地址（选填，留空同接口地址）
        <input ${inputAttr} type="url" value="${escapeAttr(value)}" placeholder="https://your-site.example.com" autocomplete="off" />
        <small>提取浏览器在该地址已登录的 Cookie 并注入转发到代理接口</small>
      </label>
      <div class="cookie-probe-row">
        <button type="button" class="secondary" ${buttonAttr}>检测 Cookie</button>
        <span class="status" ${statusAttr} role="status"></span>
      </div>
    </div>`;
}

/** 只展示 Cookie 数量与名称，绝不展示值。 */
async function runCookieProbe(url, statusEl, button) {
  if (!statusEl) return;
  const target = String(url || "").trim();
  if (!target) {
    statusEl.textContent = "请先填写 Cookie 提取地址或接口地址";
    statusEl.className = "status bad";
    return;
  }
  statusEl.textContent = "检测中…";
  statusEl.className = "status";
  if (button) button.disabled = true;
  try {
    const result = await probeCookiesForUrl(target);
    if (result?.ok) {
      const names = (result.cookieNames || []).map(String);
      const shown = names.slice(0, 3).join(", ");
      const more = names.length > 3 || result.cookieCount > names.length ? ", …" : "";
      statusEl.textContent = `已检测到 ${result.cookieCount} 个 Cookie${shown ? `（${shown}${more}）` : ""}`;
      statusEl.className = "status ok";
    } else {
      statusEl.textContent = result?.error || "未检测到 Cookie，请先在浏览器登录该站点";
      statusEl.className = "status bad";
    }
  } catch (err) {
    statusEl.textContent = err?.message || String(err);
    statusEl.className = "status bad";
  } finally {
    if (button) button.disabled = false;
  }
}

function cookieOrigin(raw) {
  try { return new URL(raw).origin; } catch { return ""; }
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function syncTextCatalog() {
  const tokens = state.settings.text?.summaryInputTokens;
  const catalog = hydrateTextCatalog(state.settings, state.settings.text);
  state.settings.textProviders = catalog.textProviders;
  state.settings.textRef = catalog.textRef;
  state.settings.text = { ...catalog.text, summaryInputTokens: tokens };
}

function sameTextRef(a, b) {
  return (a?.providerId || "") === (b?.providerId || "") && (a?.modelId || "") === (b?.modelId || "");
}

function refEnabled(providers, ref) {
  const provider = (providers || []).find((p) => p.id === ref?.providerId);
  return Boolean(provider && (provider.models || []).some((m) => m.id === ref.modelId && m.enabled !== false));
}

function withEnabledModel(provider, modelId, source) {
  const models = (provider.models || []).map((m) => ({ ...m }));
  const idx = models.findIndex((m) => m.id === modelId);
  if (idx >= 0) models[idx] = { ...models[idx], enabled: true };
  else {
    const carried = (source?.models || []).find((m) => m.id === modelId);
    models.push(carried ? { ...carried, enabled: true } : { id: modelId, enabled: true });
  }
  return { ...provider, models };
}

// Keep this edit's providers. If the preserved ref points outside them, splice in
// that one provider from latest so normalize cannot snap the ref back to the first model.
function providersKeepingRef(edited, latestProviders, ref) {
  if (!ref?.providerId || !ref.modelId || refEnabled(edited, ref)) return edited;
  const source = (latestProviders || []).find((p) => p.id === ref.providerId);
  if (!source) return edited;
  const idx = edited.findIndex((p) => p.id === ref.providerId);
  if (idx < 0) return [...edited, withEnabledModel(source, ref.modelId, source)];
  const next = edited.slice();
  next[idx] = withEnabledModel(edited[idx], ref.modelId, source);
  return next;
}

function persistTextCatalog(baseRef = state.settings.textRef ? { ...state.settings.textRef } : null) {
  syncTextCatalog();
  const textProviders = state.settings.textProviders;
  const nextRef = state.settings.textRef ? { ...state.settings.textRef } : null;
  return modifySettings((latest) => {
    const textRef = sameTextRef(latest.textRef, baseRef) ? nextRef : latest.textRef;
    const providers = sameTextRef(textRef, nextRef)
      ? textProviders
      : providersKeepingRef(textProviders, latest.textProviders, textRef);
    const slot = textSlotFromRef(providers, textRef, latest.text);
    const { authMode: _authMode, cookieUrl: _cookieUrl, ...latestText } = latest.text || {};
    return {
      ...latest,
      textProviders: providers,
      textRef,
      text: {
        ...latestText,
        preset: slot.preset,
        baseUrl: slot.baseUrl,
        apiKey: slot.apiKey,
        model: slot.model,
        ...(isCookieProxyModel(slot) ? { authMode: "cookie-proxy", cookieUrl: slot.cookieUrl || "" } : {}),
        summaryInputTokens: latest.text?.summaryInputTokens,
      },
    };
  }).then((saved) => {
    state.settings.textProviders = saved.textProviders;
    state.settings.textRef = saved.textRef;
    state.settings.text = saved.text;
    state.settings.multimodalRef = saved.multimodalRef;
    state.settings.multimodal = saved.multimodal;
    state.settings.agentBridgeOrigins = saved.agentBridgeOrigins;
    renderTextProviders();
    renderModelLine();
    return saved;
  });
}

function providerById(id) {
  return (state.settings.textProviders || []).find((p) => p.id === id);
}

function replaceProvider(next) {
  state.settings.textProviders = (state.settings.textProviders || []).map((p) => (p.id === next.id ? next : p));
}

function visibleProviderModelIds(provider) {
  const q = String(state.textProviderUi?.query || "").trim().toLowerCase();
  return (provider.models || [])
    .filter((m) => !q || m.id.toLowerCase().includes(q) || String(m.ownedBy || "").toLowerCase().includes(q))
    .map((m) => m.id);
}

function refreshProviderFilter(root) {
  const query = state.textProviderUi.query;
  for (const input of root.querySelectorAll("[data-tp-query]")) {
    if (input.value !== query) input.value = query;
  }
  for (const card of root.querySelectorAll("[data-tp-provider]")) {
    const provider = providerById(card.dataset.tpProvider);
    const bulk = card.querySelector(".model-bulk");
    if (!provider || !bulk) continue;
    const visible = new Set(visibleProviderModelIds(provider));
    for (const row of card.querySelectorAll("[data-tp-model-item]")) {
      row.hidden = !visible.has(row.dataset.tpModelItem);
    }
    const enabled = provider.models.filter((model) => model.enabled && visible.has(model.id)).length;
    card.querySelector(".model-count").textContent = `${enabled}/${visible.size}${query.trim() ? "（当前筛选）" : ""}`;
    card.querySelector(".model-empty").hidden = visible.size !== 0;
    bulk.hidden = visible.size === 0;
  }
}

function renderTextProviders() {
  const root = $("text-providers");
  if (!root) return;
  bindTextProvidersOnce();
  syncTextCatalog();
  const providers = state.settings.textProviders || [];
  const ui = state.textProviderUi;
  const current = state.settings.textRef;
  const draftCookie = normalizeAuthMode(ui.draftAuthMode) === "cookie-proxy";
  const presetOpts = presetsFor("text").map((p) => `<option value="${escapeAttr(p.id)}">${escapeAttr(p.name)}</option>`).join("");
  const cards = providers.map((p) => {
    const editing = ui.editingId === p.id;
    const cookieProxy = isCookieProxyModel(p);
    const cookieSource = p.cookieUrl ? cookieOrigin(p.cookieUrl) || p.cookieUrl : "";
    const modelInputId = `provider-model-${escapeAttr(p.id)}`;
    const modelRows = p.models.map((m) => {
      const isCurrent = current?.providerId === p.id && current?.modelId === m.id;
      return `<li data-tp-model-item="${escapeAttr(m.id)}">
        <label class="check">
          <input type="checkbox" data-tp="toggle" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "checked" : ""} />
          <span><code>${escapeAttr(m.id)}</code>${m.ownedBy ? ` <span class="muted">· ${escapeAttr(m.ownedBy)}</span>` : ""}${isCurrent ? " · 当前" : ""}</span>
        </label>
        <button type="button" class="secondary" data-tp="current" data-id="${escapeAttr(p.id)}" data-model="${escapeAttr(m.id)}" ${m.enabled ? "" : "disabled"}>设为当前</button>
      </li>`;
    }).join("");
    return `<article class="provider-card" data-tp-provider="${escapeAttr(p.id)}">
      <div class="provider-head">
        <strong>${escapeAttr(p.name)}</strong>
        <span class="muted">${escapeAttr(p.preset)} · ${cookieProxy ? '<span class="cookie-badge">Cookie 代理</span>' : (p.apiKey ? "已填密钥" : "无密钥")}</span>
      </div>
      <div class="muted provider-url">${escapeAttr(p.baseUrl || "—")}${cookieProxy && cookieSource ? `<br>Cookie 来源：${escapeAttr(cookieSource)}` : ""}${p.scannedAt ? ` · 扫描于 ${escapeAttr(p.scannedAt.slice(0, 19).replace("T", " "))}` : ""}</div>
      ${p.scanError ? `<div class="status bad">${escapeAttr(p.scanError)}</div>` : ""}
      <div class="row-btns provider-actions">
        <button type="button" class="secondary" data-tp="scan" data-id="${escapeAttr(p.id)}">扫描模型</button>
        <button type="button" class="secondary" data-tp="edit" data-id="${escapeAttr(p.id)}" aria-expanded="${editing}">${editing ? "取消编辑" : "编辑连接"}</button>
        <button type="button" class="secondary" data-tp="delete" data-id="${escapeAttr(p.id)}">删除</button>
      </div>
      ${editing ? `<div class="provider-edit">
        <label class="field">接口地址<input data-tp-edit="baseUrl" data-id="${escapeAttr(p.id)}" type="url" value="${escapeAttr(p.baseUrl)}" /></label>
        <label class="field">认证方式<select data-tp-edit="authMode" data-id="${escapeAttr(p.id)}">${authModeOptions(cookieProxy ? "cookie-proxy" : "api-key")}</select></label>
        ${cookieFields({
          wrapperAttr: `data-tp-edit-cookie="${escapeAttr(p.id)}"`,
          inputAttr: `data-tp-edit="cookieUrl" data-id="${escapeAttr(p.id)}"`,
          buttonAttr: `data-tp="probe-edit-cookie" data-id="${escapeAttr(p.id)}"`,
          statusAttr: `data-tp-probe-status="edit" data-id="${escapeAttr(p.id)}"`,
          value: p.cookieUrl,
          hidden: !cookieProxy,
        })}
        <label class="field">${cookieProxy ? "API 密钥（选填，Cookie 代理通常留空）" : "API 密钥"}<input data-tp-edit="apiKey" data-id="${escapeAttr(p.id)}" type="password" value="" placeholder="留空则不改" autocomplete="off" /></label>
        <div class="row-btns">
          <button type="button" class="primary provider-submit" data-tp="save-edit" data-id="${escapeAttr(p.id)}">保存并扫描</button>
        </div>
      </div>` : ""}
      <div class="provider-model-input">
        <label class="field" for="${modelInputId}">手动添加模型</label>
        <div class="path-row">
          <input id="${modelInputId}" data-tp-add-model="${escapeAttr(p.id)}" value="${escapeAttr(ui.addModel[p.id] || "")}" placeholder="输入模型 ID" />
          <button type="button" class="secondary" data-tp="add-model" data-id="${escapeAttr(p.id)}">添加</button>
        </div>
      </div>
      ${p.models.length > 8 ? `<label class="field">筛选模型<input data-tp-query="1" value="${escapeAttr(ui.query)}" placeholder="搜索模型名" /></label>` : ""}
      ${modelRows ? `<div class="row-btns model-bulk">
        <button type="button" class="secondary" data-tp="select-all" data-id="${escapeAttr(p.id)}">全选</button>
        <button type="button" class="secondary" data-tp="invert" data-id="${escapeAttr(p.id)}">反选</button>
        <span class="muted model-count"></span>
      </div>
      <ul class="model-scan-list">${modelRows}</ul>
      <p class="muted model-empty" hidden>没有匹配的模型。</p>` : `<p class="muted">尚未发现模型，可扫描或手填。</p>`}
    </article>`;
  }).join("");
  root.innerHTML = `
    <div class="row-btns provider-toolbar">
      <button type="button" class="${ui.adding ? "secondary" : "primary provider-submit"}" data-tp="toggle-add" aria-expanded="${ui.adding}">${ui.adding ? "取消新增" : "新增服务商"}</button>
      ${providers.length ? `<span class="muted">${providers.length} 家服务商</span>` : ""}
    </div>
    ${ui.msg ? `<p class="status ok" role="status">${escapeAttr(ui.msg)}</p>` : ""}
    ${ui.err ? `<p class="status bad" role="alert">${escapeAttr(ui.err)}</p>` : ""}
    ${ui.adding ? `<div class="provider-add">
      <label class="field">预设<select data-tp-draft="preset">${presetOpts}</select></label>
      <label class="field">认证方式<select data-tp-draft="authMode">${authModeOptions(draftCookie ? "cookie-proxy" : "api-key")}</select></label>
      <label class="field">服务商名称（选填）<input data-tp-draft="name" placeholder="默认使用接口域名" /></label>
      <label class="field">接口地址<input data-tp-draft="baseUrl" type="url" placeholder="https://api.example.com/v1" required /></label>
      ${cookieFields({
        wrapperAttr: "data-tp-draft-cookie",
        inputAttr: 'data-tp-draft="cookieUrl"',
        buttonAttr: 'data-tp="probe-draft-cookie"',
        statusAttr: 'data-tp-probe-status="draft"',
        value: "",
        hidden: !draftCookie,
      })}
      <label class="field"><span data-tp-draft-key-label>${apiKeyLabel(draftCookie)}</span><input data-tp-draft="apiKey" type="password" placeholder="sk-…" autocomplete="off" /></label>
      <label class="field">模型 ID（选填）<input data-tp-draft="model" placeholder="gpt-4o-mini" /></label>
      <div class="row-btns">
        <button type="button" class="primary provider-submit" data-tp="add">添加并扫描</button>
      </div>
    </div>` : ""}
    ${cards || (!ui.adding ? '<p class="hint">支持 OpenAI 兼容服务，例如 OpenRouter 和本地 Ollama。</p>' : "")}
  `;
  const draftPreset = root.querySelector("[data-tp-draft=preset]");
  if (draftPreset && ui.draftPreset) draftPreset.value = ui.draftPreset;
  refreshProviderFilter(root);
  settingsPage?.refreshModels();
}

function setDraftAuthMode(root, raw) {
  const mode = normalizeAuthMode(raw);
  const cookie = mode === "cookie-proxy";
  state.textProviderUi.draftAuthMode = mode;
  const select = root.querySelector("[data-tp-draft=authMode]");
  if (select && select.value !== mode) select.value = mode;
  const box = root.querySelector("[data-tp-draft-cookie]");
  if (box) box.hidden = !cookie;
  const label = root.querySelector("[data-tp-draft-key-label]");
  if (label) label.textContent = apiKeyLabel(cookie);
}

function bindTextProvidersOnce() {
  const root = $("text-providers");
  if (!root || root.dataset.bound) return;
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tp]");
    if (!btn) return;
    handleTextProviderAction(btn.dataset.tp, btn.dataset.id, btn.dataset.model).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
  root.addEventListener("change", (e) => {
    const box = e.target.closest("[data-tp=toggle]");
    if (box) {
      handleTextProviderAction("toggle", box.dataset.id, box.dataset.model, box.checked).catch((err) => {
        state.textProviderUi.err = err.message || String(err);
        renderTextProviders();
      });
    }
    const draft = e.target.closest("[data-tp-draft=preset]");
    if (draft) {
      const ui = state.textProviderUi;
      const presets = presetsFor("text");
      const preset = presets.find((p) => p.id === draft.value);
      const prevAuth = presets.find((p) => p.id === ui.draftPreset)?.authMode;
      ui.draftPreset = draft.value;
      if (preset) {
        const url = root.querySelector("[data-tp-draft=baseUrl]");
        if (url) url.value = preset.baseUrl || "";
        if (preset.authMode) setDraftAuthMode(root, preset.authMode);
        else if (normalizeAuthMode(prevAuth) === "cookie-proxy") setDraftAuthMode(root, "api-key");
      }
    }
    if (e.target.closest("[data-tp-draft=authMode]")) setDraftAuthMode(root, e.target.value);
    const edit = e.target.closest("[data-tp-edit=authMode]");
    if (edit) {
      const cookie = normalizeAuthMode(edit.value) === "cookie-proxy";
      const card = edit.closest(".provider-edit");
      const box = card?.querySelector("[data-tp-edit-cookie]");
      if (box) box.hidden = !cookie;
    }
  });
  root.addEventListener("input", (e) => {
    const add = e.target.closest("[data-tp-add-model]");
    if (add) state.textProviderUi.addModel[add.getAttribute("data-tp-add-model")] = add.value;
    if (e.target.closest("[data-tp-query]")) {
      state.textProviderUi.query = e.target.value;
      refreshProviderFilter(root);
    }
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const add = e.target.closest("[data-tp-add-model]");
    if (!add) return;
    e.preventDefault();
    handleTextProviderAction("add-model", add.getAttribute("data-tp-add-model")).catch((err) => {
      state.textProviderUi.err = err.message || String(err);
      renderTextProviders();
    });
  });
}

async function scanTextProvider(id) {
  const provider = providerById(id);
  if (!provider) throw new Error("找不到服务商");
  if (!provider.baseUrl.trim()) throw new Error("请填写接口地址");
  const result = await listRemoteModels({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    authMode: provider.authMode,
    cookieUrl: provider.cookieUrl,
  });
  replaceProvider({
    ...provider,
    models: mergeScannedModels(provider.models, result.models),
    scannedAt: new Date().toISOString(),
    scanError: "",
  });
  state.textProviderUi.msg = `已扫描 ${result.models.length} 个模型`;
  state.textProviderUi.err = "";
}

async function handleTextProviderAction(action, id, modelId, enabled) {
  const baseRef = state.settings.textRef ? { ...state.settings.textRef } : null;
  const ui = state.textProviderUi;
  const root = $("text-providers");
  if (action === "toggle-add") {
    ui.adding = !ui.adding;
    ui.err = "";
    ui.draftAuthMode = "";
    ui.draftPreset = "";
    renderTextProviders();
    root.querySelector(ui.adding ? "[data-tp-draft=preset]" : "[data-tp=toggle-add]")?.focus();
    return;
  }
  if (action === "probe-draft-cookie") {
    const cookieUrl = root.querySelector("[data-tp-draft=cookieUrl]")?.value.trim();
    const baseUrl = root.querySelector("[data-tp-draft=baseUrl]")?.value.trim();
    const status = root.querySelector("[data-tp-probe-status=draft]");
    await runCookieProbe(cookieUrl || baseUrl, status, root.querySelector("[data-tp=probe-draft-cookie]"));
    return;
  }
  if (action === "probe-edit-cookie") {
    const sel = (name) => root.querySelector(`[data-tp-edit=${name}][data-id="${CSS.escape(id)}"]`);
    const status = root.querySelector(`[data-tp-probe-status=edit][data-id="${CSS.escape(id)}"]`);
    const cookieUrl = sel("cookieUrl")?.value.trim();
    const baseUrl = sel("baseUrl")?.value.trim() || providerById(id)?.baseUrl;
    await runCookieProbe(cookieUrl || baseUrl, status, root.querySelector(`[data-tp=probe-edit-cookie][data-id="${CSS.escape(id)}"]`));
    return;
  }
  if (action === "add") {
    const preset = root.querySelector("[data-tp-draft=preset]")?.value || "custom";
    const address = root.querySelector("[data-tp-draft=baseUrl]");
    const baseUrl = address.value.trim();
    if (!baseUrl) {
      address.reportValidity();
      return;
    }
    const apiKey = root.querySelector("[data-tp-draft=apiKey]")?.value || "";
    const authMode = normalizeAuthMode(root.querySelector("[data-tp-draft=authMode]")?.value);
    const cookieUrl = authMode === "cookie-proxy"
      ? root.querySelector("[data-tp-draft=cookieUrl]")?.value.trim() || ""
      : "";
    const model = root.querySelector("[data-tp-draft=model]")?.value.trim() || "";
    const name = root.querySelector("[data-tp-draft=name]")?.value.trim() || suggestProviderName(baseUrl, preset);
    const provider = normalizeProvider({
      id: newProviderId(),
      name,
      preset,
      baseUrl,
      apiKey,
      authMode,
      cookieUrl,
      models: model ? [{ id: model, enabled: true }] : [],
    });
    state.settings.textProviders = [...(state.settings.textProviders || []), provider];
    if (model) state.settings.textRef = { providerId: provider.id, modelId: model };
    ui.adding = false;
    ui.draftAuthMode = "";
    ui.draftPreset = "";
    ui.msg = `已新增「${provider.name}」`;
    ui.err = "";
    if (baseUrl) {
      try {
        await scanTextProvider(provider.id);
      } catch (err) {
        const cur = providerById(provider.id);
        if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
        ui.err = err.message || String(err);
      }
    }
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "edit") {
    ui.editingId = ui.editingId === id ? "" : id;
    renderTextProviders();
    const control = ui.editingId ? "[data-tp-edit=baseUrl]" : "[data-tp=edit]";
    [...root.querySelectorAll(control)].find((node) => node.dataset.id === id)?.focus();
    return;
  }
  if (action === "save-edit") {
    const provider = providerById(id);
    if (!provider) return;
    const baseUrl = root.querySelector(`[data-tp-edit=baseUrl][data-id="${CSS.escape(id)}"]`)?.value.trim() || provider.baseUrl;
    const apiKeyRaw = root.querySelector(`[data-tp-edit=apiKey][data-id="${CSS.escape(id)}"]`)?.value || "";
    const authMode = normalizeAuthMode(root.querySelector(`[data-tp-edit=authMode][data-id="${CSS.escape(id)}"]`)?.value ?? provider.authMode);
    const cookieUrl = authMode === "cookie-proxy"
      ? (root.querySelector(`[data-tp-edit=cookieUrl][data-id="${CSS.escape(id)}"]`)?.value.trim() ?? provider.cookieUrl ?? "")
      : "";
    replaceProvider({
      ...provider,
      baseUrl,
      authMode,
      cookieUrl,
      apiKey: apiKeyRaw.trim() ? apiKeyRaw : provider.apiKey,
      name: provider.name || suggestProviderName(baseUrl, provider.preset),
    });
    ui.editingId = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      ui.err = err.message || String(err);
    }
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "delete") {
    state.settings.textProviders = (state.settings.textProviders || []).filter((p) => p.id !== id);
    if (state.settings.textRef?.providerId === id) state.settings.textRef = null;
    ui.msg = "已删除";
    ui.err = "";
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "scan") {
    ui.err = "";
    try {
      await scanTextProvider(id);
    } catch (err) {
      const cur = providerById(id);
      if (cur) replaceProvider({ ...cur, scanError: err.message || String(err) });
      throw err;
    }
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "toggle") {
    const provider = providerById(id);
    if (!provider) return;
    replaceProvider(setProviderModelEnabled(provider, modelId, enabled));
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "select-all" || action === "invert") {
    const provider = providerById(id);
    if (!provider) return;
    const visibleIds = visibleProviderModelIds(provider);
    replaceProvider(action === "select-all"
      ? setAllProviderModelsEnabled(provider, true, visibleIds)
      : invertProviderModelsEnabled(provider, visibleIds));
    ui.msg = action === "select-all" ? "已全选当前列表" : "已反选当前列表";
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "current") {
    state.settings.textRef = { providerId: id, modelId };
    ui.msg = `已设为当前：${modelId}`;
    await persistTextCatalog(baseRef);
    return;
  }
  if (action === "add-model") {
    const provider = providerById(id);
    if (!provider) return;
    const raw = String(ui.addModel[id] || root.querySelector(`[data-tp-add-model="${CSS.escape(id)}"]`)?.value || "").trim();
    if (!raw) throw new Error("请填写模型 ID");
    replaceProvider(addProviderModel(provider, raw));
    ui.addModel[id] = "";
    ui.msg = `已加入 ${raw}`;
    if (!state.settings.textRef) state.settings.textRef = { providerId: id, modelId: raw };
    await persistTextCatalog(baseRef);
  }
}


export {
  fieldBlock,
  runCookieProbe,
  apiKeyLabel,
  escapeAttr,
  syncTextCatalog,
  persistTextCatalog,
  providerById,
  replaceProvider,
  visibleProviderModelIds,
  renderTextProviders,
  bindTextProvidersOnce,
  scanTextProvider,
  handleTextProviderAction,
};
