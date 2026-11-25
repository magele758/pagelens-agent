import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import "./fixtures/web-locks.mjs";
import { DELEGATE_STORAGE_KEY } from "../lib/agent/delegate.js";
import { systemPrompt } from "../lib/prompts.js";
import { windowMailTools, bindWindowMail } from "../sidepanel/window-mail.js";
import { resolveActiveTools } from "../lib/agent/tools.js";
import { extractCapsule, capsuleCovers } from "../lib/agent/trust/capsule.js";
import { bindWindowMailIdentity, installWindowMail, listPeerWindows, mailKey, readWindowMail, sendWindowMail, waitForWindowResult } from "../lib/window-mail.js";

function event() {
  const listeners = new Set();
  return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
}

const db = {};
const panelUrl = "chrome-extension://fixture/sidepanel/index.html";
const senderFor = windowId => ({ id: "fixture", url: panelUrl, documentId: `doc-${windowId}` });
let sender = senderFor(1);
let identitySender = sender;
let contextRows = [{ windowId: -1 }];
const cancelled = [];
const windows = [1, 2, 3].map(id => ({ id, incognito: false })).concat({ id: 4, incognito: true });
globalThis.chrome = {
  runtime: {
    id: "fixture", onMessage: event(), getURL: () => panelUrl,
    getContexts: async () => contextRows,
    sendMessage: async msg => new Promise(resolve => {
      let messageSender = sender;
      if (msg.type === "pl.windowMail.identify") messageSender = { id: "fixture" };
      if (msg.type === "pl.windowMail.identity") messageSender = identitySender;
      const keepOpen = [...chrome.runtime.onMessage.listeners]
        .map(receive => receive(msg, messageSender, resolve)).includes(true);
      if (!keepOpen) resolve(undefined);
    }),
  },
  windows: { getAll: async () => windows, onRemoved: event(), onCreated: event() },
  tabs: { query: async q => [{ id: q.windowId * 10, url: "https://example.org/" }] },
  storage: {
    onChanged: event(),
    session: {
      get: async keys => Object.fromEntries([].concat(keys).map(k => [k, structuredClone(db[k])])),
      set: async data => {
        Object.assign(db, structuredClone(data));
        const changes = Object.fromEntries(Object.entries(data).map(([k,v]) => [k, { newValue: v }]));
        for (const notify of chrome.storage.onChanged.listeners) notify(changes, "session");
      },
      remove: async key => { delete db[key]; },
    },
  },
};
let task;
installWindowMail({
  async start(args) {
    task = { ...args, id: "task-123", createdAt: 123, status: "running" };
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [task] });
    return task;
  },
  list: async () => [task],
  cancel: async id => cancelled.push(id),
});

