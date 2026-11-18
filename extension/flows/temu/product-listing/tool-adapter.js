import { dialogNote } from "../../../lib/agent/cdp-tools.js";
import { isSensitiveUploadPath } from "../../../lib/bridge/tools-browser.js";
import { getCdp } from "../../../lib/cdp.js";
import { temuControls } from "./controls.js";
import { temuDecorationPage } from "./decoration-page.js";
import { temuEditorPage } from "./editor-page.js";
import { temuMediaPage } from "./media-page.js";
import { temuSpecPage } from "./spec-page.js";
import { isTemuCategoryPage, temuStagePage } from "./stage1.js";

const SITE = "https://agentseller.temu.com";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => ({ ok: false, code, message });
const imagePath = path => typeof path === "string" && /^(?:\/|[A-Za-z]:[\\/]).+\.(?:jpe?g|png|webp)$/iu.test(path) &&
  !isSensitiveUploadPath(path);

export function isTemuDraftEditor(href) {
  try {
    const url = new URL(href);
    const drafts = url.searchParams.getAll("productDraftId");
    return !url.username && !url.password && url.origin === SITE && url.pathname === "/goods/edit" &&
      drafts.length === 1 && /^\d{1,24}$/u.test(drafts[0]) && !url.searchParams.has("productId");
  } catch {
    return false;
  }
}

