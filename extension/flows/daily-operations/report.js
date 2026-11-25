import { dailySources } from "./catalog.js";
import { splitThinking } from "../../lib/markdown.js";
import { streamTurn } from "../../lib/openai.js";
import { isModelReady, loadSettings, resolveModel } from "../../lib/storage.js";

export function dailyReportData(state) {
  return Object.entries(state.plan || {}).flatMap(([id, sections]) => {
    const result = state.results[id];
    const { platform, module } = dailySources[id];
    return sections.map(name => {
      const section = result?.sections.find(item => item.section === name);
      return {
        platform, module, section: name,
        status: !section ? "未完成" : section.meta?.type === "metrics" ? "已读取指标" :
          section.complete ? "已核对" : "部分读取",
        count: section?.records.length ?? null,
        added: section?.previousDelta != null ? section.added?.length ?? 0 : null,
        updated: section?.previousDelta != null ? section.changed?.length ?? 0 : null,
        previousDelta: section?.previousDelta ?? null,
        yesterdayDelta: section?.yesterdayDelta ?? null,
      };
    });
  });
}

export function parseDailyHighlights(content) {
  const { answer } = splitThinking(content);
  const json = answer.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/iu)?.[1] ?? answer;
  try {
    const { 要点 } = JSON.parse(json);
    return Array.isArray(要点) ? 要点.filter(value => typeof value === "string" && value.trim())
      .slice(0, 3).map(value => value.trim().slice(0, 280)) : [];
  } catch {
    return [];
  }
}

export async function summarizeDailyRun(state) {
  if (!Object.values(state.results).some(result => result.sections.length)) {
    return { note: "本次没有可供模型整理的数据。" };
  }
  try {
    const model = resolveModel(await loadSettings(), "text");
    if (!isModelReady(model)) return { note: "配置文本模型后，可生成 AI 摘要。" };
    const stats = dailyReportData(state);
    const empty = stats.filter(row => row.status === "已核对" && row.count === 0 && !(row.previousDelta || row.yesterdayDelta));
    const facts = stats.filter(row => !empty.includes(row)).map(row =>
      [row.platform, row.module, row.section, row.status, row.count, row.added, row.updated, row.previousDelta, row.yesterdayDelta]);
    const { content, reasoning } = await streamTurn(model, {
      signal: AbortSignal.timeout(60000), onReasoningDelta: () => {},
      messages: [
        { role: "system", content: '用简体中文给跨境运营人员列出最多三条简短的事实或建议，优先待处理、待回复、违规、资金限制和采集失败。只输出 JSON 对象，格式为 {"要点":["要点内容"]}。状态可能重叠，不能相加当作总量。区分总数和新增。“已读取指标”的数量仅代表已读取的指标项数，具体数值可在报告中查看。null 表示无基线或未读取，部分读取不是总量。只依据给定事实。' },
        { role: "user", content: JSON.stringify({
          列: ["平台", "模块", "页签", "状态", "条数", "新增", "更新", "较上次", "较昨日"],
          结果: facts, 已核对无记录的页签: empty.map(row => [row.platform, row.module, row.section].join("›")),
        }) },
      ],
    });
    const highlights = content === reasoning ? [] : parseDailyHighlights(content);
    return highlights.length ? { highlights } : { note: "模型未返回可用摘要。" };
  } catch (error) {
    const status = error.message?.match(/^[45]\d\d\b/u)?.[0];
    const note = error.name === "TimeoutError" ? "模型响应超时。" : status ? `模型请求失败（${status}）。` : "无法连接当前模型。";
    return { note };
  }
}
