import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { dailyPlan, dailySelectionKey, dailySourceForUrl, dailySources } from "../catalog.js";
import { readDailyPage } from "../page.js";
import { addSnapshot, compareSnapshot, dailyScheduleKey, dailyStateKey, dayInChina } from "../history.js";
import { dailyReportData } from "../report.js";
import { handleDailyMessage, onDailyAlarm } from "../runtime.js";
import { renderDailyChat } from "../../../skill-components/daily-operations/cards.js";

test("the selected plan defaults to all and only keeps checked known sections", () => {
  assert.equal(Object.values(dailyPlan()).flat().length, 30);
  assert.deepEqual(dailyPlan({ orders: ["全部", "全部", "unknown"], refunds: [], fake: ["全部"] }), { orders: ["全部"] });
  assert.deepEqual(dailyPlan({}), {});
});

test("manual runs and alarms only open selected sources and visit selected tabs", async () => {
  const previousChrome = globalThis.chrome;
  const stored = { [dailySelectionKey]: { violations: ["店铺违规"] } };
  const calls = [];
  let resolveAlarm;
  globalThis.chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries([keys].flat().map(key => [key, stored[key]])),
      set: async values => {
        Object.assign(stored, structuredClone(values));
        if (values[dailyStateKey]?.running === false) resolveAlarm?.();
      },
    } },
    permissions: { contains: async () => true },
    tabs: {
      create: async ({ url }) => { calls.push(url); return { id: 1 }; },
      get: async () => ({ url: dailySources.violations.url, status: "complete" }),
      remove: async () => {},
    },
    scripting: { executeScript: async ({ args: [{ action, section }] }) => {
      calls.push([action, section]);
      return [{ frameId: 0, documentId: "doc", result: {
        ok: true, records: [], total: 0, next: false, account: "test",
      } }];
    } },
  };
  try {
    const completed = await handleDailyMessage({ type: "pl.daily.run", source: "all" });
    assert.deepEqual(completed.progress, { done: 1, total: 1,
      last: { id: "violations", section: "店铺违规", count: 0, added: null, complete: true } });
    const expected = [dailySources.violations.url, ["section", "店铺违规"], ["read", "店铺违规"]];
    assert.deepEqual(calls.splice(0), expected);
    const done = new Promise(resolve => { resolveAlarm = resolve; });
    onDailyAlarm({ name: "pagelens.dailyOperations" });
    await done;
    assert.deepEqual(calls, expected);
  } finally { globalThis.chrome = previousChrome; }
});

test("the report uses aggregate facts and its cards link to and retry the selected sections", () => {
  const entry = { section: "待回复消息", complete: true, previousDelta: 1, added: ["secret"],
    records: [{ id: "secret", fields: { 最新消息: "customer private message" } }] };
  const state = {
    startedAt: 1, finishedAt: 2,
    plan: { chat: ["待回复消息"], funds: ["限制记录"] },
    results: { chat: { sections: [entry], errors: [] },
      funds: { sections: [], errors: [{ error: "请登录" }] } },
    report: { text: "请查看待回复消息。" },
  };
  const data = dailyReportData(state);
  assert.equal(data[0].count, 1);
  assert.equal(data[1].status, "未完成");
  assert.doesNotMatch(JSON.stringify(data), /customer private message|secret|请登录/u);
  const previousDocument = globalThis.document;
  globalThis.document = new JSDOM("<article></article>").window.document;
  const action = [];
  try {
    const article = document.querySelector("article");
    renderDailyChat(article, { ...state, running: true, phase: "collect", progress: {
      current: { id: "chat", section: "待回复消息" }, done: 0, total: 2,
    } }, {});
    assert.equal(article.querySelector("progress").max, 2);
    assert.match(article.textContent, /正在查看 Temu › 客服 › 待回复消息/u);
    renderDailyChat(article, state, { onOpen: (...args) => action.push(args), onRetry: plan => action.push(plan) });
    assert.match(article.textContent, /AI 摘要/u);
    article.querySelector(".daily-issues button").click();
    [...article.querySelectorAll(".daily-issues button")].find(node => node.textContent === "重试").click();
    assert.deepEqual(action, [["chat", "待回复消息"], { funds: ["限制记录"] }]);
  } finally { globalThis.document = previousDocument; }
});

