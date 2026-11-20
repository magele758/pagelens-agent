import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { sellerSubmitPage, submitShopeeListing } from '../submit-listing.mjs';

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

test('reads the precise global SKU instead of a similar row', t => {
  const { run } = dom(t, globalPath, `<table>
    <tr><td>全球商品货号: TEST-010 商品ID: 555</td></tr>
    <tr><td><a href="/portal/product/mtsku/456">测试商品</a><div>全球商品货号: TEST-01 商品ID: 456</div></td></tr>
  </table>`);
  assert.deepEqual(run('read'), { stage: 'global-item', itemId: '456' });
});

function fake({ failAfterClick = false, mode = 'create', redirectWithoutShop = false } = {}) {
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
        pathname = mode === 'create' ? globalPath : publishPath;
        if (redirectWithoutShop) hasShop = false;
        return [{ result: { stage: 'clicked' } }];
      }
      if (pathname === globalPath) return [{ result: { stage: 'global-item', itemId: '456' } }];
      if (pathname === shopPath) return [{ result: { stage: 'shop-item', itemId: '789' } }];
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
  return { steps, run: () => submitShopeeListing({ tabId: 12, shopId, input, mode, replayReceipt, tabs, scripting, storage, call }) };
}

test('creates a product once and confirms its exact global item ID', async () => {
  const { run, steps } = fake({ redirectWithoutShop: true });
  assert.equal((await run()).globalItemId, '456');
  assert.equal((await run()).status, 'skipped');
  assert.deepEqual(steps, ['create', 'read']);
});

test('writes a durable uncertain receipt and avoids repeating a possibly dispatched create', async () => {
  const { run, steps } = fake({ failAfterClick: true });
  assert.equal((await run()).status, 'submission-unknown');
  const recovered = await run();
  assert.equal(recovered.status, 'skipped');
  assert.equal(recovered.globalItemId, '456');
  assert.deepEqual(steps, ['create', 'read']);
});

test('publish mode waits for shop selection, price, final confirmation and store item ID', async () => {
  const { run, steps } = fake({ mode: 'publish' });
  const receipt = await run();
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.globalItemId, '456');
  assert.equal(receipt.shopItemId, '789');
  assert.deepEqual(steps, ['publish', 'read', 'next', 'read', 'review', 'read', 'confirm', 'read']);
});
