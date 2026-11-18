import { normalizeSizeChart } from '../../../lib/size-chart.mjs';

export const id = 'shopee-listing';
export const version = 1;
const origin = 'https://seller.shopee.cn';

class Pause extends Error {
  constructor(code, details) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const norm = (value) => String(value ?? '').trim().replace(/\s*[＞>›»]\s*/g, ' > ');
const matchedNumber = (actual, wanted) => actual != null && actual !== '' && Number(actual) === Number(wanted);
const positive = value => /^(?:\d+\.?\d*|\.\d+)$/.test(String(value)) && Number.isFinite(Number(value)) && Number(value) > 0;
const validImage = path => path == null || typeof path === 'string' && /^(?:\/|[A-Za-z]:[\\/]).+\.(?:png|jpe?g|webp)$/i.test(path);
const nonemptyText = value => typeof value === 'string' && value.trim() === value && value !== '';

function normalizeVariants(variant) {
  if (variant == null) return [];
  if (!nonemptyText(variant.name) || variant.name.length > 14) throw new TypeError('规格名称格式不符');
  const rawOptions = variant.options === undefined ? [variant] : variant.options;
  if (!Array.isArray(rawOptions) || !rawOptions.length) throw new TypeError('至少需要一个规格选项');
  const names = new Set();
  const skus = new Set();
  for (const item of rawOptions) {
    if (!nonemptyText(item?.option) || item.option.length > 30 || !nonemptyText(item.sku)) {
      throw new TypeError('规格选项与货号格式不符');
    }
    if (names.has(item.option) || skus.has(item.sku)) throw new TypeError('同一商品的规格选项和货号不能重复');
    names.add(item.option);
    skus.add(item.sku);
    if (!validImage(item.imagePath)) throw new TypeError('SKU 图片应为本地图片的绝对路径');
  }
  return rawOptions;
}

function validate(input, tabId) {
  if (!Number.isSafeInteger(tabId) || tabId <= 0) throw new TypeError('需要明确的 tabId');
  for (const key of ['shopId', 'title', 'description', 'category']) {
    if (typeof input?.[key] !== 'string' || !input[key].trim()) throw new TypeError('缺少参数 ' + key);
  }
  if (!/^\d+$/.test(input.shopId) || input.title.length > 180 || input.description.length > 4000 || input.category.length > 220) {
    throw new TypeError('店铺、标题、描述或类目参数格式不符');
  }
  const fields = input.attributes ?? {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) ||
    Object.entries(fields).some(([label, value]) => !label.trim() || typeof value !== 'string' || !value.trim())) {
    throw new TypeError('attributes 应为页面标签到选项文本的映射');
  }
  const variants = normalizeVariants(input.variant);
  if (!positive(input.weight)) throw new TypeError('重量应为正数');
  for (const sales of variants.length ? variants : [input]) {
    if (!positive(sales.price)) throw new TypeError('价格应为正数');
    if (!/^\d+$/.test(String(sales.quantity))) throw new TypeError('库存应为非负整数');
  }
  for (const key of ['width', 'length', 'height', 'shipDays']) {
    if (input[key] != null && (!/^\d+$/.test(String(input[key])) || Number(input[key]) <= 0)) throw new TypeError('无效参数 ' + key);
  }
  if (!validImage(input.imagePath)) throw new TypeError('imagePath 应为本地商品图片的绝对路径');
  return variants;
}

const sizeChartLabel = label => norm(label).normalize('NFKC').replace(/\s+/gu, '')
  .replaceAll('下擺寬度', '下摆宽度').replaceAll('長', '长').replaceAll('國際', '国际');

