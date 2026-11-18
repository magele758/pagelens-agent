import { shortcutsForPage } from "../flows/workflow-context.js";
import { $ } from "./dom.js";
import { launchWorkflowFeature } from "./workflow-catalog.js";

export function renderWorkflowShortcuts(tab) {
  const root = $("workflow-shortcuts");
  if (!root) return;
  const { platform, page, features } = shortcutsForPage(tab?.url);
  const visible = features.length > 0;
  const key = visible ? `${tab.id}:${page.platform}:${page.productId || page.surface}` : "";
  if (root.dataset.target === key) return;
  root.dataset.target = key;
  root.hidden = !visible;
  $("workflow-shortcut-status").textContent = "";
  const items = $("workflow-shortcut-items");
  items.replaceChildren();
  if (!visible) return;
  const name = $("workflow-shortcut-site");
  name.textContent = platform.name;
  name.title = page.surface === "seller" ? `${platform.name} 商家后台` : `${platform.name} 商品详情`;
  for (const feature of features) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.workflow = feature.id;
    button.textContent = feature.name;
    items.append(button);
  }
}

export function bindWorkflowShortcuts({ getTargetTab, handlers }) {
  const root = $("workflow-shortcuts");
  const status = $("workflow-shortcut-status");
  let busy = false;
  root?.addEventListener("click", async event => {
    const button = event.target.closest("button[data-workflow]");
    if (!button || busy) return;
    busy = true;
    status.textContent = "";
    const target = root.dataset.target;
    try {
      const tab = await getTargetTab();
      renderWorkflowShortcuts(tab);
      const { platform, features } = shortcutsForPage(tab?.url);
      const feature = features.find(item => item.id === button.dataset.workflow);
      if (root.dataset.target !== target || !feature) throw new Error("当前页面已切换，请从新的快捷入口打开。");
      await launchWorkflowFeature(feature, platform.id, handlers);
    } catch (error) {
      if (root.dataset.target === target) status.textContent = error?.message || "暂时无法打开此工作流。";
    } finally {
      busy = false;
    }
  });
}
