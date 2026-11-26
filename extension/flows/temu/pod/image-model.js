import { isModelReady, resolveModel } from "../../../lib/storage.js";
import { imageBytes, podImageData } from "./service.js";

export const podImagePreference = "pagelens.pod.imageModel";
export const arkImageModel = "doubao-seedream-5-0-flash-260915";
const isSeedream = model => /seedream/i.test(model || "");
const isImage = model => /gpt-image|seedream|image-edit/i.test(model || "");

export function imageChoices(settings) {
  return (settings.textProviders || []).flatMap(provider => {
    const models = (provider.models || []).filter(model => model.enabled !== false && isImage(model.id));
    if (!models.length && /^https:\/\/ark[.][a-z0-9-]+[.]volces[.]com\//iu.test(provider.baseUrl)) return [
      { providerId: provider.id, modelId: arkImageModel, name: `${provider.name} · ${arkImageModel}` },
    ];
    return models.map(model => ({ providerId: provider.id, modelId: model.id, name: `${provider.name} · ${model.id}` }));
  });
}

export function resolvePodImageModel(settings, ref) {
  const candidate = ref && imageChoices(settings).find(choice => choice.providerId === ref.providerId && choice.modelId === ref.modelId);
  if (candidate) {
    const provider = settings.textProviders.find(entry => entry.id === candidate.providerId);
    return { ...provider, model: candidate.modelId };
  }
  return resolveModel(settings, "text");
}

export function artworkPrompt(theme, mode, { market, strength = "standard", hasStylePhoto = false } = {}) {
  const fixed = "图1是唯一商品底图。锁定拍摄角度、人物、背景和裁切范围。锁定服装底色、版型、比例与材质，按图1原样保留口袋数量、开口位置、形状、拉链、腰头、抽绳、缝线、袖口和下摆。已有的实物标签原样保留，禁止新增贴标、徽章或五金。只有平面印花区域允许改动。";
  const marketNote = market ? `Temu 市场参考的款式特征：${market}。这是风格依据，不能移植参考款的服装结构。` : "";
  const styleImage = hasStylePhoto ? "图2是市场风格参考。只提取印花布局、覆盖率、色彩关系和图案密度。以图1为唯一照片底稿，不复制图2的原始图案、文字、商标、人物或背景。" : "";
  const edit = mode === "plain"
    ? "去除原有印花和印刷文字，用同一面料的干净纯色无痕补齐，保留原有高光、阴影和褶皱。"
    : [
      strength === "advanced" ? "进阶印花裂变。新设计可改变印花布局、节奏与配色，但仍只修改印花。" :
        "标准印花裂变。已有印花时保留大致位置和覆盖范围，改成不同的原创画面。纯色底图按指定位置增加印花。",
      marketNote, styleImage, `原创设计要求：${theme}。`,
      "所有图案沿真实面料的褶皱走向融合；避开袋口、拉链缝隙、拉绳和皮肤。要求为原创平面印花，不增加立体配件、口袋或织造结构。"
    ].filter(Boolean).join("\n");
  return [fixed, edit, "输出一张可核对的商品照片。"].join("\n");
}

export async function generatePodImage(model, reference, theme, mode, {
  fetcher = fetch, referencePhoto, market, strength,
} = {}) {
  if (!isModelReady(model)) throw new Error("请从已配置模型中选择支持参考图编辑的模型。");
  const base = new URL(model.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("图像模型服务地址无效。");
  base.pathname = base.pathname.replace(/\/(?:chat\/completions|responses|models|images\/(?:generations|edits))\/?$/u, "").replace(/\/$/u, "");
  const ark = isSeedream(model.model);
  const stylePhoto = mode === "plain" ? null : referencePhoto;
  const prompt = artworkPrompt(theme, mode, { market, strength, hasStylePhoto: Boolean(stylePhoto) });
  const headers = model.apiKey ? { Authorization: "Bearer " + model.apiKey.trim() } : {};
  let body;
  if (ark) {
    headers["Content-Type"] = "application/json";
    const images = await Promise.all([reference, stylePhoto].filter(Boolean).map(podImageData));
    body = JSON.stringify({ model: model.model, prompt, image: stylePhoto ? images : images[0],
      size: "2K", response_format: "b64_json", watermark: false });
  } else {
    const { bytes, type } = await imageBytes(reference);
    body = new FormData();
    body.set("model", model.model);
    body.set("prompt", prompt);
    const field = stylePhoto ? "image[]" : "image";
    body.append(field, new Blob([bytes], { type }), `product.${type.split("/")[1]}`);
    if (stylePhoto) {
      const style = await imageBytes(stylePhoto);
      body.append(field, new Blob([style.bytes], { type: style.type }), `style.${style.type.split("/")[1]}`);
    }
  }
  const response = await fetcher(base.origin + base.pathname + (ark ? "/images/generations" : "/images/edits"), {
    method: "POST", headers, body, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(130000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`「${model.model}」图像编辑请求失败（HTTP ${response.status}）。请选择支持图片编辑的已配置模型。`);
  const output = result?.data?.[0];
  let blob;
  if (output?.b64_json) {
    if (output.b64_json.length > 28 * 1024 * 1024) throw new Error("生成图片超过大小限制。");
    blob = new Blob([Uint8Array.from(atob(output.b64_json), char => char.charCodeAt(0))]);
  } else if (typeof output?.url === "string" && /^https:\/\//u.test(output.url)) {
    const file = await fetcher(output.url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(25000) });
    if (file.ok) blob = await file.blob();
  }
  if (!blob) throw new Error(`「${model.model}」没有返回可下载的图片。`);
  const { bytes, type } = await imageBytes(blob);
  return new Blob([bytes], { type });
}
