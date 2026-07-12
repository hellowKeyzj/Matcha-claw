# 03 — OpenClaw Bridge、Plugin Engine 与 Shared 文件级迁移审计

> 状态：静态审计完成。本文是旧 TypeScript 行为和迁移证据库，不是 Rust 实施批准书。

## 范围、方法与覆盖

- **路径权威：**`00-inventory.md` 的当前 03 分片；固定目录为 `runtime-host/openclaw-bridge/**`、`runtime-host/plugin-engine/**`、`runtime-host/shared/**` 当前存在的 `.ts` / `.cjs`。当前 `runtime-host` production source filesystem 为 **589**（`.ts` 588、`.cjs` 1）；未跟踪的 `runtime-host/shared/matcha-terminal-delivery-trace.ts` 已作为本分片第 30 条纳入并同步 inventory。
- **文件数：**本分片当前为 **42**（`.ts` 42、`.cjs` 0）；当前 filesystem、`00-inventory.md` 和本报告范围一致。
- **审计方法：**先用 `.codegraph` 的 `codegraph explore` / `codegraph node` 追踪 Gateway 连接、challenge 认证、RPC、事件、重连、plugin discovery、manifest/filesystem，以及 Matcha event bridge、session ingress、parent event emit 的调用链；再完整读取每个范围文件，并以相关调用方和现有单测为 oracle。未执行测试、未运行 Gateway、未建立 Rust 实现。
- **归属边界：**OpenClaw Gateway 的 WebSocket、challenge 签名、RPC method、事件和 transport 状态机均是 **Runtime Integration**；它们不是 Foundation，也不定义 Matcha capability grammar。插件目录、manifest 和本地 OpenClaw plugin 布局属于 **Native Runtime Edge**（通用受控 FS 机制才可由 Foundation 提供）。`capability-descriptor.ts` / `runtime-address.ts` 的跨 Runtime grammar 属于 **Matcha Platform Core**。Runtime 内 tool harness 合约不归 Matcha Platform Core。`matcha-terminal-delivery-trace.ts` 的 Matcha 注入和协议适配归 **Runtime Integration**，其 terminal session update 的 canonical 应用归 **Session Domain Module**；日志 sink 机制可作为 **Foundation Kernel** 候选，但当前 `logger.ts` 不提供通用 secret/redaction primitive。只有跨 Runtime correlation 语义真正稳定后才可归 Matcha Platform Core；本文件的 session terminal 语义不得据此误升为 Core。
- **Defect 纪律：**没有发现同时具备实现、调用链和测试证据的 defect；以下可能的风险全部标为“待验证”，不作为必须复制或必须修复的结论。

## 已读文件（42）

1. `runtime-host/openclaw-bridge/bridge.ts`
2. `runtime-host/openclaw-bridge/capabilities.ts`
3. `runtime-host/openclaw-bridge/client-auth-ports.ts`
4. `runtime-host/openclaw-bridge/client-auth.ts`
5. `runtime-host/openclaw-bridge/client-connection-tracker.ts`
6. `runtime-host/openclaw-bridge/client-errors.ts`
7. `runtime-host/openclaw-bridge/client-frame-handler.ts`
8. `runtime-host/openclaw-bridge/client-heartbeat.ts`
9. `runtime-host/openclaw-bridge/client-pending-rpc.ts`
10. `runtime-host/openclaw-bridge/client-port-probe.ts`
11. `runtime-host/openclaw-bridge/client-reconnect-policy.ts`
12. `runtime-host/openclaw-bridge/client-rpc-sender.ts`
13. `runtime-host/openclaw-bridge/client-socket-session.ts`
14. `runtime-host/openclaw-bridge/client-state.ts`
15. `runtime-host/openclaw-bridge/client.ts`
16. `runtime-host/openclaw-bridge/events.ts`
17. `runtime-host/openclaw-bridge/index.ts`
18. `runtime-host/openclaw-bridge/protocol.ts`
19. `runtime-host/plugin-engine/plugin-discovery.ts`
20. `runtime-host/plugin-engine/plugin-file-system.ts`
21. `runtime-host/plugin-engine/plugin-id.ts`
22. `runtime-host/plugin-engine/plugin-location-rules.ts`
23. `runtime-host/plugin-engine/plugin-manifest-loader.ts`
24. `runtime-host/shared/browser-mode.ts`
25. `runtime-host/shared/capability-descriptor.ts`
26. `runtime-host/shared/chat-message-normalization.ts`
27. `runtime-host/shared/device-identity.ts`
28. `runtime-host/shared/gateway-chat-send-params.ts`
29. `runtime-host/shared/gateway-error.ts`
30. `runtime-host/shared/matcha-terminal-delivery-trace.ts`
31. `runtime-host/shared/logger.ts`
32. `runtime-host/shared/parent-transport-contracts.ts`
33. `runtime-host/shared/platform-runtime-contracts.ts`
34. `runtime-host/shared/runtime-address.ts`
35. `runtime-host/shared/runtime-host-constants.ts`
36. `runtime-host/shared/runtime-topology.ts`
37. `runtime-host/shared/session-adapter-types.ts`
38. `runtime-host/shared/task-tool-contract.ts`
39. `runtime-host/shared/trace-log-level.ts`
40. `runtime-host/shared/transport-contract.ts`
41. `runtime-host/shared/types.ts`
42. `runtime-host/shared/update-version.ts`

---

## OpenClaw Bridge

### runtime-host/openclaw-bridge/bridge.ts

- **当前 owner：**Runtime Integration 的 OpenClaw Gateway façade；只将上层 transport-independent port 映射到 Gateway RPC，非平台 capability owner。
- **职责与关键 symbols：**`OpenClawGatewayClient`、`OpenClawBridge`、`createOpenClawBridge`；暴露 readiness、RPC、agent/cron/channel/security 和 platform-tool 适配调用。
- **旧语义与策略：**除 `gatewayRpc(method, params = {}, timeout)` 的空参数默认外均直接委派；固定 RPC literals（如 agent / cron / channel 操作）是 OpenClaw 协议翻译。tool 安装/启停/abort 只转发，不自建重试、幂等或取消语义。
- **状态、存储与副作用：**无自身状态；副作用均由 client 的 WebSocket RPC 产生。
- **并发与性能特征：**O(1) façade；并发、队列、timeout 由 `client.ts` / `client-rpc-sender.ts` 控制。
- **调用/依赖边界：**上游为 OpenClaw transport、gateway event bridge、skill/team adapter；下游为 `OpenClawGatewayClient`，chat 参数由 `buildGatewayChatSendParams` 构建。`ToolSource`/`RunContext` 只是 runtime tool harness 合约，不能据此把 bridge 归 Matcha 平台。
- **故障、恢复与安全：**错误原样来自 client；无 token 存储或 redaction。RPC params 可含敏感值，禁止以无 redaction logger 记录。
- **迁移分类：**Preserve：方法名、参数省略和错误透传。待验证：每一个 OpenClaw method 是否仍是受支持协议面及其幂等性。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**以 `OpenClawGatewayPort` trait 和小型 adapter 实现，保持一对一 mapping；不需要 actor 或优化。只有 RPC client 负责背压。
- **验证 oracle：**对 mock Gateway 做 method/JSON 参数差分；调用链为 `openclaw-transport.ts`、gateway event bridge、composition gateway module；现有 bridge 专属覆盖待补。
- **证据：**`createOpenClawBridge`、`OpenClawGatewayClient`、`buildGatewayChatSendParams`。

### runtime-host/openclaw-bridge/capabilities.ts

- **当前 owner：**Runtime Integration 的 Gateway feature-method capability snapshot，不是 Matcha capability grammar。
- **职责与关键 symbols：**`GatewayCapabilitiesSnapshot`、`GatewayMethodReadiness`、`GatewayControlReadiness`、`DEFAULT_GATEWAY_BASE_METHODS`、`normalizeGatewayMethods`、`inspectGatewayMethods`。
- **旧语义与策略：**method 列表只保留 trim 后非空字符串、去重并按 locale 排序；`null` capabilities 视为 missing；空 required list 使用基础方法集。readiness 以缺失 method 决定，不做服务端探测。
- **状态、存储与副作用：**纯 DTO / 比较，无 I/O。
- **并发与性能特征：**Set membership，O(methods + required)；无锁。
- **调用/依赖边界：**client handshake 从 `features.methods` 写入 snapshot，`client.ts` control-readiness 再以其拒绝缺方法；上层只读取诊断投影。
- **故障、恢复与安全：**无凭据；未知/空 capability 以 unavailable 处理。
- **迁移分类：**Preserve：Gateway feature 归一化、基础方法默认和 missing 计算。Intentional Improvement：若产生跨 Runtime capability grammar，须另投影到 Matcha Platform Core，不能把 Gateway method strings 提升为 core owner。待验证：基础方法集与上游协议版本的兼容性。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**`BTreeSet<String>` 或排序 `Vec` 表示稳定 snapshot，`HashSet` 做 membership；无性能重写理由。
- **验证 oracle：**feature methods 的 handshake fixture 和 readiness table（空、重复、未知、缺基础方法）；证据为 `client-frame-handler.ts`、`client.ts`。
- **证据：**`normalizeGatewayMethods`、`inspectGatewayMethods`、`client-frame-handler.ts`、`client.ts`。

### runtime-host/openclaw-bridge/client-auth-ports.ts

- **当前 owner：**Runtime Integration 的 device identity / signing port 边界。
- **职责与关键 symbols：**`GatewayDeviceIdentityRepositoryPort`（load/create identity）、`GatewayDeviceCryptoPort`（Ed25519/sign）。
- **旧语义与策略：**仅 interface，无默认、拒绝、超时或重试；identity 的 create-or-load 幂等性由具体 repository 负责。
- **状态、存储与副作用：**自身无状态；实现可读取私钥文件并作密码学签名。
- **并发与性能特征：**无实现；并发 identity 创建冲突待由 adapter 明确。
- **调用/依赖边界：**`GatewayAuthService` 依赖这两个端口；具体实现由 composition 注入。
- **故障、恢复与安全：**私钥必须是 secret；port 类型未阻止日志泄漏、也无 redaction。签名 / repository 错误向 handshake 传播。
- **迁移分类：**Preserve：抽象边界和错误传播。待验证：identity 落盘权限、create/load 的并发与密钥轮换。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration；Foundation 仅可提供通用 secret handle / redaction primitive，不能拥有 Gateway identity 协议。
- **Rust 重写与性能判断：**`DeviceIdentityStore`、`DeviceSigner` traits；私钥为不可 `Debug` / 不可序列化 secret handle，防止 accidental log。
- **验证 oracle：**fake store/signer 检验 auth payload 固定字节；`runtime-host-device-identity.test.ts` 是 payload 格式证据。
- **证据：**`GatewayAuthService`、`runtime-host-device-identity.test.ts`。

