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

## Case: Team 正常审批意见与内嵌图片网页被内容小上限拒绝

### Status / Linked pattern

archived；DP-001、P4／P6／P7 与宪法 §26 已覆盖，不新增同义规则。

### Source incident / Root cause boundary

2026-11-19，连续实机录像中的正常中文返工意见提交后显示 `Team runtime request is invalid`，正式审批仍 pending、note 为 null；改成204 UTF-8字节的短备注后才接受。Canonical approval／Run decision 将备注限为256字节，Main 又复用身份规则拒绝换行；风险说明有同样256字节上限。另一独立失败是内嵌PNG的HTML超过2 MiB文本读取容量，阅读器显示文件过大。原流程通过缩短备注和生成轻量v02完成，不等于产品缺陷已修复；原始证据与连续MP4在 `.scratch/coffee-recorded-20261119-vwwn2ehf/`。

### Fix boundary / Verification closure

按用户后续授权，在原请求入口、canonical校验、恢复和消费者同步取消备注、风险、审批正文／材料、摘要／交付清单的小上限；保留非空、精确身份、幂等、fence与真实文件核验。文本读取在原Files→Main→Workspace→OpenClaw native链对齐50 MiB，不加binary旁路、不放宽sandbox；Matcha 既有整文件读取后才判超限的资源缺口仍保留，不能据此称两种 runtime 已对齐。下游内部Session正文64 KiB资格与YAML局部限额一并清理，保留原native／整体资源预算与用户返工额度。源码边界、原样回归失败及未部署限制见[本轮开发记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-19-team-内容小上限清理)。写前387份文件字节与增量在 `.scratch/team-content-limits-20261119-192hrinr/`；未重启应用或提交新审批，修后长备注／大HTML的真实链路未验。

## Case: Files HTML 资源补齐保留重复读取与文档提交

### Status / Linked pattern

archived；DP-001、P6／P7 与宪法 §26 已覆盖，属于实现收口不足，不新增同义规则。

### Source incident / Root cause boundary

2026-11-18，HTML 相对媒体已能在保留 sandbox 的条件下显示，但补资源读取 hook 再订阅容器已有 formats，资源列表以 attribute＋path 分组并逐次复制数组。同一 source 同时用于 img/src 和 video/poster 时重复读取、编码并消耗页面预算；编译与四张不同图片成功不足以证明复用和成本正确。

### Fix boundary / Verification closure

回到原 FilePreviewBody 的格式订阅与窄 callback；HTML 按 source 统一一次读取／编码，各引用保存目标元素及属性，不加跨预览 cache 或新资源层。真实 Chrome 生产组件前后回放为同一图片2次→1次读取，解码与空 sandbox保持；修后 noEmit／限定ESLint通过。这不是 Electron→Host 端到端验收或应用耗时 benchmark；现有测试夹具失败及当时 Host 未部署继续保留。证据与写前基线见[本轮开发记录](../architecture-knowledge/modules/workspace-files-media/dev.md#2026-11-18-停止后只读与-html音视频预览)。

2026-11-19又出现审批HTML白屏：正文与样式一致、外框正常，子文档却无正文布局；真实原生前台同文件对照确认无资源二次 `srcDoc` 提交是应用侧触发路径。一行无资源跳过恢复原文件，但未覆盖带资源文档的先显示再替换。后续在原hook收口为文档与资源准备完成后创建iframe，单请求身份隔离内容切换与迟到结果；不加刷新、重试或放宽sandbox。隔离Chrome的原四图、0次已挂载iframe属性更新及失败／切换／卸载边界通过；原实例已退出，最终结构的Electron复验未完成，不拿前一版实机通过替代。详见[生命周期收口](../architecture-knowledge/modules/workspace-files-media/dev.md#2026-11-19-html-文档准备与展示生命周期收口)。

## Case: 工作区媒体已生成，但原生附件交付仍只允许全局目录

### Status / Linked pattern

archived；DP-001、P4／P6／P7 与宪法 §26 已覆盖，不新增同义规则。

### Source incident / Root cause boundary

2026-11-18，将图片、音乐、视频直接保存到会话 workspace 后，仅凭干净包转换、语法和旧补丁测试提前肯定完整适配。用户实机两张图片已落盘、assistant 已回复 `MEDIA:`，但图片不展示、任务卡仍等待；原生队列的两项 `last_error` 均为对应图片 `could not be prepared`，随后 handoff 超时、任务 succeeded／blocked。后续日志与新截图确认终态已到 Host／Renderer，不能再把旧截图的转圈归因成终态事件丢失。

共用原生 `persistInternalMedia` 仍以 `[getMediaDir()]` 构建 managed outgoing，实际保存根已变但消费根没变。路径拒绝会清洗成附件准备失败，不能因日志不含 `path-not-allowed` 就排除；模型写路径或主轮结束也不能证明结构化附件已持久化。

### Fix boundary / Verification closure

仅在既有原生媒体补丁为共用交付入口追加同一已加载本地会话的授权 workspace，保原真实路径校验、managed outgoing 缓存和消息关联；不做 Renderer 路径扫描、任意目录白名单或 Host 搬运。检查又暴露字符串替换把目标属性当成旧属性前缀而跳过，已用完整调用锚点修正并从干净原包重打；最终明确核 builder 消费而非仅变量定义。18项幂等、101份生成 JS 与13项既有测试通过，本机依赖已替换。用户随后手动生成猫、狗两图，原生均 succeeded 且不再 blocked、transcript 有结构化 image/artifactId；助手连接当前真实界面核两卡完成、两缩略图加载，并逐一点击确认两张 1024×1024 原图经 Host 成功加载，图片回归闭环通过。未扩称音乐、视频、sandbox、Team 或旧任务恢复已验。证据及失败记录见[本轮记录](../architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-11-18-工作区生成媒体交付回归图片实机闭环通过)。

## Case: 生成媒体修改擅自增加旧补丁原位升级

### Status / Linked pattern

archived；宪法 §26 与 debugging P4／P6／P7 已覆盖，不新增同义规则。

### Source incident / Root cause boundary

2026-11-18，会话工作区媒体修改中，为适配本机已打过旧补丁的依赖，擅自加入 image／video 输出升级分支。转换幂等和原有13项测试未覆盖旧输出的生成语法；进一步检查发现重复插入视频恢复 helper。用户明确拒绝原位升级，要求重装干净 OpenClaw 后重打最终补丁。这是未经要求扩大兼容范围，不是媒体运行时需要另一套迁移机制。

### Fix boundary / Verification closure

删除本轮旧输出升级分支与模板拆片，保留单份最终转换及同版本重复 clean；工作区安全写入和恢复授权修正保留。干净原包三项转换 applied→clean、22份生成 JS 语法、3处 import 导出合同通过。未卸载或替换实际依赖、未启动或重启用户实例、未执行真实生成；静态检查不证明媒体业务通过。写前与纠偏快照在 `.scratch/generated-media-quality-20261118-rkgdvo9c/`，实际结果见[开发记录](../architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-11-18-生成媒体工作区工程复核安全写入恢复授权与干净包重打)。

## Case: Team 取消事实未结算审批与提交准入重复

### Status / Linked pattern

archived；DP-001、P4／P6／P7、编码宪法 §26。已有 owner／完整链路规则适用，不新增同义规范。

### Source incident / Root cause boundary

2026-11-19，真实 Run／Graph 已 Cancelled，审批仍 Pending，侧栏、顶部及审批记录均提供决定；三种决定被后端 Active＋Started 准入拒绝。原因是原取消事务只结算运行、图和执行，未结算审批。只隐藏入口会留下错误事实，允许继续又会改变取消终态语义。修复落在 Organization 原取消事务及原审批事件账本，Renderer 只派生处理资格并保留历史与材料。

用户随后质疑补丁式实现，定界复核发现同次提交先在面板找审批／核资格，再在 Store 入口核一次，等待布局保存后又核一次。前两次同一时刻的业务判定不能替代真正发送前的重核，只增加重复查找和维护点；面板另有 leader、runtime、互斥和重复提交保护，Store 原 mutation owner 已同步登记互斥。此次移除面板的业务重查及 Store 的前置资格副本；后续还纠正了只将 map 改提前退出的浅层精简：调用方已知 exact team/run，直接传原 `TeamDesignTarget`，删除跨 Run 反查，而不是为丢失的身份另建索引。等待结束后由 Store 最新事实唯一判断提交资格；Run 定位为直接键访问，同 Run 审批仍按现有数组查找，不冒称整条提交链 O(1)。保留呈现、权限与服务端事务各自必要边界。审批侧栏的只读投影也不再暴露无消费者的 active-Team 审批别名或选择动作，不删除仍有其他消费者的原 Store 字段。

同次只读复核还发现新增取消审批结算复用了入队前的取消请求时间；准入等待期间审批若晚于该时间创建，严格的审批时间校验会让 native 确认后的取消事务回滚。仅在原结算处按既有批量中止规则取 `max(observed_at, approval.requested_at)`，不改 Run 历史时间、不放宽模型校验；源码反例成立，未动态制造该竞态。

追加核对原公开状态 producer 后确认前端白名单仍是错误建模：`run.status` 同时承载 Graph Failed／Cancelled、runtime Unknown 和 Run lifecycle；其他分支失败／节点取消／发送未知不必终结当前 HumanDecision。按 running／waiting 白名单会误藏合法 Pending，按 cancelled 文案还会混淆节点取消与 Run 取消。原 `TeamRunPublicRun` 已有 lifecycle，但 legacy snapshot 丢失该字段。用户随后明确批准在原 snapshot 顶层补齐必填只读 lifecycle，直接序列化原 owner 事实；Main／Renderer 共享严格枚举校验，共同选择器删除综合状态猜测，也不再订阅 `runsById`。不新增查询、状态副本、状态例外或缺字段 fallback，不改原 status／审批／存储合同；新 producer、Main 与 Renderer 必须同次投递，未部署不称实际合同已生效。

### Verification closure / Archive note

修前391份字节与取消增量在 `.scratch/team-cancel-approvals-20261119-y5ltfyxr/`，质量收口前快照为 `quality-baseline.json`。真实旧 Cancelled＋Pending 的待办消失、历史只读和 HTML 正文呈现已观察；质量改动后的只读检查时原目标页面已不在当前组件树，不沿用旧截图冒充新提交链验收。实际类型、lint、既有用例及后端未部署／冷恢复未验边界见 [Team dev](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-19-取消运行的审批收口)。不把复用 helper、多个代理同意或编译通过当作业务闭环，不为显得资深另造审批框架。

## Case: Team 顶部审批与画布 key 碰撞遗留孤儿 DOM

### Status / Linked pattern

archived；DP-001、P4／P6／P7；局部呈现身份错误，不新增长期规则。

### Source incident / Root cause boundary

2026-11-18，真实素材 Run 的正式 API 仅一条 `direction` 审批且已 approved，页面却保留五个审批 `details`。只读 fiber 观察确认五者 connected=true、presentInCurrentReactTree=false；页面“待审批”文本次数包含展开卡片内状态，不等于真实审批数量。同一兄弟列表的审批与 Canvas 使用相同 `[teamId,runId]` key，React 重排时后项覆盖删除映射，旧审批 DOM 脱离当前 tree。Store 是同 Run snapshot 覆盖，不是审批累加，不能从视觉重复推导后台创建多条。

### Fix boundary / Verification closure

仅将原审批 key 改为 `['approvals',teamId,runId]`，保 Canvas、审批数据、表单及业务门禁；不增加去重、Store 或命令式 DOM 清理。本轮 Renderer noEmit 与组件零 warning ESLint 通过，字节对照仅生产一行变化；没有重挂当前工作面或触发新审批，修后真实更新／清空仍未验。原始证据在 `.scratch/team-matcha-rerun-20261118-1dnd8o3p/approval-dom-ownership.json`，写前基线在 `.scratch/team-settlement-approval-fix-20261118-7lz3fsk3/`；检查与范围见 [Team dev](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-18-顶部待审批-key-冲突--静态检查通过修后交互未验)。

2026-11-19，同一审批工作面改为弹窗和纯文件预览后，工程复核在真实 pending 审批复现“输入备注→关闭→重开”丢草稿，前轮仅验证预览返回时保备注，未覆盖弹窗卸载；源码又在 ApprovalRecord 与 TeamNodeDeliveries 重复判断文件选择、归属和就绪。收口为同 Run 的弹窗组件保存按 approvalId 隔离的备注，Dialog 仍正常卸载且只挂当前审批；选择与预览资格唯一归原交付组件，通过内容槽决定审批布局，不新建 Store、持久化或平行预览器。Renderer noEmit 与两组件零 warning ESLint 通过；修后实机命令在交互前发现用户已切回另一 Run／节点预览而停止，未关闭或改动该预览，草稿修复及纯文件视图尚未实机复验，不沿用前轮截图作修后证据。已有 §26／P6／P7 已覆盖，这是执行与验收收口遗漏，不新增同义规范；本轮字节基线及差异位于 `.scratch/approval-final-form-20261119-ube68o5b/`。

2026-11-19，用户截图再次指出统一范围遗漏：顶部待审批弹窗打开文件会收起审批说明，节点“审核记录”却仍保留说明，“输入”也保留输入配置；返回栏、当前文件标签和阅读器文件名重复占两行。源码确认前轮只在 `inDialog && previewing` 隐藏说明，文件选择仍局限于单个材料列表。此次按整个阅读区域统一到局部 `TeamFilePreview`，审批、审核记录、输入及产物共用选择／资格判定与 `FilePreviewBody` 原标题操作栏；打开隐藏原区域、返回恢复，可处理审核的原备注及决定操作通过 approvalId 呈现到区域底部，不复制状态或处理路径。正式材料与审批时间仅差 39ms，界面展示为同一秒，现按本地化展示值去掉重复交付时间，不同仍保留。Renderer noEmit、八个相关文件零 warning ESLint 通过。用户回到专用 pending Run 后，真实文件读取验证审核／输入／产物及顶部审批的单行工具栏、纯文件内容、返回焦点、备注保留；顶部审批关闭重开保草稿，1280×720、390×640、320×640 均无横溢且操作可达，临时备注及视口已恢复。首段正式 Run／审批／产物／Graph 完全等值，末段运行状态仍 waiting_for_user、审批仍 pending、业务事实和图版本不变，但图 layout 的部分位置变化，不宣称全程坐标不变；未提交审批或恢复运行。卡片直达文件键盘通过，鼠标被既有端口／添加节点浮层拦截而超时，不强制点击求通过。随后用户报告画布左偏，只读观察外层滚动为 0、内部 overflow-hidden 裁剪层为 348／94px，实际画布偏移与之相等；该容器签名在写前基线即存在，验收聚焦／自动滚入可视区可能触发，但本轮未修改该缺陷或重排真实图。沿用 §26／P6／P7，不再补同义规则；本轮基线、差异与真实证据为 `.scratch/team-file-view-20261119-fr4s_ala/`。

2026-11-19 工程收口，实机确认当前 Chromium 支持 `overflow: clip`；将缩放尺寸包装层由 hidden 改为 clip，外层 `StableScrollArea` 保持唯一滚动 owner，不加滚动监听、反复 reset、节点坐标或布局算法补偿。热更新后原内部 348／94px 立即归零，surface 与裁剪区域起点一致；聚焦 End／Brief／Start、卡片文件键盘打开及关闭返回均保持内部零滚动、适配节点完整可见。真实手掌平移只改变外层 70／35px，适应视图恢复外层零位置，正式 Run、审批、产物、graphVersion 与全部保存坐标前后等值。生产 noEmit 和 Canvas 零 warning ESLint 通过；未点击会保存坐标的“整理布局”，不把视口恢复冒充布局算法重验。之后只读抽查时外层视口已变为 441／45px，部分节点不在当前视口，整图可见断言未通过；内部仍为零、surface 与裁剪起点一致，未观察到外层变化的触发过程，未擅自复位，不归因于本修复或声称整个交互链均通过。收口基线及实机证据在 `.scratch/team-reading-quality-20261119-fcrn99xo/`。

同轮文件阅读复核又确认：普通子树与 Portal 切换会重建备注输入 DOM，保留 React 字符串不等于保留输入控件；顶部与节点审核还分别拥有同一 approval 的草稿，后者是基线遗留；卡片直达绕过列表选择，返回也未捕获目标按钮。现删除动作区 Portal 及 footer DOM 共享，审核内容槽仅按 approvalId 切换原记录的可见性和布局，备注／决定始终留在原记录；共同工作面内的 keyed `TeamApprovalDrafts` 为两入口提供唯一局部草稿，原提交锁、pending、身份和权限门禁不变。卡片直达返回仅在当前阅读区按 artifactId＋filePath 定位原文件按钮，不作全局查询。最终 Renderer noEmit 和七个相关文件零 warning ESLint 通过。实机回读时该审批已 approved、Run 已 failed，不恢复或伪造 pending；真实产物直达、列表阅读及已通过的审核材料往返均确认原按钮保留并回焦，单行工具栏 45px、审核区无横溢，正式 Run／审批／产物／图及版本前后等值。当前可编辑备注、跨入口草稿同步、多条记录及窄屏固定操作区未实机覆盖，不沿用前轮 Portal 版本的截图或保值结果证明新结构；另在真实已通过的审核材料中验证 390×640 窄屏阅读往返，原记录滚动位置 373px 返回后仍为 373px，焦点回到原文件按钮，设备指标已恢复。验收命令曾因误写无障碍名称、用 role 查询隐藏按钮而超时，另两次截图捕获超时／白图；修正定位后交互核验通过，但不宣称最终视觉验收通过。未提交决定、写节点布局或新建测试／probe／脚本；证据仍位于上述收口目录，不新增同义规范。

## Case: Team 请求结算误用后台续执行的 runId 重建发送回执

### Status / Linked pattern

archived；DP-001、P4／P6／P7；请求归属与单次执行身份混淆，不新增 Job／Request owner。

### Source incident / Real minimum loop

2026-11-18，专用素材 Run 的 brief、方向审批、production-plan 与 copy 已正式完成。images 原生生图一次成功，主轮结束后 Team 正确等待后台；媒体完成通知启动同会话执行 B，原 collector 已读到一条正式候选，但 images 一直 running、汇合未触达。落盘发送回执 A 指纹为 `f197981f`，续执行 B 为 `6aed31be`；bridge 同时携原 delivery A 与真实 native B，原 Store 报 receiptMatches=false、correlationMatches=false，随后 `invalid_terminal_observation`／`store_error`。保存证据中的150次 store_error 是同一终态重试，不是生图次数、模型 repair 次数或审批数量。

### Root cause boundary / Wrong path taken

公共 Organization 先把 snapshot.native_run_id B 送入 `accept_native_terminal_context`，按 B 重建 accepted receipt，再与已保存 A 比较；后续定位也只按 B 查原 delivery。Sessions 已补齐原请求归属与完整正文，这不是首节点 reader 再次失败；`ls launch-kit/images` 的 ENOENT、未复制原图和正文声明未完成也不能解释引擎身份拒绝。修复应使用已经证明的原 request／delivery 与原 accepted target，保留真实 B，不改 native、全局令 request=run 或放宽 Store correlation。

同日用户再次质疑补丁式实现后，对照当前调用链确认：actor 先检查缺回执，再记录 task native、再结算，每段重复解析同一归属；已 Accepted 仍经写事务重放相同 receipt，相关 helper 又刷新 Store 后重找 target。它们是已证的结构与额外工作，不是新增实机故障。收口为原终态 owner 的单一入口，一次解析返回借用 delivery／binding 与原 target／repair key，已确认路径不再做 accepted 写事务；缺回执仍沿既有只读 inspection 返回原入口重新验证，最终持久化校验不删。既有宪法 §26 已覆盖，这是执行收口不足，不新增同义规范。

### Verification closure / Archive note

原始日志、正式状态、DOM与录像位于 `.scratch/team-matcha-rerun-20261118-1dnd8o3p/`，本轮写前字节基线位于 `.scratch/team-settlement-approval-fix-20261118-7lz3fsk3/`。本案与图片交接漏原图路径、未完成却声明 completed 是不同责任；当前仅授权修前端重复审批与公共结算归属，不将后两项或旧录像冒充恢复。修正及本轮实际检查／未验范围见 [Team dev](../architecture-knowledge/modules/team-task-organization/dev.md)。

## Case: OpenClaw 结束快照与持久正文重复展示

### Status / Linked pattern

archived；DP-001。原有规则已要求 producer／consumer 与真实日志闭环，不新增同义规则。

### Source incident / Symptom

2026-11-16，同一视频 completion run 的 `session.message` 已保存 caption＋`MEDIA:` 路径，随后无消息身份的 `chat final` 只带 caption；应用最后出现两个不同文字 item，而非同一 item 的 React 重绘。

### Root cause / Boundary

Rust 终结接管要求 canonical 内容指纹全等，两个正文不同而未命中。此证据不等于原生 UI 也有相同显示故障，也不允许按 run 合并全部回复。

### Wrong path taken / Fix boundary

曾扩展 `outputs` 来源清单，但未持久的 `A → tool → B` 会被清理后尾插成 `tool → A → B`；该版未投递即按用户要求撤销，先改为单向子串匹配。用户后续明确移除结束正文接替的内容比较与终结位置筛选，故该子串逻辑也已删除；现以原身份、同 run／来源／前后边界及唯一候选决定接替；按后续授权，先仅结束正文候选匹配不因幂等 key 冲突或含工具调用而排除，再将相同放宽应用于普通缺 ID 接替：不比较候选正文，不按 key／工具额外筛选，保明确消息／流 ID 冲突、同 run／来源／边界与唯一候选，不合并两个不同 durable。中间版的 terminal 布尔开关及普通包装／provisional_matches 分流已删除，普通与结束共用单一 matches；结束选中 final 与原推断复核独立保留。因筛选删除新产生的 tool_continuation 字段和 decoder 参数已清理，不改 native 协议或 Renderer，不另加配置或状态。

2026-11-18 续案：真实日志显示 history 工具 assistant 与正式回复同时成为无 ID Final 的同 run 模糊候选，故 Host 物化第二展示项。按已知字段组合执行参考 Web 函数也可保留两项，不能据局部 helper 宣称已解释用户实际 Web 的单条结果。用户随后明确批准仅在 terminal 模糊路径排除工具续执行候选；exact 身份、普通接替及工具展示保留。

对齐中又擅加“已接纳 Final 数量决定流来源”及“history authority 仅首条＋纯文本＋多项身份条件”，两者无 Web 依据；先删局部条件仍漏 wire Final＋error authority，并保留本地 inferred 回扫／复活策略，属于既有 §26 和证据闭环规则的执行失败，不补同义禁令。本轮按完整涉及链补 per-run SDK 事实，移除这些策略；live 与 Full 分开匹配，终态物化后清流 owner，诊断恢复的投影开放与 native terminal custody 分离。保留该记录，避免将编译通过或部分路径接近参考写成完整等价。

2026-11-18 工程收口复核又发现两处实现耦合：reducer 扫描已生成 RunStarted 才反推恢复并直接修改 Body fence，Sessions 在投影后依赖 `projected[0]` 改写终态。两处属于表示与责任问题，不是另一个已实测产品故障；修正在原接纳分支直接携恢复事实、Body 原 RunStarted 消费处维护 fence、Sessions 原投影函数依据批次前事实直接生成最终事件，不新增框架、业务规则或公共协议。既有 Final-form 规则已经覆盖，仍按执行收口记录，不再堆同义规范。

### Verification closure / Reusable rule

撤回与各阶段检查记录见 Session dev；尚未投递／实机复验，原重复、诊断恢复和 Team 交错不宣称已恢复。结束快照不必等同单条物理消息；改变关联方式时须保留工具前后顺序，不能用静态或编译通过替代该行为证据。

### Applies to / Does not apply to

适用于相同 run 的无身份结束正文与持久候选接管；不适用于跨 run／跨会话去重或多个正式回复合并。

### Archive note

记录一次已撤销方案及真实失败边界，避免把未投递协议写成现行合同。

## Case: OpenClaw 视频任务已失败，状态未知且原查询误报503

### Status / Linked pattern

promoted；DP-001、P4／P6／P7 已要求双方协议与真实调用闭环，本次是执行遗漏，不新增同义规则。

### Source incident / Symptom

2026-11-16，原视频工具已返回后台started回执，真实任务已经失败／超时，聊天状态卡却显示“暂未确认”；补齐状态后，“查询原任务结果”仍只显示Host API HTTP503。

### Root cause boundary / Wrong path taken

OpenClaw history及Rust history/live的两端安全白名单都丢了taskId，原tasks.get无法补summary；仅核一端投影、编译和工件幂等不足。查询的原生明确拒绝又被Rust映射为Rejected→通用Unavailable，丢失业务原因；TS调用审计decoder也未接新operation。未读取运行响应前，不能把旧任务缺引用的静态分支当已证明现场原因。

### Fix boundary / Verification closure

两端只保最小任务引用，复用原tasks.get／ToolUpdated；固定查询仅将原生拒绝投影为闭合errorCode，原任务状态不变、调用审计仍rejected。首版真实Host SHA4e32在原超时及截图rate-limit／404任务均取得missing_job_reference，页面明确历史任务未保存云端编号，A→B→A回读再次查询通过。该版本Cargo0但守卫因残留vctip返回124／Job0，保留差异。

用户再次要求工程质量收口时，复核确认首版仍靠英文message判错，把拒绝夹在Succeeded内、让审计反查JSON。这是已有宪法§26的执行漏项，不新增同义规则。最终改为原生structured ToolResult→Rust显式VideoTaskRejected→原审计rejected，公共DTO／UI不变；同时在原owner保恢复投递目标、共用pending去重、补三协议提交事实。最终Host SHA `d5bf962156836e57cc7f3c3bf84900b2ffdceeb02f7fa60f57a5736761083990` 已投递真实profile，三条原任务按钮及A→B→A再查均保持明确missing_job_reference、原状态不变，不再503；Cargo0／runner0／Job0、2m04s、峰7.217GiB。未新收费生成、读DB／密钥或伪补job；成功恢复附件、交付中防重／原route及提交后故障不重提仍未实测，不能据源码收口称端到端已验。当前实现与完整边界见 [Session dev](../architecture-knowledge/modules/session-chat/dev.md) 和 [Provider dev](../architecture-knowledge/modules/provider-model-secret/dev.md)。

同日用户进一步要求检查全部 git status，复核覆盖当时70个 tracked／untracked 路径，而非继续只看视频。发现 Design 新请求整数校验误收紧既有 v1 snapshot／editing，会让旧小数时长记录阻断初始化；Google 自定义端点放行付费提交后，URI 收集仍只认官方 Files，正常公开产物不可达。分别在原历史解析与 Google 下载边界修正，不启动时跳过记录、不改用户数据、不重提任务，公开 URI 复用无凭据安全下载。另将任务回执复制收窄到当前 task、删除视频补丁的开发旧版本归一化块；已有原始包变换、两实际包字节与17补丁clean证明删除不改交付输出。74项 Provider／24项前端回归、Rust check、Renderer／Electron noEmit及隔离Design构建通过；Design noEmit一项Host fixture错误、Main boundary6项失败仍保留，新历史加载／URI下载和任务交错未动态验收，也未投递新Host／Design工件。完整边界见上述模块 dev；现有§26已覆盖完整读写边界，本次不再叠同义规范。

## Case: Agent 准入协议跨模块外露未被架构复核拦住

### Status / Linked pattern

promoted；编码宪法 §4／§26、layered architecture 依赖规则及 `/code` 既有入口／reviewer pass 已覆盖窄边界与复用要求。本次强化 `.claude/commands/code.md` §2.2 的证据和阻断流程，不新增架构原则或 Diagnostic Pattern。

### Source incident / Symptom

2026-11-13，用户追问 App Server 模块间实现泄漏并要求收口。保存基线中的 `Sessions::agent_guard` 返回裸 Tokio 写 guard，`delete_agent_sessions_guarded(agent_id)` 依赖调用方已持正确租约，`stable_agent_instances` 返回可分离的 guard／Vec。功能可运行，但跨模块调用方必须理解 Session 私有准入协议；这不是已证明的数据泄漏或死锁。

### Root cause boundary / Wrong path taken

问题在 Session 接口边界，不在 Tokio 调度器。已有规则明确要求正确 owner 和窄接口，但执行复核未拦住这类调用约定；旧入口与最终检查没有要求逐项提交“已有候选／具体缺口、责任链、边界约束、对应验证”的证据，不能以“分了模块、编译通过”代替。不能从本例推断所有模块都重复造轮子。

### Fix boundary / Verification closure

已在原 Session owner 以 `AgentScope` 绑定 Sessions／Agent／写租约，批删使用绑定对象；Agent 删除移交作用域，`AgentInstances` 同持集合与租约。其他资源流程未转移 owner，仍保留显式协调。check／release、既有 RPC 与真实 CLI 验收通过，但未覆盖专项批删／retire／Skill 竞态，不宣称消除所有死锁。基线、原始验证及限制见[Agent 准入收口记录](../../.scratch/app-server-agent-scope-20261113-zzuvnfs0/README.md)。

### Reusable rule / Applies to / Does not apply to

后续新增机制或改变模块边界时，在实现前查已有能力、闭合责任链、检查前置条件约束并确定验证判据；brief 交接同一边界，完成时按实际 diff 复核。无具体缺口不另建机制，opaque 包装不自动算收口，无关运行通过不结算并发主张。纯文案／样式／格式不触发，也不要求全仓重构或新增测试。规则写入与静态检查不等于未来代理已遵守，仍须任务级执行和复核。

### Archive note

此例的可复用要求已进入执行门禁，不改变故障诊断第一轮归因；归档只保留已观察边界和验证限制，不把用户对代码质量的质疑写成新增缺陷。

同日流程复核：补充 §2.2 后，用户指出指令持续增长并未带来预期的严格执行。先前称“硬门禁”的内容仍是文字约束，文档结构和示例核对也不能证明代理行为改善。现将 `/code` 收敛为单一执行路由，合并重复门禁和固定长汇报，按任务用证据验收表区分结构、行为与未验证范围。此轮未新增机器门禁、hook 或评测平台，未做真实任务回放，不宣称执行偏差已减少；已有原则清楚却未遵守时，应定位执行失败，不继续追加同义规则。

2026-11-16，请求完成归属实施再次暴露执行偏差：共享契约反复调整并扩查 cloud worker，静态讨论迟迟没有进入真实 bundle 变换；首次机器检查连续暴露非唯一锚点。用户指出推进过慢后停止扩查，集中核现有链，另确认 visible history 不能证明完整正文、owner-only context 不能继续进入原 active list。最终生产编译、22目标变换／解析／幂等及既有13项回归通过，但持久归属、部分原生续轮与真实节点结算仍未闭合，按部分完成记录，不投递。既有 §26、P1／P4／P6／P7 已覆盖，属于执行失败，不追加规则；具体证据及限制见 [请求完成归属](../architecture-knowledge/modules/session-chat/dev.md#2026-11-16-openclaw-请求完成归属)。

2026-11-17 续例：用户指出补遗留逐渐扩成改执行链。核对原始 producer／consumer 后确认，额外原生发送 busy／幂等裁决不属于原请求事实合同，已按明确要求定向删除；全局 Agent Promise 串行既牵连无关会话，也不等待 handler 内真正的异步持久化，不能代替提交边界。exec 通知正文确实只在内存、静默 task 台账无法重建，持久交接不能因此一并删掉，但借用媒体消费者后再逐项豁免工具／可见输出策略扩大了实现。收口必须保原 heartbeat 执行语义并复用原持久队列的实际消费确认，不以入内存、`captured`、单 run 结束或编译通过冒充整请求完成。复核又确认原 exec 在通知入队前先同步持久化 task terminal，单纯删除通知 custody 会暴露提前完成窗口；创建时提前 pending 只能挡住同步误判，不能恢复两步之间崩溃丢失的正文。最终复用原状态事务与 task／queue 写入能力：先沿原通知逻辑准备正文，再将 terminal task 和通知正文同事务提交，提交后走原内存发布及调度，删除无通知出口的 pending 补偿。组合变换、静态解析与既有打包回归通过，不等于真实崩溃恢复、主 AI 续执行或 Team 结算已验。同时，已消费通知不能证明仍明确 paused 的主请求成功，不以 queue 为空推导 completed。既有 §26 与 P3／P4／P6／P7 已覆盖，不新增规则；本轮修改和真实未验边界仍集中记录于上述模块 dev。

同日应用补丁后，真实Gateway与doctor均报 `Cannot access 'AGENT_EVENT_STATE_KEY' before initialization`。同款Electron Node隔离执行事件模块复现并取得堆栈：事件模块新增task重依赖，经过会话存储回到事件模块的顶层handler注册，触发尚未初始化的状态常量。parse、导出检查及13项旧回归都未执行该加载链，前轮“静态收口”不证明可启动。修复将同步观察回调绑定到原run context，删除事件模块对task的反向import，不以改var／延时／吞错绕过；三份原生工件已写入本地包，修后事件／task／真实server-start模块加载和官方gateway帮助命令通过，真实实例未重启、握手和请求业务仍未验。既有P1／P2／P6／P7与宪法§26已覆盖，不补同义规则；原始失败、改动基线及检查见[Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-16-openclaw-请求完成归属)。

同日第二次真实启动仍报 `Cannot access 'nativePluginBindings' before initialization`。原包重装＋正式 pnpm install 重打18补丁后同错，排除旧注入残留；同款 runtime 加载实际 plugin loader 复现，单独恢复原 system-events 或在内存仅删除其 task 静态 imports 即通过，单删 task→lifecycle 不足。根因是补丁把轻量队列反向接入 task／Session／provider 图，破坏原 lazy 加载边界，不能靠修改报错常量、延迟 import 或吞错修复。用户再次要求按 SDK／源码架构修正：已核外部 Gateway、进程内窄 SDK、单 run wait、task ledger 与原精确 receipt 的合同，缺口是请求级归属／消费事实，不重建执行器。最终由原通知生产方提供同步策略，队列只做原内存入队／选择／批量删除，实际提示准备复用同一策略；原 agent ownership、reset／poll receipt 和 durable exec 交接保留。另修 request 插入锚点与 World cleanup 的二次组合冲突。五份生成工件已核基线后应用，同款实际 loader／CLI registry／startup plugins／server-start／reply／chat-send 独立加载、18补丁只读 clean、既有13项回归通过；未重启实例，真实 ready／握手和请求业务仍未验。前轮局部 import 通过未覆盖实际 lazy consumer，属于已有规则执行失败，不新增同义门禁；证据见上述 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-16-openclaw-请求完成归属)。

同日第三次真实启动仍失败，用户再次指出不应让他们代试。实际拉起真实 Profile 的桌面应用后，原生日志是缺 `matcha-world-investigation.mjs`，不再是前两条 TDZ。launcher 在普通模块入口前执行 pending package lifecycle，postinstall 依据原 inventory 清理；World 生成器只写模块却未登记清单。原生清理器只读对照准确选中该文件，证明这是产物合同遗漏；前轮直接 import 六入口绕过了会改 dist 的启动前置步骤。修复只在 World 原生成器增加6行，将该模块加入原生 inventory 并沿原 updates 提交，保原清理、World 功能和其他补丁。实际 postinstall 执行成功、9061份预期文件哈希保持、18组补丁 clean、既有13项回归通过。真实应用正式启动及正常重启均到 Gateway ready／控制 WebSocket connected，设置页实际截图已看，OpenClaw running／汇总“全部正常”；应用保持运行，未真实 send、操作业务 Team、手改 DB／Profile／权限或调用 repair。整请求业务仍未验，不将启动通过外推。P1／P2／P6／P7 与 §26 已明确覆盖，本例是没有执行真实验收，不继续加同义规则；基线、失败与恢复日志、截图集中于上述 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-16-openclaw-请求完成归属)。

同日第四次回归发生在普通聊天：两个模型的三次手动发送都报 `Session transcript anchor was not returned`，并非历史 u64 工具 schema 舍入导致的上游502。新增 `agent_start` 观察回调同步追加 `matcha:request-run`／`appendMode=side`，原生索引按合同标 dirty；紧接着原 `message_end(role=user)` 复用已持久输入时，anchor reader 拒绝认证尚未重建的活动分支。实际事件序列与日志一致；现场没有完整 stack，不能在 SessionManager 两个同文抛点间进一步区分，也未证明停止 unknown 同因。最初恢复方向是将请求状态从 transcript 移至 SessionEntry；后经完整原生 owner 核查，已改为会话 `hasPendingWork` 只读事实＋本次输入有界正文区间，删除逐请求持久账本与归属传递，不修改 anchor 检查、不加重试或清库。此前只验启动未验聊天属于既有验收规则执行遗漏，不新增同义规则；本轮实现、投递与真实行为证据分别记录于上述 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-16-openclaw-请求完成归属)，未经对应验证不称恢复。

