import { requireHostUrl, requireOptionalFeature } from "./optional-permissions.js";

export const AUTH_MODES = Object.freeze(["api-key", "cookie-proxy"]);
export const COOKIE_PROXY_HEADER = "X-Forwarded-Cookie";

// Session rules are shared by every extension context, so ids may collide across contexts.
const RULE_ID_BASE = 940000;
const RULE_ID_RANGE = 10000;
const RULE_INSTALL_ATTEMPTS = 8;
const STRIPPED_HEADERS = new Set(["cookie", COOKIE_PROXY_HEADER.toLowerCase()]);

const dnrRules = new Map();
const reservedRuleIds = new Set();
let ruleCursor = 0;

export function normalizeAuthMode(raw) {
  return raw === "cookie-proxy" ? "cookie-proxy" : "api-key";
}

export function isCookieProxyModel(model) {
  return normalizeAuthMode(model?.authMode) === "cookie-proxy";
}

export function isValidHttpUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return false;
  try {
    const url = new URL(s);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (url.username || url.password) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveCookieSourceUrl(model) {
  const raw = String(model?.cookieUrl || "").trim() || String(model?.baseUrl || "").trim();
  if (!isValidHttpUrl(raw)) {
    throw new Error("Cookie 提取地址无效，请填写合法的 http(s) 地址。");
  }
  return raw;
}

function cookiePairs(cookies) {
  const ordered = (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => typeof cookie?.name === "string" && cookie.name && !/[\u0000-\u001f\u007f;]/.test(cookie.name))
    .sort((a, b) => (b.path?.length || 0) - (a.path?.length || 0));
  const pairs = new Map();
  for (const { name, value } of ordered) {
    const text = String(value ?? "");
    if (!pairs.has(name) && !/[\r\n]/.test(text)) pairs.set(name, text);
  }
  return pairs;
}

export function formatCookieHeader(cookies) {
  return Array.from(cookiePairs(cookies), ([name, value]) => `${name}=${value}`).join("; ");
}

export async function extractCookiesForModel(model, deps = {}) {
  const sourceUrl = resolveCookieSourceUrl(model);
  const permissionDeps = { ...deps, permissionsApi: deps.permissionsApi || deps.chromeApi?.permissions };
  const featureDenied = await requireOptionalFeature("cookies", permissionDeps);
  if (featureDenied) throw new Error(featureDenied);
  const hostDenied = await requireHostUrl(sourceUrl, permissionDeps);
  if (hostDenied) throw new Error(hostDenied);

  const cookies = (deps.chromeApi || globalThis.chrome)?.cookies;
  if (typeof cookies?.getAll !== "function") {
    throw new Error("当前环境没有 chrome.cookies。授权后若仍不可用，请重新加载扩展再试。");
  }
  let rows;
  try {
    rows = await cookies.getAll({ url: sourceUrl });
  } catch {
    throw new Error("读取浏览器 Cookie 失败。");
  }
  const pairs = cookiePairs(rows);
  if (!pairs.size) {
    throw new Error(`未能从 ${new URL(sourceUrl).origin} 提取到任何 Cookie，请先在浏览器中登录目标站点后再试。`);
  }
  return {
    cookieHeader: formatCookieHeader(rows),
    cookieCount: pairs.size,
    sourceUrl,
    cookieNames: [...pairs.keys()],
  };
}

export async function probeCookiesForUrl(url, deps = {}) {
  try {
    const { sourceUrl, cookieCount, cookieNames } = await extractCookiesForModel(
      { authMode: "cookie-proxy", cookieUrl: url, baseUrl: url },
      deps,
    );
    return { ok: true, sourceUrl, cookieCount, cookieNames };
  } catch (err) {
    return { ok: false, sourceUrl: String(url || "").trim(), cookieCount: 0, cookieNames: [], error: err.message };
  }
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function" && !Array.isArray(headers)) return [...headers.entries()];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  return Object.entries(headers);
}

function proxyHeaders(model, headers) {
  const keepAuth = Boolean(String(model?.apiKey || "").trim());
  const out = {};
  for (const [name, value] of headerEntries(headers)) {
    const lower = String(name).toLowerCase();
    if (STRIPPED_HEADERS.has(lower)) continue;
    if (lower === "authorization" && !keepAuth) continue;
    out[name] = value;
  }
  return out;
}

function takeRuleId() {
  for (let i = 0; i < RULE_ID_RANGE; i += 1) {
    const offset = (ruleCursor + i) % RULE_ID_RANGE;
    const id = RULE_ID_BASE + offset;
    if (reservedRuleIds.has(id)) continue;
    ruleCursor = (offset + 1) % RULE_ID_RANGE;
    reservedRuleIds.add(id);
    return id;
  }
  throw new Error("Cookie 代理规则已用尽，请稍后再试。");
}

async function installRule(dnr, entry, targetUrl, cookieHeader) {
  for (let attempt = 1; ; attempt += 1) {
    const id = takeRuleId();
    try {
      await dnr.updateSessionRules({
        addRules: [{
          id,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [{ header: "Cookie", operation: "set", value: cookieHeader }] },
          condition: { urlFilter: targetUrl, resourceTypes: ["xmlhttprequest", "other"] },
        }],
      });
      entry.id = id;
      return;
    } catch (err) {
      reservedRuleIds.delete(id);
      if (attempt >= RULE_INSTALL_ATTEMPTS || !/unique|\bid\b/i.test(String(err?.message || ""))) throw err;
    }
  }
}