### runtime-host/openclaw-bridge/client-auth.ts

- **当前 owner：**Runtime Integration 的 Gateway v4 challenge-response 认证。
- **职责与关键 symbols：**常量 operator scopes / protocol identity，`parseGatewayPort`，`GatewayAuthService.buildGatewayConnectRequest`、`loadGatewayDeviceIdentity`。
- **旧语义与策略：**端口 `parseInt` 后必须为 1..65535，否则 throw；connect request 读取 token、取时钟、懒加载并缓存 device identity，构造 V3 payload 并同步签名，发 `connect` request。scopes 和 client id/version/mode/family/caps 为固定 Gateway 协议值；首次 identity load/create 成功后缓存，后续复用。
- **状态、存储与副作用：**内存 identity cache；token/identity repository 读取、crypto 签名。无本文件重试与 timeout。
- **并发与性能特征：**缓存消除重复 I/O；并发首调用是否会重复 load/create 未加 single-flight，待验证。
- **调用/依赖边界：**`client-frame-handler.ts` 在 `connect.challenge` 后调用；使用 `shared/device-identity.ts` 的 canonical signing string。
- **故障、恢复与安全：**token、private key、payload、signature 都敏感；任何 repository/crypto 错误使 handshake fail。当前 logger 仅记录 nonce 是否存在，不记录 token/payload；须保持。
- **迁移分类：**Preserve：端口拒绝、固定 v4 client fields、V3 字节序列、identity cache。待验证：operator scopes / client version 的兼容更新策略。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**`OnceCell<Result<DeviceIdentity>>` 或 keyed async single-flight；保持相同字段与签名 bytes。此优化仅消除竞争重复 I/O，需先用并发测试证明。
- **验证 oracle：**challenge→connect frame fixture、固定 clock/key/token 的 byte-for-byte signature test；证据为 `client-frame-handler.ts`、`runtime-host-device-identity.test.ts`。
- **证据：**`GatewayAuthService.buildGatewayConnectRequest`、`client-frame-handler.ts`、`runtime-host-device-identity.test.ts`。

### runtime-host/openclaw-bridge/client-connection-tracker.ts

- **当前 owner：**Runtime Integration 的 Gateway 连接诊断投影 owner。
- **职责与关键 symbols：**`GatewayConnectionTracker`、`snapshot`、`diagnostics`、`updateSnapshot`、`updateDiagnostics`、`emitInitial`。
- **旧语义与策略：**以 `buildInitialDiagnostics()` 和 disconnected snapshot 初始化；更新时 shallow merge，若 `lastIssue` 未给且 `lastError === ''` 则清 issue；用字段比较避免重复 `onChange`。更新返回当前 snapshot。
- **状态、存储与副作用：**两个内存对象和 callback；无持久化。
- **并发与性能特征：**JS 单线程同步 mutation；snapshot compare 为常数级字段比较，`details` 仅引用比较，复杂 details 不深比较。
- **调用/依赖边界：**被 `client.ts` 作为唯一 Gateway connection state source；上游连接状态 callback 到 gateway/runtime read model。
- **故障、恢复与安全：**无恢复；`lastIssue.details` 可能含服务端敏感内容，callback/API 投影必须再做边界控制。
- **迁移分类：**Preserve：initial 状态、空 error 清 issue、避免相同 snapshot 重发。待验证：details 引用不深比较是否会遗漏更新。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**单 Gateway connection actor 持有 `ConnectionSnapshot`；用显式 semantic equality，发布不可变 clone。无极致性能需求。
- **验证 oracle：**状态序列 fixture（初始、connected、issue 清除、同值不 emit）；证据为 `client.ts` 状态调用链。
- **证据：**`GatewayConnectionTracker`、`client.ts`。

### runtime-host/openclaw-bridge/client-errors.ts

- **当前 owner：**Runtime Integration 的不可信 Gateway error normalization helper。
- **职责与关键 symbols：**`isRecord`、`ensureError`、错误 message/code/details/retryable/retryAfterMs 提取器。
- **旧语义与策略：**unknown 转 Error，优先 `Error.message` / string / fallback；error payload 支持 string、`message`、nested error。code 仅非空 string；retryable 仅 boolean；retryAfter 仅有限非负 number 或可解析 string，否则省略。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**O(1)，无 I/O。
- **调用/依赖边界：**frame handler、socket session、RPC sender、client recovery 用其把 Gateway error 转 transport issue。
- **故障、恢复与安全：**不对 details redaction 或大小限制；details 可被保留/投影，敏感字段处理是调用边界责任。
- **迁移分类：**Preserve：宽容解析与 unknown fallback。Intentional Improvement：Rust ingress 可对外部 details 加大小上限/redaction，但必须单列兼容影响。待验证：服务端 error schema 的全部变体。
- **未来 Rust owner：**Runtime Integration；可调用 Foundation 的通用 redaction primitive（若建立），但解析 policy 本身仍属 integration。
- **Rust 重写与性能判断：**`serde_json::Value` pattern matching，返回 typed optional fields；无优化理由。
- **验证 oracle：**payload corpus（nested error、错误类型、非法 retry hint）；证据为 `client-frame-handler.ts` 的 response mapping。
- **证据：**`ensureError` 与 error metadata 提取器、`client-frame-handler.ts`、`client-rpc-sender.ts`。

### runtime-host/openclaw-bridge/client-frame-handler.ts

- **当前 owner：**Runtime Integration 的 WebSocket frame protocol state transition / event ingress。
- **职责与关键 symbols：**`GatewayClientFrameHandler`，raw JSON parse，challenge、connect response、pending RPC response、Gateway event 分发。
- **旧语义与策略：**非法 JSON 静默丢弃；未连接时仅 `connect.challenge` 触发 auth，缺 nonce 失败；challenge 异步 build/send connect request。只接受与已存 request id 对应的 connect response；成功时归一化 `features.methods`、mark connected、settle，失败时提取 error metadata。RPC response 以 id `take` 结算；未知 id 只 mark alive / warn；`agents.delete` 的“not found”是预期业务错误，不记 RPC failure，但仍 reject。普通事件更新 alive，ready/presence/health 标 ready 后交 `dispatchGatewayProtocolEvent`。
- **状态、存储与副作用：**自身无持久化，借 deps 改 socket client state、pending map、callback；JSON parse / WebSocket send。
- **并发与性能特征：**每 frame 同步处理，connect signing 用 fire-and-forget async closure；response correlation Map O(1)。异步 signing 完成后 socket 状态变化由 settle 守卫处理。
- **调用/依赖边界：**由 `client-socket-session.ts` 挂接 message；下游 auth、pending RPC、events、connection tracker。
- **故障、恢复与安全：**malformed frame 不使连接崩溃；connect / RPC error 转 issue。日志只含 request id/method/nonce presence，不含 credential。未知 event payload 仍可能送 notification，consumer 必须 treat untrusted。
- **迁移分类：**Preserve：frame 忽略、nonce/response correlation、expected delete failure telemetry 例外、event readiness 信号。待验证：非法 JSON 是否需要计数诊断、未知 response 是否能形成攻击性噪声。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**connection actor 按 frame 顺序处理；`HashMap<RequestId, PendingRpc>`；auth task 回投带 epoch/request id。保持 unordered external frame 的现有容忍性。
- **验证 oracle：**scripted WebSocket corpus：invalid JSON、challenge 缺 nonce、错 connect id、RPC success/error、unknown response、delete-not-found、ready event；证据为 `client-socket-session.ts`、`events.ts`。
- **证据：**`GatewayClientFrameHandler`、`client-socket-session.ts`、`events.ts`。

### runtime-host/openclaw-bridge/client-heartbeat.ts

- **当前 owner：**Runtime Integration 的 Gateway liveness / readiness 恢复调度。
- **职责与关键 symbols：**`getGatewayHeartbeatOptions`、ready fallback delays、initial grace、`GatewayHeartbeatScheduler`。
- **旧语义与策略：**Windows interval/timeout/max misses 为 45s/20s/4，其他为 30s/10s/3。每 heartbeat ping 并设置 generation-protected timeout；任何 pong/message/RPC 清 timeout。未 ready 时按 1.5/3/5/8/12/30 秒 capped 队列以 `system-presence` 探测。连续 misses 到阈值：初始五分钟且未 ready 只延迟 restart；否则 request restart 并 schedule reconnect。清理方法取消所有 timer，幂等。
- **状态、存储与副作用：**四个 in-memory scheduled-task slots、attempt/generation counters；副作用为 ping、probe、restart / reconnect callback。
- **并发与性能特征：**timer callbacks 以 lifecycle epoch / generation 阻断过期回调；常数内存、低频 I/O。没有无界队列。
- **调用/依赖边界：**`client.ts` 注入 socket / diagnostics / restart callbacks；不直接持有 WebSocket。
- **故障、恢复与安全：**probe failure 只重排 fallback；restart callback 本身的错误由 client 处理。无 secret。
- **迁移分类：**Preserve：平台特定阈值、epoch/generation 防旧 timer、initial-ready grace、fallback schedule。待验证：Windows 参数是否仍需不同；没有测试证明的“缺陷”不成立。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**在 Gateway connection actor 内以 cancellable `tokio::time::Sleep` / generation token 实现，不要为每 timer 新 actor；指标为 heartbeat miss、恢复耗时、过期回调数。
- **验证 oracle：**虚拟时钟 fault tests：pong 取消、连续超时、grace 到期、epoch 切换、close cleanup；证据为 `client.ts`。
- **证据：**`GatewayHeartbeatScheduler`、`client.ts`。

### runtime-host/openclaw-bridge/client-pending-rpc.ts

- **当前 owner：**Runtime Integration 的 Gateway RPC correlation / timeout registry。
- **职责与关键 symbols：**`GatewayPendingRpcRequests`、`PendingGatewayRpcRequest`、`GATEWAY_PENDING_RPC_LIMIT = 128`、1 秒 timeout buckets。
- **旧语义与策略：**达到 128 立即 reject；timeout 最低 1s，以 deadline 向上取整到秒 bucket。`take` 原子删除并返回，`delete` 仅删，`rejectAll` reject 后清 timer。每 bucket timer 扫描 pending Map 并 reject 同 bucket 项；空 bucket 被取消。
- **状态、存储与副作用：**in-memory request Map 与 bucket timer Map；Promise resolve/reject 和 scheduler。
- **并发与性能特征：**查找 O(1)；每个 bucket timeout 扫描全部 pending O(n)，n 被 128 上限约束；bucket 将真实 timeout 最多延后近 1 秒。
- **调用/依赖边界：**RPC sender register，frame handler take，socket close/client close/recovery rejectAll。
- **故障、恢复与安全：**socket/close/recovery 统一 reject 避免悬挂；没有 cancel 单请求 API。request id/method 非 secret，params 不存储。
- **迁移分类：**Preserve：128 上限、最小 1s、bucket 迟滞、close/recovery 全拒绝。Intentional Improvement：deadline min-heap 可消除扫 Map，但需保留计时边界并以 benchmark 证明。待验证：1 秒附加超时是否被 public contract 依赖。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**connection actor `HashMap<RequestId, oneshot::Sender>`；初版可保留 bucket；规模证据出现后再采用 `BinaryHeap<Reverse<Deadline>>`，测量 timeout p99、timer 数、CPU。
- **验证 oracle：**虚拟时钟测 128th rejection、同 bucket、response-before-timeout、close / recovery rejectAll；证据为 RPC sender、socket session。
- **证据：**`GatewayPendingRpcRequests`、`client-rpc-sender.ts`、`client-socket-session.ts`。

