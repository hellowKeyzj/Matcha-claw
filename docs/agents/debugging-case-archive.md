# Debugging Case Archive

本文是 [debugging-playbook.md](./debugging-playbook.md) 的案例归档。它用于保存已经被 Diagnostic Pattern 覆盖、已经过期、或只在少数场景下有参考价值的定位案例。

默认定位类任务只需要读取 `docs/agents/debugging-playbook.md`。本文不是默认必读材料，只有在 playbook 明确指向、当前问题与某个归档案例高度相似，或需要追溯历史细节时才读取。

## 1. 使用规则

- `debugging-playbook.md` 保存默认定位原则、Diagnostic Patterns、少量 active Case Cards。
- 本文保存 `promoted` / `archived` Case Cards。
- 新案例不要直接写入本文；先进入 playbook，经过抽象或过期后再迁移到本文。
- 本文案例不应改变第一轮定位顺序；能改变第一轮定位顺序的内容必须回写到 playbook 的 Diagnostic Pattern。
- 本文不得保存聊天流水、完整命令输出或长篇事故报告。

## 2. 读取触发

只有满足至少一个条件时才读取本文：

1. `debugging-playbook.md` 的某个 pattern 或 active case 明确引用本文案例。
2. 当前问题与归档案例的 Source incident / Root cause boundary 高度相似，需要追溯细节。
3. 准备新增或合并 case，需要检查是否已有同类历史案例。
4. reviewer pass 要确认本次经验应进入 active playbook 还是 archive。

## 3. 归档状态

### promoted

案例已经抽象进 Diagnostic Pattern。本文只保留短卡片，用来说明 pattern 的来源和关键误判点。

### archived

案例已经过期、一次性太强，或不再适合作为默认定位依据。本文只保留可追溯摘要。

## 4. 迁移规则

从 `debugging-playbook.md` 迁移案例到本文时：

1. 保留 Case Card 固定字段。
2. 将 `Status` 改为 `promoted` 或 `archived`。
3. 压缩 `Wrong path taken`、`Correct first-round plan` 和 `Verification closure`，只保留未来仍有价值的信息。
4. 如果案例中的 Reusable rule 已进入 Diagnostic Pattern，写明对应 pattern id。
5. 删除所有一次性命令、日志片段、聊天上下文和与当前规则无关的实现细节。

如果迁移后发现某条信息仍会改变默认定位顺序，应先更新 `debugging-playbook.md` 的 Diagnostic Pattern，再归档案例。

## 5. 归档 Case Card 模板

```md
## Case: <short name>

### Status

promoted | archived

### Linked pattern

DP-xxx 或 `none`

### Source incident

### Symptom

### Surface path

### Real minimum loop

### Wrong path taken

### Missed first probe

### Root cause

### Root cause boundary

### Correct first-round plan

### Fix boundary

### Verification closure

### Reusable rule

### Applies to

### Does not apply to

### Archive note

为什么该案例进入 archive，而不是继续留在 playbook 主体。
```

## 6. 当前归档案例

## Case: 设计插件修复停在局部补丁与错误验证结论

### Status

archived

### Linked pattern

DP-001；既有 P4/P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，属于执行未遵守，不新增同义规则。

### Source incident

2026-10-30，设计插件 v1.0.3 的问题修复中，用户再次要求按完整责任边界修改，而非在上一轮补丁上追加条件。

### Symptom

生成预校验重复读素材且并发检查跨 await；退役仅删实例记录；MCP 首次目录仍阻塞初始化；将 npm tarball 和局部编译误报为插件打包及整链通过。

### Surface path

设计工具 → utility host／worker → Provider 媒体；独立 Matcha MCP → 应用插件目录；根打包命令 → 插件 ZIP validator。

### Real minimum loop

生成在异步前占位、只准备一次、校验后记账；停用等待真实 handler 退出并完整清理；MCP 无需等待可选 HTTP 即可握手；实际 ZIP 经安装端同款 validator 验证。

### Wrong path taken

用假快照预校验，后续再次准备；以删除 Map 代替资源退出；另加首次目录请求而保留观察任务；未核命令实际产物及完整编译结果就概括成功。

### Missed first probe

未核对容量检查至占位之间的 await、`calls.done` 与上层取消的差异、dispose 失败后的 writer 安全边界，以及 pnpm 内建 `pack` 与同名脚本的区别。

### Root cause

将局部 diff 缩小与编译／打包动作完成误当作目标语义闭合，遗漏状态责任方、失败时序及验证证据的适用范围。

### Root cause boundary

插件生成 owner、Host／worker 实例生命周期、MCP 目录观察任务及根打包入口，不是 UI、公共 SDK 或 Provider 凭据 owner。

### Correct first-round plan

读双方协议和真实完成信号，冻结单一路径及失败终态；复用既有长请求 transport 与 ZIP validator；类型、编译、工件和实机验收分开记录。

### Fix boundary

生成同步登记后执行一次准备；退役用单实例 pending／failed，清理失败明确要求重启，禁止旧新 writer 并存；MCP 由唯一观察任务首次加载及更新；媒体签名与发送复用同一串行化字节；根命令显式 `run pack`。[VERIFY: apps/design/src/backend/generation.ts:118-145,227-238] [VERIFY: electron/main/app-plugins/host.ts:60-95] [VERIFY: electron/main/app-plugins/worker.ts:25-54] [VERIFY: runtime-host/host/src/mcp/app_plugins.rs:16-25,54-92] [VERIFY: electron/main/app-plugins/media.ts:14-21] [VERIFY: runtime-host/modules/provider/src/adapters/loopback/media.rs:61-74] [VERIFY: package.json]

### Verification closure

本轮命令、原始日志、工件摘要与未验边界单独记录于 [verification.md](../../.scratch/design-final-form-20261030/verification.md)。类型／lint／ZIP 构建不能证明 v1.0.3 已安装，也不证明并发、清理故障、慢网关、真实取消或收费模型链已运行恢复。

### Reusable rule

执行既有 final-form 和 P4/P6/P7：以真实状态 owner、完成信号及实际产物收口，失败、超时和未验项不得被局部成功覆盖。

### Applies to

跨进程插件生命周期、并发 admission、动态目录及构建分发的修复。

### Does not apply to

不改变状态与执行链的单点文案修改。

### 2026-10-31 同类纠偏

用户再次质疑补丁式修复。实际源码发现外部 MCP 回执被强转为通用 JSON 事件，Editor／Workbench 分别解析，后者还用解析异常决定刷新 generations。现由 Design 协议入口一次校验并产生 `document/completed/failed` 更新，两组件只处理各自业务；删除原始回执强转与重复 parser，不改公共 SDK、不增第二 store。另沿 Search→native restore→service stop→Host joins 核对，确认还原的普通错误会在服务成功停止后仍触发 owner panic；只在 Search shutdown 分类为安全诊断，保留真实停止未确认／join 失败，显式业务操作的错误响应不变。[VERIFY: apps/design/src/ui/api.ts:5-41,69-77,92-110] [VERIFY: apps/design/src/ui/Editor.tsx:22-43,92-108] [VERIFY: runtime-host/modules/search/src/owner.rs:242-248,781-788] [VERIFY: runtime-host/external/searxng/src/process.rs:104-120]

