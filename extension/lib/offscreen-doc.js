/**
 * Service-worker side view of the shared offscreen document.
 * Chrome allows one offscreen document per extension.
 * This module no longer opens or closes that document.
 */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createOffscreenDoc({ chromeApi, sleep = wait } = {}) {
  const api = () => chromeApi || globalThis.chrome;
  let lifecycle = Promise.resolve();
  /** Serializes overlapping calls on this handle. */
  const exclusive = fn => {
    const run = lifecycle.then(fn, fn);
    lifecycle = run.catch(() => {});
    return run;
  };

  async function state() {
    let contexts;
    try {
      contexts = await api().runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    } catch {
      return (await api().offscreen?.hasDocument?.().catch(() => false)) ? "other" : "none";
    }
    if (!contexts?.length) return "none";
    return "other";
  }

  async function send(payload) {
    let last = null;
    for (let i = 0; i < 8; i += 1) {
      try {
        const res = await api().runtime.sendMessage(payload);
        if (res) return res;
      } catch (err) {
        last = err;
      }
      await sleep(60);
    }
    throw last || new Error("offscreen 未响应");
  }

  async function ensure() {}

  /** Does not close the offscreen document. */
  function release() {
    return exclusive(async () => false);
  }

  return {
    state,
    exists: async () => (await state()) === "audio",
    ensure: () => exclusive(ensure),
    withDocument: fn => exclusive(async () => { await ensure(); return fn(); }),
    send,
    release,
  };
}

export const offscreenDoc = createOffscreenDoc();
