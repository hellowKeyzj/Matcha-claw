# 07 Session workflows：TS → Rust 文件级迁移审计

> 状态：完成。范围严格取自 [`00-inventory.md`](00-inventory.md) 的 07 分片；本报告是当前工作树的只读事实记录，不是 Rust 实施批准。
>
> 审计方法：先以 Python 按 inventory 的 16 条路径逐个完整读取，再用 `.codegraph` 追踪提交、运行时发送、审批、入口翻译、timeline、hydrate/replay、snapshot 与 lifecycle 调用链。所有“未来 Rust”项均为迁移建议；不声称外部 Runtime 提供 exactly-once。

## 本分片完整文件清单（16）

1. `runtime-host/application/workflows/session-approval/session-approval-workflow.ts`
2. `runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts`
3. `runtime-host/application/workflows/session-command/session-command-operations-workflow.ts`
4. `runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts`
5. `runtime-host/application/workflows/session-hydration/session-hydration-workflow.ts`
6. `runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow.ts`
7. `runtime-host/application/workflows/session-metadata/session-model-resolution-workflow.ts`
8. `runtime-host/application/workflows/session-model-selection/session-model-selection-workflow.ts`
9. `runtime-host/application/workflows/session-operation/session-operation-result-workflow.ts`
10. `runtime-host/application/workflows/session-run/session-run-workflow.ts`
11. `runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow.ts`
12. `runtime-host/application/workflows/session-snapshot/session-snapshot-workflow.ts`
13. `runtime-host/application/workflows/session-storage/session-storage-index-workflow.ts`
14. `runtime-host/application/workflows/session-storage/session-storage-mutation-workflow.ts`
15. `runtime-host/application/workflows/session-storage/session-storage-repository-workflow.ts`
16. `runtime-host/application/workflows/session-storage/session-storage-transcript-workflow.ts`

## 已追调用链与边界结论

- **Prompt submit → local commit → runtime send：** `SessionRunWorkflow.execute` 先通过 `SessionOperationCoordinator.run(identity, 'prompt')` 激活 session、追加 `local:user:*` 和 `local:lifecycle:*:started` canonical events、构造快照并 `flushPersistedStore`；仅在 `committedEventCount > 0` 时 detached 地在同一 identity 串行队列上调用 `ensureSession`／`startSessionEvents`／`sendPrompt`。`runId` 同时是 user message/part identity、local event id 的组成和 runtime `idempotencyKey`，但不是持久化的跨进程 delivery receipt。
- **Canonical commit 与 receipt 的区别：** `SessionTimelineRuntime.appendCanonicalEvents` 通过 canonical reducer 去重、投影、更新索引并触发持久化；这是本地 Session Domain 事实已提交。运行时 `sendPrompt` 的 `{ success, error?, payload? }` 只是 transport 的即时返回：工作流仅检查 `success`，不存储 payload/receipt。外部 Runtime 是否已接受、在超时后未知、或稍后是否执行，需由后续 ingress 事实观察，不能伪造 exactly-once。
- **Approval resolve／abort：** resolve 先把请求交给 runtime，返回成功后仅在本地 pending approval 同一 `SessionIdentity` 时追加 local resolved event；该路径没有 coordinator/flush。abort 先执行 runtime `abortSession`，成功后才在 identity 串行队列追加 local `aborted` lifecycle、flush 并发 Delivery update。OpenClaw transport 对逐 approval deny 的错误明确吞掉，但 `chat.abort` 失败会阻止本地 abort 事实提交。
- **Gateway ingress／adapter／timeline：** ingress 仅解析 endpoint/session identity、调用 `protocol.eventAdapter.canTranslate/translate`（Runtime Integration translator）、将 canonical events 交给 `SessionTimelineRuntime`（Session Domain）并形成 Delivery update。非 record、无 endpoint session id、不可翻译或空 events 都是静默 drop；identity 冲突、缺少可推导 agent id 的事件/approval notification 是 hard fail。workflow 不拥有 canonical event 的顺序、重复抑制、gap 或重放合并；这些由 `canonical-reducer` 和 `SessionTimelineRuntime.appendCanonicalEvents`／hydrate 路径拥有。
- **Hydrate／replay／snapshot／lifecycle：** hydration 请求先返回 accepted job；job 执行以 identity 的 `reconcile` 队列调用 `timelineRuntime.hydrateSession`。后者在未 hydrated、且没有内存 render/canonical message 时从 transcript loader replay canonical events，再投影、标 hydrated、保存窗口。snapshot 是 Session read model；lifecycle 管理 storage identity、内存 overlay、catalog refresh 和事件订阅停止，均不是 Kernel。

---

### runtime-host/application/workflows/session-approval/session-approval-workflow.ts

- **当前 owner：** Session Domain workflow。它编排 session 的审批决定与中止事实；`resolveTransport`、OpenClaw/Matcha 协议调用属于 Runtime Integration，`emitSessionUpdate` 是 Delivery 边界。
- **职责与关键 symbols：** `abort` 获取当前 `activeRunId` 并先请求 runtime 中止；`commitAbortSession` 追加 local lifecycle、构造 snapshot、flush、发更新。`resolve` 请求 runtime 解决 approval；`findPendingApproval` 用完整 identity 确认 pending entry；`appendResolvedApprovalEvent` 形成 local approval canonical event。
- **旧语义与策略：** abort 的顺序固定为 runtime `abortSession` 成功后才写入 `local.abort` / `aborted`；事件 id 为 `local:lifecycle:<session>:<run|active>:aborted`，reducer 的事件去重决定重复提交效果。resolve 的顺序也固定为 runtime success 后才在 pending entry 存在且同 identity 时追加 `local:approval:resolved:<session>:<id>:<decision>`。因此 runtime 先成功、进程随后故障时，外部决定与本地 timeline 可暂时不一致；反向地 abort runtime 失败时没有本地 aborted 事实。resolve 不因找不到 pending approval 拒绝 runtime 调用，也不 flush/update。
- **状态、存储与副作用：** 读 `stateStore` 的 active run 和 approval index；通过 `timelineRuntime` 写 canonical state；abort 的本地提交后 flush persisted store，并可将 snapshot 发给 Delivery。外部副作用为 `transport.abortSession` / `transport.resolveApproval`；不保存 transport response 或 receipt。
- **并发与性能特征：** `commitAbortSession` 以 `SessionOperationCoordinator` 的 `buildSessionIdentityKey` 串行 `abort`；`resolve` 没有进入该队列，所以 resolve 与 abort/ingress 可交错。snapshot 会复制投影数据并做存储/metadata 查询；无批量审批或重试。
- **调用/依赖边界：** 上游 `SessionCommandOperationsWorkflow.abortSession/resolveApproval`；下游 `AgentRuntimeRegistry.resolveTransport`、`SessionTimelineRuntime.appendCanonicalEvents`、`SessionSnapshotService`、`SessionRuntimeStateStore`。OpenClaw transport 的 abort 对每个 approval 发 deny RPC 并吞掉单项失败，再调用 `chat.abort`。
- **故障、恢复与安全：** abort 捕获 runtime 调用异常并映射 `serverError`；resolve 的 transport 异常直接 reject 给上游。没有未知 receipt 状态、retry、补偿、或重启恢复流程。approval allow-once/allow-always/deny 与 abort 是红色动作；本文件仅以 identity 绑定 pending approval，未做鉴权、授权或 decision allow-list 以外的安全策略，须由 Delivery/Capability 边界提供。事件中无 secret，但 snapshot 仍可能含下游投影内容。
- **迁移分类：** **Preserve：** runtime-first 后记录 local approval/abort 的观察顺序、完整 identity 比对、abort snapshot/update。**Intentional Improvement：** 把 approval command、outbox request、runtime receipt/unknown 和 observed ingress event 显式建模；同一 identity actor 串行 resolve 与 abort，并将未证实的外部结果标为 unknown/pending，而非伪称 exactly-once。**待验证：** 现有 resolve 不 flush 是否是有意的 durability 语义；approval 与 abort 的竞态预期。
- **未来 Rust owner：** Session Domain Module 拥有 approval/abort state machine、pending approval identity 与 local facts；Runtime Integration 拥有具体 runtime approve/abort translator；Delivery 只暴露命令和 session update。
- **Rust 重写与性能判断：** 为同一 `SessionIdentity` 设 actor/mailbox；将“请求 runtime”作为含 correlation/run/approval id 的 durable outbox，记录 sent/receipt-unknown/observed，收到 ingress 再推进本地事实。receipt oracle 是 transport 返回与 canonical ingress 的关联，不是外部 exactly-once 承诺。避免每次 action 都复制完整 snapshot 仅在 Delivery 实际订阅时投影；以 actor queue depth、outbox age、unknown 数、abort 到 terminal observed 延迟为指标。
- **验证 oracle：** `tests/unit/runtime-host-pending-approval-store.test.ts`、`tests/unit/helpers/session-runtime-fixture.ts`；注入 resolve 成功后 crash、abort RPC 失败、per-approval deny 失败、并发 resolve/abort 和重放 ingress，断言 local facts、unknown 状态、Delivery update 及不重复执行。
- **证据：** `SessionApprovalWorkflow.abort/resolve/commitAbortSession`；`SessionOperationCoordinator.run`；`SessionTimelineRuntime.appendCanonicalEvents`；`runtime-host/application/adapters/openclaw/runtime/openclaw-transport.ts`。

### runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts

- **当前 owner：** Session Domain workflow 的 catalog read-model 与缓存策略；外部 session list 的 protocol/transport 翻译是 Runtime Integration，不是 Platform Core。
- **职责与关键 symbols：** `refreshCache`／`scanSessions` 扫 storage descriptors；`listSessions` 合并缓存、runtime overlays 与 external runtime sessions 并过滤/sort；`buildSessionCatalogItem` 从 transcript 与 metadata 推导展示信息；`resolveBoundSessionCatalogItem` 修正 endpoint-session alias；`buildOverlayCatalogItem` 和 external merge 组合 in-memory session。
- **旧语义与策略：** refresh 成功才替换整个 cached list、置 ready/updatedAt/clear error；失败保留旧缓存和 ready 值、设置 error 后 rethrow。scan 仅接受具有 transcript path 且 fingerprint 可取的 descriptor；store 没 label 且 transcript 没可投影内容时排除。list 仅返回同 runtime endpoint 且非 archived/deleted 项；runtime-only overlay 必须有 `runtime.updatedAt` 才暴露；external item 无 endpoint session id/keying namespace 时丢弃。排序按 `updatedAt` 降序、key 升序。
- **状态、存储与副作用：** 内存 `cachedSessions/cacheReady/cacheUpdatedAt/cacheError`；读取 session storage、逐行 transcript、metadata default model、registry alias 和可选 runtime `listExternalSessions`。不写 storage；外部 list 结果即时并入，不缓存为产品事实。
- **并发与性能特征：** scan 用固定 `SESSION_CATALOG_SCAN_CONCURRENCY = 8`，每 descriptor 可能 stat、逐行解析 transcript、解析 model；全量 merge/sort 为 O(n log n)。缓存失效依赖下游 storage index 的 mtime fingerprint；没有取消、背压或单飞 refresh，多个调用可重复扫描。
- **调用/依赖边界：** 上游 lifecycle list/refresh job、composition/fixture；下游 `SessionStoragePort`、`SessionMetadataPort`、`AgentRuntimeRegistry` 和可选 `RuntimeSessionTransport.listExternalSessions`。timeline overlays 从 state store 传入，不在此文件生成。
- **故障、恢复与安全：** `refreshCache` 将异常留在 `cacheError` 并抛出；scan 内 transcript fingerprint 缺失直接跳过，细粒度解析的容错取决于 parser/storage。标签、模型、transcript 内容都可能来自 runtime-owned files；本文件未作 secret/redaction 或权限检查，不应把缓存视为可信授权目录。
- **迁移分类：** **Preserve：** endpoint/identity-key 合并、archived/deleted 隐藏、external 与 overlay 的优先级、显示 label 的来源顺序和排序。**Intentional Improvement：** 以 Session Domain 持久索引/增量投影替代每次全 transcript scan；保留外部 runtime list 为 Runtime Integration 的 observed overlay，清晰暴露 stale/error。**待验证：** 固定并发 8 是否适合全部文件系统/大型档案。
- **未来 Rust owner：** Session Domain Module 拥有 catalog projection、缓存新鲜度及 transcript-derived metadata；Runtime Integration 提供 external-session listing/identity translation；Delivery 消费 list read model。
- **Rust 重写与性能判断：** 每 identity actor/索引 writer 消费 storage 变更和 canonical facts，维护可查询 catalog；每个 runtime adapter 用有界并发读取外部列表。消除的成本是全量 descriptor + transcript 扫描和整表排序；保持当前可见性、排序和 stale/error 语义。指标：扫描 I/O、首次/热列表延迟、峰值内存、stale duration；oracle 是 fixture corpus 的 catalog 差分和删除/归档情形。
- **验证 oracle：** `tests/unit/session-catalog-service.test.ts`、`tests/unit/helpers/session-runtime-fixture.ts`；补充损坏 transcript、重复 identity、alias 改绑、外部 runtime list 失败/缺 namespace、并发 refresh 的基准和差分测试。
- **证据：** `SessionCatalogWorkflow.refreshCache/listSessions/scanSessions`、`buildSessionCatalogItem`、`SessionLifecycleWorkflow.list`、`SessionStorageIndexWorkflow`。

### runtime-host/application/workflows/session-command/session-command-operations-workflow.ts

