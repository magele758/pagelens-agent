import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { readSheinProductDirectory, readSheinProductImages } from "../sidepanel/product-directory.js";
import { bindSheinListingPanel } from "../sidepanel/listing-panel.js";

const html = await readFile(new URL("../../../../sidepanel/index.html", import.meta.url), "utf8");
const list = "https://sellerhub.shein.com/#/spmp/commdities/list";
const editor = "https://sellerhub.shein.com/#/spmp/commoditiesInfo?mode=add";
const tick = () => new Promise(resolve => setImmediate(resolve));
const absent = () => Object.assign(new Error("missing"), { name: "NotFoundError" });

function directory(name, children) {
  return {
    name, kind: "directory",
    async getFileHandle(key) {
      if (children[key]?.kind !== "file") throw absent();
      return children[key];
    },
    async getDirectoryHandle(key) {
      if (children[key]?.kind !== "directory") throw absent();
      return children[key];
    },
    async *values() { yield* Object.values(children); },
  };
}

const file = (name, data, type) => ({ kind: "file", name, getFile: async () => new File([data], name, { type }) });
const product = (name, input, images = {}) => directory(name, {
  "product.json": file("product.json", JSON.stringify(input), "application/json"),
  images: directory("images", images),
});
const image = file("hero.jpg", "binary", "image/jpeg");

test("loads the selected JSON and only accesses manifest images contained in the selected product folder", async () => {
  const first = product("first", {
    title: "Shirt", imagePath: "images/hero.jpg", mainImages: ["images/hero.jpg", "https://example.com/p.jpg"],
    detailImages: ["../outside.jpg", "images/absent.jpg"], skus: [{ imagePath: "images/hero.jpg" }],
  }, { "hero.jpg": image });
  const root = directory("Catalog", { first, bad: product("bad", { title: "" }), ".private": product(".private", { title: "Hidden" }) });
  const result = await readSheinProductDirectory(root);
  assert.deepEqual(result.products.map(({ title }) => title), ["Shirt"]);
  assert.match(result.issues[0], /bad.*标题/);
  const images = await readSheinProductImages(result.products[0]);
  assert.deepEqual(images.images.map(({ name, role }) => [name, role]), [["hero.jpg", "main"], ["hero.jpg", "variant"]]);
  assert.equal(images.images[0].file.name, "hero.jpg");
  assert.deepEqual(images.issues, ["图片 images/absent.jpg · 目录中未找到"]);
});

test("preserves separate color hero, square, swatch and SKU assets plus shared gallery paths", async () => {
  const root = directory("Shirt", {
    "product.json": file("product.json", JSON.stringify({
      title: "Shirt",
      detailImages: ["images/common.jpg"],
      variantGroups: [{ name: "Color", options: [{ value: "Black", imagePath: "black/hero.jpg" }] }],
      skus: [{ imagePath: "black/sku.jpg" }],
      shein: {
        sharedGalleryImages: ["images/common.jpg", "black/hero.jpg", "../other/private.jpg"],
        variantGroups: [{ name: "Color", options: [
          { value: "Black", imagePath: "black/hero.jpg", squareImagePath: "black/detail.jpg", swatchImagePath: "black/detail.jpg" },
          { value: "White", imagePath: "white/hero.jpg", squareImagePath: "white/detail.jpg" },
        ] }],
        skus: [{ imagePath: "white/sku.jpg" }],
      },
    }), "application/json"),
    images: directory("images", { "common.jpg": file("common.jpg", "shared", "image/jpeg") }),
    black: directory("black", {
      "hero.jpg": file("hero.jpg", "black", "image/jpeg"), "detail.jpg": file("detail.jpg", "detail black", "image/jpeg"),
      "sku.jpg": file("sku.jpg", "sku black", "image/jpeg"),
    }),
    white: directory("white", {
      "hero.jpg": file("hero.jpg", "white", "image/jpeg"), "detail.jpg": file("detail.jpg", "detail white", "image/jpeg"),
      "sku.jpg": file("sku.jpg", "sku white", "image/jpeg"),
    }),
  });
  const { products: [selected] } = await readSheinProductDirectory(root);
  const result = await readSheinProductImages(selected);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.images.map(({ path, role }) => [path, role]), [
    ["images/common.jpg", "detail"], ["images/common.jpg", "shared-gallery"], ["black/hero.jpg", "shared-gallery"],
    ["black/hero.jpg", "variant"], ["black/detail.jpg", "variant-square"], ["black/detail.jpg", "variant-swatch"],
    ["white/hero.jpg", "variant"], ["white/detail.jpg", "variant-square"],
    ["black/sku.jpg", "variant"], ["white/sku.jpg", "variant"],
  ]);
  const heroes = result.images.filter(image => image.role === "variant" && image.name === "hero.jpg");
  assert.deepEqual(await Promise.all(heroes.map(({ file }) => file.text())), ["black", "white"]);
  assert.equal(result.images.find(image => image.role === "detail").file, result.images.find(image => image.role === "shared-gallery").file);
});

