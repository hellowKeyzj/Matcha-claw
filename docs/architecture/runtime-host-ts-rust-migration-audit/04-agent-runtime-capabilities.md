# 04 — Agent Runtime 与 Capabilities 文件级 TS → Rust 迁移审计

> **静态审计状态：完成（当前工作树快照）。** 本文是事实审计与迁移证据，不是 Rust 实施批准。

## 范围、方法与计数

- **固定范围：** `00-inventory.md` 的 04 分片：`runtime-host/application/agent-runtime/**` 与 `runtime-host/application/capabilities/**` 中当前存在的全部 `.ts`。
- **文件计数：** inventory 为 40；Python 从当前主工作树递归枚举为 **40**，逐一以 `Path.read_text(encoding='utf-8')` 全文读取，共 **5,329** 行；二者完全一致。
- **定位方法：** 在全文读取前，使用仓库 `.codegraph` 的 `explore`/`node` 跟踪了 Endpoint/Agent identity、`AgentRuntimeRegistry` 的 adapter/connector/availability/Session workflow 调用链、ACP connector/stdio/JSON-RPC 链，以及 capability scope/target/operation 到 workflow/domain service 的链路。特别确认：`AgentRuntimeRegistry` 被 Session workflow、TeamRun adapter 和 composition 使用；`CapabilityRouter` 是 descriptor 验证后分发到各领域 service 的边界；ACP 在 connector module 装配，`connectRuntimeEndpoint` 完成 declared → connecting → ready/unavailable/disconnected 的连接投影。
- **边界前提（已确认，以下记录均遵守）：** Matcha Platform Core 拥有 Agent/Endpoint identity 与 binding、Capability/Scope/Target grammar、Execution/Receipt/Correlation 的共同语言。各 Domain Module 定义自己的 outbound Port；Runtime Integration 实现 OpenClaw、matcha-agent、ACP 等具体 protocol。OpenClaw 与 matcha-agent 的 LLM loop、tool harness、sandbox、approval 仍属于各自 Native Runtime Edge，不迁入 Matcha。
- **性能表述约定：** 每条提出的 Rust 性能/并发重写均明确旧成本、需保持行为、指标与差分或故障 oracle；纯 type/re-export 没有凭空提出性能优化。

## 已读文件（40）