- **当前 owner：** Delivery command translator：把未知 payload 解析为 application request，执行必填/identity 一致性校验，再委派 Session Domain workflow；不拥有 session timeline 或 runtime 业务状态。
- **职责与关键 symbols：** create/delete/archive/unarchive/status/list/load/resume/patch/rename/switch/state/window/abort/approval/hydration 的路由级命令适配。`sessionIdentityMatchesSessionKey` 只比较 `sessionKey` 字段；`listPendingApprovals` 读 state store 并 clone/sort。
- **旧语义与策略：** 对各 request reader 的 endpoint、agentId、sessionKey、SessionIdentity、label、model、approval id/decision 做 `badRequest`；create 对 endpoint/agentId 额外校验。archive/unarchive 强制 status，switch 等价 load。load/resume/state 不在此文件显式检查 `sessionIdentity.sessionKey === sessionKey`，而 hydration job execute 会检查；patch/rename/delete/status/resolve 显式检查。older/newer window 缺 offset 直接 bad request。listPendingApprovals 按 `createdAtMs` 升序。
- **状态、存储与副作用：** 除读取 pending approvals 外无状态；副作用完全委派 lifecycle/hydration/approval/model selection。它把 accepted hydration job 原样返回，不等待 replay。
- **并发与性能特征：** 自身无队列、缓存或 I/O；并发语义由委派 workflow 和 `SessionOperationCoordinator` 决定。同步 clone/sort pending approvals 为 O(a log a)。
- **调用/依赖边界：** 上游 Session capability/route composition；下游四个 Session Domain workflows 及 state store。payload readers 在 `application/sessions/session-runtime-requests.ts` 是此 Delivery contract 的解析边界。
- **故障、恢复与安全：** 仅将可预检问题映射 bad request，委派异常/response 不统一转换。没有认证、scope 检查、rate limit、secret redaction 或 red-action approval；因此不能作为安全边界。对于红色 abort、approval resolve、delete，必须依赖 Capability/Delivery 授权后才进入这里。
- **迁移分类：** **Preserve：** public request validation、status 强制、window offset 拒绝、accepted hydration 异步契约和 pending approval 排序。**Intentional Improvement：** 将 request schema/authorization/error grammar置于 Rust Delivery 层，确保每个包含 identity 的命令一致验证完整 identity/sessionKey；不把这个 facade 迁为 Session state owner。**待验证：** load/resume/state 的 identity-key 不一致最终返回何种外部错误。
- **未来 Rust owner：** Delivery；Session Domain Module 提供 typed command handlers；Runtime Integration 不应通过本文件泄漏 runtime-specific payload。
- **Rust 重写与性能判断：** 用一次反序列化的 typed request/response contract，调用 Domain command actor；无性能迁移主张。指标仅为请求拒绝率与 handler latency，oracle 是现有 route/fixture request-response 差分及错误码测试。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts` 与 session route/capability tests；新增每个 command 的 malformed payload、identity mismatch、window missing offset、未授权 red action 的 Delivery test。
- **证据：** `SessionCommandOperationsWorkflow` 全部公开方法；`session-runtime-requests.ts`；各委派 workflow。

### runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts

- **当前 owner：** Session Domain ingress workflow，负责 identity binding、canonical commit 后的 Session update 投影；`protocol.eventAdapter.canTranslate/translate` 是 Runtime Integration translator，最终 `SessionUpdateEvent` 是 Delivery payload。Session timeline 不应升级为 Kernel。
- **职责与关键 symbols：** `consumeEndpointConversationEvent` 读取 endpoint session key、绑定 context、让 adapter 翻译并提交；`consumeEndpointNotificationByEndpoint` 处理 approval notification；`commitCanonicalEvents` 设 active session、提交 timeline、构造 snapshot/update；`resolveEndpointEventContext`／`resolveEventSessionIdentity` 强制 alias/identity 规则；`resolvePrimaryCanonicalItem` 找 message/tool/thought 的 UI 项。
- **旧语义与策略：** 非 object payload、缺 endpoint session id、`canTranslate=false`、adapter 输出空数组、或首 event 无 session id均返回空数组（静默 drop）。已有 endpointSessionId alias 时以 alias identity 覆写 payload；无 alias 时可使用合格 payload identity，或仅从 `agent:<agentId>:` session key 推导 agent。payload identity 与推导 identity 不同、指定但不合法的 SessionIdentity、或无法取得 agentId 的 event/approval notification 会 throw hard fail。每次非空提交会将 active session 改为首 event session；更新类型由最后 event 定义，lifecycle 缺失时 phase 是 `unknown`。live events 或已 hydrated state 令 snapshot `replayComplete=true`。
- **状态、存储与副作用：** 写 activeSessionKey 和 canonical timeline；timeline reducer 完成 canonical event 去重、状态索引、投影、run epoch/meta 和 `persistStore` 调度。此 workflow 同步构造 snapshot，未 await flush；它不直接网络发送。可选 terminal trace 从 Matcha event 读取、在 canonical terminal phase 附加 Delivery trace；todo debug 仅日志。
- **并发与性能特征：** 本身不通过 `SessionOperationCoordinator`，因此 concurrent ingress 直接操作共享 state；JavaScript 单线程执行单次 append，但异步 caller interleave 与持久化次序由更低层决定。primary item 搜索最坏 O(renderItems)；snapshot clone/切片成本取决于窗口。没有 ingress queue、gap buffer、seq reorder 或 backpressure。
- **调用/依赖边界：** 上游 `SessionGatewayIngressService`、runtime event subscription（由 SessionRunWorkflow 开启）和 approval notification bridge；下游 registry protocol/event adapter、timeline runtime、state store、snapshot service。CodeGraph 路径为 `SessionRunWorkflow.sendRuntimePrompt.startSessionEvents.consume` → `SessionGatewayIngressWorkflow.consumeEndpointConversationEvent` → adapter translate → `commitCanonicalEvents` → `SessionTimelineRuntime.appendCanonicalEvents` → `canonical-reducer`/projection。
- **故障、恢复与安全：** distinguish drop 与 hard fail 如上；run workflow subscription 对带 Matcha terminal trace 的 hard error 记录 `ingress_rejected` 后吞掉，普通 event 只 warn。无 adapter receipt、retry、dead-letter 或 unknown ingress state。identity injection 防护只检查 identity 一致性；没有 schema authentication、payload redaction 或 authorization。unknown phase 仅是 Delivery projection 默认，不能当 runtime execution 状态。seq/gap/重复规则不在本 workflow：它不得自行猜测或补齐。
- **迁移分类：** **Preserve：** alias 优先、drop/hard-fail 区分、adapter→canonical→Delivery projection、terminal trace 的 only-on-observed terminal 语义。**Intentional Improvement：** Session identity actor 接受已验证 canonical envelopes；Runtime Integration 在 actor 外进行协议翻译，附 source/correlation/observed timestamp；为 malformed/hard-failed event 建可观测 reject stream，不改变当前 drop 的公共响应。**待验证：** concurrent ingress 与 persistence ordering、adapter 对 sequence/gap 的实际规范。
- **未来 Rust owner：** Session Domain Module 拥有 ingress orchestration、canonical fact append和 session UI projection；Runtime Integration 拥有 protocol/approval translator；Delivery 只发送 update。Foundation Kernel 仅可提供 generic durable append/cursor/queue 原语，不能拥有 Session timeline。
- **Rust 重写与性能判断：** 同 identity actor 顺序处理 canonical events；让 Runtime Integration adapter 产生带 dedupe/correlation 候选的 envelope，由 Session reducer 决定接受。若需要恢复 transport cursor，Foundation 提供 cursor primitive，Session 定义其语义。用 bounded mailbox 与 ingress reject/lag metrics；oracle 为 canonical accepted-event stream、snapshot/update 差分、重复/乱序/gap corpus。任何 outbox/receipt只表达 sent/unknown/observed，禁止宣称外部 runtime exactly-once。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`、`tests/benchmark/runtime-host-architecture-benchmark.test.ts`；补充 non-record/missing key/drop、identity spoof/hard fail、alias、duplicate event、gap/乱序以及 terminal trace fault injection。
- **证据：** `SessionGatewayIngressWorkflow.consumeEndpointConversationEvent/commitCanonicalEvents/resolveEndpointEventContext`；`SessionTimelineRuntime.appendCanonicalEvents`；`canonical-reducer.ts`；`SessionRunWorkflow.sendRuntimePrompt`。

### runtime-host/application/workflows/session-hydration/session-hydration-workflow.ts

