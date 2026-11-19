import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { sheinStockPage } from "../stock-page.js";

const href = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add&last_page=page_commodities_category";
const categoryPath = ["家居&生活", "厨房&餐厅", "饮具", "真空瓶和保温杯"];
const stock = (quantity, siteLabel = "美国", options = ["黑色"]) => ({ options, quantity, siteLabel });

function mount(t, { save = true } = {}) {
  const dom = new JSDOM(`
    <div class="spmp_style__commodityCategoryItem--fixture"><div class="spmp_style__categoryInfo--fixture"></div></div>
    <button id="publish">发布商品</button><button id="draft">保存草稿</button><button id="other">确定</button>
    <div class="spmp_style__supplyInfoTable--fixture">
      <button id="edit">编辑库存</button>
      <table><thead><tr><th>颜色</th><th>库存</th></tr></thead><tbody>
        <tr><td><div>黑色</div><div>SKC：<span>fixture-black</span></div></td><td>0</td></tr>
        <tr><td><div>白色</div><div>SKC：<span>fixture-white</span></div></td><td>0</td></tr>
      </tbody></table>
    </div>`, { url: href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  document.querySelector('[class*="spmp_style__categoryInfo--"]').textContent = categoryPath.join(" > ");
  dom.window.HTMLElement.prototype.getClientRects = function () {
    return this.closest("[hidden]") ? [] : [{ width: 40, height: 30 }];
  };
  const remote = { "黑色:美国": "0", "黑色:墨西哥": "7", "白色:美国": "0", "白色:墨西哥": "8" };
  const actions = [];
  for (const id of ["publish", "draft", "other"]) document.getElementById(id).onclick = () => actions.push(id);
  document.getElementById("edit").onclick = () => {
    actions.push("open");
    const stockModal = document.createElement("div");
    stockModal.className = "so-modal so-modal-show";
    stockModal.innerHTML = `<div class="so-modal-mask"><section class="so-modal-panel">
      <div class="so-card-header so-modal-title">库存维护</div>
      <div class="so-table">
      <div class="so-table-simple-header"><table><thead><tr><th>颜色</th><th>库存</th></tr></thead></table></div>
      <div class="so-table-simple-body"><table><tbody>
        ${["黑色", "白色"].map(color => `<tr><td><span>${color}</span><div>SKC：<span>fixture</span></div></td><td>
          ${["美国", "墨西哥"].map(site => `<div><div>${site}</div><span><input type="text" placeholder="请输入" data-stock="${color}:${site}" value="${remote[`${color}:${site}`]}" /></span></div>`).join("")}
        </td></tr>`).join("")}
      </tbody></table></div></div>
      <footer><button data-cancel>取消</button><button data-confirm>确定</button></footer>
    </section></div>`;
    stockModal.querySelector("[data-cancel]").onclick = () => { actions.push("cancel"); stockModal.remove(); };
    stockModal.querySelector("[data-confirm]").onclick = () => {
      actions.push("confirm");
      if (save) for (const control of stockModal.querySelectorAll("input")) remote[control.dataset.stock] = control.value;
      stockModal.remove();
    };
    for (const control of stockModal.querySelectorAll("input")) control.oninput = () => actions.push(control.dataset.stock);
    document.body.append(stockModal);
  };
  const run = async args => JSON.parse(JSON.stringify(await dom.window.eval(
    `(${sheinStockPage})(${JSON.stringify({ href, categoryPath, ...args })})`,
  )));
  return { run, remote, actions, document };
}

test("writes only requested SKU and site, reopens the owned dialog for readback, and skips a redundant confirmation", async t => {
  const { run, remote, actions } = mount(t);
  const filled = await run({ rows: [stock(1)] });
  assert.equal(filled.ok, true);
  assert.deepEqual(filled.items.map(({ label, status, value }) => [label, status, value]), [["黑色 · 美国库存", "verified", 1]]);
  assert.deepEqual(actions, ["open", "黑色:美国", "confirm", "open", "cancel"]);
  assert.deepEqual(remote, { "黑色:美国": "1", "黑色:墨西哥": "7", "白色:美国": "0", "白色:墨西哥": "8" });
  actions.length = 0;
  const unchanged = await run({ rows: [stock(1)] });
  assert.equal(unchanged.items[0].status, "unchanged");
  assert.deepEqual(actions, ["open", "cancel"]);
});

test("prevalidates all requested site and spec bindings before writing", async t => {
  const { run, remote, actions } = mount(t);
  assert.equal((await run({ rows: [stock(3), stock(2, "加拿大", ["白色"])] })).code, "STOCK_TARGET_MISSING");
  assert.equal((await run({ rows: [stock(3), stock(2)] })).code, "STOCK_INPUT_INVALID");
  assert.equal((await run({ rows: [stock(-1)] })).code, "STOCK_INPUT_INVALID");
  assert.equal((await run({ rows: [stock(3, "美国", ["蓝色"])] })).code, "STOCK_ROW_NOT_FOUND");
  assert.equal((await run({ rows: [stock(3)], categoryPath: ["别的类目"] })).code, "CATEGORY_CHANGED");
  assert.deepEqual(actions, ["open", "cancel"]);
  assert.equal(remote["黑色:美国"], "0");
});

test("fills multiple matched rows and an explicitly supplied zero in the same confirmation", async t => {
  const { run, remote, actions } = mount(t);
  const outcome = await run({ rows: [stock(3), stock(0, "墨西哥", ["白色"])] });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.items.map(item => item.value), [3, 0]);
  assert.equal(remote["黑色:美国"], "3");
  assert.equal(remote["白色:墨西哥"], "0");
  assert.equal(actions.filter(action => action === "confirm").length, 1);
});

test("does not report success if the confirmed stock does not persist in the dialog", async t => {
  const { run, remote, actions } = mount(t, { save: false });
  const failed = await run({ rows: [stock(3)] });
  assert.equal(failed.code, "STOCK_SAVE_UNVERIFIED");
  assert.equal(failed.items.length, 0);
  assert.equal(remote["黑色:美国"], "0");
  assert.deepEqual(actions, ["open", "黑色:美国", "confirm", "open", "cancel"]);
});