assert.deepEqual(await listPeerWindows(1), [{ id: 2, busy: false }, { id: 3, busy: false }]);
await assert.rejects(sendWindowMail(1, 2, "message", "unbound"), /不匹配/);
contextRows = [{ documentId: "doc-1", windowId: -1 }, { documentId: "doc-2", windowId: 1 }];
await assert.rejects(sendWindowMail(1, 2, "message", "negative without responder"), /不匹配/);
bindWindowMailIdentity(1);
identitySender = senderFor(2);
await assert.rejects(sendWindowMail(1, 2, "message", "wrong document replied"), /不匹配/);
identitySender = senderFor(1);
await assert.rejects(sendWindowMail(2, 3, "message", "wrong claimed window"), /不匹配/);
await assert.rejects(sendWindowMail(null, 3, "message", "no claimed window"), /不匹配/);
contextRows = [{ documentId: "doc-2", windowId: -1 }];
await assert.rejects(sendWindowMail(1, 2, "message", "document not registered as a side panel"), /不匹配/);
contextRows = [{ documentId: "doc-1", windowId: -1 }];
const verified = await sendWindowMail(1, 2, "message", "same side panel confirmed");
assert.equal((await readWindowMail(2)).find(row => row.id === verified.id)?.text, "same side panel confirmed");
await chrome.storage.session.remove(mailKey(1));
await chrome.storage.session.remove(mailKey(2));
contextRows = [
  { documentId: "doc-1", windowId: 1 },
  { documentId: "doc-2", windowId: 2 },
  { documentId: "doc-4", windowId: 4 },
];
await assert.rejects(sendWindowMail(2, 1, "message", "spoof"), /不匹配/);
sender = { id: "fixture", url: panelUrl };
await assert.rejects(sendWindowMail(1, 2, "message", "no-doc"), /不匹配/);
sender = senderFor(1);
await assert.rejects(sendWindowMail(1, 1, "message", "self"), /另一个/);
await assert.rejects(sendWindowMail(1, 4, "message", "private"), /另一个/);
await assert.rejects(sendWindowMail(1, 2, "message", "  "), /长度/);
sender = { ...senderFor(1), tab: { id: 7 } };
await assert.rejects(sendWindowMail(1, 2, "message", "web tab"), /仅侧栏/);
sender = senderFor(1);
await sendWindowMail(1, 2, "message", "left");
sender = senderFor(2);
await sendWindowMail(2, 1, "message", "right");
sender = senderFor(1);
for (const id of [1, 2]) assert.deepEqual((await readWindowMail(id)).map(e => e.text).sort(), ["left", "right"]);
assert.deepEqual(await readWindowMail(3), []);
const repeated = await Promise.all([1, 2].map(() => sendWindowMail(1, 2, "message", "once", undefined, "turn/call")));
assert.equal(repeated[0].id, repeated[1].id);
assert.equal((await readWindowMail(2)).filter(e => e.text === "once").length, 1);
const entry = await sendWindowMail(1, 2, "task", "总结本页", { actions: [] });
assert.equal(entry.from, 1);
assert.equal(task.tabId, 20);
assert.equal(task.windowId, 2);
assert.equal(task.session.modelPlanned, true);
assert.deepEqual(task.capsule, { actions: [] });
const receipt = waitForWindowResult(1, entry.id);
const knownContexts = contextRows;
contextRows = [{ documentId: "doc-1", windowId: -1 }];
const ctrl = new AbortController();
const aborted = waitForWindowResult(1, entry.id, ctrl.signal);
ctrl.abort();
await assert.rejects(aborted, (err) => {
  assert.match(err.message, /已停止等待/);
  assert.equal(err.message, "已停止等待，该委派已取消，不会再有结果进收件箱。");
  return true;
});
assert.deepEqual(cancelled, [entry.id]);
contextRows = knownContexts;
await assert.rejects(waitForWindowResult(3, entry.id), /过期/);
cancelled.length = 0;
for (const onClose of chrome.windows.onRemoved.listeners) await onClose(1);
assert.deepEqual(cancelled, [entry.id]);
cancelled.length = 0;
for (const onClose of chrome.windows.onRemoved.listeners) await onClose(2);
assert.deepEqual(cancelled, [entry.id]);
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [{ ...task, status: "failed", error: { message: "窗口正忙" } }] });
assert.equal((await receipt).result, "窗口正忙");
assert.equal((await waitForWindowResult(1, entry.id)).status, "failed");
assert.deepEqual(await readWindowMail(3), []);
assert.equal(chrome.storage.onChanged.listeners.size, 0);
console.log("PASS cross-window messages, task delivery, failure receipts, cancellation and isolation");

