import assert from "node:assert/strict";
import { replayTemuListing } from "../listing.flow.mjs";
import { createTemuListingToolCaller, readTemuResumeCandidate } from "../tool-adapter.js";

const tabId = 71;
const href = "https://agentseller.temu.com/goods/edit?productDraftId=9461&from=menu";
const documentId = "known-draft-document";
const title = "女式短袖 T 恤";
const categoryPath = ["服装", "女装", "女装T恤"];
const resume = { href, title, categoryPath, site: "美国站", documentId };

function fixture(overrides = {}) {
  const calls = [];
  const api = {
    tabs: { async get(id) { assert.equal(id, tabId); return { id, url: href, ...overrides.tab }; } },
    scripting: {
      async executeScript({ target, func, args: [request] }) {
        assert.equal(target.tabId, tabId);
        assert.equal(request.href, href);
        calls.push({ target, func: func.name, kind: request.kind });
        let result;
        switch (request.kind) {
          case "inspect":
            if (func.name === "temuEditorPage") {
              if (request.categoryPath && JSON.stringify(request.categoryPath) !== JSON.stringify(categoryPath)) {
                result = { ok: false, code: "EDITOR_LOADING" };
              } else {
                result = { ok: true, fields: [{ key: "productName", value: " 女式短袖　Ｔ　恤 " }],
                  uploads: [], hasApparelSizes: true, ...overrides.editor };
              }
            } else {
              result = { ok: true, rows: [{ key: "productSkcList[0].mainSpec[0]", value: "" }], ...overrides.colors };
            }
            break;
          case "inspect-sizes":
            result = overrides.sizes || { ok: false, code: "SPEC_CONTROL_MISSING" };
            break;
          case "write":
            result = { ok: true, status: "filled" };
            break;
          default:
            assert.fail(`Unexpected ${func.name} call ${request.kind}`);
        }
        return [{ documentId: overrides.documentByKind?.[request.kind] || documentId, frameId: 0, result }];
      },
    },
  };
  return { api, calls };
}

{
  const { api, calls } = fixture();
  assert.deepEqual(await readTemuResumeCandidate({ tabId, href, api }), { ok: true, title, documentId });
  assert.deepEqual(calls.map(call => call.kind), ["inspect", "inspect", "inspect-sizes"]);
  assert.deepEqual(calls[0].target, { tabId, frameIds: [0] });
  assert.deepEqual(calls.slice(1).map(call => call.target), [1, 2].map(() => ({ tabId, documentIds: [documentId] })));
  assert.equal((await readTemuResumeCandidate({ tabId, href: href.replace("9461", "9462"), api })).code, "PAGE_CHANGED");
  assert.equal((await readTemuResumeCandidate({ tabId, href: href + "&productId=1", api })).code, "PAGE_CHANGED");
}

for (const [overrides, code] of [
  [{ tab: { pendingUrl: href } }, "PAGE_CHANGED"],
  [{ documentByKind: { "inspect-sizes": "replacement-document" } }, "PAGE_CHANGED"],
  [{ editor: { uploads: [{ markers: 1 }] } }, "RESUME_OCCUPIED"],
  [{ editor: { uploads: [{ selectedFiles: 1 }] } }, "RESUME_OCCUPIED"],
  [{ editor: { skuRows: [{ id: "blue-small", labels: ["蓝色", "S"] }] } }, "RESUME_OCCUPIED"],
  [{ editor: { fields: [{ key: "productName", value: title }, { skuMember: "siteSupplierPriceMap.us", value: "49.00" }] } }, "RESUME_OCCUPIED"],
  [{ colors: { rows: [{ value: "蓝色" }] } }, "RESUME_OCCUPIED"],
  [{ sizes: { ok: true, selectedSizes: ["S"] } }, "RESUME_OCCUPIED"],
  [{ editor: { fields: [{ key: "productEnName", value: title }] } }, "RESUME_UNVERIFIED"],
]) {
  const { api } = fixture(overrides);
  const candidate = await readTemuResumeCandidate({ tabId, href, api });
  assert.equal(candidate.code, code, JSON.stringify(overrides));
}

{
  const { api } = fixture({ editor: { hasApparelSizes: false, skuRows: [{ id: "default", labels: [] }] } });
  assert.equal((await readTemuResumeCandidate({ tabId, href, api })).ok, true,
    "Temu can delay showing the size-chart control until a color is selected");
}

{
  const { api, calls } = fixture();
  const create = options => createTemuListingToolCaller({ tabId, url: href, resume: { ...resume, ...options }, api, cdp: {} });
  const rejected = create({ title: "另外一个商品" });
  assert.equal((await rejected("temu_resume", { tabId, href })).code, "RESUME_UNVERIFIED");
  assert.equal((await rejected("temu_write", { tabId, key: "productName", value: "incorrect" })).code, "ACTION_UNSUPPORTED");
  assert.equal((await create({ categoryPath: ["另一类目"] })("temu_resume", { tabId, href })).code, "EDITOR_LOADING");
  assert.equal((await create({ documentId: "stale-document" })("temu_resume", { tabId, href })).code, "PAGE_CHANGED");

  const call = create();
  assert.equal((await call("temu_category", { tabId })).code, "ACTION_UNSUPPORTED");
  assert.equal((await call("temu_resume", { tabId: tabId + 1, href })).code, "PAGE_CHANGED");
  assert.equal((await call("temu_resume", { tabId, href: href + "&other=1" })).code, "RESUME_UNVERIFIED");
  assert.equal((await call("temu_write", { tabId, key: "productName", value: title })).code, "ACTION_UNSUPPORTED");
  assert.deepEqual(await call("temu_resume", { tabId, href }), { ok: true, href, status: "verified" });
  assert.equal((await call("temu_write", { tabId, key: "productName", value: title })).status, "filled");
  assert.deepEqual(calls.at(-1).target, { tabId, documentIds: [documentId] });
  assert.ok(!calls.some(call => call.func === "temuStagePage"));
}

{
  const input = { title, sites: [resume.site], categoryPath };
  const calls = [];
  const receipt = await replayTemuListing({ tabId, input, resume: { href }, async call(tool, args) {
    calls.push(tool);
    assert.equal(args.tabId, tabId);
    if (tool === "temu_resume") return { ok: true, href, status: "verified" };
    if (tool === "temu_editor_state") return { ok: true, fields: [], uploads: [] };
    if (tool === "temu_apparel" && args.kind === "composition-inspect") return { ok: false, code: "COMPOSITION_MISSING" };
    assert.fail(`Unexpected replay action ${tool}`);
  } });
  assert.equal(receipt.status, "ready-for-review");
  assert.equal(receipt.draftUrl, href);
  assert.deepEqual(calls.slice(0, 2), ["temu_resume", "temu_editor_state"]);
  assert.ok(!calls.some(tool => /category|submit|publish|save/u.test(tool)));

  const switched = await replayTemuListing({ tabId, input, resume: { href }, async call(tool) {
    assert.equal(tool, "temu_resume");
    return { ok: true, href: href + "&other=1" };
  } });
  assert.equal(switched.code, "PAGE_CHANGED");
}

console.log("Temu listing resumes only a matching, untouched draft and keeps write actions pinned to its document.");
