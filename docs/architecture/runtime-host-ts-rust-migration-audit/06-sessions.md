# 06 — Session Domain 文件级 TS → Rust 迁移审计

> **静态审计状态：完成（当前工作树快照）。** 本报告是旧 TypeScript 的文件级事实与迁移证据，不是 Rust 实施批准书，也不是运行时 exactly-once/replay 承诺。
>
> **范围：** `runtime-host/application/sessions/**` 当前存在的全部 `.ts`（含 `canonical/`、`tool/`）。Python 在当前主工作树枚举得到 **58** 个文件、10,805 行；随后以 `Path.read_text(encoding='utf-8')` 对每个文件逐一完整读取。先用 `.codegraph` 追踪 `SessionIdentity → prompt/run/approval → gateway ingress → timeline/reducer/projection → state store/catalog/render/execution graph`，再审计文件。
>
> **边界结论：** Session 是 **Domain Module**。canonical timeline/reducer 是单一 Session 的规范事实归并与投影输入，不能提升为全平台万能 event kernel；UI/tool render、catalog 和 snapshot 都是投影，不是事实源。完整 `SessionIdentity = endpoint + agentId + sessionKey`（key 由 `buildSessionIdentityKey` 构造）是正确串行维度：`SessionOperationCoordinator` 对经过它的操作按完整 identity 串行、不同 identity 可并行；但 gateway ingress 等并不都经过它，因此旧代码**未证明**整个域已统一串行。外部 Runtime 的投递、重试、去重、持久事件日志和 replay 语义均不可从本域伪称为 exactly-once 或可靠 replay。

## 已读文件清单（58/58）

```text
runtime-host/application/sessions/assistant-segment-media.ts
runtime-host/application/sessions/assistant-turn-assembler.ts
runtime-host/application/sessions/assistant-turn-entry.ts
runtime-host/application/sessions/canonical/canonical-approval-events.ts
runtime-host/application/sessions/canonical/canonical-events.ts
runtime-host/application/sessions/canonical/canonical-projection.ts
runtime-host/application/sessions/canonical/canonical-reducer.ts
runtime-host/application/sessions/canonical/canonical-state.ts
runtime-host/application/sessions/canonical/canonical-transcript-replay.ts
runtime-host/application/sessions/service.ts
runtime-host/application/sessions/session-catalog-jobs.ts
runtime-host/application/sessions/session-catalog-model.ts
runtime-host/application/sessions/session-catalog.ts
runtime-host/application/sessions/session-command-service.ts
runtime-host/application/sessions/session-context-tokens.ts
runtime-host/application/sessions/session-execution-graph-runtime.ts
runtime-host/application/sessions/session-gateway-ingress-service.ts
runtime-host/application/sessions/session-hydration-jobs.ts
runtime-host/application/sessions/session-metadata-repository.ts
runtime-host/application/sessions/session-operation-coordinator.ts
runtime-host/application/sessions/session-prompt-service.ts
runtime-host/application/sessions/session-render-model.ts
runtime-host/application/sessions/session-runtime-requests.ts
runtime-host/application/sessions/session-runtime-state.ts
runtime-host/application/sessions/session-runtime-store-repository.ts
runtime-host/application/sessions/session-runtime-types.ts
runtime-host/application/sessions/session-snapshot-service.ts
runtime-host/application/sessions/session-state-model.ts
runtime-host/application/sessions/session-storage-repository.ts
runtime-host/application/sessions/session-timeline-runtime.ts
runtime-host/application/sessions/session-transcript-timeline-loader.ts
runtime-host/application/sessions/session-value-normalization.ts
runtime-host/application/sessions/session-window-model.ts
runtime-host/application/sessions/state-only-tools.ts
runtime-host/application/sessions/task-completion-events.ts
runtime-host/application/sessions/task-snapshot-normalizer.ts
runtime-host/application/sessions/timeline-state.ts
runtime-host/application/sessions/todo-tool-debug.ts
runtime-host/application/sessions/tool/tool-card-content.ts
runtime-host/application/sessions/tool/tool-card-preview.ts
runtime-host/application/sessions/tool/tool-card-render-state.ts
runtime-host/application/sessions/tool/tool-card-utils.ts
runtime-host/application/sessions/tool/tool-display-browser-detail.ts
runtime-host/application/sessions/tool/tool-display-common.ts
runtime-host/application/sessions/tool/tool-display-detail-resolvers.ts
runtime-host/application/sessions/tool/tool-display-exec-shell.ts
runtime-host/application/sessions/tool/tool-display-exec.ts
runtime-host/application/sessions/tool/tool-display-format.ts
runtime-host/application/sessions/tool/tool-display-message-detail.ts
runtime-host/application/sessions/tool/tool-display.ts
runtime-host/application/sessions/tool-event-sanitizer.ts
runtime-host/application/sessions/tool-result-media.ts
runtime-host/application/sessions/transcript-content-extractors.ts
runtime-host/application/sessions/transcript-labels.ts
runtime-host/application/sessions/transcript-media-extractors.ts
runtime-host/application/sessions/transcript-parser.ts
runtime-host/application/sessions/transcript-task-snapshot-replay.ts
runtime-host/application/sessions/transcript-types.ts
```

## 调用关系与迁移总原则

1. Delivery/capability/route → `SessionRuntimeService` → command/prompt/ingress façades；真正 command、run、approval、hydration 规则在 `application/workflows/session-*`（07 分片）和 Runtime Integration。
2. `SessionPromptService` 验证完整 identity 后委托 run workflow；该 workflow 通过 coordinator 写本地 canonical 事实、snapshot、持久 selector，再后台发送 Runtime。成功仅表示本地接受/开始发送，非外部 Runtime 确认。
3. Runtime gateway notification/conversation event → `SessionGatewayIngressWorkflow` → `SessionTimelineRuntime.appendCanonicalEvents()` → reducer → projection/index/snapshot → optional update emitter。该 ingress 未见统一 coordinator fence。
4. hydrate/replay 通过 storage 或 Runtime external transcript、协议 replay adapter 输入 canonical event；它不是持久 event log。`SessionRuntimeStateStore` 只持久化 active-session selector，canonical state/timeline/index 不落该 store。
5. `CanonicalSessionState` 是事实；timeline、execution graph、render item、catalog label、window 和 UI tool cards均为派生。Rust 应让 Session Domain actor/aggregate 维护事实与版本，投影在其后派生；Runtime Integration 只翻译 Runtime 私有协议。
6. 下面的 Rust 建议均是**未来落点**，不是现有 Rust 代码事实。局部本地 JSON/clone/扫描的成本可优化，但这与 LLM/Runtime 网络延迟、外部 transcript I/O 是不同成本；不得泛称“Rust 更快”。

---

### runtime-host/application/sessions/assistant-segment-media.ts

- **当前 owner：** Session assistant media 的纯 render projection helper；symbols `extractImagesFromSingleBlock`、`extractImagesAsAttachedFiles`。
- **职责与关键 symbols：** Session assistant media 的纯 render projection helper；symbols `extractImagesFromSingleBlock`、`extractImagesAsAttachedFiles`。
- **旧语义与策略：** 接受 base64、URL、顶层 data 与嵌套 `tool_result` 内容，分别投影 image/attached file；不下载、不验证 URL、不写事实。
- **状态、存储与副作用：** 无状态、I/O、网络或持久化。
- **并发与性能特征：** 线性扫描且保留 base64；递归无深度/环限制，非 LLM/Runtime 延迟。
- **调用/依赖边界：** canonical projection/replay 使用；依赖 shared render DTO。
- **故障、恢复与安全：** `content` 数组中的 `null`/`undefined` 被断言后直接访问 `block.type`，可抛出并击穿 replay/projection；不做 redaction。
- **迁移分类：** Preserve：媒体形状及 image/file 分离。Intentional Improvement：对象 guard、深度/容量预算须明确兼容影响。Defect：坏数组元素触发 TypeError（代码可证）。待验证：Runtime 是否只给 JSON 安全数组。
- **未来 Rust owner：** Domain Module；`Vec<RenderImage/AttachedFile>` 纯投影函数，无 actor/storage/I-O。
- **Rust 重写与性能判断：** 消除的是本地异常与无界递归风险，保持输出形状；测坏输入拒绝/跳过率和峰值内存，不把它归因于网络。
- **验证 oracle：** 合法媒体测试与 `[null]`、嵌套 tool_result、超深输入差分 fixture；证据：本文件、`canonical/canonical-projection.ts`、`canonical/canonical-transcript-replay.ts`。
- **证据：** 源码 `runtime-host/application/sessions/assistant-segment-media.ts`；调用/依赖边界：canonical projection/replay 使用；依赖 shared render DTO。；验证 oracle：合法媒体测试与 `[null]`、嵌套 tool_result、超深输入差分 fixture；证据：本文件、`canonical/canonical-projection.ts`、`canonical/canonical-transcript-replay.ts`。

### runtime-host/application/sessions/assistant-turn-assembler.ts

- **当前 owner：** timeline assistant turn + runtime snapshot 的 render assembler；`assembleAuthoritativeAssistantTurns`、pending/identity helpers。
- **职责与关键 symbols：** timeline assistant turn + runtime snapshot 的 render assembler；`assembleAuthoritativeAssistantTurns`、pending/identity helpers。
- **旧语义与策略：** 基于 authoritative timeline 拼 text/thinking/tool/media，runtime 只影响 streaming/waiting/pending 显示，不能回写事实。
- **状态、存储与副作用：** 纯投影；clone segment/tool/image/file，无存储。
- **并发与性能特征：** 对每个 entry clone；`resolvePendingState` 为判定是否有 tool 再派生/clone 一次，局部冗余分配。无队列。
- **调用/依赖边界：** 被 `session-render-model.ts`、canonical projection 消费；依赖 assistant turn DTO。
- **故障、恢复与安全：** structured clone 异常不捕获；active runtime 且无 pending turn key 时可能将 active entry 标 pending，语义待 fixture 证明。
- **迁移分类：** Preserve：事实→展示单向性。Intentional Improvement：传递已派生 tool 数避免二次 clone。Defect：无已证实。待验证：多 turn/recovery 下 pending 绑定。
- **未来 Rust owner：** Domain Module 的 presentation projector；不可作为事实存储。
- **Rust 重写与性能判断：** 只消除局部 clone；指标为每次投影分配与 CPU，不与 Runtime/LLM 等待混淆。
- **验证 oracle：** canonical timeline render/turn ordering fixture；证据：本文件、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/assistant-turn-assembler.ts`；调用/依赖边界：被 `session-render-model.ts`、canonical projection 消费；依赖 assistant turn DTO。；验证 oracle：canonical timeline render/turn ordering fixture；证据：本文件、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。

### runtime-host/application/sessions/assistant-turn-entry.ts

- **当前 owner：** 单 assistant timeline entry/key 的纯构造器；`buildAssistantTurnEntryKey`、`buildAssistantTurnEntry`。
- **职责与关键 symbols：** 单 assistant timeline entry/key 的纯构造器；`buildAssistantTurnEntryKey`、`buildAssistantTurnEntry`。
- **旧语义与策略：** final/error 投影无结果 running tool 为 `missing_result`；stable key 是投影标识，非 SessionIdentity。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 常数级构造；无锁/队列。
- **调用/依赖边界：** canonical projection 组装 timeline。
- **故障、恢复与安全：** 非 final/error 不 clone segments；aborted 不走 missing-result 映射，是否故意待验证。
- **迁移分类：** Preserve：key/最终工具状态规则。Intentional Improvement：明确输入不可变或 clone。Defect：无已证实。待验证：aborted 工具 UI 契约。
- **未来 Rust owner：** Domain Module render projector；无 actor/storage/I-O。
- **Rust 重写与性能判断：** 无性能迁移理由；以 final/error/aborted golden trace 验证。
- **验证 oracle：** canonical timeline 测试的 tool rendering；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/assistant-turn-entry.ts`；调用/依赖边界：canonical projection 组装 timeline。；验证 oracle：canonical timeline 测试的 tool rendering；证据：本文件。

### runtime-host/application/sessions/canonical/canonical-approval-events.ts