// Auto allocation belongs to the sender's browsing mode, never to an existing peer.
chrome.runtime.onMessage.listeners.clear();
const jobs = [];
const opened = [];
const removed = [];
const capsule = extractCapsule("比较 https://a.example/report 和 https://b.example/report");
assert.equal(capsuleCovers(capsule, { toolName: "run_parallel_tasks" }).covered, true);
let capacityUsed = 0;
let rejectStart = false;
chrome.windows.get = async id => ({ id, type: "normal", incognito: id === 4 });
chrome.windows.create = async props => {
  const id = 20 + opened.length;
  opened.push({ id, ...props });
  return { id, tabs: [{ id: id * 10 }] };
};
chrome.tabs.query = async ({ windowId }) => [{ id: windowId * 10, url: "about:blank" }];
chrome.windows.remove = async id => { removed.push(id); };
installWindowMail({
  list: async () => jobs,
  runningCount: () => capacityUsed,
  async start(args) {
    if (rejectStart) throw new Error("start failed");
    const job = { ...args, id: `job-${jobs.length}`, createdAt: Date.now(), status: "done", answer: args.prompt };
    jobs.push(job);
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: jobs });
    return job;
  },
});
sender = senderFor(4);
const available = resolveActiveTools({ userText: "对照两份报告", tools: windowMailTools(4, () => capsule, "turn-1") });
const batch = available.find(t => t.name === "run_parallel_tasks");
assert.ok(batch, "planning is discoverable without window-related keywords");
await assert.rejects(batch.execute({ tasks: ["one"] }), /2 至/);
assert.equal(opened.length, 0);
const runBatch = () => batch.execute({ tasks: ["报告一", "报告二"] }, { callId: "call-1" }).then(JSON.parse);
const [first, replay] = await Promise.all([runBatch(), runBatch()]);
assert.deepEqual(first, replay);
assert.deepEqual(first.map(t => t.to), [20, 21]);
assert.equal(opened.length, 2);
assert.ok(opened.every(w => w.incognito && !w.focused && w.url === "about:blank"));
assert.ok(jobs.every(j => j.capsule.urls.length === 2 && j.session.modelPlanned));
capacityUsed = 7;
const busy = await batch.execute({ tasks: ["三", "四"] }, { callId: "call-2" }).then(JSON.parse);
assert.ok(busy.every(t => t.status === "failed"));
assert.equal(opened.length, 2);
capacityUsed = 0;
rejectStart = true;
const panelOpens = [];
chrome.sidePanel = { open: async ({ windowId }) => { panelOpens.push(windowId); } };
await assert.rejects(sendWindowMail(4, null, "auto_task", "失败", capsule, "new"), /start failed/);
assert.deepEqual(removed, [22]);
assert.deepEqual(panelOpens, []);

async function expectRollback(prompt, key, query, closes) {
  const removedBefore = removed.length;
  const panelsBefore = panelOpens.length;
  const openedBefore = opened.length;
  chrome.tabs.query = query;
  await assert.rejects(sendWindowMail(4, null, "auto_task", prompt, capsule, key), /start failed/);
  assert.equal(opened.length, openedBefore + 1);
  const id = opened.at(-1).id;
  assert.deepEqual(removed.slice(removedBefore), closes ? [id] : []);
  assert.deepEqual(panelOpens.slice(panelsBefore), closes ? [] : [id]);
}
const blankTab = (url, extra = {}) => async ({ windowId }) => [{ id: windowId * 10, url, ...extra }];
await expectRollback("空白空串", "blank-empty", blankTab(""), true);
await expectRollback("空白新标签", "blank-ntp", blankTab("chrome://newtab"), true);
await expectRollback("空白新标签斜杠", "blank-ntp-slash", blankTab("chrome://newtab/"), true);
await expectRollback("空白pending空", "blank-pending-empty", blankTab("about:blank", { pendingUrl: "" }), true);
await expectRollback("空白pending空白", "blank-pending-blank", blankTab("about:blank", { pendingUrl: "about:blank" }), true);
await expectRollback("空白pending新标签", "blank-pending-ntp", blankTab("chrome://newtab/", { pendingUrl: "chrome://newtab/" }), true);
chrome.windows.remove = async () => { throw new Error("remove failed"); };
await expectRollback("关窗失败", "remove-fails", blankTab("about:blank"), false);
chrome.windows.remove = async id => { removed.push(id); };
await expectRollback("用户打开了页", "user-url", blankTab("https://example.org/touched"), false);
await expectRollback("用户多开标签", "user-tabs", async ({ windowId }) => [
  { id: windowId * 10, url: "about:blank" },
  { id: windowId * 10 + 1, url: "about:blank" },
], false);
await expectRollback("用户正在导航", "user-pending", blankTab("about:blank", { pendingUrl: "https://example.org/next" }), false);
await expectRollback("标签查询失败", "query-fails", async (query) => {
  if (query?.active) return [{ id: query.windowId * 10, url: "about:blank" }];
  throw new Error("tabs unavailable");
}, false);
const removedBeforePanel = removed.length;
chrome.tabs.query = blankTab("https://example.org/touched");
chrome.sidePanel.open = async () => { throw new Error("no gesture"); };
await assert.rejects(sendWindowMail(4, null, "auto_task", "侧栏也失败", capsule, "panel-fails"), /start failed/);
assert.equal(removed.length, removedBeforePanel);
chrome.sidePanel.open = async ({ windowId }) => { panelOpens.push(windowId); };
chrome.tabs.query = async ({ windowId }) => [{ id: windowId * 10, url: "https://example.org/" }];
console.log("PASS automatic window allocation, joining, checkpoint replay and rollback");