同日第五次启动前失败是 postinstall 的 `native-history-path: source anchor mismatch`，不是 Gateway 运行时错误。原包生成与新版二次幂等均过，但未覆盖实际已部署旧版：chat／worker 旧 `historyPath` 在 `isTailPage` 内，新变换只识别原包或新版位置，外层分页回包另有两处旧输出未接。Node 24.15.0 对现场源码内存变换准确复现两处首错；修复原生成器4处严格旧锚点到当前单一输出，保 seal／唯一性和未知形态拒绝，不吞错。旧5目标升级、二次幂等、语法、篡改拒绝及既有13项回归通过；按用户新授权备份并投递34份已验证原包候选工件，退出旧请求注入，正式补丁入口18组全clean／exit0。真实默认Profile应用已拉起，原生日志 `gateway ready`／`webchat connected`，正式API healthy／connected，Agent加载及设置“全部正常”截图已验；应用保持运行。未重建新Host、未真实send／Team验收，不据启动通过声称聊天或会话完成恢复。已有P1／P6／P7覆盖，此为升级路径验收执行遗漏，不新增同义规则；证据见 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-17-openclaw-会话完成只读投影--native-已投递启动已验业务未验)。

同日会话完成检视另发现：collector 将读取超时／Unknown 压成投递 `false`，原 work 已空时 observation 无主动 sync，失败集合又依赖其他事件改变 retry epoch，可能永久保留待结算首项。用户批准每次任务最多自动恢复一次后，已将额度放回原 pending 条目，读取失败主动回原 actor／observation restart／sync，再按同一 selector 重读；正文完整或失败冻结后沿原 hook 交付，Organization 以准确读取失败结算，不伪造 native Failed／空正文 repair。复核还发现外层恢复超时先于 sync 超时完成时的丢唤醒窗口，已将交付暂缓与真实失败分开，暂缓不进失败集合；关闭取消不转业务失败。本案仍只有源码／生产编译证据，故障恢复与 Team 真机未验；已有 P6／P7 和 §26 已覆盖，不新增同义规则。精确检查结果见上述 Session dev。

同日普通聊天范围回归：用户生成图片时，工具已返回但发送按钮保持停止，最终图片与回复正常返回；原图片专属 composer 限制本已存在，新增公共 `requestPending` 又将会话级后台等待扩大到了普通聊天。当前运行应用只读确认该会话 `ownership=ordinary`、runtime `done` 且无 active run／pending turn，仍有 `requestPending=true`、发送 gate 为 active；不能只凭图标恢复成发送就声称准入已恢复。用户批准普通聊天在主 Agent 结束／明确 Yielded 后可继续输入，Team 仍等待全部工作和正文交付；在原 Sessions 投影／准入收窄规则，图片复用原视频任务卡，raw work 与原观察续读保留，不改 native 执行。精确源码范围、检查及旧运行工件未投递的限制见 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-17-普通聊天后台发送与媒体任务卡)。已有 §26／P4／P6／P7 覆盖事实与策略分离及前后端闭环，不新增同义规则。

随后限定源码复核发现，新准入使原交接假设不再成立：Renderer 新提交继承上一 Yielded run，ACK 的本地 pending 接管失败，Stop 可能选中上一图片；仅清 activeRunId 仍可能从图片任务 fallback 取回旧 run。Sessions 同请求重试会在发送前重新插入已释放 run，ACK 的“不再添加”不能撤销该需求，后续新输入可能仍被挡。两者是源码可达的生命周期缺口，尚未实机复现，不能以此前编译通过或媒体完成卡可见否认。用户已授权在 Matcha 原发送／观察需求边界修复，不改 OpenClaw 源码或 Team 结算；Sessions 已在原结算处统一判据，亦覆盖前一次 Unknown 后的同请求已知确认。实施与实际验证结果集中于上述 Session dev，不把编译或源码推演当成真实交错验收。现有 §26／P6／P7 已要求完整责任链，本例是执行遗漏，不追加规则或新建状态 owner。

2026-11-18 继续收口：前次新增 receipt 禁发只在同 run idle 时临时豁免，未退休旧等待；后台续轮换 run 后旧 accepted 又能拦输入，unknown-null 的确切消费也未接回发送记录。根因在原发送交接，不在图片卡或按钮。现按原具体运行时模型解释 exact 输入消费／会话变化，`handed-off` 保单条操作身份但退出禁发，迟 ACK／unknown 不回退；收存先于执行时仍由原 submitted 等待 native 接管。queued source final 可早于真正执行，即使消费证据先到也不能凭该 final 退休 submitted；ACK Started 与 started timing 也可能仅为准入。关联失败／真实 lifecycle ended timing 在原 projection 中收口本地等待；同 ID 在途补读复用原 `refreshRequested` 合并，不加第二 owner 或轮询。前次完整链路核对遗漏属于既有规则执行失败，不新增同义规则；实际检查与未验限制见上述 Session dev。

