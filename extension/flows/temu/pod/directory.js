import { imageBytes, resizePodImage } from "./service.js";
import { kitViews } from "./product-kit.js";

const imagePattern = /\.(?:jpe?g|png|webp|avif)$/iu;
const displayFiles = names => [...names].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
const chartName = name => /size.?chart|size[-_.]|尺码|尺寸/iu.test(name);

async function fileAt(directory, path) {
  const fields = String(path || "").split("/");
  if (!path || fields.some(name => !name || name === ".." || name === "." || name.includes("\\"))) return null;
  try {
    for (const part of fields.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return await (await directory.getFileHandle(fields.at(-1))).getFile();
  } catch { return null; }
}

async function listFolder(directory, depth) {
  let product;
  const files = [];
  const dirs = [];
  for await (const [name, handle] of directory.entries()) {
    if (name.startsWith(".")) continue;
    if (handle.kind === "directory") dirs.push(handle);
    if (handle.kind === "file" && imagePattern.test(name)) files.push(name);
    if (handle.kind === "file" && name === "product.json") {
      try { product = JSON.parse(await (await handle.getFile()).text()); }
      catch { throw new Error(`无法读取「${directory.name}」的商品资料。`); }
    }
  }
  if (product) {
    const path = product.imagePath || product.mainImages?.[0] || product.imageFiles?.find(asset => asset.role === "main")?.path ||
      displayFiles(files).find(name => !chartName(name));
    const photo = await fileAt(directory, path);
    if (!photo) return [];
    const size = await fileAt(directory, product.sizeChartImagePath || displayFiles(files).find(chartName));
    return [{ name: product.title || directory.name, photo, product, size }];
  }
  const groups = new Map();
  for (const name of displayFiles(files).filter(name => !chartName(name))) {
    const stem = name.replace(imagePattern, "").replace(/[-_][1-9]\d*$/u, "");
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(name);
  }
  const assets = [];
  for (const [name, members] of groups) {
    const photo = await fileAt(directory, members[0]);
    if (!photo) continue;
    const chart = displayFiles(files).filter(chartName).filter(file =>
      groups.size === 1 || file.toLowerCase().startsWith(name.toLowerCase()));
    const size = chart.length === 1 ? await fileAt(directory, chart[0]) : null;
    assets.push({ name, photo, size });
  }
  if (depth >= 3) return assets;
  for (const child of dirs) assets.push(...await listFolder(child, depth + 1));
  return assets;
}

export const readPodDirectory = directory => listFolder(directory, 0);

async function put(directory, name, contents) {
  const handle = await directory.getFileHandle(name, { create: true });
  const stream = await handle.createWritable();
  try {
    await stream.write(contents);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

const simple = value => Array.from(String(value || "").replace(/[\\/:*?"<>|\x00-\x1f]/gu, "-").trim()).slice(0, 27).join("");
const withoutImage = ({ image, imagePath, ...fields }) => fields;

export async function saveArtwork(root, item, artwork) {
  if (artwork.approved !== true) throw new Error("请先人工核对并确认这张富图。");
  const { bytes, type } = await imageBytes(artwork.photo);
  const dir = await root.getDirectoryHandle(`${simple(item.name)}-${simple(artwork.theme)}-${crypto.randomUUID().slice(0, 8)}`, { create: true });
  const images = await dir.getDirectoryHandle("images", { create: true });
  const source = await dir.getDirectoryHandle("参考资料", { create: true });
  const original = await imageBytes(item.photo);
  const extension = mime => mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
  const name = "main." + extension(type);
  await put(images, name, bytes);
  await put(source, "original." + extension(original.type), original.bytes);
  const imagePath = "images/" + name;
  let sizeChartImagePath;
  if (item.size) {
    const size = await imageBytes(item.size);
    if (size.bytes.length <= 4 * 1024 * 1024) {
      const sizeFile = "size-chart." + extension(size.type);
      await put(images, sizeFile, size.bytes);
      sizeChartImagePath = "images/" + sizeFile;
    }
  }
  const { imagePath: _oldPath, images: _oldImages, imageFiles: _oldFiles, detailImages: _oldDetail,
    mainImages: _oldMain, sizeChartImagePath: _oldChart, sizeChartImage: _oldRemoteChart, ...previous } = item.product || {};
  const title = artwork.theme === "纯色底图" ? `${item.name} · 纯色` : `${item.name} · ${artwork.theme}`;
  const product = { ...previous, schemaVersion: 1, title,
    imagePath, mainImages: [imagePath], imageFiles: [{ path: imagePath, role: "main" }],
    ...(sizeChartImagePath && { sizeChartImagePath }),
    variantGroups: (previous.variantGroups || []).map(group => ({ ...group, options: (group.options || []).map(withoutImage) })),
    skus: (previous.skus || []).map(withoutImage),
    pod: { theme: artwork.theme, model: artwork.model, check: artwork.check, trend: artwork.evidence, approved: true },
  };
  await put(dir, "product.json", JSON.stringify(product, null, 2) + "\n");
  return dir.name;
}


async function writeKitPhoto(images, id, photo, resize) {
  const { bytes, type } = await imageBytes(photo).catch(async () => imageBytes(await resize(photo)));
  const file = id + "." + (type === "image/jpeg" ? "jpg" : type.split("/")[1]);
  await put(images, file, bytes);
  return "images/" + file;
}

export async function saveProductKit(root, item, kit, { resize = resizePodImage } = {}) {
  if (!kit.reviewed) throw new Error("请先核对套图和 SKC。");
  if (Object.keys(kitViews).some(key => !kit.photos[key]) || kit.variants.some(variant => !variant.photo)) {
    throw new Error("还缺少套图或 SKC 图片，请重试未完成的图片。");
  }
  if (kit.size?.source === "estimated" && !kit.sizesReviewed) throw new Error("请先核对 AI 估算的尺码。");
  const id = crypto.randomUUID().slice(0, 8);
  const dir = await root.getDirectoryHandle(`${simple(item.name)}-商品套图-${id}`, { create: true });
  const images = await dir.getDirectoryHandle("images", { create: true });
  const views = Object.fromEntries(await Promise.all(Object.keys(kitViews).map(async key => [
    key, await writeKitPhoto(images, key, kit.photos[key], resize),
  ])));
  const coverView = ["front", "back"].includes(kit.plan.source) ? kit.plan.source : "front";
  const sharedGalleryImages = Object.entries(views).filter(([key]) => key !== coverView).map(([, file]) => file);
  const variants = await Promise.all(kit.variants.map(async (variant, index) => ({
    value: variant.label,
    color: variant.color,
    print: variant.print,
    imagePath: variant.photo === kit.photos[coverView] ? views[coverView] :
      await writeKitPhoto(images, `skc-${index + 1}`, variant.photo, resize),
  })));
  const { imagePath } = variants[0];
  const imageFiles = [
    { path: imagePath, role: "main" },
    ...sharedGalleryImages.map(path => ({ path, role: "detail" })),
    ...variants.map(variant => ({ path: variant.imagePath, role: "variant" })),
  ];
  const sizeChart = kit.size?.chart;
  const sizeChartImagePath = item.size ? await writeKitPhoto(images, "size-chart", await resize(item.size, 1800), resize) : undefined;
  const sizeColumn = sizeChart?.columns.find(column => column === "尺寸（国际）") ??
    sizeChart?.columns.find(column => column.startsWith("尺寸（"));
  const sizes = sizeColumn ? sizeChart.rows.map(row => row[sizeColumn]) : kit.plan.sizes;
  const source = item.product || {};
  const { imagePath: _image, images: _images, imageFiles: _files, mainImages: _main,
    detailImages: _detail, galleryImages: _gallery, sharedGalleryImages: _shared, sizeChart: _chart,
    sizeChartImagePath: _chartPath, sizeChartImage: _chartUrl, sku: _sku, skus: _skus, variant: _variant,
    variantGroups: _groups, sizes: _sizes, temu: _temu, pod: _pod, ...details } = source;
  const product = {
    ...details, schemaVersion: 1, title: item.name.slice(0, 180).replace(/[\uD800-\uDBFF]$/u, ""), imagePath, imageFiles, mainImages: [imagePath, ...sharedGalleryImages],
    galleryImages: sharedGalleryImages, detailImages: sharedGalleryImages, sharedGalleryImages,
    ...(sizes.length && { sizes }),
    ...(sizeChart && { sizeChart }),
    ...(sizeChartImagePath && { sizeChartImagePath }),
    ...(_temu && { temu: { ..._temu, sizes: sizes.length ? sizes : undefined, sharedGalleryImages, sizeChart } }),
    variantGroups: [{ name: "颜色", options: variants.map(row => ({
      value: row.value, imagePath: row.imagePath,
      ...(row.color !== "原色" && { temuValue: row.color }),
    })) }],
    variant: { name: "款式", options: variants.map((row, index) => ({
      option: row.value, sku: `POD-${id}-${index + 1}`, imagePath: row.imagePath,
      price: source.price, quantity: source.quantity,
    })) },
    skus: variants.flatMap((row, index) => (sizes.length ? sizes : [null]).map((size, sizeIndex) => ({
      sellerSku: `POD-${id}-${index + 1}-${sizeIndex + 1}`,
      imagePath: row.imagePath,
      options: { 颜色: row.value, ...(size && { 尺码: size }) },
    }))),
    pod: {
      views, variants, sizeSource: kit.size?.source, sizeReviewed: kit.sizesReviewed,
      sourceView: kit.plan.source, unverifiedViews: Object.keys(kitViews).filter(key => key !== kit.plan.source),
      sharedViewNote: "共用图基于底图原款生成，未随 SKC 改色。",
    },
  };
  await put(dir, "product.json", JSON.stringify(product, null, 2) + "\n");
  return dir.name;
}
