import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { test } from "node:test";
import { createGeekbiClient } from "../integrations/geekbi/client.js";
import { europeanSites, normalizeCandidates, productForCandidate, reviewPod, sourcingParams, mapPodJobs } from "../flows/temu/pod/service.js";
import { resolvePodImageModel, generatePodImage, arkImageModel } from "../flows/temu/pod/image-model.js";
import { saveArtwork } from "../flows/temu/pod/directory.js";
import { loadProductDirectory } from "../../native/product-directory.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const auth = { enabled: true, appKey: "sample", appSecret: "test-only" };
const image = new Blob([Uint8Array.of(255, 216, 255, 0, 1, 2, 3, 4, 5, 6, 7, 8)], { type: "image/jpeg" });
const site = { name: "Germany", cnName: "德国", siteId: 15, regionId: 76, currency: "EUR" };

test("GeekBI canonical GET/POST, image hash, cache, concurrency, and budget", async () => {
  const data = {};
  let now = 1760000000000;
  let requests = 0;
  const client = createGeekbiClient({
    now: () => now,
    storage: { get: async keys => Object.fromEntries((keys || Object.keys(data)).map(key => [key, data[key]])),
      set: async values => Object.assign(data, values), remove: async keys => keys.forEach(key => delete data[key]) },
    fetcher: async (url, options) => {
      requests++;
      const target = new URL(url);
      const headers = options.headers;
      const values = [options.method, target.pathname, target.search.slice(1), headers["X-GB-Timestamp"], headers["X-GB-Nonce"]];
      if (options.method === "POST") {
        assert.equal(target.search, "?siteId=15");
        const file = options.body.get("file");
        assert.equal(file.type, "image/jpeg");
        const digest = sha(`file:file=${sha(Buffer.from(await file.arrayBuffer()))}&page=1&size=12`);
        assert.equal(headers["X-GB-Body-SHA256"], digest);
        values.push(digest);
      }
      assert.equal(headers["X-GB-Signature"], createHmac("sha256", auth.appSecret).update(values.join("\n")).digest("base64"));
      return Response.json({ code: 0, data: [] });
    },
  });
  await assert.rejects(client.call({ ...auth, enabled: false }, "search"), /启用/u);
  const first = { siteId: 15, keyword: "men's hoodie", page: 1 };
  await Promise.all([client.call(auth, "search", first), client.call(auth, "search", first)]);
  assert.equal(requests, 1);
  assert.equal((await client.call(auth, "search", first)).cached, true);
  await client.call(auth, "search", { ...first, keyword: "trousers" });
  await assert.rejects(client.call(auth, "search", { ...first, keyword: "shirts" }), /2 次/u);
  await client.clearCache();
  await assert.rejects(client.call(auth, "search", first), /2 次/u);
  now += 12 * 60 * 60 * 1000;
  await client.call(auth, "search", first);
  await client.call(auth, "image", { siteId: 15, page: 1, size: 12 }, image);
  assert.equal(requests, 4);
});

test("only EU sites and male apparel reach review, preserving market figures and supplied detail", async () => {
  assert.deepEqual(europeanSites([site, { ...site, name: "United States" }]), [site]);
  assert.equal(sourcingParams({ siteId: 15, keyword: " Men's Hoodie ", growth: "150", sort: "growth" }).weekSoldRateMin, 1.5);
  const raw = { goodsId: "5", goodsNameEn: "Men's graphic hoodie", siteId: 15, minPrice: 16.5,
    thumbnail: "https://img.kwcdn.com/hoodie.jpg", weekSold: 30, weekSoldRate: .2 };
  const candidates = normalizeCandidates([raw, raw, { ...raw, goodsId: "6", goodsNameEn: "Women's Hoodie" },
    { ...raw, goodsId: "7", siteId: 48 }], site);
  assert.deepEqual(candidates.map(item => item.id), ["5"]);
  candidates[0].detail = { goods: { description: "Hooded top", sizeChartImage: "https://img.kwcdn.com/size.png",
    sku: '[{"skuId":"a1","options":{"Size":"M"}}]' }, history: [{ weekSold: 6 }] };
  const product = productForCandidate(candidates[0]);
  assert.equal(product.sourcePrice.currency, "EUR");
  assert.equal(product.sizeChartImage, "https://img.kwcdn.com/size.png");
  assert.equal(product.skus[0].options.Size, "M");
  assert.equal(product.marketResearch.history[0].weekSold, 6);
  const settings = { text: { baseUrl: "https://api.example.test/v1", apiKey: "test", model: "vision" } };
  const report = await reviewPod(settings, { prompt: "Check", photos: [image] }, async (_model, input) => {
    assert.match(input.messages[1].content[1].image_url.url, /^data:image\/jpeg;base64,/u);
    return { content: '{"result":"需修改","evidence":{"口袋":"偏左","帽型":"无变化"}}' };
  });
  assert.match(report.evidence, /口袋：偏左/u);
  assert.deepEqual(await mapPodJobs([1, 2, 3], 2, async n => n * 2), [{ value: 2 }, { value: 4 }, { value: 6 }]);
});

test("image edits use an existing model provider and approved product directories remain importable", async () => {
  const model = resolvePodImageModel({
    text: { model: "text-only" },
    textProviders: [{ id: "ark", name: "Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "test", models: [] }],
  }, { providerId: "ark", modelId: arkImageModel });
  const generated = await generatePodImage(model, image, "London", "print", async (url, req) => {
    assert.ok(url.endsWith("/images/generations"));
    assert.equal(JSON.parse(req.body).model, arkImageModel);
    return Response.json({ data: [{ b64_json: Buffer.from(await image.arrayBuffer()).toString("base64") }] });
  });
  const base = await mkdtemp(join(tmpdir(), "pagelens-pod-"));
  const item = { name: "Hoodie", photo: image, product: { skus: [{ id: "5", imagePath: "old.jpg", options: { Size: "M" } }] } };
  function directory(path) {
    return { name: basename(path),
      getDirectoryHandle: async name => { const dir = join(path, name); await mkdir(dir, { recursive: true }); return directory(dir); },
      getFileHandle: async name => ({ createWritable: async () => ({
        write: async value => writeFile(join(path, name), value), close: async () => {}, abort: async () => {},
      }) }),
    };
  }
  try {
    await assert.rejects(saveArtwork(directory(base), item, { photo: generated }), /人工核对/u);
    const name = await saveArtwork(directory(base), item, { photo: generated, theme: "London", approved: true, model: model.model });
    const product = JSON.parse(await readFile(join(base, name, "product.json"), "utf8"));
    assert.equal(product.imagePath, "images/main.jpg");
    assert.deepEqual(product.skus, [{ id: "5", options: { Size: "M" } }]);
    assert.equal(loadProductDirectory(base).products.length, 1);
  } finally { await rm(base, { recursive: true, force: true }); }
});