2026-11-18 又确认公共 history 回读回归：新增内部 `work_pending` 自续条件与500ms节流，使普通发送也在无 waiter、`needs_sync=false`、已有 committed view 时持续同步。真实日志同一会话从 send 到正文提交的17.275秒内有38个不同 history 请求；既有 seq／resync、Renderer 补读与80／200分页不匹配将其放大，但不是新增持续驱动，不能归为旧版本一直如此。后续只读追到 subagent、exec、delivery、followup 与 wake 等 owner 的最后释放，确认部分正常路径没有可消费的最后事件；因此不以纯事件保证完成，也不扩大原生事件改造。用户批准将 Team 等待的状态查询留在原 Sessions observation，删除公共自续，现有事件只加速、无事件退避补查；状态读取不进入 timeline reconcile 或推进展示水位。已有 §26／P4／P6／P7 已覆盖责任隔离与完整验收，本例是执行遗漏，不新增同义规则；实现与本轮验证边界见 [Session dev](../architecture-knowledge/modules/session-chat/dev.md#2026-11-18-team-结算状态探测隔离)。

2026-11-18 真实 Team 素材场景在首节点 `brief:attempt:1` 失败，错误为 `team_message_result_read_failed`；brief 文件与合法最终回复均已生成，未进入审批或生图。落盘日志确认原 collector 已执行一次 observation restart／sync，恢复成功后仍交付正文读取失败，不能再归因于“没有恢复”。原生同锚历史共有18条，直接输入的 user 位于 seq9、最终 assistant 位于 seq18，而 `inputReceipts`／`inputConsumptions` 均为空。改前 request reader 首次只读末1条，又在分页前强制要求 root messageId，误把仅查询 `session_pending_inputs` 的可选回执当成所有输入的必备索引，因而在已有真实输入和正文时提前失败。修复边界是原 Integration 的精确输入定位与同快照正文采集，不是放宽 Organization 结算、猜取末条回复或增加恢复次数。原始材料位于 `.scratch/team-matcha-scene-20261118-2960d5g9/`，本轮字节基线位于 `.scratch/team-request-root-fix-20261118-yjmmrv13/`；源码、编译与修后真实场景分别记录于 [Session dev](../architecture-knowledge/modules/session-chat/dev.md)。已有 P4／P6／P7 与 §26 覆盖，本例是协议取证与行为验收遗漏，不新增同义规则。

## Case: Session cwd 需求被捆绑 CLI 指令源扩展

### Status / Linked pattern

promoted；编码宪法 §26、既有范围／原生能力复用原则与 debugging P4 已覆盖，不新增同义规范。

### Source incident / Root cause boundary

2026-11-13，用户追问只指定会话 cwd 为何需要修改 CLI，并要求撤回多余修改。实际 cwd 由 App Server 保存 Session.workspace、以进程工作目录启动原生 CLI 即可；此前将自动叠加 Agent 默认目录的 CLAUDE.md／imports／rules、配置目录固定和 cwd stamp 一并实施，超出“先只要 cwd”的明确范围。旧双目录指令验证通过不构成这项扩展的授权。

### Fix boundary / Verification closure

精确撤回 CLI 指令源六文件及 print.ts 对应 hunk，同时收回 App Server initialize／sleep replay 字段。CLI 恢复原生动态 getCwd，移除依赖固定 cwd stamp 的新增断言，history 恢复既有 leaf cwd 在 Session workspace 内且无重定向的校验；保留启动时目录授权、Session UUID／runtime custody、Session cwd 持久化／恢复／fork／文件绑定。print.ts 既有取消／EOF／队列修复不动，不整文件 git restore。CLI 全量 tsc 与 App Server cargo check 均通过，3GiB整树硬限、峰2.444／1.164GiB、exit0／Job0；未构建部署或重启实际应用，不把旧扩展版实机成绩当撤回后的业务证明。验证详情见 [Integration 撤回记录](../architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-11-13-撤回超范围-cli-指令源扩展)。

### Reusable rule / Archive note

先分清已授权目标与相邻增强，原生能力足够时不追加协议。撤回按完整依赖块而非目录／文件粒度，既清 producer 与 consumer，也保留原授权能力和其他作者修改；恢复原生行为不等于删除既有安全边界。此案是已有范围和复用规则的执行遗漏。

## Case: Organization 借用重构未闭合算法与增量语义

### Status / Linked pattern

promoted；编码宪法 §26 与既有单一事实／完整链路规则已覆盖，不新增同义规范。

### Source incident / Root cause boundary

2026-11-13，用户再次质疑 Organization 内部重构是否只是补丁。限定复核确认模型收敛本身成立，但借用事件校验仍逐事件扫描命令、整态历史检查仍全账本嵌套查找，Graph 在结构已验后又验一次。Decision 则新引入整 Run 临时重建／校验，并将同 Run replacement 一律拒绝；现有 producer 允许 purge 后重用同 Run／Decision ID，SQLite read_since 压缩中间删除后只见合法最终 Put，滞后 handle 错报损坏而冷恢复可接受。后者是静态调用链确认，未动态复现。

### Fix boundary / Verification closure

在原 EventLedger 按 Run／commandId 借用索引，历史按已校验连续序列比较前缀；Graph 各入口原位验结构一次，共用执行状态校验，raw snapshot 编码排序仍保留；Decision 保持单 Event 事实／单 undo／原 SQL 双记录，以既有位置／幂等索引校验变化槽位与最终序列，接纳合法压缩后的同 Run 重用，不猜中间历史、不重验未变历史。最终生产 check／build 通过；原样复用 Event11、Decision4、Workflow3项通过。未新增测试／probe／benchmark；全库测试仍编译失败，新增增量边界、内存回滚、完整SQLite、真实Profile及业务性能未验。独立基线、工件与限制见[结构质量复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-结构质量复核)。

同日后续全量精简复核又确认两处表示收敛未闭合：validate-only 为复用冷恢复逻辑构建完整 owned DeliveryIndexes 后丢弃，retry-due 实际调用；Decision 写侧由 snapshot 改为合法领域对象后仍重建 command。现同一校验返回临时借用索引，只有冷恢复成功后转 owned；Decision Row 直接借用原 command，读侧与双记录不变。三生产文件净增18行，不以减行冒充质量；生产 check／build通过，原样 Decision 源码局部重编4项通过，但不覆盖codec／Facts动态分支，完整库测试仍151项同诊断编译失败。基线与日志 `.scratch/org-quality-20261113-udmxga_d/`；临时树分配、冷恢复转换成本及真实性能未测，详见[同轮结构质量复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-同轮结构质量复核)。

2026-11-15，四处引擎修复后的限定质量复核又确认：Task inspect 先将 Failed／RetryScheduled 合并成 Rejected，再反查 Delivery 区分是否结束；续跑先生成 receipt，再按未完成 intent 覆盖重组。前者改为原 Delivery 投影扫描内汇总有效 native terminal／确定 Failed，后者先判事实分支、只构造选中 receipt；公共模型、原事务和原恢复状态机不变。生产 check／build 与 DAG 通过，但不能据此宣称四项故障行为已验收。复核中的“无 End batch”候选被真实 RunStart 完整路径校验排除，未据此修改图算法。基线与证据见[推进引擎修复记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-15-推进引擎四处修复--源码与生产检查完成行为验收未闭合)。

同日团队矩阵复验后的质量追问又暴露同类遗漏：移除全局 ActivityTarget 查询虽消除了真实多余往返，actor 仍预查 Run／binding 并解码 endpoint，领取 owner 再查相同 binding 并克隆整份 Activity。现由原 Run lane 核归属、原领取 owner 一次解析目标，借用 Run／Activity／binding 构造请求；Task inspection 共用原解析与构造，删除只用于预查的结果类型。持久化 claim 的事务再核与 prepare 后的发送准入属于不同时间边界，仍完整保留以防取消／fence 竞态；没有新增调度器、缓存、状态或公共协议。[VERIFY: runtime-host/modules/organization/src/owner/actor.rs] [VERIFY: runtime-host/modules/organization/src/owner/team_run.rs] [VERIFY: runtime-host/modules/organization/src/owner/run_scheduler.rs] [VERIFY: runtime-host/modules/organization/src/owner/task_execution.rs] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:657-759]

本次四个生产文件与 ignored flow 文档按独立基线核对，既有测试正文未改、未运行测试；最终 Organization check 为4.60秒／峰0.954GiB／exit0／Job0，29条既有 warnings，crate DAG／模块边界通过。Host 全链 check 首次触及4GiB硬限（exit125），按此前验证过的8GiB预算重验后240秒超时（exit124／峰5.247GiB／Job0）；不能拿前一版完整 build 成绩覆盖本次最终源码。未重建／部署最终 binary、重启应用或复跑真实性能，OpenClaw 取消后 exec-event 启动新 turn 的已知问题仍未修，撤回的 OpenClaw 打包补丁和严格退出等待未恢复。精确基线与原输出在 `.scratch/team-recheck-20261115-4bb9ac67/before-dispatch-owner-closure/`、`dispatch-owner-closure-*.output`。原生 endpoint 前置校验现收归领取 owner，正式调用链的校验顺序不变；直接调用 owner 的既有测试仍使用 `endpoint:one` 占位引用，不满足原生 endpoint 解码，未修改夹具或运行这些测试，不据生产 check 声称该回归边界通过。[VERIFY: runtime-host/modules/organization/src/owner/actor.rs:2420-2436] [VERIFY: runtime-host/modules/organization/src/owner/actor.rs:4049-4059] [VERIFY: runtime-host/modules/runtime-directory/src/domain/identity.rs:11-28] 这是 §26 已有单一路径／重复计算检查的执行遗漏，不追加同义规范。

同轮通知修复的独立只读复核及主侧定向源码核对还确认覆盖未闭合：实机仅证明同一输入查询内的 `user.source_tool_use_id` 回放成功；独立通知查询会使用另一输入 ID，其结果不能通过原 Active 的精确身份门。Workflow 通知未带已有工具来源，resume replacement 又可能在没有新 progress 时留下旧 task/tool 关联。三者未实机复现，不认定本轮新增回归，也未扩大为原生通知生命周期重写。标准通知在 MessageSelector 可用时被排除出初始 ACK，因此 print 的 ACK 装饰不能证明该路径覆盖；lazy selector 加载失败时现有 fallback 仍可能产生 ACK，不能据此宣称装饰分支绝对不可达。未知 task、错工具、ACK、唯一 result 和 drained idle 保护不放宽。[VERIFY: matcha-agent/src/QueryEngine.ts:100-109] [VERIFY: matcha-agent/src/QueryEngine.ts:589-623] [VERIFY: matcha-agent/src/components/MessageSelector.tsx:809-819] [VERIFY: matcha-agent/src/cli/print.ts:2348-2349] [VERIFY: matcha-agent/src/cli/print.ts:2620-2626] [VERIFY: matcha-agent/app-server/src/session/observation.rs:218-230] [VERIFY: matcha-agent/app-server/src/session/observation.rs:354-365] [VERIFY: matcha-agent/src/workflow/notifications.ts:82-87] [VERIFY: matcha-agent/src/utils/task/framework.ts:101-108]

### Reusable rule / Archive note

减少表示副本不等于消除重复工作；借用重构还须核查算法与调用频率。增量协议若只承诺最终事实，刷新层不能推测已被压缩的操作历史；利用已有连续序列／索引证明变化集，而不是重建未变事实或另加常驻框架。构建与原有窄测试不能冒充未覆盖分支的动态证明。这是已有 §26 的执行遗漏，保留事实与未验边界，不扩大成通用框架。

## Case: TeamRun 格式修复误丢可辨认文件声明

### Status / Linked pattern

promoted；编码宪法 §26 与 debugging P3／P6／P7 已覆盖。用户再次质疑补丁式实现，限定源码复核发现本反例；不新增同义规范。

### Source incident / Root cause boundary

2026-11-13，完整 JSON 已声明 `files:["report.md"]`，仅漏 `</team_message>`。正式 parser 应要求格式修复，但声明读取误用同一完整 envelope 门槛，返回 None；repair 正确保留原文件后，原结算把 None 当空列表，错误判为 `InvalidFiles`。根因在可辨认声明的提取，不是 native 文件缺失、模型改变文件或事务 proof。[VERIFY: runtime-host/modules/organization/src/run/delivery/model.rs:409-419] [VERIFY: runtime-host/modules/organization/src/owner/terminal_settlement.rs:322-325]

### Fix boundary / Verification closure

`declared_files` 复用原 `split_team_message` 提取唯一可辨认对象，严格 JSON／重复字段／路径校验保留；正式 parse 仍要求闭合，结算仍禁止 repair 增删文件，文件 proof 不变。单生产文件修改，未新增 helper／状态／fallback／测试／probe。修正版 Organization 生产 check 通过（`bjffac23d`，13.60秒、3GiB 整树硬限、峰0.953GiB、cargo0／guard0／Job0）；当前尚无该输入的动态 repair 或新 Host 部署，不能据此称完整业务已验。验证状态见[共享工作区工程复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-有界工程复核与声明解析修正)。

2026-11-18补答工程复核发现相反方向的边界分裂：新 application parser可冻结“闭合控制块后还有正文”，原 business_messages提取却拒该 envelope并清空正文；另一个独立拒结算helper对正常合法补答额外完整解析两遍。已将声明识别收回原 TeamNodeOutput 的 envelope／JSON／重复键／路径校验，拒绝归原候选 UnsafeDecision 分支；删除平行 parser与完整扫描，保跨 native await的预检／结算再核。收口后生产 Host check通过（28.60秒、峰1.903GiB、Job0），未动态跑模型repair或部署，见[补答开发记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-18-缺控制块补交与格式修复分离)。

### Reusable rule / Archive note

严格接纳与修复前保留已知事实是不同职责，应复用现成的可辨认对象边界，而非让格式拒绝抹掉原文件声明或在结算处增例外。此前正常链跑通不证明异常修复路径；§26／P6／P7 已有，本案记录执行遗漏及实际验证边界。

## Case: TeamRun 正文采集误依赖可选计量上下文

### Status / Linked pattern

promoted；DP-001，编码宪法§26与调试P4／P6／P7已覆盖，不新增同义规则。

### Source incident / Symptom

2026-11-12，共享Run工作区验收中，模型实际写入34字节report.md，UI与原生Run.result都含合法files交付控制块；nativeSeq451助手消息、455原生成功终态之后，Sessions candidateCount=0，Organization三次repair拿到空原文，产品节点failed且Artifact空。故障尚未进入文件stat／事务proof，不是模型格式或文件缺失。

### Real minimum loop / Root cause boundary

原生ACK＋唯一result＋drained idle确认exact Run结果 → Matcha read_session_run核session／inputMessageId → Sessions deliver_terminal → Organization解析／文件验证／同事务结算。原生展示消息无已证明run归属，inner runId=None不能猜补；已有exact Run结果读取却只在execution_context存在时执行，普通图和repair均无计量上下文，结果正文被错排除。[VERIFY: runtime-host/modules/sessions/src/owner/terminal.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/runtime.rs] [VERIFY: matcha-agent/app-server/src/session/run.rs]

### Wrong path taken / Correct first-round plan

构建、原生成功和四项delivery生命周期通过，都未覆盖“无计量上下文但需原生正文”的分支；不能据此提前称业务链已通。先按本次nativeSeq／Run串现成日志，分别核终态状态、正文来源及业务Artifact；不用放宽parser、删除files或从当前active／outer run／正文相等猜消息归属。

### Fix boundary / Verification closure

只在原Sessions deliver_terminal将合法空正文的exact Run读取与计量enrichment分开，保Session／Run／phase／已知request／message校验、Some(empty)与完整性失败None区别；不改展示消息、公开DTO、原生协议或Organization结算。修复窄静态回核完成，首Hostbuild停在并行Organization模块删除中间态；冻结后完整构建cargo0／guard0／Job0，4分12秒、整树峰7.185GiB，已按原lifecycle切入真实Profile。新Run启动前另遇Renderer浮点布局与native整数合同冲突，已在原布局producer量化自动坐标并正常保存，未绕门禁。真实新Run两会话各一次native succeeded、无repair，四节点completed，snapshot候选0→Organization dequeue候选1，两次分别49／67ms settled；两条Artifact同report.md保各自attempt／rs0、rs1。较早交付预览当前最终47字节“初稿＋复核完成”，正常冷重启后根／绑定／Artifact身份与fence／文件SHA保留，正式API与旧交付预览再通过。本案正文消费故障已闭合，不外推为全runtime或故障矩阵通过。真实闭环与最终状态见[共享工作区验收](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-teamrun-共享工作区与文件交付关联)。

### Reusable rule / Archive note

执行既有完整链路原则：业务结果的必要输入不能隐含依赖可选审计／计量metadata；已知状态不等于正文或产物已消费。本案只保留实测反例与正确owner，不将短期失败堆成新框架或长期规范。

## Case: 返工挂起快照遗漏后续执行生命周期

### Status / Linked pattern

promoted；宪法 §2／§26 与 debugging P3／P6／P7 已覆盖，属于完整生命周期验收遗漏，不新增同义规范。

### Source incident / Symptom

2026-11-12，用户质疑预算改造是否补丁式实现。合法 Graph 事件回放确认：返工耗尽冻结 scope 后，范围内已运行的 X 仍能完成并激活范围外 Y，Continue 重开 X2 后 Y 仍消费旧 X1；另一次 trigger 为 batch2，动态新增节点却初始化 batch1，连线成功但永不激活。[VERIFY: runtime-host/modules/organization/src/run/graph/reducer.rs] [VERIFY: runtime-host/modules/organization/src/run/graph/rework.rs]

### Real minimum loop / Root cause boundary

原 Graph reducer 完成节点 → 挂起出口／冻结影响范围 → 接收其他在途结果 → Continue；原 GraphPatch 新增节点与边 → 当前批次上游完成 → 激活新目标。两条失败均可在生产同款库的合法事件与逐步 durable 等值恢复中复现，不是 UI 刷新或 native 通信错误。

### Wrong path taken / Missed first probe

只验证“挂起已保存、Continue用了原scope、Activate检查同batch”，未验证冻结期间哪些新工作仍能产生，以及运行中改图如何延续真实批次。临时重算 Continue 范围会改变已批准边界，全局最新 batch 又会混淆独立任务；两者都不是正确修复。

### Correct first-round plan / Fix boundary

在原引擎统一读取 blocked source/scope，停止新调度／注册／claim／审批，已 claim 的结果真实保存但不再向下路由；Continue保原scope，Gate保实际已路由收据。动态新非Start节点先Pending，连入流程时由未执行分量的实际来源唯一继承batch，冲突整批拒绝；不新建暂停状态、调度器或第二图。[VERIFY: runtime-host/modules/organization/src/run/graph/state.rs] [VERIFY: runtime-host/modules/organization/src/run/graph/patch.rs] [VERIFY: runtime-host/modules/organization/src/store/durable.rs]

### Verification closure

当前生产库编译通过；公开Agent/control planner同输入对照已证明挂起范围不再被选择、独立工作继续，直接启动拒绝、Continue原范围与计数不变。原A/B及扩展回放、既有测试与未验范围以[本轮记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-挂起生命周期与动态节点批次修正)为准，不把Graph回放等同private SQLite claim事务、native或完整桌面验收。

### Reusable rule / Applies to / Does not apply to

规则已有且明确，本次承认未完整执行。下次在入口与reviewer pass同时核冻结事实、后续新执行资格、在途结果、恢复边界和动态拓扑，不能以单次终态或编译替代时序验证。适用于范围暂停／恢复、批次化工作流和动态改图；不要求静态图、文案或布局修改引入状态框架。

### Archive note

通用归因与final-form门禁已有，只保留反例与修复落点；未修改长期规范或harness配置。

## Case: Team 终态容量限制误作跨会话交付互斥

### Status / Linked pattern

promoted；DP-001，编码宪法 §10／§26 已覆盖。属于实现检查遗漏，不新增同义长期规则。

### Source incident / Symptom

2026-11-12，聊天终态隔离修复仅让普通会话绕开 Team 单预算；用户追问后确认同一及不同 TeamRun 的成员会话仍互相等待。远端事故没有现场日志，不将源码缺陷认定为唯一现场根因。

### Real minimum loop / Root cause boundary

原生终态 → Sessions identity lane → 留存结果并发布状态 → 正文补读／hook 接纳 → 清理 pending。全局单份 permit 覆盖整个慢交付，唯一 worker 顺序 await；把防积压与执行互斥合在一起。单项 hook 失败还会终止公共 worker。普通会话分支绕行只缩小影响，未消除 Team 会话间的等待。

### Wrong path taken / Missed first probe

将“普通终态已不受慢 Team 阻挡”当作整体 final-form 收口，未以同 TeamRun 不同成员、不同 TeamRun 的慢 A／快 B 交错检查独立性。编译、普通分支通过及单件重试均不足以证明跨会话交付隔离。

### Correct first-round plan / Fix boundary

在原 Sessions owner 内统一终态入口；以逐结果容量保留 queued／running／failed custody，不再以一张票覆盖所有会话。不同 identity 独立推进，同 identity 队首保序；成功确认才释放，失败只保本项。满容量仍背压，不能用无限 pending、无限 spawn 或假设 native 自动重放来换“无锁”。下游接纳与业务持久结算分开，不借此变更 Organization 合同。

### Verification closure

旧二进制回放再次证实第二 Team 等单票；本轮源码、独立交付、容量与关闭验证结果单列在 [交付隔离验证](../../.scratch/chat-terminal-20261112/parallel-delivery-validation.md)。未部署或远端实机验证，不以模块回放声明现场恢复。

### Reusable rule / Applies to / Does not apply to

执行既有 §10／§26 与 P3／P6／P7：reviewer pass 同时核容量、顺序和失败域，分别验证同 key 与跨 key。适用于结果交付、异步补读及多会话接收；不要求把共享事务改为无锁，不承诺有限资源在任意积压下绝对互不影响。

后续端到端只读审视确认：Sessions 交付隔离不等于全链路隔离。Matcha 启动／Agent 控制、Organization Global／Exclusive、Provider 模型解析和 Electron 重连仍有不同等待域，不能把模块验收外推成整体完成；OpenClaw 控制读又确实依赖前序工具／epoch 事实，机械拆锁会漏取消。按原 owner 的登记／执行／核实提交边界分别整改，实施、验证及保留的必要顺序见[全链路执行记录](../../.scratch/chat-terminal-20261112/end-to-end-execution.md)。该记录未收口前不构成修复完成证明。

实施复核另发现：仅把 native await 挪到 keyed lane，再持同一 resident permit 通过普通 mailbox 回 Global，仍可能在满准入下自锁；必须同时核“执行中占有什么、提交还需再取得什么”，不是看到锁已缩短就算完成。Team 删除原按 Run 无界创建任务也不能借 dependency 的64项上限声称整体有界。最终返修直接在原 keyed store 核原意图提交，删除三条自发准入 command；TeamSkill begin／settle 恢复原 CallReply，保留未知提交审计。Team 删除以64份随 pending cleanup 留存的容量和每 Team 一份四 Run 滚动 batch 收敛，原回流／proof 不变。返修后联合生产 check 通过、三项窄静态复核未发现新的可达缺陷；Organization 测试编译仍被四处未改夹具错误阻断，慢 A/B 与实机未验，不以静态复核或编译代替行为证据。Matcha 后续复核确认关闭顺序与新目标 Provider 在途冲突后，停笔快照又核出两个新增关闭回归：预算等 guard 不再响应 stopped，可能与持 guard join executor 的删除互等；两个 close 夹已排 resume，前置 Closed 被 Open 覆盖，而后一个 close 拿锁后不重核却返回成功。原 writer 合批收口到原 guard／意图块，独立静态回核两条反例均已封住，最终 app-server 生产check通过；具体时序证据不是运行复现，慢A/B、实机与完整故障恢复仍未验，不以编译提前宣告整个链路恢复。不新增同义调度规范。

### Archive note

通用规则已明确，偏差是未核完整并发边界；这里只保留可追溯案例，不把本次实现细节升级为全局调度规范。

## Case: 图保存状态沿输入贡献包装扩散到聊天外壳

### Status / Linked pattern

宪法 §20／§26 与 debugging P3／P6／P7 已覆盖；属于迁移时遗漏实际 React 祖先链，不新增同义规范。

### Source incident / Symptom

2026-11-12，用户报告移动 Review 卡片像整页刷新。实机确认拖动中局部更新、document 和 Canvas 身份不变；松手保存却使聊天／产物／工作区壳各重算 4–6 次。`TeamComposerActions` 的设计状态订阅位于 render-prop 包装链上，调用 `children(content)` 重新构造整片展示，而非独立输入内容。

### Fix boundary / Verification closure

composer-content 改为输入区内的叶子贡献，删除 wrapper 回调契约，lazy 加载用局部 Suspense；保留共享互斥、事件及权威回读，不靠减少更新频率或 memo 遮掩。真实同条件四次拖动及函数入口断点复核，保存时四个壳组件调用为 0；坐标刷新回读、草稿保留、成员只读通过。但开发版仍有保存尾部停顿、两项既有检查失败，不能宣称整体性能达标。详见 [本轮证据](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-图保存带动聊天外壳更新)。

同日用户继续报告画布跟卡片抖动。真实几何复现发现，拖动越原点时点阵未随同坐标补偿；取消后内容右／下边界回缩夹紧 scroll，静止节点跳约 84px。原点完整 extent 与点阵收口后又测出约 2–3px 小数滚动取整漂移，按缩放对齐屏幕像素后 100% 同手势静止节点／点阵／取消回位均 0px，约 83% 条件交叉复验最大点阵误差小于 0.11px。Store 将图 patch action 的观察刷新统一到结算回读，最终设计快照两次降为一次；结算中迟到事件仍丢旧重读，不能为“一次请求”漏更新。Canvas 以最终坐标而非草稿／canonical 来源触发几何，保存阶段同坐标 route 调用八次降为零。四次真实往返保存无整图跳动，恢复当时实时基线；开发版仍有约 50–67ms 保存帧尾，不宣称全部性能问题解决。用户随后圈出按钮同步灰显再恢复：共享 mutationPending 正常互斥，却被各入口的 disabled opacity 表现为整片闪动；这是几何采样遗漏的可见状态变化，当前未修，不能以节点／点阵 0px 代替全界面视觉验收。[续案证据与未验范围](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-位置保存重复发布与画布抖动)。

