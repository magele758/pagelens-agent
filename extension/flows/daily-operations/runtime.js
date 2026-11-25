import { dailyPlan, dailySelectionKey, dailySourceForUrl, dailySources, savedDailyPlan } from "./catalog.js";
import { getCdp } from "../../lib/cdp.js";
import { readDailyPage } from "./page.js";
import { addSnapshot, compareSnapshot, dailyHistoryKey, dailyScheduleKey, dailyStateKey, dayInChina } from "./history.js";
import { summarizeDailyRun } from "./report.js";

const alarmName = "pagelens.dailyOperations";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const validDay = value => typeof value === "string" && /^\d{4}-\d\d-\d\d$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value);

function orderFilters(startDay, endDay, number) {
  if (!validDay(startDay) || !validDay(endDay) || startDay > endDay) throw new Error("请选择有效的付款时间范围。");
  if (number && !/^[\w ,.-]{1,120}$/u.test(number)) throw new Error("请输入订单号，多个订单号可用逗号或空格分隔。");
  return { start: startDay + " 00:00:00", end: endDay + " 23:59:59", orderNumber: number };
}

async function openCollector(id, windowId, visible) {
  const config = dailySources[id];
  const permission = new URL(config.url).origin + "/*";
  if (!await chrome.permissions.contains({ origins: [permission] })) throw new Error("请在每日运营面板允许读取对应站点。");
  const { id: tabId } = await chrome.tabs.create({ url: config.url, active: visible,
    ...(Number.isInteger(windowId) && { windowId }) });
  let documentId;
  async function invoke(action, section, filters = {}) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.pendingUrl || tab.status !== "complete") return { ok: false, code: "loading", error: "正在打开列表。" };
    if (dailySourceForUrl(tab.url) !== id) throw new Error("页面跳转到了其他地址，请检查登录状态。");
    const [reply] = await chrome.scripting.executeScript({
      target: documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] },
      func: readDailyPage,
      args: [{ source: id, targetUrl: config.url, sections: config.sections, translations: config.translations,
        header: config.header, allowedFields: config.fields?.source, mode: config.mode, action, section, ...filters }],
    });
    if (reply?.frameId !== 0 || !reply.documentId || documentId && reply.documentId !== documentId) {
      throw new Error("采集标签的页面已切换。");
    }
    documentId = reply.documentId;
    return reply.result;
  }
  async function ready(action, section, filters, accept = () => true) {
    const deadline = Date.now() + 12000;
    let last;
    let closes = 0;
    let polished = false;
    while (Date.now() < deadline) {
      last = await invoke(action, section, filters);
      if (last?.ok && accept(last)) return last;
      if (last?.code === "dialog-open" && closes++ < 4) {
        const closed = await invoke("dismiss", section, filters);
        if (!closed?.ok) throw new Error(closed?.error || "未能验证弹窗关闭。");
        await pause(300);
        continue;
      }
      if (last?.code === "chat-collapsed" && !polished) {
        polished = true;
        await invoke("section", section);
      } else if (!last?.ok && !["loading", "chat-collapsed"].includes(last?.code)) {
        throw new Error(last?.error || "未能读取页面。");
      }
      await pause(240);
    }
    throw new Error(last?.ok ? "分页切换后结果未更新。" : last?.error || "读取列表超时。");
  }
  async function typeFilter(section, filters, field) {
    const cdp = getCdp();
    const target = { ...filters, field };
    if ((await ready("focus-filter", section, target)).unchanged) return;
    await cdp.ensure(tabId);
    const focus = await ready("focus-filter", section, target);
    if (focus.unchanged) return;
    await cdp.send(tabId, "Input.insertText", { text: focus.value });
    const key = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 };
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
    await cdp.send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  return { tabId, ready, typeFilter };
}

async function applyOrderFilters(collector, section, filters) {
  try {
    for (const field of ["start", "end", "orderNumber"]) {
      if (filters[field]) await collector.typeFilter(section, filters, field);
    }
    await pause(360);
    await collector.ready("search", section, filters);
  } finally { await getCdp().detach(collector.tabId); }
  await pause(850);
}

async function collectSection(id, collector, section, filters) {
  await collector.ready("section", section, filters);
  await pause(id === "orders" ? 1250 : 850);
  const first = await collectRows(id, collector, section, filters);
  if (id !== "orders" || first.complete || !(first.total > first.records.length)) return first;
  // Fangguo can reuse a row with stale content. Read the list in the opposite direction
  // and reconcile distinct order numbers against the same reported count.
  const sort = await collector.ready("order-sort", section, filters);
  if (!sort.previousSort) return first;
  try {
    await pause(1450);
    const second = await collectRows(id, collector, section, filters);
    if (second.account !== first.account || second.total !== first.total) return first;
    const records = [...new Map([...first.records, ...second.records].map(row => [row.id, row])).values()];
    return { ...second, records, complete: records.length === second.total };
  } catch {
    return first;
  } finally {
    await collector.ready("order-sort", section, { ...filters, field: sort.previousSort }).catch(() => {});
  }
}