- **当前 owner：** Session Domain workflow 的 asynchronous hydrate/replay orchestration；job transport是 Foundation/host 提供的任务机制，但 replay语义仍归 Session Domain。
- **职责与关键 symbols：** `load/resume/state` 均接受 hydration job；`window` 对已 hydrated state 直接投影窗口，否则接受 job；`execute` 解析 job payload；`hydrateFromTranscriptSlowPath` 同 identity 串行调用 timeline hydrate、snapshot、persist；`readHydrationRequest/readHydrationSnapshotRequest` 校验 identity/request。
- **旧语义与策略：** load 请求 latest window，resume/state 请求 state，响应为 `accepted({ hydrationJob })` 而非 data。window 已 hydrated 时立即 build window snapshot、更新 state.window、persist/flush；否则也返回 accepted。job execute 拒绝非 object/空 sessionKey/无效 identity/identity sessionKey 不匹配；缺少或未知 snapshot 默认 state，latest 识别为 latest，window 复用 window request parser。慢路径以 `reconcile` 串行，timeline 只在必要时 replay；state snapshot 若未选窗口且当前 window 空，使用 latest window；完成后 `replayComplete=true` 并 flush。
- **状态、存储与副作用：** 读写 state/window，调用 transcript/timeline hydrate；提交 job 到 `SessionHydrationJobPort`；persist store 并 await flush。此 workflow 不直接持有 transcript parser 或 runtime transport，不写 runtime receipt。
- **并发与性能特征：** hydrate/reconcile 在完整 SessionIdentity 串行队列内；已 hydrated window fast path 不经 coordinator，可能与 ingress/other state mutation交错。slow path 由 transcript大小主导，snapshot会复制 render items；job queue 的去重/并发/重试未在本文件规定。
- **调用/依赖边界：** 上游 `SessionCommandOperationsWorkflow.load/resume/state/window/executeSessionHydration`；下游 `SessionHydrationJobPort`、registry identity memory、`SessionTimelineRuntime.hydrateSession`、snapshot/state store。timeline hydrate 从 `SessionTranscriptTimelineLoader` 读 replay canonical events。
- **故障、恢复与安全：** payload validation 抛 Error（job failure）；storage/replay/snapshot/flush 错误向 job 调用方传播，本文件没有 retry/unknown mapping。缺失 snapshot request 不是失败而是 state default；未 hydrated data不会冒充完成。transcript 是不可信/历史输入，本文件只验证 identity，不清洗内容或 redaction；必须让 parser/reducer与 Delivery保护敏感内容。
- **迁移分类：** **Preserve：** accepted job API、identity/sessionKey 强校验、reconcile串行、fast window 与 transcript slow-path、replayComplete/window semantics。**Intentional Improvement：** durable hydration job 记录 `(identity, transcript fingerprint, requested projection)`，使 crash/retry可观察；actor把 replay与live ingress排序，记录 `unknown/failed` job outcome而不是隐含重试。**待验证：** 同一 identity 多个 hydration job 是否应合并、fast window与 ingress竞态。
- **未来 Rust owner：** Session Domain Module；Foundation Kernel 提供 job supervisor、deadline/retry/cursor，而不能拥有 transcript replay或窗口规则；Delivery接收 job handle/最终 snapshot。
- **Rust 重写与性能判断：** 使用同 identity actor，并让 job带 fingerprint/correlation；流式 replay避免整文件/全量 render中间复制，最后依请求窗口投影。要消除的旧成本是重复 hydration/全量 snapshot；保持当前 replay、窗口和 accepted语义。指标：replay吞吐、峰值内存、job latency、fingerprint命中、failed/unknown ratio；oracle是 transcript corpus 的 canonical facts/snapshot差分与 crash-after-replay-before-flush注入。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`；新增 malformed job、identity mismatch、缺失文件、重复 job、live ingress 同时到达、flush失败与恢复测试。
- **证据：** `SessionHydrationWorkflow`；`SessionTimelineRuntime.hydrateSession/ensureSessionHydrated`；`SessionTranscriptTimelineLoader`；`SessionOperationCoordinator.run`。

### runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow.ts

- **当前 owner：** Session Domain workflow，拥有 session create/delete/status/rename/list的跨 storage、timeline、overlay编排；停止 runtime event subscription 是 Runtime Integration control hook，list response是 Delivery read model。
- **职责与关键 symbols：** `create` 解析 endpoint keying、激活 timeline、upsert storage identity、snapshot/flush；`delete` 验证 ownership、停止 events、删除 storage与内存 state；`updateStatus`／`rename` 修改 storage；`list` 刷新 catalog并报告 job freshness；`verifySessionIdentity` 防止同 local key 误属其他 endpoint/agent。
- **旧语义与策略：** create 优先 explicit key，否则 `<namespace>:<agent>:session-<clock>-<random>`；endpoint没 keying namespace 返回 conflict。create 先激活内存、再 upsert storage identity、再快照/flush，storage write失败会使已激活内存暂留。delete 先 ownership check，随后 stop events、delete storage、delete memory、persist/flush，并吞掉 catalog refresh失败。status/rename 先 ownership、storage返回 false时 notFound；status `deleted` 停 events并删除内存，但不像 delete 明确 persist/flush。list 若cache未 ready就同步 refresh，然后合并 runtime overlays；`refreshing` 从当前 catalog job queued/running得出。
- **状态、存储与副作用：** 读写 session storage index、state store、timeline active key/window；停止 runtime event stream；读 catalog and job status。没有直接 runtime create/delete RPC：本地 session lifecycle与外部 runtime session lifecycle不等同。
- **并发与性能特征：** 本文件的 lifecycle methods未用 SessionOperationCoordinator；同步 create/delete/status可竞态。list可能触发全 storage scan；create key依 clock+random，不能视为业务幂等键。
- **调用/依赖边界：** 上游 `SessionCommandOperationsWorkflow`；下游 registry、timeline, storage repository, snapshot service, catalog/job, state store及可选 `stopSessionEvents`。storage mutation最后进入 session-storage workflows。
- **故障、恢复与安全：** ownership以完整 `buildSessionIdentityKey` 验证，state未命中时读取 storage descriptor；unknown key为 notFound，identity错配为 conflict。catalog refresh error被故意吞掉；其余 storage/timeline异常可逸出。delete是红色破坏动作，停止订阅、文件删除和内存删除无事务/outbox，故半完成/未知需迁移时可观测；本文件不鉴权、不审计操作主体，也不处理 secrets。
- **迁移分类：** **Preserve：** identity ownership、防止跨 endpoint删除、key生成策略/无namespace冲突、catalog visibility、delete时停止订阅。**Intentional Improvement：** lifecycle actor/command ledger显式记录 storage mutation、event stop与完成/unknown；对 create的部分失败和 `deleted` status 的持久化一致性建立事务边界或恢复流程。**待验证：** status deleted 是否依 lower-layer mutation自动持久化；外部 runtime是否需要单独删除。
- **未来 Rust owner：** Session Domain Module；Runtime Integration实现 event subscription stop；Delivery实施红色动作授权、确认和审计展示。不可归 Foundation Kernel或 Matcha Platform Core。
- **Rust 重写与性能判断：** Session identity actor串行 lifecycle/ingress/hydration，持久 command ledger/outbox记录对 runtime subscription 的stop请求及unknown；storage mutation可以利用原子 rename/事务索引。保持当前本地生命周期与外部 runtime不等价。指标：create/delete恢复时间、订阅泄漏、catalog staleness、失败半完成数；oracle为故障点矩阵和身份隔离测试。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts`、session catalog tests；补充 create storage失败、delete文件/flush失败、deleted status后重启、identity collision、catalog refresh失败、subscription stop失败的fault injection。
- **证据：** `SessionLifecycleWorkflow.create/delete/updateStatus/rename/list/verifySessionIdentity`；`SessionCatalogWorkflow`；`SessionStorageRepositoryWorkflow`。

### runtime-host/application/workflows/session-metadata/session-model-resolution-workflow.ts

- **当前 owner：** Session Domain model-resolution policy；可选 default model resolver 的 runtime/config读取是 Runtime Integration adapter。
- **职责与关键 symbols：** `resolveSessionModel` 执行 runtime model → storage entry override/model → default resolver 的优先级；`readAgentModelValue` 和 `resolveAgentConfigDefaultModel` 解析 agent config；`qualifySessionModel` 补 provider 前缀。
- **旧语义与策略：** truthy `runtimeModel`直接胜出；否则 `providerOverride/modelOverride` 胜于 `modelProvider/model`；再调用可选 default resolver，未配置或无结果为 null。string都会 trim；provider已同大小写前缀不重复拼接。agent list 按 id 精确匹配，未命中落到 agents.defaults；非 record、空值、数组均不作为 model。
- **状态、存储与副作用：** 无内部状态/写入；读取已提供的 storage descriptor，可能异步调用 default resolver。无 network/storage ownership。
- **并发与性能特征：** 无队列、缓存或 I/O（除 injected resolver）；线性扫描 agents list。每个 async snapshot/catalog调用可能重复解析 default config，缓存不在此文件定义。
- **调用/依赖边界：** 上游 snapshot async 和 catalog item building，经 `SessionMetadataRepository`；下游 `SessionDefaultModelResolverPort`，当前 CodeGraph 指向 OpenClaw session metadata resolver。输出是展示/已解析 model，并不发送 patch。
- **故障、恢复与安全：** resolver 抛错会传播；畸形存储字段静默归 null/下一优先级。model/provider字段可来自配置但无 secret读取；无 authorization、provider capability验证或 redaction。不要将未验证字符串作为安全凭据。
- **迁移分类：** **Preserve：** 三层 precedence、trim/qualification和 null fallback。**Intentional Improvement：** 用 typed `ModelRef` 和 provider capability validation表达解析结果/来源，runtime config读取留在 Runtime Integration；将 resolver失败与“未配置”区分为可观察状态。**待验证：** `runtimeModel` 空白字符串当前因 truthy直接返回，和其他路径 trim规则不一致。
- **未来 Rust owner：** Session Domain Module 的 precedence policy；Runtime Integration 的 default-model config projection；Delivery仅显示结果。
- **Rust 重写与性能判断：** 不需要 actor或优化；仅在 catalog批量解析时可按 endpoint/agent缓存安全的配置快照。保持 precedence；指标为批量 catalog读取次数/延迟；oracle为表驱动 provider/model/override/default输入矩阵。
- **验证 oracle：** catalog/snapshot fixtures；新增大小写 provider、空白 runtime model、缺失/畸形 config、agent override/default和 resolver错误测试。
- **证据：** `SessionModelResolutionWorkflow.resolveSessionModel`、`resolveAgentConfigDefaultModel`；`SessionSnapshotWorkflow.buildSnapshotAsync`；`SessionCatalogWorkflow.buildSessionCatalogItem`。

### runtime-host/application/workflows/session-model-selection/session-model-selection-workflow.ts

