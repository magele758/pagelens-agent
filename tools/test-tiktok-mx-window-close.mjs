import assert from "node:assert/strict";
import { closeOwnedAutomation, runNativeDraft, windowOnlyHasOwnedTabs } from "../extension/skills/tiktok-mx-draft/tiktok-mx-native.mjs";
import { inspectDraftJob } from "../extension/skills/tiktok-mx-draft/tiktok-mx-inspect.mjs";
import { DraftTabs } from "./tiktok-mx-tabs.mjs";

const sourceId = "1234567890123";
const draftId = "7600000000000001";
const source = `https://shop.tiktok.com/jp/pdp/${sourceId}`;

// Fake Chrome: windows map id -> tabs. Closing the last tab of a window makes Chrome leave a fresh newtab behind.
function makeBrowser(windows, { closeFails = false } = {}) {
  const log = { closed: [], removed: [], ungrouped: [] };
  const tabs = Object.values(windows).flat();
  const find = id => tabs.find(t => t.id === id);
  const chrome = {
    tabs: { get: async id => { const t = find(id); if (!t) throw Error("No tab with id " + id); return t; },
      ungroup: async ids => { log.ungrouped.push(ids); } },
    windows: {
      get: async id => { if (!windows[id]) throw Error("No window " + id); return { id, tabs: [...windows[id]] }; },
      remove: async id => { log.removed.push(id); delete windows[id]; },
    },
    runtime: {},
  };
  const closeTab = async tabId => {
    log.closed.push(tabId);
    if (closeFails) return { ok: false, error: { message: "boom" } };
    for (const [id, list] of Object.entries(windows)) {
      const index = list.findIndex(t => t.id === tabId);
      if (index < 0) continue;
      list.splice(index, 1);
      if (!list.length) list.push({ id: 900 + Number(id), url: "chrome://newtab/" });
      return { ok: true, result: { tabId, done: "closed" } };
    }
    return { ok: false, error: { message: "No tab with id " + tabId } };
  };
  return { chrome, log, closeTab };
}

const owned = (id, windowId = 5) => ({ id, windowId, url: source, groupId: 3 });
const userTab = (id, url) => ({ id, url });

// Pure rule: blank pages are not a reason to close.
{
  const ids = new Set([11, 12]);
  assert.equal(windowOnlyHasOwnedTabs([], ids), false, "empty snapshot never closes");
  assert.equal(windowOnlyHasOwnedTabs([owned(11), owned(12)], ids), true);
  assert.equal(windowOnlyHasOwnedTabs([owned(11), userTab(40, "https://example.com/")], ids), false);
  for (const url of ["", "about:blank", "chrome://newtab/"])
    assert.equal(windowOnlyHasOwnedTabs([owned(11), userTab(41, url)], ids), false, `unowned ${JSON.stringify(url)} protects`);
  assert.equal(windowOnlyHasOwnedTabs([userTab(41, "about:blank")], ids), false);
}

// Scripted native port: runs tool steps, then finishes.
async function runDraft({ windows, steps, done = { ok: true, result: { ok: true } }, bridgeOptions, onTool }) {
  const browser = makeBrowser(windows, bridgeOptions);
  const bridgeCalls = [];
  const bridge = { async call({ tool, args }) {
    bridgeCalls.push({ tool, args });
    if (tool === "open_tab") return { ok: true, result: onTool.open(args) };
    if (tool === "close_tab") return browser.closeTab(args.tabId);
    throw Error("unexpected " + tool);
  } };
  let handler;
  globalThis.chrome = { ...browser.chrome, runtime: { connectNative: () => ({
    onMessage: { addListener(fn) { handler = fn; } },
    onDisconnect: { addListener() {} },
    disconnect() {},
    postMessage(msg) {
      if (msg.type === "mx.tool_result") return resume?.(msg);
      queueMicrotask(async () => {
        for (const [seq, [tool, args]] of steps.entries()) {
          const wait = new Promise(resolve => { resume = resolve; });
          handler({ type: "mx.tool", seq, job: { action: "bridge_call", request: { tool, args } } });
          await wait;
        }
        handler({ type: "mx.done", ...done });
      });
    },
  }) } };
  let resume;
  const job = { id: "job", action: "ptc_create_mx_draft", sourceId, rate: 1 };
  try { await runNativeDraft(job, bridge); } catch (error) { return { ...browser, bridgeCalls, error }; }
  finally { delete globalThis.chrome; }
  return { ...browser, bridgeCalls };
}

