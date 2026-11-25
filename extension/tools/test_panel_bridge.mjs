import assert from "node:assert/strict";
import { classifyAgentPrompt, continueAgentPrompt } from "../sidepanel/panel-bridge.js";

const RUNTIME = "runtime-id";
const ping = (windowId) => ({ type: "pl.agentPrompt.ping", windowId });

assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, 9, ping(9)), "handle");
assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, 9, ping(3)), "ignore");
assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, 0, ping(0)), "handle");
assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, 0, ping(1)), "ignore");
assert.equal(classifyAgentPrompt("other-extension", RUNTIME, null, ping(9)), "ignore");
assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, 9, { type: "pl.other", windowId: 9 }), "ignore");
assert.equal(classifyAgentPrompt(RUNTIME, RUNTIME, null, ping(4)), "resolve");

async function settle(msg, resolveWindowId) {
  const state = { windowId: null };
  const matched = [];
  const responses = [];
  let responded = false;
  await continueAgentPrompt(msg, {
    resolveWindowId,
    sendResponse(value) {
      responded = true;
      responses.push(value);
    },
    onMatch(windowId) {
      matched.push(windowId);
    },
  });
  return { state, matched, responses, responded };
}

{
  const state = { windowId: null };
  const calls = [];
  const matched = [];
  const responses = [];
  await continueAgentPrompt({ type: "pl.agentPrompt.ping", windowId: 9 }, {
    resolveWindowId(...args) {
      calls.push(args);
      return 9;
    },
    sendResponse(value) {
      responses.push(value);
    },
    onMatch(windowId) {
      matched.push(windowId);
    },
  });
  assert.deepEqual(calls, [[]], "resolveWindowId is called with no arguments");
  assert.deepEqual(matched, [9]);
  assert.deepEqual(responses, []);
  assert.equal(state.windowId, null);
}

{
  const { matched, responses, responded } = await settle(ping(9), () => 3);
  assert.equal(responded, true);
  assert.deepEqual(responses, [undefined]);
  assert.deepEqual(matched, []);
}

{
  const { matched, responses, responded } = await settle(ping(9), () => {
    throw new Error("无法确定 PageLens 所属窗口，请重新打开侧栏。");
  });
  assert.equal(responded, true);
  assert.deepEqual(responses, [undefined]);
  assert.deepEqual(matched, []);
}

console.log("test_panel_bridge: ok");
