import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuEditorPage } from "../editor-page.js";

const editor = "https://agentseller.temu.com/goods/edit?productDraftId=42";
const categoryPath = ["服装", "女士上衣"];
const fit = new JSDOM(`
  <main id="page_container_id">
    <div>服装 &gt; 女士上衣</div>
    <div id="productProperties[9]"></div>
    <div id="productName" hidden>
      <div data-testid="beast-core-form-item">
        <div class="Form_itemLabelContent_test"><span>*</span><span>商品名称</span></div>
        <div><textarea id="generated-1" maxlength="150"></textarea></div>
      </div>
      <div data-testid="beast-core-form-item">
        <span id="english-label">英文名称</span>
        <div><textarea aria-labelledby="english-label" maxlength="150"></textarea></div>
      </div>
    </div>
    <table id="sku-table"><tbody><tr><td rowspan="2">黑白条纹</td><td>S</td>
      <td><div id="productSkuVolumeWeightMap.s1.inputWeight"><input id="generated-2" type="number" min="1"></div></td>
      <td><div id="productSkuMap.s1.siteSupplierPriceMap.100"><input id="generated-3" type="number" min="0.01"></div></td>
    </tr><tr><td>M</td><td></td>
      <td><div id="productSkuMap.s2.siteSupplierPriceMap.100"><input id="generated-4" type="number" min="0.01"></div></td>
    </tr></tbody></table>
    <div id="productSkcList[0].mainSpec[0]">
      <div class="colour-spec-select_colorSpecSelect__test">
        <input data-testid="beast-core-input-htmlInput" placeholder="花色">
      </div>
    </div>
    <div id="productSkcList[0].carouselImgsI18n.common">
      <div class="upload-trigger_wrap__test">素材中心</div>
      <img src="https://images.example/hero.jpg?thumbnail=300">
    </div>
    <button>创建</button>
  </main>`, { url: editor, runScripts: "outside-only" });
const { document } = fit.window;
fit.window.HTMLElement.prototype.getClientRects = function () {
  return this.closest("[hidden]") ? [] : [{}];
};
const call = request => fit.window.eval(`(${temuEditorPage.toString()})(${JSON.stringify({ href: editor, categoryPath, ...request })})`);
assert.equal((await call({ kind: "inspect" })).code, "EDITOR_LOADING");
document.querySelector("#productName").hidden = false;
const found = await call({ kind: "inspect" });
assert.equal(found.ok, true);
assert.deepEqual(Array.from(found.fields, field => [field.key, field.label, field.required]), [
  ["productName", "中文商品名称", true],
  ["productEnName", "英文商品名称", true],
  ["productSkuVolumeWeightMap.s1.inputWeight", "重量", true],
  ["productSkuMap.s1.siteSupplierPriceMap.100", "申报价格(CNY)", true],
  ["productSkuMap.s2.siteSupplierPriceMap.100", "申报价格(CNY)", true],
]);
assert.deepEqual(Array.from(found.fields.find(field => field.skuMember === "inputWeight").rowLabels), ["黑白条纹", "S"]);
assert.equal(found.uploads[0].variant, "花色");
assert.deepEqual(Array.from(found.uploads[0].images), ["https://images.example/hero.jpg"]);
assert.equal((await call({ kind: "write", key: "productName", value: "女士条纹 T 恤" })).status, "filled");
assert.equal((await call({ kind: "write", key: "productEnName", value: "Women's Stripe Tee" })).status, "filled");
assert.equal((await call({ kind: "write", key: "productSkuVolumeWeightMap.s1.inputWeight", value: "230" })).status, "filled");
assert.deepEqual([...document.querySelectorAll("textarea")].map(field => field.value), ["女士条纹 T 恤", "Women's Stripe Tee"]);
assert.equal(document.getElementById("generated-2").value, "230");

const weight = document.getElementById("generated-2");
const firstPrice = document.getElementById("generated-3");
const secondPrice = document.getElementById("generated-4");
weight.parentElement.style.border = "1px solid rgb(250, 50, 25)";
secondPrice.style.borderBottom = "1px solid red";
secondPrice.parentElement.insertAdjacentHTML("afterend", '<div style="color: red">申报价格不能为空</div>');
firstPrice.parentElement.insertAdjacentHTML("afterend", '<label style="color: red">请检查平台规则</label>');
document.getElementById("sku-table").insertAdjacentHTML("beforebegin", '<p style="color:red">请查看全局帮助</p>');
const validated = JSON.parse(JSON.stringify(await call({ kind: "inspect" })));
assert.deepEqual(validated.validation, [
  { key: "productSkuMap.s2.siteSupplierPriceMap.100", label: "申报价格(CNY)", kind: "text", rowLabels: ["M", "黑白条纹"],
    message: "申报价格不能为空" },
  { key: "productSkuVolumeWeightMap.s1.inputWeight", label: "重量", kind: "text", rowLabels: ["黑白条纹", "S"],
    message: "当前控件校验未通过" },
]);
assert.deepEqual(validated.issues, ["申报价格不能为空", "当前控件校验未通过"]);

const english = document.querySelector('textarea[aria-labelledby="english-label"]');
english.after(english.cloneNode());
assert.equal((await call({ kind: "write", key: "productEnName", value: "Ambiguous title" })).code, "FIELD_MISSING");
assert.equal(english.value, "Women's Stripe Tee");
fit.window.close();
console.log("Temu requires real title controls before editor replay and preserves SKU field identity.");