async function collectRows(id, collector, section, filters) {
  const read = (accept = () => true) => {
    let previous;
    return collector.ready("read", section, filters, state => {
      if (!accept(state)) return false;
      if (id !== "orders") return true;
      const current = JSON.stringify([state.total, state.page, state.more, state.records.map(row => row.id).sort()]);
      const stable = previous === current;
      previous = current;
      return stable;
    });
  };
  let result = await read();
  if (id === "orders" && result.more) {
    await collector.ready("expand-order-list", section, filters);
    await pause(500);
    result = await read();
  }
  const account = result.account;
  const rows = new Map();
  let invalidRows = false;
  for (let step = 0; step < 500; step++) {
    if (result.account !== account) throw new Error("商家账号在采集中发生变化。");
    for (const row of result.records) rows.set(row.id, row);
    invalidRows ||= Boolean(result.invalidRows);
    if (id === "orders" && result.more) {
      const oldRows = result.records.map(row => row.id).join("|");
      await collector.ready("scroll", section, filters);
      await pause(250);
      result = await read(state =>
        state.records.map(row => row.id).join("|") !== oldRows ||
        (!state.more && state.total === rows.size));
    } else if (result.next) {
      const oldPage = result.page;
      const first = result.records[0]?.id;
      await collector.ready("next", section, filters);
      await pause(750);
      result = await read(state =>
        state.page > oldPage || state.records[0]?.id && state.records[0].id !== first);
    } else {
      const complete = !invalidRows && !result.more && (result.total == null || result.total === rows.size);
      return { account, records: [...rows.values()], total: result.total, complete,
        ...(result.meta && { meta: result.meta }) };
    }
  }
  return { account, records: [...rows.values()], total: result.total, complete: false };
}

export async function openDailyShortcut({ source, section, startDay, endDay, number, recordId, windowId }) {
  const config = dailySources[source];
  if (!config?.sections.includes(section)) throw new Error("未知的数据入口。");
  const filters = source === "orders" ? orderFilters(startDay, endDay, number) : {};
  let saved;
  if (recordId !== undefined) {
    if (config.mode !== "campaigns" || typeof recordId !== "string") throw new Error("无效的活动入口。");
    const stored = await chrome.storage.local.get(dailyStateKey);
    saved = stored[dailyStateKey]?.results?.[source]?.sections.find(item => item.section === section);
    if (!saved?.records.some(row => row.id === recordId && row.action)) throw new Error("活动已刷新，请选择最新的记录。");
  }
  const collector = await openCollector(source, windowId, true);
  if (source === "orders") await applyOrderFilters(collector, section, filters);
  await collector.ready("section", section, filters);
  await pause(850);
  await collector.ready("read", section, filters);
  if (saved) await collector.ready("campaign-open", section, { recordId, expectedAccount: saved.account });
}

let running;
function collectDaily(request) {
  if (running) throw new Error("已经有一个每日运营流程在运行。");
  running = executeDaily(request).finally(() => { running = undefined; });
  return running;
}

async function retryDailyReport(startedAt) {
  const stored = await chrome.storage.local.get(dailyStateKey);
  const state = stored[dailyStateKey];
  if (!state?.plan || state.startedAt !== startedAt || state.running) throw new Error("请刷新并打开最新报告。");
  const save = () => chrome.storage.local.set({ [dailyStateKey]: state });
  state.running = true;
  state.phase = "report";
  await save();
  try {
    state.report = await summarizeDailyRun(state);
  } finally {
    state.running = false;
    await save();
  }
  return state;
}