- **当前 owner：** Gateway approval notification → Session canonical approval event 的协议归一化 helper；`buildCanonicalApprovalEventsFromGatewayNotification`。
- **职责与关键 symbols：** Gateway approval notification → Session canonical approval event 的协议归一化 helper；`buildCanonicalApprovalEventsFromGatewayNotification`。
- **旧语义与策略：** 仅 `exec/plugin.approval.requested|resolved`；从顶层/data/request 提取 ID、session/run、argv、时间、决策；过期 pending 丢弃。
- **状态、存储与副作用：** 纯同步，仅 structuredClone raw/request；无持久化。
- **并发与性能特征：** argv/decision 线性处理；无 identity queue。
- **调用/依赖边界：** ingress workflow 取得其 event，再交 timeline reducer。
- **故障、恢复与安全：** `structuredClone` 可抛；event id 为 endpoint/status/session/approval ID，若 Runtime 用同 ID 更新 pending 快照，state-local 去重可能吞更新，尚待 Runtime 语义确认。
- **迁移分类：** Preserve：未知 payload 不建事件、默认安全决策。Intentional Improvement：先定义 pending 更新协议再变更 event identity。Defect：无确定功能缺陷。待验证：重复 pending 更新、不可 clone raw。
- **未来 Rust owner：** Runtime Integration 翻译 + Domain Module canonical event contract；无 actor/storage/I-O。
- **Rust 重写与性能判断：** 以表驱动 parser 取代零散 shape 读取；指标为错误输入归一化，无网络性能结论。
- **验证 oracle：** pending requested/resolved/expiry 单测；证据：本文件、`tests/unit/runtime-host-pending-approval-store.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-approval-events.ts`；调用/依赖边界：ingress workflow 取得其 event，再交 timeline reducer。；验证 oracle：pending requested/resolved/expiry 单测；证据：本文件、`tests/unit/runtime-host-pending-approval-store.test.ts`。

### runtime-host/application/sessions/canonical/canonical-events.ts

- **当前 owner：** Session canonical event TypeScript contract；消息、thought、tool、lifecycle、approval、task、artifact、replay boundary 联合体。
- **职责与关键 symbols：** Session canonical event TypeScript contract；消息、thought、tool、lifecycle、approval、task、artifact、replay boundary 联合体。
- **旧语义与策略：** 只定义输入形状；不验证、传输、排序、落盘或跨 Session 编排。虽有 `CanonicalOrderKey`，reducer 按 iterable 抵达顺序，不消费 `event.order`。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 类型文件，无队列/成本。
- **调用/依赖边界：** adapter/replay/ingress 生产，reducer 消费。
- **故障、恢复与安全：** `origin.raw/payload/content` 为 unknown；该契约不保证 clone、顺序或 replay。
- **迁移分类：** Preserve：Session 域事件范围。Intentional Improvement：若 order 成为语义须有明确 conflict policy。Defect：无。待验证：adapter 是否产生 order 并期望排序。
- **未来 Rust owner：** Domain Module event enum，Runtime 私有字段留 Runtime Integration；事件追加/cursor 原语由 Foundation Kernel，但不要扩大本事件为平台 kernel。
- **Rust 重写与性能判断：** 无直接性能命题；用 protocol fixture 和 reducer differential trace。
- **验证 oracle：** canonical contract/timeline tests；证据：本文件、`canonical-reducer.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-events.ts`；调用/依赖边界：adapter/replay/ingress 生产，reducer 消费。；验证 oracle：canonical contract/timeline tests；证据：本文件、`canonical-reducer.ts`。

### runtime-host/application/sessions/canonical/canonical-projection.ts

- **当前 owner：** 从 canonical state 派生 timeline、execution graph、render item/index 的 projection owner；`buildTimelineEntriesFromCanonicalState`、`buildProjectedCanonicalSessionState`、incremental functions。
- **职责与关键 symbols：** 从 canonical state 派生 timeline、execution graph、render item/index 的 projection owner；`buildTimelineEntriesFromCanonicalState`、`buildProjectedCanonicalSessionState`、incremental functions。
- **旧语义与策略：** canonical → timeline → render 单向；execution graph capped 32 steps；所谓 incremental 仍建全 state index、重建 render，显式 turn binding/零 affected key 退化全量。
- **状态、存储与副作用：** 创建数组/Map/Set/clone，不写 canonical 事实。
- **并发与性能特征：** 至少随 canonical/timeline 规模线性；local clone/JSON 成本与 LLM/Runtime 网络延迟无关。
- **调用/依赖边界：** timeline runtime、execution graph runtime 调用；依赖 tool/media/assistant render helpers。
- **故障、恢复与安全：** JSON stringify 某 graph detail 才降级；其他 clone/media异常中断投影。`content:[null]` 可经 media helper 触发错误。
- **迁移分类：** Preserve：canonical 为唯一输入、render 非事实。Intentional Improvement：对“incremental”建立基准并只优化真实重建成本。Defect：坏 media 输入可失败（由下游可证）。待验证：graph tail duplicate key 规则。
- **未来 Rust owner：** Domain Module projector；纯 `CanonicalState -> Timeline/Render/Graph`，不设全平台 actor/storage。
- **Rust 重写与性能判断：** 先测全量索引、render rebuild、媒体 clone；保持排序/anchor/32 step 行为，oracle 是 golden projection + allocation/latency benchmark。
- **验证 oracle：** canonical timeline tests；证据：本文件、`assistant-segment-media.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-projection.ts`；调用/依赖边界：timeline runtime、execution graph runtime 调用；依赖 tool/media/assistant render helpers。；验证 oracle：canonical timeline tests；证据：本文件、`assistant-segment-media.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。

### runtime-host/application/sessions/canonical/canonical-reducer.ts

- **当前 owner：** 单 Session canonical state 原地 reducer；identity/key reader、empty state、single/batch reduce。
- **职责与关键 symbols：** 单 Session canonical state 原地 reducer；identity/key reader、empty state、single/batch reduce。
- **旧语义与策略：** message/thought/tool/approval/control/task/runtime 归并；endpoint/protocol 不匹配拒绝；按 event ID 做 state-local 去重。当前工作树本地改动增加 terminal run guard、terminal error/abort cleanup、finalizing 语义。
- **状态、存储与副作用：** 原地更新事实数组、Map/Set、runtime/control/approval index；不直接 I-O。
- **并发与性能特征：** tool/approval terminal cleanup 线性；同步单调用不让出 JS，但无内部锁，调用方必须按完整 identity 序列化。
- **调用/依赖边界：** `SessionTimelineRuntime.appendCanonicalEvents` 调用；事件来自 ingress/replay/run workflow。
- **故障、恢复与安全：** event ID 在 payload clone/upsert 前写入去重集合；不可 clone payload 抛错后同 ID retry 被吞，且可能留部分状态，已证实原子性缺口。event/terminal run set 无保留上限。
- **迁移分类：** Preserve：identity 硬匹配、state-local dedupe、Session 而非平台 kernel。Intentional Improvement：定义 commit 原子性/失败策略后才改变 dedupe。Defect：先标 event ID 后可抛导致 retry 吞失。待验证：长期 event/run 集合 retention。
- **未来 Rust owner：** Domain Module aggregate/reducer，`HashMap/HashSet` 派生 index；同 identity actor/mailbox 承担串行，非全局 actor。
- **Rust 重写与性能判断：** 消除失败半提交而非声称更快；测 event apply p50/p99、state memory、fault-injection retry 和 diff trace；外部 runtime delivery 不计入。
- **验证 oracle：** duplicate/terminal run timeline tests，新增不可序列化/clone 失败 fault test；证据：本文件、`canonical-state.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-reducer.ts`；调用/依赖边界：`SessionTimelineRuntime.appendCanonicalEvents` 调用；事件来自 ingress/replay/run workflow。；验证 oracle：duplicate/terminal run timeline tests，新增不可序列化/clone 失败 fault test；证据：本文件、`canonical-state.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`。

### runtime-host/application/sessions/canonical/canonical-state.ts

- **当前 owner：** canonical fact shape 与可重建索引；`CanonicalSessionState`、`rebuildCanonicalSessionIndexes`、`cloneCanonicalSessionState`。
- **职责与关键 symbols：** canonical fact shape 与可重建索引；`CanonicalSessionState`、`rebuildCanonicalSessionIndexes`、`cloneCanonicalSessionState`。
- **旧语义与策略：** messages/thoughts/tools/approvals 等为事实，Map/Set 是派生 index；clone 后 rebuild index。
- **状态、存储与副作用：** rebuild 原地重建；clone 使用 structuredClone；无 I-O。
- **并发与性能特征：** clone/rebuild 随完整 state 线性；无锁。
- **调用/依赖边界：** reducer 写，projection/read model 用。
- **故障、恢复与安全：** unknown facts 不可 clone 时抛；clone 先复制部分随后覆盖的派生 index，产生无效分配；event/terminal run retention 未限定。
- **迁移分类：** Preserve：事实/索引分层。Intentional Improvement：clone 时跳过所有派生 index。Defect：无单独确定缺陷。待验证：payload cloneability/retention policy。
- **未来 Rust owner：** Domain Module aggregate state，事实 `Vec/Map` 与 rebuildable index；storage 需独立持久事实 schema，不能把 render 当 store。
- **Rust 重写与性能判断：** 测 clone/rebuild allocation，保持索引重建结果；故障 oracle 为含坏 payload 的 clone/apply trace。
- **验证 oracle：** reducer/projection differential tests；证据：本文件、`canonical-reducer.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-state.ts`；调用/依赖边界：reducer 写，projection/read model 用。；验证 oracle：reducer/projection differential tests；证据：本文件、`canonical-reducer.ts`。

### runtime-host/application/sessions/canonical/canonical-transcript-replay.ts

- **当前 owner：** transcript → canonical Session events 的 replay adapter；iterable/async iterable generators。
- **职责与关键 symbols：** transcript → canonical Session events 的 replay adapter；iterable/async iterable generators。
- **旧语义与策略：** 过滤内部控制/显示消息和 state-only tool；按 run/parent 链绑定 assistant/tool，带 visited loop guard；不是通用 replay framework。
- **状态、存储与副作用：** 只 yield 事件，不写 state；reducer 消费其输出。
- **并发与性能特征：** 先完整缓存 transcript 再计算 binding，O(n) 内存、首条 message 要等待完整输入；真实 transcript I-O 在 loader/Runtime，不在此文件。
- **调用/依赖边界：** runtime protocol replay adapter、timeline hydrate；使用 transcript/media/task helpers。
- **故障、恢复与安全：** generator 在 start 后无 try/finally；上游/媒体抛错时不 yield end，reducer 可残留 replay depth，已证实边界缺口；不能据此承诺 replay 完整。
- **迁移分类：** Preserve：owner binding、visited guard、state-only filter。Intentional Improvement：先确定 transcript size/first-screen budget与失败闭合。Defect：异常 replay boundary 不闭合。待验证：Runtime transcript 的大小及异常模型。
- **未来 Rust owner：** Domain Module replay translator，Runtime Integration 提供 transcript source；按 Session actor append，不成为全平台 replay engine。
- **Rust 重写与性能判断：** 消除的是全量缓存/未闭合边界；测首事件延迟、峰值内存、异常后 depth；不要与外部读取延迟混称。
- **验证 oracle：** 合法 gateway media 与上游 iterator throw fault injection；证据：本文件、`transcript-parser.ts`、`tests/unit/transcript-utils.gateway-media.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/canonical/canonical-transcript-replay.ts`；调用/依赖边界：runtime protocol replay adapter、timeline hydrate；使用 transcript/media/task helpers。；验证 oracle：合法 gateway media 与上游 iterator throw fault injection；证据：本文件、`transcript-parser.ts`、`tests/unit/transcript-utils.gateway-media.test.ts`。

### runtime-host/application/sessions/service.ts

- **当前 owner：** `SessionRuntimeService` 应用 façade；真实 owner 是 catalog/ingress/command/prompt 服务。
- **职责与关键 symbols：** `SessionRuntimeService` 应用 façade；真实 owner 是 catalog/ingress/command/prompt 服务。
- **旧语义与策略：** 原样转发 ingress、command、prompt，refresh 直接刷新 catalog cache；不解析 payload、不 reduce。
- **状态、存储与副作用：** 自身无；下游所有。
- **并发与性能特征：** 无锁/队列/identity 分片；注入但未直接用的 state/timeline/snapshot/coordinator 不能形成串行保证。
- **调用/依赖边界：** route/capability 上游，专用 session services 下游。
- **故障、恢复与安全：** 无 catch，rejection 原样传播。
- **迁移分类：** Preserve：façade 不绕过领域边界。Intentional Improvement：组合依赖应与实际使用一致。Defect：无。待验证：所有 route 是否只经本 façade。
- **未来 Rust owner：** Delivery/application adapter；领域事实仍在 Domain Module。
- **Rust 重写与性能判断：** 无数据结构/I-O；以 API 响应和 delegation trace 验证。
- **验证 oracle：** route/capability fixture；证据：本文件、composition session module。
- **证据：** 源码 `runtime-host/application/sessions/service.ts`；调用/依赖边界：route/capability 上游，专用 session services 下游。；验证 oracle：route/capability fixture；证据：本文件、composition session module。

### runtime-host/application/sessions/session-catalog-jobs.ts

- **当前 owner：** catalog refresh job submission adapter；`createSessionCatalogJobPort`。
- **职责与关键 symbols：** catalog refresh job submission adapter；`createSessionCatalogJobPort`。
- **旧语义与策略：** 固定 `sessions.refreshCatalog`、low queue、全局 dedupe key/cooldown；latest job lookup。
- **状态、存储与副作用：** 提交到 Runtime long-task system；本文件不扫描 catalog。
- **并发与性能特征：** 所有 endpoint/session 共用一个 refresh dedupe key，刻意合并 refresh；非 per-session queue。
- **调用/依赖边界：** catalog workflow/route 触发，runtime task port 执行。
- **故障、恢复与安全：** stopped queue/未注册 handler 由下游抛；无身份或 secret。
- **迁移分类：** Preserve：去重/cooldown。Intentional Improvement：仅在产品需要 endpoint 独立 refresh 时分片 key。Defect：无。待验证：全局合并是否可延迟某 endpoint。
- **未来 Rust owner：** Foundation Kernel task submission + Domain Module catalog intent；不持有 session facts。
- **Rust 重写与性能判断：** 量化重复 refresh 数、扫描 I-O；保持 dedupe observable job state；oracle 为 task queue fixture。
- **验证 oracle：** job dedupe/cooldown trace；证据：本文件、runtime task ports。
- **证据：** 源码 `runtime-host/application/sessions/session-catalog-jobs.ts`；调用/依赖边界：catalog workflow/route 触发，runtime task port 执行。；验证 oracle：job dedupe/cooldown trace；证据：本文件、runtime task ports。

### runtime-host/application/sessions/session-catalog-model.ts

- **当前 owner：** timeline/runtime/context → `SessionCatalogItem` projection；`createSessionCatalogItem`。
- **职责与关键 symbols：** timeline/runtime/context → `SessionCatalogItem` projection；`createSessionCatalogItem`。
- **旧语义与策略：** key suffix 推 kind，main preferred；显式 label 优先 timeline label，last activity 从末尾 timeline timestamp 后退至 runtime，model 优先 runtimeModel。
- **状态、存储与副作用：** 纯构造；catalog 非事实源。
- **并发与性能特征：** label/last activity 反向线性扫描；无队列。
- **调用/依赖边界：** catalog workflow、state snapshot 使用；依赖 labels/timeline state。
- **故障、恢复与安全：** 无 catch；不 redaction label/model。
- **迁移分类：** Preserve：label/model/kind precedence。Intentional Improvement：显式 catalog version 以处理并发 snapshot。Defect：无。待验证：suffix 分类是否覆盖所有 Runtime key。
- **未来 Rust owner：** Domain Module catalog projection；storage catalog scan 在 Runtime Integration。
- **Rust 重写与性能判断：** 可缓存 label/activity 仅当 timeline version 驱动；测扫描/alloc而非网络。
- **验证 oracle：** catalog service tests与 timeline label fixtures；证据：本文件、`transcript-labels.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-catalog-model.ts`；调用/依赖边界：catalog workflow、state snapshot 使用；依赖 labels/timeline state。；验证 oracle：catalog service tests与 timeline label fixtures；证据：本文件、`transcript-labels.ts`。

### runtime-host/application/sessions/session-catalog.ts

- **当前 owner：** `SessionCatalogService` façade/port。
- **职责与关键 symbols：** `SessionCatalogService` façade/port。
- **旧语义与策略：** list descriptor、refresh cache、snapshot meta、list/scan 皆委托 catalog workflow。
- **状态、存储与副作用：** 无自身状态，workflow 有 cache/scan I-O。
- **并发与性能特征：** 无同步策略；调用者并发决定 refresh/scan。
- **调用/依赖边界：** SessionRuntimeService/workflows → catalog workflow。
- **故障、恢复与安全：** 原样传播；无 secret逻辑。
- **迁移分类：** Preserve：port隔离。Intentional Improvement：明确 cache consistency。Defect：无。待验证：并发 refresh 闭合。
- **未来 Rust owner：** Domain Module query port，Runtime Integration/storage scanner 实现。
- **Rust 重写与性能判断：** 无直接优化；以 cache meta/list trace 验证。
- **验证 oracle：** session catalog service tests；证据：本文件、07 catalog workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-catalog.ts`；调用/依赖边界：SessionRuntimeService/workflows → catalog workflow。；验证 oracle：session catalog service tests；证据：本文件、07 catalog workflow。

