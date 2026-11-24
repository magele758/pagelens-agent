import assert from 'node:assert/strict';
import test from 'node:test';
import { replayShopeeListing } from '../listing.flow.mjs';
import { shopeeExampleInput as example } from '../example-input.js';

const input = { ...example, shopId: '123', imagePath: '/products/notebook.png', attributes: { 品牌: 'NoBrand' } };

function mockPage({ modal = null, newRequired = false, failWrite = false, delayedWrite = false, noImagePreview = false,
  coverPresent = false, retryCategory = false, categoryRecommendations = null, rejectVariantName = false, advice, gallery = [] } = {}) {
  const labels = {
    '#category': input.category, '#noBrand': 'NoBrand', '#enable': '开启商品规格'
  };
  const attrs = [{ label: '品牌', required: true, selector: '#brand', value: '' }];
  if (newRequired) attrs.push({
    label: '装订方式', type: 'select', required: true, selector: '#binding', value: '',
    ...(advice && { error: '请选择装订方式' }),
  });
  const fields = Object.fromEntries([
    'title', 'description', 'price', 'quantity', 'weight', 'width', 'length', 'height', 'shipDays',
    'sku', 'batchQuantity',
  ].map((key) => [key, { selector: '#' + key, value: '' }]));
  const state = {
    url: 'https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=123',
    modal,
    validation: newRequired && advice ? ['请选择装订方式'] : [],
    unscopedValidation: [],
    category: null,
    categoryReady: false,
    recommendation: null,
    recommendations: [],
    options: [],
    optionSearch: null,
    fields,
    attributes: attrs,
    image: { count: Number(coverPresent), cover: coverPresent, readyCount: Number(coverPresent), coverReady: coverPresent, selector: '#cover' },
    variant: { enable: '#enable', options: [], rows: [] },
  };
  const calls = [];
  const commitCategory = () => {
    state.category = input.category;
    state.categoryReady = true;
    state.recommendation = null;
  };
  const actions = {
    '#category': () => { if (!retryCategory) commitCategory(); },
    '#brand': () => {
      state.options = [{ text: 'NoBrand', selector: '#noBrand' }];
      state.optionOwner = '品牌';
    },
    '#noBrand': () => {
      attrs[0].value = 'NoBrand';
      state.options = [];
      state.optionOwner = null;
    },
    '#binding': () => {
      state.options = [{ text: '线圈装', selector: '#spiral' }, { text: '胶装', selector: '#glued' }];
      state.optionOwner = '装订方式';
    },
    '#spiral': () => {
      attrs[1].value = '线圈装';
      attrs[1].error = '';
      state.validation = [];
      state.options = [];
      state.optionOwner = null;
    },
    '#enable': () => {
      state.variant.enable = null;
      fields.variantName = { selector: '#variantName', value: '' };
      fields.variantOption = { selector: '#variantOption', value: '' };
    },
  };
  const call = async (tool, args) => {
    assert.equal(args.tabId, 10);
    calls.push({ tool, args });
    switch (tool) {
      case 'flow_page_state':
        assert.equal(args.category, input.category);
        return JSON.stringify(state);
      case 'query_dom':
        return JSON.stringify([{ tag: labels[args.selector] ? 'button' : 'input', text: labels[args.selector] ?? '',
          type: args.selector === '#cover' || args.selector.startsWith('#image-') ? 'file' : 'text' }]);
      case 'fill': {
        assert.equal(args.submit, false);
        const key = args.selector.slice(1);
        const row = state.variant.rows.find(row => Object.values(row.selectors).includes(args.selector));
        if (row) {
          const field = Object.keys(row.selectors).find(key => row.selectors[key] === args.selector);
          if (failWrite && field === 'quantity') break;
          const write = () => { row[field] = args.value; };
          if (delayedWrite && field === 'sku') setTimeout(write, 350);
          else write();
          break;
        }
        fields[key].value = args.value;
        if (key === 'title') {
          state.recommendations = categoryRecommendations ?? [input.category];
          if (state.recommendations.includes(input.category)) state.recommendation = '#category';
        }
        break;
      }
      case 'flow_variant_write': {
        assert.equal(args.category, input.category);
        assert.deepEqual(args.existingOptions, state.variant.options);
        assert.equal(args.selector, args.kind === 'name' ? '#variantName' : '#variantOption');
        if (args.kind === 'name') {
          if (!rejectVariantName) fields.variantName.value = args.name;
        } else {
          assert.equal(args.name, fields.variantName.value);
          state.variant.options.push(args.option);
          const index = state.variant.options.length;
          state.variant.rows.unshift({
            option: args.option,
            price: '',
            quantity: '0',
            sku: '',
            selectors: { price: '#price-' + index, quantity: '#quantity-' + index, sku: '#sku-' + index },
            image: { selector: '#image-' + index, present: false },
          });
        }
        break;
      }
      case 'trusted_click':
        assert.equal(args.selector, '#category');
        actions[args.selector]();
        break;
      case 'flow_control_click':
        assert.equal(args.category, input.category);
        assert.equal({ '#brand': 'attribute-trigger', '#noBrand': 'attribute-option', '#enable': 'variant-enable',
          '#binding': 'attribute-trigger', '#spiral': 'attribute-option' }[args.selector], args.action);
        actions[args.selector]();
        break;
      case 'flow_attribute_advice':
        return { values: await advice(args.fields) };
      case 'flow_category_click':
        assert.equal(args.selector, '#category');
        assert.equal(args.category, input.category);
        assert.equal(state.category, null);
        commitCategory();
        break;
      case 'upload_file': {
        if (args.selector === '#cover') {
          assert.deepEqual(args.paths, [[input.imagePath, ...gallery][state.image.count]]);
          const count = state.image.count + 1;
          Object.assign(state.image, { count, cover: true, readyCount: count, coverReady: true });
        } else {
          const row = state.variant.rows.find(row => row.image.selector === args.selector);
          assert.ok(row);
          if (!noImagePreview) row.image.present = true;
        }
        break;
      }
      case 'press_keys':
        if (args.keys[0] === 'Escape') {
          state.options = [];
          state.optionOwner = null;
        }
        break;
      case 'wait_for':
        break;
      default:
        assert.fail(tool);
    }
    return JSON.stringify({ ok: true });
  };
  return { call, calls, state };
}

