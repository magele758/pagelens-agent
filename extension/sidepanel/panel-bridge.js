// Routing for the side panel agent-prompt bridge. Node tests import this file, so it must not touch chrome or document.

const AGENT_PROMPT_TYPES = new Set([
  "pl.agentPrompt.ping",
  "pl.agentPrompt.run",
  "pl.agentPrompt.cancel",
]);

function knownWindowId(windowId) {
  return Number.isInteger(windowId) && windowId >= 0;
}

export function classifyAgentPrompt(senderId, runtimeId, windowId, msg) {
  if (senderId !== runtimeId) return "ignore";
  if (!AGENT_PROMPT_TYPES.has(msg?.type)) return "ignore";
  if (!knownWindowId(windowId)) return "resolve";
  return msg?.windowId === windowId ? "handle" : "ignore";
}

export async function continueAgentPrompt(msg, { resolveWindowId, sendResponse, onMatch }) {
  let windowId;
  try {
    windowId = await resolveWindowId();
  } catch {
    sendResponse(undefined);
    return;
  }
  if (windowId !== msg?.windowId) {
    sendResponse(undefined);
    return;
  }
  onMatch(windowId);
}
