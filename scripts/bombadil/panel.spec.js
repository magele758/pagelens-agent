import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction } from '@antithesishq/bombadil/browser';
import { choose, enter } from './dom-actions.js';
import { readPanel } from './panel-state.js';
export { noUncaughtExceptions } from '@antithesishq/bombadil/browser/defaults/properties';

const panel = extract(readPanel);
const settingsLayout = extract(({ document }) => {
  const get = id => document.getElementById(id);
  const rect = id => get(id).getBoundingClientRect();
  const active = !get('view-settings').classList.contains('hidden');
  if (!active) return { basic: false, native: false };
  const basic = !get('settings-basic').hidden;
  if (basic) {
    const model = rect('settings-text-model');
    const card = rect('block-text');
    return {
      basic,
      modelLayout: model.width >= card.width * 0.6 &&
        model.bottom <= rect('settings-provider-manager').top + 1,
      appearanceLayout: [rect('answer-lang'), rect('ui-font')].every(
        control => control.width >= 90 && control.bottom <= get('block-answer').querySelector('.theme-picker').getBoundingClientRect().top + 1),
    };
  }
  const native = get('settings-group-native').open;
  if (!native) return { basic, native };
  const inputs = [...get('irreversible-list').querySelectorAll('input[type=checkbox]')];
  return {
    basic, native,
    consentLayout: inputs.length > 0 && inputs.every(input => {
      const checkbox = input.getBoundingClientRect();
      const label = input.labels[0];
      const text = document.createRange();
      text.setStartAfter(input);
      text.setEndAfter(label.lastChild);
      const firstLine = [...text.getClientRects()].find(part => part.width >= 1);
      const gap = firstLine && firstLine.left - checkbox.right;
      return checkbox.width >= 12 && checkbox.width <= 24 &&
        checkbox.height >= 12 && checkbox.height <= 24 && gap >= 3 && gap <= 18;
    }),
  };
});
const switchTab = registerCustomAction('switchFixtureTab', async (document, window, id) => {
  document.dispatchEvent(new window.CustomEvent('fixture-activate-tab', { detail: id }));
});
export const oneActiveView = always(() => !panel.current.ready || panel.current.viewAgrees);
export const branchBelongsToSession = always(() => panel.current.threadAgrees);
export const branchDraftIsIsolated = always(() => panel.current.draftIsLocal);
export const drawerMatchesHeader = always(() => !panel.current.ready || panel.current.paneAgrees);
export const mediaControlsMatchPanels = always(() => !panel.current.ready || panel.current.mediaAgrees);
export const historyMatchesSearchAndDisclosure = always(() => panel.current.historyMatches);
export const basicSettingsControlsHaveRoom = always(() => !settingsLayout.current.basic ||
  (settingsLayout.current.modelLayout && settingsLayout.current.appearanceLayout));
export const consentCheckboxesStayByTheirLabels = always(() => !settingsLayout.current.native ||
  settingsLayout.current.consentLayout);

const visited = extract(({ document }) => (document.documentElement.dataset.bombadilVisits || '').split(' '));
const controls = extract(({ document }) => {
  const selectors = ['#btn-history', '#btn-hist-back', '.hist-main', '.lab-toggle', '#btn-review', '#btn-review-back',
    '#btn-settings', '#btn-back', '#btn-sidechat-header', '#btn-sc-list', '#btn-sc-close', '#btn-sc-resolve',
    '#btn-clear-ref'];
  return selectors.flatMap(selector => [...document.querySelectorAll(selector)].flatMap((el, index) =>
    !el.disabled && el.getClientRects().length && !el.closest('.hidden,[hidden]') ? [{ selector, index, text: selector === '.hist-main' ? el.textContent : '' }] : []));
});

export const navigatePanel = actions(() => {
  const current = panel.current;
  if (!current.ready) return ['Wait'];
  const options = controls.current.map(({ selector, index }) => choose(selector, index));
  const seen = visited.current;
  const nextOwner = !seen.includes('alpha-draft') ? 'Alpha' : !seen.includes('beta-draft') ? 'Beta' : 'Alpha';
  if (!seen.includes('alpha-restored')) {
    if (current.view === 'history') {
      const row = controls.current.find(c => c.selector === '.hist-main' && c.text.includes('Question ' + nextOwner));
      if (row) return [choose(row.selector, row.index)];
    } else if (current.owner !== nextOwner) return [choose('#btn-history', 0)];
    else if (!current.open) return [choose('#btn-sidechat-header', 0)];
    else if (!current.thread) return [choose('#btn-sc-list', 0)];
    else if (nextOwner === 'Beta' || !seen.includes('alpha-draft')) return [enter('sc-input', 'draft-' + nextOwner)];
    else return ['Wait']; // Restoration must come from the application.
  }
  if (!seen.includes('context-off') && controls.current.some(c => c.selector === '#btn-clear-ref')) {
    return [choose('#btn-clear-ref', 0)];
  }
  if (seen.includes('context-off') && !seen.includes('article-context')) return [switchTab(18)];
  if (!seen.includes('settings-consent')) {
    if (current.view !== 'settings') return [choose('#btn-settings', 0)];
    if (settingsLayout.current.basic) return [choose('#settings-tab-advanced', 0)];
    if (!settingsLayout.current.native) return [choose('#settings-group-native > summary', 0)];
    return ['Wait'];
  }
  options.push(switchTab(17), switchTab(18));
  if (current.thread) options.push(enter('sc-input', 'draft-' + current.owner));
  if (current.view === 'history') {
    for (const query of ['', 'Alpha', 'Beta', 'no-match']) options.push(enter('hist-q', query));
  }
  return options;
});
