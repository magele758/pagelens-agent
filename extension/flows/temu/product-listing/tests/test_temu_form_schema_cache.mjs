import assert from "node:assert/strict";
import test from "node:test";
import { createTemuOptionCache } from "../attribute-cache.js";
import { createTemuListingToolCaller } from "../tool-adapter.js";

const storageFixture = () => {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(update) { Object.assign(data, structuredClone(update)); },
  };
};
const scope = { site: "美国站", categoryPath: ["服装", "T恤"], categoryId: "523", storeId: "100" };
const field = { key: "productProperties[42]", label: "风格 Style", kind: "select", required: true,
  locator: { adapter: "temu-select", selector: "#do-not-store" }, value: "", options: [] };
const options = [{ label: "休闲", value: "style-21" }];

test("stores typed category structure and uses cached choices only with matching live fields", async () => {
  const storage = storageFixture();
  const cache = createTemuOptionCache({ storage });
  const first = await cache.observe(scope, [field]);
  assert.deepEqual(first.schemaCache, { status: "cold", fieldCount: 1 });
  assert.deepEqual(first.fields, [field]);
  await cache.write(first.optionsScope, field, options);

  const newLiveValue = { ...field, value: "new-draft-value" };
  const warm = await cache.observe(scope, [newLiveValue]);
  assert.deepEqual(warm.schemaCache, { status: "warm", fieldCount: 1 });
  assert.equal(warm.fields[0].value, newLiveValue.value);
  assert.equal(warm.fields[0].cachedOptions, true);
  assert.deepEqual(warm.fields[0].options, options);
  assert.deepEqual(warm.fields[0].locator, field.locator);
  for (const otherScope of [{ ...scope, storeId: "101" }, { ...scope, categoryId: "524" }, { ...scope, site: "加拿大站" }]) {
    const other = await cache.observe(otherScope, [field]);
    assert.equal(other.schemaCache.status, "cold");
    assert.deepEqual(other.fields[0].options, []);
  }

  const changedField = { ...field, multiple: true };
  const changed = await cache.observe(scope, [changedField]);
  assert.equal(changed.schemaCache.status, "changed");
  assert.deepEqual(changed.fields[0].options, []);
  assert.equal(await cache.read(changed.optionsScope, field), undefined);
  assert.equal((await cache.observe(scope, [field], { truncated: true })).optionsScope, undefined);
  await cache.invalidate(warm.optionsScope, field);
  assert.deepEqual((await cache.observe(scope, [field])).fields[0].options, []);
  const persisted = JSON.stringify(storage.data);
  assert.ok(!persisted.includes("new-draft-value"));
  assert.ok(!persisted.includes("#do-not-store"));
});

test("records SKU columns as schema without persisting row data and ignores ambiguous attribute keys", async () => {
  const storage = storageFixture();
  const cache = createTemuOptionCache({ storage });
  const sku = { key: "productSkuMap.private-row.siteSupplierPriceMap.US", label: "申报价格（CNY）",
    kind: "number", min: 1, skuGroup: "private-row", skuMember: "siteSupplierPriceMap.US",
    value: "85.99", rowLabels: ["private-color"] };
  const second = { ...sku, key: "productSkuMap.other-row.siteSupplierPriceMap.US", skuGroup: "other-row" };
  const observed = await cache.observe(scope, [field, field, field, sku, second]);
  assert.equal(observed.schemaCache.fieldCount, 1);
  const records = Object.values(storage.data).flat();
  assert.deepEqual(records[0].fields, [{ section: "sku", key: "siteSupplierPriceMap.US", label: sku.label,
    kind: "number", min: 1, required: false, multiple: false, adapter: "native" }]);
  const serialized = JSON.stringify(records);
  assert.ok(!/private-row|other-row|private-color|85\.99/u.test(serialized));
});

test("warm adapter reads the live shape but skips the probe and resolves cached IDs by label before writing", async () => {
  const storage = storageFixture();
  const startUrl = "https://agentseller.temu.com/goods/create/category";
  const draftUrl = "https://agentseller.temu.com/goods/edit?productDraftId=843";
  const trace = [];
  let menuOptions = options;
  let dropdowns = [field];
  const start = async () => {
    let url = startUrl;
    const api = { storage: { local: storage }, tabs: { get: async () => ({ url }) },
      scripting: { async executeScript({ func, args: [request] }) {
        trace.push([func.name, request.kind, request.value]);
        let result;
        if (request.kind === "next") url = draftUrl;
        if (func.name === "temuStagePage") result = { ok: true, merchantId: scope.storeId };
        if (func.name === "temuEditorPage") result = { ok: true, fields: [], validation: [] };
        if (func.name === "temuControls") {
          if (request.kind === "inspect") result = { ok: true, fields: dropdowns };
          if (request.kind === "probe") result = { ok: true, field, options: menuOptions };
          if (request.kind === "select") result = menuOptions.some(option => [option.label, option.value].includes(request.value))
            ? { ok: true, options: menuOptions } : { ok: false, code: "OPTION_MISSING" };
        }
        return [{ documentId: func.name === "temuStagePage" ? "stage" : "draft", frameId: 0, result }];
      } } };
    const call = createTemuListingToolCaller({ tabId: 7, url, api, cdp: {} });
    assert.equal((await call("temu_category", { tabId: 7, ...scope })).ok, true);
    return (tool, args) => call(tool, { tabId: 7, ...args });
  };

  const cold = await start();
  assert.equal((await cold("temu_editor_state")).schemaCache.status, "cold");
  assert.deepEqual((await cold("temu_field_options", { key: field.key })).options, options);
  trace.length = 0;

  const warm = await start();
  const listing = await warm("temu_editor_state");
  assert.equal(listing.schemaCache.status, "warm");
  assert.deepEqual(listing.fields[0].options, options);
  assert.equal((await warm("temu_field_options", { key: field.key })).cached, true);
  assert.ok(!trace.some(([, kind]) => kind === "probe"));

  menuOptions = [{ label: "运动", value: options[0].value }, { label: "休闲", value: "style-52" }];
  assert.equal((await warm("temu_select", { key: field.key, value: options[0].value })).ok, true);
  assert.deepEqual(trace.at(-1), ["temuControls", "select", "休闲"]);

  dropdowns = [{ ...field, multiple: true }];
  assert.equal((await warm("temu_select", { key: field.key, value: options[0].value })).ok, true);
  assert.deepEqual(trace.at(-1), ["temuControls", "select", "休闲"], "a changed live shape still cannot reuse an unverified cached ID");
  assert.equal((await warm("temu_field_options", { key: field.key })).cached, undefined);
  assert.deepEqual(trace.at(-1), ["temuControls", "probe", undefined]);

  dropdowns = [field];
  const next = await start();
  assert.equal((await next("temu_editor_state")).schemaCache.status, "warm");
  menuOptions = [{ label: "工作", value: options[0].value }];
  assert.equal((await next("temu_select", { key: field.key, value: options[0].value })).code, "OPTION_MISSING");
  assert.deepEqual(trace.at(-1), ["temuControls", "select", "运动"]);
  const refreshed = await next("temu_field_options", { key: field.key });
  assert.equal(refreshed.cached, undefined);
  assert.deepEqual(refreshed.options, menuOptions);
  assert.deepEqual(trace.at(-1), ["temuControls", "probe", undefined]);
});
