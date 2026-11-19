import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { editorSubmitCode, sellerListCode } from "../native/mx-seller-page.mjs";
import { mxManageUrl, mxDraftUrl, mxSellerRequest, mxSellerUrlAllowed } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";

const productId = "1738630710999877196";
const otherId = "1738630711000270412";
const active = mxManageUrl + "&tab=active";
const draft = mxDraftUrl(productId);

function sellerDocument(html, url) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "innerText", {
    get() { return this.textContent; },
  });
  dom.window.HTMLElement.prototype.getClientRects = () => ({ length: 1 });
  return {
    window: dom.window, document: dom.window.document,
    run(code) { return dom.window.eval("(async()=>{" + code + "})()"); },
  };
}

function productRow(id, state, prefix = "ID") {
  return `<tr><td>Un título igual\n${prefix}:${id}</td><td>${state}</td><td><button id="x${id}">下架</button></td></tr>`;
}

const table = rows => `<h1>商品管理</h1><table><thead><tr><th>商品</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`;

{
  const page = sellerDocument(table(productRow(otherId, "在售") + productRow(productId, "审核中 今日")), active);
  const observed = await page.run(sellerListCode(active, productId));
  assert.equal(observed.productId, productId);
  assert.equal(observed.status, "under_review");
  await assert.rejects(page.run(sellerListCode(active, productId, "delist")), /no longer in the active state/);
  page.window.close();
}
{
  const page = sellerDocument(table(productRow(otherId, "在售") + productRow(productId, "在售", "SKU ID") + productRow(productId, "在售")), active);
  const clicks = [];
  for (const button of page.document.querySelectorAll("button")) button.onclick = () => clicks.push(button.id);
  assert.equal((await page.run(sellerListCode(active, productId, "delist"))).dispatched, true);
  assert.deepEqual(clicks, ["x" + productId]);
  assert.equal((await page.run(sellerListCode(active, "123456789012", "delist"))).status, "not_found");
  page.window.close();
}
{
  const page = sellerDocument(table(productRow(productId, "在售") + productRow(productId, "在售")), active);
  await assert.rejects(page.run(sellerListCode(active, productId, "delist")), /More than one/);
  page.window.close();
}
{
  const page = sellerDocument("<button>提交审核</button>", draft);
  const button = page.document.querySelector("button");
  let clicks = 0;
  button.onclick = () => {
    clicks++;
    page.document.body.insertAdjacentHTML("beforeend", '<div role="dialog">提交前请阅读并同意协议<button>同意</button></div>');
  };
  await assert.rejects(page.run(editorSubmitCode(mxDraftUrl(otherId), ["提交审核"])), /changed/);
  assert.match((await page.run(editorSubmitCode(draft, ["提交审核"]))).dialog, /同意协议/);
  await assert.rejects(page.run(editorSubmitCode(draft, ["提交审核"])), /unexpected seller dialog/);
  assert.equal(clicks, 1);
  page.window.close();
}
{
  const request = { mode: "publish_draft", sourceId: "1733781903228241493", draftId: productId };
  assert.throws(() => mxSellerRequest(request), /request fields/);
  const offer = { brand: "无品牌", packagedWeightGrams: 480, packageCm: { width: 14, height: 12, length: 24 },
    skus: [{ label: "Silver / 1 piece", stock: 1, priceMXN: 1200 }] };
  assert.equal(mxSellerRequest({ ...request, offer }).offer.skus[0].priceMXN, 1200);
  assert.throws(() => mxSellerRequest({ ...request, offer: { ...offer, skus: [{ label: "Silver", priceMXN: 1200 }] } }), /request fields/);
  assert.equal(mxSellerUrlAllowed(request, draft), true);
  assert.equal(mxSellerUrlAllowed(request, mxDraftUrl(otherId)), false);
  assert.equal(mxSellerUrlAllowed(request, active.replace("MX", "JP")), false);
  assert.equal(mxSellerUrlAllowed({ mode: "read_orders" }, "https://seller.tiktokshopglobalselling.com/order?tab=to_ship"), true);
  assert.equal(mxSellerUrlAllowed({ mode: "read_orders" }, "https://seller.tiktokshopglobalselling.com/order?shop_region=MX&shop_region=JP"), false);
}
{
  const request = { mode: "reprice_draft", sourceId: "1733781903228241493", draftId: productId,
    multiplier: 100, baselinePricesMXN: [{ label: "Silver / 1 piece", priceMXN: 120 }] };
  assert.deepEqual(mxSellerRequest(request), request);
  assert.deepEqual(mxSellerRequest({ ...request, maxTotalStock: 10 }), { ...request, maxTotalStock: 10 });
  assert.throws(() => mxSellerRequest({ ...request, maxTotalStock: 11 }), /stock limit/);
  assert.throws(() => mxSellerRequest({ ...request, multiplier: 1000 }), /multiplier/);
}

console.log("PASS exact product row, one-click submission, offer data and seller scope");
