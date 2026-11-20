const ORIGIN = 'https://seller.shopee.cn';
const NEW = '/portal/mtsku/new';
const GLOBAL_LIST = '/portal/product/mtsku/list';
const SHOP_LIST = '/portal/product/list/all';
const PUBLISH = '/portal/product-distribute/single-product-publish/';
const RECORDS = '/portal/product-distribute/publish-record';
const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
const ledgerKey = (shopId, sku) => `pl.shopee.submission.v1.${shopId}.${encodeURIComponent(sku)}`;

function target(url, shopId) {
  try {
    const parsed = new URL(url);
    const shops = parsed.searchParams.getAll('cnsc_shop_id');
    return parsed.origin === ORIGIN && shops.length === 1 && shops[0] === String(shopId) ? parsed : null;
  } catch {
    return null;
  }
}

// Runs in the seller tab. All mutations are bound to an exact page, SKU and control.
export function sellerSubmitPage({ action, expectedUrl, title, sku }) {
  const trim = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible' &&
    !el.closest('[hidden],[inert],[aria-hidden=true]');
  const nodes = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const unique = values => values.length === 1 ? values[0] : null;
  const label = el => trim(el.innerText ?? el.textContent);
  const buttons = (root, text) => nodes(root, 'button').filter(el => label(el) === text &&
    !el.disabled && !el.closest('[aria-disabled=true],.disabled,.eds-button--disabled'));
  const modals = nodes(document, '.eds-modal__content,[role=dialog],dialog[open]').filter(el =>
    !el.parentElement?.closest('.eds-modal__content,[role=dialog],dialog[open]'));
  const body = trim(document.body.innerText ?? document.body.textContent);
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn') return { stage: 'page-changed' };
  const path = location.pathname;
  if (path === '/portal/mtsku/new') {
    const fields = nodes(document, '.edit-row').filter(row => {
      const text = trim(row.querySelector(':scope > .edit-label')?.textContent).replace(/^[*＊]\s*/u, '');
      return ['商品名称', '全球商品货号'].includes(text);
    });
    const titlePresent = fields.some(row => trim(row.querySelector('input:not([type=hidden])')?.value) === title);
    const skuPresent = !sku || fields.some(row => trim(row.querySelector('input:not([type=hidden])')?.value) === sku);
    const error = body.match(/仍有\s*\d+\s*个必填字段为空[^。]*。?|(?:创建|提交)失败[^。]*。?/u)?.[0];
    const ready = titlePresent && skuPresent && !error && !modals.length;
    if (ready && ['create', 'publish'].includes(action)) {
      const button = unique(buttons(document, action === 'create' ? '创建' : '创建并发布'));
      if (!button) return { stage: 'form', error: 'Shopee 提交按钮尚不可用。' };
      button.click();
      return { stage: 'clicked' };
    }
    return { stage: 'form', error: error || (modals.length ? label(modals[0]).slice(0, 160) : undefined) };
  }
  if (/^\/portal\/product\/(?:mtsku\/list|list(?:\/all)?)\/?$/u.test(path)) {
    const global = path.includes('/mtsku/');
    const rows = [...document.querySelectorAll('tr,[role=row]')].filter(row =>
      !row.closest('[hidden],[inert],[aria-hidden=true]') && !row.querySelector('tr,[role=row]'));
    const records = [];
    for (const row of rows) {
      const record = label(row) || trim(row.textContent);
      const match = record.match(/全球商品货号\s*[：:]\s*(.*?)\s*商品\s*ID\s*[：:]\s*(\d+)/iu);
      if (!match) continue;
      if (action === 'list-receipts' || (sku ? match[1] === sku : nodes(row, 'a').some(a => label(a) === title))) {
        records.push({ sku: match[1], itemId: match[2] });
      }
    }
    if (action === 'list-receipts') return { stage: 'list-receipts', records };
    const ids = new Set(records.map(record => record.itemId));
    if (ids.size > 1) return { stage: 'ambiguous' };
    if (ids.size === 1) return { stage: global ? 'global-item' : 'shop-item', itemId: [...ids][0] };
    if (['prepare-search', 'search-record'].includes(action) && !modals.length) {
      const field = unique(nodes(document, 'input').filter(el => !el.disabled && !el.readOnly &&
        (global ? el.placeholder === '请输入单字的至少首 2 个字符' :
          trim(el.placeholder) === '搜索商品名称, 全球商品货号, 规格货号, 商品ID')));
      const keyword = global ? title : sku || title;
      if (action === 'prepare-search' && field && keyword) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, keyword);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return { stage: 'search-ready' };
      }
      const apply = unique(buttons(document, global ? '应用' : '套用'));
      if (action === 'search-record' && field?.value === keyword && apply) {
        apply.click();
        return { stage: 'searched' };
      }
    }
    return { stage: global ? 'global-list' : 'shop-list' };
  }
  if (path === '/portal/product-distribute/publish-record') return { stage: 'publish-record' };
  if (path.startsWith('/portal/product-distribute/single-product-publish/')) {
    const itemId = path.match(/\/(\d+)\/?$/u)?.[1];
    if (unique(buttons(document, '下一步：确认商品价格'))) {
      const single = /发布至\s*1\s*店铺/u.test(body);
      if (action === 'next' && single && !modals.length) {
        unique(buttons(document, '下一步：确认商品价格')).click();
        return { stage: 'clicked', itemId };
      }
      return { stage: 'select-shop', itemId, single };
    }
    if (/第2步\s*[：:]\s*确认店铺商品信息/u.test(body)) {
      const shop = body.match(/发布至\s+([A-Z]{2})\s*-\s*([^\s]+)/u)?.slice(1);
      const confirmation = unique(modals.filter(modal =>
        /item will be published to\s+1\s+shop\s+[A-Z]{2}\s+\S+/iu.test(label(modal))));
      if (confirmation) {
        const actual = label(confirmation).match(/item will be published to\s+1\s+shop\s+([A-Z]{2})\s+(\S+)/iu)?.slice(1);
        const sameShop = shop && actual && actual[0] === shop[0] && actual[1] === shop[1];
        const button = unique(buttons(confirmation, '确认'));
        if (action === 'confirm' && sameShop && button) {
          button.click();
          return { stage: 'clicked', itemId };
        }
        return { stage: 'confirm-publish', itemId, sameShop };
      }
      const button = unique(buttons(document, '确认发布'));
      const settled = shop && body.match(/发布至\s+[A-Z]{2}\s*-/gu)?.length === 1;
      if (action === 'review' && settled && button && !modals.length) {
        button.click();
        return { stage: 'clicked', itemId };
      }
      return { stage: 'review-prices', itemId, ready: Boolean(settled && button && !modals.length) };
    }
    return { stage: 'publish-loading', itemId };
  }
  return { stage: 'unrecognized' };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function reconcileShopeeCreated({ tabId, shopId, skus, signal, tabs = chrome.tabs,
  scripting = chrome.scripting, storage = chrome.storage.local }) {
  const matches = new Map();
  const pending = new Set(skus.filter(Boolean));
  if (!pending.size) return matches;
  const deadline = Date.now() + 9000;
  while (pending.size && !signal?.aborted && Date.now() < deadline) {
    const tab = await tabs.get(tabId);
    const url = target(tab?.url, shopId);
    if (url?.pathname === GLOBAL_LIST) {
      let reply;
      try {
        [reply] = await scripting.executeScript({ target: { tabId, frameIds: [0] }, func: sellerSubmitPage,
          args: [{ action: 'list-receipts', expectedUrl: url.href }] });
      } catch {
        if (signal?.aborted) return matches;
      }
      if (reply?.result?.stage === 'list-receipts') {
        const records = reply.result.records;
        for (const sku of pending) {
          const ids = new Set(records.filter(record => record.sku === sku).map(record => record.itemId));
          if (ids.size !== 1) continue;
          const [globalItemId] = ids;
          const key = ledgerKey(shopId, sku);
          const prior = (await storage.get(key))[key];
          if (prior?.stage === 'creating') {
            await storage.set({ [key]: { stage: 'created', globalItemId, updatedAt: Date.now() } });
          }
          matches.set(sku, globalItemId);
          pending.delete(sku);
        }
      }
    }
    if (pending.size) await wait(500);
  }
  return matches;
}