async function run(mock, parameters = input) {
  return replayShopeeListing({ call: mock.call, tabId: 10, input: parameters });
}

const apparelChart = {
  name: '条纹 T 恤尺码',
  unit: 'inch',
  columns: ['尺寸（国际）', '胸围', '下摆宽度', '长度'],
  rows: [
    { '尺寸（国际）': 'S', 胸围: '37.80', 下摆宽度: '40.55', 长度: '26.38' },
    { '尺寸（国际）': '2XL', 胸围: '48.82', 下摆宽度: '52.36', 长度: '28.35' },
  ],
};

function mockSizeChart(page, { templates = [], usRequired = false, selectOnSave = true, failSave = false,
  inferredValues = ['4', '16'] } = {}) {
  const state = { available: true, selectedName: null, dialog: null, options: null };
  const actions = [];
  const base = page.call;
  page.call = async (tool, args) => {
    if (tool === 'flow_size_chart_state') return structuredClone(state);
    if (tool === 'flow_size_chart_complete') {
      actions.push({ action: 'infer', ...args });
      const label = '尺寸（美国）';
      return { sizeChart: { ...args.chart, columns: [...args.chart.columns, label],
        rows: args.chart.rows.map((row, index) => ({ ...row, [label]: inferredValues[index] })) } };
    }
    if (tool !== 'flow_size_chart_action') return base(tool, args);
    actions.push(args);
    switch (args.action) {
      case 'column-options':
        assert.equal(args.label, '尺寸（美国）');
        return { options: ['2', '4', '6', '8', '10', '12', '14', '16', '18', '20'] };
      case 'dismiss':
        state.dialog = null;
        break;
      case 'open-options':
        state.options = [...templates];
        break;
      case 'select':
        assert.ok(templates.includes(args.name));
        state.selectedName = args.name;
        state.options = null;
        break;
      case 'open':
        state.options = null;
        state.dialog = {
          kind: '上衣', name: '', unit: 'cm', rows: [{}],
          columns: [
            { label: '尺寸（美国）', checked: true, locked: true, required: usRequired },
            { label: '尺寸（国际）', checked: false, locked: false },
            { label: '长度', checked: true, locked: true },
            { label: '上衣长度', checked: true, locked: true },
            { label: '胸围', checked: true, locked: true },
            { label: '下擺寬度', checked: false, locked: false },
            { label: '肩宽', checked: true, locked: false },
          ],
        };
        break;
      case 'set-name':
        state.dialog.name = args.name;
        break;
      case 'set-unit':
        state.dialog.unit = args.unit;
        break;
      case 'toggle-column':
        state.dialog.columns.find(column => column.label === args.label).checked = args.checked;
        break;
      case 'add-row':
        assert.equal(state.dialog.rows.length, args.rowCount);
        state.dialog.rows.push({});
        break;
      case 'fill-rows':
        state.dialog.rows = args.rows.map(row => ({ ...row,
          '尺寸（国际）': row['尺寸（国际）'] === '2XL' ? 'XXL' : row['尺寸（国际）'],
          胸围: String(Number(row.胸围)),
        }));
        break;
      case 'save':
        assert.equal(state.dialog.name, args.name);
        assert.equal(state.dialog.unit, args.unit);
        if (failSave) {
          state.dialog.validation = ['有必填项未填'];
          break;
        }
        if (selectOnSave) state.selectedName = args.name;
        templates.push(args.name);
        state.dialog = null;
        break;
      default:
        assert.fail(args.action);
    }
    return { ok: true };
  };
  return actions;
}

