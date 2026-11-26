import assert from "node:assert/strict";
import {
  activeCookieProxyRuleIds,
  extractCookiesForModel,
  fetchWithCookieProxy,
  formatCookieHeader,
  isCookieProxyModel,
  isValidHttpUrl,
  normalizeAuthMode,
  probeCookiesForUrl,
  resolveCookieSourceUrl,
} from "../lib/cookie-proxy.js";
import { resetPermissionPrompter, setPermissionPrompter } from "../lib/optional-permissions.js";

assert.equal(normalizeAuthMode("cookie-proxy"), "cookie-proxy");
assert.equal(normalizeAuthMode("Cookie-Proxy"), "api-key");
assert.equal(normalizeAuthMode(""), "api-key");
assert.equal(normalizeAuthMode(undefined), "api-key");
assert.equal(isCookieProxyModel({ authMode: "cookie-proxy" }), true);
assert.equal(isCookieProxyModel({ authMode: "api-key" }), false);
assert.equal(isCookieProxyModel(null), false);

assert.equal(isValidHttpUrl("https://tango.example.com/a"), true);
assert.equal(isValidHttpUrl("http://127.0.0.1:8811/api"), true);
assert.equal(isValidHttpUrl(""), false);
assert.equal(isValidHttpUrl("file:///tmp/a"), false);
assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
assert.equal(isValidHttpUrl("https://user:pass@tango.example.com/a"), false);

assert.equal(
  resolveCookieSourceUrl({ cookieUrl: " https://tango.example.com/session ", baseUrl: "http://127.0.0.1:8811/v1" }),
  "https://tango.example.com/session",
);
assert.equal(
  resolveCookieSourceUrl({ cookieUrl: "  ", baseUrl: " http://127.0.0.1:8811/api/model-proxy/v1 " }),
  "http://127.0.0.1:8811/api/model-proxy/v1",
);
for (const cookieUrl of ["file:///tmp/a", "javascript:alert(1)", "https://user:pass@tango.example.com/a"]) {
  assert.throws(() => resolveCookieSourceUrl({ cookieUrl, baseUrl: "https://ok.example/v1" }), /http\(s\)/);
}

assert.equal(formatCookieHeader([
  { name: "short", value: "1", path: "/" },
  { name: "long", value: "2", path: "/app/session" },
  { name: "short", value: "later-loses", path: "/app" },
  { name: "", value: "drop" },
  { name: "bad;name", value: "drop" },
  { name: "ctrl\nname", value: "drop" },
  { name: "injected", value: "a\r\nSet-Cookie: evil" },
  { name: "plain", value: "ok", path: "/z" },
]), "long=2; short=later-loses; plain=ok");

const COOKIE_URL = "https://tango.example.com";
const TARGET_URL = "http://127.0.0.1:8811/api/model-proxy/v1/chat/completions";
const SECRET = "super-secret-cookie-value";

function permissionApi({ cookiesGranted = true, hostGranted = true } = {}) {
  return {
    async contains(query) {
      if (query.permissions) return cookiesGranted;
      if (query.origins) return hostGranted;
      return false;
    },
    async request() {
      return false;
    },
  };
}

function chromeFor({ rows = [], dnr, cookiesGranted = true, hostGranted = true } = {}) {
  const getAllCalls = [];
  const chromeApi = {
    permissions: permissionApi({ cookiesGranted, hostGranted }),
    cookies: {
      async getAll(query) {
        getAllCalls.push(query);
        return rows;
      },
    },
  };
  if (dnr) chromeApi.declarativeNetRequest = dnr;
  return { chromeApi, getAllCalls, permissionsApi: chromeApi.permissions };
}

function sessionRows() {
  return [
    { name: "sid", value: SECRET, path: "/" },
    { name: "sid", value: "shorter-path-loses", path: "" },
    { name: "theme", value: "dark", path: "/app" },
  ];
}

function createDnr() {
  const rules = new Map();
  const calls = [];
  return {
    rules,
    calls,
    async updateSessionRules({ addRules = [], removeRuleIds = [] } = {}) {
      calls.push({ addRules, removeRuleIds: [...removeRuleIds] });
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    },
  };
}