### runtime-host/openclaw-bridge/client-port-probe.ts

- **当前 owner：**Runtime Integration 的 Gateway TCP reachability adapter helper。
- **职责与关键 symbols：**`probeGatewayPortReachable(tcpProbe, port, timeoutMs)`。
- **旧语义与策略：**调用 injected TCP probe；任何 rejection 返回 `false`，不抛出、不重试。
- **状态、存储与副作用：**无自身状态；网络 probe 由 port 产生。
- **并发与性能特征：**单次 await，成本由 adapter / timeout 决定。
- **调用/依赖边界：**`client.ts.readGatewayConnectionState` 与 RPC recovery restart decision 使用。
- **故障、恢复与安全：**故障 fail-closed 为 unreachable；无 token。
- **迁移分类：**Preserve：probe 异常折叠 false。待验证：权限 / DNS 类错误是否应与不存在端口区分。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**`TcpConnector` + explicit timeout，返回 bool；不需要优化。
- **验证 oracle：**fake probe success/false/reject；调用证据为 `client.ts`。
- **证据：**`probeGatewayPortReachable`、`client.ts`。

### runtime-host/openclaw-bridge/client-reconnect-policy.ts

- **当前 owner：**Runtime Integration 的 Gateway reconnect 延迟 policy。
- **职责与关键 symbols：**`GATEWAY_RECONNECT_MAX_ATTEMPTS = 10`、`nextReconnectDelayMs`。
- **旧语义与策略：**attempt 0 起返回 capped exponential delays（以 1s 起步、上限 30s）；输入负数经 `Math.max(0, attempt)` 处理。client 在超过十次前才 schedule。
- **状态、存储与副作用：**纯函数，无 I/O。
- **并发与性能特征：**O(1)。
- **调用/依赖边界：**`client.ts.scheduleReconnect` 管理计数、epoch 与 timer。
- **故障、恢复与安全：**不含 jitter；多个 client 同时断线的 herd 风险没有调用/测试证据，列待验证。
- **迁移分类：**Preserve：attempt cap 与 deterministic sequence。Intentional Improvement：若加入 jitter，必须声明可观察的恢复时间变化并用 fault oracle 验证。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**纯 `Duration` function；不应因迁移自动改用无限重试。
- **验证 oracle：**attempt -1、0、各指数台阶、10/超过 10 的 client integration fixture；证据为 `client.ts`。
- **证据：**`nextReconnectDelayMs`、`client.ts.scheduleReconnect`。

### runtime-host/openclaw-bridge/client-rpc-sender.ts

- **当前 owner：**Runtime Integration 的 Gateway RPC admission / send lifecycle owner。
- **职责与关键 symbols：**`GatewayRpcSender`、concurrency 16、queue 64、`call`、`callWithSlot`、telemetry policy。
- **旧语义与策略：**16 active slots；满时 FIFO queue，queued >=64 立即 reject；slot finally release。每 call 默认 `DEFAULT_GATEWAY_RPC_TIMEOUT_MS`，先 `ensureConnected(max(2s, timeout))`，再 register pending、发送 `{type:'req', id, method, params: params || {}}`。send error 删除 pending 并记录失败；timeout / response 由 pending/frame handler 结算。readiness-probe 不计一般 RPC failure，改回调。
- **状态、存储与副作用：**active count、array + head queue；WebSocket send、pending registry、logger。
- **并发与性能特征：**bounded 80 in-flight+queued admission；FIFO O(1) amortized，head 超阈值 compaction 防 array 无限增长；被连接 / response timeout 占住 slot，形成背压。
- **调用/依赖边界：**`client.ts.gatewayRpc` / readiness probe 调用；依赖 connection、pending registry、state telemetry。
- **故障、恢复与安全：**queue full、connect/send/timeout 都 reject；没有按 caller cancellation 删除 queue item。日志不写 params，必须保持。
- **迁移分类：**Preserve：16/64 容量、FIFO、params falsy→`{}`、readiness telemetry 隔离、finally release。待验证：调用取消需求及 queue wait 是否应计入 timeout；无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**connection actor 加 bounded `mpsc`（capacity 64）和 semaphore 16；须明确 queue wait 沿用当前不计入 RPC timeout 的行为。测量 queue wait、rejection、active/pending、RPC p99。
- **验证 oracle：**fake socket + controlled promises：16 active、65th queued、81st reject、send throw、timeout、readiness failure；证据为 client state chain。
- **证据：**`GatewayRpcSender`、`client.ts.gatewayRpc`、pending RPC registry。

### runtime-host/openclaw-bridge/client-socket-session.ts

- **当前 owner：**Runtime Integration 的单次 WebSocket establish / teardown orchestration。
- **职责与关键 symbols：**`GatewaySocketSessionDeps`、`connectGatewaySocketSession`。
- **旧语义与策略：**创建 ws 并设为 current；connect timeout 取 `max(1s, supplied)`，timeout close socket、写 retryable handshake-timeout issue、reject。成功 / 失败只可 settle 一次且必须仍是 current socket。open 标记 port reachable；message 交 frame handler；pong mark alive；pre-connect error 失败、connected error 仅 report。close 清 timer、记录 close、reject pending、置 disconnected；非客户端主动 close 才 report 并重连；connect 期间关闭走 settle failure。
- **状态、存储与副作用：**WebSocket listener、connect timer、connection tracker / pending registry mutation。
- **并发与性能特征：**socket identity guards 防止旧 socket callback 改新连接；listener constant count。close 与 timeout 竞态由 `connectSettled` 控制。
- **调用/依赖边界：**仅由 `client.ts.ensureConnected` 调；委派 frame parsing 给 frame handler，重连策略回 client。
- **故障、恢复与安全：**所有 close pending reject；客户端 shutdown 通过 flag 禁止重连。reason 写入 diagnostics，可能为不可信 peer text，外部显示/日志需按数据处理。
- **迁移分类：**Preserve：current-socket guard、settle-once、主动 close 不重连、pending 清理、timeout issue metadata。待验证：WebSocket close reason 的 redaction/size。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**一个 socket task 将 read/write / lifecycle event 串行化，epoch/token 丢弃 stale event；维持 cleanup 顺序。指标：pending leak、重连次数、connect timeout。
- **验证 oracle：**mock WS race tests：late old close、timeout then close、auth fail、client close、peer close；证据为 `client.ts`、frame handler。
- **证据：**`connectGatewaySocketSession`、`client.ts.ensureConnected`、`client-frame-handler.ts`。

### runtime-host/openclaw-bridge/client-state.ts

- **当前 owner：**Runtime Integration 的 Gateway observable diagnostics / issue model builder。
- **职责与关键 symbols：**connection / health unions，diagnostics and payload types，`buildInitialDiagnostics`、`sameDiagnosticsSnapshot`、`buildGatewayHealthSummary`、`createGatewayTransportIssue`。
- **旧语义与策略：**initial diagnostics 全部 undefined/zero；health 是 connected + gatewayReady + no misses/failures 的 `healthy`，connected 但有问题为 `degraded`，非 connected 为 `unresponsive`。issue 总带 timestamp，optional fields 仅在 defined 时出现。
- **状态、存储与副作用：**纯构造 / 比较，无 I/O。
- **并发与性能特征：**O(1)；details 仅引用，不深比较。
- **调用/依赖边界：**tracker/client/frame/RPC/socket 创建和投影 issue；`shared/gateway-error.ts` 是公开契约。
- **故障、恢复与安全：**无 redaction；issue details 是未可信边界数据。
- **迁移分类：**Preserve：health truth table、timestamp、可选字段 omission。待验证：health 是否足够反映 connection 以外状态。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**typed enum / immutable struct；issue `details: Option<Value>` 并在 API 边界限大小。无性能结论。
- **验证 oracle：**health matrix / issue serialization vectors；证据为 `client.ts` state update。
- **证据：**`buildGatewayHealthSummary`、`createGatewayTransportIssue`、`client.ts`。

### runtime-host/openclaw-bridge/client.ts

- **当前 owner：**Runtime Integration 的完整 OpenClaw Gateway connection actor（当前以 closure state 实现）。
- **职责与关键 symbols：**`createGatewayClient`；连接/close、capability handshake、readiness control state、RPC recovery、socket reconnect、heartbeat、state read、security audit query projection。
- **旧语义与策略：**
  - 连接 single-flight：已有 open connected socket 立即成功，已有 `connectPromise` 共用；地址固定 `ws://127.0.0.1:<port>/ws`。
  - connect 成功递增 `transportEpoch`、重置 reconnect/RPC recovery，启动 heartbeat；close/recovery 均 bump `lifecycleEpoch` 失效旧 timer。
  - RPC 连续普通失败达 3 次触发 recovery；前三次 1s，随后 10/30/60s capped backoff；recovery single-flight，取消 reconnect、清 timer、reject pending、关闭旧 socket，再以 `system-presence` 建连。失败时若 heartbeat miss 或 TCP port 不可达请求重启；同一 transport epoch 最多请求一次 restart。
  - peer socket close 以最多 10 次 backoff reconnect；主动 `close()` 取消 timer、拒绝 pending、以 1000 shutdown close 且不重连，重复 close 可安全调用。
  - control readiness：默认 handshake 15s、liveness probe 2s；未连接返回 retryable `starting`，缺 required methods 为 non-retryable unavailable；UNAUTHORIZED / FORBIDDEN / protocol mismatch 是 connection-wide unavailable；其他 non-retryable issue 限定 required-methods。successful `system-presence` 才标 control ready。
  - `ensureGatewayReady` 默认基础 methods 后 `system-presence`；`isGatewayRunning` 仅 TCP reachability；audit query filter 掉空值，不 redaction key/value。
