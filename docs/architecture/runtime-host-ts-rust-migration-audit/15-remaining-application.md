# 15：其余 application（含 matcha-agent adapter）

> 状态：进行中。本分片是旧 `runtime-host` 当前 TypeScript 文件的事实审计；不是当前实现事实的替代，不构成已批准的 Rust 实施计划，也不表示任何迁移或测试已经完成。
>
> 审计方法：先阅读本目录 `README.md` 与 `00-inventory.md`，逐个完整读取本分片列出的 25 个 current files；并以 CodeGraph 探索 `MatchaAgentRuntimeAdapter`、app-server client/event bridge/transport、runtime CLI/stdio MCP/dispatch、diagnostics、tasks 和 workbench 的关键符号与调用关系。下文将代码直接证明的内容称为“事实”，其他结论明确标为“待验证”。

## 覆盖、读取与排除

- **已完整读取（25）：**
  1. `runtime-host/application/adapters/matcha-agent/runtime/index.ts`
  2. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-app-server-client.ts`
  3. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-event-bridge.ts`
  4. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-profile.ts`
  5. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-protocol-adapter.ts`
  6. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-adapter.ts`
  7. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity.ts`
  8. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-session-checkpoint-store.ts`
  9. `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-transport.ts`
  10. `runtime-host/application/runtime-cli/matcha-runtime-command.ts`
  11. `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts`
  12. `runtime-host/application/runtime-cli/runtime-host-dispatch-client.ts`
  13. `runtime-host/application/runtime-cli/system-runtime-mcp-server-command.ts`
  14. `runtime-host/application/subagents/agent-skill-config-contracts.ts`
  15. `runtime-host/application/subagents/agent-skill-config-service.ts`
  16. `runtime-host/application/subagents/agent-tool-config-contracts.ts`
  17. `runtime-host/application/subagents/agent-tool-config-service.ts`
  18. `runtime-host/application/subagents/service.ts`
  19. `runtime-host/application/subagents/subagent-config-contracts.ts`
  20. `runtime-host/application/support/diagnostics-bundle.ts`
  21. `runtime-host/application/support/diagnostics-jobs.ts`
  22. `runtime-host/application/support/diagnostics.ts`
  23. `runtime-host/application/tasks/service.ts`
  24. `runtime-host/application/workbench/bootstrap.ts`
  25. `runtime-host/application/workbench/service.ts`
- **关键调用边界（CodeGraph + 源码事实）：** matcha-agent registration factory 创建 `MatchaAgentRuntimeAdapter`；adapter 缓存 `MatchaAgentRuntimeTransport`；transport 使用 app-server JSON-RPC client 与 event bridge。CLI 与 system MCP 最终均经 `invokeRuntimeCapability` → `/dispatch` → `/api/capabilities/execute`。subagent capability services 经 projection/workflow 进入 OpenClaw。diagnostics service 由 job port 提交后台任务，或调用 bundle collector；task/workbench service 是 workflow/state 的薄门面。
- **未读：** 本分片 25 个 current files 没有未读项。为边界证据额外读取/由 CodeGraph 展开的相邻文件包括 subagent capability routes、OpenClaw config projections、composition module 和既有 `tests/unit/runtime-host-subagent-routes.test.ts`；它们不构成本分片记录。
- **明确排除：** `runtime-host/build/**`（编译产物）；`node_modules/**`、覆盖率、测试输出、临时目录（非本仓库 runtime-host 生产 source）；`runtime-host/package.json`、`runtime-host/tsconfig.json`（构建配置）。其余 production `.ts` 由 inventory 指定的其他分片负责，未静默归入本报告。

### runtime-host/application/adapters/matcha-agent/runtime/index.ts

- **当前 owner：** matcha-agent Runtime Integration 的装配入口；不拥有 runtime session、网络连接或持久状态。
- **职责与关键 symbols：** 重导出 app-server、event、profile、protocol、transport、identity、checkpoint 适配件；`createMatchaAgentRuntimeAdapterRegistrationFactory(options)` 返回只在 `create()` 时构造一个 `MatchaAgentRuntimeAdapter` 的注册工厂。
- **旧语义与策略：** factory 捕获 options，重复调用 `create()` 会创建新的 adapter 实例；没有注册时的 endpoint 判定逻辑在 adapter 内而非本文件。
- **状态、存储与副作用：** 文件自身无 I/O、可变状态或副作用；构造 adapter 的副作用仍受 endpoint 环境变量和后续 transport 创建控制。
- **并发与性能特征：** 常数时间的闭包/对象创建；不缓存 adapter，不建立连接。
- **调用/依赖边界：** 上游是 agent-runtime registry 的 `RuntimeAdapterRegistrationFactory` 消费者；下游为 `MatchaAgentRuntimeAdapter`。CodeGraph 确认该 factory 与 adapter/index 的装配关系。
- **故障、恢复与安全：** 本文件不捕获错误、不持有 token；endpoint 关闭时 adapter 以空 endpoints/capabilities 表示，不在此处恢复。
- **迁移分类：** **Preserve：** 延迟实例化、单 factory 返回单 adapter 数组的 registration 契约。**Intentional Improvement：** 无代码证据。**Defect：** 无证据。**待验证：** factory 是否会被多个 composition root 重复注册，当前未在本文件闭环。
- **未来 Rust owner：** **Runtime Integration**；composition registry 仅装配实现，不应取得 Matcha 产品状态。
- **Rust 重写与性能判断：** 旧成本是一次闭包/adapter 分配；不变量是 registration identity 与延迟构造；指标为注册次数和启动期分配；oracle 是 factory fixture 断言每次 create 的 adapter id、endpoint 可用性与 options 注入。没有证据支持把它当作性能热点。
- **验证 oracle：** adapter registration 与 disabled/enabled endpoint 的集成 fixture；现有证据为本文件和 `matcha-agent-runtime-adapter.ts`。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/index.ts`；CodeGraph 对 `MatchaAgentRuntimeAdapter` 的 callers/instantiates 结果。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-app-server-client.ts

- **当前 owner：** matcha-agent app-server 的 WebSocket/HTTP **Runtime Integration** client；拥有单 endpoint 的 socket、JSON-RPC request correlation、event listener 集合和连接中的 promise。
- **职责与关键 symbols：** `inspectHealth()` GET `/health`；`initialize()` 发固定 protocol/clientName；`request()` 以递增 id 发 newline-delimited JSON-RPC；`onEvent()` 订阅 notification；`close()` 关闭连接并拒绝 pending。`connect()`、`handleMessage()`、`parseJsonRpcWireMessage()` 是连接/协议边界。
- **旧语义与策略：** URL 从 endpoint 派生 `/health` 与 `/ws`，HTTPS 映射 WSS；token 仅作为 WebSocket `Authorization: Bearer` header。请求默认 30 秒，timeout/send failure/JSON-RPC error/close 各自拒绝对应 promise；不可解析/非 JSON-RPC 行静默忽略；仅无 id 且 method 为 `event` 的 notification 交给 listeners。
- **状态、存储与副作用：** 内存 `socket`、递增 request id、`pendingRequests`、listener set、`connectPromise`；网络 fetch/WebSocket、timer 与 socket close 是外部副作用；不落盘 token 或结果。
- **并发与性能特征：** `connectPromise` 合并并发连接；`Map` 按 id 关联可并行在途 request。每条 websocket data 转 UTF-8、trim、split newline、JSON parse；pending 数量和 listener 数未在本文件设上界。
- **调用/依赖边界：** `MatchaAgentRuntimeTransport` 构造并调用 client；event bridge 通过 `onEvent/request('events.subscribe')` 使用它；底层依赖 `ws` 和全局 `fetch`。
- **故障、恢复与安全：** close 会清理所有 timer 并拒绝 pending，初始 error 清空 socket；不会自动重连或重发。URL/token 由环境读入 adapter，本类不记录日志或 redaction，错误字符串可能来自远端；远端错误 `data` 被丢弃。认证 header 不进入返回 payload，但日志路径是否暴露 URL/token 待验证。
- **迁移分类：** **Preserve：** 单连接合并、request id correlation、30 秒默认、close/reject cleanup、HTTP/WSS URL 规则与 event-only notification 分派。**Intentional Improvement：** 无证据。**Defect：** 无充分证据。**待验证：** 无界 pending/listeners、半开连接检测、重连与服务端多 JSON 行 framing 的产品期望。
- **未来 Rust owner：** **Runtime Integration**；通用任务 deadline/cancellation 原语可复用 **Foundation Kernel**，但 app-server wire protocol 不进入 Core。
- **Rust 重写与性能判断：** 旧成本为逐帧 UTF-8/string split/JSON parse、每 request 一个 timer，且无 pending 上限；不变量是 request/response 一一相关、关闭时所有 request 完结、事件不与 response 混淆；指标为在途数、p95 request latency、断线清理时间、内存和 parse CPU；oracle 为 mock WebSocket 的并发 request、timeout、send-error、close、畸形行和 token-header fixture。
- **验证 oracle：** 需补 app-server protocol mock 与断线 fault injection；CodeGraph 显示该 client 没有直接覆盖测试，当前证据为源码和 transport/event bridge callers。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-app-server-client.ts`；`matcha-agent-transport.ts`；`matcha-agent-event-bridge.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-event-bridge.ts

- **当前 owner：** matcha-agent 实时/回放事件接收、按 session 序列去重排序与 checkpoint 推进的 **Runtime Integration** owner。
- **职责与关键 symbols：** `start()` 先读 checkpoint、注册 live listener、调用 `events.subscribe(afterSeq)`、消费 replay 再消费启动窗口缓冲的 live events；`consumeEnvelope()` 过滤 session、处理无 seq 事件或维护 `lastContiguousSeq/pendingBySeq`；`stop()` 解除订阅。terminal delivery trace 由 `attachTerminalTrace/emitTrace` 投影。
- **旧语义与策略：** 正整数 seq 才参与顺序控制；已 checkpoint 或 pending 的 seq 去重；缺洞事件缓存在 `Map`，直到下一连续 seq 到达。回放订阅期间 live event 先进入数组，避免 replay 与 live 交错。consumer 对无 seq 的异常会向上抛；有 seq 的 consumer 异常会记录 trace、仍写入下一个 checkpoint，刻意防止一个 malformed ingress 阻塞后续事件。
- **状态、存储与副作用：** 一个 bridge 只有一个 unsubscribe、全局 serial `consumeTail`、每 session 内存 checkpoint/pending map、checkpoint store read/write；client subscription 与 trace callback 为外部副作用。checkpoint store 的本实现仅内存，重启丢失。
- **并发与性能特征：** live `enqueueEnvelope` 用单 promise tail 串行所有 session 的消费，保证顺序但慢 consumer 会形成无背压队列；gap `pendingBySeq` 与启动期 `bufferedLiveEvents` 未设上限。每个连续 event 都 await checkpoint write。
- **调用/依赖边界：** 由 `MatchaAgentRuntimeTransport.startSessionEvents()` 每 session 创建；向 `RuntimeStartSessionEventsRequest.consume` 交付正规化事件，使用 app-server client 和 checkpoint port。
- **故障、恢复与安全：** start 中订阅/replay failure 由 transport 清理 bridge；live consumer failure 被 `enqueueEnvelope` 吞掉，且有 seq event 会前移 checkpoint，构成 at-most-once 后续推进而非可重试交付。只处理匹配 session id，trace 仅 terminal event；checkpoint 数据不含 token。gap 永不补齐时的内存/恢复没有本地机制。
- **迁移分类：** **Preserve：** `afterSeq` replay、live buffering、严格连续 seq、重复压制、consumer 成功或失败后推进有 seq checkpoint，以及 terminal trace correlation。**Intentional Improvement：** 无已证实项。**Defect：** 无证据可把“消费失败仍推进”定为缺陷，源码明确写出避免停滞的取舍。**待验证：** 该 at-most-once 取舍是否为产品最终语义；长期缺 seq 的治理、cross-session head-of-line blocking 和 durable checkpoint 的需求。
- **未来 Rust owner：** **Runtime Integration** 负责 app-server event protocol；cursor/checkpoint 原语与有界背压应归 **Foundation Kernel**；canonical session 业务解释不应留在 bridge。
- **Rust 重写与性能判断：** 旧成本是全 session 单串行 tail、无界 gap/live buffer、每事件异步 checkpoint；不变量是同 session 只交付连续且未 checkpoint 的 seq、subscription window 不丢 live event、失败推进语义不变（除非正式批准替换）；指标为 gap-buffer 大小、队列延迟、checkpoint 写入延迟、事件丢失/重复率和重连恢复时间；oracle 为 replay/live race、乱序/重复/gap、consumer throw、checkpoint write fault 和多 session 压力 trace。
- **验证 oracle：** 需补上述 deterministic event harness；当前证据为 `matcha-agent-event-bridge.ts`、`matcha-agent-transport.ts` 与 shared terminal trace contract。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-event-bridge.ts`；`matcha-agent-transport.ts`；`runtime-host/shared/matcha-terminal-delivery-trace.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-profile.ts

- **当前 owner：** 静态 Matcha runtime endpoint capability profile；不拥有运行时功能实现。
- **职责与关键 symbols：** `matchaAgentRuntimeEndpointProfile` 固定 endpoint/protocol/instance id、显示名、默认及允许 agent `matcha`、dynamic agents、chat/streaming/tools/approvals/replay/modelSelection capability、storage/keying namespace 与 external session 能力声明。
- **旧语义与策略：** endpoint 永远声明 `acceptsDynamicAgents: true`，但 profile 初始 agent 列表只有 `matcha`；adapter 仅在环境启用时暴露 profile。capability 为诚实声明的输入，但本文件不对 app-server 探测或降级。
- **状态、存储与副作用：** 纯静态对象，无 I/O、状态或副作用。
- **并发与性能特征：** 零运行时算法成本（模块加载时一次对象）；无并发控制。
- **调用/依赖边界：** runtime adapter 将 profile 放入 endpoints，并以它生成 capability descriptors；identity constants 是唯一内部依赖。
- **故障、恢复与安全：** 无错误/恢复路径；若声明与真实 app-server 不一致，调用方可能错误路由，当前不自检。无 secret。
- **迁移分类：** **Preserve：** endpoint/instance/protocol identity、namespace 和当前 capability/external-session 声明。**Intentional Improvement：** 无证据。**Defect：** 无证据。**待验证：** 动态 agents、全部 six capabilities 与 external session features 是否都由每个 app-server 版本实际支持。
- **未来 Rust owner：** endpoint identity/capability grammar 为 **Matcha Platform Core**；matcha-agent 对能力的具体诚实声明为 **Runtime Integration**。
- **Rust 重写与性能判断：** 旧成本为零；不变量是 descriptor 字段与 adapter 生成的 descriptors 一致；指标是 capability discovery 正确率而非延迟；oracle 为 profile 与 app-server `initialize` capabilities 的 contract fixture/negative capability fixture。
- **验证 oracle：** 需补 handshake capability comparison；当前证据为 profile、runtime adapter 和 runtime endpoint contracts。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-profile.ts`；`matcha-agent-runtime-adapter.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-protocol-adapter.ts

- **当前 owner：** 将 matcha-agent app-server live events 与 transcript replay 投影为 canonical session events 的 **Runtime Integration**；本类拥有翻译期间的文本/tool metadata 内存。
- **职责与关键 symbols：** `MatchaAgentProtocolAdapter` 提供 protocol id、event/replay adapter 和 session-scoped message id policy。`translateAppServerEventEnvelope()` 分派 run/message/sdk/tool/approval/usage 事件；`createToolEvent()` 记忆工具 metadata；SDK text accumulator 与 tool block index 保证 streaming projection；replay adapter 调 canonical transcript parser/replay。
- **旧语义与策略：** 只接受形状完整的 app-server envelope；未知 event 无输出。run terminal 清除按 `(sessionId, runId)` 的 translation state。SDK text delta 输出 accumulated **snapshot**，assistant completion 输出 final；tool input JSON delta 只在可解析 object 时与已有 input shallow merge。approval options 映射为 allow-once/allow-always/deny，缺选项时默认 allow-once+deny。canonical `eventId` 基于 runtime event id+part，source 为 live/replay，raw origin 使用 `structuredClone`。
- **状态、存储与副作用：** `MatchaAgentRuntimeEventAdapter` 有三个内存 Map（text、tool metadata、tool block index）；无文件/网络写入。翻译输出的 raw payload 可被 session canonical 层存储；本文件本身不持久化。
- **并发与性能特征：** 按每条 event 同步翻译；SDK delta 每次 `readAccumulatedSdkMessageText()` 扫描全部 accumulator entries、filter/sort/join，且 terminal cleanup 扫描 maps，长 run/多块内容可能超线性。`structuredClone` 复制完整 envelope；未对未终止 run 的 map 设置容量或 TTL。
- **调用/依赖边界：** adapter 由 `MatchaAgentRuntimeAdapter.protocol` 持有；transport/event bridge 向上游交 event；下游是 canonical session reducer/replay parser，依赖 agent-runtime identity contracts 与 session approval contract。
- **故障、恢复与安全：** schema 不合/缺关键 id 时事件被丢弃而非抛错；JSON input delta parse failure 保留已知 input。run terminal 清理内存；未见连接中断或永远没有 terminal 的清理。raw origin/工具 input/output 可能含敏感内容，本文件无 redaction，存储/展示安全需由下游负责且待验证。
- **迁移分类：** **Preserve：** event type 映射、identity/seq/origin 字段、SDK snapshot/final 语义、tool metadata 合并、approval 决策映射、terminal state cleanup 和 unknown-event 忽略。**Intentional Improvement：** 无已证实项。**Defect：** 无充分证据。**待验证：** `Date.parse(...) || Date.now()` 对无效时间的可观察性、raw origin 的持久化/redaction policy，以及未终结 run 的 state 回收。
- **未来 Rust owner：** **Runtime Integration**；canonical transcript/state 属 **Domain Module（Session）**，跨-runtime identity grammar 属 **Matcha Platform Core**。
- **Rust 重写与性能判断：** 旧成本是 delta 时全 map filter/sort/join、terminal 全 map scan 和 raw structuredClone；不变量是每 message/block 的 snapshot text 顺序、tool input/owner binding、event id 与 terminal cleanup；指标为长流的 per-event CPU/allocations、peak state、canonical event differential；oracle 为 app-server event corpus golden diff（streaming、tool JSON、approval、malformed、terminal）和 run-leak soak test。
- **验证 oracle：** 需补 differential corpus 与 state bound benchmark；CodeGraph 未发现本 adapter 的直接测试，源码与 canonical contracts是当前证据。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-protocol-adapter.ts`；`runtime-host/application/sessions/canonical/canonical-transcript-replay.ts`；`runtime-host/application/sessions/transcript-parser.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-adapter.ts

- **当前 owner：** matcha-agent endpoint 可用性、adapter identity、transport cache 与 runtime capability descriptor 的 **Runtime Integration** owner。
- **职责与关键 symbols：** `MatchaAgentRuntimeAdapter` 实现 `RuntimeAdapter`；构造时读取 endpoint、选择 endpoints/capabilities；`createTransport()` 以 endpoint URL 缓存 `MatchaAgentRuntimeTransport`；`readMatchaAgentAppServerEndpoint()` 只在 enabled flag 为 `1` 且 URL 非空时返回 endpoint；`buildMatchaAgentRuntimeCapabilities()` 为 endpoint 和每 agent 生成 native descriptor。
- **旧语义与策略：** 未启用/无 URL 时适配器仍存在但暴露空 endpoint/capability，调用 createTransport 会抛。token 不 trim，原值进入 client。当前固定 local endpoint，但 cache key 仅 URL，故同 URL 的 token 变化不会创建新 transport（该 adapter 实例环境通常不可变）。
- **状态、存储与副作用：** 构造时读环境；内存 endpoint、client factory、endpoint URL→transport map 和内存 checkpoint store。构造不连网；首次 createTransport 才创建 client/transport，连接更晚发生。
- **并发与性能特征：** Map 确保同 adapter、同 URL 复用一个 transport/client；没有销毁/eviction。同步构造和 descriptor flatMap 成本小；多实例会各自有连接/cache。
- **调用/依赖边界：** index registration factory 上游；下游是 runtime registry、agent-runtime contracts、gateway runtime ports 和 transport；profile/identity/protocol 都被组合。
- **故障、恢复与安全：** endpoint missing 提供明确错误，network failure 留给 transport/client。token 不出现在 descriptor，但 URL/token 环境来源的进程安全、transport close 生命周期没有该类 owner。
- **迁移分类：** **Preserve：** enabled gating、无 endpoint 时空 discovery、native endpoint/capability scope、同 URL transport reuse。**Intentional Improvement：** 无证据。**Defect：** 无充分证据。**待验证：** cache lifetime、token rotation、多个 endpoint/instance 与 adapter shutdown 的最终需求。
- **未来 Rust owner：** **Runtime Integration**；descriptor grammar/endpoint binding 的共享部分是 **Matcha Platform Core**。
- **Rust 重写与性能判断：** 旧成本为一次 environment parse 与无界 lifetime Map；不变量是 disabled 不宣称 endpoint、同配置 reuse、capability scope；指标为启动 discovery、transport count、connection reuse、shutdown leak；oracle 是 env matrix（disabled/missing URL/token）、descriptor golden 和 repeated createTransport identity test。
- **验证 oracle：** 需补 adapter lifecycle/mock client test；CodeGraph 显示该 adapter 无直接覆盖测试。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-adapter.ts`；`index.ts`；`matcha-agent-profile.ts`；`matcha-agent-transport.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity.ts

- **当前 owner：** 静态 runtime adapter/endpoint/protocol/instance identity 常量；pure helper owner。
- **职责与关键 symbols：** `MATCHA_AGENT_RUNTIME_ADAPTER_ID='matcha-agent'`、endpoint `matcha-agent-local`、protocol `matcha-agent-app-server`、instance `local`。
- **旧语义与策略：** 四个字符串是 profile、protocol adapter、runtime adapter 和 capability address 的共同 key；无派生或验证。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 模块常量，零可观察 I/O/算法成本。
- **调用/依赖边界：** 被 profile、protocol、runtime adapter 与 index re-export；最终进入 runtime endpoint address/capability registry。
- **故障、恢复与安全：** 无运行时错误或 secret；改值会导致 session/capability routing identity 不兼容。
- **迁移分类：** **Preserve：** 所有字符串及其跨模块一致性。**Intentional Improvement：** 无。**Defect：** 无。**待验证：** 是否需要 versioned/multi-instance identity，当前没有证据。
- **未来 Rust owner：** **Matcha Platform Core**（identity/binding grammar）；matcha-agent 值的注册由 **Runtime Integration** 提供。
- **Rust 重写与性能判断：** 旧成本为零；不变量是 wire/storage address strings；指标是 identity resolution compatibility；oracle 是 endpoint/capability/session fixture 反序列化与 routing golden tests。
- **验证 oracle：** 共享 identity fixture；当前证据为所有同目录 consumers。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity.ts`；profile、protocol adapter、runtime adapter。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-session-checkpoint-store.ts

- **当前 owner：** app-server event replay cursor port 与默认 in-memory 实现；当前实现拥有每 session last seq 内存状态。
- **职责与关键 symbols：** `MatchaAgentSessionCheckpointStore` 定义 async read/write；`InMemoryMatchaAgentSessionCheckpointStore` 用 `Map<string, number>`，写入仅在新 seq 大于已有值时更新。
- **旧语义与策略：** 未知 session 返回 `null`；写入相等/倒退 seq 是 no-op，形成单调 checkpoint。async 签名不等于 durable 或并发原子；默认 adapter 只使用这个内存实现。
- **状态、存储与副作用：** 内存 Map，无文件、网络、事件或 cleanup；进程/adapter 重建后全失。
- **并发与性能特征：** O(1) Map，单 Node event-loop 下 read/write 同步完成的 async wrapper；无容量/TTL/锁。
- **调用/依赖边界：** runtime adapter 建一个 store 并交给 transport；event bridge read/write cursor；接口允许以后注入不同实现，但当前 transport 构造参数具体标为 InMemory class。
- **故障、恢复与安全：** 无 error/retry/durability，重启只能依赖远端订阅无 afterSeq 从头/服务端语义；session id 未校验且无 secret。
- **迁移分类：** **Preserve：** null 初始值与单调不回退写入。**Intentional Improvement：** 无证据。**Defect：** 不可将 in-memory checkpoint 直接断定为缺陷，是否要求跨重启去重待验证。**待验证：** durable checkpoint、retention、并发 multi-process 和 session deletion 清理要求。
- **未来 Rust owner：** 通用 cursor/append/checkpoint 机制为 **Foundation Kernel**；matcha-agent session key 的选择为 **Runtime Integration**。
- **Rust 重写与性能判断：** 旧成本为无界内存 Map、重启丢 cursor；不变量是 per-session 单调性与 `null` 未见语义；指标为 cursor read/write latency、memory cardinality、restart duplicate replay count；oracle 是 monotonic write fixture、restart/replay integration fixture 与 bounded-retention soak test。
- **验证 oracle：** 需补 durable/restart tests；当前证据为 checkpoint store 和 event bridge。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-session-checkpoint-store.ts`；`matcha-agent-event-bridge.ts`；`matcha-agent-runtime-adapter.ts`。

### runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-transport.ts

- **当前 owner：** `RuntimeSessionTransport` 的 matcha-agent protocol implementation；拥有 ensured session set 和 per-session event bridge registry。
- **职责与关键 symbols：** `ensureSession()` load→not-found create→duplicate load；events start/stop；外部 session list/transcript；prompt/cancel/approval/model RPC；`inspectReadiness()` health+initialize。helper 正规化外部 session、event envelope、approval decision 和以错误消息判定 session 状态。
- **旧语义与策略：** ensure 的成功 session 每次仍 `session.load`；仅错误文本以 `Session not found:` 开头才 create，create 的 `Session already exists` 再 load。start events 已有 bridge 就 no-op；start failure 删除 registry 并 stop。sendPrompt/readiness 把 error 转结果，cancel/approval/model/list/transcript rejection 则传播。外部 list 仅 `hasConversation===true`，未知 worker state 归 completed；approval allow/deny 映射固定 option id。
- **状态、存储与副作用：** sets/maps、client RPC、event subscription/checkpoint；没有 persistent session catalog。`stopSessionEvents` 只 unsubscribe/删除 bridge，不 close app-server client 或清 ensured ids。
- **并发与性能特征：** `ensuredSessionIds` 和 bridge map 没有 per-session in-flight promise；并发 ensure/start 可能发重复 load/create 或竞态构造（JavaScript 在 await 前的 map set 降低 start 竞态，但 ensure 在 await 前未占位）。list 全量读取/filter/map；每次 readiness 至少 HTTP health+WebSocket initialize。
- **调用/依赖边界：** runtime adapter 缓存并返回该 transport；下游 `MatchaAgentAppServerClient`、event bridge；上游 session agent-runtime contract 和 gateway indirect consumption。
- **故障、恢复与安全：** create duplicate 有明确恢复；event start failure cleanup；依赖字符串匹配远端错误，协议错误文本变化会改变行为。prompt 错误仅返回字符串，不携带 structured code；endpoint session id 被直接传给远端。没有对 transport shutdown/cache eviction 的实现。
- **迁移分类：** **Preserve：** load/create/duplicate-load recover sequence、每 session一 bridge、event start cleanup、external-session filtering/status mapping、approval option mapping、prompt/readiness response mapping。**Intentional Improvement：** 无证据。**Defect：** 无充分证据。**待验证：** error string 的稳定契约、并发 ensure、session cleanup、app-server restart 后 ensured set 是否失效。
- **未来 Rust owner：** **Runtime Integration**；session fact/reducer归 **Domain Module（Session）**，generic cancellation/deadline可由 **Foundation Kernel** 提供。
- **Rust 重写与性能判断：** 旧成本为 readiness 两次远程交互、全量 list、无 per-key ensure coalescing；不变量是 create only after exact not-found、duplicate create 重新 load、event bridge singleton；指标为 session startup RPC count、concurrent ensure duplicate rate、list p95/allocations、restart recovery time；oracle 是 mock app-server state machine（not-found/duplicate/error text）、concurrent calls、start failure and stop/restart trace。
- **验证 oracle：** 需补 app-server mock integration；当前证据为 transport、event bridge/client 和 agent-runtime contracts。
- **证据：** `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-transport.ts`；event bridge/client/checkpoint store。

### runtime-host/application/runtime-cli/matcha-runtime-command.ts

- **当前 owner：** 面向用户的 `matcha runtime invoke` CLI **Delivery** parser、output formatter 与 exit-code owner；不拥有 capability business logic。
- **职责与关键 symbols：** `parseMatchaRuntimeCommand()`、`runMatchaRuntimeCommand()`、`parseRuntimeInvokeOptions()`、`buildRuntimeInvokeCommand()`；解析 id/operation/scope/target/input/url/timeout/`--json`，调用 dispatch client，输出 success/failure/help。
- **旧语义与策略：** 空或 help 返回 0；语法/JSON/scope/target/timeout错误返回 2；已解析但 dispatch/application failure 返回 1。每 option 至多一次、所有必填；scope/target 先 JSON parse 再使用 address validators，target 允许 `null`。text success 仍将原 data JSON line 写 stdout；`--json` 包 `{success,data}` 或 `{success:false,error}`。可选可执行前缀仅精确 `matcha`。
- **状态、存储与副作用：** 无内部状态或存储；唯一副作用是 stdout/stderr write 和 HTTP dispatch（可注入 fetch）。
- **并发与性能特征：** 单 argv 线性扫描、一次 JSON parse/字段、一次 remote dispatch；无 retry/queue/cache。
- **调用/依赖边界：** main CLI 上游；`runtime-address` 校验和 `runtime-host-dispatch-client` 下游，后者进入 runtime-host dispatch/capability route。
- **故障、恢复与安全：** 不记录 input；错误输出可能含远端 message。parser 拒绝重复/未知/missing option，但没有对 input schema 授权，交 capability 层。timeout/cancel由 dispatch client；无本地恢复。
- **迁移分类：** **Preserve：** 命令语法、required argument、scope/target validators、exit-code 三分、JSON/text envelope、timeout parse规则。**Intentional Improvement：** 无证据。**Defect：** 无证据。**待验证：** text mode实际是否应仅输出 human text 而不是 JSON，以及 CLI compatibility surface 是否已有外部依赖。
- **未来 Rust owner：** **Delivery**；endpoint/scope grammar本身为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** 旧成本为 argv scan/JSON parse加一次 HTTP；不变量是 exit code、stdout/stderr分流和 payload形状；指标为 parse allocation、dispatch latency、错误分类一致率；oracle 是 table-driven argv→result/output golden 和 mock dispatch timeout/network/application fixtures。
- **验证 oracle：** 需补 CLI black-box fixtures；当前证据为该 command 和 dispatch client。
- **证据：** `runtime-host/application/runtime-cli/matcha-runtime-command.ts`；`runtime-host/application/runtime-cli/runtime-host-dispatch-client.ts`。

### runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts

- **当前 owner：** stdin/stdout JSON-RPC framing server 的 **Delivery** transport helper；拥有输入 buffer 和顺序请求 drain，不拥有 MCP 工具语义。
- **职责与关键 symbols：** `runJsonRpcStdioServer()`；Content-Length 与 JSON Lines 双 framing；`readJsonRpcRequest()`；`jsonRpcResult/error()`；`writeJsonRpcMessage()`。默认 header 8 KiB、body 1 MB、buffer 约 1.008 MB。
- **旧语义与策略：** 首个非空白 byte 是 `{` 即采用 JSON Lines，否则等待 Content-Length header。stdin data 被串行接到 `pending` promise，handler result 非 `undefined` 才写 response；notification id `undefined` 时 jsonRpcResult/error 返回 undefined。畸形 JSON/request 返回 -32700/-32600；输入超过限制会发 error、清空 buffer，继续接收。
- **状态、存储与副作用：** 本次 server invocation 有 Buffer 和 promise tail；读 stdin、写 stdout，结束后 resolve；不落盘。
- **并发与性能特征：** `Buffer.concat` 每 data chunk 重复制累计 buffer，长分片输入可二次方复制；`pending` 故意串行化所有 handler，慢请求阻塞后续请求/notification。大小限制防止无界 buffer，但 handler queue 无上限。
- **调用/依赖边界：** system-runtime MCP server 使用它；对 handler 暴露已验证基础 JSON-RPC request；依赖 Node streams。
- **故障、恢复与安全：** stdin error/rejected handler 使 server promise reject；`pending.catch(reject)` 可能在之后继续接收 data，未主动解绑 listener。大小、header/body合法性防止部分资源耗尽；无 authentication（stdio process boundary承担）。不支持 batch request。
- **迁移分类：** **Preserve：** dual framing auto-detect、限制阈值、JSON-RPC error codes、notification无 response、请求串行顺序。**Intentional Improvement：** 无证据。**Defect：** 无充分证据，尽管 byte-concat/串行队列的容量取舍待验证。**待验证：** MCP client 是否需要 batch、是否必须允许并发 handler、handler rejection 后 transport lifecycle。
- **未来 Rust owner：** **Delivery**；通用 bounded I/O/backpressure primitives可采用 **Foundation Kernel**，但 MCP CLI server 不应拥有业务状态。
- **Rust 重写与性能判断：** 旧成本为反复 Buffer.concat 和无界 handler queue；不变量是字节精确 framing、响应顺序、limits与错误码；指标为 fragmented-input copy bytes、queue depth、p95 handler completion、max RSS；oracle 是 split-boundary/fuzz corpus、over-limit cases、notification/no-output、handler throw 和 slow-handler backpressure tests。
- **验证 oracle：** 需补 framing fuzz/integration；当前证据为 `mcp-stdio-json-rpc.ts` 和 system MCP consumer。
- **证据：** `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts`；`system-runtime-mcp-server-command.ts`。

### runtime-host/application/runtime-cli/runtime-host-dispatch-client.ts

- **当前 owner：** runtime-host HTTP dispatch **Delivery** client；拥有 URL/timeout默认、wire envelope、response error classification。
- **职责与关键 symbols：** `resolveRuntimeHostBaseUrl()`、`parse/resolveRuntimeHostTimeoutMs()`、`dispatchRuntimeHostRoute()`、`invokeRuntimeCapability()`、`RuntimeHostDispatchClientError`、`formatRuntimeHostDispatchError()`。
- **旧语义与策略：** precedence 是 explicit URL→`MATCHACLAW_RUNTIME_HOST_BASE_URL`→port env→127.0.0.1 default；URL 去尾 slash。每 dispatch 永远 POST `/dispatch`，payload 传 transport version、目标 method/route/payload。HTTP 非 OK或 envelope `success!==true`为 `dispatchFailure`；响应不是 JSON为 `invalidResponse`；Abort 为 `timeout`，其余 fetch error为 `network`；capability data `success===false`另为 `applicationFailure`。
- **状态、存储与副作用：** 每请求创建 AbortController/timer（`unref`）并 HTTP POST；finally 清 timer；无 cache/retry/持久化。
- **并发与性能特征：** 各请求独立并行；完整 JSON stringify/body json parse；没有连接池控制（依赖 fetch runtime）。超时只取消本地 fetch，不证明服务端取消。
- **调用/依赖边界：** CLI command 与 system MCP 上游；runtime-host parent transport `/dispatch` 下游；依赖 shared default port/transport version 和 agent-runtime scope types。
- **故障、恢复与安全：** Error 保留 cause/status/code，便于 CLI映射；没有重试/idempotency以避免把写操作自动重放。URL来自 env/argv，调用方负责部署信任；request body可能含敏感 tool input，本类不 redaction/logging。
- **迁移分类：** **Preserve：** URL/timeout precedence、dispatch envelope、五类错误和 capability `success:false` 分离、finally cleanup、无自动重试。**Intentional Improvement：** 无证据。**Defect：** 无证据。**待验证：** remote URL/HTTPS policy、服务器端 cancellation coupling 和 non-JSON error body diagnostics。
- **未来 Rust owner：** **Delivery**；transport deadline/cancellation substrate可归 **Foundation Kernel**。
- **Rust 重写与性能判断：** 旧成本是每请求 JSON encode/decode与 timer；不变量是 exact route/envelope、timeout分类、非幂等操作不自动重试；指标为 dispatch p50/p95、timeout cleanup、error-class differential、serialized payload bytes；oracle 是 injected fetch matrix（status/envelope/non-JSON/abort/network）和 captured HTTP request golden。
- **验证 oracle：** 需补 injected-fetch unit fixtures；当前证据为 dispatch client及两个 CLI callers。
- **证据：** `runtime-host/application/runtime-cli/runtime-host-dispatch-client.ts`；`matcha-runtime-command.ts`；`system-runtime-mcp-server-command.ts`。

### runtime-host/application/runtime-cli/system-runtime-mcp-server-command.ts

- **当前 owner：** system-runtime stdio MCP **Delivery** command，以及 TeamRun MCP tool schema/projection boundary；不拥有 TeamRun state machine。
- **职责与关键 symbols：** `runSystemRuntimeMcpServerCommand()` parse/run/error exit；`createSystemRuntimeMcpHandler()` 支持 initialize、initialized notification、tools/list、tools/call；三 tools 为 `team_node_event`、`team_graph_patch`、`team_graph_context`；`invokeTeamRuntimeTool()` 组装 team-run scope/target 并 dispatch。
- **旧语义与策略：** 只接受 `mcp-stdio` 和 URL/timeout options，未知/缺值输出 usage且返回 1。MCP initialize 固定 2024-11-05、server version `0.0.0`。tools/call中未支持 tool 返回 -32602；dispatch failure 作为 JSON-RPC **result** 的 `isError:true` content，而非 JSON-RPC error。event/patch只向模型投影 `success/runId/accepted`，context返回完整 result。flat runtime endpoint必须通过 `validateRuntimeEndpointRef`。
- **状态、存储与副作用：** 无长期状态；读取/写入 stdio，运行 stdio server，调用 HTTP dispatch；tool schemas为静态对象。
- **并发与性能特征：** 性能受底层 stdio server的串行 handler与每 tool 一次 dispatch约束；schema 每 `tools/list` 重建三个大对象；无 cache/retry。
- **调用/依赖边界：** 上游 CLI entry；下游 `mcp-stdio-json-rpc`、dispatch client、runtime-address validator，最终 `team.runtime` capability 的 three operation ids。TeamRun business validation在远端 capability。
- **故障、恢复与安全：** 顶层捕获写 stderr且 exit 1；tool要求 runId/endpoint string，拒绝不支持 tool。schema文案明确 idempotencyKey、终态后停用、不要 secrets/large outputs，但服务器只做结构/endpoint门面，权限、idempotency持久化与敏感字段 enforcement在下游且待验证。
- **迁移分类：** **Preserve：** command grammar、MCP handshake/tool names、flat endpoint validation、operation/scope mapping、event/patch compact result projection、dispatch failure 的 MCP `isError` 表现。**Intentional Improvement：** 无证据。**Defect：** 无充分证据。**待验证：** schema `additionalProperties:true` 与下游 validation是否足够、MCP protocol version/`0.0.0`是否兼容性承诺。
- **未来 Rust owner：** **Delivery**；TeamRun idempotency/audit/state为 **Domain Module**，通用 deadline为 **Foundation Kernel**。
- **Rust 重写与性能判断：** 旧成本为每 list 重建 schema、每 call 一次 JSON/HTTP且被 stdio串行化；不变量是 tool descriptions/schema required fields、scope/target mapping和错误投影；指标为 tool list allocation、call latency、invalid input rejection率、terminal duplicate event率；oracle 为 MCP transcript golden（initialize/list/call/error）及 mock capability mapping tests。
- **验证 oracle：** 需补 stdio MCP end-to-end transcript；当前证据为 command、stdio server、dispatch client。
- **证据：** `runtime-host/application/runtime-cli/system-runtime-mcp-server-command.ts`；`mcp-stdio-json-rpc.ts`；`runtime-host/application/team-runtime/*` capability boundary（通过 operation id）。

### runtime-host/application/subagents/agent-skill-config-contracts.ts

- **当前 owner：** pure agent-skill configuration view/port contracts；不拥有 catalog、OpenClaw config、RPC 或状态。
- **职责与关键 symbols：** `AgentSkillConfigView/Option` 表达 support、selection、explicit/inherited/effective keys、options、revision；`SetAgentSkillConfigCommand/Result` 表达 CAS 写；`AgentSkillConfigProjectionPort` 定义 read/set。
- **旧语义与策略：** selection 区分继承 defaults 与显式 allowlist；result 精确区分 `updated`、`staleRevision`、`unsupported`、`invalidSkillKeys`，后者区分 unknown/non-canonical；readonly只是 TypeScript 编译期约束。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 零执行/I/O/锁；revision只定义协议，不在本文件比较。
- **调用/依赖边界：** service 消费 contract；OpenClaw agent-skill projection 实现 port；capability route 将目标绑定为 subagent。
- **故障、恢复与安全：** 只表达 stale/unsupported/invalid，未定义 retry/durability/secret/redaction。
- **迁移分类：** **Preserve：** selection、四 result discriminant、unknown/non-canonical 区分与 revision/latest view形状。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** `runtimeDoesNotExposeAgentSkillConfig` 是否有实际 producer；已读 OpenClaw implementation未返回它。
- **未来 Rust owner：** 通用 agent/revision outcome grammar为 **Matcha Platform Core**；skill可用性领域事实为 **Domain Module**；OpenClaw翻译为 **Runtime Integration**。
- **Rust 重写与性能判断：** 旧成本为零；不变量是 schema discriminant/nullable/array order；指标是 schema compatibility而非吞吐；oracle 是 TS/Rust JSON fixture及 capability response golden differential。
- **验证 oracle：** 既有间接 route scenarios覆盖 read/unsupported/stale/updated/invalid；仍需 schema compatibility fixture。
- **证据：** `runtime-host/application/subagents/agent-skill-config-contracts.ts`；`runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection.ts`；`tests/unit/runtime-host-subagent-routes.test.ts`。

### runtime-host/application/subagents/agent-skill-config-service.ts

- **当前 owner：** agent-skill config application/delivery parser facade；不拥有 skill或配置事实。
- **职责与关键 symbols：** `getConfig/setConfig()`；`readAgentSkillConfigCommand()`、`readSetAgentSkillConfigCommand()`、`readRequiredStringList()`、`isSafeAgentId()` 解析/校验 payload并调用 projection。
- **旧语义与策略：** `agentId`优先，trim后为空才回退`subagentId`；拒绝 slash/backslash/NUL/`..`/Windows drive。set需要非空 revision。inherit忽略 skillKeys；显式 allowlist要求 string array、trim、按首次顺序去重，空 array合法。parser error为 badRequest；projection 的 stale/unsupported/invalid均以正常 `ok` response承载。
- **状态、存储与副作用：** 无内部 mutable state；每有效请求一次 port await，间接读写取决于 injected projection。
- **并发与性能特征：** 无锁/retry/cache；`values.includes`去重最坏 O(n²)，revision CAS下沉到 projection。
- **调用/依赖边界：** capability `agent-skill-config-capability.ts` 上游（强制 subagent target并检查 body identity）；下游 `AgentSkillConfigProjectionPort`，composition注入OpenClaw projection。
- **故障、恢复与安全：** 不 catch projection rejection；本层防路径式 id但不做授权/canonicality/persistence recovery。
- **迁移分类：** **Preserve：** alias优先级、trim/safe-id拒绝、required规则、稳定首次去重、bad-request边界。**Intentional Improvement：** 无。**Defect：** 无证据，空 allowlist不应臆断为缺陷。**待验证：** 绕过 capability route 直接调用是否是支持 API，及 compatibility alias长期必要性。
- **未来 Rust owner：** payload decode/response mapping为 **Delivery**；OpenClaw port为 **Runtime Integration**。
- **Rust 重写与性能判断：** 旧成本是 O(n²) list dedupe加一次 port call；不变量是顺序、trim、错误/alias；指标是 large-list p95/allocation与 port-call count；oracle 是 payload table、invalid input零 port-call spy、command equivalence fixtures。
- **验证 oracle：** `tests/unit/runtime-host-subagent-routes.test.ts` 有 route mismatch/invalid/read/write/stale scenarios；未表示真实持久化已测试。
- **证据：** `runtime-host/application/subagents/agent-skill-config-service.ts`；对应 capability/projection/composition和上述测试。

### runtime-host/application/subagents/agent-tool-config-contracts.ts

- **当前 owner：** pure tool policy/config DTO 与 projection port contracts；不拥有 catalog、OpenClaw config或状态。
- **职责与关键 symbols：** `AgentToolConfigView`、`AgentToolPolicy(profile/allow/deny)`、tool/group option元数据、conditional `SetAgentToolConfigCommand/Result`、`AgentToolConfigProjectionPort`。
- **旧语义与策略：** default inheritance时 `toolPolicy:null`；view可表达 core/plugin source、plugin id、risk/tags/group；result为 updated/stale/unsupported/invalidToolKeys，invalid仅携带 unknown keys。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 零运行路径；revision只是跨 port 的 optimistic concurrency 数据。
- **调用/依赖边界：** tool config service/capability route 消费；OpenClaw agent-tool projection生产。
- **故障、恢复与安全：** 没有 runtime immutability、retry、catalog安全或 secret规则；Promise rejection由实现传播。
- **迁移分类：** **Preserve：** `profile/allow/deny`、null policy、catalog元数据与四 outcome。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** runtimeDoesNotExpose...实际 producer，以及 profile/key catalog约束是否需提升为共用模型。
- **未来 Rust owner：** revision command grammar为 **Matcha Platform Core**；OpenClaw catalog/config翻译为 **Runtime Integration**；若保持 runtime原生 policy则为 **Native Runtime Edge**。
- **Rust 重写与性能判断：** 旧成本为零；不变量为 policy nullability、option/group字段和 result schema；指标为 schema fixture compatibility；oracle 为 core/plugin/group/risk/empty-policy JSON golden。
- **验证 oracle：** 现有 subagent route test间接覆盖；仍需跨实现 DTO differential。
- **证据：** `runtime-host/application/subagents/agent-tool-config-contracts.ts`；OpenClaw tool projection；`tests/unit/runtime-host-subagent-routes.test.ts`。

### runtime-host/application/subagents/agent-tool-config-service.ts

- **当前 owner：** tool config payload parser/application facade；不拥有 tool catalog或配置。
- **职责与关键 symbols：** `getConfig/setConfig()`、agent identity parser、policy parser、list parser与 safe-id检查。
- **旧语义与策略：** identity/alias/path-like拒绝同 skill service；set必须 revision。inherit不读取 policy；set policy要求非空 trimmed profile以及 allow/deny 都为 arrays；两个 array独立 trim、拒空/非字符串、首次去重，空 array合法。不在这里判断 allow/deny交集、profile存在或 key合法。
- **状态、存储与副作用：** 无 mutable state；每有效调用一次 projection。
- **并发与性能特征：** 无cache/retry/锁；allow/deny独立 `includes` 最坏 O(a²+d²)，CAS下沉。
- **调用/依赖边界：** agent-tool capability route target-bound body上游；OpenClaw projection port下游；openclaw application module注入实现。
- **故障、恢复与安全：** parsing 为 400；projection/gateway/catalog exception传播；safe id不是授权。policy冲突的解释留给 native runtime/projection。
- **迁移分类：** **Preserve：** identity、revision/profile、independent ordered dedupe、inherit分支和 projection outcome透传。**Intentional Improvement：** 无。**Defect：** 无证据，overlap/empty array均待产品语义。**待验证：** profile catalog membership、allow/deny overlap与 direct callers。
- **未来 Rust owner：** **Delivery** 负责 parse/response；**Runtime Integration** 负责 OpenClaw catalog/config。
- **Rust 重写与性能判断：** 旧成本 O(a²+d²) plus one port call；不变量为 list order、profile trim和branch requirements；指标为 validation p95/allocation、unknown-key时写调用数；oracle 为 parser/route fixture及 projection spy。
- **验证 oracle：** existing test覆盖 unknown key不写、stale/update/inherit；需要真实 catalog projection test。
- **证据：** `runtime-host/application/subagents/agent-tool-config-service.ts`；对应 capability/projection/composition；`tests/unit/runtime-host-subagent-routes.test.ts`。

### runtime-host/application/subagents/service.ts

- **当前 owner：** `SubagentRuntimeService` 是 OpenClaw-backed subagent lifecycle/config/files application facade；协调 Gateway workflow、skill canonicalization workflow与 config projection，但不存 agent snapshot。
- **职责与关键 symbols：** list/display，description/model/skills write，create/update/delete，固定五文件 get/set/list；`canonicalizeAgentsPayload/canonicalizeDisplayConfig/readOptionalSkillKeys`，以及 manageability/file filtering helpers。allowlist 为 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`。
- **旧语义与策略：** list从 `agents.list` snapshot拿 agent后canonicalize skills，未知非空 key保留、空/重复去除。description/model空值交给 projection（OpenClaw实现删除字段）。skill write接受null/undefined未显式传，array先 canonical validate。create默认`mainAgentTemplate`，可选`emptyWorkspace`；update/delete要求 invalidateSnapshots，deleteFiles仅严格true。文件操作先 agents.list证明可管理，且仅返回允许 content/name，过滤远端 path/content/非 allowlist 条目。
- **状态、存储与副作用：** 仅 dependencies和常量 set，无本地 cache；Gateway RPC、snapshot cache、workspace init及OpenClaw config落盘在workflow/projection。
- **并发与性能特征：** 无本地锁/retry；file每次至少 agents.list+file RPC；skill canonicalization uses array includes最坏 O(n²)。下游 workflow冷读有 snapshot/background refresh coalescing，非本类状态。
- **调用/依赖边界：** subagent-management capability route上游（agent与subagent target/body一致性）；`SubagentRuntimeWorkflow`、skill workflow、`SubagentConfigProjectionPort`下游；OpenClaw application module装配。
- **故障、恢复与安全：** bad payload/file/id 为 badRequest；file preflight failure/不存在/形状异常归 `agentId is not manageable`；files投影防路径与内容泄露。create Gateway失败不初始化 workspace；create后初始化失败的补偿、retry、recovery未在此处定义。description/model等 id约束更多依赖外层 target route。
- **迁移分类：** **Preserve：** skill canonicalization规则、create default、update/delete invalidation、五文件 allowlist+preflight+脱敏、Gateway create成功后才 workspace init。**Intentional Improvement：** 无。**Defect：** 无充分证据；大小写preflight与原 id RPC、部分方法未重用 safe-id仅为待验证。**待验证：** snapshot TTL/failure、workspace补偿、file preflight是否可减RPC仍保持安全。
- **未来 Rust owner：** OpenClaw native lifecycle/workspace/files为 **Native Runtime Edge**；协议/config bridge为 **Runtime Integration**；target/response边界为 **Delivery**。
- **Rust 重写与性能判断：** 旧成本是 file双RPC和 O(n²) skill dedupe；不变量是可管理 agent前置、五文件/字段过滤、未知 skill不丢、冷读不无界重复 refresh；指标为 file p95/RPC数、canonicalization CPU、cold-read concurrent RPC、workspace failure recovery；oracle 为恶意 files golden、concurrent cold-read、Gateway failure/workspace failure fault injection、large skill benchmark。
- **验证 oracle：** 已有 `tests/unit/runtime-host-subagent-routes.test.ts` 覆盖 cold refresh、file过滤、create顺序与不少 config场景；未证明真实 OpenClaw持久化/恢复。
- **证据：** `runtime-host/application/subagents/service.ts`；subagent capability/projection/composition；上述 unit test。

### runtime-host/application/subagents/subagent-config-contracts.ts

- **当前 owner：** subagent raw/display config projection DTO与 port；自身不持有 OpenClaw raw config。
- **职责与关键 symbols：** `SubagentConfigDisplayView`、raw `SubagentConfigSnapshot`、CAS `SubagentConfigReplaceResult`、description/model/skills commands、`SubagentConfigProjectionPort`。
- **旧语义与策略：** display固定 `ready:true/refreshing:false/error:null`；raw snapshot包含 `Record<string,unknown>` config、revision、optional path/updatedAt；replace按 revision返回 updated或stale latest。已读OpenClaw实现将 undefined删除字段、找不到 agent可 upsert `{id}`，但后者是实现事实而非 contract强制。
- **状态、存储与副作用：** 当前文件无执行路径；OpenClaw实现经 config repository读写，以 stable hash revision且 JSON stringify/parse clone/全顶层替换。
- **并发与性能特征：** contract零成本；实现成本随全 config大小增长，CAS原子/落盘依赖未在本分片完整读取的 repository。
- **调用/依赖边界：** subagent service及skill/tool projections消费；OpenClawSubagentConfigProjection生产，是三种语义写的共同边界。
- **故障、恢复与安全：** port无 error union，rejection传播；stale提供latest避免静默覆盖。raw config/path属内部信息，公开 capability view不暴露它，但所有future caller安全性待验证。
- **迁移分类：** **Preserve：** revision stale/latest、display/raw分层、字段删除语义和更新后snapshot。**Intentional Improvement：** 无。**Defect：** 无证据；missing agent自动创建是否应保留待验证。**待验证：** repository serialisation/atomic durability/concurrent writers、raw config/path外露。
- **未来 Rust owner：** OpenClaw raw schema/hash/path为 **Runtime Integration**（其原生配置为 **Native Runtime Edge**）；跨 runtime revision receipt可为 **Matcha Platform Core**。
- **Rust 重写与性能判断：** 旧成本全档JSON clone/hash/replace；不变量是 stale不写、updated snapshot、display不泄 raw、field deletion；指标为 config-size下 latency/RSS/conflict/crash recovery；oracle 为 CAS race、full-config preservation diff、concurrent writer/crash fault tests。
- **验证 oracle：** existing fake-port tests验证consumer stale/command行为；真实 repository durable/concurrent oracle待补。
- **证据：** `runtime-host/application/subagents/subagent-config-contracts.ts`；OpenClaw subagent/skill/tool projections；`tests/unit/runtime-host-subagent-routes.test.ts`。

### runtime-host/application/support/diagnostics-bundle.ts

- **当前 owner：** diagnostics archive selection、redaction、staging/compression owner；拥有 bundle contents policy，不拥有 runtime data layout（委托 layout port）。
- **职责与关键 symbols：** `collectDiagnosticsBundle()` 计算72小时默认窗口、收集 user logs/runtime layout/settings、dedupe destination、写 sanitized `diagnostics.json`、压缩 ZIP、finally清 staging。`sanitizeStructuredValue()`按敏感 key递归遮掩；`compressDiagnosticsStagingDir()`在 Windows用 PowerShell、其他平台用 zip。
- **旧语义与策略：** destination去 leading slash/反斜杠并 case-insensitive Map去重，后放 entry覆盖先放。runtime layout给每项 kind/count/redact；settings/runtime JSON redacted，日志/其他copy原文。敏感 key含 token/secret/password/api/key/authorization/cookie/proxy；字符串一律`***`。JSON parse失败的 redacted file整文件`***`。最终 ZIP含 entries加 diagnostics.json；output ZIP同时间戳重复运行会先 remove。
- **状态、存储与副作用：** 遍历/读/复制/写 file，创建/删除 staging及ZIP，执行 PowerShell或zip；counts/entryMap为调用局部内存。app/gateway/license metadata也经 structured sanitizer。
- **并发与性能特征：** 递归遍历、entry map和逐文件串行 copy；redacted JSON整文件读入+parse+pretty stringify；默认 recent window。staging名用时间+pid/now，output名只时间秒级，进程或同秒并行收集可能竞争同ZIP；没有总字节/文件数上限。
- **调用/依赖边界：** DiagnosticsService提供 ports；`DiagnosticsRuntimeBundleLayoutPort`列 runtime entries；Runtime file/clock/command executor为外部 ports。
- **故障、恢复与安全：** finally删除 staging，compression失败不返回 success；可能留下/删除同名旧 output（compression先remove）。redaction为 heuristic key-name，非JSON日志不脱敏；绝不应据此声称 archive不含secret。PowerShell literal escaping处理单引号，非Windows command输入固定。
- **迁移分类：** **Preserve：** window、entry-kind/count、destination normalisation/dedupe、JSON key redaction、diagnostics metadata、staging finally cleanup和平台压缩。**Intentional Improvement：** 无证据。**Defect：** 未有证据把 heuristic redaction定为缺陷；其覆盖充分性必须待验证。**待验证：** concurrent same-second bundle、symbolic link/path policy、archive size limits、日志secrets扫描与 compressor failure output处理。
- **未来 Rust owner：** archive delivery orchestration为 **Delivery**；generic secret/redaction mechanism为 **Foundation Kernel**；runtime-specific layout为 **Runtime Integration/Native Runtime Edge**。
- **Rust 重写与性能判断：** 旧成本为全文件JSON materialisation、串行I/O、无容量限制；不变量是选择/路径/红action/cleanup与统计；指标为 bundle time、peak RSS、I/O bytes、archive byte size、redaction miss rate、failure cleanup；oracle 为 fake filesystem golden ZIP tree、secret corpus、malformed JSON、compressor fault、parallel same timestamp test。
- **验证 oracle：** 需补 file-system/compressor fault-injection 和 redaction corpus；当前证据为 collector与DiagnosticsService。
- **证据：** `runtime-host/application/support/diagnostics-bundle.ts`；`diagnostics.ts`；common runtime ports。

### runtime-host/application/support/diagnostics-jobs.ts

- **当前 owner：** diagnostics collection 的 background-task submission policy；不拥有实际压缩或文件扫描。
- **职责与关键 symbols：** `COLLECT_DIAGNOSTICS_JOB='diagnostics.collect'`、`DiagnosticsCollectInput`、`DiagnosticsJobPort`、`createDiagnosticsJobPort(tasks)`。
- **旧语义与策略：** submit 总是 `queue:'low'`、dedupe key固定为 job id；input带 runtime/user data、app/gateway/license diagnostic metadata。返回底层 `RuntimeLongTaskSubmission` 原样。
- **状态、存储与副作用：** 无自身状态；向 RuntimeLongTaskSubmissionPort提交，队列/持久化/执行状态在下游。
- **并发与性能特征：** 同 dedupe key收敛语义取决于 tasks port；本文件常数分配/一次 submit。
- **调用/依赖边界：** DiagnosticsService `submitCollect` 上游；runtime-host long-task port下游。
- **故障、恢复与安全：** 不 catch/映射 submission error；input可能含 gateway/license snapshot，安全保护由队列/collector责任，未在此文件处理。
- **迁移分类：** **Preserve：** job id、low queue、dedupe key与input形状。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** dedupe是合并/拒绝/复用、job durability/retry/cancel和snapshot secret policy。
- **未来 Rust owner：** submission/dedupe/task supervision为 **Foundation Kernel**；diagnostics request delivery为 **Delivery**。
- **Rust 重写与性能判断：** 旧成本为一次 submit；不变量是 queue/dedupe以及返回 receipt；指标为 queue wait、dedupe hit、job completion/failure和cancel latency；oracle 为 fake task manager assertions及 repeated-submit integration trace。
- **验证 oracle：** 需补 queue/dedupe contract test；当前证据为 job port及 DiagnosticsService。
- **证据：** `runtime-host/application/support/diagnostics-jobs.ts`；`runtime-host/application/runtime-host/runtime-task-ports.ts`；`diagnostics.ts`。

### runtime-host/application/support/diagnostics.ts

- **当前 owner：** diagnostics application facade；负责把 input与 process/platform ports投影给 long task或同步 bundle collector。
- **职责与关键 symbols：** `DiagnosticsService.submitCollect()` delegation；`collect()` 构造 `CollectDiagnosticsBundleInput` 并调用 collector。
- **旧语义与策略：** async collect固定使用进程 pid、injected clock/filesystem/command executor/runtime layout；gatewayStatus/runtimePaths与license snapshot转为 collector gateway/license对象。submit不执行 collect，而是交 jobs port。
- **状态、存储与副作用：** service无mutable state；sync collect执行文件/command副作用，async submission由 job port产生。
- **并发与性能特征：** 无锁/cache/queue；性能取决于 bundle collector或long task系统；调用层常数开销。
- **调用/依赖边界：** routes/application registry上游；diagnostics jobs、bundle collector和common ports下游。
- **故障、恢复与安全：** 不 catch collector/port exception；安全/cleanup在 collector，queue recovery在 task system；两种路径的成功/失败表现是否完全一致待验证。
- **迁移分类：** **Preserve：** submit与collect分离、input projection、injected process/clock/fs/command/layout边界。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** 谁调用同步 collect、是否应只允许后台执行，以及 errors如何经route映射。
- **未来 Rust owner：** application endpoint是 **Delivery**；generic background jobs为 **Foundation Kernel**。
- **Rust 重写与性能判断：** 旧成本是薄 wrapper；不变量是两条入口使用一致 metadata与ports；指标为 direct-vs-job completion/failure、queue latency；oracle 为 fake collector/job port的 delegation fixtures与 collector fault tests。
- **验证 oracle：** 需补 facade route/job integration；当前证据为 `diagnostics.ts`、jobs和bundle collector。
- **证据：** `runtime-host/application/support/diagnostics.ts`；`diagnostics-jobs.ts`；`diagnostics-bundle.ts`。

### runtime-host/application/tasks/service.ts

- **当前 owner：** task runtime workflow application facade；不拥有 task state、tool execution或 snapshot persistence。
- **职责与关键 symbols：** `TaskManagerService` 将 `invokeTool/output/stop/buildTaskSnapshot/emitSnapshot` 原样委托给 `TaskOperationsWorkflow` 的相应五个能力。
- **旧语义与策略：** async方法保留下游 result/rejection；`emitSnapshot`同步转发。不解析、验证、重试、转换或缓存 payload；`buildTaskSnapshot`接受 string或 `{sessionKey,teamKey?}` 并可返回 null。
- **状态、存储与副作用：** 自身仅持 workflow dependency；工具调用、停止、event emission和snapshot存储均下沉工作流。
- **并发与性能特征：** 常数 delegation；所有并发、queue、backpressure、I/O在 workflow；本类不序列化。
- **调用/依赖边界：** task capability/route上游；`application/workflows/task-runtime/task-operations-workflow.ts` 下游，TaskSnapshotEvent与session adapter type共享。
- **故障、恢复与安全：** 不 catch/cleanup/redact；workflow rejection原样传播。snapshot可能携带会话/task信息，access/security必须在 caller/workflow，当前不可由本文件证明。
- **迁移分类：** **Preserve：** 五个方法/async sync边界、参数/返回值及无额外处理。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** task execution cancellation/idempotency/durability、snapshot visibility和workflow error mapping。
- **未来 Rust owner：** generic task supervision/cancel为 **Foundation Kernel**；session task snapshot事实为 **Domain Module（Session）**；capability delivery为 **Delivery**。
- **Rust 重写与性能判断：** 旧成本为零实质逻辑；不变量是一次且仅一次 delegation与同步 emit；指标为 workflow-call count、queue/stop latency、snapshot delivery loss；oracle 为 spy workflow contract tests和task lifecycle fault injection（不应以替换语言宣称性能收益）。
- **验证 oracle：** 需补 facade delegation tests；当前证据为 service及workflow contract import。
- **证据：** `runtime-host/application/tasks/service.ts`；`runtime-host/application/workflows/task-runtime/task-operations-workflow.ts`。

### runtime-host/application/workbench/bootstrap.ts

- **当前 owner：** workbench bootstrap response 的 pure presentation projection helper；不拥有 runtime state。
- **职责与关键 symbols：** `WorkbenchRuntimeState`；`buildWorkbenchBootstrapPayload(state, generatedAt)` 返回 success、时间、lifecycle、active plugin count和原 plugins array。
- **旧语义与策略：** active count只计 `plugin.lifecycle === 'active'`；plugins原数组直接出现在输出中（不 clone/filter）；generatedAt由调用方提供毫秒值。
- **状态、存储与副作用：** 无；但返回值与输入 `plugins` 共享引用是 JavaScript对象语义。
- **并发与性能特征：** 单次 `filter` O(number of plugins)并保留数组引用，无锁/IO。
- **调用/依赖边界：** WorkbenchService调用；runtime state port是更外层输入来源；workbench route/registry再消费结果。
- **故障、恢复与安全：** 无验证/error/redaction；如果 state/plugins 含敏感字段，helper不筛除，实际runtime state公开字段政策待验证。
- **迁移分类：** **Preserve：** payload键、active的精确判定、generatedAt来源、plugins完整投影。**Intentional Improvement：** 无。**Defect：** 无证据，引用共享是实现细节而非已证实产品语义。**待验证：** workbench公开 plugins是否需要 whitelist/redaction以及 lifecycle值域。
- **未来 Rust owner：** **Delivery**；runtime lifecycle的事实 owner不应被该响应 helper取得。
- **Rust 重写与性能判断：** 旧成本 O(n) count；不变量是 exact payload与active count；指标是 plugin数量下 allocation/response time；oracle 为 state→JSON golden（active/non-active/missing lifecycle）和 public-field exposure review。
- **验证 oracle：** 需补 payload golden；当前证据为 bootstrap helper和WorkbenchService。
- **证据：** `runtime-host/application/workbench/bootstrap.ts`；`runtime-host/application/workbench/service.ts`。

### runtime-host/application/workbench/service.ts

- **当前 owner：** workbench bootstrap application facade；读取 runtime state并提供当前时间给 presentation helper。
- **职责与关键 symbols：** `WorkbenchServiceDeps`（runtimeState、clock）；`WorkbenchService.bootstrap()` 调用 `runtimeState.runtimeState()` 与 `clock.nowMs()`，再转 `buildWorkbenchBootstrapPayload()`。
- **旧语义与策略：** 每次 bootstrap同步读取即时 runtime state和clock；不缓存、排序、过滤或错误映射。runtime state port仅取 `runtimeState`，不拥有其生命周期。
- **状态、存储与副作用：** service无 mutable state；调用 dependency可能观察内存 runtime state，clock读取是唯一外部 interaction；无I/O。
- **并发与性能特征：** 常数 facade加下游 plugins O(n) filter；无锁/cache，snapshot一致性取决于 runtime state port。
- **调用/依赖边界：** runtime application module创建、runtime route module/route services/token registry引用（CodeGraph）；下游 workbench bootstrap helper和 runtime-host state port。
- **故障、恢复与安全：** 不 catch state/clock exception；不进行字段redaction。CodeGraph未发现直接测试，故 route error/visibility契约待验证。
- **迁移分类：** **Preserve：** current-state/current-clock读取与无cache delegation。**Intentional Improvement：** 无。**Defect：** 无证据。**待验证：** runtime state read是否原子、workbench读取失败HTTP mapping、公开 plugin字段策略。
- **未来 Rust owner：** **Delivery**；runtime lifecycle state为相应 **Domain Module** 或 **Foundation Kernel**，不得由 workbench成为事实源。
- **Rust 重写与性能判断：** 旧成本仅一次state/clock调用和下游 O(n) count；不变量是即时 snapshot与timestamp；指标为 bootstrap p95、snapshot consistency、response allocation；oracle 为 fake state/clock delegation fixture、concurrent lifecycle transition snapshot test与bootstrap JSON golden。
- **验证 oracle：** 需补 service/route tests；CodeGraph明确该 service未发现覆盖测试。
- **证据：** `runtime-host/application/workbench/service.ts`；`runtime-host/application/workbench/bootstrap.ts`；CodeGraph callers：runtime application/route modules、runtime-host tokens。

## 当前工作区增量审计：matcha-agent app-server 与 Runtime Integration

> **审计范围与状态：** 本节记录本次工作区 `git status` 中可见的 matcha-agent app-server / Runtime Integration 增量，以及为理解该增量读取的当前 active path。它是事实审计，不表示这些 TypeScript 实现已经完成 Rust cutover。下述 app-server 生产文件中，`main.ts`、`transport/clientHub.ts`、`workers/workerSupervisor.ts` 是已修改项，`sessions/sessionEventCommitter.ts` 是未跟踪的新项；`EventStore`、`SnapshotStore`、`SessionIndex`、`SessionRegistry`、`RunCoordinator`、`ApprovalBroker` 是当前链路中仍在使用的相邻 owner，并非本次 status 中逐一修改的文件。
>
> **本节明确排除：** `matcha-agent/.matcha-agent-app-server/**` 中未跟踪的 `sessions/*/events.jsonl`、`snapshot.json` 与 `index.json` 是本机运行产生的 session artifacts，不是 production source、迁移输入、测试 fixture 或 Rust ownership 证据；不得提交、不得作为 Runtime Integration 的持久化实现迁移。也排除构建产物、`node_modules`、coverage、临时输出及本节以外的 working-tree 改动。

### 1. 当前 app-server 完整提交链

- **组合根：** `createDefaultAppServerServices()` 以同一 `storageRoot` 创建 `EventStore`、`SnapshotStore`、`SessionIndex`，并在内存中持有 `SessionRegistry`、`RunCoordinator(maxQueueSize: 16)`、`ApprovalBroker`、按 session 的 drain tail/pending 标记和 `WorkerSupervisor`。`WsServer`/protocol ports 只调用这组 service；它们不是第二套 session owner。
- **持久事件的先后约束：** `EventStore.append()` 对每个 session 保持 append promise tail；`appendAfterPrevious()` 在 `events.jsonl` 成功追加带 `eventId`、单调 `seq`、时间、可选 `runId`/`workerId` 的 envelope 后才更新内存 latest seq。`replay(afterSeq, limit)` 仅从该日志按 seq 过滤，故 event log 是 app-server 可回放事实源，而非 ClientHub 或 snapshot。
- **本次新增的完整 event pipeline owner：** `SessionEventCommitter` 又按 session 串行整个 `append → session metadata projection → snapshot projection → ClientHub.publish` 链，而不只串行 event file append。因此同一 session 不会出现后一个 event 先被投影或发布；不同 session 仍可并行。它复制调用 fields，append failure 会拒绝当前 commit（不发布）但将 tail 复位，使后续 commit 可继续。
- **append 后投影的可用性取舍：** metadata、snapshot、publish 任一阶段失败，`SessionEventCommitter` 记录阶段和 envelope 后吞掉该阶段错误，仍执行后续阶段及下一 event；当前 `main.ts` reporter 只写结构化的 console error。故“已落盘 event”与“已更新 snapshot/index / 已推送 live client”不是原子事务；恢复和 replay 必须以 event log 为准，不能从 snapshot 或已送达通知反推提交成功。
- **SessionIndex / registry：** envelope 中可映射为 session 的事件经 `updateSessionAfterEnvelope()` 更新 `SessionRegistry`，随后 `SessionIndex.upsert()` 在全局 index mutation queue 中 read-all / map-replace / write-all。session 创建和 load 路径已移除直接 index upsert，改由 `session.created` / `session.loaded` 的 committer projection 统一推进。index 读不到、JSON 无效或 shape 无效时返回空列表，因而它是可重建目录，不是比 event log 更强的 source of truth。
- **SnapshotStore：** snapshot 由 current registry/session 与 event reducer 计算；每 session 有独立 write queue，只有新 snapshot version 不低于已存 version 才覆写 `snapshot.json`。读不存在、损坏或 shape 不合的 snapshot 返回 `undefined`。它是加速读取和状态投影，不能替代 event replay，也不提供 event/index/live push 的原子提交。
- **恢复含义：** active path 从 `SessionIndex` 找到 session，再由 `EventStore.replay()` 供应恢复、snapshot 构建和 transport replay；因此 index/snapshot 损坏的降级语义与 event-file 缺失不同。尚未证明多文件部分写入后的自动 repair 或 compaction；这应作为未来 durability fault oracle，而非假定已解决。

### 2. session、run、approval、worker、client 的当前链

1. **session / run：** session ports 创建、load、更新设置、snapshot 和 event replay 后，prompt 进入 `RunCoordinator.enqueue()`。它拒绝重复 `runId`，每 session 最多 16 个 queued run；`scheduleDrain()` 用每 session drain tail 合并重入。`drainNextRun()` 先加载 session runtime state，`WorkerSupervisor.ensureWorker()` 成功后才 `startNext()`，把 registry 标为 running，再向 worker 发 `session.prompt`。worker send error 或非成功 response 会标记 worker 不可用、kill session worker，并把该 run 落为 `run.failed` event；完成、失败、取消和 crash 各经 coordinator transition 后继续 drain。
2. **approval：** worker 的 `approval.request` 先令对应 run 进入 waiting-for-approval，再由 `ApprovalBroker.create()` 建立 approval、将 registry worker state 写为 waiting，并提交 `approval.requested`。响应路径先以 `prepareResponse()` 验证 approval 存在、session 一致、未终态及 option 合法；worker receive 成功后才 `commitResponse()` 改 broker terminal state，并提交 `approval.resolved`。worker crash 会取消其 approval、将 running/waiting run 标成 interrupted 并为每个变化写 event。broker 和 coordinator 都是进程内状态，重启后的可观测恢复以 event replay 的重建语义为准。
3. **worker：** `WorkerSupervisor` 维持单 session→worker slot、request correlation 和 heartbeat watchdog；frame 必须同时匹配现有 slot 与 assigned `workerId` 才会交给 main ports。本次增加的早退使 shutdown 已移除 slot、或旧 worker 已被替换后的 late frame 无法再造成 ready/event/approval/run 状态倒灌。该改动是进程边界的旧消息隔离，不改变 app-server event identity 语义。
4. **ClientHub：** committer 最后调用 `ClientHub.broadcast(envelope)`；hub 仍按 client subscription/session 与 `afterSeq` 判定投递，并用每 client 的 item/byte queue 和串行 flush 保证该 client 的发送顺序。本次移除了每次 live broadcast 后把 subscription `afterSeq` 前移的逻辑：已收到较高 seq 的 client 不再因此压掉迟到的较低 seq。换言之，hub 现在是有界 fan-out queue，不是 seq 去重/reordering owner；连续 seq、replay/live window 和 checkpoint 责任留在 Runtime Integration event bridge。

### 3. Runtime Integration：peer native Runtime 边界

- **边界结论：** matcha-agent app-server 是与 OpenClaw 并列的 native runtime peer，不是 `runtime-host` 的子服务、也不应被 Rust Foundation Kernel 吸收。它拥有 worker lifecycle、run/approval/session event protocol 以及其本地 event/snapshot/index 存储；runtime-host 只通过 `RuntimeAdapter` / `RuntimeSessionTransport` 将该运行时接到统一 capability、canonical session 和 delivery 边界。
- **注册与发现：** 当前 `MatchaAgentRuntimeAdapter` 受 enabled endpoint 环境配置 gate 控制；启用时暴露固定的 Matcha endpoint/profile、默认 agent 与 native capability descriptors，未启用或缺 URL 时暴露空 endpoints/capabilities。adapter 按 endpoint URL 缓存 transport；registry 的 endpoint/instance summary 现携带 `defaultAgentId`，而不是把 Matcha agent 当成 OpenClaw gateway agent。
- **native transport contract：** `RuntimeSessionTransport` 已扩展可选 `ensureSession`、`startSessionEvents` / `stopSessionEvents`、external session list 与 transcript read。`MatchaAgentRuntimeTransport` 以 app-server JSON-RPC 执行 `session.load → not-found create → duplicate-create load`，随后将 prompt、cancel、approval response、model patch 交给 app-server；它不会直接访问 `EventStore`，也不会管理 worker。external catalog 只投影有 conversation 的远端 session，transcript 仍由 app-server 提供。
- **event ingress：** 每 endpoint session 最多一个 `MatchaAgentEventBridge`。它通过 app-server `events.subscribe(afterSeq)` 组合 replay 和订阅窗口内缓存的 live event，维护连续 seq / gap pending / checkpoint，再把 normalised envelope 交给 runtime-host 的 canonical translation。ClientHub 只送达原始 envelope；bridge 才是 runtime-host 侧的去重、顺序和 checkpoint boundary，不能以 client fan-out 行为替代它。
- **上游 workflow：** session-run workflow 先绑定 `RuntimeSessionContext`、提交 canonical submitted-prompt projection，再异步 ensure/start event stream/send prompt；session-catalog workflow 可通过 runtime overlay/list external sessions 把远端目录映射进 UI/session services。canonical reducer、timeline 和 transcript loader 是 Matcha event 的下游投影，不拥有 app-server run、approval 或本地 storage。
- **Rust owner 划分：** app-server protocol client、event bridge、profile-specific capability declaration、远端 session catalogue/transcript adapter 属 **Runtime Integration**；跨 runtime endpoint/identity/transport contract 属 **Matcha Platform Core**；canonical session state 属 **Domain Module（Session）**；通用 cursor/deadline/backpressure primitives 才可下沉 **Foundation Kernel**。matcha-agent 本身的 worker/session implementation 仍是 **Native Runtime Edge**。迁移不得复制 app-server 的 local artifacts，更不得把 event log、snapshot 或 index 误建为 runtime-host 的第二事实源。

### 4. 当前增量的验证证据与未运行测试

- **已读代码与 diff 证据：** `matcha-agent/src/app-server/main.ts`、`stores/EventStore.ts`、`stores/SnapshotStore.ts`、`stores/SessionIndex.ts`、`sessions/sessionRegistry.ts`、`sessions/runCoordinator.ts`、`approvals/approvalBroker.ts`、`workers/workerSupervisor.ts`、`transport/clientHub.ts`、新增 `sessions/sessionEventCommitter.ts`；以及 `runtime-host/application/adapters/matcha-agent/runtime/*`、agent-runtime endpoint contracts/registry、session-run/session-catalog workflows 和当前 git diff/status。CodeGraph 还确认 `SessionRunWorkflow` 调用 `ensureSession` / `startSessionEvents`，并确认 app-server store/worker/client callers。
- **工作区中已新增/调整的测试，但本次没有执行：** `matcha-agent/src/app-server/__tests__/sessionEventCommitter.test.ts` 覆盖同 session 全链串行、跨 session 并行、post-append projection failure 继续和 append failure tail recovery；`appServerMain.test.ts` 新断言 live notification 的完整 seq/type 顺序；`workerSupervisor.test.ts` 新断言 shutdown 后 late frame 被忽略；`transport/__tests__/clientHub.test.ts` 新断言高 seq 后迟到低 seq 不被抑制。工作区另有未跟踪的 `tests/unit/matcha-agent-runtime-adapter.test.ts`，但其内容和执行结果均不构成本节通过证据。
- **明确未运行：** 本次任务仅追加本审计文档，未执行 `bun test`、`pnpm test`、typecheck、lint、app-server process 或 runtime-host integration/e2e 测试；没有生成任何新的测试输出。因此上述测试只是存在的覆盖意图，不能表述为已通过。
- **后续最小 oracle：** 在干净 artifact root 跑 app-server store/committer/main/worker/client tests；再以 mock app-server 做 Runtime Integration 的 ensure create-race、replay/live race、gap/duplicate、client disconnect、worker crash、approval response 与 restart/recovery trace。必须分别断言 event log、snapshot/index projection和 live delivery，避免把任一投影的成功误当成三者原子成功。

### 5. app-server worker 协议收敛与 Electron lifecycle / renderer consumer 的重新归类

- **peer Runtime 的正常 worker 收敛：** app-server 组合根保留 `AppServerServices.workerSupervisor`，`createAppServerRuntime().stop()` 以一次性 `stopPromise` 先 `WsServer.stop(closeActiveConnections)` 关闭 WS ingress，再 `services.shutdown()` → `WorkerSupervisor.shutdownAll('serverShutdown')`。每个 slot 先从 supervisor map 移除并清除 heartbeat timer，发送 `worker.shutdown`、等待成功 response，随后 `WorkerProcess.close()` 关闭 worker stdin 并**等待 OS child `exit`**；仅 response 拒绝/超时、stdin EOF 后在 `WORKER_SHUTDOWN_TIMEOUT_MS = 2_000` 内仍未退出时才 `kill()`，并继续等待 exit。`SIGINT`、`SIGTERM` 与 app-server stdin EOF 复用同一 shutdown latch，故 Electron 关闭 root stdin 可走协议关闭，不依赖 Windows signal 语义。此链路、worker IPC、worker 内 QueryEngine/tool/approval/session 语义仍由 `matcha-agent` Native Runtime Edge 拥有，Rust不得复制或接管其 `WorkerSupervisor`。
- **当前受管 peer lifecycle 的外部旧 owner：** Electron `MatchaAgentAppServerProcessManager` / `LocalProcessRuntime` 当前以 `gracefulShutdownStdin: true` 关闭 app-server root stdin，给它 `gracefulShutdownGraceMs: 3_000` 等待 root 自然退出；之后才按 `terminateProcessTree: true` 升级为强制终止（Windows为 `taskkill /F /PID <root> /T`）。`taskkill /T` 因而是 root 在有界 grace 后仍存活时的异常兜底，**不是**正常 worker 回收机制。spawn、root readiness、restart/backoff、child log、root shutdown/escalation、process-tree cleanup、PID/provenance及私有 endpoint/token handoff均是目标 Rust Matcha Runtime Local Process Host 的外部旧 owner；迁移后 Rust拥有是否运行、何时升级终止、如何观察及对应进程实现。Electron只保留窗口、桌面集成和 Command/Query/Event客户端，不能继续拥有 Runtime PID或生命周期事实。
- **必须冻结的可观察约束与未关闭证明：** 未来 lifecycle slice须将「关闭 ingress → all worker shutdown request/ACK → worker stdin EOF → 每个 worker OS exit 或有界 kill → app-server root exit → root grace 后 tree-kill fallback」写入行为表和 TS↔Rust fault/replay oracle。正常 shutdown、Settings `setModel`/`setMode` restart均不得在旧 worker 的真实 exit 前启动 replacement；root exit 后还必须以受管 worker PID/provenance 做 post-exit orphan 检查，断言没有存活 worker，不能只因 root exit 或 `taskkill` 返回成功即宣称收敛。该 orphan oracle须覆盖 worker拒绝/缺失 shutdown ACK、stdin EOF后不退出、root提前崩溃、强杀期间及 restart race；按平台记录 PID/process-tree 观测差异和允许差异。当前 source/test 已证明 worker close等待 exit、supervisor timeout后 kill及adapter的3秒stdin grace，但本审计未运行真实多进程、Windows `taskkill`、post-root-exit orphan或跨平台 package smoke，故后四类仍为**待验证**，不得写成已无泄漏。
- Settings中的 app-server status/restart、renderer Host API/event transport及chat/session UI仅是 Delivery contract witness。它们可检验runtime-host提供的command/query/event投影，不能直接连接 app-server，也不能将UI success、toast或local cache解释为peer event已commit、worker已退出或runtime effect已完成。

### 6. 本次 shutdown 增量的旧 owner、测试与迁移映射

| 当前实现 / 策略 | 当前 semantic owner | 未来 Rust / retained 边界 | observable oracle 与状态 |
|---|---|---|---|
| `AppServerRuntime.stop()` 的 once-only latch：停止 WS ingress 后调用 `services.shutdown()` | matcha-agent app-server main / `WsServer`，Native Runtime Edge | retained peer Runtime shutdown contract；Rust Local Process Host只请求/等待root关闭，不解释 worker业务状态 | `runAppServer` 的 SIGINT/SIGTERM/stdin EOF共用latch、重复 stop 只执行一次；当前静态已读，真实进程信号/EOF待运行 |
| `WorkerSupervisor.shutdownAll()` 并行逐 session：ACK → stdin EOF → `waitForExit()`；2秒后 kill再等 exit | `WorkerSupervisor` / `WorkerProcess`，Native Runtime Edge | worker protocol、worker PID与QueryEngine生命周期保留给peer；Rust只把root正常退出/超时升级作为受管 peer contract | `workerProcess.test.ts`、`workerSupervisor.test.ts`、`appServerMain.test.ts`是未运行 oracle；正常路径必须没有worker kill |
| app-server root stdin EOF → worker收敛 → root exit | app-server main shutdown trigger，Native Runtime Edge | Rust Local Process Host以版本化、私有的root shutdown contract触发并等待；不得以Windows信号语义替代协议 | root stdin EOF、WS ingress已停止、每个worker exit、root exit的顺序trace；当前未有真实多进程全链证据 |
| 3秒后 `terminateProcessTree` / Windows `taskkill /F /T` | 当前 Electron `LocalProcessRuntime`，受管 peer lifecycle外部旧 owner | Rust Local Process Host接管强制升级与PID/provenance/tree cleanup；Electron不保留lifecycle authority | 仅root在grace后仍活才升级；必须另验taskkill失败、root已退但worker残留、tree cleanup完成；当前真实Windows证据未运行 |
| Settings warm-worker restart | app-server session settings workflow / `WorkerSupervisor`，Native Runtime Edge | retained peer restart contract；Rust只管理app-server root，不能管理其session worker | old worker shutdown ACK、EOF、OS exit后才可创建replacement；当前fake worker test为未运行 oracle，真实non-overlap待验证 |

- **证据：** `matcha-agent/src/app-server/{main.ts,workers/workerProcess.ts,workers/workerSupervisor.ts}`；`electron/main/process-runtime/{contracts.ts,local-process-runtime.ts,adapters/matcha-agent-app-server-process-adapter.ts}`；`matcha-agent/docs/matcha-agent-app-server-architecture.md`；`matcha-agent/src/app-server/__tests__/{appServerMain,workerProcess,workerSupervisor}.test.ts`；`tests/unit/matcha-agent-app-server-process-adapter.test.ts`。
