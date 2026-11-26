import { editPodImage } from "./image-model.js";
import { mapPodJobs, podImageData, resizePodImage } from "./service.js";
import { normalizeSizeChart, parseSizeChartImage, parseSizeChartResponse, resolveSizeChartModel } from "../../../lib/size-chart.mjs";
import { multimodalUserContent, streamTurn } from "../../../lib/openai.js";
import { isModelReady } from "../../../lib/storage.js";

export const kitViews = Object.freeze({ front: "正面图", back: "背面图", seam: "车缝细节", fabric: "面料纹理" });
const visuallyLocked = "严格保持图中同一件商品的版型、缝线、口袋、帽型、拉链、罗纹、面料和配件。禁止新增品牌标志、标签、口袋、附件或改变结构。";
const viewDirections = {
  front: "展示同一件商品正面，全件清楚可见。参考若是背面，原背面印花仍只在背面，绝不镜像或搬到正面；没有可见正面印花依据时保持正面纯色。不要擅自加上前袋、拉链或帽绳；只在参考可确认时表现这些结构。",
  back: "展示同一件商品背面，全件清楚可见。参考若是正面，原正面印花仍只在正面，绝不镜像或搬到背面；没有可见背面印花依据时保持背面纯色，也不要凭空增加口袋、接片或标签。",
  seam: "从参考中选择真实可见的缝线、袖口或下摆区域，生成近景展示。裁切尽量避开有图案的区域，保留实际车缝方向、走线、颜色和纹理，不推测内侧或制造新的缝线。",
  fabric: "对参考中可见的无图案区域做面料近景，保留原始颜色、纤维视觉、垂感、反光和纹理。只表现实际可见表面，禁止猜测纤维成分、放大成陌生纹理或加入图案。",
};
const colors = ["蓝色", "粉色", "绿色", "黑色", "灰色", "白色", "棕色", "紫色", "红色",
  "黄色", "橙色", "卡其色"];
const printAdjustments = [
  ["疏密微调", "仅略微拉开原有重复图案的间距，覆盖区域保持不变"],
  ["比例微调", "仅略微缩小原有的重复图案，保留布局与留白"],
  ["对比度微调", "仅略微降低非文字印花的对比度，让图案与底色自然融合"],
  ["纹样间距微调", "仅略微收紧现有纹样的重复间距"],
  ["细线微调", "仅略微减细已有纹样的线条，保留其轮廓"],
  ["做旧微调", "如果原印花有做旧效果，仅略微弱化现有磨损"],
  ["边缘微调", "仅略微柔化原印花的边缘"],
  ["面积微调", "仅略微调整现有图案单元的大小，整体覆盖区域不变"],
  ["色阶微调", "仅略微调整现有印花的深浅，保持色系一致"],
  ["饱和度微调", "仅略微降低现有印花的饱和度"],
  ["重复节奏微调", "仅略微调整已有纹样的重复节奏，保持原有方向"],
  ["层次微调", "仅略微减弱现有纹样的次要细节"],
];
const split = value => [...new Set(String(value ?? "").split(/[,，、\n]/u).map(s => s.trim()).filter(Boolean))].slice(0, 12);
const defaultSizes = ["S", "M", "L", "XL"];

export function makeKitPlan({ source = "front", count = 3, recolor = true, redesign = true,
  colorList, designList, originalColor, sizeList } = {}) {
  if (!Object.hasOwn(kitViews, source)) throw new Error("请选择已有图片的角度。");
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("SKC 数量须为 1–12。");
  const variants = [];
  const tones = split(colorList);
  const prints = split(designList);
  const sizes = split(sizeList);
  if (sizes.some(size => !/^[\p{L}\p{N}][\p{L}\p{N} .+-]{0,15}$/u.test(size))) throw new Error("尺码请用逗号分隔，如 S, M, L, XL。");
  const base = String(originalColor || "原色").trim().slice(0, 12) || "原色";
  if (!recolor && !redesign) return { source, sizes, variants: [{ label: base, color: base }] };

  // Rotate print assignments so the first variants differ in both dimensions.
  const colorChoices = recolor ? tones.length ? tones : colors : [base];
  const printChoices = !redesign ? [{ print: "" }] : prints.length
    ? prints.map(print => ({ print }))
    : printAdjustments.map(([print, adjustment]) => ({ print, adjustment }));
  for (let offset = 0; offset < printChoices.length; offset++) {
    for (const [index, color] of colorChoices.entries()) {
      const choice = printChoices[(index + offset) % printChoices.length];
      const label = [color.slice(0, 12), choice.print.slice(0, 16)].filter(Boolean).join(" ");
      if (variants.some(variant => variant.label === label)) continue;
      variants.push({ label, color, recolor: Boolean(recolor), ...choice });
      if (variants.length === count) return { source, sizes, variants };
    }
  }
  throw new Error(`目前只有 ${variants.length} 种不同的颜色和图案组合。请增加候选或减少 SKC 数量。`);
}

