// Injected by PageLens. Keep this function self-contained and read-only.
export function readPage(category) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const ownText = node => [...node.childNodes].filter(child => child.nodeType === 3)
    .map(child => child.nodeValue).join(' ');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const all = (q, root = document) => [...(root?.querySelectorAll(q) ?? [])];
  const shown = (q, root) => all(q, root).filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const one = (q, root) => only(shown(q, root));
  function value(node) {
    if (!node) return null;
    if (node.matches('input[type=checkbox],input[type=radio]') && !node.checked) return '';
    return String(node.value ?? node.textContent);
  }

  const out = {
    url: location.href, modal: null, validation: [], category: null, recommendation: null, recommendations: [],
    categoryReady: false, fields: {}, attributes: [], options: [], optionSearch: null,
    image: { count: null, cover: false, selector: null },
    variant: { enable: null, options: [], rows: [] },
  };
  if (location.origin !== 'https://seller.shopee.cn' || location.pathname !== '/portal/mtsku/new') return out;

  const panels = ['.product-basic-info', '.product-specification-new', '.product-sales-info', '.mtsku-product-shipping'];
  function selectorOf(node) {
    if (!node) return null;
    const steps = [];
    for (let el = node; el && el !== document.body; el = el.parentElement) {
      const anchor = panels.find(selector => el.matches(selector) && only(all(selector)) === el);
      if (anchor) return [anchor, ...steps].join(' > ');
      const index = Array.from(el.parentElement.children).indexOf(el) + 1;
      steps.unshift(el.localName + ':nth-child(' + index + ')');
    }
    return ['body', ...steps].join(' > ');
  }

  const basic = one(panels[0]), sales = one(panels[2]);
  const labelText = node => clean(node.querySelector('.item-title-text,:scope > span')?.textContent ||
    clean(ownText(node)) || node.textContent).replace(/^[*＊]\s*|\s*\d+\/\d+$/gu, '');
  const labelNode = row => row?.querySelector(':scope > .edit-label');
  const rowsWithLabels = root => shown('.edit-row', root).filter(row => labelNode(row));
  const labels = {
    商品名称: 'title', 商品描述: 'description', 全球商品价格: 'price', 商品数量: 'quantity',
    重量: 'weight', 发货时间: 'shipDays', 全球商品货号: 'sku',
  };
  const edits = ':is(input:not([type=file],[type=checkbox],[type=radio]),textarea,[contenteditable=true]):not([disabled],[readonly])';
  const fields = new Map();
  function add(key, node) {
    if (node) fields.set(key, fields.has(key) ? null : node);
  }
  for (const row of rowsWithLabels(document)) {
    if (row.closest(panels[1])) continue;
    const label = labelText(labelNode(row));
    const controls = shown(edits, row).filter(el => el.closest('.edit-row') === row &&
      !el.closest('.eds-popper,.eds-modal,.batch-edit-row,.variation-model-table'));
    if (Object.hasOwn(labels, label)) add(labels[label], only(controls));
    if (label === '包裹尺寸大小') {
      const dims = { 宽: 'width', 长: 'length', 高: 'height' };
      for (const el of controls) {
        const key = dims[el.getAttribute('placeholder')?.[0]];
        if (key) add(key, el);
      }
    }
  }

  const nameFields = shown('.variation-name-panel input', sales);
  const optionFields = shown('.variation-option-panel .options-item input', sales);
  const options = optionFields.map(el => clean(value(el))).filter(Boolean);
  add('variantName', only(nameFields));
  const blankOptions = optionFields.filter(el => value(el) === '');
  add('variantOption', !options.length && only(blankOptions.filter(el => el.closest('.drag-item') &&
    !el.closest('.virtual-options-item'))) || only(blankOptions.filter(el => el.closest('.virtual-options-item'))));
  for (const [key, node] of fields) {
    if (node) out.fields[key] = { selector: selectorOf(node), value: value(node) };
  }

  const categoryNode = one('.product-category-text', basic);
  const selected = pathText(categoryNode?.textContent).replace(/^(?:Please set category|请选择(?:商品)?类[别目])$/iu, '');
  out.category = selected || null;
  const wanted = pathText(category);
  if (!out.category && categoryNode) {
    const row = categoryNode.closest('.edit-row');
    const radios = shown('.recommend-category-container .category-select-radio', row)
      .filter(el => el.querySelector(':scope > .radio-indicator') && el.querySelector(':scope > .radio-text'));
    const candidates = (radios.length ? radios : shown('label,button,[role=option],[role=radio],li,a,span,div,p', row))
      .map(el => ({ el, text: pathText(el.textContent) }))
      .filter(({ text }) => text.length <= 220 && text.includes(' > '));
    const items = candidates.filter(({ el, text }) => !candidates.some(other =>
      other.el !== el && el.contains(other.el) && (other.text === text || text.includes(other.text))));
    out.recommendations = [...new Set(items.map(({ text }) => text))].slice(0, 20);
    const match = only(items.filter(({ text }) => text === wanted));
    out.recommendation = selectorOf(match?.el);
  }

  const opened = [];
  for (const row of all('.edit-row', one(panels[1]))) {
    const label = labelNode(row);
    if (!label) continue;
    const controls = all('.eds-selector,select,input,textarea,[contenteditable=true]', row)
      .filter(el => !el.closest('.eds-popper,.eds-modal'));
    const control = only(controls.filter(el => visible(el) &&
      !el.closest('[disabled],[readonly],[aria-disabled=true],.eds-selector--disabled')));
    const required = Boolean(label.querySelector('.mandatory') || /^\s*[＊*]/u.test(label.textContent) ||
      controls.some(el => el.matches('[required],[aria-required=true]')));
    if (!control && !required) continue;
    const selection = control?.querySelector('.eds-selector__inner,.scroll-selector-content') ?? control;
    if (control && (control.getAttribute('aria-expanded') === 'true' || control.closest('.eds-select.is-show'))) {
      opened.push(labelText(label));
    }
    out.attributes.push({ label: labelText(label), required, selector: selectorOf(control),
      value: selection?.matches('.placeholder') ? '' : clean(value(selection)).replace(/^请选择$/u, '') });
  }
  out.categoryReady = Boolean(out.category && (!wanted || out.category === wanted) &&
    (out.attributes.some(attribute => attribute.selector) || out.fields.price || out.fields.variantName));

  const menu = only(shown('.eds-select-popover-content:not(.slide-fast-leave-active)')
    .filter(el => el.getClientRects().length && el.querySelector('.eds-option,[role=option],input:not([type=hidden])')));
  if (menu) {
    const active = shown(':is(.eds-option,[role=option]):not([aria-disabled=true],.eds-option--disabled,.is-disabled)', menu);
    out.options = active.slice(0, 100).map(el => ({ text: clean(el.textContent), selector: selectorOf(el) }));
    out.optionSearch = selectorOf(one('input:not([type=hidden],[disabled],[readonly])', menu));
    out.optionOwner = only(opened);
  }

  const media = one('.shopee-image-manager', basic);
  if (media) {
    const upload = '.product-basic-info .shopee-image-manager__upload input[type=file][accept="image/*"]';
    const count = media.querySelector('.shopee-image-manager__upload__content__text')?.textContent
      .match(/\((\d+)\s*\/\s*\d+\)/u)?.[1];
    out.image = {
      count: count == null ? null : Number(count),
      cover: /封面/u.test(media.innerText ?? media.textContent),
      selector: selectorOf(only(all(upload).filter(el => !el.disabled))),
    };
  }

  function button(q, label) {
    const node = one(q, sales);
    return clean(node?.textContent) === label ? selectorOf(node) : null;
  }
  out.variant.enable = button('.variation-add-button button.primary-dash-button', '开启商品规格');
  out.variant.options = options;
  const leftBody = one('.variation-model-table-fixed-left .variation-model-table-body', sales);
  const middleBody = one('.variation-model-table-middle-scroll .variation-model-table-body', sales);
  const firstCells = shown('.first-variation-cell', leftBody);
  const price = '.table-cell .model-edit-input .price-input input';
  const groups = shown('.data-group', middleBody).filter(group => group.querySelector(price));
  const choices = firstCells.map(el => clean(ownText(el)));
  // Shopee renders variation labels/images in a fixed table and the editable
  // columns in a separate scrollable table. Confirm they describe the same rows.
  if (nameFields.length === 1 && groups.length === choices.length && choices.length === options.length &&
      choices.every((option, index) => option === options[index])) {
    out.variant.rows = groups.map((group, index) => {
      const fields = {
        price: one(price, group),
        quantity: one('.table-cell.stock-column input', group),
        sku: one('.table-cell .sku-textarea textarea', group),
      };
      const images = one('.shopee-image-manager', firstCells[index]);
      const uploads = all('.shopee-image-manager__upload input[type=file][accept="image/*"]', images)
        .filter(el => !el.disabled);
      const thumbnail = shown('.shopee-image-manager__itembox img', images).find(img =>
        !img.closest('.shopee-image-manager__upload,.eds-modal,.image-cropper-modal') &&
        img.complete && img.naturalWidth > 0 && !/^data:image\/gif[;,]/iu.test(img.currentSrc || img.src));
      return {
        option: choices[index],
        price: value(fields.price),
        quantity: value(fields.quantity),
        sku: value(fields.sku),
        selectors: Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, selectorOf(el)])),
        image: { selector: selectorOf(only(uploads)), present: Boolean(thumbnail) },
      };
    });
  }

  const modal = shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open]').at(-1) ??
    shown('.eds-popper:has(.pulse-popover-button)').at(-1);
  if (modal) out.modal = { text: clean(modal.innerText ?? modal.textContent).slice(0, 200) || '页面弹窗' };
  out.missingRequired = Number(document.body.innerText?.match(/仍有\s*(\d+)\s*个必填字段为空/u)?.[1] ?? 0);
  out.validation = [...new Set(shown('[aria-invalid=true],.eds-form-item__error,.eds-message--error,[role=alert]')
    .map(el => clean(el.textContent || el.getAttribute('aria-label') || labelNode(el.closest('.edit-row'))?.textContent))
    .filter(Boolean))].slice(0, 12);
  return out;
}