async function releaseRule(dnr, key, entry) {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  if (dnrRules.get(key) === entry) dnrRules.delete(key);
  try {
    await dnr.updateSessionRules({ removeRuleIds: [entry.id] });
  } catch {
    // The session rule also disappears when the browser session ends.
  } finally {
    reservedRuleIds.delete(entry.id);
  }
}

async function acquireRule(dnr, targetUrl, cookieHeader) {
  const key = JSON.stringify([targetUrl, cookieHeader]);
  let entry = dnrRules.get(key);
  if (!entry) {
    entry = { id: 0, refs: 0, ready: null };
    entry.ready = installRule(dnr, entry, targetUrl, cookieHeader);
    dnrRules.set(key, entry);
  }
  entry.refs += 1;
  try {
    await entry.ready;
  } catch (err) {
    entry.refs -= 1;
    if (dnrRules.get(key) === entry) dnrRules.delete(key);
    throw err;
  }
  return () => releaseRule(dnr, key, entry);
}

/** Rule ids currently held by this context; empty once every proxied fetch has settled. */
export function activeCookieProxyRuleIds() {
  return [...reservedRuleIds].sort((a, b) => a - b);
}

/**
 * `init` may be a function so callers can start timeouts after permission prompts finish.
 */
export async function fetchWithCookieProxy(model, targetUrl, init = {}, deps = {}) {
  if (!isValidHttpUrl(targetUrl)) {
    throw new Error("模型请求地址无效，请填写合法的 http(s) 地址。");
  }
  const { cookieHeader, sourceUrl } = await extractCookiesForModel(model, deps);
  const options = (typeof init === "function" ? init() : init) || {};
  const headers = proxyHeaders(model, options.headers);
  const sameOrigin = new URL(sourceUrl).origin === new URL(targetUrl).origin;
  const fetchInit = { ...options, headers, redirect: "error" };
  if (sameOrigin) fetchInit.credentials = "include";

  const dnr = (deps.chromeApi || globalThis.chrome)?.declarativeNetRequest;
  let release = null;
  if (typeof dnr?.updateSessionRules === "function") {
    try {
      release = await acquireRule(dnr, targetUrl, cookieHeader);
    } catch {
      release = null;
    }
  }
  if (!sameOrigin || !release) headers[COOKIE_PROXY_HEADER] = cookieHeader;

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  try {
    return await fetchImpl(targetUrl, fetchInit);
  } finally {
    if (release) await release();
  }
}