/** A tool caller serves one trial begun on the new-product category page. */
export function createTemuListingToolCaller({ tabId, url, signal, confirmUpload, api = globalThis.chrome, cdp = getCdp() } = {}) {
  let href = url;
  let documentId;
  let categoryPath;
  let stage = "category";
  let siteAndCategorySet = false;
  let busy = false;
  const currentTab = () => api.tabs.get(tabId).catch(() => null);
  const editorScope = () => ({ origin: SITE, path: "/goods/edit", href });

  const getConsistentTab = async () => {
    const tab = await currentTab();
    if (!tab || tab.url !== href || (stage === "editor" ? !isTemuDraftEditor(tab.url) : !isTemuCategoryPage(tab.url))) {
      return failure("PAGE_CHANGED", "试填标签或 Temu 登录状态已变化。");
    }
    const dialog = cdp.pendingDialog?.(tabId);
    return dialog ? failure("MODAL_BLOCKED", dialogNote(dialog)) : null;
  };

  async function runInPage(func, request) {
    signal?.throwIfAborted();
    const stopped = await getConsistentTab();
    if (stopped) return stopped;
    const target = documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [0] };
    const [reply] = await api.scripting.executeScript({
      target, func, args: [func === temuEditorPage ? { ...request, categoryPath } : request],
    });
    signal?.throwIfAborted();
    if (!reply || !reply.documentId || reply.frameId !== 0 || documentId && reply.documentId !== documentId) {
      return failure("PAGE_CHANGED", "试填页面已重新加载。");
    }
    documentId ||= reply.documentId;
    const result = reply.result;
    const transition = func === temuStagePage && request.kind === "next" && result?.ok;
    return (!transition && await getConsistentTab()) || result || failure("PAGE_CHANGED", "试填页面失去连接。");
  }

  async function enteredEditor() {
    const deadline = Date.now() + 12000;
    do {
      signal?.throwIfAborted();
      const tab = await currentTab();
      if (isTemuDraftEditor(tab?.url)) {
        href = tab.url;
        documentId = undefined;
        stage = "editor";
        return { ok: true, href };
      }
      if (tab?.url !== href) return failure("PAGE_CHANGED", "选择类目后跳出了 Temu 新建商品页。");
      await sleep(180);
    } while (Date.now() < deadline);
    return failure("EDITOR_LOADING", "Temu 未进入第二步，请检查类目、站点或页面提示。");
  }

  async function approveFiles(role, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 10 || paths.some(path => !imagePath(path))) {
      return failure("UPLOAD_DENIED", "只能上传所选商品目录里的 JPG、PNG 或 WebP 图片。");
    }
    if (!(await confirmUpload?.({ role, paths: [...paths] }))) return failure("UPLOAD_DENIED", "未确认本次图片上传。");
    return null;
  }

  async function selectFiles(selector, paths) {
    signal?.throwIfAborted();
    const result = await cdp.send(tabId, "Runtime.evaluate", {
      expression: `(() => { if (location.href !== ${JSON.stringify(href)}) return null; const found = document.querySelectorAll(${JSON.stringify(selector)}); const input = found.length === 1 && found[0]; return input instanceof HTMLInputElement && input.type === "file" && !input.disabled ? input : null; })()`,
    });
    const objectId = result?.result?.objectId;
    if (!objectId) return failure("PAGE_CHANGED", "图片上传控件已切换。");
    try {
      await cdp.send(tabId, "DOM.setFileInputFiles", { objectId, files: paths });
    } finally {
      await cdp.send(tabId, "Runtime.releaseObject", { objectId }).catch(() => {});
    }
    return { ok: true };
  }

  async function uploadMaterial(key, paths) {
    const filenames = paths.map(path => path.split(/[/\\]/u).at(-1).replace(/\.(?:jpe?g|png|webp)$/iu, ""));
    if (new Set(filenames).size !== filenames.length) return failure("UPLOAD_DENIED", "一起上传的图片需要不同的文件名。");
    const media = (kind, args) => runInPage(temuMediaPage, { href, kind, key, filenames, ...args });
    const picker = await media("open");
    if (!picker.ok) return picker;
    let confirmed;
    try {
      if (paths.length > 1 && !picker.multiple) return failure("UPLOAD_CONTROL_SINGLE", "素材中心每次只接收一张图片。");
      const selectedFiles = await selectFiles(picker.selector, paths);
      if (!selectedFiles.ok) return selectedFiles;
      const deadline = Date.now() + 22000;
      do {
        const selected = await media("inspect");
        if (!selected.ok) return selected;
        const previous = picker.knownMedia || [];
        const newCards = (selected.knownMedia || []).filter(card => !previous.some(old => old.identity === card.identity));
        const allUploaded = filenames.every(name => newCards.filter(card => card.filename === name).length === 1);
        if (allUploaded && selected.count === picker.count) {
          const picked = await media("select-new", { baseline: picker.count, previous });
          if (!picked.ok && picked.code !== "UPLOAD_PENDING") return picked;
          if (picked.ok) {
            confirmed = await media("confirm", { baseline: picker.count, added: paths.length });
            return confirmed;
          }
        } else if (allUploaded && selected.count === picker.count + paths.length) {
          confirmed = await media("confirm", { baseline: picker.count, added: paths.length });
          return confirmed;
        }
        await sleep(300);
      } while (Date.now() < deadline);
      return failure("UPLOAD_UNVERIFIED", "图片上传后没有确认全部新文件被选中，未确认素材中心。");
    } finally {
      if (!confirmed?.ok) await media("cancel").catch(() => {});
    }
  }

  async function upload({ role, key, identifier, paths }) {
    const request = { kind: "upload-target", href, role, key, identifier, expectedCount: paths?.length };
    const target = await runInPage(temuEditorPage, request);
    if (!target.ok) return target;
    const denied = await approveFiles(role, paths);
    if (denied) return denied;
    const stable = await runInPage(temuEditorPage, request);
    if (!stable.ok || stable.mode !== target.mode || stable.selector !== target.selector) return failure("PAGE_CHANGED", "图片上传控件已变化。");
    const selected = stable.mode === "material" ? await uploadMaterial(key, paths) : await selectFiles(stable.selector, paths);
    if (!selected.ok) return selected;
    const uploadDeadline = Date.now() + 14000;
    do {
      const next = await runInPage(temuEditorPage, request);
      if (next.ok && next.markers >= stable.markers + paths.length) return {
        ok: true, status: "verified", uploaded: paths.length,
      };
      if (["PAGE_CHANGED", "MODAL_BLOCKED"].includes(next.code)) return next;
      await sleep(250);
    } while (Date.now() < uploadDeadline);
    return failure("UPLOAD_UNVERIFIED", "浏览器已交给页面处理图片，但未能核对 Temu 上传完成状态。");
  }

  async function fillDetails({ description, paths }) {
    const denied = paths?.length ? await approveFiles("detail", paths) : null;
    const files = denied ? [] : paths || [];
    if (!files.length && !description?.trim()) return denied || failure("VALUE_INVALID", "没有可填写的详情资料。");
    const edit = kind => runInPage(temuDecorationPage, { href, kind, description });
    const prepared = await edit("prepare");
    if (!prepared.ok) return prepared;
    let imageResult;
    if (files.length) {
      imageResult = await uploadMaterial("decoration-images", files);
      if (!imageResult.ok && !description?.trim()) return imageResult;
    }
    const verified = await edit("apply");
    const imageIssue = denied || (imageResult && !imageResult.ok ? imageResult : null);
    return verified.ok ? { ...verified, uploaded: imageResult?.ok ? files.length : 0, ...(imageIssue && { imageIssue }) } : verified;
  }

  return async (tool, args = {}) => {
    if (args.tabId !== tabId || !Number.isSafeInteger(tabId) || tabId < 1) return failure("PAGE_CHANGED", "试填标签不匹配。");
    if (busy) return failure("FLOW_BUSY", "当前 Temu 商品页正执行另一步。");
    busy = true;
    try {
      if (stage === "category") {
        if (tool === "temu_sites") return await runInPage(temuStagePage, { kind: "sites", expectedHref: href });
        if (tool === "temu_category") {
          const selection = { expectedHref: href, siteId: args.site, category: args.categoryPath };
          const applied = await runInPage(temuStagePage, { ...selection, kind: "select" });
          if (!applied.ok) return applied;
          siteAndCategorySet = true;
          categoryPath = args.categoryPath;
          const next = await runInPage(temuStagePage, { ...selection, kind: "next" });
          return next.ok ? await enteredEditor() : next;
        }
      } else if (siteAndCategorySet) {
        switch (tool) {
          case "temu_editor_state": {
            const state = await runInPage(temuEditorPage, { kind: "inspect", href });
            if (!state.ok) return state;
            const dropdowns = await runInPage(temuControls, { kind: "inspect", scope: editorScope() });
            if (!dropdowns.ok) return dropdowns;
            return { ...state, fields: [...state.fields, ...dropdowns.fields], unsupported: dropdowns.unsupported };
          }
          case "temu_field_options":
          case "temu_select": {
            const options = await runInPage(temuControls, { kind: "inspect", scope: editorScope() });
            if (!options.ok) return options;
            const fields = options.fields.filter(field => field.key === args.key);
            if (fields.length !== 1) return failure("FIELD_MISSING", "没有唯一匹配的动态下拉字段。");
            return await runInPage(temuControls, { kind: tool === "temu_select" ? "select" : "probe", field: fields[0],
              value: args.value, scope: editorScope() });
          }
          case "temu_write":
            return await runInPage(temuEditorPage, { kind: "write", href, key: args.key, value: args.value });
          case "temu_add_parent_spec":
            return await runInPage(temuEditorPage, { kind: "add-parent-spec", href });
          case "temu_spec_values":
            return await runInPage(temuSpecPage, { href, parentIndex: args.parentIndex, labels: args.labels, values: args.values });
          case "temu_description":
            return await fillDetails(args);
          case "temu_origin":
            return await runInPage(temuStagePage, { kind: "origin", expectedHref: href, origin: args.origin });
          case "temu_upload":
            return await upload(args);
        }
      }
      return failure("ACTION_UNSUPPORTED", "此操作不属于当前 Temu 商品步骤。");
    } catch (error) {
      if (signal?.aborted) throw error;
      const stopped = await getConsistentTab();
      return stopped || failure("ACTION_FAILED", error?.message || "Temu 试填操作失败。");
    } finally {
      busy = false;
    }
  };
}