// The retry is limited to a current, exact recommendation in the shop category row.
export function clickCategoryRecommendation(selector, category, expectedUrl) {
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim().replace(/\s*[＞>›»]\s*/gu, ' > ');
  const rejected = error => ({ ok: false, code: 'category-control-changed', error });
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' || location.pathname !== '/portal/mtsku/new') {
    return rejected('页面已离开 Shopee 新增商品表单。');
  }
  const displays = [...document.querySelectorAll('.product-basic-info .product-category-text')]
    .filter(node => node.getClientRects().length);
  const display = displays.length === 1 ? displays[0] : null;
  const row = display?.closest('.edit-row');
  if (!row || !/^(?:Please set category|请选择(?:商品)?类[别目])$/iu.test(clean(display.textContent))) {
    return rejected('类别字段已改变。');
  }
  const matches = [...document.querySelectorAll(selector)];
  const item = matches.length === 1 ? matches[0] : null;
  if (!item || !row.contains(item) || item.closest('.product-category-box') || clean(item.textContent) !== clean(category) ||
      !item.getClientRects().length || getComputedStyle(item).visibility !== 'visible') {
    return rejected('推荐类目的位置或文字已改变。');
  }
  const custom = item.closest('.recommend-category-container .category-select-radio');
  if (custom) {
    const text = custom.querySelector(':scope > .radio-text');
    if (!row.contains(custom) || (custom !== item && !text?.contains(item)) || clean(text?.textContent) !== clean(category) ||
        !custom.querySelector(':scope > .radio-indicator') || custom.closest('[disabled],[aria-disabled=true],[inert]') ||
        !custom.getClientRects().length || getComputedStyle(custom).visibility !== 'visible') {
      return rejected('推荐类目的单选控件不可用。');
    }
    custom.click();
    return { ok: true };
  }
  const label = item.closest('label,[role=radio]');
  if (!label || !row.contains(label) || clean(label.textContent) !== clean(category) ||
      label.closest('[aria-disabled=true],[inert]')) {
    return rejected('推荐类目没有可确认的单选控件。');
  }
  const radio = label.matches('label') ? label.control || label.querySelector('input[type=radio]') : label;
  if (!radio || !row.contains(radio) || !radio.matches('input[type=radio],[role=radio]') || radio.matches(':disabled')) {
    return rejected('推荐类目的单选控件不可用。');
  }
  radio.click();
  return { ok: true };
}

