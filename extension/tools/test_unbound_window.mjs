import "./fixtures/web-locks.mjs";
import assert from "node:assert/strict";
import { chromeCall } from "../lib/chrome.js";
import { createAgentTools } from "../lib/agent/tools.js";

const tabs = [
  { id: 1, windowId: 10, active: true, title: "Alpha", url: "https://a.example/post", groupId: 7 },
  { id: 2, windowId: 20, active: true, title: "Beta", url: "https://b.example/other", groupId: 7 },
];

const calls = [];
const permissionRequests = [];
const cookieJar = [
  { name: "sid", value: "tok-1", domain: "a.example", path: "/", url: "https://a.example/post", secure: true, httpOnly: true },
];
let currentWindowInfo = { id: 99, type: "normal", incognito: false };
let nextCreatedWindowId = 30;
let historyQueries = [];

globalThis.chrome = {
  permissions: {
    contains: async () => true,
    request: async (q) => {
      permissionRequests.push(q);
      return true;
    },
  },
  tabs: {
    async query(query) {
      calls.push(["tabs.query", query]);
      return tabs.filter(
        (t) => (query.windowId == null || t.windowId === query.windowId) && (query.groupId == null || t.groupId === query.groupId),
      );
    },
    async get(id) {
      calls.push(["tabs.get", id]);
      const tab = tabs.find((t) => t.id === id);
      if (!tab) throw new Error(`No tab ${id}`);
      return tab;
    },
    async create(props) {
      calls.push(["tabs.create", props]);
      const tab = { id: tabs.length + 1, active: false, title: "New", groupId: -1, ...props };
      tabs.push(tab);
      return tab;
    },
    async update(id, props) {
      calls.push(["tabs.update", id, props]);
      return Object.assign(await this.get(id), props);
    },
    async move(ids, props) {
      calls.push(["tabs.move", ids, props]);
      return [];
    },
    async remove(ids) {
      calls.push(["tabs.remove", ids]);
    },
    async ungroup(ids) {
      calls.push(["tabs.ungroup", ids]);
    },
    async group(props) {
      calls.push(["tabs.group", props]);
      return 7;
    },
  },
  tabGroups: {
    async query(query) {
      calls.push(["tabGroups.query", query]);
      return [];
    },
    async get(id) {
      calls.push(["tabGroups.get", id]);
      return { id, windowId: 10, title: "PL", color: "orange" };
    },
    async update(id, props) {
      calls.push(["tabGroups.update", id, props]);
      return { id, ...props };
    },
    async move(id, props) {
      calls.push(["tabGroups.move", id, props]);
      return { id, ...props };
    },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    WINDOW_ID_CURRENT: -2,
    async get(id) {
      calls.push(["windows.get", id]);
      return { id, type: "normal", incognito: false };
    },
    async getCurrent() {
      calls.push(["windows.getCurrent"]);
      return currentWindowInfo;
    },
    async getLastFocused() {
      calls.push(["windows.getLastFocused"]);
      return currentWindowInfo;
    },
    async getAll() {
      calls.push(["windows.getAll"]);
      return [currentWindowInfo];
    },
    async create(props) {
      calls.push(["windows.create", props]);
      const id = nextCreatedWindowId++;
      return { id, ...props };
    },
    async update(id, props) {
      calls.push(["windows.update", id, props]);
      return { id, ...props };
    },
    async remove(id) {
      calls.push(["windows.remove", id]);
    },
  },
  webNavigation: {
    async getFrame(details) {
      calls.push(["webNavigation.getFrame", details]);
      return { frameId: 0, url: "https://a.example/post" };
    },
    async getAllFrames(details) {
      calls.push(["webNavigation.getAllFrames", details]);
      return [{ frameId: 0, url: "https://a.example/post" }];
    },
  },
  bookmarks: {
    async search(query) {
      calls.push(["bookmarks.search", query]);
      return [{ id: "b1", title: "MDN", url: "https://developer.mozilla.org/", parentId: "1" }];
    },
    async get(id) {
      calls.push(["bookmarks.get", id]);
      return [{ id: String(id), title: "书签栏" }];
    },
    async getTree() {
      calls.push(["bookmarks.getTree"]);
      return [{ id: "0", children: [{ id: "1", title: "书签栏" }] }];
    },
    async create(node) {
      calls.push(["bookmarks.create", node]);
      return { id: "bm-1", parentId: node.parentId || "1", ...node };
    },
  },
  history: {
    async search(query) {
      historyQueries.push(query);
      calls.push(["history.search", query]);
      return [{ title: "Alpha", url: "https://a.example/post", visitCount: 2, lastVisitTime: Date.now() }];
    },
    async getVisits(details) {
      calls.push(["history.getVisits", details]);
      return [{ id: "v1", visitTime: Date.now() }];
    },
  },
  cookies: {
    async getAll(details) {
      calls.push(["cookies.getAll", details]);
      return cookieJar.filter((c) => (!details.url || c.url === details.url) && (!details.name || c.name === details.name));
    },
    async set(details) {
      calls.push(["cookies.set", details]);
      const entry = { domain: new URL(details.url).hostname, path: "/", ...details };
      const idx = cookieJar.findIndex((c) => c.url === entry.url && c.name === entry.name);
      if (idx >= 0) cookieJar[idx] = entry;
      else cookieJar.push(entry);
      return entry;
    },
    async remove(details) {
      calls.push(["cookies.remove", details]);
      const idx = cookieJar.findIndex((c) => c.url === details.url && c.name === details.name);
      if (idx >= 0) cookieJar.splice(idx, 1);
      return details;
    },
  },
  runtime: {
    getURL: (p) => `chrome-extension://ext/${p}`,
    getPlatformInfo: async () => ({ os: "mac", arch: "arm" }),
  },
};

