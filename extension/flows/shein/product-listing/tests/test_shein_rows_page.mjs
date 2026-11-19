import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinRowsPage } from "../rows-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];

function fixture(t) {
  const dom = new JSDOM(`<main>
    <h1>发布商品</h1>
    <div class="spmp_style__commodityCategoryItem--test"><span class="spmp_style__categoryInfo--test"></span></div>
    <div class="so-table spmp_style__supplyInfoTable--test" id="supply"></div>
    <div class="so-table" id="package"></div>
    <div class="spmp_style__sizeContentBox--test"><div class="so-table" id="size"></div></div>
    <div class="detail_img_container"><div class="so-table" id="media"></div></div>
    <button id="publish">发布商品</button><button id="save">保存草稿</button>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(">");
  HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ left: 1, top: 1, width: 50, height: 10 }];
  };
  let publishes = 0;
  let saves = 0;
  document.getElementById("publish").onclick = () => publishes++;
  document.getElementById("save").onclick = () => saves++;
  function table(id, headers, rows) {
    // SHEIN uses separate tables for the fixed header and scrollable body.
    document.getElementById(id).innerHTML = `<div class="so-table-head"><table><thead><tr>${headers.map(header => `<th>${header}</th>`).join("")}</tr></thead></table></div>
      <div class="so-table-body"><table><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  }
  const packageDimensions = '<input placeholder="长(最长边)"><input placeholder="宽(次长边)"><input placeholder="高(最短边)">';
  table("supply", ["颜色", "尺码", "价格(USD)", "商家SKU", "SKU图"], [
    ["黑色 SKC: existing-key", "500 ml", '<input id="black-price">', '<input id="black-code">', '<input type="file" accept="image/png,image/jpeg">'],
    ["红色", "500 ml", '<input id="red-price">', '<input id="red-code">', '<input type="file" accept="image/png,image/jpeg">'],
  ]);
  table("package", ["含包装尺寸", "颜色", "含包装重量 (g)", "尺码", "包装类型"], [
    [packageDimensions, "红色", '<input id="red-weight">', "500 ml", "-"],
    [packageDimensions, "黑色", '<input id="black-weight">', "500 ml", "-"],
  ]);
  table("size", ["宽度 (cm)", "长度 (cm)", "高度 (cm)", "直径 (cm)"], [Array(4).fill("<input>")]);
  table("media", ["颜色", "细节图", "方形图", "色块图"], [
    ["黑色", '<div><input type="file" accept="image/png,image/jpeg"></div>', '<div><input type="file" accept="image/png,image/jpeg"></div>', '<div><input type="file" accept="image/png,image/jpeg"></div>'],
    ["红色", '<div><input type="file" accept="image/png,image/jpeg"></div>', '<div><input type="file" accept="image/png,image/jpeg"></div>', '<div><input type="file" accept="image/png,image/jpeg"></div>'],
  ]);
  const run = async args => {
    const result = await dom.window.eval(`(${sheinRowsPage})(${JSON.stringify({ href, categoryPath, ...args })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, document, window: dom.window, publishes: () => publishes, saves: () => saves };
}

test("reads split SHEIN tables and updates only the matching SKU across different header and row orders", async t => {
  const { run, document, publishes, saves } = fixture(t);
  const inspected = await run();
  assert.deepEqual(inspected.tables.supply, [["黑色", "500 ml"], ["红色", "500 ml"]]);
  assert.deepEqual(inspected.tables.package, [["红色", "500 ml"], ["黑色", "500 ml"]]);
  const row = { options: ["黑色", "500 ml"], priceUsd: "12.50", sellerSku: "PL-01", weightG: 331, lengthCm: 22, widthCm: 10, heightCm: 9 };
  const result = await run({ kind: "fill", rows: [row], dimensions: { widthCm: 9, lengthCm: 21, heightCm: 8, diameterCm: 7 } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.items.length, 10);
  assert.equal(document.getElementById("black-price").value, "12.50");
  assert.equal(document.getElementById("black-code").value, "PL-01");
  assert.equal(document.getElementById("black-weight").value, "331");
  assert.deepEqual([...document.querySelectorAll("#package tbody tr")].map(row => [...row.cells[0].querySelectorAll("input")].map(input => input.value)), [
    ["", "", ""], ["22", "10", "9"],
  ]);
  assert.deepEqual([...document.querySelectorAll("#size input")].map(input => input.value), ["9", "21", "8", "7"]);
  assert.equal(document.getElementById("red-price").value, "");
  assert.equal(document.getElementById("red-weight").value, "");
  const repeated = await run({ kind: "fill", rows: [row] });
  assert.equal(repeated.items.length, 6);
  assert.ok(repeated.items.every(item => item.status === "unchanged"));
  assert.equal(publishes() + saves(), 0);
});

test("rejects unbound categories, duplicate SKU rows and invalid positive amounts", async t => {
  const { run, document } = fixture(t);
  const request = { kind: "fill", rows: [{ options: ["黑色", "500 ml"], priceUsd: "-1" }] };
  assert.equal((await run({ ...request, categoryPath: ["鞋子"] })).code, "SHEIN_EDIT_CONTEXT_CHANGED");
  assert.equal((await run(request)).issues[0].code, "SHEIN_ROW_FIELD");
  const table = document.querySelector("#supply tbody");
  table.append(table.rows[0].cloneNode(true));
  const duplicate = await run({ kind: "fill", rows: [{ options: ["黑色", "500 ml"], priceUsd: "1.29" }] });
  assert.deepEqual(duplicate.items, []);
  assert.equal(duplicate.issues[0].code, "SHEIN_ROW_FIELD");
  assert.ok([...document.querySelectorAll("#supply input")].every(input => input.value === ""));
});

test("binds the selected SKC image cell and waits for the remote preview instead of counting the local blob", async t => {
  const { run, document, window } = fixture(t);
  window.DataTransfer = class {
    files = [];
    items = { add: file => this.files.push(file) };
  };
  const black = document.querySelector('#media tbody tr:first-child td:nth-child(2) input');
  const red = document.querySelector('#media tbody tr:last-child td:nth-child(2) input');
  Object.defineProperty(black, "files", { value: [], writable: true });
  let called = 0;
  let serverPreview = false;
  black.onchange = () => {
    called++;
    const preview = document.createElement("img");
    preview.src = "blob:https://sellerhub.shein.com/local";
    black.parentElement.append(preview);
    setTimeout(() => {
      serverPreview = true;
      preview.src = "https://example.test/confirmed.png";
    }, 110);
  };
  red.onchange = () => assert.fail("different SKC upload attempted");
  const upload = await run({ kind: "upload", upload: { role: "detail", options: ["黑色"],
    files: [{ name: "sample.png", type: "image/png", base64: "iVBORw0KGgo=" }] } });
  assert.deepEqual(upload, { ok: true, status: "verified" });
  assert.equal(called, 1);
  assert.equal(serverPreview, true);
  assert.equal(black.files[0].name, "sample.png");
  assert.equal(red.files.length, 0);
});
