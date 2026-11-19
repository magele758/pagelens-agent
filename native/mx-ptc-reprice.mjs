import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { DraftTabs } from "../tools/tiktok-mx-tabs.mjs";
import { commerceScript, setDraftSkuPrice } from "../tools/tiktok-mx-commerce.mjs";
import {
  readFreshDocument, saveDraftCode, sellerVerification, snapshotCode,
} from "../tools/tiktok-mx-editor.mjs";
import { registeredListing } from "./mx-ptc-inspect.mjs";

const normalizeLabel = label => label.trim().replace(/\s+/g, " ").toLowerCase();
const sameSnapshotValue = (before, after) => JSON.stringify(before) === JSON.stringify(after);
const exactId = /^\d{12,22}$/;

function priceTargets(baseline, multiplier) {
  if (![10, 100].includes(multiplier) || !Array.isArray(baseline) || !baseline.length)
    throw Error("Expected existing SKU prices and a multiplier of 10 or 100");
  const labels = new Set();
  return baseline.map(({ label, priceMXN }) => {
    if (typeof label !== "string" || !label.trim() || labels.has(normalizeLabel(label)))
      throw Error("SKU baseline labels must be unique and nonempty");
    const cents = Math.round(priceMXN * 100);
    if (!Number.isFinite(priceMXN) || cents <= 0 || !Number.isSafeInteger(cents * multiplier) ||
        Math.abs(priceMXN * 100 - cents) > 1e-6)
      throw Error("Invalid MXN baseline price for " + label);
    labels.add(normalizeLabel(label));
    return { label, beforeMXN: cents / 100, afterMXN: cents * multiplier / 100 };
  });
}

function bindPrices(commerce, targets) {
  if (!commerce || commerce.skus.length !== targets.length)
    throw Error("The baseline must cover every SKU in the draft");
  const used = new Set();
  return targets.map(target => {
    const matchingTags = commerce.options.filter(aliases =>
      aliases.some(label => normalizeLabel(label) === normalizeLabel(target.label)));
    if (matchingTags.length !== 1) throw Error("Cannot verify SKU option " + target.label);
    const aliases = matchingTags[0].map(normalizeLabel);
    const available = commerce.skus.filter(row => row.label && aliases.includes(normalizeLabel(row.label)));
    const row = available[0];
    if (available.length !== 1 || used.has(row) || !row.priceField || !Number.isInteger(row.stock) || row.stock < 0)
      throw Error("Cannot verify SKU row or stock for " + target.label);
    if (![target.beforeMXN, target.afterMXN].includes(row.priceMXN))
      throw Error("Current price for " + row.label + " differs from both the baseline and target");
    used.add(row);
    return { ...target, label: row.label, aliases, stock: row.stock, currentMXN: row.priceMXN };
  });
}

function verifyPreserved(before, state, targets) {
  if (state.url !== before.url || state.captcha) throw Error("Wrong draft or seller verification");
  for (const field of ["title", "description", "enTitle", "enDescription", "gallery", "detailImages", "category", "attributes"])
    if (!sameSnapshotValue(before[field], state[field])) throw Error("Unexpected change to draft " + field);
  for (const field of ["brand", "axes", "axisLabels", "options", "weightUnit", "dimensionsInCm", "packagedWeightGrams", "packageCm"])
    if (!sameSnapshotValue(before.salesAndShipping[field], state.salesAndShipping?.[field]))
      throw Error("Unexpected change to draft " + field);
  const rows = bindPrices(state.salesAndShipping, targets);
  for (const [index, row] of rows.entries())
    if (row.stock !== targets[index].stock) throw Error("Unexpected stock change for " + row.label);
  return rows.every(row => row.currentMXN === row.afterMXN);
}

function expectedPriceUpdate(copy, prices, multiplier) {
  if (copy.salesAndShipping?.skus?.length !== prices.length || !copy.salesAndShipping.origins) return null;
  const next = structuredClone(copy);
  const used = new Set();
  for (const sku of next.salesAndShipping.skus) {
    if (typeof sku.option !== "string") return null;
    const matched = prices.filter(row => row.aliases.includes(normalizeLabel(sku.option)));
    const row = matched[0];
    if (matched.length !== 1 || used.has(row) || ![row.beforeMXN, row.afterMXN].includes(sku.priceMXN)) return null;
    used.add(row);
    if (sku.priceMXN === row.afterMXN) continue;
    sku.priceMXN = row.afterMXN;
    next.salesAndShipping.origins[sku.option + ".priceMXN"] = {
      kind: "seller", verified: true, basis: `用户指定卖家草稿售价 MXN ${row.beforeMXN} × ${multiplier}。已刷新核对 MXN ${row.afterMXN}`,
    };
  }
  return next;
}