function fixture(source, html, markupVisible = () => true) {
  const config = dailySources[source];
  const dom = new JSDOM(html, { url: config.url, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return markupVisible(this) ? [{}] : []; };
  const run = params => dom.window.eval(`(${readDailyPage.toString()})`)({
    source, targetUrl: config.url, sections: config.sections, translations: config.translations,
    header: config.header, allowedFields: config.fields?.source, ...params,
  });
  return { run, doc: dom.window.document };
}

test("the daily entry points are restricted to the business lists", () => {
  assert.equal(dailySourceForUrl(dailySources.violations.url + "?targetType=2"), "violations");
  assert.equal(dailySourceForUrl("https://agentseller-eu.temu.com/labor/account"), undefined);
  assert.equal(dailySourceForUrl("https://fangguo.com.example/business/order"), undefined);
});

test("a modal is dismissed only via its verified close icon", () => {
  const { run, doc } = fixture("orders", `
    <div role="dialog"><button class="el-dialog__headerbtn" aria-label="关闭此对话框">×</button>
      <button id="danger">一键调整</button></div>
  `);
  assert.equal(run({}).code, "dialog-open");
  doc.querySelector("#danger").onclick = () => assert.fail("Business action was clicked");
  let closes = 0;
  doc.querySelector(".el-dialog__headerbtn").onclick = () => closes++;
  assert.equal(run({ action: "dismiss" }).dismissed, true);
  assert.equal(closes, 1);
  doc.querySelector(".el-dialog__headerbtn").remove();
  assert.equal(run({ action: "dismiss" }).code, "popup-unrecognized");
});

test("only pending chats are collected even when the all-conversations pane is open", () => {
  const { run } = fixture("chat", `
    <div class="components_mall-item--selected"><div class="info_name">shop</div></div>
    <div><div class="conv-list_panel-wrapper__1"><div class="conv-list_panel-wrapper_left_label__1">全部会话</div></div>
      <div class="conv-list_panel-content__1"><div class="conv-item_conv-item__1">other</div></div></div>
    <div><div class="conv-list_panel-wrapper__1"><div class="conv-list_panel-wrapper_left_label__1">待回复消息</div></div>
      <div class="conv-list_panel-content__1"><div>暂无会话</div></div></div>
  `);
  const reply = run({ section: "待回复消息" });
  assert.equal(reply.ok, true);
  assert.equal(reply.total, 0);
  assert.deepEqual([...reply.records], []);
});

test("the Fangguo date popper remains available while the range is entered", () => {
  const { run } = fixture("orders", `
    <div class="avatar-box"><span class="name-line">account</span></div>
    <div class="date-picker"><input class="el-range-input"><input class="el-range-input"></div>
    <span class="el-select__selected-item">付款时间</span><button>搜索</button>
    <div class="el-picker__popper" role="dialog">日期选择</div>
  `);
  const result = run({ action: "focus-filter", field: "start", start: "2026-11-01 00:00:00" });
  assert.equal(result.ok, true);
  assert.equal(result.value, "2026-11-01 00:00:00");
});

test("the Fangguo order parser reads the virtual row and omits recipient data", () => {
  const { run } = fixture("orders", `
    <div class="avatar-box"><span class="name-line">account</span></div>
    <div class="state-wrap"><div class="state active">全部 16</div></div>
    <div class="dynamic-scroller-ref vue-recycle-scroller">
      <div class="virtual-table-row-tr">${["", "1", "shop", "PO-210-1234567", "待发货", "11-02 04:05",
        "time", "Private recipient and phone", "1", "shipment", "", ""].map(v =>
        `<div class="virtual-table-row-td">${v}</div>`).join("")}</div>
    </div>
    <span class="el-pagination__total">共 1 条</span>
  `);
  const reply = run({ section: "全部" });
  assert.equal(reply.ok, true);
  assert.equal(reply.total, 1);
  assert.equal(reply.records[0].fields.订单号, "PO-210-1234567");
  assert.ok(!JSON.stringify(reply).includes("Private recipient"));
});

test("Fangguo recovery reverses only the payment-time sort", () => {
  const { run, doc } = fixture("orders", `
    <div class="avatar-box"><span class="name-line">account</span></div>
    <div class="state-wrap"><div class="state active">全部</div></div>
    <div class="dynamic-scroller-ref vue-recycle-scroller"><div class="vue-recycle-scroller__slot">
      <div>付款时间<p><i class="icon-shouqi !text-primary"></i><i class="icon-xiala-baise"></i></p></div>
      <div>发货逾期时间<p><i class="icon-shouqi"></i><i class="icon-xiala-baise" id="other"></i></p></div>
    </div></div>
  `);
  const [ascending, descending] = doc.querySelectorAll(".vue-recycle-scroller__slot > div:first-child i");
  let clicked = 0;
  doc.querySelector("#other").onclick = () => assert.fail("The unrelated date sort was clicked");
  descending.onclick = () => {
    clicked++;
    ascending.classList.remove("!text-primary");
    descending.classList.add("!text-primary");
  };
  ascending.onclick = () => clicked++;
  assert.equal(run({ action: "order-sort", section: "全部" }).previousSort, "ascending");
  assert.equal(run({ action: "order-sort", section: "全部", field: "ascending" }).previousSort, "descending");
  assert.equal(clicked, 2);
});

test("order violations use the middle table and ignore duplicated fixed columns", () => {
  const { run } = fixture("violations", `
    <div class="_Wrz4-O9w">shop</div>
    <div class="TAB_lineLabelActive_123" data-testid="beast-core-tab-itemLabel">订单违规</div>
    <div data-testid="beast-core-table">
      <table><thead data-testid="beast-core-table-middle-thead"><tr><th>违规编号</th><th>违规类型</th></tr></thead>
        <tbody data-testid="beast-core-table-middle-tbody"><tr><td>ABC123</td><td>发货超时</td></tr></tbody></table>
      <table><thead data-testid="beast-core-table-left-thead"><tr><th>违规编号</th></tr></thead>
        <tbody data-testid="beast-core-table-left-tbody"><tr><td>ABC123</td></tr></tbody></table>
      <ul data-testid="beast-core-pagination"><li>共有 2 条</li><li data-testid="beast-core-pagination-next"></li></ul>
    </div>
  `);
  const reply = run({ section: "订单违规" });
  assert.equal(reply.ok, true);
  assert.equal(reply.records.length, 1);
  assert.equal(reply.records[0].fields.违规类型, "发货超时");
  assert.equal(reply.total, 2);
  assert.equal(reply.next, true);
});

test("first runs, repeated same-day runs and yesterday use distinct comparisons", () => {
  const day1 = Date.parse("2026-11-24T16:15:00+08:00");
  const day2 = Date.parse("2026-11-25T08:00:00+08:00");
  const row = (id, status) => ({ id, fields: { status } });
  const yesterday = { at: day1, records: [row("a", "open")] };
  const today = { at: day2, records: [row("a", "closed"), row("b", "open")] };
  const again = { at: day2 + 3600000, records: [row("a", "closed"), row("c", "open")] };
  const first = compareSnapshot([], today);
  assert.equal(first.previousDelta, null);
  assert.deepEqual(first.added, []);
  const history = addSnapshot(addSnapshot([], yesterday), today);
  const next = compareSnapshot(history, again);
  assert.equal(next.previousDelta, 0);
  assert.equal(next.yesterdayDelta, 1);
  assert.deepEqual(next.added, ["c"]);
  assert.deepEqual(next.trend.at(-1), ["2026-11-25", 2]);
});

test("daily collection schedules the next Beijing time and clears a disabled alarm", async () => {
  const previousChrome = globalThis.chrome;
  const storage = {};
  const alarms = new Map();
  globalThis.chrome = {
    storage: { local: { set: async values => Object.assign(storage, values) } },
    alarms: {
      clear: async name => alarms.delete(name),
      create: async (name, options) => alarms.set(name, options),
    },
  };
  try {
    const now = Date.now();
    const time = "08:35";
    await handleDailyMessage({ type: "pl.daily.schedule", enabled: true, time });
    const { when, periodInMinutes } = alarms.get("pagelens.dailyOperations");
    assert.ok(when > now && when - now <= 86400000);
    assert.equal(when, Date.parse(dayInChina(when) + "T08:35:00+08:00"));
    assert.equal(periodInMinutes, 1440);
    assert.deepEqual(storage[dailyScheduleKey], { enabled: true, time });
    await handleDailyMessage({ type: "pl.daily.schedule", enabled: false, time });
    assert.equal(alarms.size, 0);
    assert.equal(storage[dailyScheduleKey].enabled, false);
  } finally { globalThis.chrome = previousChrome; }
});
