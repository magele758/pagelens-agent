import { imageBytes } from "./service.js";

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
    if (photo) assets.push({ name, photo });
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
