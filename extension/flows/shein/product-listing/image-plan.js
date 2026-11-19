const maxGalleryImages = 5;
const array = value => Array.isArray(value) ? value : [];
const nameKey = name => String(name ?? "").normalize("NFKC").trim().replace(/\s+/gu, "").toLowerCase();
const optionKey = options => JSON.stringify(array(options).map(nameKey));
const validOptions = options => Array.isArray(options) && options.length > 0 &&
  options.every(option => typeof option === "string" && nameKey(option));
const pathValue = path => typeof path === "string" && path.length > 0 && !/[\0\\:]/u.test(path) &&
  path.split("/").every(segment => segment && segment !== "." && segment !== "..") ? path : "";
const paths = values => [...new Set(array(values).map(pathValue).filter(Boolean))];
const one = values => values.length === 1 ? values[0] : undefined;

/** Bind product assets to the committed SHEIN media and SKU table rows. */
export function buildSheinImagePlan({ product = {}, variant = {}, rows = [], images = [], tables = {} } = {}) {
  const tasks = [];
  const issues = [];
  const available = array(images).filter(image => pathValue(image?.path));

  const media = array(tables.media).filter(validOptions);
  const supply = array(tables.supply).filter(validOptions);
  const primary = variant.groups?.[0];
  const sourceOptions = array(product.variantGroups?.[0]?.options);
  const imagePaths = roles => paths(available.filter(image => roles.includes(image.role)).map(image => image.path));
  const add = (role, options, image) => tasks.push({ role, options, image });
  const report = (label, code, message) => issues.push({ label, code, message });

  function lookup(path, roles, label) {
    for (const role of roles) {
      const matches = available.filter(image => image.path === path && image.role === role);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        report(label, "MEDIA_ASSET_AMBIGUOUS", `目录有多条相同用途的图片记录，请核对 ${path}。`);
        return;
      }
    }
    report(label, "MEDIA_ASSET_MISSING", `未读取到登记的图片 ${path}。`);
  }

  const mappedOptions = sourceOptions.map(option => {
    const mapped = array(primary?.matches).filter(match => nameKey(match.requested) === nameKey(option.value));
    const committed = array(primary?.values);
    const name = mapped.length ? one(mapped)?.value : option.value;
    return { option, name: one(committed.filter(value => nameKey(value) && nameKey(value) === nameKey(name))) };
  });
  const single = media.length === 1 && sourceOptions.length <= 1 && array(primary?.values).length === 1;
  const galleryRows = mappedOptions.length ? mappedOptions
    : array(primary?.values).map(name => ({ option: {}, name }));
  const plans = [];

  for (const { option, name } of galleryRows) {
    const label = cleanLabel(option.source || option.value || name);
    if (!name || galleryRows.filter(row => nameKey(row.name) === nameKey(name)).length !== 1) {
      report(label, "MEDIA_COLOR_UNVERIFIED", "主规格未唯一匹配到 SHEIN 已选值，图片尚未关联。");
      continue;
    }
    const options = one(media.filter(row => nameKey(row[0]) === nameKey(name)));
    if (!options) {
      report(label, "MEDIA_COLOR_ROW_AMBIGUOUS", "未读取到主规格对应的唯一图片行。");
      continue;
    }
    const skuImages = paths(array(rows).filter(row => nameKey(row.options?.[0]) === nameKey(name)).map(row => row.imagePath));
    const defaults = paths(product.mainImages ?? product.shein?.mainImages);
    const main = pathValue(product.imagePath ?? product.shein?.imagePath) || defaults[0] || one(imagePaths(["main"]));
    const heroPath = pathValue(option.imagePath) || one(skuImages) || (single ? main : "");
    plans.push({ option, options, label, heroPath });
  }

  const galleryRoles = ["shared-gallery", "detail"];
  const sharedPaths = paths([
    ...array(product.sharedGalleryImages ?? product.shein?.sharedGalleryImages),
    ...array(product.detailImages ?? product.shein?.detailImages),
    ...imagePaths(galleryRoles),
  ]).filter(path => !plans.some(plan => plan.heroPath === path));
  const shared = plans.some(plan => plan.heroPath)
    ? sharedPaths.map(path => lookup(path, galleryRoles, "公共详情图")).filter(Boolean) : [];
  if (plans.length && !shared.length) {
    report("公共详情图", "MEDIA_SHARED_MISSING", "本次未读取到可复用的详情图，请在卖家页核对各主规格的详情图。");
  } else if (shared.length >= maxGalleryImages) {
    report("公共详情图", "MEDIA_GALLERY_LIMIT", `本次试填为每个主规格安排 ${maxGalleryImages} 张细节图，其中第一张是首图。`);
  }

  for (const { option, options, label, heroPath } of plans) {
    if (!heroPath || plans.filter(plan => plan.heroPath === heroPath).length !== 1) {
      report(label + " 详情图首图", "MEDIA_HERO_UNVERIFIED", "请为每个主规格登记唯一的首图，公共详情图不会补入首图位置。");
    } else {
      const hero = lookup(heroPath, single ? ["variant", "main"] : ["variant"], label + " 详情图首图");
      if (hero) for (const image of [hero, ...shared.slice(0, maxGalleryImages - 1)]) add("detail", options, image);
    }

    for (const [role, field, title] of [["square", "squareImagePath", "方形图"], ["swatch", "swatchImagePath", "色块图"]]) {
      const fallback = single ? pathValue(product[field] ?? product.shein?.[field]) || one(imagePaths([role])) : "";
      const imagePath = pathValue(option[field]) || fallback;
      if (!imagePath) {
        if (role === "square") report(label + " " + title, "MEDIA_SQUARE_MISSING", "请为该主规格单独登记方形图。");
        continue;
      }
      const image = lookup(imagePath, single ? [`variant-${role}`, role] : [`variant-${role}`], label + " " + title);
      if (image) add(role, options, image);
    }
  }

  const skuRows = array(rows).filter(row => validOptions(row.options));
  const skuByPage = new Set(skuRows.map(row => optionKey(row.options)));
  for (const row of skuRows) {
    const key = optionKey(row.options);
    const label = row.options.join(" / ") + " SKU 图";
    if (!pathValue(row.imagePath)) {
      report(label, "MEDIA_SKU_IMAGE_MISSING", "本次未登记该 SKU 的图片，请在卖家页核对。");
      continue;
    }
    const options = one(supply.filter(options => optionKey(options) === key));
    if (!options || skuRows.filter(row => optionKey(row.options) === key).length !== 1) {
      report(label, "MEDIA_SKU_ROW_AMBIGUOUS", "未读取到 SKU 对应的唯一供货行。");
      continue;
    }
    const image = lookup(row.imagePath, ["variant"], label);
    if (image) add("variant", options, image);
  }
  for (const options of supply) {
    const key = optionKey(options);
    if (skuByPage.has(key)) continue;
    report(options.join(" / ") + " SKU 图", "MEDIA_SKU_IMAGE_MISSING", "本次未登记该 SKU 的图片，请在卖家页核对。");
    skuByPage.add(key);
  }

  if (!plans.length && !available.length) {
    report("商品图片", "MEDIA_ASSET_MISSING", "本次未读取到图片，请在卖家页核对必填的详情图、方形图和 SKU 图。");
  } else if (!tasks.length && !issues.length) {
    report("商品图片", "MEDIA_MAPPING_REQUIRED", "未找到图片与已确认规格的唯一对应关系。");
  }
  return { tasks, issues };
}

function cleanLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "主规格";
}
