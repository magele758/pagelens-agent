import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuApparelPage } from "../apparel-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=101";
const name = "PL女上装7ae31b";

function fixture(existing, { warnAboutFit = false, anchoredAttachment = false } = {}) {
  const dom = new JSDOM('<main id="page_container_id">' + `
    <section id="attached"><span>* 尺码表</span><button id="open">+ 添加尺码表</button></section>
    <button id="publish">创建</button><button id="save-draft">保存草稿</button>
    <div role="listbox" id="previous-menu" hidden><div role="option">之前的下拉选项</div></div>
    <div aria-modal="true" id="picker" hidden>
      <h2>选择尺码表模板</h2>
      <input data-testid="beast-core-select-htmlInput" readonly>
      <span tabindex="0" data-testid="beast-core-input-suffix"></span>
      <div role="listbox" hidden></div>
      <a id="create" href="#create-template">创建模板</a><button>确认</button><button>取消</button>
    </div>
    <div id="editor" data-placement="right" hidden>
      <div><span>创建模板</span></div>
      <div data-testid="beast-core-form-item"><span>* 模板名称</span><input maxlength="20"></div>
      <label><input id="default-mode" name="entry" type="radio">系统默认</label>
      <label><input name="entry" type="radio">手动录入</label>
      <div id="manual" hidden>
        <section id="garment">
          <h3>商品尺码表</h3><p>商品各个部位对应的长度</p>
          <label><input type="checkbox" disabled checked>胸围全围（cm）</label>
          <label><input type="checkbox" disabled checked>衣长（cm）</label>
          <table><thead><tr><th>尺码</th></tr></thead><tbody><tr><td>M</td></tr><tr><td>S</td></tr></tbody></table>
          <div>
            <table><thead><tr><th><div>胸围全围（cm）</div><span>测量示例</span></th>
              <th><div>衣长（cm）</div><span>平量拉量</span></th></tr></thead></table>
            <table id="garment-data"><tbody>
              <tr><td><input></td><td><input></td></tr><tr><td><input></td><td><input></td></tr>
            </tbody></table>
          </div>
        </section>
        <section id="body">
          <h3>基码表</h3><p>商品所适用的身体三围参数</p>
          <label><input id="chest" type="checkbox">胸围（CM）</label>
          <label><input id="height" type="checkbox">高度（CM）</label>
          <table><thead><tr><th>尺码</th>
            <th id="chest-column" hidden><div>胸围（CM）</div><label><input id="range" type="checkbox">范围</label></th>
            <th id="height-column" hidden><div>高度（CM）</div></th>
          </tr></thead></table>
          <table id="body-data"><tbody><tr><td>S</td><td></td><td></td></tr><tr><td>M</td><td></td><td></td></tr></tbody></table>
        </section>
      </div>
      <button disabled>确认</button><button>取消</button>
    </div>
    <div id="switch" hidden>
      <img alt=""><p>确认切换填写方式？ 切换后将清空原填写的尺码和参数信息</p><button>确认</button><button>取消</button>
    </div>
    <div id="unrelated-switch">
      <p>确认切换填写方式？ 仅供帮助中心参考</p><button>确认</button>
    </div>
    <div id="fit-warning" hidden>
      <h3>存在 <strong>3</strong> 个异常，请确认无误后再提交</h3>
      <table>
        <thead><tr><th>尺码参数</th><th>尺码</th><th>异常原因</th></tr></thead>
        <tbody>
          <tr><td>胸围全围</td><td>S、M、L、XL、XXL</td><td>档差不一致</td></tr>
          <tr><td>衣长</td><td>S、M、L、XL、XXL</td><td>档差不一致</td></tr>
          <tr><td>下摆围</td><td>S、M、L、XL、XXL</td><td>档差不一致</td></tr>
        </tbody>
      </table>
      <button>再检查一下</button><button>没问题，继续提交</button>
    </div>
    <div id="notice" hidden>
      <h3>【新功能】高合身率 TOP 商品</h3><button>我知道了</button>
    </div>
    <div id="other-notice"><h3>其他平台提示</h3><button>我知道了</button></div>
  </main>`, { url: href, runScripts: "outside-only" });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return this.closest("[hidden]") ? [] : [{}]; };
  const doc = window.document;
  const id = name => doc.getElementById(name);
  const picker = id("picker");
  const editor = id("editor");
  const mode = [...editor.querySelectorAll('input[type="radio"]')][1];
  let modeLoaded = false;
  const menu = picker.querySelector('[role="listbox"]');
  const selector = picker.querySelector("input");
  const reviews = { returned: 0, accepted: 0 };
  const actions = { created: 0, attached: 0, noticed: 0, forbidden: 0, switched: 0 };
  const button = (area, label) => [...area.querySelectorAll("button")].find(node => node.textContent === label);
  id("publish").addEventListener("click", () => { actions.forbidden++; });
  id("save-draft").addEventListener("click", () => { actions.forbidden++; });
  id("previous-menu").addEventListener("click", () => { actions.forbidden++; });
  id("other-notice").querySelector("button").addEventListener("click", () => { actions.forbidden++; });
  id("unrelated-switch").querySelector("button").addEventListener("click", () => { actions.forbidden++; });
  id("open").addEventListener("click", () => {
    if (!id("previous-menu").hidden) actions.forbidden++;
    picker.hidden = false;
  });
  picker.querySelector("[tabindex]").addEventListener("click", () => { menu.hidden = !menu.hidden; });
  menu.textContent = existing ? "" : "暂无数据";
  if (existing) {
    const option = doc.createElement("div");
    option.setAttribute("role", "option");
    option.textContent = name;
    option.addEventListener("click", () => { selector.value = name; menu.hidden = true; });
    menu.append(option);
  }
  id("create").addEventListener("click", () => {
    actions.created++;
    editor.hidden = false;
    id("notice").hidden = false;
    window.setTimeout(() => {
      modeLoaded = true;
      id("default-mode").checked = true;
    }, 175);
  });
  button(id("notice"), "我知道了").addEventListener("click", () => { actions.noticed++; id("notice").hidden = true; });
  mode.addEventListener("click", event => {
    event.preventDefault();
    if (modeLoaded) id("switch").hidden = false;
    else actions.forbidden++;
  });
  button(id("switch"), "确认").addEventListener("click", () => {
    actions.switched++;
    mode.checked = true;
    id("switch").hidden = true;
    id("manual").hidden = false;
  });
  id("chest").addEventListener("change", () => {
    id("chest-column").hidden = !id("chest").checked;
    for (const row of id("body-data").rows) row.cells[1].innerHTML = '<input placeholder="请输入">';
  });
  id("range").addEventListener("change", () => {
    for (const row of id("body-data").rows) row.cells[1].innerHTML = '<input placeholder="最小值"><input placeholder="最大值">';
  });
  id("height").addEventListener("change", () => {
    id("height-column").hidden = !id("height").checked;
    for (const row of id("body-data").rows) row.cells[2].innerHTML = '<input placeholder="请输入">';
  });
  editor.querySelector('input[maxlength="20"]').addEventListener("input", event => {
    button(editor, "确认").disabled = !event.target.value;
  });
  button(editor, "确认").addEventListener("click", () => {
    if (warnAboutFit) {
      id("fit-warning").hidden = false;
      return;
    }
    selector.value = editor.querySelector('input[maxlength="20"]').value;
    editor.hidden = true;
  });
  button(id("fit-warning"), "再检查一下").addEventListener("click", () => {
    reviews.returned++;
    id("fit-warning").hidden = true;
  });
  button(id("fit-warning"), "没问题，继续提交").addEventListener("click", () => { reviews.accepted++; });
  for (const modal of [picker, editor, id("switch")]) button(modal, "取消").addEventListener("click", () => { modal.hidden = true; });
  button(picker, "确认").addEventListener("click", () => {
    assert.equal(selector.value, name);
    actions.attached++;
    id("attached").innerHTML = anchoredAttachment
      ? '<label><span>*</span><b>尺码表</b></label><div id="productSizeTemplateIds"><p><strong>已添加</strong></p><a>查看</a><a>编辑</a><a aria-disabled="true">删除</a></div>'
      : '<span>* 尺码表</span><span>已添加</span><a>查看</a><a>编辑</a><a>删除</a>';
    picker.hidden = true;
  });
  return {
    close: () => window.close(),
    run: request => window.eval(`(${temuApparelPage.toString()})(${JSON.stringify({ href, ...request })})`),
    values: selector => [...doc.querySelectorAll(selector)].map(node => node.value),
    url: () => window.location.href,
    showTip: () => { id("notice").hidden = false; },
    showPreviousMenu: closeAfter => {
      const previous = id("previous-menu");
      previous.hidden = false;
      if (closeAfter != null) window.setTimeout(() => { previous.hidden = true; }, closeAfter);
    },
    isOpen: selector => !id(selector).hidden,
    actions,
    reviews,
  };
}

