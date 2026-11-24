const STORAGE_KEY = "pl.temu.productFormSchema.v1";
const ATTRIBUTE_KEY = /^productProperties\[\d+\]$/u;
const STANDARD_FIELD = /^(?:product(?:En)?(?:Name|Desc|Description)|productOriginCode|manufacturingLocation|shipmentLimitSecond|freightTemplateId|apparel-size)$/u;
const SKU_COLUMN = /^(?:skuCode|input(?:Len|Width|Height|Weight)|stock|quantity|usSuggestSalesPrice|sensitiveAttr|siteSupplierPriceMap\.[\w-]+|productSkuSameReferPrice\.url|productSkuMultiPack\.(?:skuClassification|packIncludeInfo))$/u;
const CONTROL_KINDS = new Set(["text", "number", "select", "radio", "checkbox"]);
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_ENTRIES = 120;
const MAX_OPTION_COUNT = 100;
const MAX_CACHE_LENGTH = 350_000;
const MAX_SCHEMAS_PER_CATEGORY = 4;

// All listing runs in a panel share the write queue.
let pending = Promise.resolve();

function scopeKey(scope) {
  const { site, categoryPath, categoryId, storeId } = scope || {};
  if ((typeof site !== "string" && !Number.isFinite(site)) || !String(site).trim() || String(site).length > 100 ||
      !Array.isArray(categoryPath) || !categoryPath.length || categoryPath.length > 12 ||
      categoryPath.some(part => typeof part !== "string" || !part.trim() || part.length > 100)) return null;
  const knownId = value => /^\d{1,24}$/u.test(String(value ?? "")) ? String(value) : null;
  return JSON.stringify([String(site).trim(), categoryPath.map(part => part.trim()), knownId(categoryId), knownId(storeId)]);
}

function descriptor(field) {
  if (!CONTROL_KINDS.has(field?.kind) || typeof field.label !== "string" || !field.label.trim() ||
      field.label.length > 250 || typeof field.key !== "string") return null;
  let key = field.key;
  let section = "basic";
  if (field.skuMember && SKU_COLUMN.test(field.skuMember)) {
    section = "sku";
    key = field.skuMember;
  } else if (ATTRIBUTE_KEY.test(key)) section = "attribute";
  else if (/^composition-material-\d+$/u.test(key)) {
    section = "attribute-table";
    key = "composition-material";
  } else if (/^(?:productSkcList\[\d+\]\.(?:extCode|mainSpec\[0\])|minorSpec\.\d+\.selectedRootSpecId)$/u.test(key)) {
    section = "variant";
    key = key.replace(/^productSkcList\[\d+\]/u, "productSkcList[]");
  } else if (!STANDARD_FIELD.test(key)) return null;
  const { min, max, maxLength } = field;
  return {
    section, key, label: field.label.trim(), kind: field.kind, required: Boolean(field.required),
    multiple: Boolean(field.multiple), adapter: field.locator?.adapter === "temu-select" ? "temu-select" : "native",
    ...(Number.isFinite(min) && { min }), ...(Number.isFinite(max) && { max }),
    ...(Number.isFinite(maxLength) && { maxLength }),
  };
}

function descriptors(fields) {
  const groups = new Map();
  for (const field of fields) {
    const shape = descriptor(field);
    if (!shape) continue;
    const identity = JSON.stringify([shape.section, shape.key]);
    if (!groups.has(identity)) {
      groups.set(identity, shape);
      continue;
    }
    // Repeated rows describe a column only if they agree on its shape.
    if (!["sku", "attribute-table", "variant"].includes(shape.section) ||
        JSON.stringify(groups.get(identity)) !== JSON.stringify(shape)) groups.set(identity, null);
  }
  return [...groups.values()].filter(Boolean).sort((first, second) =>
    first.section.localeCompare(second.section) || first.key.localeCompare(second.key));
}

export function temuCategoryDropdownShape(fields) {
  return JSON.stringify(descriptors(fields).filter(field => field.section === "attribute" && field.kind === "select"));
}

