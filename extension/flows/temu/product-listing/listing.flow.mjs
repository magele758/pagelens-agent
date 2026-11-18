export const id = "temu-listing";
export const version = 1;

const keyOf = value => String(value ?? "").trim().normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
const hasValue = value => Array.isArray(value) ? value.length > 0 : value != null && (typeof value !== "string" || value.trim() !== "");
const fatal = new Set(["PAGE_CHANGED", "MODAL_BLOCKED", "EDITOR_LOADING", "FLOW_BUSY", "MENU_STILL_OPEN"]);

function fieldMap(values) {
  return new Map(Object.entries(values || {}).map(([key, value]) => [keyOf(key), value]));
}

function optionAliases(value) {
  const alias = keyOf(value);
  for (const group of [["颜色", "color", "colour"], ["尺码", "尺寸", "size"], ["款式", "style"], ["材质", "material"]]) {
    if (group.includes(alias)) return group;
  }
  return [alias];
}

function skuValue(field, row, input) {
  const dims = [row.lengthCm, row.widthCm, row.heightCm].map(Number).sort((a, b) => b - a);
  const validDimensions = dims.every(value => Number.isFinite(value) && value > 0);
  const values = {
    skuCode: row.sellerSku, inputLen: validDimensions ? dims[0] : undefined,
    inputWidth: validDimensions ? dims[1] : undefined, inputHeight: validDimensions ? dims[2] : undefined,
    inputWeight: row.weightG, quantity: row.quantity, stock: row.quantity,
    usSuggestSalesPrice: row.retailPrice ?? input.retailPrice,
    "productSkuSameReferPrice.url": input.referenceUrl,
    sensitiveAttr: row.sensitiveAttribute ?? input.sensitiveAttribute,
    "productSkuMultiPack.skuClassification": row.skuClassification ?? input.skuClassification,
  };
  const result = field.skuMember.startsWith("siteSupplierPriceMap.") ? row.price : values[field.skuMember];
  return field.multiple && hasValue(result) && !Array.isArray(result) ? [result] : result;
}

function matchingSku(field, rows, rowCount) {
  const labels = new Set((field.rowLabels || []).map(keyOf));
  if (rows.length === 1 && rowCount === 1 && (!Object.keys(rows[0].options || {}).length || !labels.size)) return rows[0];
  const matches = rows.filter(row => {
    const values = Object.values(row.options || {}).map(keyOf);
    return values.length > 0 && values.every(value => labels.has(value));
  });
  if (matches.length === 1) return matches[0];
  return null;
}

