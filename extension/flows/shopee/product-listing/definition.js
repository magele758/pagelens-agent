import { id, version, replayShopeeListing } from "./listing.flow.mjs";

const origin = "https://seller.shopee.cn";
const path = "/portal/mtsku/new";

function matchesTarget(url, shopId) {
  try {
    const target = new URL(url);
    const shops = target.searchParams.getAll("cnsc_shop_id");
    return target.origin === origin && target.pathname === path &&
      shops.length === 1 && /^\d+$/.test(shops[0]) && (shopId == null || shops[0] === shopId);
  } catch {
    return false;
  }
}

export const shopeeProductListing = {
  id,
  version,
  title: "Shopee 商品上架",
  origin,
  path,
  matchesTarget,
  replay: replayShopeeListing,
};
