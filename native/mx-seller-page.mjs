import { draftTitleOf, normDraftTitle, sellerVerification } from "../tools/tiktok-mx-editor.mjs";

// Identify a product using its ID in the product column and the state in the
// separate status column. A matching title or SKU is insufficient.
function sellerProductRow(productId) {
  const text = element => element?.innerText?.trim() || "";
  const visible = element => Boolean(element?.getClientRects().length);
  const byText = (parent, selector, label) => [...parent.querySelectorAll(selector)]
    .filter(element => visible(element) && text(element) === label);
  const statusLabels = {
    "在售": "active", "审核中": "under_review", "已下架": "inactive", "草稿": "draft",
    "已删除": "deleted", "需要关注": "attention", "审核未通过": "attention",
  };
  const tables = [...document.querySelectorAll("table,[role=table]")].filter(visible);
  const records = [];
  for (const table of tables) {
    const headers = [...table.querySelectorAll("th,[role=columnheader]")];
    const productColumn = headers.findIndex(header => text(header) === "商品");
    const statusColumn = headers.findIndex(header => text(header) === "状态");
    if (productColumn < 0 || statusColumn < 0) continue;
    for (const row of table.querySelectorAll("tbody tr,[role=row]")) {
      if (!visible(row)) continue;
      const cells = [...row.querySelectorAll("td,[role=cell]")];
      const product = text(cells[productColumn]);
      const matches = [...product.matchAll(/^(?:(?:商品|产品)\s*)?ID\s*[:：]\s*(\d{12,22})\s*$/gim)];
      if (matches.length !== 1 || matches[0][1] !== productId) continue;
      const phrase = text(cells[statusColumn]);
      const label = Object.keys(statusLabels).find(value => phrase === value || phrase.startsWith(value + "\n") || phrase.startsWith(value + " "));
      records.push({ row, productId, status: statusLabels[label] || "unrecognized", statusLabel: phrase,
        title: draftTitleOf(product),
        editLinks: [...row.querySelectorAll("a[href]")].map(a => a.href).filter(href => {
          const url = new URL(href);
          return url.origin === location.origin && url.pathname === "/product/edit/" + productId &&
            url.searchParams.get("shop_region") === "MX";
        }),
        directDelist: byText(row, 'button,[role=button]', "下架"),
      });
    }
  }
  if (records.length > 1) throw Error("More than one visible seller row has this exact product ID");
  return records[0];
}

export function sellerListCode(url, productId, operation = "read") {
  const run = async (address, id, mode) => {
    const guard = () => {
      if (location.href !== address || sellerVerification()) throw Error("Seller product list changed or verification is required");
    };
    let previous = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      guard();
      const content = document.body?.innerText || "";
      const busy = [...document.querySelectorAll('[aria-busy=true],[role=progressbar]')].some(node => node.getClientRects().length);
      const loaded = !busy && content.includes("商品管理") &&
        (content.includes("暂无商品") || document.querySelector("tbody tr,[role=row] [role=cell]"));
      const row = loaded ? sellerProductRow(id) : null;
      const current = row?.statusLabel || (loaded ? "absent" : null);
      if (current && current === previous) {
        if (!row) return { productId: id, status: "not_found", url: address };
        const { productId, status, statusLabel, title, editLinks } = row;
        if (mode === "delist") {
          if (status !== "active") throw Error("The exact product is no longer in the active state");
          if (row.directDelist.length !== 1 || row.directDelist[0].disabled ||
              row.directDelist[0].getAttribute("aria-disabled") === "true")
            throw Error("No unique enabled delist button on the exact product row");
          if ([...document.querySelectorAll('[role=dialog],[aria-modal=true]')].some(el => el.getClientRects().length))
            throw Error("An unexpected seller dialog is open");
          row.directDelist[0].click();
          await new Promise(resolve => setTimeout(resolve, 450));
          const dialogs = [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(el => el.getClientRects().length);
          const dialog = dialogs.map(el => el.innerText.trim()).join(" ").slice(0, 350);
          return { productId, status, dispatched: true, ...(dialog && { dialog }) };
        }
        return { productId, status, statusLabel, title, editLinks, url: address };
      }
      previous = current;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error("Seller product management did not finish loading");
  };
  return [normDraftTitle, draftTitleOf, sellerVerification, sellerProductRow].map(fn => fn.toString()).join("\n") +
    "\nreturn await (" + run.toString() + ")(" + [url, productId, operation].map(x => JSON.stringify(x)).join(",") + ");";
}

// Only a visible, unique action in the exact editor can be triggered. Modal
// confirmations and legal agreements are recorded for the caller to resolve.
export function editorSubmitCode(url, labels) {
  const run = async (address, actions) => {
    const visible = el => Boolean(el?.getClientRects().length);
    const normalize = el => (el.innerText || el.textContent).trim().replace(/\s+/g, " ");
    const dialogs = () => [...document.querySelectorAll('[role=dialog],[aria-modal=true]')].filter(visible);
    const feedback = () => [...document.querySelectorAll('[class*=message-content],[role=alert]')].filter(visible);
    if (location.href !== address || sellerVerification()) throw Error("Seller editor changed or verification is required");
    if (dialogs().length) throw Error("An unexpected seller dialog is open");
    const controls = [...document.querySelectorAll("button")].filter(button => visible(button) && actions.includes(normalize(button)));
    if (controls.length !== 1 || controls[0].disabled || controls[0].getAttribute("aria-disabled") === "true")
      throw Error("Seller submit control is missing, disabled or ambiguous");
    const previous = new Set(feedback().map(normalize));
    controls[0].click();
    for (let attempt = 0; attempt < 24; attempt++) {
      if (sellerVerification()) return { verificationRequired: true };
      const dialog = dialogs().map(normalize).join(" ").slice(0, 350);
      if (dialog) return { dialog };
      const messages = feedback().map(normalize).filter(message => message && !previous.has(message));
      if (messages.length || location.href !== address) {
        const productLinks = feedback().filter(element => /提交成功|发布成功/.test(normalize(element)))
          .flatMap(element => [...element.querySelectorAll("a[href]")])
          .map(link => link.href);
        return { messages, url: location.href, productLinks };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { messages: [], url: location.href };
  };
  return sellerVerification.toString() + "\nreturn await (" + run.toString() + ")(" +
    JSON.stringify(url) + "," + JSON.stringify(labels) + ");";
}
