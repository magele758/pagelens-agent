import assert from "node:assert/strict";
import { normalizeSettings } from "../lib/storage.js";
import {
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  confirmSummary,
  createPollGate,
  needsConfirmation,
  pickAllowedTab,
  pollMinutesFor,
} from "../lib/agent/inbox-policy.js";
import { createConfirmBroker } from "../lib/agent/inbox-confirm.js";
import { DEFAULT_ALLOWED_ORIGINS } from "../lib/bridge/policy.js";

// --- settings: off by default, legacy implicit `true` does not count ---
assert.equal(normalizeSettings({}).agentInboxEnabled, false);
assert.equal(normalizeSettings({ agentInboxEnabled: true }).agentInboxEnabled, false, "pre-v1 persisted default must not keep inbox on");
assert.equal(normalizeSettings({ agentInboxEnabled: true, agentInboxVersion: 1 }).agentInboxEnabled, true);
assert.equal(normalizeSettings({ agentInboxEnabled: false, agentInboxVersion: 1 }).agentInboxEnabled, false);
assert.equal(normalizeSettings({}).agentInboxVersion, 1);

// --- interval: packaged builds are clamped by Chrome to >= 30s ---
assert.ok(pollMinutesFor({ packaged: true }) * 60 >= 30);
assert.ok(pollMinutesFor({ packaged: false }) * 60 < 30);

// --- backoff gate ---
{
  let t = 0;
  const gate = createPollGate({ now: () => t });
  assert.ok(gate.canPoll());
  gate.markDirsReady();
  gate.onFailure();
  assert.equal(gate.dirsReady(), false, "failure forces dirs to be re-ensured");
  assert.equal(gate.canPoll(), false);
  assert.equal(gate.retryInMs(), BACKOFF_BASE_MS);
  t += BACKOFF_BASE_MS;
  assert.ok(gate.canPoll());
  gate.onFailure();
  assert.equal(gate.retryInMs(), BACKOFF_BASE_MS * 2);
  for (let i = 0; i < 20; i += 1) gate.onFailure();
  assert.equal(gate.retryInMs(), BACKOFF_MAX_MS);
  gate.onSuccess();
  assert.ok(gate.canPoll());
}