- **状态、存储与副作用：**闭包中的 socket、promises、epochs、capabilities/readiness、timers、attempts；WebSocket/TCP、scheduler、auth repository、restart callback、event callbacks。无本地持久化。
- **并发与性能特征：**single-flight connect/recovery、epoch guard、bounded RPC 由 sender 承担；每连接一个 heartbeat 和有限 recovery/reconnect timer。读取 state 可能再次 TCP probe；没有无限调度队列。
- **调用/依赖边界：**composition 建立 client；`openclaw-gateway-event-bridge.ts`、`openclaw-transport.ts`、skill/team adapters 使用其。下游为 auth/socket/frame/RPC/heartbeat/tracker。Gateway event 正规化仍是 integration，不应接管 Session domain reducer。
- **故障、恢复与安全：**统一 pending rejection 避免悬挂；connection issue 写 state / callback。token/private key 留在 auth service；trace logs 禁止 params/token。`buildSecurityAuditQueryParams` 不是 redaction，调用者不得误作为安全过滤器。
- **迁移分类：**Preserve：single-flight、epoch stale guard、阈值与 capped recovery/reconnect、同 epoch restart 去重、control readiness truth table、主动 close 不重连。Intentional Improvement：Rust actor 可把分散 closure mutation 串行化；不得改变时序，先以 virtual-time differential tests 固定。待验证：manual recovery 与 in-flight RPC caller cancellation 的产品语义、audit query 的敏感键策略。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**一个 `GatewayConnectionActor` 持有 `ConnectionState`、socket command channel、pending registry、epoch；RPC semaphore/queue 独立但受该 actor 管理。优点是消除 callback interleaving 和 stale socket mutation，不宣称吞吐必然提升。测量连接恢复时间、RPC p99、pending leak、timer/epoch stale-event 数；以 TS scripted transport differential oracle 回归。
- **验证 oracle：**CodeGraph 调用链：composition gateway bridge module → OpenClaw gateway event bridge / OpenClaw transport；应补 mock transport + virtual scheduler scenario suite（auth、close、heartbeat、3 RPC failures、10 reconnect、readiness permanent/transient、manual close/recovery）。
- **证据：**`createGatewayClient`、composition gateway bridge module、`openclaw-gateway-event-bridge.ts`、`openclaw-transport.ts`。

### runtime-host/openclaw-bridge/events.ts

- **当前 owner：**Runtime Integration 的 OpenClaw Gateway event-to-runtime projection；不拥有 Session canonical state。
- **职责与关键 symbols：**Gateway chat/thinking/tool/plan/run event types、normalizers、`dispatchGatewayProtocolEvent`、测试 hook。
- **旧语义与策略：**只接受 record、trim text、有限 number（string number 可转）；chat 必须 state/runId/sessionKey/seq，`replace` 优先于 `deltaText`，否则 snapshot content 的 text/message blocks join `\n`。tool start 必须 name，tool/thinking/plan/lifecycle 均有各自必填字段；不合格 event 静默丢弃。`tick` 忽略；`chat` 只 conversation event；session/agent/tool/usage/artifact 多数也 notification；`channel.status` 直接 cast 并 callback；未知 event notification passthrough。所谓 dedup reset 是空 hook，ingress 当前无 dedup state。
- **状态、存储与副作用：**纯 normalize + callback emission，无持久化、无实际 dedup。
- **并发与性能特征：**每 event O(payload blocks)，message content flatten 线性；无队列/背压，callback 在 socket event path 同步执行。
- **调用/依赖边界：**frame handler 调用；下游 `openclaw-gateway-event-bridge.ts` / session ingress 将投影交领域 reducer。runId 是 ownership、seq 是 ordering、message id 是 identity，bridge 不应自行重写这三个语义。
- **故障、恢复与安全：**不可信 payload 以 drop/opaque notification 处理；args/result/errorDetails 可含 secret 或大对象，当前无 redaction / size ceiling。未知 event passthrough 不是授权。
- **迁移分类：**Preserve：严格必填过滤、chat text-mode precedence、event routing 和 notification side channel。Intentional Improvement：在 integration ingress 增加 payload size/redaction 可行但要确认外部可见 notification 影响。待验证：`channel.status` 无 runtime validation、同步 callback 是否会阻塞 WS。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration；Session Domain Module 才拥有后续 canonical ordering/replay。
- **Rust 重写与性能判断：**serde raw event enums + explicit tolerant parser，输出 typed integration events；可在 actor channel 设置有界背压，但要定义丢弃 / flow-control 语义。测量 decode p99、event lag、drop 数，回归 raw-event corpus。
- **验证 oracle：**fixtures 覆盖 chat modes、invalid required fields、agent stream 分支、unknown notification；证据为 frame handler 和 session gateway ingress call chain。
- **证据：**`dispatchGatewayProtocolEvent`、`client-frame-handler.ts`、session gateway ingress 调用链。

### runtime-host/openclaw-bridge/index.ts

- **当前 owner：**Runtime Integration public barrel。
- **职责与关键 symbols：**re-export `createOpenClawBridge`、bridge/client public types。
- **旧语义与策略：**无逻辑、默认、拒绝或副作用。
- **状态、存储与副作用：**无。
- **并发与性能特征：**无。
- **调用/依赖边界：**编译期导入边界，向 composition / adapters 暴露两个入口。
- **故障、恢复与安全：**无运行时行为。
- **迁移分类：**Preserve：只暴露经审计的 integration API；无需仿制 TypeScript barrel。
- **未来 Rust owner：**Runtime Integration crate public module。
- **Rust 重写与性能判断：**显式 `pub use`；无性能问题。
- **验证 oracle：**compile/API surface test；证据为 imports of openclaw bridge module。
- **证据：**`createOpenClawBridge` 与 client public type 的 barrel exports；其 import 调用面待编译/API oracle 固定。

### runtime-host/openclaw-bridge/protocol.ts

- **当前 owner：**Runtime Integration 的 Gateway wire-frame type guards。
- **职责与关键 symbols：**response/error/event/notification DTO，`isGatewayResponseFrame`、`isGatewayEventFrame`。
- **旧语义与策略：**只检查 non-array record、`id` string 对 response、`event` string 对 event；不验证 `type`、payload、ok/error 的完整 schema。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**O(1)。
- **调用/依赖边界：**frame handler 先以 guards 分类，再交具体 normalizer；events output 采用 notification DTO。
- **故障、恢复与安全：**弱 guard 是宽容 protocol ingress，后续处理必须继续字段校验；payload unknown，不可信。
- **迁移分类：**Preserve：最小分类和后续严格化位置。待验证：是否要验证 `type` 以避免错误 frame 误分类；无调用/测试证明前不能定 Defect。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**先 deserialize `Value`，尝试最小 envelope，再 per-message decoder；不需性能优化。
- **验证 oracle：**record/array/null/missing id/event corpus；证据为 frame handler。
- **证据：**`isGatewayResponseFrame`、`isGatewayEventFrame`、`client-frame-handler.ts`。

---

## Plugin Engine

### runtime-host/plugin-engine/plugin-discovery.ts

- **当前 owner：**Native Runtime Edge 的本地插件目录扫描与 discovered-plugin projection；不是 capability grammar owner。
- **职责与关键 symbols：**`PluginDiscovery`、options、`resolveManifestPath`、`detectPluginId`、`createPluginDiscovery`。
- **旧语义与策略：**roots 缺省为 location rules，传入 root trim/去空/按原字符串去重；每 root 串行列目录，只接受目录，按 `openclaw.plugin.json` 再 `package.json` 找 manifest。ID 优先 manifest id/name，再 directory basename；allowlist 非空为 exact-match；相同 ID 由 root order first-wins；最终按 English locale id 排序。无法列 root 静默 continue；manifest path/ID read rejection可传播；固定 FS 输入下幂等但每次全量扫描。
- **状态、存储与副作用：**只读 filesystem port，无 cache / 写入。
- **并发与性能特征：**root、entry、manifest probe 均串行，约 O(roots + directories×2) FS round trips；最终 sort O(n log n)。
- **调用/依赖边界：**`PluginCatalogDiscoveryWorkflow` 和 OpenClaw plugin skill sync 调用；使用 location/id/filesystem port，输出 `RuntimeHostDiscoveredPlugin`。
- **故障、恢复与安全：**workspace `packages` 中任意含 package manifest 的目录可成为候选；不执行 code，但没有 trust/root containment/schema/size policy。坏 listing 被忽略，坏 manifest 的最终行为依 Node FS adapter / manifest loader 而异。
- **迁移分类：**Preserve：root 与 manifest precedence、first-wins、root list failure skip、sorted output。Intentional Improvement：有 differential tests 后才可并行/缓存/canonical root dedupe。待验证：普通 workspace package 是否应被发现、malformed manifest 应跳过还是使 catalog 失败、raw path duplicate 的实际成本。
- **未来 Rust owner：**Native Runtime Edge；面向 Plugin Domain Module 输出 location projection。
- **Rust 重写与性能判断：**固定顺序扫描或受限并发后按 discovery priority 选 first-wins，使用 `BTreeMap`/stable sort。并行扫描必须不改变 first-wins。指标：扫描 I/O、catalog startup、结果顺序；以 fake-FS differential oracle 约束。
- **验证 oracle：**`plugin-catalog-repository.test.ts` 间接覆盖正常 bundled catalog；需 fake-FS table 覆盖 root failure、duplicates、allowlist、manifest precedence、sort、malformed input。证据为 plugin catalog workflow、OpenClaw plugin skill sync。
- **证据：**`createPluginDiscovery`、`PluginCatalogDiscoveryWorkflow`、OpenClaw plugin skill sync、`plugin-catalog-repository.test.ts`。

### runtime-host/plugin-engine/plugin-file-system.ts

- **当前 owner：**插件专用 filesystem port；文件本身不拥有 storage policy。
- **职责与关键 symbols：**`PluginDirectoryEntry`、`PluginPathSignature`、`PluginFileSystemPort`（exists/read/list/mkdir/remove/copy/write/signature）。
- **旧语义与策略：**interface 无默认或实现。当前 `NodePluginFileSystem` 调用端证据表明：access error→`false`，JSON 读/parse/non-record error→`null`，read/list/write error 传播，mkdir recursive、remove recursive force、copy recursive force、stat error→`null`。
- **状态、存储与副作用：**port 定义读和直接本地写/删/复制副作用；无事务或持久化 owner。
- **并发与性能特征：**接口无锁、取消、atomic write 或背压；递归 copy/remove 的成本按树大小，安装/删除并发竞争语义未定义。
- **调用/依赖边界：**composition 绑定 Node adapter；discovery 取只读子集，managed installer / companion skill / OpenClaw projections 取 mutation 子集。
- **故障、恢复与安全：**无 path sandbox、symlink policy、权限 policy；调用方必须提供可信受限路径。没有 secret/redaction 责任。
- **迁移分类：**Preserve：已有 adapter 的 false/null error folding 和 force recursive behavior，前提是调用者 fixture 证明依赖。Intentional Improvement：Foundation 提供通用受控 FS primitive；Native Edge 保留 plugin path policy。待验证：force remove 链接行为、并发 install 一致性。无 Defect 结论。
- **未来 Rust owner：**机制分拆：Foundation Kernel（generic controlled FS / atomic IO）；Native Runtime Edge（plugin roots、path capability 与接口映射）。
- **Rust 重写与性能判断：**`PluginFileSystem` trait；需写侧增加 containment、atomic replace、cancellation 时先定义新的行为。不要无证据优化 recursive copy；测量 copy I/O、恢复、并发冲突。
- **验证 oracle：**temp-dir fault tests：missing/permission/bad JSON/non-record/overwrite/remove/signature/concurrent install；证据为 `composition/plugin-file-system-adapter.ts` 和 installer calls。
- **证据：**`PluginFileSystemPort`、`composition/plugin-file-system-adapter.ts`、managed installer 调用面。

