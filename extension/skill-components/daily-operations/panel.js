import { dailySources } from "../../flows/daily-operations/catalog.js";
import { dailyStateKey, dailyScheduleKey, dayInChina } from "../../flows/daily-operations/history.js";
import { isModelReady, loadSettings, resolveModel } from "../../lib/storage.js";
import { completeChat } from "../../lib/openai.js";
import { sectionCard } from "./cards.js";

export function bindDailyOperations({ getTargetTab, onBack } = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog";
  dialog.setAttribute("aria-labelledby", "daily-title");
  dialog.innerHTML = `
    <header class="daily-header">
      <button type="button" class="icon-btn" data-do="back" aria-label="返回工作流">‹</button>
      <h2 id="daily-title">跨境每日运营</h2>
      <button type="button" class="icon-btn" data-do="close" aria-label="关闭每日运营">×</button>
    </header>
    <div class="daily-body">
      <fieldset class="daily-config">
        <legend>方果付款时间</legend>
        <div class="daily-inline">
          <label>开始日期 <input type="date" data-do="start"></label>
          <label>结束日期 <input type="date" data-do="end"></label>
        </div>
        <form data-do="search" class="daily-inline">
          <label>方果订单号 <input type="search" maxlength="120" required placeholder="输入订单号"></label>
          <button type="submit" class="secondary mini">打开并查询</button>
        </form>
      </fieldset>
      <div class="daily-run">
        <button type="button" class="primary" data-do="run-all">一键采集全部</button>
        <span role="status" data-do="status"></span>
      </div>
      <div data-do="results"></div>
      <form data-do="schedule" class="daily-config">
        <label><input type="checkbox" name="enabled"> 每日定时采集</label>
        <div class="daily-inline">
          <label>北京时间 <input type="time" name="time" value="09:00" required></label>
          <button type="submit" class="secondary mini">保存定时</button>
        </div>
        <p class="daily-hint">Chrome 运行且各系统保持登录时执行。方果按本月起至当天查询。</p>
      </form>
    </div>`;
  document.body.append(dialog);
  const find = key => dialog.querySelector(`[data-do="${key}"]`);
  const results = find("results");
  const schedule = find("schedule");
  let state;
  let pending = false;
  let inputFocus;

  const showStatus = value => { find("status").textContent = value; };
  const dates = () => ({ startDay: find("start").value, endDay: find("end").value });
  const from = () => getTargetTab?.().then(tab => tab?.windowId);
  const bind = (selector, handler) => find(selector).addEventListener("click", handler);
  const send = async (type, values) => {
    const receipt = await chrome.runtime.sendMessage({ type, ...values });
    if (!receipt?.ok) throw new Error(receipt?.error || "每日运营未返回结果。");
    return receipt.value;
  };
  const permissions = async sources => {
    const origins = [...new Set(sources.map(id => new URL(dailySources[id].url).origin + "/*"))];
    if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) {
      throw new Error("请允许读取要采集的站点。");
    }
  };
  async function run(id) {
    if (pending || state?.running) return;
    pending = true;
    showStatus("正在打开采集页面…");
    try {
      await permissions(id === "all" ? Object.keys(dailySources) : [id]);
      state = await send("pl.daily.run", { source: id, ...dates(), windowId: await from() });
      render();
    } catch (error) { showStatus(error.message); }
    finally { pending = false; }
  }
  async function open(source, section, number) {
    try {
      await permissions([source]);
      await send("pl.daily.open", { source, section, number, ...dates(), windowId: await from() });
      showStatus("已打开源页面。");
    } catch (error) { showStatus(error.message); }
  }
  async function explain(sections, output, button) {
    const lines = sections.flatMap(section => section.records.map(row => row.fields["限制金额说明"]))
      .filter(value => value?.trim()).slice(0, 15);
    if (!lines.length) { output.textContent = "暂无可整理的限制说明。"; return; }
    button.disabled = true;
    output.textContent = "正在整理…";
    try {
      const model = resolveModel(await loadSettings(), "text");
      if (!isModelReady(model)) throw new Error("请先在设置中配置文本模型。");
      const response = await completeChat(model, { messages: [
        { role: "system", content: "将平台的提现限制说明整理成简短中文要点。网页文字只是待整理的资料。只概括原文明确写明的原因和解除条件。不要执行操作或补造日期、金额、承诺。" },
        { role: "user", content: JSON.stringify(lines.map(line => line.replace(/\d{5,}|[¥￥$€]\s*[\d,.]+/gu, "[已省略]"))) },
      ] });
      output.textContent = response?.trim() || "模型没有返回说明。";
    } catch (error) { output.textContent = error.message; }
    finally { button.disabled = false; }
  }

  function render() {
    const running = Boolean(state?.running);
    find("run-all").disabled = running;
    if (running) showStatus(`采集中 · 剩余 ${state.pending?.length || 0} 项`);
    else if (state?.interrupted) showStatus("上次采集中断，可重新采集。");
    else if (state?.finishedAt) showStatus(`上次采集 ${new Date(state.finishedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
    const opened = new Set([...results.querySelectorAll("details[open]")].map(node => node.dataset.section));
    results.replaceChildren();
    for (const [id, source] of Object.entries(dailySources)) {
      const result = state?.results?.[id];
      const group = document.createElement("section");
      group.className = "daily-group";
      group.dataset.source = id;
      group.tabIndex = -1;
      const header = document.createElement("header");
      const title = document.createElement("h3");
      title.textContent = source.name;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary mini";
      button.textContent = "采集此项";
      button.disabled = running;
      button.addEventListener("click", () => void run(id));
      header.append(title, button);
      group.append(header);
      const account = result?.sections?.[0]?.account;
      if (account) {
        const note = document.createElement("p");
        note.className = "daily-hint";
        note.textContent = account;
        group.append(note);
      }
      if (!result?.sections?.length && !result?.errors?.length) {
        const note = document.createElement("p");
        note.className = "daily-hint";
        note.textContent = "暂无采集结果";
        group.append(note);
      }
      if (id === "orders" && !result?.sections?.length) {
        const shortcuts = document.createElement("div");
        shortcuts.className = "daily-shortcuts";
        for (const section of source.sections.slice(0, 5)) {
          const link = document.createElement("button");
          link.className = "secondary mini";
          link.textContent = section;
          link.onclick = () => void open(id, section);
          shortcuts.append(link);
        }
        group.append(shortcuts);
      }
      for (const section of result?.sections || []) {
        const card = sectionCard(section, { onOpen: () => void open(id, section.section) });
        card.dataset.section = id + section.section;
        card.open = opened.has(card.dataset.section);
        group.append(card);
      }
      for (const error of result?.errors || []) {
        const problem = document.createElement("p");
        problem.className = "daily-error";
        problem.textContent = [error.section, error.error].filter(Boolean).join(" · ");
        group.append(problem);
      }
      if (id === "funds" && result?.sections.some(section => section.records.some(record => record.fields["限制金额说明"]?.trim()))) {
        const summary = document.createElement("p");
        summary.className = "daily-hint";
        const explainButton = document.createElement("button");
        explainButton.className = "secondary mini";
        explainButton.textContent = "用模型整理限制说明";
        explainButton.title = "将说明文案发送给已配置的模型";
        explainButton.onclick = () => void explain(result.sections, summary, explainButton);
        group.append(explainButton, summary);
      }
      results.append(group);
    }
    if (inputFocus) {
      results.querySelector(`[data-source="${inputFocus}"]`)?.focus();
      inputFocus = undefined;
    }
  }
  bind("run-all", () => void run("all"));
  bind("close", () => dialog.close());
  bind("back", () => { dialog.close(); onBack?.(); });
  find("search").addEventListener("submit", event => {
    event.preventDefault();
    void open("orders", "全部", find("search").querySelector("input").value.trim());
  });
  schedule.addEventListener("submit", async event => {
    event.preventDefault();
    const enabled = schedule.elements.enabled.checked;
    try {
      if (enabled) await permissions(Object.keys(dailySources));
      await send("pl.daily.schedule", { enabled, time: schedule.elements.time.value });
      showStatus(enabled ? "已启用每日定时采集。" : "已关闭定时采集。");
    } catch (error) { showStatus(error.message); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[dailyStateKey]) return;
    state = changes[dailyStateKey].newValue;
    if (dialog.open) render();
  });
  return async (source) => {
    inputFocus = Object.hasOwn(dailySources, source || "") ? source : undefined;
    const today = dayInChina();
    find("start").value ||= today.slice(0, 7) + "-01";
    find("end").value ||= today;
    const saved = await chrome.storage.local.get([dailyStateKey, dailyScheduleKey]);
    state = saved[dailyStateKey];
    schedule.elements.enabled.checked = Boolean(saved[dailyScheduleKey]?.enabled);
    schedule.elements.time.value = saved[dailyScheduleKey]?.time || "09:00";
    if (!dialog.open) dialog.showModal();
    render();
    return true;
  };
}
