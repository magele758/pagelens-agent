import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinEditorPage } from "../editor-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];

function fixture(t) {
  const dom = new JSDOM(`<main>
    <h1>发布商品</h1>
    <div class="spmp_style__commodityCategoryItem--test"><span class="spmp_style__categoryInfo--test"></span></div>
    <input placeholder="请输入关键字">
    <div class="so-form-item main_name"><input placeholder="最多输入250个字符"></div>
    <div class="so-form-item main_desc"><textarea placeholder="最多输入5000个字符"></textarea></div>
    <div class="so-form-item supplier_code"><input placeholder="此商家自用编码，可自行编码输入"></div>
    <div class="item productAttrItem--hash soui-form-item-wrapper soui-form-item-wrapper-required">
      <div class="soui-form-item-label-wrapper">产品型号 <span>Product Model</span></div>
      <div class="soui-form-item-control"><input type="text"></div>
    </div>
    <div class="item productAttrItem--hash soui-form-item-wrapper soui-form-item-wrapper-required">
      <div class="soui-form-item-label-wrapper">产品功能 <span>Product Features</span></div>
      <div class="soui-form-item-control"><div id="features" class="soui-select soui-select-multiple soui-select-wrapper-empty">
        <div class="soui-select-result-wrapper"><div class="soui-select-result"><input type="text"></div></div>
      </div></div>
    </div>
    <div class="spmp_style__specContentRow--test"></div>
    <div class="so-form-item publish_site"><label><input type="checkbox">美国站</label></div>
    <button id="publish">发布商品</button><button id="save">保存草稿</button>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(">");
  HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ left: 1, top: 1, width: 50, height: 10 }];
  };
  let publications = 0;
  let saves = 0;
  let selectClicks = 0;
  const received = [];
  document.querySelector("#publish").onclick = () => publications++;
  document.querySelector("#save").onclick = () => saves++;
  document.querySelector(".main_name input").oninput = ev => received.push(ev.target.value);
  function setOptions(names, { commit = true } = {}) {
    const select = document.querySelector("#features");
    const opener = select.querySelector(".soui-select-result-wrapper");
    const display = select.querySelector(".soui-select-result");
    let menu;
    opener.onclick = () => {
      if (menu?.isConnected) { menu.remove(); return; }
      menu = document.createElement("div");
      menu.className = "soui-select-picker-wrapper merchant-ui-select-options";
      menu.style.opacity = "0";
      menu.innerHTML = '<div class="soui-select-list"><ul class="soui-select-virtual-list"><li class="soui-select-option">旧菜单</li></ul></div>';
      document.body.append(menu);
      setTimeout(() => {
        menu.style.opacity = "1";
        menu.querySelector("ul").replaceChildren(...names.map(name => {
          const row = Object.assign(document.createElement("li"), { className: "soui-select-option" });
          row.innerHTML = '<div class="soui-select-option-inner"><div class="attrValRenderItem--test"></div></div>';
          const title = row.querySelector('[class*="attrValRenderItem--"]');
          const bilingual = /^(.*\p{Script=Han})(\s+[A-Za-z].*)$/u.exec(name);
          title.textContent = bilingual?.[1] ?? name;
          if (bilingual) title.append(Object.assign(document.createElement('span'), {
            className: "attrValRenderItemEnText--test", textContent: bilingual[2],
          }));
          row.onclick = () => {
            selectClicks++;
            if (commit) {
              const chip = document.createElement("span");
              chip.className = "soui-select-multiple-result-item";
              chip.textContent = name;
              display.prepend(chip);
              select.classList.remove("soui-select-wrapper-empty");
            }
          };
          return row;
        }));
      }, 70);
    };
  }
  const run = async args => {
    const result = await dom.window.eval(`(${sheinEditorPage})(${JSON.stringify({ href, ...args,
      input: { categoryPath, ...args?.input } })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, document, setOptions, received, publications: () => publications, saves: () => saves, selectClicks: () => selectClicks };
}

test("fills English copy and live bilingual attributes and verifies selected chips", async t => {
  const { run, document, setOptions, received, publications, saves, selectClicks } = fixture(t);
  assert.deepEqual((await run()).fields.map(field => field.key), ["englishTitle", "englishDescription", "sellerSku",
    "attribute:产品型号 Product Model", "attribute:产品功能 Product Features"]);
  setOptions(["防漏", "保温", "便携"]);
  const result = await run({ kind: "fill", input: { englishTitle: "Steel Travel Tumbler", englishDescription: "Travel mug.", sellerSku: "SKU-01",
    attributes: { 产品型号: "T-01", "Product Features": ["保温", "便携"] } } });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.fields.at(-1).value, ["便携", "保温"]);
  assert.equal(result.items.length, 5);
  assert.deepEqual(received, ["Steel Travel Tumbler"]);
  assert.equal(document.querySelector('input[placeholder="请输入关键字"]').value, "");
  assert.equal(selectClicks(), 2);
  assert.equal(publications() + saves(), 0);
});

test("reports ambiguous options, missing required and oversized inputs", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["防漏", "防漏"]);
  const result = await run({ kind: "fill", input: { englishTitle: "x".repeat(251), attributes: { 产品功能: ["防漏"] } } });
  assert.equal(selectClicks(), 0);
  assert.deepEqual(result.issues.map(issue => issue.code), ["VALUE_TOO_LONG", "OPTION_AMBIGUOUS", "VALUE_REQUIRED", "VALUE_REQUIRED"]);
});

test("resolves the whole multiselect request before making changes", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["保温 Insulated", "防漏 Leakproof"]);
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温", "不存在"] } } });
  assert.ok(result.issues.some(issue => issue.code === "OPTION_MISSING"));
  assert.equal(selectClicks(), 0);
  const first = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温"] } } });
  assert.deepEqual(first.fields.at(-1).value, ["保温 Insulated"]);
  const next = await run({ kind: "fill", input: { attributes: { 产品功能: ["保温", "Leakproof"] } } });
  assert.deepEqual(next.fields.at(-1).value, ["防漏 Leakproof", "保温 Insulated"]);
  assert.equal(selectClicks(), 2);
});

test("resolves separately rendered English labels when the localized label starts with Latin text", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["Wi-Fi 功能 WiFi Function", "无 None"]);
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: "WiFi Function" } } });
  assert.deepEqual(result.fields.at(-1).value, ["Wi-Fi 功能 WiFi Function"]);
  assert.equal(selectClicks(), 1);
});

test("does not count a choice without actual readback", async t => {
  const { run, setOptions, selectClicks } = fixture(t);
  setOptions(["保温"], { commit: false });
  const result = await run({ kind: "fill", input: { attributes: { 产品功能: "保温" } } });
  assert.equal(selectClicks(), 1);
  assert.ok(result.issues.some(issue => issue.code === "VALUE_UNVERIFIED"));
  assert.deepEqual(result.items, []);
});

test("leaves a changed or blocked page untouched", async t => {
  const { run, document, received } = fixture(t);
  assert.deepEqual((await run()).categoryPath, categoryPath);
  assert.equal((await run({ kind: "fill", input: { categoryPath: [], englishTitle: "Do not write" } })).code, "CATEGORY_CHANGED");
  assert.equal((await run({ kind: "fill", input: { categoryPath: ["另外的类目"], englishTitle: "Do not write" } })).code, "CATEGORY_CHANGED");
  assert.equal((await run({ href: href.replace("mode=add", "mode=edit") })).code, "PAGE_CHANGED");
  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  assert.equal((await run({ kind: "fill", input: { englishTitle: "Do not write" } })).code, "MODAL_BLOCKED");
  assert.deepEqual(received, []);
});
