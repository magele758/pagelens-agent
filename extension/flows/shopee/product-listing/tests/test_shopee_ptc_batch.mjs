import assert from "node:assert/strict";
import test from "node:test";
import { listFlows } from "../../../../lib/flow/runtime.js";
import { imagePathsFor, runProductBatch } from "../sidepanel/batch-run.js";

const flow = listFlows().find(({ id }) => id === "shopee-listing");
const shopId = "1901697826";
const sourceTab = {
  id: 37, windowId: 8, url: `${flow.origin}${flow.path}?cnsc_shop_id=${shopId}&other=not-reused`, status: "complete",
};

const products = ["alpha", "beta"].map((key) => ({
  title: key,
  input: {
    title: key, imagePath: `/batch/${key}/cover.jpg`, variant: { name: "颜色", options: [
      { option: "蓝色", imagePath: `/batch/${key}/blue.jpg` },
      { option: "白色", imagePath: `/batch/${key}/white.jpg` },
    ] },
  },
}));

function makeRun({ data = products, redirect = false, uploadApproved = true, prepareInput } = {}) {
  const records = new Map([[sourceTab.id, sourceTab]]);
  const created = [];
  const events = [];
  const active = [];
  const tabs = {
    get: async (id) => records.get(id),
    create: async (args) => {
      const id = 40 + created.length;
      created.push(args);
      records.set(id, {
        id, windowId: args.windowId, url: id === 41 && redirect ? flow.origin + "/login" : args.url, status: "complete",
      });
      return { id };
    },
  };
  const signal = new AbortController().signal;
  const run = (replay) => runProductBatch({
    flow, shopId, sourceTab, products: data, uploadApproved, signal, tabs, prepareInput,
    onJob: (index, event) => events.push({ index, ...event }),
    createCall: ({ tabId, confirmUpload }) => {
      const product = data[tabId - 40];
      const itemPaths = imagePathsFor(product.input);
      for (const image of itemPaths) assert.equal(confirmUpload({ tabId, paths: [image] }), true);
      if (product.input.sizeChartImagePath) assert.equal(confirmUpload({ tabId, paths: [product.input.sizeChartImagePath] }), false);
      assert.equal(confirmUpload({ tabId, paths: ["/batch/secret/cover.jpg"] }), false);
      assert.equal(confirmUpload({ tabId: 12, paths: [itemPaths[0]] }), false);
      return async (tool, { selector }) => {
        assert.equal(tool, "wait_for");
        assert.ok(selector.includes(".product-basic-info"));
        return { ok: true };
      };
    },
    replay: async (args) => {
      active.push(args);
      assert.equal(args.input.shopId, shopId);
      args.onStep({ step: "sales", tool: "upload_file" });
      return replay ? replay(args) : { status: "verified" };
    },
  });
  return { run, created, events, active };
}

test("obtains two independent tabs before either product completes", async () => {
  const { run, created, events, active } = makeRun();
  let finish;
  const delayed = new Promise((resolve) => { finish = resolve; });
  const pending = run(() => delayed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 2);
  assert.deepEqual(created[0], created[1]);
  assert.equal(created[0].url, `${flow.origin}${flow.path}?cnsc_shop_id=${shopId}`);
  assert.equal(created[0].active, false);
  assert.deepEqual(active.map(({ tabId }) => tabId), [40, 41]);
  assert.equal(events.filter(({ phase }) => phase === "running").length, 2);
  finish({ status: "verified" });
  await pending;
  assert.equal(events.filter(({ phase }) => phase === "verified").length, 2);
});

test("a redirected product keeps its own error and does not block the other tab", async () => {
  const { run, events, active } = makeRun({ redirect: true });
  await run();
  assert.equal(active.length, 1);
  assert.equal(events.find(({ index, phase }) => index === 0 && phase === "verified").tabId, 40);
  const blocked = events.find(({ index, phase }) => index === 1 && phase === "needs-review");
  assert.equal(blocked.tabId, 41);
  assert.match(blocked.receipt.details, /Shopee 登录/u);
});

test("does not start jobs containing images without this run's consent", async () => {
  const { run, events, created } = makeRun({ uploadApproved: false });
  await run();
  assert.equal(created.length, 0);
  assert.equal(events.filter(({ phase }) => phase === "needs-review").length, 2);
});

test("prepares a supplied apparel chart before opening its form without granting permission to upload the original chart image", async () => {
  const data = [{ ...products[0], input: { ...products[0].input, sizeChartImagePath: "/batch/alpha/size.png" } }];
  const sizeChart = { name: "上衣 尺码表", unit: "cm", columns: ["尺寸（国际）", "胸围"], rows: [{ "尺寸（国际）": "S", 胸围: "90" }] };
  const { run, created, events } = makeRun({
    data,
    prepareInput: async (product, signal) => {
      assert.equal(product, data[0]);
      assert.equal(signal.aborted, false);
      assert.equal(created.length, 0);
      return { ...product.input, sizeChart };
    },
  });
  await run(({ input }) => {
    assert.deepEqual(input.sizeChart, sizeChart);
    assert.equal(input.completeMissingSizeChart, true);
    return { status: "verified" };
  });
  assert.ok(events.some(({ phase }) => phase === "preparing"));
  assert.equal(created.length, 1);
});

test("does not block another product when the chart image cannot be parsed", async () => {
  const data = [products[0], { ...products[1], input: { ...products[1].input, sizeChartImagePath: "/batch/beta/size.png" } }];
  const { run, created, events } = makeRun({
    data, prepareInput: async () => { throw new Error("尺码图解析失败"); },
  });
  await run(({ input }) => {
    assert.equal(input.title, "alpha");
    return { status: "verified" };
  });
  assert.equal(created.length, 1);
  const failure = events.find(({ index, phase }) => index === 1 && phase === "needs-review");
  assert.equal(failure.tabId, null);
  assert.match(failure.receipt.details, /尺码图解析失败/u);
});

test("extracts a product's cover and SKU paths without granting duplicate entries", () => {
  assert.deepEqual(imagePathsFor({
    imagePath: "/products/cover.jpg", variant: { options: [{ imagePath: "/products/cover.jpg" }, { imagePath: "/products/blue.jpg" }] },
  }), ["/products/cover.jpg", "/products/blue.jpg"]);
  assert.deepEqual(imagePathsFor({ variant: { imagePath: "/products/old.jpg" } }), ["/products/old.jpg"]);
});
