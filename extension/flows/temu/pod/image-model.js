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

export function artworkPrompt(theme, mode) {
  const task = mode === "plain"
    ? "移除参考衣服上所有印花和印刷文字，恢复同材质同颜色的连续纯色面料。"
    : `只把印花改为这一原创主题：${theme}。若参考图是纯色，只在可见的主要服装面板加印花。移除原图文，避免商标及球队符号。`;
  return task + "保持参考照片不变，包括人体、相机视角、背景、帽子、裤腰、口袋的数量位置和形状、拉链、缝线、尺寸比例、布料色彩和纹理。只编辑衣服印花区域，不改版型，不增添装饰物。输出单张商品照片。";
}

export async function generatePodImage(model, reference, theme, mode, fetcher = fetch) {
  if (!isModelReady(model)) throw new Error("请从已配置模型中选择支持参考图编辑的模型。");
  const base = new URL(model.baseUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("图像模型服务地址无效。");
  base.pathname = base.pathname.replace(/\/(?:chat\/completions|responses|models|images\/(?:generations|edits))\/?$/u, "").replace(/\/$/u, "");
  const ark = isSeedream(model.model);
  const prompt = artworkPrompt(theme, mode);
  const headers = model.apiKey ? { Authorization: "Bearer " + model.apiKey.trim() } : {};
  let body;
  if (ark) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ model: model.model, prompt, image: await podImageData(reference),
      size: "2K", response_format: "b64_json", watermark: false });
  } else {
    const { bytes, type } = await imageBytes(reference);
    body = new FormData();
    body.set("model", model.model);
    body.set("prompt", prompt);
    body.set("image", new Blob([bytes], { type }), `reference.${type.split("/")[1]}`);
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