### runtime-host/application/sessions/session-command-service.ts

- **当前 owner：** `SessionCommandService` workflow typed delegation boundary。
- **职责与关键 symbols：** `SessionCommandService` workflow typed delegation boundary。
- **旧语义与策略：** create/delete/archive/status/list/load/resume/patch/rename/switch/window/abort/approval/hydration 原样委托；hydration 返回契约不同于 application response。
- **状态、存储与副作用：** 无，均在 workflow。
- **并发与性能特征：** 无 per-identity queue；不能由本文件证明所有 command 串行。
- **调用/依赖边界：** façade/route 上游，session command operations workflow 下游。
- **故障、恢复与安全：** 无 catch。
- **迁移分类：** Preserve：service 不装入业务状态。Intentional Improvement：调用方须显式区分 hydration result。Defect：无。待验证：workflow identity fence 覆盖。
- **未来 Rust owner：** Delivery/application command adapter，Session actor拥有真实 mutation。
- **Rust 重写与性能判断：** 无 I-O；以 command response/diff trace 验证。
- **验证 oracle：** session runtime fixture；证据：本文件、07 command workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-command-service.ts`；调用/依赖边界：façade/route 上游，session command operations workflow 下游。；验证 oracle：session runtime fixture；证据：本文件、07 command workflow。

### runtime-host/application/sessions/session-context-tokens.ts

- **当前 owner：** token snapshot 纯 parser；`readSessionContextTokenSnapshot`。
- **职责与关键 symbols：** token snapshot 纯 parser；`readSessionContextTokenSnapshot`。
- **旧语义与策略：** 只保留 finite total/context token 和 boolean freshness；全无效则 undefined。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(1)，无队列。
- **调用/依赖边界：** snapshot/catalog workflow。
- **故障、恢复与安全：** 畸形字段静默丢弃；接受负数/小数。
- **迁移分类：** Preserve：finite/boolean guard。Intentional Improvement：若领域要求非负整数，需新契约。Defect：无。待验证：上游 token 单位/估算语义。
- **未来 Rust owner：** Domain Module DTO parser；无 actor/storage/I-O。
- **Rust 重写与性能判断：** 无性能命题；表驱动有效/NaN/Infinity/negative oracle。
- **验证 oracle：** snapshot/catelog fixture；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/session-context-tokens.ts`；调用/依赖边界：snapshot/catalog workflow。；验证 oracle：snapshot/catelog fixture；证据：本文件。

### runtime-host/application/sessions/session-execution-graph-runtime.ts

- **当前 owner：** canonical projection/graph/render 刷新协调者；`refreshProjectedState`、`refreshRenderItems`、`refreshParents`。
- **职责与关键 symbols：** canonical projection/graph/render 刷新协调者；`refreshProjectedState`、`refreshRenderItems`、`refreshParents`。
- **旧语义与策略：** 用 canonical state 重建 timeline/graph/render/index；父会话仅已 hydrated 才刷新并 clamp window。
- **状态、存储与副作用：** 原地替换 timeline/projection、更新 graph dependency index，刷新 parent window。
- **并发与性能特征：** 无锁；全量 projection 依赖 state 长度；子变化可刷新多个 parent。
- **调用/依赖边界：** timeline runtime、state store、canonical projection/window model。
- **故障、恢复与安全：** 多字段更新无回滚，投影/index失败可能留下中间状态。
- **迁移分类：** Preserve：canonical 输入/已 hydration parent 条件。Intentional Improvement：同 identity fence/原子投影 swap。Defect：无确定。待验证：parent 仅重建 render 是否充分。
- **未来 Rust owner：** Domain Module projection cache；Session actor 内原子替换，dependency index 可作为域内派生状态。
- **Rust 重写与性能判断：** 测 parent fan-out 与重建分配；不将 Runtime 网络延迟归它。
- **验证 oracle：** canonical projection/graph fixture；证据：本文件、`session-timeline-runtime.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-execution-graph-runtime.ts`；调用/依赖边界：timeline runtime、state store、canonical projection/window model。；验证 oracle：canonical projection/graph fixture；证据：本文件、`session-timeline-runtime.ts`。

### runtime-host/application/sessions/session-gateway-ingress-service.ts

- **当前 owner：** gateway ingress 薄入口；`consumeEndpointNotification`、`consumeEndpointConversationEvent`、`emitUpdates`。
- **职责与关键 symbols：** gateway ingress 薄入口；`consumeEndpointNotification`、`consumeEndpointConversationEvent`、`emitUpdates`。
- **旧语义与策略：** workflow 先生成 updates，再逐个 emit；真正 identity 解析/canonical append/snapshot 在 07 ingress workflow。
- **状态、存储与副作用：** 自身无；下游可登记 identity、append canonical、更新 snapshot；可同步调用 UI update emitter。
- **并发与性能特征：** 不经 coordinator，未建立同 identity queue；不同 session亦无独立配额。
- **调用/依赖边界：** gateway event bridge/workflow 上游，optional session update delivery 下游。
- **故障、恢复与安全：** workflow/emitter 错误不捕获；composition 对异步 gateway 转发存在 catch-to-undefined，失败无重试/结果。不可翻译输入可为空更新。
- **迁移分类：** Preserve：commit 后 emit、不可翻译无副作用。Intentional Improvement：将 ingress order 放入 Session aggregate fence。Defect：composition 异步转发吞失败。待验证：adapter/event-source 去重与保序。
- **未来 Rust owner：** Runtime Integration ingress translator + Domain Module actor append；Delivery emitter 在 actor commit 后。
- **Rust 重写与性能判断：** 指标为 ingress ordering、drop/error observable rate；外部 gateway latency单列。
- **验证 oracle：** ingress workflow fixture/forced emitter failure；证据：本文件、07 ingress workflow、composition session module。
- **证据：** 源码 `runtime-host/application/sessions/session-gateway-ingress-service.ts`；调用/依赖边界：gateway event bridge/workflow 上游，optional session update delivery 下游。；验证 oracle：ingress workflow fixture/forced emitter failure；证据：本文件、07 ingress workflow、composition session module。

### runtime-host/application/sessions/session-hydration-jobs.ts

- **当前 owner：** hydration job submission/dedupe port；`buildSessionHydrationDedupeKey`、`createSessionHydrationJobPort`。
- **职责与关键 symbols：** hydration job submission/dedupe port；`buildSessionHydrationDedupeKey`、`createSessionHydrationJobPort`。
- **旧语义与策略：** low queue，drop result；key 包完整 identity、optional endpointSessionId、snapshot kind，window 还含 mode/limit/offset；慢路径 reconcile coordinator。
- **状态、存储与副作用：** enqueue only；真实 hydrate/replay/persist 在 workflow。
- **并发与性能特征：** 同 identity同参数 queued/running 去重；不同参数可并发提交，Runtime job queue 为共享全局并发而非 session workers。
- **调用/依赖边界：** command/hydration workflow 与 runtime long task ports。
- **故障、恢复与安全：** queue stopped/handler 未注册可抛；adapter不定义 retry。顶层 sessionKey 不入 dedupe key，但 handler验证其同 identity，一错误 payload可占 key使有效同 key请求复用错误 job。
- **迁移分类：** Preserve：identity/window 参数 dedupe、耗时任务脱离请求。Intentional Improvement：enqueue 前交叉校验及明确 retry。Defect：错误 top-level sessionKey 占同 identity dedupe key（代码路径可证）。待验证：全部调用点与 maxAttempts。
- **未来 Rust owner：** Foundation Kernel job dedupe + Domain Module hydrate command；worker 向 per-identity Session actor提交。
- **Rust 重写与性能判断：** 测去重率/queue等待/scan I-O/恢复时间，保持参数区分；不声称外部 Runtime replay。
- **验证 oracle：** queue dedupe/error-then-valid trace；证据：本文件、07 hydration workflow、`core/jobs.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-hydration-jobs.ts`；调用/依赖边界：command/hydration workflow 与 runtime long task ports。；验证 oracle：queue dedupe/error-then-valid trace；证据：本文件、07 hydration workflow、`core/jobs.ts`。

