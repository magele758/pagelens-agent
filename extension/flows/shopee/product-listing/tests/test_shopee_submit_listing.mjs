import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  checkShopeeSubmission, prepareShopeeCreationCheck, reconcileShopeeCreated, sellerSubmitPage, submitShopeeListing,
} from '../submit-listing.mjs';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const origin = 'https://seller.shopee.cn';
const shopId = '123';
const formPath = '/portal/mtsku/new';
const globalPath = '/portal/product/mtsku/list';
const publishPath = '/portal/product-distribute/single-product-publish/select-shop/456';
const publishRecordPath = '/portal/product-distribute/publish-record';
const shopPath = '/portal/product/list/all';
const url = pathname => `${origin}${pathname}?cnsc_shop_id=${shopId}`;
const input = { title: '测试商品', sku: 'TEST-01', imagePath: '/products/cover.jpg' };
const replayReceipt = { status: 'verified', category: '家居生活 > 餐饮用品' };

function dom(t, pathname, markup) {
  const { window } = new JSDOM(markup, { url: url(pathname), runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => window.close());
  window.Element.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{ width: 20 }]; };
  const run = (action, extra = {}) => JSON.parse(JSON.stringify(window.eval(`(${sellerSubmitPage})`)({
    action, expectedUrl: url(pathname), title: input.title, sku: input.sku, ...extra,
  })));
  return { document: window.document, run };
}

test('the create control targets its own form and never clicks the publish control', t => {
  const { document, run } = dom(t, formPath, `
    <div class="edit-row"><div class="edit-label">* 商品名称</div><input value="测试商品"></div>
    <div class="edit-row"><div class="edit-label">全球商品货号</div><input value="TEST-01"></div>
    <button>创建</button><button>创建并发布</button>`);
  const clicks = [];
  for (const button of document.querySelectorAll('button')) button.onclick = () => clicks.push(button.textContent);
  assert.equal(run('create', { sku: 'OTHER' }).stage, 'form');
  assert.equal(run('create', { expectedUrl: url(globalPath) }).stage, 'page-changed');
  assert.deepEqual(clicks, []);
  assert.equal(run('create').stage, 'clicked');
  assert.deepEqual(clicks, ['创建']);
});

test('a second create needs an isolated Shopee review summary and an idle action', t => {
  const { document, run } = dom(t, formPath, `
    <div class="edit-row"><div class="edit-label">* 商品名称</div><input value="测试商品"></div>
    <div class="edit-row"><div class="edit-label">全球商品货号</div><input value="TEST-01"></div>
    <button id="create">创建</button><button>创建并发布</button>
    <div role="alert">1个错误需调整。</div>
    <div class="eds-input__error" hidden>此栏位不可空白</div>
    <div class="eds-message--success" hidden>创建成功</div>
    <div id="transient"></div>`);
  const clickTargets = [];
  for (const button of document.querySelectorAll('button')) button.onclick = () => clickTargets.push(button.textContent);
  const create = document.querySelector('#create');
  const inlineError = document.querySelector('.eds-input__error');
  const success = document.querySelector('.eds-message--success');
  const transient = document.querySelector('#transient');
  assert.equal(run('create').stage, 'form');
  assert.equal(run('read').retryable, true);
  assert.equal(run('retry-create', { sku: 'OTHER' }).stage, 'form');
  assert.equal(run('retry-create', { sku: '' }).stage, 'form');
  create.setAttribute('aria-busy', 'true');
  assert.equal(run('retry-create').stage, 'form');
  create.removeAttribute('aria-busy');
  inlineError.hidden = false;
  assert.match(run('read').error, /此栏位不可空白/);
  assert.equal(run('retry-create').stage, 'form');
  inlineError.hidden = true;
  success.hidden = false;
  assert.equal(run('retry-create').stage, 'form');
  success.hidden = true;
  transient.textContent = '请求超时';
  assert.match(run('read').error, /请求超时/u);
  assert.equal(run('retry-create').stage, 'form');
  transient.remove();
  assert.equal(run('retry-create').stage, 'clicked');
  assert.deepEqual(clickTargets, ['创建']);
});

test('reads the precise global SKU instead of a similar row', t => {
  const { run } = dom(t, globalPath, `<table>
    <tr><td>全球商品货号: TEST-010 商品ID: 555</td></tr>
    <tr><td><a href="/portal/product/mtsku/456">测试商品</a><div>全球商品货号: TEST-01 商品ID: 456</div></td></tr>
  </table>`);
  assert.deepEqual(run('read'), { stage: 'global-item', itemId: '456' });
});