async function executeDaily({ source = "all", selection, startDay, endDay, windowId }) {
  if (source !== "all" && !Object.hasOwn(dailySources, source)) throw new Error("未知的每日运营来源。");
  const stored = await chrome.storage.local.get([dailyHistoryKey, dailySelectionKey]);
  const plan = dailyPlan(selection ?? savedDailyPlan(stored[dailySelectionKey]), source);
  const total = Object.values(plan).reduce((sum, sections) => sum + sections.length, 0);
  if (!total) throw new Error("请至少选择一项要采集的数据。");
  const filters = plan.orders ? orderFilters(startDay, endDay) : {};
  const history = stored[dailyHistoryKey] || {};
  const cutoff = Date.now() - 9 * 86400000;
  for (const [key, entries] of Object.entries(history)) {
    if (!entries.length || entries.at(-1).at < cutoff) delete history[key];
  }
  const state = { startedAt: Date.now(), running: true, phase: "collect", plan, results: {},
    dates: { startDay, endDay }, progress: { done: 0, total } };
  const save = (snapshotChanged = false) => chrome.storage.local.set({
    [dailyStateKey]: state, ...(snapshotChanged && { [dailyHistoryKey]: history }),
  });
  await save();
  try {
    for (const [id, sections] of Object.entries(plan)) {
      const result = state.results[id] = { at: Date.now(), sections: [], errors: [] };
      let collector;
      try {
        state.progress.current = { id, section: sections[0], opening: true };
        await save();
        // Fangguo renders its virtual list on animation frames. A background tab can report
        // the new scroll position before its recycled rows update.
        collector = await openCollector(id, windowId, id === "orders");
        if (id === "orders") await applyOrderFilters(collector, sections[0], filters);
        for (const section of sections) {
          state.progress.current = { id, section };
          await save();
          try {
            const snapshot = { at: Date.now(), section, ...await collectSection(id, collector, section, id === "orders" ? filters : {}) };
            const range = id === "orders" ? [startDay, endDay === dayInChina(snapshot.at) ? null : endDay] : null;
            const key = JSON.stringify([id, snapshot.account, section, range, id === "orders" ? 4 : 1]);
            const entry = snapshot.complete ? { ...snapshot, ...compareSnapshot(history[key] || [], snapshot) } : snapshot;
            result.sections.push(entry);
            if (snapshot.complete) history[key] = addSnapshot(history[key] || [], snapshot);
            state.progress.last = { id, section, count: entry.records.length,
              added: entry.previousDelta != null ? entry.added.length : null, complete: entry.complete };
          } catch (error) {
            result.errors.push({ section, error: error.message });
            state.progress.last = { id, section, failed: true };
          }
          state.progress.done++;
          await save(true);
        }
      } catch (error) {
        result.errors.push({ error: error.message });
        state.progress.last = { id, section: sections[0], failed: true };
        state.progress.done += sections.length - result.sections.length - result.errors.filter(item => item.section).length;
      }
      finally {
        if (collector) await chrome.tabs.remove(collector.tabId).catch(() => {});
        await save();
      }
    }
    state.phase = "report";
    delete state.progress.current;
    await save();
    state.report = await summarizeDailyRun(state);
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
    await save();
  }
  return state;
}

export async function syncDailyAlarm(settings) {
  const saved = settings || (await chrome.storage.local.get(dailyScheduleKey))[dailyScheduleKey];
  await chrome.alarms.clear(alarmName);
  if (!saved?.enabled) return;
  const now = Date.now();
  let when = Date.parse(dayInChina(now) + "T" + saved.time + ":00+08:00");
  if (when <= now) when += 86400000;
  await chrome.alarms.create(alarmName, { when, periodInMinutes: 1440 });
}

export async function restoreDailyOperations() {
  const stored = await chrome.storage.local.get([dailyStateKey, dailyScheduleKey]);
  if (stored[dailyStateKey]?.running && !running) {
    await chrome.storage.local.set({ [dailyStateKey]: { ...stored[dailyStateKey], running: false, interrupted: true } });
  }
  if (stored[dailyScheduleKey]?.enabled && !await chrome.alarms.get(alarmName)) {
    await syncDailyAlarm(stored[dailyScheduleKey]);
  }
}

export function onDailyAlarm(alarm) {
  if (alarm.name !== alarmName || running) return;
  const endDay = dayInChina();
  void collectDaily({ source: "all", startDay: endDay.slice(0, 7) + "-01", endDay }).catch(() => {});
}

export async function handleDailyMessage(message) {
  if (message.type === "pl.daily.run") return await collectDaily(message);
  if (message.type === "pl.daily.report") {
    if (running) throw new Error("已经有一个每日运营流程在运行。");
    running = retryDailyReport(message.startedAt).finally(() => { running = undefined; });
    return await running;
  }
  if (message.type === "pl.daily.open") return await openDailyShortcut(message);
  if (message.type !== "pl.daily.schedule" || typeof message.enabled !== "boolean" ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(message.time)) throw new Error("请输入有效的每日执行时间。");
  const settings = { enabled: message.enabled, time: message.time };
  await syncDailyAlarm(settings);
  await chrome.storage.local.set({ [dailyScheduleKey]: settings });
  return settings;
}