async function scopedSizeChartName(chart, category) {
  const payload = [category, chart.unit, chart.rows.map(row => Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const fingerprint = [...new Uint8Array(digest).subarray(0, 6)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const prefix = chart.name.length > 37 ? chart.name.slice(0, 37).trimEnd() : chart.name;
  return prefix + '-' + fingerprint;
}

function sameSizeChartRows(actual, desired) {
  return actual.length === desired.length && desired.every((row, index) => Object.entries(row).every(([label, value]) => {
    const key = sizeChartLabel(label);
    const observed = norm(actual[index][label]);
    if (key === '尺寸(国际)' && value === '2XL' && observed === 'XXL') return true;
    return value && !key.startsWith('尺寸(') ? matchedNumber(observed, value) : observed === value;
  }));
}

function sizeChartSources(chart, dialog) {
  const sourceColumns = new Map(chart.columns.map(label => [sizeChartLabel(label), label]));
  const kind = dialog.kind ?? norm(dialog.title).split(/\s+/u).at(-1);
  return dialog.columns.filter(column => column.checked).map(column => {
    const key = sizeChartLabel(column.label);
    const source = sourceColumns.get(key) || (kind === '上衣' && key === '上衣长度' ? sourceColumns.get('长度') : undefined);
    return { ...column, source };
  });
}

function validateCompletedChart(original, completed, requiredColumns) {
  const result = normalizeSizeChart(completed);
  const originalLabels = new Set(original.columns);
  const additions = result.columns.filter(label => !originalLabels.has(label));
  const required = new Map(requiredColumns.map(({ label, options }) => [sizeChartLabel(label), options]));
  if (result.name !== original.name || result.unit !== original.unit || result.rows.length !== original.rows.length ||
      additions.length !== required.size || additions.some(label => !required.has(sizeChartLabel(label))) ||
      !original.columns.every(label => result.columns.includes(label))) throw new Pause('size-chart-inference-changed');
  for (const [index, row] of result.rows.entries()) {
    if (original.columns.some(label => row[label] !== original.rows[index][label])) throw new Pause('size-chart-inference-changed');
    for (const label of additions) {
      const options = required.get(sizeChartLabel(label));
      if (options && !options.includes(row[label])) throw new Pause('size-chart-inference-option', { label, actual: row[label] });
    }
  }
  return { chart: result, estimatedColumns: additions };
}

async function replaySizeChart({ chart, category, title, allowInference, native, pause }) {
  const read = () => native('flow_size_chart_state', { category });
  const act = (action, args) => native('flow_size_chart_action', { category, action, ...args });
  async function waitFor(predicate, timeoutMs = 1600) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const current = await read();
      if (predicate(current) || Date.now() >= deadline) return current;
      await pause(100);
    }
  }
  let availableTemplates = [];
  async function selectExisting(name) {
    await act('open-options');
    const menu = await waitFor(current => Array.isArray(current.options));
    if (!Array.isArray(menu.options)) throw new Pause('size-chart-options-unavailable');
    availableTemplates = menu.options;
    const matches = availableTemplates.filter(option => option === name);
    if (matches.length > 1) throw new Pause('size-chart-template-ambiguous', { name });
    if (!matches.length) return false;
    await act('select', { name });
    const result = await waitFor(current => current.selectedName === name);
    if (result.selectedName !== name) throw new Pause('size-chart-selection-unverified', { name });
    return true;
  }

  let name = await scopedSizeChartName(chart, category);
  const first = await read();
  if (!first.available) throw new Pause('size-chart-control-unavailable');
  if (first.dialog) throw new Pause('size-chart-dialog-already-open');
  if (first.selectedName && first.selectedName !== name) {
    throw new Pause('size-chart-selection-conflict', { name, actual: first.selectedName });
  }
  let estimatedColumns = [];
  const receipt = reused => ({ name, unit: chart.unit, rows: chart.rows.length, reused,
    ...(estimatedColumns.length ? { estimatedColumns } : {}) });
  if (first.selectedName === name || await selectExisting(name)) return receipt(true);

  let dialog;
  async function expectDialog(predicate, code, details) {
    ({ dialog } = await waitFor(current => current.dialog && predicate(current.dialog)));
    if (!dialog || !predicate(dialog)) throw new Pause(code, details);
  }
  async function toggle(label, checked) {
    await act('toggle-column', { label, checked });
    await expectDialog(current => current.columns.some(column => column.label === label && column.checked === checked),
      'size-chart-column-unverified', { label });
  }
  async function openAndConfigureColumns() {
    await act('open');
    await expectDialog(current => current.columns?.length && current.rows?.length, 'size-chart-dialog-unavailable');
    if (dialog.name) throw new Pause('size-chart-dialog-name-conflict', { actual: dialog.name });
    const configured = new Set();
    for (const label of chart.columns) {
      const matches = dialog.columns.filter(column => sizeChartLabel(column.label) === sizeChartLabel(label));
      if (matches.length !== 1) throw new Pause('size-chart-column-unavailable', { label });
      configured.add(matches[0].label);
    }
    for (const label of configured) {
      const column = dialog.columns.find(candidate => candidate.label === label);
      if (!column?.checked) await toggle(label, true);
    }
    for (const { label } of dialog.columns) {
      const column = dialog.columns.find(candidate => candidate.label === label);
      if (column?.checked && !column.locked && !configured.has(label)) await toggle(label, false);
    }
  }

  await openAndConfigureColumns();
  let active = sizeChartSources(chart, dialog);
  const missing = active.filter(column => !column.source && column.required !== false);
  if (missing.length && allowInference) {
    const requiredColumns = [];
    for (const { label } of missing) {
      const field = { label };
      if (sizeChartLabel(label).startsWith('尺寸(')) {
        const values = await act('column-options', { label });
        if (!Array.isArray(values.options) || !values.options.length ||
            values.options.some(option => typeof option !== 'string' || !option.trim())) {
          throw new Pause('size-chart-inference-options-unavailable', { label });
        }
        field.options = [...new Set(values.options)];
      }
      requiredColumns.push(field);
    }
    const completion = await native('flow_size_chart_complete', { category, title, chart, requiredColumns });
    ({ chart, estimatedColumns } = validateCompletedChart(chart, completion.sizeChart, requiredColumns));
    name = await scopedSizeChartName(chart, category);
    if (availableTemplates.includes(name)) {
      await act('dismiss');
      if ((await waitFor(current => !current.dialog, 12000)).dialog) throw new Pause('size-chart-dismiss-unverified');
      if (await selectExisting(name)) return receipt(true);
      await openAndConfigureColumns();
    }
    active = sizeChartSources(chart, dialog);
  }
  for (const column of active) {
    if (!column.source && column.required !== false) throw new Pause('size-chart-required-column', { label: column.label });
  }

  await act('set-name', { name });
  await expectDialog(current => current.name === name, 'size-chart-name-unverified', { name });
  if (dialog.unit !== chart.unit) {
    await act('set-unit', { unit: chart.unit });
    await expectDialog(current => current.unit === chart.unit, 'size-chart-unit-unverified', { unit: chart.unit });
  }
  const rows = chart.rows.map(row => Object.fromEntries(active.map(({ label, source }) => [label, source ? row[source] : ''])));
  if (dialog.rows.length > rows.length) throw new Pause('size-chart-row-count-changed', { expected: rows.length, actual: dialog.rows.length });
  while (dialog.rows.length < rows.length) {
    const rowCount = dialog.rows.length;
    await act('add-row', { rowCount });
    await expectDialog(current => current.rows.length === rowCount + 1, 'size-chart-row-add-unverified', { rowCount });
  }
  await act('fill-rows', { rows });
  await expectDialog(current => current.name === name && current.unit === chart.unit && sameSizeChartRows(current.rows, rows),
    'size-chart-readback', { name });
  if (dialog.validation?.length) throw new Pause('size-chart-validation', dialog.validation);
  await act('save', { name, unit: chart.unit, rows });
  const saved = await waitFor(current => !current.dialog || current.dialog.validation?.length, 22000);
  if (saved.dialog?.validation?.length) throw new Pause('size-chart-validation', saved.dialog.validation);
  if (saved.dialog) throw new Pause('size-chart-save-unverified', { name });
  if (saved.selectedName !== name && !await selectExisting(name)) throw new Pause('size-chart-selection-unverified', { name });
  return receipt(false);
}

// call 由宿主提供，经 PageLens 现有工具包装后返回原始结果或抛出工具错误。
export async function replayShopeeListing({ call, tabId, input, onStep = () => {}, signal }) {
  const variants = validate(input, tabId);
  const sizeChart = input.sizeChart == null ? null : normalizeSizeChart(input.sizeChart);
  const completed = [];
  const began = Date.now();
  let step = 'bind-page';
  let originalUrl;
  let state;
  let coverUploaded = false;
  let skuRows;
  let sizeChartReceipt;
  const category = norm(input.category);
  const uploadedOptions = new Set();
  const native = async (tool, args) => {
    signal?.throwIfAborted();
    onStep({ step, tool });
    const raw = await call(tool, { tabId, ...args });
    signal?.throwIfAborted();
    let response = raw;
    if (typeof raw === 'string') {
      try { response = JSON.parse(raw); } catch { throw new Pause('tool-failed', { tool, error: raw.slice(0, 300) }); }
    }
    if (response?.ok === false) {
      throw new Pause(response.code || response.error?.code || 'tool-failed', { tool, error: response.error });
    }
    return response;
  };
  const checkpoint = (next) => {
    completed.push(step);
    step = next;
  };
  const read = async (verifySummary = false) => {
    const current = await native('flow_page_state', { category, ...(verifySummary && { verifySummary }) });
    const url = new URL(current.url);
    if (url.origin !== origin || url.pathname !== '/portal/mtsku/new' ||
      url.searchParams.getAll('cnsc_shop_id').length !== 1 || url.searchParams.get('cnsc_shop_id') !== input.shopId ||
      originalUrl && current.url !== originalUrl) throw new Pause('page-changed', { url: url.origin + url.pathname });
    originalUrl = current.url;
    if (current.modal) throw new Pause('modal', current.modal);
    if (current.validation?.length) throw new Pause('page-validation', current.validation);
    state = current;
    return state;
  };
  const pause = async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    signal?.throwIfAborted();
  };
  const readUntil = async (predicate, timeoutMs = 1600) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      await read();
      if (predicate(state) || Date.now() >= deadline) return;
      await pause(100);
    }
  };
  const unique = async (selector, tag) => {
    if (!selector) throw new Pause('control-missing');
    const targets = await native('query_dom', { selector, limit: 2 });
    if (!Array.isArray(targets) || targets.length !== 1 || tag && targets[0].tag !== tag) {
      throw new Pause('control-changed', { selector });
    }
    return targets[0];
  };
  const fill = async (field, value) => {
    if (!field) throw new Pause('field-missing');
    if (field.value === String(value)) return;
    const target = await unique(field.selector);
    if (!['input', 'textarea'].includes(target.tag) || target.type === 'file') {
      throw new Pause('field-kind-changed', { selector: field.selector });
    }
    await native('fill', { selector: field.selector, value: String(value), submit: false });
  };
  const click = async (selector, label) => {
    const target = await unique(selector);
    if (norm(target.text) !== norm(label)) throw new Pause('click-label-changed', { expected: label, actual: target.text });
    await native('trusted_click', { selector, text: target.text });
  };
  const clickAttribute = async (label, selector) => {
    const target = await unique(selector);
    await native('flow_control_click', { action: 'attribute-trigger', selector, category, label, text: target.text });
  };
  const expected = (key, value, normalize = (actual, desired) => String(actual) === String(desired)) => {
    if (!state.fields[key] || !normalize(state.fields[key].value, value)) throw new Pause('readback-mismatch', { key });
  };
  const rowFor = (option, current = state) => {
    const candidates = current.variant.rows.filter(row => row.option === option);
    return candidates.length === 1 ? candidates[0] : null;
  };
  const rowMatches = (row, wanted) => Boolean(row && matchedNumber(row.price, wanted.price) &&
    matchedNumber(row.quantity, wanted.quantity) && row.sku === wanted.sku);
  try {
    await read();
    checkpoint('basic');
    if (state.category && norm(state.category) !== category) throw new Pause('different-category', { actual: state.category });
    await fill(state.fields.title, input.title);
    await fill(state.fields.description, input.description);
    await read();
    expected('title', input.title);
    expected('description', input.description);

    checkpoint('category');
    if (!state.category) {
      if (!state.recommendation) {
        await readUntil(current => Boolean(current.recommendation || current.category), 3800);
      }
      if (!state.category) {
        if (!state.recommendation) {
          throw new Pause('category-option-missing', { category, recommendations: state.recommendations ?? [] });
        }
        await click(state.recommendation, category);
        await readUntil(current => Boolean(current.category));
        if (!state.category && state.recommendation) {
          const target = await unique(state.recommendation);
          if (norm(target.text) !== category) throw new Pause('category-control-changed', { category, actual: target.text });
          await native('flow_category_click', { selector: state.recommendation, category });
        }
      }
      if (!state.categoryReady) await readUntil(current => current.categoryReady, 3800);
    }
    if (norm(state.category) !== category || !state.categoryReady) {
      throw new Pause('category-not-ready', { category, actual: state.category, recommendations: state.recommendations ?? [] });
    }

    checkpoint('category-attributes');
    const supplied = input.attributes ?? {};
    // Shopee can render sales controls before the category attribute panel is hydrated.
    // Wait for these category-specific controls instead of immediately treating them as missing.
    const requestedAttributes = Object.keys(supplied);
    if (requestedAttributes.some(label => !state.attributes.some(field => field.label === label && field.selector))) {
      await readUntil(current => requestedAttributes.every(label =>
        current.attributes.some(field => field.label === label && field.selector)), 4800);
    }
    for (const { label, required, value } of state.attributes) {
      if (required && !value && !Object.hasOwn(supplied, label)) throw new Pause('required-attribute-missing', { label });
    }
    for (const [label, choice] of Object.entries(supplied)) {
      const fields = state.attributes.filter((field) => field.label === label);
      if (fields.length !== 1) throw new Pause('attribute-changed', { label });
      const field = fields[0];
      const alreadyOpen = Boolean(state.options.length || state.optionSearch);
      if (field.value === choice) {
        if (alreadyOpen && state.optionOwner === label) {
          await clickAttribute(label, field.selector);
          await pause(180);
          await readUntil((current) => !current.options.length && !current.optionSearch);
        }
        continue;
      }
      if (alreadyOpen && state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
      if (!alreadyOpen) {
        await clickAttribute(label, field.selector);
        await pause(200);
      }
      await readUntil((current) => current.options.some(({ text }) => text === choice));
      let matches = state.options.filter(({ text }) => text === choice);
      if (!matches.length && state.optionSearch) {
        await fill({ selector: state.optionSearch }, choice);
        await native('wait_for', { text: choice, timeoutMs: 2300 });
        await readUntil((current) => current.options.some(({ text }) => text === choice));
        matches = state.options.filter(({ text }) => text === choice);
      }
      if (matches.length !== 1) throw new Pause('attribute-option-changed', { label, choice });
      await native('flow_control_click', {
        action: 'attribute-option', selector: matches[0].selector, category, label, text: choice,
      });
      await pause(180);
      await readUntil((current) => current.attributes.find((attribute) => attribute.label === label)?.value === choice);
      if (state.attributes.find((after) => after.label === label)?.value !== choice) throw new Pause('attribute-readback', { label, choice });
      if (state.options.length || state.optionSearch) {
        await native('press_keys', { keys: ['Escape'] });
        await pause(180);
        await read();
        if (state.options.length || state.optionSearch) {
          const live = state.attributes.find((after) => after.label === label);
          if (!live?.selector || state.optionOwner && state.optionOwner !== label) throw new Pause('unexpected-open-menu', { label });
          await clickAttribute(label, live.selector);
          await readUntil((current) => !current.options.length && !current.optionSearch, 650);
        }
      }
    }

    checkpoint('image');
    if (input.imagePath && state.image.count == null) throw new Pause('cover-count-unknown');
    if (input.imagePath && state.image.count && !input.retainExistingCover) throw new Pause('cover-already-present');
    if (input.imagePath && !state.image.count) {
      await unique(state.image.selector, 'input');
      await native('upload_file', { selector: state.image.selector, paths: [input.imagePath] });
      await native('wait_for', { text: '封面', timeoutMs: 8000 });
      await readUntil((current) => current.image.cover && current.image.count === 1, 2500);
      coverUploaded = state.image.cover && state.image.count === 1;
      if (!coverUploaded) throw new Pause('cover-readback');
    }

    checkpoint('sales');
    const variant = input.variant;
    if (variant) {
      const allowedOptions = new Set(variants.map(item => item.option));
      if (state.variant.enable) {
        await native('flow_control_click', {
          action: 'variant-enable', selector: state.variant.enable, category, label: '开启商品规格', text: '开启商品规格',
        });
        await readUntil((current) => Boolean(current.fields.variantName));
      }
      if (state.fields.variantName?.value && state.fields.variantName.value !== variant.name ||
          state.variant.options.some(existing => !allowedOptions.has(existing))) throw new Pause('different-variant');
      if (state.fields.variantName?.value !== variant.name) {
        if (!state.fields.variantName?.selector) throw new Pause('variant-control-changed', { kind: 'name' });
        await native('flow_variant_write', {
          kind: 'name', selector: state.fields.variantName.selector, category, name: variant.name, existingOptions: state.variant.options,
        });
        await readUntil((current) => current.fields.variantName?.value === variant.name);
        if (state.fields.variantName?.value !== variant.name) throw new Pause('variant-name-readback', { name: variant.name });
      }
      for (const { option } of variants) {
        if (state.variant.options.includes(option)) continue;
        if (!state.fields.variantOption?.selector) throw new Pause('variant-control-changed', { kind: 'option', option });
        await native('flow_variant_write', {
          kind: 'option', selector: state.fields.variantOption.selector, category, name: variant.name, option,
          existingOptions: state.variant.options,
        });
        await readUntil(current => Boolean(rowFor(option, current)));
        if (!rowFor(option)) throw new Pause('sku-row-not-unique', { option });
      }
      if (state.variant.rows.length !== variants.length || variants.some(({ option }) => !rowFor(option))) {
        throw new Pause('sku-row-not-unique');
      }
      for (const item of variants) {
        const { option } = item;
        const row = rowFor(option);
        for (const key of ['price', 'quantity', 'sku']) {
          if (!row.selectors?.[key]) throw new Pause('sku-control-missing', { option, key });
          await fill({ selector: row.selectors[key], value: row[key] }, item[key]);
        }
        await readUntil(current => rowMatches(rowFor(option, current), item));
        if (!rowMatches(rowFor(option), item)) throw new Pause('sku-readback', { option });
        if (!item.imagePath) continue;
        const image = rowFor(option).image;
        if (image?.present) {
          if (!item.retainExistingImage) throw new Pause('sku-image-already-present', { option });
          continue;
        }
        if (!image?.selector) throw new Pause('sku-image-control-missing', { option });
        await unique(image.selector, 'input');
        await native('upload_file', { selector: image.selector, paths: [item.imagePath] });
        await readUntil(current => Boolean(rowFor(option, current)?.image?.present), 8000);
        if (!rowFor(option)?.image?.present) throw new Pause('sku-image-readback', { option });
        uploadedOptions.add(option);
      }
    } else {
      if (state.fields.variantName || state.variant.rows.length) throw new Pause('variants-already-enabled');
      await fill(state.fields.price, input.price);
      await fill(state.fields.quantity, input.quantity);
    }

    checkpoint('shipping');
    const shipping = ['weight', 'width', 'length', 'height', 'shipDays'].filter((key) => input[key] != null);
    for (const key of shipping) await fill(state.fields[key], input[key]);
    if (input.sku != null) await fill(state.fields.sku, input.sku);
    await read();
    for (const key of shipping) expected(key, input[key], matchedNumber);
    if (input.sku != null) expected('sku', input.sku);
    if (!variant) {
      expected('price', input.price, matchedNumber);
      expected('quantity', input.quantity, matchedNumber);
    }
    skuRows = variants.map(item => {
      const row = rowFor(item.option);
      if (!rowMatches(row, item)) throw new Pause('sku-readback', { option: item.option });
      const { option, price, quantity, sku } = row;
      if (!item.imagePath) return { option, price, quantity, sku };
      if (!row.image?.present) throw new Pause('sku-image-readback', { option });
      return { option, price, quantity, sku, imageVerified: true, imageUploaded: uploadedOptions.has(option) };
    });
    if (sizeChart) {
      checkpoint('size-chart');
      sizeChartReceipt = await replaySizeChart({
        chart: sizeChart, category, title: input.title, allowInference: input.completeMissingSizeChart === true, native, pause,
      });
      await read();
    }
    if (state.missingRequired > 0) {
      await read(true);
      if (state.missingRequired > 0) await readUntil(current => !current.missingRequired, 2500);
    }
    completed.push(step);
    const receipt = { completed, category, coverUploaded, skuRows, ...(sizeChartReceipt ? { sizeChart: sizeChartReceipt } : {}),
      elapsedMs: Date.now() - began };
    if (state.missingRequired > 0) {
      return { ...receipt, status: 'needs-review', code: 'required-fields-remain',
        details: { text: `Shopee 提示仍有 ${state.missingRequired} 个必填字段为空。` } };
    }
    return { ...receipt, status: 'verified' };
  } catch (error) {
    return {
      status: signal?.aborted ? 'cancelled' : 'needs-review', step, completed,
      code: signal?.aborted ? 'cancelled' : error.code || 'tool-error',
      details: error.details ?? error.message, elapsedMs: Date.now() - began,
      ...(skuRows ? { category, coverUploaded, skuRows } : {}),
      ...(sizeChartReceipt ? { sizeChart: sizeChartReceipt } : {}),
    };
  }
}