export function kitPrompt(slot, source, variant) {
  const original = "保留参考原有颜色、实物面料和原有印花。可见图案的文字、位置、比例和颜色不得改变。";
  if (!variant) return [
    `参考图是${kitViews[source]}。制作同一件商品的${kitViews[slot]}，只输出一张照片。`,
    visuallyLocked, original, viewDirections[slot],
  ].join("\n");
  let changePrint = "保留现有印花的文字、位置、比例和颜色。";
  if (variant.adjustment) {
    changePrint = [
      "以参考照片中实际可见的印花为唯一依据，做同款小幅变体。保留原有图案类型、主要元素、覆盖位置和视觉比例。底图有格纹、条纹或做旧印花时，保持其原有风格和搭配关系。",
      `本款只做这一项微调：${variant.adjustment}。只调整适用的部分，原图没有可调整的对应特征时保留原样。`,
      "不要加入参考图中没有的主题、具象图景、文字、标语、标志或装饰。原图文字有则保留，不要补写、重绘或替换难辨字样。纯色底图保持纯色，不新增印花。印花贴合面料褶皱，不移到其他面或实物部件上。",
    ].join("\n");
  } else if (variant.print) {
    changePrint = `按用户指定的「${variant.print}」替换原主题。沿用现有印花的覆盖位置、布局、相对比例和面料融合方式，无原印花时只在当前展示面加入指定图案。清除与新主题无关的旧印花、小字、副标题、标语及标志；保留实物标签和配件。仅表现用户指定主题，所需文字须正确，其他地方留空。印花只在当前服装表面，不跨越口袋开口、拉链及车缝。`;
  }
  return [
    `用参考的${kitViews[source]}作为 SKC 主图，保留拍摄角度、人、姿势、裁切和背景，只编辑这一件服装。`,
    visuallyLocked,
    variant.recolor ? `将服装底色改为「${variant.color}」，颜色均匀自然沿原褶皱变化，不变更其他服装和印花配色。` : "服装底色与配饰颜色保持不变。",
    changePrint, "只输出一张商品照片。",
  ].join("\n");
}

function sizeName(item) {
  return Array.from(String(item.name || "服装")).slice(0, 32).join("") + "尺码表";
}

function sizeValues(input) {
  const direct = Array.isArray(input?.sizes) ? input.sizes : [];
  const groups = Array.isArray(input?.variantGroups) ? input.variantGroups : [];
  const group = groups.find(entry => /^(size|尺码|尺寸)$/iu.test(entry.name));
  return [...new Set([...direct, ...(group?.options || []).map(option => option?.value ?? option)].map(String).filter(Boolean))];
}

