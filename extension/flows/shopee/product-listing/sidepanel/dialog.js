const markup = `
<dialog id="ptc-flow-dialog" aria-labelledby="ptc-title">
    <header class="ptc-heading">
      <div>
        <p class="ptc-site" id="ptc-site">Shopee</p>
        <h2 id="ptc-title">商品上架</h2>
      </div>
      <div class="workflow-dialog-actions">
        <button type="button" id="ptc-back" class="secondary mini" hidden>返回工作流</button>
        <button type="button" id="ptc-close" class="icon-btn" aria-label="关闭商品上架">×</button>
      </div>
    </header>
    <p class="ptc-target" id="ptc-target">正在读取当前标签页</p>
    <a id="ptc-product-link" target="_blank" rel="noopener" hidden></a>
    <div class="ptc-mode" role="group" aria-label="试填方式">
      <button type="button" id="ptc-mode-single" aria-pressed="true">单个商品</button>
      <button type="button" id="ptc-mode-directory" aria-pressed="false">目录批量</button>
    </div>
    <section id="ptc-single-pane">
     <form id="ptc-form">
      <label class="ptc-field" for="ptc-input">商品参数（JSON）</label>
      <textarea id="ptc-input" rows="8" spellcheck="false" aria-describedby="ptc-sample-note"></textarea>
      <div class="ptc-sample-row">
        <button type="button" id="ptc-sample" class="secondary mini">载入演示数据</button>
        <span id="ptc-sample-note">笔记本样例用于试填</span>
      </div>
      <label class="ptc-field" for="ptc-image-path">主图（可选）</label>
      <input id="ptc-image-path" type="text" spellcheck="false" placeholder="本机图片的绝对路径" />
      <label class="ptc-consent" id="ptc-consent-row" hidden>
        <input id="ptc-upload-consent" type="checkbox" />
        <span id="ptc-consent-text"></span>
      </label>
      <div class="ptc-actions">
        <button type="submit" id="ptc-start" class="primary" disabled>开始试填</button>
        <button type="button" id="ptc-stop" class="secondary" hidden>停止</button>
        <button type="button" id="ptc-review" class="secondary" hidden>请 Agent 看异常</button>
      </div>
     </form>
     <p id="ptc-status" class="ptc-status" role="status" aria-atomic="true">填好后停在表单，供你核对。</p>
     <ol id="ptc-progress" class="ptc-progress" aria-label="执行步骤" hidden></ol>
     <pre id="ptc-result" class="ptc-result" hidden></pre>
    </section>
    <section id="ptc-batch-pane" hidden>
      <form id="ptc-batch-form">
        <label class="ptc-field" for="ptc-directory-path">商品目录</label>
        <div class="ptc-directory-row">
          <input id="ptc-directory-path" type="text" spellcheck="false" placeholder="桌面商品目录的绝对路径" />
          <button type="button" id="ptc-load-directory" class="secondary" disabled>读取目录</button>
        </div>
        <p class="ptc-directory-hint">可读取批次目录或单个商品目录。尺码图可命名为 <code>size.png</code>，或者在 <code>product.json</code> 指定相对路径。</p>
        <label class="ptc-consent" id="ptc-batch-consent-row" hidden>
          <input id="ptc-batch-upload-consent" type="checkbox" />
          <span id="ptc-batch-consent-text">同意将下方商品的主图和 SKU 图上传到当前 Shopee 店铺</span>
        </label>
        <div class="ptc-actions">
          <button type="submit" id="ptc-batch-start" class="primary" disabled>并发开始试填</button>
          <button type="button" id="ptc-batch-stop" class="secondary" hidden>停止</button>
        </div>
      </form>
      <p id="ptc-batch-status" class="ptc-status" role="status" aria-atomic="true">每个商品打开一个标签，填好后停在表单。</p>
      <p id="ptc-batch-import-issues" class="ptc-status" data-state="needs-review" hidden></p>
      <ol id="ptc-batch-jobs" class="ptc-batch-list" aria-label="各商品执行结果" hidden></ol>
    </section>
  </dialog>
`;

/** Mount the product workflow once in the side panel. */
export function mountProductListingDialog() {
  const existing = document.getElementById("ptc-flow-dialog");
  if (existing) return existing;
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("flows/shopee/product-listing/sidepanel/dialog.css");
  document.head.append(style);
  const template = document.createElement("template");
  template.innerHTML = markup;
  const dialog = template.content.firstElementChild;
  document.body.append(dialog);
  return dialog;
}
