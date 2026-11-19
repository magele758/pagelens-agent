import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import { runMxDraftReprice } from "../native/mx-ptc-reprice.mjs";

const sourceId = "1738630710999877195";
const draftId = "1738630710999877196";
const link = `https://seller.tiktokshopglobalselling.com/product/edit-draft/${draftId}?shop_region=MX`;
const title = "Cuchilla para pan";
const baselinePricesMXN = [{ label: "Silver / 1 piece", priceMXN: 120 }, { label: "Dorado", priceMXN: 9.99 }];
const args = { sourceId, draftId, baselinePricesMXN, multiplier: 10 };
const original = [
  { label: "Silver / 1 piece", option: "Plata / 1 pza", stock: 0, priceMXN: 120 },
  { label: "Gold", option: "Dorado", stock: 3, priceMXN: 9.99 },
];
const listing = { title, salesAndShipping: { skus: original.map(({ option, stock, priceMXN }) => ({ option, stock, priceMXN })),
  origins: { "Plata / 1 pza.stock": { kind: "estimated", basis: "fixture" } } } };
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pagelens-reprice-test-"));
const home = process.env.PAGELENS_HOME;
process.env.PAGELENS_HOME = tmp;
const listingFile = path.join(tmp, "listing.json");
const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
await fs.writeFile(listingFile, JSON.stringify(listing));