// Background delegate_window_task must follow the same stop signal after it returns.
chrome.runtime.onMessage.listeners.clear();
sender = senderFor(1);
const bgTasks = [];
const bgCancelled = [];
let abortDuringStart = null;
installWindowMail({
  list: async () => bgTasks,
  async start(args) {
    const job = { ...args, id: `bg-${bgTasks.length + 1}`, createdAt: Date.now(), status: "running" };
    bgTasks.push(job);
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: bgTasks });
    abortDuringStart?.abort();
    return job;
  },
  async cancel(id) {
    const job = bgTasks.find(item => item.id === id && item.status === "running");
    if (!job || bgCancelled.includes(id)) return;
    job.status = "cancelled";
    bgCancelled.push(id);
    await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: bgTasks });
  },
});
const cancelMessages = [];
const deliverMessage = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = async msg => {
  if (msg?.type === "pl.windowMail.cancel") cancelMessages.push(msg.id);
  return deliverMessage(msg);
};
async function until(fn) {
  for (let i = 0; i < 30; i++) {
    if (fn()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error("condition not met");
}
const delegate = windowMailTools(1, () => ({ actions: [] }), "turn-bg").find(tool => tool.name === "delegate_window_task");
await assert.rejects(
  delegate.execute({ windowId: 2, text: "停在发出前", background: true }, { signal: AbortSignal.abort(), callId: "pre" }),
  err => err?.name === "AbortError",
);
assert.equal(bgTasks.length, 0);
assert.deepEqual(bgCancelled, []);

const mid = new AbortController();
abortDuringStart = mid;
await assert.rejects(
  delegate.execute({ windowId: 2, text: "发出时已停止", background: true }, { signal: mid.signal, callId: "mid" }),
  err => err?.name === "AbortError",
);
abortDuringStart = null;
assert.deepEqual(bgCancelled, ["bg-1"]);
assert.deepEqual(cancelMessages, ["bg-1"]);

const live = new AbortController();
const dispatched = JSON.parse(await delegate.execute(
  { windowId: 2, text: "后台继续", background: true },
  { signal: live.signal, callId: "bg-live" },
));
assert.equal(dispatched.taskId, "bg-2");
assert.equal(dispatched.status, "running");
assert.deepEqual(bgCancelled, ["bg-1"]);
live.abort();
await until(() => bgCancelled.includes("bg-2"));
assert.deepEqual(bgCancelled, ["bg-1", "bg-2"]);

const stop = new AbortController();
const finished = JSON.parse(await delegate.execute(
  { windowId: 2, text: "已经做完", background: true },
  { signal: stop.signal, callId: "done-one" },
));
const doneTask = bgTasks.find(item => item.id === finished.taskId);
doneTask.status = "done";
doneTask.answer = "ok";
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: bgTasks });
const running = JSON.parse(await delegate.execute(
  { windowId: 2, text: "仍在执行", background: true },
  { signal: stop.signal, callId: "run-one" },
));
const sentBeforeStop = cancelMessages.length;
stop.abort();
await until(() => bgCancelled.includes(running.taskId));
assert.deepEqual(cancelMessages.slice(sentBeforeStop), [running.taskId]);
assert.equal(bgCancelled.includes(finished.taskId), false);
assert.equal(bgTasks.find(item => item.id === finished.taskId).status, "done");

