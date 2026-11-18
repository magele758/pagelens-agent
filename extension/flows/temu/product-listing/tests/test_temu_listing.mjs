import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { replayTemuListing } from "../listing.flow.mjs";
import { createTemuListingToolCaller, isTemuDraftEditor } from "../tool-adapter.js";
import { temuDecorationPage } from "../decoration-page.js";
import { temuEditorPage } from "../editor-page.js";
import { temuMediaPage } from "../media-page.js";
import { temuSpecPage } from "../spec-page.js";

const category = "https://agentseller.temu.com/goods/create/category";
const editor = "https://agentseller.temu.com/goods/edit?productDraftId=9461&from=menu&st_time=10";
const title = { key: "productEnName", label: "英文商品名称", kind: "text", required: true, value: "" };
const material = { key: "productProperties[22]", label: "主体材质", kind: "select", required: true, options: [], value: "", locator: {} };
const price = {
  key: "productSkuMap.color-size.siteSupplierPriceMap.100", label: "申报价格（CNY）",
  skuGroup: "color-size", skuMember: "siteSupplierPriceMap.100", rowLabels: ["红色", "Small"],
};
const images = ["/products/cup/photo.png"];
const input = {
  sites: ["美国站"], categoryPath: ["运动与户外用品", "运动与户外休闲用品", "运动杯"], title: "Water Bottle",
  skus: [{ options: { Color: "红色", Size: "Small" }, price: "19.80" }], mainImages: images,
};

{
  const calls = [];
  const fields = structuredClone([title, material, price]);
  const state = { ok: true, fields, uploads: [{ role: "main", key: "album", multiple: false }], issues: [] };
  const receipt = await replayTemuListing({
    tabId: 1, input,
    async call(tool, args) {
      calls.push([tool, args]);
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return structuredClone(state);
      if (tool === "temu_field_options") return { ok: true, options: [{ label: "不锈钢", value: "metal" }] };
      if (tool === "temu_upload") return { ok: true, status: "verified" };
      if (/^temu_(write|select)$/u.test(tool)) {
        fields.find(field => field.key === args.key).value = args.value;
        return { ok: true, status: "filled" };
      }
      throw new Error("unexpected action: " + tool);
    },
    async suggestFields(product, schema) {
      assert.equal(product, input);
      assert.deepEqual(schema.fields.map(field => ({ key: field.key, options: field.options })), [
        { key: material.key, options: [{ label: "不锈钢", value: "metal" }] },
      ]);
      return { values: { [material.key]: "metal", unexpected: "discard" } };
    },
  });
  assert.equal(receipt.status, "ready-for-review");
  assert.equal(receipt.draftUrl, editor);
  assert.deepEqual(calls.filter(([tool]) => tool === "temu_write").map(([, args]) => args.value), ["Water Bottle", "19.80"]);
  assert.deepEqual(calls.find(([tool]) => tool === "temu_upload")[1].paths, images);
  assert.ok(!calls.some(([tool]) => /save|publish|submit/u.test(tool)));
}

{
  let failed = false;
  const result = await replayTemuListing({
    tabId: 1, input,
    async call(tool) {
      assert.equal(failed, false, "the flow must stop when the page changes");
      if (tool === "temu_category") return { ok: true, href: editor };
      if (tool === "temu_editor_state") return { ok: true, fields: [title], uploads: [], issues: [] };
      failed = true;
      return { ok: false, code: "PAGE_CHANGED" };
    },
  });
  assert.equal(result.status, "needs-review");
  assert.equal(result.code, "PAGE_CHANGED");
}

{
  assert.ok(isTemuDraftEditor(editor));
  assert.ok(!isTemuDraftEditor(editor + "&productDraftId=2"));
  assert.ok(!isTemuDraftEditor(editor + "&productId=2"));
  assert.ok(!isTemuDraftEditor(editor.replace("agentseller.temu.com", "agentseller.temu.com.attacker.invalid")));
  let url = editor;
  const api = { tabs: { get: async () => ({ url }) }, scripting: { executeScript: async () => {
    throw new Error("Must not touch an existing draft.");
  } } };
  const call = createTemuListingToolCaller({ tabId: 7, url, api, cdp: {} });
  assert.equal((await call("temu_write", { tabId: 7, key: title.key, value: input.title })).code, "ACTION_UNSUPPORTED");
  assert.equal((await call("temu_category", { tabId: 7 })).code, "PAGE_CHANGED");
  const original = createTemuListingToolCaller({ tabId: 7, url: category, api, cdp: {} });
  url = "https://agentseller.temu.com/login";
  assert.equal((await original("temu_category", { tabId: 7 })).code, "PAGE_CHANGED");
}

