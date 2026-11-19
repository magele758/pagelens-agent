import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSheinCategory } from "../category-search.js";

const cupPath = ["家居&生活", "厨房&餐厅", "饮具", "马克杯"];
const store = "GS12345678";
const cache = `pagelens.shein.category-keywords.v1.${store}`;
function fixture({ storeKey = store, terms = {}, records = {} } = {}) {
  const calls = [];
  const data = new Map(Object.entries(records));
  const storage = {
    get: async key => ({ [key]: data.get(key) }),
    set: async values => { for (const [key, value] of Object.entries(values)) data.set(key, value); },
  };
  const callPage = async input => {
    calls.push(input);
    if (input.kind === "inspect") return { ok: true, selectedPath: [], storeKey };
    const path = terms[input.keyword];
    return Array.isArray(path) ? { ok: true, selectedPath: path, canAdvance: true, storeKey } :
      { ok: false, code: path || "CATEGORY_SEARCH_NO_MATCH" };
  };
  return { calls, storage, callPage, data };
}

test("tries explicit source words and one model shortlist in order, stopping at the first verified shelf category", async () => {
  const state = fixture({ terms: { 马克杯: cupPath, 杯子: ["商品", "其它杯子"] } });
  let models = 0;
  const outcome = await resolveSheinCategory({ ...state, input: { title: "350 ml 黑色咖啡用杯", category: "Kitchen > Drinkware" },
    suggestKeywords: async evidence => {
      models++;
      assert.deepEqual(evidence.sourceCategories, ["Kitchen > Drinkware"]);
      return { keywords: ["马克杯", "杯子"] };
    },
  });
  assert.equal(models, 1);
  assert.deepEqual(outcome.selectedPath, cupPath);
  assert.deepEqual(state.calls.map(call => call.keyword).filter(Boolean), ["Drinkware", "Kitchen", "马克杯"]);
  assert.deepEqual(state.data.get(cache).map(({ keyword, path }) => ({ keyword, path })), [{ keyword: "马克杯", path: cupPath }]);
});

test("reuses only same-store matching keywords, verifies against live results, and replaces stale path receipts", async () => {
  const changedPath = ["家居&生活", "餐厨用品", "马克杯"];
  const state = fixture({ terms: { 马克杯: changedPath }, records: { [cache]: [
    { keyword: "杯", path: cupPath, learnedAt: Date.now() },
    { keyword: "马克杯", path: cupPath, learnedAt: Date.now() },
  ] } });
  const outcome = await resolveSheinCategory({ ...state, input: { title: "黑色马克杯带手柄" },
    suggestKeywords: async () => assert.fail("matched live cache should skip the model"),
  });
  assert.deepEqual(outcome.selectedPath, changedPath);
  assert.deepEqual(state.calls.slice(1).map(call => [call.keyword, call.preferredPath]), [["马克杯", cupPath]]);
  assert.deepEqual(state.data.get(cache)[0].path, changedPath);

  const other = fixture({ storeKey: "GS76543210", terms: { 马克杯: cupPath }, records: { [cache]: state.data.get(cache) } });
  await resolveSheinCategory({ ...other, input: { title: "黑色马克杯带手柄" }, suggestKeywords: async () => ["马克杯"] });
  assert.equal(other.calls.at(-1).preferredPath, undefined);
  assert.equal(other.data.size, 2);
});

test("does not persist without a verified store identity or continue past a changed page", async () => {
  const unknown = fixture({ storeKey: "", terms: { 马克杯: cupPath } });
  assert.equal((await resolveSheinCategory({ ...unknown, input: { title: "马克杯" } })).ok, true);
  assert.equal(unknown.data.size, 0);
  const blocked = fixture({ terms: { 马克杯: "PAGE_CHANGED", 杯子: cupPath } });
  const outcome = await resolveSheinCategory({ ...blocked, input: { title: "马克杯", categoryKeywords: ["马克杯", "杯子"] } });
  assert.equal(outcome.code, "PAGE_CHANGED");
  assert.equal(blocked.calls.length, 2);
  assert.equal(blocked.data.size, 0);
});