const open = (tabId, windowId, backgroundTabIds = []) => ({ tabId, windowId, backgroundTabIds });
const openStep = ["open_tab", { url: source, groupTitle: "PageLens", backgroundUrls: [source] }];

// Only automation tabs: window removed exactly once even though Chrome leaves a newtab after close_tab.
{
  const windows = { 5: [owned(11), owned(12)] };
  const run = await runDraft({ windows, steps: [openStep], onTool: { open: () => open(11, 5, [12]) } });
  assert.deepEqual(run.log.closed.sort(), [11, 12]);
  assert.deepEqual(run.log.removed, [5]);
  assert.deepEqual(run.log.ungrouped, [[11, 12]]);
}

// A user tab with an ordinary URL protects the window; owned tabs are still closed.
{
  const windows = { 5: [owned(11), userTab(40, "https://example.com/")] };
  const run = await runDraft({ windows, steps: [openStep], onTool: { open: () => open(11, 5, [11]) } });
  assert.deepEqual(run.log.closed, [11]);
  assert.deepEqual(run.log.removed, []);
  assert.deepEqual(windows[5].map(t => t.id), [40]);
}

// A user's blank/newtab/empty-URL tab (id not owned) is not a reason to close the window.
for (const url of ["chrome://newtab/", "about:blank", ""]) {
  const windows = { 5: [owned(11), userTab(41, url)] };
  const run = await runDraft({ windows, steps: [openStep], onTool: { open: () => open(11, 5, [11]) } });
  assert.deepEqual(run.log.removed, [], `blank ${JSON.stringify(url)} protects the window`);
  assert.deepEqual(windows[5].map(t => t.id), [41]);
}

// Owned tab dragged into another window: closed by id, destination (and user-held origin) never removed.
{
  const windows = { 5: [userTab(50, "https://example.com/a")], 7: [owned(11, 7), userTab(70, "https://example.com/b")] };
  const run = await runDraft({ windows, steps: [openStep], onTool: { open: () => open(11, 5, [11]) } });
  assert.deepEqual(run.log.closed, [11]);
  assert.deepEqual(run.log.removed, []);
  assert.deepEqual(windows[7].map(t => t.id), [70]);
  assert.deepEqual(windows[5].map(t => t.id), [50]);
}

// Dragged owned tab alone in another window is closed, but that destination is never an owned window.
{
  const windows = { 5: [userTab(50, "https://example.com/a")], 7: [owned(11, 7)] };
  const run = await runDraft({ windows, steps: [openStep], onTool: { open: () => open(11, 5, [11]) } });
  assert.deepEqual(run.log.closed, [11]);
  assert.deepEqual(run.log.removed, [], "destination window is not removed explicitly");
}

// pendingForm (result A): host leaves the editor tab; the extension still closes a window holding only owned tabs.
{
  const windows = { 5: [owned(11), owned(12)] };
  const run = await runDraft({
    windows,
    steps: [openStep, ["close_tab", { tabId: 11 }]],
    onTool: { open: () => open(11, 5, [12]) },
  });
  assert.deepEqual(run.log.closed.filter(id => id === 12), [12]);
  assert.deepEqual(run.log.removed, [5]);
}

// Verification failures skip every close.
{
  const windows = { 5: [owned(11)] };
  const run = await runDraft({ windows, steps: [openStep], done: { ok: false, error: "TikTok verification required" },
    onTool: { open: () => open(11, 5, [11]) } });
  assert.match(run.error.message, /verification/);
  assert.deepEqual(run.log.closed, []);
  assert.deepEqual(run.log.removed, []);
}

