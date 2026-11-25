function element(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}

export function sectionCard(section, { onOpen } = {}) {
  const body = element("details", undefined, "daily-section");
  const caption = element("summary");
  const totals = section.complete ? String(section.records.length) : `${section.records.length} 条已读 · 未核对全量`;
  caption.append(element("strong", section.section), element("span", totals, "daily-total"));
  if (section.added?.length) caption.append(element("span", `新增 ${section.added.length}`, "daily-badge"));
  body.append(caption);
  const panel = element("div", undefined, "daily-section-body");
  if (onOpen) {
    const open = element("button", "打开源页面", "secondary mini");
    open.type = "button";
    open.addEventListener("click", onOpen);
    panel.append(open);
  }
  if (section.trend) {
    const delta = value => value == null ? "暂无基线" : value > 0 ? "+" + value : String(value);
    panel.append(element("p", `较上次 ${delta(section.previousDelta)} · 较昨日 ${delta(section.yesterdayDelta)}`, "daily-hint"));
    const chart = element("div", undefined, "daily-chart");
    chart.setAttribute("aria-label", "最近七天采集结果");
    const peak = Math.max(1, ...section.trend.map(([, count]) => count || 0));
    for (const [day, count] of section.trend) {
      const point = element("div");
      point.title = `${day} · ${count ?? "未采集"}`;
      const track = element("span", undefined, "daily-chart-track");
      const bar = element("span", undefined, "daily-chart-bar");
      bar.style.height = count == null ? "0" : `${Math.max(3, 100 * count / peak)}%`;
      track.setAttribute("aria-hidden", "true");
      track.append(bar);
      point.append(element("b", count ?? "—"), track, element("small", day.slice(5)));
      chart.append(point);
    }
    if (section.trend.filter(([, count]) => count != null).length >= 2) panel.append(chart);
  }
  const added = new Set(section.added);
  const changed = new Set(section.changed);
  const list = element("ul", undefined, "daily-records");
  const rows = [...section.records].sort((a, b) => Number(added.has(b.id)) - Number(added.has(a.id)) ||
    Number(changed.has(b.id)) - Number(changed.has(a.id)));
  function renderMore() {
    for (const row of rows.slice(list.children.length, list.children.length + 30)) {
      const card = element("li", undefined, added.has(row.id) ? "daily-new" : undefined);
      if (added.has(row.id) || changed.has(row.id)) card.append(element("strong", added.has(row.id) ? "新增" : "有更新", "daily-badge"));
      const fields = element("dl");
      for (const [label, value] of Object.entries(row.fields)) {
        fields.append(element("dt", label), element("dd", value || "—"));
      }
      card.append(fields);
      list.append(card);
    }
    more.hidden = list.children.length >= rows.length;
  }
  const more = element("button", "显示更多记录", "secondary mini");
  more.type = "button";
  more.addEventListener("click", renderMore);
  body.addEventListener("toggle", () => { if (body.open && !list.childNodes.length) renderMore(); });
  if (!rows.length) panel.append(element("p", section.complete ? "当前没有记录。" : "未核对到记录。", "daily-hint"));
  else panel.append(list, more);
  body.append(panel);
  return body;
}
import { dailySectionName, dailySources } from "../../flows/daily-operations/catalog.js";