### runtime-host/application/sessions/session-metadata-repository.ts

- **当前 owner：** session model metadata port wrapper；`SessionMetadataRepository.resolveSessionModel`，并 re-export model helpers。
- **职责与关键 symbols：** session model metadata port wrapper；`SessionMetadataRepository.resolveSessionModel`，并 re-export model helpers。
- **旧语义与策略：** 原样委托 session-model-resolution workflow，model 可来自 storage/runtime。
- **状态、存储与副作用：** 自身无；下游可能读 metadata/config。
- **并发与性能特征：** 无 cache/lock；async I-O 由下游。
- **调用/依赖边界：** catalog/snapshot workflows 与 session model resolution workflow。
- **故障、恢复与安全：** 无 catch，未知 Runtime/config 错误原样传播；无 secret owner。
- **迁移分类：** Preserve：repository port隔离。Intentional Improvement：把 Runtime-specific model lookup留 Integration。Defect：无。待验证：fallback/default model consistency。
- **未来 Rust owner：** Domain Module metadata port；Runtime Integration/model config adapter 实现。
- **Rust 重写与性能判断：** 测真实 storage/config I-O，不能给 wrapper作性能结论。
- **验证 oracle：** catalog service fixture/model workflow tests；证据：本文件、07 model resolution workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-metadata-repository.ts`；调用/依赖边界：catalog/snapshot workflows 与 session model resolution workflow。；验证 oracle：catalog service fixture/model workflow tests；证据：本文件、07 model resolution workflow。

### runtime-host/application/sessions/session-operation-coordinator.ts

- **当前 owner：** 进程内 per-identity Promise-tail coordinator；`run`、`queues`、sequence。
- **职责与关键 symbols：** 进程内 per-identity Promise-tail coordinator；`run`、`queues`、sequence。
- **旧语义与策略：** `buildSessionIdentityKey` 作队列 key；prompt/abort/patch-model/resume/reconcile 排队，前一失败后也继续；finally仅删当前 tail；成功带 snapshot才更新 latest result。
- **状态、存储与副作用：** Map identity→Promise 与 sequence；无持久化。
- **并发与性能特征：** **经过它的**同完整 identity 串行、不同 identity并行；不是全域统一栅栏。
- **调用/依赖边界：** session run/hydration/workflow 调用；result workflow下游。
- **故障、恢复与安全：** 前一 rejection 不永久阻塞；无 callback 抛。latest result cache无 TTL/eviction/delete cleanup。
- **迁移分类：** Preserve：完整 identity，不用裸 sessionKey；失败后继续。Intentional Improvement：最新结果上限/TTL、让 ingress也入同 actor。Defect：latest results无上限进程内 Map，长期占内存。待验证：operationId是否仅诊断且不可跨进程。
- **未来 Rust owner：** Domain Module Session actor registry（`HashMap<SessionIdentity, mailbox>`）；actor state/receipt需要容量与生命周期，不能承诺跨进程一次性。
- **Rust 重写与性能判断：** 目标是可观测 mailbox/backpressure和 bounded cache；测 queue wait、actor count、memory、failed operation后续可执行性。
- **验证 oracle：** same identity ordering/different identity concurrency/failure continuation/eviction test；证据：本文件、07 session-operation-result workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-operation-coordinator.ts`；调用/依赖边界：session run/hydration/workflow 调用；result workflow下游。；验证 oracle：same identity ordering/different identity concurrency/failure continuation/eviction test；证据：本文件、07 session-operation-result workflow。

### runtime-host/application/sessions/session-prompt-service.ts

- **当前 owner：** request boundary validator + run workflow caller；`promptSession`。
- **职责与关键 symbols：** request boundary validator + run workflow caller；`promptSession`。
- **旧语义与策略：** 解析完整 identity、message/media/runId；缺 session、identity不匹配、无 message/media 返回 badRequest；缺 run id/key 才生成。
- **状态、存储与副作用：** 自身无；run workflow local commit/flush 后后台 Runtime send。
- **并发与性能特征：** workflow prompt/补偿经 coordinator；但 ingress 回流不必经其，非全域 fence。
- **调用/依赖边界：** SessionRuntimeService/route → SessionRunWorkflow；ID generator下游。
- **故障、恢复与安全：** 输入失败无 mutation；send失败仅在 activeRunId匹配时补 lifecycle error，补偿失败仅 warning；API 成功不是 Runtime send 成功。
- **迁移分类：** Preserve：先本地接受/持久化再后台发送，旧 run不能覆盖新 run。Intentional Improvement：可查询后台失败。Defect：无确定；started event subscription set是否泄漏待验证。
- **未来 Rust owner：** Delivery validation + Domain Session actor command；Runtime Integration async dispatch；receipt/correlation可归 Platform Core。
- **Rust 重写与性能判断：** 关注本地 commit到dispatch启动、后台失败可见性；Runtime/LLM耗时独立量化。
- **验证 oracle：** local accepted/send fail/new run race traces；证据：本文件、07 `session-run-workflow.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-prompt-service.ts`；调用/依赖边界：SessionRuntimeService/route → SessionRunWorkflow；ID generator下游。；验证 oracle：local accepted/send fail/new run race traces；证据：本文件、07 `session-run-workflow.ts`。

### runtime-host/application/sessions/session-render-model.ts

- **当前 owner：** timeline/graph/runtime → final render list assembler；`cloneRenderItems`、type guard、`buildRenderItemsFromTimeline`。
- **职责与关键 symbols：** timeline/graph/runtime → final render list assembler；`cloneRenderItems`、type guard、`buildRenderItemsFromTimeline`。
- **旧语义与策略：** 保留 timeline顺序、anchor后插 graph、dedupe普通 render key，补 pending assistant，tail graph末尾；纯投影。
- **状态、存储与副作用：** structuredClone，不写 canonical。
- **并发与性能特征：** graph 在收集/flush重复 clone；timeline线性，非 I-O。
- **调用/依赖边界：** canonical projection/runtime调用，assistant assembler下游。
- **故障、恢复与安全：** 当前文件引用 `SessionRuntimeStateSnapshot` 和 `normalizeString` 但未导入，且导入未用 `hasAssistantTurnOutput`：正常 TypeScript typecheck应报未解析符号。tail graph未入 rendered key dedupe。
- **迁移分类：** Preserve：render非事实、timeline/anchor顺序。Intentional Improvement：避免重复 graph clone。Defect：缺 import的构建缺陷（源码直接可证）。待验证：tail duplicate key规则。
- **未来 Rust owner：** Domain Module render projector；Delivery只能读结果。
- **Rust 重写与性能判断：** 测 graph clone/allocation，保持排序/anchor；oracle为 render golden + typecheck。
- **验证 oracle：** canonical timeline render tests；证据：本文件、`assistant-turn-assembler.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-render-model.ts`；调用/依赖边界：canonical projection/runtime调用，assistant assembler下游。；验证 oracle：canonical timeline render tests；证据：本文件、`assistant-turn-assembler.ts`。

### runtime-host/application/sessions/session-runtime-requests.ts

- **当前 owner：** command/prompt pure request readers；create/identity/list/load/abort/approval/patch/rename/status/window/prompt readers。
- **职责与关键 symbols：** command/prompt pure request readers；create/identity/list/load/abort/approval/patch/rename/status/window/prompt readers。
- **旧语义与策略：** unknown 非 record视为空；trim strings；验证 endpoint/identity；显式 sessionKey必须与 identity sessionKey一致；媒体/window归一化。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 同步/无共享状态，不提供串行。
- **调用/依赖边界：** command/prompt services与 workflows。
- **故障、恢复与安全：** validation result表达错误而非抛/写；调用者映射 application errors。
- **迁移分类：** Preserve：payload key/identity交叉校验。Intentional Improvement：无。Defect：无。待验证：media normalizer异常契约。
- **未来 Rust owner：** Delivery/application input parser，Domain actor只接收 validated command。
- **Rust 重写与性能判断：** serde/custom validation纯本地；contract vector oracle。
- **验证 oracle：** malformed endpoint/identity/sessionKey/media fixture；证据：本文件、shared runtime address。
- **证据：** 源码 `runtime-host/application/sessions/session-runtime-requests.ts`；调用/依赖边界：command/prompt services与 workflows。；验证 oracle：malformed endpoint/identity/sessionKey/media fixture；证据：本文件、shared runtime address。

### runtime-host/application/sessions/session-runtime-state.ts

- **当前 owner：** 进程内 Session runtime state/derived-index/selector owner；state map、approval/graph/transport/model indices、active selector、persistence loop。
- **职责与关键 symbols：** 进程内 Session runtime state/derived-index/selector owner；state map、approval/graph/transport/model indices、active selector、persistence loop。
- **旧语义与策略：** 主 Map用完整 identity key；无 context按裸 sessionKey查询遇多匹配则抛。只持久化 `{version:3, activeSessionKey}`，不持久 canonical/timeline/index/model。
- **状态、存储与副作用：** create/delete timeline state；delete移除索引；读写 `SessionRuntimeStorePort` selector。
- **并发与性能特征：** Map同步无 mutex；global `pendingPersist`合并所有 identity selector save；ingress与coordinator无统一 fence。
- **调用/依赖边界：** timeline/snapshot/workflow读写；repository port下接 persistence workflow。
- **故障、恢复与安全：** load/JSON错误可下游降级；save failure warn且本实例未自动重试；flush在save前清dirty。`listSessionStates`输出 sessionKey而非完整 identity key；active selector只存字符串，两个 identity同 sessionKey时删其一可清另一个active，均为可证缺口。
- **迁移分类：** Preserve：identity-key state、无 context歧义拒绝、delete清index、late load不覆盖本地选择。Intentional Improvement：持久完整 identity+version、bounded/transactional selector persistence。Defect：activeSessionKey collision删除；save失败无本实例重试；list key丢identity区分。待验证：hydrate/I-O与ingress交错。
- **未来 Rust owner：** Domain Module state registry/actor lifecycle；Foundation Kernel提供 durable write/retry primitive；不要把内存 state误称 event store。
- **Rust 重写与性能判断：** 测 selector write合并、failed save recovery、identity collision、memory indices；外部 runtime延迟不计。
- **验证 oracle：** state-store tests、two identities/same sessionKey、write-failure/restart fault tests；证据：本文件、`tests/unit/session-runtime-state-store.test.ts`。
- **证据：** 源码 `runtime-host/application/sessions/session-runtime-state.ts`；调用/依赖边界：timeline/snapshot/workflow读写；repository port下接 persistence workflow。；验证 oracle：state-store tests、two identities/same sessionKey、write-failure/restart fault tests；证据：本文件、`tests/unit/session-runtime-state-store.test.ts`。

### runtime-host/application/sessions/session-runtime-store-repository.ts