// --- tab picking respects the origin allowlist ---
{
  const tabs = [
    { id: 1, url: "https://bank.example/transfer", title: "Bank" },
    { id: 2, url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media&type=10", title: "WeChat list" },
    { id: 3, url: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media&type=77", title: "WeChat draft" },
    { id: 4, url: "chrome://settings", title: "Settings" },
  ];
  const restricted = (url) => url.startsWith("chrome://");
  const bank = pickAllowedTab(tabs, { tabUrlIncludes: "bank" }, DEFAULT_ALLOWED_ORIGINS, restricted);
  assert.match(bank.error, /不在白名单.*bank\.example/);
  const anyTab = pickAllowedTab(tabs, {}, DEFAULT_ALLOWED_ORIGINS, restricted);
  assert.equal(anyTab.tab.id, 3, "empty needle still only picks allowlisted tabs");
  const wechat = pickAllowedTab(tabs, { tabUrlIncludes: "mp.weixin.qq.com", preferType77: true }, DEFAULT_ALLOWED_ORIGINS);
  assert.equal(wechat.tab.id, 3);
  assert.match(pickAllowedTab(tabs, { tabUrlIncludes: "nowhere" }, DEFAULT_ALLOWED_ORIGINS).error, /no tab matching/);
  assert.match(pickAllowedTab(tabs, {}, []).error, /不在白名单/);
}

assert.ok(needsConfirmation("paste_html"));
assert.ok(needsConfirmation("wechat_fill_draft"));
assert.ok(needsConfirmation("cose_publish"));
assert.ok(!needsConfirmation("clipboard_write"));

{
  const s = confirmSummary(
    { id: "j1", action: "paste_html", title: "T" },
    { id: 7, url: "https://mp.weixin.qq.com/x?y=1", title: "Tab" },
    { html: `<p>${"字".repeat(300)}</p>` },
  );
  assert.equal(s.origin, "https://mp.weixin.qq.com");
  assert.equal(s.chars, 300);
  assert.equal(s.preview.length, 200);
}

// --- confirm broker ---
{
  const timers = [];
  const opened = [];
  const closed = [];
  const makeBroker = (open = async (url) => (opened.push(url), 100 + opened.length)) =>
    createConfirmBroker({
      openWindow: open,
      closeWindow: async (id) => closed.push(id),
      timeoutMs: 1000,
      now: () => 0,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: () => {},
    });

  const broker = makeBroker();
  const p1 = broker.request({ action: "paste_html" });
  await Promise.resolve();
  const id1 = new URL(`x://h/${opened[0]}`).searchParams.get("id");
  assert.deepEqual(broker.handleMessage({ type: "pl.inboxConfirm.get", id: id1 }).summary, { action: "paste_html" });
  assert.equal(broker.handleMessage({ type: "pl.inboxConfirm.ping", id: id1 }).ok, true);
  assert.equal(broker.handleMessage({ type: "pl.inboxConfirm.answer", id: id1, approved: true }).ok, true);
  assert.deepEqual(await p1, { approved: true, reason: "approved" });
  assert.equal(broker.handleMessage({ type: "pl.inboxConfirm.get", id: id1 }).ok, false);
  assert.equal(broker.handleMessage({ type: "other" }), undefined);

  const p2 = broker.request({});
  await Promise.resolve();
  const id2 = new URL(`x://h/${opened[1]}`).searchParams.get("id");
  broker.handleMessage({ type: "pl.inboxConfirm.answer", id: id2, approved: "yes" });
  assert.equal((await p2).approved, false, "only literal true approves");

  const p3 = broker.request({});
  await Promise.resolve();
  timers.at(-1).fn();
  assert.deepEqual(await p3, { approved: false, reason: "timeout" });

  const p4 = broker.request({});
  await Promise.resolve();
  await Promise.resolve();
  broker.onWindowRemoved(104);
  assert.deepEqual(await p4, { approved: false, reason: "window closed" });
  assert.equal(broker.pendingCount(), 0);

  const failing = makeBroker(async () => {
    throw new Error("no windows");
  });
  assert.equal((await failing.request({})).approved, false);
}

// --- integration with a stubbed chrome: process count, backoff, allowlist, confirmation ---
const native = { calls: [], down: false, files: {}, directed: {} };
const store = { settings: {} };
const alarms = new Map();
let installType = "normal";
const scripted = [];
const TABS = [
  { id: 1, url: "https://bank.example/", title: "Bank" },
  { id: 2, url: "https://mp.weixin.qq.com/cgi-bin/appmsg?type=77", title: "WeChat" },
];

globalThis.chrome = {
  runtime: {
    id: "test-ext",
    getManifest: () => ({ version: "0.0.0" }),
    getPlatformInfo: async () => ({ os: "linux" }),
    async sendNativeMessage(_name, msg) {
      native.calls.push(msg);
      if (native.down) throw new Error("Specified native messaging host not found.");
      if (msg.op === "clipboard_write") return { ok: true };
      if (msg.action === "ensureDir") return { ok: true };
      const entries = files => Object.keys(files || {}).filter(name => !name.includes("/")).map(name => ({ name, kind: "file" }));
      const key = msg.root?.match(/\/([a-p]{32})$/)?.[1];
      const files = key ? native.directed[key] : native.files;
      if (msg.action === "readdir") {
        return { ok: true, entries: entries(files), directedEntries: entries(native.directed[msg.inboxId]) };
      }
      if (msg.action === "readText") return Object.hasOwn(files, msg.rel)
        ? { ok: true, text: files[msg.rel] } : { ok: false, code: "ENOENT" };
      if (msg.action === "claimInboxJob") {
        if (!Object.hasOwn(files, msg.rel)) return { ok: true, claimed: false };
        const rel = `processing/${msg.rel}`;
        files[rel] = files[msg.rel];
        delete files[msg.rel];
        return { ok: true, claimed: true, rel };
      }
      if (msg.action === "deleteFile") {
        delete files[msg.rel];
        return { ok: true };
      }
      if (msg.action === "writeText") return { ok: true };
      return { ok: false, error: `unexpected ${JSON.stringify(msg)}` };
    },
  },
  management: { getSelf: async () => ({ installType }) },
  storage: { local: { get: async () => ({ settings: store.settings }) }, onChanged: { addListener() {} } },
  tabs: {
    query: async () => TABS,
    get: async (id) => TABS.find((t) => t.id === id),
    update: async () => ({}),
  },
  scripting: {
    async executeScript(opts) {
      scripted.push(opts);
      return [{ result: { ok: true, method: "paste-event" } }];
    },
  },
  alarms: {
    get: async (name) => alarms.get(name) || null,
    clear: async (name) => alarms.delete(name),
    create: async (name, info) => alarms.set(name, { name, ...info }),
    onAlarm: { addListener() {} },
  },
};

const inbox = await import("../lib/agent/inbox.js");

{
  alarms.set(inbox.ALARM_NAME, { name: inbox.ALARM_NAME, periodInMinutes: 0.1 });
  assert.deepEqual(await inbox.syncAgentInboxAlarm(), { enabled: false });
  assert.equal(alarms.size, 0, "disabled inbox clears its alarm");
  native.calls.length = 0;
  assert.equal((await inbox.pollAgentInboxOnce()).reason, "disabled");
  assert.equal(native.calls.length, 0, "disabled inbox spawns no Native Host process");
}

store.settings = { agentInboxEnabled: true, agentInboxVersion: 1, cdpInput: false };

{
  installType = "normal";
  let res = await inbox.syncAgentInboxAlarm();
  assert.equal(res.periodInMinutes, 0.5);
  assert.equal(alarms.get(inbox.ALARM_NAME).periodInMinutes, 0.5);
  installType = "development";
  res = await inbox.syncAgentInboxAlarm();
  assert.equal(alarms.get(inbox.ALARM_NAME).periodInMinutes, 0.1);
}

{
  native.calls.length = 0;
  const first = await inbox.pollAgentInboxOnce();
  assert.equal(first.ok, true);
  assert.equal(native.calls.length, 4, "first poll: 3x ensureDir + readdir, no ping");
  native.calls.length = 0;
  await inbox.pollAgentInboxOnce();
  assert.deepEqual(native.calls.map((c) => c.action), ["readdir"], "steady state: one Native Host process per poll");
}

{
  const competitor = await import("../lib/agent/inbox.js?competing-worker");
  native.files["product.json"] = JSON.stringify({ id: "product", action: "ptc_create_mx_draft" });
  native.calls.length = 0;
  const results = await Promise.all([inbox.pollAgentInboxOnce(), competitor.pollAgentInboxOnce()]);
  assert.equal(results.every(result => result.ok), true);
  assert.equal(results.reduce((count, result) => count + result.processed, 0), 1);
  assert.equal(native.calls.filter(call => call.action === "writeText" && call.root === inbox.OUTBOX_ROOT).length, 1);
  assert.deepEqual(native.files, {}, "a finalized claim is removed from processing");
}

{
  const target = "a".repeat(32), other = "b".repeat(32);
  native.directed[target] = {
    "probe.json": JSON.stringify({ id: "probe", action: "clipboard_write", text: "probe" }),
    "mismatch.json": JSON.stringify({ id: "foreign", action: "clipboard_write", text: "bad" }),
  };
  const oldId = chrome.runtime.id;
  try {
    chrome.runtime.id = other;
    native.calls.length = 0;
    assert.equal((await inbox.pollAgentInboxOnce()).processed, 0);
    assert.deepEqual(native.calls.map(call => call.action), ["readdir"]);
    chrome.runtime.id = target;
    const handled = await inbox.pollAgentInboxOnce();
    assert.equal(handled.processed, 1);
    assert.equal(handled.results[0].consumerExtensionId, target);
    assert.equal(handled.results[0].id, "probe");
    assert.equal(handled.results[0].ok, true);
    assert.deepEqual(native.files, {});
    assert.deepEqual(native.directed[target], {});
    assert.equal(native.calls.filter(call => call.op === "clipboard_write").length, 1);
    const bad = native.calls.find(call => call.root === inbox.OUTBOX_ROOT && call.rel === "mismatch.json");
    assert.match(JSON.parse(bad.text).error, /must match its filename/);
  } finally {
    chrome.runtime.id = oldId;
  }
}

{
  native.down = true;
  native.calls.length = 0;
  const fail = await inbox.pollAgentInboxOnce();
  assert.equal(fail.ok, false);
  assert.ok(fail.retryInMs > 0);
  assert.equal(native.calls.length, 1);
  native.calls.length = 0;
  const skipped = await inbox.pollAgentInboxOnce();
  assert.equal(skipped.reason, "backoff");
  assert.equal(native.calls.length, 0, "host down: backoff skips polls without spawning processes");
  native.down = false;
  store.settings = { ...store.settings, agentInboxEnabled: false };
  await inbox.syncAgentInboxAlarm();
  store.settings = { ...store.settings, agentInboxEnabled: true };
  native.calls.length = 0;
  assert.equal((await inbox.pollAgentInboxOnce()).ok, true, "toggling off/on resets backoff");
  assert.equal(native.calls.length, 4, "dirs re-ensured after a failure");
}

{
  const settings = normalizeSettings(store.settings);
  let asked = 0;
  const approve = async () => (asked++, { approved: true });
  const reject = async () => (asked++, { approved: false, reason: "rejected" });

  native.calls.length = 0;
  await assert.rejects(
    inbox.executeJob({ action: "paste_html", tabUrlIncludes: "bank.example", html: "<b>x</b>" }, { confirm: approve, settings }),
    /不在白名单/,
  );
  assert.equal(asked, 0, "non-allowlisted tab is refused before asking");
  assert.equal(native.calls.length, 0, "nothing written to the clipboard");

  const rejected = await inbox.executeJob({ action: "paste_html", tabUrlIncludes: "weixin", html: "<b>x</b>" }, { confirm: reject, settings });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.failCriteria, "not_confirmed");
  assert.equal(asked, 1);
  assert.equal(native.calls.length, 0, "rejected job does not touch clipboard or page");
  assert.equal(scripted.length, 0);

  const approved = await inbox.executeJob({ action: "paste_html", tabUrlIncludes: "weixin", html: "<b>x</b>" }, { confirm: approve, settings });
  assert.equal(approved.ok, true);
  assert.equal(approved.tabId, 2);
  assert.equal(native.calls[0].op, "clipboard_write");
  assert.equal(scripted.at(-1).target.tabId, 2);

  const noBroker = await inbox.executeJob({ action: "cose_publish", title: "T", markdown: "# hi" }, { settings });
  assert.equal(noBroker.failCriteria, "not_confirmed", "without a confirm channel page actions are denied");

  const fileJob = await inbox.executeJob({ action: "wechat_fill_draft", title: "T", html: "<p>x</p>", tabUrlIncludes: "bank" }, { confirm: approve, settings }).catch((e) => e);
  assert.match(String(fileJob?.message), /不在白名单/);
}

{
  native.files["job1.json"] = JSON.stringify({ id: "job1", action: "paste_html", tabUrlIncludes: "weixin", html: "<b>x</b>" });
  const res = await inbox.pollAgentInboxOnce({ confirm: async () => ({ approved: false, reason: "timeout" }) });
  assert.equal(res.processed, 1);
  assert.equal(res.results[0].ok, false);
  assert.match(res.results[0].error, /timeout/);
  assert.equal(native.files["job1.json"], undefined, "unconfirmed job is moved out of the inbox");
}

// --- jobs carrying a per-agent token ---
{
  const { createTokenRecord } = await import("../lib/bridge/auth.js");
  const { redactJobToken, missingScopes } = await import("../lib/agent/inbox-policy.js");
  const settings = normalizeSettings(store.settings);
  const operate = await createTokenRecord({ name: "codex", scopes: ["page:act", "clipboard"], origins: ["https://bank.example"] });
  const reader = await createTokenRecord({ name: "reader", scopes: ["page:read"], origins: ["*"] });
  const records = [operate.record, reader.record];
  const audited = [];
  const deps = {
    settings,
    loadTokens: async () => records,
    auditLog: { append: async (e) => audited.push(e) },
    confirm: async () => {
      throw new Error("token jobs must not open the confirm popup");
    },
  };

  scripted.length = 0;
  const ok = await inbox.executeJob({ id: "t1", action: "paste_html", token: operate.token, tabUrlIncludes: "bank", html: "<b>x</b>" }, deps);
  assert.equal(ok.ok, true, "valid token with page:act+clipboard skips confirmation");
  assert.equal(ok.tabId, 1, "tab picked from the token's origin range, not agentBridgeOrigins");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].agent, "codex");
  assert.equal(audited[0].tool, "inbox.paste_html");
  assert.equal(audited[0].argsSummary.html, "[8 chars]", "audit keeps only the body length");

  await assert.rejects(
    inbox.executeJob({ action: "paste_html", token: operate.token, tabUrlIncludes: "weixin", html: "x" }, deps),
    /不在白名单/,
    "token origin range still applies",
  );

  const denied = await inbox.executeJob({ action: "paste_html", token: reader.token, tabUrlIncludes: "bank", html: "x" }, deps);
  assert.equal(denied.code, "SCOPE_DENIED");
  assert.deepEqual(missingScopes(reader.record, "cose_publish"), ["page:act"]);

  const bad = await inbox.executeJob({ action: "paste_html", token: "plk_wrong", tabUrlIncludes: "bank", html: "x" }, deps);
  assert.equal(bad.code, "UNAUTHORIZED", "an invalid token is rejected, not downgraded to a confirm popup");

  records[0] = { ...operate.record, revokedAt: Date.now() };
  const revoked = await inbox.executeJob({ action: "paste_html", token: operate.token, tabUrlIncludes: "bank", html: "x" }, deps);
  assert.equal(revoked.code, "UNAUTHORIZED");

  let asked = 0;
  const legacy = await inbox.executeJob(
    { action: "paste_html", tabUrlIncludes: "weixin", html: "x" },
    { ...deps, confirm: async () => (asked++, { approved: false, reason: "rejected" }) },
  );
  assert.equal(legacy.failCriteria, "not_confirmed");
  assert.equal(asked, 1, "jobs without token keep the confirmation");

  assert.equal(redactJobToken({ id: "x", token: operate.token }).token, "[redacted]");
  assert.equal(redactJobToken({ id: "x" }).token, undefined);
}