{
  let url = category;
  let documentId = "category-document";
  const scopes = [];
  const api = { tabs: { get: async () => ({ url }) }, scripting: { async executeScript({ target, args: [request] }) {
    const executedOn = documentId;
    scopes.push(target);
    if (request.kind === "next") {
      url = editor;
      documentId = "editor-document";
    }
    return [{ frameId: 0, documentId: executedOn, result: { ok: true, selector: "#album input" } }];
  } } };
  const call = createTemuListingToolCaller({ tabId: 7, url, api,
    cdp: { async send() { throw new Error("A changed page must never reach the debugger uploader."); } },
    confirmUpload: async () => { url = editor.replace("9461", "1322"); return true; } });
  assert.equal((await call("temu_category", { tabId: 7, site: "美国站", categoryPath: input.categoryPath })).href, editor);
  assert.deepEqual(scopes[1], { tabId: 7, documentIds: ["category-document"] });
  const upload = await call("temu_upload", { tabId: 7, role: "main", key: "album", paths: images });
  assert.equal(upload.code, "PAGE_CHANGED");
  assert.deepEqual(scopes[2], { tabId: 7, frameIds: [0] });
  assert.equal(scopes.length, 3);
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div>运动与户外用品 &gt; 运动与户外休闲用品 &gt; 运动杯</div>
    <div id="productEnName"><textarea maxlength="80"></textarea></div>
    <div id="productAlbum"><div>商品轮播图</div><input type="file" accept="image/*" multiple></div>
    <table><tbody>
      <tr><td rowspan="2">红色</td><td>Small</td><td><div id="productSkuMap.x.siteSupplierPriceMap.1"><input></div></td></tr>
      <tr><td>Medium</td><td><div id="productSkuMap.y.siteSupplierPriceMap.1"><input></div></td></tr>
    </tbody></table>
    <button>创建</button><button>保存草稿</button>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  let submits = 0;
  for (const button of dom.window.document.querySelectorAll("button")) button.addEventListener("click", () => submits++);
  const run = request => dom.window.eval(`(${temuEditorPage.toString()})(${JSON.stringify({ href: editor, ...request })})`);
  const state = await run({ kind: "inspect" });
  assert.ok(state.ok);
  assert.deepEqual(Array.from(state.fields.find(field => field.skuGroup === "y").rowLabels), ["Medium", "红色"]);
  assert.equal(state.uploads[0].role, "main");
  assert.equal((await run({ kind: "write", key: title.key, value: "Water Bottle" })).status, "filled");
  assert.equal((await run({ kind: "write", key: title.key, value: "x".repeat(81) })).code, "VALUE_INVALID");
  assert.equal((await run({ kind: "add-parent-spec" })).code, "SPEC_ADD_MISSING");
  assert.equal((await run({ kind: "inspect", categoryPath: input.categoryPath })).ok, true);
  assert.equal((await run({ kind: "write", categoryPath: ["茶具"], key: title.key, value: "Incorrect" })).code, "EDITOR_LOADING");
  assert.equal(submits, 0);
  const otherScope = await run({ kind: "write", href: editor.replace("9461", "9462"), key: title.key, value: "Other" });
  assert.equal(otherScope.code, "PAGE_CHANGED");
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div class="decoration_operate__test"><button>开始装修</button></div>
    <button id="publish">创建</button><button id="save-draft">保存草稿</button>
    <div class="MDL_inner_test" hidden>
      <h2>详情页装修</h2><div class="side-left_sectionItem__test"><span>文本</span></div>
      <textarea placeholder="请输入" hidden></textarea>
      <div class="footer_footer__test"><button>保存</button></div>
    </div>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const doc = dom.window.document;
  const dialog = doc.querySelector(".MDL_inner_test");
  const textarea = dialog.querySelector("textarea");
  let localDescription = "";
  let listingWrites = 0;
  const disallowed = () => { listingWrites++; };
  doc.querySelector("#publish").addEventListener("click", disallowed);
  doc.querySelector("#save-draft").addEventListener("click", disallowed);
  doc.querySelector(".decoration_operate__test button").addEventListener("click", () => { dialog.hidden = false; });
  dialog.querySelector("span").addEventListener("click", () => { textarea.hidden = false; });
  dialog.querySelector("button").addEventListener("click", () => { localDescription = textarea.value; dialog.hidden = true; });
  const description = "A travel cup.\nLid is washable.";
  const receipt = await dom.window.eval(`(${temuDecorationPage.toString()})(${JSON.stringify({ href: editor, description })})`);
  assert.equal(receipt.status, "verified");
  assert.equal(localDescription, description);
  assert.equal(listingWrites, 0);
  dom.window.close();
}

