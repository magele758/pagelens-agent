import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { operateTemuSellerData } from "../page-state.js";
import { operateTemuEnrollment } from "../enrollment.js";
import { canReadTemuSellerData, readTemuSellerData, temuSellerCsv } from "../runtime.js";
import { isTemuEnrollmentPage, temuSellerDataPage } from "../routes.js";

const seller = "https://agentseller.temu.com";
const goods = seller + "/goods/list";
const orders = seller + "/mmsos/orders.html";
const campaigns = seller + "/activity/marketing-activity";
const signup = campaigns + "/detail";
const finance = "https://seller.kuajingmaihuo.com/labor/account";

function fixture(url, markup) {
  const dom = new JSDOM("<title>Temu 商家后台</title><main>" + markup + "</main>", {
    url,
    pretendToBeVisual: true,
  });
  for (const name of ["document", "location", "getComputedStyle", "HTMLTableElement", "HTMLSelectElement", "HTMLInputElement", "Event"]) {
    const value = dom.window[name];
    globalThis[name] = name === "getComputedStyle" ? value.bind(dom.window) : value;
  }
  return dom;
}

const read = (url, kind, args) => operateTemuSellerData({ expectedUrl: url, kind, ...args });
assert.equal(temuSellerDataPage(goods)?.kind, "products");
assert.equal(temuSellerDataPage(orders)?.kind, "orders");
assert.equal(temuSellerDataPage(campaigns + "/result")?.kind, "campaigns");
assert.equal(temuSellerDataPage("https://ads.temu.com/index.html?source=2")?.kind, "marketing");
assert.equal(temuSellerDataPage("https://seller.kuajingmaihuo.com/labor/bill")?.kind, "finance");
assert.equal(temuSellerDataPage("https://agentseller.temu.com.evil.invalid/goods/list"), null);
assert.equal(temuSellerDataPage("https://untrusted@agentseller.temu.com/goods/list"), null);
assert.equal(canReadTemuSellerData(goods, "orders"), false);
assert.equal(isTemuEnrollmentPage(signup), true);
assert.equal(isTemuEnrollmentPage(campaigns + "/auto-sign"), false);

{
  const dom = fixture(goods, [
    "<h1>商品列表</h1>",
    "<section><div><table><thead>",
    "<tr><th rowspan='2'>商品信息</th><th rowspan='2'>SKU ID</th><th colspan='2'>包装</th><th rowspan='2'>操作</th></tr>",
    "<tr><th>体积</th><th>重量</th></tr>",
    "</thead></table></div>",
    "<div><table><tbody>",
    "<tr><td rowspan='2'>夹克</td><td>1001</td><td>30×20×5</td><td>200g</td><td>编辑</td></tr>",
    "<tr><td>1002</td><td>35×24×5</td><td>250g</td><td>删除</td></tr>",
    "</tbody></table></div></section>",
    "<nav class='merchant-pagination'><button aria-current='page'>1</button><button title='下一页'>→</button></nav>",
  ].join("\n"));
  const first = read(goods, "products");
  assert.equal(first.ok, true);
  assert.equal(first.records.length, 2);
  assert.deepEqual(first.records[1].fields, { 商品信息: "夹克", "SKU ID": "1002", "包装 / 体积": "35×24×5", "包装 / 重量": "250g" });
  assert.equal(first.page, 1);
  let clicks = 0;
  document.querySelector("[title='下一页']").addEventListener("click", () => clicks++);
  assert.equal(read(goods, "products", { action: "next-page", expectedPageKey: "stale" }).ok, false);
  assert.equal(clicks, 0);
  assert.equal(read(goods, "products", { action: "next-page", expectedPageKey: first.pageKey }).ok, true);
  assert.equal(clicks, 1);
  dom.window.close();
}