function cookieRules(rules) {
  return [...rules.values()].filter((rule) =>
    (rule.action?.requestHeaders || []).some((header) => String(header.header).toLowerCase() === "cookie"));
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

setPermissionPrompter(() => false);

{
  const env = chromeFor({ cookiesGranted: false, rows: sessionRows() });
  await assert.rejects(
    () => extractCookiesForModel({ authMode: "cookie-proxy", cookieUrl: COOKIE_URL }, env),
    /未授予权限/,
  );
  assert.equal(env.getAllCalls.length, 0, "denied cookies permission does not read cookies");
  const probed = await probeCookiesForUrl(COOKIE_URL, env);
  assert.equal(probed.ok, false);
  assert.match(probed.error, /未授予权限/);
  assert.equal(env.getAllCalls.length, 0);
  assert.equal(Object.hasOwn(probed, "cookieHeader"), false);
}

{
  const env = chromeFor({ hostGranted: false, rows: sessionRows() });
  await assert.rejects(
    () => extractCookiesForModel({ authMode: "cookie-proxy", cookieUrl: COOKIE_URL }, env),
    /未授予权限/,
  );
  assert.equal(env.getAllCalls.length, 0, "denied host permission does not read cookies");
  const probed = await probeCookiesForUrl(COOKIE_URL, env);
  assert.equal(probed.ok, false);
  assert.match(probed.error, /未授予权限/);
  assert.equal(env.getAllCalls.length, 0);
}

{
  const env = chromeFor({ rows: [] });
  await assert.rejects(
    () => extractCookiesForModel({ authMode: "cookie-proxy", cookieUrl: COOKIE_URL }, env),
    /登录/,
  );
  assert.deepEqual(env.getAllCalls, [{ url: COOKIE_URL }]);
  const probed = await probeCookiesForUrl(COOKIE_URL, env);
  assert.equal(probed.ok, false);
  assert.match(probed.error, /未能从 https:\/\/tango\.example\.com 提取到任何 Cookie/);
  assert.match(probed.error, /登录/);
  assert.equal(Object.hasOwn(probed, "cookieHeader"), false);
}

{
  const env = chromeFor({ rows: sessionRows() });
  const extracted = await extractCookiesForModel(
    { authMode: "cookie-proxy", cookieUrl: COOKIE_URL, baseUrl: "http://127.0.0.1:8811/v1" },
    env,
  );
  assert.deepEqual(env.getAllCalls, [{ url: COOKIE_URL }]);
  assert.equal(extracted.cookieHeader, "theme=dark; sid=super-secret-cookie-value");
  assert.equal(extracted.cookieCount, 2);
  assert.deepEqual(extracted.cookieNames, ["theme", "sid"]);
  const probed = await probeCookiesForUrl(COOKIE_URL, env);
  assert.equal(probed.ok, true);
  assert.equal(probed.cookieCount, 2);
  assert.deepEqual(probed.cookieNames, ["theme", "sid"]);
  assert.equal(Object.hasOwn(probed, "cookieHeader"), false);
  assert.equal(JSON.stringify(probed).includes(SECRET), false, "probe never returns raw cookie values");
}

{
  const dnr = createDnr();
  const env = chromeFor({ rows: sessionRows(), dnr });
  const model = { authMode: "cookie-proxy", cookieUrl: COOKIE_URL, apiKey: "" };
  const original = new Headers({ Authorization: "Bearer local", "X-Title": "PageLens" });
  let seen = null;
  const response = await fetchWithCookieProxy(model, TARGET_URL, { method: "POST", headers: original }, {
    ...env,
    fetchImpl: async (_url, init) => {
      seen = init;
      assert.equal(cookieRules(dnr.rules).length, 1, "session rule is installed before fetch");
      return new Response("ok");
    },
  });
  assert.equal(await response.text(), "ok");
  assert.equal(original.get("Authorization"), "Bearer local", "caller headers stay intact");
  assert.equal(headerValue(seen.headers, "Authorization"), undefined);
  assert.equal(headerValue(seen.headers, "X-Forwarded-Cookie"), "theme=dark; sid=super-secret-cookie-value");
  assert.equal(headerValue(seen.headers, "X-Title"), "PageLens");
  const rule = cookieRules(dnr.rules)[0];
  assert.equal(rule, undefined, "rule is removed after fetch");
  const added = dnr.calls.find((call) => call.addRules.length)?.addRules[0];
  assert.ok(added.id >= 940000 && added.id < 950000);
  assert.equal(added.priority, 1);
  assert.equal(added.action.type, "modifyHeaders");
  assert.deepEqual(added.action.requestHeaders, [{
    header: "Cookie",
    operation: "set",
    value: "theme=dark; sid=super-secret-cookie-value",
  }]);
  assert.equal(added.condition.urlFilter, TARGET_URL);
  assert.deepEqual(added.condition.resourceTypes, ["xmlhttprequest", "other"]);
  assert.deepEqual(dnr.calls.at(-1).removeRuleIds, [added.id]);
  assert.deepEqual(activeCookieProxyRuleIds(), []);

  seen = null;
  await fetchWithCookieProxy(
    { ...model, apiKey: "sk-explicit" },
    TARGET_URL,
    { headers: { Authorization: "Bearer sk-explicit" } },
    {
      ...env,
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response("ok");
      },
    },
  );
  assert.equal(headerValue(seen.headers, "Authorization"), "Bearer sk-explicit");
  assert.deepEqual(activeCookieProxyRuleIds(), []);
}