test('configures actual tops columns, expands the live row count, saves precisely one template and verifies selection', async () => {
  const page = mockPage();
  const actions = mockSizeChart(page, { selectOnSave: false });
  const receipt = await run(page, { ...input, sizeChart: apparelChart });
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(receipt.sizeChart, { name: actions.find(args => args.action === 'save').name, unit: 'inch', rows: 2, reused: false });
  assert.match(receipt.sizeChart.name, /^条纹 T 恤尺码-[a-f0-9]{12}$/u);
  assert.deepEqual(actions.filter(args => args.action === 'toggle-column').map(({ label, checked }) => [label, checked]),
    [['尺寸（国际）', true], ['下擺寬度', true], ['肩宽', false]]);
  assert.deepEqual(actions.find(args => args.action === 'fill-rows').rows, [
    { '尺寸（美国）': '', '尺寸（国际）': 'S', 长度: '26.38', 上衣长度: '26.38', 胸围: '37.80', 下擺寬度: '40.55' },
    { '尺寸（美国）': '', '尺寸（国际）': '2XL', 长度: '28.35', 上衣长度: '28.35', 胸围: '48.82', 下擺寬度: '52.36' },
  ]);
  assert.equal(actions.filter(args => args.action === 'save').length, 1);
  assert.equal(actions.at(-1).action, 'select');
});

test('selects the exact existing fingerprinted size chart without resaving it', async () => {
  const page = mockPage();
  mockSizeChart(page);
  const first = await run(page, { ...input, sizeChart: apparelChart });
  const next = mockPage();
  const actions = mockSizeChart(next, { templates: [first.sizeChart.name] });
  const receipt = await run(next, { ...input, sizeChart: apparelChart });
  assert.deepEqual(actions.map(args => args.action), ['open-options', 'select']);
  assert.deepEqual(receipt.sizeChart, { ...first.sizeChart, reused: true });
});

test('reports a missing locked size column without selecting guessed sizes or saving a template', async () => {
  const page = mockPage();
  const actions = mockSizeChart(page, { usRequired: true });
  const receipt = await run(page, { ...input, sizeChart: apparelChart });
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.code, 'size-chart-required-column');
  assert.equal(receipt.details.label, '尺寸（美国）');
  assert.equal(receipt.coverUploaded, true);
  assert.equal(actions.some(args => ['fill-rows', 'save'].includes(args.action)), false);
});