- **当前 owner：** selector persistence repository wrapper；`load/save`。
- **职责与关键 symbols：** selector persistence repository wrapper；`load/save`。
- **旧语义与策略：** 原样委托 persistence workflow，无 cache/转换。
- **状态、存储与副作用：** 下游写 config-dir JSON；本身无。
- **并发与性能特征：** 无文件锁/identity lock，上层 pendingPersist处理。
- **调用/依赖边界：** state store → persistence workflow。
- **故障、恢复与安全：** repository不 catch；workflow load可默认，save错误向上。atomic replace/fsync/跨进程锁未证实。
- **迁移分类：** Preserve：port与实现分离。Intentional Improvement：把 crash consistency写入 storage contract。Defect：无。待验证：file durability/locking。
- **未来 Rust owner：** Foundation Kernel storage mechanism，Session Domain拥有 selector语义。
- **Rust 重写与性能判断：** 测 fsync/rename/recovery，而非 wrapper速度。
- **验证 oracle：** corrupted JSON/permission failure/restart tests；证据：本文件、07 persistence workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-runtime-store-repository.ts`；调用/依赖边界：state store → persistence workflow。；验证 oracle：corrupted JSON/permission failure/restart tests；证据：本文件、07 persistence workflow。

### runtime-host/application/sessions/session-runtime-types.ts

- **当前 owner：** Session inbound payload、timeline state、committed transition TypeScript contracts。
- **职责与关键 symbols：** Session inbound payload、timeline state、committed transition TypeScript contracts。
- **旧语义与策略：** inbound多数 optional unknown，必须经 request reader；runtime timeline state同时含 canonical、projection/index/window/hydration/transport epoch，非持久 schema。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 类型不能保证 actor/serialisation。
- **调用/依赖边界：** services/workflows/timeline runtime。
- **故障、恢复与安全：** 类型不替代 validation；公开 arrays/Map使旁路 mutation可能。
- **迁移分类：** Preserve：unknown boundary。Intentional Improvement：Rust用validated command与私有aggregate mutation。Defect：无。待验证：所有 mutation是否经 timeline runtime。
- **未来 Rust owner：** Domain Module command/state DTO；Runtime Integration转换未知协议。
- **Rust 重写与性能判断：** 无；compile-time/schema plus behavior vectors。
- **验证 oracle：** request reader and timeline mutation tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/session-runtime-types.ts`；调用/依赖边界：services/workflows/timeline runtime。；验证 oracle：request reader and timeline mutation tests；证据：本文件。

### runtime-host/application/sessions/session-snapshot-service.ts

- **当前 owner：** snapshot workflow façade；empty/sync/async/latest/window/primary item。
- **职责与关键 symbols：** snapshot workflow façade；empty/sync/async/latest/window/primary item。
- **旧语义与策略：** sync从当前 state；async另读 storage descriptor/metadata/model，返回clone projection而不写事实。
- **状态、存储与副作用：** 本身无；workflow间接读 storage/metadata。
- **并发与性能特征：** async snapshot无 per-identity fence；I-O完成后读可变state，非一致性事务。
- **调用/依赖边界：** SessionRuntimeService/command workflows → snapshot workflow。
- **故障、恢复与安全：** 无 catch，metadata/storage错误rejection；无 secret owner。
- **迁移分类：** Preserve：snapshot是读投影。Intentional Improvement：若要求同点一致需version/actor query或retry。Defect：无。待验证：并发ingress期间混合时间点是否允许。
- **未来 Rust owner：** Domain Module query/projection；Runtime Integration storage metadata port。
- **Rust 重写与性能判断：** 测 snapshot staleness/version和storage I-O，不以Rust泛化快。
- **验证 oracle：** snapshot workflow fixture/concurrent update trace；证据：本文件、07 snapshot workflow。
- **证据：** 源码 `runtime-host/application/sessions/session-snapshot-service.ts`；调用/依赖边界：SessionRuntimeService/command workflows → snapshot workflow。；验证 oracle：snapshot workflow fixture/concurrent update trace；证据：本文件、07 snapshot workflow。

### runtime-host/application/sessions/session-state-model.ts

- **当前 owner：** empty state factory、clone、patched resolved model reader。
- **职责与关键 symbols：** empty state factory、clone、patched resolved model reader。
- **旧语义与策略：** 新 timeline含空 canonical/projection/index、unhydrated、window、epoch；patch后覆盖 default；resolved model有验证失败则回退 requested。
- **状态、存储与副作用：** 创建对象/Map，clone shallow；无I-O。
- **并发与性能特征：** 常数级、无队列；共享嵌套值依调用方纪律。
- **调用/依赖边界：** state store/timeline runtime。
- **故障、恢复与安全：** malformed patch降级；shallow clone不保证隔离。
- **迁移分类：** Preserve：empty canonical factory/默认window。Intentional Improvement：immutable aggregate或明确clone深度。Defect：无。待验证：patch cross-field identity。
- **未来 Rust owner：** Domain Module aggregate factory。
- **Rust 重写与性能判断：** 无显著性能理由；empty/default/model fallback oracle。
- **验证 oracle：** timeline state fixture；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/session-state-model.ts`；调用/依赖边界：state store/timeline runtime。；验证 oracle：timeline state fixture；证据：本文件。

### runtime-host/application/sessions/session-storage-repository.ts

- **当前 owner：** session storage port/repository wrapper，descriptor/transcript/identity/status/rename/delete接口。
- **职责与关键 symbols：** session storage port/repository wrapper，descriptor/transcript/identity/status/rename/delete接口。
- **旧语义与策略：** 原样委托 storage repository workflow；`readSessionStoreLabel` trim空值→null。
- **状态、存储与副作用：** 实际文件/descriptor/transcript I-O在workflow；该类仅delegate。
- **并发与性能特征：** async line streaming；无锁/identity queue，文件操作的原子性在下游未由此证明。
- **调用/依赖边界：** catalog/hydration/timeline/metadata workflows；workflow接外部 artifact resolver/config dir。
- **故障、恢复与安全：** 错误原样；路径/identity安全由workflow/adapter，非本类。
- **迁移分类：** Preserve：port shape/streaming transcript。Intentional Improvement：storage错误/atomicity显式合同。Defect：无。待验证：path traversal、external artefact resolver与跨进程修改。
- **未来 Rust owner：** Domain Module port；Runtime Integration/Infrastructure实现文件布局和外部 artefact。
- **Rust 重写与性能判断：** 用stream而非无谓全读；测 bytes、scan、descriptor I-O和错误恢复。
- **验证 oracle：** catalog/storage workflow tests；证据：本文件、07 session-storage workflows。
- **证据：** 源码 `runtime-host/application/sessions/session-storage-repository.ts`；调用/依赖边界：catalog/hydration/timeline/metadata workflows；workflow接外部 artifact resolver/config dir。；验证 oracle：catalog/storage workflow tests；证据：本文件、07 session-storage workflows。

### runtime-host/application/sessions/session-timeline-runtime.ts

- **当前 owner：** Session Domain runtime orchestration；hydrate/activate/reduce/project/index/persist。
- **职责与关键 symbols：** Session Domain runtime orchestration；hydrate/activate/reduce/project/index/persist。
- **旧语义与策略：** 首次 hydrate replay transcript；`appendCanonicalEvents` 原地reduce后投影、同步 approval/transport/graph index、persist selector。`persistStore`不持久canonical events。
- **状态、存储与副作用：** 写 timeline state与derived indices，读 transcript descriptor，触发 selector persist。
- **并发与性能特征：** hydrate await transcript期间可与 ingress append交错；hydration workflow经 coordinator，但 gateway ingress直接append。因此无统一同identity串行；初次 replay/全投影成本随 transcript/state。
- **调用/依赖边界：** ingress/run/hydration workflows，state store, loader, execution graph runtime。
- **故障、恢复与安全：** replay/projection错误无事务回滚。若live event先写使 render/messages非空，ensure hydrate可跳过历史 replay却标hydrated，是否漏史待交错fixture。`activateSession`的 `hydrate?` 参数未读取。
- **迁移分类：** Preserve：canonical是输入、cache非event log。Intentional Improvement：同identity actor把 replay/ingress/commit串行并用版本化投影。Defect：`hydrate?` dead parameter。待验证：live-before-hydrate漏历史与partial rollback。
- **未来 Rust owner：** Domain Module Session actor + projection cache；Foundation Kernel只提供 task/cancel/storage primitives。
- **Rust 重写与性能判断：** 测 replay bytes/首屏/全量projection、mailbox wait与fault rollback；LLM/Runtime transcript network另列。
- **验证 oracle：** canonical timeline tests，加 live-ingress/hydrate race、loader throw、replay boundary tests；证据：本文件、07 ingress/hydration workflows。
- **证据：** 源码 `runtime-host/application/sessions/session-timeline-runtime.ts`；调用/依赖边界：ingress/run/hydration workflows，state store, loader, execution graph runtime。；验证 oracle：canonical timeline tests，加 live-ingress/hydrate race、loader throw、replay boundary tests；证据：本文件、07 ingress/hydration workflows。

### runtime-host/application/sessions/session-transcript-timeline-loader.ts

- **当前 owner：** Runtime transcript source selector；`readCanonicalReplayEvents`。
- **职责与关键 symbols：** Runtime transcript source selector；`readCanonicalReplayEvents`。
- **旧语义与策略：** 若 endpoint声明 external transcript且transport支持，则优先其结果（包括其返回的空 transcript）；否则以 endpointSessionId 查本地 descriptor，再以完整 identity读本地，交给 protocol replay adapter。
- **状态、存储与副作用：** 异步读 Runtime transport或storage stream；不写 canonical。
- **并发与性能特征：** 无cache/lock；单hydrate的 I-O/stream延迟在此路径，不能归为 reducer性能。
- **调用/依赖边界：** timeline runtime→registry protocol/transport/storage；replay adapter下游。
- **故障、恢复与安全：** transport/storage errors向上；外部返回null与unavailable区别只由代码分支，不能推断可靠回放。
- **迁移分类：** Preserve：external优先、endpointSessionId fallback。Intentional Improvement：明确 null/empty/error和可观测 source。Defect：无。待验证：external transcript的完整性/ordering。
- **未来 Rust owner：** Runtime Integration transcript port；Domain Module接 canonical event stream。
- **Rust 重写与性能判断：** 基准真实读延迟/bytes与fallback比例；不以本地实现替代Runtime协议承诺。
- **验证 oracle：** external/local/endpoint-id fallback/error trace；证据：本文件、agent registry contract。
- **证据：** 源码 `runtime-host/application/sessions/session-transcript-timeline-loader.ts`；调用/依赖边界：timeline runtime→registry protocol/transport/storage；replay adapter下游。；验证 oracle：external/local/endpoint-id fallback/error trace；证据：本文件、agent registry contract。

### runtime-host/application/sessions/session-value-normalization.ts

- **当前 owner：** shared Session pure normalizers；record/string/finite number。
- **职责与关键 symbols：** shared Session pure normalizers；record/string/finite number。
- **旧语义与策略：** array非record，string trim，finite number可由string Number解析。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(1)。
- **调用/依赖边界：** request/task/transcript helpers。
- **故障、恢复与安全：** invalid→empty/undefined，无throw；不做semantic范围验证。
- **迁移分类：** Preserve：JS Number兼容。Intentional Improvement：Rust显式数值/字符串解析边界。Defect：无。待验证：空字符串/hex/负数是否应与JS完全兼容。
- **未来 Rust owner：** Domain Module validation utility；无 actor/storage/I-O。
- **Rust 重写与性能判断：** 无；numeric corpus oracle。
- **验证 oracle：** caller contract tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/session-value-normalization.ts`；调用/依赖边界：request/task/transcript helpers。；验证 oracle：caller contract tests；证据：本文件。

### runtime-host/application/sessions/session-window-model.ts