test('recognizes an empty global inventory only when the list count agrees', t => {
  const { document, run } = dom(t, globalPath, `
    <div id="count">24 全球商品</div>
    <button>新增全球商品</button>
    <table><tr><td>找不到商品</td></tr></table>`);
  assert.equal(run('list-receipts').total, null);
  document.querySelector('#count').textContent = '0 全球商品';
  assert.deepEqual(run('list-receipts'), {
    stage: 'list-receipts', records: [], total: 0, page: null, hasNext: false,
  });
  const search = document.createElement('input');
  search.placeholder = '请输入单字的至少首 2 个字符';
  search.value = 'other product';
  document.body.append(search);
  assert.equal(run('list-receipts').total, null);
  search.remove();
  document.querySelector('table').setAttribute('aria-busy', 'true');
  assert.equal(run('list-receipts').total, null);
});

test('keeps only the exact SKU evidence and bounds list pagination to the active page', t => {
  const { document, run } = dom(t, globalPath, `
    <div>2 全球商品</div>
    <button>新增全球商品</button>
    <table><tr><td>全球商品货号: TEST-01 商品ID: 456</td></tr></table>
    <div class="eds-react-pagination">
      <button aria-current="page">1</button><button aria-label="下一页" id="next">›</button>
    </div>`);
  let clicks = 0;
  document.querySelector('#next').onclick = () => clicks++;
  assert.deepEqual(run('list-receipts'), {
    stage: 'list-receipts', records: [{ sku: 'TEST-01', itemId: '456' }], total: 2, page: 1, hasNext: true,
  });
  assert.equal(run('list-next-page', { expectedPage: 2 }).stage, 'list-receipts');
  assert.equal(run('list-next-page', { expectedPage: 1 }).stage, 'list-advanced');
  assert.equal(clicks, 1);
});

function fake({ failAfterClick = false, validationAfterClick, mode = 'create', redirectWithoutShop = false } = {}) {
  let pathname = formPath;
  let hasShop = true;
  let phase = 0;
  const steps = [];
  const records = new Map();
  const tabs = {
    get: async () => ({ url: hasShop ? url(pathname) : origin + pathname, status: 'complete' }),
    async update(_tabId, { url: location }) { pathname = new URL(location).pathname; hasShop = true; },
  };
  const storage = {
    get: async key => ({ [key]: records.get(key) }),
    async set(values) { for (const row of Object.entries(values)) records.set(...row); },
    async remove(key) { records.delete(key); },
  };
  const scripting = {
    async executeScript({ args: [{ action }] }) {
      steps.push(action);
      if (action === mode) {
        if (failAfterClick) throw Error('Renderer disconnected after dispatch');
        if (validationAfterClick) return [{ result: { stage: 'clicked' } }];
        pathname = mode === 'create' ? globalPath : publishPath;
        if (redirectWithoutShop) hasShop = false;
        return [{ result: { stage: 'clicked' } }];
      }
      if (pathname === globalPath) return [{ result: { stage: 'global-item', itemId: '456' } }];
      if (pathname === shopPath) return [{ result: { stage: 'shop-item', itemId: '789' } }];
      if (pathname === formPath && validationAfterClick) return [{ result: { stage: 'form', error: validationAfterClick } }];
      if (action === 'next') phase = 1;
      if (action === 'review') phase = 2;
      if (action === 'confirm') pathname = publishRecordPath;
      if (action !== 'read') return [{ result: { stage: 'clicked' } }];
      return [{ result: [
        { stage: 'select-shop', single: true }, { stage: 'review-prices', ready: true }, { stage: 'confirm-publish', sameShop: true },
      ][phase] }];
    },
  };
  const call = async () => ({
    category: replayReceipt.category, categoryReady: true, validation: [], missingRequired: 0,
    fields: { title: { value: input.title }, sku: { value: input.sku } }, image: { readyCount: 1, count: 1, coverReady: true },
  });
  const context = { tabId: 12, shopId, input, mode, tabs, scripting, storage, call };
  return {
    context, steps, run: () => submitShopeeListing({ ...context, replayReceipt }),
    check: () => checkShopeeSubmission(context),
  };
}

test('creates a product once and checks the existing record before replay on a later run', async () => {
  const { run, steps, check } = fake({ redirectWithoutShop: true });
  assert.equal(await check(), null);
  assert.equal((await run()).globalItemId, '456');
  assert.equal((await check()).status, 'skipped');
  assert.deepEqual(steps, ['create', 'read']);
});

