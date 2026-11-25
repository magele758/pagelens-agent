import { dailyPlan, dailySelectionKey, dailySources } from "../../flows/daily-operations/catalog.js";
import { dailyScheduleKey, dailyStateKey, dayInChina } from "../../flows/daily-operations/history.js";
import { renderDailyChat } from "./cards.js";

export function bindDailyOperations({ getTargetTab, onBack } = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = "daily-dialog";
  dialog.setAttribute("aria-labelledby", "daily-title");
  dialog.innerHTML = `
    <header class="daily-header">
      <button type="button" class="icon-btn" data-do="back" aria-label="返回工作流">‹</button>
      <h2 id="daily-title">每日运营数据</h2>
      <button type="button" class="icon-btn" data-do="close" aria-label="关闭每日运营数据">×</button>
    </header>
    <div class="daily-body">
      <div class="daily-section-heading"><h3 id="daily-scope-title">关注数据</h3><span data-do="count"></span></div>
      <div class="daily-scope" data-do="scope" role="group" aria-labelledby="daily-scope-title"></div>
      <section class="daily-settings" aria-labelledby="daily-order-title">
        <h3 id="daily-order-title">方果订单查询</h3>
        <div class="daily-form-grid">
          <label class="field">开始日期 <input type="date" data-do="start" required></label>
          <label class="field">结束日期 <input type="date" data-do="end" required></label>
        </div>
        <form data-do="search" class="daily-form-action">
          <label class="field">方果订单号 <input type="search" maxlength="120" required placeholder="输入订单号"></label>
          <button type="submit" class="secondary">打开并查询</button>
        </form>
      </section>
      <form data-do="schedule" class="daily-settings">
        <label class="settings-switch daily-switch">
          <span>每日定时采集</span><input type="checkbox" role="switch" name="enabled">
        </label>
        <div class="daily-form-action">
          <label class="field">北京时间 <input type="time" name="time" value="09:00" required></label>
          <button type="submit" class="secondary">保存定时</button>
        </div>
        <p class="daily-hint">Chrome 运行且各平台保持登录时执行，按已选关注项采集。</p>
      </form>
    </div>
    <footer class="daily-footer">
      <span data-do="status" role="status"></span>
      <div><button type="button" class="secondary" data-do="report" hidden>查看报告</button>
      <button type="button" class="primary" data-do="run">开始采集</button></div>
    </footer>`;
  document.body.append(dialog);
  const find = key => dialog.querySelector(`[data-do="${key}"]`);
  const scope = find("scope");
  const schedule = find("schedule");
  const dateInputs = [find("start"), find("end")];
  const platforms = new Map();
  for (const entry of Object.entries(dailySources)) {
    const { platform } = entry[1];
    if (!platforms.has(platform)) platforms.set(platform, []);
    platforms.get(platform).push(entry);
  }
  let selection = dailyPlan();
  let state;
  let requesting = false;
  let writeSelection = Promise.resolve();
  let attached = false;
  let launching = false;
  const article = document.createElement("article");
  article.id = "daily-chat-run";
  article.className = "daily-chat";
  article.setAttribute("aria-label", "每日运营数据报告");

  const showStatus = value => { find("status").textContent = value; };
  const dates = () => ({ startDay: dateInputs[0].value, endDay: dateInputs[1].value });
  const from = async () => (await getTargetTab?.())?.windowId;
  const send = async (type, values) => {
    const receipt = await chrome.runtime.sendMessage({ type, ...values });
    if (!receipt?.ok) throw new Error(receipt?.error || "每日运营数据未返回结果。");
    return receipt.value;
  };
  async function permissions(ids) {
    const origins = [...new Set(ids.map(id => new URL(dailySources[id].url).origin + "/*"))];
    if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) {
      throw new Error("请允许读取选中的站点。");
    }
  }

  function showInChat({ scroll = false } = {}) {
    const feed = document.getElementById("msgs");
    if (!feed) return;
    attached = true;
    if (!article.isConnected) {
      feed.querySelectorAll(":scope > .empty, :scope > .big-actions").forEach(node => node.remove());
      feed.append(article);
    }
    if (scroll) article.scrollIntoView?.({ block: "end" });
  }

  async function run(plan, range, { fromDialog = false } = {}) {
    if (requesting || state?.running) return;
    const ids = Object.keys(plan);
    if (!ids.length || (fromDialog && plan.orders && !dateInputs.every(input => input.reportValidity()))) return;
    requesting = true;
    showStatus("正在准备采集…");
    updateControls();
    try {
      await permissions(ids);
      await writeSelection;
      launching = true;
      if (fromDialog) dialog.close();
      showInChat({ scroll: true });
      article.replaceChildren(Object.assign(document.createElement("p"), { textContent: "正在打开采集页面…" }));
      state = await send("pl.daily.run", { source: "all", selection: plan, ...range, windowId: await from() });
      renderReport();
    } catch (error) {
      if (launching) article.replaceChildren(Object.assign(document.createElement("p"), { textContent: error.message }));
      else showStatus(error.message);
    } finally {
      launching = false;
      requesting = false;
      updateControls();
    }
  }

  async function openSource(id, section, number) {
    const status = dialog.open ? showStatus : text => {
      const node = article.querySelector("[data-daily-action-status]");
      if (node) node.textContent = text;
    };
    try {
      const range = dialog.open ? dates() : state?.dates || dates();
      if (dialog.open && id === "orders" && !dateInputs.every(input => input.reportValidity())) return;
      status("正在打开页面…");
      await permissions([id]);
      await send("pl.daily.open", { source: id, section, number, ...range, windowId: await from() });
      status("已打开源页面。");
    } catch (error) { status(error.message); }
  }

  function renderReport() {
    if (attached && state) renderDailyChat(article, state, {
      onOpen: openSource,
      onRetry: plan => void run(plan, state.dates || dates()),
      onSummarize: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          state = await send("pl.daily.report", { startedAt: state.startedAt });
          renderReport();
        } catch (error) {
          const status = article.querySelector("[data-daily-action-status]");
          if (status) status.textContent = error.message;
          if (button.isConnected) button.disabled = false;
        }
      },
    });
    updateControls();
  }

  function updateControls() {
    const count = Object.values(selection).reduce((sum, rows) => sum + rows.length, 0);
    find("count").textContent = `已选 ${count} 项`;
    find("run").disabled = requesting || Boolean(state?.running) || !count;
    find("run").textContent = state?.running ? "采集中" : "开始采集";
    find("report").hidden = !state;
    find("report").textContent = state?.running ? "查看进度" : "查看报告";
    for (const box of scope.querySelectorAll("input[type=checkbox]")) {
      const { platform, id, section } = box.dataset;
      const modules = id ? [[id, dailySources[id]]] : platforms.get(platform);
      const max = section ? 1 : modules.reduce((sum, [, config]) => sum + config.sections.length, 0);
      const checked = section ? Number(Boolean(selection[id]?.includes(section))) :
        modules.reduce((sum, [key]) => sum + (selection[key]?.length || 0), 0);
      box.checked = checked === max;
      box.indeterminate = checked > 0 && checked < max;
      if (!section) box.closest("label").querySelector("small").textContent = `${checked}/${max}`;
    }
  }

  function checkbox(text, data, counter = false) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    Object.assign(input.dataset, data);
    label.append(input, Object.assign(document.createElement("span"), { textContent: text }));
    if (counter) label.append(document.createElement("small"));
    return label;
  }

  for (const [platform, modules] of platforms) {
    const group = document.createElement("section");
    group.className = "daily-platform";
    const heading = checkbox(platform, { platform }, true);
    heading.className = "daily-platform-title";
    group.append(heading);
    for (const [id, config] of modules) {
      const row = document.createElement("div");
      row.className = "daily-module";
      const bar = document.createElement("div");
      bar.className = "daily-module-row";
      bar.append(checkbox(config.module, { id }, true));
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "icon-btn daily-expand";
      toggle.setAttribute("aria-label", `${config.name}的状态选项`);
      toggle.setAttribute("aria-expanded", "false");
      const list = document.createElement("div");
      list.className = "daily-leaves";
      list.id = `daily-select-${id}`;
      list.hidden = true;
      toggle.setAttribute("aria-controls", list.id);
      toggle.textContent = "›";
      toggle.onclick = () => {
        list.hidden = !list.hidden;
        toggle.setAttribute("aria-expanded", String(!list.hidden));
      };
      bar.append(toggle);
      list.append(...config.sections.map(section => checkbox(section, { id, section })));
      row.append(bar, list);
      group.append(row);
    }
    scope.append(group);
  }

  scope.addEventListener("change", event => {
    const box = event.target.closest("input[type=checkbox]");
    if (!box) return;
    const { id, platform, section } = box.dataset;
    const next = { ...selection };
    if (section) {
      const set = new Set(next[id]);
      if (box.checked) set.add(section);
      else set.delete(section);
      next[id] = [...set];
    } else {
      for (const [key, config] of id ? [[id, dailySources[id]]] : platforms.get(platform)) {
        next[key] = box.checked ? config.sections : [];
      }
    }
    const saved = selection = dailyPlan(next);
    writeSelection = writeSelection.catch(() => {}).then(() => chrome.storage.local.set({ [dailySelectionKey]: saved }));
    void writeSelection.catch(() => showStatus("未能保存关注项。"));
    updateControls();
  });

  find("close").onclick = () => dialog.close();
  find("back").onclick = () => { dialog.close(); onBack?.(); };
  find("run").onclick = () => void run(selection, dates(), { fromDialog: true });
  find("report").onclick = () => {
    dialog.close();
    showInChat({ scroll: true });
    renderReport();
  };
  find("search").addEventListener("submit", event => {
    event.preventDefault();
    const input = event.currentTarget.querySelector("input");
    void openSource("orders", "全部", input.value.trim());
  });
  schedule.addEventListener("submit", async event => {
    event.preventDefault();
    const { enabled, time } = schedule.elements;
    const save = schedule.querySelector("button");
    save.disabled = true;
    try {
      if (enabled.checked) {
        const ids = Object.keys(selection);
        if (!ids.length) throw new Error("请至少选择一项要定时采集的数据。");
        await permissions(ids);
        await writeSelection;
      }
      await send("pl.daily.schedule", { enabled: enabled.checked, time: time.value });
      showStatus(enabled.checked ? "已保存每日定时采集。" : "已关闭定时采集。");
    } catch (error) { showStatus(error.message); }
    finally { save.disabled = false; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[dailyStateKey]) return;
    state = changes[dailyStateKey].newValue;
    if (state?.plan && (launching || state.windowId == null)) showInChat();
    renderReport();
  });
  void chrome.storage.local.get(dailyStateKey).then(saved => {
    if (state) return;
    state = saved[dailyStateKey];
    if (state?.plan) {
      showInChat();
      renderReport();
    }
  }).catch(() => {});

  return async source => {
    const today = dayInChina();
    dateInputs[0].value ||= today.slice(0, 7) + "-01";
    dateInputs[1].value ||= today;
    await writeSelection.catch(() => {});
    const saved = await chrome.storage.local.get([dailyStateKey, dailyScheduleKey, dailySelectionKey]);
    state = saved[dailyStateKey];
    selection = dailyPlan(saved[dailySelectionKey]);
    schedule.elements.enabled.checked = Boolean(saved[dailyScheduleKey]?.enabled);
    schedule.elements.time.value = saved[dailyScheduleKey]?.time || "09:00";
    showStatus("");
    updateControls();
    if (!dialog.open) dialog.showModal();
    if (source && Object.hasOwn(dailySources, source)) scope.querySelector(`[data-id="${source}"]`)?.focus();
    return true;
  };
}