- **当前 owner：** pure render window model；normalization/range/clamp/clone。
- **职责与关键 symbols：** pure render window model；normalization/range/clamp/clone。
- **旧语义与策略：** default latest/80，limit clamp 0..200，offset≥0；older 范围以 anchor两侧可到约2×limit，latest尾部取 limit。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(1)。
- **调用/依赖边界：** hydration/window commands/execution graph runtime。
- **故障、恢复与安全：** nonfinite默认/空；total假定调用方有效。
- **迁移分类：** Preserve：clamps/range。Intentional Improvement：先定义“older”是否应为单侧。Defect：无。待验证：total输入约束。
- **未来 Rust owner：** Domain Module read projection utility。
- **Rust 重写与性能判断：** 无；range vector oracle。
- **验证 oracle：** window boundary table；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/session-window-model.ts`；调用/依赖边界：hydration/window commands/execution graph runtime。；验证 oracle：window boundary table；证据：本文件。

### runtime-host/application/sessions/state-only-tools.ts

- **当前 owner：** state-only task tool/compat parsing；tool name/call ID/payload/result/type predicates。
- **职责与关键 symbols：** state-only task tool/compat parsing；tool name/call ID/payload/result/type predicates。
- **旧语义与策略：** 兼容多个字段名和嵌套 function，payload优先 input/arguments/args，result优先 result/output/partialResult/content/text；只识别，不执行。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 同步；嵌套解析随深度，未设cycle/depth guard。
- **调用/依赖边界：** canonical replay/task normalizer，shared task-tool contract。
- **故障、恢复与安全：** nonrecord降级；非JSON循环对象可能深递归，是否可输入待验证。
- **迁移分类：** Preserve：共享命名规则、字段优先级。Intentional Improvement：限制不可信深度/循环。Defect：无。待验证：arguments JSON string是否需decode。
- **未来 Rust owner：** Domain Module task snapshot normalizer；Runtime Integration先做协议形状映射。
- **Rust 重写与性能判断：** 无网络命题；field alias/depth corpus oracle。
- **验证 oracle：** state-only tool payload variants；证据：本文件、`task-snapshot-normalizer.ts`。
- **证据：** 源码 `runtime-host/application/sessions/state-only-tools.ts`；调用/依赖边界：canonical replay/task normalizer，shared task-tool contract。；验证 oracle：state-only tool payload variants；证据：本文件、`task-snapshot-normalizer.ts`。

### runtime-host/application/sessions/task-completion-events.ts

- **当前 owner：** task completion notification normalizer/deduper。
- **职责与关键 symbols：** task completion notification normalizer/deduper。
- **旧语义与策略：** 仅 kind task_completion，childSessionKey必需；source仅subagent/cron否则unknown；可从 key推 agent；identity要通过validate；按6字段合成key保序去重。
- **状态、存储与副作用：** 纯数组/Set，不持久。
- **并发与性能特征：** O(n) Set；无 Session queue。
- **调用/依赖边界：** transcript parser写入 transcript message，canonical replay/adapter消费。
- **故障、恢复与安全：** 异形输入丢弃；dedupe key未含 result/stats/replyInstruction/source/identity，差异事件可被吞，是否缺陷取决于重复定义。
- **迁移分类：** Preserve：kind/key/保序。Intentional Improvement：将 dedupe identity和payload version写明。Defect：无确认。待验证：同任务更新结果是否应保留。
- **未来 Rust owner：** Domain Module child completion projection/event normalizer。
- **Rust 重写与性能判断：** O(n)保持；以重复更新/字段变化 vectors检验。
- **验证 oracle：** transcript parsing/replay fixtures；证据：本文件、`transcript-parser.ts`。
- **证据：** 源码 `runtime-host/application/sessions/task-completion-events.ts`；调用/依赖边界：transcript parser写入 transcript message，canonical replay/adapter消费。；验证 oracle：transcript parsing/replay fixtures；证据：本文件、`transcript-parser.ts`。

### runtime-host/application/sessions/task-snapshot-normalizer.ts

- **当前 owner：** task/todo/artifact payload → `TaskSnapshotEvent` normalizer。
- **职责与关键 symbols：** task/todo/artifact payload → `TaskSnapshotEvent` normalizer。
- **旧语义与策略：** task subject必需，缺id用index+1，status未知→pending；sessionKey来自字段/agent URI/fallback；无task/todo且非todo source→null；state-only tool强制source todo，artifact type tasks强制artifact。
- **状态、存储与副作用：** pure DTO创建，metadata引用未深clone。
- **并发与性能特征：** arrays线性；无queue/I-O。
- **调用/依赖边界：** state-only tools、transcript replay、canonical reducer。
- **故障、恢复与安全：** unknown payload静默null；metadata原样进入投影，未redact/validate；task id fallback在重排时不稳定。
- **迁移分类：** Preserve：source/sessionKey/field precedence。Intentional Improvement：明确metadata JSON/sensitivity和stable task identity。Defect：无确认。待验证：duplicate ids/reorder语义。
- **未来 Rust owner：** Domain Module task projection normalizer。
- **Rust 重写与性能判断：** 保持O(n)，测payload/metadata大小；不与Runtime任务执行时间混淆。
- **验证 oracle：** task/todo/artifact/state-only payload vectors；证据：本文件、`transcript-task-snapshot-replay.ts`。
- **证据：** 源码 `runtime-host/application/sessions/task-snapshot-normalizer.ts`；调用/依赖边界：state-only tools、transcript replay、canonical reducer。；验证 oracle：task/todo/artifact/state-only payload vectors；证据：本文件、`transcript-task-snapshot-replay.ts`。

### runtime-host/application/sessions/timeline-state.ts

- **当前 owner：** timeline last-activity pure selector。
- **职责与关键 symbols：** timeline last-activity pure selector。
- **旧语义与策略：** 从末尾找finite `createdAt`，无则用runtime.updatedAt。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** worst O(n) reverse scan。
- **调用/依赖边界：** catalog model/workflow。
- **故障、恢复与安全：** invalid timestamps略过；不排序/不修复时钟。
- **迁移分类：** Preserve：timeline优先fallback。Intentional Improvement：若大timeline频繁catalog，维护派生last activity。Defect：无。待验证：out-of-order timestamps应否取末项而非最大值。
- **未来 Rust owner：** Domain Module catalog projection helper。
- **Rust 重写与性能判断：** 测扫描次数；保持末尾优先语义。
- **验证 oracle：** timestamp order vectors；证据：本文件、`session-catalog-model.ts`。
- **证据：** 源码 `runtime-host/application/sessions/timeline-state.ts`；调用/依赖边界：catalog model/workflow。；验证 oracle：timestamp order vectors；证据：本文件、`session-catalog-model.ts`。

### runtime-host/application/sessions/todo-tool-debug.ts

- **当前 owner：** Todo tool debug recognizer/summarizer/logger。
- **职责与关键 symbols：** Todo tool debug recognizer/summarizer/logger。
- **旧语义与策略：** JSON stringify正则识别 Todo 信号，命中才 traceDebug摘要。
- **状态、存储与副作用：** 无session写入；可选日志输出。
- **并发与性能特征：** stringify整个payload/遍历snapshot，O(payload)；仅本地debug成本。
- **调用/依赖边界：** ingress/debug logging。
- **故障、恢复与安全：** stringify循环/BigInt降级String；含 text/tool input/todos，未脱敏，logger保留策略不在本文件。
- **迁移分类：** Preserve：命中才记录。Intentional Improvement：采样/截断/redaction应由日志策略明确。Defect：无确认。待验证：logger落盘/上传/访问控制。
- **未来 Rust owner：** Delivery/observability adapter，Domain Module不拥有日志；Foundation Kernel可提供 redaction primitive。
- **Rust 重写与性能判断：** 测debug payload序列化，不能代表Runtime性能。
- **验证 oracle：** todo/non-todo/cyclic payload logging tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/todo-tool-debug.ts`；调用/依赖边界：ingress/debug logging。；验证 oracle：todo/non-todo/cyclic payload logging tests；证据：本文件。

### runtime-host/application/sessions/tool-event-sanitizer.ts

- **当前 owner：** malformed empty tool result 的纯谓词；`isMalformedEmptyToolNameResult`。
- **职责与关键 symbols：** malformed empty tool result 的纯谓词；`isMalformedEmptyToolNameResult`。
- **旧语义与策略：** 工具名空/unknown、call id `call_auto_`、文本匹配 tool not found 三条件才true；不实际sanitize/redact或删事件。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 常数/数组文本扫描；无I-O。
- **调用/依赖边界：** 当前 production tracked source未见调用者，属于未接入策略。
- **故障、恢复与安全：** 类型guard避免异常；名称不等于安全净化。
- **迁移分类：** Preserve：联合判定。Intentional Improvement：若接入须明确隐藏展示还是拒绝事实。Defect：无。待验证：是否应在Runtime ingress处理。
- **未来 Rust owner：** Runtime Integration protocol anomaly recognizer；Session只收规范事件。
- **Rust 重写与性能判断：** pure fn，无性能论断；三条件反例table oracle。
- **验证 oracle：** 正反例及接入决策；证据：本文件、全树调用搜索。
- **证据：** 源码 `runtime-host/application/sessions/tool-event-sanitizer.ts`；调用/依赖边界：当前 production tracked source未见调用者，属于未接入策略。；验证 oracle：正反例及接入决策；证据：本文件、全树调用搜索。

### runtime-host/application/sessions/tool-result-media.ts

- **当前 owner：** tool result attachment render projection；`extractToolResultMediaAttachments`。
- **职责与关键 symbols：** tool result attachment render projection；`extractToolResultMediaAttachments`。
- **旧语义与策略：** 合并 `output.media.mediaUrls`、paths、文本 `MEDIA:`，精确去重保首见；http(s)/`/api/`为gatewayUrl，否则filePath；只推MIME/filename，不下载/验证。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(n) Vec+Set，global regex正常扫描完复位；本地处理。
- **调用/依赖边界：** canonical projection/replay使用。
- **故障、恢复与安全：** URL parse失败回basename；路径/URL投影给UI，未做授权/path constraint/redaction。
- **迁移分类：** Preserve：三来源/精确dedupe/MIME fallback。Intentional Improvement：URL/path授权需显式安全兼容方案。Defect：无。待验证：非HTTP/relative/equivalent URL契约。
- **未来 Rust owner：** Domain Module attachment projection，Runtime私有 `MEDIA:` 在Integration翻译。
- **Rust 重写与性能判断：** `Vec + HashSet`；测引用数/alloc，不涉网络加载。
- **验证 oracle：** structured media/path/MEDIA line/unknown MIME fixture；证据：本文件、gateway-media tests。
- **证据：** 源码 `runtime-host/application/sessions/tool-result-media.ts`；调用/依赖边界：canonical projection/replay使用。；验证 oracle：structured media/path/MEDIA line/unknown MIME fixture；证据：本文件、gateway-media tests。

### runtime-host/application/sessions/transcript-content-extractors.ts

- **当前 owner：** transcript content display/thinking/image extractors。
- **职责与关键 symbols：** transcript content display/thinking/image extractors。
- **旧语义与策略：** user用canonical user sanitizer，assistant用assistant display sanitizer，其他 extract text trim；thinking/image只遍历array blocks。
- **状态、存储与副作用：** pure projection，无I-O。
- **并发与性能特征：** content线性；bad null block可因断言访问type抛，和media helper类似。
- **调用/依赖边界：** replay/catalog/display projection。
- **故障、恢复与安全：** text sanitizer有共享策略；image URL/base64未授权/redact；array内null可失败，待建立明确测试。
- **迁移分类：** Preserve：user/assistant不同sanitize与block形状。Intentional Improvement：block guard。Defect：坏数组元素可能抛（代码路径）。待验证：content JSON安全保证。
- **未来 Rust owner：** Domain Module transcript projection；shared redaction Foundation Kernel/Platform共享机制。
- **Rust 重写与性能判断：** 测文本/media扫描与坏输入，不涉及transcript网络读取。
- **验证 oracle：** sanitizer/media/null block vectors；证据：本文件、shared chat normalization。
- **证据：** 源码 `runtime-host/application/sessions/transcript-content-extractors.ts`；调用/依赖边界：replay/catalog/display projection。；验证 oracle：sanitizer/media/null block vectors；证据：本文件、shared chat normalization。

### runtime-host/application/sessions/transcript-labels.ts

- **当前 owner：** session title label projection。
- **职责与关键 symbols：** session title label projection。
- **旧语义与策略：** user优先assistant；清媒体标记/空白，最多50+ellipsis；过滤internal message与模板assistant文本；timeline从末向前先user后assistant，transcript遍历保留最后候选。
- **状态、存储与副作用：** 无；label不是事实。
- **并发与性能特征：** linear/reverse scan，无I-O。
- **调用/依赖边界：** catalog model/workflow。
- **故障、恢复与安全：** user sanitizer/assistant normalizer；截断非secret redaction，潜在敏感文本仍label。
- **迁移分类：** Preserve：title precedence/templates/length。Intentional Improvement：locale/grapheme-aware truncation需兼容评估。Defect：无。待验证：模板集合和敏感label规则。
- **未来 Rust owner：** Domain Module catalog projection。
- **Rust 重写与性能判断：** local scan，测Unicode truncation/title precedence，非LLM延迟。
- **验证 oracle：** catalog/session label fixture；证据：本文件、`session-catalog-model.ts`。
- **证据：** 源码 `runtime-host/application/sessions/transcript-labels.ts`；调用/依赖边界：catalog model/workflow。；验证 oracle：catalog/session label fixture；证据：本文件、`session-catalog-model.ts`。