不因“小 diff”判定为补丁：Chat contexts 进入已有草稿生命周期、FFmpeg 原链增加 `apad`、媒体 scope 全链合同及插件退役 fence 保留。Design 改后 noEmit／lint／真实 api＋React Editor 驻内存检查、Search 窄 cargo check／rustfmt 均通过；验证环境曾在模块隔离、脚本转义及缺 iframe 前提处失败，均不计业务通过。真实外部宿主、native 还原故障及桌面关停未运行，完整证据见[本次记录](../../.scratch/design-canvas-20261030/verification.md#2026-10-31-工程质量复核与结构纠偏)。

### 2026-10-31 第3组定向复核

再次沿真实 producer、native 文件合同和 Main 读取入口复核：managed 原图票据是 `v1.<payload>.<HMAC>`，不能复用 transcript 的 connection/token 语法；Design 默认保存位置不能假设 `assets/` 已存在；Main binary 入口必须在 JSON 解析前限制 wire；媒体归集 hook 的相同调度分支不需要两份镜像状态。分别在原票据 parser、保存默认路径、原 bounded body reader 和原 hook 收口，不增加 fallback、mkdir 重试或新 owner。最终类型／lint 通过，但 Cargo 曾触发资源硬限，真实 Gateway 原件及 Workspace 写入未验，不能据此认领第3组业务完成。证据与失败边界见[第3组台账](../../.scratch/design-accio-third-20261031/README.md#2026-10-31-final-form定向复核)。

同日用户报告连续切会话后工具栏残留；当前源码核实 `ChatInputToolbar` 与新增 `ComposerPromptEnhancement` 在同一父节点使用完全相同的 key。仅将两处 key 分别加 `toolbar:`、`prompt-enhancement:` 前缀，保留原 draft/session 身份后缀、scopeKey 与卸载清理；不删会话重置、不加 DOM 清理补丁、不转查 HTTP。Renderer noEmit 与定向 lint 通过；未启动应用复现或重跑连续切会话，截图与现场现象来自用户，不能写成本轮实测恢复。[VERIFY: src/plugins/chat/ChatInput.tsx:1870-1908] [VERIFY: src/plugins/chat/components/ComposerPromptEnhancement.tsx:22-29]

### 2026-10-31 两批交互结构纠偏

用户再次质疑补丁式修改。本轮限定原diff，核实组附件虽归draft store，ChatInput仍用effect复制到本地state并在删除时双写；复制失败也同时保存在CopyState与Workbench error，底部重试成功不会清副本。现删除组附件projection effect／projectedGroupIdsRef／双删，直接从contexts派生展示，失败恢复仅将独立附件写回本地；复制错误只归原CopyState，不按错误字符串反推来源。[VERIFY: src/plugins/chat/ChatInput.tsx:510-524,1160-1174,1248-1255,1304-1307,1592-1606] [VERIFY: apps/design/src/ui/useCanvasTransfers.ts:177-204,216-232,354-355] [VERIFY: apps/design/src/ui/Editor.tsx:451,513]

同一边界另核实fit／focus错误套用5%手动缩放下限、reducer将可选视频参考当成必需、UI重复固化可选人物照片约束；分别在原Canvas fit／focus、Design纯reducer及业务prompt producer收口，不在Chat解释Design JSON，不加框架或兼容层。[VERIFY: apps/design/src/ui/Canvas.tsx:265-278,524-539] [VERIFY: apps/design/src/backend/compose.ts:27-30,121-134] [VERIFY: apps/design/src/ui/Generation.tsx:164] [VERIFY: apps/design/src/backend/generation-instructions.ts:49]

稳定源码Design／Renderer noEmit、六文件no-fix lint及win32-x64 build通过；保留首次Editor JSX闭合失败与修复后复验。既有tests仍5通过／8失败，失败case名和首诊断与改前逐字一致，未改测试求绿。当前实际安装仍是旧12工具版，未pack／安装、发模型请求或执行新代码真实业务；构建不算实机验收。原始日志、当前工件hash与限制见[本轮台账](../../.scratch/design-interaction-20261031/README.md#2026-10-31-工程质量定向纠偏)。

### 2026-10-31 原提示词忠实性纠偏

用户追问增强提示词来源，确认先前仅参考机制、正文为自行编写后，明确要求直接用Accio原文。静态追到提取包本地默认`xfo.PROMPT_ENHANCE_SYSTEM_PROMPT`与`xza/Sza`最终规则，增强组件现逐字保留1642字符原文，删除旧JSON rewrite与摘要伪领域增强路径。不将单prompt桥冒称原system/user两消息，不复制候选增强器平台或更改服务端。原文逐字比较、定向lint及Renderer noEmit通过，未调用模型；来源hash、必要适配及未验限制见[本轮台账](../../.scratch/design-interaction-20261031/README.md#2026-10-31-直接复用-accio-原增强提示词)。这是既有参考忠实与§26的执行纠偏，不新增同义规则。[VERIFY: src/plugins/chat/components/ComposerPromptEnhancement.tsx]

### 2026-11-01 增强按钮挤占发送槽

用户实际截图与当前登录应用均复现：工具栏只有四列，新增增强按钮没有布局槽，正文非空时自动占第4列，固定第4列的发送按钮被排到下一行。原生 DOM 实测工具栏662px宽、76px高，发送未禁用且中心命中正确；不能把换行直接认定为发送失败。[VERIFY: src/plugins/chat/components/ComposerPromptEnhancement.tsx:118-129] [VERIFY: src/plugins/chat/ChatInput.tsx:1988-2052]

将增强／还原与发送收在唯一右侧操作槽，原四列末列按内容宽度分配，窄容器复用原第二行槽；撤掉发送按钮的独立 grid 定位，不增加第二工具栏、输入框或发送路径。[VERIFY: src/plugins/chat/components/chat-input.css:6-22,41-48] 当前应用清空、重输“你好”后均为36px单行，发送随正文正确启用；1000／900／680px页面宽度无溢出，500px沿原窄容器布局两行、增强与发送同行。380px模拟下固定侧栏仅留53px工具区仍溢出，低于应用960px最小窗口宽度，不扩改全局壳布局。原页面尺寸和草稿已恢复；未调用增强模型或发送收费消息，未实测还原按钮出现和消息态切换。截图见 `.scratch/design-interaction-20261031/chat-toolbar-20261101-{before,after}.png`，Renderer noEmit与三份输入组件no-fix ESLint均exit0；一次页面验证因hidden文档等待animation frame超时，改用有界协议等待后完成，不能抹除首次失败。

同次只读日志核到五次OpenClaw `sessions.create`被原生`UNAVAILABLE — Agent main startup preparation was superseded`拒绝，发生在send.start之前；原生数据库准入准备失效的具体触发项、是否新回归未确认，不改第三方包、数据库或运行doctor／重启。创建明确拒绝后自动恢复纯文本会移除submission，而ChatMessages未消费顶层store.error，源码存在持续错误提示缺口；本轮未复演该失败、不扩大布局修复到下游协议。[VERIFY: src/plugins/chat/store/session-initialization.ts:229-252] [VERIFY: src/plugins/chat/ChatInput.tsx:1596-1616] [VERIFY: src/plugins/chat/ChatMessages.tsx:303-314,454-461] [VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:899-940]

既有§26、P3/P6与真实UI验收规则已覆盖；本次是新增交互只过静态检查、未核实际grid子项及输入前后布局的执行遗漏，不新增同义规则。下次在交互接入与reviewer pass核动态控件的槽位、显隐和实际命中；服务端明确拒绝必须独立归因，不能改按钮gate掩盖。

同日工程复核保留正确的布局操作槽与原增强生命周期，不为“高级实现”制造新框架。已在原 `ComposerInitialization` 增加 `createRejected` 终态，明确创建失败不再清空结果；页面从当前草稿键直接派生已有横幅，纯文字恢复仍删除 submission 并释放发送资格，关闭只隐藏当前结果，显式重试以新 operation 进入 creating，另开新会话退休该结果。`createUnknown` 仍阻止盲重建，pending 配置恢复保持原 operation；未订阅混合了其他操作错误的顶层 store.error、未留失败 submission 堵 gate、未加 toast／平行错误 store。新增文案同步四语言；本块共享状态与直接消费者由单一 writer 修改，检查并行，未另派重复全链调查。[VERIFY: src/plugins/chat/composer-drafts.ts:59-66] [VERIFY: src/plugins/chat/store/session-initialization.ts:211-253] [VERIFY: src/plugins/chat/store/session-actions.ts:1523-1531] [VERIFY: src/plugins/chat/ChatMessages.tsx:308-315]

最终 Renderer noEmit、六文件 no-fix ESLint、四语言 JSON/文案检查与限定 diffcheck 均通过；真实应用只读核当前唯一 composer、1286×824 页面及36px无溢出工具行，未改草稿。未发模型／发送请求、未注入 store 或 mock、未重启；新增创建拒绝→恢复→横幅→关闭／重试状态尚未实机验证，OpenClaw 原生 superseded 拒绝仍未修复。检查与边界见同台账“初始化失败结果归属纠偏”。

### Archive note

规则已存在且足够明确；保留事故卡，下一次在入口边界冻结及最终结果报告阶段触发，不扩写长期规范。

## Case: 参考画板迁移被误做成独立三栏编辑器

### Status

archived

### Linked pattern

DP-001；已有完整链路、原始参考和用户结果验收规则覆盖，本次承认未遵守，不新增同义规则。

### Source incident

2026-10-30，Accio 画板迁移为可安装 Matcha 应用插件，用户指出呈现位置、使用方式与前端精美程度偏离原版。

### Symptom

实现新增独立设计导航、创建表单和三栏工作台；原参考是在会话工作区内打开，采用画布、浮动工具栏及选区上下文操作。

### Surface path

安装贡献 → Renderer 工作区入口 → 应用 iframe → 插件编辑器 → 后台文档／生成工具。

### Real minimum loop

对照原版入口、工作区容器、空态、选中态及生成操作，在真实 Matcha 相同尺寸工作区操作并比较截图；后台导出成功只证明后台，不证明前端一致。

### Wrong path taken

先按业务工具清单重建通用编辑器，把功能数量和编译、原生导出验证误作整套参考迁移的主要完成依据。

### Missed first probe

实现前未把原版 use-embedded-canvas、ImageCanvas 与画板 CSS 的容器、工具顺序和交互状态对应到 Matcha 现有 Chat 扩展链。

### Root cause

将“自有编辑器和通用插件平台”的技术选择误解为可以自行重设计产品体验。

### Root cause boundary

Renderer 安装贡献落点及插件 UI，不是 Rust Provider、插件后台 owner 或 MCP 动态分发。

### Correct first-round plan

从原始参考恢复入口和状态转换，复用现有聊天工作区承载；先冻结体验不变量，再并行改通用承载与插件 UI。

### Fix boundary

保留可信插件后台和模型边界，撤去设计独立导航，以原版工作区画板作为唯一产品入口；不靠新 Dock、文件 reader 伪装应用或远端 Accio 服务补洞。

### Verification closure

2026-10-30 实际登录 profile 已安装 v1.0.2，独立设计链接为 0，右侧画板成功激活；实测导入、撤销／重做、关闭重开、追加既有草稿并聚焦。半像素坐标导出多 1px 已归因至后台 bounds 取整并修复，真实 PNG/JPG 与多图 ZIP 各项均保持 2560×1600，生成记录为空，验收副本已撤回。随后用户提供新版 Accio 截图，证明仅复刻提取包本地 ImageCanvas 仍不足：点阵画布、垂直工具、图层标签、预览进入画板与源图缩略图同步等仍有差距。v1.0.3 源码已补对应交互、原位蒙版与四语言资源，真实窗口验收另记，不将源码当成已安装结果。图文草稿实现中进一步发现：Main 原发送预算是16附件／单5 MiB／总20 MiB，Matcha native model adapter 只接受四种图片 MIME 和 PDF，JSON 附件会 Unsupported。最终精确参数走可查看／移除的 composer context，发送时附入原文本，参考图片由插件投影为支持的 MIME，不扩服务端、不伪装 PDF、不堆进可编辑输入框；暂存成功不等于模型消费成功。[VERIFY: electron/api/routes/sessions.ts:35-37] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/model.rs:55-75] [VERIFY: src/types/desktop/app-plugin-sdk.ts] [VERIFY: apps/design/src/ui/Editor.tsx] OCR、云模板、收费模型及外部互操作仍未闭环，不能宣称完全一致。

### Reusable rule

迁移技术承载不授权重设计用户路径；入口、布局、操作和视觉均属于用户指定参考的验收合同。

### Applies to

参考应用迁移、插件化改造及已有产品 UI 的跨框架实现。

### Does not apply to

用户明确授权的新设计，或不改变交互的局部文案修改。

### Archive note

既有规则已清楚，问题是执行失败；在入口理解和截图验收阶段核原参考，不扩写项目规范。

## Case: 热切模型暴露内部命令误分类与乐观输入残留

### Status

archived

### Linked pattern

DP-001；原生事实源、完整链路与身份区分已有规则覆盖，本次是执行遗漏，不新增同义规则。

### Source incident

2026-10-29，Matcha Agent 同连接热切模型后，历史显示原生 `/model` 标签并多出一条“你好”；跨层原修复未同时验收消息展示链。

### Symptom

原生两次发送、两条真人输入，Renderer 却保留第三条无 native messageId 的乐观输入；另有三条模型切换上下文被投影成真人消息。两次请求均有相同 WorkBuddy ECONNRESET，不能把对端错误归因给切换。

### Surface path

CLI 模型切换 breadcrumb → native transcript → Integration 归一／投影 → Renderer 历史确认。

### Real minimum loop

同一 Session 的两条真实输入 UUID、两条 durable Run 与 Renderer 记录对照，区分内部上下文、真人输入和未获精确身份的乐观项；模型是否真的切换另核实际 sender。

### Wrong path taken

先把共享 `inputIds/inputReceipts` 的存在当作 native 已支持消费确认，又扩大成全 CLI 合并／恢复协议改造；没有先核原生展示分类和当前产品串行发送路径。

### Missed first probe

对照 `createModelSwitchBreadcrumbs`、`UserTextMessage`、QueryEngine 与 print 队列／回显，再核普通 send 是否保留客户端 requestId。`type:user` 不等于真人，`isReplay` 也不等于持久化确认。

### Root cause

Integration 丢弃原生来源并把内部 command/output 当 user；Matcha 发送未保留客户端 requestId，前端依正文＋顺序确认，被前置 breadcrumb 阻断而留下乐观项。相关缺陷在 HEAD 已存在；开放热切触发旧缺陷，不是已完成旧版本实机 bisection 的结论。

### Root cause boundary

原生展示语义到 Integration 的翻译，以及既有 requestId／messageId／transcript UUID 到 Renderer 的精确关联；不是 OpenClaw 消费规则、CLI 新消息协议或按正文去重。

### Correct first-round plan

先核真实 native producer、输入消费与显示分支，再在当前产品路径接通已有身份。分开接单、stdout 回显、历史物化、运行终态与远端连接错误。

### Fix boundary

Matcha Integration 按原生命令语义投影；普通发送保留 requestId，真实主链存在对应 messageId 后才确认关联。Renderer 以 exact messageId 接管乐观项，不删除模型所需上下文，不修改 CLI 排队／合并／恢复规则或 OpenClaw 私有流程。

### Verification closure

只读日志已经证实两次原生发送、内部三条 breadcrumb 与前端多余乐观项；修复实施及独立验证状态见 [Session 本轮记录](../architecture-knowledge/modules/session-chat/dev.md)。历史诊断不是新产物运行验收，502 上游 reset 根因仍未证。

### Reusable rule

共享字段只是表达能力；native 消费／持久事实必须回到真实生产与消费路径。保留原生模型上下文，同时按原生展示语义区分来源，不把相同 role、回显或已分配 ID 当真人／落盘证据。

### Applies to

多 runtime 集成、内部命令混入 transcript、乐观输入与权威历史接管。

### Does not apply to

静态文案修改，或已经由原生明确提供 canonical 消息关联的纯字段转发。

### Archive note

现有规则明确，承认未遵守；在入口归因及 reviewer pass 核 native 原始路径，不继续堆叠新协议或同义规范。

## Case: 模型菜单仅消除忙态样式，遗漏滑杆提交连续性

### Status

archived

### Linked pattern

none；现有宪法 §26、P3／P6 已覆盖完整状态链与真实验证，不新增同义规则。

### Source incident

2026-10-29，Chat 模型／思考菜单无感切换修复，用户再次指出列表闪动与补丁式修改。[VERIFY: docs/architecture-knowledge/modules/session-chat/dev.md#2026-10-29-模型菜单无感切换--部分完成]

### Symptom

thinking SET 令整个模型列表变灰，模型切换提示挤动列表；去掉这些忙态样式后，滑杆松手仍会先清 preview，再等原生确认回到目标档位。

### Surface path

Picker disabled／状态节点／局部 preview → thinking hook → 原生 SET 回执。

### Real minimum loop

拖动或键盘选档 → 提交 → 在途 → 原生确认或失败；列表身份、滚动和焦点保持，显示目标在提交前后连续，失败才回已确认值。

### Wrong path taken

先检查了整列灰态与组件 key，却未核完整提交显示生命周期。既有规则明确，属于执行遗漏，不是规则缺失。

### Missed first probe

核 pointer／keyboard commit 是否先 clearPreview，以及 busy 是否令提交预览失效；真实窗口验证须覆盖松手瞬间与异步确认之间，而非只看前后截图。

### Root cause

局部交互预览在提交时过早清除，且 switching 被当作展示失效条件。[VERIFY: src/plugins/chat/components/ChatModelPicker.tsx]

### Root cause boundary

Renderer 交互状态生命周期；不能以提前写 confirmed、延时或动画掩盖，也不能由此推断 CLI 模型已经应用。

### Correct first-round plan

分开业务不可用、操作互斥、提交预览与原生确认，沿完整操作链核显示连续性及失败回退。

### Fix boundary

复用原局部 preview 标记提交阶段，原生值接管或失败后失效；保留 store／native 事实权威，不新增缓存层。[VERIFY: src/plugins/chat/components/ChatModelPicker.tsx] [VERIFY: src/plugins/chat/useChatThinking.ts]

### Verification closure

限定 lint／diffcheck 通过；既有菜单 suite 受 plugin host 未挂载阻断，最终类型检查受磁盘门阻断，真实窗口不可达。实现已改，现场无闪动尚未验收；本卡不是成功运行证据。

2026-10-30 续案：用户报告启动后再次新建发送仍会整页隐藏。主侧最初把首次异步 renderer 上冒 route Suspense 的真实风险说得过于接近定案，用户纠正后撤回该归因：贡献 Promise／lazy 模块可复用，不能解释全部后续新建；`useEffect([takeoverMode])` 的 mounted 标签也不是独立 remount 证据。日志已证输入清空等待约1.8–2秒接单、能力 GET 与发送共用 lane／agent 锁；整页挂起当次 fallback 提交仍未捕获。修已证输入生命周期、读写争用及局部加载边界，不把它们统称全部闪动的最终根因。本次属于未落实既有 P3／P6，不新增同义规则，实施与验证另见 [Session 本轮记录](../architecture-knowledge/modules/session-chat/dev.md)。

### Reusable rule

已有完整链路规则在 reviewer pass 应具体落到交互结束至异步结算之间的每次显示转移，不仅检查组件是否重挂或样式是否变灰。

### Applies to

异步滑杆、选项与设置面板的无感提交。

### Does not apply to

仅修改静态文案，或确实需要清空失效业务内容的 scope 切换。

### Archive note

问题已被既有原则覆盖，仅保留可追溯的执行遗漏与验证边界，不改变默认诊断顺序。

## Case: 去除首屏骨架时误删渲染调度

### Status

archived

### Linked pattern

none；P2、P3、P6 已覆盖测量和行为验证，不新增同义 pattern。

### Source incident

2026-10-17，任务、技能、Agent、仪表盘首屏骨架修正。

### Symptom

进入页面先出现大量空卡片；移除后，用户追问是否同时牺牲了性能。

### Surface path

页面加载态、idle 调度、卡片挂载和刷新。

### Real minimum loop

使用真实资源进入页面，导航获得反馈，真实内容完整可用，刷新保持已有快照。

### Wrong path taken

把加载装饰与性能调度一起删除，未先测量；又把外壳提前出现误当作整体性能提升。

### Missed first probe

同数据规模、同缓存条件下，分别记录导航反馈、真实内容就绪和主线程阻塞；核对开发态追踪开销。

### Root cause

修复边界错误：空骨架只是展示，调度控制昂贵挂载，两者不能一刀切处理。

### Root cause boundary

Renderer 展示与渲染调度，不是资源 API 或数据模型。

### Correct first-round plan

保留资源快照和现有虚拟化、延后搜索，独立替换骨架；用实测决定是否调整调度及更新边界。

### Fix boundary

页面渲染、稳定回调与卡片更新；不为优化改变业务契约。

### Verification closure

开发态暖路由各三次采样：纯恢复 idle/transition 虽降低部分阻塞，却使技能、Agent 卡片到齐中位数分别晚约 85ms、61ms，因此缓存快照不再额外等待 idle。收紧卡片更新边界后，三秒观测窗内超过 50ms 的阻塞总量中位数由技能 370ms、Agent 203ms 降至 98ms、14ms；卡片到齐未证实提速。开发态、样本量和文档生命周期变化均限制结论，不能外推生产收益。

### Reusable rule

消除空骨架不授权删除性能机制；外壳更快不等于完整可用更快。先区分展示、数据状态与调度，再测量修正。

### Applies to

首屏加载、渐进挂载、列表刷新和路由切换优化。

### Does not apply to

已证明无昂贵挂载且不承担性能职责的纯展示状态。

### Archive note

具体误删已由既有归属与验证原则、个人执行记忆覆盖，保留简短案例供追溯。

## Case: Provider private resolver blocking client 关闭异步 owner

### Status

archived

### Linked pattern

DP-001；既有 P2 生产同款与 P6 闭环验证已覆盖，不新增同义规则。

### Source incident

2026-10-12，文本生成 calls 停在 running，Provider account list/delete 随后返回 503。主代理核现场 PID 73920 / parent 51968，运行 `runtime-host/dist/win32-x64/runtime-host.exe` 为 322,907,136 bytes、SHA256 `0c5773dedbf8627f8e2e47c6e66c380ec9a39ca512b67103161282d810f51242`，与 `target/x86_64-pc-windows-msvc/debug/runtime-host.exe` 一致；release 为 273,088,000 bytes、SHA256 `9b94b6b78c93d0a670df070dc186a2b8e6ab5aa2c4623d2653f90aca53b1a00c`。dev 启动显式选择 dev profile，reqwest fingerprint `rustflags=[]`。[VERIFY: scripts/dev.mjs:31-32] [VERIFY: runtime-host/target/x86_64-pc-windows-msvc/debug/.fingerprint/reqwest-47c8e06419532ad1/lib-reqwest.json:1]

### Symptom

生成无终态，随后账号查询/删除不可用；明确 `not-admitted` 又在 Main IPC catch 被映射为 unknown，UI 无法区分未接单与已接单但结果未知。

### Surface path

Wiki / Team 成员介绍 → Provider GenerateText Direct → private credential resolver；随后账号 list/delete → 同一 Provider owner admission/query → Main private-auth IPC → UI projection。

### Real minimum loop

运行 DEBUG artifact → Tokio 异步 handler 取私有凭据 → reqwest blocking `wait::enter` 的临时 Runtime 析构 → Tokio blocking pool 的必然 panic 路径 → Foundation 将 handler panic 结算为失败并关闭同一 Provider owner → 后继 list/delete 503。生成 call 已 running，handler 未到安全终态结算；未取得持久 panic stack，不把源码路径确证写成现场捕获堆栈或修后实测。[VERIFY: runtime-host/foundation/src/execution/owner_runtime.rs:1476-1519] [VERIFY: runtime-host/foundation/src/execution/owner_runtime.rs:1602-1645]

### Wrong path taken

此前未完整核对运行 artifact/profile/hash，局部源码或检查不能替代现场 DEBUG 身份，遗漏了 Tokio 异步上下文内 blocking client 的失败边界；把后继 503 或 UI unknown 当作原始失败也会误判。

### Missed first probe

先冻结实际加载的 executable、profile 与 hash，再用同款调用路径复现；同时核 resolver panic → Foundation handler settle/close → 后继 admission 的顺序，而非只查 UI 或凭据是否存在。

### Root cause

旧 Provider resolver 每个请求在异步 handler 内构建 `reqwest::blocking::Client`；reqwest 0.12.28 client 构建调用 `wait::timeout`，debug-only `wait::enter` 创建临时 current-thread Runtime，其析构进入 tokio 1.53.1 `BlockingPool::shutdown(None)` / `shutdown::Receiver::wait`，异步上下文不允许 blocking，必然 panic。当前本机 registry 已核 `reqwest-0.12.28/src/blocking/client.rs:1417`、`blocking/wait.rs:73-81` 与 `tokio-1.53.1/src/runtime/blocking/pool.rs:244-285`、`blocking/shutdown.rs:37-54`；依赖版本、源码及运行 DEBUG 身份共同确证这条路径，没有持久堆栈。Foundation 按既有 panic 关闭 owner；账号 IPC 的裸 catch 另抹掉已闭合的 admission failure。两者不是 secret 缺失、durable store 损坏或新的 owner/state 需求。[VERIFY: runtime-host/Cargo.lock:8604-8606] [VERIFY: runtime-host/Cargo.lock:10265-10267]

### Root cause boundary

ConnectorSecretResolverPort 共用凭据调用链及 Provider 私有 HTTP transport；UI unknown 属于 Main admission failure 传递边界。discovery 已在 `spawn_blocking` 内执行的真实 blocking HTTP 不属于该非法异步调用。

### Correct first-round plan

核现场 artifact/profile/hash → 同款异步 resolver probe → handler panic/owner close → query/admission；再分别确认凭据调用链与 typed UI 失败，不读取凭据正文、不把 call running 解释为模型仍在执行。

### Fix boundary

当前源码已核：原 Connector port 返回 object-safe `connectors::ports::ConnectorFuture`，Provider 复用 async `reqwest::Client` 并 await resolve/claim/settle/apply/delete/discard；Sessions/OpenClaw consumers await，FactSource 保持 sync；discovery 仅先 await 凭据，再保留合法 blocking HTTP。不新增 owner、state/store、队列或 fallback；保留 2 秒 private timeout、commit/unknown/rollback 及 secret/redaction 安全。Main closed not-admitted 返回 typed rejected，不再被裸 catch 抹成 unknown；内部 generation reason 经原 Team provision / CallScope / strict decoder 显示安全成员错误，不改变生成成功正文或另建 UI 状态。[VERIFY: runtime-host/modules/provider/src/ports.rs:409-455] [VERIFY: runtime-host/modules/provider/src/ports.rs:717-728] [VERIFY: runtime-host/modules/provider/src/owner/actor.rs:204-273] [VERIFY: runtime-host/modules/provider/src/owner/models.rs:663-688] [VERIFY: electron/main/ipc/provider-private-auth.ts:643-666] [VERIFY: src/lib/provider-projection.ts:235-248]

### Verification closure

事故根因已由 code 与运行 DEBUG artifact hash 确证；唯一 runner 的 TS typecheck exit 0，unit 217 PASS / 17 FAIL，主代理只读归属为非本轮失败路径且相关源码/fixture 对 HEAD 无 diff，未跑旧 revision，不称实测基线或全绿。Cargo 最终 Provider 74/74、Connectors 26/26、Organization 456/456（exit 0）；Sessions 111、OpenClaw 152 编译错误，均 0 tests 运行 / exit 101。主代理有界归属：Sessions 相关 fixture 本轮无 diff；OpenClaw 152 主诊断均在未改 security/gateway/session 链，Connector async / Provider 范围诊断 0、无 resolve/Future/await 签名错误。均未跑旧 revision，不称实测旧基线或 tests 通过。Host lib/bins check exit 101，另一会话 migration 的 `cascade.rs:298 journal.clear_locked()` 当时缺定义；随后补齐但本轮未复跑，不称通过。556 已运行 tests 全过不等于五 crate 全过。Connector、Provider producer、Sessions/OpenClaw await 链及 Main typed admission / Host Team 安全失败 consumers 已完整读取确认；源码收口、验证部分完成且有编译阻塞，修后真实生成/list/delete 未测，不宣称运行产物已替换、owner 恢复或旧 running calls 已结算。进度见 [Provider 验证边界](../architecture-knowledge/modules/provider-model-secret/dev.md#2026-10-12-resolver-共用链-async-修复)。

### Reusable rule

执行既有 P2：核生产同款 runtime/config/command/env/identity 时包含实际运行 artifact 与 profile 的一致性；本次是执行遗漏，不是规则缺失。

### Applies to

Tokio 异步 handler 内同步 HTTP runtime 的创建/销毁、共享 resolver 多消费者，以及 handler panic 后 owner admission 失败。

### Does not apply to

已隔离到 `spawn_blocking` 的 discovery HTTP、同步 FactSource、未经证据确认的凭据失效或 durable state 损坏。

### Archive note

既有 P2 / DP-001 已覆盖；保存可追溯触发、first probe、artifact/profile 身份与根因边界，不保存聊天流水或新增长期同义规则，归档不等于修复验收。

## Case: TeamRun terminal 已到达，但持久化容量耗尽阻断结算

### Status

archived

### Linked pattern

`none`；沿真实最小闭环定位失败边界，执行约束沿用 `CODING_CONSTITUTION.md` 的 Final-form 最小改动，不新增同义规则。

### Source incident

2026-10-12，两个 Work 已有模型最终回复，后继 Review 持续 Pending。

### Symptom

用户看到角色已回答，但节点未完成、调度器没有进入 Review。

### Surface path

模型正文 → Sessions terminal snapshot → Organization terminal settlement → scheduler ready queue。

### Real minimum loop

native terminal 已接收，Sessions final candidates 已形成；Organization 在 `terminal.store.accept_context` 的 commit 阶段报 `log_full`，尚未解析最终控制块，`terminal.wake` 的 `published=false`，调度检查得到 `readyQueueCount=0`。

### Wrong path taken

把“有回复但不推进”继续归为 JSON 修复或调度唤醒问题；只扩大文件上限或更换文件格式，也无法消除每次写入完整 OrganizationFacts 的增长机制。

### Missed first probe

直接比较终态接收、事实提交、唤醒发布三个边界，不用 UI 完成表象推断持久化成功。

### Root cause

旧日志为每次提交追加全组织快照，设置 16,777,216 字节总预算；现场文件 16,609,259 字节，剩余空间不足追加下一帧。不是磁盘空间不足，也不是单字符串限制。

### Root cause boundary

Organization durable store 的提交机制。

### Correct first-round plan

核 native terminal 与 final candidates，定位第一处 StoreFault，再核持久化布局和文件大小；不重放 native effect，不改 scheduler 来跳过未提交状态。

### Fix boundary

Organization 内改为单 SQLite 的逐记录事务和 Team/Run 不可变正文；按真实 mutation keys 编码与回滚。旧日志仅显式离线迁移，不保留生产双写、快照 BLOB 或全量 diff。

### Verification closure

根因由日志与文件大小确认；初轮 Organization 436 通过 / 20 失败。用户授权适配测试后，旧日志物理断言改为 SQLite 事务事实，提示词仍全文比较，最终 Organization 456/456 全通过、Host 编译检查通过；两处迁移业务回归的原用例通过。2026-10-12 使用用户新构建的 CLI 完成真实离线迁移并无覆盖发布 canonical 目录：185 条记录、82 个正文文件，完整事实等价、正文哈希、SQLite 完整性及发布前后文件清单均通过，源日志和额外备份保持原哈希。未重启应用或重放 native effect，现场旧 Run 恢复仍未验证。

### Reusable rule

存储迁移不仅检查新介质，还要检查正常写路径是否仍复制、校验、编码整个历史；事务必须覆盖真实跨记录结算，成功提交后才发布原有唤醒。

### Applies to

终态已到达但事实提交失败，以及用新数据库替换追加全量快照的迁移。

### Does not apply to

已证明提交成功、仅订阅丢失或前端投影陈旧的故障。

### Archive note

通用归因和 final-form 规则已存在；这里保存容量增长机制与现场证据，不另增长期编码口号。

## Case: OpenClaw MCP status timeout

### Status

promoted

### Linked pattern

DP-001 Integration status failure / unavailable result

### Source incident

Matcha system-runtime MCP 在当前会话连接器中显示等待/未知，`mcpServerStatus/list` 和 `/api/external-connectors/session-status` 超时。

### Symptom

外层看到 session connector status 请求超时，gateway RPC `mcpServerStatus/list` 超时，OpenClaw 报 MCP server connection timed out。

### Surface path

Renderer status component → external connector store → Electron host API → runtime-host route → downstream status provider → OpenClaw gateway RPC。

### Real minimum loop

OpenClaw MCP runtime 通过 stdio JSON-RPC 调用 Matcha `system-runtime mcp-stdio`，完成 `initialize` 和 `tools/list`，拿到 TeamRun command tools。

### Wrong path taken

先沿 UI/status/gateway RPC 表象逐层排查，并过早处理 timeout、cached catalog、stale runtime/config 等外围问题。

### Missed first probe

没有第一时间用 OpenClaw `createSessionMcpRuntime(...).getCatalog()` 直接验证真实 MCP runtime 闭环；手写 probe 只测了 Content-Length，没有模拟 OpenClaw SDK 的 newline-delimited JSON-RPC framing。

### Root cause

OpenClaw 使用的 MCP SDK stdio transport 发送 newline-delimited JSON-RPC；Matcha MCP server 当时只支持 Content-Length framing。

### Root cause boundary

runtime-host R4 MCP stdio protocol boundary。

### Correct first-round plan

1. 直接跑 OpenClaw runtime `getCatalog()`。
2. 用同一 command/env 拉起 `system-runtime mcp-stdio`。
3. 分别 probe Content-Length 和 newline-delimited JSON-RPC framing。
4. 读取 OpenClaw MCP SDK stdio serialize 实现。
5. 只修 MCP stdio parser/response framing。

### Fix boundary

修 `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts`；不要修 Renderer、generic route、TeamRun core 或 OpenClaw business projection。

### Verification closure

OpenClaw runtime `getCatalog()` 返回 `team_node_event` 和 `team_graph_patch`；system-runtime MCP framing 单测同时覆盖 Content-Length 和 newline-delimited JSON-RPC。

### Reusable rule

集成类状态失败先验证真实协议闭环；手写 probe 必须模拟真实调用方 SDK，而不是只测我方已知 happy path。

### Applies to

MCP、stdio JSON-RPC、gateway runtime、子进程工具服务、provider SDK transport、跨进程协议适配。

### Does not apply to

纯 UI 展示错误、纯 DTO 文案映射错误、已经由单元测试直接复现的业务纯函数错误。

### Archive note

该案例已经被 DP-001 覆盖。默认定位顺序应由 DP-001 承载，完整案例只作为追溯材料保留。

## Case: Matcha-agent app-server completed but UI pending

### Status

promoted

### Linked pattern

DP-001 Integration status failure / unavailable result

### Source incident

Matcha-agent app-server 接入 runtime-host 后，用户在 Matcha Agent 会话发“你好”，app-server 已完成 run，但 UI 持续显示“正在思考”。

### Symptom

Renderer 中 assistant pending 卡片一直存在；用户可见状态没有结束。后端 app-server session 事件实际已经包含 `run.completed`，snapshot 中 run 状态也是 `completed`。

### Surface path

Renderer chat pending state → runtime-host session update projection → session gateway ingress → matcha-agent event bridge → app-server event store。

### Real minimum loop

Renderer 发起 chat turn，经 runtime-host 调用 matcha-agent app-server；app-server worker 产出 SDK message 和 `run.completed`；runtime-host ingress 接收 app-server envelope，adapter 投影成 canonical lifecycle `final/done`；renderer 收到 terminal update 后清除 pending 并展示 assistant result。

### Wrong path taken

先把成功标准停在 worker 初始化和 app-server `run.completed`，没有一开始要求 renderer terminal state 作为闭环完成证据。

### Missed first probe

没有第一轮冻结并验证跨进程字段映射：app-server envelope 顶层 `sessionId` → runtime-host `endpointSessionId` → canonical `sessionKey` → renderer `sessionKey`。

### Root cause

app-server event envelope 使用顶层 `sessionId`；runtime-host session gateway ingress 只读取 `sessionKey` / `event.sessionKey` / `params.sessionKey`。结果 `run.completed` envelope 在 ingress 被丢弃，没有进入 matcha-agent protocol adapter，也没有投影成 renderer 的 `final/done`。

### Root cause boundary

runtime-host session gateway ingress 的 endpoint session identity 提取边界。不是 worker、app-server、SDK、renderer pending 组件或 UI timeout 问题。

### Correct first-round plan

1. 定义最终成功状态：renderer pending cleared、assistant item visible、runtime `activeRunId=null`、`runPhase=done`。
2. 沿真实 envelope 链路核对每一跳：app-server event store → event bridge → gateway ingress → protocol adapter → canonical reducer → renderer store。
3. 冻结字段映射：外部 `sessionId` 作为 endpointSessionId，进入 registry 后映射为 canonical sessionKey。
4. 用真实 app-server envelope 验证 `run.started` / `sdk.message` / `run.completed` 能投影成 streaming 和 final/done。

### Fix boundary

修 runtime-host ingress 对 app-server envelope 的 endpoint session id 读取；不要在 renderer 增加超时清 pending，也不要把 app-server `run.completed` 当成可绕过 runtime-host 的 UI 直连信号。

### Verification closure

回归测试必须证明 app-server envelope 经 runtime-host 后产生：`session_item_chunk` streaming、`session_info_update phase=final`、snapshot runtime `activeRunId=null`、`runPhase=done`、`pendingTurnKey=null`。真实运行还需重启 app 后用 UI 发消息确认 pending 消失。

### Reusable rule

新 runtime / app-server / event adapter 接入，不能以中间层 completed 作为完成证据；必须验证 terminal event 被 downstream ingestion 接收并投影到最终产品状态。跨进程 session 字段必须先作为 contract 冻结，不能把 `sessionId`、`endpointSessionId`、`sessionKey` 当成同义词。

### Applies to

runtime-host session ingress、event bridge、protocol adapter、canonical session lifecycle、renderer pending state、worker/app-server/gateway 到 UI 的多进程 chat turn。

### Does not apply to

纯 renderer 样式、纯文案、单进程内纯函数错误、已经由局部单元测试直接复现的非集成 bug。

### Archive note

该案例补强 DP-001 的 verification closure 和 field mapping 要求。默认定位顺序仍由 DP-001 承载；本文只保留本次 app-server 接入事故的追溯摘要。

### 2026-10-18：回执丢失与两套等待来源

本次不是 terminal ingress 丢失：应用日志已记录 Matcha `202 queued + runId`，Electron 后续返回 `200 unknown`；同一轮 terminal 已被 Renderer 接受，native runtime 已 done，本地未关联发送仍把展示派生成 submitted。store 空助手与页面 runtime 空助手同时存在，形成两处“正在思考”。源码中两个 OpenClaw-only queued 条件丢弃 Matcha 回执；共享发送状态又要求 native 助手携同 runId 才接管，而 Matcha 消息按独立 SDK UUID 投影、runId 为 null。

先前建议统一删除两端占位，随后退回“仅改 Matcha 分支”，又把 `ChatSessionRecord.runtime` 误当 native 唯一 authority，从 receipt 反复派生 OpenClaw UI owner；均未同时保住结构性多 runtime 与原 OpenClaw 行为。后续 shared 先算 `nextAbort`、再用 `messages.abort === undefined ? nextAbort : messages.abort` 允许 concrete override，仍是双 owner，undefined 委托没有消除重复裁决。既有宪法 §26、P4/P7 与 runtime 语义隔离规则已覆盖，属于执行未遵守，不新增同义规则。

当前源码收口：accepted native facts 留在既有 `projectionStore/windowStore`；OpenClaw send-start、queued／started ACK 绑定、乐观清理、native pending／stopping merge 与原 UI gate 归 `openclaw-session`。Matcha 保持 native runtime、独立 SDK UUID 助手与 latest-tail activity，不补造助手或消息 runId。shared receipt 只管操作／回执／unknown／exact terminal 关联；`SessionMessageState.abort` 必填，两个模型明确返回取消状态，分别负责 OpenClaw UI 停止退休与 Matcha exact 关联退休，shared 仅提交。[VERIFY: src/stores/chat/session-presentation.ts] [VERIFY: src/stores/chat/openclaw-session.ts] [VERIFY: src/stores/chat/matcha-session.ts] [VERIFY: src/stores/chat/send-handlers.ts] [VERIFY: src/stores/chat/store-state-helpers.ts]

同案续查还遗漏两条边界：一是共享正文路径直接套 OpenClaw cleaner，Matcha 正常原文也可能被当 envelope／内部控制文本清掉；发送／等待模型分离并不自动隔离 store 投影、pending user 确认、message segments、复制及列表可见性／头像分组。二是 Matcha 回执已绑定 known R，terminal delta 丢失后再取得 full view，单有 inactive runtime／final 助手仍不提供该 R 的 exact 结束证据，未结 receipt 不能据此安全退休。

已核正文落点是唯一 `getSessionTextModel(identity?)`：OpenClaw 直接引用原 user／assistant cleaner，Matcha 与无 identity 中性展示原文直返；store user 投影、pending user／receipt 确认、阅读窗及附件 hydrate 归并，以及 Turn segments／纯文本复制、List 可见性／头像分组消费同一策略，不改 cleaner 算法。[VERIFY: src/stores/chat/session-presentation.ts:21-63] [VERIFY: src/stores/chat/openclaw-session.ts:15-18] [VERIFY: src/stores/chat/matcha-session.ts:6-9] [VERIFY: src/stores/chat/store-state-helpers.ts:446-575] [VERIFY: src/stores/chat/store-state-helpers.ts:1454-1506] [VERIFY: src/stores/chat/store-state-helpers.ts:1742] [VERIFY: src/stores/chat/store-state-helpers.ts:1866] [VERIFY: src/stores/chat/attachment-helpers.ts:341-383] [VERIFY: src/pages/Chat/ChatAssistantTurn.tsx:110-121] [VERIFY: src/pages/Chat/ChatAssistantTurn.tsx:291-311] [VERIFY: src/pages/Chat/components/ChatList.tsx:187-246]

同案后续把漏事件恢复扩大为每次 ACK 后额外查询，属于范围扩张；方案已叫停并撤回，本次不实现替代。

等待闪烁续案又将 Matcha 当前无头像 activity 当作必须保留的 runtime 差异，用户明确纠正应与 OpenClaw 一样发送后立即显示「头像＋正在思考」。原生 SDK 消息身份与等待行的外观不是同一约束：现在等待仍不造消息、run 或 native 状态，但复用正常助手的 MessageShell 与当前 agent presentation。错误在于把实现现状当作产品要求，不是缺少通用架构规则；既有宪法 §26／调试 P6 已覆盖，后续实现检查同时核对用户可见结果与原生事实边界，不追加同义规则。[VERIFY: src/stores/chat/matcha-session.ts:70-85] [VERIFY: src/pages/Chat/components/ChatList.tsx:465-476] [VERIFY: src/pages/Chat/index.tsx:913-941]

不新增状态存储或 OpenClaw 专属 record 字段；上述遗漏仍由既有宪法 §26、P4/P7 与语义隔离规则覆盖，原因是执行未遵守，不再补同义长期规则。最终集成检查单独记本轮，不沿用前轮成绩；源码、编译与已有测试不替代两端实际发送验收，live 与全部 OpenClaw 等价仍未验证。

## Case: Gateway retry re-entered prepare

### Status

archived

### Linked pattern

none

### Source incident

将 OpenClaw Gateway 的物理进程 ownership 迁移到 Electron main `LocalProcessRuntime` 后，一次 startup 在 port ready 之后等待 control ready 超时，`keep-current` retry 却重新进入 prepare、prelaunch 和 spawn。

### Symptom

control-ready timeout 后，config sync、prelaunch 和 fork 全部重复，owned Gateway 被 stop 后换成新 PID；本应只消费 startup outer retry budget 的暂态等待变成了重复拉起进程。

### Surface path

Electron main Gateway startup → `LocalProcessRuntime` owned process → OpenClaw Gateway adapter/supervisor readiness → recovery decision → startup outer retry。

### Real minimum loop

同一 logical start 仅按 `prepareLaunch → launch → readiness` 执行一次准备和启动。port ready 后继续等待 control ready；若 control-ready timeout 返回 `{ action: retry, cleanup: keep-current }` 且当前 plan/child 有效，则保留同一进程，等待 1 秒后只重执行 readiness。整个 startup 使用 3 次 outer budget，`still-starting` 在单轮内按内层 backoff 等待。`stop-current` 停止后，下一轮才正常 prepare/spawn；active start/restart 的 readiness 期间 child 退出时，立即中断并以真实 child-exit failure 结束本次 start。

### Wrong path taken

迁移后的 recovery 让 `keep-current` retry 重新进入 prepare，因此再次执行 prelaunch、listener 查找/attach/orphan cleanup、config/env sync 和 fork；这破坏了同一 logical start 保留 current plan/child 时只重试 readiness 的语义。

### Missed first probe

没有先断言 control-ready timeout 前后 PID、fork 次数与 prepare 次数，也没有在 ownership migration 开始时逐项冻结 startup retry、readiness、attach/orphan、crash backoff、stop/quit cleanup 等旧行为约束。

### Root cause

ownership migration 只迁移了可启动、可停止、可通过 readiness 的 happy path，没有明确 `keep-current` 重试复用 current plan/child 而不重入 prepare 的边界；generic retry loop 因而把 Gateway 专属 prepare 策略错误应用到同一 logical start 的后续 readiness attempt。

### Root cause boundary

问题位于 Electron main 的 owner seam：OpenClaw Gateway adapter/supervisor/recovery 拥有 Gateway 专属 prepare、readiness、attach/orphan 与恢复决策，`LocalProcessRuntime` 拥有 config 驱动的物理进程和 quit termination 机制。它不在 Renderer UI 或 runtime-host bridge/workflow。

### Correct first-round plan

1. 先把旧语义写成迁移约束表，并逐项指定新 owner 与验证断言。
2. 用同一 PID、一次 fork、一次 prepare 复现 port-ready/control-not-ready 场景，先确认 `keep-current` 只重试 readiness，再看 outer retry。
3. 分开验证 startup outer budget/inner backoff、首次 logical start 或显式 restart 的 listener attach/orphan cleanup、crash reconnect backoff 与 stop/quit cleanup，不能只测 happy path readiness。
4. 保持 `electron/gateway/**` 退出，不用复活旧实现修补迁移语义。

### Fix boundary

修复只落在 OpenClaw Gateway adapter/supervisor/recovery 与 `LocalProcessRuntime` 的 config/quit owner 边界：`keep-current` 且 current plan/child 有效时，通用 owner 只重执行 readiness；`stop-current` 后才由下一轮正常 prepare/spawn。Gateway 的 listener attach 或 orphan cleanup 仍只在首次 logical start 或显式 restart 的 prepare 阶段决策，config/env 只在真实 spawn 前同步。不要在 UI 或 runtime-host 增加 retry/timeout 补丁。

### Verification closure

回归闭环必须断言：

- control-ready timeout 后仍是同一 owned PID，且整个 startup 只有一次 prepare、一次 fork、一次真实 spawn 前 config/env 同步；
- `{ action: retry, cleanup: keep-current }` 只重执行 readiness，不执行 prelaunch、listener 查找/attach/orphan cleanup、config/env sync 或 spawn/fork；`stop-current` 后下一轮正常 prepare/spawn；
- active start/restart 的 readiness 期间 child 退出会立即中断，并以真实 child-exit failure 结束本次 start；
- startup 最多 3 次 outer attempt、轮次间 1 秒 delay，`still-starting` 使用单轮内层 backoff；
- listener attach 与非 owned listener 的 orphan cleanup 只发生在首次 logical start 或显式 restart 的 prepare 阶段；
- Gateway crash reconnect 最多 10 次，从 1 秒指数退避到 30 秒封顶，readiness 成功后归零；
- stop/quit 执行 5 秒 cleanup，quit timeout 时触发 emergency force termination；
- stderr classify/dedup 与 public status 在 retry、prepare 和 crash recovery 中保持既有语义。

### Reusable rule

架构 ownership migration 不能以 happy path 可用作为完成证据；必须用 `旧语义/策略 → 旧 owner 位置 → 新 owner 落点 → 验证方式 → 完成状态` 约束表逐项迁移和验收。

### Applies to

runtime/process owner migration、daemon/framework replacement、跨层 lifecycle owner 转移，以及带 prepare/readiness/recovery/attach/quit 策略的子进程迁移。

### Does not apply to

纯 UI 文案或样式、无 owner 转移的小型重构、单个纯函数 bugfix。

### Archive note

该经验已经由 `.claude/commands/code.md` 的 architecture-migration 行为约束表规则覆盖，因此不新增同义规则；本文只保留 Gateway control-ready retry 事故的可追溯案例。

## Case: TeamDesign final-form 结构收口

### Status

archived

### Linked pattern

DP-001；既有 P3/P4/P6/P7、`CODING_CONSTITUTION.md` §26 与 code reviewer 已覆盖，不新增同义规则。

### Source incident

2026-10-08，ExistingTeam 工作流设计实现后，用户质疑补丁式方案，授权有界 final-form 收口；随后核对设计 API 前三操作 input.teamId 遗漏。

### Symptom

源码确认四项结构缺陷：TeamChat 完整图缺失时 fallback 到 active-team graph/roles/gate，UI 自选新旧 patch；两页各持 local 设计写 pending；request hash 被塞为未实际 apply 的 SetMetadata audit 操作，operation_count 虚增；design store 与 facts 重复 apply/validate。后续确认 Start/Continue/Snapshot 的 wrapper 与 validator 都未要求 input.teamId，与 Rust exact decode 不匹配；文档前三表同样遗漏。同范围 response 核对发现 dependencyPlan 旧 TS 平铺类型与 Rust status/plan envelope 不符，页面直接 items.filter；Canvas replace helper 又丢 Work.groupId、Join.config.join、edge.dependency，使 domain 回默认值。未证明 durable ledger 损坏或实机故障。

### Surface path

TeamChat / Chat 页面里的 TeamLeader 会话运行面 → Teams store → Organization design transaction → draft.resolve → facts / event ledger。

### Real minimum loop

同 exact team/run 请求经 wrapper → Electron validator → Rust decode/owner → 原 store mutation 与 facts 单次 apply/validate/accept → 同 run snapshot 回读；dependencyPlan 返回原 status/plan union，页面先判 status 再展示 plan。

### Wrong path taken

以局部检查通过和旧 review pass 收口，保留了第二展示来源、页面级写互斥及假 audit 操作；又过度用既有 Data 74 绿替代新增三操作的请求 producer/consumer 核对。已有 P4/P7、DP-001、宪法 §26 和 code reviewer 规则明确；这是代理执行失败，不是规则缺失。

### Missed first probe

未核单一消费者实际读哪个 graph/roles/gate、写 flight 的跨页面 owner，以及 audit operations 是否与真实 apply 操作逐项一致；未逐项比对前三 wrapper serialize、Electron exact validator 与 Rust design decode 的 teamId。

### Root cause

新增设计分支没有收束到既有图消费与 mutation 边界；请求身份被编码成领域操作，验证工作又在两个 store 层重复。后续请求缺陷是前三仅在 target 放 teamId，而后端要求 input 同样携带；response 缺陷是 client 错报 dependencyPlan 为平铺 plan，consumer 未先判 status/取 .plan。不能放宽 Rust decode、从 target 隐式补值或为 client 改服务协议。

### Root cause boundary

仅 UI/store 投影与写入控制、Organization patch command identity / apply，以及 Team API wrapper/validator/response consumer 边界；不是 native runtime、Goal owner 或用户数据损坏。

### Correct first-round plan

先沿同 exact-run 消费链核单源与写 owner，再比对 command operations 与真实 apply，选择 typed fingerprint 和 facts 单次验证；新增 operation 逐项核 wrapper → validator → Rust decode → response consumer，不靠 fallback 或旧绿测试补齐证据。

### Fix boundary

TeamChat 只读 exact 完整 snapshot；两页共享原 store flight/mutationPending，图提交由 store 单入口选择，canvas pending 不清 draft。event GraphPatch 显式 content_fingerprint 由 draft.resolve 统一生成，codec 新 tag 4、旧 tag 0 保留原历史解释；删除假 metadata 与 design 层重复 apply/validate，facts 保留 layout/noop 设计校验。普通 session 无 Team 设计入口/协议，成员不获 leader control；Goal 独立链未重裁。[VERIFY: src/pages/Teams/TeamChat.tsx:88-94] [VERIFY: src/pages/Chat/index.tsx:681-694] [VERIFY: src/stores/teams.ts:267-322] [VERIFY: src/stores/teams.ts:1066-1099] [VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:100-139] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1193-1213] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:2904-2919] [VERIFY: runtime-host/modules/organization/src/store/design.rs:29-79] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:2880-2921]

前三请求修复遵循原 Rust decode：Start `{teamId,runId,idempotencyKey}`、Continue `{teamId,runId,proposalId,idempotencyKey}`、Snapshot `{teamId,runId}`，匹配 exact team target；只修 wrapper/validator，Patch、响应及 owner/facts 不变。[VERIFY: runtime-host/modules/organization/src/application/design.rs:58-117] [VERIFY: src/services/openclaw/team-runtime-client.ts:956-999] [VERIFY: electron/api/routes/team-runtime-capability.ts:111-127] dependencyPlan client 改 typed status/plan union，页面两 consumer 先判 status/取 `.plan`，非 available 沿原 createError；不改服务器 source 或协议。[VERIFY: runtime-host/modules/organization/src/application/team_runtime_control.rs:696-745] [VERIFY: src/pages/Teams/index.tsx:314-348] Canvas replace 保留原 Work.groupId、Join.config.join、edge.dependency，shared DTO 对齐原 nullable 字段，不加 UI 或修改 Rust 合同。[VERIFY: src/pages/Teams/TeamRunGraphCanvas.tsx:535-560] [VERIFY: src/types/team-design.ts:16-56] MCP schema 仅对齐原 decoder 的结构、条件必填、grammar 与整数范围，不改执行语义。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:42-104] [VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:163-190]

### Verification closure

主代理结构收口后四包/MCP bin check exit 0、Org 459 passed / 0 failed；Data 74 既有 tests 两次通过，Renderer tsc/scoped lint 通过。canvas 18 passed / 1 failed，前轮 MCP 1 passed / 6 failed 及 interaction/events/dock/page 失败保留；未为旧 fixture 恢复第二 store。74 原 tests 未覆盖新增三操作的请求，不能证明本次契约缺陷已恢复；本次源码核验确认 wrapper/validator 已按原 decode 对齐；主代理报告独立内存真实 client→validator 四 design 正例/20 负例、dependency decoder 3 正例/10 负例通过，未落盘、并非原 74 tests 覆盖。本轮 Organization lib 459/0、Renderer 集成 tsc exit 0，Electron 63 diagnostics/exit 2（changed design scope 0）；Canvas 18/1、page 4/10、额外 API 62/1 失败保留。未构建替换新 runtime-host/MCP 生产二进制；`OPEN`：真实模型/native/UI live 未验收。详见 [Team 设计验证账](../architecture-knowledge/modules/team-task-organization/dev.md#existingteam-工作流设计本轮验证边界)。

2026-10-08，Chat 入口改为输入框上方文字按钮后，用户仍看不到入口。实际旧 `dist/assets/page-chat-ejVJ__RC.js` 不含 `input.teamDesignInProgress`；源码修改未同步构建产物，属于既有 P6 闭环验证未执行，不是规则缺失。重新运行 `pnpm run build:vite` exit 0，新 Chat chunk 已包含文字入口和设计中状态；没有放宽 Leader/run/startGate 条件。未直接观察当前窗口加载 URL 或会话 ownership，不能据截图判定普通会话，也不能把产物更新称为实机按钮验收。[VERIFY: src/pages/Chat/ChatInput.tsx:1386-1409] [VERIFY: src/pages/Chat/index.tsx:681-694] [VERIFY: src/pages/Chat/index.tsx:1608-1615] [VERIFY: electron/main/main-window.ts:119-130]

2026-10-08，同一 Leader 会话入口仍缺失。主代理只读实机观察当前 loadedSession：OpenClaw 完整 identity 在 Teams store roles 与 design snapshot roles 均精确匹配同一 leader/run，不是 Agent main，却收到 `ownership.kind=ordinary`；meta 的 native `endpointSessionId` 与 leader receipt 的 `endpointSessionId` 不同。修前源码根因是 Host ownership reader 以 receipt 派生 ID 匹配 native history UUID，成功批查未命中落入 ordinary，Chat 据此隐藏设计入口；修后 reader 按 peer 身份关联，原 ordinary 投影与 leader gate 保持不变。[VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:46-79] [VERIFY: runtime-host/modules/sessions/src/owner/session_ownership.rs:72-81] [VERIFY: src/pages/Chat/index.tsx:681-683]

前轮已查到该归属缺陷，却仅改入口样式/构建，未修真实失败边界，也缺当前加载会话的状态观测；这是既有 P3/P4/P6/P7 与宪法 §26 执行失败，不是规则缺失。修复仅由 writer 独占 Host reader/composition，复用既有 resolver 从 receipt 生成 OpenClaw 完整 sessionKey，按 endpoint/agent/sessionKey 关联；Matcha 保持 native ID 关联并忽略 default agent。不改 public DTO、reducer 或前端 fallback。writer 两文件已落盘且文档代理已读取当前源码核实；Host bins 离线 cargo check exit0，Windows x64 MSVC Host/MCP locked offline release 构建 exit0。Host/MCP 均已替换，Host SHA256 与构建来源一致；主代理未终止或重启进程，已通知用户可自行启动。Host lib 最终 79 PASS /6 FAIL（85 项，exit101）：两项源码文本断言、一项 recovery 次数差异、三项 service 5 秒 timeout；失败不在 reader/constructor，但未复跑修改前基线，不能称与修复无关或全通过，未新增、修改测试。修后 live 待启动观察，仍 OPEN，不把源码修复、编译或替换成功写成验收。[VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:20-79] [VERIFY: runtime-host/host/src/composition/host/owners/runtime.rs:381-392] [VERIFY: runtime-host/host/src/composition/runtime_ports.rs:286-295] 详见 [Session / Chat 验证账](../architecture-knowledge/modules/session-chat/dev.md#2026-10-08-teamleader-设计入口--归属根因已确认修复验证-open)。

2026-10-10，用户提供已显示“运行图设计中”但 MCP 拒绝改图的导出。源码核对发现发送 hook 仍以 OpenClaw native sessionId 对比 Organization receipt 的地址 suffix；先前 ownership reader 修正没有覆盖发送注入入口。导出中的 generation `1`、占位 base IDs 和全零版本不足以区分具体拒绝原因，也不能证明 Run 不在 Designing。主代理未取得该次发送的实际匹配输入和 hook 结果，却把源码推断表述为现场确定事实；这是既有 P3/P4/P6/P7 与 DP-001 的执行失败，不是规则缺失。后续修复与调测须分别记录：身份解析代码是否纠正、同 trace 的匹配和注入结果、模型工具是否真正落图；不能用前两项替代第三项。

2026-10-10，后续导出已显示携真实设计凭据的完整读图成功，不能继续沿用“hook 未注入”的解释。实际 patch 分别包含 work 的 `out` 出端口、带任务 review 的 `approve` 出端口，以及未创建的连线目标；这些与当前领域规则直接冲突。MCP 端口 schema 只有字符串类型，空图没有可复制的端口示例，领域错误又被压成通用拒绝，模型因此无法纠正请求。主代理再次将“请求静态不合法”简写成“现场因此被拒”，经用户追问后澄清：请求缺陷确定，但缺少现场具体分支日志，不能断言首先命中哪条 guard。已有 P3/P4 与宪法 §14/§17 已覆盖，属于执行失败，不新增同义规则；修复落在工具说明与原校验错误的传递，不放宽 gate、不增加旁路预校验。

### Reusable rule

执行已有 P3/P4/P6/P7、DP-001、宪法 §26 与 code reviewer：沿真实 producer/consumer 核身份字段与当前产品状态，在已证明的失败边界收束最终形态并验证原行为恢复；本案不增加规则、兼容层或新的审计流程。

### Applies to

多页面消费同一权威图、同 run 并发 mutation、API producer/consumer、replace 字段保真、内容幂等与 event operation 语义核查。

### Does not apply to

独立业务投影、Goal 原生事实、未经观察的 ledger 损坏或实机结果。

### Archive note

既有规则已明确，归档只承认本轮执行及旧 review 漏查边界，保存已证明事故与修复，不建立重复规则。

## Case: TeamRun Started 但 admission 通知源已关闭

### Status

archived

### Linked pattern

DP-001；既有 P1/P5/P6 与 `CODING_CONSTITUTION.md` §26 Final-form 已覆盖，不新增规则。

### Source incident

2026-10-11，TeamRun 用户启动 bugfix：Started 后未推进执行，Chat 又把整个启动前入口隐藏，无法从原位置重开运行图。

### Symptom

启动可返回 started，但没有后续调度消费；图入口随 Started 消失。两者是后端生命周期接线与前端展示边界的不同问题。

### Surface path

Chat → store `startRun` → Organization RunStart → Started commit / RunStarted wake → supervisor → scheduler / Session send。

### Real minimum loop

同 exact team/run 启动提交后，存活 supervisor 消费 wake、派发 ready node 到原 Session owner，native terminal 回流推进图，当前 Leader UI 可查看同一运行图。

### Wrong path taken

旧接线新建无 producer 的 admission watch 并立即丢 sender；独立 RunStart 仍可成功，门禁响应掩盖了消费者退出。只保留 sender、吞关闭错误或把 Started 标为运行中，都不能补回真实 Host readiness 通知。

### Missed first probe

未沿 admission 的实际 sender 生命周期核对 subscribe → ready → reconcile → wake consumer，而把 Started 落盘与调度推进连成了未经验证的结论。

### Root cause

旧 Host owners 在创建 watch 后立即 `drop(admission_changes_tx)`；Organization supervisor 对 `changed()` 的 Err 执行 Shutdown。RunStart 独立提交 Started 并发 wake，不要求 supervisor 存活。Chat 另以 Started 隐藏整个入口，而非只隐藏启动/设计动作。[VERIFY: runtime-host/modules/organization/src/owner/supervisor.rs:119-155] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:336-379] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs:588-604]

### Root cause boundary

Host admission 通知与 Organization coordinator 生命周期接线；查看入口另在 Chat gate 投影，不是模型、图合法性或 native runtime 已失败的证据。

### Correct first-round plan

先核真实通知 producer、supervisor 退出与同 run 提交/wake；修原通知来源，再分别验证节点调度和 UI 查看，不用展示状态代替执行事实。

### Fix boundary

已核修后源码：`spawn<T: Send + Sync + 'static>(input, watch::Receiver<T>)` 直接接 HostAdmission.subscribe，删除无 producer 的 AdmissionState / input.admission_changes，不新建 watch 或转发 task；ready reconcile 与真实 shutdown cancel/join 沿原路径。Chat 用既有 gate union，Started 仅查看图；启动成功且 context 未变才自动开图。[VERIFY: runtime-host/host/src/composition/admission.rs:164-173] [VERIFY: runtime-host/host/src/composition/host/owners/runtime.rs:72-101] [VERIFY: runtime-host/host/src/composition/host/owners/runtime.rs:489-498] [VERIFY: runtime-host/modules/organization/src/owner/coordinator.rs:47-100] [VERIFY: runtime-host/modules/organization/src/owner/supervisor.rs:55-155] [VERIFY: src/pages/Chat/ChatInput.tsx:1361-1438] [VERIFY: src/pages/Chat/index.tsx:873-890]

### Verification closure

当前只确认源码修复；本轮最终检查由主代理补 [模块验证账](../architecture-knowledge/modules/team-task-organization/dev.md#2026-10-11-started-后未调度与查看图入口)。无既有 coordinator spawn 整链用例，未实测 ready → active Run → native；实机加载二进制、真实模型/终态及 UI 自动开图、重开和切 context 均 OPEN，不以构建或 Started 回读宣称恢复。

2026-10-11 后续现场证明 coordinator 已被 RunStarted 唤醒，实际失败为 `OutputPortDoesNotMatchEdge`。初版日志未记录失败 node/edge，凭 Start 仍 Ready 推断 Start 边错误属于代理执行失误：planner 在克隆图上连续推进，后续控制节点失败也会整体不提交。补充 canonical/UI/DOM/request/commit/snapshot/control-check 的 hash 与端口对照；在实际检查点记录期望值，不复制执行规则推导。后续直接读取本机应用日志确认：2026-10-11T07:25:17.920Z，runHash `cc0bfb25` 的 Start `652b04df`、唯一出边 `11dc48fa` 在真实 `control.port_check` 返回 mismatched（expected completed，actual hash ab1a365f/length 3）；随后的 `schedule.result` 为 invalid_facts。原始日志第59301–59305行完整，截断仅发生于用户粘贴。既有日志落盘规则已覆盖此场景，代理未执行而反复让用户贴日志是执行失误，不需新增同义规则。具体端口不匹配已确认，UI默认显示分支及修复后闭环仍未验证。[VERIFY: runtime-host/modules/organization/src/run/control/executor.rs]

后续只读走查确认两个独立缺陷：旧表单保留未知 sourcePort，React select 无匹配项时显示首个 option，保存仍取 state；后端 Start 缺端口约束，工具说明还指导填写 out/in。但原截图选的是 Review→End，不能作为同一条 Start 边的 DOM/state 不一致现场证据，也不能仅凭工具说明断言该次错误值的生成来源。修复范围由用户扩大并批准为所有节点的统一端口契约，不能只给 Start 加特判；实现与验证结果见模块验证账。诊断证据分层和 Final-form 规则早已存在，本次偏差属于执行失败，不另增同义规则。[VERIFY: runtime-host/modules/organization/src/run/graph/definition.rs:84] [VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:64]

### Reusable rule

执行既有 P1/P5/P6 与 Final-form：先证明真实 producer/consumer 生命周期，在原通知来源收口，业务恢复证据到真实调度和产品结果。

### Applies to

提交成功但异步消费者退出、watch 生命周期接线、启动门禁与实际执行状态分离。

### Does not apply to

未经同次执行证据确认的模型/native 拒绝，或只需调整样式的 UI 问题。

### Archive note

本卡保存已证根因、修复落点与尚未闭合的验收；现有规则已完整覆盖，不增同义 pattern，也不把归档状态当成 live 验收通过。

## Case: Goal 原生窗口 ID 被会话地址替代

### Status

archived

### Linked pattern

DP-001；既有 P4/P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，不新增同义规则。

### Source incident

2026-10-08，OpenClaw Goal 创建失败后，复查 create/catalog producer、typed error 与输入区；此前只编译收口，未验证原生业务闭环。

### Symptom

当前同一完整 identity 的 stored binding 与 native describe binding 不同，stored 等于 key suffix。旧 failedtrace 是不同会话，旧请求的精确 native 拒绝尚未确认；另有裸失败分类、输入区对齐及未证闪动问题。

### Surface path

Goal composer → Chat send/controller → Electron transport → Sessions → OpenClaw native；create/catalog → Session meta 提供 native binding。

### Real minimum loop

真实 create/catalog 返回原生窗口 ID → 同 identity meta 保留该 ID → Goal 请求/receipt 核原 native session → 权威回读到达当前 UI；失败仍保 typed 分类并本地化。

### Wrong path taken

把 `sessionKey` 地址 suffix 当 `endpointSessionId` 原生窗口 ID，漏核 create/catalog producer；又以编译通过代替 live 闭环。已有 §26 和 P4/P6/P7 明确覆盖，本案是代理执行未遵守，不是规则缺失。

### Missed first probe

未按同一完整 identity 对比 create/list/describe 的真实 ID 与最终 meta，未沿 typed outcome 核失败分类，也未取得修后 Goal/UI 现场证据。

### Root cause

OpenClaw create 投影使用 command 地址 ID、catalog 从 key 拆 suffix，真实 native ID 没有进入消费链；错误分类在前端链丢失。当前 identity mismatch 不能证明旧 failedtrace 的精确原生拒绝，也不能解释未经现场采样的闪动。

### Root cause boundary

OpenClaw create/catalog producer、Team 导航传参、现有 send error/controller 与 ChatInput 对齐；不是新 Goal owner、临时 describe 填充或通用 UI remount 机制。

### Correct first-round plan

先核同 identity 的 producer → meta → Goal binding 与 typed outcome，再修原责任边界；最后真实 Goal/UI 验收，不跨会话借证据或用编译代替 live。

### Fix boundary

create 用 result.native_session_id，catalog 从 sessionId 保存真实 ID、缺 ID 不产 mandatory public row；sessionKey 地址不变，不加 describe 填充。typed 失败保既有四类 outcome，有限 GoalError / 四语文案承接；成功合同不扩展。ChatInput 根部承担对齐。Team receipt 的历史 suffix 仍为地址，TeamChat/侧栏 role/run 三处导航已仅传完整 identity，不再覆盖 meta native ID；无 Team native effects 重构。[VERIFY: src/pages/Teams/TeamChat.tsx:175-184] [VERIFY: src/components/layout/AgentSessionsPane.tsx:1144-1164][VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:490-498] [VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:649-655] [VERIFY: src/stores/chat/send-handlers.ts:528-549] [VERIFY: src/pages/Chat/useChatGoals.ts:11-32] [VERIFY: src/pages/Chat/ChatInput.tsx:1367-1375]

### Verification closure

main 三 crate 生产 cargo check、Windows x64 Host/MCP build exit0，产物已更新；Renderer tsc/6文件 lint PASS，成功字段回收后 scoped lint 再 PASS；扩大8文件 lint 两项失败经 Team owner 内存逆替 baseline/current diagnostics deepEqual 确认为改前已有，未顺手修；该局部有 baseline，与无 baseline 的 tests 分开。Rust protocol lib tests exit101、152项编译错误未运行，含本轮4 literal 缺字段及7 deleted-field 引用，不统称旧错误。既有 send/create 7 suites 52 PASS /18 FAIL，layout 4 suites 4 PASS /29 FAIL，无完整改前 baseline，不统称旧失败；未新增或修改测试。CDP 观测/复查 ECONNREFUSED，DOM/mount/cap 样本0，闪动 OPEN。旧 Goal 未重发、未花费模型，未证明 App 重启或加载新产物；Goal 创建/管理/预算同步与 UI live 均 OPEN。最终 Renderer tsc/6 Goal 核心文件 lint/diffcheck、四语9个错误 keys 存在性检查 PASS，不代替 live；完整检查见 [Goal 验证账](../architecture-knowledge/modules/session-chat/dev.md#后续身份诊断与修复账--live-open)。

### Reusable rule

执行已有 §26 Final-form 与 P4/P6/P7：核真实 producer/consumer 身份和最终状态，修原边界并证明业务恢复；不新增规则。

### Applies to

跨 runtime 地址/原生 ID 投影、create/catalog/meta 契约、typed 失败交付与真实 UI 验收。

### Does not apply to

未经同会话证据确认的原生拒绝、无现场样本的闪动，或以构建成功推断应用已重启。

### Archive note

既有规则已覆盖，本卡仅保存执行遗漏和有界事实；最终进展复用模块验证账，不新增同义规则或长篇事故报告。后续 09:09:16Z 同次提交已确认 ID 正确而 native restart-safe admission 拒绝，具体资格子条件仍 OPEN；上轮分类日志误用未传播的 platform task-local 且 exact match 未考虑原生错误包装，已改回 OpenClaw 现有 Session trace 与 requestHash 关联，既有 describe 边界只采安全状态摘要，不重算准入或追加 RPC。后续 09:46:44Z request/rejected 同 requestHash 已证明新日志生效，完整日志的同会话 describe 可见字段未命中不合格项；继续核对已安装插件代码与同次 gateway 初始化日志，确认 memory-lancedb-pro 无条件注册的纯 debug `before_message_write` hook 构成原生 restart-unsafe 的确定充分阻断条件：权限不拦该 hook，原生只检查全局存在性。不是 session busy；未移除 hook、未关闭插件、未重发 Goal，剩余条件及业务恢复仍未验证。证据见模块验证账与 [插件 hook](../../packages/memory-lancedb-pro/index.ts#L2603)、[原生准入](../openclaw-source/src/gateway/server-methods/chat-restart-recovery.ts#L274)。编译与拒绝分类确认均不等于 Goal 创建成功。

## Case: 工作区拖动只查分隔线与录屏干扰归因

### Status

open；原始动态视觉割裂尚未闭合。

### Linked pattern

既有 P3/P6/P7 已覆盖先归属、完整链路与真实结果；不新增同义规则。

### Source incident

2026-11-01，用户要求 GPU 保持关闭，修复 Chat 与工作区左右拖动时的割裂；随后明确指出不能只抓分隔线窄条，应整体考量工作区容器。

### Symptom / real minimum loop

真实鼠标拖动 → Chat/工作区共同布局 → 页签栏、工具栏、正文与原生网页呈现一致；不能以松手后宽度正确、rAF 正常或首 Chat E2E 通过替代。

### Wrong path / missed first probe

先后把重复滚动消除、局部线条与录屏中的约 33ms rAF 当作过强依据，未先校准采集开销与完整容器的呈现链。公开 bounds 回执对应上一条 rAF 记录也不单独证明读取旧布局：回执异步与采样次序均可产生该现象。

### Observed boundary

现有无连续截帧 trace 中，107 批完整 DOM Paint 的 Grid 宽度均等于 Chat + 工作区 + 6px 分隔区，批内绘制跨度中位 0.298ms、p95 0.415ms；这只支持同批 DOM 绘制几何一致，不证明最终像素无割裂。原生网页经 DOM rect → IPC → Main → WebContentsView.setBounds，属于另一呈现面；跨面失同步仍待证。拖动不逐帧发布外壳 dock 布局，也不逐帧 resize BrowserWindow。

### Measurement correction

默认 E2E trace 同时连续截主页面与网页，混入 screencast/CopyOutput。通过现有 runner 的 `E2E_TRACE_SCREENSHOTS=0` 从源头关闭后，同样 GPU 关闭的空态、必应、example.com 完整往返，rAF p50 约16.7ms、p95 约16.8ms，trace 的 screencast/CopyOutput 均为0。旧约33ms不能再归为日常产品瓶颈，也不能由新 rAF 推断已丝滑。活跃布局区间的整窗 DrawAndSwap 耗时 p50 11.663ms、p95 16.530ms；软件 Swap 间隔 p95 21.802ms、最大64.038ms。Browser FramePresented 标记不覆盖全部 Viz swap，不能冒充物理屏幕呈现次数。

### Verification / blocker

截帧选项默认行为不变，`check:e2e` exit0；无截帧拖动为调试观测，runner130、Electron53904/launcher57368 exit0，不标正常 E2E pass。后一次基于最新 quality 工件的完整容器观测，因空态无 browser surface，stdin driver 读取 null.lastElementChild 且未及时捕获异步拒绝，exit1；这是观测工具错误，不是产品失败。Electron44408/runner57572 在故障检查时已不存在，但缺正常 exit.json 且 licensed Profile 的 .owner.lock 残留。按锁存在即 fail-fast，不自动清锁、不重跑、不请 peer 代清、不改 cache。此前 quality 正常 E2E 与本次失败严格分开。

### Fix boundary / reusable rule

本轮未新增产品修复；不凭猜测添加 ResizeObserver、线条遮罩或开启 GPU。视觉性能问题先核完整父容器、DOM 与 native 呈现边界，并校准录屏/截图/trace 开销；区分输入、布局、回执、合成与物理呈现，原始视觉目标未验证就保持 OPEN。

### Evidence

`.scratch/workspace-resize-20261101/verification-progress.json`、`no-screencast/result.json`、`no-screencast/browser-trace.json`、`no-screencast-check.log`、`whole-container/test-results/shared-electron-0/session.json`；失败 runner 输出为该 session 的 `tasks/bli4aj9t6.output`。无录屏 trace 属于 projection 构建，不能借作最新 quality 工件的整体验收。