test('blocks create when a single-SKU form has gained variants since replay', async () => {
  const { context, steps } = fake();
  const call = async () => ({
    ...(await context.call()),
    variant: { options: ['其他商品规格'], rows: [] },
  });
  const receipt = await submitShopeeListing({ ...context, call, replayReceipt });
  assert.equal(receipt.status, 'needs-review');
  assert.match(receipt.details, /规格/);
  assert.deepEqual(steps, []);
});

test('writes a durable uncertain receipt and avoids repeating a possibly dispatched create', async () => {
  const { run, steps } = fake({ failAfterClick: true });
  assert.equal((await run()).status, 'submission-unknown');
  const recovered = await run();
  assert.equal(recovered.status, 'skipped');
  assert.equal(recovered.globalItemId, '456');
  assert.deepEqual(steps, ['create', 'read']);
});

test('includes Shopee validation raised after the create control was clicked', async () => {
  const error = '1个错误需调整 · Your days to ship is now out of range';
  const { run, steps } = fake({ validationAfterClick: error });
  const result = await run();
  assert.equal(result.status, 'submission-unknown');
  assert.equal(result.details, error);
  assert.deepEqual(steps, ['create', 'read']);
});

function fakeCreateRetry({ confirm = true, drift = false, replaceDocument = false } = {}) {
  const { context } = fake();
  const submissionInput = { ...input, weight: 0.32, description: '描述' };
  const summary = '1个错误需调整';
  let pathname = formPath;
  let reads = 0;
  let confirmations = 0;
  const actions = [];
  const formDocument = 'original-document';
  const calls = {
    tabs: { ...context.tabs, get: async () => ({ url: url(pathname), status: 'complete' }) },
    async call() {
      const form = await context.call();
      const weight = reads++ && drift ? '' : '0.32';
      return { ...form, url: url(formPath), validation: reads > 1 ? [summary] : [],
        fields: { ...form.fields, weight: { value: weight }, description: { value: submissionInput.description } } };
    },
    scripting: { async executeScript({ target, args: [{ action }] }) {
      actions.push(action);
      if (action === 'create') {
        assert.deepEqual(target, { tabId: 12, frameIds: [0] });
        return [{ documentId: formDocument, result: { stage: 'clicked' } }];
      }
      if (action === 'retry-create') {
        assert.deepEqual(target, { tabId: 12, documentIds: [formDocument] });
        if (confirm) pathname = globalPath;
        return [{ documentId: formDocument, result: { stage: 'clicked' } }];
      }
      assert.equal(action, 'read');
      if (pathname === globalPath) return [{ result: { stage: 'global-item', itemId: '456' } }];
      assert.deepEqual(target, { tabId: 12, documentIds: [formDocument] });
      return [{ documentId: replaceDocument && confirmations++ === 0 ? 'replacement' : formDocument,
        result: { stage: 'form', error: summary, reviewOnly: true, retryable: true } }];
    } },
  };
  return { actions, get reads() { return reads; },
    run: () => submitShopeeListing({ ...context, ...calls, input: submissionInput, replayReceipt }) };
}

test('retries a settled Shopee form rejection once and verifies the product ID', async () => {
  const scenario = fakeCreateRetry();
  const receipt = await scenario.run();
  assert.equal(receipt.globalItemId, '456');
  assert.equal(receipt.status, 'created');
  assert.equal(scenario.reads, 2);
  assert.equal(scenario.actions.filter(action => action === 'create').length, 1);
  assert.equal(scenario.actions.filter(action => action === 'retry-create').length, 1);
});

test('leaves a second still-rejected create pending without a third click', async () => {
  const scenario = fakeCreateRetry({ confirm: false });
  const receipt = await scenario.run();
  assert.equal(receipt.status, 'submission-unknown');
  assert.equal(receipt.details, '1个错误需调整');
  assert.equal(scenario.actions.filter(action => action === 'retry-create').length, 1);
  assert.equal(scenario.reads, 2);
});

test('suppresses create retries when the shipping form drifted before verification', async () => {
  const scenario = fakeCreateRetry({ drift: true });
  const receipt = await scenario.run();
  assert.equal(receipt.status, 'submission-unknown');
  assert.match(receipt.details, /运费字段已变化/u);
  assert.equal(scenario.actions.filter(action => action === 'retry-create').length, 0);
  assert.equal(scenario.reads, 2);
});

test('suppresses create retries when the verification document changed', async () => {
  const scenario = fakeCreateRetry({ replaceDocument: true });
  const receipt = await scenario.run();
  assert.equal(receipt.status, 'submission-unknown');
  assert.equal(scenario.actions.filter(action => action === 'retry-create').length, 0);
  assert.equal(scenario.reads, 1);
});

