import assert from "node:assert/strict";
import { test } from "node:test";
import { readShopeeMarketing } from "../../marketing-runtime.js";

const origin = "https://seller.shopee.cn";
const shop = "42";
const overview = { id: 1, windowId: 7, url: `${origin}/portal/marketing?cnsc_shop_id=${shop}`, status: "complete" };

test("aggregates signed-in shop lists using bounded read-only tabs and closes its tabs", async t => {
  const tabs = new Map([[overview.id, overview]]);
  const closed = [];
  let nextId = overview.id + 1;
  let mostOpen = 0;
  const oldChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = oldChrome; });
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: {
      get: async id => tabs.get(id),
      create: async ({ url, active, windowId }) => {
        assert.equal(active, false);
        assert.equal(windowId, overview.windowId);
        const parsed = new URL(url);
        assert.equal(parsed.origin, origin);
        assert.equal(parsed.searchParams.get("cnsc_shop_id"), shop);
        const tab = { id: nextId++, url, status: "complete" };
        tabs.set(tab.id, tab);
        mostOpen = Math.max(mostOpen, tabs.size - 1);
        return tab;
      },
      remove: async id => {
        assert.notEqual(id, overview.id);
        closed.push(id);
        tabs.delete(id);
      },
    },
    scripting: { executeScript: async ({ target, func, args }) => {
      const url = new URL(tabs.get(target.tabId).url);
      assert.equal(args[0], url.href);
      assert.equal(args[1]?.action || args[1], "read");
      const meta = { url: url.href, shopId: shop };
      let result;
      if (url.pathname.endsWith("/list/campaign")) {
        assert.equal(func.name, "readShopeeCampaigns");
        assert.equal(url.searchParams.get("source"), "3");
        result = { kind: "campaign-catalog", rows: [{ title: "June seller deal" }], meta };
      } else if (url.pathname.endsWith("/vouchers/list")) {
        result = { kind: "vouchers", rows: [{ title: "试填券", code: "PFX10", used: "0" }], meta };
      } else {
        result = { kind: "empty", rows: [], meta: { ...meta, stats: { 销售: "฿0" }, emptyMessage: "暂无数据" } };
      }
      return [{ frameId: 0, documentId: "doc-" + target.tabId, result }];
    } },
  };
  const report = await readShopeeMarketing({
    tab: overview, allPages: true,
    getSettings: async () => { throw new Error("model unavailable"); },
  });
  assert.equal(report.kind, "marketing-report");
  assert.equal(report.sources.length, 6);
  assert.equal(closed.length, 6);
  assert.equal(mostOpen, 2);
  assert.deepEqual([...tabs.keys()], [overview.id]);
  assert.deepEqual(report.records.map(row => [row.source, row.title, row.code]), [
    ["官方活动", "June seller deal", undefined],
    ["优惠券", "试填券", "PFX10"],
  ]);
  assert.match(report.summary, /销售 ฿0/u);
  assert.match(report.warnings.at(-1), /保留原文/u);

  const campaigns = await readShopeeMarketing({
    tab: overview, allPages: true, translate: false, includeVouchers: false,
  });
  assert.equal(campaigns.sources.length, 5);
  assert.equal(campaigns.sources.some(source => source.label === "优惠券"), false);
  assert.deepEqual(campaigns.records.map(row => row.source), ["官方活动"]);
  assert.deepEqual([...tabs.keys()], [overview.id]);
});

test("keeps the initial URL and rows when pagination updates the same list URL", async t => {
  const url = overview.url.replace("/marketing?", "/marketing/cmt-cb/list/campaign?source=3&");
  const tab = { ...overview, url };
  const nextUrl = url + "&page=2";
  let currentUrl = url;
  const injections = [];
  const oldChrome = globalThis.chrome;
  t.after(() => { globalThis.chrome = oldChrome; });
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: { get: async () => ({ ...tab, url: currentUrl }) },
    scripting: { executeScript: async ({ args, target }) => {
      const [expectedUrl, action] = args;
      assert.equal(expectedUrl, currentUrl);
      injections.push(target);
      if (action === "next-page") {
        currentUrl = nextUrl;
        return [{ frameId: 0, documentId: "same", result: { changed: true } }];
      }
      const second = currentUrl === nextUrl;
      return [{
        frameId: 0, documentId: "same",
        result: {
          kind: "campaign-catalog", rows: [{ title: second ? "第二页" : "第一页" }],
          meta: { url: expectedUrl, shopId: shop, page: second ? 2 : 1, tabs: [{ label: "可报名", selected: true }] },
          next: second ? null : { action: "next-page" },
        },
      }];
    } },
  };
  const report = await readShopeeMarketing({ tab, allPages: true, translate: false });
  assert.deepEqual(report.records.map(row => [row.title, row.sourcePage]), [["第一页", 1], ["第二页", 2]]);
  assert.equal(report.sourceUrl, url);
  assert.equal(report.lastReadPageUrl, nextUrl);
  assert.deepEqual(injections.map(target => target.frameIds || target.documentIds), [[0], ["same"], ["same"]]);
});
