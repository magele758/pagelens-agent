import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { instrumentedFixture } from '../../scripts/bombadil/browser-fixture.mjs';
import { requiredVisits } from '../../scripts/bombadil/coverage.js';
import { readGraph } from '../../scripts/bombadil/graph-state.js';
import { readPanel } from '../../scripts/bombadil/panel-state.js';

async function mount(html, width) {
  const errors = [];
  const visits = new Set();
  const virtualConsole = new VirtualConsole().on('jsdomError', e => errors.push(e)).on('error', (...args) => errors.push(args));
  const dom = new JSDOM(html, {
    url: 'https://fixture.invalid/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(w) {
      w.navigator.sendBeacon = path => { visits.add(path.split('/').pop()); return true; };
      Object.assign(w, { innerWidth: width, TextEncoder, TextDecoder, structuredClone });
      w.HTMLElement.prototype.scrollIntoView = () => {};
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
    },
  });
  return { dom, document: dom.window.document, errors, visits };
}

async function until(check, label) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(label);
}

function field(document, id, value) {
  const el = document.getElementById(id);
  el.value = value;
  el.dispatchEvent(new document.defaultView.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}

const panelHtml = await instrumentedFixture('panel');
for (const width of [400, 900]) {
  const { document, dom, errors, visits } = await mount(panelHtml, width);
  const state = () => readPanel({ document });
  const check = (label) => {
    const s = state();
    for (const key of ['ready', 'viewAgrees', 'threadAgrees', 'draftIsLocal', 'paneAgrees', 'mediaAgrees', 'historyMatches']) {
      assert.ok(s[key], label + ' / ' + key + ' ' + JSON.stringify(s));
    }
    assert.deepEqual(errors, []);
    return s;
  };
  const click = id => document.getElementById(id).click();
  async function openSession(name) {
    click('btn-history');
    await until(() => state().view === 'history', 'open history');
    check('history');
    field(document, 'hist-q', 'no-match');
    await until(() => document.querySelector('#hist-list .hist-empty'), 'empty search');
    check('empty history');
    field(document, 'hist-q', name);
    await until(() => document.querySelector('.hist-main')?.textContent.includes('Question ' + name), 'matching history');
    const group = document.querySelector('.lab-toggle');
    group.click();
    assert.ok(document.getElementById(group.getAttribute('aria-controls')).hidden);
    check('collapsed history group');
    group.click();
    document.querySelector('.hist-main').click();
    await until(() => state().owner === name && state().view === 'chat', 'open ' + name);
    if (!state().open) click('btn-sidechat-header');
    check('session ' + name);
  }
  try {
    await until(() => state().ready, 'boot panel');
    check('boot');
    click('btn-settings');
    assert.equal(check('settings').view, 'settings');
    click('settings-tab-advanced');
    document.querySelector('#settings-group-native > summary').click();
    await until(() => visits.has('settings-consent'), 'open native authorization in advanced settings');
    click('btn-back');
    await until(() => state().view === 'chat', 'return from settings');
    const workflow = document.getElementById('workflow-catalog-dialog');
    const workflowAction = name => workflow.querySelector(`[data-workflow="${name}"]`).click();
    click('btn-ptc-flow');
    workflowAction('product-listing');
    const product = document.getElementById('ptc-flow-dialog');
    await until(() => product.open, 'open Shopee product listing');
    // Give the first click's asynchronous dispatch the same task boundary as a subsequent browser click.
    await delay(0);
    assert.equal(document.getElementById('ptc-start').disabled, true, 'fixture is outside Shopee listing');
    click('ptc-mode-directory');
    assert.equal(document.getElementById('ptc-batch-pane').hidden, false);
    click('ptc-back');
    assert.ok(workflow.open);
    workflowAction('campaign-data');
    const marketing = document.getElementById('shopee-marketing-dialog');
    await until(() => marketing.open, 'open Shopee campaign data');
    assert.equal(document.getElementById('shopee-marketing-title').textContent, '活动数据');
    assert.equal(document.getElementById('shopee-marketing-read').disabled, true, 'fixture is outside Shopee');
    click('shopee-marketing-back');
    assert.ok(workflow.open);
    workflow.querySelector('#workflow-platform button[data-platform="tiktok-shop"]').click();
    assert.equal(workflow.querySelector('#workflow-platform [aria-pressed="true"]').dataset.platform, 'tiktok-shop');
    workflowAction('tiktok-mx-draft');
    await until(() => document.getElementById('workflow-catalog-status').textContent.includes('启用 Skill'), 'Skill disabled hint');
    click('workflow-catalog-close');

    click('btn-settings');
    const skills = document.getElementById('skills-enabled');
    skills.checked = true;
    skills.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    click('btn-back');
    await until(() => state().view === 'chat', 'return with Skills enabled');
    field(document, 'input', 'https://shop.example/item');
    const messagesBefore = document.getElementById('msgs').textContent;
    click('btn-ptc-flow');
    assert.equal(workflow.querySelector('#workflow-platform [aria-pressed="true"]').dataset.platform, 'tiktok-shop');
    workflowAction('tiktok-mx-draft');
    await until(() => document.getElementById('input').value.startsWith('使用「TikTok 墨西哥商品草稿」'), 'prefill TikTok Skill');
    assert.equal(document.getElementById('input').value, '使用「TikTok 墨西哥商品草稿」 https://shop.example/item');
    assert.equal(document.getElementById('msgs').textContent, messagesBefore, 'opening a workflow must not submit');
    field(document, 'input', '');
    check('workflow entry and return');
    click('btn-review');
    await until(() => state().view === 'review', 'open review');
    assert.equal(check('review').view, 'review');
    click('btn-review-back');
    if (!state().open) click('btn-sidechat-header');
    if (!state().thread) click('btn-sc-list');
    assert.ok(check('thread opened').thread);
    assert.equal(document.getElementById('sidechat-pane').classList.contains('is-split'), width === 900);
    click('btn-sc-list');
    assert.equal(check('branch list').thread, false);
    click('btn-sc-list');
    click('btn-sc-resolve');
    assert.ok(check('mark resolved').resolved);
    field(document, 'sc-input', 'draft-Alpha');
    await openSession('Beta');
    assert.equal(check('Beta is independent').resolved, false);
    assert.equal(state().draft, '');
    field(document, 'sc-input', 'draft-Beta');
    await openSession('Alpha');
    assert.ok(check('Alpha resolution restored').resolved);
    assert.equal(state().draft, 'draft-Alpha');
    click('btn-clear-ref');
    assert.equal(document.getElementById('compose-chip-label').textContent, '未带网页');
    for (const [id, title] of [[18, 'Fixture article'], [17, 'Fixture video']]) {
      document.dispatchEvent(new dom.window.CustomEvent('fixture-activate-tab', { detail: id }));
      await until(() => document.getElementById('compose-chip-label').textContent === '当前网页：' + title, 'attach ' + title);
      check('tab switch to ' + title);
    }
    const activate = id => document.dispatchEvent(new dom.window.CustomEvent('fixture-activate-tab', { detail: id }));
    const shortcuts = document.getElementById('workflow-shortcuts');
    assert.ok(shortcuts.hidden, 'unrelated site has no marketplace shortcuts');
    activate(19);
    await until(() => !shortcuts.hidden && shortcuts.querySelector('[data-workflow="campaign-data"]'), 'Shopee seller shortcuts');
    assert.ok(shortcuts.querySelector('[data-workflow="product-listing"]'));
    assert.ok(!shortcuts.querySelector('[data-workflow="product-capture"]'));
    shortcuts.querySelector('[data-workflow="campaign-data"]').click();
    await until(() => marketing.open, 'open campaigns without the catalog');
    assert.equal(document.getElementById('shopee-marketing-title').textContent, '活动数据');
    click('shopee-marketing-close');
    activate(20);
    await until(() => !shortcuts.hidden && shortcuts.querySelector('[data-workflow="product-capture"]'), 'Amazon detail shortcut');
    assert.deepEqual([...shortcuts.querySelectorAll('[data-workflow]')].map(button => button.dataset.workflow), ['product-capture']);
    activate(21);
    await until(() => shortcuts.querySelector('[data-workflow="temu-product-listing"]'), 'show Temu seller listing shortcut');
    assert.equal(shortcuts.querySelector('[data-workflow="product-capture"]'), null, 'keep seller and retail entries separate');
    activate(22);
    await until(() => shortcuts.querySelector('[data-workflow="identify-tab"]'), 'show address permission action');
    shortcuts.querySelector('[data-workflow="identify-tab"]').click();
    await until(() => shortcuts.querySelector('[data-workflow="product-capture"]'), 'Temu shortcut after granting tab address access');
    assert.equal(document.getElementById('workflow-shortcut-site').textContent, 'Temu');
    check('marketplace shortcut transitions');
    await until(() => requiredVisits.panel.every(v => visits.has(v)), 'missing panel coverage: ' + [...visits]);
    console.log('Passed sidebar navigation, history, media and branch isolation at width ' + width);
  } finally { dom.window.close(); }
}

const { document, dom, errors, visits } = await mount(await instrumentedFixture('graph'), 900);
try {
  const seen = new Set();
  const check = () => {
    const s = readGraph({ document });
    for (const key of ['ready', 'topicsMatch', 'selectionMatches', 'sourcesMatch']) assert.ok(s[key], JSON.stringify(s));
    seen.add(s.name);
    assert.deepEqual(errors, []);
  };
  await until(() => readGraph({ document }).ready, 'load clippings');
  for (const domain of ['', 'Research', 'Engineering']) {
    field(document, 'domain', domain);
    for (const query of ['', 'queue', 'Notebook', 'no-match', '']) {
      field(document, 'query', query);
      check();
      for (let i = 0; i < document.querySelectorAll('#topics button').length; i++) {
        document.querySelectorAll('#topics button')[i].click();
        check();
      }
    }
  }
  document.querySelector('#edges button').click();
  assert.equal(document.getElementById('domain').value, '');
  check();
  assert.deepEqual([...seen].sort(), ['agent', 'notes', 'queue', '无匹配主题'].sort());
  await until(() => requiredVisits.graph.every(v => visits.has(v)), 'missing graph coverage: ' + [...visits]);
  console.log('Passed graph topic, source, domain, related-topic and empty-state checks.');
} finally { dom.window.close(); }