// closeOwnedAutomation survives close_tab throwing.
{
  const { chrome, log } = makeBrowser({ 5: [owned(11)] });
  await closeOwnedAutomation({ ownedIds: new Set([11]), windowIds: [5], closeTab: async () => { throw Error("x"); }, chromeApi: chrome });
  assert.deepEqual(log.removed, [5]);
}

// Inspection: close_tab failure still removes an inspection-only window and never masks the read.
async function runInspect({ windows, closeFails, readFails }) {
  const browser = makeBrowser(windows, { closeFails });
  let handler, readReply;
  const calls = [];
  const bridge = { async call({ tool, args }) {
    calls.push(tool);
    if (tool === "open_tab") return { ok: true, result: { tabId: 11, windowId: 5 } };
    if (tool === "close_tab") return browser.closeTab(args.tabId);
    if (readFails && tool === "run_js") return { ok: false, error: { message: "read blew up" } };
    if (tool === "run_js") return { ok: true, result: { result: calls.filter(t => t === "run_js").length === 1 ? 123 : { title: "ok" } } };
    return { ok: true, result: {} };
  } };
  const live = windows[5].find(t => t.id === 11);
  if (live) live.url = `https://seller.tiktokshopglobalselling.com/product/edit-draft/${draftId}?shop_region=MX`;
  globalThis.chrome = { ...browser.chrome, runtime: { connectNative: () => ({
    onMessage: { addListener(fn) { handler = fn; } },
    onDisconnect: { addListener() {} },
    disconnect() {},
    postMessage(msg) {
      if (msg.type === "ptc.inspect_mx") queueMicrotask(() => handler({ type: "ptc.read_saved" }));
      else if (msg.type === "ptc.read_result") { readReply = msg; handler({ type: "ptc.done", ok: msg.ok, result: msg.result, error: msg.error }); }
    },
  }) } };
  const job = { id: "inspect", sourceId, draftId };
  try { return { ...browser, readReply, result: await inspectDraftJob(job, bridge) }; }
  catch (error) { return { ...browser, readReply, error }; }
  finally { delete globalThis.chrome; }
}

{
  const windows = { 5: [{ id: 11, groupId: 2 }] };
  const run = await runInspect({ windows, closeFails: true });
  assert.equal(run.error, undefined, "close failure must not mask a good read");
  assert.deepEqual(run.result, { title: "ok" });
  assert.deepEqual(run.log.removed, [5]);
}
{
  const windows = { 5: [{ id: 11 }, userTab(40, "https://example.com/")] };
  const run = await runInspect({ windows, closeFails: false });
  assert.deepEqual(run.result, { title: "ok" });
  assert.deepEqual(run.log.closed, [11]);
  assert.deepEqual(run.log.removed, [], "user tab protects the inspection window");
}
{
  const windows = { 5: [{ id: 11 }, userTab(41, "chrome://newtab/")] };
  const run = await runInspect({ windows, closeFails: false });
  assert.deepEqual(run.log.removed, [], "unowned newtab protects the inspection window");
}
{
  const windows = { 5: [{ id: 11 }] };
  const run = await runInspect({ windows, closeFails: true, readFails: true });
  assert.match(run.error.message, /read blew up/, "the read error wins over close errors");
  assert.deepEqual(run.log.removed, [5]);
}

// Host close() no longer says the editor tab is kept.
{
  const messages = [];
  const original = console.error;
  console.error = message => messages.push(String(message));
  try {
    const closed = [];
    const tabs = new DraftTabs(sourceId, async (tool, args) => {
      if (tool === "close_tab") { closed.push(args.tabId); return {}; }
      return [];
    });
    tabs.owned = new Set([3, 4]);
    tabs.pendingForm = 4;
    await tabs.close();
    assert.deepEqual(closed, [3]);
  } finally { console.error = original; }
  assert.ok(messages.length >= 1);
  for (const message of messages) assert.doesNotMatch(message, /kept/i);
  assert.ok(messages.some(message => /editor tab 4 was not closed by the host/.test(message)));
}

console.log("tiktok mx window close tests passed");
