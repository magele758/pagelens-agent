import { workflowPlatforms } from "../flows/catalog.js";
import { $ } from "./dom.js";

export function bindWorkflowCatalog({ openProductListing, openMarketing, openTiktokDraft }) {
  const entry = $("btn-ptc-flow");
  const dialog = $("workflow-catalog-dialog");
  const platform = $("workflow-platform");
  const list = $("workflow-feature-list");
  const empty = $("workflow-feature-empty");
  const close = $("workflow-catalog-close");
  const status = $("workflow-catalog-status");
  let opening = false;

  function open() {
    if (dialog.open) return;
    status.textContent = "";
    dialog.showModal();
  }

  async function choose(feature) {
    if (opening) return;
    opening = true;
    dialog.close();
    try {
      const launch = {
        "product-listing": openProductListing,
        "tiktok-mx-draft": openTiktokDraft,
      };
      const opened = Object.hasOwn(launch, feature.id)
        ? await launch[feature.id]?.(feature)
        : await openMarketing({ mode: feature.id, force: true });
      if (!opened) throw new Error("暂时无法打开此工作流。");
    } catch (error) {
      open();
      status.textContent = error?.message || "暂时无法打开此工作流。";
    } finally {
      opening = false;
    }
  }

  function renderFeatures() {
    const current = workflowPlatforms.find(item => item.id === platform.value);
    const features = current?.features || [];
    list.replaceChildren(...features.map(feature => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workflow-feature";
      button.dataset.workflow = feature.id;
      const name = document.createElement("strong");
      name.id = `workflow-name-${current.id}-${feature.id}`;
      name.textContent = feature.name;
      const description = document.createElement("span");
      description.id = `${name.id}-description`;
      description.textContent = feature.description;
      button.setAttribute("aria-labelledby", name.id);
      button.setAttribute("aria-describedby", description.id);
      button.append(name, description);
      button.addEventListener("click", () => void choose(feature));
      row.append(button);
      return row;
    }));
    empty.hidden = Boolean(features.length);
    empty.textContent = current ? `${current.name} 暂无可执行的工作流。` : "";
    status.textContent = "";
  }

  for (const item of workflowPlatforms) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.features.length ? item.name : `${item.name}（待接入）`;
    platform.append(option);
  }
  renderFeatures();
  platform.addEventListener("change", renderFeatures);
  entry.addEventListener("click", open);
  close.addEventListener("click", () => dialog.close());
  return open;
}