{
  const dom = new JSDOM(`<main id="page_container_id">
    <div><div id="minorSpec.0.selectedRootSpecId"><input></div>
    <table><thead><tr><th>* 颜色</th><th>操作</th></tr></thead><tbody><tr><td><input placeholder="请输入"></td>
      <td><button>+ 继续添加子规格</button></td></tr></tbody></table></div>
    <div id="noCostumeCarouselImgsI18n.common"><div class="upload-trigger_wrap__test"><span>素材中心</span></div></div>
    <div class="MDL_inner_test" hidden>
      <h2>素材中心</h2><div class="UPD_outerWrapper_test"><input type="file" multiple></div>
      <div class="cards"><div><img src="https://cdn.invalid/old"><span>main</span></div></div>
      <span class="selected">已选 0 个，可选 10 个</span><button>确认</button>
    </div>
  </main>`, { url: editor, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  const run = (script, request) => dom.window.eval(`(${script.toString()})(${JSON.stringify({ href: editor, ...request })})`);
  const doc = dom.window.document;
  const table = doc.querySelector("table");
  table.querySelector("button").addEventListener("click", () => { table.querySelector("tbody").insertAdjacentHTML("beforeend",
    '<tr><td><input placeholder="请输入"></td><td></td></tr>'); });
  const spec = await run(temuSpecPage, { parentIndex: 0, labels: ["颜色", "Color"], values: ["Sugar High", "Off the Grid"] });
  assert.equal(spec.ok, true);
  assert.deepEqual([...table.querySelectorAll("input")].map(input => input.value), ["Sugar High", "Off the Grid"]);
  const dialog = doc.querySelector(".MDL_inner_test");
  doc.querySelector("#page_container_id [class^=upload-trigger_wrap__] span").addEventListener("click", () => { dialog.hidden = false; });
  const action = args => run(temuMediaPage, { key: "noCostumeCarouselImgsI18n.common", filenames: ["main"], ...args });
  const opened = await action({ kind: "open" });
  assert.equal(opened.count, 0);
  let oldClicks = 0;
  dialog.querySelector("img").addEventListener("click", () => { oldClicks++; });
  assert.equal((await action({ kind: "select-new", previous: opened.knownMedia, baseline: 0 })).code, "UPLOAD_PENDING");
  dialog.querySelector(".cards").insertAdjacentHTML("afterbegin", '<div><img src="https://cdn.invalid/new"><span>main</span></div>');
  dialog.querySelector("img").addEventListener("click", () => { dialog.querySelector(".selected").textContent = "已选 1 个，可选 10 个"; });
  dialog.querySelector("button").addEventListener("click", () => { dialog.hidden = true; });
  assert.equal((await action({ kind: "select-new", previous: opened.knownMedia, baseline: 0 })).count, 1);
  assert.equal((await action({ kind: "confirm", baseline: 0, added: 1 })).ok, true);
  assert.equal(oldClicks, 0);
  dom.window.close();
}

console.log("Temu listing flow applies and verifies only its pinned newly created draft.");
