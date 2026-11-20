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

function makeRun({ anchor = sourceTab, data = products, redirect = false, uploadApproved = true, prepareInput,
  concurrency, mode, remove, submit, reconcile } = {}) {
  const records = new Map([[anchor.id, anchor]]);
  const created = [];
  const events = [];
  const active = [];
  const closed = [];
  const submissions = [];
  let peak = 0;
  const tabs = {
    get: async (id) => records.get(id),
    create: async (args) => {
      const id = 40 + created.length;
      created.push(args);
      records.set(id, {
        id, windowId: args.windowId, url: id === 41 && redirect ? flow.origin + "/login" : args.url, status: "complete",
      });
      peak = Math.max(peak, records.size - 1);
      return { id };
    },
    remove: async (id) => {
      assert.notEqual(id, anchor.id);
      assert.ok(records.has(id));
      await remove?.(id);
      records.delete(id);
      closed.push(id);
    },
  };
  const controller = new AbortController();
  const run = (replay) => runProductBatch({
    flow, shopId, sourceTab: anchor, products: data, uploadApproved, signal: controller.signal, tabs, prepareInput, concurrency, mode, reconcile,
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
    submit: async (args) => {
      assert.equal(args.replayReceipt.status, "verified");
      assert.equal(args.shopId, shopId);
      assert.equal(args.input.shopId, shopId);
      assert.equal(args.signal, controller.signal);
      submissions.push(args);
      return submit ? submit(args) : {
        status: args.mode === "publish" ? "published" : "created", globalItemId: String(1900000 + args.tabId),
      };
    },
  });
  return { run, created, events, active, closed, submissions, controller, peak: () => peak };
}

test("obtains two independent tabs before either product completes", async () => {
  const { run, created, events, active, closed } = makeRun();
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
  assert.equal(events.filter(({ phase }) => phase === "created").length, 2);
  assert.deepEqual(closed, [40, 41]);
});

test("a Shopee product list can anchor workers, but a different shop or site cannot", async () => {
  const shopList = `${flow.origin}/portal/product/mtsku/list?cnsc_shop_id=${shopId}`;
  const { run, created, closed } = makeRun({ anchor: { ...sourceTab, url: shopList } });
  await run();
  assert.equal(created.length, products.length);
  assert.ok(created.every(tab => tab.url === `${flow.origin}${flow.path}?cnsc_shop_id=${shopId}`));
  assert.equal(closed.length, products.length);

  for (const url of [shopList.replace(shopId, "42"), shopList.replace("seller.shopee.cn", "example.com")]) {
    const rejected = makeRun({ anchor: { ...sourceTab, url } });
    await assert.rejects(rejected.run());
    assert.deepEqual(rejected.created, []);
  }
});