// 1. 无 windowId（或无效 windowId）的窗口类 chromeCall 全部被拒绝，且不触达底层 Chrome API 或权限请求
const windowScopedCalls = [
  ["tabs.query", [{ currentWindow: true }]],
  ["tabs.query", [{}]],
  ["tabs.query", [{ windowId: 10 }]],
  ["tabs.create", [{ url: "https://a.example/new" }]],
  ["tabs.create", [{ url: "https://a.example/new", windowId: 10 }]],
  ["tabs.get", [1]],
  ["tabs.update", [1, { active: true }]],
  ["tabs.move", [1, { index: 0 }]],
  ["tabs.remove", [1]],
  ["tabs.group", [{ tabIds: [1] }]],
  ["tabGroups.query", [{}]],
  ["tabGroups.get", [7]],
  ["tabGroups.update", [7, { title: "X" }]],
  ["tabGroups.move", [7, { index: 0 }]],
  ["windows.get", [10]],
  ["windows.getCurrent", []],
  ["windows.getLastFocused", []],
  ["windows.getAll", []],
  ["windows.create", [{ url: "https://a.example/" }]],
  ["windows.update", [10, { focused: true }]],
  ["windows.remove", [10]],
  ["webNavigation.getFrame", [{ tabId: 1, frameId: 0 }]],
  ["webNavigation.getAllFrames", [{ tabId: 1 }]],
];

for (const badWindowId of [undefined, null, -1, -2, "10"]) {
  for (const [method, args] of windowScopedCalls) {
    const res = await chromeCall(method, args, badWindowId, 1);
    assert.equal(res.ok, false, `${method} with windowId=${String(badWindowId)} must be rejected`);
    assert.match(res.error, /窗口/, `${method} error mentions window binding: ${res.error}`);
  }
}
assert.equal(calls.length, 0, "rejected unbound chromeCall makes zero Chrome API calls");
assert.equal(permissionRequests.length, 0, "rejected unbound chromeCall makes zero permission requests");