{
  const dom = fixture(orders, [
    "<h1>卖家履约订单</h1>",
    "<table><thead><tr><th>订单信息</th><th>订单状态</th><th>收货信息</th><th>备注</th></tr></thead>",
    "<tbody><tr><td>1024</td><td>待发货</td><td>收件人、电话、地址</td><td> =1+1</td></tr></tbody></table>",
  ].join("\n"));
  const data = read(orders, "orders");
  assert.deepEqual(data.records[0].fields, { 订单信息: "1024", 订单状态: "待发货", 备注: "=1+1" });
  const exported = temuSellerCsv({
    title: "订单", sourceUrl: orders, pages: 1, records: data.records.map(row => ({ ...row, page: 1 })),
  });
  assert.ok(exported.startsWith("\ufeff"));
  assert.ok(exported.includes("'=1+1"));
  assert.ok(!exported.includes("收件人、电话、地址"));
  document.querySelector("tbody").replaceChildren();
  document.querySelector("main").append(document.createTextNode("\n共有 0 条\n"));
  const empty = read(orders, "orders");
  assert.equal(empty.ok, true);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.records, []);
  dom.window.close();
}

{
  const dom = fixture(finance, [
    "<h1>资金中心</h1><h2>货款账户</h2>",
    "<section><div><span>总金额（CNY）</span></div><div><strong>12,345.67</strong></div></section>",
    "<div><span>可用余额 (CNY)</span><span> 1,200.50</span></div>",
    "<dl><dt>账户预留金额 (CNY)</dt><dd>--</dd></dl>",
    "<p>预留额度：0.00 元</p>",
    "<h2>提现记录</h2><table><thead><tr><th>提现时间</th><th>提现金额</th></tr></thead><tbody></tbody></table>",
    "<p>暂无数据</p><nav class='merchant-pagination'><a title='下一页' href='/labor/withdraw'>提现</a></nav>",
  ].join("\n"));
  const tab = { id: 11, active: true, url: finance };
  globalThis.chrome = {
    tabs: { get: async () => tab },
    scripting: { executeScript: async ({ func, args }) => [{ frameId: 0, documentId: "finance", result: func(...args) }] },
  };
  const report = await readTemuSellerData({ tab, kind: "finance", allPages: true });
  assert.deepEqual(report.records, []);
  assert.equal(report.emptyMessage, "暂无数据");
  assert.equal(report.hasMore, false, "提现 link cannot be mistaken for pagination");
  assert.equal(report.sections.includes("提现记录"), true);
  assert.equal(report.stats.账户类型, "货款账户");
  assert.equal(report.stats["总金额 (CNY)"], "12,345.67");
  assert.equal(report.stats["可用余额 (CNY)"], "1,200.50");
  assert.equal(report.stats["账户预留金额 (CNY)"], "--");
  assert.equal(report.stats.预留额度, "0.00 元");
  assert.ok(temuSellerCsv(report).includes('"指标"'));
  dom.window.close();
}

{
  const dom = fixture(campaigns, [
    "<h1>营销活动</h1>",
    "<table><thead><tr><th>活动主题</th><th>活动时间 UTC+8（北京）</th><th>申报价格条件</th><th>库存条件</th><th>已报名</th><th>操作</th></tr></thead></table>",
    "<table><tbody><tr><td>测试促销</td><td>11-20 18:00</td><td>满足价格要求</td><td>9</td><td>0</td><td><a>报名</a></td></tr></tbody></table>",
  ].join("\n"));
  assert.equal(read(campaigns, "campaigns").records[0].fields.活动主题, "测试促销");
  document.querySelector("main").append(document.createElement("dialog"));
  document.querySelector("dialog").setAttribute("open", "");
  assert.equal(read(campaigns, "campaigns").code, "dialog-open");
  dom.window.close();
}

