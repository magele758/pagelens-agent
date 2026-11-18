import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { bindShopeeMarketingPanel } from "../flows/shopee/marketing-panel.js";
import { bindWorkflowCatalog } from "../sidepanel/workflow-catalog.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("selects a platform and opens the requested workflow without running it", async t => {
  const html = await readFile(new URL("../sidepanel/index.html", import.meta.url), "utf8");
  const { window } = new JSDOM(html);
  const { document } = window;
  const oldDocument = globalThis.document;
  const oldChrome = globalThis.chrome;
  t.after(() => {
    globalThis.document = oldDocument;
    globalThis.chrome = oldChrome;
    window.close();
  });
  globalThis.document = document;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const byId = id => document.getElementById(id);
  const shopId = 42;
  const origin = "https://seller.shopee.cn";
  const tab = { id: 7, url: origin + "/portal/marketing?cnsc_shop_id=" + shopId };
  const listener = { addListener() {} };
  globalThis.chrome = {
    tabs: { query: async () => [tab], onActivated: listener, onUpdated: listener },
    runtime: { onMessage: listener },
  };
  let openCatalog;
  const onBack = () => openCatalog();
  const openMarketing = bindShopeeMarketingPanel({ getTargetTab: async () => tab, onBack });
  let selectedSkill;
  let listingOpened = false;
  const openProductListing = () => { listingOpened = true; return true; };
  const openTiktokDraft = feature => { selectedSkill = feature; return true; };
  openCatalog = bindWorkflowCatalog({ openProductListing, openMarketing, openTiktokDraft });

  const picker = byId("workflow-platform");
  const choices = () => [...document.querySelectorAll("#workflow-feature-list button")];
  const launch = async id => {
    document.querySelector(`#workflow-feature-list button[data-workflow="${id}"]`).click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(byId("workflow-catalog-dialog").open, false);
  };
  byId("btn-ptc-flow").click();
  assert.equal(byId("workflow-catalog-dialog").open, true);
  picker.value = "temu";
  picker.dispatchEvent(new window.Event("change"));
  assert.equal(choices().length, 0);
  assert.match(byId("workflow-feature-empty").textContent, /Temu 暂无/u);
  picker.value = "shopee";
  picker.dispatchEvent(new window.Event("change"));
  assert.deepEqual(choices().map(item => item.dataset.workflow), [
    "product-listing", "campaign-data", "campaign-draft", "voucher-data", "voucher-draft",
  ]);

  await launch("product-listing");
  assert.ok(listingOpened);
  openCatalog();

  for (const [id, title, readVisible] of [
    ["campaign-data", "活动数据", true],
    ["campaign-draft", "活动表单试填", false],
    ["voucher-data", "优惠券数据", true],
    ["voucher-draft", "优惠券表单试填", false],
  ]) {
    await launch(id);
    assert.equal(byId("shopee-marketing-dialog").open, true);
    assert.equal(byId("shopee-marketing-title").textContent, title);
    assert.equal(byId("shopee-marketing-read").hidden, !readVisible);
    assert.equal(byId("shopee-marketing-inspect").hidden, readVisible);
    assert.equal(byId("shopee-marketing-report").hidden, true);
    assert.equal(byId("shopee-marketing-preview").hidden, true);
    byId("shopee-marketing-back").click();
    assert.equal(byId("workflow-catalog-dialog").open, true);
  }
  picker.value = "tiktok-shop";
  picker.dispatchEvent(new window.Event("change"));
  assert.deepEqual(choices().map(item => item.dataset.workflow), ["tiktok-mx-draft"]);
  await launch("tiktok-mx-draft");
  assert.equal(selectedSkill.skillName, "TikTok 墨西哥商品草稿");
  assert.equal(byId("shopee-marketing-dialog").open, false);
});
