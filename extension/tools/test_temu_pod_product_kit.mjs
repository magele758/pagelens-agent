import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createKit, estimatedPodProgress, kitPrompt, kitTasks, makeKitPlan, prepareKitChart, runKitTasks } from "../flows/temu/pod/product-kit.js";
import { readPodDirectory, saveProductKit } from "../flows/temu/pod/directory.js";
import { loadProductDirectory } from "../../native/product-directory.mjs";
import { normalizeTemuListingInput } from "../flows/temu/product-listing/input.js";
import { normalizeSizeChart } from "../lib/size-chart.mjs";
import { validateProductDirectory } from "../flows/shopee/product-listing/sidepanel/product-directory.js";

const image = new Blob([Uint8Array.of(255,216,255,0,1,2,3,4,5,6,7,8)], { type: "image/jpeg" });
const vision = { multimodal: { baseUrl: "https://example.test/v1", model: "vision", apiKey: "test" } };
const item = { name: "卫衣", photo: image };
const resize = async photo => photo;
const sourceChart = { name: "上衣", unit: "cm", columns: ["尺寸（国际）", "胸围", "上衣长度"], rows: [["S", 104, 66], ["M", 110, 68]] };

test("SKC switches, counts, and prompts keep the original face and requested changes separate", () => {
  const defaults = makeKitPlan();
  assert.equal(defaults.variants.length, 3);
  assert.equal(new Set(defaults.variants.map(row => row.color)).size, 3);
  assert.equal(new Set(defaults.variants.map(row => row.print)).size, 3);
  for (const variant of makeKitPlan({ count: 12 }).variants) {
    const prompt = kitPrompt("front", "front", variant);
    assert.match(prompt, /实际可见的印花为唯一依据/u);
    assert.match(prompt, /不要加入参考图中没有的主题/u);
    assert.match(prompt, /纯色底图保持纯色/u);
    assert.doesNotMatch(prompt, /城市|建筑|街景|海报|山脉/u);
  }
  const pairs = makeKitPlan({ source: "back", count: 4, colorList: "黑色、粉色", designList: "伦敦、纽约" });
  assert.deepEqual(new Set(pairs.variants.map(row => row.label)), new Set(["黑色 伦敦", "黑色 纽约", "粉色 伦敦", "粉色 纽约"]));
  for (const variant of pairs.variants) {
    const prompt = kitPrompt("back", "back", variant);
    assert.ok(prompt.includes(variant.print));
    assert.match(prompt, /清除与新主题无关的旧印花/u);
    assert.doesNotMatch(prompt, /实际可见的印花为唯一依据/u);
  }
  const onlyPrint = makeKitPlan({ recolor: false, originalColor: "黑色" });
  assert.match(kitPrompt("back", "back", onlyPrint.variants[0]), /服装底色与配饰颜色保持不变/u);
  assert.match(kitPrompt("back", "back", onlyPrint.variants[0]), /本款只做这一项微调/u);
  const onlyColor = makeKitPlan({ redesign: false });
  assert.match(kitPrompt("front", "front", onlyColor.variants[0]), /保留现有印花/u);
  assert.equal(makeKitPlan({ recolor: false, redesign: false }).variants.length, 1);
  assert.match(kitPrompt("front", "back"), /绝不镜像或搬到正面/u);
  assert.throws(() => makeKitPlan({ count: 4, colorList: "黑色", designList: "伦敦" }), /只有 1 种/u);
});