- `runtime-host/application/agent-runtime/agent-runtime-application-service.ts`
- `runtime-host/application/agent-runtime/contracts/agent-runtime-registry.ts`
- `runtime-host/application/agent-runtime/contracts/runtime-address.ts`
- `runtime-host/application/agent-runtime/contracts/runtime-capability-descriptors.ts`
- `runtime-host/application/agent-runtime/contracts/runtime-endpoint-types.ts`
- `runtime-host/application/agent-runtime/contracts/runtime-identity-contract.ts`
- `runtime-host/application/agent-runtime/contracts/runtime-session-context.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-canonical-adapter.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-client-connector.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-framing.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-identity.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-json-rpc-client.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter.ts`
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport.ts`
- `runtime-host/application/capabilities/agent/agent-run-capability.ts`
- `runtime-host/application/capabilities/agent/agent-skill-config-capability.ts`
- `runtime-host/application/capabilities/agent/agent-tool-config-capability.ts`
- `runtime-host/application/capabilities/agent/subagent-management-capability.ts`
- `runtime-host/application/capabilities/approval/session-approval-capability.ts`
- `runtime-host/application/capabilities/contracts/capability-descriptor.ts`
- `runtime-host/application/capabilities/contracts/capability-registry.ts`
- `runtime-host/application/capabilities/contracts/capability-router.ts`
- `runtime-host/application/capabilities/integration/channel-integration-capability.ts`
- `runtime-host/application/capabilities/license/license-runtime-capability.ts`
- `runtime-host/application/capabilities/model/model-provider-capability.ts`
- `runtime-host/application/capabilities/model/session-model-capability.ts`
- `runtime-host/application/capabilities/platform/platform-runtime-capability.ts`
- `runtime-host/application/capabilities/plugin/plugin-runtime-capability.ts`
- `runtime-host/application/capabilities/runtime/runtime-host-capability.ts`
- `runtime-host/application/capabilities/scheduler/cron-scheduler-capability.ts`
- `runtime-host/application/capabilities/security/security-runtime-capability.ts`
- `runtime-host/application/capabilities/session/session-management-capability.ts`
- `runtime-host/application/capabilities/session/session-prompt-capability.ts`
- `runtime-host/application/capabilities/settings/settings-runtime-capability.ts`
- `runtime-host/application/capabilities/skill/skill-management-capability.ts`
- `runtime-host/application/capabilities/task/task-control-capability.ts`
- `runtime-host/application/capabilities/team/team-runtime-capability.ts`
- `runtime-host/application/capabilities/tool/tool-invoke-capability.ts`
- `runtime-host/application/capabilities/workspace/workspace-file-capability.ts`

---

### runtime-host/application/agent-runtime/agent-runtime-application-service.ts

- **当前 owner：** Delivery-facing application facade；不拥有 runtime 或 capability 状态。
- **职责与关键 symbols：** `AgentRuntimeApplicationService` 仅转发 capabilities 的 list/describe/execute 和 topology snapshot；`readRuntimeConnectorEndpointRequest` 解析 connect/disconnect payload。
- **旧语义与策略：** 非 object/array payload 视为 `{}`；三个 connector ID 均 trim 后必填，缺失返回 400；connect 异步、disconnect 同步，成功包为 `{success:true, readiness}`。
- **状态、存储与副作用：** 无自身状态；调用 registry 改变 connector 生命周期，router 可调用领域 I/O。
- **并发与性能特征：** O(1) facade；连接时成本由 registry/transport 主导。Rust 保持逐字段 400 与 connect/disconnect 同步性；指标为 facade 校验延迟及连接 readiness，差分 oracle 为 API route 的有效/缺字段响应与 lifecycle snapshot。
- **调用/依赖边界：** 上游为 runtime topology/connector delivery route；下游仅为 `AgentRuntimeRegistry`、`CapabilityRouter`。
- **故障、恢复与安全：** connect 抛出的 registry/transport 错误未在此映射；未知字段忽略；不接触 secret。
- **迁移分类：** Preserve：参数 trim、400、delegation。待验证：route 层对 connect 异常的 HTTP 映射。
- **未来 Rust owner：** Delivery；调用 Matcha Platform Core 的 runtime directory/capability facade。
- **Rust 重写与性能判断：** 以薄 command/query handler 实现，不复制 registry 状态；保持 O(1) 校验。无需优化。
- **验证 oracle：** capability/topology route integration、缺少 `protocolId`/`connectorId`/`endpointId` 的 400、连接成功/失败 topology 差分。
- **证据：** 本文件；`contracts/agent-runtime-registry.ts`；CodeGraph `AgentRuntimeApplicationService → CapabilityRouter/AgentRuntimeRegistry`。

### runtime-host/application/agent-runtime/contracts/agent-runtime-registry.ts

- **当前 owner：** 混合 owner：`AgentRuntimeRegistry` 是 Endpoint/Agent identity、session binding、capability directory 的 Platform Core coordinator，同时含 connector 生命周期和 transport selection 的 Runtime Integration orchestration；不是单纯 adapter registry。
- **职责与关键 symbols：** `RuntimeProtocolRegistry`/`RuntimeAdapterRegistry`/`RuntimeConnectorRegistry` 拒绝重复 registration；`RuntimeEndpointCatalog` 用 native 或 connector 复合键索引 endpoint；`RuntimeSessionContextStore` 双向缓存 identity 与 endpointSessionId；`RuntimeTransportRouter` 按 endpoint kind 选择 native adapter 或 connector；主类完成 topology、control state、连接、动态 descriptor 与 session context。
- **旧语义与策略：** endpoint ID 若跨 source 重名，裸 `get(id)` 抛 ambiguous；endpoint agent 必须 declared 或 `acceptsDynamicAgents`。native endpoint 直接 ready，connector 依次 connecting、discovery、readiness，再注册 descriptor；不 ready/异常时 disconnect、清理 endpoint/capability，投影 unavailable。session binding 优先显式 endpoint session ID，再用缓存，再仅当 local key 带 endpoint namespace 时复用，其他情形拒绝。动态 agent/session/team-run descriptor 从 endpoint/runtime scope 派生；team-run 复制 runtime descriptor 并替换 scope。
- **状态、存储与副作用：** 多个进程内 `Map`（protocol、adapter、connector、endpoint、context、control state、connector lifecycle、capability）；`structuredClone` 防止 control-state 引用泄露；透过 adapter/connector 创建 transport、可启动/停止外部进程。
- **并发与性能特征：** 查找 O(1)，`snapshotTopology`、capability filter 和 scope replace/remove 为 O(E+C)；每次 snapshot 克隆/重建 summary。`connectRuntimeEndpoint` 在 `await discovery/readiness` 间没有 per-endpoint serialization，connect/disconnect 可交错，现有单线程事件循环不等于操作线性化。Rust 应以 endpoint-key actor/serial command queue 和不可变 snapshot 处理生命周期，消除旧的全量 summary 构造与交错状态成本；保持重复注册拒绝、disconnect cleanup、动态 descriptor 和 lifecycle 可观察值；指标：并发 connect/disconnect 的线性化、snapshot p95/alloc、endpoint capability staleness；oracle：TS/Rust topology differential、同 endpoint race fault injection、process/readiness failure trace。
- **调用/依赖边界：** 被 Session workflows/catalog/hydration/run、TeamRun role-session adapter、composition 与 topology routes 使用；依赖 shared runtime address/topology、`CapabilityRegistry`、gateway ports；向 concrete adapter/connector 下发 transport。
- **故障、恢复与安全：** 不存在的 protocol/adapter/connector/endpoint、重复/ambiguous ID、未注册 agent 和未显式 binding 都抛错；连接异常清理和 unavailable 记录，context 仅内存、进程重启后不可恢复；launcher env 可含 secret，registry 不 redaction。
- **迁移分类：** Preserve：复合 Endpoint identity、binding 强制性、connector 清理、availability 投影与动态 capability。Intentional Improvement：每 endpoint 串行化 lifecycle 与原子 capability swap，理由是 await 交错和 remove-then-register 观察窗口；兼容影响仅消除中间态。待验证：native endpoint 无 control state 时默认 ready 是否符合所有 runtime 的真实 availability。
- **未来 Rust owner：** 分拆为 **Matcha Platform Core**（endpoint/address/session binding、directory、capability/scope/receipt identity）和 **Runtime Integration**（connector lifecycle、transport resolution、discovery）；进程任务监督原语委托 Foundation Kernel。
- **Rust 重写与性能判断：** Core 以 typed `EndpointRef`/`SessionIdentity` 与 keyed store；Integration 以 endpoint actor 承接 connect/disconnect；Foundation 提供 supervised task/child process。不得把 OpenClaw/matcha-agent 私有 session 或 LLM 状态移入此层。
- **验证 oracle：** `tests/unit/agent-runtime-registry.test.ts`、`runtime-adapter-connector-registry.test.ts`、`runtime-identity-contract.test.ts`；补 property tests（复合键、cache forget、descriptor scope）和 crash/reconnect/race fault injection。
- **证据：** 本文件 `register*`、`rememberSessionIdentity`、`connectRuntimeEndpoint`、`registerConnectorRuntimeEndpoint`、`buildDynamicCapability`；CodeGraph `AgentRuntimeRegistry` callers。

### runtime-host/application/agent-runtime/contracts/runtime-address.ts

- **当前 owner：** Platform Core 的 address/scope/target 公共语言 re-export；当前文件本身无实现状态。
- **职责与关键 symbols：** 从 `shared/runtime-address` 重导出 EndpointRef、SessionIdentity、RuntimeScope、CapabilityTarget 的构造、比较、校验和 canonical key API。
- **旧语义与策略：** 本文件不转换、不默认；真实 grammar 由 shared implementation 决定。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** import-time type/value re-export；无运行时算法或性能提案。
- **调用/依赖边界：** 本分片 registry/router/各 capability 通过此 import path 依赖 shared grammar。
- **故障、恢复与安全：** 错误由被重导出的 assert/validate 函数定义；无 secret/I-O。
- **迁移分类：** Preserve：单一 canonical address grammar，避免双份 Rust 模型。待验证：shared 源文件归其他分片，需在最终总审计核验全部实现。
- **未来 Rust owner：** Matcha Platform Core。
- **Rust 重写与性能判断：** 将实现在 Core crate，使用 opaque/newtype IDs 和 exhaustive enums；保持 key/validation bytes 级兼容，编译期替代该 re-export。
- **验证 oracle：** shared address 单元/property tests 与跨 TS/Rust canonical key/validation corpus。
- **证据：** 本文件全部 export；`CapabilityRegistry`、`CapabilityRouter`、Session/Team capability imports。

### runtime-host/application/agent-runtime/contracts/runtime-capability-descriptors.ts

- **当前 owner：** Platform Core 的 runtime capability projection policy；输入 runtime profile，输出 capability/scope/target grammar 的 descriptor。
- **职责与关键 symbols：** `buildRuntimeEndpointCapabilityDescriptors` 按 chat/tools/approvals/modelSelection 和 runtime-instance/agent/session scope 选择 operations；`endpointMetadata`、`targetAgentMetadata` 写 endpoint 与 agent projection。
- **旧语义与策略：** chat 在 runtime-instance 只发布 `sessions.list`，agent 发布 create+agent.wait，session 发布 prompt/media/abort/load 与 session management 子集；tools 只在 agent/session，approval/model selection 只在 session。缺 agent ID 的默认 agent scope 抛错；operation target kinds 去重。
- **状态、存储与副作用：** 无持久状态或 I/O；返回新 descriptor arrays。
- **并发与性能特征：** 每次连接/动态 scope 构造少量数组与 `Set`，O(operation count)。Rust 保持相同 capability 集合和顺序；指标为 descriptor allocation/连接时延，oracle 为 endpoint capability snapshot differential。
- **调用/依赖边界：** `AgentRuntimeRegistry` 在 connector ready 和 dynamic capability 时调用；依赖 Session/Tool/Approval/Agent operation constants，但不调用领域 service。
- **故障、恢复与安全：** endpoint 既不是 native 也非 connector 时抛错；availability 默认 `available`；无 secret。
- **迁移分类：** Preserve：capability honesty 与 scope 限制。Intentional Improvement：Rust 将 operation matrix 显式声明为表并在编译/启动校验，保持输出不变，防止 descriptor/route 漂移。
- **未来 Rust owner：** Matcha Platform Core；领域 operation ID 由各 Domain Module 提供声明，Core 不拥有其业务实现。
- **Rust 重写与性能判断：** 静态 operation slices + typed projection；消除 JS transient arrays 是次要成本，保持运行时动态 endpoint 发现。指标为注册 alloc 和 descriptor hash，oracle 为所有 capabilities × scopes 矩阵差分。
- **验证 oracle：** registry tests；补 chat/tools/approval/modelSelection 的 scope matrix golden snapshots。
- **证据：** 本文件；`agent-runtime-registry.ts:registerConnectorRuntimeEndpoint/buildDynamicCapability`。

### runtime-host/application/agent-runtime/contracts/runtime-endpoint-types.ts

- **当前 owner：** Platform Core 的跨 runtime contract，含少量 Runtime Integration config (`RuntimeLauncherConfig`)；不拥有具体 runtime 行为。
- **职责与关键 symbols：** Endpoint source/location/lifecycle/profile、session binding/context、capability flags、transport/event/replay/identity/approval protocol interfaces，以及 adapter/connector registration interfaces。
- **旧语义与策略：** lifecycle 固定为 declared/connecting/ready/unavailable/disconnected；transport 中 send/abort/approval 必需，ensure/events/external sessions/model/readiness/discovery 可选；endpoint 允许 static agents 或 dynamic agents；replay 允许 string/sync/async iterable。
- **状态、存储与副作用：** 类型契约，无状态；实现方可进行 process/network/gateway I-O。
- **并发与性能特征：** 无运行时成本；stream 和 async iterable 是背压边界，Rust 必须不把 replay 强制收集为全量内存。
- **调用/依赖边界：** registry、ACP、OpenClaw/matcha-agent adapters、Session canonical projection 共用；依赖 canonical events、gateway ports、shared approval decision。
- **故障、恢复与安全：** `unknown` 被刻意留在 payload/details/notification；launcher `env` 可能敏感，不能进入 topology/public diagnostics；transport 的 stop 为同步可选，取消确认语义未在 contract 表达。
- **迁移分类：** Preserve：core identity/binding、capability flags、unknown protocol payload 边界。Intentional Improvement：将 launcher secret 改为 Foundation secret handle、把 cancellation/outcome 语义补成明确 receipt，兼容影响需通过 adapter contract versioning 验证。
- **未来 Rust owner：** Matcha Platform Core（identity/capability/event/receipt contract）+ Runtime Integration（protocol config/transport trait）；进程、secret、cancel deadline primitive 属 Foundation Kernel。
- **Rust 重写与性能判断：** typed enums/newtypes、async stream trait、opaque raw payload；保持 lazy replay，指标为 replay peak memory、cancel latency、event loss，oracle 为 protocol contract and replay differential/fault injection。
- **验证 oracle：** adapter/connector registry 与 Session workflow contract tests；补 compile-time exhaustive lifecycle and capability support tests。
- **证据：** 本文件；`AgentRuntimeRegistry`、`AcpStdioTransport`、`AcpProtocolAdapter`。

### runtime-host/application/agent-runtime/contracts/runtime-identity-contract.ts

- **当前 owner：** Platform Core 的 message correlation policy helper。
- **职责与关键 symbols：** `RuntimeSessionIdentity` 是 protocol+endpoint ID pair；`buildSessionIdentityScopedMessageId` 用 session identity key、runId、laneKey、role、messageIndex 组成 ID。
- **旧语义与策略：** `runId`/`laneKey` trim 后不得为空；role 与 index 不校验；字段以 `:` 拼接。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** O(length) string construction；无独立优化。Rust 要保持字段和编码，指标为 identity collision=0，oracle 为 corpus 的逐字 ID 差分。
- **调用/依赖边界：** ACP protocol adapter 的 `identityPolicy` 依赖此函数；session key grammar 来自 runtime-address。
- **故障、恢复与安全：** 缺关键 correlation 字段抛错；不泄露 secret，但 ID 可能出现在 logs，应按 session metadata 处理。
- **迁移分类：** Preserve：run/lane 必填与完整字段顺序。待验证：冒号是否可出现在 shared key/role，现有拼接是否可能歧义；未证实前不可擅改。
- **未来 Rust owner：** Matcha Platform Core。
- **Rust 重写与性能判断：** canonical encoder（必要时长度前缀但需版本化）而非散落字符串拼接；现阶段先保持 exact format。
- **验证 oracle：** `runtime-identity-contract.test.ts` 与跨实现 ID vectors/empty run-lane rejection。
- **证据：** 本文件；`acp-protocol-adapter.ts`。

### runtime-host/application/agent-runtime/contracts/runtime-session-context.ts

- **当前 owner：** Platform Core 的 Endpoint-to-local Session binding constructor。
- **职责与关键 symbols：** `buildRuntimeEndpointIdentity` 将 connector/native ref 投影到 identity；`createRuntimeSessionContext` 补齐 binding、local/session key、agent ID。
- **旧语义与策略：** endpointSessionId 必须 trim 后非空；未提供 binding 时以 local session key、identity endpoint/agent 创建；提供 binding 时信任其 local/session endpoint ID（只先校验 top-level endpointSessionId）。
- **状态、存储与副作用：** 无，返回 plain object。
- **并发与性能特征：** 常数对象构造；无性能提案。
- **调用/依赖边界：** 仅由 registry 记忆 identity 时调用，输出被 Session workflows 与 transport 使用。
- **故障、恢复与安全：** 不能在此从 runtime 猜测 remote session ID；空 ID 抛错，避免本地/外部 session 混绑；无 I-O/secret。
- **迁移分类：** Preserve：显式 endpoint session binding。Intentional Improvement：Rust constructor 校验 supplied binding 与 top-level identity/protocol/endpoint 全部一致，理由是 TS 当前仅部分约束；兼容影响为拒绝不一致输入，oracle 为 malformed binding tests。
- **未来 Rust owner：** Matcha Platform Core。
- **Rust 重写与性能判断：** immutable `SessionBinding` value object；保持 constant allocation，指标为 binding mismatch rejection，oracle 为 TS valid vectors 和 malformed negative corpus。
- **验证 oracle：** `runtime-identity-contract.test.ts`、Session catalog/run workflow contract tests。
- **证据：** 本文件；`AgentRuntimeRegistry.rememberSessionIdentity`。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-canonical-adapter.ts

- **当前 owner：** Runtime Integration 的 ACP event-to-canonical-session-event translator。
- **职责与关键 symbols：** `AcpCanonicalAdapter.canTranslate/translate`；tool method sets/classifier；payload readers；stable fingerprint fallback；`base` canonical envelope builder。
- **旧语义与策略：** 只接受 ACP context+object；tool method 且有 toolCallId 产生 started/completed/failed tool event；其他输入产生 message part，assistant final 且有 runId 额外产生 lifecycle done。缺 messageId 时优先 seq，否则 deterministic FNV-like fingerprint；未知/空非-ID message 丢弃。turn/message binding 缺 runtime ID 时使用 synthetic+low confidence；`source:'replay'` 透传。
- **状态、存储与副作用：** 无持久状态；对 raw 使用 `structuredClone`，每个 event 携带原始 payload。
- **并发与性能特征：** 每个 event O(payload size) clone；无 ID fallback 时还排序全部 object keys 及 hash，流量大时成本明显。Rust 应流式翻译并保留 clone/raw 可诊断性（或有界 raw envelope），不得改变 event ID、status、unknown 丢弃；指标为 events/s、p95 translate、alloc/raw retained bytes；oracle 为 ACP event corpus differential 与 malformed/replay fuzz tests。
- **调用/依赖边界：** `AcpProtocolAdapter` 提供其为 `RuntimeEventAdapter`；下游是 Session canonical reducer/projection，而非 ACP runtime 的 LLM loop。
- **故障、恢复与安全：** 解析失败/不认识 event 静默返回空，非 `Error` 载荷保持 unknown raw；raw 可能含 prompt/tool data，公开 projection/logging 必须 redaction，当前文件未做。
- **迁移分类：** Preserve：method aliases、fallback identity、synthetic confidence、final assistant → done。Intentional Improvement：有界/可 redact 的 raw retention，理由是 structuredClone 的未界定 payload 成本与敏感内容风险；兼容影响仅 diagnostics payload，oracle 为 canonical fields differential + redaction leak test。待验证：所有 ACP method aliases 是否覆盖目标 versions。
- **未来 Rust owner：** Runtime Integration（ACP translator）；Canonical Session domain 仍拥有 reducer/state，不迁入此 adapter。
- **Rust 重写与性能判断：** protocol-specific decoder + `RawEvent` capped store; stream one event at a time；保持 sequence、message and run correlation。
- **验证 oracle：** canonical event unit fixtures、`runtime-identity-contract.test.ts`；新增 tool/message/final/error/replay/unknown/large-payload golden corpus。
- **证据：** 本文件；`acp-protocol-adapter.ts`；Session canonical types。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-client-connector.ts

- **当前 owner：** Runtime Integration 的 ACP endpoint connection cache。
- **职责与关键 symbols：** `AcpClientConnector` 实现 connector；endpoint template ID map、transport map、`connect`、`disconnect`、`inspectEndpointReadiness`。
- **旧语义与策略：** connect 只接受本 connector/protocol 的 declared endpoint，按 endpoint ID 缓存并复用 transport；disconnect unknown endpoint 抛、未连接为幂等 no-op，删除后可选 stop；未连接 readiness 是 disconnected，已连接且无 probe 时乐观 connected/ready。
- **状态、存储与副作用：** 两个进程内 Map；`createTransport` 可创建 stdio child，`stop` 杀 child。
- **并发与性能特征：** O(1) map 操作；同一 event loop tick 的 repeated connect 复用，但 connect/disconnect 无 mutex。Rust 用 endpoint-key actor 与 lazy transport cell，消除异步 interleave 的重复/stop-after-reuse 成本；保持 cache/unknown rejection/readiness fallback；指标为 child spawn count、concurrent connect linearizability、disconnect completion；oracle 为 connector unit tests and spawn mock race faults。
- **调用/依赖边界：** registry 连接、transport router 与 ACP composition factory 调用；依赖 protocol/endpoint contracts。
- **故障、恢复与安全：** endpoint mismatch/unknown 抛；transport create error传播；没有跨进程恢复；launcher env 经 transport 处理。
- **迁移分类：** Preserve：template membership、transport cache、disconnect idempotence。Intentional Improvement：serialized lifecycle，理由/兼容影响/oracle 同 registry（消除未定义中间态）。
- **未来 Rust owner：** Runtime Integration；child supervision由 Foundation Kernel。
- **Rust 重写与性能判断：** keyed actor owns transport handle；不让 Platform Core 了解 ACP child。
- **验证 oracle：** `tests/unit/acp-client-connector.test.ts`、`runtime-adapter-connector-registry.test.ts`，新增 concurrent connect/disconnect tests。
- **证据：** 本文件；`AgentRuntimeRegistry.connectRuntimeEndpoint`。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-framing.ts

- **当前 owner：** Runtime Integration 的 ACP/LSP-style JSON-RPC framing codec。
- **职责与关键 symbols：** `encodeAcpJsonRpcMessage` 输出 Content-Length header+JSON；`AcpFrameParser.push` 累积、找 header、验证 length、切 body、JSON parse。
- **旧语义与策略：** header 名大小写不敏感；缺/非法 `Content-Length` 丢弃该 header；不完整 body 留 buffer；JSON parse 或非 object/jsonrpc 2.0 body 静默丢弃。编码以 UTF-8 byte length 写 header。
- **状态、存储与副作用：** parser 保有未消费 string buffer；无 I-O。
- **并发与性能特征：** append/slice 与 repeated `indexOf`，大分片会复制；更关键地，header length 是 UTF-8 bytes，而 parser 将 Buffer 转 UTF-8 JS string 后以 UTF-16 `string.length` 截 body，含非 ASCII JSON 时 byte/character 单位不一致。这是代码可直接证明的 framing **Defect**。Rust 用 byte buffer/bytes codec，保持 valid ASCII/byte-framed messages、指标为 Unicode framing correctness、throughput、buffer high-water；oracle 为 TS defect regression（标记不要求等价）及 Rust fragmented Unicode frame/property fuzz corpus。另需设置最大 header/body/buffer，现有无上限，作为待验证的 DoS 边界改进。
- **调用/依赖边界：** `AcpJsonRpcClient` 写 stdin、解析 stdout；不依赖业务领域。
- **故障、恢复与安全：** malformed input 静默跳过，长无终止数据会保留/增长 buffer；不可把 protocol input 的任意内容记录为 secret-free。
- **迁移分类：** Preserve：header tolerant、fragment accumulation、malformed JSON discard。Defect：Unicode byte length mismatch。Intentional Improvement：buffer caps/backpressure，兼容影响是拒绝超限 peer，需明确 error/teardown receipt。
- **未来 Rust owner：** Runtime Integration（ACP codec）；通用 bounded stream primitive可复用 Foundation Kernel。
- **Rust 重写与性能判断：** `BytesMut` byte-oriented state machine，incremental parse，bounded capacity；不做 JSON full decode 前拷贝。
- **验证 oracle：** `tests/unit/acp-json-rpc-client.test.ts`；新增 ASCII/Unicode、one-byte chunks、multiple frames、bad header/length、oversize/fuzz tests。
- **证据：** 本文件 `Buffer.byteLength` 与 `this.buffer.length`；`acp-json-rpc-client.ts`。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-identity.ts

- **当前 owner：** Runtime Integration 的 ACP protocol/connector stable identifiers。
- **职责与关键 symbols：** `ACP_PROTOCOL_ID = 'acp'`、`ACP_CLIENT_CONNECTOR_ID = 'acp'`。
- **旧语义与策略：** 两个 ID 均为 lowercase literal；它们进入 endpoint composite key、descriptor owner/source 和 topology。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无运行时成本或优化。
- **调用/依赖边界：** ACP adapter/connector/profile 及 composition registration 使用。
- **故障、恢复与安全：** ID 改动会使 persisted/correlated key 不兼容；无 secret。
- **迁移分类：** Preserve：literal identity。待验证：connector ID 与 protocol ID 同值是否刻意的 long-term namespace policy。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** versioned typed constants；保持 wire/topology strings。
- **验证 oracle：** registration/topology golden snapshot。
- **证据：** 本文件；ACP files 和 registry composite key construction。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-json-rpc-client.ts

- **当前 owner：** Runtime Integration 的 ACP stdio JSON-RPC child-process client；child lifetime primitive实际应下沉 Foundation。
- **职责与关键 symbols：** `AcpJsonRpcClient.request/stop/ensureChild/handleMessage`；pending request map keyed JSON-RPC ID；epoch 阻止 stale child callbacks；4,000-char stderr tail。
- **旧语义与策略：** request 默认 30s，timeout 删除 pending 并 reject，不取消 remote request；spawn lazy，child exit/error 只 reject 同 epoch；stop 先置 null/reject all 后 kill；response with missing/stale/unknown ID 静默忽略；JSON-RPC error 原样 reject；next ID 单调递增且不回绕。
- **状态、存储与副作用：** child process、parser、pending promises/timers、stderr string；spawn 合并 `process.env` 与 endpoint env，pipe stdio。
- **并发与性能特征：** 多路 pending O(1)；每 request timer、stderr string concat+slice，未限制 pending 数/ID 溢出策略。Rust Foundation child supervisor + Integration ACP multiplexer 应加 max in-flight/backpressure；保持 timeout、epoch stale isolation、stop rejects-all、stderr tail observable；指标为 in-flight count、timeout/cancel latency、child leak=0、stderr memory；oracle 为 mocked child differential、exit/error/late response/timeout/stop fault tests。
- **调用/依赖边界：** `AcpStdioTransport` 唯一生产构造者；依赖 framing 和 Node child_process。
- **故障、恢复与安全：** child exit/error 清理同 epoch pending，timeout 不杀 child；stderr 可能暴露 credentials/prompt，当前原样进入 readiness details，必须作为 private/redacted diagnostics；env 不得进入 public topology。
- **迁移分类：** Preserve：epoch isolation、pending rejection、5/30s caller timeouts。Intentional Improvement：bounded in-flight、deadline-linked remote cancel和 redacted stderr；兼容影响是 overload 明确拒绝/timeout receipt，oracle 为 overload and secret-redaction tests。待验证：remote ACP 是否支持 generic request cancellation。
- **未来 Rust owner：** Foundation Kernel（supervised process, deadline/cancel, redaction) + Runtime Integration（JSON-RPC correlation and ACP methods）。
- **Rust 重写与性能判断：** child actor owns stdin/stdout reader and pending table; bounded channel avoids unbounded promises; byte codec prevents framing defect。保持 per-epoch late response drop。
- **验证 oracle：** `tests/unit/acp-json-rpc-client.test.ts`；补 in-flight saturation、spawn failure、stale epoch、stderr secret and process leak tests。
- **证据：** 本文件；`acp-framing.ts`、`acp-stdio-transport.ts`。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles.ts

- **当前 owner：** Runtime Integration 的内置 ACP endpoint template catalog；具体 vendor launcher/packaging 属性属于 Native Runtime Edge。
- **职责与关键 symbols：** Claude Code 与 Hermes 两个 `RuntimeEndpointProfile` template 及 `acpEndpointTemplates`。
- **旧语义与策略：** 两者均 default agent、chat/stream/tools/approvals/replay true、model selection false；namespace 与 endpoint ID 对齐。Claude Code 以 `npx --yes @zed-industries/claude-code-acp@latest` 启动，Hermes 为 `hermes acp`。
- **状态、存储与副作用：** immutable objects；真正 launch 在 stdio transport。
- **并发与性能特征：** 常量，零热路径成本；不应做性能优化。`npx @latest` 首启网络/安装成本是现有启动成本，Rust 必须保留“按配置启动”而不是在 Core 预加载；指标是 cold/warm startup、spawn failure；oracle 为 launcher argv/profile snapshot。
- **调用/依赖边界：** ACP connector composition 注册 template；registry 使用 profile 建 endpoint identity/capability。
- **故障、恢复与安全：** `@latest` 是非可复现供应链输入，未固定版本；launcher 环境可能含 secret。此处未声明 auth/sandbox/approval，不能推定 Matcha 拥有这些机制。
- **迁移分类：** Preserve：published profiles/capability honesty/namespaces。Intentional Improvement：发行物锁定或签名的 runtime launcher resolution；兼容影响为更新策略显式化，oracle 为 pinned artifact/integration launch verification。待验证：是否允许配置覆写这些 templates。
- **未来 Rust owner：** Runtime Integration（profile schema/registration）+ Native Runtime Edge（Claude Code/Hermes launcher distribution policy）。
- **Rust 重写与性能判断：** config-deserialized profiles；不在 Platform Core hard-code runtime binary；保留 lazy spawn and namespace behavior。
- **验证 oracle：** ACP connector registration test、profile JSON/argv golden、offline/cold-start failure test。
- **证据：** 本文件；`acp-client-connector.ts`、`acp-stdio-transport.ts`。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter.ts

- **当前 owner：** Runtime Integration 的 ACP protocol adapter 和 transcript replay translator。
- **职责与关键 symbols：** `AcpReplayAdapter.replayTranscript/readLines/parseLine/markReplayPayload`；`AcpProtocolAdapter` 组合 canonical/replay/identity adapters。
- **旧语义与策略：** 逐行先尝试 session transcript parser，失败再尝试 JSON ACP payload；有 transcript messages 时先 yield canonical replay，再 yield ACP payload events；仅 string lines 被消费，空/invalid JSON忽略；replay source 标识通过 shallow copy 加 `source:'replay'`。
- **状态、存储与副作用：** 本地 `transcriptMessages` 与 `acpPayloads` 两个全量 arrays 后才开始 yielding；无 I-O。
- **并发与性能特征：** 输入虽可 async iterable，但会整段 materialize，成本 O(transcript size) memory 且 replay 延迟至 EOF。Rust 可作 intentional streaming improvement：保留 transcript-before-ACP 的可观察顺序需先证明是否必要；若必须该顺序，保留 bounded spool/disk rather than unbounded RAM；指标为 first-event latency、peak memory、event ordering；oracle 为 mixed transcript/ACP replay differential and long-transcript fault benchmark。
- **调用/依赖边界：** 注册为 `RuntimeProtocolAdapter`，Session replay workflow 消费 canonical events；依赖 Session transcript parser/canonical replay（Session domain owns其语义）。
- **故障、恢复与安全：** malformed lines 静默丢弃；raw replay payload会流入 canonical raw；无 checkpoint/offset，重启需上游重放。
- **迁移分类：** Preserve：line acceptance、transcript precedence、source replay、message ID policy。Intentional Improvement：bounded/streamed replay，理由为全量 array；兼容影响（interleaving）必须先由 trace确认，当前为待验证。
- **未来 Rust owner：** Runtime Integration；Session domain 继续拥有 canonical replay reducer/artefact semantics。
- **Rust 重写与性能判断：** async line decoder plus bounded spool; no LLM/session persistence here。
- **验证 oracle：** Session transcript replay tests、ACP canonical golden; add large async iterable and invalid-line ordering corpus。
- **证据：** 本文件；`acp-canonical-adapter.ts`、Session canonical transcript modules。

### runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport.ts

- **当前 owner：** Runtime Integration 的 ACP method mapping transport。
- **职责与关键 symbols：** `AcpStdioTransport.sendPrompt/abortSession/resolveApproval/inspectReadiness/stop` 将 RuntimeSessionTransport 映射到 ACP `session/prompt`、`session/cancel`、`approval/resolve`、`initialize`。
- **旧语义与策略：** 无 launcher 即构造失败；prompt 捕获任意异常并返回 `{success:false,error}`，其余 methods 传播 reject；abort/initialize 固定 5s；abort 接受但不发送 `runId`；readiness 成功附 initialize、epoch、stderr tail，失败返回 unavailable 和同类 details。
- **状态、存储与副作用：** 每 transport 一个 JSON-RPC client/child；stdio process I-O。
- **并发与性能特征：** prompt 并发由 client pending map 支撑；initialize 会 lazy spawn。Rust 保持 method names/payload/5s deadlines 和 prompt 结果化错误；增加 cancellation/deadline supervision 的成本/指标/oracle 见 JSON-RPC client，不重建 LLM loop。
- **调用/依赖边界：** `AcpClientConnector.createTransport` 产生；registry/Session workflows 经 `RuntimeSessionTransport` 使用。
- **故障、恢复与安全：** prompt 与其它 operation 的错误风格不一致是当前 observable semantics；readiness details 包含未 redact stderr，风险由 Foundation redaction 处理；stop kill child。
- **迁移分类：** Preserve：ACP mapping、prompt failure-as-result、readiness phase。待验证：`session/cancel` 未发送 runId 是否 ACP contract 要求或偶然遗漏，未证实不得改变。
- **未来 Rust owner：** Runtime Integration；process/cancel/redaction primitive 为 Foundation Kernel。
- **Rust 重写与性能判断：** thin ACP transport trait implementation over supervised JSON-RPC actor；保持 async payload and failure mapping。
- **验证 oracle：** ACP mock server method/payload/timeout tests、Session abort/approval integration tests、readiness redaction test。
- **证据：** 本文件；`acp-json-rpc-client.ts`、endpoint transport contract。

### runtime-host/application/capabilities/agent/agent-run-capability.ts

- **当前 owner：** Gateway Runtime Integration route adapter for agent-run wait; it does not own agent execution state.
- **职责与关键 symbols：** `AGENT_RUN_CAPABILITY_ID`、`agent.wait`、`createAgentRunCapabilityOperationRoutes`。
- **旧语义与策略：** `runId` 必填 trim；`waitSliceMs` 最小 1000、默认 30000；RPC buffer 最小 0、默认 10000；调用 gateway `agent.wait`，RPC timeout 等于 slice+buffer，成功包 200。
- **状态、存储与副作用：** 无本地状态；gateway RPC/network I-O。
- **并发与性能特征：** 一个长轮询 RPC/调用，默认最多 40s；Rust 保持 slice/buffer math，指标为 wait latency、gateway concurrent waits、timeout rate；oracle 为 exact request/timeout differential and gateway timeout faults。
- **调用/依赖边界：** descriptor builder 将其发布给 agent scope；router dispatch 后到 `GatewayRpcPort`。
- **故障、恢复与安全：** missing runId 400；gateway errors propagate；无 ownership/correlation validation beyond target grammar，待由 core receipt/Domain policy确认。
- **迁移分类：** Preserve：defaults/clamps/RPC method。待验证：agent wait ownership authorization 不在本文件。
- **未来 Rust owner：** Runtime Integration（gateway port implementation）+ Matcha Platform Core（run/receipt correlation grammar）。
- **Rust 重写与性能判断：** bounded async wait over gateway port，避免 busy polling；保持 one RPC per slice。
- **验证 oracle：** gateway RPC fixture and capability route tests with default/minimum timeouts。
- **证据：** 本文件；`runtime-capability-descriptors.ts`。

### runtime-host/application/capabilities/agent/agent-skill-config-capability.ts

- **当前 owner：** Delivery capability adapter for the Subagent Domain’s skill configuration port.
- **职责与关键 symbols：** `agent.skill-config` get/set descriptors、`handleSubagentTarget`、route factory。
- **旧语义与策略：** target 必为非空 subagent；input 中 `agentId`/`subagentId` 若给出必须一致；将 target ID 强制写回两字段后调用 service。
- **状态、存储与副作用：** 无状态；service 读写 subagent configuration。
- **并发与性能特征：** O(1) validation；不自行缓存。Rust 保持 target wins 的 rewrite，指标为 validation latency/config conflict result，oracle 为 target/input mismatch differential。
- **调用/依赖边界：** `CapabilityRouter` → `AgentSkillConfigService`；domain storage/projection不在本文件。
- **故障、恢复与安全：** 目标错误 400；无 service exception conversion；skill config的文件/secret语义由 Subagent Domain 负责。
- **迁移分类：** Preserve：anti-confused-deputy target binding。Intentional Improvement：Domain port 接受 typed `SubagentId`，让 delivery 无需双字段重写；保持 external payload response。
- **未来 Rust owner：** Delivery（capability adapter）+ Domain Module（Subagent skill-config port/state）。
- **Rust 重写与性能判断：** typed target binding then domain command；无额外性能优化。
- **验证 oracle：** subagent capability tests/route integration；get/set, missing/mismatched IDs。
- **证据：** 本文件；`CapabilityRouter`、`application/subagents/agent-skill-config-service.ts`。

### runtime-host/application/capabilities/agent/agent-tool-config-capability.ts

- **当前 owner：** Delivery capability adapter for Subagent Domain’s tool configuration port.
- **职责与关键 symbols：** `agent.tool-config` get/set、同形 `handleSubagentTarget`。
- **旧语义与策略：** 与 skill-config 相同：required subagent target、optional input IDs必须一致、target 覆盖传入 agent/subagent IDs。
- **状态、存储与副作用：** 无；delegate `AgentToolConfigService`。
- **并发与性能特征：** O(1) binding；无 cache/queue。Rust 保持 rejection and canonical target propagation；指标/差分 oracle 为 get/set target mismatch cases。
- **调用/依赖边界：** router → Subagent Domain service。
- **故障、恢复与安全：** 400 防跨 agent config write；service persistence failure外传。
- **迁移分类：** Preserve：target binding。Intentional Improvement：typed Domain command，理由同 skill-config，外部兼容由 capability contract tests保护。
- **未来 Rust owner：** Delivery + Domain Module（Subagent）。
- **Rust 重写与性能判断：** 最薄 route adapter；不将 tool harness policy迁入 Matcha。
- **验证 oracle：** capability target negative tests、Subagent Domain config persistence tests。
- **证据：** 本文件；`agent-skill-config-capability.ts` parallel policy。

### runtime-host/application/capabilities/agent/subagent-management-capability.ts

- **当前 owner：** Delivery adapter for Subagent Domain management operations, not ownership of runtime-native subagent loop.
- **职责与关键 symbols：** eleven `subagents.*` operations；agent/subagent target validation helpers；factory maps to `SubagentRuntimeService`.
- **旧语义与策略：** list/display config require agent target; create permits a blank subagent ID target but update/delete/config/files require nonempty one; supplied `agentId`/`subagentId` must match target and then target is authoritative. Agent-target path accepts a supplied `subagentId` only if equal to agent target.
- **状态、存储与副作用：** 无；delegate service that owns config/file I-O.
- **并发与性能特征：** constant validation; file operations may dominate downstream. Rust preserves target gates; metrics: rejected confused-deputy requests, downstream file latency; oracle: operation × target-required matrix and service mock differential.
- **调用/依赖边界：** router → `SubagentRuntimeService`; capability declaration may be projected by other composition.
- **故障、恢复与安全：** 400 before service side effect; no auth here; agent file content may be sensitive and needs Subagent Domain access control/redaction.
- **迁移分类：** Preserve：per-operation target requirements and canonical ID injection. 待验证：blank target for create is intentional UX versus overly broad target; do not narrow without route/client evidence.
- **未来 Rust owner：** Delivery + Domain Module（Subagent）；native runtime’s own harness/config remains Native Runtime Edge.
- **Rust 重写与性能判断：** operation enum mapped to typed domain port; no generic dynamic dispatch in domain; keep boundary validations.
- **验证 oracle：** subagent routes tests; exhaustive table tests for list/create/update/files and mismatch rejection.
- **证据：** 本文件；`application/subagents/service.ts` dependency surface。

### runtime-host/application/capabilities/approval/session-approval-capability.ts

- **当前 owner：** Delivery adapter over Session Domain approval commands.
- **职责与关键 symbols：** `session.approval`, list/resolve descriptors; `withSessionTargetValidation` and `withApprovalTargetValidation`.
- **旧语义与策略：** session or approval target required respectively; supplied sessionKey/sessionIdentity/approval ID must match target when present; wrapper injects canonical target identity/key/ID before `SessionCommandService` call.
- **状态、存储与副作用：** no local state; Session Domain reads pending approvals/resolves runtime approval side effect.
- **并发与性能特征：** O(1) structural comparison; approval resolution race/idempotence belongs Session Domain. Rust preserves pre-side-effect binding; metrics: mismatch rejections, resolve latency/outcome; oracle: session/approval mismatch and duplicate resolve fault tests.
- **调用/依赖边界：** router → Session command service → Session workflows/runtime transport.
- **故障、恢复与安全：** local badRequest is equivalent 400 shape; service errors pass through; decision is not authorized here and raw approval content remains Session Domain concern.
- **迁移分类：** Preserve：target identity pinning and injection. Intentional Improvement：use typed `SessionIdentity`/`ApprovalId` command fields instead of mutable input map; external request behavior preserved.
- **未来 Rust owner：** Delivery + Domain Module（Session）；core owns only common identity/target grammar.
- **Rust 重写与性能判断：** typed request extractor; no caching. Maintain comparison semantics and response status.
- **验证 oracle：** session approval workflow/service tests, capability negative corpus.
- **证据：** 本文件；`SessionCommandService` calls; shared runtime address comparisons。

### runtime-host/application/capabilities/contracts/capability-descriptor.ts

- **当前 owner：** Platform Core public capability descriptor type re-export.
- **职责与关键 symbols：** re-exports `CapabilityDescriptor`, operation descriptor, support level, availability from shared model.
- **旧语义与策略：** no transformation or defaults.
- **状态、存储与副作用：** none.
- **并发与性能特征：** type/export only; no performance proposal.
- **调用/依赖边界：** registry, router, every capability declaration import through it.
- **故障、恢复与安全：** semantics depend on shared source outside this shard; no secret.
- **迁移分类：** Preserve：one shared descriptor ABI. 待验证：shared implementation is audited in its own shard before final consolidation.
- **未来 Rust owner：** Matcha Platform Core.
- **Rust 重写与性能判断：** common Core crate contract; compile-time sharing replaces re-export.
- **验证 oracle：** descriptor serialization/capability snapshot cross-language schema tests.
- **证据：** file contents and all capability imports.

### runtime-host/application/capabilities/contracts/capability-registry.ts

- **当前 owner：** Matcha Platform Core’s in-memory capability directory.
- **职责与关键 symbols：** metadata assertion; endpoint-scope equivalence; `CapabilityRegistry.register/registerMany/replace/remove/list/get`.
- **旧语义与策略：** registration requires nonempty policy/owner/route IDs, matching scopeKind, valid scope, nonempty operations/target kinds and declared target kinds; descriptor key is `id:scope-key`; duplicate rejects. Runtime endpoint replacement removes all same endpoint scopes (session scopes compare their endpoint) then registers supplied descriptors.
- **状态、存储与副作用：** process-local descriptor `Map`; no I-O.
- **并发与性能特征：** get O(1), list/filter/remove O(N). `replace` does remove then iterative register: an invalid later descriptor leaves a partially rebuilt directory—factual mutation sequence. Rust should validate a complete replacement and atomically swap endpoint slice; eliminate scan/partial-observation cost while preserving duplicate/validation behavior. Metrics: replace latency/alloc, atomic visibility, descriptor count; oracle: invalid batch fault test, topology/capability differential.
- **调用/依赖边界：** AgentRuntimeRegistry owns an instance; provider/runtime composition registers domain descriptors; router resolves via registry callback.
- **故障、恢复与安全：** invalid/duplicate throws rather than 400; memory lost on restart; descriptor metadata must not itself contain secrets.
- **迁移分类：** Preserve：descriptor validation/key grammar. Intentional Improvement：transactional replacement; compatibility impact eliminates partial intermediate state, proven by fault oracle.
- **未来 Rust owner：** Matcha Platform Core.
- **Rust 重写与性能判断：** validate vector then replace per-endpoint immutable index under keyed lock/actor; retain lookup key exactness.
- **验证 oracle：** `tests/unit/capability-registry.test.ts`, `agent-runtime-registry.test.ts`; add invalid second descriptor atomicity test.
- **证据：** this file; `AgentRuntimeRegistry.registerConnectorRuntimeEndpoint`.

### runtime-host/application/capabilities/contracts/capability-router.ts

- **当前 owner：** Matcha Platform Core capability execution/target gate; individual operation business behavior belongs Domain/Integration route factories.
- **职责与关键 symbols：** request/context/route types; `CapabilityRouter.execute`; descriptor operation WeakMap index and operation Map.
- **旧语义与策略：** validates id/operation/scope, fetches descriptor, exact scope key match, advertised operation, target required/kind/belongs-to-scope, then forbids `input.runtimeAddress`; nonobject input becomes empty domainInput. Route table is eager or lazily built once and duplicate key throws. Handler exceptions propagate.
- **状态、存储与副作用：** `Map` of handlers and `WeakMap` descriptor operation indices; invokes arbitrary domain/integration side effects.
- **并发与性能特征：** first lazy route resolution O(routes), then O(1) lookup; descriptor index avoids repeat operation scans. Rust keeps lazy/eager startup semantics and O(1) keyed dispatch; metric: cold route-build and per-execute p95/alloc; oracle: validation rejection corpus and duplicate route startup test.
- **调用/依赖边界：** `AgentRuntimeApplicationService` forwards execute; all capability files produce routes; address grammar comes from Platform Core.
- **故障、恢复与安全：** wrong request returns 400; unknown descriptor get may throw rather than normalized response; defense forbids caller-supplied `runtimeAddress`, preventing address smuggling; no authorization policy in router.
- **迁移分类：** Preserve：validation order and scope/target authority. Intentional Improvement：typed command envelope and structured error taxonomy; compatibility requires preserving 400 contract at Delivery; oracle covers all negative cases. 待验证：whether missing descriptor should be 400/404 rather than exception at route layer.
- **未来 Rust owner：** Matcha Platform Core.
- **Rust 重写与性能判断：** static operation registry validated at composition; typed `CapabilityExecution`; retain domain outbound ports and do not make Core execute domain state machines.
- **验证 oracle：** `tests/unit/team-runtime-capability.test.ts`, capability route integration, property test for target scope containment and runtimeAddress rejection.
- **证据：** this file; CodeGraph `AgentRuntimeApplicationService → CapabilityRouter`.

### runtime-host/application/capabilities/integration/channel-integration-capability.ts

- **当前 owner：** Delivery adapter for Channel Domain integration operations.
- **职责与关键 symbols：** `integration.channel` operations; target validators and `channelInputFromTarget`.
- **旧语义与策略：** probe needs no target; channel/pairing operations require exact target kind; target channelType/accountId and pairingId↔input `code` must equal after trim. Target replaces those fields before service call; delete only passes target channel type.
- **状态、存储与副作用：** none; ChannelService may probe/connect/login/delete config I-O.
- **并发与性能特征：** constant validation; channel network/session I-O downstream. Rust preserves target-derived input; metric: pairing mismatch rejection, connect/login lifecycle latency; oracle: per-operation channel/pairing mismatch differential and service integration faults.
- **调用/依赖边界：** router → `ChannelService`; capability grammar from Core.
- **故障、恢复与安全：** local 400 prevents target/input confusion; QR/pairing credentials must not be emitted by generic logs; auth/retry are Channel Domain policy.
- **迁移分类：** Preserve：channel/pairing binding and input field mapping. Intentional Improvement：typed ChannelTarget command port; preserve API map.
- **未来 Rust owner：** Delivery + Domain Module（Channel）。
- **Rust 重写与性能判断：** thin validated delivery projection; no protocol connector implementation here.
- **验证 oracle：** `runtime-host-process-channel-routes.test.ts`, Channel service tests, target equality table.
- **证据：** this file; `application/channels/service.ts` dependency interface.

### runtime-host/application/capabilities/license/license-runtime-capability.ts

- **当前 owner：** Delivery adapter for License Domain service.
- **职责与关键 symbols：** `license.runtime`, validate/revalidate/clear; `requireLicenseTargetSubject`.
- **旧语义与策略：** all routes require license target subject `key`; validate forwards body, revalidate/clear ignore body and call stored-license actions.
- **状态、存储与副作用：** none; LicenseService accesses persisted license state/network validation.
- **并发与性能特征：** O(1) gate; downstream validation I-O. Rust keeps subject gate; metrics are validation latency and state mutation outcomes; oracle targets wrong subject and valid stored-license flows.
- **调用/依赖边界：** router → `LicenseService`.
- **故障、恢复与安全：** 400 for wrong target; license key is sensitive and must not echo in receipts/logs; current file does not redact.
- **迁移分类：** Preserve：subject key gate and body forwarding rules. Intentional Improvement：private secret handling/redacted receipt at Foundation/License boundary; compatibility preserves service result shape.
- **未来 Rust owner：** Delivery + Domain Module（License）；secret/redaction mechanisms为 Foundation Kernel。
- **Rust 重写与性能判断：** typed `LicenseSubject::Key`; no optimization beyond not copying secret body into logs.
- **验证 oracle：** license route/service tests, secret-redaction log test.
- **证据：** this file; `application/license/service.ts`.

### runtime-host/application/capabilities/model/model-provider-capability.ts

- **当前 owner：** Delivery adapter for Provider Accounts/Models/Capability-Routing Domains.
- **职责与关键 symbols：** nineteen `providers.*`, `providerModels.*`, `capabilityRouting.*` operations; `requireTargetBinding`.
- **旧语义与策略：** list/read-all need none; target kind must match and supplied account/vendor/flow/credential/capability ID must agree when binding is specified; missing explicitly required binding returns 400. It deliberately calls `getApiKey` and returns its result wrapped 200.
- **状态、存储与副作用：** no state; account secret store, OAuth, model catalog and routing storage/network are downstream.
- **并发与性能特征：** O(binding fields); OAuth and model I-O dominate. Rust preserves target binding and operation mapping; metrics: OAuth completion latency, catalog list/read throughput, target rejection; oracle: operation matrix, OAuth fault/retry traces, account/model differential.
- **调用/依赖边界：** router → `ProviderAccountsService`, `ProviderModelsApplicationService`, `CapabilityRoutingApplicationService`.
- **故障、恢复与安全：** raw API key retrieval is a concrete secret exposure boundary. This file proves the operation exists but not caller authorization/redaction; therefore public exposure is **待验证**, not declared safe. Rust must give Provider Domain a private credential outbound port and make Delivery return only authorized/redacted projection unless an explicitly private route contract proves otherwise; test secret nonappearance in topology/audit/log/unauthorized receipt.
- **迁移分类：** Preserve：target/input correlation, OAuth/model operation names. Intentional Improvement：private credential projection, reason is raw key operation; compatibility impact must be explicitly versioned/approved. 待验证：current auth layer and intended consumer of `getApiKey`.
- **未来 Rust owner：** Delivery + Domain Module（Provider）；Foundation Kernel owns secret/redaction machinery, not Platform Core.
- **Rust 重写与性能判断：** typed account/credential/OAuth targets and private secret handle; do not optimize by caching credentials in capability directory.
- **验证 oracle：** provider capability routes, OAuth integration fixtures, credential redaction and authorized-private-port tests.
- **证据：** this file `providers.getApiKey`; provider services in `application/providers/**`.

### runtime-host/application/capabilities/model/session-model-capability.ts

- **当前 owner：** Delivery adapter for Session Domain model-selection command.
- **职责与关键 symbols：** `session.modelSelection`, sole `sessions.patchModel` route.
- **旧语义与策略：** descriptor requires `model-selection` target; router enforces generic target/scope, then route forwards raw `context.input` to `patchSession` without route-specific identity/model comparison.
- **状态、存储与副作用：** none; session model update and runtime patch downstream.
- **并发与性能特征：** constant dispatch; model patch transport latency dominates. Rust preserves generic validation; metric: patch latency/failure and target mismatch rejection; oracle: model-selection target and Session workflow differential.
- **调用/依赖边界：** router → `SessionCommandService.patchSession` → Session model-selection workflow/runtime transport.
- **故障、恢复与安全：** no local exception mapping; exact model authorization/availability is Session/Runtime policy.
- **迁移分类：** Preserve：operation and generic target gate. 待验证：whether target model/identity needs adapter-level exact binding like other Session operations; no evidence here to classify a defect.
- **未来 Rust owner：** Delivery + Domain Module（Session）。
- **Rust 重写与性能判断：** typed session model command; retain dynamic runtime capability check rather than hard-code provider policy.
- **验证 oracle：** session model selection workflow tests, capability scope/target negative corpus。
- **证据：** this file; `runtime-capability-descriptors.ts` publishes only for session scope.

### runtime-host/application/capabilities/platform/platform-runtime-capability.ts

- **当前 owner：** Delivery adapter for Platform Runtime Domain and Toolchain Domain.
- **职责与关键 symbols：** `platform.runtime` operations; abort run and native tool validators.
- **旧语义与策略：** start/upsert wrap awaited results 200; reconcile/install-uv return 202 job receipt; abort requires runtime-job target whose jobId equals input runId; install requires tool target equal to one of toolId/source toolId/id/spec; other endpoint-target operations rely generic router scope validation.
- **状态、存储与副作用：** none; platform run/tool state and uv process install downstream.
- **并发与性能特征：** operations can enqueue long jobs; no local queue. Rust must preserve 200 vs 202 distinction and target gates; metric: job submission latency, queue depth, tool reconcile duration; oracle: response-status and job receipt differential, install failure injection.
- **调用/依赖边界：** router → `PlatformService` and `ToolchainUvService`.
- **故障、恢复与安全：** validation returns 400; async job recovery/cancel owns Domain/Foundation job supervisor; native tool source may be untrusted, validation is identity not supply-chain validation.
- **迁移分类：** Preserve：sync/accepted response statuses and target matches. Intentional Improvement：use Foundation supervised job receipt/cancel primitives while Platform Domain retains tool state; compatibility via receipt/status differential.
- **未来 Rust owner：** Delivery + Domain Module（Platform Runtime/Toolchain）；Foundation Kernel owns job supervision.
- **Rust 重写与性能判断：** route emits typed commands/receipts; bounded worker supervision reduces untracked long process cost while keeping accepted semantics.
- **验证 oracle：** platform runtime and toolchain workflow tests; 200/202 target/error contract tests.
- **证据：** this file; Platform and Toolchain service interfaces.

### runtime-host/application/capabilities/plugin/plugin-runtime-capability.ts

- **当前 owner：** Delivery adapter for Plugin Domain runtime enablement.
- **职责与关键 symbols：** `plugin.runtime`, `plugins.setEnabled`, `validatePluginTargetInput`.
- **旧语义与策略：** requires nonempty plugin target; input `pluginIds` must be an array of exactly that one identical ID; otherwise 400.
- **状态、存储与副作用：** none; PluginRuntimeService changes plugin state/config.
- **并发与性能特征：** O(1) length/equality check; downstream lifecycle I-O dominates. Rust keeps single-plugin capability invocation, metric plugin enable completion/rollback, oracle single/multiple/mismatch input table.
- **调用/依赖边界：** router → PluginRuntimeService.
- **故障、恢复与安全：** prevents broad multi-plugin mutation under one target; plugin installation/privilege policy is Plugin Domain/Native Edge concern.
- **迁移分类：** Preserve：single-target anti-broadening rule. Intentional Improvement：typed `PluginId` command; keep external `pluginIds` compatibility at Delivery.
- **未来 Rust owner：** Delivery + Domain Module（Plugin）。
- **Rust 重写与性能判断：** one typed command per target; no speculative batch path.
- **验证 oracle：** plugin runtime route tests, lifecycle failure/rollback tests.
- **证据：** this file; `application/plugins/plugin-runtime-service.ts`.

### runtime-host/application/capabilities/runtime/runtime-host-capability.ts

- **当前 owner：** Delivery adapter for Runtime Host/Gateway operational services.
- **职责与关键 symbols：** `runtime.host` plus diagnostics operation; `validateRuntimeJobTargetInput`.
- **旧语义与策略：** prepare/lifecycle/ready forward body; auto-approve has no input; runtimeJob requires target/input same nonempty job ID; diagnostics forwards body although descriptor target is runtime-endpoint.
- **状态、存储与副作用：** none; gateway launch/lifecycle/job store/diagnostics I-O downstream.
- **并发与性能特征：** O(1) validation; long lifecycle/diagnostics job costs downstream. Rust preserves operation mapping/status from services, metrics job lookup/readiness/diagnostic duration, oracle lifecycle and job target differential.
- **调用/依赖边界：** router → `RuntimeHostService`, `GatewayService`.
- **故障、恢复与安全：** approval auto-approve is privileged and this adapter has no authorization check; target scope policy comes router; diagnostics may include sensitive data and needs Foundation redaction.
- **迁移分类：** Preserve：job ID binding and body forwarding. 待验证：authorization and endpoint-target binding for diagnostics; must be decided from delivery/auth code before migration.
- **未来 Rust owner：** Delivery + Domain Module（Environment/Runtime Host）；Foundation Kernel owns diagnostics redaction/job supervision.
- **Rust 重写与性能判断：** explicit privileged command authorization at Delivery policy boundary, no runtime state in adapter.
- **验证 oracle：** runtime host route tests, gateway readiness fixture, authorization/redaction test to add.
- **证据：** this file; runtime-host/gateway services.

### runtime-host/application/capabilities/scheduler/cron-scheduler-capability.ts

- **当前 owner：** Delivery adapter for Cron Domain.
- **职责与关键 symbols：** `scheduler.cron`, CRUD/toggle/trigger routes; `validateCronJobTargetInput`.
- **旧语义与策略：** create forwards domain input; others require cron-job target and exact input `jobId` or `id`; update uses `jobId` + opaque `updates`, delete reads jobId, toggle/trigger forward full body.
- **状态、存储与副作用：** none; schedule persistence/triggering is Cron Domain.
- **并发与性能特征：** constant gate; trigger scheduling workload downstream. Rust preserves `id` versus `jobId` compatibility; metrics trigger enqueue delay, duplicate execution/retry, oracle per-operation field mapping differential and schedule fault tests.
- **调用/依赖边界：** router → `CronService`.
- **故障、恢复与安全：** 400 precondition; cron idempotency/lease/recovery not represented here.
- **迁移分类：** Preserve：per-operation field naming and target equality. Intentional Improvement：typed Cron command normalizes ID internally while Delivery preserves input aliases.
- **未来 Rust owner：** Delivery + Domain Module（Cron）。
- **Rust 重写与性能判断：** domain scheduler has its own locks/recovery; this adapter remains pure.
- **验证 oracle：** `cron-service-delivery.test.ts`, runtime-host cron routes, job-id mismatch tests.
- **证据：** this file; `application/cron/service.ts`.

### runtime-host/application/capabilities/security/security-runtime-capability.ts

- **当前 owner：** Delivery adapter for Security Domain operations/jobs.
- **职责与关键 symbols：** eleven `security.*` descriptors/routes; remediation target validator; feed URL reader.
- **旧语义与策略：** policy write/sync direct; audits/emergency/integrity/scan/advisory/remediation job submissions return 202; apply requires target/input remediationId, rollback snapshotId exact equality; `feedUrl` is passed as-is or null.
- **状态、存储与副作用：** none; Security service persists policy and launches gateway/domain work.
- **并发与性能特征：** constant validation; jobs are long-running. Rust preserves accepted receipt behavior and remediation anti-confusion binding; metrics job enqueue, audit duration, rollback correctness; oracle job receipt/cancel/failure traces and target mismatch corpus.
- **调用/依赖边界：** router → `SecurityRuntimeService` → Security workflows/gateway operations.
- **故障、恢复与安全：** policy/remediation privileged; no authorization here; external advisory URL is unvalidated at this adapter and downstream SSRF policy is outside evidence; security logs/results require redaction.
- **迁移分类：** Preserve：202 semantics/target equality. 待验证：feed URL validation/auth ownership. Intentional Improvement：Foundation job receipts and secret-redacted audit storage, with status/receipt differential.
- **未来 Rust owner：** Delivery + Domain Module（Security）；Foundation Kernel for task supervision/redaction.
- **Rust 重写与性能判断：** typed remediation command, no generic synchronous blocking; preserve job enqueue rather than await audit.
- **验证 oracle：** `security-runtime-service.test.ts`, security workflow tests, feed URL/auth and remediation rollback fault tests.
- **证据：** this file; `SecurityOperationsWorkflow` CodeGraph path.

### runtime-host/application/capabilities/session/session-management-capability.ts

- **当前 owner：** Delivery adapter for Session Domain management, not owner of canonical timeline or runtime transport.
- **职责与关键 symbols：** `session.management` ten operations; common session target wrapper.
- **旧语义与策略：** list forwards raw input (runtime-endpoint target generic-validated); all other operations require session target, reject conflicting supplied sessionKey/identity, then inject canonical target values before command service.
- **状态、存储与副作用：** none; Session command service operates catalog/state/storage.
- **并发与性能特征：** O(identity compare); downstream catalog/file/network cost. Rust preserves injection before side effects; metrics session command p95, conflict rejection, command idempotence belongs Session Domain; oracle all management operations target mismatch differential.
- **调用/依赖边界：** router → `SessionCommandService` → Session workflows/catalog/runtime registry.
- **故障、恢复与安全：** local manual 400 shape; service exceptions propagate; session metadata may be sensitive but no raw data handled here.
- **迁移分类：** Preserve：SessionIdentity is target authority. Intentional Improvement：share typed session-target extractor with approval/prompt adapters to prevent drift, while preserving each operation matrix.
- **未来 Rust owner：** Delivery + Domain Module（Session）。
- **Rust 重写与性能判断：** no duplicate session state in Core; exact target equals implementation at Delivery.
- **验证 oracle：** session command/coordinator tests and operation × mismatched identity property corpus.
- **证据：** this file; `session-approval-capability.ts`, `session-prompt-capability.ts` parallel wrapper.

### runtime-host/application/capabilities/session/session-prompt-capability.ts

- **当前 owner：** Delivery adapter for Session prompt/lifecycle commands; media path uses Gateway Integration.
- **职责与关键 symbols：** `session.prompt`, create/load/prompt/media/abort; session target wrapper; media dependencies.
- **旧语义与策略：** create forwards raw input; session methods pin session target identity. sendWithMedia requires both filesystem and gateway or 400; normalizes media input, gateway send failure maps to 500, success to 200 `{success:true,result}`. Other service results pass through.
- **状态、存储与副作用：** no local state; command/prompt services and file/gateway I-O.
- **并发与性能特征：** wrapper O(1); media upload/read can dominate. Rust maintains optional runtime support and 400/500/200 mapping; metrics media success latency/bytes, failure mapping, oracle media fixture differential and gateway/filesystem fault injection.
- **调用/依赖边界：** router → SessionCommand/Prompt service; media → RuntimeFileSystemPort/GatewayChatPort.
- **故障、恢复与安全：** media payload/path can expose files; file scope enforcement is not in this adapter (workspace capability has stronger target checks); gateway errors only map through `sendWithMediaViaGateway` result.
- **迁移分类：** Preserve：session pinning, optional media behavior/status. 待验证：relationship between media prompt file authorization and workspace scope must be audited in File/Session domains before Rust design.
- **未来 Rust owner：** Delivery + Domain Module（Session）；media gateway implementation Runtime Integration.
- **Rust 重写与性能判断：** streaming upload through bounded file/gateway port rather than full buffering if existing helper permits; preserve normalized payload/result. Metrics/oracle as above.
- **验证 oracle：** Session prompt route tests, send-media integration fixture, missing-dependency/invalid payload/error cases.
- **证据：** this file; `application/chat/send-media.ts` and Session services.

### runtime-host/application/capabilities/settings/settings-runtime-capability.ts

- **当前 owner：** Delivery adapter for Settings Domain.
- **职责与关键 symbols：** `settings.runtime`, patch/reset/setValue routes.
- **旧语义与策略：** patch forwards body; reset ignores target/input; setValue trim-extracts `key` and forwards raw `value`; descriptor says setting target but no route-specific target/key comparison.
- **状态、存储与副作用：** none; SettingsService persistence/config projection downstream.
- **并发与性能特征：** O(1); config write cost downstream. Rust preserves pass-through and empty-key behavior delegated to service; metrics write latency/conflict, oracle settings target/key and reset differential.
- **调用/依赖边界：** router → SettingsService.
- **故障、恢复与安全：** generic router scope/target kind validation applies; exact setting authority is not enforced here; settings may contain sensitive values depending on domain policy.
- **迁移分类：** Preserve：current forwarding semantics. 待验证：target setting key must match `setValue` key; lacking evidence, do not call the absent check a defect.
- **未来 Rust owner：** Delivery + Domain Module（Settings）。
- **Rust 重写与性能判断：** typed Settings port with target binding decision after policy audit; no cache here.
- **验证 oracle：** settings route/service tests; add explicit target-key mismatch behavior test before changing it.
- **证据：** this file; `application/settings/service.ts`.

### runtime-host/application/capabilities/skill/skill-management-capability.ts

- **当前 owner：** Delivery adapter for Skill and ClawHub Domains.
- **职责与关键 symbols：** `skill.management`, twelve skill/ClawHub operations; `readSkillLocator`.
- **旧语义与策略：** update/import forward raw body; export/refresh/login/open readme/path await and wrap 200; install/uninstall enqueue and wrap 202. Locator prefers `skillKey`, otherwise slug, optionally forwards slug/baseDir; no route-specific skill target/input equality check.
- **状态、存储与副作用：** none; Skill storage/bundle I-O, ClawHub CLI/network/open-path side effects downstream.
- **并发与性能特征：** short queries await; long install/uninstall are jobs. Rust preserves 200 versus 202 and locator precedence; metrics bundle transfer duration, job queue/backpressure, oracle status/locator differential and install failure/retry trace.
- **调用/依赖边界：** router → `SkillsService`/`ClawHubService`.
- **故障、恢复与安全：** local paths and bundle contents are untrusted/sensitive; no target binding in this file beyond router kind/scope. Current source strategy remains domain policy, not a generic capability concern.
- **迁移分类：** Preserve：status wrappers/locator precedence. 待验证：whether skill target must be bound to input for all mutation/open operations. Intentional Improvement：supervised background receipt for transfers, preserving accepted semantics.
- **未来 Rust owner：** Delivery + Domain Module（Skill）；Foundation Kernel job/file primitives.
- **Rust 重写与性能判断：** typed SkillLocator and bounded transfer job; no Core-owned skill catalog.
- **验证 oracle：** skill install/runtime workflow tests, locator golden, job receipt and path-security fault tests.
- **证据：** this file; `application/skills/service.ts`, `clawhub.ts`.

### runtime-host/application/capabilities/task/task-control-capability.ts

- **当前 owner：** Delivery adapter for Task Domain background-task control.
- **职责与关键 symbols：** `task.control`, output/stop; `validateTaskTargetInput`, owner match helpers.
- **旧语义与策略：** target must be task, exact taskId, nonempty owner; owner must match input SessionIdentity or TeamRun IDs and request scope. Only session/team-run owners are accepted.
- **状态、存储与副作用：** none; Task service reads output/stops task.
- **并发与性能特征：** O(1) target checks; stop/output workload downstream. Rust keeps owner isolation and target authority; metrics stop latency, output stream/retention, cross-owner rejection; oracle session/team-run task differential and stop-race fault tests.
- **调用/依赖边界：** router → `TaskManagerService`; scopes depend Platform Core grammar, but task facts/leases are Domain-owned.
- **故障、恢复与安全：** prevents cross-session/team task access before side effect; no cancellation receipt semantics in adapter.
- **迁移分类：** Preserve：owner-to-input-to-scope triple match. Intentional Improvement：Task Domain owns typed outbound task port and Foundation cancellation/receipt primitive; compatibility preserves stop/output responses.
- **未来 Rust owner：** Delivery + Domain Module（Task）；Foundation Kernel owns task supervision/cancel primitive.
- **Rust 重写与性能判断：** task owner key is typed enum; bounded output cursor rather than unbounded string is a domain decision, measured by retention/memory and verified against output replay oracle.
- **验证 oracle：** task routes/service tests, owner confusion and task-stop race cases.
- **证据：** this file; `application/tasks/service.ts`.

### runtime-host/application/capabilities/team/team-runtime-capability.ts

- **当前 owner：** Delivery adapter for TeamRun Domain; it must not become Platform Core merely because it uses scope/target grammar.
- **职责与关键 symbols：** 25 `team.*` operation descriptors; `TEAM_RUNTIME_OPERATION_IDS`; route factory; comprehensive `validateTeamRuntimeTargetInput` and helpers.
- **旧语义与策略：** maps every declared operation to `TeamRuntimePort.invoke`; validates exact package/team/run/approval IDs, required idempotency keys, graph/yaml/patch contents, manual team member nonempty, sourceType enum, settled phase enum, and team-run scope matches. `triggerList` intentionally has no target validation because internal cron enumerates all nonterminal runs; webhook only requires path. Unknown operation after descriptor route construction throws.
- **状态、存储与副作用：** no local state; TeamRun command ledger/graph/scheduler/worker I-O downstream.
- **并发与性能特征：** validation O(patch/member input size); no local queue. Rust preserves idempotency requirement and accepted domain scheduling; metrics command dedupe hit, graph patch validation p95, scheduler wake delay, oracle TeamRun command ledger differential and duplicate/retry/crash fault traces.
- **调用/依赖边界：** router → TeamRuntimePort; Domain owns TeamRun graph, ledger, managed-agent materialization; Core only supplies scope/target/correlation.
- **故障、恢复与安全：** returns 400 for malformed/mismatched commands; direct `invoke` errors pass; webhook authorization not performed here; package paths/YAML must be treated untrusted by TeamRun Domain.
- **迁移分类：** Preserve：operation inventory, idempotency keys, all target/scope equality and exceptional scheduler operations. Intentional Improvement：TeamRun typed command enum/event receipt in Domain; retain Delivery compatibility. 待验证：`triggerList` global enumeration authorization/tenant isolation.
- **未来 Rust owner：** Delivery + Domain Module（TeamRun）；Foundation Kernel owns worker/job supervision.
- **Rust 重写与性能判断：** schema-validated typed command compiler, then append to Domain ledger; do not put TeamRun graph/state in Core. Eliminates repeated string/record validation cost while retaining errors; measure command throughput/dedupe/replay, oracle ledger/reducer differential.
- **验证 oracle：** `tests/unit/team-runtime-capability.test.ts`, TeamRun graph/ledger/scheduler tests, comprehensive operation matrix + duplicate idempotency faults.
- **证据：** this file; CodeGraph TeamRuntime service/worker call chain.

### runtime-host/application/capabilities/tool/tool-invoke-capability.ts

- **当前 owner：** Delivery adapter to Task Domain’s tool-invocation outbound port; Matcha does not own runtime-native tool harness/sandbox.
- **职责与关键 symbols：** `tool.invoke`, `tools.invoke`; validates tool target/method/SessionIdentity.
- **旧语义与策略：** target must tool; input method must equal target toolName; session scope requires target identity equals scope identity; supplied input sessionIdentity, when present, must equal target identity. Calls `TaskManagerService.invokeTool(context.input)`.
- **状态、存储与副作用：** none; Task service triggers tool execution/background state.
- **并发与性能特征：** O(1) validation; tool execution cost/scheduling downstream. Rust preserves identity pinning, metric tool queue wait/execute/cancel and rejection rate, oracle tool target/session mismatch and task receipt differential.
- **调用/依赖边界：** descriptor projected for runtime agent/session scope; router → Task service. Runtime-specific harness is behind Task Domain outbound Port/Runtime Integration implementation.
- **故障、恢复与安全：** prevents cross-session tool invocation; tool arguments/results may contain secrets; no sandbox or approval logic here and it must not be moved into Matcha.
- **迁移分类：** Preserve：tool name/session identity binding. Intentional Improvement：typed tool invocation receipt/correlation in Platform Core plus Task Domain command; concrete runtime harness remains Native Runtime Edge.
- **未来 Rust owner：** Delivery + Domain Module（Task）；Runtime Integration implements protocol ports; Foundation supplies process/cancel primitives.
- **Rust 重写与性能判断：** typed `ToolTarget`, bounded Task command/outcome stream; retain exact target validation.
- **验证 oracle：** task/tool routes, session identity negative tests, runtime adapter end-to-end tool receipt traces.
- **证据：** this file; `application/tasks/service.ts`, runtime capability descriptors.

### runtime-host/application/capabilities/workspace/workspace-file-capability.ts

- **当前 owner：** Delivery adapter for Workspace/Environment Domain file port.
- **职责与关键 symbols：** `workspace.file` eight ops; metadata/identity match helpers; workspace file/staging input constructors and handlers.
- **旧语义与策略：** file target path exactly equals input path, workspaceId/sourceId equal workspace scope, and target SessionIdentity endpoint equals scope endpoint (not full session identity). staging requires workspace scope and endpoint identity, then injects scope/target. Successful FileService result wraps 200; validation failures 400.
- **状态、存储与副作用：** no state; FileService reads/writes/lists/stat/thumbnail/stages filesystem bytes.
- **并发与性能特征：** validation O(1); binary/thumbnail/staging I-O dominates. Rust must stream reads/buffers with bounds instead of materializing arbitrary binary data; preserve path/metadata/endpoint checks and response form; metrics bytes/s, peak memory, staging latency, path-escape rejection; oracle filesystem sandbox differential, large-file benchmark and I-O failure tests.
- **调用/依赖边界：** router → FileService; uses Platform Core scopes/endpoint identity but Environment Domain owns filesystem policy and storage.
- **故障、恢复与安全：** strongest in-shard workspace binding; however it compares endpoint rather than session key by design. Path normalization/symlink containment is delegated; no raw paths/content should enter public diagnostics without policy.
- **迁移分类：** Preserve：target path/workspace/source/endpoint binding and staging injection. Intentional Improvement：bounded streaming and filesystem capability handle; compatibility retains target rules and bytes/result semantics. 待验证：whether endpoint-only identity is sufficient authorization for shared workspace.
- **未来 Rust owner：** Delivery + Domain Module（Environment/Workspace）；Foundation Kernel provides secure file/stream primitives.
- **Rust 重写与性能判断：** typed `WorkspaceScope` plus capability-rooted file handle; eliminate whole-buffer overhead only if FileService behavior allows streaming, measure/verify as above.
- **验证 oracle：** workspace file routes/service tests, path traversal/symlink/large binary/staging fault corpus.
- **证据：** this file; `application/files/file-service.ts`.

## 未读项、排除项与工作树确认

- **未读项：0。** 当前 filesystem 04 范围与 `00-inventory.md` 的 40 条逐路径清单无差异；没有缺失、额外或无法读取的 `.ts`。
- **范围外而未作为本报告文件记录的源码：** 所有 Session、TeamRun、Gateway、Provider、Task、OpenClaw、matcha-agent、composition、API route 等源码；它们只通过 CodeGraph 调用关系或本分片 imports 作为边界证据，分别属于 inventory 的其他分片。测试文件未列入固定范围，未作为“已读源文件”计数。
- **明确排除：** `runtime-host/build/**` 编译产物、`node_modules/**`、coverage/测试输出/临时目录，以及 `runtime-host/package.json`/`tsconfig.json` 构建配置；理由与 `00-inventory.md` 一致，均不是本分片须逐文件迁移的生产 TypeScript source of truth。
- **无源代码修改确认：** 本次仅创建本报告：`docs/architecture/runtime-host-ts-rust-migration-audit/04-agent-runtime-capabilities.md`；未修改生产源码、测试、README、inventory、其他审计报告、配置或锁文件。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **Agent Runtime / Capability grammar 与 router 保留为 TypeScript；Rust cutover 未证实。** 当前 status 修改了 `agent-runtime-registry.ts`、`runtime-endpoint-types.ts`、ACP canonical/profile files、`capability-router.ts`、runtime/session capability 等；它们仍由 TS registry/router 运行，不能标记为 Rust owner。
- **生产 active path：** `runtime-host-runtime-module-registry.ts` contribution `createMatchaAgentRuntimeAdapterRegistrationFactory` 与 OpenClaw/ACP factories → `composition/modules/agent-runtime-module.ts:registerAgentRuntimeModule` → `AgentRuntimeRegistry` 注册 adapter/connector → `CapabilityRouter` → route/capability/session workflows。Electron `bootstrapMainApplication` 先启动 `matcha-agent` app-server，`RuntimeHostManager` 再以 `MATCHACLAW_MATCHA_AGENT_APP_SERVER_{ENABLED,URL,TOKEN}` 将 endpoint 注入 child；`MatchaAgentRuntimeAdapter` 因而是新增但仍为 **TS Runtime Integration** active path。
- **旧 owner impact：** 没有旧 Rust owner；原有 OpenClaw native registry/transport 保留，新增 Matcha-agent adapter 是并列 peer runtime，而非替代 registry/capability grammar。Capability route 的具体 domain operation 仍留在下游 workflows；registry/router 仍为 TS Platform-Core grammar/facade。
- **旧策略与 future owner：** 保留 endpoint identity、protocol/connector readiness、capability target binding 和 route validation；future Rust 只能实现稳定的 identity/capability/correlation grammar 与 adapter ports，OpenClaw/Matcha/ACP protocol loops 仍各归 Runtime Integration。新增 adapter 的 app-server availability、token projection 和 event/checkpoint 可靠性仅静态可见，分类为**残留/未证明**。
- **外部 Delivery / lifecycle 边界：** Electron 当前启动 app-server、向 runtime-host child 私有注入 endpoint/token，并以 `process-runtime` 监督 child；renderer 仅通过 retained Host API 消费 topology/capability/session projection，不能直连 token 或 app-server。前者的受管 Runtime lifecycle 语义是目标 Rust Local Process Host 的外部旧 owner，而非 Platform Core registry 的永久 Electron owner；后者始终只是 Delivery consumer。app-server worker、LLM/tool harness、approval和本地 store仍是 peer Native Runtime Edge，不随 registry迁入。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/agent-runtime-registry.test.ts tests/unit/capability-registry.test.ts tests/unit/capability-router.test.ts tests/unit/matcha-agent-runtime-adapter.test.ts tests/unit/matcha-agent-app-server-routes.test.ts tests/unit/non-provider-capability-target-binding.test.ts`；`pnpm run typecheck`。本次均**未运行**。