function button(label, action, className = "secondary mini") {
  const node = element("button", label, className);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function countText(last) {
  if (last.failed) return "采集失败";
  if (!last.complete) return `读取 ${last.count} 条，仍需核对`;
  if (last.added == null) return `读取 ${last.count} 条`;
  return last.added > 0 ? `发现 ${last.added} 条新增 · 共 ${last.count} 条` : `读取 ${last.count} 条 · 无新增`;
}

export function renderDailyChat(article, state, { onOpen, onRetry, onSummarize }) {
  const header = element("header", undefined, "daily-chat-header");
  header.append(element("h3", "每日运营数据"),
    element("span", state.running ? "进行中" : state.interrupted ? "已中断" : "已完成", "daily-chat-state"));
  const body = element("div", undefined, "daily-chat-body");
  article.replaceChildren(header, body);
  const { done, total, current, last } = state.progress || {};
  if (state.running) {
    const progress = element("progress");
    progress.max = total || 1;
    progress.value = done || 0;
    progress.setAttribute("aria-label", "采集进度");
    body.append(progress);
    const text = state.phase === "report" ? "正在生成 AI 摘要…" :
      current ? `${current.opening ? "正在打开" : "正在查看"} ${dailySectionName(current.id, current.section)}` : "正在准备采集…";
    const status = element("div", undefined, "daily-progress-status");
    status.setAttribute("role", "status");
    status.append(element("span", text), element("small", `${done || 0}/${total || 0} 项`));
    body.append(status);
    if (last) body.append(element("p", `${dailySectionName(last.id, last.section)} · ${countText(last)}`, "daily-hint"));
    return;
  }

  const groups = Object.keys(dailySources).flatMap(id => state.results?.[id] ? [[id, state.results[id]]] : []);
  const metrics = element("div", undefined, "daily-metrics");
  const issues = element("ul", undefined, "daily-issues");
  const detail = element("details", undefined, "daily-report-details");
  detail.append(element("summary", "查看各项数据"));
  const actionStatus = element("p", undefined, "daily-action-status");
  actionStatus.dataset.dailyActionStatus = "";
  actionStatus.setAttribute("role", "status");
  const needsAttention = /待整理|待推送|待处理|待回复|违规|限制记录/u;
  for (const [id, result] of groups) {
    const config = dailySources[id];
    if (!config) continue;
    const slices = result.sections;
    const preview = slices.find(section => section.section === "全部") || (slices.length === 1 ? slices[0] : null);
    if (preview) {
      const metric = element("div", undefined, "daily-metric");
      metric.append(element("small", `${config.name} · ${preview.section}`),
        element("strong", preview.records.length),
        element("span", preview.complete ? preview.added?.length ? `新增 ${preview.added.length}` : "条记录" : "条已读"));
      metrics.append(metric);
    }
    if (slices.length) {
      const group = element("section", undefined, "daily-report-group");
      group.append(element("h4", config.name));
      for (const section of slices) {
        group.append(sectionCard(section, { onOpen: () => onOpen(id, section.section) }));
        if (!section.complete || section.records.length && (needsAttention.test(section.section) || section.added?.length)) {
          const label = section.complete ? needsAttention.test(section.section) ?
            `${section.records.length} 条可查看` : `${section.added.length} 条新增` : "需要核对全量";
          addIssue(section.section, label, !section.complete);
        }
      }
      detail.append(group);
    }
    for (const error of result.errors) addIssue(error.section, error.error, true);

    function addIssue(section, description, retry) {
      const selected = state.plan?.[id] || [];
      const entry = section || selected[0] || slices[0]?.section;
      if (!entry) return;
      const row = element("li");
      const copy = element("div");
      copy.append(element("strong", section ? dailySectionName(id, section) : config.name), element("small", description));
      const actions = element("div", undefined, "daily-issue-actions");
      actions.append(button("前往", () => onOpen(id, entry)));
      if (retry) actions.append(button("重试", () => onRetry({ [id]: section ? [section] : selected })));
      row.append(copy, actions);
      issues.append(row);
    }
  }

  const time = new Date(state.finishedAt || state.startedAt);
  body.append(element("p", time.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }), "daily-hint daily-report-time"));
  if (metrics.childElementCount) body.append(metrics);
  if (state.report?.highlights?.length) {
    const summary = element("section", undefined, "daily-summary");
    summary.append(element("h4", "AI 摘要"));
    for (const line of state.report.highlights) summary.append(element("p", line));
    body.append(summary);
  } else if (state.report || state.interrupted) {
    body.append(element("p", state.report?.note || (state.interrupted ? "本次采集中断，可以开始新的采集。" :
      "可重新生成本次报告的 AI 摘要。"), "daily-hint"));
    if (state.report && groups.some(([, result]) => result.sections.length)) {
      body.append(button("重试 AI 摘要", onSummarize));
    }
  }
  if (issues.childElementCount) body.append(element("h4", "需要关注"), issues);
  if (detail.childElementCount > 1) body.append(detail);
  body.append(actionStatus);
}