### runtime-host/plugin-engine/plugin-id.ts

- **当前 owner：**Native Runtime Edge 的插件 ID compatibility normalization。
- **职责与关键 symbols：**`normalizePluginId`、`resolvePluginId`。
- **旧语义与策略：**非 string / blank→`undefined`；trim；`@scope/name` 去 scope 成 `name`；普通 ID 保持；resolve 缺有效 ID 用 fallback，不抛。固定输入幂等。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**O(ID length)。
- **调用/依赖边界：**discovery 的 id/name/basename fallback，manifest loader 的 ID normalizer。
- **故障、恢复与安全：**不验证字符、长度、reserved word 或唯一性；不能当安全 identity validator。
- **迁移分类：**Preserve：trim/scope removal/undefined-fallback。待验证：`@a/foo` 与 `@b/foo` 都映射 `foo`，结合 discovery first-wins 是否允许 collision。无 Defect 结论。
- **未来 Rust owner：**Native Runtime Edge。
- **Rust 重写与性能判断：**pure `Option<PluginId>` normalizer；若改 collision-safe global identity，必须是 Intentional Improvement 并做 compatibility migration。
- **验证 oracle：**补 table：non-string、blank、plain、scoped、collision、fallback；证据为 discovery / manifest loader。
- **证据：**`normalizePluginId`、`resolvePluginId`、`plugin-discovery.ts`、`plugin-manifest-loader.ts`。

### runtime-host/plugin-engine/plugin-location-rules.ts

- **当前 owner：**Native Runtime Edge 的本地/OpenClaw 插件目录布局和 source/platform/kind classifier。
- **职责与关键 symbols：**manifest names、`PluginLocationContext`、default/OpenClaw roots、source/platform/kind classifiers。
- **旧语义与策略：**默认 root 顺序：`workingDir/plugins`、`workingDir/packages`、可选 user MatchaClaw dir、OpenClaw config extensions、OpenClaw dist extensions；OpenClaw runtime scan 只后二者。manifest precedence 为 openclaw manifest 后 package；路径 `resolve()` 比较，未知 root→workspace；openclaw manifest→openclaw platform，其余→matchaclaw；only extension sources→third-party，其余 builtin。纯、确定、无 symlink resolution。
- **状态、存储与副作用：**无。
- **并发与性能特征：**常数路径构造/比较。
- **调用/依赖边界：**discovery 使用完整规则；OpenClaw projection 的 discovery state 使用 OpenClaw roots / manifest name，也有 source classifier 的相邻重复。
- **故障、恢复与安全：**不定义 trusted roots、containment 或 symlink 策略。
- **迁移分类：**Preserve：root order / mapping / optional root omission。Intentional Improvement：把 projection 内 duplicate source classification 收敛至一个 tested classifier；先核实两个调用面差异。待验证：matchaclaw-extension branch 在 projection 仅两根扫描时的可达性。无 Defect 结论。
- **未来 Rust owner：**Native Runtime Edge；Foundation 仅能提供 canonical-path primitive。
- **Rust 重写与性能判断：**injected `PluginLocationClassifier`，不读取全局环境；无需优化。
- **验证 oracle：**roots order、relative/absolute equivalent、source/platform/kind matrix；证据为 discovery 与 `openclaw-plugin-discovery-state.ts`。
- **证据：**`PluginLocationContext`、`plugin-discovery.ts`、`openclaw-plugin-discovery-state.ts`。

### runtime-host/plugin-engine/plugin-manifest-loader.ts

- **当前 owner：**Native Runtime Edge 的 manifest decode / catalog input normalization。
- **职责与关键 symbols：**`PluginManifestLoader`、`isRecord`、`createPluginManifestLoader`。
- **旧语义与策略：**read text + JSON.parse；ID 用 id/name normalizer，缺失时 package fallback `package`、OpenClaw fallback `openclaw`；name fallback ID、version `0.0.0`、category `general`、空 description omit。contracts 仅 non-array record，speech/media provider arrays 只保留 non-empty strings；group channel 从 `channel` 或 `openclaw.channel`，model 从 providers 或两个 contract arrays 推导。read/parse error 传播；顶层非 object 未显式保证，可能后续访问失败。
- **状态、存储与副作用：**只读、无缓存，parse/array filter 线性。
- **并发与性能特征：**单 manifest O(size + provider entries)；catalog workflow 对 discovered plugins `Promise.all` 并行调用。
- **调用/依赖边界：**catalog discovery 和 managed plugin installer。manifest 的 contracts 是 plugin metadata，不等于已证明的跨 Runtime grammar。
- **故障、恢复与安全：**不执行 plugin code、无 schema/path/size trust policy；metadata 可影响 catalog grouping。read errors 直接影响 caller。
- **迁移分类：**Preserve：trim/default/omit、contract filtering、group hint derivation。Intentional Improvement：raw parse 与 catalog grouping 分离；若 contracts 未来成为 canonical capability grammar，目标 owner 必须是 Matcha Platform Core，manifest adapter 只翻译。待验证：loader fallback ID 与 discovery directory fallback 不一致；non-object/bad manifest 的 catalog failure policy。无 Defect 结论。
- **未来 Rust owner：**Native Runtime Edge decode；Plugin Domain Module 拥有 catalog grouping policy。
- **Rust 重写与性能判断：**raw `serde_json::Value` 后 typed compatibility normalizer；先以 fixtures 固定 `null`/array/error 行为，再决定显式 reject。无无证据性能改写。
- **验证 oracle：**fixtures：missing/blank/scoped ID、bad JSON、null/array root、mixed contracts、channel/model hints、两种 fallback；证据为 catalog workflow 和 managed installer。
- **证据：**`createPluginManifestLoader`、catalog discovery、managed plugin installer。

---

## Shared

### runtime-host/shared/browser-mode.ts

- **当前 owner：**Runtime configuration 的 browser mode normalization；Host 配置适配，不是 bridge capability grammar。
- **职责与关键 symbols：**`BrowserMode = off|relay|native`、`normalizeBrowserMode`。
- **旧语义与策略：**仅精确三个 string 保留；任何其他值（含空、大小写变体、非 string）默认 `native`，不抛、幂等。
- **状态、存储与副作用：**纯函数；settings/config sync 后才有副作用。
- **并发与性能特征：**O(1)；无内部并发状态。
- **调用/依赖边界：**settings store、runtime-config sync、OpenClaw browser projection/restart workflow 消费。
- **故障、恢复与安全：**invalid 输入 fail-open 到 native，可能影响 browser/relay policy；无证据可改为 off/reject。
- **迁移分类：**Preserve：native default。待验证：invalid configuration 的安全产品意图。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration / configuration adapter。
- **Rust 重写与性能判断：**serde enum + explicit `Value -> Native` normalizer；无优化。
- **验证 oracle：**settings proxy-sync test 与 table vectors；证据为 settings/runtime config workflows。
- **证据：**`normalizeBrowserMode`、settings store、runtime-config sync、OpenClaw browser projection/restart workflow。

### runtime-host/shared/capability-descriptor.ts

- **当前 owner：**Matcha Platform Core 的跨 adapter capability descriptor grammar。
- **职责与关键 symbols：**support/availability、operation / descriptor DTO（id、kind、scope、target kinds、operations、policy/owner/route metadata）。
- **旧语义与策略：**类型定义，无 local defaults/validation；registry/router 层负责注册、owner、scope、target/operation 拒绝。
- **状态、存储与副作用：**无状态、无存储、无 I/O 或副作用；仅声明 capability descriptor DTO/类型 grammar。
- **并发与性能特征：**无；consumer registry 使用 map/index。
- **调用/依赖边界：**被 application capability registry/router 和 runtime adapters 消费；不能被 Gateway bridge 重新拥有。
- **故障、恢复与安全：**descriptor 不是授权实现；缺 owner/policy 等输入拒绝必须在 Core registry 维持。
- **迁移分类：**Preserve：字段 grammar 和 Core-side validation contract。待验证：全部 descriptor field 是否仍需要 public wire exposure。无 Defect 结论。
- **未来 Rust owner：**Matcha Platform Core。
- **Rust 重写与性能判断：**strong newtypes/enums；`HashMap<(CapabilityId, OperationId), HandlerRef>`；性能是索引而非迁移承诺。
- **验证 oracle：**`capability-registry.test.ts`、`capability-router.test.ts` 和 descriptor validation cases。
- **证据：**`capability-registry.test.ts`、`capability-router.test.ts`、application capability registry/router。

### runtime-host/shared/chat-message-normalization.ts

- **当前 owner：**Session transcript / renderer prompt-artifact policy，非 Foundation。
- **职责与关键 symbols：**message role/text/identity normalization、canonical-user / assistant display cleanup、internal/control detection、transcript retention。
- **旧语义与策略：**未知 role→undefined；非 text block 不抽文本；只剥离已知前导 Bootstrap/untrusted metadata/conversation envelope 工件；tool result 不进 canonical transcript。assistant 精确 `NO_REPLY` / `HEARTBEAT_OK` 视 control，用户同文字不隐藏；canonical identity 默认 `messageId <- id`、`originMessageId <- parentMessageId`。不修改输入，未改变可复用原 array。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**对内容/regex 前缀线性；超长恶意前缀成本待量测，无实际缺陷证据。
- **调用/依赖边界：**transcript parser、canonical replay/projection、renderer helpers 使用；不属于 Gateway transport。
- **故障、恢复与安全：**对 known untrusted artifact 清洗，但不是通用 secret redactor。
- **迁移分类：**Preserve：user/assistant 控制消息不对称、artifact stripping、identity fallback。待验证：超长输入性能和更广 control tokens。无 Defect 结论。
- **未来 Rust owner：**Session Domain Module。
- **Rust 重写与性能判断：**typed role/identity + `serde_json::Value`，预编译 regex 或 explicit prefix parser；仅在基准证明时优化，指标是 message length p99 / allocations。
- **验证 oracle：**`chat-message-normalization.test.ts`；调用证据为 transcript/canonical/render modules。
- **证据：**`chat-message-normalization.test.ts`、transcript/canonical/render modules。