{
  const dnr = createDnr();
  const env = chromeFor({ rows: sessionRows(), dnr });
  const model = { authMode: "cookie-proxy", cookieUrl: COOKIE_URL };
  await assert.rejects(
    () => fetchWithCookieProxy(model, TARGET_URL, {}, {
      ...env,
      fetchImpl: async () => {
        assert.equal(cookieRules(dnr.rules).length, 1);
        throw new Error("upstream failed");
      },
    }),
    /upstream failed/,
  );
  assert.equal(cookieRules(dnr.rules).length, 0, "failed fetch still removes the session rule");
  assert.deepEqual(activeCookieProxyRuleIds(), []);
}

{
  const dnr = createDnr();
  const env = chromeFor({ rows: [{ name: "sid", value: "secret", path: "/" }], dnr });
  const model = { authMode: "cookie-proxy", cookieUrl: COOKIE_URL };
  let entered = 0;
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const fetchImpl = async () => {
    const turn = ++entered;
    if (turn === 1) await firstGate;
    else await secondGate;
    return new Response(String(turn));
  };
  const deps = { ...env, fetchImpl };
  const first = fetchWithCookieProxy(model, TARGET_URL, {}, deps);
  const second = fetchWithCookieProxy(model, TARGET_URL, {}, deps);
  for (let i = 0; i < 20 && entered < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(entered, 2, "both requests reached fetch");
  assert.equal(cookieRules(dnr.rules).length, 1, "concurrent identical forwards share one rule");
  releaseFirst();
  assert.equal(await (await first).text(), "1");
  assert.equal(cookieRules(dnr.rules).length, 1, "the in-flight request still holds the rule");
  releaseSecond();
  assert.equal(await (await second).text(), "2");
  assert.equal(cookieRules(dnr.rules).length, 0);
  assert.deepEqual(activeCookieProxyRuleIds(), []);
}

{
  const dnr = createDnr();
  const env = chromeFor({ rows: sessionRows(), dnr });
  const target = "https://tango.example.com/api/chat/completions";
  let seen = null;
  await fetchWithCookieProxy(
    { authMode: "cookie-proxy", cookieUrl: COOKIE_URL },
    target,
    {},
    {
      ...env,
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response("same");
      },
    },
  );
  assert.equal(seen.credentials, "include");
  assert.equal(headerValue(seen.headers, "X-Forwarded-Cookie"), undefined);
  assert.deepEqual(activeCookieProxyRuleIds(), []);
}

{
  const env = chromeFor({ rows: sessionRows() });
  let seen = null;
  await fetchWithCookieProxy(
    { authMode: "cookie-proxy", cookieUrl: COOKIE_URL },
    TARGET_URL,
    { headers: { Authorization: "Bearer local" } },
    {
      ...env,
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response("fallback");
      },
    },
  );
  assert.equal(env.chromeApi.declarativeNetRequest, undefined);
  assert.equal(headerValue(seen.headers, "X-Forwarded-Cookie"), "theme=dark; sid=super-secret-cookie-value");
  assert.equal(headerValue(seen.headers, "Authorization"), undefined);
  assert.deepEqual(activeCookieProxyRuleIds(), []);
}

resetPermissionPrompter();
assert.deepEqual(activeCookieProxyRuleIds(), []);
console.log("PASS cookie-proxy");
