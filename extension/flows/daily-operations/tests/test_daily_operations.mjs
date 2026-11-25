import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { dailySourceForUrl, dailySources } from "../catalog.js";
import { readDailyPage } from "../page.js";
import { addSnapshot, compareSnapshot } from "../history.js";

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
