export const MX_APPROVAL_WATCH_KEY = "agentMxApprovalWatch";
const CHECK_INTERVAL_MS = 60_000;
const EXACT_ID = /^\d{12,22}$/;
const PUBLISH_STATES = ["active", "under_review", "inactive", "attention"];
const EDITED_STATES = ["active", "inactive"];

function exactId(value) {
  return typeof value === "string" && EXACT_ID.test(value);
}

function newWatch(job, result, time) {
  const { request } = job;
  const { productId, submitted, verified, status, title } = result;
  if (!exactId(productId)) return null;
  const common = { mode: request.mode, productId, jobId: job.id, nextCheckAt: time + CHECK_INTERVAL_MS };
  if (request.mode === "publish_draft") {
    if (submitted !== true || verified !== true || !PUBLISH_STATES.includes(status) ||
        typeof result.intentAt !== "string" || !Number.isFinite(Date.parse(result.intentAt))) return null;
    if ((result.draftId != null && request.draftId !== result.draftId) ||
        (result.sourceId != null && request.sourceId !== result.sourceId)) return null;
    return { ...common, key: "publish:" + productId + ":" + result.intentAt, intentAt: result.intentAt };
  }
  if (request.mode !== "optimize_listing" || request.productId !== productId || result.changed === false ||
      typeof request.afterTitle !== "string" || !request.afterTitle.trim() || title !== request.afterTitle) return null;
  const review = result.review;
  const pending = status === "optimization_under_review" && submitted === true &&
    review?.productId === productId && review.title === title && review.status === "under_review";
  const changed = result.changed === true && verified === true && EDITED_STATES.includes(status);
  if (!pending && !changed) return null;
  return { ...common, key: "optimize:" + job.id, title };
}

function approved(watch, result) {
  if (result?.verified !== true || result.productId !== watch.productId) return false;
  if (watch.mode === "publish_draft") return result.status === "active";
  return EDITED_STATES.includes(result.status) && result.title === watch.title;
}

export function createMxApprovalWatcher({ storage = chrome.storage.local, now = Date.now, notify }) {
  let queue = Promise.resolve();

  // Manual receipts and alarm polls can arrive together in the service worker.
  function serialized(run) {
    const next = queue.then(run);
    queue = next.catch(() => {});
    return next;
  }

  async function load() {
    const data = (await storage.get(MX_APPROVAL_WATCH_KEY))?.[MX_APPROVAL_WATCH_KEY];
    return {
      watches: Array.isArray(data?.watches) ? data.watches : [],
      nextPollAt: Number.isFinite(data?.nextPollAt) ? data.nextPollAt : 0,
    };
  }

  const save = state => storage.set({ [MX_APPROVAL_WATCH_KEY]: state });

  async function reconcile(state, result) {
    let notified = 0;
    for (const watch of state.watches) {
      if (watch.notifiedAt != null || !approved(watch, result)) continue;
      const title = watch.title ?? result.title ??
        (result.readback?.productId === watch.productId ? result.readback.title : undefined);
      try {
        await notify({
          mode: watch.mode, productId: watch.productId, status: result.status, jobId: watch.jobId,
          ...(typeof title === "string" && title && { title }),
          ...(watch.intentAt && { intentAt: watch.intentAt }),
        });
      } catch {
        // A notification failure leaves the watch eligible for a fresh read.
        continue;
      }
      watch.notifiedAt = now();
      await save(state);
      notified++;
    }
    return notified;
  }

  return {
    record(job, outcome) {
      return serialized(async () => {
        const result = outcome?.ok === true && outcome.result;
        if (job?.action !== "ptc_mx_seller_action" || !job.request ||
            typeof job.id !== "string" || !job.id || !result) return;
        if (job.request.mode === "listing_status") {
          if (!exactId(job.request.productId) || job.request.productId !== result.productId || result.verified !== true)
            return;
          return reconcile(await load(), result);
        }
        const watch = newWatch(job, result, now());
        if (!watch) return;
        const state = await load();
        let entry = state.watches.find(item => item.key === watch.key);
        if (!entry) {
          entry = watch;
          state.watches.push(entry);
          await save(state);
        }
        if (entry.productId !== watch.productId || entry.title !== watch.title || entry.notifiedAt != null) return;
        return reconcile(state, result);
      });
    },

    poll(readStatus) {
      return serialized(async () => {
        const state = await load();
        const time = now();
        if (state.nextPollAt > time) return;
        const due = state.watches.filter(watch => watch.notifiedAt == null && watch.nextCheckAt <= time)
          .sort((a, b) => a.nextCheckAt - b.nextCheckAt)[0];
        if (!due) return;
        state.nextPollAt = due.nextCheckAt = time + CHECK_INTERVAL_MS;
        await save(state);
        let reply;
        try { reply = await readStatus(due.productId); }
        catch { return; }
        const result = reply?.ok === undefined ? reply : reply.ok === true ? reply.result : null;
        if (result?.productId === due.productId) return reconcile(state, result);
      });
    },
  };
}