test("a redirected product keeps its own error and releases its tab without blocking the other tab", async () => {
  const { run, events, active, closed } = makeRun({ redirect: true });
  await run();
  assert.equal(active.length, 1);
  assert.equal(events.find(({ index, phase }) => index === 0 && phase === "created").tabId, null);
  const blocked = events.find(({ index, phase }) => index === 1 && phase === "needs-review");
  assert.equal(blocked.tabId, null);
  assert.deepEqual([...closed].sort(), [40, 41]);
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

function jobs(count) {
  return Array.from({ length: count }, (_, index) => ({ title: `商品 ${index}`, input: { title: `商品 ${index}` } }));
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("defaults to five open workers and rolls through thirty products without waiting for the first wave", async () => {
  const gates = jobs(30).map(() => Promise.withResolvers());
  const removing = Promise.withResolvers();
  const { run, created, closed, events, peak, submissions } = makeRun({
    data: jobs(30), remove: (id) => id === 42 ? removing.promise : undefined,
  });
  const pending = run(({ tabId }) => gates[tabId - 40].promise);
  await nextTick();
  assert.equal(created.length, 5);
  assert.equal(submissions.length, 0);
  gates[2].resolve({ status: "verified" });
  await nextTick();
  assert.equal(created.length, 5, "must finish closing this tab before opening its replacement");
  removing.resolve();
  await nextTick();
  assert.equal(created.length, 6, "the next product starts while the other four remain pending");
  for (const gate of gates) gate.resolve({ status: "verified" });
  await pending;
  assert.equal(peak(), 5);
  assert.equal(closed.length, 30);
  assert.equal(events.filter(({ phase }) => phase === "created").length, 30);
  assert.ok(submissions.every(({ mode }) => mode === "create"));
});

test("honors the configured ten-worker limit and sends publish only when requested", async () => {
  const gate = Promise.withResolvers();
  const { run, created, events, submissions, peak } = makeRun({ data: jobs(13), concurrency: 10, mode: "publish" });
  const pending = run(() => gate.promise);
  await nextTick();
  assert.equal(created.length, 10);
  gate.resolve({ status: "verified" });
  await pending;
  assert.equal(peak(), 10);
  assert.equal(events.filter(({ phase }) => phase === "published").length, 13);
  assert.ok(submissions.every(({ mode }) => mode === "publish"));
  for (const concurrency of [0, 11, 1.5, "5"]) {
    const invalid = makeRun({ concurrency });
    await assert.rejects(invalid.run(), RangeError);
    assert.equal(invalid.created.length, 0);
  }
  await assert.rejects(makeRun({ mode: "prefill" }).run(), TypeError);
});

test("skips submission after replay validation and preserves uncertainty if a submission call fails", async () => {
  const { run, events, submissions, closed } = makeRun({
    data: jobs(3), concurrency: 1,
    submit: ({ tabId }) => {
      if (tabId === 41) throw new Error("回执连接中断");
      return { status: "created", globalItemId: "50123" };
    },
  });
  await run(({ tabId }) => tabId === 40 ? { status: "needs-review", details: "仍有必填项" } : { status: "verified" });
  assert.deepEqual(submissions.map(({ tabId }) => tabId), [41, 42]);
  assert.deepEqual(closed, [40, 41, 42]);
  assert.equal(events.find(({ index, phase }) => index === 0 && phase === "needs-review").receipt.details, "仍有必填项");
  assert.equal(events.find(({ index, phase }) => index === 1 && phase === "submission-unknown").receipt.details, "回执连接中断");
  assert.equal(events.find(({ index, phase }) => index === 2 && phase === "created").receipt.globalItemId, "50123");
});

test("reconciles uncertain creation from a shared list tab after releasing the form tabs", async () => {
  const data = products.map((product, index) => ({ ...product, input: { ...product.input, sku: `SKU-${index}` } }));
  const { run, events, submissions, closed, peak } = makeRun({
    data, concurrency: 1, submit: () => ({ status: "submission-unknown" }),
    reconcile: async ({ skus, tabId }) => {
      assert.deepEqual(skus, ["SKU-0", "SKU-1"]);
      assert.deepEqual(closed, [40, 41]);
      assert.equal(tabId, 42);
      return new Map([["SKU-0", "50001"]]);
    },
  });
  await run();
  assert.equal(submissions.length, 2);
  assert.equal(peak(), 1);
  assert.deepEqual(closed, [40, 41, 42]);
  assert.equal(events.find(({ phase }) => phase === "created")?.receipt.globalItemId, "50001");
});

test("the stop signal does not open queued tabs or report a started submission as a safe cancellation", async () => {
  const gate = Promise.withResolvers();
  const { run, created, closed, events, controller } = makeRun({ data: jobs(3), concurrency: 1, submit: () => gate.promise });
  const pending = run();
  await nextTick();
  controller.abort();
  gate.reject(controller.signal.reason);
  await pending;
  assert.equal(created.length, 1);
  assert.deepEqual(closed, [40]);
  assert.ok(events.some(({ index, phase }) => index === 0 && phase === "submission-unknown"));
  assert.deepEqual(events.filter(({ phase }) => phase === "cancelled").map(({ index }) => index), [1, 2]);
});

test("a failed tab cleanup does not free a slot or discard the creation receipt", async () => {
  const { run, created, events, peak } = makeRun({
    data: jobs(3), concurrency: 1, remove: () => { throw new Error("close failed"); },
  });
  await run();
  assert.equal(created.length, 1);
  assert.equal(peak(), 1);
  const outcome = events.find(({ index, phase }) => index === 0 && phase === "created");
  assert.equal(outcome.receipt.tabCleanupFailed, true);
  assert.notEqual(outcome.receipt.globalItemId, undefined);
  assert.equal(outcome.tabId, 40);
  assert.deepEqual(events.filter(({ phase }) => phase === "needs-review").map(({ receipt }) => receipt.code),
    ["batch-tabs-not-closed", "batch-tabs-not-closed"]);
});
