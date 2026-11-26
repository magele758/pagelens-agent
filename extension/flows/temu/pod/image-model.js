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

export function artworkPrompt(theme, mode, { strength = "standard", hasStylePhoto = false } = {}) {
  const fixed = "图1是唯一商品底图。锁定拍摄角度、人物、姿势、背景、裁切，以及其他衣物和配饰。保留商品版型、比例、面料质感、口袋数量与开口、领口、拉链、腰头、抽绳、缝线、袖口、下摆以及已有实物标签。禁止新增贴标、徽章、拼接缝、五金或立体材质。只改图1目标商品的表面，不改裤子等其他衣物。";
  let edit;
  if (mode === "plain") {
    edit = "去除原有印花和印刷文字，用同一面料的干净纯色无痕补齐，保留原本的底色、高光、阴影和褶皱。";
  } else if (hasStylePhoto) {
    edit = [
      "图2只作视觉参考。直接观察图2衣服上可见的图案、色块比例、配色、边界方向、布局和覆盖范围，将最显眼的特征映射到图1现有面料表面。参考是纯拼色时，重点迁移色块顺序、相对尺寸和分界走向，将各色块视为纯平面色层，只借颜色和边界；排除参考图的粗糙颗粒、编织纹、绒面、毛圈和材质明暗，不要另加迷彩、图案、装饰条或实体拼接。",
      strength === "advanced" ? "进阶印花裂变。可以重新组织图2的视觉元素，成图仍须能看出它的主色关系与标志性布局。" :
        "标准印花裂变。保留图2的主要配色与布局关系，包括纯色底图上的新增色块；允许改变被覆盖区域的颜色，其余区域保持图1原样。",
      theme && `用户补充要求：${theme}。按此细化图2可见的视觉特征。`,
      "只迁移平面视觉特征，不复制图2的服装类型、部件、材质、文字、商标、模特或场景。各色块下方必须连续保留图1原有的细纹、光泽、褶皱和阴影，像同一块面料换色；保护拉链、袋口、罗纹和皮肤。",
    ].filter(Boolean).join("\n");
  } else {
    edit = [
      strength === "advanced" ? "进阶印花裂变。允许重排印花布局、节奏与配色。" :
        "标准印花裂变。已有印花时保留大致位置和覆盖范围，纯色底图按指定位置新增印花。",
      `原创设计要求：${theme}。`,
      "只改平面印花，其他区域保留底色。所有图案沿面料褶皱自然贴合，避开袋口、拉链和皮肤。",
    ].join("\n");
  }
  return [fixed, edit, "输出一张可核对的商品照片。"].join("\n");
}

export async function generatePodImage(model, reference, theme, mode, {
  fetcher = fetch, referencePhoto, strength,
} = {}) {
  if (!isModelReady(model)) throw new Error("请从已配置模型中选择支持参考图编辑的模型。");
  const base = new URL(model.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("图像模型服务地址无效。");
  base.pathname = base.pathname.replace(/\/(?:chat\/completions|responses|models|images\/(?:generations|edits))\/?$/u, "").replace(/\/$/u, "");
  const ark = isSeedream(model.model);
  const stylePhoto = mode === "plain" ? null : referencePhoto;
  const prompt = artworkPrompt(theme, mode, { strength, hasStylePhoto: Boolean(stylePhoto) });
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
