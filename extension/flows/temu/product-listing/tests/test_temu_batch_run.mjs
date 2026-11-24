import assert from "node:assert/strict";
import test from "node:test";
import { runTemuBatchPrefill, TEMU_BATCH_LIMIT } from "../batch-run.js";

const sourceTab = { id: 2, windowId: 7, url: "https://agentseller.temu.com/goods/list" };
const categoryUrl = "https://agentseller.temu.com/goods/create/category";
const products = Array.from({ length: TEMU_BATCH_LIMIT }, (_, index) => ({ title: `Product ${index + 1}` }));

function browserTabs() {
  const open = new Map([[sourceTab.id, { ...sourceTab, active: true, status: "complete" }]]);
  const calls = [];
  return { open, calls, tabs: {
    async create(options) {
      calls.push(["create", options]);
      const tab = { ...options, id: open.size + 20, status: "complete" };
      open.set(tab.id, tab);
      return { ...tab };
    },
    async get(id) {
      calls.push(["get", id]);
      return open.has(id) ? { ...open.get(id) } : undefined;
    },
    async update(id, options) {
      calls.push(["update", id, options]);
      for (const tab of open.values()) tab.active = tab.id === id;
    },
    async remove(id) {
      calls.push(["remove", id]);
      open.delete(id);
    },
  } };
}

test("opens five independent Temu tabs together and retains every outcome for human review", async () => {
  const { tabs, calls, open } = browserTabs();
  const states = [];
  const completed = [];
  const controller = new AbortController();
  const result = await runTemuBatchPrefill({
    products, sourceTab, tabs, signal: controller.signal,
    onJob: (index, job) => states.push({ index, ...job }),
    async runProduct(product, { tab, index, signal, onStep }) {
      assert.equal(open.size, 6);
      assert.equal(tab.id, 21 + index);
      assert.equal(tab.active, true);
      assert.equal(tab.url, categoryUrl);
      assert.equal(tab.windowId, sourceTab.windowId);
      assert.equal(product, products[index]);
      assert.equal(signal, controller.signal);
      assert.deepEqual(completed, Array.from({ length: index }, (_, previous) => previous));
      onStep({ label: "核对规格表" });
      // Transition into the job's own browser draft, independent of other products.
      open.get(tab.id).url = `https://agentseller.temu.com/goods/edit?productDraftId=${tab.id}`;
      completed.push(index);
      if (index === 1) return { status: "needs-review", issues: [{ label: "尺码表" }] };
      if (index === 2) throw new Error("读取图片失败");
      return { status: "ready-for-review", draftUrl: open.get(tab.id).url };
    },
  });
  assert.deepEqual(result.map(({ status, tabId }) => [status, tabId]), [
    ["completed", 21], ["needs-review", 22], ["needs-review", 23], ["completed", 24], ["completed", 25],
  ]);
  assert.equal(result[1].receipt.issues[0].label, "尺码表");
  assert.equal(result[2].message, "读取图片失败");
  assert.equal(open.size, 6);
  assert.equal(states.filter(({ message }) => message === "核对规格表").length, 5);
  assert.equal(calls.filter(([action]) => action === "remove").length, 0);
  assert.deepEqual(calls.filter(([action]) => action === "create").map(([, options]) => options),
    products.map(() => ({ url: categoryUrl, windowId: sourceTab.windowId, active: false })));
  assert.deepEqual(calls.filter(([action]) => action === "update").map(([, id, options]) => [id, options]),
    products.map((_, index) => [21 + index, { active: true }]));
});

test("stops remaining replays without closing already opened tabs", async () => {
  const { tabs, calls, open } = browserTabs();
  const controller = new AbortController();
  const result = await runTemuBatchPrefill({
    products, sourceTab, tabs, signal: controller.signal,
    async runProduct(_product, { index, signal }) {
      assert.equal(index, 0);
      controller.abort();
      signal.throwIfAborted();
    },
  });
  assert.deepEqual(result.map(({ status }) => status), products.map(() => "cancelled"));
  assert.deepEqual(result.map(({ tabId }) => tabId), [21, 22, 23, 24, 25]);
  assert.equal(open.size, 6);
  assert.equal(calls.filter(([action]) => action === "update").length, 1);
});

test("preserves a job whose assigned tab changed without overwriting its new page", async () => {
  const { tabs, calls, open } = browserTabs();
  const replayed = [];
  const result = await runTemuBatchPrefill({
    products, sourceTab, tabs,
    async runProduct(_product, { index }) {
      replayed.push(index);
      if (index === 0) open.get(22).url = "https://agentseller.temu.com/goods/edit?productDraftId=other";
      return { status: "ready-for-review" };
    },
  });
  assert.deepEqual(replayed, [0, 2, 3, 4]);
  assert.equal(result[1].status, "needs-review");
  assert.equal(result[1].tabId, 22);
  assert.equal(calls.some(([action, id]) => action === "update" && id === 22), false);
  assert.equal(open.size, 6);
});

test("rejects a batch above the limit before opening any tabs", async () => {
  const { tabs, calls } = browserTabs();
  await assert.rejects(runTemuBatchPrefill({
    products: [...products, products[0]], sourceTab, tabs, runProduct: async () => {},
  }), /1–5/);
  assert.deepEqual(calls, []);
});

test("continues retained product tabs without opening or replacing any drafts", async () => {
  const { tabs, calls, open } = browserTabs();
  const resumes = products.map((_, index) => {
    const tabId = index + 30;
    const href = `https://agentseller.temu.com/goods/edit?productDraftId=${tabId}`;
    open.set(tabId, { id: tabId, windowId: sourceTab.windowId, url: href, status: "complete" });
    return { tabId, href, documentId: `doc-${tabId}` };
  });
  const result = await runTemuBatchPrefill({
    products, sourceTab, tabs, resumeTabs: resumes,
    async runProduct(_product, { tab, index, resume }) {
      assert.equal(tab.id, resumes[index].tabId);
      assert.equal(tab.url, resumes[index].href);
      assert.equal(resume, resumes[index]);
      assert.equal(tab.active, true);
      return { status: "ready-for-review", draftUrl: resume.href };
    },
  });
  assert.deepEqual(result.map(({ receipt }) => receipt.draftUrl), resumes.map(({ href }) => href));
  assert.equal(calls.some(([method]) => method === "create" || method === "remove"), false);
});
