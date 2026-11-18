import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { loadTemuCategoryRoots, loadTemuOrigins, searchTemuCategories } from "../taxonomy.js";

function localFetch(requests) {
  return async url => {
    requests.push(url.pathname.split("/").at(-1));
    return new Response(await readFile(url));
  };
}

test("loads only the chosen root branch for qualified paths and preserves exact Temu labels", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  assert.equal(roots.length, 25);
  assert.deepEqual(requests, ["roots.json"]);
  const cup = { id: "31559", path: ["运动与户外用品", "运动与户外休闲用品", "运动杯"] };
  assert.deepEqual(await searchTemuCategories("运动与户外用品 -> 运动与户外休闲用品 -> 运动杯", { fetchImpl, limit: 1 }), [cup]);
  assert.deepEqual(await searchTemuCategories("运动杯", { fetchImpl, rootId: "31148", limit: 1 }), [cup]);
  assert.deepEqual(requests, ["roots.json", "category-31148.json.gz"]);
});

test("supports unscoped leaf search, disambiguating by breadcrumb instead of rewriting category names", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const exact = await searchTemuCategories("女装针织衫开衫", { fetchImpl, limit: 1 });
  assert.deepEqual(exact, [{ id: "28950", path: ["服装、鞋靴和珠宝饰品", "女士时尚", "女装", "女士毛衣", "女装针织衫开衫"] }]);
  assert.equal(requests.length, 26);
  const cups = await searchTemuCategories(31559, { fetchImpl, limit: 1 });
  assert.equal(cups[0].id, "31559");
  assert.equal(requests.length, 26);
});

test("packs country display names and province choices separately from the category tree", async () => {
  const requests = [];
  const fetchImpl = localFetch(requests);
  const origins = await loadTemuOrigins({ fetchImpl });
  assert.deepEqual(requests, ["origins.json"]);
  assert.equal(origins.length, 227);
  const china = origins.find(entry => entry.country === "中国大陆");
  assert.ok(china.aliases.includes("China"));
  assert.ok(china.regions.includes("广东省"));
  assert.equal(china.regions.length, 31);
});