// These specific Shopee controls can be operated in either foreground or background tabs.
export function clickListingControl({ action, selector, category, label, text }, expectedUrl) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const shown = query => [...document.querySelectorAll(query)].filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const denied = () => ({ ok: false, code: 'control-changed', error: 'Shopee 商品表单的目标控件已变化。' });
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' ||
      location.pathname !== '/portal/mtsku/new' || !category || !label ||
      typeof selector !== 'string' || !selector || selector.length > 2048) return denied();
  const categoryField = only(shown('.product-basic-info .product-category-text'));
  if (!categoryField || pathText(categoryField.textContent) !== pathText(category)) return denied();
  if (shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)').length) {
    return { ok: false, code: 'modal', error: '操作前出现了 Shopee 弹窗。' };
  }
  let target;
  try {
    target = only([...document.querySelectorAll(selector)]);
  } catch {
    return denied();
  }
  if (!target || !visible(target) || target.closest('[disabled],[readonly],[aria-disabled=true],.is-disabled,.eds-selector--disabled,.eds-option--disabled')) {
    return denied();
  }

  const attributeLabel = control => {
    const row = control.closest('.product-specification-new .edit-row');
    const node = row?.querySelector(':scope > .edit-label');
    if (!node) return '';
    const ownText = [...node.childNodes].filter(child => child.nodeType === 3).map(child => child.nodeValue).join(' ');
    const title = node.querySelector('.item-title-text,:scope > span');
    return clean(title?.textContent || clean(ownText) || node.textContent).replace(/^[*＊]\s*|\s*\d+\/\d+$/gu, '');
  };
  const trigger = '.product-specification-new .eds-selector';
  const option = '.eds-option,[role=option]';
  const menu = '.eds-select-popover-content:not(.slide-fast-leave-active)';
  switch (action) {
    case 'attribute-trigger': {
      const matches = shown(trigger).filter(control => attributeLabel(control) === label);
      if (only(matches) !== target || clean(target.innerText ?? target.textContent).slice(0, 400) !== text) return denied();
      break;
    }
    case 'attribute-option': {
      const owner = only(shown(trigger).filter(control => control.getAttribute('aria-expanded') === 'true' ||
        control.closest('.eds-select.is-show')));
      const popover = only(shown(menu).filter(node => node.querySelector(option + ',input:not([type=hidden])')));
      if (!owner || attributeLabel(owner) !== label || !target.matches(option) || !popover?.contains(target) ||
          !text || clean(target.textContent) !== text) return denied();
      break;
    }
    case 'variant-enable':
      if (label !== '开启商品规格' || text !== label || clean(target.textContent) !== label ||
          !target.matches('.product-sales-info .variation-add-button button.primary-dash-button[type=button]')) return denied();
      break;
    default:
      return denied();
  }
  target.click();
  return { ok: true };
}

