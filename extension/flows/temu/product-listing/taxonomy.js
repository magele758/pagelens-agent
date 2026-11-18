const DATA = new URL("./taxonomy/", import.meta.url);
const caches = new WeakMap();
const text = value => typeof value === "string" ? value.trim() : Number.isSafeInteger(value) ? String(value) : "";
const key = value => text(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const searchParts = value => text(value).normalize("NFKC").toLowerCase().split(/[\p{P}\p{S}\s]+/u).filter(Boolean);

function resource(file, fetchImpl, decode) {
  const cache = caches.get(fetchImpl) ?? new Map();
  caches.set(fetchImpl, cache);
  if (!cache.has(file)) {
    const pending = (async () => {
      const response = await fetchImpl(new URL(file, DATA));
      if (!response.ok) throw new Error("无法加载插件内置的 Temu 目录。");
      return decode(response);
    })().catch(error => {
      cache.delete(file);
      throw error;
    });
    cache.set(file, pending);
  }
  return cache.get(file);
}

function unpackLeaves(node, prefix = [], leaves = []) {
  const [id, label, children] = node;
  const path = [...prefix, label];
  if (children?.length) {
    for (const child of children) unpackLeaves(child, path, leaves);
  } else {
    leaves.push({ id: String(id), path, name: key(label), full: key(path.join(" ")) });
  }
  return leaves;
}

const readJson = response => response.json();
async function readCategory(response) {
  const json = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
  return unpackLeaves(json);
}

export async function loadTemuCategoryRoots({ fetchImpl = fetch } = {}) {
  const roots = await resource("roots.json", fetchImpl, readJson);
  return roots.map(([id, label]) => ({ id: String(id), label }));
}

function rank(entry, value, tokens) {
  if (entry.id === value) return 6;
  if (entry.full === value) return 5;
  if (entry.name === value) return 4;
  if (entry.name.startsWith(value)) return 3;
  if (entry.name.includes(value)) return 2;
  return tokens.every(part => entry.full.includes(part)) ? 1 : 0;
}

export async function searchTemuCategories(query, { rootId, limit = 30, fetchImpl = fetch } = {}) {
  const value = key(query);
  const max = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 30;
  if ((!value && !rootId) || !max) return [];
  const roots = await loadTemuCategoryRoots({ fetchImpl });
  let selected = rootId == null ? roots : roots.filter(root => root.id === String(rootId));
  if (rootId == null) {
    // A full breadcrumb starts with its top-level label, so it needs only one shard.
    const matchingRoots = roots.filter(root => value.startsWith(key(root.label)));
    if (matchingRoots.length) selected = matchingRoots;
  }
  const branches = await Promise.all(selected.map(({ id }) => resource(`category-${id}.json.gz`, fetchImpl, readCategory)));
  const tokens = searchParts(query);
  const matches = [];
  for (const branch of branches) {
    for (const entry of branch) {
      const score = value ? rank(entry, value, tokens) : 1;
      if (score) matches.push({ entry, score });
    }
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, max)
    .map(({ entry: { id, path } }) => ({ id, path: [...path] }));
}

export async function loadTemuOrigins({ fetchImpl = fetch } = {}) {
  const rows = await resource("origins.json", fetchImpl, readJson);
  return rows.map(([country, aliases, regions]) => ({ country, aliases: [...aliases], regions: [...regions] }));
}
