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
    assert.equal(byId("ptc-batch-start").textContent, "开始上品");
    assert.equal(byId("ptc-batch-start").disabled, true);
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
