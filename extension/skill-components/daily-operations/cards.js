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
      const bar = element("meter");
      bar.max = peak;
      bar.value = count ?? 0;
      bar.setAttribute("aria-label", point.title);
      if (count == null) bar.hidden = true;
      point.append(element("b", count ?? "—"), bar, element("small", day.slice(5)));
      chart.append(point);
    }
    panel.append(chart);
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