### runtime-host/shared/device-identity.ts

- **当前 owner：**Gateway authentication protocol signing serializer；不归 Foundation。
- **职责与关键 symbols：**`DeviceIdentity`、V3 params、`buildDeviceAuthPayloadV3`。
- **旧语义与策略：**签名原文固定 11 个 `|` 字段；scope 保持输入顺序以逗号 join；空 token 为空字段；platform/deviceFamily trim 后 ASCII lowercase。builder 不验证 nonce/scopes/timestamp/separators。
- **状态、存储与副作用：**纯 O(input length)，实际 private key cache/IO 在 auth service。
- **并发与性能特征：**无。
- **调用/依赖边界：**`GatewayAuthService` 传产物给 crypto signer；固定 V3 bytes 是 Gateway compatibility boundary。
- **故障、恢复与安全：**`privateKeyPem`、token 和 payload 敏感，绝不能送 logger；无 redaction 在此实现。
- **迁移分类：**Preserve：字段顺序、空字段、lowercase、scope order。待验证：输入 separator 是否需要 protocol-side validation。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**non-serializable secret key handle，byte-exact serializer；无性能改写。
- **验证 oracle：**`runtime-host-device-identity.test.ts` 固定 V3 string，配固定 key signature vector。
- **证据：**`buildDeviceAuthPayloadV3`、`GatewayAuthService`、`runtime-host-device-identity.test.ts`。

### runtime-host/shared/gateway-chat-send-params.ts

- **当前 owner：**Gateway RPC `chat.send` parameter adapter，Runtime Integration。
- **职责与关键 symbols：**identity/input DTO、`buildGatewayChatSendParams`。
- **旧语义与策略：**session/idempotency key trim 后空则 omit；非 string message→`''`；deliver 只要非 null/undefined 透传；仅非空 attachments array 透传，未深验证/clone。
- **状态、存储与副作用：**纯 O(1)，attachments 引用共享。
- **并发与性能特征：**无；调用方 mutation 可影响同一引用，现有行为。
- **调用/依赖边界：**bridge chat send 用它，media workflow 负责附件内容。
- **故障、恢复与安全：**不验证 attachment/secret；只做 RPC shape。
- **迁移分类：**Preserve：字段 omission、falsy message、no deep copy。待验证：附件 deep validation 是否属于上游。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration。
- **Rust 重写与性能判断：**`Option<String/bool/Vec<Value>>` + `skip_serializing_if`；不要擅自加深校验。
- **验证 oracle：**chat.send wire fixture、media workflow integration case。
- **证据：**`buildGatewayChatSendParams`、OpenClaw bridge chat send、media workflow。

### runtime-host/shared/gateway-error.ts

- **当前 owner：**Gateway transport error contract。
- **职责与关键 symbols：**`GatewayIssueSource`、`GatewayTransportIssue`。
- **旧语义与策略：**类型仅描述 message/source/timestamp 与 optional code/details/retry metadata；无 builder / validation。
- **状态、存储与副作用：**无。
- **并发与性能特征：**无。
- **调用/依赖边界：**client state/error/frame/RPC 创建，session/runtime state 读取投影。
- **故障、恢复与安全：**`details: unknown` 可含大对象或 secret，producer/API/log boundary 必须约束；本类型不提供 redaction。
- **迁移分类：**Preserve：source vocabulary与 optional fields。Intentional Improvement：在 public projection 限 size/redact，需独立测试。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration 的 transport DTO；若有通用 redaction 则调用 Foundation primitive。
- **Rust 重写与性能判断：**serde source enum，`Option<Value>` details；无性能议题。
- **验证 oracle：**client-state issue serialization and fault scenarios。
- **证据：**`GatewayTransportIssue`、`client-state.ts`、frame/RPC/client state producers。

### runtime-host/shared/logger.ts

- **当前 owner：**Runtime observability infrastructure；当前不归 Foundation 的 secret primitive。
- **职责与关键 symbols：**`RuntimeHostLogger`、clock/sink ports、`createRuntimeLogger`。
- **旧语义与策略：**统一 `[timestamp] [LEVEL] [runtime-host:scope]`，清理 ANSI/newline/empty line；对象 JSON 化，循环 fallback `String`；Error 输出 message/stack；`traceDebug` 受 trace level gate。
- **状态、存储与副作用：**logger 无状态，写 injected sink；每条 log 序列化参数。
- **并发与性能特征：**复杂 object/stack 可能热路径成本，sink 异步/线程安全不在此文件。
- **调用/依赖边界：**Gateway client logs lifecycle metadata；Electron trace logger 的并行兼容面。
- **故障、恢复与安全：**没有 token/key/secret redaction；这不是已证实泄漏 defect，但 auth payload 与 params 不得传入。若新增通用 redaction，应作为单独 Foundation Kernel primitive，而非混入 message cleanup。
- **迁移分类：**Preserve：format、ANSI/newline cleanup、trace gating。Intentional Improvement：单独建立 tested redaction layer。待验证：所有日志调用是否隔离 credentials。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration observability adapter；通用 redaction（尚不存在）才归 Foundation Kernel。
- **Rust 重写与性能判断：**Clock/LogSink trait + structured event；保持 text format 或作版本化变化。测量 allocation / sink latency 后才优化。
- **验证 oracle：**`trace-log-level.test.ts`、runtime logger helper / Electron trace compatibility vectors。
- **证据：**`createRuntimeLogger`、`trace-log-level.test.ts`、Electron trace compatibility surface。

### runtime-host/shared/matcha-terminal-delivery-trace.ts

- **当前 owner：**Matcha terminal-delivery 的窄 correlation/metadata 机制：Matcha runtime 的生成、注入和协议适配属于 **Runtime Integration**；terminal session update 的 canonical 应用属于 **Session Domain Module**；日志 sink 机制仅是 **Foundation Kernel** 候选。此处尚非跨 Runtime 稳定 correlation grammar，不能归 **Matcha Platform Core**。
- **职责与关键 symbols：**`MatchaTerminalDeliveryPhase`、`MatchaTerminalDeliveryTraceCorrelationFactory`、`readMatchaTerminalDeliveryTraceContext`、`attachMatchaTerminalDeliveryTraceToEnvelope`、`attachMatchaTerminalDeliveryTrace`、`createMatchaTerminalDeliveryTraceLogger`；定义 terminal trace 的阶段、关联和 `_meta.matchaTerminalDelivery` 投影。
- **旧语义与策略：**terminal phase 仅为 `final`、`error`、`aborted`，由 `run.completed`、`run.failed`、`run.cancelled`/`run.interrupted` 映射；其他 `run.*` 是 lifecycle，非 `run.*` 是 non-terminal。bridge/run trace ID 分别为 factory 实例内 `matcha-bridge-N`/`matcha-run-N` 的连续内存计数器，进程重启不持久化。shared reader 只校验 metadata 的 record 形状、terminal phase、`session_info_update` 的 phase 对齐（如有）及 ID；它不校验 protocol 来源。`runTraceId` 可为 `null`，非空时才须匹配 `matcha-run-N`；factory 对 terminal 生成非空 run ID，但 reader 接受 `null`。
- **状态、存储与副作用：**factory 持有两个递增计数器，无文件、数据库或 checkpoint；logger adapter 将 record 以 trace level 4 交给 injected `traceDebug` sink。trace record 只含 stage、opaque bridge/run correlation、event class/phase、seq/checkpoint/pending count 和 error category；不得承载 `sessionId`、业务 `runId`、`eventId`、assistant 正文或 error 正文。
- **并发与性能特征：**ID 递增为 O(1)，但 metadata attach 是顶层 event 与 `_meta` 的对象 spread 浅复制：不遍历嵌套 snapshot/item/raw event，成本仍随被 spread 的 own keys 增长，不能表述为严格 O(1)。Matcha event bridge 对同一 `consumeTail` 串行消费；仅有效正整数 `seq` 会进入 `lastContiguousSeq`/`pendingBySeq` 的连续消费循环。无/非法 seq 直通消费而不推进 checkpoint，gap 只缓冲、duplicate 只丢弃，均不推进；只有进入该循环的 expected seq 在 consume resolved 或 rejected 后才推进并写 checkpoint，避免一个 ingress 失败阻塞后续连续事件。
- **调用/依赖边界：**只有 `MatchaAgentEventBridge` 生成 correlation 并向 terminal app-server envelope 注入 metadata。`SessionGatewayIngressWorkflow` 仅在 Matcha protocol 下读取并向 phase 相符的 canonical session update 传播；`SessionRunWorkflow` 为 ingress resolved/rejected 读取形状并记 trace，composition 的 parent `session:update` emit 路径与 renderer 也都只作同一 metadata 形状读取，不验证 protocol 来源。renderer 再将合法形状投影为 received/applied/rejected。
- **故障、恢复与安全：**非 record、非 terminal、phase 不匹配或无效 ID 的 metadata 不被 reader 采纳；但 metadata 没有签名、来源标记或 capability 证明，shared reader 本身不能认证其 protocol 来源。logger 无 redaction，故相关调用不得传入业务正文或身份值。bridge consume failure 记录类别化 rejected 后继续连续 seq；trace ID 在运行时重启后重新起算，不能作为 durable correlation。跨 Runtime correlation 是否稳定、是否应形成 Core grammar均为待验证。
- **迁移分类：**Preserve：三种 terminal phase、事件类型映射、opaque record 字段集、metadata 形状/phase/ID gate、仅 Matcha ingress 的传播边界、同 session 的有效连续 seq 顺序与失败后前进。待验证：reader 接受 `runTraceId: null` 与其终态 TypeScript 类型声明的契约、trace counter 重启后的运维可辨识性，以及跨 Runtime correlation 的稳定 grammar；无 Defect 结论。
- **未来 Rust owner：**分拆：Matcha runtime adapter/injection 为 **Runtime Integration**；canonical terminal session update 为 **Session Domain Module**；通用日志 sink 机制若抽取则为 **Foundation Kernel**。只有有稳定、跨 Runtime 的 correlation 契约后，其 grammar 才可转入 **Matcha Platform Core**。
- **Rust 重写与性能判断：**不据此提出新的 Rust 实施计划；若未来迁移，只以现有 type/测试保持上述窄 metadata、浅复制和有效连续 seq 语义，不能把 session terminal 语义泛化为 Core 或借迁移改变持久化、checkpoint、背压行为。
- **验证 oracle：**现有 `tests/unit/matcha-agent-runtime-adapter.test.ts` 覆盖有序 terminal、gap 与 opaque record，`tests/unit/session-gateway-ingress-workflow.test.ts` 覆盖 Matcha canonical terminal attach/非 Matcha 或 phase mismatch，`tests/unit/gateway-events.test.ts` 覆盖 renderer received/applied/rejected/rejected-shape；均未运行。明确待补：parent emit trace、`final`/`error`/`aborted` 三 phase 的同一 correlation 全链、malformed/`null` `runTraceId`、无 seq，以及 sequenced rejection 后 checkpoint 前进的 oracle。
- **证据：**`runtime-host/shared/matcha-terminal-delivery-trace.ts`；`runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-event-bridge.ts`；`runtime-host/application/workflows/session-run/session-run-workflow.ts`；`runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts`；`runtime-host/composition/modules/session-runtime-module.ts`；`src/stores/gateway.ts`；上述三份现有测试。

