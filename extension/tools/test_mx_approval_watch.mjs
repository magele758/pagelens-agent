import assert from "node:assert/strict";
import { test } from "node:test";
import { createMxApprovalWatcher } from "../lib/agent/mx-approval-watch.js";

const MINUTE = 60_000;
const submittedAt = "2026-11-19T02:00:00.000Z";
const draftId = "1738630710999877196";
const productId = "1738630710999877200";
const sourceId = "1733781903228241493";
const beforeTitle = "Rejilla de pan de acero inoxidable";
const afterTitle = "Rejilla de acero inoxidable para pan, 6 espacios";
const action = "ptc_mx_seller_action";
const publishJob = {
  id: "publish-1", action, createdAt: submittedAt,
  request: {
    mode: "publish_draft", sourceId, draftId,
    offer: {
      brand: "无品牌", packagedWeightGrams: 480, packageCm: { length: 24, width: 14, height: 12 },
      skus: [{ label: "Silver / 1 piece", priceMXN: 1200, stock: 1 }],
    },
  },
};
const optimizationJob = {
  id: "optimize-1", action, createdAt: submittedAt,
  request: {
    mode: "optimize_listing", productId, beforeTitle, afterTitle,
    editorUrl: "https://seller.tiktokshopglobalselling.com/product/edit/" + productId + "?shop_region=MX",
  },
};
const publishResult = status => ({
  ok: true,
  result: {
    mode: "publish_draft", runtime: "pagelens-native", sourceId, draftId, productId,
    productCandidateId: productId, intentAt: submittedAt, status, verified: true, submitted: true,
    readback: { productId, status, title: beforeTitle },
  },
});
const optimizationResult = {
  ok: true,
  result: {
    mode: "optimize_listing", runtime: "pagelens-native", productId, title: afterTitle,
    status: "optimization_under_review", submitted: true, verified: false,
    review: { productId, title: afterTitle, status: "under_review" },
  },
};
const active = ({ id = productId, title = beforeTitle, verified = true } = {}) => ({
  productId: id, status: "active", title, verified,
});

function fixture() {
  let time = Date.parse(submittedAt);
  const records = {};
  const notices = [];
  const storage = {
    async get(key) {
      return Object.hasOwn(records, key) ? { [key]: structuredClone(records[key]) } : {};
    },
    async set(values) {
      Object.assign(records, structuredClone(values));
    },
  };
  return {
    openWorker: () => createMxApprovalWatcher({
      storage, now: () => time, notify: async notice => { notices.push(structuredClone(notice)); },
    }),
    advance: ms => { time += ms; },
    notices,
  };
}

async function expectNoRead(watcher) {
  let reads = 0;
  await watcher.poll(async () => { reads += 1; });
  assert.equal(reads, 0, "No seller status read is due");
}

test("checks the published product ID after 60 seconds and notifies once when active", async () => {
  const { openWorker, advance, notices } = fixture();
  const watcher = openWorker();
  await watcher.record(publishJob, publishResult("under_review"));
  assert.deepEqual(notices, []);
  await expectNoRead(watcher);
  advance(MINUTE - 1);
  await expectNoRead(watcher);
  advance(1);

  const checked = [];
  await watcher.poll(async id => {
    checked.push(id);
    return { ok: true, result: active() };
  });
  assert.deepEqual(checked, [productId]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
  assert.equal(notices[0].mode, "publish_draft");
  assert.equal(notices[0].status, "active");

  advance(MINUTE);
  await expectNoRead(openWorker());
  assert.equal(notices.length, 1);
});

test("empty, unrelated or failed outcomes leave no pending seller reads", async () => {
  const { openWorker, advance, notices } = fixture();
  const watcher = openWorker();
  await expectNoRead(watcher);
  await watcher.record({ ...publishJob, action: "bridge_call" }, publishResult("under_review"));
  await watcher.record(publishJob, { ...publishResult("under_review"), ok: false });
  advance(MINUTE);
  await expectNoRead(watcher);
  assert.deepEqual(notices, []);
});

test("only the exact product with its approved optimized title can notify", async () => {
  const { openWorker, advance, notices } = fixture();
  const watcher = openWorker();
  await watcher.record(optimizationJob, optimizationResult);
  await expectNoRead(watcher);

  const checked = [];
  advance(MINUTE);
  await watcher.poll(async id => {
    checked.push(id);
    return active({ id: draftId, title: afterTitle });
  });
  assert.deepEqual(checked, [productId]);
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await watcher.poll(async () => active());
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await watcher.poll(async () => active({ title: afterTitle }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
  assert.equal(notices[0].mode, "optimize_listing");
  assert.equal(notices[0].title, afterTitle);
});

test("deduplicates repeat immediate active receipts after a worker restart", async () => {
  const { openWorker, advance, notices } = fixture();
  await openWorker().record(publishJob, publishResult("active"));
  assert.equal(notices.length, 1);
  await openWorker().record({ ...publishJob, id: "publish-replayed" }, publishResult("active"));
  assert.equal(notices.length, 1);
  advance(MINUTE);
  await expectNoRead(openWorker());
});

test("persists the retry gate and only accepts a verified active read across restarts", async () => {
  const { openWorker, advance, notices } = fixture();
  await openWorker().record(publishJob, publishResult("under_review"));
  advance(MINUTE);

  const checked = [];
  await openWorker().poll(async id => {
    checked.push(id);
    throw Error("Seller read deferred by the inbox gate");
  });
  assert.deepEqual(checked, [productId]);
  assert.deepEqual(notices, []);

  const restarted = openWorker();
  await expectNoRead(restarted);
  advance(MINUTE - 1);
  await expectNoRead(restarted);
  advance(1);
  await restarted.poll(async id => {
    checked.push(id);
    return active({ verified: false });
  });
  assert.deepEqual(checked, [productId, productId]);
  assert.deepEqual(notices, []);

  advance(MINUTE);
  await openWorker().poll(async id => {
    checked.push(id);
    return active();
  });
  assert.deepEqual(checked, [productId, productId, productId]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].productId, productId);
});
