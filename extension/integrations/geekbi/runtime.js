import { createGeekbiClient, geekbiSettingsKey, geekbiConfigured } from "./client.js";

let client;
const getClient = () => client ||= createGeekbiClient({ storage: chrome.storage.local });

export async function handleGeekbiMessage(message, sender) {
  if (sender.id !== chrome.runtime.id || sender.url?.split(/[?#]/u)[0] !== chrome.runtime.getURL("sidepanel/index.html")) {
    throw new Error("极鲸云仅供 PageLens 侧栏使用。");
  }
  if (message.action === "clear") return getClient().clearCache();
  const settings = (await chrome.storage.local.get(geekbiSettingsKey))[geekbiSettingsKey];
  if (!geekbiConfigured(settings)) throw new Error("请在设置中启用极鲸云。");
  const { action, params } = message;
  let photo;
  if (action === "image") {
    if (message.photo?.length > 14 * 1024 * 1024 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(message.photo || "")) throw new Error("图搜图片格式无效。");
    photo = await (await fetch(message.photo)).blob();
  }
  return getClient().call(settings, action, params, photo);
}

export async function requestGeekbi(action, params, photo) {
  const result = await chrome.runtime.sendMessage({ type: "pl.geekbi", action, params, photo });
  if (!result?.ok) throw new Error(result?.error || "无法连接极鲸云。");
  return result.value;
}
