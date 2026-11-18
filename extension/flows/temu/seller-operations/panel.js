import {
  canReadTemuSellerData, inspectTemuEnrollment, readTemuSellerData, temuSellerCsv, trialTemuEnrollment,
} from "./runtime.js";
import { isTemuEnrollmentPage, TEMU_SELLER_OPERATIONS } from "./routes.js";

function element(tag, value = "", className = "") {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function button(value, className = "compact secondary") {
  const node = element("button", value, className);
  node.type = "button";
  return node;
}

function panelMarkup() {
  const css = element("link");
  css.rel = "stylesheet";
  css.href = new URL("./panel.css", import.meta.url).href;
  document.head.append(css);

  const dialog = element("dialog", "", "temu-operations-dialog");
  dialog.id = "temu-operations-dialog";
  dialog.setAttribute("aria-labelledby", "temu-operations-title");

  const heading = element("header", "", "workflow-dialog-header");
  const title = element("h2");
  title.id = "temu-operations-title";
  const headerActions = element("div", "", "workflow-dialog-actions");
  const back = button("工作流");
  const close = button("关闭", "compact ghost");
  headerActions.append(back, close);
  heading.append(title, headerActions);

  const target = element("p", "", "temu-operations-target");
  const links = element("nav", "", "temu-operations-links");
  links.setAttribute("aria-label", "Temu 数据页面");
  const allPages = element("input");
  allPages.type = "checkbox";
  const pagination = element("label", "", "temu-operations-pagination");
  pagination.append(allPages, document.createTextNode("读取当前筛选的多页数据（最多 25 页）"));
  const status = element("p", "", "temu-operations-status");
  status.setAttribute("role", "status");
  const preview = element("div", "", "temu-operations-preview");
  const fields = element("div", "", "temu-operations-fields");
  const next = element("input");
  next.type = "checkbox";
  const step = element("label", "", "temu-operations-pagination");
  step.append(next, document.createTextNode("回读成功后进入下一步"));
  const note = element("p", "试填商品、申报价和库存，停在报名提交前。");

  const actions = element("footer", "", "temu-operations-actions");
  const load = button("读取当前页", "compact");
  const stop = button("停止读取");
  const json = button("下载 JSON");
  const csv = button("下载 CSV");
  const fill = button("试填已选商品", "compact");
  actions.append(load, stop, json, csv, fill);
  dialog.append(heading, target, links, pagination, note, preview, fields, step, status, actions);
  document.body.append(dialog);
  return { dialog, title, back, close, target, links, allPages, pagination, status, preview, fields, step, next, note, load, stop, json, csv, fill };
}

function showReport(report, target) {
  const summary = [
    report.title, report.records.length + " 条记录", report.pages + " 页",
    report.total != null && "总数 " + report.total, report.hasMore && "尚有后续页",
  ].filter(Boolean);
  const fragments = [
    element("strong", summary.join(" · ")),
    ...(report.filters.length ? [element("p", "当前筛选：" + report.filters.join("、"))] : []),
    ...(report.emptyMessage ? [element("p", report.emptyMessage)] : []),
    ...report.warnings.map(warning => element("p", warning)),
  ];
  const rows = report.records.slice(0, 5).map(({ fields }) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value)));
  const content = rows.length ? rows : Object.keys(report.stats).length ? report.stats : report.overview.slice(0, 12);
  if (Array.isArray(content) ? content.length : Object.keys(content).length) {
    const detail = element("details");
    const label = element("summary", rows.length ? "查看前 " + rows.length + " 条记录" : "查看页面指标");
    detail.append(label, element("pre", JSON.stringify(content, null, 2)));
    fragments.push(detail);
  }
  target.replaceChildren(...fragments);
}

function createEnrollmentRow(item) {
  const row = element("fieldset");
  const use = element("input");
  use.type = "checkbox";
  const name = element("label", "", "temu-operations-item-name");
  name.append(use, document.createTextNode(item.label));
  const price = element("input");
  price.type = "number";
  price.min = "0.01";
  price.step = "any";
  price.required = true;
  price.value = item.price || item.priceSuggestion;
  price.setAttribute("aria-label", "活动申报价");
  const inventory = element("input");
  inventory.type = "number";
  inventory.min = "1";
  inventory.step = "1";
  inventory.required = true;
  inventory.value = item.inventory || item.inventorySuggestion;
  inventory.setAttribute("aria-label", "活动库存");
  const values = element("div", "", "temu-operations-item-values");
  const priceLabel = element("label", "活动申报价");
  const inventoryLabel = element("label", "活动库存");
  priceLabel.append(price);
  inventoryLabel.append(inventory);
  values.append(priceLabel, inventoryLabel);
  row.append(name, values);
  return { id: item.id, row, use, price, inventory };
}