// --- token jobs: irreversible items go to the approval queue ---
{
  const { createTokenRecord } = await import("../lib/bridge/auth.js");
  const { createApprovalQueue, memoryAdapter } = await import("../lib/agent/trust/approval-queue.js");
  const settings = normalizeSettings(store.settings);
  const pub = await createTokenRecord({ name: "codex", scopes: ["page:act", "clipboard"], origins: ["https://bank.example"] });
  const optOut = await createTokenRecord({ name: "bot", scopes: ["page:act", "clipboard"], origins: ["https://bank.example"], skipIrreversible: true });
  const approvals = createApprovalQueue({ storage: memoryAdapter() });
  const audited = [];
  const deps = {
    settings,
    approvals,
    loadTokens: async () => [pub.record, optOut.record],
    auditLog: { append: async (e) => audited.push(e) },
    confirm: async () => {
      throw new Error("token jobs must not open the confirm popup");
    },
  };
  const body = { action: "cose_publish", title: "T", markdown: "# hi", platforms: ["wechat"] };

  scripted.length = 0;
  const queued = await inbox.executeJob({ id: "p1", token: pub.token, ...body }, deps);
  assert.equal(queued.ok, false);
  assert.equal(queued.code, "CONFIRMATION_REQUIRED");
  assert.match(queued.pendingId, /^pend_/);
  const probes = scripted.length;
  assert.ok(probes <= 1, "only the $cose probe ran; nothing was published");
  const [entry] = await approvals.list({ status: "pending" });
  assert.equal(entry.id, queued.pendingId);
  assert.equal(entry.toolName, "inbox.cose_publish");
  assert.equal(entry.item.id, "publish_send");
  assert.ok(!entry.argsPreview.includes(pub.token), "token never lands in the approval queue");
  assert.equal(audited.at(-1).code, "CONFIRMATION_REQUIRED");

  await approvals.resolve(queued.pendingId, true);
  const ran = await inbox.executeJob({ id: "p2", token: pub.token, ...body }, deps);
  assert.equal(ran.ok, true, "resubmitted job (new id, same body) runs after approval");
  assert.equal(ran.method, "cose_publish");
  assert.equal(audited.at(-1).confirmed, true);
  const again = await inbox.executeJob({ id: "p3", token: pub.token, ...body }, deps);
  assert.equal(again.code, "CONFIRMATION_REQUIRED", "approval is single-use");

  const skipped = await inbox.executeJob({ id: "p4", token: optOut.token, ...body }, deps);
  assert.equal(skipped.ok, true, "opt-out token publishes directly");
  assert.equal(audited.at(-1).optOut, true);
  assert.equal(audited.at(-1).irreversible, "publish_send");

  const paste = await inbox.executeJob({ id: "p5", token: pub.token, action: "paste_html", tabUrlIncludes: "bank", html: "<b>x</b>" }, deps);
  assert.equal(paste.ok, true, "non-irreversible token jobs still skip confirmation");

  const pendingBefore = (await approvals.list()).length;
  let asked = 0;
  const legacy = await inbox.executeJob(body, { ...deps, confirm: async () => (asked++, { approved: false, reason: "rejected" }) });
  assert.equal(legacy.failCriteria, "not_confirmed");
  assert.equal(asked, 1, "tokenless cose_publish keeps the per-job confirmation");
  assert.equal((await approvals.list()).length, pendingBefore, "tokenless jobs never use the approval queue");
}