### runtime-host/application/sessions/transcript-media-extractors.ts

- **当前 owner：** transcript attached file/media ref/image-file projection。
- **职责与关键 symbols：** transcript attached file/media ref/image-file projection。
- **旧语义与策略：** normalize `_attachedFiles`；regex读`[media attached:]`；image转attachment并递归tool result；merge按多字段线性dedupe，比较未含gatewayUrl。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** merge为O(existing×incoming)，递归无depth/cycle guard；本地成本。
- **调用/依赖边界：** replay/projection/catalog media。
- **故障、恢复与安全：** content block断言，null可抛；base64/url/path未redact，merge缺gatewayUrl可合并不同gateway URL，语义待确认。
- **迁移分类：** Preserve：attached fields/merge首见。Intentional Improvement：HashSet key、block/depth guard。Defect：bad block failure；gatewayUrl遗漏是否缺陷待验证。待验证：attachment dedupe identity。
- **未来 Rust owner：** Domain Module render projection；Runtime Integration负责可访问性授权。
- **Rust 重写与性能判断：** 可用HashSet消除局部二次扫描，需保持first-win；测附件数/alloc而非下载延迟。
- **验证 oracle：** attachments/url/base64/duplicate/gatewayUrl/null fixture；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/transcript-media-extractors.ts`；调用/依赖边界：replay/projection/catalog media。；验证 oracle：attachments/url/base64/duplicate/gatewayUrl/null fixture；证据：本文件。

### runtime-host/application/sessions/transcript-parser.ts

- **当前 owner：** JSONL transcript parser/iterators。
- **职责与关键 symbols：** JSONL transcript parser/iterators。
- **旧语义与策略：** 每行JSON失败/缺message/role则跳过；normalize raw chat fields，task completions；sync、async lines、async chunks均按换行yield。
- **状态、存储与副作用：** 不写文件；streaming消费source。
- **并发与性能特征：** 行/字节线性；chunk parser无限制拼pending，长无换行chunk可占无界内存。
- **调用/依赖边界：** storage catalog/replay/transcript loader。
- **故障、恢复与安全：** malformed行静默丢弃（不是recovery保证）；source迭代异常传播；raw content/details可能保留敏感数据。
- **迁移分类：** Preserve：容错跳行、CRLF/chunk语义、normalization。Intentional Improvement：pending line容量/error metrics。Defect：无明确产品缺陷。待验证：是否应报告损坏行及巨大单行限额。
- **未来 Rust owner：** Runtime Integration transcript format parser，Domain只消费normalized message/event。
- **Rust 重写与性能判断：** streamed buffered parser；测bytes、malformed率、max pending、first message latency；外部file/network读取分开。
- **验证 oracle：** JSONL/CRLF/chunk split/malformed/huge line test；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/transcript-parser.ts`；调用/依赖边界：storage catalog/replay/transcript loader。；验证 oracle：JSONL/CRLF/chunk split/malformed/huge line test；证据：本文件。

### runtime-host/application/sessions/transcript-task-snapshot-replay.ts

- **当前 owner：** transcript state-only tool call/result → latest task snapshot extractor。
- **职责与关键 symbols：** transcript state-only tool call/result → latest task snapshot extractor。
- **旧语义与策略：** JSON-like string尝试parse失败保原；content/toolCalls按顺序覆盖latest；toolcall/result payload加 source todo；只state-only tool。
- **状态、存储与副作用：** pure scan，无I-O。
- **并发与性能特征：** messages/content/tool calls线性；无queue。
- **调用/依赖边界：** transcript replay/hydration与task snapshot normalizer。
- **故障、恢复与安全：** invalid value降低；不验证JSON payload secret/metadata；latest仅输入顺序，不保证外部时间排序。
- **迁移分类：** Preserve：payload precedence/source forcing/last-wins。Intentional Improvement：明确event ordering/version。Defect：无。待验证：同message多snapshot、timestamp反序。
- **未来 Rust owner：** Domain Module task snapshot projection，Runtime Integration先译工具协议。
- **Rust 重写与性能判断：** streaming fold，不必缓存全部只为snapshot；测first/latest snapshot与payload parse开销。
- **验证 oracle：** call/result/string/invalid/multi-message order vectors；证据：本文件、`task-snapshot-normalizer.ts`。
- **证据：** 源码 `runtime-host/application/sessions/transcript-task-snapshot-replay.ts`；调用/依赖边界：transcript replay/hydration与task snapshot normalizer。；验证 oracle：call/result/string/invalid/multi-message order vectors；证据：本文件、`task-snapshot-normalizer.ts`。

### runtime-host/application/sessions/transcript-types.ts

- **当前 owner：** transcript normalized DTO与record/bool/timestamp guards。
- **职责与关键 symbols：** transcript normalized DTO与record/bool/timestamp guards。
- **旧语义与策略：** 时间接受finite number、numeric string或Date.parse string；content/metadata等unknown保留直到消费者。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(1)，无队列。
- **调用/依赖边界：** parser/content/media/labels/replay。
- **故障、恢复与安全：** `Date.parse` 的实现/时区兼容是JS行为；invalid→undefined；不redact raw fields。
- **迁移分类：** Preserve：accepted timestamp forms/unknown boundary。Intentional Improvement：Rust时间解析须写出ISO/number合同，不能无意接受/拒绝更多。Defect：无。待验证：非ISO date strings生产样本。
- **未来 Rust owner：** Runtime Integration normalized transcript DTO；Domain Module接明确timestamp。
- **Rust 重写与性能判断：** 无；timestamp compatibility corpus oracle。
- **验证 oracle：** parser timestamp fixture；证据：本文件、`transcript-parser.ts`。
- **证据：** 源码 `runtime-host/application/sessions/transcript-types.ts`；调用/依赖边界：parser/content/media/labels/replay。；验证 oracle：parser timestamp fixture；证据：本文件、`transcript-parser.ts`。

### runtime-host/application/sessions/tool/tool-card-content.ts