test('fills only missing approved columns using observed choices, then reuses the enriched fingerprint', async () => {
  const page = mockPage();
  const parameters = { ...input, sizeChart: apparelChart, completeMissingSizeChart: true };
  const actions = mockSizeChart(page, { usRequired: true });
  const first = await run(page, parameters);
  assert.equal(first.status, 'verified');
  const [, secondSource] = actions.find(args => args.action === 'fill-rows').rows;
  assert.equal(secondSource['尺寸（美国）'], '16');
  assert.equal(secondSource.胸围, apparelChart.rows[1].胸围);
  assert.deepEqual(first.sizeChart.estimatedColumns, ['尺寸（美国）']);
  assert.equal(actions.some(args => args.action === 'dismiss'), false);
  const next = mockPage();
  const retry = mockSizeChart(next, { templates: [first.sizeChart.name], usRequired: true });
  const second = await run(next, parameters);
  assert.deepEqual(second.sizeChart, { ...first.sizeChart, reused: true });
  assert.equal(retry.at(-1).action, 'select');
  assert.ok(retry.some(args => args.action === 'dismiss'));
  assert.equal(retry.some(args => args.action === 'save'), false);
});

test('stops before save when the inference suggests a size outside observed choices', async () => {
  const page = mockPage();
  const actions = mockSizeChart(page, { usRequired: true, inferredValues: ['4', '99'] });
  const receipt = await run(page, { ...input, sizeChart: apparelChart, completeMissingSizeChart: true });
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.code, 'size-chart-inference-option');
  assert.equal(actions.some(args => args.action === 'save'), false);
});

test('keeps prior SKU evidence and stops when Shopee rejects the size-chart save', async () => {
  const page = mockPage();
  const actions = mockSizeChart(page, { failSave: true });
  const receipt = await run(page, { ...input, sizeChart: apparelChart });
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.code, 'size-chart-validation');
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
  assert.equal(actions.filter(args => args.action === 'save').length, 1);
});

test('retains the verified uploads and SKU values when Shopee reports an unfilled required field', async () => {
  const page = mockPage();
  page.state.missingRequired = 1;
  const receipt = await run(page);
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.code, 'required-fields-remain');
  assert.match(receipt.details.text, /1 个必填字段/);
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
});

test('replays the fixed steps and verifies values in the actual SKU row', async () => {
  const page = mockPage();
  const receipt = await run(page);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
  assert.deepEqual(page.calls.filter(({ tool }) => tool === 'trusted_click').map(({ args }) => args.selector), ['#category']);
  assert.deepEqual(page.calls.filter(({ tool }) => tool === 'flow_control_click').map(({ args }) => args.selector), ['#brand', '#noBrand', '#enable']);
  assert.deepEqual(page.calls.filter(({ tool }) => tool === 'flow_variant_write').map(({ args }) => [args.kind, args.option]), [
    ['name', undefined], ...input.variant.options.map(({ option }) => ['option', option]),
  ]);
  const offset = page.calls.length;
  const repeat = await run(page, { ...input, retainExistingCover: true });
  assert.equal(repeat.status, 'verified');
  assert.ok(page.calls.slice(offset).every(({ tool }) => tool === 'flow_page_state'));
});

test('stops before touching SKU options if the page did not accept the variation name', async () => {
  const page = mockPage({ rejectVariantName: true });
  const receipt = await run(page);
  assert.equal(receipt.code, 'variant-name-readback');
  assert.deepEqual(page.calls.filter(({ tool }) => tool === 'flow_variant_write').map(({ args }) => args.kind), ['name']);
  assert.deepEqual(page.state.variant.rows, []);
});

test('reports a modal before making changes', async () => {
  const page = mockPage({ modal: { text: '操作提示' } });
  assert.equal((await run(page)).code, 'modal');
  assert.deepEqual(page.calls.map(({ tool }) => tool), ['flow_page_state']);
});

