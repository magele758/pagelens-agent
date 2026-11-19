const maximumKeywords = 6;
const maximumEntries = 96;
const retention = 90 * 24 * 60 * 60 * 1000;
const missCodes = new Set(["CATEGORY_SEARCH_NO_MATCH", "CATEGORY_SEARCH_EMPTY"]);
const clean = value => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const fold = value => clean(value).toLowerCase();
const list = value => Array.isArray(value) ? value : [value];
const validKeyword = value => Boolean(value && value.length <= 70 && !/[\u0000-\u001f\u007f]/u.test(value));
const validPath = value => Array.isArray(value) && value.length >= 2 && value.length <= 8 &&
  value.every(part => typeof part === "string" && clean(part) && clean(part).length <= 90);
const fail = (code, message) => ({ ok: false, code, message });

function keywords(values) {
  const unique = new Map();
  for (const value of values.map(clean).filter(validKeyword)) {
    if (!unique.has(fold(value))) unique.set(fold(value), value);
  }
  return [...unique.values()];
}

function storageKey(storeKey) {
  return /^(?:GS\d{4,20})$/iu.test(storeKey) ? `pagelens.shein.category-keywords.v1.${storeKey.toUpperCase()}` : "";
}

async function readEntries(storage, key) {
  if (!key || !storage?.get) return [];
  try {
    const data = (await storage.get(key))?.[key];
    const loaded = Array.isArray(data) ? data : [];
    const now = Date.now();
    return loaded.filter(entry => validKeyword(clean(entry?.keyword)) && validPath(entry?.path) &&
      Number.isFinite(entry?.learnedAt) && entry.learnedAt <= now && now - entry.learnedAt <= retention)
      .slice(0, maximumEntries);
  } catch {
    return [];
  }
}

async function remember(storage, key, keyword, path) {
  if (!key || !storage?.set || !validPath(path)) return;
  try {
    const current = await readEntries(storage, key);
    const entries = [{ keyword, path, learnedAt: Date.now() }, ...current.filter(entry => fold(entry.keyword) !== fold(keyword))];
    await storage.set({ [key]: entries.slice(0, maximumEntries) });
  } catch {
    // A browser storage quota error does not invalidate the seller's visible category receipt.
  }
}

function containsKeyword(facts, keyword) {
  if (/\p{Script=Han}/u.test(keyword)) return facts.includes(keyword);
  const escaped = keyword.replace(/[.*+?^$${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u").test(facts);
}

/** The supplied page adapter is pinned to the active SHEIN category tab. */
export async function resolveSheinCategory({ callPage, input = {}, suggestKeywords, storage, signal } = {}) {
  signal?.throwIfAborted();
  const requestedBrand = clean(input.shein?.brand ?? input.brand);
  const brand = /^(?:无品牌|nobrand|unbranded)$/iu.test(requestedBrand) ? "" : requestedBrand;
  const selected = await callPage({ kind: "inspect" });
  if (!selected.ok || selected.selectedPath?.length) return selected;

  const storeKey = clean(selected.storeKey);
  const cacheKey = storageKey(storeKey);
  const remembered = await readEntries(storage, cacheKey);
  const byKeyword = new Map(remembered.map(entry => [fold(entry.keyword), entry.path]));
  const title = clean(input.title ?? input.englishTitle ?? input.shein?.englishTitle);
  const description = clean(input.description ?? input.englishDescription ?? input.shein?.englishDescription);
  const sourceCategories = [...list(input.category), ...list(input.shein?.category)];
  const hints = [...list(input.categoryKeywords), ...list(input.shein?.categoryKeywords), ...list(input.categoryHint),
    ...sourceCategories.flatMap(value => clean(value).split(/\s*[>/›＞]\s*/u).slice(-2).reverse())];
  const facts = [title, description.slice(0, 2000), ...hints].map(fold).join(" ");
  const cached = remembered.filter(entry => containsKeyword(facts, fold(entry.keyword)))
    .sort((a, b) => b.keyword.length - a.keyword.length).slice(0, 2).map(entry => entry.keyword);
  const attempted = new Set();

  async function search(candidates) {
    for (const keyword of keywords(candidates)) {
      const key = fold(keyword);
      if (attempted.has(key)) continue;
      if (attempted.size === maximumKeywords) break;
      attempted.add(key);
      signal?.throwIfAborted();
      const receipt = await callPage({ kind: "search", keyword, preferredPath: byKeyword.get(key), brand,
        ...(cacheKey && { storeKey }) });
      signal?.throwIfAborted();
      if (receipt.ok) {
        if (!receipt.canAdvance || !validPath(receipt.selectedPath)) {
          return fail("CATEGORY_NOT_CONFIRMED", "SHEIN 未回显可用的末级分类，请核对当前分类。");
        }
        if (cacheKey && clean(receipt.storeKey) === storeKey) await remember(storage, cacheKey, keyword, receipt.selectedPath);
        return receipt;
      }
      if (!missCodes.has(receipt.code)) return receipt;
    }
    return null;
  }

  const specificTitle = /^(?:[A-Za-z0-9]+[ -])?\p{Script=Han}{2,8}$/u.test(title) ? [title] : [];
  const direct = await search(keywords([...cached, ...hints, ...specificTitle]).slice(0, 3));
  if (direct) return direct;
  let suggested = [];
  if (typeof suggestKeywords === "function") {
    try {
      const result = await suggestKeywords({ title, description, sourceCategories: keywords(sourceCategories), signal });
      suggested = Array.isArray(result) ? result : result?.keywords ?? [];
    } catch (error) {
      signal?.throwIfAborted();
      const exactTitle = await search([title]);
      return exactTitle || fail("CATEGORY_MODEL_UNAVAILABLE", error?.message || "暂时无法生成商品分类关键词。");
    }
  }
  const found = await search([...list(suggested).slice(0, maximumKeywords), title]);
  return found || fail("CATEGORY_SEARCH_NO_MATCH", "SHEIN 搜索未找到可用的末级分类，请核对商品分类。");
}