test("source image is reused and six image requests run concurrently; retries only failed assets", async () => {
  const plan = makeKitPlan({ source: "back" });
  const kit = createKit(item, plan);
  let active = 0;
  let max = 0;
  let rejectSeam = true;
  const deps = { resize, edit: async (_, photo, prompt) => {
    assert.equal(photo, image);
    max = Math.max(max, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (rejectSeam && prompt.startsWith("参考图是背面图。制作同一件商品的车缝细节")) throw new Error("temporary");
    return image;
  }, prepareChart: async () => ({ chart: normalizeSizeChart(sourceChart), source: "structured" }) };
  const jobs = kitTasks(item, kit, {}, {}, deps);
  assert.equal(jobs.length, 7);
  await runKitTasks(jobs);
  assert.ok(max >= 5);
  assert.equal(kit.photos.back, image);
  assert.equal(kit.errors.seam, "temporary");
  rejectSeam = false;
  const retry = kitTasks(item, kit, {}, {}, deps);
  assert.deepEqual(retry.map(task => task.id), ["seam"]);
  await runKitTasks(retry);
  assert.deepEqual(kit.errors, {});
  assert.equal(kit.variants.filter(row => row.photo).length, 3);

  const detail = createKit(item, makeKitPlan({ source: "seam", recolor: false, redesign: false }));
  await runKitTasks(kitTasks(item, detail, {}, {}, deps));
  assert.equal(detail.variants[0].photo, detail.photos.front);
  assert.equal(kitTasks(item, detail, {}, {}, deps).length, 0);
});

test("progress cannot show 100% while requests are outstanding", () => {
  assert.equal(estimatedPodProgress(0, [0], 1, 25000), 47);
  assert.equal(estimatedPodProgress(0, [0], 1, 150000), 94);
  assert.equal(estimatedPodProgress(100, [0], 101, 150000), 99);
  assert.equal(estimatedPodProgress(6, [], 6, 150000), 100);
});

test("supplier chart wins, explicit chart photo is parsed, missing chart becomes labelled estimates", async () => {
  const plan = makeKitPlan({ sizeList: "S,M" });
  assert.equal((await prepareKitChart({ ...item, product: { sizeChart: sourceChart } }, {}, plan)).source, "structured");
  const parsed = await prepareKitChart({ ...item, product: { sizeChart: sourceChart }, size: image, sizeOverride: true }, vision, plan, {
    resize, parse: async ({ imageDataUrl }) => {
      assert.match(imageDataUrl, /^data:image\/jpeg;base64,/u);
      return normalizeSizeChart(sourceChart);
    },
  });
  assert.equal(parsed.source, "image");
  const estimated = await prepareKitChart(item, vision, plan, {
    resize, invoke: async () => ({ finishReason: "stop", content: JSON.stringify(sourceChart) }),
  });
  assert.equal(estimated.source, "estimated");
  assert.deepEqual(estimated.chart.estimatedColumns, ["胸围", "上衣长度"]);
  await assert.rejects(prepareKitChart(item, vision, makeKitPlan({ sizeList: "L,XL" }), {
    resize, invoke: async () => ({ content: JSON.stringify(sourceChart) }),
  }), /行与指定尺码不符/u);
});

function folder(path) {
  return { name: basename(path),
    async *entries() {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        yield [entry.name, entry.isDirectory() ? { ...folder(join(path, entry.name)), kind: "directory" } : file(path, entry.name)];
      }
    },
    getDirectoryHandle: async name => { const sub = join(path, name); await mkdir(sub, { recursive: true }); return folder(sub); },
    getFileHandle: async name => file(path, name),
  };
}
function file(path, name) {
  return { kind: "file", getFile: async () => new Blob([await readFile(join(path, name))]),
    createWritable: async () => ({
      write: async value => writeFile(join(path, name), value), close: async () => {}, abort: async () => {},
    }),
  };
}

test("exported kit imports through Temu and Shopee with three shared files and distinct SKC photos", async () => {
  const root = await mkdtemp(join(tmpdir(), "pagelens-product-kit-"));
  try {
    const source = { ...item, product: { description: "卫衣", price: 99, quantity: 3 } };
    const kit = createKit(source, makeKitPlan({ source: "back" }));
    await runKitTasks(kitTasks(source, kit, {}, {}, { resize, edit: async () => image,
      prepareChart: async () => ({ chart: normalizeSizeChart(sourceChart), source: "estimated" }),
    }));
    await assert.rejects(saveProductKit(folder(root), source, kit), /核对套图/u);
    kit.reviewed = true;
    await assert.rejects(saveProductKit(folder(root), source, kit), /核对 AI 估算/u);
    kit.sizesReviewed = true;
    // Separate Blob objects simulate individually generated SKC images.
    kit.variants.forEach(option => { option.photo = image.slice(); });
    const name = await saveProductKit(folder(root), source, kit);
    const loaded = loadProductDirectory(root);
    const shopee = validateProductDirectory({ ok: true, ...loaded }).products[0].input;
    assert.equal(shopee.galleryImages.length, 3);
    assert.equal(new Set(shopee.variant.options.map(option => option.imagePath)).size, 3);
    assert.equal(shopee.variant.options[0].price, 99);
    assert.equal(shopee.sizeChart.rows.length, 2);
    const temu = normalizeTemuListingInput(shopee, { root: loaded.root, folder: name });
    assert.equal(temu.sharedGalleryImages.length, 3);
    assert.equal(temu.variantGroups[0].options.length, 3);
    assert.equal(temu.skus.length, 6);
    assert.deepEqual(temu.sizes, ["S", "M"]);
    assert.equal((await readPodDirectory(folder(join(root, name)))).length, 1);
    const json = JSON.parse(await readFile(join(root, name, "product.json"), "utf8"));
    assert.equal(json.pod.sizeSource, "estimated");
  } finally { await rm(root, { recursive: true, force: true }); }
});
