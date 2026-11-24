import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { mountProductListingDialog } from "../sidepanel/dialog.js";
import { bindPtcFlow } from "../sidepanel/flow-ui.js";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const shopUrl = "https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=1901697826";
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test("product view requires consent for an explicit size chart even without uploaded images", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const activatedListeners = [];
  let accessRequests = 0;
  let tab = { id: 12, windowId: 1, url: shopUrl };

  globalThis.document = document;
  globalThis.chrome = {
    permissions: {
      contains() { accessRequests++; return Promise.resolve(false); },
      request() { accessRequests++; return Promise.resolve(false); },
    },
    tabs: {
      onActivated: { addListener(listener) { activatedListeners.push(listener); } },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => tab,
      chooseDirectory: async () => ({ root: "/Products", directoryName: "Products",
        products: [{ title: "Shirt", folder: "shirt", input: { sizeChart: {} } }], issues: [] }),
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    assert.equal(mountProductListingDialog(), dialog);
    assert.equal(document.querySelectorAll('link[rel="stylesheet"]').length, 1);
    assert.equal(open(), true);
    await nextTurn();
    assert.equal(byId("ptc-input"), null);
    assert.equal(byId("ptc-directory-path"), null);
    assert.equal(byId("ptc-batch-start").textContent, "创建商品");
    assert.equal(byId("ptc-batch-publish").textContent, "创建并上架");
    assert.equal(byId("ptc-batch-start").disabled, true);
    assert.equal(byId("ptc-batch-publish").disabled, true);
    byId("ptc-load-directory").click();
    await nextTurn();
    assert.equal(byId("ptc-batch-consent-row").hidden, false);
    assert.match(byId("ptc-batch-consent-text").textContent, /模型估算/u);
    assert.match(byId("ptc-batch-consent-text").textContent, /创建尺码表/u);
    assert.equal(byId("ptc-batch-start").disabled, true);
    assert.equal(byId("ptc-batch-ai-consent").checked, false);

    byId("ptc-batch-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
    assert.equal(accessRequests, 0);

    const consent = byId("ptc-batch-upload-consent");
    consent.checked = true;
    consent.dispatchEvent(new window.Event("change"));
    assert.equal(byId("ptc-batch-start").disabled, false);
    assert.equal(byId("ptc-batch-publish").disabled, false);
    byId("ptc-batch-ai-consent").checked = true;
    tab = { ...tab, url: shopUrl.replace("1901697826", "1234") };
    activatedListeners[0]();
    await nextTurn();
    assert.equal(consent.checked, false);
    assert.equal(byId("ptc-batch-ai-consent").checked, false);
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});

test("starts the selected write mode with a bounded concurrency and shows verified receipt IDs", async () => {
  const { window } = new JSDOM("<!doctype html><body></body>");
  const { document } = window;
  const originalDocument = globalThis.document;
  const originalChrome = globalThis.chrome;
  const tab = { id: 12, windowId: 1, url: shopUrl };
  const starts = [];
  globalThis.document = document;
  globalThis.chrome = {
    permissions: { contains: async () => true },
    tabs: {
      query: async () => [tab],
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: { getURL: path => "chrome-extension://test/" + path, onMessage: { addListener() {} } },
  };
  try {
    const open = bindPtcFlow({
      getTargetTab: async () => tab,
      chooseDirectory: async () => ({
        root: "/Products", directoryName: "Products",
        products: [{ title: "Shirt", folder: "shirt", input: {} }], issues: [],
      }),
      startBatch: async ({ mode, concurrency, onJob }) => {
        starts.push({ mode, concurrency });
        const status = mode === "create" ? "created" : "published";
        onJob(0, { phase: status, tabId: null, receipt: { status, globalItemId: "654321" } });
      },
    });
    const byId = id => document.getElementById(id);
    const dialog = byId("ptc-flow-dialog");
    dialog.showModal ??= () => { dialog.open = true; };
    open();
    await nextTurn();
    const concurrency = byId("ptc-batch-concurrency");
    const create = byId("ptc-batch-start");
    const publish = byId("ptc-batch-publish");
    assert.equal(concurrency.valueAsNumber, 5);
    byId("ptc-load-directory").click();
    await nextTurn();
    concurrency.value = "11";
    concurrency.dispatchEvent(new window.Event("input"));
    assert.equal(create.disabled, true);
    assert.equal(publish.disabled, true);
    publish.click();
    assert.deepEqual(starts, []);
    concurrency.value = "5";
    concurrency.dispatchEvent(new window.Event("input"));
    create.click();
    await nextTurn();
    assert.deepEqual(starts, [{ mode: "create", concurrency: 5 }]);
    assert.match(byId("ptc-batch-status").textContent, /已创建 1\/1/u);
    assert.match(byId("ptc-batch-jobs").textContent, /全球商品 ID 654321/u);
    assert.equal(byId("ptc-batch-jobs").querySelector("button").hidden, true);

    concurrency.value = "10";
    concurrency.dispatchEvent(new window.Event("input"));
    publish.click();
    await nextTurn();
    assert.deepEqual(starts, [{ mode: "create", concurrency: 5 }, { mode: "publish", concurrency: 10 }]);
    assert.match(byId("ptc-batch-status").textContent, /已提交上架 1\/1/u);
  } finally {
    globalThis.document = originalDocument;
    globalThis.chrome = originalChrome;
    window.close();
  }
});