### Reusable rule / Applies to / Does not apply to

同日布局保存续案：纯坐标在原 Store 保留每 exact-run 一在途 batch＋按节点合并的最新 pending，业务 flight 先登记再等布局；不删除顺序保护，也不改 CSS 掩盖 disabled。Canvas 仅交接草稿，旧 ack 不清新手势，失败保留位置并局部重试。真实保存采样中五个按钮始终 enabled／opacity=1、静止节点0px；前次 saving 时再次拖动成功，实时原坐标已权威回读恢复。开发版最大保存帧间隔约83ms，Store既有套件10通过／24失败（含旧 scope 精确断言失败后未释放回执，新增删除 admission 使后续串扰），不宣称整体最优或回归全绿。补充反证还发现明确 `graph_version_mismatch` 后冻结旧版本会让重试永久失败；仅此确证拒绝归回 latest pending、显式重试生成当前版本新请求，未知提交仍原请求重放。两种时序已分别回放，未改 native guard。完整范围见[后台布局续案](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-布局后台保存与按钮灰闪)。

用户再次质疑后，复核同类 stale epoch/base 仍永久重试旧上下文的反例，暴露了只修 version 的特判遗漏。恢复现统一为 typed `context-stale`，batch 显式 `unconfirmed/outcome-unknown/acknowledged`，未知结果不被后续拒绝降格；八组真实 Store 源码回放覆盖新旧上下文、latest及未知重放，不改后端合同或增加通用框架。独立 Canvas 复核另确认只读主动整理被失败保存覆盖盖住，已在唯一坐标合成处提升本地只读视图优先级，保存意图不变；实际 Canvas 内存运行覆盖整理、后续保存刷新、回编辑及换 scope，未实机注入失败。[本轮复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-布局恢复模型工程复核)。

2026-11-13 完整链审查进一步确认 unknown 跨设计阶段／epoch 时，native 先 guard 后 ledger，使已提交请求也无法确认；此前 Renderer 保守保原请求不能独自解决。现原 SQLite 事务先核 exact Run 归属与原 ledger，MCP generation 授权仍前置，只有 ledger miss 后的设计阶段／epoch／version 拒绝才可释放旧 unknown 合回 latest pending。真实隔离 SQLite 跨 Intake／新 epoch／Started／重开验证 replay 不写 records／epoch，Store 实际源码＋IO 替身验证已提交／未提交两分支，其他 unknown 不放宽。同轮修复合法原型名 ID 字典与安全整数坐标边界；[三处修复证据及失败／未验范围](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-运行图三处审查修复)。既有 P3／P6／P7、宪法§26已覆盖，不新增同义规则，不能把模型内回放称为实机故障闭环。

用户继续追问画布全部操作是否已极致隔离，实机只读采样反证：标题／提示词各输入6字符，Canvas函数各执行12次、三卡片渲染逻辑共36次（开发StrictMode，非DOM提交数）；11字符的原生measures同时见滚动容器与添加节点控件各11次。四聊天壳、Panel和侧栏在配置输入期间0次，说明外层隔离不等于内层已收敛。保存的独立往返则ComposerActions8次、团队侧栏2次；源码归因是父Canvas持全部配置草稿、卡片直接map JSX，及整record订阅／回读新建列表投影。按原§20／§26继续在真实owner收敛，不新增同义规范，不因大型文件机械切分。[本轮性能边界与证据](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-配置输入与拖动更新范围收敛)。

同次授权重构后，表单草稿与异步生命周期收归独立Editor，父Canvas旧路径删除；默认memo卡片使用原node事实与独立坐标，事件读取最新已提交handler，原路由按上一份候选／障碍依赖增量失效。Store同值共享另暴露隐式freshness耦合：迟到list原靠引用变化识别新snapshot，现需在原flight分别记录run/list roles/active roles接纳，null角色事实不能保Run或冒充list更新；该反例已由真实Store回放闭合。主侧内存真实Canvas中逐字符输入父画布／卡片0调用，中央拖动静止卡片／Palette0；几何7,808组oracle差分通过，但全节点移动有额外成本。真实后测因最终重载期间原CDP target关闭、9222不可达而未完成，未重启或补写坐标；类型／lint／Canvas19项通过，Store仍10／24，不能称实机零扩散或整体性能完成。详细负载、失败载具与未验见[本轮续案](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-配置输入与拖动更新范围收敛)。

后续只读实机已补证：标题／prompt各6字符，父Canvas、卡片、Panel、Composer、侧栏及四聊天壳0调用；中央12步触摸取消仅移动卡片执行，两个静止卡片0，配置／位置均恢复。该样本为3节点／0连线，不覆盖复杂图。完整同内容graph回读的独立实际Canvas回放仍使三卡片各执行2次；父Canvas也仍逐边构建path／SVG，说明路由引用增量化不等于呈现增量化。这两项已分别在原Store完整接纳与默认memo连线叶子收口，保全部字段／同team-run-graph作用域、原几何和交互，不另建缓存或图owner。主侧真实“刷新快照”确认新snapshot已接纳、同值graph／nodes／edges引用保留，全部卡片0调用；20／8位置往返保存各发布1份设计快照，仅移动卡片执行，外围0、原坐标权威回读恢复。独立无断点四个小图保存窗口最大帧约16.8ms、五按钮不灰、静止节点0px；未有严格同条件改前时延，不报提升倍数。三边实际Canvas内存回放确认只变route的边重建路径，hover／selected只执行旧新边；这不是复杂图实机或生产证明。类型／lint／Canvas19项通过，Store仍10／24，整体未全绿。[后续证据与本轮结果](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-图快照共享与连线呈现边界)。

### 2026-11-13 整页复核：提交与观察不能共用失败结论

此前已记录却未修的反例由真实 StrictMode Node／Edge Editor＋Canvas patch builder＋Store 再现：写入接纳，后置 Run 读取失败，成功回调为0；再次保存仍以新 commandId 发送同 ID 的 add 并被拒 duplicate。不是草稿缺少局部 duplicate guard，也不是 native 写入失败。原 client 对设计快照／运行 `success + saved + available` 严格解码，Store 为普通图 patch 显式采用写入确认完成条件；回读继续发布原记录错误，开始／退出／返工等仍要求原回读完成。未把命令未知解释为成功，也不在两个 Editor 重复吞错。

同轮空图反例是视图直接标 ready、实际 readyScope 却因零节点跳过；现空／非空图共用布局和尺寸就绪条件，删除特殊 ready 分支，不新增 viewport。修改与限定验证、既有回归失败及实机边界见[提交与视口复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-提交完成与空图视口的工程复核)。DP-001／P6／P7、宪法§26已覆盖，属于遗漏完成语义与空输入生命周期，不新增同义全局规则；历史非法边补入真实端口数组的几何风险未修，不能称整页缺陷清零。

局部状态的责任边界要看实际 React 祖先、render 回调和权威回读后的引用，不只看 Store selector 和文件归属；先区分重载、重挂、render、DOM 和呈现，再用 profiler 与原操作复验。适用于状态化插件贡献／render-slot 的交互迁移，不要求普通内容机械拆组件，也不把 React 开发采样当生产性能。

## Case: TeamRun 技术标签被当成正式标题

### Status / Linked pattern

promoted；debugging P3／P7 与宪法 §26 已覆盖，属于代理未完成生产者链核对，不新增同义规则。

### Source incident / Root cause

2026-11-13，用户指出侧栏和运行图出现 `teamrun-… · leader · rs0`。初答只核两处是否关联同一 Leader，后又把 Renderer 缺省 `titleSource:'none'` 误当 native 未命名证据。实际 Matcha Team confirm 调用 `sessions.rename` 持久化技术 title，经 catalog.label 共同显示；该显式 title 还阻止首个真人 ACK 的 AI 命名资格。公共 catalog 没有 native 标题来源，none 不能用来全局丢弃 label。[VERIFY: runtime-host/integrations/matcha-agent/src/team/native_effects.rs] [VERIFY: matcha-agent/app-server/src/session/title.rs:24-54] [VERIFY: src/plugins/chat/store/session-actions.ts:645-669]

### Fix boundary / Verification closure

删除 confirm 技术 rename 与标题等值条件，保留 existing get／create 后 get 的 identity／Agent／workspace／open 确证，工程复核再删除 rename 遗留的无副作用重复 get。共享 Chat catalog 对已知 Matcha team ownership 的精确技术模板作占位判定，manual／user 与其他正式 label 保留；两 UI 继续复用 Leader 标题，不加各自 guard、不改旧 native title／attempt。48项无落盘内存断言覆盖正式 none-source 名、手动名、displayName、user fallback、peer／ownership／缓存变更及同值引用；原登录实例打开已有活动 Run，侧栏和图标题均“新会话”，无创建／rename／模型消息。Renderer noEmit、限定 ESLint、integration cargo check 与 diffcheck 通过；既有22项仍13通过／9失败，与改前相同。未构建或部署新 Host，未创建新会话实测 producer，旧 attempt 不重置，不称自动补标题已恢复。

2026-11-13 工程复核又发现删 rename 后残留纯重复 get，并在原 Profile 观察到技术名过滤后 user-item 回退把 `<teamrun_message_repair>` 指令显示为标题。前者删冗余往返但保 create 后权威回读；后者在原共享回退对齐 native XML prose 判据，不逐标签加黑名单、不改正式名／manual／OpenClaw。原始7条Leader displayName均null，native view也不从显式title复制，未因静态可构造输入扩大displayName过滤。独立复核的U+FEFF反例用Unicode White_Space收口，42＋62项内存断言与原Profile侧栏／图标题通过；Rust12场景业务断言通过但guard附属进程清理超时exit124，未计整次验证通过。最终cargo check通过，既有测试仍13／9，部署／新建验收仍未做。具体边界见[工程收口记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-标题链工程收口)。本案已由P3／P7／§26覆盖，不把必要的旧数据展示补偿伪称纯终态，也不为去掉它越权迁移会话或扩大公共来源字段。

## Case: 团队工作区迁移保留页面中转与选择耦合

### Status / Linked pattern

promoted；宪法 §26 与 debugging P3／P6／P7 已覆盖，属于代理执行未遵守，不新增同义规范

### Source incident / Symptom

2026-11-11 至 2026-11-12，团队创建与图编辑迁入聊天工作区后，用户再次质疑补丁式实现。首版仍从侧栏导航到旧团队路由再回聊天，工作区 wrapper 导入旧页面组件；图绑定 exact run，运行详情与审批却仍读取团队当前选择。

### Real minimum loop / Root cause boundary

`团队创建／侧栏选择／审批入口 → Teams 导航 → Chat 完整 SessionIdentity → Workspace page → exact run snapshot／原 mutation → Organization`。问题是入口和读取粒度未一起迁移，不是缺少通用工作区框架；仅给部分动作补 runId，不能证明整个面板已隔离团队选择。

### Fix boundary / Verification closure

在原 Teams 导航中统一打开真实运行会话，删除独立路由与旧页面；图交互直接归工作区组件。原 Store 快照在途读取按 team/run 合并，按 run 发布运行与审批投影，只有仍为当前选择时更新团队级视图；创建成功传递本次真实 runId，删除后的迟到读取不能回填。实现与最终验证状态见 [Team Dev Notes](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-12-团队入口与工作区运行图)。静态结构收口不等于真实创建、持久化编辑或启动验收。

### Reusable rule / Applies to / Does not apply to

既有 §26 在入口冻结和 reviewer pass 即应检查入口、组件归属、读取与 mutation 是否采用相同实体身份，并确认旧 active path 已退出。适用于页面迁入工作区、保留页签及异步选择；不要求局部文案修改扩成框架重写。规则已有，本次只保存遗漏证据。

## Case: Markdown 粗体兼容只覆盖汉字相邻

### Status / Linked pattern

宪法 §26 与 debugging P3／P6／P7 已覆盖；属于边界覆盖不足，不新增同义规范。

### Source incident / Symptom

2026-11-09，用户真实聊天截图出现 `**检索口径：**GitHub`、`**关注理由：**OSINT` 原始星号；相同标签后接汉字却正常加粗。

### Real minimum loop / Root cause boundary

`TextPart → AssistantMessageBody → assistant-markdown-body → md-pipeline → markdown-it`。真实生产公开渲染入口复现两英文相邻输入不生成 strong，加空格后生成。标准解析器亦受强调标点边界限制；已有 `cjk_strong` 仅放宽 Han 相邻，不是业务文案匹配，但仍是语言特例，不能支持完整混排结论。

### Wrong path taken / Fix boundary

以单一文字类别样本代替语法边界覆盖。修复落在原共享 parser：用语言无关的双星标点边界规则替换旧 Han 特例，保留 native 配对、嵌套、转义与代码边界，不在正文清洗层替换字符串，不更改消息原文或原生协议。

### Verification closure / Reusable rule

本轮结果及未验范围见 [验证记录](../../.scratch/markdown-strong-20261109/validation.md)。既有 §26 和 P3／P6／P7 在 bugfix 入口及 reviewer pass 应触发：按定界符、空白、标点、文字、代码与转义分类验证，不按业务词穷举；此规则不要求普通文案改动扩大成解析器改造。

## Case: 隐藏恢复输入造成聊天展示分界不一致

### Status / Linked pattern

promoted；宪法 §26 与 debugging P3／P6／P7 已覆盖，不新增同义规则

### Source incident / Symptom

2026-11-09，用户真实 OpenClaw 截图中工具呈1/2/2与10/1/2，仅末两工具进入过程摘要，恢复分界却不可见。四条 native internal_system 恢复 user 在 Renderer 清空，presentation 与 work 各自解释边界。旧组件通过不证明该真实输入已覆盖。

### Real minimum loop / Wrong path taken

只读原生DB → Rust解码／wire正文 → Renderer投影 → presentation／work → 实际ChatList。最初建议跳过隐藏user合并5／13工具；核本地OpenClaw Web后撤回：恢复notice默认startsTurn=true，应显示分界，不合并不同恢复执行。公共wire未保留provenance，本轮只复用现有精确prompt识别，不冒充严格来源判断。

### Fix boundary / Verification closure

清洗前投影本地恢复notice；presentation统一展示组及计时，work消费而不再自行划界。修复mixed tool run计时回归与跨notice复用input的串时反例，保留内容规则和结构共享。owner16项、独立组件12组／53断言通过，200×3历史额外render／commit为0。真实桌面确认四条原key通知、两摘要交互、图片不隐藏、正文／草稿不变；未发消息或启停runtime。记录与限制见[修复验证](../../.scratch/chat-boundary-20261109/validation.md)。

### Reusable rule / Applies to / Does not apply to / Archive note

可见性与分组必须在同一展示owner解释，消费者不能再按未投影身份重划边界；引用上游须核其实际notice与turn规则。适用于消息清洗、系统通知、派生分组与计时，不要求普通文案变更扩查native协议。已有规则足够，修正执行与真实样本覆盖。

### 后续：来源启发式收口（2026-11-09）

用户再次质疑补丁后，复核确认精确prompt识别仍会把真人同文当系统、受系统措辞变化影响；此前Final-form结论超出了Renderer分组收口范围。用户批准后，恢复来源在原生统一decoder分类，以窄typed notice贯穿原UserMessage/view/delta/严格解码，Renderer才转system，删除恢复reader及清洗引用。不把公共item提前改System：Body内部正依UserMessage划terminal/tool边界，不能为展示来源改变执行身份。另补display signature遗漏notice，reconciliation原已包含。规则§26与P3/P7已有，属于执行失败，不新增同义规范；本轮证据与限制见[来源链验证](../../.scratch/chat-origin-20261109/validation.md)。

## Case: 过程折叠复核遗漏耗时归属与历史行渲染

### Status / Linked pattern

promoted；宪法 §26 与 debugging P3／P6／P7 已覆盖，属于代理执行未遵守，不新增同义规则

### Source incident / Symptom

2026-11-09，公共过程折叠内容回放与交互通过后，复核仍以局部 diff 宣称没有结构性问题。完整走读发现摘要直接借用更宽回复组耗时，以及每次重算全部 work 对象使历史消息 memo 失效。

### Real minimum loop / Root cause boundary

生产 `buildThreadPresentation → buildThreadWorkPlan → ChatList → ChatAssistantTurn／Parts`。两个 lane 各1秒、中间9秒，第二摘要误显示11秒；实际 React 的200个历史区间经历3次尾部delta，历史 ChatItem／ChatAssistantTurn 各600次 render／commit，变化的 prop 只有 work。测量位于隔离组件，不等于完整桌面性能基准。

### Wrong path taken / Missed first probe

把“当前行有可靠 finished timing”误认为“该耗时属于当前折叠区间”；检查内容正确性、DOM保留和滚动，却没量流式更新时未变化历史行的真实渲染。读取局部 diff 不足以支持整体收口结论。

### Fix boundary / Verification closure

在 Renderer 分组 owner 按原生 run／input 身份确定区间耗时；已提交结果仅用于输出结构共享，折叠资格每次重算，不能恢复成功事件账本。ChatList保留同identity提交边界，footer仅在本组摘要已显示相同跨度时去重。实施及本轮验证结果见 [Session Dev Notes](../architecture-knowledge/modules/session-chat/dev.md) 与 [修复记录](../../.scratch/chat-work-fix-20261109/validation.md)，不沿用旧轮通过数作新验收。

### Reusable rule / Applies to / Does not apply to / Archive note

已有§26与P3／P6／P7在入口及 reviewer pass 即应触发：核聚合输入的实际归属和热路径消费者，不以函数引用检查或编译代替真实渲染测量。适用于派生展示分组、计时聚合与流式列表；单文案修改不要求性能实验。规则已清楚，问题是未执行，不修改长期规范本体。

### 后续：历史缺计时与原生口径反证（2026-11-09）

真实daily-weibo摘要22工具、16assistant同run，列表未获runTimings；原生sessionInfo缺计时字段。最初据数据库trajectory起止推断“适配可补回”，但实施前追producer发现trajectory记录attempt准备／延后收尾时刻，非实时agent/lifecycle起止，不能以其363751ms替代run耗时。当前Gateway的agent.wait仅10分钟内存；trajectory无已注册RPC，CLI tail不提供run精确metadata，export会写整条会话。保持原生协议与禁止直读数据库的边界后，本轮没有合法同口径持久来源，停止实施，不加Host影子计时或上游补丁。此前“只是漏接历史”的结论过强，应改为历史计时能力缺口、原生producer受阻。[VERIFY: runtime-host/integrations/openclaw/src/session/window/history.rs:443-461] [VERIFY: runtime-host/integrations/openclaw/src/session/protocol.rs:3544-3558]

已有§26与P3/P4/P6/P7足够，属于producer核查与结论校准未遵守，不增同义长期规则。下次在入口与reviewer pass同时核实时／历史的事实源、时间口径及合法读取能力；相同runId不证明不同记录事件的时刻可互换。证据与停止边界见[本轮调查记录](../../.scratch/run-timing-unified-20261109/validation.md)。

## Case: 侧栏启动分区的隔离验证遗漏真实启动窗口

### Status / Linked pattern

promoted；DP-001 与宪法 §26 已覆盖，属于执行遗漏，不新增同义规则

### Source incident / Symptom

2026-11-08，隔离侧栏交互已通过、复核仍报告未发现问题；用户随后在真实启动截图指出只有 OpenClaw、没有 Matcha Agent，状态依次跳变。

### Real minimum loop / Root cause boundary

真实自动启动调度 → prepare → 进程与连接 ready → Directory → 双 runtime 分区。前轮仅给 OpenClaw 提前声明分区，Matcha 仍等 ready catalog；OpenClaw prepare 期间 Supervisor 仍 Idle，Gateway 将其映为 stopped。日志 stopped→starting 约4.5秒；这是 owning workflow 事实缺失，不是应由 UI 防抖消除的渲染抖动。

### Wrong path taken / Missed first probe

供给 Gateway／Directory 状态验证按钮和草稿，未验证状态的真实 producer、两个 peer 的对称覆盖及生产 `RuntimeService → control loop` 入口；读局部 view model 后再次给出过强复核结论。HEAD 同失败测试对照只证明已有失败未变化，不能证明新增启动语义。

### Fix boundary / Verification closure

双分区同用 Directory；观测未取得仅 spinner，不把未知当停止；Directory 并发刷新合并，事件失效串行补读。真实启动流程状态由已有 Peer startup owner 补齐，不改 Foundation 状态或以 autoStart 配置猜已接单。同日再复核删除侧栏对契约外状态组合的推断，并修正共享函数将 declared 当作 starting 的遗留误判；否则侧栏“未启动”而Chat仍“正在准备”。同输入HEAD／当前执行已证明该谓词变化，既有Directory4项、五阶段Chat consumer及13组组件交互通过。后续又确认 Matcha 原生 Running 事件绕过完整启动结算、autostart Busy可覆盖Stop；已在原typed事件链统一有效投影，Matcha结算绑定实际ready-projection进程而非recovery后重采的新进程；OpenClaw Pending与实际reservation绑定，未取得执行权不写共享结果；两peer均仅在停止确认成功后清启动反馈，停止失败不抹掉原事实。当前Host源码使用缓存依赖的metadata编译通过；既有事件测试编译触硬限未运行，完整构建／真实冷启动仍未完成。当前证据与限制见[本轮记录](../../.scratch/openclaw-sidebar-20261108-db2zt7o9/verification.md)，不以组件供给事实冒充冷启动验收。

### Reusable rule / Applies to / Does not apply to / Archive note

已有 P7、DP-001、宪法 §26 足以覆盖：生命周期展示须核 owning workflow 与下游进程两个生命周期、实际生产入口及并列 runtime；验收结论限定到实际运行边界。适用于异步启动／状态展示，不要求单文案修改重跑全应用。保留此次误判证据，不新增状态／验证框架。

## Case: 桌面账号交接依赖散落的回调路径特判

### Status / Linked pattern

promoted；宪法 §26 已覆盖，本次为执行遗漏，不新增同义规则

### Source incident / Symptom

2026-11-07，桌面账号免登录的真实浏览器验证已通过，用户仍质疑补丁式实现。源码复核发现：App 的订阅、公告、可见性回调分别判断 `/auth/desktop`，router 又按来源路径放行登录页，HTTP client 硬编码兑换 URL 排除认证恢复。