const foreground = new AbortController();
const waiting = delegate.execute(
  { windowId: 2, text: "前台等待", background: false },
  { signal: foreground.signal, callId: "fg" },
);
await until(() => bgTasks.some(item => item.prompt === "前台等待"));
await new Promise(resolve => setTimeout(resolve, 0));
foreground.abort();
const foregroundResult = JSON.parse(await waiting);
assert.equal(foregroundResult.status, "cancelled");
assert.equal(bgCancelled.includes(bgTasks.find(item => item.prompt === "前台等待").id), true);
chrome.runtime.sendMessage = deliverMessage;
console.log("PASS background delegation follows stop without cancelling finished tasks");

const mailPrompt = systemPrompt({}, { windowMail: true });
assert.match(mailPrompt, /单页或前后依赖的操作直接完成/);
assert.match(mailPrompt, /忙着的窗口不要再接另一项任务/);
assert.doesNotMatch(mailPrompt, /无限重试/);
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [
  { id: "busy-2", windowId: 2, requesterWindowId: 1, status: "running", prompt: "占着", createdAt: 1 },
  { id: "done-3", windowId: 3, requesterWindowId: 1, status: "done", prompt: "完了", createdAt: 2, answer: "ok" },
  { id: "approve-3", windowId: 3, requesterWindowId: 1, status: "needs_approval", prompt: "等批准", createdAt: 3 },
] });
assert.deepEqual(await listPeerWindows(1), [{ id: 2, busy: true }, { id: 3, busy: false }]);
const listTool = windowMailTools(1, () => ({}), "turn-busy").find(tool => tool.name === "list_task_windows");
assert.match(listTool.description, /busy/);
assert.deepEqual(JSON.parse(await listTool.execute()), {
  current: 1,
  peers: [{ id: 2, busy: true }, { id: 3, busy: false }],
});
const tasksBeforeBusySend = bgTasks.length;
await assert.rejects(sendWindowMail(1, 2, "task", "再派一个", { actions: [] }, "busy-task"), /窗口 2 正在执行任务/);
await assert.rejects(sendWindowMail(1, 2, "message", "再传一句", undefined, "busy-msg"), /窗口 2 正在执行任务/);
assert.equal(bgTasks.length, tasksBeforeBusySend);
assert.equal((await readWindowMail(2)).some(entry => entry.text === "再传一句" || entry.text === "再派一个"), false);
await sendWindowMail(1, 3, "message", "空闲可收");
assert.equal((await readWindowMail(3)).some(entry => entry.text === "空闲可收"), true);

const dom = new JSDOM(`<details id="window-mail">
  <summary>窗口协作</summary>
  <select id="window-peer"></select>
  <textarea id="window-mail-text"></textarea>
  <span id="window-mail-status"></span>
  <ol id="window-mail-log"></ol>
  <button type="button" data-kind="message">发消息</button>
  <button type="button" data-kind="task">委派任务</button>
</details>`);
globalThis.document = dom.window.document;
globalThis.Option = dom.window.Option;
bindWindowMail(1);
const select = document.getElementById("window-peer");
await until(() => [...select.options].some(option => option.value === "2" && option.disabled));
const busyOption = [...select.options].find(option => option.value === "2");
const idleOption = [...select.options].find(option => option.value === "3");
assert.equal(busyOption.textContent, "窗口 2（任务中）");
assert.equal(busyOption.disabled, true);
assert.equal(idleOption.textContent, "窗口 3");
assert.equal(idleOption.disabled, false);
select.value = "3";
await chrome.storage.session.set({ [DELEGATE_STORAGE_KEY]: [
  { id: "busy-2", windowId: 2, requesterWindowId: 1, status: "running", prompt: "占着", createdAt: 1 },
  { id: "busy-3", windowId: 3, requesterWindowId: 1, status: "running", prompt: "也占", createdAt: 4 },
] });
await until(() => select.value === "" && [...select.options].find(option => option.value === "3")?.disabled === true);
assert.equal([...select.options].find(option => option.value === "3").textContent, "窗口 3（任务中）");
console.log("PASS busy peers are listed, disabled, and refused");
