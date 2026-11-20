import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { clickCategoryRecommendation, clickListingControl, operateShopeeCategory, readPage } from '../page-state.mjs';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const url = 'https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=123';
const category = '家居生活 > 居家收纳 > 收纳盒';

function fixture(t, markup) {
  const { window } = new JSDOM(markup, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => window.close());
  window.Element.prototype.getClientRects = function () {
    return this.closest('[hidden]') ? [] : [{ width: 120, height: 28 }];
  };
  const wrap = fn => (...args) => JSON.parse(JSON.stringify(window.eval(`(${fn})`)(...args)));
  return {
    document: window.document, window,
    read: wrap(readPage), category: wrap(operateShopeeCategory), choose: wrap(clickCategoryRecommendation),
    change: wrap(clickListingControl),
  };
}

function pickerMarkup() {
  return `<section class="product-basic-info"><div class="edit-row">
    <div class="product-category-box-inner" id="open"><div class="product-category-text"><span class="product-category-placeholder">Please set category</span></div></div>
  </div></section>
  <div class="eds-modal" id="picker" hidden><div class="eds-modal__mask"><div class="eds-modal__content">
    <div class="eds-modal__title">编辑类目</div>
    <div class="category-selector">
      <div class="category-search"><input placeholder="请输入至少 1 个字"></div>
      <div class="category-list">
        <ul class="scroll-item"><li class="category-item" id="root"><p class="text-overflow">家居生活</p><i class="category-item-right"></i></li></ul>
        <ul class="scroll-item" id="children" hidden><li class="category-item" id="parent"><p class="text-overflow">居家收纳</p><i class="category-item-right"></i></li></ul>
        <ul class="scroll-item" id="leaves" hidden><li class="category-item" id="leaf"><p class="text-overflow">收纳盒</p><div class="category-item-right"><i></i></div></li></ul>
      </div>
    </div>
    <div class="eds-modal__footer-buttons"><button id="confirm">Confirm</button><button>Cancel</button></div>
  </div></div></div><button id="publish">创建并发布</button>`;
}

test('matches and confirms a unique live category route, without touching listing publication', t => {
  const app = fixture(t, pickerMarkup());
  const { document } = app;
  const $ = id => document.getElementById(id);
  const picker = args => app.category(args, url);
  let confirms = 0;
  let published = 0;
  $('publish').onclick = () => published++;
  $('open').onclick = () => { $('picker').hidden = false; };
  $('root').onclick = () => { $('root').classList.add('selected'); $('children').hidden = false; };
  $('parent').onclick = () => { $('parent').classList.add('selected'); $('leaves').hidden = false; };
  $('leaf').onclick = () => { $('leaf').classList.add('selected'); };
  $('confirm').onclick = () => {
    confirms++;
    $('picker').hidden = true;
    document.querySelector('.product-category-text').textContent = category;
  };
  assert.equal(picker({ action: 'read' }).available, true);
  assert.equal(app.category({ action: 'open' }, url.replace('123', '999')).ok, false);
  assert.equal(picker({ action: 'open' }).ok, true);
  assert.equal(picker({ action: 'search', query: '收纳', expectedPath: [] }).ok, true);
  assert.equal(picker({ action: 'read' }).query, '收纳');
  assert.equal(picker({ action: 'select', level: 0, label: '家居生活', expectedPath: [] }).ok, true);
  assert.equal(picker({ action: 'confirm', category: '家居生活' }).ok, false);
  assert.equal(picker({ action: 'select', level: 1, label: '居家收纳', expectedPath: [] }).ok, false);
  assert.equal(picker({ action: 'select', level: 1, label: '居家收纳', expectedPath: ['家居生活'] }).ok, true);
  assert.equal(picker({ action: 'select', level: 2, label: '收纳盒', expectedPath: ['家居生活', '居家收纳'] }).ok, true);
  assert.deepEqual(picker({ action: 'read' }).selectedPath, category.split(' > '));
  assert.equal(picker({ action: 'confirm', category: '家居生活 > 居家收纳 > 收纳包' }).ok, false);
  assert.equal(picker({ action: 'confirm', category }).ok, true);
  assert.equal(app.read(category).category, category);
  assert.equal(picker({ action: 'open' }).ok, false);
  assert.deepEqual({ confirms, published }, { confirms: 1, published: 0 });
});

test('does not select category options when a modal intervenes or when the same label is ambiguous', t => {
  const app = fixture(t, pickerMarkup());
  const { document } = app;
  const picker = args => app.category(args, url);
  document.getElementById('picker').hidden = false;
  const other = document.createElement('div');
  other.setAttribute('role', 'dialog');
  document.body.append(other);
  assert.equal(picker({ action: 'read' }).code, 'modal');
  other.remove();
  const root = document.getElementById('root');
  root.after(root.cloneNode(true));
  assert.equal(picker({ action: 'select', level: 0, label: '家居生活', expectedPath: [] }).code, 'category-option-missing');
});

