import { requireHostUrl } from "../../lib/optional-permissions.js";
import { geekbiSettingsKey, geekbiConfigured } from "./client.js";
import { requestGeekbi } from "./runtime.js";

export function bindGeekbiSettings(root) {
  if (!root) return;
  const field = name => root.querySelector(`[name="${name}"]`);
  const status = root.querySelector("[role=status]");
  const clear = root.querySelector("[data-clear]");
  function show(settings = {}) {
    field("enabled").checked = Boolean(settings.enabled);
    field("appKey").value = settings.appKey || "";
    field("appSecret").value = settings.appSecret || "";
    root.querySelector("[data-state]").textContent = geekbiConfigured(settings) ? "已启用" : "未启用";
  }
  void chrome.storage.local.get(geekbiSettingsKey).then(data => show(data[geekbiSettingsKey]));
  root.querySelector("[data-save]").addEventListener("click", async () => {
    const settings = { enabled: field("enabled").checked, appKey: field("appKey").value.trim(),
      appSecret: field("appSecret").value.trim() };
    if (settings.enabled && !geekbiConfigured(settings)) {
      status.textContent = "请填写调用标识和应用密钥。";
      return;
    }
    try {
      if (settings.enabled) {
        const denied = await requireHostUrl("https://open.geekbi.com/", { userGesture: true });
        if (denied) throw new Error(denied);
      }
      await chrome.storage.local.set({ [geekbiSettingsKey]: settings });
      show(settings);
      status.textContent = "已保存。";
    } catch (error) { status.textContent = error?.message || "配置保存失败。"; }
  });
  clear.addEventListener("click", async () => {
    clear.disabled = true;
    try {
      await requestGeekbi("clear");
      status.textContent = "已清除缓存，调用额度继续按实际发起次数计算。";
    } catch (error) { status.textContent = error.message; }
    finally { clear.disabled = false; }
  });
}
