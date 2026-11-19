import assert from "node:assert/strict";
import { test } from "node:test";
import { createListingFieldCache, recoverListingFields } from "../adaptive-fields.js";
import { createListingAdvisor } from "../listing-advisor.js";

const shop = { platform: "shein", store: "GS1", market: "美国站", categoryPath: ["家居", "杯子"] };
const material = { key: "material", label: "材质", section: "商品属性", type: "select", required: true, value: "" };
const state = fields => ({ ok: true, fields });
function memoryStorage() {
  const data = {};
  return {
    get: async key => ({ [key]: data[key] }),
    set: async copy => Object.assign(data, copy),
    remove: async key => delete data[key],
  };
}

test("keeps identical field labels separated by site, store, category, editor section, and dependencies", async () => {
  const cache = createListingFieldCache({ storage: memoryStorage() });
  await cache.set(shop, material, ["金属", "玻璃"]);
  assert.deepEqual(await cache.get(shop, material), ["金属", "玻璃"]);
  assert.deepEqual(await cache.get({ ...shop, market: "英国站" }, material), []);
  assert.deepEqual(await cache.get({ ...shop, store: "GS2" }, material), []);
  assert.deepEqual(await cache.get({ ...shop, categoryPath: ["服装", "上衣"] }, material), []);
  assert.deepEqual(await cache.get(shop, { ...material, section: "SKU 规格" }), []);
  assert.deepEqual(await cache.get(shop, { ...material, dependency: "塑料" }), []);
});

test("refreshes a stale option, bounds model requests, and scopes writes to verified form values", async () => {
  const storage = memoryStorage();
  const cache = createListingFieldCache({ storage });
  await cache.set(shop, material, ["旧选项"]);
  const price = { ...material, key: "price", label: "申报价格", type: "number", error: "请填写" };
  const upload = { ...material, key: "image", label: "资质附件", type: "upload" };
  const selected = [];
  let optionsRead = 0;
  let modelCalls = 0;
  let current = state([material, price, upload]);
  const result = await recoverListingFields({ scope: shop, snapshot: current, cache, read: async () => current,
    readOptions: async field => { assert.equal(field.key, "material"); optionsRead++; return ["纯金属", "玻璃"]; },
    suggest: async fields => {
      modelCalls++;
      assert.deepEqual(fields.map(field => field.key), ["material"]);
      return { material: fields[0].options[0], price: 99, image: "/local/file.pdf" };
    },
    apply: async values => {
      selected.push(values);
      if (values.material === "旧选项") return { ok: true, issues: [{ key: "material", code: "OPTION_MISSING" }] };
      current = state([{ ...material, value: values.material }, price, upload]);
      return { ok: true, items: [{ key: "material", status: "verified" }] };
    },
  });
  assert.deepEqual(selected, [{ material: "旧选项" }, { material: "纯金属" }]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.state.fields[0].value, "纯金属");
  assert.equal(optionsRead, 1);
  assert.equal(modelCalls, 2);
  assert.deepEqual(await cache.get(shop, material), ["纯金属", "玻璃"]);
});

test("batches direct text, numeric and checkbox repairs and rejects a value outside the real options", async () => {
  const fields = [
    { ...material, value: ["示例"], multiple: true, error: "选项已变" },
    { ...material, key: "label", type: "text", maxLength: 20, label: "简短描述" },
    { ...material, key: "length", type: "number", max: 10, label: "长度" },
    { ...material, key: "format", type: "checkbox", label: "可叠放" },
  ];
  const writes = [];
  const recovery = await recoverListingFields({ scope: shop, snapshot: state(fields), read: async () => state([]),
    readOptions: async () => ["金属", "玻璃"],
    suggest: async () => ({ material: ["不存在"], label: "日常收纳", length: 3, format: true }),
    apply: async values => { writes.push(values); return { ok: true, items: [] }; },
  });
  assert.deepEqual(writes, [{ label: "日常收纳", length: 3, format: true }]);
  assert.deepEqual(recovery.issues, []);
});

test("sends category and field instructions with only the selected product photo and scoped options", async () => {
  const settings = { text: { baseUrl: "http://localhost:1234/v1", model: "text" },
    multimodal: { baseUrl: "http://localhost:1234/v1", model: "vision" } };
  const file = new File(["png"], "cup.png", { type: "image/png" });
  const calls = [];
  const advisor = createListingAdvisor({
    settings, product: { title: "保温杯", operatorNotes: "品牌无要求" }, referenceImages: [{ role: "main", file }],
    async request(model, payload) {
      calls.push({ model, payload });
      return calls.length === 1 ? '{"keywords":["保温杯","杯子"]}' : '{"material":"纯金属"}';
    },
  });
  assert.deepEqual(await advisor.categoryKeywords({ sourceCategories: ["饮具"] }), ["保温杯", "杯子"]);
  assert.deepEqual(await advisor.fields([{ ...material, options: ["纯金属", "玻璃"] }]), { material: "纯金属" });
  assert.ok(calls.every(call => call.model.model === "vision"));
  const content = calls[1].payload.messages.at(-1).content;
  assert.match(content[0].text, /纯金属/u);
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/u);
});
