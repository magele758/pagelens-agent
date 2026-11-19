const MAX_PRODUCTS = 20;
const MAX_PRODUCT_SIZE = 512 * 1024;
const MAX_IMAGES = 100;
const IMAGE_ROLES = new Map([["main", "main"], ["gallery", "main"], ["detail", "detail"],
  ["variant", "variant"], ["variant-square", "variant-square"], ["variant-swatch", "variant-swatch"],
  ["shared-gallery", "shared-gallery"], ["square", "square"], ["swatch", "swatch"], ["size-chart", "size-chart"]]);
const localImagePath = value => typeof value === "string" && value.length <= 512 &&
  /\.(?:png|jpe?g|gif)$/iu.test(value) && !/[\0\\:]/u.test(value) &&
  value.split("/").every(segment => segment && segment !== "." && segment !== "..");
const array = value => Array.isArray(value) ? value : [];

async function productFile(directory) {
  try {
    return await directory.getFileHandle("product.json");
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

export function parseSheinProductJSON(value) {
  let data;
  try {
    data = JSON.parse(value);
  } catch {
    throw new Error("商品 JSON 格式有误。");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("请填写一个商品 JSON 对象。");
  return data;
}

/** Read the selected manifest or the immediate product folders. */
export async function readSheinProductDirectory(root, { signal } = {}) {
  signal?.throwIfAborted();
  const candidates = [];
  const issues = [];
  const single = await productFile(root);
  if (single) {
    candidates.push([root, single]);
  } else {
    for await (const child of root.values()) {
      signal?.throwIfAborted();
      if (child.kind !== "directory" || child.name.startsWith(".")) continue;
      const manifest = await productFile(child);
      if (!manifest) continue;
      if (candidates.length === MAX_PRODUCTS) {
        throw new Error(`一次最多读取 ${MAX_PRODUCTS} 个商品，请选择较小的目录。`);
      }
      candidates.push([child, manifest]);
    }
  }

  const products = [];
  candidates.sort(([left], [right]) => left.name.localeCompare(right.name, "zh-CN"));
  for (const [directory, handle] of candidates) {
    signal?.throwIfAborted();
    try {
      const file = await handle.getFile();
      if (!file.size || file.size > MAX_PRODUCT_SIZE) throw new Error("product.json 为空或超过 512 KB。");
      const input = parseSheinProductJSON(await file.text());
      if (typeof input.title !== "string" || !input.title.trim()) throw new Error("product.json 缺少商品标题。");
      products.push({ directory, input, title: input.title.trim() });
    } catch (error) {
      issues.push(`${directory.name} · ${error.message || "读取失败"}`);
    }
  }
  signal?.throwIfAborted();
  return { name: root.name, products, issues };
}

export function productImagePaths(input) {
  const variantImages = option => [
    ["variant", option?.imagePath], ["variant-square", option?.squareImagePath], ["variant-swatch", option?.swatchImagePath],
  ];
  const groups = [...array(input.shein?.variantGroups), ...array(input.variantGroups)];
  const pairs = [
    ["main", input.shein?.imagePath ?? input.imagePath],
    ...array(input.shein?.mainImages ?? input.mainImages).map(path => ["main", path]),
    ...array(input.shein?.detailImages ?? input.detailImages).map(path => ["detail", path]),
    ...array(input.shein?.sharedGalleryImages ?? input.sharedGalleryImages).map(path => ["shared-gallery", path]),
    ...groups.flatMap(group => array(group?.options).flatMap(variantImages)),
    ...array(input.variant?.options).flatMap(variantImages),
    ...variantImages(input.variant),
    ...array(input.skus).map(sku => ["variant", sku?.imagePath]),
    ...array(input.shein?.skus).map(sku => ["variant", sku?.imagePath]),
    ["square", input.shein?.squareImagePath ?? input.squareImagePath],
    ["swatch", input.shein?.swatchImagePath ?? input.swatchImagePath],
    ["size-chart", input.sizeChartImagePath],
    ...array(input.imageFiles).map(row => [IMAGE_ROLES.get(row?.role), row?.path]),
  ];
  return [...new Map(pairs.filter(([role, path]) => role && localImagePath(path))
    .map(([role, path]) => [`${role}:${path}`, { role, path }])).values()].slice(0, MAX_IMAGES);
}

/** Load only files listed by this product within the user-selected folder. */
export async function readSheinProductImages(product, { signal } = {}) {
  const images = [];
  const issues = [];
  const files = new Map();
  for (const { role, path } of productImagePaths(product.input)) {
    signal?.throwIfAborted();
    const parts = path.split("/");
    const name = parts.pop();
    if (!files.has(path)) {
      try {
        let directory = product.directory;
        for (const segment of parts) directory = await directory.getDirectoryHandle(segment);
        const entry = await directory.getFileHandle(name);
        const file = await entry.getFile();
        if (!file.size || !/^image\/(?:png|jpeg|gif)$/u.test(file.type)) throw new Error("图片格式无效。");
        files.set(path, file);
      } catch (error) {
        files.set(path, null);
        issues.push(`图片 ${path} · ${error.name === "NotFoundError" ? "目录中未找到" : error.message || "无法读取"}`);
      }
    }
    const file = files.get(path);
    if (file) images.push({ role, file, name, path });
  }
  signal?.throwIfAborted();
  return { images, issues };
}