async function writeJson(file, value) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

async function ptcVerify(before, saved, prices) {
  const executor = createPtcExecTool({ getAuthorizedTools: () => [{
    name: "verify_draft_prices", ptc: { kind: "read" },
    async execute() {
      if (!verifyPreserved(before, saved, prices)) throw Error("Draft prices differ on refreshed readback");
      return { ok: true, content: "verified" };
    },
  }] });
  const result = await executor.execute({ session: { id: randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: "return (await verify_draft_prices({})).content;", timeoutMs: 10000 });
  if (!result.ok || JSON.parse(result.content).result !== "verified") throw Error(result.content);
}

export async function runMxDraftReprice({ sourceId, draftId, baselinePricesMXN, multiplier }, hooks) {
  if (![sourceId, draftId].every(id => typeof id === "string" && exactId.test(id)))
    throw Error("Expected exact TikTok source and draft IDs");
  const targets = priceTargets(baselinePricesMXN, multiplier);
  const start = Date.now();
  const link = "https://seller.tiktokshopglobalselling.com/product/edit-draft/" + draftId + "?shop_region=MX";
  const home = process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");
  const lock = path.join(home, "tiktok-mx-" + sourceId + ".lock");
  const send = (tool, args) => hooks.request({ action: "bridge_call", request: { tool, args } });
  const group = new DraftTabs(sourceId, send);
  const guard = "if(location.href!==" + JSON.stringify(link) + ")throw Error('Wrong draft editor');";
  const verification = sellerVerification.toString() + "\nif(sellerVerification())throw Error('Seller verification is required');";
  const snapshot = snapshotCode(true, true, true);
  let tab;
  const inEditor = (tool, args) => send(tool, { ...args, tabId: tab });
  async function runCode(tabId, code) {
    if (tabId !== tab) throw Error("Wrong tab for draft prices");
    const reply = await inEditor("run_js", { code: guard + code });
    if (!reply?.ok) throw Error(reply?.error || "Draft price editor did not respond");
    return reply.result;
  }
  await fs.mkdir(lock);
  try {
    const { copy, dir } = await (hooks.registeredListing ?? registeredListing)(sourceId, draftId);
    tab = await group.open(link, [], false);
    await group.waitForUrl(tab, link);
    const before = await readFreshDocument(link, inEditor, snapshot);
    if (before.url !== link || before.captcha || before.title !== copy.title)
      throw Error("Draft differs from its source registration or requires seller verification");
    const prices = bindPrices(before.salesAndShipping, targets);
    const changes = prices.filter(row => row.currentMXN !== row.afterMXN);
    let saved = before, signal = null;
    if (changes.length) {
      await inEditor("activate_tab", {});
      group.pendingForm = tab;
      for (const row of changes)
        await runCode(tab, verification + commerceScript(setDraftSkuPrice, row.label, row.beforeMXN, row.afterMXN));
      const staged = await runCode(tab, snapshot);
      if (!verifyPreserved(before, staged, prices)) throw Error("Draft prices differ before saving");
      signal = await runCode(tab, verification + saveDraftCode(link));
      if (/提交失败|保存失败/.test(signal?.message || "")) throw Error(signal.message);
      if (signal?.message?.includes("草稿保存成功") && /\/product\/edit-draft\//.test(signal.url || "") && signal.url !== link)
        throw Error("Seller acknowledged a different draft");
      tab = await group.reopenSavedDraft(tab, link);
      group.pendingForm = tab;
      for (const delay of [0, 1000, 4000]) {
        if (delay) await sleep(delay);
        saved = await readFreshDocument(link, inEditor, snapshot);
        if (verifyPreserved(before, saved, prices)) break;
      }
    }
    await ptcVerify(before, saved, prices);
    const expected = expectedPriceUpdate(copy, prices, multiplier);
    const expectedPlanUpdated = Boolean(expected && !isDeepStrictEqual(copy, expected));
    const receiptFile = path.join(dir, "reprice-" + randomUUID() + "-receipt.json");
    const receipt = {
      verified: true, changed: Boolean(changes.length), sourceId, draftId, link, multiplier,
      prices: prices.map(({ label, stock, beforeMXN, afterMXN }) => ({ label, stock, beforeMXN, afterMXN })),
      expectedPlanUpdated, signal: signal?.message || null, receiptFile,
      elapsedSeconds: (Date.now() - start) / 1000,
    };
    if (expectedPlanUpdated) await writeJson(path.join(dir, "listing.json"), expected);
    await writeJson(receiptFile, receipt);
    group.pendingForm = null;
    return receipt;
  } finally {
    try { await group.close(); }
    finally { await fs.rmdir(lock); }
  }
}