// Write only the one empty name or option input belonging to the current variation axis.
export async function writeListingVariant({ kind, selector, category, name, option, existingOptions }, expectedUrl) {
  const clean = value => String(value ?? '').trim().replace(/\s+/gu, ' ');
  const pathText = value => clean(value).replace(/\s*[＞>›»]\s*/gu, ' > ');
  const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[aria-hidden=true],[inert]');
  const shown = (query, root = document) => [...root.querySelectorAll(query)].filter(visible);
  const only = items => items.length === 1 ? items[0] : null;
  const denied = reason => ({ ok: false, code: 'variant-control-changed', error: (kind === 'name' ? '规格名称' : '规格选项') + '：' + reason });
  const validText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;
  if (location.href !== expectedUrl || location.origin !== 'https://seller.shopee.cn' ||
      location.pathname !== '/portal/mtsku/new' || !['name', 'option'].includes(kind) ||
      typeof selector !== 'string' || !selector || selector.length > 2048 ||
      !validText(category, 220) || !validText(name, 14) ||
      (kind === 'option' && !validText(option, 30)) || !Array.isArray(existingOptions)) return denied('页面地址或输入参数与回放不符。');
  const categoryField = only(shown('.product-basic-info .product-category-text'));
  const sales = only(shown('.product-sales-info'));
  if (!sales) return denied('未找到唯一的销售资料区。');
  if (!categoryField || pathText(categoryField.textContent) !== pathText(category)) return denied('当前商品类目与回放不符。');
  if (shown('.eds-modal__mask,[role=dialog],[aria-modal=true],dialog[open],.eds-popper:has(.pulse-popover-button)').length) {
    return { ok: false, code: 'modal', error: '操作前出现了 Shopee 弹窗。' };
  }
  let target;
  try {
    target = only([...document.querySelectorAll(selector)]);
  } catch {
    return denied('控件定位格式无效。');
  }
  if (!target) return denied('未定位到唯一的输入框。');
  if (!target.matches('input[type=text]') || !visible(target)) return denied('匹配的控件并非可见文本输入框。');
  if (target.matches(':disabled,[readonly]') ||
      target.closest('[aria-disabled=true],.is-disabled,.custom-len-calc-input[disabled=true]')) {
    return denied('匹配的输入框处于禁用或只读状态。');
  }
  const nameField = only(shown('.variation-name-panel input', sales));
  const optionFields = shown('.variation-option-panel .options-item input', sales);
  const currentOptions = optionFields.map(input => clean(input.value)).filter(Boolean);
  if (!nameField) return denied('未找到唯一的规格名称输入框。');
  if (currentOptions.length !== existingOptions.length || currentOptions.some((value, index) => value !== existingOptions[index])) {
    return denied('已有规格选项在读取后发生变化。');
  }
  if (kind === 'name') {
    if (target !== nameField || target.value !== '' || currentOptions.length) return denied('目标并非唯一的空白规格名称输入框。');
  } else {
    const blanks = optionFields.filter(input => input.value === '');
    const next = !currentOptions.length && only(blanks.filter(input => input.closest('.drag-item') &&
      !input.closest('.virtual-options-item'))) || only(blanks.filter(input => input.closest('.virtual-options-item')));
    if (next !== target) return denied('目标并非下一个空白规格选项输入框。');
    if (nameField.value !== name) return denied('当前规格名称与回放不符。');
    if (currentOptions.includes(clean(option))) return denied('相同的规格选项已经存在。');
  }
  target.focus();
  if (!target.isConnected || target.value !== '' || location.href !== expectedUrl) return denied('输入框在聚焦后发生变化。');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setValue.call(target, kind === 'name' ? name : option);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  await Promise.resolve();
  target.blur();
  return { ok: true };
}