### Real minimum loop / Root cause boundary

旧账号内存投影与持久凭据没有区分暂停和删除：为保留失败前的凭据，旧方案恢复旧内存身份后再在各消费者阻止副作用。真正责任方是 Auth Store 的会话生命周期，不是各页面；匿名请求策略属于 API 调用配置，不应靠通用 client 识别业务 URL。

### Fix boundary

Auth Store 的 `suspendSession()` 统一停定时器、失效旧 profile 并清内存，保留持久凭据；`clearAuth()` 复用该路径再删除凭据。router 仅在交接入口暂停，删除恢复选项及登录来源例外，App 删除所有桌面回调路径特判。兑换显式声明 Axios `Authorization:false`，通用 client 尊重匿名语义；票据单次消费、取消旧兑换及安装前资格校验保持不变。[VERIFY: third_party/sub2api/frontend/src/stores/auth.ts] [VERIFY: third_party/sub2api/frontend/src/router/index.ts] [VERIFY: third_party/sub2api/frontend/src/App.vue] [VERIFY: third_party/sub2api/frontend/src/api/auth.ts] [VERIFY: third_party/sub2api/frontend/src/api/client.ts]

### Verification closure

本轮既有 111 项回归、Vue 类型检查、定向 ESLint 通过；隔离真实后端与 Chrome 重放冷启动、已有账号切换、失败保留凭据与普通登录、同页新票据、A/B 响应乱序，完整 dashboard 可见。首次回归曾因错误对象的 plain headers 不具 `.get()` 失败，改为读取原生 Authorization 属性后同组复跑通过，未改测试。桌面 OS 点击全链与线上部署未验证；后端/Main 安全与 close drain 契约未改。

### 原生质量复核补充（2026-11-07）

此前通过功能闭环后仍遗漏了三条失败语义：service 将内部原因替换成裸 503，审计只在成功时标记登录，前端把权限 403 误归无效票据。宪法 §16–18／§26 和 P7 已明确覆盖，属于 reviewer pass 执行遗漏，不新增同义规则；事故事实归本案例，当前行为归模块知识库。修复分别复用 `ApplicationError.WithCause`、`auditActionOverrides` 和 `extractApiErrorCode`，不另建日志、审计或错误解析框架。

本次隔离真实后端逐项触发票据存储、消费、token pair、用户读取、设置读取五类故障，均公开安全 503，原日志保留阶段与根因；查询审计确认 200/401/403/429/503 全为 `auth.login`、body 全省略且失败无伪造 actor。Chrome 中英真实 403 提示管理员限制，同账号完整控制台及复用票据拒绝通过；详细检查与限制见[本轮验证](../../.scratch/browser-login-quality-xoZh2a/validation.md)。下次“给现有认证入口加桌面交接”在实现检查及 reviewer pass 核对成功与失败的原生扩展点；“改按钮文字”不触发此链路复核。

### Reusable rule / Applies to / Does not apply to

适用于同一生命周期语义被多个消费者分别猜测的情形：在真实 owner 表达状态转换，消费者只读状态；在调用配置表达匿名策略，不把路径识别扩散到 transport。不是禁止必要安全 guard，也不要求重写全站认证。下次在入口责任归属与 final reviewer pass 检查；单按钮文案改动不触发。

### Archive note

已有 final-form／单一 owner 规则足以指导本例；保留事故证据，不追加通用认证框架或重复规范。

## Case: 完成态修复的单入口结算与恢复预算错位

### Status

promoted

### Linked pattern

DP-001；宪法§2／§26与P6／P7已覆盖，属于执行遗漏，不新增同义规则

### Source incident / Symptom

2026-11-07，正文已显示但仍响应。CLI重复stop根因修复后，用户再次要求排除补丁式修改；复核发现回执只在完整view投影结算、恢复退休证据按整段历史累计，原本的单条happy path与类型检查没有暴露它们。

### Real minimum loop / Root cause boundary

实际生产函数顺序显示：无已知run的ended timing快照先到，terminalRunIds为空；迟到ACK保accepted，UI已done仍拦下一次发送。独立源码核查另确认：restoring内部预览从未发Host，却全记入外部退休名单，101条双预览历史超过200上限。两者分别归原Renderer record commit与Integration恢复候选边界，不归CLI producer或UI按钮。

### Wrong path taken / Missed first probe

把“落在原owner”和局部检查通过当作语义已收敛，遗漏同一事实从不同入口、不同顺序到达，以及候选内部与外部已发布身份的区别。不是所有guard都错误；原生失败事实到展示的映射仍必要。

### Fix boundary

沿原runtime message model在record commit统一结算exact send／abort／timing，删除投影独有的timing→terminal缓存补偿；恢复以sync-local Restoration保存固定cut和起点checkpoint IDs，原ItemsReplaced清内部候选，只有起点集合的exact退休进入对外证据，删除Streaming全历史镜像，不取消预算或扩live。[VERIFY: src/plugins/chat/store/session-record-projection.ts] [VERIFY: src/plugins/chat/store/matcha-session.ts] [VERIFY: src/plugins/chat/store/session-presentation.ts] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/observation.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/session/projection/stream.rs]

### Verification closure

实际record提交函数八个检查通过，Renderer类型／lint通过；Rust与真实应用验证边界保留在[模块记录](../architecture-knowledge/modules/session-chat/dev.md#工程质量复核收敛事实提交不继续堆-guard)。没有Rust恢复动态回放，不以源码反例或编译代替历史重开验收。

### Reusable rule / Applies to / Does not apply to

已有完整链路与final-form规则：在提交点验证事实的两种到达顺序，并区分内部候选与对外已发布证据。适用于异步回执、恢复和分页旁路；不要求为普通局部修正创建通用状态机，也不授权改原生公共协议。

### Archive note

默认诊断顺序已由DP-001覆盖，此处仅保留可追溯反例，不新增active pattern或架构框架。

### 2026-11-15 续例：请求收尾重新定义已有规则

后台通知跨 ask 的 root 修复后，用户再次质疑补丁式实现。对照真实 dirty before 与 producer／queue／queryLoop，静态确认三项本轮回归：Task 注册绑定所有任务，但 print 只等 Agent／Workflow，一次性后台 Bash 的通知可能被当旧 root 丢弃；新增 `!liveRequest` 禁掉普通请求的 now 抢占；把 SDK `num_turns` 的 user 消息数当执行回合，多个工具结果会提前耗尽请求预算。这是既有 §26／P5–P7 的执行遗漏，不新增同义规范。

五个既有生产文件内收口：请求／会话任务寿命只在 Task 注册处分类，print 只等待已绑定 root 的后台任务；恢复原 now controller 入口；queryLoop 直接报告真实 turnCount，SDK 展示计数不变；每条命令显式进入 root／无 root ALS 作用域，避免队列唤醒方上下文污染。未新增任务账本、队列、预算框架或 Team／UI 补偿。[VERIFY: matcha-agent/src/utils/task/framework.ts] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/src/query.ts] [VERIFY: matcha-agent/src/QueryEngine.ts] [VERIFY: matcha-agent/src/utils/requestExecution.ts]

最终 CLI 类型与五文件 no-fix lint 通过；既有 query／queue 21项、controller／sleep 27项通过。通知／Task 五文件测试仍为0通过、11失败、4导入错误，首错为 `Cannot access 'env' before initialization`，未到业务断言且无改前对照；真实 A→B→A、Bash 通知、now 抢占与跨 ask 预算未运行，不能称行为恢复。before、日志及消费者资源阻断见[模块记录](../architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-11-15-后台通知续执行与请求终态--实现已落盘业务未验收)。

## Case: MCP schema 超大整数上限触发模型 502

### Status

promoted

### Linked pattern

DP-001；P3/P4/P5 的真实失败边界与双端协议核查已覆盖。code.md §8 已要求事故归档，旧记录未接入 playbook 索引，本轮又未检索已有记录，属于执行遗漏，不新增同义规则。

### Source incident

2026-11-03，`team_graph_patch.metadata` 的整数 schema 使用 `maximum: u64::MAX`，已删除并进入提交 `e68b7b6f`；原始证据见[当日诊断](../../.scratch/model-diagnosis-20261103/RESULTS.md)。2026-11-07，新增 `maintenance.cursor` 又声明相同上限，复发同类模型 502。当前 Organization 旧修复仍在，不是旧代码回退。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:137] [VERIFY: runtime-host/modules/maintenance/src/lib.rs:143-147]

### Symptom / Surface path

OpenClaw 尚未执行工具就无法回复，裸 API 和其他客户端却可成功；本轮又与域名切换相邻。真实链路为 MCP schema → OpenClaw/JavaScript → Magpie → 服务端 Chat→Responses/OAuth 转换 → 模型上游。上游 HTTP 500 被包装为 502，外层 overloaded 分类不是根因。

### Real minimum loop

同入口、模型和凭据，仅携 maintenance 工具声明与最小无上下文消息，交错改变 `cursor.maximum` 或 `allOf`，检查 HTTP、流终态和实际回复；不调用维护动作、不修改生产配置。

### Wrong path taken / Missed first probe

未先检索已有模型 502 诊断及 schema 数值边界，重复扩大域名、协议、重试链调查；把“同一个 MCP 已连接”当作模型实际收到同一工具声明，也会误排该候选。应先核已知故障签名与最终发出的工具集合，再做单变量差分，而不是删工具或条件 schema 试运气。

### Root cause / Root cause boundary

Rust 工具发布了不适合跨浮点 JSON 链路传递的 u64 上限。`18446744073709551615` 经 JavaScript `JSON.parse` 舍入到 2⁶⁴，序列化为 `18446744073709552000`；安装版工具 normalizer 保留该有限数值。已部署服务端 OAuth 转换也以 `map[string]any` / `float64` 解码，因此直接发送精确 u64 上限并不能保证转发后仍精确。修复归 MCP 声明源头，不是 UI、重试、域名或 OpenClaw 专属禁用。

2026-11-03 旧入口的精确 u64 上限对照曾成功；2026-11-07 当前转换链的精确上限对照失败。两次结果必须分列，不能把旧入口结果冒充当前行为。上游内部为何返回 500 未公开，也未捕获本次完整 OpenClaw 出站体。

### Correct first-round plan / Fix boundary

先读取相似事故并核当前源码是否仍有该签名；用同链路交错对照区分数值、条件关键词和偶发恢复。只删除 maintenance 声明的 `cursor.maximum`，保留 `integer`、`minimum: 0`、`allOf`、工具本身和执行端 `as_u64()` 校验；不添加 provider 过滤、兼容层或任意缩小合法范围。[VERIFY: runtime-host/modules/maintenance/src/lib.rs:86-90] [VERIFY: runtime-host/modules/maintenance/src/lib.rs:143-166]

### Verification closure

2026-11-07 同链路 14 次最小差分：完整 maintenance schema 三次均 502；只删除 maximum 两次均 200/OK；只删除 allOf 仍 502；safe integer 及稍低于 u64 上限的值成功，精确 u64 上限与 2⁶⁴ 失败。修改源码后再从当前声明生成 schema，经安装版 normalizer 和同模型入口得到 200/OK、完整流结束，响应 ID 为 `d0a2e338-0820-497e-949c-174fcc4dce30`。限定 rustfmt 检查通过；未新增测试。

以上证明该字段在当前链路可独立触发故障，不等于完整桌面恢复：尚未重建/投递 runtime-host，修改后的真实 stdio catalog、维护工具调用和完整 OpenClaw 对话均未复验。

### Reusable rule / Applies to

新增或修改 MCP/模型工具的数值 schema，以及“裸 API 成功、带工具请求失败”时，检查 schema 数值本身经过各 JSON 解析器后是否保真；连接成功、工具没有执行或另一客户端成功不能代替模型出站工具声明核对。既有 DP-001/P4 负责诊断顺序，本卡提供具体签名与反例。

### Does not apply to

不把所有 502 都归为 schema，不删除正常的 u32 maximum，也不把仅在 Rust 内部使用的 `u64::MAX` 当作模型协议缺陷。不同入口、账户或协议的历史成功不能替代当前链路差分。

### Archive note

合并首次事故与新增工具复发，保留差分结论及未验边界；playbook 索引供下一次 diagnosis 入口触发，code.md 仅保留既有路由，不堆业务细节。

## Case: 把本机对外显示名称误解成成员备注

### Status

archived

### Linked pattern

项目 CLAUDE.md §2 先理解目标、§26 Final-form 先查事实源与消费者；规则已明确，本次为沟通与调查执行偏差，不新增同义规则。

### Source incident / Symptom

2026-11-07 用户圈出本机名称并询问可否修改。回答先沿 member.update 建议成员改名，遗漏真正目标是「我改一次本机显示名，对方看到同一设备的新名字」，随后又把建议行为表述得像现有能力。用户明确纠正不是成员备注。

### Real minimum loop / Root cause boundary

本机名称输入 → Main Access.host_name持久化 → 邀请/Join/认证hello发送 → 对端关联成员显示投影。旧本机初始化同时填充host与member名称，但不是同一个编辑责任；网络deviceName又是独立节点标签。仅因界面落在成员详情就认定事实归属，未提前读出生产者到远端列表的完整链。后续实现又把对端名双写 SQLite member.name 与 pair 文件；SQLite先提交、pair保存失败时两处分歧，缺少失败边界核查，仍属既有事实源规则的执行偏差。

### Fix boundary

统一可编辑事实仍为host_name；左上角和配对前复用同一设置，本机成员名由host投影。对端名唯一归关联Access member.name，认证 `acceptName` 仅写SQLite，不再保存pair名称；公开 `PairedClient.name` 从成员投影，缺成员显式 `storage-unavailable`、无旧名fallback。私有旧pair校验后仅去冗余name，原身份/key/credential/join/phase保留，不重置数据。同步沿原command和mutation lane，无后台轮询或跨库事务/补偿；首次建成员与配对仍非跨store原子，不据名称修复承诺该边界。[VERIFY: electron/main/interconnect/index.ts] [VERIFY: electron/main/interconnect/pairing.ts] [VERIFY: electron/main/interconnect/storage.ts] [VERIFY: src/types/desktop/interconnect.ts]

### Verification closure

历史实现与运行证据见[本机名验证](../../.scratch/host-display-name-20261107-i6eco_p4/validation.md)：SQLite5组、三native8项通过，licensed UI8项业务通过，但runtime-host shutdown deadline导致exit1，完整UI验收失败；恢复与锁释放已核，不扩修退出流程。未运行部分按该记录明确列出，不沿用旧成绩。

本轮真实Electron safeStorage/SQLite将 `state.json` 改为目录注入保存失败，认证hello后重开SQLite见memberName=After、pairName=Before，分歧复现run exit0，见[基线日志](../../.scratch/host-name-consistency-20261107-imlri6d2/baseline.log)。该run仅证明缺陷；修复后另次三native同次10项、licensed真实UI同次8项通过，均正常exit0/Job0，原状态恢复/锁释放及源码工件无漂移已核。准确证据和未验边界见[名称一致性验证](../../.scratch/host-name-consistency-20261107-imlri6d2/validation.md)，不据此宣称历史退出deadline已修复。

### Reusable rule / Applies to / Does not apply to

入口判断先辨别用户在改「本人发布的事实」还是「本地备注」，再查生产者及对端消费者；最终回复区分当前能力与建议行为。已有规则覆盖，承认本次未遵守，不扩成所有名称都跨端同步。

### Archive note

保留可追溯误判，不修改或堆叠长期规则；下次在入口归属判断和最终事实核对阶段触发。

## Case: 共享资源只有暂停，没有取消登记

### Status

archived

### Linked pattern

既有完整链路检查与 `CODING_CONSTITUTION.md` §26；不新增同义规则。

### Source incident / Symptom

2026-11-07 用户在「我的共享」指出已登记能力无法删除。原详情仅暂停/恢复；公共 AccessChange、strict parser 和 Main domain 均无删除操作，不是按钮遗漏或刷新故障。

### Real minimum loop / Root cause boundary

真实资源详情确认 → 既有 commandAccess/POST command → Main Access 唯一事务删除 resource 与其 grants → 新快照 → 原 discover/admit 不再授予访问。缺失归属资源生命周期，不能用 UI 隐藏或暂停代替终止登记，也不能删除原 capability。

### Fix boundary

新增 `resource.delete{id}`，沿原 expectedRevision/顺序边界/SQLite 事务一次清理目标登记及其 grants；四语应用内确认，成功后收起详情。其他资源、成员、角色、配对和本机能力保持；重新登记为新 ID、不继承旧授权，已准入操作不回滚。无新 route、owner、缓存或取消框架。

### Verification closure

本轮独立真实 SQLite 同次7组与 Windows licensed UI 同次9项通过；包括严格输入、revision冲突、事务清授权、重开、active/paused、取消确认、角色投影、重载、重新登记与四语短窗。正常exit0/Job0、锁释放、原状态恢复及33source/5artifact无漂移已核。初次shell引号和隐藏radio定位失败保留；未改产品迎合carrier。不是跨机或全平台证明，详见[本轮记录](../../.scratch/resource-access-implementation/resource-delete-validation-20261107.md)。

### Reusable rule / Applies to / Does not apply to

功能闭环应覆盖当前业务真正需要的终止动作，并在事实owner一次清理关联授权，不能只核创建和暂时禁用。不据此推导所有实体都必须可删除，也不自动扩大到成员/角色删除或已执行副作用回滚。

### Archive note

现有完整链路和 final-form 原则足够；保留具体遗漏与运行证据，不堆叠长期同义规则。

## Case: TeamRun 会话创建误拆独立 MCP 工具

### Status

promoted

### Linked pattern

`CODING_CONSTITUTION.md` §26 的现有入口复用与单一路径规则；不是新增架构框架。

### Source incident

2026-11-06，用户要求 MCP 支持同 Agent 多会话，并要求 schema 描述参考已有字段。首版另加独立创建 tool，用户追问为何不能放进原有创建节点的工具。

### Wrong path taken

把原生会话创建与图写事务不同，直接当作必须拆成两个模型工具的理由。内部副作用边界决定执行与失败语义，不必一一决定用户工具数量；只证明复用后端 owner，遗漏模型实际使用的建图入口。

### Root cause boundary

Organization MCP catalog/schema/dispatch，而非原生 create 或 durable intent。独立工具并非用户要求，也非现有 `team_graph_patch.operations` 无法表达。

### Correct first-round plan

在原工具扩展 `create_role_session` 操作，明确单项调用、禁止与改图混批；成功返回真实 role/ref，再经 context 与同工具保存节点。保持原设计 guard、幂等与 unknown 恢复，不承诺跨原生创建和图保存的原子事务。

### Fix boundary

删除独立工具的注册、allowlist、函数与分发，不保留别名；schema、prompt、parser 和当前契约文档一致收回原入口。底层仍只有原创建 owner。

### Verification closure

源码残留与差异检查通过；Organization 定向 check 的 Cargo exit0，守卫等待后代超时124、清理后Job0，分列记录。新版完整构建、实际工具列表及原生生命周期的结果以[本轮记录](../../.scratch/team-role-sessions-20261105-xWJYZt/validation.md)为准，不沿用独立tool版本工件。

### Reusable rule

扩展已有工作流前先检查原工具的操作语法；内部事务或owner不同，不自动推出新增对外工具。复用入口不能抹掉副作用、混批、幂等和未知结果边界。

### Archive note

已有§26覆盖，属于入口契约选择的执行纠偏，不增加同义规则。

## Case: TeamRun 画布跟随修复遗漏空闲帧与提交归属

### Status

promoted

### Linked pattern

P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖；规则明确而执行遗漏，不新增同义规范。

### Source incident

2026-11-06，用户报告运行图节点偶发不能拖、上移受限、越出视口不跟随；完成首轮修改后再次要求避免补丁式实现。

### Wrong path taken

首轮正确去掉负坐标钳制、区分读取与mutation锁并补四边平移，但将rAF无条件续订到整个手势结束；指针停在画布中央也逐帧读DOM。原点补偿与待提交pan又由两个layout effect先后写scroll。四边能动及类型检查通过，没有覆盖中央静止、滚动唤醒和同次视口提交。

### Root cause boundary

Renderer的同一画布交互流程没有同时收口调度和提交：需要连续运行的是边缘平移，不是全部拖拽存续时间；原点补偿和平移应在同次几何提交后一起应用。[VERIFY: src/plugins/teams/pages/TeamRunGraphCanvas.tsx]

### Fix boundary

保留现有Canvas与原patch契约；同一frame请求入口受pointermove/scroll唤醒，edge pan才续帧，中央停止并清时间基线。单一layout effect合成原点补偿与pan，不扩成通用手势框架、不再加外层guard。[VERIFY: src/plugins/teams/pages/TeamRunGraphCanvas.tsx]

### Verification closure

首轮真实前台四边持续拖动及touchCancel还原通过，0位置patch，但属于调度收口前。收口后的Renderer noEmit、两文件ESLint零告警、既有Canvas19/19及限定diff-check通过，未编写测试。首次effect依赖告警已按真实提交依赖修正。当前只读核到实际应用隐藏Chat、无Canvas，未再导航或激活；最终中央停帧、scroll唤醒、四边平移及松手保存未实机复验，不用旧实测或既有编辑器单测冒称已覆盖。详细结果见[模块记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-06-画布拖拽边界与边缘平移)。

### Reusable rule

按既有§26在交互reviewer pass核对活动区间和实际提交责任：连续手势不等于必须连续执行；验证中央静止、边缘持续、外部scroll与最终事件，不只看单次拖动能否移动。普通文案或无持续调度的点击不扩做帧循环审查。

### 2026-11-13 手掌视口与工具交接续记

首版手掌沿原extent／scroll接入，但普通主指针可用的验收遗漏了更新与工具交接。十步扩原点让四卡各执行20次，原因是把viewport原点减进每卡props；extent内平移仍无条件发布React，边界又由差值加回产生浮点往返。真实触摸还确认：手掌期间第二触点可拖单卡，或箭头拖卡后键盘切手掌仍保旧drag；两次以native cancel收尾，未保存。属于已有§20／§26与本Case的执行遗漏，不增同义规则。

修正在原Canvas：节点保图坐标、公共层平移，已有边界内直接scroll，扩边界沿唯一layout提交；right／bottom直接派生，待scroll存图坐标。节点准入绑定选择模式主指针，切工具复用节点取消与capture释放。修后十步扩原点仅Canvas22次，卡片／router及所挂外层0；extent内回拖全部0；单卡拖动仅目标卡执行，配置输入不执行Canvas／卡片／外层且DOM身份不变。次触点与键盘切换反例复验通过，未写业务。开发StrictMode调用数不是commit或耗时；tsc／lint通过，既有Canvas仍3通过／16失败，保存回包、生产大图／尾延迟与正式E2E未验。详见[视口与手势复核](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-视口更新与手势交接质量复核)。

