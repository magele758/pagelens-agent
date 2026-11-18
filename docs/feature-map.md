# PageLens 产品功能地图

按用户看到的名称定位功能。入口 ID 来自[侧栏页面](../extension/sidepanel/index.html)。同一项功能可以跨侧栏、后台和本机进程，最后一列给出最先值得运行的验证。新增入口、迁移实现或修改用户约定时，在同一个改动里更新对应行。

| 用户入口 | 用户可观察的行为 | 从哪里改 | 从哪里验证 |
| --- | --- | --- | --- |
| 对话框 → 发送 `#btn-send` | 当前网页或 PDF 可以作为提问上下文，只使用侧栏所在窗口的当前标签。自动刷新复用已有权限 | [当前标签](../extension/sidepanel/tab-context.js)、[页面内容包](../extension/lib/page-pack.js) | [PDF 提取与上下文](../extension/tools/test_pdf.mjs)；真实标签切换需加载扩展 |
| 历史会话 `#btn-history` | 重新打开会话可续聊，也可导出 Markdown | [历史界面](../extension/sidepanel/history.js)、[会话存储](../extension/lib/sessions.js) | [会话读写与导出](../extension/tools/test_sessions.mjs)、[历史搜索与折叠](../scripts/bombadil/panel.spec.js) |
| 旁注分支 `#btn-sidechat-header` | 从一段回答继续追问，分支继承锚点之前的上下文，主线后续消息不进入分支 | [旁注界面](../extension/sidepanel/sidechat-ui.js)、[上下文组装](../extension/lib/sidechat-context.js) | [分支隔离、锚点与导出](../extension/tools/test_sidechat.mjs)、[跨会话草稿与侧栏导航](../scripts/bombadil/panel.spec.js) |
| 剪藏 → 确认保存 `#btn-clip-confirm`、知识盘点 `#btn-review` | 剪藏保留来源和批注，日／周盘点按时间范围归集材料 | [剪藏](../extension/sidepanel/clippings-ui.js)、[盘点](../extension/sidepanel/review-view.js) | [剪藏格式](../extension/tools/test_clippings.mjs)、[盘点筛选与导出](../extension/tools/test_reviews.mjs)、[剪藏知识图谱](../scripts/bombadil/graph.spec.js) |
| 设置 → 基础配置／高级配置 `#btn-settings` | 切换分类时选中项、显示面板和键盘焦点一致，保留未保存的输入 | [设置标签页](../extension/sidepanel/settings-page.js)、[配置存储](../extension/lib/storage.js) | [导航状态转换](../extension/tools/test_settings_navigation.mjs)、[Bombadil 属性](../scripts/bombadil/settings.spec.js)、[配置保存与迁移](../extension/tools/test_settings_grouped.mjs) |
| 写入文稿文件夹 `#btn-obsidian` | 将当前会话写入用户选择的目录，生成 Obsidian 可读取的 Markdown | [目录界面](../extension/sidepanel/library-ui.js)、[文件写入](../extension/lib/library.js) | [目录与文件规则](../extension/tools/test_library.mjs)；系统目录选择器需在扩展中验证 |
| 侧栏输入框、高级配置 → Skill 目录 `#btn-skills-pick` | 启用技能后可用显示名调用，例如 `使用「TikTok 墨西哥商品草稿」`；支持内置技能及所选目录中的技能 | [名称匹配](../extension/lib/slash.js)、[扫描与读取](../extension/lib/skill-folder.js)、[目录界面](../extension/sidepanel/skill-folder-ui.js) | [中文调用与菜单回归](../extension/tools/test_slash.mjs)、[Skill 扫描与载入](../extension/tools/test_skill_folder.mjs) |
| 高级配置 → Agent 网关 `#agent-gateway` | 外部客户端通过本机网关请求扩展能力，连接和工具授权分别处理。启用时直接向 Chrome 申请本机助手权限，已有权限直接复用 | [网关面板](../extension/sidepanel/agent-gateway-panel.js)、[接入说明](agent-interop.md) | [扩展协议与策略](../extension/tools/test_bridge_protocol.mjs)、[本机网关](../native/test_gateway.mjs) |
| TikTok 墨西哥商品草稿 → 输入商品链接 | 日本商品链接的 create 命令和侧栏均通过单条 ptc_create_mx_draft 请求启动流程，侧栏可关闭。新建及重跑默认由 PTC 组织商品参数生成。已核对商品可复用同源 SKU 的选项和类目。新商品从当前后台候选匹配类目和属性，按来源证据选值，同源商品的类目、属性字段及已选值与当前菜单匹配时复用已验证方案；查重命中后刷新复核，保存后优先读取保存提示中的草稿链接，否则刷新原列表识别新增 ID。刷新后逐字段核对勾选项，独立任务并行，有依赖的任务传递结构化结果，ptc_inspect_mx_draft 复核已登记草稿；商品、表单、草稿箱同组并行加载；主图分批上传，双语详情图从源语言编辑器同步。变体在选项框中确认，按标签匹配 SKU 行后填写库存和价格，暂存未确认时保留编辑页；保存后按草稿 ID 刷新核对，侧栏凭精简回执报告双语文案、图片、各 SKU 和包裹数据 | [PTC 字段任务](../tools/listing-workers.ptc.js)、[草稿组装](../tools/listing.ptc.js)、[草稿流程](../tools/tiktok-mx-draft.mjs)、[商品表单](../extension/skills/tiktok-mx-draft/tiktok-mx-editor.mjs) | [填表回归](../tools/test-tiktok-mx-commerce.mjs)、[草稿校验](../tools/test-tiktok-mx-ptc.mjs) |

首次读取需要网站权限时，可在 Chrome 工具栏授权后重试。基础授权由 [权限组件](../extension/lib/optional-permissions.js) 管理，[权限测试](../extension/tools/test_optional_permissions.mjs) 覆盖授权复用、撤销和并发请求。

## 浏览器属性测试

[本地运行、CI、覆盖门槛与失败重放](bombadil-testing.md)。设置、主侧栏和知识图谱有各自的属性文件；主侧栏复用生产启动入口，并使用两份带旁注的测试会话。
