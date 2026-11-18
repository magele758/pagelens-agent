import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { temuDecorationPage } from "../decoration-page.js";
import { temuMediaPage } from "../media-page.js";

const href = "https://agentseller.temu.com/goods/edit?productDraftId=9461";

function fixture(html) {
  const dom = new JSDOM(`<main id="page_container_id">${html}</main>`, { url: href, runScripts: "outside-only" });
  dom.window.HTMLElement.prototype.getClientRects = () => [{}];
  return {
    dom, doc: dom.window.document,
    run: (page, request) => dom.window.eval(`(${page.toString()})(${JSON.stringify({ href, ...request })})`),
  };
}

{
  const key = "productSkcList[0].carouselImgsI18n.common";
  const filenames = ["red-main", "fabric", "fit"];
  const { dom, doc, run } = fixture(`
    <div id="${key}"><div class="upload-trigger_wrap__test"><span>素材中心</span></div></div>
    <div class="MDL_inner_picker" hidden><h2>素材中心</h2><div class="UPD_outerWrapper_test"><input type="file"></div>
      <div id="cards"></div><div id="count">已选 0 个，可选 10 个</div><button>确认</button></div>
    <div class="MDL_inner_upload" hidden><h2>本地上传</h2><button id="upload-save">保存</button></div>
    <div class="MDL_inner_crop" hidden><h2>裁剪</h2><button id="crop-submit">确认裁剪</button></div>
    <div class="MDL_inner_unexpected" hidden><h2>其他弹窗</h2><button id="unrelated-save">保存</button></div>
    <button id="page-save">保存</button>`);
  const picker = doc.querySelector(".MDL_inner_picker");
  const upload = doc.querySelector(".MDL_inner_upload");
  const crop = doc.querySelector(".MDL_inner_crop");
  const unrelated = doc.querySelector(".MDL_inner_unexpected");
  const cards = doc.querySelector("#cards");
  const count = doc.querySelector("#count");
  const events = [];
  const clicked = [];
  let file;

  function addCard(name, identity) {
    cards.insertAdjacentHTML("afterbegin", `<div data-material-id="${identity}"><img src="https://cdn.invalid/${identity}?thumbnail=1"><span>${name}.jpg</span></div>`);
    cards.firstElementChild.querySelector("img").addEventListener("click", () => {
      clicked.push(identity);
      count.textContent = `已选 ${clicked.length} 个，可选 ${10 - clicked.length} 个`;
    });
  }
  addCard("red-main", "old-red");
  doc.querySelector('[class^="upload-trigger_wrap__"] span').onclick = () => { picker.hidden = false; };
  picker.querySelector("button").onclick = () => { picker.hidden = true; };
  doc.querySelector("#crop-submit").onclick = () => { events.push("crop:" + file); crop.hidden = true; };
  doc.querySelector("#upload-save").onclick = () => {
    events.push("save:" + file);
    upload.hidden = true;
    addCard(file, file + "-new");
  };
  doc.querySelector("#unrelated-save").onclick = () => events.push("unrelated-save");
  doc.querySelector("#page-save").onclick = () => events.push("page-save");
  const media = args => run(temuMediaPage, { key, filenames, ...args });
  const opened = await media({ kind: "open" });
  assert.equal(opened.ordered, true);
  assert.equal(opened.multiple, false);
  assert.equal(opened.available, 10);
  assert.equal(doc.querySelector(opened.selector).type, "file");

  unrelated.hidden = false;
  assert.equal((await media({ kind: "settle-upload", name: filenames[0], previous: opened.knownMedia })).code, "MODAL_BLOCKED");
  unrelated.hidden = true;
  const expected = [];
  for (const name of filenames) {
    const before = await media({ kind: "inspect" });
    file = name;
    upload.hidden = false;
    crop.hidden = false;
    const result = await media({ kind: "settle-upload", name, previous: before.knownMedia });
    assert.equal(result.ok, true);
    assert.equal(result.card.identity, name + "-new");
    expected.push(result.card);
  }
  assert.equal(cards.firstElementChild.dataset.materialId, "fit-new");
  const selected = await media({ kind: "select-new", baseline: 0, previous: opened.knownMedia, expected });
  assert.equal(selected.ok, true);
  assert.deepEqual(Array.from(selected.media, item => item.src), filenames.map(name => `https://cdn.invalid/${name}-new`));
  assert.deepEqual(clicked, filenames.map(name => name + "-new"));
  assert.deepEqual(events, filenames.flatMap(name => ["crop:" + name, "save:" + name]));
  assert.equal((await media({ kind: "confirm", baseline: 0, added: filenames.length })).ok, true);
  dom.window.close();
}

{
  const { dom, doc, run } = fixture(`
    <div class="decoration_operate__test"><button>开始装修</button></div>
    <div class="MDL_inner_decoration" hidden><h2>详情页装修</h2><div class="side-left_sectionItem__test"><span>文本</span></div>
      <div id="preview"></div><textarea placeholder="请输入" hidden></textarea><button id="save">保存</button></div>`);
  const dialog = doc.querySelector(".MDL_inner_decoration");
  const editor = dialog.querySelector("textarea");
  const description = "Item dimensions as pictured.";
  const images = ["https://cdn.invalid/gallery/detail.jpg"];
  const decorate = args => run(temuDecorationPage, { description, hasImages: true, ...args });
  let saved = "";
  doc.querySelector('[class^="decoration_operate__"] button').onclick = () => { dialog.hidden = false; };
  dialog.querySelector("span").onclick = () => { editor.hidden = false; };
  doc.querySelector("#save").onclick = () => { saved = editor.value; dialog.hidden = true; };

  assert.equal((await decorate({ kind: "begin" })).ok, true);
  assert.equal(editor.hidden, true);
  assert.equal((await decorate({ kind: "apply", images })).code, "DETAIL_IMAGE_REQUIRED");
  assert.equal(saved, "");
  doc.querySelector("#preview").innerHTML = `<img src="${images[0]}?width=600">`;
  const written = await decorate({ kind: "write", images });
  assert.equal(written.written, description);
  assert.equal((await decorate({ kind: "apply", images, description: written.written })).status, "verified");
  assert.equal(saved, description);
  dom.window.close();
}

console.log("Temu material picker crops and saves verified local images, and selects them in slot order before saving details.");