const normalized = { name, unit: "cm", rows: [
  { size: "S", garment: { chest: "96.01", length: "66.51" }, body: { chest: [86, 90], height: 165 } },
  { size: "M", garment: { chest: "101.6", length: "69.0" }, body: { chest: [90, 94], height: 170 } },
] };

{
  const page = fixture(false);
  assert.equal((await page.run({ kind: "dismiss-size-tip" })).status, "unchanged");
  page.showTip();
  assert.equal((await page.run({ kind: "dismiss-size-tip" })).status, "verified");
  assert.equal((await page.run({ kind: "dismiss-size-tip" })).status, "unchanged");
  assert.deepEqual(page.actions, { created: 0, attached: 0, noticed: 1, forbidden: 0, switched: 0 });
  page.close();
}

{
  const page = fixture(false);
  const result = await page.run({ kind: "create-size-chart", value: normalized });
  assert.equal(result.status, "verified", result.message);
  assert.equal(result.created, true);
  assert.equal(page.url(), href);
  assert.deepEqual(page.values("#garment-data input"), ["102", "69", "96", "67"]);
  assert.deepEqual(page.values("#body-data input"), ["86", "90", "165", "90", "94", "170"]);
  assert.deepEqual(page.actions, { created: 1, attached: 1, noticed: 1, forbidden: 0, switched: 1 });
  const already = await page.run({ kind: "create-size-chart", value: normalized });
  assert.equal(already.code, "SIZE_CHART_ALREADY_ATTACHED");
  assert.equal(page.actions.created, 1);
  page.close();
}