function buildEditor(rows, documentEpoch) {
  const input = value => `<input role="spinbutton" value="${value}">`;
  const field = (id, value) => `<div data-id="product.publish.${id}">${value}</div>`;
  const dom = new JSDOM(`<body>
    <input data-id="product.publish.product_name" value="${title}">
    <input data-id="product.publish.title.input_lang" value="Bread lame">
    <div id="product-cascader-select-view">Cocina</div>
    ${field("description.local_lang", '<div class="ProseMirror">Cuchilla</div>')}
    <div data-id="product.widget.main_image.0"><img src="/test.jpg"></div>
    ${field("brand", '<span class="core-select-view-value">Marca</span>')}
    ${field("sale_property.name.1", '<span class="core-cascader-view-value">Color</span>')}
    ${rows.map(({ label, option }, id) => field("sale_property.value.name." + id,
      `<span class="pulse-input-tag-item">${label}</span><span class="pulse-input-tag-item">${option}</span>`)).join("")}
    <table>${rows.toReversed().map(({ label, stock, priceMXN }, id) => `<tr data-label="${label}"><td>${label}</td>
      <td>${field("skus.stock." + id, input(stock))}</td><td>${field("skus.sale_price." + id, input(priceMXN))}</td></tr>`).join("")}</table>
    <button id="draft">另存为草稿</button><button id="publish">提交</button></body>`, { url: link, runScripts: "outside-only" });
  const win = dom.window;
  Object.defineProperty(win.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
  Object.defineProperty(win.performance, "timeOrigin", { value: documentEpoch });
  win.HTMLElement.prototype.scrollIntoView = () => {};
  return dom;
}

let persisted = structuredClone(original), dom, epoch = 0, open = false, clicks = 0, reloads = 0, corruptStock = false;
const writes = [];
function render() {
  dom?.window.close();
  dom = buildEditor(persisted, ++epoch);
  const doc = dom.window.document;
  doc.querySelector("#publish").onclick = () => assert.fail("Repricing must never publish");
  doc.querySelector("#draft").onclick = () => {
    clicks++;
    for (const tr of doc.querySelectorAll("tbody tr")) {
      const row = persisted.find(row => row.label === tr.dataset.label);
      row.priceMXN = Number(tr.querySelector('[data-id*="sale_price"] input').value);
    }
    if (corruptStock) persisted[0].stock++;
    doc.body.insertAdjacentHTML("beforeend", `<p role="alert">草稿保存成功<a href="${link}"></a></p>`);
  };
}
const hooks = {
  async registeredListing(sid, did) {
    assert.deepEqual([sid, did], [sourceId, draftId]);
    assert.ok((await fs.stat(path.join(tmp, `tiktok-mx-${sourceId}.lock`))).isDirectory());
    return { copy: await readJson(listingFile), dir: tmp };
  },
  async request({ action, request: { tool, args } }) {
    assert.equal(action, "bridge_call");
    if (tool === "open_tab") {
      assert.equal(args.url, link);
      open = true;
      render();
      return { tabId: 7, groupId: 9 };
    }
    if (tool === "list_tabs") return open ? [{ id: 7, groupId: 9, url: link }] : [];
    assert.equal(args.tabId, 7);
    if (tool === "close_tab") { open = false; return {}; }
    if (tool === "reload_tab") { reloads++; render(); return {}; }
    if (tool === "trusted_type") {
      assert.match(args.selector, /skus\.sale_price\./);
      const input = dom.window.document.querySelector(args.selector);
      input.focus();
      input.value = args.value;
      writes.push({ label: input.closest("tr").dataset.label, price: args.value });
    } else if (tool === "press_keys") {
      assert.deepEqual(args.keys, ["Tab"]);
      dom.window.document.activeElement.blur();
      // Seller Center can allocate new row controls after the first commit.
      for (const field of dom.window.document.querySelectorAll('[data-id*=".skus."]')) field.dataset.id += "-r";
    } else if (tool === "run_js") {
      assert.ok(args.code.length <= 8000);
      return { ok: true, result: await dom.window.eval("(async()=>{" + args.code + "})()") };
    } else assert.equal(tool, "activate_tab");
    return { ok: true };
  },
};

try {
  await assert.rejects(runMxDraftReprice({ ...args, baselinePricesMXN: baselinePricesMXN.slice(0, 1) }, hooks), /every SKU/);
  await assert.rejects(runMxDraftReprice({ ...args, baselinePricesMXN: [{ label: "Silver / 1 piece", priceMXN: 121 }, baselinePricesMXN[1]] }, hooks),
    /baseline and target/);
  assert.equal(clicks, 0);
  assert.deepEqual(writes, []);

  reloads = 0;
  const receipt = await runMxDraftReprice(args, hooks);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.changed, true);
  assert.equal(receipt.expectedPlanUpdated, true);
  assert.deepEqual(receipt.prices, [
    { label: "Silver / 1 piece", stock: 0, beforeMXN: 120, afterMXN: 1200 },
    { label: "Gold", stock: 3, beforeMXN: 9.99, afterMXN: 99.9 },
  ]);
  assert.deepEqual(writes, [{ label: "Silver / 1 piece", price: "1200" }, { label: "Gold", price: "99.9" }]);
  assert.deepEqual([clicks, reloads], [1, 2]);
  assert.equal((await readJson(receipt.receiptFile)).draftId, draftId);
  const updated = await readJson(listingFile);
  assert.deepEqual(updated.salesAndShipping.skus.map(({ stock, priceMXN }) => [stock, priceMXN]), [[0, 1200], [3, 99.9]]);
  assert.equal(updated.salesAndShipping.origins["Dorado.priceMXN"].verified, true);
  assert.deepEqual(updated.salesAndShipping.origins["Plata / 1 pza.stock"], listing.salesAndShipping.origins["Plata / 1 pza.stock"]);

  const repeated = await runMxDraftReprice(args, hooks);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.expectedPlanUpdated, false);
  assert.deepEqual([clicks, writes.length], [1, 2]);

  persisted = structuredClone(original);
  corruptStock = true;
  await assert.rejects(runMxDraftReprice(args, hooks), /Unexpected stock change/);
  assert.equal(clicks, 2);
  assert.deepEqual(await readJson(listingFile), updated);
  assert.ok(!(await fs.readdir(tmp)).some(name => name.endsWith(".lock")));
  console.log("MX draft repricing verified only exact SKU targets, readback, and idempotent retries");
} finally {
  dom?.window.close();
  if (home === undefined) delete process.env.PAGELENS_HOME;
  else process.env.PAGELENS_HOME = home;
  await fs.rm(tmp, { recursive: true, force: true });
}