export async function replayTemuListing({ tabId, input, call, onStep, signal, suggestFields } = {}) {
  const start = Date.now();
  const items = [];
  const issues = [];
  const attempted = new Set();
  let step = "validate";
  let draftUrl;
  let missing = [];
  let lastState;
  const run = (tool, args) => {
    signal?.throwIfAborted();
    return call(tool, { tabId, ...args });
  };
  const report = (next, label) => {
    step = next;
    onStep?.({ step, label, completed: items.filter(item => ["filled", "verified", "unchanged"].includes(item.status)),
      issues: [...issues] });
  };
  const asIssue = (label, result) => ({
    label, code: result?.code || "UNVERIFIED", message: result?.message || "没有收到可核对的结果。",
  });
  const result = (status, code) => ({
    status, step, ...(code && { code }), ...(draftUrl && { draftUrl }), items, issues, missing,
    elapsedMs: Date.now() - start, fieldCount: lastState?.fields.length || 0,
  });
  const stop = (label, failure) => {
    const problem = asIssue(label, failure);
    issues.push(problem);
    return result("needs-review", problem.code);
  };
  const listMissing = () => (lastState?.fields || []).filter(field => field.required && !hasValue(field.value))
    .map(({ key, label }) => ({ key, label }));
  const record = (label, outcome, key) => {
    const status = outcome?.ok ? outcome.status || "verified" : "needs-review";
    items.push({ ...(key && { key }), label, status });
    if (!outcome?.ok) {
      const problem = asIssue(label, outcome);
      issues.push(problem);
      if (fatal.has(problem.code)) throw Object.assign(new Error(problem.message), { workflowCode: problem.code });
    }
  };
  async function readEditor({ wait = false } = {}) {
    const deadline = Date.now() + (wait ? 12000 : 0);
    do {
      const state = await run("temu_editor_state");
      if (state?.ok) {
        lastState = state;
        return state;
      }
      if (state?.code !== "EDITOR_LOADING" || Date.now() + 250 >= deadline) return state;
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (true);
  }
  async function applyField(field, value) {
    if (!hasValue(value) || attempted.has(field.key)) return;
    attempted.add(field.key);
    const outcome = await run(field.locator ? "temu_select" : "temu_write", { key: field.key, value });
    record(field.label, outcome, field.key);
    return outcome;
  }
  async function chooseCurrentOption(field, wanted) {
    if (!field.locator || !wanted) return wanted;
    const result = await run("temu_field_options", { key: field.key });
    if (!result?.ok) { record(field.label, result, field.key); return undefined; }
    const aliases = optionAliases(wanted);
    const matches = (result.options || []).filter(option => !option.disabled && [option.value, option.label]
      .some(value => aliases.includes(keyOf(value))));
    return matches.length === 1 ? matches[0].value : undefined;
  }
  async function applyApparel(apparel, groups) {
    const color = groups.find(group => optionAliases(group.name).includes("颜色"));
    let rows = apparel.rows;
    for (const option of color?.options || []) {
      const exists = rows.some(row => keyOf(row.value) === keyOf(option.value));
      if (exists) continue;
      let blank = rows.find(row => !hasValue(row.value));
      if (!blank) {
        const added = await run("temu_apparel", { kind: "add-color" });
        if (!added?.ok) { record("服装颜色", added); break; }
        rows = added.rows;
        blank = rows.find(row => !hasValue(row.value));
      }
      if (!blank) {
        record(option.value, { code: "SPEC_CONTROL_MISSING", message: "服装颜色表没有空白可填写行。" });
        break;
      }
      const applied = await run("temu_apparel", { kind: "set-color", key: blank.key, value: option.value });
      record(option.value, applied, blank.key);
      if (!applied?.ok) break;
      const live = await run("temu_apparel", { kind: "inspect" });
      if (!live?.ok) { record("服装颜色", live); break; }
      rows = live.rows;
    }
    const sizeGroup = groups.find(group => optionAliases(group.name).includes("尺码"));
    const sizes = [...new Set(input.sizes || sizeGroup?.options.map(option => option.value) || [])];
    if (!sizes.length) return;
    const system = input.sizeSystem || ((input.sites || [input.site]).includes("美国站") ? "欧美尺码" : "");
    const outcome = await run("temu_apparel", { kind: "set-sizes", value: { system, sizes } });
    for (const item of outcome?.items || []) items.push(item);
    record("尺码", outcome);
    if (outcome?.ok && input.sizeChartTemplate) {
      record("尺码表模板", await run("temu_apparel", { kind: "select-size-chart", value: input.sizeChartTemplate }));
    }
  }
  async function applyComposition() {
    const entries = input.composition || [];
    if (!entries.length) return;
    if (entries.length > 8 || entries.some(entry => !entry.material || !(Number(entry.percent) > 0)) ||
        Math.abs(entries.reduce((sum, entry) => sum + Number(entry.percent), 0) - 100) > 0.001) {
      record("成分比例", { code: "COMPOSITION_INVALID", message: "请按商品资料提供总计 100% 的材料及比例。" });
      return;
    }
    let current = await run("temu_apparel", { kind: "composition-inspect" });
    for (const [index, entry] of entries.entries()) {
      if (current?.ok && index >= current.rows.length) current = await run("temu_apparel", { kind: "composition-add" });
      if (!current?.ok) { record("成分比例", current); return; }
      const row = current.rows[index];
      const fresh = await readEditor();
      if (!fresh?.ok) { record("成分比例", fresh); return; }
      const key = `composition-material-${row?.index}`;
      const field = fresh.fields.find(field => field.key === key);
      if (!field) {
        record(entry.material, { code: "COMPOSITION_MISSING", message: "成分选项行尚未渲染。" });
        return;
      }
      const applied = await applyField(field, entry.material);
      if (!applied?.ok) return;
      const percent = await run("temu_apparel", { kind: "composition-percentage", key: row.index, value: entry.percent });
      record(`${entry.material} · ${entry.percent}%`, percent);
      if (!percent?.ok) return;
    }
  }
  async function applyVariantGroups() {
    if (!input.variantGroups?.length && !input.sizes?.length) return;
    const parentFields = state => state.fields.filter(field => /^父规格\s*[12]/u.test(field.label));
    const groups = (input.variantGroups || []).slice(0, 2);
    if (!parentFields(lastState).length) {
      const apparel = await run("temu_apparel", { kind: "inspect" });
      if (!apparel?.ok) { record("商品规格", apparel); return; }
      if (apparel.rows.length) {
        await applyApparel(apparel, groups);
        return;
      }
    }
    for (const [index, group] of groups.entries()) {
      let live = await readEditor();
      if (!live?.ok) { record("商品规格", live); return; }
      if (index === 1 && parentFields(live).length === 1) {
        const added = await run("temu_add_parent_spec");
        record("添加父规格 2", added);
        if (!added?.ok) break;
        live = await readEditor();
        if (!live?.ok) { record("商品规格", live); return; }
      }
      const parentFieldsAtIndex = parentFields(live).filter(field => keyOf(field.label).startsWith(`父规格${index + 1}`));
      if (parentFieldsAtIndex.length !== 1) {
        record(group.name, { code: "SPEC_CONTROL_MISSING", message: "未定位到可用的父规格下拉，请在 Temu 核对此类目的规格。" });
        continue;
      }
      const parent = parentFieldsAtIndex[0];
      if (!optionAliases(group.name).includes(keyOf(parent.value))) {
        const value = await chooseCurrentOption(parent, group.name);
        if (!value) {
          record(group.name, { code: "SPEC_OPTION_MISSING", message: "Temu 没有唯一匹配的父规格选项。" });
          continue;
        }
        await applyField(parent, value);
      }
      const fresh = await readEditor();
      if (!fresh?.ok) { record("商品规格", fresh); return; }
      const typed = await run("temu_spec_values", { parentIndex: index,
        labels: optionAliases(group.name), values: group.options.map(option => option.value) });
      for (const item of typed?.items || []) items.push(item);
      if (typed?.ok) {
        record(group.name, typed);
        continue;
      }
      if (typed?.items?.length || fatal.has(typed?.code)) { record(group.name, typed); continue; }
      const containers = fresh.fields.filter(field => field.multiple && field.locator && field.key !== parent.key &&
        optionAliases(group.name).includes(keyOf(field.label)));
      if (containers.length === 1) {
        const [target] = containers;
        await applyField(target, group.options.map(option => option.value));
      } else if (group.options.length) {
        const prefix = index === 0 ? /^productSkcList\[\d+\]\.mainSpec\[0\]$/u : /\.subSpec\[\d+\]/u;
        const values = fresh.fields.filter(field => prefix.test(field.key));
        const confirmed = new Set(values.flatMap(field => [keyOf(field.value)]));
        const available = values.filter(field => !hasValue(field.value));
        for (const option of group.options.filter(option => !confirmed.has(keyOf(option.value)))) {
          const target = available.shift();
          if (!target) {
            record(group.name, { code: "SPEC_VALUES_NOT_RENDERED", message: "部分规格值没有可填写的控件，需核对生成的 SKU 行。" });
            break;
          }
          await applyField(target, option.value);
        }
      }
    }
  }
  async function uploadImages(role, paths, state, variant, targetKey) {
    if (!paths?.length) return;
    const label = { main: "商品轮播图", detail: "详情图", "size-chart": "尺码图", variant: "规格图" }[role];
    const targets = state.uploads.filter(target => target.role === role &&
      (!targetKey || target.key === targetKey) && (!variant || keyOf(target.variant) === keyOf(variant)));
    if (targets.length !== 1) {
      record(label, { code: "UPLOAD_CONTROL_MISSING", message: "未找到唯一匹配的图片上传控件。" });
      return;
    }
    const [target] = targets;
    const capacity = role === "main" ? 10 : 8;
    const files = [...new Set(paths)].slice(0, capacity);
    const batches = target.multiple ? [files] : files.map(file => [file]);
    for (const paths of batches) {
      const outcome = await run("temu_upload", { role, key: target.key, identifier: target.variant, paths });
      record(label, outcome, target.key);
      if (!outcome?.ok) break;
    }
  }
  function explicitValue(field) {
    const named = keyOf(field.key);
    const label = keyOf(field.label);
    const direct = attributes.get(named) ?? attributes.get(label);
    if (hasValue(direct)) return direct;
    if (field.skuMember) {
      const rows = input.skus?.length ? input.skus : [input];
      const keys = new Set(lastState.fields.filter(entry => entry.skuMember).map(entry => entry.skuGroup));
      const row = matchingSku(field, rows, keys.size);
      return row && skuValue(field, row, input);
    }
    if (/^productEnName$|^英文(?:商品)?名称$/u.test(field.key === "productEnName" ? field.key : field.label)) {
      return input.englishTitle || (/[a-z]/iu.test(input.title) && !/\p{Script=Han}/u.test(input.title) ? input.title : null);
    }
    if (field.key === "productName" || /^(?:中文)?商品(?:名称|标题)$/u.test(field.label)) return input.title;
    if (/^(?:中文|英文)?商品(?:描述|详情描述)$/u.test(field.label)) return input.description;
    if (/^(?:商家货号|商品货号)$/u.test(field.label)) return input.sku;
    if (/承诺发货时效/u.test(field.label)) return input.handlingTime;
    if (/运费模板/u.test(field.label)) return input.freightTemplate;
    if (field.key === "manufacturingLocation" && input.manufacturingLocation) {
      return field.multiple ? [input.manufacturingLocation] : input.manufacturingLocation;
    }
    return undefined;
  }

  const attributes = fieldMap({ ...input?.attributes, ...input?.listingAttributes });
  try {
    const sites = input?.sites?.length ? input.sites : input?.site ? [input.site] : [];
    if (!Number.isSafeInteger(tabId) || tabId < 1 || typeof call !== "function" ||
        typeof input?.title !== "string" || !input.title.trim() || !sites[0] || sites.length !== 1 ||
        !Array.isArray(input?.categoryPath) || input.categoryPath.length < 1 || !input.categoryPath.every(item => typeof item === "string" && item.trim())) {
      return stop("试填参数", { code: "INPUT_REQUIRED", message: "选择一个经营站点和完整商品类目，再检查商品名称。" });
    }

    report("category", "选择经营站点和商品分类");
    const moved = await run("temu_category", { site: sites[0], categoryPath: input.categoryPath });
    if (!moved?.ok) return stop("经营站点与商品分类", moved);
    draftUrl = moved.href;
    record("经营站点与商品分类", moved);

    report("editor", "读取商品类目表单");
    const first = await readEditor({ wait: true });
    if (!first?.ok) return stop("商品表单", first);
    const country = input.origin?.country || (typeof input.origin === "string" ? input.origin.trim() : "");
    if (country) {
      const countryNames = /^(CN|中国|China|中国大陆)$/iu.test(country) ? [country, "中国", "中国大陆", "China", "中国（大陆）"] : [country];
      const origin = [countryNames];
      if (input.origin?.region) origin.push([input.origin.region]);
      const outcome = await run("temu_origin", { origin });
      record("商品产地", outcome, "productOriginCode");
      attempted.add("productOriginCode");
    }

    report("basic", "填写商品名称和类目属性");
    for (let round = 0; round < 3; round++) {
      const live = round === 0 && !country ? first : await readEditor();
      if (!live?.ok) return stop("商品表单", live);
      const explicit = live.fields.filter(field => !field.skuMember && !attempted.has(field.key) && hasValue(explicitValue(field)));
      if (!explicit.length) break;
      for (const field of explicit) await applyField(field, explicitValue(field));
    }
    const afterBasic = await readEditor();
    if (!afterBasic?.ok) return stop("已填商品复核", afterBasic);
    await applyComposition();
    if (input.shipDays && !input.handlingTime) {
      const shippingFields = afterBasic.fields.filter(field => /承诺发货时效/u.test(field.label) &&
        !attempted.has(field.key) && !hasValue(field.value));
      for (const field of shippingFields) {
        const probed = field.locator ? await run("temu_field_options", { key: field.key }) : { ok: true, options: field.options };
        if (!probed?.ok) { record(field.label, probed, field.key); continue; }
        const matched = (probed.options || []).filter(option => !option.disabled &&
          /^\s*(?:在)?\s*\d+\s*(?:个)?\s*工作日/u.test(option.label) && option.label.match(/\d+/u)?.[0] === String(input.shipDays));
        if (matched.length === 1) await applyField(field, matched[0].value);
      }
    }

    if (typeof suggestFields === "function") {
      report("suggest", "补齐当前类目字段");
      const candidates = afterBasic.fields.filter(field => field.required && !field.skuMember &&
        !attempted.has(field.key) && !hasValue(field.value)).slice(0, 30);
      const fields = [];
      for (const field of candidates) {
        if (field.locator && !field.options?.length) {
          const probed = await run("temu_field_options", { key: field.key });
          if (!probed?.ok && fatal.has(probed?.code)) return stop(field.label, probed);
          if (probed?.ok && probed.options?.length) fields.push({ ...field, options: probed.options });
        } else fields.push(field);
      }
      if (fields.length) {
        try {
          const suggestion = await suggestFields(input, { fields }, { signal });
          for (const field of fields) if (Object.hasOwn(suggestion?.values || {}, field.key)) {
            await applyField(field, suggestion.values[field.key]);
          }
        } catch (error) {
          if (signal?.aborted || error?.workflowCode) throw error;
          issues.push(asIssue("类目资料补齐", { code: "SUGGEST_FAILED", message: error?.message }));
        }
      }
    }

    report("variants", "按当前类目准备规格并填写匹配的 SKU 行");
    await applyVariantGroups();
    const afterVariants = await readEditor();
    if (!afterVariants?.ok) return stop("商品规格", afterVariants);
    for (const field of afterVariants.fields.filter(field => field.skuMember)) await applyField(field, explicitValue(field));
    if (input.skus?.length && !afterVariants.fields.some(field => field.skuMember)) {
      issues.push(asIssue("SKU", { code: "SKU_NOT_RENDERED", message: "当前类目没有生成可填写的 SKU 行。" }));
    }

    report("images", "上传本商品图片并核对页面回显");
    const beforeImages = await readEditor();
    if (!beforeImages?.ok) return stop("图片控件", beforeImages);
    const gallery = input.mainImages || (input.imagePath ? [input.imagePath] : []);
    const requiredGallerySize = beforeImages.uploads.find(target => target.role === "main")?.minimum || 3;
    const galleryFiles = gallery.length < requiredGallerySize && input.variantImages?.length
      ? [...new Set([...gallery, ...input.variantImages])].slice(0, requiredGallerySize)
      : gallery;
    const apparelGalleries = beforeImages.uploads.filter(target => /^productSkcList\[/u.test(target.key) && target.role === "variant");
    if (!apparelGalleries.length || beforeImages.uploads.some(target => target.role === "main")) {
      await uploadImages("main", galleryFiles, beforeImages);
    }
    const detailUpload = beforeImages.uploads.some(target => target.role === "detail");
    if (detailUpload) await uploadImages("detail", input.detailImages, beforeImages);
    if (input.sizeChartImagePath && !input.sizeChartTemplate) {
      if (apparelGalleries.length) {
        record("尺码表模板", { code: "SIZE_CHART_TEMPLATE_REQUIRED",
          message: "目录尺码图已保留。此类目需要选择现有的 Temu 尺码表模板。" });
      } else await uploadImages("size-chart", [input.sizeChartImagePath], beforeImages);
    }
    const groups = input.variantGroups || [];
    const skuImages = beforeImages.uploads.filter(target => target.role === "variant" && target.rowLabels);
    for (const target of skuImages) {
      const row = matchingSku(target, input.skus?.length ? input.skus : [input], skuImages.length);
      if (!row) continue;
      const optionImages = groups.flatMap(group => group.options.filter(option =>
        option.imagePath && Object.values(row.options || {}).some(value => keyOf(value) === keyOf(option.value))).map(option => option.imagePath));
      const image = row.imagePath || optionImages[0] || gallery[0];
      if (image) await uploadImages("variant", [image], beforeImages, undefined, target.key);
    }
    for (const group of groups) for (const option of group.options || []) {
      const matching = beforeImages.uploads.filter(target => target.role === "variant" && keyOf(target.variant) === keyOf(option.value));
      if (matching.length === 1) {
        const image = option.imagePath || (apparelGalleries.length === 1 && group.options.length === 1 ? gallery[0] : "");
        if (image) await uploadImages("variant", [image], beforeImages, option.value, matching[0].key);
      }
    }

    const hasDirectDescription = beforeImages.fields.some(field =>
      /^(?:中文|英文)?商品(?:描述|详情描述)$/u.test(field.label) && field.value === input.description);
    const decorImages = !detailUpload ? [...new Set(input.detailImages || [])].slice(0, 10) : [];
    if (input.description && !hasDirectDescription || decorImages.length) {
      report("description", "填写商品详情图文");
      const description = await run("temu_description", { description: hasDirectDescription ? "" : input.description, paths: decorImages });
      record("详情图文", description);
      if (description?.imageIssue) record("详情图", description.imageIssue);
    }

    report("verify", "复核试填表单");
    const final = await readEditor();
    if (!final?.ok) return stop("试填回读", final);
    missing = listMissing();
    for (const upload of final.uploads || []) {
      if (upload.minimum && upload.markers < upload.minimum) {
        missing.push({ key: upload.key, label: `商品轮播图需至少 ${upload.minimum} 张，已显示 ${upload.markers} 张` });
      }
    }
    for (const message of final.issues || []) issues.push(asIssue("Temu 页面提示", { code: "VALIDATION", message }));
    if (final.truncated) issues.push(asIssue("商品表单", { code: "FIELD_LIMIT", message: "当前表单超出一次试填支持的控件数量。" }));
    return result(issues.length || missing.length ? "needs-review" : "ready-for-review");
  } catch (error) {
    if (signal?.aborted) return result("cancelled", "CANCELLED");
    if (error?.workflowCode) return result("needs-review", error.workflowCode);
    return stop("Temu 试填", { code: "ACTION_FAILED", message: error?.message });
  }
}