test('returns bindable recommendations without permitting duplicated or disabled candidates', t => {
  const radio = (path, attrs = '') => `<div class="category-select-radio" ${attrs}><i class="radio-indicator"></i><span class="radio-text">${path}</span></div>`;
  const app = fixture(t, `<section class="product-basic-info"><div class="edit-row"><span class="product-category-text">Please set category</span>
    <div class="recommend-category-container">${radio(category)}${radio('家居 > 重复')}${radio('家居 > 重复')}${radio('家居 > 已下架', 'aria-disabled="true"')}</div>
    <div>家居 > 裸文本</div></div></section>`);
  const state = app.read(category);
  assert.deepEqual(state.recommendations, [category, '家居 > 重复']);
  assert.deepEqual(state.categoryRecommendations, [{ path: category, selector: state.recommendation }]);
  assert.equal(app.choose(state.recommendation, category, url).ok, true);
  assert.equal(app.choose(state.recommendation, '家居 > 其他', url).ok, false);
});

test('reports scoped required markers and binds optional text, numeric, and multiselect values', t => {
  const app = fixture(t, `<div class="product-basic-info"><span class="product-category-text">${category}</span></div>
    <section class="product-specification-new">
      <div class="edit-row"><label class="edit-label"><span class="mandatory">*</span><span class="item-title-text">长度</span></label><input type="number" min="1" max="99"></div>
      <div class="edit-row"><label class="edit-label">材质</label><input type="text" maxlength="12"></div>
      <div class="edit-row"><label class="edit-label">适用场景</label><select multiple><option>书桌</option><option>书柜</option><option disabled>失效选项</option></select></div>
      <div class="edit-row"><label class="edit-label">仅保留包装</label><input type="checkbox"></div>
      <div class="edit-row"><label class="edit-label">真实下拉</label><div class="eds-select eds-select--multiple"><div class="eds-selector"><div class="eds-selector__inner"><span class="eds-tag__text">家居</span><input></div></div></div></div>
    </section>`);
  const { document } = app;
  const fields = () => Object.fromEntries(app.read(category).attributes.map(item => [item.label, item]));
  const current = fields();
  assert.equal(current['长度'].required, true);
  assert.equal(current['长度'].type, 'number');
  assert.equal(current['长度'].max, 99);
  assert.equal(current['材质'].required, false);
  assert.equal(current['材质'].type, 'text');
  assert.deepEqual(current['适用场景'].nativeOptions, ['书桌', '书柜']);
  assert.deepEqual(current['真实下拉'].value, ['家居']);
  assert.equal(current['仅保留包装'].value, false);
  const set = (label, value, pinned = category) => app.change({ action: 'attribute-set', label, category: pinned,
    selector: current[label].selector, value }, url);
  let changes = 0;
  document.querySelector('input[type=text]').onchange = () => changes++;
  assert.equal(set('材质', '纸', '家居 > 其他').ok, false);
  assert.equal(set('材质', '纸').ok, true);
  assert.equal(changes, 1);
  assert.equal(set('长度', 101).ok, false);
  assert.equal(set('长度', 10).ok, true);
  assert.equal(set('适用场景', ['书桌', '失效选项']).ok, false);
  assert.equal(set('适用场景', ['书桌', '书柜']).ok, true);
  assert.equal(set('仅保留包装', true).ok, true);
  assert.deepEqual(Object.values(fields()).map(item => item.value), ['10', '纸', ['书桌', '书柜'], true, ['家居']]);
});

test('counts a visible red CSS star without making hidden or non-red decoration required', t => {
  const row = (label, type) => `<div class="edit-row"><label class="edit-label" data-star="${type}">${label}</label><input type="text"></div>`;
  const app = fixture(t, `<section class="product-specification-new">${row('红色', 'visible')}${row('隐藏', 'hidden')}${row('装饰', 'decorative')}</section>`);
  const { window } = app;
  const style = window.getComputedStyle.bind(window);
  window.CSS = { supports: () => true };
  window.getComputedStyle = (el, pseudo) => {
    if (!pseudo) return style(el);
    return { content: '"*"', display: el.dataset.star === 'hidden' ? 'none' : 'inline', visibility: 'visible',
      color: el.dataset.star === 'decorative' ? 'rgb(30, 30, 30)' : 'rgb(238, 77, 45)' };
  };
  assert.deepEqual(app.read(category).attributes.map(({ label, required }) => [label, required]),
    [['红色', true], ['隐藏', false], ['装饰', false]]);
});

test('resets only the sole variation control of the bound, unsaved product form', t => {
  const app = fixture(t, `<section class="product-basic-info">
    <div class="product-category-text">${category}</div>
    <div class="edit-row"><label class="edit-label">商品名称</label><input value="同款商品"></div>
  </section><section class="product-sales-info"><div class="variation-edit-item">
    <div class="variation-name-panel"><input value="颜色"></div>
    <div class="variation-option-panel"><div class="options-item"><input value="旧颜色"></div></div>
    <span class="variation-delete-btn" id="local">×</span>
  </div></section><span class="variation-delete-btn" id="other">×</span>`);
  const clicks = [];
  for (const control of app.document.querySelectorAll('.variation-delete-btn')) {
    control.onclick = () => clicks.push(control.id);
  }
  const args = { action: 'variant-reset', selector: '#local', category, label: '清除新表单预带规格', value: '同款商品',
    variantName: '颜色', variantOptions: ['旧颜色'] };
  assert.equal(app.change({ ...args, value: '错商品' }, url).ok, false);
  assert.equal(app.change({ ...args, selector: '#other' }, url).ok, false);
  assert.equal(app.change({ ...args, variantOptions: ['刚换掉的选项'] }, url).ok, false);
  assert.equal(app.change(args, url).ok, true);
  assert.deepEqual(clicks, ['local']);
});