- **当前 owner：** tool content shape compatibility helper；`normalizeContentBlocks`、`coerceToolArgs`、result output/text extraction。
- **职责与关键 symbols：** tool content shape compatibility helper；`normalizeContentBlocks`、`coerceToolArgs`、result output/text extraction。
- **旧语义与策略：** 仅留array objects；JSON string仅`{`/`[`尝试parse，失败原样；output优先result/partialResult/content/text；text递归content数组。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** local JSON/array scan，递归无cycle guard。
- **调用/依赖边界：** live OpenClaw adapter、canonical replay/projection；若干导出当前无调用者。
- **故障、恢复与安全：** JSON错误安全fallback；不redact args/output/text。
- **迁移分类：** Preserve：field priority/invalid JSON原样。Intentional Improvement：cycle/budget由不可信输入模型决定。Defect：无。待验证：unused exports/arguments decode。
- **未来 Rust owner：** Domain Module canonical/render DTO normalizer，Runtime adapter做私有字段映射。
- **Rust 重写与性能判断：** serde JSON local parse；以priority/invalid/array fixtures验证。
- **验证 oracle：** adapter/replay projection tests；证据：本文件、canonical replay。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-card-content.ts`；调用/依赖边界：live OpenClaw adapter、canonical replay/projection；若干导出当前无调用者。；验证 oracle：adapter/replay projection tests；证据：本文件、canonical replay。

### runtime-host/application/sessions/tool/tool-card-preview.ts

- **当前 owner：** tool result preview strategy；serialization/JSON detection/canvas/semantic/text preview。
- **职责与关键 symbols：** tool result preview strategy；serialization/JSON detection/canvas/semantic/text preview。
- **旧语义与策略：** JSON pretty body与语义摘要；符合canvas条件投canvas preview；其他文本按字段和首行摘要，约18–48字符截断。
- **状态、存储与副作用：** 无；不加载canvas URL。
- **并发与性能特征：** stringify/parse/regex线性并可分配完整pretty string；本地非网络。
- **调用/依赖边界：** render state调用。
- **故障、恢复与安全：** stringify失败回Object tag，JSON失败文本；不redact raw text/body/URL/command/prompt。
- **迁移分类：** Preserve：canvas条件/JSON优先/`{`不作摘要。Intentional Improvement：保持raw/body契约前加size budget。Defect：无。待验证：secret/URL scheme/display memory policy。
- **未来 Rust owner：** Domain Module presentation projector；Delivery安全渲染canvas。
- **Rust 重写与性能判断：** 量化payload stringify/alloc；unicode截断需明确与JS UTF-16差异。
- **验证 oracle：** `tool-card-preview-generic-fallback.test.ts` golden tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-card-preview.ts`；调用/依赖边界：render state调用。；验证 oracle：`tool-card-preview-generic-fallback.test.ts` golden tests；证据：本文件。

### runtime-host/application/sessions/tool/tool-card-render-state.ts

- **当前 owner：** `resolveToolCardRenderState` tool input/output→card display组合点。
- **职责与关键 symbols：** `resolveToolCardRenderState` tool input/output→card display组合点。
- **旧语义与策略：** input summary/fallback；outputText优先否则serialize output；结果优先canvas→JSON→text→none；canvas surface assistant bubble。
- **状态、存储与副作用：** 无事实写入。
- **并发与性能特征：** 每card至少serialize input，output可能再serialize即使canvas；局部CPU/alloc。
- **调用/依赖边界：** canonical projection `buildToolCard`唯一生产入口。
- **故障、恢复与安全：** 下游可降级；工具output卡片路径未调用assistant display sanitizer，不代表一定漏洞但脱敏归属待查。
- **迁移分类：** Preserve：type priority/surface/fallback。Intentional Improvement：避免canvas重复序列化并定义secret projection。Defect：无确认。待验证：workdir/output/canvas容量与secret policy。
- **未来 Rust owner：** Domain Module pure tool-card projector。
- **Rust 重写与性能判断：** 比较四分支输出及alloc；不要归因Runtime执行时间。
- **验证 oracle：** empty args/preview fallback/canonical render fixtures；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-card-render-state.ts`；调用/依赖边界：canonical projection `buildToolCard`唯一生产入口。；验证 oracle：empty args/preview fallback/canonical render fixtures；证据：本文件。

### runtime-host/application/sessions/tool/tool-card-utils.ts

- **当前 owner：** card projection utilities：preview/string/finite/record/identity normalization。
- **职责与关键 symbols：** card projection utilities：preview/string/finite/record/identity normalization。
- **旧语义与策略：** 空值drop；预览折空白截断；finite number可由string；array非record。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** local string O(n)。
- **调用/依赖边界：** tool card content/preview/render state。
- **故障、恢复与安全：** 截断不是redaction；emoji/combining字符JS slice语义。
- **迁移分类：** Preserve：falsey/finite/trim/截断。Intentional Improvement：Rust Unicode策略显式化。Defect：无。待验证：UTF-16兼容要求。
- **未来 Rust owner：** Domain Module projector helper。
- **Rust 重写与性能判断：** 无；Unicode/numeric vectors。
- **验证 oracle：** card preview tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-card-utils.ts`；调用/依赖边界：tool card content/preview/render state。；验证 oracle：card preview tests；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-browser-detail.ts

- **当前 owner：** browser action中文 detail strategy；`resolveBrowserDetail`。
- **职责与关键 symbols：** browser action中文 detail strategy；`resolveBrowserDetail`。
- **旧语义与策略：** status/tabs/open/navigate/snapshot/screenshot/pdf/upload/dialog/act等映射，未知返回undefined给fallback。
- **状态、存储与副作用：** 无浏览器执行/I-O。
- **并发与性能特征：** 局部字段/数组截断；非Runtime浏览器延迟。
- **调用/依赖边界：** known detail resolver→tool display→card render→canonical projection。
- **故障、恢复与安全：** 缺字段降级；URL/selector/path/prompt可能展示，不是权限控制。
- **迁移分类：** Preserve：action映射/字段优先级。Intentional Improvement：隐私mask需显式。Defect：无。待验证：browser敏感字段策略。
- **未来 Rust owner：** Domain Module localised presentation；真实browser协议留Runtime Integration。
- **Rust 重写与性能判断：** pure mapping，action/field golden table。
- **验证 oracle：** `tool-display.test.ts` browser cases；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-browser-detail.ts`；调用/依赖边界：known detail resolver→tool display→card render→canonical projection。；验证 oracle：`tool-display.test.ts` browser cases；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-common.ts

- **当前 owner：** display strategy dispatcher；spec/action/known resolver/meta fallback。
- **职责与关键 symbols：** display strategy dispatcher；spec/action/known resolver/meta fallback。
- **旧语义与策略：** known resolver→detail keys→meta；first取首项，summary聚合去重最多8项；verb action label/fallback。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 配置key/path小规模扫描。
- **调用/依赖边界：** tool display入口调用；依赖 format/detail resolvers。
- **故障、恢复与安全：** 无detail正常fallback；meta原样可展示、未redact。
- **迁移分类：** Preserve：priority/8项。Intentional Improvement：meta敏感策略。Defect：无。待验证：单一重复detail UI文本。
- **未来 Rust owner：** Domain Module display policy。
- **Rust 重写与性能判断：** 无；known/fallback/meta first/summary table oracle。
- **验证 oracle：** tool display tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-common.ts`；调用/依赖边界：tool display入口调用；依赖 format/detail resolvers。；验证 oracle：tool display tests；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-detail-resolvers.ts

- **当前 owner：** known tool detail policy集合；read/write/search/fetch和多工具私有resolver。
- **职责与关键 symbols：** known tool detail policy集合；read/write/search/fetch和多工具私有resolver。
- **旧语义与策略：** 固定tool key顺序命中专用resolver，未命中common配置fallback；数值多数要求finite/positive。
- **状态、存储与副作用：** 无工具执行。
- **并发与性能特征：** 有限字段/数组处理，非工具/LLM/Runtime延迟。
- **调用/依赖边界：** tool-display-common直接使用。
- **故障、恢复与安全：** malformed→undefined；query/path/ID/reason可能显示，未redact。
- **迁移分类：** Preserve：专用优先与action文案。Intentional Improvement：schema/长字段/隐私规则以Runtime catalog验证。Defect：无。待验证：字段别名完整性。
- **未来 Rust owner：** Domain Module presentation policy；Runtime Integration拥有实际tool schema/execution。
- **Rust 重写与性能判断：** static mapping；按catalog抽样golden。
- **验证 oracle：** `tool-display.test.ts`多工具 cases；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-detail-resolvers.ts`；调用/依赖边界：tool-display-common直接使用。；验证 oracle：`tool-display.test.ts`多工具 cases；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-exec-shell.ts

- **当前 owner：** shell command展示解析helper。
- **职责与关键 symbols：** shell command展示解析helper。
- **旧语义与策略：** 简单双引号/单引号/backslash分词，识别shell `-c` wrapper，最多剥4段set/export/unset/cd等preamble；不是POSIX shell parser。
- **状态、存储与副作用：** 无执行/I-O。
- **并发与性能特征：** command长度线性，token数限制；本地处理。
- **调用/依赖边界：** exec display使用。
- **故障、恢复与安全：** 不完整语法回原command；不redact，不能用作安全解析。
- **迁移分类：** Preserve：启发式和上限。Intentional Improvement：替真parser会变展示，须先corpus。Defect：无。待验证：Windows/heredoc/complex quotes样本。
- **未来 Rust owner：** Domain Module exec-display helper，绝不进入执行actor。
- **Rust 重写与性能判断：** pure scanner；shell corpus golden。
- **验证 oracle：** quote/env/cd/wrapper/pipe/unknown tests；证据：本文件、tool display test。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-exec-shell.ts`；调用/依赖边界：exec display使用。；验证 oracle：quote/env/cd/wrapper/pipe/unknown tests；证据：本文件、tool display test。

### runtime-host/application/sessions/tool/tool-display-exec.ts

- **当前 owner：** exec/bash command中文摘要策略；`resolveExecDetail`。
- **职责与关键 symbols：** exec/bash command中文摘要策略；`resolveExecDetail`。
- **旧语义与策略：** unwrap/prelude strip，解析git/rg/find/ls/head/sed/cp/rm/package/script等；unknown回显压缩raw command，workdir优先workdir→cwd→preamble dir。
- **状态、存储与副作用：** 不执行命令。
- **并发与性能特征：** command线性，本地。
- **调用/依赖边界：** tool-display注入common resolver。
- **故障、恢复与安全：** parse失败可见raw command，可能露token；空workdir阻止采用cwd是否故意待验证。
- **迁移分类：** Preserve：known/generic/目录优先/120字。Intentional Improvement：secret masking要定义规则。Defect：无。待验证：空workdir/cwd与token命令。
- **未来 Rust owner：** Domain Module display mapper。
- **Rust 重写与性能判断：** command golden/alloc，不涉及子进程耗时。
- **验证 oracle：** git/pnpm/pipeline/cd/unknown/empty dir corpus；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-exec.ts`；调用/依赖边界：tool-display注入common resolver。；验证 oracle：git/pnpm/pipeline/cd/unknown/empty dir corpus；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-format.ts

- **当前 owner：** display value/path/format/spec primitives。
- **职责与关键 symbols：** display value/path/format/spec primitives。
- **旧语义与策略：** 默认忽略空/false/0/nonfinite；首行截断，数组至3，点路径lookup，` · `→中文顿号。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 局部线性。
- **调用/依赖边界：** browser/common/detail/message/display共享。
- **故障、恢复与安全：** 不 stringify任意object；仍非secret redaction。
- **迁移分类：** Preserve：false/zero省略/限制/分隔符。Intentional Improvement：按schema决定false/zero是否可显示。Defect：无。待验证：语义丢失情形。
- **未来 Rust owner：** Domain Module presentation utility。
- **Rust 重写与性能判断：** no I-O；value/path vectors。
- **验证 oracle：** tool display tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-format.ts`；调用/依赖边界：browser/common/detail/message/display共享。；验证 oracle：tool display tests；证据：本文件。

### runtime-host/application/sessions/tool/tool-display-message-detail.ts

- **当前 owner：** message tool action detail strategy。
- **职责与关键 symbols：** message tool action detail strategy。
- **旧语义与策略：** send/read/react/edit/delete/pin/poll/search/thread/permissions等，message text预览36字符，unknown交fallback。
- **状态、存储与副作用：** 不发送/读取消息。
- **并发与性能特征：** 局部fields，无网络。
- **调用/依赖边界：** detail resolvers调用。
- **故障、恢复与安全：** recipient/channel/user IDs与正文可展示；截断非隐私控制。
- **迁移分类：** Preserve：action/36字/field组合。Intentional Improvement：provider ID/DM content masking。Defect：无。待验证：跨provider可见性。
- **未来 Rust owner：** Domain Module presentation；Runtime Integration负责协议授权。
- **Rust 重写与性能判断：** action table，无I-O。
- **验证 oracle：** tool display send/thread tests；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display-message-detail.ts`；调用/依赖边界：detail resolvers调用。；验证 oracle：tool display send/thread tests；证据：本文件。

### runtime-host/application/sessions/tool/tool-display.ts

- **当前 owner：** display公开汇聚点；`resolveToolDisplay`、summary/formatters，加载shared/override JSON spec。
- **职责与关键 symbols：** display公开汇聚点；`resolveToolDisplay`、summary/formatters，加载shared/override JSON spec。
- **旧语义与策略：** module load合并两JSON；同名override对象级覆盖非deep merge；name规范后spec/fallback，只有detail开头home路径缩`~`。
- **状态、存储与副作用：** 模块初始化读嵌入JSON为常量；无运行期I-O/事实写。
- **并发与性能特征：** 每次有限字符串/key操作，无可变共享状态。
- **调用/依赖边界：** card render state唯一直接消费者，间接canonical projection。
- **故障、恢复与安全：** missing spec fallback；home缩写非redaction，URL query/token/中间绝对路径仍可展示。
- **迁移分类：** Preserve：merge优先/对象覆盖/title/detail/home规则。Intentional Improvement：deep merge/全mask都会改变输出。Defect：无。待验证：spec覆盖Runtime catalog及meta敏感规则。
- **未来 Rust owner：** Domain Module versioned display spec/projector；Delivery消费投影。
- **Rust 重写与性能判断：** 静态spec/纯函数；JSON merge/output golden，不涉Runtime执行。
- **验证 oracle：** `tool-display.test.ts` + two spec files；证据：本文件。
- **证据：** 源码 `runtime-host/application/sessions/tool/tool-display.ts`；调用/依赖边界：card render state唯一直接消费者，间接canonical projection。；验证 oracle：`tool-display.test.ts` + two spec files；证据：本文件。


## 末尾核验

- **未读：** 0；**已读：** 58/58（10,805 行）。
- **排除：** `runtime-host/application/sessions/tool/tool-display-overrides.json`、`tool-display-shared-spec.json` 是输入契约而非 `.ts`，按 inventory 规则不计入58；`runtime-host/build/**`为编译产物，`node_modules/**`、覆盖率/测试输出/临时目录为非拥有生产源；`runtime-host/package.json`、`tsconfig.json`为构建配置。没有静默排除 `.ts`。
- **范围不一致：** 无；Python 当前枚举数与 `00-inventory.md` 06分片均为58。报告仅覆盖此分片；session workflows在07分片，shared/runtime/adapter/route仅作为调用证据，不重审。
- **写入限制：** 本次只创建本报告 `docs/architecture/runtime-host-ts-rust-migration-audit/06-sessions.md`；未修改 `runtime-host` 源码、测试、README、inventory、其它报告或配置。报告生成后应以 Git 路径状态再次核验。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **Session Domain canonical state/timeline 仍由 TypeScript semantic owner 保留；Rust cutover 未证实。** 当前 status 修改了 `canonical/{canonical-reducer,canonical-state}.ts`、`session-timeline-runtime.ts`、`session-transcript-timeline-loader.ts`、runtime types 等；这些是 active TS facts/projections，不是 Rust replacement。
- **生产 active path：** Delivery/capability → `SessionRuntimeService` / `SessionPromptService` → `SessionRunWorkflow`；其本地 canonical commit 经 `SessionOperationCoordinator` → `SessionTimelineRuntime.appendCanonicalEvents` → reducer/state/projection/snapshot，随后由 `AgentRuntimeRegistry.resolveTransport` 发送。Gateway/adapter event 则经 `SessionGatewayIngressWorkflow` → 同一 timeline。新增 Matcha-agent transport/event bridge 的 checkpoint store 只为 in-memory TS sequence projection；它与 OpenClaw/ACP 同经 registry/ingress，不能当 durable replay proof。
- **关联增量 owner：** `application/chat/send-media.ts` 已移除直接 `GatewayChatPort.chatSend` 的 `sendWithMediaViaGateway`。active media path 现在是 `buildSendWithMediaGatewayParams` → `SessionRunWorkflow.sendRuntimePrompt` → endpoint-selected `RuntimeSessionTransport.sendPrompt`，因此其 owner 属 Session prompt transport boundary（本 06/07 链），不是 Gateway 的独立事实 owner。此改变保留 attachment 组装，但必须由所选 runtime 决定投递；无 Rust handoff。`application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter.ts` 也已改动但属 **12 Team Runtime** 分片（dematerialize 的 `chat.sessions.delete` 不再传 `agentId`），本 06 仅记录边界，不将其遗漏伪归 Session。
- **旧策略与 future owner：** 保持完整 `SessionIdentity`、local canonical-first commit、runtime send receipt 与 observed ingress 分离，以及 media size/content projection。future Rust 应由 Session Domain actor/aggregate 持有 canonical facts；Runtime Integration 继续持有 OpenClaw/Matcha/ACP transport；不能从本次静态改动声称 exactly-once、durable checkpoint 或 successful delivery。
- **renderer / lifecycle 外部边界：**chat store、pane、ChatInput、attachment preview、optimistic snapshot、toast与 local active-run 都只是 Session consumer projection；UI receipt或 local patch不可替代 canonical timeline或外部 outcome。Electron 当前所承载的 app-server/Gateway/runtime-host process lifecycle也不进入 Session Domain；其 lifecycle policy/implementation将在对应 Rust Local Process Host功能块迁移，peer app-server 的 event store/worker不随之迁入。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/runtime-host-canonical-timeline-model.test.ts tests/unit/session-adapter-service.test.ts tests/unit/session-catalog-service.test.ts tests/unit/session-gateway-ingress-workflow.test.ts tests/unit/chat-input-attachments.test.ts tests/unit/chat-send-handlers.test.ts`；`pnpm run typecheck`。本次均**未运行**。