export async function prepareKitChart(item, settings, plan, {
  parse = parseSizeChartImage, invoke = streamTurn, resize = resizePodImage,
} = {}) {
  const name = sizeName(item);
  if (item.product?.sizeChart && !item.sizeOverride) {
    const source = item.product.sizeChart;
    return { chart: { ...normalizeSizeChart(source, { name }), ...(source.body && { body: source.body }) },
      source: source.estimatedColumns?.length ? "estimated" : "structured" };
  }
  const model = resolveSizeChartModel(settings) ?? settings.text;
  if (!isModelReady(model)) throw new Error("请配置支持图像理解的模型。");
  const signal = AbortSignal.timeout(65000);
  if (item.size) {
    const imageDataUrl = await podImageData(await resize(item.size, 2100));
    const chart = await parse({ settings: { ...settings, multimodalSameAsText: false, multimodal: model }, imageDataUrl, name, signal });
    return { chart, source: "image" };
  }
  const known = sizeValues(item.product);
  const sizes = plan.sizes.length ? plan.sizes : known.length ? known : defaultSizes;
  const reply = await invoke(model, { signal, messages: [
    { role: "system", content: "按照片和尺码生成服装通用参考表。只能给估算，不能声称是实测。上衣给胸围全围和衣长，按款式补充肩宽或袖长；下装给腰围全围、臀围和裤长，可补充裤内长。看不清的附加项不输出。仅回 JSON：{unit:\"cm\",columns:[\"尺寸（国际）\",\"胸围\",\"上衣长度\"],rows:[[\"S\",100,65]]}。按实际尺码体系选择尺码列，保留用户给定的尺码与顺序。所有尺寸为正数，随尺码合理递增。" },
    { role: "user", content: multimodalUserContent(JSON.stringify({ title: item.name, sizes }),
      await podImageData(await resize(item.photo, 1050))) },
  ] });
  if (reply.finishReason && reply.finishReason !== "stop") throw new Error("尺码模型未完整返回数据。");
  const chart = parseSizeChartResponse(reply.content, { name });
  const sizeColumn = chart.columns[0];
  if (!sizeColumn.startsWith("尺寸（") ||
      JSON.stringify(chart.rows.map(row => row[sizeColumn])) !== JSON.stringify(sizes)) {
    throw new Error("尺码模型返回的行与指定尺码不符。");
  }
  return { chart: { ...chart, estimatedColumns: chart.columns.filter(column => !column.startsWith("尺寸（")) }, source: "estimated" };
}

export function createKit(item, plan) {
  return { plan, photos: { [plan.source]: item.photo }, variants: plan.variants.map(variant => ({
    ...variant, photo: !variant.recolor && !variant.print && ["front", "back"].includes(plan.source) ? item.photo : undefined,
  })), errors: {}, reviewed: false, sizesReviewed: false };
}

export function kitTasks(item, kit, model, settings, {
  includeSize = true, edit = editPodImage, resize = resizePodImage, prepareChart = prepareKitChart,
} = {}) {
  const reference = () => basePhoto ??= resize(item.photo);
  let basePhoto;
  let frontReady;
  const tasks = [];
  function add(id, label, run) {
    tasks.push({ id, label, run: async () => {
      delete kit.errors[id];
      try { await run(); }
      catch (error) { kit.errors[id] = error?.message || "任务失败。"; throw error; }
    } });
  }
  for (const [key, label] of Object.entries(kitViews)) {
    if (kit.photos[key]) continue;
    add(key, label, async () => {
      const pending = Promise.resolve(reference()).then(photo => edit(model, photo, kitPrompt(key, kit.plan.source)));
      if (key === "front") frontReady = pending;
      kit.photos[key] = await pending;
    });
  }
  if (includeSize && !kit.size) add("size", "尺码表", async () => { kit.size = await prepareChart(item, settings, kit.plan); });
  const source = kit.plan.source === "front" || kit.plan.source === "back" ? kit.plan.source : "front";
  for (const [index, variant] of kit.variants.entries()) {
    if (variant.photo) continue;
    add(`skc-${index + 1}`, `SKC · ${variant.label}`, async () => {
      if (source !== kit.plan.source && !kit.photos.front && !frontReady) throw new Error("需先生成正面图。");
      const photo = source === kit.plan.source ? await reference() : kit.photos.front || await frontReady;
      variant.photo = variant.recolor || variant.print ? await edit(model, photo, kitPrompt(source, source, variant)) : photo;
    });
  }
  return tasks;
}

export function runKitTasks(tasks, progress) {
  return mapPodJobs(tasks, 6, task => task.run(), progress);
}

export function estimatedPodProgress(done, runningSince, total, now) {
  if (!total) return 0;
  const elapsed = runningSince.reduce((sum, started) => sum + Math.min(.94, Math.max(0, (now - started) / 50000 * .94)), 0);
  return done >= total ? 100 : Math.min(99, Math.round((done + elapsed) * 100 / total));
}