### runtime-host/shared/parent-transport-contracts.ts

- **当前 owner：**Runtime Host 与 parent shell 的 IPC/HTTP compatibility wire contract。
- **职责与关键 symbols：**shell actions、gateway/job forward event names、success/failure/upstream discriminated payload。
- **旧语义与策略：**封闭 action/event union，合约自身无 parser/default/retry；parent transport client 实际执行 envelope/token/timeout validation。
- **状态、存储与副作用：**无。
- **并发与性能特征：**无。
- **调用/依赖边界：**`composition/parent-transport-client.ts` 和 route composition；不是 Gateway WebSocket contract。
- **故障、恢复与安全：**dispatch token/header、timeout、response validation 由 client 层承担；合约内 payload 仍可能含敏感 data。
- **迁移分类：**Preserve：tagged wire vocabulary。待验证：各 shell action 的 idempotency / retry contract。无 Defect 结论。
- **未来 Rust owner：**Delivery / Runtime Host wire adapter；不属于 Matcha Platform Core business facts。
- **Rust 重写与性能判断：**serde tagged enums + HTTP/IPC client explicit deadline；无性能议题。
- **验证 oracle：**`parent-transport-client.ts`、`runtime-host-route-composition.test.ts`。
- **证据：**`ParentGatewayForwardEventName`、`composition/parent-transport-client.ts`、`runtime-host-route-composition.test.ts`。

### runtime-host/shared/platform-runtime-contracts.ts

- **当前 owner：**Runtime 内 tool harness contract，明确不归 Matcha Platform Core。
- **职责与关键 symbols：**driver、registry、context assembler、executor、policy、audit/event bus/reconciler ports，`ToolSource`、`ToolDefinition`。
- **旧语义与策略：**类型合约；实现侧默认过滤 `enabled === false`，context 默认空 prompt/resources/credentials，blocked tool 返回 deny，missing handler 返回 `tool_handler_not_found`。`ToolSource.kind` 是可扩展 string，不构成 platform grammar。
- **状态、存储与副作用：**文件无状态；实现用 in-memory Map、event emitter、audit sink。
- **并发与性能特征：**契约无策略；实现中 policy checks 多工具并行、audit/event capacity待核实。
- **调用/依赖边界：**platform-runtime state/executor/reconciler；bridge 仅以 tool source 传 runtime-native tool，不应因接口名被提升为平台 owner。
- **故障、恢复与安全：**契约未保证 schema validation、credentials isolation 或 durable audit。
- **迁移分类：**Preserve：tool harness 语义边界和现有 deny/missing-handler observable outcomes。Intentional Improvement：bounded event/audit、durable sink 需独立容量要求。待验证：in-memory state / synchronous emitter 的生产容量。无 Defect 结论。
- **未来 Rust owner：**Native Runtime Edge / Runtime Tool Harness，不是 Matcha Platform Core。
- **Rust 重写与性能判断：**独立 `tool_harness` crate，HashMap registry、bounded event channel、async ports；先定义 drop/persistence，测事件滞后/内存/handler latency。
- **验证 oracle：**`tool-registry-store.ts`、context/policy/executor/reconciler，专属 contract tests 待补。
- **证据：**tool registry/context/policy/executor/reconciler 实现；专属 contract tests 待补。

### runtime-host/shared/runtime-address.ts

- **当前 owner：**Matcha Platform Core 的 endpoint/scope/session/capability target canonical grammar。
- **职责与关键 symbols：**endpoint refs、scope / target unions、constructors、structured-key builders、equality/assert/validate、`targetBelongsToScope`。
- **旧语义与策略：**严格 kind、non-empty string、allowed keys、endpoint互斥和受限 nested target validation；非法输入 throw。structured key 用 JSON.stringify 避免 delimiter collision；无 owner task 不属于 scope；workspace-file 要 identity/endpoint/workspace/source 全匹配。
- **状态、存储与副作用：**纯函数。
- **并发与性能特征：**浅校验、key object allocation/stringify；无 I/O。
- **调用/依赖边界：**agent runtime contracts、capability router / registry；OpenClaw bridge 只消费投影，不能拥有语法。
- **故障、恢复与安全：**输入 validation 是 Core authorization routing 前置；没有直接 secret。
- **迁移分类：**Preserve：validation、key collision avoidance、scope membership deny cases。Intentional Improvement：cross-boundary key 应显式 versioned serializer，不能依赖 Rust serde field order。无 Defect 结论。
- **未来 Rust owner：**Matcha Platform Core。
- **Rust 重写与性能判断：**tagged enums + non-empty newtypes + `Eq/Hash`；process-local Hash key，wire key versioned canonical encoding。无极致优化。
- **验证 oracle：**`runtime-address-contract.test.ts`（collision、invalid fields、nested target、workspace boundary、unowned task deny），router bad-request mapping。
- **证据：**`runtime-address-contract.test.ts`、capability router/registry、agent runtime contracts。

### runtime-host/shared/runtime-host-constants.ts

- **当前 owner：**Runtime Host/Gateway transport policy constants。
- **职责与关键 symbols：**default port 3211、transport version 1、dispatch 15s、Gateway connect 10s、RPC 30s、HTTP method set、default account。
- **旧语义与策略：**constants only；consumer `parseInt(...) || 3211` 使缺失/非法/0 回 default；dispatch 拒绝未知 method/version，timer cleanup 在 callers。
- **状态、存储与副作用：**只读 constants / Set。
- **并发与性能特征：**O(1)。
- **调用/依赖边界：**client, parent transport, dispatch envelope。
- **故障、恢复与安全：**timeout 是 resource bound；port fallback 可改变部署目标，需保持或明确迁移。
- **迁移分类：**Preserve：数值、method/version allowlist。待验证：port 0 fallback是否刻意。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration / Runtime Host wire adapter。
- **Rust 重写与性能判断：**`Duration`、closed enum、config normalizer；不自动改变值。
- **验证 oracle：**dispatch envelope / parent client tests 与 Gateway client timing fixtures。
- **证据：**`runtime-host-constants.ts` consumers：Gateway client、parent transport、dispatch envelope。

### runtime-host/shared/runtime-topology.ts

- **当前 owner：**runtime registry / adapter control-plane read-model DTO，非 Core canonical grammar。
- **职责与关键 symbols：**protocol/adapter/connector/endpoint source/location/lifecycle、agent/control/capability summary、directory / snapshot types。
- **旧语义与策略：**纯 projection，无 default/validator；lifecycle `declared|connecting|ready|unavailable|disconnected`。capability booleans/summary 是诊断展示，不能作为授权。
- **状态、存储与副作用：**文件无状态；registry producer重建 snapshot arrays。
- **并发与性能特征：**snapshot O(endpoints + adapters + connectors)，无内部 lock。
- **调用/依赖边界：**`agent-runtime-registry.ts` 生产，route/UI consumers读取。
- **故障、恢复与安全：**connect/disconnect 同 endpoint 串行化未由本 DTO 表达，待验证。
- **迁移分类：**Preserve：projection vocabulary和 diagnostic-only status。Intentional Improvement：registry 可用 per-endpoint actor/mutex。待验证：lifecycle overwrite race。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration registry/control plane。
- **Rust 重写与性能判断：**`HashMap<EndpointRef, EndpointState>` + immutable snapshot；只有并发证据时加 keyed actor。测 snapshot latency / lifecycle consistency。
- **验证 oracle：**`agent-runtime-registry.test.ts` covering connecting/unavailable/connect/disconnect。
- **证据：**`agent-runtime-registry.ts`、`agent-runtime-registry.test.ts`。

### runtime-host/shared/session-adapter-types.ts

- **当前 owner：**Session application/runtime canonical timeline, snapshot, task projection and renderer ABI；渲染 DTO 不应误作 Core domain。
- **职责与关键 symbols：**run phase/state、timeline/render items、assistant/tool/approval/usage/artifact、execution graph、snapshot/update、task/todo types、`isRunActive` / `isWaitingTool`。
- **旧语义与策略：**active 仅 `submitted|streaming|waiting_tool|finalizing|stopping`；waiting 仅 `waiting_tool`。多为 type；input validation、event idempotency/ordering 在 ingress/reducer/coordinator，不在此文件。
- **状态、存储与副作用：**只读 active Set；DTO arrays，文件无 storage。
- **并发与性能特征：**phase Set O(1)；snapshot copy/order策略外置。
- **调用/依赖边界：**session model selection、turn assembler、canonical reducer/projection、renderer；Gateway events 只是来源。
- **故障、恢复与安全：**run/session identities 的正确关联是 session domain责任；无 secret handling。
- **迁移分类：**Preserve：phase predicates / wire labels。Intentional Improvement：per-session actor/keyed mutex 处理 reducer 和 ordering。待验证：complete snapshot ABI coverage。无 Defect 结论。
- **未来 Rust owner：**Session Domain Module（对外 DTO 由 Delivery/API adapter）。
- **Rust 重写与性能判断：**`SessionKey + RunId + LaneKey + TurnKey` keys、tagged event/timeline enums；测 reducer throughput、replay correctness、event loss。
- **验证 oracle：**session-model selection workflow、assistant turn assembler；迁移前补 snapshot golden fixtures。
- **证据：**session model selection、assistant turn assembler、canonical reducer/projection；snapshot golden fixtures 待补。

### runtime-host/shared/task-tool-contract.ts