// 2. 显式绑定有效 windowId 时，窗口类 chromeCall 正常执行并锁定到该窗口
const boundQuery = await chromeCall("tabs.query", [{ currentWindow: true }], 10);
assert.equal(boundQuery.ok, true, "explicit windowId allows scoped tabs.query");
assert.deepEqual(
  boundQuery.result.map((t) => t.id),
  [1],
);
assert.deepEqual(calls.at(-1), ["tabs.query", { windowId: 10 }]);
const crossWindowQuery = await chromeCall("tabs.query", [{ windowId: 20 }], 10);
assert.equal(crossWindowQuery.ok, false, "bound windowId still blocks cross-window access");

// 3. tools.js 中窗口类工具在无 windowId（null / omitted / WINDOW_ID_CURRENT）时全部拒绝且零副作用
calls.length = 0;
for (const [label, makeCtx] of [
  ["getWindowId: () => null", () => ({ getWindowId: () => null, getTabId: () => 1, getTaskGroupId: () => 7, settings: { cdpInput: false } })],
  ["omitted getWindowId", () => ({ getTabId: () => 1, getTaskGroupId: () => 7, settings: { cdpInput: false } })],
  ["getWindowId: () => -2", () => ({ getWindowId: () => -2, getTabId: () => 1, getTaskGroupId: () => 7, settings: { cdpInput: false } })],
]) {
  let clearedGroup = false;
  const ctx = {
    ...makeCtx(),
    setTaskGroupId: () => {
      clearedGroup = true;
    },
  };
  const tools = createAgentTools(ctx);
  const run = (name, args = {}) => tools.find((t) => t.name === name).execute(args);

  await assert.rejects(run("list_tabs", {}), /窗口/, `${label}: list_tabs default`);
  await assert.rejects(run("list_tabs", { currentWindow: false }), /窗口/, `${label}: list_tabs all windows`);
  await assert.rejects(run("open_tab", { url: "https://a.example/new" }), /窗口/, `${label}: open_tab`);
  await assert.rejects(run("open_tab", { url: "https://a.example/new", active: true }), /窗口/, `${label}: open_tab active`);
  await assert.rejects(run("extract_pages", {}), /窗口/, `${label}: extract_pages default`);
  await assert.rejects(run("extract_pages", { currentWindow: false }), /窗口/, `${label}: extract_pages all windows`);
  await assert.rejects(run("extract_pages", { query: "Alpha" }), /窗口/, `${label}: extract_pages query`);
  await assert.rejects(run("extract_pages", { tabIds: [2] }), /窗口/, `${label}: extract_pages explicit tabIds`);
  await assert.rejects(run("close_task_group", {}), /窗口/, `${label}: close_task_group`);
  await assert.rejects(run("bookmark_open_tabs", { title: "未绑定书签" }), /窗口/, `${label}: bookmark_open_tabs`);
  await assert.rejects(
    run("bookmark_open_tabs", { title: "未绑定书签", currentWindow: false }),
    /窗口/,
    `${label}: bookmark_open_tabs all windows`,
  );

  for (const [method, args] of [
    ["tabs.query", [{ currentWindow: true }]],
    ["tabs.create", [{ url: "https://a.example/new" }]],
    ["windows.create", [{ url: "https://a.example/" }]],
    ["windows.getAll", []],
    ["tabGroups.query", [{}]],
    ["webNavigation.getAllFrames", [{ tabId: 1 }]],
  ]) {
    const raw = JSON.parse(await run("chrome_call", { method, args }));
    assert.equal(raw.ok, false, `${label}: chrome_call ${method} rejected`);
    assert.match(raw.error, /窗口/);
  }
  assert.equal(clearedGroup, false, `${label}: close_task_group must not clear groupId on rejection`);
}
assert.equal(calls.length, 0, "unbound tool rejections must not touch chrome.tabs / windows / bookmarks");

// 4. create_window 在 windowId 为 null 时仍是特权路径：创建新窗口并返回新 windowId，不改变任务窗口
let boundWindow = null;
const unboundCtx = {
  getWindowId: () => boundWindow,
  getTabId: () => 1,
  settings: { cdpInput: false },
};
const unboundTools = createAgentTools(unboundCtx);
const runUnbound = (name, args = {}) => unboundTools.find((t) => t.name === name).execute(args);