{
  const page = fixture(true);
  const result = await page.run({ kind: "create-size-chart", value: normalized });
  assert.equal(result.status, "verified", result.message);
  assert.equal(result.created, false);
  assert.deepEqual(page.actions, { created: 0, attached: 1, noticed: 0, forbidden: 0, switched: 0 });
  page.close();
}

{
  const page = fixture(true, { anchoredAttachment: true });
  page.showPreviousMenu(190);
  const result = await page.run({ kind: "create-size-chart", value: normalized });
  assert.equal(result.status, "verified", result.message);
  assert.equal(result.created, false);
  assert.equal(page.actions.attached, 1);
  assert.equal((await page.run({ kind: "create-size-chart", value: normalized })).code, "SIZE_CHART_ALREADY_ATTACHED");
  page.close();
}

{
  const page = fixture(true);
  page.showPreviousMenu();
  const result = await page.run({ kind: "create-size-chart", value: normalized });
  assert.equal(result.code, "MENU_STILL_OPEN");
  assert.equal(page.actions.forbidden, 0);
  assert.equal(page.actions.attached, 0);
  assert.equal(page.isOpen("previous-menu"), true);
  assert.equal(page.isOpen("picker"), false);
  page.close();
}

{
  const page = fixture(false);
  const result = await page.run({ kind: "create-size-chart", value: {
    ...normalized, rows: normalized.rows.map(({ body, ...row }) => row),
  } });
  assert.equal(result.code, "SIZE_CHART_BODY_REQUIRED");
  assert.deepEqual(page.actions, { created: 0, attached: 0, noticed: 0, forbidden: 0, switched: 0 });
  page.close();
}

{
  const page = fixture(false, { warnAboutFit: true });
  const result = JSON.parse(JSON.stringify(await page.run({ kind: "create-size-chart", value: normalized })));
  assert.equal(result.code, "SIZE_CHART_VALIDATION_WARNING");
  assert.deepEqual(result.warnings, ["胸围全围", "衣长", "下摆围"].map(measurement =>
    ({ measurement, sizes: "S、M、L、XL、XXL", reason: "档差不一致" })));
  assert.match(result.message, /3 个尺码异常.*胸围全围.*下摆围.*档差不一致/u);
  assert.deepEqual(page.reviews, { returned: 1, accepted: 0 });
  assert.equal(page.actions.attached, 0);
  assert.equal(page.isOpen("fit-warning"), false);
  assert.equal(page.isOpen("editor"), false);
  assert.equal(page.isOpen("picker"), false);
  page.close();
}

console.log("Temu creates or selects exact apparel templates; body ranges and row order are checked before attachment.");
