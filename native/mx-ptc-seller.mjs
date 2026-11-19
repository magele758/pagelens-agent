import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createPtcExecTool } from "@mage-ai-lab/agent-loop/ptc";
import { mxDraftUrl, mxManageUrl, mxSellerRequest } from "../extension/skills/tiktok-mx-draft/tiktok-mx-seller-request.mjs";
import { attributeCode, readFreshDocument, snapshotCode, titleSelector } from "../tools/tiktok-mx-editor.mjs";
import { DraftTabs } from "../tools/tiktok-mx-tabs.mjs";
import { inspectWithPtc } from "./mx-ptc-inspect.mjs";
import { runMxDraftReprice } from "./mx-ptc-reprice.mjs";
import { readMxOrders } from "./mx-ptc-orders.mjs";
import { editorSubmitCode, sellerListCode } from "./mx-seller-page.mjs";

const sellerHome = () => process.env.PAGELENS_HOME || path.join(os.homedir(), ".pagelens");

async function ptcVerify(verify) {
  const executor = createPtcExecTool({ getAuthorizedTools: () => [{
    name: "verify_seller_readback", ptc: { kind: "read" },
    async execute() {
      await verify();
      return { ok: true, content: "verified" };
    },
  }] });
  const reply = await executor.execute(
    { session: { id: randomUUID(), metadata: { orchestrationEngine: "ptc" } } },
    { code: "return (await verify_seller_readback({})).content;", timeoutMs: 10000 },
  );
  if (!reply.ok || JSON.parse(reply.content).result !== "verified") throw Error(reply.content);
  return executor.name;
}

async function withSellerTab(send, url, run) {
  const { tabId } = await send("open_tab", { url, active: false });
  if (!Number.isInteger(tabId)) throw Error("Seller Center did not open a task tab");
  const call = (tool, args) => send(tool, { tabId, ...args });
  let keep = false;
  try {
    const deadline = Date.now() + 15000;
    do {
      const tabs = await send("list_tabs", {});
      if (tabs.some(tab => tab.id === tabId && tab.url === url))
        return await run(call, () => { keep = true; return tabId; });
      await new Promise(resolve => setTimeout(resolve, 150));
    } while (Date.now() < deadline);
    throw Error("The expected Seller Center page did not open");
  } finally {
    if (!keep) {
      try { await call("close_tab", {}); }
      catch (error) { if (!String(error.message).includes("TAB_NOT_FOUND")) throw error; }
    }
  }
}

function refreshedProduct(send, productId, tab = "all") {
  const url = mxManageUrl + "&tab=" + tab;
  return withSellerTab(send, url, call => readFreshDocument(url, call, sellerListCode(url, productId)));
}

function compareOffer(saved, offer) {
  for (const field of ["brand", "packagedWeightGrams"]) {
    if (saved[field] !== offer[field]) throw Error("The saved seller " + field + " differs from the confirmed offer");
  }
  for (const field of ["length", "width", "height"]) {
    if (saved.packageCm[field] !== offer.packageCm[field]) throw Error("The saved package " + field + " differs from the confirmed offer");
  }
  if (saved.skus.length !== offer.skus.length) throw Error("The saved SKU count differs from the confirmed offer");
  for (const { label, priceMXN, stock } of offer.skus) {
    const rows = saved.skus.filter(row => row.label === label);
    if (rows.length !== 1 || rows[0].priceMXN !== priceMXN || rows[0].stock !== stock)
      throw Error("The saved unit price or fulfillable stock differs for SKU " + label);
  }
}

async function writeState(file, state) {
  const tmp = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
}

const releasedStatus = status => ["active", "under_review", "inactive", "attention"].includes(status);

function returnedProductId(signal, draftId) {
  const ids = new Set((signal?.productLinks || []).flatMap(link => {
    const url = new URL(link);
    const match = /^\/product\/edit\/(\d{12,22})$/.exec(url.pathname);
    return match && url.origin === new URL(mxManageUrl).origin && url.searchParams.get("shop_region") === "MX" ? [match[1]] : [];
  }));
  return ids.size === 1 ? [...ids][0] : draftId;
}

async function waitForListing(send, productId) {
  let current;
  for (let attempt = 0; attempt < 3; attempt++) {
    current = await refreshedProduct(send, productId).catch(error => ({ error: error.message }));
    if (releasedStatus(current.status)) break;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1500));
  }
  return current;
}

