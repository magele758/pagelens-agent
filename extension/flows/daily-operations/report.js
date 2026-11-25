import { dailySources } from "./catalog.js";
import { completeChat } from "../../lib/openai.js";
import { isModelReady, loadSettings, resolveModel } from "../../lib/storage.js";

export function dailyReportData(state) {
  return Object.entries(state.plan || {}).flatMap(([id, sections]) => {
    const result = state.results[id];
    const { platform, module } = dailySources[id];
    return sections.map(name => {
      const section = result?.sections.find(item => item.section === name);
      return {
        platform, module, section: name,
        status: !section ? "未完成" : section.complete ? "已核对" : "部分读取",
        count: section?.records.length ?? null,
        added: section?.previousDelta != null ? section.added?.length ?? 0 : null,
        updated: section?.previousDelta != null ? section.changed?.length ?? 0 : null,
        previousDelta: section?.previousDelta ?? null,
        yesterdayDelta: section?.yesterdayDelta ?? null,
      };
    });
  });
}

export async function summarizeDailyRun(state) {
  if (!Object.values(state.results).some(result => result.sections.length)) {
    return { note: "本次没有可供模型整理的数据。" };
  }
  try {
    const model = resolveModel(await loadSettings(), "text");
    if (!isModelReady(model)) return { note: "配置文本模型后，可生成 AI 摘要。" };
    const text = await completeChat(model, {
      maxTokens: 600, signal: AbortSignal.timeout(40000),
      messages: [
        { role: "system", content: "为跨境运营人员用简体中文生成简短报告。给出最多三条需要关注的事实或下一步建议，优先关注待处理、待回复、违规、资金限制和采集失败。各状态可能重叠，不能将其相加当作订单总量。区分总数和新增，null 代表没有基线或未读取，部分读取不能代表总量。不要虚构内容、日期、身份或原因。输出纯文本，每条一行，不加标题。" },
        { role: "user", content: JSON.stringify(dailyReportData(state)) },
      ],
    });
    return text?.trim() ? { text: text.trim().slice(0, 1800) } : { note: "模型没有返回摘要。" };
  } catch {
    return { note: "模型暂时不可用，采集结果可继续查看。" };
  }
}