export function checkShopeeSubmission(args) {
  return submitShopeeListing({ ...args, preflight: true });
}

export async function submitShopeeListing({ tabId, shopId, input, mode, replayReceipt, signal, call, onStep, preflight = false,
  tabs = chrome.tabs, scripting = chrome.scripting, storage = chrome.storage.local }) {
  if (!['create', 'publish'].includes(mode) || !preflight && replayReceipt?.status !== 'verified') {
    return { status: 'needs-review', details: '商品表单尚未核对。' };
  }
  const sku = clean(input.sku), title = clean(input.title);
  const key = ledgerKey(shopId, sku || title);
  async function run() {
    let globalItemId;
    let clicked = false;
    const result = (status, details, extra = {}) => ({
      ...replayReceipt, ...extra, status, ...(globalItemId && { globalItemId }), ...(details && { details }),
    });
    const readTab = async () => target((await tabs.get(tabId))?.url, shopId);
    const reached = async pathname => {
      const tab = await tabs.get(tabId);
      if (!tab?.url) return false;
      const url = new URL(tab.url);
      return url.origin === ORIGIN && url.pathname === pathname &&
        (!url.searchParams.has('cnsc_shop_id') || Boolean(target(url, shopId)));
    };
    const operate = async (action, route) => {
      signal?.throwIfAborted();
      const url = await readTab();
      if (!url || !route(url.pathname)) return { stage: 'page-changed' };
      try {
        const [reply] = await scripting.executeScript({
          target: { tabId, frameIds: [0] }, world: 'MAIN', func: sellerSubmitPage,
          args: [{ action, expectedUrl: url.href, sku, title }],
        });
        return reply?.result ?? { stage: 'loading' };
      } catch (error) {
        if (action === 'read' && /frame.*(?:removed|not found)|document.*(?:unloaded|changed)/iu.test(error?.message ?? '')) {
          return { stage: 'loading' };
        }
        throw error;
      }
    };
    const until = async (check, timeout = 14000) => {
      const deadline = Date.now() + timeout;
      do {
        signal?.throwIfAborted();
        const state = await check();
        if (state) return state;
        await wait(350);
      } while (Date.now() < deadline);
      return null;
    };
    const listingRoute = route => route === GLOBAL_LIST || route === SHOP_LIST || route === '/portal/product/list';
    const publishRoute = route => route.startsWith(PUBLISH);
    const persist = (stage, extra = {}) => storage.set({ [key]: {
      stage, ...(globalItemId && { globalItemId }), updatedAt: Date.now(), ...extra,
    } });
    const lookup = async stage => {
      let search = 'prepare-search';
      const wakeAt = Date.now() + 4500;
      let woke = false;
      return until(async () => {
        const snapshot = await operate('read', listingRoute);
        if (snapshot.stage === stage || snapshot.stage === 'ambiguous') return snapshot;
        if (!woke && Date.now() >= wakeAt && snapshot.stage.endsWith('-list')) {
          // Some seller views defer rendering in a background tab. Bring only the
          // owned verification tab forward if the normal readback has stalled.
          woke = true;
          await tabs.update(tabId, { active: true });
        }
        if (search && snapshot.stage.endsWith('-list')) {
          const current = await operate(search, listingRoute);
          if (current.stage === 'search-ready') search = 'search-record';
          if (current.stage === 'searched') search = null;
        }
        return null;
      }, 19000);
    };
    const globalListUrl = `${ORIGIN}${GLOBAL_LIST}?cnsc_shop_id=${shopId}&page=1&size=48`;
    try {
      const prior = (await storage.get(key))[key];
      globalItemId = /^\d+$/u.test(prior?.globalItemId) ? prior.globalItemId : undefined;
      if (preflight && (!prior || mode === 'publish' && globalItemId && prior.stage === 'created')) return null;
      if (prior?.stage === 'creating' || prior?.stage === 'publishing') {
        const recoveringPublish = prior.stage === 'publishing';
        await tabs.update(tabId, { url: recoveringPublish ? `${ORIGIN}${SHOP_LIST}?cnsc_shop_id=${shopId}` : globalListUrl });
        const found = await lookup(recoveringPublish ? 'shop-item' : 'global-item');
        if (!found?.itemId || (!sku && !recoveringPublish)) {
          return result('submission-unknown', '此前提交尚未核实，请先在 Shopee 后台核对。');
        }
        if (!recoveringPublish) globalItemId = found.itemId;
        await persist(recoveringPublish ? 'published' : 'created', recoveringPublish ? { shopItemId: found.itemId } : {});
        return result('skipped', '已在 Shopee 核对到此前提交的记录。', recoveringPublish ? { shopItemId: found.itemId } : {});
      }
      if (globalItemId && (mode === 'create' || prior.stage === 'published')) {
        return result('skipped', '该货号已有本店的创建记录。');
      }
      if (preflight) return null;
      if (!globalItemId) {
        const form = await call('flow_page_state', { tabId, category: replayReceipt.category });
        if (!form.categoryReady || form.category !== replayReceipt.category || form.modal ||
            form.missingRequired > 0 || form.validation?.length || clean(form.fields.title?.value) !== title ||
            sku && clean(form.fields.sku?.value) !== sku ||
            input.imagePath && (!form.image.coverReady || form.image.readyCount !== form.image.count)) {
          return result('needs-review', '创建前核对未通过，请检查必填项、图片及货号。');
        }
        onStep?.({ step: 'submit-create' });
        await persist('creating');
        clicked = true;
        const click = await operate(mode, route => route === NEW);
        if (click.stage !== 'clicked') {
          await storage.remove(key);
          return result('needs-review', click.error || 'Shopee 创建按钮未确认。');
        }
        if (mode === 'create') {
          const reachedList = await until(() => reached(GLOBAL_LIST));
          if (reachedList) await tabs.update(tabId, { url: globalListUrl });
          const found = reachedList && await lookup('global-item');
          if (found?.stage !== 'global-item') return result('submission-unknown', '创建按钮已点击，全球商品列表尚未核对到唯一编号。');
          globalItemId = found.itemId;
          await persist('created');
          return result('created');
        }
        const selected = await until(async () => {
          const current = (await tabs.get(tabId))?.url;
          if (!current) return null;
          const route = new URL(current);
          const itemId = route.origin === ORIGIN && route.pathname.startsWith(PUBLISH) &&
            (!route.searchParams.has('cnsc_shop_id') || target(route, shopId)) && route.pathname.match(/\/(\d+)\/?$/u)?.[1];
          if (!itemId) return null;
          if (!route.searchParams.has('cnsc_shop_id')) {
            route.searchParams.set('cnsc_shop_id', shopId);
            await tabs.update(tabId, { url: route.href });
          }
          return itemId;
        });
        if (!selected) return result('submission-unknown', '创建按钮已点击，尚未获取全球商品编号。');
        globalItemId = selected;
        await persist('created');
      } else {
        await tabs.update(tabId, { url: `${ORIGIN}${PUBLISH}select-shop/${globalItemId}?cnsc_shop_id=${shopId}` });
      }
      onStep?.({ step: 'submit-publish' });
      const routeForItem = route => publishRoute(route) && route.endsWith('/' + globalItemId);
      const select = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'select-shop' ? state : null;
      });
      if (!select?.single || (await operate('next', routeForItem)).stage !== 'clicked') {
        return result('needs-review', '商品已创建，请在 Shopee 确认唯一目标店铺。');
      }
      const pricing = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'review-prices' && state.ready;
      });
      if (!pricing || (await operate('review', routeForItem)).stage !== 'clicked') {
        return result('needs-review', '商品已创建，Shopee 尚未显示可确认的店铺售价。');
      }
      const confirmation = await until(async () => {
        const state = await operate('read', routeForItem);
        return state.stage === 'confirm-publish' ? state : null;
      });
      if (!confirmation?.sameShop) return result('needs-review', '商品已创建，店铺发布确认未匹配。');
      await persist('publishing');
      clicked = true;
      if ((await operate('confirm', routeForItem)).stage !== 'clicked') {
        await persist('created');
        return result('needs-review', '商品已创建，发布确认按钮已变化。');
      }
      const records = await until(() => reached(RECORDS));
      if (!records) return result('submission-unknown', '已点击确认发布，Shopee 尚未返回发布记录。');
      await tabs.update(tabId, { url: `${ORIGIN}${SHOP_LIST}?cnsc_shop_id=${shopId}` });
      const found = await lookup('shop-item');
      if (found?.stage !== 'shop-item') return result('submission-unknown', '已提交上架，店铺商品列表尚未查到该货号。');
      await persist('published', { shopItemId: found.itemId });
      return result('published', undefined, { shopItemId: found.itemId });
    } catch (error) {
      return result(clicked ? 'submission-unknown' : signal?.aborted ? 'cancelled' : 'needs-review',
        error?.message || 'Shopee 提交状态无法核对。');
    }
  }
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(key, { ifAvailable: true }, lock => lock
    ? run() : { status: 'needs-review', details: '同一店铺的该货号正在处理。' }) : run();
}
