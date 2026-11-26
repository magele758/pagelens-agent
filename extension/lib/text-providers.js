import { isCookieProxyModel, normalizeAuthMode } from "./cookie-proxy.js";

export function newProviderId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function suggestProviderName(baseUrl, preset) {
  if (String(preset || "").trim() === "ai-agent-node") return "ai-agent-node";
  const raw = String(baseUrl || "").trim();
  if (raw) {
    try {
      const href = raw.includes("://") ? raw : `https://${raw}`;
      const host = new URL(href).hostname.replace(/^api\./i, "").replace(/^www\./i, "");
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "::1" ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      ) {
        return "本地服务";
      }
      const label = host.split(".")[0]?.trim() || "";
      if (label) return label.charAt(0).toUpperCase() + label.slice(1);
    } catch {
      /* fallthrough */
    }
  }
  const p = String(preset || "").trim();
  if (p && p !== "custom") return p;
  return "OpenAI 兼容";
}

export function parseModelRef(raw) {
  if (!raw || typeof raw !== "object") return null;
  const providerId = String(raw.providerId || "").trim();
  const modelId = String(raw.modelId || "").trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function modelsUrl(baseUrl) {
  const raw = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("缺少 base_url");
  if (/\/models$/i.test(raw)) return raw;
  return `${raw}/models`;
}

export function parseRemoteModelList(payload) {
  if (!payload || typeof payload !== "object") return [];
  const rec = payload;
  const buckets = [];
  if (Array.isArray(rec.data)) buckets.push(...rec.data);
  else if (Array.isArray(rec.models)) buckets.push(...rec.models);
  else if (Array.isArray(payload)) buckets.push(...payload);
  const seen = new Set();
  const out = [];
  for (const item of buckets) {
    if (typeof item === "string") {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = String(item.owned_by || item.display_name || item.ownedBy || "").trim();
    out.push(ownedBy ? { id, ownedBy } : { id });
  }
  return out;
}

export function normalizeCatalogModel(raw) {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, enabled: true } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  if (!id) return null;
  const ownedBy = String(raw.ownedBy || "").trim();
  return {
    id,
    enabled: raw.enabled !== false,
    ...(ownedBy ? { ownedBy } : {}),
  };
}

export function normalizeProvider(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim() || newProviderId();
  const baseUrl = String(raw.baseUrl || "").trim();
  const preset = String(raw.preset || "custom").trim() || "custom";
  const models = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const model = normalizeCatalogModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return {
    id,
    name: String(raw.name || "").trim() || suggestProviderName(baseUrl, preset),
    preset,
    baseUrl,
    apiKey: String(raw.apiKey || ""),
    authMode: normalizeAuthMode(raw.authMode),
    cookieUrl: String(raw.cookieUrl || "").trim(),
    models,
    scannedAt: String(raw.scannedAt || ""),
    scanError: String(raw.scanError || ""),
  };
}

export function mergeScannedModels(existing, scanned) {
  const byId = new Map((existing || []).map((m) => [m.id, m]));
  const out = [];
  const seen = new Set();
  for (const item of scanned || []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const prev = byId.get(id);
    const ownedBy = String(item.ownedBy || prev?.ownedBy || "").trim();
    out.push({
      id,
      enabled: prev ? prev.enabled : true,
      ...(ownedBy ? { ownedBy } : {}),
    });
  }
  for (const prev of existing || []) {
    if (seen.has(prev.id)) continue;
    seen.add(prev.id);
    out.push(prev);
  }
  return out;
}

export function providerFromLegacyText(text) {
  const model = String(text?.model || "").trim();
  return normalizeProvider({
    id: newProviderId(),
    name: suggestProviderName(text?.baseUrl, text?.preset),
    preset: text?.preset || "custom",
    baseUrl: text?.baseUrl || "",
    apiKey: text?.apiKey || "",
    authMode: text?.authMode,
    cookieUrl: text?.cookieUrl,
    models: model ? [{ id: model, enabled: true }] : [],
  });
}

export function enabledModelOptions(providers) {
  const out = [];
  for (const provider of providers || []) {
    for (const model of provider.models || []) {
      if (!model.enabled) continue;
      out.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
      });
    }
  }
  return out;
}

export function pickDefaultRef(providers, preferred) {
  const parsed = parseModelRef(preferred);
  if (parsed && providers.some((p) => p.id === parsed.providerId && p.models.some((m) => m.id === parsed.modelId && m.enabled))) {
    return parsed;
  }
  const first = enabledModelOptions(providers)[0];
  return first ? { providerId: first.providerId, modelId: first.modelId } : null;
}

export function textSlotFromRef(providers, ref, prevText = {}) {
  const provider = (providers || []).find((p) => p.id === ref?.providerId);
  const out = {
    ...prevText,
    preset: provider?.preset || prevText.preset || "custom",
    baseUrl: provider?.baseUrl || "",
    apiKey: provider ? provider.apiKey : "",
    model: ref?.modelId || "",
  };
  // Drop leftover cookie fields when the selected provider is a normal API-key slot.
  if (provider && isCookieProxyModel(provider)) {
    out.authMode = "cookie-proxy";
    out.cookieUrl = String(provider.cookieUrl || "").trim();
  } else {
    delete out.authMode;
    delete out.cookieUrl;
  }
  return out;
}

export function hydrateTextCatalog(raw, text = {}) {
  let providers = (Array.isArray(raw?.textProviders) ? raw.textProviders : [])
    .map(normalizeProvider)
    .filter(Boolean);
  if (!providers.length && (text.baseUrl || text.model || text.apiKey)) {
    providers = [providerFromLegacyText(text)];
  }
  const textRef = pickDefaultRef(providers, raw?.textRef);
  return {
    textProviders: providers,
    textRef,
    text: textSlotFromRef(providers, textRef, text),
  };
}

export function setProviderModelEnabled(provider, modelId, enabled) {
  const id = String(modelId || "").trim();
  if (!id) return provider;
  const models = (provider.models || []).map((m) => (m.id === id ? { ...m, enabled: Boolean(enabled) } : m));
  return { ...provider, models };
}

export function setAllProviderModelsEnabled(provider, enabled, onlyIds) {
  const allow = Array.isArray(onlyIds) && onlyIds.length ? new Set(onlyIds) : null;
  const models = (provider.models || []).map((m) => (
    !allow || allow.has(m.id) ? { ...m, enabled: Boolean(enabled) } : m
  ));
  return { ...provider, models };
}

export function invertProviderModelsEnabled(provider, onlyIds) {
  const allow = Array.isArray(onlyIds) && onlyIds.length ? new Set(onlyIds) : null;
  const models = (provider.models || []).map((m) => (
    !allow || allow.has(m.id) ? { ...m, enabled: !m.enabled } : m
  ));
  return { ...provider, models };
}

export function addProviderModel(provider, modelId) {
  const id = String(modelId || "").trim();
  if (!id) return provider;
  const models = [...(provider.models || [])];
  const idx = models.findIndex((m) => m.id === id);
  if (idx >= 0) models[idx] = { ...models[idx], enabled: true };
  else models.push({ id, enabled: true });
  return { ...provider, models };
}