async function publishDraft(send, { sourceId, draftId, offer }) {
  const link = mxDraftUrl(draftId);
  const home = sellerHome();
  const stateDir = path.join(home, "mx-seller-submissions");
  const statePath = path.join(stateDir, draftId + ".json");
  const lock = path.join(home, "tiktok-mx-" + sourceId + ".lock");
  const tabs = new DraftTabs(sourceId, send);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(lock);
  try {
    let previous;
    try { previous = JSON.parse(await fs.readFile(statePath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (previous?.sourceId && previous.sourceId !== sourceId)
      throw Error("An existing submission bound this draft to another source");
    if (previous) {
      const current = await waitForListing(send, previous.productId || previous.productCandidateId || draftId);
      if (releasedStatus(current.status))
        return { ...previous, ...current, submitted: true, verified: true, changed: false };
      return { ...previous, status: "submission_unconfirmed", verified: false, changed: false };
    }
    const tab = await tabs.open(link, [], false);
    await tabs.waitForUrl(tab, link);
    const call = (tool, args) => send(tool, { tabId: tab, ...args });
    const inspected = await inspectWithPtc({ sourceId, draftId }, async () => {
      const saved = await readFreshDocument(link, call);
      if (saved.hasCategoryAttributes)
        saved.attributeCatalog = (await call("run_js", { code: attributeCode(link) })).result;
      return saved;
    });
    const executor = await ptcVerify(() => compareOffer(inspected, offer));
    const state = { sourceId, draftId, link, executor, intentAt: new Date().toISOString() };
    // Write the intent before submitting so interruption cannot submit twice.
    await writeState(statePath, state);
    tabs.pendingForm = tab;
    let signal;
    try { signal = (await call("run_js", { code: editorSubmitCode(link, ["提交审核"]) })).result; }
    catch (error) { signal = { error: error.message }; }
    const productCandidateId = returnedProductId(signal, draftId);
    if (productCandidateId !== draftId) await writeState(statePath, { ...state, productCandidateId, signal });
    const current = await waitForListing(send, productCandidateId);
    const verified = releasedStatus(current.status);
    const result = { ...state, status: verified ? current.status : "submission_unconfirmed", verified,
      submitted: verified, productCandidateId, ...(verified && { productId: current.productId }), signal, readback: current };
    await writeState(statePath, result);
    if (verified) tabs.pendingForm = null;
    return result;
  } finally {
    try { await tabs.close(); }
    finally { await fs.rmdir(lock); }
  }
}

async function delistProduct(send, { productId }) {
  const current = await refreshedProduct(send, productId, "deactivate");
  if (current.status === "inactive") return { ...current, verified: true, changed: false };
  const url = mxManageUrl + "&tab=active";
  return withSellerTab(send, url, async (call, keepOpen) => {
    const before = await readFreshDocument(url, call, sellerListCode(url, productId));
    if (before.status !== "active") throw Error("Could not verify this exact product as active");
    const signal = (await call("run_js", { code: sellerListCode(url, productId, "delist") })).result;
    const saved = await refreshedProduct(send, productId, "deactivate").catch(error => ({ error: error.message }));
    if (saved.status !== "inactive") return { productId, status: "delist_unconfirmed", verified: false,
      tabId: keepOpen(), signal, readback: saved };
    return { ...saved, changed: true, verified: true, executor: await ptcVerify(() => {
      if (saved.productId !== productId || saved.status !== "inactive") throw Error("Delist readback did not match");
    }) };
  });
}

function comparable(form) {
  const { enTitle, description, enDescription, gallery, detailImages, category, salesAndShipping } = form;
  const { brand, packagedWeightGrams, packageCm, skus } = salesAndShipping;
  return { enTitle, description, enDescription, gallery, detailImages, category,
    brand, packagedWeightGrams, packageCm, skus: skus.map(({ label, priceMXN, stock }) => ({ label, priceMXN, stock })) };
}

async function optimizeProduct(send, { productId, editorUrl, beforeTitle, afterTitle }) {
  const current = await refreshedProduct(send, productId);
  if (!["active", "inactive"].includes(current.status) || !current.editLinks.includes(editorUrl))
    throw Error("Seller Center did not provide that edit link on the exact product row");
  return withSellerTab(send, editorUrl, async call => {
    const before = await readFreshDocument(editorUrl, call);
    if (before.captcha || ![beforeTitle, afterTitle].includes(before.title)) throw Error("The saved product title or verification state changed");
    if (before.title === afterTitle) return { productId, title: afterTitle, verified: true, changed: false };
    const field = await call("run_js", { code:
      "return document.querySelectorAll(" + JSON.stringify(titleSelector) + ").length;" });
    if (field.result !== 1) throw Error("The title input could not be located uniquely");
    const write = await call("trusted_type", { selector: titleSelector, value: afterTitle, clear: true });
    if (!write.ok) throw Error(write.error || "Title input was not written");
    const staged = (await call("run_js", { code: snapshotCode(true, true, true) })).result;
    const compare = form => {
      if (form.url !== editorUrl || form.captcha || form.title !== afterTitle ||
          JSON.stringify(comparable(before)) !== JSON.stringify(comparable(form)))
        throw Error("The exact title and other product fields did not match");
    };
    await ptcVerify(() => compare(staged));
    const signal = (await call("run_js", { code: editorSubmitCode(editorUrl, ["保存", "提交审核"]) })).result;
    if (signal.dialog || signal.verificationRequired || signal.messages?.some(message => /失败/.test(message)))
      return { productId, status: "optimization_unconfirmed", verified: false, signal };
    const saved = await withSellerTab(send, editorUrl, fresh => readFreshDocument(editorUrl, fresh));
    const executor = await ptcVerify(() => compare(saved));
    return { productId, title: afterTitle, verified: true, changed: true, executor, signal };
  });
}

export async function runMxSellerAction(parameters, request) {
  const args = mxSellerRequest(parameters);
  const start = Date.now();
  const send = (tool, payload) => request({ action: "bridge_call", request: { tool, args: payload } });
  let result;
  switch (args.mode) {
    case "reprice_draft": result = await runMxDraftReprice(args, { request }); break;
    case "publish_draft": result = await publishDraft(send, args); break;
    case "listing_status": {
      const current = await refreshedProduct(send, args.productId);
      result = { ...current, verified: !["not_found", "unrecognized"].includes(current.status) };
      break;
    }
    case "delist_listing": result = await delistProduct(send, args); break;
    case "optimize_listing": result = await optimizeProduct(send, args); break;
    case "read_orders": {
      const orders = await readMxOrders(send, args);
      result = { ...orders, executor: await ptcVerify(() => {
        if (!orders.verified || (args.orderStatus && args.orderStatus !== orders.orderStatus) ||
            !Number.isSafeInteger(orders.count) || orders.count < 0) throw Error("Order count or filter could not be verified");
      }) };
      break;
    }
  }
  return { ...result, mode: args.mode, runtime: "pagelens-native", elapsedSeconds: (Date.now() - start) / 1000 };
}
