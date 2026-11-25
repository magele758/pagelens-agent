import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { bindTemuListingPanel } from "../sidepanel/temu-listing-panel.js";
import { normalizeTemuListingInput } from "../flows/temu/product-listing/input.js";

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "https://pagelens.test/sidepanel/",
  pretendToBeVisual: true,
});
globalThis.document = dom.window.document;
Object.assign(dom.window.HTMLDialogElement.prototype, {
  showModal() { this.open = true; },
  close() {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  },
});
globalThis.chrome = { permissions: { contains: async () => true, request: async () => true } };
const fetchImpl = async url => new Response(await readFile(url));
const get = selector => document.querySelector(selector);
const inputText = (field, text) => {
  field.value = text;
  field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const clickChoice = (id, label) => {
  const option = [...get(`#temu-${id}`).querySelectorAll(".temu-select-option")].find(row => row.textContent === label);
  assert.ok(option, label);
  option.click();
};
const value = id => get(`#temu-${id}-value`).textContent;
const openSelect = id => get(`#temu-${id} .temu-select-trigger`).click();
const category = { id: "cup", ids: ["sport", "outdoors", "cup"], path: ["运动与户外用品", "运动与户外休闲用品", "运动杯"] };
const product = { title: "Water Bottle", input: normalizeTemuListingInput({ title: "Water Bottle" }) };
const apparel = [
  ["Cotton Tee", "t-shirt", "女装 T 恤"],
  ["Linen Shirt", "shirt", "女装衬衫"],
  ["Knit Tank", "tank", "女装背心"],
  ["Fleece Hoodie", "hoodie", "女装卫衣"],
  ["Polo Top", "polo", "女装 Polo 衫"],
].map(([title, id, label]) => ({
  title,
  input: normalizeTemuListingInput({ title }),
  category: { id, ids: ["clothing", "womens", id], path: ["服装", "女装", label] },
}));
let navigation;
let replayed;
const batchReplays = [];
const batchComplete = Promise.withResolvers();
let batchRequest;
let focusedTab;
let recommended = [];
let picked = 0;
let typedDirectory;
let typedProducts = [product];
let back = 0;
const open = bindTemuListingPanel({
  getTargetTab: async () => ({ id: 4, windowId: 8, url: "https://agentseller.temu.com/goods/list" }),
  onBack: () => back++,
  fetchImpl,
  chooseDirectory: async () => ++picked === 1
    ? { directoryName: "跨境", products: [product], issues: [] } : null,
  readDirectory: async path => {
    typedDirectory = path;
    return { root: path, products: typedProducts, issues: [] };
  },
  suggestCategory: async ({ title, operatorNotes }, { useModel }) => {
    recommended.push([title, operatorNotes, useModel]);
    return { category: apparel.find(product => product.title === title)?.category ?? category,
      source: useModel ? "model" : "local" };
  },
  openTab: async options => {
    navigation = options;
    return { id: 5, url: options.href };
  },
  replay: async args => {
    if (args.tabId >= 30) {
      batchReplays.push(args);
      return args.tabId === 31
        ? { status: "needs-review", items: [], issues: [{ label: "尺码表", message: "缺少人体尺寸" }], missing: [] }
        : { status: "ready-for-review", items: [], issues: [], missing: [] };
    }
    replayed = args;
    return { status: "verified", items: [{ status: "verified" }], issues: [], missing: [] };
  },
  async runBatch(request) {
    batchRequest = request;
    const { products, sourceTab, runProduct, signal, onJob } = request;
    assert.equal(sourceTab.id, 4);
    assert.equal(sourceTab.windowId, 8);
    const jobs = [];
    for (const [index, product] of products.entries()) {
      const tabId = 30 + index;
      const tab = { id: tabId, url: "https://agentseller.temu.com/goods/create/category", windowId: 8 };
      onJob(index, { status: "queued", tabId });
      const receipt = await runProduct(product, {
        tab, index, signal, onStep: ({ label }) => onJob(index, { status: "running", tabId, message: label }),
      });
      const job = { status: receipt.status === "ready-for-review" ? "completed" : receipt.status, tabId, receipt };
      jobs.push(job);
      onJob(index, job);
    }
    batchComplete.resolve();
    return jobs;
  },
  activateTab: async id => { focusedTab = id; },
});
await open();
assert.equal(value("listing-site"), "美国站");
assert.equal(value("listing-origin"), "中国大陆");
assert.equal(value("listing-region"), "浙江省");
assert.equal(get(".temu-listing-dialog datalist, .temu-listing-dialog input[type=text]"), null);
assert.equal(get(".temu-listing-header").firstElementChild.getAttribute("aria-label"), "返回工作流");
assert.equal(get(".temu-listing-header").lastElementChild.getAttribute("aria-label"), "关闭");
assert.equal(navigation, undefined);

openSelect("listing-site");
clickChoice("listing-site", "加拿大站");
assert.equal(dom.window.localStorage.getItem("pagelens.temu.listingSite"), "加拿大站");

get('[data-action="choose"]').click();
await delay(15);
assert.equal(get("#temu-directory-summary").textContent, "Water Bottle");
assert.deepEqual(recommended, [["Water Bottle", "", false]]);
assert.match(value("listing-category"), /运动杯/);
assert.match(get("#temu-category-hint").textContent, /已按商品资料匹配/);
assert.equal(value("listing-site"), "加拿大站");
get('[data-action="choose"]').click();
await delay(10);
assert.equal(get("#temu-directory-summary").textContent, "Water Bottle");

assert.equal(get("#temu-product-json"), null);
const notes = get("#temu-product-notes");
inputText(notes, "附带蓝色盖子");
assert.equal(value("listing-category"), "选择类目");
await delay(440);
assert.deepEqual(recommended, [["Water Bottle", "", false], ["Water Bottle", "附带蓝色盖子", false]]);

openSelect("listing-origin");
await delay(20);
clickChoice("listing-origin", "中国大陆");
openSelect("listing-region");
await delay(20);
clickChoice("listing-region", "广东省");
assert.equal(value("listing-region"), "广东省");

assert.equal(get('[data-action="run"]').textContent, "开始上品");
get('[data-action="run"]').click();
await delay(10);
assert.equal(navigation.href, "https://agentseller.temu.com/goods/create/category");
assert.equal(navigation.tab.id, 4);
assert.equal(navigation.accepts(navigation.href), true);
assert.equal(replayed.tabId, 5);
assert.deepEqual(replayed.input.sites, ["加拿大站"]);
assert.deepEqual(replayed.input.categoryPath, category.path);
assert.deepEqual(replayed.input.origin, { country: "中国大陆", region: "广东省" });
assert.equal(replayed.input.operatorNotes, "附带蓝色盖子");

openSelect("listing-category");
await delay(25);
const search = get("#temu-listing-category-menu input");
inputText(search, "运动杯");
await delay(360);
clickChoice("listing-category", category.path.join(" › "));
assert.match(value("listing-category"), /运动杯/);
assert.equal(get("#temu-listing-category-menu").hidden, true);
assert.equal(get("#temu-category-hint").textContent, "");

get('[data-action="back"]').click();
assert.equal(back, 1);
assert.equal(get(".temu-listing-dialog").open, false);
await open();
assert.equal(value("listing-site"), "加拿大站");
inputText(get("#temu-directory-path"), " /Products/Fit sample ");
get('[data-action="read-directory"]').click();
await delay(10);
assert.equal(typedDirectory, "/Products/Fit sample");
assert.equal(get("#temu-directory-summary").textContent, "Water Bottle");
const runAll = get('[data-action="run-all"]');
assert.ok(runAll.hidden || runAll.disabled, "one selected product cannot start a multi-product batch");

typedProducts = [...apparel, product];
inputText(get("#temu-directory-path"), "/Products/Oversized");
get('[data-action="read-directory"]').click();
await delay(15);
assert.equal(runAll.disabled, true);
assert.equal(batchRequest, undefined);

typedProducts = apparel;
inputText(get("#temu-directory-path"), "/Products/Apparel");
get('[data-action="read-directory"]').click();
await delay(20);
assert.equal(runAll.disabled, false);
assert.equal(runAll.hidden, false);
assert.match(get("#temu-directory-summary").textContent, /5 件商品/);
assert.match(value("listing-category"), /女装 T 恤/);
runAll.click();
await Promise.race([batchComplete.promise, delay(1000).then(() => assert.fail("batch did not finish"))]);
await delay(0);
assert.equal(batchRequest.products.length, 5);
assert.deepEqual(batchReplays.map(({ tabId, input }) => ({
  tabId, title: input.title, categoryPath: input.categoryPath,
})), apparel.map((product, index) => ({
  tabId: 30 + index, title: product.title, categoryPath: product.category.path,
})));
const reviewButtons = [...document.querySelectorAll(".temu-listing-dialog button")]
  .filter(button => button.textContent.trim() === "查看商品页");
assert.equal(reviewButtons.length, 5);
reviewButtons[1].click();
await delay(0);
assert.equal(focusedTab, 31);
dom.window.close();
console.log("Temu listing selector, directory, recommendation, auto-navigation, and batch review verified.");