const created1 = JSON.parse(await runUnbound("create_window", {}));
assert.deepEqual(created1, { windowId: 30 }, "create_window returns new windowId when unbound");
assert.equal(boundWindow, null, "create_window does not bind/redirect task window");
assert.deepEqual(calls.slice(-2), [
  ["windows.getCurrent"],
  ["windows.create", { type: "normal", focused: false, incognito: false }],
]);

currentWindowInfo = { id: 100, type: "normal", incognito: true };
const created2 = JSON.parse(await runUnbound("create_window", { url: "https://a.example/", focused: true }));
assert.deepEqual(created2, { windowId: 31 }, "create_window with url works when unbound");
assert.equal(boundWindow, null, "create_window still keeps task window unbound");
assert.deepEqual(calls.at(-1), [
  "windows.create",
  { type: "normal", focused: true, incognito: true, url: "https://a.example/" },
]);
await assert.rejects(runUnbound("list_tabs", {}), /窗口/, "task remains unbound after create_window");
await assert.rejects(runUnbound("open_tab", { url: "https://a.example/after" }), /窗口/, "open_tab still rejected after create_window");

// 省略 getWindowId 时 create_window 同样工作
const omittedTools = createAgentTools({ settings: { cdpInput: false } });
const created3 = JSON.parse(await omittedTools.find((t) => t.name === "create_window").execute({}));
assert.deepEqual(created3, { windowId: 32 });

// 5. 非窗口方法（history / cookies / bookmarks / runtime）在 windowId 为 null 时保持可用
historyQueries = [];
const histCall = await chromeCall("history.search", [{ text: "pagelens", maxResults: 99 }], null);
assert.equal(histCall.ok, true, "chromeCall history.search succeeds with null windowId");
assert.equal(histCall.result.length, 1);
assert.equal(historyQueries.at(-1).maxResults, 30, "history.search still clamps maxResults");

const visitsCall = await chromeCall("history.getVisits", [{ url: "https://a.example/post" }]);
assert.equal(visitsCall.ok, true, "chromeCall history.getVisits succeeds without windowId");

const bmCall = await chromeCall("bookmarks.search", ["MDN"], null);
assert.equal(bmCall.ok, true, "chromeCall bookmarks.search succeeds with null windowId");

const rtCall = await chromeCall("runtime.getPlatformInfo", [], null);
assert.equal(rtCall.ok, true, "chromeCall runtime.getPlatformInfo succeeds with null windowId");

const cookiesBlockedByAllowlist = await chromeCall("cookies.getAll", [{ domain: "a.example" }], null);
assert.equal(cookiesBlockedByAllowlist.ok, false, "cookies.getAll stays blocked by allowlist");
assert.match(cookiesBlockedByAllowlist.error, /不允许/, "cookies.getAll reports allowlist error, not window error");

const histTool = JSON.parse(await runUnbound("search_history", { query: "Alpha" }));
assert.equal(histTool.length, 1, "search_history tool succeeds with null windowId");

const histViaChromeCall = JSON.parse(await runUnbound("chrome_call", { method: "history.search", args: [{ text: "Alpha" }] }));
assert.equal(histViaChromeCall.ok, true, "chrome_call history.search succeeds with null windowId");

const gotCookies = JSON.parse(await runUnbound("get_cookies", { url: "https://a.example/post" }));
assert.equal(gotCookies.count, 1, "get_cookies succeeds with null windowId");
assert.equal(gotCookies.cookies[0].name, "sid");

const setCookie = JSON.parse(await runUnbound("set_cookie", { url: "https://a.example/post", name: "theme", value: "dark" }));
assert.equal(setCookie.ok, true, "set_cookie succeeds with null windowId");

const removedCookie = JSON.parse(await runUnbound("remove_cookie", { url: "https://a.example/post", name: "theme" }));
assert.equal(removedCookie.ok, true, "remove_cookie succeeds with null windowId");

console.log("PASS unbound window rejects window-scoped calls while preserving create_window and non-window APIs");