export function bindTemuSellerOperationsPanel({ getTargetTab, isAgentBusy, downloadText, onBack } = {}) {
  let panel;
  let mode;
  let active;
  let report;
  let snapshot;
  let editRows = [];
  let inProgress;

  function status(message, failed = false) {
    panel.status.textContent = message || "";
    panel.status.toggleAttribute("data-error", failed);
  }

  function present() {
    const enrollment = mode.kind === "enrollment";
    panel.load.textContent = enrollment ? "读取报名表" : "读取当前页";
    panel.load.disabled = Boolean(inProgress);
    panel.stop.hidden = !inProgress;
    panel.note.hidden = !enrollment;
    panel.pagination.hidden = enrollment;
    panel.allPages.disabled = Boolean(inProgress);
    panel.preview.hidden = enrollment || !report;
    panel.fields.hidden = !enrollment || !editRows.length;
    for (const item of editRows) item.row.disabled = Boolean(inProgress);
    panel.step.hidden = !enrollment || !snapshot?.canNext;
    panel.fill.hidden = !enrollment || !editRows.length;
    panel.fill.disabled = Boolean(inProgress);
    panel.json.hidden = enrollment || !report;
    panel.csv.hidden = enrollment || !report;
    panel.target.textContent = active?.url && (enrollment ? isTemuEnrollmentPage(active.url) : canReadTemuSellerData(active.url, mode.kind))
      ? new URL(active.url).hostname + new URL(active.url).pathname
      : "请打开对应 Temu 页面后读取。";
  }

  function showEnrollment(current) {
    snapshot = current;
    editRows = current.items.map(createEnrollmentRow);
    panel.fields.replaceChildren(...editRows.map(item => item.row));
    panel.next.checked = false;
    status(current.reason || (editRows.length ? "选择要试填的商品，核对活动价和库存。" : "正在等待报名表。"));
  }

  async function run(action) {
    if (inProgress) return;
    if (isAgentBusy?.()) {
      status("当前聊天正在使用网页，请等操作结束后重试。", true);
      return;
    }
    const controller = new AbortController();
    inProgress = controller;
    status("正在读取 Temu 页面…");
    present();
    try {
      await action(controller.signal);
    } catch (error) {
      if (panel.dialog.open) status(controller.signal.aborted ? "已停止。" : error?.message || "Temu 操作失败。", !controller.signal.aborted);
    } finally {
      if (inProgress === controller) inProgress = undefined;
      present();
    }
  }

  function connect() {
    panel = panelMarkup();
    const { dialog, back, close, stop, load, fill, json, csv, allPages, next } = panel;
    close.addEventListener("click", () => dialog.close());
    back.addEventListener("click", () => { dialog.close(); onBack?.(); });
    stop.addEventListener("click", () => inProgress?.abort());
    dialog.addEventListener("close", () => inProgress?.abort());
    load.addEventListener("click", () => void run(async signal => {
      active = await getTargetTab();
      report = undefined;
      snapshot = undefined;
      editRows = [];
      present();
      if (mode.kind === "enrollment") {
        showEnrollment(await inspectTemuEnrollment({ tab: active, signal }));
        return;
      }
      report = await readTemuSellerData({
        tab: active, kind: mode.kind, allPages: allPages.checked, signal,
        onProgress: ({ pages, count }) => status("已读取 " + pages + " 页 · " + count + " 条"),
      });
      showReport(report, panel.preview);
      status(report.records.length || report.overview.length || Object.keys(report.stats).length ? "可下载当前结果。" : "已核对当前页。");
    }));
    fill.addEventListener("click", () => {
      const chosen = editRows.filter(item => item.use.checked);
      if (!chosen.length) {
        status("请先选择要试填的商品。", true);
        return;
      }
      if (chosen.some(({ price, inventory }) => !price.reportValidity() || !inventory.reportValidity())) return;
      const values = chosen.map(item => ({ id: item.id, price: item.price.value, inventory: item.inventory.value }));
      void run(async signal => {
        active = await getTargetTab();
        const receipt = await trialTemuEnrollment({ tab: active, snapshot, values, next: next.checked, signal });
        const completed = receipt.verified.length + " 行已填写并回读。";
        if (receipt.advanced) {
          active = await getTargetTab();
          showEnrollment(await inspectTemuEnrollment({ tab: active, signal }));
          status(completed + " 已进入下一步。 " + panel.status.textContent);
        } else {
          showEnrollment(receipt);
          const failed = receipt.failures.length ? receipt.failures.length + " 行待手工核对。" : "";
          status([completed, failed, receipt.reason || "已停在报名提交前。"].filter(Boolean).join(" "), Boolean(failed));
        }
      });
    });
    json.addEventListener("click", () => {
      if (report) downloadText("temu-" + mode.kind + ".json", JSON.stringify(report, null, 2) + "\n", "application/json");
    });
    csv.addEventListener("click", () => {
      if (report) downloadText("temu-" + mode.kind + ".csv", temuSellerCsv(report), "text/csv");
    });
  }

  return async function openTemuSellerOperations({ mode: id } = {}) {
    if (!Object.hasOwn(TEMU_SELLER_OPERATIONS, id)) return false;
    if (!panel) connect();
    if (panel.dialog.open || inProgress) return true;
    mode = TEMU_SELLER_OPERATIONS[id];
    active = await getTargetTab();
    report = undefined;
    snapshot = undefined;
    editRows = [];
    panel.title.textContent = mode.title;
    panel.allPages.checked = false;
    panel.links.replaceChildren(...(mode.links || [{ label: "打开 Temu 页面", href: mode.href }]).map(link => {
      const target = element("a", link.label);
      target.href = link.href;
      target.target = "_blank";
      target.rel = "noopener";
      return target;
    }));
    status("");
    present();
    panel.dialog.showModal();
    return true;
  };
}
