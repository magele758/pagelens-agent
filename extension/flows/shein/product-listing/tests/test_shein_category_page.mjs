import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinCategoryPage } from "../category-page.js";

const url = "https://sellerhub.shein.com/#/spmc/commodities-category/followsales-pro/list?externalSystem=spmp&last_page=page_commodities_list";
const path = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];

function fixture(t, { href = url, withBrand = false } = {}) {
  const dom = new JSDOM(`<main>
    <h1>发布商品</h1>
    <aside><button>厨房&amp;餐厅</button></aside>
    <section>
      <div role="tab">手动选择分类</div><input type="text">
      <div class="spmc_wrapper_QSELq">
        <div class="spmc_result_IyX_d"></div>
        <div class="spmc_panelWrapper_ngBoL"></div>
      </div>
      <div class="bottomAlert-4-2-1">
        <div id="selected"><span>已选分类：</span><span></span></div>
        <label>品牌<input placeholder="请选择品牌"></label>
        <button>上新检测</button><button id="next">确认，下一步</button><button id="publish">发布商品</button>
      </div>
    </section>
  </main>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document, HTMLElement } = dom.window;
  HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ x: 1, y: 1, height: 20, width: 80 }];
  };
  let advances = 0;
  let publishes = 0;
  const selected = [];
  const categories = document.querySelector(".spmc_panelWrapper_ngBoL");
  const leaf = document.querySelector("#selected span:last-child");
  const breadcrumb = document.querySelector(".spmc_result_IyX_d");
  const menu = [["鞋子", "家居&生活"], ["厨房&餐厅"], ["饮具", "餐具"], ["真空瓶和保温杯", "马克杯"]];
  function render() {
    categories.replaceChildren();
    for (let depth = 0; depth < Math.min(selected.length + 1, menu.length); depth++) {
      const column = document.createElement("div");
      const lastPanel = depth === menu.length - 1 ? "spmc_lastPanel_Otzv4" : "";
      column.className = `panel_${depth} spmc_panel_psTsn ${lastPanel}`;
      for (const [index, name] of menu[depth].entries()) {
        const option = document.createElement("div");
        const selectedClass = selected[depth] === name ? "spmc_selected_MviXe" : "";
        option.className = `panel_child_item_${2030 + depth * 10 + index} spmc_item_kgMhs ${selectedClass}`;
        const text = document.createElement("span");
        text.className = "spmc_itemContent_WXhBo";
        text.textContent = name;
        option.append(text);
        option.onclick = () => {
          selected.splice(depth, selected.length - depth, name);
          leaf.textContent = selected.length === menu.length ? name : "";
          breadcrumb.replaceChildren(...selected.map(name => {
            const crumb = document.createElement("span");
            crumb.textContent = name;
            return crumb;
          }));
          setTimeout(render, 5);
        };
        column.append(option);
      }
      categories.append(column);
    }
  }
  render();
  document.querySelector("#publish").onclick = () => publishes++;
  document.querySelector("#next").onclick = () => advances++;
  if (withBrand) {
    const input = document.querySelector('input[placeholder="请选择品牌"]');
    input.onclick = () => {
      const list = document.createElement("ul");
      list.setAttribute("role", "listbox");
      const option = document.createElement("li");
      option.textContent = "Sample brand";
      option.onclick = () => { input.value = option.textContent; list.remove(); };
      list.append(option);
      document.body.append(list);
    };
  }
  const run = async (args = {}) => {
    // Match Chrome's serialization boundary and copy plain values back out of JSDOM.
    const result = await dom.window.eval(`(${sheinCategoryPage})(${JSON.stringify({ href, ...args })})`);
    return JSON.parse(JSON.stringify(result));
  };
  return { run, document, advances: () => advances, publishes: () => publishes };
}

test("reads choices, selects the exact live path, and explicitly advances without publishing", async t => {
  const { run, advances, publishes } = fixture(t);
  assert.deepEqual(await run(), { ok: true, status: "ready", selectedPath: [], options: [["鞋子", "家居&生活"]], canAdvance: false });
  const result = await run({ kind: "select", categoryPath: path, brand: "" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.selectedPath, path);
  assert.equal(result.canAdvance, true);
  assert.equal(advances(), 0);
  assert.equal((await run({ kind: "advance", categoryPath: [...path.slice(0, -1), "马克杯"] })).code, "CATEGORY_NOT_CONFIRMED");
  assert.equal((await run({ kind: "advance", categoryPath: path, brand: "" })).status, "clicked");
  assert.equal(advances(), 1);
  assert.equal(publishes(), 0);
});

test("stays on the category page for a non-leaf input or a missing brand", async t => {
  const { run, advances } = fixture(t);
  assert.equal((await run({ kind: "select", categoryPath: path.slice(0, 2) })).code, "CATEGORY_NOT_CONFIRMED");
  assert.equal((await run({ kind: "select", categoryPath: path, brand: "Missing" })).code, "BRAND_MISSING");
  assert.equal(advances(), 0);
});

test("only uses the scoped brand control and accepts a manual category receipt", async t => {
  const { run, advances, document } = fixture(t, { withBrand: true });
  const result = await run({ kind: "select", categoryPath: path, brand: "Sample brand" });
  assert.deepEqual(result.selectedPath, path);
  assert.equal(document.querySelector('input[placeholder="请选择品牌"]').value, "Sample brand");
  assert.equal((await run({ kind: "advance" })).status, "clicked");
  assert.equal(advances(), 1);
});

test("rejects a changed route, invalid paths, and placeholder modals", async t => {
  const { run, document, advances } = fixture(t);
  assert.equal((await run({ href: "https://sellerhub.shein.com/#/spmp/commdities/list" })).code, "PAGE_CHANGED");
  assert.equal((await run({ kind: "select", categoryPath: [""] })).code, "CATEGORY_PATH_INVALID");
  const modal = document.createElement("div");
  modal.setAttribute("aria-modal", "true");
  document.body.append(modal);
  assert.equal((await run({ kind: "advance" })).code, "MODAL_BLOCKED");
  assert.equal(advances(), 0);
});

test("refuses duplicate rows at the same level without changing the selected category", async t => {
  const { run, advances, document } = fixture(t);
  const duplicate = document.querySelector(".panel_0 div:last-child").cloneNode(true);
  document.querySelector(".panel_0").append(duplicate);
  assert.equal((await run({ kind: "select", categoryPath: path })).code, "CATEGORY_AMBIGUOUS");
  assert.equal((await run()).selectedPath.length, 0);
  assert.equal(advances(), 0);
});
