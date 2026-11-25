import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import './fixtures/web-locks.mjs';
import { browserFixture } from '../../scripts/bombadil/browser-fixture.mjs';

async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail(label);
}

const dom = new JSDOM(await browserFixture('panel'), {
  url: 'https://fixture.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),
  beforeParse(win) {
    Object.assign(win, { TextEncoder, TextDecoder, structuredClone });
    win.HTMLElement.prototype.scrollIntoView = () => {};
    win.navigator.locks = navigator.locks;
  },
});
const win = dom.window;
const { document } = win;
try {
  await until(() => document.getElementById('compose-chip-label')?.textContent === '当前网页：Fixture video', 'panel boot');
  const setTimeout = win.setTimeout.bind(win);
  win.setTimeout = (fn, timeout, ...args) => setTimeout(fn, timeout === 8000 ? 50 : timeout, ...args);

  let stalledReads = 0;
  win.chrome.scripting.executeScript = () => {
    stalledReads++;
    return new Promise(() => {});
  };
  const requests = [];
  win.fetch = async (url, request) => {
    assert.match(url, /^https:\/\/model\.invalid\//);
    requests.push(JSON.parse(request.body));
    const first = requests.length === 1;
    const choice = first ? {
      message: { tool_calls: [{ id: 'list-windows', function: { name: 'list_task_windows', arguments: '{}' } }] },
      finish_reason: 'tool_calls',
    } : { message: { content: 'Panel inbox completed' }, finish_reason: 'stop' };
    return { ok: true, json: async () => ({ choices: [choice] }) };
  };
  const completions = [];
  win.chrome.runtime.sendMessage = async message => {
    if (message.type === 'pl.agentPrompt.done') completions.push(message);
    return { ok: true };
  };
  const accepted = [];
  document.dispatchEvent(new win.CustomEvent('fixture-runtime-message', { detail: {
    message: { type: 'pl.agentPrompt.run', windowId: 1, id: 'panel-inbox-fixture', prompt: 'Check inbox with a stalled page.' },
    respond: response => accepted.push(response.ok),
  } }));
  assert.deepEqual(accepted, [true], 'inbox ack is synchronous');
  await until(() => stalledReads > 0, 'panel attempts to refresh the active page');
  assert.match(document.getElementById('msgs').textContent, /Check inbox with a stalled page\./,
    'inbox prompt is visible while the page is stalled');
  await until(() => completions.length > 0, 'panel returns a completion receipt while the page is stalled');
  assert.equal(stalledReads, 1, 'inbox refreshes the page once');
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some(message => message.role === 'tool' &&
    message.content.includes('\"current\":1')), 'model receives the window list');
  assert.equal(completions[0].id, 'panel-inbox-fixture');
  assert.equal(completions[0].ok, true, JSON.stringify(completions[0]));
  assert.equal(completions[0].summary, 'Panel inbox completed');
  assert.deepEqual(Array.from(completions[0].steps, step => [step.name, step.ok]), [['list_task_windows', true]]);
} finally {
  win.close();
}
console.log('PASS side panel inbox completes when the active page does not respond');
