# PageLens 产品功能地图

按用户看到的名称定位功能。入口 ID 来自[侧栏页面](../extension/sidepanel/index.html)。同一项功能可以跨侧栏、后台和本机进程，最后一列给出最先值得运行的验证。新增入口、迁移实现或修改用户约定时，在同一个改动里更新对应行。

| 用户入口 | 用户可观察的行为 | 从哪里改 | 从哪里验证 |
| --- | --- | --- | --- |
| 对话框 → 发送 `#btn-send` | 当前网页或 PDF 可以作为提问上下文，只使用侧栏所在窗口的当前标签。自动刷新复用已有权限 | [当前标签](../extension/sidepanel/tab-context.js)、[页面内容包](../extension/lib/page-pack.js) | [PDF 提取与上下文](../extension/tools/test_pdf.mjs)；真实标签切换需加载扩展 |
| 历史会话 `#btn-history` | 重新打开会话可续聊，也可导出 Markdown | [历史界面](../extension/sidepanel/history.js)、[会话存储](../extension/lib/sessions.js) | [会话读写与导出](../extension/tools/test_sessions.mjs)、[历史搜索与折叠](../scripts/bombadil/panel.spec.js) |
| 旁注分支 `#btn-sidechat-header` | 从一段回答继续追问，分支继承锚点之前的上下文，主线后续消息不进入分支 | [旁注界面](../extension/sidepanel/sidechat-ui.js)、[上下文组装](../extension/lib/sidechat-context.js) | [分支隔离、锚点与导出](../extension/tools/test_sidechat.mjs)、[跨会话草稿与侧栏导航](../scripts/bombadil/panel.spec.js) |
| 剪藏 → 确认保存 `#btn-clip-confirm`、知识盘点 `#btn-review` | 剪藏保留来源和批注，日／周盘点按时间范围归集材料 | [剪藏](../extension/sidepanel/clippings-ui.js)、[盘点](../extension/sidepanel/review-view.js) | [剪藏格式](../extension/tools/test_clippings.mjs)、[盘点筛选与导出](../extension/tools/test_reviews.mjs)、[剪藏知识图谱](../scripts/bombadil/graph.spec.js) |
| 设置 → 基础配置／高级配置 `#btn-settings` | 切换分类保留未保存的输入。基础配置分区显示模型连接、回答外观和文稿保存。高级配置的授权列表逐行显示复选框和说明。 | [设置标签页](../extension/sidepanel/settings-page.js)、[布局样式](../extension/sidepanel/settings.css)、[配置存储](../extension/lib/storage.js) | [导航状态转换](../extension/tools/test_settings_navigation.mjs)、[窄侧栏布局](../scripts/bombadil/panel.spec.js)、[配置保存与迁移](../extension/tools/test_settings_grouped.mjs) |
| 基础配置 → 管理服务商与模型 `#btn-toggle-provider-manager` | 展开后可新增和维护服务商、管理模型。取消勾选「图片理解使用当前文本模型」可填写独立配置。 | [服务商面板](../extension/sidepanel/text-providers-ui.js)、[设置表单](../extension/sidepanel/settings-form.js) | [服务商规范](../extension/tools/test_text_providers.mjs)、[侧栏设置流程](../extension/tools/test_bombadil_flows.mjs) |
| 写入文稿文件夹 `#btn-obsidian` | 将当前会话写入用户选择的目录，生成 Obsidian 可读取的 Markdown | [目录界面](../extension/sidepanel/library-ui.js)、[文件写入](../extension/lib/library.js) | [目录与文件规则](../extension/tools/test_library.mjs)；系统目录选择器需在扩展中验证 |
| 侧栏输入框、高级配置 → Skill 目录 `#btn-skills-pick` | 启用技能后可用显示名调用，例如 `使用「TikTok 墨西哥商品草稿」`；支持内置技能及所选目录中的技能 | [名称匹配](../extension/lib/slash.js)、[扫描与读取](../extension/lib/skill-folder.js)、[目录界面](../extension/sidepanel/skill-folder-ui.js) | [中文调用与菜单回归](../extension/tools/test_slash.mjs)、[Skill 扫描与载入](../extension/tools/test_skill_folder.mjs) |
| 高级配置 → Agent 网关 `#agent-gateway` | 外部客户端通过本机网关请求扩展能力，连接和工具授权分别处理。启用时直接向 Chrome 申请本机助手权限，已有权限直接复用 | [网关面板](../extension/sidepanel/agent-gateway-panel.js)、[接入说明](agent-interop.md) | [扩展协议与策略](../extension/tools/test_bridge_protocol.mjs)、[本机网关](../native/test_gateway.mjs) |
| 工作流 `#btn-ptc-flow` | 从平台目录打开 Shopee 商品或营销面板，或将 TikTok 墨西哥草稿 Skill 指令填入对话。发送由用户确认。 | [功能目录](../extension/flows/catalog.js)、[侧栏分发](../extension/sidepanel/workflow-catalog.js) | [目录切换与入口](../extension/tools/test_workflow_catalog.mjs)、[实际侧栏装配](../extension/tools/test_bombadil_flows.mjs) |
| 外部 Agent → Shopee 商品回放 | 通过网关的 `list_flows` 发现店铺流程，用 `run_flow` 执行固定步骤。授权和当前标签校验逐步执行。侧栏显示进度，作业回执用于核对。 | [网关工作流工具](../extension/lib/bridge/tools-flow.js)、[互通说明](agent-interop.md) | [作用域、租约、回读和审批](../extension/tools/test_bridge_flow.mjs) |
| 工作流 → Shopee → 商品上架 | 单件或从商品目录分标签试填。按类目读取当前表单后填规格、图片、运费和尺码表，逐项回读。上传图片、模型识图及保存尺码表由用户按本次操作同意。商品试填停在表单。 | [上架工作流](../extension/flows/shopee/product-listing/README.md)、[商品目录宿主](../native/product-directory.mjs) | [固定回放](../extension/flows/shopee/product-listing/tests/test_shopee_ptc_replay.mjs)、[侧栏授权](../extension/flows/shopee/product-listing/tests/test_shopee_listing_dialog.mjs) |
| 工作流 → Shopee → 活动数据／优惠券数据 | 按当前店铺读取和翻页。可用配置的文本模型翻译非中文名称及说明，保留原文并下载 JSON 或 CSV。 | [Shopee 使用说明](../extension/flows/shopee/README.md)、[营销读取](../extension/flows/shopee/marketing-runtime.js) | [活动与导出](../extension/flows/shopee/campaign-data/tests/test_shopee_marketing_panel.mjs)、[优惠券提取](../extension/flows/shopee/vouchers/tests/test_shopee_vouchers.mjs) |
| 工作流 → Shopee → 活动表单试填／优惠券表单试填 | 探测同店铺的新建页。折扣活动试填名称，商店固定金额券可试填和回读六个字段。试填停在提交前。 | [活动表单](../extension/flows/shopee/campaign-draft/page-state.js)、[优惠券表单](../extension/flows/shopee/vouchers/draft.js) | [试填边界](../extension/flows/shopee/campaign-draft/tests/test_shopee_campaign_draft.mjs) |
| TikTok 墨西哥商品草稿 → 输入商品链接 | 日本商品链接的 create 命令和侧栏均通过单条 ptc_create_mx_draft 请求启动流程，侧栏可关闭。新建及重跑默认由 PTC 组织商品参数生成。已核对商品可复用同源 SKU 的选项和类目。新商品从当前后台候选匹配类目和属性，按来源证据选值，同源商品的类目、属性字段及已选值与当前菜单匹配时复用已验证方案；查重命中后刷新复核，保存后优先读取保存提示中的草稿链接，否则刷新原列表识别新增 ID。刷新后逐字段核对勾选项，独立任务并行，有依赖的任务传递结构化结果，ptc_inspect_mx_draft 复核已登记草稿；商品、表单、草稿箱同组并行加载；主图分批上传，双语详情图从源语言编辑器同步。变体在选项框中确认，按标签匹配 SKU 行后填写库存和价格，暂存未确认时保留编辑页；保存后按草稿 ID 刷新核对，侧栏凭精简回执报告双语文案、图片、各 SKU 和包裹数据 | [PTC 字段任务](../tools/listing-workers.ptc.js)、[草稿组装](../tools/listing.ptc.js)、[草稿流程](../tools/tiktok-mx-draft.mjs)、[商品表单](../extension/skills/tiktok-mx-draft/tiktok-mx-editor.mjs) | [填表回归](../tools/test-tiktok-mx-commerce.mjs)、[草稿校验](../tools/test-tiktok-mx-ptc.mjs) |

首次读取需要网站权限时，可在 Chrome 工具栏授权后重试。基础授权由 [权限组件](../extension/lib/optional-permissions.js) 管理，[权限测试](../extension/tools/test_optional_permissions.mjs) 覆盖授权复用、撤销和并发请求。

## 浏览器属性测试

[本地运行、CI、覆盖门槛与失败重放](bombadil-testing.md)。设置、主侧栏和知识图谱有各自的属性文件；主侧栏复用生产启动入口，并使用两份带旁注的测试会话。