async function signature(shapes) {
  const bytes = new TextEncoder().encode(JSON.stringify(shapes));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function optionKey(scope, field) {
  const category = scopeKey(scope);
  const shape = descriptor(field);
  if (!category || shape?.section !== "attribute" || shape.kind !== "select" ||
      scope.attributeShape != null && !/^[a-f0-9]{64}$/u.test(scope.attributeShape)) return null;
  return JSON.stringify(["options", category, scope.attributeShape ?? null, shape]);
}

function cleanOptions(options) {
  if (!Array.isArray(options) || !options.length || options.length > MAX_OPTION_COUNT) return undefined;
  if (options.some(option => typeof option?.label !== "string" || typeof option.value !== "string" ||
      !option.label.trim() || !option.value.trim() || option.label.length > 500 || option.value.length > 1000)) return undefined;
  return options.map(({ label, value, aliases, disabled }) => ({
    label, value,
    ...(Array.isArray(aliases) && { aliases: aliases.filter(alias => typeof alias === "string" && alias.length <= 500).slice(0, 12) }),
    ...(disabled === true && { disabled: true }),
  }));
}

export function createTemuOptionCache({ storage = globalThis.chrome?.storage?.local, now = Date.now } = {}) {
  const isFresh = ({ savedAt } = {}) => Number.isFinite(savedAt) && savedAt <= now() && now() - savedAt < MAX_AGE_MS;

  async function entries() {
    const result = (await storage?.get(STORAGE_KEY))?.[STORAGE_KEY];
    return Array.isArray(result) ? result.filter(entry => entry && typeof entry.key === "string" && isFresh(entry)) : [];
  }

  function update(change) {
    if (!storage) return Promise.resolve();
    const persist = async () => {
      let length = 2;
      const next = [];
      for (const entry of change(await entries()).slice(0, MAX_ENTRIES)) {
        length += JSON.stringify(entry).length + 1;
        if (length > MAX_CACHE_LENGTH) break;
        next.push(entry);
      }
      await storage.set({ [STORAGE_KEY]: next });
    };
    const locks = globalThis.navigator?.locks;
    pending = pending.then(() => locks ? locks.request(STORAGE_KEY, persist) : persist()).catch(() => {});
    return pending;
  }

  function readOptions(prior, scope, field) {
    const key = optionKey(scope, field);
    return key ? cleanOptions(prior.find(entry => entry.key === key)?.options) : undefined;
  }

  return {
    async read(scope, field) {
      try {
        await pending;
        return readOptions(await entries(), scope, field);
      } catch {
        return undefined;
      }
    },
    async write(scope, field, observed) {
      const key = optionKey(scope, field);
      const options = cleanOptions(observed);
      if (key && options) await update(prior => [{ key, options, savedAt: now() }, ...prior.filter(entry => entry.key !== key)]);
    },
    async invalidate(scope, field) {
      const key = optionKey(scope, field);
      if (key) await update(prior => prior.filter(entry => entry.key !== key));
    },
    async observe(scope, fields, { truncated = false } = {}) {
      const fallback = { fields, schemaCache: { status: "cold", fieldCount: 0 } };
      if (!storage || truncated || !Array.isArray(fields)) return fallback;
      const category = scopeKey(scope);
      const shapes = category && descriptors(fields);
      if (!shapes?.length) return fallback;
      try {
        const [schemaShape, attributeShape] = await Promise.all([
          signature(shapes),
          signature(shapes.filter(field => field.section === "attribute")),
        ]);
        const key = JSON.stringify(["schema", category, schemaShape]);
        const optionsScope = { ...scope, attributeShape };
        await pending;
        const prior = await entries();
        const previous = prior.filter(entry => entry.category === category);
        const status = previous.some(entry => entry.key === key) ? "warm" : previous.length ? "changed" : "cold";
        if (status !== "warm") {
          await update(current => {
            const existing = current.filter(entry => entry.category === category && entry.key !== key);
            const obsolete = new Set(existing.slice(MAX_SCHEMAS_PER_CATEGORY - 1).map(entry => entry.key));
            return [{ key, category, fields: shapes, savedAt: now() },
              ...current.filter(entry => entry.key !== key && !obsolete.has(entry.key))];
          });
        }
        return {
          fields: fields.map(field => {
            if (field.kind !== "select" || !field.locator || field.options?.length) return field;
            const options = readOptions(prior, optionsScope, field);
            return options ? { ...field, options, cachedOptions: true } : field;
          }),
          optionsScope,
          schemaCache: { status, fieldCount: shapes.length },
        };
      } catch {
        return fallback;
      }
    },
  };
}