{
  const { installBridge } = await import("../lib/bridge/index.js");
  const { ACTIVITY_KEY } = await import("../lib/agent/inbox-activity.js");
  const target = "a".repeat(32);
  const revision = "1".repeat(40);
  const state = { ...store, [ACTIVITY_KEY]: [], agentInboxDevelopmentRevision: revision };
  const live = new Set();
  const ports = [];
  let peak = 0;
  let statusChecks = 0;
  let failingWrite;
  let attemptedFailingWrite = false;
  const yieldToWorker = () => new Promise(resolve => setImmediate(resolve));
  async function waitFor(check, message) {
    for (let i = 0; i < 20 && !check(); i++) await yieldToWorker();
    assert.ok(check(), message);
  }
  chrome.runtime.id = target;
  chrome.runtime.onMessage = { addListener() {} };
  chrome.runtime.getURL = relative => `chrome-extension://${target}/${relative}`;
  chrome.runtime.reload = () => assert.fail("A reload in the same inbox scan must be refused");
  chrome.management.getSelf = async () => {
    statusChecks++;
    return { installType: "development" };
  };
  globalThis.fetch = async () => ({
    ok: true, json: async () => ({ enabled: true, extensionId: target, revision }),
  });
  chrome.storage.local = {
    get: async key => ({ [key]: structuredClone(state[key]) }),
    async set(values) {
      await yieldToWorker();
      Object.assign(state, values);
    },
  };
  const sendNativeMessage = chrome.runtime.sendNativeMessage;
  chrome.runtime.sendNativeMessage = async (host, msg) => {
    if (msg.action === "writeText" && msg.root === inbox.OUTBOX_ROOT && msg.rel === failingWrite) {
      attemptedFailingWrite = true;
      return { ok: false, error: "fixture outbox unavailable" };
    }
    return sendNativeMessage(host, msg);
  };
  chrome.runtime.connectNative = () => {
    let source, onMessage;
    return {
      onMessage: { addListener(listener) { onMessage = listener; } },
      onDisconnect: { addListener() {} },
      postMessage(msg) {
        assert.equal(msg.type, "mx.create");
        source = msg.sourceId;
        assert.ok(!live.has(source), "one native port at a time for each source");
        live.add(source);
        peak = Math.max(peak, live.size);
        ports.push({ source, finish: result => onMessage({ type: "mx.done", ...result }) });
      },
      disconnect() { live.delete(source); },
    };
  };
  installBridge();

  const ids = Array.from({ length: 5 }, (_, i) => "170000000000000000" + i);
  const create = (id, sourceId) => ({ id, action: "ptc_create_mx_draft", sourceId, rate: 0.12 });
  const jobs = [
    { ...create("01-first"), sourceUrl: `https://shop.tiktok.com/jp/pdp/item/${ids[0]}` },
    create("02-failure", ids[1]),
    create("03-third", ids[2]),
    create("04-fourth", ids[3]),
    create("05-same-source", ids[0]),
    { id: "06-clipboard", action: "clipboard_write", text: "sequential barrier" },
    create("07-last", ids[4]),
    { id: "08-reload", action: "dev_reload", expectedRevision: revision, createdAt: new Date().toISOString() },
  ];
  const setJobs = jobs => {
    native.calls.length = 0;
    native.directed[target] = Object.fromEntries(jobs.map(job => [job.id + ".json", JSON.stringify(job)]));
  };
  const success = (port, draftId) => ports[port].finish({ ok: true, result: { draftId } });
  const received = id => native.calls.find(call => call.root === inbox.OUTBOX_ROOT &&
    call.action === "writeText" && call.rel === id + ".json");
  setJobs(jobs);

  const batch = inbox.pollAgentInboxOnce();
  await waitFor(() => ports.length >= 3, "three native creates must reach their private ports");
  assert.deepEqual(ports.map(port => port.source), ids.slice(0, 3), "three native creates start without a prior receipt");
  assert.deepEqual(await inbox.pollAgentInboxOnce(), { skipped: true, reason: "busy" });
  assert.deepEqual(Object.keys(native.directed[target]).filter(name => name.startsWith("processing/")).sort(),
    ["processing/01-first.json", "processing/02-failure.json", "processing/03-third.json"]);
  assert.ok(Object.hasOwn(native.directed[target], "04-fourth.json"), "fourth job remains unclaimed at capacity");

  ports[1].finish({ ok: false, error: "fixture create failed" });
  await waitFor(() => ports.length >= 4, "the fourth create must use the open slot");
  assert.equal(ports[3]?.source, ids[3], "a free slot starts the fourth while other jobs run");
  assert.equal(live.size, 3);
  success(2, "draft-C");
  await waitFor(() => Object.hasOwn(native.directed[target], "processing/05-same-source.json"),
    "the same-source request has reached the scanner");
  assert.equal(ports.length, 4, "source URL and canonical ID share the same parallel slot");
  success(0, "draft-A");
  await waitFor(() => ports.length >= 5, "the same-source job starts after its predecessor");
  assert.equal(ports[4]?.source, ids[0]);
  assert.ok(!native.calls.some(call => call.op === "clipboard_write"), "serial action waits for earlier creates");

  success(4, "draft-A-follow-up");
  success(3, "draft-D");
  await waitFor(() => ports.length >= 6, "the last job starts after the clipboard barrier");
  assert.equal(ports[5]?.source, ids[4]);
  assert.ok(native.calls.some(call => call.op === "clipboard_write"), "later create waits for serial action");
  assert.equal(statusChecks, 0, "reload handler waits for the last create");
  success(5, "draft-E");

  const { processed, results } = await batch;
  assert.equal(peak, 3);
  assert.equal(processed, jobs.length);
  assert.deepEqual(results.map(out => out.id), jobs.map(job => job.id));
  assert.deepEqual(results.filter(out => out.result?.draftId).map(out => out.result.draftId),
    ["draft-A", "draft-C", "draft-D", "draft-A-follow-up", "draft-E"]);
  assert.equal(results[1].error, "fixture create failed");
  assert.equal(results.at(-1).errorCode, "DEVELOPMENT_BUSY");
  assert.equal(statusChecks, 1);
  assert.deepEqual(native.directed[target], {});
  assert.equal(live.size, 0);
  assert.deepEqual(state[ACTIVITY_KEY].map(entry => entry.id).sort(), jobs.map(job => job.id));
  for (const out of results) {
    assert.ok(received(out.id), "each sibling has its own outbox receipt");
    assert.equal(JSON.parse(received(out.id).text).consumerExtensionId, target);
  }

  setJobs([create("write-failure", ids[0]), create("write-sibling", ids[1])]);
  failingWrite = "write-failure.json";
  const writeBatch = inbox.pollAgentInboxOnce();
  const writeRejected = assert.rejects(writeBatch, /fixture outbox unavailable/);
  await waitFor(() => ports.length >= 8, "the write-failure jobs start at the same time");
  success(6, "draft-F");
  await waitFor(() => attemptedFailingWrite, "the failure arrives while the sibling is running");
  assert.deepEqual(await inbox.pollAgentInboxOnce(), { skipped: true, reason: "busy" });
  success(7, "draft-G");
  await writeRejected;
  assert.ok(received("write-sibling"), "one outbox write failure does not skip a sibling's receipt");
  assert.deepEqual(Object.keys(native.directed[target]), ["processing/write-failure.json"]);
}

console.log("test_agent_inbox: ok");