test('fills supplied attributes, uploads, and SKUs before reporting a new unresolved required attribute', async () => {
  const page = mockPage({ newRequired: true });
  const receipt = await run(page);
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.step, 'category-attributes');
  assert.equal(receipt.code, 'required-attribute-missing');
  assert.equal(receipt.details.label, '装订方式');
  assert.equal(page.state.attributes.find(attr => attr.label === '品牌').value, 'NoBrand');
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
  assert.equal(page.calls.some(({ tool }) => tool === 'flow_attribute_advice'), false);
});

test('recovers a new red-required dropdown in the current category after model consent', async () => {
  const page = mockPage({ newRequired: true, advice: async fields => {
    assert.deepEqual(fields.map(({ key, error, options }) => ({ key, error, options })), [
      { key: '装订方式', error: '请选择装订方式', options: ['线圈装', '胶装'] },
    ]);
    return { '装订方式': '线圈装', '库存': '50' };
  } });
  const receipt = await run(page, { ...input, completeMissingAttributes: true });
  assert.equal(receipt.status, 'verified');
  assert.equal(page.state.attributes.find(attr => attr.label === '装订方式').value, '线圈装');
  assert.equal(page.calls.filter(({ tool }) => tool === 'flow_attribute_advice').length, 1);
  assert.ok(page.calls.every(({ args }) => args.selector !== '#submit'));
});

test('leaves a required dropdown pending when the model invents an option', async () => {
  const page = mockPage({ newRequired: true, advice: async () => ({ '装订方式': '其他虚构方式' }) });
  const receipt = await run(page, { ...input, completeMissingAttributes: true });
  assert.equal(receipt.code, 'required-attribute-missing');
  assert.equal(receipt.details.label, '装订方式');
  assert.deepEqual(receipt.details.validation, ['请选择装订方式']);
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
  assert.ok(!page.calls.some(({ args }) => args.selector === '#spiral'));
});

test('defers a supplied obsolete attribute option without inventing its replacement', async () => {
  const page = mockPage({ newRequired: true });
  const receipt = await run(page, { ...input, attributes: { ...input.attributes, '装订方式': '以前的选项' } });
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.details.label, '装订方式');
  assert.equal(receipt.coverUploaded, true);
  assert.deepEqual(receipt.skuRows, input.variant.options);
  assert.ok(!page.calls.some(({ args }) => args.text === '以前的选项'));
});

test('rechecks attributes revealed during a later form section', async () => {
  const page = mockPage();
  const call = page.call;
  page.call = async (tool, args) => {
    if (tool === 'fill' && args.selector === '#weight') {
      page.state.attributes.push({ label: '纸张类型', required: true, value: '' });
    }
    return call(tool, args);
  };
  const receipt = await run(page);
  assert.equal(receipt.status, 'needs-review');
  assert.equal(receipt.details.label, '纸张类型');
  assert.deepEqual(receipt.skuRows, input.variant.options);
});

test('still stops on a validation error outside the category attributes', async () => {
  const page = mockPage();
  const call = page.call;
  page.call = async (tool, args) => {
    if (tool === 'upload_file') page.state.unscopedValidation = ['请填入重量'];
    return call(tool, args);
  };
  const receipt = await run(page);
  assert.equal(receipt.code, 'page-validation');
  assert.equal(receipt.step, 'image');
  assert.ok(!page.calls.some(({ args }) => args.selector === '#enable'));
});

test('reconsiders an old supplied choice only against the current category dropdown', async () => {
  const page = mockPage({ newRequired: true, advice: async fields => {
    assert.deepEqual(fields[0].options, ['线圈装', '胶装']);
    return { '装订方式': '线圈装' };
  } });
  const receipt = await run(page, { ...input, attributes: { ...input.attributes, '装订方式': '以前的选项' },
    completeMissingAttributes: true });
  assert.equal(receipt.status, 'verified');
  assert.equal(page.state.attributes.find(attr => attr.label === '装订方式').value, '线圈装');
  assert.ok(!page.calls.some(({ args }) => args.text === '以前的选项'));
});

