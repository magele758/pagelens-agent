const origin = "https://seller.tiktokshopglobalselling.com";
const numericId = /^\d{12,22}$/;
export const mxOrderUrl = origin + "/order?shop_region=MX";
export const mxManageUrl = origin + "/product/manage?shop_region=MX";
export const mxDraftUrl = id => origin + "/product/edit-draft/" + id + "?shop_region=MX";
export const mxOrderStatuses = ["all", "to_ship", "shipped", "completed", "cancelled"];

function fields(body, names, optional = []) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      names.some(name => !Object.hasOwn(body, name)) ||
      Object.keys(body).some(name => !names.includes(name) && !optional.includes(name)))
    throw Error("Unexpected TikTok MX seller request fields");
}

function id(value) {
  if (typeof value !== "string" || !numericId.test(value)) throw Error("Expected an exact TikTok product ID");
  return value;
}

export function mxPriceCents(price) {
  const cents = Math.round(price * 100);
  if (typeof price !== "number" || !Number.isSafeInteger(cents) || cents <= 0 || cents / 100 !== price)
    throw Error("Expected a positive MXN price, to cent precision");
  return cents;
}

function prices(rows, includeStock = false) {
  if (!Array.isArray(rows) || !rows.length) throw Error("Expected exact SKU rows and MXN prices");
  const labels = new Set();
  return rows.map(row => {
    fields(row, ["label", "priceMXN", ...(includeStock ? ["stock"] : [])]);
    const { label, priceMXN, stock } = row;
    if (typeof label !== "string" || label.trim() !== label || labels.has(label))
      throw Error("Expected unique seller SKU labels");
    labels.add(label);
    mxPriceCents(priceMXN);
    if (includeStock && (!Number.isSafeInteger(stock) || stock < 0))
      throw Error("Expected confirmed fulfillable inventory for every SKU");
    return includeStock ? { label, priceMXN, stock } : { label, priceMXN };
  });
}

function draft(body) {
  return { mode: body.mode, sourceId: id(body.sourceId), draftId: id(body.draftId) };
}

export function mxSellerRequest(body) {
  switch (body?.mode) {
    case "reprice_draft":
      fields(body, ["mode", "sourceId", "draftId", "baselinePricesMXN", "multiplier"]);
      if (![10, 100].includes(body.multiplier)) throw Error("Expected an explicit 10× or 100× test price multiplier");
      return { ...draft(body), baselinePricesMXN: prices(body.baselinePricesMXN), multiplier: body.multiplier };
    case "publish_draft": {
      fields(body, ["mode", "sourceId", "draftId", "offer"]);
      const { offer } = body;
      fields(offer, ["brand", "packagedWeightGrams", "packageCm", "skus"]);
      if (typeof offer.brand !== "string" || !offer.brand.trim()) throw Error("Expected the confirmed brand");
      fields(offer.packageCm, ["length", "width", "height"]);
      if (![offer.packagedWeightGrams, ...Object.values(offer.packageCm)].every(x => Number.isFinite(x) && x > 0))
        throw Error("Expected confirmed weight and package dimensions");
      return { ...draft(body), offer: {
        brand: offer.brand.trim(), packagedWeightGrams: offer.packagedWeightGrams,
        packageCm: offer.packageCm, skus: prices(offer.skus, true),
      } };
    }
    case "listing_status":
    case "delist_listing":
      fields(body, ["mode", "productId"]);
      return { mode: body.mode, productId: id(body.productId) };
    case "optimize_listing": {
      fields(body, ["mode", "productId", "editorUrl", "beforeTitle", "afterTitle"]);
      const productId = id(body.productId);
      if (!mxSellerUrlAllowed({ mode: body.mode, productId }, body.editorUrl, { destination: true }) ||
          new URL(body.editorUrl).pathname !== "/product/edit/" + productId)
        throw Error("Expected Seller Center's exact product edit link");
      for (const title of [body.beforeTitle, body.afterTitle])
        if (typeof title !== "string" || !title.trim() || title.length > 300 || title.trim() !== title)
          throw Error("Expected the old and new saved Spanish titles");
      return { mode: body.mode, productId, editorUrl: body.editorUrl, beforeTitle: body.beforeTitle, afterTitle: body.afterTitle };
    }
    case "read_orders": {
      fields(body, ["mode"], ["orderStatus"]);
      if (body.orderStatus != null && !mxOrderStatuses.includes(body.orderStatus)) throw Error("Unexpected order status");
      return { mode: body.mode, ...(body.orderStatus != null && { orderStatus: body.orderStatus }) };
    }
    default: throw Error("Unexpected TikTok MX seller action");
  }
}

export function mxSellerUrlAllowed(parameters, url, { destination = false } = {}) {
  let page;
  try { page = new URL(url); } catch { return false; }
  if (page.origin !== origin || page.username || page.password || page.hash) return false;
  if (parameters.mode === "read_orders") {
    const regions = page.searchParams.getAll("shop_region");
    return page.pathname === "/order" && (destination ? page.href === mxOrderUrl :
      !regions.length || (regions.length === 1 && regions[0] === "MX"));
  }
  if (page.searchParams.getAll("shop_region").length !== 1 || page.searchParams.get("shop_region") !== "MX") return false;
  if (parameters.mode === "reprice_draft" || parameters.mode === "publish_draft") {
    if (page.href === mxDraftUrl(parameters.draftId)) return true;
  }
  if (page.pathname === "/product/manage") {
    if (parameters.mode === "reprice_draft" && destination) return false;
    const tabs = page.searchParams.getAll("tab");
    return [...page.searchParams.keys()].every(key => ["shop_region", "tab"].includes(key)) &&
      (!tabs.length || (tabs.length === 1 && ["all", "draft", "active", "deactivate"].includes(tabs[0])));
  }
  return parameters.mode === "optimize_listing" &&
    page.pathname === "/product/edit/" + parameters.productId &&
    [...page.searchParams.keys()].every(key => key === "shop_region") &&
    (!parameters.editorUrl || page.href === parameters.editorUrl);
}