- **当前 owner：**Runtime 内 task-manager/tool harness method normalization，不归平台。
- **职责与关键 symbols：**task snapshot methods set、`TaskSnapshotToolMethod`、normalizer/canonicalizer/predicates。
- **旧语义与策略：**non-string/blank→`''`；TodoWrite/TodoGet ASCII case-insensitive 并 canonicalize PascalCase；TaskCreate/Update/List/Get 为 strict case；仅 TodoWrite 是 state-only call snapshot。
- **状态、存储与副作用：**只读 Set、纯 O(1)。
- **并发与性能特征：**无。
- **调用/依赖边界：**gateway capability service、task snapshot normalizer、state-only tool extractor。
- **故障、恢复与安全：**不验证 tool params 或权限。
- **迁移分类：**Preserve：Todo 与 Task 的不对称大小写、state-only subset。待验证：为何仅 TodoWrite state-only。无 Defect 结论。
- **未来 Rust owner：**Native Runtime Edge / task tool harness。
- **Rust 重写与性能判断：**explicit parser enum，Todo ASCII casefold、Task exact match；不放 Core。
- **验证 oracle：**task snapshot/state-only workflow fixtures，gateway capability service method list。
- **证据：**`TaskSnapshotToolMethod` normalizer、gateway capability service、task snapshot/state-only workflow fixtures。

### runtime-host/shared/trace-log-level.ts

- **当前 owner：**Runtime observability configuration policy。
- **职责与关键 symbols：**`TraceLogLevel`、`resolveTraceLogLevel`、`isTraceLogLevelEnabled`。
- **旧语义与策略：**empty/0/false/no/off→0；true/yes/on/all/*/debug→7；其他使用 JS `parseInt` prefix semantics（如 `2foo`→2），negative/NaN→0，clamp max 7。纯、无缓存。
- **状态、存储与副作用：**无；logger 每 trace call 可重新解析 env。
- **并发与性能特征：**O(input)，debug low-frequency path。
- **调用/依赖边界：**`logger.ts` 和 Electron trace implementation。
- **故障、恢复与安全：**只控制 verbosity；高 level 可能扩大诊断暴露，但不 redaction。
- **迁移分类：**Preserve：JS prefix parser and aliases，不能直接替换为 strict Rust parse。待验证：environment re-read 是否刻意支持 runtime changes。无 Defect 结论。
- **未来 Rust owner：**Runtime Integration observability adapter。
- **Rust 重写与性能判断：**compat parser/golden vectors；若缓存 config，必须声明动态配置变化。无性能必要。
- **验证 oracle：**`trace-log-level.test.ts` + Electron vectors（disabled/all/clamp/threshold/prefix）。
- **证据：**`trace-log-level.test.ts`、`logger.ts`、Electron trace implementation。

### runtime-host/shared/transport-contract.ts

- **当前 owner：**Runtime Host HTTP / child-process wire DTO。
- **职责与关键 symbols：**version 1、request method/error-code unions、request/success/failure/health DTO。
- **旧语义与策略：**types/constants only；无 parser/auth/default/side effect；response discrimination by `success`。
- **状态、存储与副作用：**无。
- **并发与性能特征：**无。
- **调用/依赖边界：**与 `parent-transport-contracts.ts` 相邻但现有已取证正式 client 更直接使用后者及 constants；本文件专属 consumer 尚未确定。
- **故障、恢复与安全：**contract自身不实现 validation/auth。
- **迁移分类：**待验证：是否为活跃 transport contract、重复 DTO 或预留面；不能仅凭未定位 consumer 定为 Defect。若保留，Preserve tagged response semantics。
- **未来 Rust owner：**Runtime Host wire adapter / Delivery。
- **Rust 重写与性能判断：**serde tagged response、single version constant；先完成 usage inventory 再实施。
- **验证 oracle：**补 consumer search / wire fixture；已知 evidence 为 parent transport client 与 dispatch envelope 的相邻合约。
- **证据：**`transport-contract.ts`、parent transport client 与 dispatch envelope 的相邻合约；专属 consumer search/fixture 待补。

### runtime-host/shared/types.ts

- **当前 owner：**Runtime Host plugin/lifecycle/workbench read-model DTO collection。
- **职责与关键 symbols：**plugin kind/platform/source/lifecycle、runtime state/health/workbench payload、plugin manifest/discovery、legacy request/route result types。
- **旧语义与策略：**主要 types；producer 将 running host 的 enabled plugin 标 active，否则 inactive；非-running health 生成 child lifecycle error。DTO 自身不验证 manifest/path。
- **状态、存储与副作用：**无；runtime state / plugin discovery producer 有 I/O或 state。
- **并发与性能特征：**无。
- **调用/依赖边界：**plugin engine、runtime state、workbench/route composition；不应把 plugin metadata当 Capability Core grammar。
- **故障、恢复与安全：**path/trust validation 必须在 discovery/FS，不能依赖 DTO；无 secret primitive。
- **迁移分类：**Preserve：public labels和 state projection semantics。Intentional Improvement：按 owner 拆 DTO crate/module，避免聚合 shared 变事实 owner。待验证：legacy request/route types 的活跃调用面。无 Defect 结论。
- **未来 Rust owner：**按切片：Native Runtime Edge（plugin DTO）、Runtime Host integration（lifecycle/workbench），而非单 shared crate。
- **Rust 重写与性能判断：**typed enums/PathBuf internal string wire；无性能论断。
- **验证 oracle：**`runtime-state.ts`、plugin discovery/catalog、`runtime-host-route-composition.test.ts`。
- **证据：**`runtime-state.ts`、plugin discovery/catalog、`runtime-host-route-composition.test.ts`。

### runtime-host/shared/update-version.ts

- **当前 owner：**App Update Domain 的纯版本 comparison policy。
- **职责与关键 symbols：**private parser/prerelease comparator，`compareAppVersions`、`isUpdateVersionNewer`。
- **旧语义与策略：**接受 optional `v`、major.minor.patch、prerelease，忽略 build metadata；invalid→null，`isUpdateVersionNewer` fail-closed false。release 大于同 base prerelease；numeric prerelease 小于 nonnumeric；non-numeric 用 JS `localeCompare`。纯、幂等。
- **状态、存储与副作用：**无。
- **并发与性能特征：**linearly parse/compare，短 strings。
- **调用/依赖边界：**Electron updater 与 renderer update store 都消费。
- **故障、恢复与安全：**invalid remote version 不触发 update，fail-closed；无 secret。
- **迁移分类：**Preserve：v/build/prerelease/invalid behavior。待验证：JS localeCompare 的 Unicode/locale 与 Rust comparator compatibility；不能假定 SemVer crate 等同。无 Defect 结论。
- **未来 Rust owner：**Update Domain Module。
- **Rust 重写与性能判断：**`Option<Ordering>` plus compatibility parser; golden vectors first。无性能需求。
- **验证 oracle：**`update-version.test.ts`，再增加 Unicode / huge numeric / build metadata differential corpus。
- **证据：**`compareAppVersions`、`isUpdateVersionNewer`、`update-version.test.ts`。

---

## 未读项、排除项与工作树确认

- **未读范围文件：**0 / 42。
- **范围变化或 inventory 不一致：**新增未跟踪源码 `runtime-host/shared/matcha-terminal-delivery-trace.ts` 已作为本报告第 30 条完整审计并同步至 `00-inventory.md`；当前 runtime-host production source filesystem 为 589（`.ts` 588、`.cjs` 1）。除该路径外无缺失路径、未列路径或 `.cjs` 文件。
- **明确排除：**本分片固定路径外的 `runtime-host/build/**` 编译产物、依赖目录、测试输出、临时目录，以及构建配置，沿 `00-inventory.md` 的全局规则排除；它们不在本分片的 42 文件当前范围内。为理解调用链读取的文件只作证据，不计入分片文件数。
- **源代码未改确认：**本审计只写入本报告；范围清单由独立审计任务同步更新。未修改任何 `runtime-host` 源码、测试、README、其它审计报告、package 配置或锁文件。审计开始时工作树中已有若干 `openclaw-bridge` / `shared` 源文件改动；本次未对其写入或格式化。
- **验证：**仅静态审计（CodeGraph 调用链、源码/调用方及指定现有测试 oracle 核对）；未运行测试、Gateway、Electron 或 benchmark。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **残留 TypeScript Runtime Integration / Native Runtime Edge；Rust cutover 未证实。** `openclaw-bridge/**` 的 client/RPC/reconnect 实现和 `plugin-engine/**` 仍是生产 TS owner；不存在可证明替换它们的 Rust bridge/plugin owner。
- **生产 active path：** Electron 通过新 `electron/main/process-runtime/openclaw-gateway/**` 监督 Gateway，并把 port 传入 runtime-host；`composition/modules/gateway-bridge-module.ts` 构造 host-side Gateway client/bridge，`openclaw-infrastructure-module.ts` 绑定 `createOpenClawBridge`，再由 adapters/workflows 消费。`runtime-host/openclaw-bridge/{bridge,capabilities,client,client-frame-handler,client-heartbeat,client-pending-rpc,client-rpc-sender,client-socket-session,client-state}.ts` 都在当前 status 中变化，故仍是 active evolving TS protocol path；`shared/runtime-topology.ts` 是其投影。
- **外部旧 owner 与 current-vs-target 边界：** 已删除 `electron/gateway/**` 与 legacy runtime-host process manager 已由 `electron/main/process-runtime/**` 当前实现替代。其受管 Gateway/runtime-host lifecycle 部分是 Rust Local Process Host 必须重新走读并接管的外部旧 owner：包括 attach/orphan、readiness、restart/recovery、logs、shutdown、PID/provenance 与 process-tree policy；不能因其当前 Electron 目录而排除。该迁移不改变 `openclaw-bridge/**` 作为 Gateway 协议 owner 的事实，也不迁入 OpenClaw 的 native semantics。`shared/runtime-address.ts`/`capability-descriptor.ts` 仍为 TS 的跨-runtime grammar；plugin engine 仍为 TS native-edge。
- **旧策略与 future owner：** Preserve Gateway challenge/RPC/event/reconnect、plugin filesystem/manifest 和 shared transport grammar 的协议兼容；终态 Rust 分别以 Runtime Integration、Native Runtime Edge 和稳定的 Platform-Core grammar 实现这些 runtime-host 侧语义。生命周期基础机制可由 Foundation Kernel 提供，但不能把 OpenClaw native policy并入 Foundation；Electron 仅保留 Delivery client/desktop integration。`shared/matcha-terminal-delivery-trace.ts` 仍是 TS correlation adapter，执行语义未证实。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/runtime-host-process-openclaw-bridge.test.ts tests/unit/runtime-host-gateway-heartbeat.test.ts tests/unit/runtime-host-gateway-lifecycle.test.ts tests/unit/runtime-host-gateway-ready.test.ts tests/unit/gateway-event-bridge.test.ts tests/unit/openclaw-gateway-process-adapter.test.ts`；`pnpm exec vitest run tests/unit/agent-runtime-registry.test.ts tests/unit/capability-registry.test.ts tests/unit/matcha-agent-runtime-adapter.test.ts tests/unit/session-gateway-ingress-workflow.test.ts`；`pnpm run typecheck`。本次均**未运行**。