- **当前 owner：** Session Domain command workflow：在本地 run safety gate之后请求 Runtime Integration patch，并更新本地 resolved-model overlay；response snapshot是 Delivery。
- **职责与关键 symbols：** `patch` 在 coordinator中记忆 identity context，检测 active run，调用可选 `transport.patchSessionModel`，以 `readPatchedSessionResolvedModel` 写 overlay，activate并生成/flush snapshot。
- **旧语义与策略：** 以完整 SessionIdentity 串行 `patch-model`。若 `isRunActive(current)` 或 `activeRunId` 为真，激活但不重置窗口，返回 `conflict { code: 'ACTIVE_RUN', snapshot }`，不请求 runtime。runtime不支持 patch返回 bad request。runtime patch 成功后才写本地 model，随后 activation/snapshot/flush并返回 success。transport抛错时没有本地变更或unknown receipt记录；若实际 runtime已变更但response丢失，后续本地模型可未知/陈旧。
- **状态、存储与副作用：** 读 runtime state、写 resolved model到 state store、activate timeline、flush持久 store；网络副作用为 `patchSessionModel`。不修改 sessions.json的 stored provider/model字段。
- **并发与性能特征：** 同 identity queue与 prompt/abort/hydration共享 coordinator，避免这些已使用 queue 的操作同时执行；但 ingress不必经队列。snapshot包含 metadata/storage查找和复制；无重试。
- **调用/依赖边界：** 上游 command patch；下游 registry transport、state/timeline/snapshot。transport当前可实现为 OpenClaw `sessions.patch`，其 runtime protocol细节不属于本 workflow。
- **故障、恢复与安全：** ACTIVE_RUN为明确 conflict；无能力时bad request；transport/flush错误向外传播。model切换是影响执行的高影响动作，未在此鉴权、审计或验证 model provider；runtime reply payload被传入 normalizer，不应不受控地进入日志/Delivery。无 receipt/unknown state是迁移风险。
- **迁移分类：** **Preserve：** active run拒绝、transport capability检测、runtime-first/local overlay、flush后的snapshot。**Intentional Improvement：** model patch command用 outbox/correlation，记录 accepted/unknown/observed，runtime receipt与后续 runtime metadata reconcile决定 applied model；避免调用失败即断言未修改。**待验证：** activeRunId与isRunActive双重检查是否有历史兼容需要。
- **未来 Rust owner：** Session Domain Module拥有“运行中不可切换”和 selected/resolved state；Runtime Integration拥有 sessions.patch adapter；Delivery授权/呈现 conflict。
- **Rust 重写与性能判断：** identity actor串行 patch/run commands；outbox保留 request hash、requested model、receipt状态，adapter只报告transport outcome。指标为 patch到observed-model延迟、unknown比例、active-run冲突率；oracle为 request/outcome/ingress重放差分，不能以外部 exactly-once作为oracle。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts`；补充 active run、unsupported capability、runtime成功但本地crash、timeout/unknown、runtime返回不同规范化model、flush失败。
- **证据：** `SessionModelSelectionWorkflow.patch`；`SessionOperationCoordinator.run`；`SessionRunWorkflow`；OpenClaw transport `patchSessionModel`。

### runtime-host/application/workflows/session-operation/session-operation-result-workflow.ts

- **当前 owner：** Session Domain workflow 的进程内最近 operation-result cache；它是 coordinator辅助投影，不是 durable receipt ledger。
- **职责与关键 symbols：** `latestResults` 按 `buildSessionIdentityKey` 保存一条 `SessionOperationResult`；`rememberResult` 仅当结果含合格 `SessionStateSnapshot` 时覆盖；`readSnapshot` 接受 result、result.snapshot或result.data.snapshot。
- **旧语义与策略：** 每 identity仅保留最后一个带 snapshot 的成功 operation；无 snapshot、primitive、array或不含 sessionKey/runtime/items的对象静默不记录。operation id是 coordinator的内存递增 `<kind>:<sequence>`，重启后归零，不是 runId/idempotency key/外部 runtime receipt。
- **状态、存储与副作用：** 纯内存 Map，无 flush、文件、网络或事件；读取返回原 snapshot引用而非再次 clone。
- **并发与性能特征：** O(1) Map读写；由 JS event loop使用，无上限/TTL/按session删除，identity累积会增长；coordinator在 operation resolve后写入。
- **调用/依赖边界：** 只由 `SessionOperationCoordinator.getLatestResult/run` 依赖；各 Session workflow通过 coordinator间接产生输入。
- **故障、恢复与安全：** 进程重启或内存丢失即丢 cache；不捕获或映射异常；snapshot可能包含用户/工具数据，此处没有 clone/redaction/访问控制，不能跨信任边界返回。不能将其解读为 transport receipt或恢复依据。
- **迁移分类：** **Preserve：** 对现有本进程消费者保留“每 identity最后有 snapshot的结果”辅助能力。**Intentional Improvement：** 不将此 Map迁成核心事实；若产品需要重启恢复/幂等查询，Session Domain应有显式 durable operation journal，而 Platform Core只提供 generic execution/correlation grammar。**待验证：** 是否有生产路径依赖 getLatestResult（CodeGraph主要显示 coordinator/tests）。
- **未来 Rust owner：** Session Domain Module 的短暂 read cache；若变成通用 execution receipt协议，identity/correlation representation归 Matcha Platform Core、存储机制归 Foundation Kernel，但本Session snapshot payload仍归Domain。
- **Rust 重写与性能判断：** 可省略直迁，改为 identity actor内最近 projection或有界LRU；只有经需求证明时才持久 operation journal。指标为cache hit、内存、重启行为；oracle为 coordinator tests且不得把cache hit误当runtime delivery成功。
- **验证 oracle：** `tests/unit/session-operation-coordinator.test.ts`；新增 no-snapshot、response嵌套、identity隔离、重启/eviction（若实现）测试。
- **证据：** `SessionOperationResultWorkflow`；`SessionOperationCoordinator.run`。

### runtime-host/application/workflows/session-run/session-run-workflow.ts

- **当前 owner：** Session Domain workflow拥有本地 prompt submission 事实与失败补偿；Runtime Integration拥有 ensure/event subscription/send translator；Delivery消费立即返回的 prompt snapshot与异步 updates。
- **职责与关键 symbols：** `execute` 记忆 SessionIdentity、`commitSubmittedPrompt`、必要时 `startRuntimeSendInBackground`、立即返回结果。`buildSubmittedPromptEvents` 建 user message + started lifecycle。`sendRuntimePrompt` ensure session、一次性订阅 events、发送带 media的payload；`failSubmittedPrompt` 对仍 active 的同run追加 error lifecycle。
- **旧语义与策略：** `commitSubmittedPrompt` 先在 identity `prompt` queue 激活、append两条 local canonical events、build latest snapshot并 **await flush**；只有 reducer实际接受事件才发runtime。`runId`同时进入 eventId/partId/messageId、lifecycle、payload idempotencyKey和runtime send request；它是运行/提交关联键，不表示外部 receipt。调用者在本地commit完成后立即获得 `success:true`，runtime send以 detached Promise随后执行；所以local canonical commit是本地事实，绝非runtime accepted receipt。runtime send先可选 ensure、再每identity只启动一次session events、再 `sendPrompt`; transport `{success:false}`转 RuntimePromptSendError。任何 background failure只在state的`activeRunId`仍同run时提交 local error并flush/emit；被后续run替换时静默不补偿。
- **状态、存储与副作用：** 写 timeline/state/active window和持久 store；读取 workspace/file system以构建media发送参数；维护进程内 `startedSessionEventIdentityKeys`。外部副作用为 ensure、start session events、send prompt；subscription callback交给 gateway ingress。runtime send result payload不写入store，未建outbox/receipt；media路径/preview可进本地render snapshot。
- **并发与性能特征：** 本地commit、background send、fail compensation均以完整 identity的同一 `prompt` coordinator串行；同Session的这些操作不会重叠，队列在operation失败后仍继续。subscription Set无停止/清理于此文件，lifecycle承担stop hook。每submit构造latest snapshot和flush；background send不背压、没有retry/deadline/cancel owner。不同identity可并行。
- **调用/依赖边界：** 上游 Session prompt service/capability，经 composition注册；下游 coordinator、timeline/snapshot/state、media builder、workspace resolver、registry transport和 ingress callback。精确链：`execute` → `commitSubmittedPrompt` → `appendCanonicalEvents` → reducer/projection/persist → return；detached `sendRuntimePrompt` → `startSessionEvents.consume` → `SessionGatewayIngressWorkflow.consumeEndpointConversationEvent` → adapter/timeline.
- **故障、恢复与安全：** local persist/snapshot错误会拒绝execute且不发送；ensure/send失败产生local error（若仍active），补偿再失败只warn。process在本地flush后、runtime send前/中崩溃时是未发送或未知，当前无持久outbox可恢复；runtime成功但response丢失也不能判定未发送。ingress callback带terminal trace的错误被记录/rejected后吞掉，普通错误warn。输入/附件未在本文件净化，workspace与file paths是安全边界；不记录transport payload/secret是正向限制，但snapshot/日志仍须由上游redaction控制。prompt content可带红色工具触发意图，真正工具权限不应由这里决定。
- **迁移分类：** **Preserve：** local-first可见用户消息、runId/idempotency映射、同identity串行、异步send和“仅active run失败补偿”、一次订阅/ingress接线。**Intentional Improvement：** 用Session actor与durable outbox区分 `locally_committed`、`send_pending`、`receipt_unknown`、`observed`; crash恢复以outbox+ingress correlation进行，明确禁止根据timeout伪造外部 exactly-once。**待验证：** duplicate local event是否足以防止所有重复send；subscription Set在identity删除/重建后的生命周期。
- **未来 Rust owner：** Session Domain Module拥有 submit facts、run state、outbox状态、failure fact；Runtime Integration实现 runtime transport及event translator；Foundation Kernel提供事务写/任务监督/重试原语；Delivery返回accepted/local snapshot和更新。
- **Rust 重写与性能判断：** 同 identity actor原子写local facts+outbox，再由有界sender worker发送。transport response仅转换为 receipt/unknown候选；canonical ingress终态才为observed oracle。消除旧成本是提交路径强制全量snapshot+flush和无持久后台send；保持立即local可见性与failure展示。指标：commit latency、outbox lag、unknown率、重复send率、crash恢复时间、actor queue depth；oracle是事件/投影差分、fault injection和transport mock，不是声称runtime exactly-once。
- **验证 oracle：** `tests/unit/helpers/session-runtime-fixture.ts`、`tests/unit/runtime-host-canonical-timeline-model.test.ts`；补充 commit后崩溃、ensure/send timeout、runtime接受后响应丢失、后续run覆盖、重复runId、media构建失败、terminal ingress被拒。
- **证据：** `SessionRunWorkflow.execute/commitSubmittedPrompt/sendRuntimePrompt/failSubmittedPrompt`；`SessionOperationCoordinator.run`；`SessionTimelineRuntime.appendCanonicalEvents`；`SessionGatewayIngressWorkflow`；OpenClaw transport `sendPrompt`。

### runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow.ts

- **当前 owner：** Session Domain persistence adapter，专门持久化 runtime-host 的 active local session pointer；不是 Session timeline或通用 Kernel store。
- **职责与关键 symbols：** 构造 config-dir 下 `matchaclaw-session-runtime-store.json` 路径；`load` 解析/normalizes version 3的 `activeSessionKey`；`save` ensure directory并pretty JSON写入。
- **旧语义与策略：** 任何 read/JSON parse/shape错误均静默退回 `{version:3, activeSessionKey:null}`；旧/其他version不保留，输出固定version 3；仅非空trimmed string保留。save不做临时文件、atomic rename、lock、checksum或fsync语义。
- **状态、存储与副作用：** 仅文件 I/O，配置目录由 injected port决定；没有内存缓存、network或事件。内容不含 canonical timeline、run state、receipt或secret。
- **并发与性能特征：** 每load全文件JSON parse，每save重写小文件；无同进程或跨进程序列化，last writer wins，适合小元数据但不保证并发安全。
- **调用/依赖边界：** 被 `SessionRuntimeStoreRepository`注入/调用，state store使用其active session pointer；路径/FS由 composition infrastructure提供。
- **故障、恢复与安全：** load故意吞没所有错误，因而无法区分首次启动、丢失、权限、损坏；save错误向上抛。active session key可能暴露session命名但非secret；config dir ACL/路径信任由外层负责。
- **迁移分类：** **Preserve：** 缺失/损坏读为无active session、key trim、明确version。**Intentional Improvement：** 原子写+可区分corrupt/I/O状态，保持对用户启动的安全fallback；若需多进程用Foundation提供的KV/锁原语，Session定义此pointer语义。**待验证：** 吞掉所有load错误是否用于兼容损坏的旧desktop配置。
- **未来 Rust owner：** Session Domain Module拥有 active-session语义；Foundation Kernel可拥有原子文件/KV机制；Delivery不拥有该状态。
- **Rust 重写与性能判断：** 小记录可写atomically到临时文件+rename，附version/schema；不需actor。指标为启动读取成功率、损坏恢复、write failure；oracle为缺文件、坏JSON、空白、save中断后restart的表驱动测试。
- **验证 oracle：** `tests/unit/session-runtime-store-repository.test.ts`；补充权限/partial-write和并发写的恢复测试。
- **证据：** `SessionRuntimeStorePersistenceWorkflow.load/save`；`SessionRuntimeStoreRepository`。

### runtime-host/application/workflows/session-snapshot/session-snapshot-workflow.ts

- **当前 owner：** Session Domain read-model projection；它将 Session canonical/timeline/runtime状态变为 Delivery snapshot，不拥有事实源或 runtime transport。
- **职责与关键 symbols：** `buildEmptySnapshot`；`buildSnapshot`裁剪窗口并clone render/runtime/approval/usage/artifact；`buildSnapshotAsync`补 storage label/context tokens/resolved model；latest/window variants选择窗口；`resolvePrimaryItemFromSnapshot`对应timeline entry到render item。
- **旧语义与策略：** window start/end都clamp到items范围，hasMore/hasNewer/isAtLatest由clamped range得到。若state窗口是latest且start 0则重新按当前item数生成latest；否则保留窗口语义。snapshot默认 `replayComplete=true`，调用方可覆盖；approvals/usage/artifacts/task snapshot深clone，render items和runtime用dedicated clone。async variant优先从state store runtime model和metadata policy解析模型，读取storage label/context token；storage descriptor不存在仍给基础snapshot。
- **状态、存储与副作用：** 自身纯投影；async方法读 storage/metadata/state store但不写。使用 `structuredClone`、slice和render clone避免Delivery修改内存state。
- **并发与性能特征：** build snapshot为O(窗口items + approvals + usage + artifacts)，同时可能对所有usage/artifact clone；async增加storage/metadata I/O。没有缓存，ingress/prompt等高频路径可反复全量snapshot，可能是性能热点但须用benchmark证明。
- **调用/依赖边界：** 被 run、approval、hydration、lifecycle、model selection、ingress和`SessionSnapshotService`调用；依赖 window/state/catalog/context-token/model resolution。它消费timeline投影，不决定canonical event顺序/seq/gap。
- **故障、恢复与安全：** sync projection一般不失败；async storage/metadata错误会向上传播，使相应command/hydrate失败。clone降低共享可变状态泄漏，但不做内容redaction；snapshot是传给Delivery的边界，需要按用户权限/敏感工具输出实行redaction。`replayComplete`是调用方提供的状态，不可由snapshot自行声称历史完整。
- **迁移分类：** **Preserve：** window clamp/flags、clone隔离、model/label/context tokens合并及replayComplete传递。**Intentional Improvement：** 分页/增量read model，避免流式ingress对全量数组重复clone；保留同样window与null/缺storage可观察结果。**待验证：** snapshot中所有usage/artifacts无窗口分页是否是可接受产品契约。
- **未来 Rust owner：** Session Domain Module；Delivery根据snapshot权限投影/序列化；Runtime Integration仅提供metadata/storage adapter。
- **Rust 重写与性能判断：** actor内维护不可变版本/offset索引，snapshot查询复制请求窗口而不是整条history；metadata lookup可按descriptor fingerprint缓存。消除的成本是全量clone和重复I/O；指标：p50/p99 snapshot latency、allocated bytes、render item count、metadata IO；oracle是snapshot JSON/delivery view差分和benchmark `runtime-host-architecture-benchmark.test.ts`。
- **验证 oracle：** `tests/unit/runtime-host-canonical-timeline-model.test.ts`、`tests/unit/helpers/session-runtime-fixture.ts`、`tests/benchmark/runtime-host-architecture-benchmark.test.ts`；补充窗口边界、不可变clone、缺storage、metadata failure、敏感内容redaction的Delivery测试。
- **证据：** `SessionSnapshotWorkflow.buildSnapshot/buildSnapshotAsync/buildWindowSnapshotAsync`；`SessionTimelineRuntime`；各workflow调用点。

### runtime-host/application/workflows/session-storage/session-storage-index-workflow.ts

- **当前 owner：** Session Domain的 runtime-owned session-file layout index/cache adapter；不应抽象为Foundation的通用目录扫描策略，因为 `agents/<agent>/sessions`、key fallback 和 identity解析是Session语义。
- **职责与关键 symbols：** `listStorageDescriptors`扫 agents目录，`findStorageDescriptor`按完整identity索引；每agent cache依 sessions.json/dir fingerprint；`listAgentStorageDescriptors`合并index和未索引transcript；helper解析两种sessions.json形状、路径、fallback key并排除team-role local sessions。
- **旧语义与策略：** agents目录列举失败清空sessionDescriptorIndex并返回[]。只处理directory agent entry。cache仅当 sessions.json `(size,mtimeMs)`和sessions dir `mtimeMs`均相同才命中；读取/JSON失败使indexed descriptors为空但仍scan filenames。array shape按candidate key/sessionKey，object shape支持string或record；已indexed transcript不会重复。仅`.jsonl`而非`.deleted.jsonl`成为fallback，fallback为`agent:<agentId>:<filebase>`，`team-role-session-*`排除。identity resolver拒绝时descriptor丢弃；重复identity后写入index者覆盖前者。
- **状态、存储与副作用：** 两个进程内Map cache/index；读配置目录、目录、stat、sessions.json；无写、无网络。sessions.json可含runtime生成字段，identity resolver才是绑定安全关键。
- **并发与性能特征：** agent逐个串行扫描；每agent多个stat/list/read；缓存避免未变目录解析。完整list O(agent+entries)，find miss重扫所有agents。fingerprint mtime/size可能漏掉罕见同mtime同size替换，目录mtime语义依文件系统。
- **调用/依赖边界：** 由 storage repository workflow、catalog、lifecycle/hydration/snapshot间接使用；依赖 injected `SessionStorageSessionIdentityResolverPort`，不能自行臆测 endpoint identity。
- **故障、恢复与安全：** FS错误大多降级为空/null而不是抛；这将“不可读”与“无session”合并。absolute index path允许存在，但读取/删除的路径控制在其他workflow；本文件不验证其在sessionsDir下。来自文件的 key/agentId没有授权或secret处理；identity resolver必须阻止跨endpoint绑定。未拥有seq/gap或runtime receipt。
- **迁移分类：** **Preserve：** layout兼容、两种sessions.json格式、fallback/排除规则、identity resolver gate、fingerprint cache基本语义。**Intentional Improvement：** 用持久Session index和目录watch/transactional refresh替代扫描；对读取失败与empty区分diagnostic，记录descriptor source/conflict。**待验证：** absolute sessionFile的兼容/安全需求与相同fingerprint替换风险。
- **未来 Rust owner：** Session Domain Module的 storage adapter；Foundation Kernel仅提供FS/watch/cache原语；Runtime Integration可提供runtime-specific layout reader，不能把该文件布局升格为平台协议。
- **Rust 重写与性能判断：** 增量watch按agent更新身份索引，content hash或monotonic generation补充mtime；保留fallback和排除。指标：list I/O/syscalls、cache hit、descriptor错误/冲突、large agent目录延迟；oracle为fixture目录树与变更/删除/损坏index差分。
- **验证 oracle：** `tests/unit/session-catalog-service.test.ts`、`tests/unit/helpers/session-runtime-fixture.ts`；新增数组/object index、missing dirs、invalid JSON、重复/alias identity、deleted/team-role files、absolute paths与cache invalidation测试。
- **证据：** `SessionStorageIndexWorkflow`、`SessionStorageRepositoryWorkflow`、`SessionCatalogWorkflow.scanSessions`。

### runtime-host/application/workflows/session-storage/session-storage-mutation-workflow.ts

- **当前 owner：** Session Domain storage mutation adapter，拥有session index patch和关联artefact删除的精确文件语义；是红色删除动作执行器，不是通用Foundation文件清理器。
- **职责与关键 symbols：** upsert/status/rename 通过 `writeSessionIndex` 修改 index；`delete`删artefacts再删index entry；`removeSessionArtefacts`仅删除base id匹配的本地files；`removeExternalTrajectory`透过可选resolver删除经过筛选的外部trajectory targets。
- **旧语义与策略：** 若无 sessionsJsonPath或sessionsJson，write是无操作却成功返回。index兼容array和object shape：找不到entry时upsert patch会新增；string entry变为含file的record。delete先尝试文件删除，后写index，未做事务。只有 transcript path 的base id可删除；transcript dir必须在sessionsDir内；列目录失败静默不删artefact，但仍会继续写index。删除集合精确匹配`.jsonl`、`.deleted.jsonl`、`.trajectory.jsonl`、pointer、`.jsonl.reset.*`。pointer存在时读取后resolver得到absolute且**不在 transcriptDir内**的target才删除；读取失败静默跳过外部删除。local/external删除使用`Promise.all`，任一个reject可导致index未更新或部分删除。
- **状态、存储与副作用：** 可重写sessions.json，递归影响已列出的文件和经resolver批准的外部绝对路径；无内存state。pretty JSON write非atomic；index cache由repository调用后失效。
- **并发与性能特征：** 同sessions.json无锁/compare-and-swap，多个patch可lost update；delete对targets并行。每delete列整个transcript dir。无backpressure/retry/rollback。
- **调用/依赖边界：** 由 `SessionStorageRepositoryWorkflow`调用，lifecycle再调用repository；依赖 RuntimeFileSystem和可选 `SessionExternalArtefactResolverPort`。external resolver是安全敏感的path policy边界。
- **故障、恢复与安全：** 目录/pointer读取错误故意忽略；write/remove错误大多传播。delete是红色破坏动作：path containment保护本地目录，外部只允许absolute且不得在transcript dir中，但没有如允许根、symlink resolution、TOCTOU、audit/confirmation；resolver输出必须被视为不可信。index先后不原子使重试需按幂等删除/entry removal设计；不得把“file not found”等价为完整成功而不记录。JSON可能含session identity，不应包含secret。
- **迁移分类：** **Preserve：** layout/index兼容、精确artefact命名、local containment和external target筛选、delete-before-index顺序（除非有明确恢复改进）。**Intentional Improvement：** red-action command ledger + tombstone/atomic index transaction，path capability/allow-root与symlink-safe deletion，记录partial/unknown cleanup以供reconcile。**待验证：** external resolver的trust/allowed roots和对部分删除的用户可见语义。
- **未来 Rust owner：** Session Domain Module拥有删除及storage语义；Foundation Kernel仅提供capability-scoped atomic FS primitives；Delivery负责授权、确认、审计；Runtime Integration实现外部trajectory resolver。
- **Rust 重写与性能判断：** identity actor/command ledger先写deleting tombstone，再以bounded cleanup worker处理文件，最终原子移除index；失败保留可重试状态而不伪称成功。避免旧的整目录重复scan可用manifest/index；指标：cleanup latency、partial/unknown count、path policy reject、lost-update率；oracle为fault-injected删除矩阵和无越界文件删除的security测试。
- **验证 oracle：** storage/lifecycle fixtures；新增array/object index、pointer畸形、resolver越界/relative/symlink、list失败、并行delete/rename、remove中断和restart reconcile测试。
- **证据：** `SessionStorageMutationWorkflow.delete/removeSessionArtefacts/removeExternalTrajectory`；`SessionStorageRepositoryWorkflow.deleteSession`；`SessionLifecycleWorkflow.delete`。

### runtime-host/application/workflows/session-storage/session-storage-repository-workflow.ts

- **当前 owner：** Session Domain storage facade，组合index/mutation/transcript sub-workflows为SessionStoragePort；不拥有文件格式具体解析或业务timeline。
- **职责与关键 symbols：** descriptor/fingerprint/read content/read lines是透明委派；upsert/status/rename/delete先找可写descriptor，再mutation，最后invalidate agent cache。`findWritableDescriptor`要求同时有sessionsJson和sessionsJsonPath。
- **旧语义与策略：** 不存在descriptor时read content为null、lines yield nothing、mutation返回false；只读/仅transcript descriptor也不能写。rename先trim，空label返回false。成功的mutation后按descriptor.agentId清cache；mutation抛错则不invalidate。delete returns true仅代表mutation调用完成，不等价于所有外部runtime或file cleanup被强验证。
- **状态、存储与副作用：** 无自己的state；读取/写入由index/transcript/mutation实现。对外将一些“not found/not writable”归并为boolean false。
- **并发与性能特征：** 无锁，findWritable可能触发完整index scan；连续mutation各自重扫/invalidates。async generator流式委派行读取，优于全内容读取但异常被transcript层吞掉。
- **调用/依赖边界：** 上游 lifecycle、catalog、snapshot、timeline transcript loader；下游三个session-storage workflow。是SessionDomain对runtime-owned filesystem layout的port facade。
- **故障、恢复与安全：** false无法区分missing、readonly、identity resolution失败；下游读取容错常变成null/empty，写错误可抛。无auth/redaction/path validation；红色delete安全由mutation/resolver和Delivery授权共同保证。无receipt/transaction日志，文件操作重启后可能unknown/partial。
- **迁移分类：** **Preserve：** SessionStoragePort的null/false/stream contract、writable descriptor gate、rename normalization/cache invalidation。**Intentional Improvement：** typed outcome区分 not-found/read-only/corrupt/I/O/partial cleanup，并让红色mutation持久化command status；保持公共API需要时由Delivery映射兼容错误。**待验证：** callers是否把所有false均当not-found以及cache invalidation时机。
- **未来 Rust owner：** Session Domain Module；Runtime Integration提供具体旧runtime文件layout adapter；Foundation提供generic I/O only。
- **Rust 重写与性能判断：** 保留薄facade，I/O采用流式reader；同identity actor协调mutation/index invalidation。不需要无依据的性能优化；测量descriptor lookup I/O、line streaming内存、typed failure分布，oracle为storage fixture contract和restart fault tests。
- **验证 oracle：** `tests/unit/session-catalog-service.test.ts`、`tests/unit/helpers/session-runtime-fixture.ts`；补充readonly/missing/corrupt/partial delete返回映射与cache失效测试。
- **证据：** `SessionStorageRepositoryWorkflow`；三个sub-workflows；`SessionLifecycleWorkflow`、`SessionCatalogWorkflow`、`SessionSnapshotWorkflow`。

### runtime-host/application/workflows/session-storage/session-storage-transcript-workflow.ts

- **当前 owner：** Session Domain transcript-file read adapter；它提供历史输入的fingerprint、整文和流式行读取，不负责解析/replay、redaction或timeline事实。
- **职责与关键 symbols：** `getTranscriptFingerprint`返回path/size/mtime；`readTranscriptDescriptorContent`读取完整文本；`readTranscriptDescriptorLines`提供AsyncIterable lines。
- **旧语义与策略：** stat失败/非file返回null；无path/不存在/读取异常时content为null、line generator空结束。它预检查`exists`后再读，仍有TOCTOU窗口；不解析JSONL、不跳坏行、不验证identity。整文与逐行读取的错误均故意吞掉。
- **状态、存储与副作用：** 纯FS read，无内存缓存、写入、网络或事件；descriptor选择由repository/index拥有。
- **并发与性能特征：** fingerprint O(1) stat；content将整份transcript驻内存；lines能流式处理，实际backpressure依RuntimeFileSystemPort实现。无缓存/锁，文件写入中可能得到变化中内容。
- **调用/依赖边界：** repository facade委派；catalog用fingerprint/lines解析label，timeline transcript loader用linesreplay，其他调用可用content。它不决定hydration complete。
- **故障、恢复与安全：** 将missing、permission、I/O和mid-stream错误都归为null/empty，调用方因此无法区别并可能显示空历史；对不可信历史内容没有size limit、encoding guard、redaction或path allow-list。读取内容进入snapshot/Delivery之前需由parser/projection策略保护。
- **迁移分类：** **Preserve：** null/empty容错与流式lines contract（若兼容公共表现要求）。**Intentional Improvement：** typed read outcome/diagnostic、最大文件/行限制、fingerprint一致性检查与secure path capability；仍让Session replay policy决定坏行和恢复。**待验证：** 静默I/O失败是否应向用户显示catalog/hydration错误。
- **未来 Rust owner：** Session Domain Module的 transcript port；Foundation Kernel可提供async filesystem/stream primitives；Runtime Integration可适配外部runtime transcript layout。
- **Rust 重写与性能判断：** 优先streaming reader，并在hydrate中记录开始/结束fingerprint来检测文件中途变化；不以读取成功假设replay完整。指标：峰值内存、lines/s、read error/changed-file率；oracle为缺失、权限、截断/并发写与大文件replay测试。
- **验证 oracle：** session catalog/hydration fixtures；补充nonfile、missing、read error、midstream error和large JSONL测试。
- **证据：** `SessionStorageTranscriptWorkflow`；`SessionStorageRepositoryWorkflow`；`SessionCatalogWorkflow.resolveTranscriptCatalogDetails`；`SessionTimelineRuntime.ensureSessionHydrated`。

## 覆盖核对

### 已读文件（16/16）

- `runtime-host/application/workflows/session-approval/session-approval-workflow.ts`
- `runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts`
- `runtime-host/application/workflows/session-command/session-command-operations-workflow.ts`
- `runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts`
- `runtime-host/application/workflows/session-hydration/session-hydration-workflow.ts`
- `runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow.ts`
- `runtime-host/application/workflows/session-metadata/session-model-resolution-workflow.ts`
- `runtime-host/application/workflows/session-model-selection/session-model-selection-workflow.ts`
- `runtime-host/application/workflows/session-operation/session-operation-result-workflow.ts`
- `runtime-host/application/workflows/session-run/session-run-workflow.ts`
- `runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow.ts`
- `runtime-host/application/workflows/session-snapshot/session-snapshot-workflow.ts`
- `runtime-host/application/workflows/session-storage/session-storage-index-workflow.ts`
- `runtime-host/application/workflows/session-storage/session-storage-mutation-workflow.ts`
- `runtime-host/application/workflows/session-storage/session-storage-repository-workflow.ts`
- `runtime-host/application/workflows/session-storage/session-storage-transcript-workflow.ts`

### 未读文件（0）

- 无；与 `00-inventory.md` 的 07 分片路径逐条一致。

### 排除

- `00-inventory.md` 明确分配给其他分片的 runtime-host 源文件，包括被本报告通过 CodeGraph 作为依赖边界追踪的 `application/sessions/**`、`application/agent-runtime/**`、`application/adapters/**`、`composition/**`、API/测试；它们不是本分片逐文件记录对象。
- `runtime-host/build/**`、依赖目录、覆盖率/测试输出、临时目录，以及 `runtime-host/package.json`、`runtime-host/tsconfig.json`，理由与 inventory 的全局明确排除一致。

### 源改动确认

- 本次为独占只读审计；未修改 runtime-host 源码、测试、README、inventory、其他报告、配置或锁文件。唯一写入为本报告：`docs/architecture/runtime-host-ts-rust-migration-audit/07-session-workflows.md`。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **Session workflows 仍为 TypeScript Domain orchestration；Rust cutover 未证实。** status 修改了 `session-{catalog,gateway-ingress,lifecycle,run}-workflow.ts`，它们继续在 TS composition/session-runtime module 的 active chain 中运行。
- **生产 active path：** prompt 由 `SessionRunWorkflow.execute` 在完整 identity coordinator 中提交 canonical user/lifecycle events、snapshot/flush 后 background send；runtime event 由 `SessionGatewayIngressWorkflow` 解析 endpoint identity、委托 protocol adapter 翻译、交给 `SessionTimelineRuntime`；catalog/lifecycle 经各 workflow 维护 storage selector、hydration/read model。此次 session-run 还使用 `buildSendWithMediaGatewayParams` 仅构造 media payload，再经 `AgentRuntimeRegistry.resolveTransport` 投向选择的 endpoint，替代 `send-media.ts` 过去的 direct Gateway send helper。
- **旧 owner impact：** 无旧 Rust owner；旧的 direct Gateway media transport 被删除为避免双 owner，现实 owner 迁为 endpoint-selected RuntimeSessionTransport（仍是 TS adapter/workflow）。OpenClaw Gateway event bridge 与新 Matcha-agent app-server event stream 都作为 runtime ingress source；workflow 并未取得 Runtime 私有协议事实。
- **旧策略与 future owner：** 保持 local canonical commit / later runtime send、完整 SessionIdentity 串行、transport receipt 不等同 observed ingress、catalog/lifecycle 和 hydration 分层。future Rust 可实现 Session Domain workflow/actor/outbox，但须保持 runtime adapters 在 Integration 边界；本次无执行证据可宣称 crash recovery、event replay 或 exactly-once 已闭环。
- **外部 consumer / lifecycle 边界：**renderer Chat/Panes/store与 Electron Host API只提供 command/query/event entry和read projection；不拥有 workflow、canonical commit或runtime send outcome。Electron 当前受管 app-server/Gateway/runtime-host lifecycle为 Rust Local Process Host的外部旧 owner，必须与本 workflow 对 transport readiness、startup/recovery failure mapping的可观察交集一起重走；peer Runtime的 worker/session/store仍不进入 Session Domain。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/session-gateway-ingress-workflow.test.ts tests/unit/session-catalog-service.test.ts tests/unit/session-adapter-service.test.ts tests/unit/runtime-host-canonical-timeline-model.test.ts tests/unit/chat-send-handlers.test.ts tests/unit/chat-input-attachments.test.ts`；`pnpm run typecheck`。本次均**未运行**。