{
  const dom = fixture(signup, [
    "<h1>活动报名</h1>",
    "<button type='button'>同意活动规则，立即报名</button>",
    "<table><thead><tr><th>选择</th><th>商品信息</th><th>SKU ID</th><th>建议申报价格</th><th>活动申报价格</th><th>建议活动库存</th><th>活动库存</th></tr></thead>",
    "<tbody><tr><td><input type='checkbox'></td><td>夹克</td><td>1001</td><td>¥14.50</td><td><input type='number' min='0.01' step='0.01'></td><td>15 件</td><td><input type='number' min='1'></td></tr></tbody></table>",
    "<button type='button'>下一步</button><button type='submit'>提交</button>",
  ].join("\n"));
  let finalClicks = 0;
  let nextClicks = 0;
  for (const node of document.querySelectorAll("button")) {
    node.addEventListener("click", () => node.textContent === "下一步" ? nextClicks++ : finalClicks++);
  }
  const inspect = (args = {}) => operateTemuEnrollment({ expectedUrl: signup, ...args });
  const snapshot = inspect();
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.canNext, false);
  assert.equal(snapshot.items[0].priceSuggestion, "14.50");
  assert.equal(snapshot.items[0].inventorySuggestion, "15");
  const proposal = { id: snapshot.items[0].id, price: "14.50", inventory: "15" };
  assert.equal(inspect({ action: "fill", expectedKey: snapshot.key, items: [proposal, { id: "wrong" }] }).ok, false);
  assert.equal(document.querySelector("input[type='checkbox']").checked, false);
  const receipt = inspect({ action: "fill", expectedKey: snapshot.key, items: [proposal] });
  assert.equal(receipt.verified.length, 1);
  assert.equal(receipt.items[0].price, "14.50");
  assert.equal(receipt.items[0].inventory, "15");
  assert.equal(finalClicks, 0);
  assert.equal(inspect({ action: "next", expectedKey: snapshot.key, items: [proposal] }).code, "final-step");
  const step = document.createElement("li");
  step.setAttribute("aria-current", "step");
  const steps = document.createElement("ol");
  steps.append(step, document.createElement("li"));
  document.querySelector("main").append(steps);
  assert.equal(inspect({ action: "next", expectedKey: snapshot.key, items: [proposal] }).advanced, true);
  assert.equal(nextClicks, 1);
  assert.equal(finalClicks, 0);
  document.querySelector("tbody").replaceChildren();
  const empty = inspect();
  assert.equal(empty.ready, true);
  assert.equal(empty.items.length, 0);
  dom.window.close();
}

{
  const dom = fixture(campaigns, "<aside role='dialog'><h2>活动详情</h2><button>同意活动规则，立即报名</button></aside>");
  let clicks = 0;
  document.querySelector("button").addEventListener("click", () => clicks++);
  assert.equal(operateTemuEnrollment({ expectedUrl: campaigns }).ready, false);
  assert.equal(operateTemuEnrollment({ expectedUrl: campaigns, action: "fill", items: [] }).ok, false);
  assert.equal(clicks, 0);
  dom.window.close();
}

{
  const tab = { id: 10, active: true, url: goods };
  const synthetic = ({ kind, action, expectedPageKey }) => {
    assert.equal(kind, "products");
    if (action === "next-page") {
      assert.equal(expectedPageKey, "first");
      page++;
      return { ok: true };
    }
    return {
      ok: true, records: [{ table: "商品列表", fields: { SKU: "s" + page } }], warnings: [],
      next: page === 1, pageKey: page === 1 ? "first" : "second", page, total: 2,
      filters: ["全部"], stats: {}, overview: [],
    };
  };
  let page = 1;
  let reads = 0;
  let newDocument = false;
  globalThis.chrome = {
    tabs: { get: async () => tab },
    scripting: {
      executeScript: async ({ target, world, args }) => {
        assert.equal(world, "ISOLATED");
        assert.equal(target.tabId, 10);
        assert.equal(args[0].expectedUrl, goods);
        if (++reads > 1) assert.deepEqual(target.documentIds, ["current"]);
        return [{ frameId: 0, documentId: newDocument && page > 1 ? "other" : "current", result: synthetic(args[0]) }];
      },
    },
  };
  const report = await readTemuSellerData({ tab, kind: "products", allPages: true });
  assert.deepEqual(report.records.map(item => item.fields.SKU), ["s1", "s2"]);
  assert.equal(report.pages, 2);
  page = 1;
  reads = 0;
  newDocument = true;
  const partial = await readTemuSellerData({ tab, kind: "products", allPages: true });
  assert.equal(partial.pages, 1);
  assert.match(partial.warnings[0], /未能验证/);
  tab.active = false;
  await assert.rejects(readTemuSellerData({ tab, kind: "products" }), /标签已切换/u);
}