test('does not confuse populated bulk controls with the actual SKU row', async () => {
  const page = mockPage({ failWrite: true });
  page.state.fields.batchQuantity.value = '30';
  const receipt = await run(page);
  assert.equal(receipt.code, 'sku-readback');
  assert.equal(page.state.fields.batchQuantity.value, '30');
  assert.equal(page.state.variant.rows.find(row => row.option === '雾蓝色').quantity, '0');
});

test('existing image requires verification before this run can continue', async () => {
  const page = mockPage({ coverPresent: true });
  assert.equal((await run(page)).code, 'cover-already-present');
  assert.equal(page.calls.some(({ tool }) => tool === 'upload_file'), false);
});

test('never writes outside the selected shop', async () => {
  const page = mockPage();
  page.state.url = 'https://seller.shopee.cn/portal/mtsku/new?cnsc_shop_id=555';
  assert.equal((await run(page)).code, 'page-changed');
  assert.deepEqual(page.calls.map(({ tool }) => tool), ['flow_page_state']);
});

test('waits for delayed values in each addressed SKU row', async () => {
  const page = mockPage({ delayedWrite: true });
  const receipt = await run(page);
  assert.equal(receipt.status, 'verified');
  assert.equal(receipt.skuRows[0].quantity, '30');
});

test('uploads two distinct local images to the individual SKU cells and verifies each preview', async () => {
  const page = mockPage();
  const options = input.variant.options.map((option, index) => ({ ...option, imagePath: '/products/sku-' + index + '.png' }));
  const receipt = await run(page, { ...input, variant: { ...input.variant, options } });
  assert.equal(receipt.status, 'verified');
  assert.ok(receipt.skuRows.every(row => row.imageVerified && row.imageUploaded));
  assert.deepEqual(page.calls.filter(({ tool }) => tool === 'upload_file').map(({ args }) => [args.selector, args.paths[0]]), [
    ['#cover', input.imagePath], ['#image-1', options[0].imagePath], ['#image-2', options[1].imagePath],
  ]);
  assert.equal(page.state.variant.rows[0].sku, options[1].sku, 'row order is independent of request order');
});

test('waits for each gallery image to finish before sending the next one', async () => {
  const gallery = ['/products/detail-1.png', '/products/detail-2.png'];
  const page = mockPage({ gallery });
  const call = page.call;
  let pendingReads = 0;
  page.call = async (tool, args) => {
    if (tool === 'upload_file' && args.selector === '#cover') {
      assert.equal(pendingReads, 0);
      pendingReads = 2;
    }
    const result = await call(tool, args);
    if (tool === 'flow_page_state' && pendingReads > 0) {
      pendingReads--;
      const current = JSON.parse(result);
      current.image.readyCount--;
      return current;
    }
    return result;
  };
  const receipt = await run(page, { ...input, galleryImages: gallery });
  assert.equal(receipt.status, 'verified', JSON.stringify(receipt));
  assert.equal(receipt.galleryUploaded, 2);
});

test('preserves the original single-option schema', async () => {
  const page = mockPage();
  const [first] = input.variant.options;
  const receipt = await run(page, { ...input, variant: { name: input.variant.name, ...first } });
  assert.equal(receipt.status, 'verified');
  assert.deepEqual(receipt.skuRows, [first]);
});

test('retries only the same exact recommendation after a click that did not commit', async () => {
  const page = mockPage({ retryCategory: true });
  const receipt = await run(page);
  assert.equal(receipt.status, 'verified');
  const attempts = page.calls.filter(({ args }) => args.selector === '#category');
  assert.deepEqual(attempts.map(({ tool }) => tool), ['query_dom', 'trusted_click', 'query_dom', 'flow_category_click']);
});

test('reports observed paths without selecting a different recommendation', async () => {
  const recommendations = ['文具 > 笔记本与纸质用品 > 备忘录与便利贴', '文具 > 笔记本与纸质用品 > 活页纸'];
  const page = mockPage({ categoryRecommendations: recommendations });
  const receipt = await run(page);
  assert.equal(receipt.code, 'category-option-missing');
  assert.deepEqual(receipt.details.recommendations, recommendations);
  assert.ok(!page.calls.some(({ tool }) => tool === 'trusted_click' || tool === 'flow_category_click'));
});
