const origin = "https://open.geekbi.com";
const prefix = "pagelens.geekbi.";
const ttl = 12 * 60 * 60 * 1000;
const encoder = new TextEncoder();
const hex = bytes => Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
const sha = async value => hex(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : value));
const endpoints = {
  sites: "/api/v2/data/temu/site/list",
  search: "/api/v2/data/temu/goods/search",
  image: "/api/v2/data/temu/goods/search-image",
  detail: "/api/v2/data/temu/goods/detail",
};
export const geekbiSettingsKey = prefix + "settings";
export const geekbiConfigured = settings => Boolean(settings?.enabled && settings.appKey && settings.appSecret);

export function createGeekbiClient({ storage, fetcher = fetch, now = Date.now }) {
  const inFlight = new Map();
  let storageQueue = Promise.resolve();
  const serialized = operation => {
    const pending = storageQueue.then(operation);
    storageQueue = pending.catch(() => {});
    return pending;
  };

  async function call(settings, action, params = {}, photo) {
    if (!geekbiConfigured(settings)) throw new Error("请先在设置中启用并配置极鲸云。");
    if (!Object.hasOwn(endpoints, action)) throw new Error("极鲸云接口不存在。");
    const app = (await sha(settings.appKey)).slice(0, 24);
    const fields = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null && value !== "").sort());
    const query = action === "image" ? "" : fields.toString();
    let form, bodyHash;
    if (action === "image") {
      if (!photo?.size || photo.size > 10 * 1024 * 1024) throw new Error("图搜需要一张不超过 10 MB 的图片。");
      form = new FormData();
      // The image endpoint verifies siteId as a multipart field along with pagination.
      for (const [name, value] of fields) form.append(name, value);
      form.append("file", photo, "reference.jpg");
      const entries = [...fields].map(entry => new URLSearchParams([entry]).toString());
      entries.push("file:file=" + await sha(await photo.arrayBuffer()));
      bodyHash = await sha(entries.sort().join("&"));
    }
    const cacheKey = prefix + "cache." + app + "." + await sha(JSON.stringify([action, query, bodyHash]));
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    const pending = (async () => {
      const allowance = await serialized(async () => {
        const attemptKey = prefix + "attempts." + app + "." + action;
        const saved = await storage.get([cacheKey, attemptKey]);
        const time = now();
        const cached = saved[cacheKey];
        if (cached?.at + ttl > time) return { cached };
        const attempts = (saved[attemptKey] || []).filter(at => at + ttl > time);
        if (action !== "sites" && attempts.length >= 2) {
          throw new Error("此接口最近 12 小时已发起 2 次请求。相同查询仍可使用缓存。");
        }
        await storage.set({ [attemptKey]: [...attempts, time] });
        return {};
      });
      if (allowance.cached) return { data: allowance.cached.data, cached: true, at: allowance.cached.at };
      const path = endpoints[action];
      const method = form ? "POST" : "GET";
      const timestamp = String(Math.floor(now() / 1000));
      const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
      const canonical = [method, path, query, timestamp, nonce, ...(bodyHash ? [bodyHash] : [])].join("\n");
      const key = await crypto.subtle.importKey("raw", encoder.encode(settings.appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
      const response = await fetcher(origin + path + (query ? "?" + query : ""), {
        method, body: form, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000),
        headers: {
          "X-GB-App-Key": settings.appKey, "X-GB-Timestamp": timestamp, "X-GB-Nonce": nonce,
          "X-GB-Signature": btoa(String.fromCharCode(...new Uint8Array(signature))),
          ...(bodyHash && { "X-GB-Body-SHA256": bodyHash }),
        },
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.code !== 0 || body.data == null) {
        const returned = body?.msg || body?.message;
        const message = typeof returned === "string" ? returned.replaceAll(settings.appKey, "…").replaceAll(settings.appSecret, "…").slice(0, 180) : "";
        throw new Error(`极鲸云 ${action} 请求失败（${response.status}${body?.code != null ? ` / ${body.code}` : ""}）${message ? ` ${message}` : ""}`);
      }
      const at = now();
      await storage.set({ [cacheKey]: { at, data: body.data } });
      return { data: body.data, cached: false, at };
    })().finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, pending);
    return pending;
  }

  async function clearCache() {
    await Promise.allSettled([...inFlight.values()]);
    await serialized(async () => {
      const keys = typeof storage.getKeys === "function" ? await storage.getKeys() : Object.keys(await storage.get(null));
      await storage.remove(keys.filter(key => key.startsWith(prefix + "cache.")));
    });
  }
  return { call, clearCache };
}