### 2026-11-13 整页责任与验收范围续记

用户所说“整个运行图页面”被主侧误缩为手掌／平移，随后明确纠正。正确的草稿隔离、卡片／连线叶子与 Files 复用保留；问题不在推倒重建，而在跨组件读取、临时可写性、启动准入与布局恢复没有按整页责任一起收口。既有 P4/P6/P7 与§20／§26已覆盖，这是执行遗漏，不新增同义规则。

修正在原 Renderer：Details 删除独立 reader，原 Store 统一 exact-run snapshot 与 UTF-8 cursor 组装；编辑身份不再随临时 runtime readiness 改变，离线禁写但保草稿／取消；Panel与Composer共用真实当前 Chat／leader／send gate启动资格并在点击时即时复核；首次确定 node_not_found 只在精确回读后清失效旧布局意图，unknown保原请求、ACK只读。完整同值approvals保引用、呈现callback依赖nodes，Canvas普通memo，不另建canonical／队列或忽略callback的比较器。

真实登录四节点三边Run验到七类新增取消、三条边编辑、五个详情tab及当前文件预览；前述本地操作实测team IPC0。完整同值刷新等待新快照接纳后：设计／运行各1次IPC，Panel6、Canvas／卡片／Editor／Inspector／Composer／侧栏／四聊天壳／App0，草稿与DOM身份保持；次数含开发StrictMode，不是commit或生产延迟。真实Store/client回放覆盖90KB中文／emoji分页、多消息、六类坏续页、dirty／removed、失败保旧与六组布局恢复；两runtime启动资格54组、真实Editor离线生命周期回放通过，不等于native故障验收。

统一tsc、11生产文件零warning lint通过，既有Canvas3通过／16失败、Store8通过／26失败，总11／42；较前轮Store多两失败，旧快照夹具缺强制messagePage／workspace等，未修改测试或加fallback讨绿。首次刷新采样在void handler返回时过早结束、同revision伪造不同正文、原地更新WeakMap record等载具假设均已纠正，失败不抹去。正式Electron E2E、真实业务副作用／故障、生产大图与尾延迟仍未验，整体部分完成。完整责任、执行纠偏与验证边界见[本轮记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-13-整页运行图状态责任收敛)。

再次整页结构复核确认 Panel 仍复制 Store 的读取状态：首次失败后，后台 Store 成功清错但局部 `snapshotError` 不变，实际 Panel StrictMode 回放复现旧警告残留。原 Panel 删除局部 error／refreshing，只派生 exact design/run 记录；七项恢复／两读并行／异team断言通过。实机同值刷新仍为 Run／Design 各1 IPC、Panel6、Canvas／卡片／Composer／侧栏／聊天壳／App0；新noEmit与Panel lint通过，不将前述42项失败抹成通过。没有再增加“成功时清错”effect、状态框架或后端fallback，详见同一模块记录的“整页结构复核：读取状态只归 Store”。

同日用户纠正了运行图默认占主区：把图放大不应以聊天／图互斥切页为代价。唯一 Teams page builder 改为 `initialPane: side`，复用原 Workspace 分栏而非增加侧栏实现；主区保聊天，已有用户移动不强迁。原登录实例验证团队会话与聊天“查看运行图”两入口、重复点击单页、4节点实际呈现与输入框同时可见；原失败业务提示保留。§26调用边界／owner／单路径／旧默认替换落实，类型／定向lint通过；不以分栏验收宣称整页42项既有失败已修复。细节见同一模块记录“默认右侧工作区：保留主区聊天”。

随后真实 Node／Edge 回放复现旧草稿 A 覆盖已接纳定义 B：Store 等布局后取得最新 version 不能代替草稿基线。修正沿原 Editor→Canvas→Panel→Store 传窄前置条件，在布局等待后冻结请求前比较，不新增 canonical、native字段或自动重试。Store七组、真实StrictMode Editor／Store与原builder两组反例、预算／只读／原子操作七组、布局等待窗口两组通过；冲突零transport、保草稿／错误、不触发成功。只读Agent随当前绑定，已删节点尺寸淘汰亦完成限定回放；四语207键、noEmit与定向lint通过。原登录实例只验本地改标题跨页签、取消重开与主聊天／右图并显，不真实写配置。当前检查不保证未观察native并发；收口复核另发现新增已写成功但Run回读失败时仍保新增身份，真实Node／Edge＋Store回放确认恢复后重试仍以新requestId发同ID的add并遭重复拒绝，尚未修复，不能泛化普通失败保草稿为该路径已恢复。Webhook URL与控制节点当前／历史输出亦未修，42项既有失败未重跑，整体仍部分完成。详见同一模块记录“配置草稿与提交前置条件”。

### 2026-11-15 审批记录误用当前流程

用户要求看清“审批什么”，首版却把当前节点的批准／拒绝／中止连线放进历史审批，又追加“不是审批时快照”等说明；用户先否定冗余小字，再指出业务方向错误。根因是未先核请求事实：旧 Approval 只有固定 reason／risk，公开适配还丢 note，当前配置不能补成过去的具体请求。已有任务目标校准、§26 与本 Case 的整页事实责任规则足够，不新增同义禁令。

获补齐授权后，沿原 Approval／ContentStore／snapshot 保存请求时标题、正文、材料 ID 并回读真实处理事实，移除当前分支和冗余说明；旧记录保持未知，不虚构操作者或文件版本。随后复核确认四处边界缺口：派发后改 edge payload 影响材料、Electron 误套单行文本限制、合法正文 YAML 往返拒绝控制字符、新决定继承旧备注。获修复授权后，材料回到与实际 prompt 同存的 Activity 事实，另外三处分别在原入口、parser 和 resolution 写入／重放边界收口；无新审批或输入 Store。最终生产 Rust／Electron 类型／限定 lint 与依赖 DAG 通过，Rust 测试仍149项编译错误、0用例，前端定向用例4过31败，真实四项场景未动态验收。原实现及本次修复的独立基线、源码与准确验证分别见[审批真实内容与处理记录](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-15-审批真实内容与处理记录)及[审批四项边界修复](../architecture-knowledge/modules/team-task-organization/dev.md#2026-11-15-审批四项边界修复--源码收口行为验收未闭合)。

## Case: 审批展示预算误作原生请求有效性

### Status

promoted

### Linked pattern

DP-001；P4/P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，本次为执行遗漏，不新增同义规则。

### Source incident

2026-11-05，用户报告工具审批没有工具名或操作内容；首轮补齐 Matcha 信息链后，质量复核发现合法大参数会被展示预算拒绝，OpenClaw 的空详情接线也不代表功能可用。

### Wrong path taken

把公开展示的 128KiB 预算直接用于判定原生请求有效性；只核字段经过各层，没有覆盖原生合法输入超出展示预算的反例。OpenClaw 只补空详情以通过公共类型编译，未据此检查原生展示、无 runId 事件及查询／响应入口的完整消费者。后续复核又漏掉 constructor 合法字段、公共 request 可省略及已解决历史占满32项三个边界；属于既有规则明确但执行未遵守，不新增同义规则。

### Root cause boundary

原生 Matcha input 没有同等字节限制，首轮 `Pending::approval()` 的详情校验失败会在消费 cursor 提交前中断观察，冷回放仍可再次遇到该事件。OpenClaw 原生 presentation 是 exec／plugin／system-agent 三种事实，不能强造 Matcha tool ID；native session UUID 也不能当作 session key。[VERIFY: matcha-agent/app-server/src/interaction/native.rs:28-49] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/observation.rs:351-381] [VERIFY: runtime-host/integrations/openclaw/src/session/protocol.rs]

### Fix boundary

原生有效性与展示完整性分开，预算不足须明确表达，不静默截断成完整内容、不放大所有 payload 预算。两个 Integration 各自核原生身份与决策，公共卡片只展示事实，不从工具名、run 或展示字段反推授权。后续补齐 OpenClaw 候选失败：内部 Result 区分失败与 no-op，失败复用无成功 native cursor 的 Unknown／RecoveryRequired，审批 known 失效至权威同步；不在 router 叠 guard 或新增重试。连接接收序号与 Host 发布恢复事实的 seq 仍可推进，不把它们误称为业务成功水位。[VERIFY: runtime-host/integrations/openclaw/src/session/reducer.rs:399-548,858-871] [VERIFY: runtime-host/integrations/openclaw/src/driver/projection.rs:42-59]

### Verification closure