test("binds the current seller tab, requests approval only on action, and sends image Files only after consent", async t => {
  const { window } = new JSDOM(html);
  const previous = globalThis.document;
  globalThis.document = window.document;
  t.after(() => { globalThis.document = previous; window.close(); });
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const get = key => document.getElementById(`shein-listing-${key}`);
  let tab = { id: 13, url: list };
  const calls = [];
  let approvalCount = 0;
  const open = bindSheinListingPanel({
    getTargetTab: async () => tab,
    authorize: async (url, options) => {
      approvalCount++;
      assert.equal(url, tab.url);
      assert.deepEqual(options, { userGesture: true, tabId: 13 });
    },
    pickDirectory: async () => product("first", { title: "Shirt", imagePath: "images/hero.jpg" }, {
      "hero.jpg": image, "common.jpg": file("common.jpg", "details", "image/jpeg"),
    }),
    openEditor: async spec => { calls.push(["open", spec]); tab = { ...tab, url: editor }; return { ok: true }; },
    inspect: async spec => { calls.push(["inspect", spec]); return { ok: true, fields: [{ label: "商品名", required: true }] }; },
    replay: async spec => {
      calls.push(["replay", spec]);
      spec.onStep({ label: "正在填写商品" });
      return { ok: true, items: [{ label: "商品标题", status: "filled" }], issues: [] };
    },
  });
  await open();
  assert.equal(get("dialog").open, true);
  assert.equal(approvalCount, 0);
  assert.equal(get("run").disabled, true);
  get("open").click();
  await tick();
  assert.equal(calls[0][1].url, list);
  get("inspect").click();
  await tick();
  assert.equal(calls[1][1].url, editor);
  assert.equal(get("results").textContent, "商品名（必填）");
  get("pick").click();
  await tick();
  assert.equal(get("directory-status").textContent, "Shirt");
  assert.equal(get("upload-row").hidden, false);
  get("category").value = "Clothing › T-shirts";
  get("run").click();
  await tick();
  assert.deepEqual(calls[2][1].images, []);
  assert.deepEqual(calls[2][1].input.categoryPath, ["Clothing", "T-shirts"]);
  get("upload").checked = true;
  get("json").value = '{"description":"Cotton t-shirt","shein":{"sharedGalleryImages":["images/common.jpg"]}}';
  get("json").dispatchEvent(new window.Event("input", { bubbles: true }));
  get("run").click();
  await tick();
  assert.equal(calls[3][1].input.title, "Shirt");
  assert.equal(calls[3][1].input.description, "Cotton t-shirt");
  assert.equal(calls[3][1].images[0].file.name, "hero.jpg");
  assert.deepEqual(calls[3][1].images.map(({ role, path }) => [role, path]), [["main", "images/hero.jpg"], ["shared-gallery", "images/common.jpg"]]);
  assert.equal(get("upload").checked, false);
  assert.equal(get("status").dataset.state, "verified");
  assert.equal(get("results").textContent, "已核对 · 商品标题");
  tab = { ...tab, url: "https://www.shein.com/" };
  get("run").click();
  await tick();
  assert.equal(calls.length, 4);
  assert.equal(approvalCount, 4);
  assert.match(get("status").textContent, /切回 SHEIN 商家后台/);
});