const keyFor = sku => `pl.shopee.submission.v1.${shopId}.${sku}`;
const listPage = `${url(globalPath)}&page=1&size=48`;
const inventoryPage = (records, total = records.length, page = null, hasNext = false) => ({
  stage: 'list-receipts', records, total, page, hasNext,
});

function fakeInventory(initial, read) {
  const ledger = new Map(Object.entries(initial));
  const storage = {
    async get(keys) { return Object.fromEntries([keys].flat().map(key => [key, ledger.get(key)])); },
    async remove(key) { ledger.delete(key); },
    async set(values) { for (const row of Object.entries(values)) ledger.set(...row); },
  };
  let reads = 0;
  let reloads = 0;
  let closed = false;
  const tabs = {
    async create(args) {
      assert.deepEqual(args, { windowId: 8, url: listPage, active: false });
      return { id: 12 };
    },
    async get() { return { url: listPage, status: 'complete' }; },
    async remove(id) { assert.equal(id, 12); closed = true; },
    async reload(id) { assert.equal(id, 12); reloads++; },
  };
  const scripting = {
    async executeScript({ args: [args] }) {
      assert.equal(args.expectedUrl, listPage);
      return [{ result: read({ ...args, reads: reads++, reloads }) }];
    },
  };
  return { get closed() { return closed; }, tabs, scripting, storage, ledger };
}

test('removes only the unchanged prior same-shop record after an exact complete inventory check', async () => {
  const key = keyFor(input.sku);
  const old = Date.now() - 360000;
  const otherSkuKey = keyFor('TEST-02');
  const updatedSkuKey = keyFor('TEST-03');
  const inventoryBrowser = fakeInventory({
    [key]: { stage: 'created', globalItemId: '456', updatedAt: old },
    [otherSkuKey]: { stage: 'creating', updatedAt: old },
    [updatedSkuKey]: { stage: 'created', globalItemId: '789', updatedAt: old },
  }, ({ reads }) => inventoryPage([], reads === 0 ? null : 0));
  const inventory = await prepareShopeeCreationCheck({
    shopId, windowId: 8, skus: [input.sku, 'TEST-02', 'TEST-03'], ...inventoryBrowser,
  });
  assert.equal(inventoryBrowser.closed, true);
  assert.equal(inventory.complete, true);
  const { context } = fake();
  const check = sku => checkShopeeSubmission({
    ...context, input: { ...input, sku }, inventory, storage: inventoryBrowser.storage,
  });
  assert.equal(await check(input.sku), null);
  assert.equal(await check('TEST-02'), null);
  await inventoryBrowser.storage.set({ [updatedSkuKey]: { stage: 'created', globalItemId: '999', updatedAt: Date.now() } });
  assert.equal((await check('TEST-03')).globalItemId, '999');
  assert.deepEqual([...inventoryBrowser.ledger.keys()], [updatedSkuKey]);
});

test('retains same-SKU records and blocks ambiguous inventory matches', async () => {
  const { context } = fake();
  const key = keyFor(input.sku);
  const record = { stage: 'created', globalItemId: '456', updatedAt: Date.now() - 120000 };
  await context.storage.set({ [key]: record });
  const inventory = { complete: true, idsBySku: new Map(), prior: { [key]: record }, checkedAt: Date.now() };
  inventory.idsBySku.set(input.sku, ['456', '789']);
  assert.equal((await checkShopeeSubmission({ ...context, inventory })).status, 'submission-unknown');
  inventory.idsBySku.set(input.sku, ['456']);
  const outcome = await checkShopeeSubmission({ ...context, inventory });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.globalItemId, '456');
});

test('waits for the freshly rendered list when the creation receipt is delayed', async () => {
  const key = keyFor(input.sku);
  const inventoryBrowser = fakeInventory({ [key]: { stage: 'creating', updatedAt: Date.now() } }, ({ reloads }) =>
    inventoryPage(reloads ? [{ sku: 'TEST-010', itemId: '555' }, { sku: input.sku, itemId: '456' }] : []));
  const matches = await reconcileShopeeCreated({ tabId: 12, shopId, skus: [input.sku], ...inventoryBrowser });
  assert.deepEqual([...matches], [[input.sku, '456']]);
  assert.equal(inventoryBrowser.ledger.get(key).stage, 'created');
});

test('publish mode waits for shop selection, price, final confirmation and store item ID', async () => {
  const { run, steps } = fake({ mode: 'publish' });
  const receipt = await run();
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.globalItemId, '456');
  assert.equal(receipt.shopItemId, '789');
  assert.deepEqual(steps, ['publish', 'read', 'next', 'read', 'review', 'read', 'confirm', 'read']);
});