展示预算、两运行时原生审批链与后续三处补修已改；decoder／决策入口及单方法连续1024周期对照通过，既有四 suite仍12通过／9失败。再补候选失败语义后 production check与实际失败转换入口执行通过，但完整生产库回放构建两次触World依赖的5GiB硬限，未执行完整回放。保留构建／验证失败与后续局部通过的区别。真实审批与恢复未验收，完整结果见 [Session / Chat 验证记录](../architecture-knowledge/modules/session-chat/dev.md#2026-11-05-审批候选失败语义--源码已改完整回放受阻)，不据编译或局部运行宣称业务修复完成。

### Reusable rule

在实现检查与 reviewer pass 对照原生合法输入范围、公开展示预算、实际查询／响应入口；覆盖合法数据字段、可选输入缺省与同一 owner 的连续生命周期，而不只验首个成功样本。用超限输入、无可选 run 身份及第二运行时原生判别作为反例，不以共同字段或编译通过代替语义闭环。

## Case: OpenClaw 原生媒体配置先于运行包交付

### Status

promoted

### Linked pattern

DP-001；P2/P4/P6 与 `CODING_CONSTITUTION.md` §26 已覆盖，不另增同义规则。

### Source incident

2026-11-03，原生图片多账号接线后，真实 Gateway 拒绝 `models.providers.<key>.media`；用户随后质疑实际改动是否为依赖补丁，以及为什么声称已适配。

### Wrong path taken

Rust 已生产新字段，只在独立补丁副本验证 schema／工具注册；未先验证正常启动实际选择的包。把编译产物补丁笼统称为“适配”，未清楚说明非上游配置契约及版本耦合。

### Root cause boundary

实际进程使用开发态 `node_modules/openclaw/openclaw.mjs`。同一隔离配置在该包校验 exit 1／未知 media，在适配副本 exit 0；`pnpm dev` 不调用统一适配，新增补丁也不会自动重触发 postinstall。完整 bundle 对复制产物应用补丁，不能证明开发安装包已更新。[VERIFY: scripts/patch-openclaw-dev.mjs:6-12] [VERIFY: scripts/dev.mjs] [VERIFY: electron/main/runtime-host-delivery/bootstrap-resources.ts:221-223,269] [VERIFY: scripts/openclaw-media-patches.mjs:23-35,165-185]

### Fix boundary

用户授权后通过既有入口应用实际开发包；开发启动在构建／启动前复用同一入口，失败沿原 run() 退出，不删除 media、不在 Host 增加 fallback，也不另建补丁执行器。[VERIFY: scripts/dev.mjs:11-31]

### Verification closure

实际包适配 applied 后二次 clean，真实 profile 只读配置校验 exit 0／11 条 warnings 未归因；质量收口后入口幂等、脚本语法／限定 diffcheck、实际包隔离 CLI 校验及原生 image_generate 列表均通过。未执行完整 dev 启动、收费生图或真实会话／附件验收，不把运行包校验当业务完成。详见 [Provider dev](../architecture-knowledge/modules/provider-model-secret/dev.md#2026-11-03-openclaw-原生图片账号接线真实会话验收-open)。

### Reusable rule

依赖代码改写必须明确称为补丁；配置 producer、schema consumer 与工具注册必须落在同一实际交付包，并核正常启动路径选中的工件。脚本已注册、隔离副本通过和编译成功都不能证明真实运行包已更新。

## Case: 发送空窗先加等待提示，混淆两段独立延迟

### Status

promoted

### Linked pattern

DP-001、P3/P5/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，不另增同义规则。

### Source incident

2026-11-03，用户报告发送后输入被吞、很久没有输出，并指出先增加等待提示没有解决问题。

### Wrong path taken

在提交交接尚未修正时增加输入框等待条；解释中还容易把创建前约16秒空窗与接单后约120秒等待混为一谈。提示条已撤销。

### Root cause boundary

原输入 take 清空编辑，但消息区只消费实际 send record；创建／配置期间原文仍在 submission 快照，未进入正常消息展示。另一个独立故障是 Gateway 的 owner 停止通道监听 stdin，而无显式 input 的 Git 子进程继承同一 Windows 管道，baseline 卡到预算结束。原日志分别定位16189ms创建与120434ms baseline；同步可继承 named-pipe 单变量复现中隔离 child stdin 后返回268ms。创建自身的16秒尚未完整归因，不以消息提前可见宣称后台已加速。

### Fix boundary

本地提交沿原 composer store 进入正常消息区，实际 send record 写好后交接同 operation；不造 Session／run／回执，不再加独立提示。stdin 隔离由既有 owned-stdin-stop 适配负责，只隔离 active owner 的私有通道，保普通 CLI 继承、显式 input 和停止帧。

### Verification closure

实现与既有检查、真实应用未验边界分别记录于 [Session / Chat](../architecture-knowledge/modules/session-chat/dev.md) 与 [stdin 专项记录](../../.scratch/openclaw-first-send-20261103.md)。组件、静态检查不替代真实新会话的正文可见、回执接替与最终回复验收。

### Reusable rule

先区分输入 custody、展示交接、接单与执行等待；修各自真实 owner，不用提示掩盖空窗，也不把一段延迟的证据套到另一段。

## Case: Browser Relay 移植擅自改变连接成功时机

### Status

promoted

### Linked pattern

DP-001；P4/P6/P7 与 `CODING_CONSTITUTION.md` §26 已覆盖，不另增同义规则。

### Source incident

2026-11-03，用户指出扩展长时间“连接中”，对照 Accio 后再次纠正未经确认改变语义流程。

### Symptom

服务端已经握手成功并收到页面，扩展仍可处于连接中；本次各阶段耗时未采集，不能把全部等待归因于该差异。

### Real minimum loop

扩展加密握手 → 发布连接成功 → 后台初始化页面；具体页面动作在原 readiness 边界等待就绪。

### Wrong path taken

将 `onConnected` 初始化同步放入 CONNECTED 前置等待，混淆连接与页面就绪；解释延迟时先批评 30 秒重试，未先查参考实现也使用该间隔。

### Root cause boundary

参考实现握手后先 CONNECTED、后台调用 `onConnected`；本地改为 await 后才 CONNECTED。此为未经确认的可观察状态时序变化，不是移植必需项。证据：参考 `D:/accio_work/resources/chrome-extension/accio-browser-relay/lib/cdp/relay/connection.js:1194-1208`，本地 `resources/tools/data/extension/chrome-extension/browser-relay/lib/cdp/relay/connection.js:1225-1252`。

### Fix boundary

已在连接 lifecycle 恢复握手成功后先 CONNECTED、后台 onConnected/resync；动作准入仍由自己的 tabsReadyBarrier 与 socket/generation 核验负责。没有新增重试策略或提前放行业务动作。

### Verification closure

已核对双方状态转换、await 位置及相同 30 秒重试，相关生产修改通过语法检查；本轮现有真实加密 WS 握手用例通过。本地 connection 夹具仍发送明文 ACK，与现有强制密文门禁冲突，不能视为通过或据此放宽加密。未做真实 Chrome 时序测量，不宣称等待耗时或整体 ready 性能已验收。

### Reusable rule

移植中的状态语义与返回时机也是行为合同；安全、架构质量或 final-form 不授予擅改权限。

### Archive note

属于既有原则执行偏离的追溯案例，不增加新的诊断模式。

### 2026-11-03 续记：下载事实不应成为上层业务特判

用户再次质疑补丁式实现。下载保存虽沿原 service／watch，execution agent/admin 与 tool 却三次解析下载动作／公开状态以保留取消后的回执；这是语义散落，不是把条件包成 helper 就能解决。现由 service 对真实完成事实标记私有、不可枚举 Symbol receipt，上层只消费机制，不增加公共字段或第二 owner；原入口取消与 raw drain 保留。文件边界独立审阅另发现符号链接工作区下绝对目标误拒，复用既有路径解析映射真实根，保留真实祖先与 protected 校验。[VERIFY: packages/openclaw-browser-relay-plugin/src/browser-action-contract.ts:560-569] [VERIFY: packages/openclaw-browser-relay-plugin/src/service/browser-control-service.ts:385-390] [VERIFY: packages/openclaw-browser-relay-plugin/src/application/browser-execution.ts:122-126,221-223] [VERIFY: packages/openclaw-browser-relay-plugin/src/application/browser-relay-tool.ts:577-578] [VERIFY: packages/openclaw-browser-relay-plugin/src/service/workspace-files.ts:83-122]

复用既有 §26／P4 的责任方原则，不新增同义规范、不因资深标签扩大重构。最终 strict／五文件 nofix lint／插件构建与46份产物及2metadata核对通过，25原测试SHA未变；既有定向回归15pass／1fail，保留单参数断言失败。没有真实下载、跨盘或取消竞态运行证明，完整证据见[质量整改记录](../../.scratch/relay-download-workspace-20261103-verification.md#后续质量整改责任归位不叠补丁)。

## Case: 工作区连续性被修窄为文件入口保留

### Status

archived

### Linked pattern

既有 §26 与 P3／P6／P7 已覆盖，属于执行未遵守，不新增同义规则。

### Source incident

2026-11-03，用户指出切换会话时工作区消失，先前实现只保留文件目录入口；后续用户明确公共容器与手动网页都应保留，不应为了交给另一 Agent 操作而重新打开网页。

### Real minimum loop

手动打开网页 → 切 Agent／会话 → 容器意图和原网页资源继续 → 原 Agent 独占操作 → 真实终态／停止排空 → 另一 Agent 领取同一原页。可见、资源身份与操作权限不是同一归属。

### Wrong path taken

先把“工作区”按同名文件入口解释，未校准公共容器；更早只保 dock open 又漏掉 descriptor／React key／native visibility。把局部状态修复视为完整连续性修复，导致用户反复指出仍会收起或闪动。

### Fix boundary

WorkspaceProvider 切 scope 保 open／layout；手动 open 合同移除 identity，Main 初始 creator／claim／group 为 null；仅 createdBy===null 的手动 IAB 页跨 scope 展示并用 workspace lifetime。Agent 准入和物理排空释放不变；Main 关闭共享页不沿 claim group 选 Agent 后继，先确定后继再 close；活 claim 派生的 Agent popup 沿原 show-requested 过滤，不直接抢 native active。[VERIFY: src/plugins/workspace/context.tsx:22-27] [VERIFY: src/plugins/iab/browser-page.tsx:12-42] [VERIFY: src/plugins/iab/store.ts:24-28] [VERIFY: electron/main/iab/manager.ts:207-222,257-280,438-447]

### Verification closure

Main noEmit 与七文件 no-fix lint 通过（1 条既有 warning）；首次 Renderer noEmit 被另一会话正在交接的 ChatInput／composer-drafts 契约阻断，未抢写其文件。未运行应用，不宣称同一 WebContents、无视觉闪动、claim 接管或 popup／关闭帧序已验。后续类型复查及完整证据以[本轮记录](../../.scratch/workspace-browser-session-continuity-20261103-verification.md)为准。

### 质量复核续记：下载完成仍有独立选页旁路

同日用户再次质疑补丁式修改。限定复核发现 download popup 的完成回调先将 activeTabId 改回 opener 再 close，绕过统一后继规则；从已释放 claim 的 retained Agent 页派生用户 popup 后，切 B 再完成下载，可走到激活 A 的任务页。现删除回调里的 opener 预选，仅保原 popup 实例校验并调用 close；不在 Renderer 补 hide、不增加第二个显示权限判断。[VERIFY: electron/main/iab/manager.ts:452-455] 本次为静态因果确认，未实机复现；Main noEmit 与单文件 no-fix lint 结果见同一[验证记录](../../.scratch/workspace-browser-session-continuity-20261103-verification.md)。

### 2026-11-08 续记：聊天选择与实际呈现遗漏

前轮手动开页已移除跨 await 的旧 Workspace controller，但仅凭静态检查就宣称结构收口。独立只读复核确认两条源码可达反例：主区选聊天后关闭后台 native active 页，普通快照因两区 null 自动激活后继主区页；侧区非 IAB 全屏时新增归主区的浏览器页，IAB 仅凭 main placement 就消费开页意图，主区仍被遮挡。沿既有 §26／P6／P7 归类为执行未遵守，不新增规则；2026-11-03 的手动页跨 scope 规则已由 2026-11-07 精确展示 scope 合同取代，不恢复全局混显。

修复保留原 `activate` 单一路径：显式主区激活解除侧区 full／fullscreen 与 composer dock，`reveal:false` 不改布局；Workspace 提供纯呈现资格判断，IAB 确认后消费，普通快照不将 main null 当空选择。描述符同步与选区／布局确认分开，不新增状态、重试、兼容层或 native 生命周期分支。[VERIFY: src/plugins/workspace/context.tsx:60-65] [VERIFY: src/plugins/workspace/page-placement.ts:3-11] [VERIFY: src/plugins/iab/workspace.tsx:43-83]

最终三文件 nofix lint exit0（1 条既有 Fast Refresh warning）、Renderer 全量 noEmit exit0，受控 Job 均 active=0；未新增测试／probe／日志，未运行本轮构建、应用或 E2E，两条真实 UI 路径仍未验收。该成绩不替代前轮转正迟到开页、会话隔离或 native 实例连续性验证。

### Reusable rule

沿已有完整链路规则，在目标冻结和最终复核时分别检查容器意图、页面生命周期、原生实例和操作权；不能用保一个 flag 或类型成功替代用户原始结果。无需扩大为全会话页面缓存或另一套权限系统。

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

### 2026-11-08 路径复制提示原文忠实性纠偏

用户批准迁入参考版“逐字符复制，不重输目录”，主侧却将其原始 Bash 完整命令改成自写 Read JSON 参数指引。用户明确不要加工后，撤掉改写，沿原内置 Skill owner 接入参考三段原句与两批预算；只适配本地工具可用性、预算、路径和安全 quoting，不把 Artifact 专属上下文或全文 tail 塞进巨大日志处理。三段模板只读原文比对通过；类型/既有回归不证明真实模型不会抄错，实机未复验。用户继续追问发现 Read 截断还自行叠加粗估/字节约束、提前中止及空串兜底，未证明优于参考；按“能一比一移植就不自行修改”撤掉，算法循环和警告选择回到源分支，只适配本地类型/字段及缺少 allow_large 的接口。既有上游保真要求已覆盖，是执行遗漏，不增加同义规则。下次在提示组装处同时核原句来源与适用边界，不将“语义类似”称为原文。[VERIFY: matcha-agent/src/skills/bundledSkills.ts] [VERIFY: matcha-agent/src/utils/toolResultStorage.ts] [VERIFY: .scratch/large-output-alignment-20261108.md]

### 2026-11-03 浏览器工具原文忠实性纠偏

用户要求迁入 Accio 全部浏览器工具使用规则。首版虽对照原始定义，却大量独立改写并添加不存在 API 清单、实现细节与重复告诫；用户要求尽量沿用原文且不要废话后，主侧又误将其理解成缩写原文参数描述。用户打断后明确边界：能用的原句、WHEN/RULES 与示例原样保留，只替换工具名、调用格式、参数名及真实行为差异；删的是额外补写，不是原规则。已暂停错误精简，按该标准返工，模型可见入口仍为同一 `createBrowserToolCatalog(mode)`，不改 schema 结构或执行行为。[VERIFY: packages/openclaw-browser-relay-plugin/src/application/browser-relay-tool.ts] [VERIFY: packages/openclaw-browser-relay-plugin/src/application/browser-tool-description.ts]

原始材料为 Accio 0.36.2 提取包 `out__main__gateway-worker.js`：17 项原子工具定义在4298–4314行，统一 `browser` 在10557行，`browser_script` 从10420行起；只静态读取、不执行。返工后逐项保留原用途／WHEN／RULES／示例，只适配单工具调用、参数及已核本地差异；移除自写手册与不存在API清单。主侧对照原文、最终两模式目录及62条可静态提取规则，另检查条件文本和示例；脚本找出的文字差异按真实能力核对，不把未匹配机械当作遗漏。目录证据见 `.scratch/browser-tool-catalog-20261103.json`。最终 Electron 原配置 noEmit、两文件 nofix lint、参数去description后深比较与动作覆盖均通过；未新增测试／probe、未重建或做真实 Agent 加载验收，上一轮工具回归的6通过／1失败仍不改称全过。此为既有上游忠实性规则与§26的执行纠偏，读取边界、原catalog落点、单一路径及旧自写说明替换已收口，不新增同义流程或提示词平台。

### 2026-11-01 增强按钮挤占发送槽

用户实际截图与当前登录应用均复现：工具栏只有四列，新增增强按钮没有布局槽，正文非空时自动占第4列，固定第4列的发送按钮被排到下一行。原生 DOM 实测工具栏662px宽、76px高，发送未禁用且中心命中正确；不能把换行直接认定为发送失败。[VERIFY: src/plugins/chat/components/ComposerPromptEnhancement.tsx:118-129] [VERIFY: src/plugins/chat/ChatInput.tsx:1988-2052]

将增强／还原与发送收在唯一右侧操作槽，原四列末列按内容宽度分配，窄容器复用原第二行槽；撤掉发送按钮的独立 grid 定位，不增加第二工具栏、输入框或发送路径。[VERIFY: src/plugins/chat/components/chat-input.css:6-22,41-48] 当前应用清空、重输“你好”后均为36px单行，发送随正文正确启用；1000／900／680px页面宽度无溢出，500px沿原窄容器布局两行、增强与发送同行。380px模拟下固定侧栏仅留53px工具区仍溢出，低于应用960px最小窗口宽度，不扩改全局壳布局。原页面尺寸和草稿已恢复；未调用增强模型或发送收费消息，未实测还原按钮出现和消息态切换。截图见 `.scratch/design-interaction-20261031/chat-toolbar-20261101-{before,after}.png`，Renderer noEmit与三份输入组件no-fix ESLint均exit0；一次页面验证因hidden文档等待animation frame超时，改用有界协议等待后完成，不能抹除首次失败。

同次只读日志核到五次OpenClaw `sessions.create`被原生`UNAVAILABLE — Agent main startup preparation was superseded`拒绝，发生在send.start之前；原生数据库准入准备失效的具体触发项、是否新回归未确认，不改第三方包、数据库或运行doctor／重启。创建明确拒绝后自动恢复纯文本会移除submission，而ChatMessages未消费顶层store.error，源码存在持续错误提示缺口；本轮未复演该失败、不扩大布局修复到下游协议。[VERIFY: src/plugins/chat/store/session-initialization.ts:229-252] [VERIFY: src/plugins/chat/ChatInput.tsx:1596-1616] [VERIFY: src/plugins/chat/ChatMessages.tsx:303-314,454-461] [VERIFY: runtime-host/integrations/openclaw/src/session/adapters/runtime.rs:899-940]

既有§26、P3/P6与真实UI验收规则已覆盖；本次是新增交互只过静态检查、未核实际grid子项及输入前后布局的执行遗漏，不新增同义规则。下次在交互接入与reviewer pass核动态控件的槽位、显隐和实际命中；服务端明确拒绝必须独立归因，不能改按钮gate掩盖。

同日工程复核保留正确的布局操作槽与原增强生命周期，不为“高级实现”制造新框架。已在原 `ComposerInitialization` 增加 `createRejected` 终态，明确创建失败不再清空结果；页面从当前草稿键直接派生已有横幅，纯文字恢复仍删除 submission 并释放发送资格，关闭只隐藏当前结果，显式重试以新 operation 进入 creating，另开新会话退休该结果。`createUnknown` 仍阻止盲重建，pending 配置恢复保持原 operation；未订阅混合了其他操作错误的顶层 store.error、未留失败 submission 堵 gate、未加 toast／平行错误 store。新增文案同步四语言；本块共享状态与直接消费者由单一 writer 修改，检查并行，未另派重复全链调查。[VERIFY: src/plugins/chat/composer-drafts.ts:59-66] [VERIFY: src/plugins/chat/store/session-initialization.ts:211-253] [VERIFY: src/plugins/chat/store/session-actions.ts:1523-1531] [VERIFY: src/plugins/chat/ChatMessages.tsx:308-315]

最终 Renderer noEmit、六文件 no-fix ESLint、四语言 JSON/文案检查与限定 diffcheck 均通过；真实应用只读核当前唯一 composer、1286×824 页面及36px无溢出工具行，未改草稿。未发模型／发送请求、未注入 store 或 mock、未重启；新增创建拒绝→恢复→横幅→关闭／重试状态尚未实机验证，OpenClaw 原生 superseded 拒绝仍未修复。检查与边界见同台账“初始化失败结果归属纠偏”。

### 2026-11-02 画板随包分发工程复核

用户在接入画板预装时再次要求避免补丁式修改。范围固定为 builder 目标工件→平台 resources→首次 catalog→原 owner 安装／更新，不另建 built-in registry 或第二 installer；独立构建 ZIP 不代表应用安装成功。构建与运行时分边界并行，主线程核验实际 native、收据、安装事实与失败边界，内部 bundle receipt 随原 catalog 原子发布，不回传 Renderer；首次目录读取等待同 lane 的预装，保留停用、卸载、回滚和用户覆盖，插件 data 不参与归档清理。[VERIFY: scripts/bundle-app-plugins.mjs] [VERIFY: electron/main/app-plugins/bundled.ts] [VERIFY: electron/main/app-plugins/owner.ts] [VERIFY: electron/main/app-plugins/storage.ts] [VERIFY: electron/main/app-bootstrap.ts]

Windows x64 工件及生产验包、Renderer／Design types、owner 窄类型与限定 lint 通过；临时目录真实 owner＋package worker 已验证首次安装、HTML读取、停用／卸载跨实例、真实 v1.0.4→1.0.5 保留数据／停用／previous、回滚保留和错误收据拒绝。完整 Electron 类型检查最初有 IAB／Browser Relay 的18条接口错误，中途重跑剩 IAB 的13条 SessionEntry 缺字段错误；负责该边界的既有会话修复后，本会话独立重跑完整 noEmit 已 exit 0。本轮未修改这些边界，也不据类型通过宣称其业务通过。一次 no-incremental 检查因 composite 参数错误退出，修正调用再验。没有生成应用安装包、安装／启动应用、模型调用、签名／公证或跨平台验收；Windows arm64 缺真实 FFmpeg。完整记录见 [bundled-plugin-20261102.md](../../.scratch/design-interaction-20261031/bundled-plugin-20261102.md)。这是执行既有§26/P4/P6与事实分级要求，不新增通用框架。

用户同日再次指出质量疑虑，进一步复核实证两处遗漏：`list()` 等待全部pending导致commit通知回读排到自身之后；跳过bundle仍更新digest基线导致“回滚→旧应用→新应用”覆盖用户选择。前者改回已提交快照读取，并禁止内部未提交load提前发布缓存；后者保持真正安装基线，不新增状态或豁免开关。改前分别用真实owner／worker观察到通知阻塞和版本错误回到1.0.5，改后同边界验证跨实例回滚维持1.0.4、停用／data保持、卸载不复活及同版不同收据后仍可正常升级。owner窄类型／限定lint通过；全量检查出现其他会话IAB文件引入的新TS6307，已通知原owner。本次还确认ARM64缺工件会使正式Windows job及后续tag发布阻塞，不能只标“未验”。详见同一[记录](../../.scratch/design-interaction-20261031/bundled-plugin-20261102.md#再次质量纠正提交快照与安装基线)。这是遗漏应用既有提交点／事实源／P6要求，不新增同义框架。

用户随后澄清“其他插件”而非“其他操作系统”，要求实现可扩展清单。已将公共构建／bootstrap 的 Design 硬编码替换为 `apps/bundled.json` → 各插件 `buildPlugin` → ZIP＋统一索引 → 原 owner 逐项安装；Design 原生校验／签名归回自身，无第二 installer 或旧单收据兼容路径。新清单 Windows x64 实际构建／生产验包、两个既有合法插件的索引安装及独立状态保留、新 Design 索引升级／回滚／data 复验通过；最终完整 Electron noEmit 和限定 lint 通过，前述 TS6307 未再出现。完整应用安装包与跨平台未验，ARM64 producer 缺口不变。详见[清单验证](../../.scratch/design-interaction-20261031/bundled-plugin-20261102.md#可扩展随包清单)。

同日按“补齐”授权增加 Windows ARM64 专属原生准备入口，固定官方 Skia、BtbN FFmpeg 与微软 VC redist 的版本／SHA，静态提取两份 ARM64 VC DLL 与 Skia 同目录随包，不执行安装器、不全局安装；未用本机 x64 或许可未明确覆盖的 LLVM/bin DLL 代替。真实 ARM64 ZIP 55,573,579 B／14文件，通过 SDK／目标校验；重复准备、损坏 VC 缓存拒绝并保旧目标、缺失／错架构 DLL 拒绝及 x64 digest 不变均有实际验证。ARM64 真机、整个安装包与公开发布未执行；GPL 完整对应源码／构建材料分发及微软许可前提仍须落实，不再把 producer 缺失作为当前事实，也不把验包当运行或合规证明。[VERIFY: apps/design/prepare-win-arm64.mjs] [VERIFY: apps/design/native.mjs] [VERIFY: apps/design/build.mjs] [VERIFY: .github/workflows/release.yml] 详见[同轮补齐记录](../../.scratch/design-interaction-20261031/bundled-plugin-20261102.md#windows-arm64-原生工件补齐)。

### 2026-11-03 无会话媒体扫描与原生协议错配

截图显示新对话画板的“会话媒体列表读取失败 [list]”。源码确认无sessionIdentity仍安排list，AppFrame无media owner拒绝且无stable code，能够产生该表象；真实profile未捕获该次请求，因此不把此路径认定为已实机复现的唯一根因。沿同链另证OpenClaw 2026.9.3 closed schema不支持consumer发送的type／limit／cursor／transport，普通图片ID规则也不符；不能只吞UI异常或删参数就宣称能力恢复。[VERIFY: apps/design/src/ui/useSessionMedia.ts] [VERIFY: src/plugins/application-plugins/AppFrame.tsx] [VERIFY: node_modules/openclaw/dist/src-CxpZ9eYs.mjs:2441-2479] [VERIFY: node_modules/openclaw/dist/artifacts-DjgRxHy9.mjs:216-218,407-499]

修复归原hook资格与OpenClaw integration：无会话不扫描但仍可编辑，原生scope-only请求加consumer本地分页／摘要失效，bytes ID与managed ticket分开核；Host DTO／SDK／native及授权边界不动。Design v1.0.6的双Windows架构ZIP生产验包、类型／限定lint、Rust库check／限定格式通过；未安装、启动、发送消息或发模型请求，真实截图与有媒体归集仍未验。初次pack因旧ZIP存在被wx拒绝，保留旧包另产版本化ZIP；初次Rust检查exit125，降低并发并调整已测资源预算后通过，不改业务或全仓警告来通过检查。完整事实与收据见[修复记录](../../.scratch/design-interaction-20261031/session-media-20261103.md)。这是执行既有P3/P4/P6与§26，不新增规则或框架。

同日用户再次质疑补丁式修改，定向复核确认上一轮仍遗漏传输与恢复语义：native单帧base64受tungstenite默认16 MiB frame／64 MiB message限制，原共享control会因大原件失败而连带断开；隐藏中止没有恢复通知，“重新读取”也没有重试媒体。现已在原Gateway复用认证建立有界媒体短连接（只请求operator.read，download为50 MiB base64＋1 MiB envelope限额，list保默认），保留control默认限额并删除无producer的旧transcript HTTP-ticket分支；AppFrame用原pending信号／dirty串起中止、隐藏拒绝和恢复，Design重读复用原扫描request，不增加自动重试。v1.0.7双Windows架构重建／验包、Design和完整Renderer noEmit、限定lint、Rust库check通过；client.rs原全文件格式未改，仅核新增片段。真实native下载／隐藏恢复／截图仍未验，未安装启动或替换宿主；不能以这些静态结果再宣称行为闭环。[VERIFY: runtime-host/integrations/openclaw/src/gateway/artifacts.rs] [VERIFY: runtime-host/integrations/openclaw/src/gateway/client.rs] [VERIFY: src/plugins/application-plugins/AppFrame.tsx] [VERIFY: apps/design/src/ui/useSessionMedia.ts] [VERIFY: apps/design/src/ui/Editor.tsx] 实测收据与首轮遗漏保留在同一[记录](../../.scratch/design-interaction-20261031/session-media-20261103.md#质量复核修正同日v107)。

### 2026-11-03 空草稿画板晋升链遗漏

用户追问空会话变为正式会话是否自动读取，源码确认原Workspace在composer草稿key变为正式record key时移除application页；AppFrame虽然会按正式身份重建，原页却已不存在。只保页也不够：原无身份随机文档与正式会话默认hash文档不相同。漏项是完整生命周期与文档归属，不是缺一条媒体通知。[VERIFY: src/plugins/chat/store/session-actions.ts] [VERIFY: src/plugins/workspace/context.tsx] [VERIFY: src/plugins/application-plugins/AppFrame.tsx] [VERIFY: apps/design/src/backend/documents.ts]

按已批准范围冻结共享合同后，三个agent分别实现Chat／Workspace、应用冻结context、Design绑定；主线程集成。真实create与原选择资格产生准确晋升事实，Workspace只承接对应草稿已开opt-in页，页级ID避免正式会话后来新开页面借用旧草稿。原Documents保同文档及已保存内容／history／消费集合，先原子绑定再写派生索引，索引缺失可从真实文档恢复，冲突拒绝；undo保当前身份。没有新增轮询／bus／第二store／常驻页，SDK仅增加可选非授权context字段，native与权限不变。[VERIFY: src/plugins/chat/store/types.ts] [VERIFY: src/plugins/workspace/extensions.ts] [VERIFY: src/plugins/application-plugins/application-workspace.tsx] [VERIFY: sdk/app-plugins/src/api.ts] [VERIFY: apps/design/src/ui/Editor.tsx] [VERIFY: apps/design/src/backend/documents.ts]

SDK构建、完整Renderer及稳定Design noEmit、Design限定lint和v1.0.8双Windows架构生产验包通过。Host严格lint为0 errors／2个改前既存warnings；两个既有suite为9通过／10失败，保留旧入口／缺runtimeScopeKey的fixture失败，未改断言求绿。首次build命令在所有构建与bundle验包后因收据打印误读manifest.tools而exit1；改用真实contributes.tools只读复验exit0，未覆盖版本化ZIP。未授权安装／启动／模型请求／新测试或probe，真实自动交接、native扫描与中断恢复仍未验，不以静态检查抵扣。沿用既有§26及P3–P7，不增加同义规则；实测收据见[交接记录](../../.scratch/design-interaction-20261031/draft-handoff-20261103.md)。

同日用户再次质疑补丁式修改，有界复核发现首轮为了保晋升回执，在same-current显式刷新中直接复用currentConversation，意外合并了两笔请求的选择资格。非OpenClaw会话连续刷新且身份／endpointSessionId／pendingTurn不变时，第二笔成功后第一笔迟到失败仍可通过引用检查并写回error；HEAD每次新对象会拒绝旧笔，这是本轮引入的源码时序缺陷，未执行实机或probe。修正保原builder产出的语义及promotedDraft，但显式刷新生成新选择对象，恢复原isCurrent引用隔离；不新增请求序号store／wrapper，也不为风格重写其余正确路径。目录投影仍保对象连续性，两种生命周期不能混用。[VERIFY: src/plugins/chat/store/session-actions.ts:855-870] [VERIFY: src/plugins/chat/store/session-runtime-graph.ts:364-386] 完整Renderer noEmit与单文件严格lint复验通过；新并发行为、自动交接仍未动态验证，旧suite没有覆盖此触发，不重跑作有效证据。详见同一[交接记录](../../.scratch/design-interaction-20261031/draft-handoff-20261103.md#同日质量复核选择实例与晋升信息分离)。沿用§26与已有异步资格规则，本次是执行遗漏，不新增同义规范。

### 2026-11-03 空草稿 compose 遗漏与推荐缺配置误报

用户随后截图指出：空会话画板标注无法“添加到对话”；前轮只完成草稿→正式会话保板，并未覆盖发送前添加。直接失败由 application-workspace 无正式身份时不提供 onCompose 产生，下游 composer-actions、ChatComposer 与 Input 也各要求正式身份。按§26将原 compose 目标改为正式身份或真实草稿实例，保原暂存／revision／附件 custody 和手动发送，Input scope 同时区别同 Agent 不同草稿，不通过提前创建会话或去除隔离绕过。AppFrame 原 compose／ui/message 同核冻结草稿 ID，媒体和文件授权不放宽。[VERIFY: src/plugins/application-plugins/application-workspace.tsx] [VERIFY: src/plugins/application-plugins/AppFrame.tsx] [VERIFY: src/plugins/chat/composer-actions.ts] [VERIFY: src/plugins/chat/ChatComposer.tsx] [VERIFY: src/plugins/chat/ChatInput.tsx]

另一截图把未配置推荐模型／路由显示成红色内部英文。native 已返回 selection-unavailable，Main／CJS 桥丢 code 才使 Design 无法区分配置未就绪。修复在原错误链保留稳定 code，Design 推荐边界映射为 recommendation_unavailable，四语言 UI 呈中性状态；真实失败仍保失败＋手动重试，空候选不伪造，不做额外预检／自动重试。共享合同由主线程先冻结，再同批四独占写 agent 实施；未扩 native／SDK 或建立第二 owner。静态检查、构建结果与实机未验边界见[本轮记录](../../.scratch/design-interaction-20261031/draft-compose-20261103.md)。这仍是已有完整链路与类型化错误规则的执行遗漏，不增加同义规范。[VERIFY: runtime-host/modules/provider/src/adapters/loopback/text.rs:199] [VERIFY: electron/main/app-plugins/media.ts] [VERIFY: electron/main/app-plugins/protocol.ts] [VERIFY: electron/main/app-plugins/runtime.ts] [VERIFY: electron/main/app-plugins/worker.ts] [VERIFY: apps/design/src/backend/analysis.ts] [VERIFY: apps/design/src/ui/Recommendations.tsx]

复核又发现本轮 UI 丢弃失败原因的回归：有模型但账号缺少凭据时，native 已给 `credential-missing`，却只显示“稍后重试”；`invalid_model_output` 同样失去换模型建议。只读对照 HEAD 与 producer/consumer 后，在 Design 原推荐工具错误结果保留已有 code，UI 仅将已知原因映射为简短四语言提示，未知原因不透出内部英文，不为恢复文案修改 native／SDK 或另建预检。用户进一步要求提示言简意赅，最终 v1.0.11 文案为“请检查模型账号凭据。”等短句；类型、定向严格 lint 与双Windows生产验包通过，真实应用未验。沿用既有“用户错误可行动”与完整错误链规则，不增加同义规范。[VERIFY: runtime-host/modules/provider/src/adapters/loopback/text.rs:225-238] [VERIFY: apps/design/src/activate.ts:29-35] [VERIFY: apps/design/src/backend/analysis.ts] [VERIFY: apps/design/src/ui/Recommendations.tsx]

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

### 2026-11-03 同类：工具上下文被当作外部输入

实际 Session 的唯一 native result 为 success，input ID 与 ACK 均精确匹配；ExecuteExtraTool 的“先发现工具”内部提示却以另一 user UUID 输出，App Server 据此置 `ownership_ambiguous`，随后输出 `native_result_ownership_ambiguous`。native terminal 已经到达 Renderer，不能归因于前端漏消费或更早的 history_source_changed。[VERIFY: matcha-agent/packages/builtin-tools/src/tools/ExecuteTool/ExecuteTool.ts] [VERIFY: matcha-agent/app-server/src/session/observation.rs] [VERIFY: matcha-agent/app-server/src/session/run.rs]

最初建议只改该工具失败出口，遗漏 Skill／FileRead 正常附加上下文及 Agent progress；这是既有 DP-001 P4／P7 与宪法 §26 的执行失败，不新增同义规则。修复改在公共工具消息来源与 Server 当前 Run 归属判断：保原模型上下文与工具行为，真实 foreign input 仍保守收口。下次在修复方案冻结／reviewer pass 核同一消息出口的成功、失败、进度及拆块路径，不将单次触发点当作完整修复边界。[VERIFY: matcha-agent/src/services/tools/toolExecution.ts] [VERIFY: matcha-agent/src/utils/messages.ts] [VERIFY: matcha-agent/src/utils/queryHelpers.ts] [VERIFY: matcha-agent/app-server/src/session/observation.rs]

诊断现场与新代码验证分开；静态检查、既有回归及尚缺的真实业务验收见 [Integration 本轮记录](../architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-11-03-工具上下文误判-unknown--源码已改业务未验收)。不修改真实 transcript／Run 数据来消除已有错误。

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

### 2026-11-03：流式正常，结束后用户与助手倒序

真实事件与产品日志表明：普通 user ACK 直到正文结束才发出，Integration 又过滤 live UserMessage，因而同步前只有助手 A。终态历史读取当时只有用户 U，Integration 内部三方 Merge 在无共同前驱时将 A 插到 U 前，Host 已收到 `[A,U]`；Renderer 乐观 U 被 exact 身份接管后才显现倒序。最终原生 JSONL 主链实际为 `[U,A]`，不是文件丢失、前端排序或 OpenClaw 共享私有 reducer 故障。[VERIFY: runtime-host/integrations/matcha-agent/src/session/events.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/observation.rs] [VERIFY: runtime-host/modules/sessions/src/domain/model.rs] [VERIFY: src/plugins/chat/store/session-item-reconciliation.ts]

仅在 result 前追加 flush 的建议没有闭合两个反例：输出期间也可读历史；原 flush 先排队列再等异步生产结束，会漏掉随后入队的记录，recordTranscript 的首次 await 之前也未登记生产任务。修复归原生输入确认、存储屏障与 Matcha 精确输入投影，不在共享 Merge 加角色排序，也不让前端猜顺序。最后正文到 content_block_stop 的 9674ms 是独立等待，现有证据不足以归因，本次不改模型结束语义。[VERIFY: matcha-agent/src/QueryEngine.ts] [VERIFY: matcha-agent/src/utils/sessionStorage.ts] [VERIFY: matcha-agent/src/services/api/openai/responsesAdapter.ts]

既有 P3/P7、DP-001 与宪法 §26 已明确要求完整失败链路和真实闭环；本次过早将局部方案称为最终方案属于执行未遵守，不新增同义规则。下一次在 bugfix 入口与 reviewer pass 同时核对实际事件身份、顺序、文件可读屏障及 Renderer 接管；编译、模型自评或另一 agent 认可不能替代动态结果。验证结果另记本轮模块 dev，不沿用本卡早期成绩。

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

## Case: Session 历史恢复与错误码展示（2026-11-06）

### Status

源码已修，真实会话恢复未验收；不是整体验收完成。

### Symptom and evidence

Matcha 历史中的合法审批收尾发生在 run terminal 之后，被公共状态机一概拒绝，形成 InvalidChange → InvalidReadback → 503。原生持久事件与 Host 日志、Renderer 内存交叉核对：文件会话459成功→461实例关闭；另一会话442成功→2025重启恢复；未完成性能会话则是恢复审批后记录 outcomeUnknown/server_restarted，属于不同语义。证据见 `.scratch/session-history-fix-20261106-sonqn0hu/verification.md`。

### Owning fix and quality correction

SessionState 在原 apply 与 replay 路径允许合法 Resolved，保留 Requested 和运行防复活，不删事件或清终态集合。首次展示修复仍用英文 `Session runtime unknown` 匹配翻译；质量复核确认这是把已知结构化 issue 降成文案再猜回语义。最终在原 projection 使用既有 lastIssue.code 保留 `session.runtime.<issue>`，展示复用原按码本地化，删除字符串匹配，不新增 DTO、状态或错误框架。加载失败只依据当前 scoped historyStatus，不接无归属全局错误。

### Reusable rule and verification boundary

已有编码宪法§16/§17/§26与DP-001已覆盖，偏差是执行遗漏，不新增同义规则。修复或本地化运行错误时，入口及reviewer均检查“原生结构化原因→现有错误载体→展示”的完整链；纯文案替换不触发状态模型改造。类型和lint通过不代表真实重放恢复；旧测试夹具失败及共享构建限制原样保留在验证记录。

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

### 2026-11-02 续记：功能回归不能替代卡顿验收

用户追问“什么叫验证通过，你是为了修什么改的代码”“那就证明啊”，指出三轮拖拽尺寸正确、页面身份／输入保留、浮层显隐恢复只验证功能，不证明原始卡顿改善。随后在同一真实 Electron 会话、固定2078×824 client、GPU关闭、同一系统鼠标轨迹下，交替加载只改变目标源码的 Renderer 工件，使用 DXGI 桌面像素及非零 LastPresentTime 检查可见更新；不用 rAF／IPC 回执代替呈现。

- 六组旧hook／直接 ResizeObserver 同步对照：直接同步显著减小网页与分隔条的边缘误差，但三次可见位置更新中位间隔均由约17ms变为34ms；这是回退，不是修复完成。
- 九组原版／下一帧调度／直接同步对照：两个完整的下一帧候选恢复约17ms，仍有约9–10px的边缘误差尾部，不能宣称原始跟手问题已解决。另一个候选run鼠标越出预设轨迹、拖拽提前停止，明确排除，不挑其有利数据。
- 九组强制React同帧提交对照：中位恢复，但尾部停顿未改善，不落入ChatShell；布局后任务候选也出现约66ms尾部停顿，不采用。该轮第八组前丢失前台窗口，runner exit1；已完成七组证据保留，Electron正常exit0，不把部分采集洗成整轮通过。
- 最终仅将 `ResizeObserver(() => { void sync(); })` 改为既有 `ResizeObserver(schedule)`，移除失真注释；保留事件驱动、单在途及latest补发、owner／generation隔离和显隐清理，不新增轮询、协议或布局owner。此改动目标是消除已测新增回退，不把“恢复基线”说成“修复原始卡顿”。

最终落盘源码再做六组交替复验，三次最终版中位16.82–16.88ms、P95 33.94–34.13ms，三次原版中位16.86–16.89ms、P95 33.74–34.05ms；二者边缘误差P95均约9–10px。结论是直接RO造成的回退已消除，未证明相对原版更顺。最终Renderer类型、限定no-fix ESLint及实际源码构建exit0，浏览器chunk与已测候选逐字节一致；采集runner及Electron均exit0，PID已退出、专用锁不存在。不将这些通过项提升为原始卡顿修复。

旧锁经用户明确授权删除后，后续专用profile均正常获锁／释放。性能对照固定缓存Main指纹；同期另一会话将共享OpenClaw降为9.3，故本次不证明其SDK兼容或automation授权链。原始上下割裂及整体丝滑目标仍OPEN。

原始证据：`.scratch/workspace-resize-20261101/product-perf-ab-20261102/` 下 `measure-fixed-window/comparison.json`、`measure-candidate/{comparison,validity,environment-boundary}.json`、`measure-commit/comparison.json`、`measure-task/{failure,assessment}.json`；最终落盘工件与独立复验另见该目录 `final.json` 与 `measure-final/`。

### 2026-11-02 续记：高速复现与 IAB 引入前后源码反证

用户补充“加入浏览器功能后才注意到”，随后指出自动拖动可能太慢。此前把软件输出路径参与最小复现说成已经排除本方回归，归因过早；应分别验证故障机制与回归引入点，不用慢速零捕获证明旧版正常。

隔离提取 `7d1ef797`（IAB 前）与 `88ce0ced`（IAB 后）的 Main／Renderer，固定当前 Electron 44.10.0、GPU 关闭、2078×824 client、专用 licensed Profile，交替执行系统鼠标轨迹并采 DXGI 桌面。两提交的 package.json 均指定相同 Electron；但安装依赖和 runtime-host 共享当前版本，因此这是源码对照，不是完整历史发行包对照。慢速峰值约565px/s 的1666帧均未捕获；提高到约2304px/s、240Hz 输入后：

- **旧 Main＋旧 Renderer** 两轮1049有效帧中有8帧错位，最大45px；截图中输入框与竖线沿同一水平边界断开。IAB 不是该故障的必要条件，但这不证明新代码没有提高显现率。
- 新 Main 下分别只恢复线条半像素平移、只取消 rAF 合并，均仍错位：原版12/1248、平移20/1281、即时更新21/1291。只证明两处单变量回退均不能消除故障，不把相关帧当独立样本推导发生率回归。
- 旧 Main 导航至 about:blank，移除应用文档，只注入一个 rAF 变宽 CSS Grid、竖线与灰色方块；无 React／业务 Renderer、无 IAB 视图，仍捕获162/784及281/849帧错位，最大39px。该自动动画是机制反证，不是产品验收，发生率不与产品直接比较。

有效判据为精确绿线实色／半像素混色、每帧全部764扫描行、非零 LastPresentTime；早期宽松色阈值误识别 ClearType 的采集已标 invalid，不混入结果。正式截图连续采集关闭，DXGI 及其余 trace 开销仍影响时序；截图中完整容器断开才是故障证据，不拿 DOM、rAF 或 IPC 代替。

当前支持软件绘制／呈现边界继续调查；源 DIB、GDI 提交、窗口重定向与 DWM 尚未分别观测，不能宣布精确原生根因或修复。未改生产代码、正式 E2E 或 GPU 配置；两个候选只在 ignored 诊断目录。六次有效会话均有 Electron exit0 记录，5GiB 整树硬限、超时及 owned 清理；状态仍 OPEN。

证据：`.scratch/workspace-drag-ab-GI6ANB/assessment-20261102.json`、`inputs.json`，各 `desktop-*/comparison.json`／`exit.json`；旧版原始截图 `desktop-before-main-fast/0-before/desktop-410.png`，纯页面反证 `desktop-minimal-fast/0-minimal/desktop-225.png`。

### 2026-11-02 续记：直接源 DIB 与原生提交边界闭合

用户要求继续“钉死”。本轮在真实新版应用 GPU 子进程的 `BitBlt` 入口设原生断点，按实际 `CreateDIBSection` 返回的像素地址及 `SelectObject` 关系，暂停时读取本次源位图，而非另取 CopyOutput 图。716次完整764行源像素全部笔直；同次613有效桌面帧中出现5张上下混帧，5张的上下x均精确对应桌面QPC前相邻两次正确源提交。例如源514全高x1459、源515全高x1432，桌面411却在y520拼为这两个x。断点改变时序，但坏帧仍出现；这直接排除本次故障在提交前已由DOM／软件源位图画歪。

独立Win32最小程序彻底移除Electron，再验证相同输出边界：

- 普通 `BitBlt → HWND` 61/791帧混合，加 `GdiFlush` 仍64/864；另一轮 `DwmFlush` 也未消除，不把等待完成误当原子提交。
- 两张初始化后永不改写的位图，固定x1180／1400交替，排除源内存复用；无鼠标输入的 `BitBlt + GdiFlush` 两轮42/825帧混合。相同源、窗口尺寸与采集，仅换 `UpdateLayeredWindow` 两轮0/824；所有源图逐行正确，全部提交返回成功。零捕获仅限本对照，不宣布产品已修好。
- 独立Windows.Graphics.Capture窗口帧同样看到不可变源混合，143/809及161/790，说明不必等到物理显示器扫描，也不只是DXGI采集器误判。窗口DC读回会改变同步并压掉复现，不能拿这种正确读回代表故障时刻的重定向表面。

归属已缩到**正确源位图经普通GDI窗口更新到桌面合成的非整帧一致性边界**，不是Chat／Workspace宽度状态、上下两根线或IAB视图bounds。精确到Windows内部哪一个驱动／内核／DWM函数仍未证明，不能把边界归属冒称OS函数级定位。修复方向是保留GPU关闭和原生窗口功能的整帧提交路径；已知透明窗口副作用仍使其不可交付，不新增CSS补丁或宣称flush修复。

失败／无效实验独立保留：主进程IAT探针未命中真实提交，GPU DLL未加载时未关沙箱；只读共享区扫描未找到源；一轮鼠标轨迹偏离作废；WGC边框遮住DXGI三行导致零有效帧，且应用WGC缓存静止帧，不把其零坏帧当通过。最终证据使用直接原生断点＋原DXGI。真实应用正常exit0、PID已退出、专用锁释放；生产源码、正式E2E、GPU和沙箱配置未改。诊断边界已闭合，产品修复仍OPEN。

证据：`.scratch/workspace-drag-ab-GI6ANB/native-boundary-20261102.json`；`product-native-breakpoint/source-desktop-association.json`、`source-debug/source.jsonl`、`0-after/capture.json`；`native-gdi-immutable-atomic-noinput/comparison.json`、`native-gdi-wgc-ab/*-wgc.jsonl`。工具、失败记录与资源限制均保留在同一ignored诊断目录。

### 2026-11-02 续记：稳定版 Electron 对照未找到现成修复

用户同意先查发布记录和隔离版本对照。核实最近补丁44.10.1、最新稳定主版本45.2.1的官方发布与具体backport，未找到明确对应GDI混帧的修复；这不等于证明上游所有分支均无修复。两份win32-x64运行包只下载到新建scratch目录，镜像包SHA256与官方GitHub release asset digest一致，不安装依赖、不改项目package／lockfile。

固定同一Main／preload／Renderer指纹、GPU关闭、不透明窗口、2078×824 client、240Hz同轨系统鼠标，每版本两轮12秒：基线44.10.0（Chromium152）19/1114有效帧混合；44.10.1（同Chromium152）7/1185；45.2.1（Chromium156.0.8078.75）8/1154。每个候选两轮均复现，结论仅为**都不能消除故障**，不从短时相关坏帧数量宣称发生率改善。

实际运行路径／版本、GPU compositing=`disabled_software`、真实license receipt与exit0逐项核验。每版本用专用E2E licensed Profile的独立克隆，非日常Profile；许可验证不变，Bun load-time只改诊断进程的profileRoot，正式E2E未改。首次基线因同PID有两个可见HWND失败，已排除；随后从BrowserWindow读取精确native handle并保留PID／前台验证，不再猜窗口。

Chromium156源码仍以 `GetDC → CopyHDC → ReleaseDC` 执行Direct；Win10仍被排除出RemoveRedirectionBitmap的新提交路径，与实测未修复一致。两个候选已失败视觉门，不追加完整窗口／内嵌浏览器验收，不升级依赖，也不未经确认转自维护Electron补丁。全部实测进程正常退出，克隆锁释放、GUI资源已向并行会话交还；产品修复仍OPEN。

证据：`.scratch/workspace-drag-ab-GI6ANB/electron-version-assessment-20261102.json`、`electron-version-inputs.json`，`version-44.10.0-r2/`、`version-44.10.1-r1/`、`version-45.2.1-r1/`的`session.json`、`version-environment.json`、`comparison.json`、原始capture与`exit.json`。45.2.1原图为`version-45.2.1-r1/1-after/desktop-456.png`，分隔线与输入框同高断开。

### 2026-11-02 续记：CPU 软件交换链可行，尚非可发布修复

用户同意继续隔离验证整帧提交。独立原生程序在同一不透明窗口交替提交两张不可变源图，ABBA 对照中普通 GDI 为37/787有效帧混合；`D3D_DRIVER_TYPE_WARP`、`FLIP_SEQUENTIAL`、`AlphaMode=IGNORE` 为0/822。软件设备 vendor5140／device140，源图每行正确、提交均成功。这只证明该原生对照，不拿它替代真实应用。

Chromium 已有 `SoftwareOutputDeviceWinSwapChain`，其 backing 明确创建 WARP 软件设备；Win10 在现有 factory 政策下未选择此分支。匹配官方 Breakpad MODULE 与 PE 后，仅在完整私有 Electron44.10.0 副本的 `CreateSoftwareOutputDeviceWin` 中，将该 factory 的五字节政策调用结果置真，选择现有 child-HWND／DirectComposition／composition-swapchain 实现；全局版本谓词、沙箱、许可和授权检查未改。**这是签名失效的私有可行性实验，绝不能安装或发布；尚无源码集成、重建和签名验证。**

真实应用两轮空工作区0/1018有效全高帧混合；额外四个独立应用会话ABBA中，原版30/1115，候选0/1017。各轮均为同一专用 Profile、固定历史Main／Renderer、2078×824 client、12秒、240Hz系统鼠标、实际x1070–1510。候选仍 `hardwareAcceleration=false`、GPU compositing／rasterization=`disabled_software`、opacity1，未以透明主窗或硬件渲染换视觉结果。

功能闭环 `swapchain-functional-r6` 正常退出：真实标题栏双击最大化／精确还原、Win+Left贴边、1800×950 resize 均通过，始终无 `WS_EX_LAYERED`；实际内嵌网页导航、输入、点击成功，“更多”原生透明浮层出现并可Escape关闭，高速拖动后输入值与clicked状态保留。全桌面原图证明网页可见；r5虽因错误role定位失败，其桌面原图独立证明浮层盖在网页上。r6共有515张桌面帧，448张全764扫描行有效，0混合；另67张仅上方89行marker可见，恰止于native网页y149，**必须排除，不能宣称跨原生面的边缘同步已解决**。

无效验收分别留档：r1在窄窗开侧栏未得到resizer；r2把成功贴边后的Snap Assist抢焦点当失败；r3在resize已关闭侧栏时找browser按钮；r4／r5要求菜单具有实际并不存在的dialog角色。修正观测流程后才取得r6收据，不把工具失败冒称产品回归，也不把失败轮计入通过。

性能补充：完整桌面ABBA中，基线可见位置变化中位16.88／16.85ms，候选32.32／17.00ms；候选对应采集间隔也为32.17／17.01ms，存在漏采与采集负担。随后只缩小DXGI传输区域为780×764、保留全764行及完全相同精确色判据，并用既有原图逐像素核对分类和x计算一致。有效AB中基线142/671混合、候选0/650，可见变化中位16.70／16.72ms、P95 33.43／33.36ms；不支持候选必然降为30Hz，也不能凭单对样本证明广泛性能无回退。其后候选在采集前失去resizer，失败DOM显示窗口1812px且右侧为非docked状态；该次不计通过，末次基线未启动，不能称轻量ABBA已完成。未再重试，全部应用仍正常exit0、PID退出、锁释放，GUI交还。此前完整容器证据不被窄采样替代；输入到呈现延迟、跨native面的同步与整体丝滑仍未证明。

产品源码、安装版Electron、依赖和正式E2E未改；安装版exe哈希仍为`4d313d128cb9d2412dc17a7beefb1d79269825e3a3ffa0af611c203c836a1ab6`。上述应用会话全部exit0、PID退出、专用锁释放；5GiB整树硬限与owned cleanup保留。当前无Electron／Chromium完整源码或depot_tools、剩余磁盘约17GiB，未擅自启动全量下载／构建。

证据：`.scratch/workspace-drag-ab-GI6ANB/swapchain-progress-20261102.json`、`swapchain-candidate-inputs.json`、`native-warp-atomic-ab/comparison.json`、`swapchain-product-r1/`、`swapchain-functional-r6/{native-window-acceptance,resize-acceptance,browser-acceptance,browser-after-drag,comparison,version-environment,exit}.json`、`presenter-timing-abba-assessment.json`、`presenter-slim-assessment.json`；实屏图`swapchain-functional-r6/0-after/desktop-0.png`及`swapchain-functional-r5/failure-desktop/desktop-0.png`。

### 2026-11-03 续记：改走硬件加速，提供设置与恢复闭环

只读核实当前 Accio 的启动日志、GPU feature 与设备：硬件加速、合成／栅格化实际开启，RTX 3070／ANGLE D3D11，不是 GPU 安全模式。用户随后明确选择 Windows 默认启用加速、关闭 GPU 进程沙箱，并要求设置页可控、连续崩溃自动降级与手动恢复；此前软件模式实验约束不再是当前产品方向。未投递私有 WARP 二进制或升级 Electron。

GPU 策略、当前 userData 的 graphics.json 与崩溃观察归 Main `desktop/graphics.ts`；设置→通用开关通过仅主窗口主框架允许的 retained IPC，统一退出先保存浏览器数据，再原子写模式，清理确认后 native relaunch。30 秒内 6 次 GPU crashed 请求软件 recovery，失败后冷却 90 秒并等待新风暴，软件模式不重复重启。读取坏配置有日志并进入 recovery；不新增 Rust desired、OpenClaw 字段、Renderer persist 或通用恢复框架。

真实专用 licensed profile 取消与开关重启通过；最终关闭后 hardware=false／gpu_compositing=disabled_software，恢复后 hardware=true／合成与栅格化 enabled，实际 RTX 3070／ANGLE D3D11。重启后早期 feature status 可能尚为软件快照，需完整进入页面并 await getGPUInfo('complete') 后交叉核设备，不能只拿设置开关证明硬件恢复。另在真实 Main 注入模拟 GPU crashed 事件，前 5 次不降级，第 6 次沿产品真实退出／持久化／native relaunch 进入软件 recovery、显示原因，软件模式再 12 次事件不重启；用户开关恢复硬件通过。模拟事件不证明真实驱动崩溃分类、跨显卡兼容或所有故障可恢复。

双 noEmit、定向 lint、JS build、check:e2e 通过。现有两 suites 11 项为 2 pass／9 fail：7 项旧 Electron mock 缺 hasSwitch，另 2 项当前 export／IPC 精确快照差异（含本轮新增 GPU 通道），未改测试洗绿。真实磁盘失败与浏览器 prepareQuit 拒绝未动态验；软件降级仍可能回到原 Win10 GDI 混帧路径，不能宣称无条件根治拖动。全部最终应用 exit0、无专用残留进程、锁释放，专用偏好恢复 enabled；未改日常 Accio／Matcha 配置，未发布。本轮 JS 工件不作为其他会话未构建的 native IAB 链路证据。详细原件与失败轮：[GPU 验证记录](../../.scratch/workspace-drag-ab-GI6ANB/gpu-settings-validation-20261103.md)。

同日用户再次质疑补丁式实现。前版真实重启通过，但 controller changing／restarting 与入口 graphicsRestart 共同持有同一变更，保存和回执通过 save/resolve 回调交接；此前直接宣称 Final-form 已收口过满。最终在原两生产文件收敛：GPU owner 用 requested／committed 单一联合状态持有变更、原子保存、失败回执和 relaunch 策略，入口只编排浏览器准备→GPU提交→原清理→GPU确认重启；旧回调与重复标记全部删除，UI／IPC／文件格式不变，不新增通用框架。最终 Electron noEmit、限定lint、JSbuild、check:e2e均0；新工件同一专用profile真实取消、关闭→开启→模拟GPU风暴降级→UI恢复四次native relaunch通过，逐次核实际软件／RTX3070合成，最终exit0、进程清空、锁释放。源码内存验证另覆盖取消、写失败、并发、冷却及unconfirmed不重启；不当作真实磁盘／驱动故障。旧11项单测本次未重跑，不声明失败消失。证据：上述验证记录最终结构节、`gpu-single-owner-20261103/{receipts,exit}.json`。
