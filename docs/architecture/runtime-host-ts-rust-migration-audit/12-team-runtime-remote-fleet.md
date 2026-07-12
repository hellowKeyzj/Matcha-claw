# 12. TeamRun 与 Remote Fleet：TS → Rust 文件级迁移审计

> 状态：静态审计完成；这是旧 TypeScript 实现的事实与迁移证据，不是 Rust 实施批准书。
>
> 本分片把 **TeamRun** 与 **Remote Fleet** 分别视为独立的 Domain Module。Matcha Platform Core 仅提供 identity、execution/correlation、capability/scope 与 receipt 的共同语法；Foundation Kernel 仅提供 task supervision、事务性存储、lease 原语与 redaction；OpenClaw、Session Runtime、Docker、Kubernetes、SSH、RuntimeAgent transport 均是 Integration。不得把 Remote agent 的 tool harness、审批决策或 Runtime 私有控制面提升为 Matcha Core 事实。

## 范围、方法与完备性

- **inventory 范围：** `00-inventory.md` 第 12 分片指定 93 个当前 `.ts` 文件：Remote Fleet 50 个、TeamRun 43 个。
- **实际读取：** 以当前主工作树执行 Python 枚举两个目录并对每个路径调用 `Path.read_text(encoding="utf-8")` 全文读取；结果 **inventory=93、on-disk=93、缺失=0、额外=0**。随后使用 CodeGraph 追踪 TeamRun graph/reducer/scheduler/actor/command-ledger/role-session/materialization/prompt-delivery/recovery，以及 Fleet lifecycle/command/lease/terminal/ingress/capability/reconcile/security 调用链。
- **审计方法：** 文件级静态走读、调用边界与已有测试/fixture 名称核对；没有执行生产运行、故障注入、基准或集成测试。文中的“Defect”只在代码顺序、状态机或输入处理可直接证明时标注；其余均为“待验证”。
- **迁移判读：** `Preserve` 是必须保持的可观察语义；`Intentional Improvement` 是明确不逐字复制旧实现的替换；不把 Rust actor、outbox、lease 或类型系统误写成外部 Docker/K8s/SSH/RuntimeAgent 的 exactly-once 保证。

## 完整已读路径（93）

### Remote Fleet（50）

1. `runtime-host/application/remote-fleet/index.ts`
2. `runtime-host/application/remote-fleet/infrastructure/remote-fleet-file-state-store.ts`
3. `runtime-host/application/remote-fleet/infrastructure/remote-fleet-node-identity.ts`
4. `runtime-host/application/remote-fleet/infrastructure/remote-fleet-system-clock.ts`
5. `runtime-host/application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry.ts`
6. `runtime-host/application/remote-fleet/remote-fleet-agent-client.ts`
7. `runtime-host/application/remote-fleet/remote-fleet-agent-ingress.ts`
8. `runtime-host/application/remote-fleet/remote-fleet-audit.ts`
9. `runtime-host/application/remote-fleet/remote-fleet-bootstrap-dispatcher.ts`
10. `runtime-host/application/remote-fleet/remote-fleet-bootstrap-docker-provider.ts`
11. `runtime-host/application/remote-fleet/remote-fleet-bootstrap-k8s-provider.ts`
12. `runtime-host/application/remote-fleet/remote-fleet-bootstrap-ssh-provider.ts`
13. `runtime-host/application/remote-fleet/remote-fleet-bootstrap.ts`
14. `runtime-host/application/remote-fleet/remote-fleet-capability-projection.ts`
15. `runtime-host/application/remote-fleet/remote-fleet-capability-routes.ts`
16. `runtime-host/application/remote-fleet/remote-fleet-command-dispatch.ts`
17. `runtime-host/application/remote-fleet/remote-fleet-command-policy.ts`
18. `runtime-host/application/remote-fleet/remote-fleet-command-queue.ts`
19. `runtime-host/application/remote-fleet/remote-fleet-connectors.ts`
20. `runtime-host/application/remote-fleet/remote-fleet-credential-host-rpc.ts`
21. `runtime-host/application/remote-fleet/remote-fleet-credential-store.ts`
22. `runtime-host/application/remote-fleet/remote-fleet-custom-terminal-config.ts`
23. `runtime-host/application/remote-fleet/remote-fleet-docker-target-config.ts`
24. `runtime-host/application/remote-fleet/remote-fleet-environment-secret-resolver.ts`
25. `runtime-host/application/remote-fleet/remote-fleet-k8s-target-config.ts`
26. `runtime-host/application/remote-fleet/remote-fleet-lease-manager.ts`
27. `runtime-host/application/remote-fleet/remote-fleet-log-stream.ts`
28. `runtime-host/application/remote-fleet/remote-fleet-metrics.ts`
29. `runtime-host/application/remote-fleet/remote-fleet-model.ts`
30. `runtime-host/application/remote-fleet/remote-fleet-operation-id.ts`
31. `runtime-host/application/remote-fleet/remote-fleet-ops-timeline.ts`
32. `runtime-host/application/remote-fleet/remote-fleet-reconcile.ts`
33. `runtime-host/application/remote-fleet/remote-fleet-routing-service.ts`
34. `runtime-host/application/remote-fleet/remote-fleet-runtime-agent-transport-dispatcher.ts`
35. `runtime-host/application/remote-fleet/remote-fleet-runtime-launch.ts`
36. `runtime-host/application/remote-fleet/remote-fleet-runtime.ts`
37. `runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc.ts`
38. `runtime-host/application/remote-fleet/remote-fleet-secret-policy.ts`
39. `runtime-host/application/remote-fleet/remote-fleet-service.ts`
40. `runtime-host/application/remote-fleet/remote-fleet-ssh-target-config.ts`
41. `runtime-host/application/remote-fleet/remote-fleet-store.ts`
42. `runtime-host/application/remote-fleet/remote-fleet-terminal-contracts.ts`
43. `runtime-host/application/remote-fleet/remote-fleet-terminal-custom-provider.ts`
44. `runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider.ts`
45. `runtime-host/application/remote-fleet/remote-fleet-terminal-k8s-provider.ts`
46. `runtime-host/application/remote-fleet/remote-fleet-terminal-manager.ts`
47. `runtime-host/application/remote-fleet/remote-fleet-terminal-providers.ts`
48. `runtime-host/application/remote-fleet/remote-fleet-terminal-ssh-provider.ts`
49. `runtime-host/application/remote-fleet/remote-fleet-worker-client.ts`
50. `runtime-host/application/remote-fleet/remote-fleet-worker-contracts.ts`

### TeamRun（43）

1. `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-materialization-adapter.ts`
2. `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-policy-projection.ts`
3. `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter.ts`
4. `runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts`
5. `runtime-host/application/team-runtime/adapters/session-runtime-team-role-session-adapter.ts`
6. `runtime-host/application/team-runtime/domain/team-command-ledger.ts`
7. `runtime-host/application/team-runtime/domain/team-event.ts`
8. `runtime-host/application/team-runtime/domain/team-evidence.ts`
9. `runtime-host/application/team-runtime/domain/team-instance.ts`
10. `runtime-host/application/team-runtime/domain/team-managed-agent.ts`
11. `runtime-host/application/team-runtime/domain/team-node-prompt-delivery.ts`
12. `runtime-host/application/team-runtime/domain/team-run.ts`
13. `runtime-host/application/team-runtime/graph/definition.ts`
14. `runtime-host/application/team-runtime/graph/export-yaml.ts`
15. `runtime-host/application/team-runtime/graph/index.ts`
16. `runtime-host/application/team-runtime/graph/projection.ts`
17. `runtime-host/application/team-runtime/graph/reducer.ts`
18. `runtime-host/application/team-runtime/graph/run-state.ts`
19. `runtime-host/application/team-runtime/graph/scheduler.ts`
20. `runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/index.ts`
21. `runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-command-ledger.ts`
22. `runtime-host/application/team-runtime/infrastructure/worker/team-runtime-worker-entry.ts`
23. `runtime-host/application/team-runtime/ports/team-agent-materialization-port.ts`
24. `runtime-host/application/team-runtime/ports/team-command-ledger-port.ts`
25. `runtime-host/application/team-runtime/ports/team-node-prompt-delivery-port.ts`
26. `runtime-host/application/team-runtime/ports/team-notification-port.ts`
27. `runtime-host/application/team-runtime/ports/team-role-session-materialization-port.ts`
28. `runtime-host/application/team-runtime/ports/team-role-session-port.ts`
29. `runtime-host/application/team-runtime/team-dependency-plan.ts`
30. `runtime-host/application/team-runtime/team-node-prompt-delivery-service.ts`
31. `runtime-host/application/team-runtime/team-run-registry.ts`
32. `runtime-host/application/team-runtime/team-runtime-cron-scheduler.ts`
33. `runtime-host/application/team-runtime/team-runtime-debug-logging.ts`
34. `runtime-host/application/team-runtime/team-runtime-jobs.ts`
35. `runtime-host/application/team-runtime/team-runtime-operation-id.ts`
36. `runtime-host/application/team-runtime/team-runtime-package-service.ts`
37. `runtime-host/application/team-runtime/team-runtime-port.ts`
38. `runtime-host/application/team-runtime/team-runtime-service.ts`
39. `runtime-host/application/team-runtime/team-runtime-state-store.ts`
40. `runtime-host/application/team-runtime/team-runtime-webhook-auth.ts`
41. `runtime-host/application/team-runtime/team-runtime-worker-client.ts`
42. `runtime-host/application/team-runtime/team-runtime-worker-contracts.ts`
43. `runtime-host/application/team-runtime/team-runtime-worker-host-proxy.ts`

---

# Remote Fleet Domain Module

### runtime-host/application/remote-fleet/index.ts

- **当前 owner：** 无运行时 owner；Remote Fleet public barrel。
- **职责与关键 symbols：** re-export `WorkerBackedRemoteFleetService`、`RemoteFleetRuntime`、port、queue/policy/dispatch、agent、bootstrap、terminal 与 capability 边界。
- **旧语义与策略：** 纯导出；同时导出 facade 与底层 runtime，调用方可绕开 worker actor 直接构造 aggregate。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无；但公开 Runtime 使单 writer 仅是组成约定。
- **调用/依赖边界：** API/composition 可依赖本 barrel；底层引用范围跨 Domain、Foundation-style storage 和 Integration。
- **故障、恢复与安全：** 无直接处理；过宽 public surface 使并发/持久化不变量难由类型边界强制。
- **迁移分类：** Preserve：稳定 facade；Intentional Improvement：Rust 仅公开 command/query facade，aggregate actor 设为内部；Defect：无；待验证：外部是否直接构造 Runtime。
- **未来 Rust owner：** Domain Module（Remote Fleet）的 public application facade；平台共同 `ExecutionReceipt` 引用 Platform Core。
- **Rust 重写与性能判断：** 无数据/actor/outbox/I-O；隐藏 aggregate 构造以守护单写者，不是性能优化。
- **验证 oracle：** 编译期 public API snapshot；组合根仅能得到 facade；并发调用通过 actor 路由。
- **证据：** `index.ts:3-10,68-78,130-172,299-310,388-402`。

### runtime-host/application/remote-fleet/infrastructure/remote-fleet-file-state-store.ts

- **当前 owner：** 文件快照基础设施。
- **职责与关键 symbols：** `FileRemoteFleetStateStore.readState/writeState` 读写整份 JSON state。
- **旧语义与策略：** 不存在文件返回 `null`；写入采用临时文件再 rename。
- **状态、存储与副作用：** 本地目录、`${statePath}.tmp`、全量 JSON；无 revision、journal、outbox 或 fsync 承诺。
- **并发与性能特征：** O(|state|) 序列化/写放大；无锁/CAS，固定 tmp 名在多进程下冲突。
- **调用/依赖边界：** `RemoteFleetRuntime` 经 `RemoteFleetStateStore` 使用；worker entry 组装 Node file-system 实现。
- **故障、恢复与安全：** rename 降低半写概率；未恢复残留 tmp，断电/跨进程最后写者覆盖仍待外层防护。
- **迁移分类：** Preserve：缺失→空状态、完整快照而非部分 JSON；Intentional Improvement：revision + transaction/WAL + fsync；Defect：无跨进程线性化可由代码证明；待验证：部署是否会多实例共享路径。
- **未来 Rust owner：** Foundation Kernel storage primitive 的具体 Infrastructure 实现，Fleet 仅拥有 snapshot schema。
- **Rust 重写与性能判断：** 单 Fleet actor 写；使用版本化双代或 SQLite transaction 使 state+outbox 原子。保持写成功只代表本地持久化，不能伪造远端完成。指标：写放大、恢复时间、崩溃后可读率。
- **验证 oracle：** write/rename 前后 fault injection；双进程写保留单调 revision；旧或新完整状态可恢复。
- **证据：** `remote-fleet-file-state-store.ts:23-39`。

### runtime-host/application/remote-fleet/infrastructure/remote-fleet-node-identity.ts

- **当前 owner：** 宿主 identity/credential helper。
- **职责与关键 symbols：** `randomId`、`randomToken`、`hashSecret`。
- **旧语义与策略：** 同步 CSPRNG 生成；`hashSecret` 为 SHA-256 指纹。
- **状态、存储与副作用：** 无持久化；读取 crypto 随机源。
- **并发与性能特征：** O(输入长度)，无共享状态。
- **调用/依赖边界：** Runtime 生成 agent/credential identity；hash 供 ingress credential 比对。
- **故障、恢复与安全：** 快速无盐 hash 适合高熵 token 指纹；若扩展为低熵口令验证会允许离线猜测。
- **迁移分类：** Preserve：随机 token 与不可明文存储的 hash 语义；Intentional Improvement：低熵秘密改用 KDF；Defect：当前无；待验证：所有输入是否高熵。
- **未来 Rust owner：** Foundation Kernel identity/secret primitive；Fleet 不拥有通用加密算法。
- **Rust 重写与性能判断：** `getrandom`/UUID 与 SHA-256；不引入 actor/outbox/storage。指标仅 token 生成延迟与正确长度。
- **验证 oracle：** 标准 SHA-256 vectors、token hex 长度与碰撞抽样。
- **证据：** `remote-fleet-node-identity.ts:4-15`。

### runtime-host/application/remote-fleet/infrastructure/remote-fleet-system-clock.ts

- **当前 owner：** wall-clock adapter。
- **职责与关键 symbols：** `nowIso()`。
- **旧语义与策略：** 返回当前 UTC ISO 字符串。
- **状态、存储与副作用：** 无；读取系统时间。
- **并发与性能特征：** O(1)，无共享状态。
- **调用/依赖边界：** 注入 Runtime、lease/audit/reconcile 时间判断。
- **故障、恢复与安全：** wall clock 非单调，NTP 回拨会影响租约和 stale 判断。
- **迁移分类：** Preserve：审计时间可序列化；Intentional Improvement：duration/deadline 使用单调 `Instant`，审计保留 UTC；Defect：无；待验证：时钟回拨的产品期望。
- **未来 Rust owner：** Foundation Kernel clock primitive。
- **Rust 重写与性能判断：** `Clock` trait；无 actor/outbox/I-O。不能用单调时钟伪造跨重启 lease 时间。
- **验证 oracle：** fake clock 回拨下 timeout 不提前/不永久延迟；ISO 可解析。
- **证据：** `remote-fleet-system-clock.ts:3-6`。

### runtime-host/application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry.ts

- **当前 owner：** Fleet worker composition root 与单进程 mailbox。
- **职责与关键 symbols：** `startWorkerRuntime`、`enqueueLifecycle`、`handleInvoke`、`closeWorkerRuntime`、`pendingHostRequests`。
- **旧语义与策略：** 所有 invoke/close 进入 `lifecycleQueue` 串行；host result 直接按 requestId resolve，不进入 aggregate mutation queue；state 懒加载于首个 invoke。
- **状态、存储与副作用：** worker 内持 Runtime、volatile pending RPC；组装 file store、identity、clock、host bridge，并使用 `worker_threads`。
- **并发与性能特征：** 单写者避免 Map 竞态；慢/永不返回的 host RPC 阻塞后续所有 invoke 与 close，形成 HOL blocking；pending 无上限/期限。
- **调用/依赖边界：** 接收 main→worker IPC，反向请求主线程 capability/secret/bootstrap/terminal/agent dispatch。
- **故障、恢复与安全：** invoke/close error 统一 opaque 化；close 排在卡住 invoke 后，无法及时 reject pending；`workerData` 仅信任父进程，无 runtime schema。
- **迁移分类：** Preserve：aggregate mutation 单写；Intentional Improvement：mailbox 与 I/O completion 分离、每 RPC deadline/cancel；Defect：无 deadline 导致 close 可永久阻塞；待验证：host RPC 实际超时层。
- **未来 Rust owner：** Foundation Kernel task supervision/worker mechanism + Remote Fleet Domain actor composition；非 Platform Core。
- **Rust 重写与性能判断：** Fleet actor 串行 state transition，外部 I/O 作为带 deadline 的 outbox task 回投 receipt；不能并行 aggregate mutation。指标：mailbox 延迟、pending 数、shutdown 时间。
- **验证 oracle：** 卡住 host RPC 时 close 有界；同一 state revision 的并发命令不丢更新；worker crash 后 pending 全部失败分类。
- **证据：** `remote-fleet-worker-entry.ts:24-53,55-102,113-165`。

### runtime-host/application/remote-fleet/remote-fleet-agent-client.ts

- **当前 owner：** RuntimeAgent protocol DTO normalizer/validator。
- **职责与关键 symbols：** `RuntimeAgentClientPort`、`RuntimeAgentTransport`、`normalizeRuntimeAgentClientTarget`、credential projection、request/snapshot validators。
- **旧语义与策略：** 接受 heartbeat/capability/command DTO；credential projection 只保留 type/id；progress/result 绑定 `commandId + idempotencyKey`；result 禁止 output/stdout/stderr。
- **状态、存储与副作用：** 纯函数，无 I-O/存储。
- **并发与性能特征：** 输入规模线性；递归 snapshot/plaintext scan 无总大小与深度限制。
- **调用/依赖边界：** transport 和 ingress 共用此 protocol；认证、命令所有权、重试由 Runtime/dispatcher 负责。
- **故障、恢复与安全：** 多个时间字段仅非空字符串、非 RFC3339 校验；`command.accept` 的 idempotency key 可选；secret 防漏是正向保护而非资源限制。
- **迁移分类：** Preserve：不回传 credential plaintext、结果输出拒绝；Intentional Improvement：versioned serde schema、尺寸/深度与时间校验；Defect：当前无边界上限；待验证：客户端兼容旧可选 idempotency 的需要。
- **未来 Rust owner：** Platform Core 可拥有 endpoint/execution/correlation grammar；Fleet Domain 拥有 agent-specific DTO；transport 在 Integration。
- **Rust 重写与性能判断：** 无 actor/outbox/storage；采用迭代/有界 decode。指标：最大 payload、拒绝耗时、无 plaintext 序列化。
- **验证 oracle：** malformed time/oversized nesting 拒绝；credential/result 序列化不含明文；differential DTO cases。
- **证据：** `remote-fleet-agent-client.ts:395-469,471-690,802-857,930-953`。

### runtime-host/application/remote-fleet/remote-fleet-agent-ingress.ts

- **当前 owner：** RuntimeAgent 入站 operation allowlist。
- **职责与关键 symbols：** `normalizeRuntimeAgentIngressOperation`、`createRuntimeAgentIngressRejectedResponse`。
- **旧语义与策略：** 只允许 heartbeat、command progress/result；拒绝 agent 发起 accept、capability、lifecycle 等 host→agent 操作。
- **状态、存储与副作用：** 纯 DTO normalizer，无 I-O。
- **并发与性能特征：** O(1)，无队列。
- **调用/依赖边界：** route/transport 入口后交 Fleet Runtime 认证和状态写入。
- **故障、恢复与安全：** rejection 会 trim/回显 requestId/agentId，未限长；认证、replay、速率限制不在本文件。
- **迁移分类：** Preserve：入站最小 allowlist；Intentional Improvement：身份验证后才构造回显、长度限制；Defect：无；待验证：HTTP 层日志是否记录回显。
- **未来 Rust owner：** Remote Fleet Domain ingress parser；共同 correlation 字段用 Platform Core。
- **Rust 重写与性能判断：** enum decode，无 actor/outbox；把认证事件交给 Fleet actor。指标：拒绝路径 allocation、超长输入日志安全。
- **验证 oracle：** 三个允许操作成功；四类下行操作拒绝；超长 ID 不原样进入日志/响应。
- **证据：** `remote-fleet-agent-ingress.ts:52-101,148-151`。

### runtime-host/application/remote-fleet/remote-fleet-audit.ts

- **当前 owner：** Fleet audit record 与 redaction policy。
- **职责与关键 symbols：** `createRemoteFleetAuditEventRecord`、metadata/message redaction、`summarizeRemoteFleetAuditEvent`。
- **旧语义与策略：** 创建时递归遮蔽敏感 metadata key，message 经共享 log redactor；timeline summary 重用 message。
- **状态、存储与副作用：** 纯投影，不负责 durable audit sink。
- **并发与性能特征：** O(metadata graph) 复制；循环结构会递归失败，非 plain object 可能保留引用。
- **调用/依赖边界：** Runtime 将 audit record 放入 state；ops timeline 再读取。
- **故障、恢复与安全：** 直接传入的既有 audit event 若未经 constructor，summary 不会二次 redaction；不能将这种类型约束当作日志安全证明。
- **迁移分类：** Preserve：写入前 redaction；Intentional Improvement：结构化 redaction、循环/大小限制，并在 sink 前强制执行；Defect：summary 绕过构造器可泄漏是代码可证缺口；待验证：所有写入是否只经构造器。
- **未来 Rust owner：** Foundation Kernel redaction primitive；Fleet Domain 的 audit event schema；实际 sink 属 Delivery/Infrastructure。
- **Rust 重写与性能判断：** 无 actor/outbox；可用有界 JSON visitor，避免栈溢出。指标：redaction 漏报率、最大对象处理时间。
- **验证 oracle：** 手造 event、JSON token/api_key、循环 metadata 都不得泄密或崩溃。
- **证据：** `remote-fleet-audit.ts:29-42,49-60,72-91`。

### runtime-host/application/remote-fleet/remote-fleet-bootstrap-dispatcher.ts

- **当前 owner：** bootstrap command provider/secret dispatch coordinator。
- **职责与关键 symbols：** `dispatchRemoteFleetBootstrapCommand`、`readExactBootstrapSecret`。
- **旧语义与策略：** provider kind 分派；secret ref 先 policy gate 后 resolve；原样返回 provider result。
- **状态、存储与副作用：** 调 provider I-O、secret host RPC；无 idempotency store、deadline、queue 或 outbox。
- **并发与性能特征：** 同 envelope 可并发进入 provider；无资源串行键。
- **调用/依赖边界：** Runtime/bootstrap worker host 调此 dispatcher；下游 Docker/K8s/SSH Integration。
- **故障、恢复与安全：** secret 失败映射为非明文失败；未调用 result validator，provider 错 commandId/providerKind 能穿透；connection/node/environment 的 secret precedence 与 Docker target resolve 不完全同构。
- **迁移分类：** Preserve：policy-gated secret resolve；Intentional Improvement：validated provider receipt + durable dispatch intent/lease；Defect：无 result validation、无并发 dedupe；待验证：各 provider 是否自带幂等。
- **未来 Rust owner：** Fleet Domain command application service；providers/secret RPC 是 Integration。
- **Rust 重写与性能判断：** actor 先持久 intent，再由 outbox 执行；每资源 lease 防重入。不得承诺 provider exactly-once。指标：重复 dispatch、timeout、收敛延迟。
- **验证 oracle：** 错 commandId/providerKind provider result 拒绝；policy deny 时 resolver=0；同 command 至多一个执行 lease。
- **证据：** `remote-fleet-bootstrap-dispatcher.ts:23-71,106-167`。

### runtime-host/application/remote-fleet/remote-fleet-bootstrap-docker-provider.ts

- **当前 owner：** Docker Engine bootstrap Integration。
- **职责与关键 symbols：** probe、install/deploy/delete、container create/start/inspect/setup exec。
- **旧语义与策略：** 拉取、创建、启动容器，Debian setup 修改 apt source/装包；409 create 与 delete 通过管理 label/404 等收敛；argv 而非 shell 拼接。
- **状态、存储与副作用：** Docker HTTP、token resolve、容器生命周期、远端 package 安装；无本地持久 phase。
- **并发与性能特征：** 无 `(endpoint,container)` 锁；setup poll 最多 600×1 秒、非全链路 deadline；响应先全读，最终摘要才截断。
- **调用/依赖边界：** bootstrap dispatcher 调 provider；config 来自 Docker target config；远端状态是 Docker API。
- **故障、恢复与安全：** create/start/setup 成功可在 completed receipt 之前崩溃，重试会重复 setup；不匹配 label 不删除是重要保护；`install-agent`/`deploy-environment` 共用创建流的资源归属待澄清。
- **迁移分类：** Preserve：managed-label ownership、409/404 收敛、secret ref；Intentional Improvement：持久 phase/tombstone、每资源互斥、全链路 deadline；Defect：无 durable phase 导致重跑副作用；待验证：Docker API 幂等细节。
- **未来 Rust owner：** Docker Runtime Integration；Fleet Domain 只拥有 desired/resource phase 与 receipt。
- **Rust 重写与性能判断：** endpoint/resource actor 和 image pull single-flight；outbox receipt 只记录请求/观察到状态，不能保证远端未重复。指标：API 次数、setup 重跑、恢复收敛时间。
- **验证 oracle：** create/start/setup/delete 各崩溃点后 inspect 收敛；同标签资源不并发 setup；不归属容器不 stop/remove；大输出输入字节受限。
- **证据：** `remote-fleet-bootstrap-docker-provider.ts:169-391,456-515,584-797,834-866,990-1112`。

### runtime-host/application/remote-fleet/remote-fleet-bootstrap-k8s-provider.ts

- **当前 owner：** Kubernetes bootstrap Integration。
- **职责与关键 symbols：** probe、Secret→Deployment→Service install、反向 delete。
- **旧语义与策略：** 409 后 GET 验证管理 labels 才 PATCH；404 delete 成功；enrollment token 作为 K8s Secret ref，不写入 Deployment plaintext env/result。
- **状态、存储与副作用：** K8s HTTP、secret resolution、Secret/Deployment/Service 资源。
- **并发与性能特征：** install 正常 3 个串行 POST，409 路径更多；无本地 state/outbox，GET→PATCH/DELETE 无 resourceVersion precondition。
- **调用/依赖边界：** dispatcher→provider→K8s API；target config 提供 endpoint/namespace/name。
- **故障、恢复与安全：** 仅 probe 有 timeout，install/delete 缺统一 Abort deadline；Secret 成功后后续失败留部分资源；completed 仅 API 接受，不等于 rollout/agent enrolled。
- **迁移分类：** Preserve：ownership labels、token 不入 plaintext、404 收敛；Intentional Improvement：desired generation、resourceVersion 与 readiness/enrollment receipt；Defect：关键请求无 deadline、阶段非原子；待验证：API client 默认 timeout。
- **未来 Rust owner：** Kubernetes Runtime Integration；Fleet Domain reconcile/outbox。
- **Rust 重写与性能判断：** 对连接/环境/node 分片 actor；存 desired/observed/tombstone，外部调用 deadline。指标：部分失败残留、rollout 时间、冲突重试。
- **验证 oracle：** invalid config 零 HTTP；安装顺序固定；未归属对象不 patch/delete；所有请求可取消；若 API 宣称 ready 则需 rollout+enrollment。
- **证据：** `remote-fleet-bootstrap-k8s-provider.ts:84-103,252-449,451-597`。

### runtime-host/application/remote-fleet/remote-fleet-bootstrap-ssh-provider.ts

- **当前 owner：** SSH bootstrap Integration。
- **职责与关键 symbols：** probe/connect/PTY shell/install command。
- **旧语义与策略：** resolve SSH secret、连接、执行 `sh -lc`；connect 15 秒、install 120 秒；stdout/stderr 截断和 redaction；token 以 POSIX quote 传递。
- **状态、存储与副作用：** SSH client、远端 shell/I-O；无远端 install marker 或本地 outbox。
- **并发与性能特征：** 无 node/agent lease；截断按字符非 UTF-8 字节。
- **调用/依赖边界：** bootstrap dispatcher、SSH target config、secret resolver。
- **故障、恢复与安全：** command contract 有 `delete-environment` 而 switch 未处理且无 default，可能返回 `undefined`；本地 timeout/断连不证明远端 shell 停止；没有明确 known-host/fingerprint policy。
- **迁移分类：** Preserve：secret redaction、bounded output；Intentional Improvement：远端 idempotency marker、host key pin、统一 finish；Defect：未处理 delete-environment 可由代码证明；待验证：上游是否禁止该 command。
- **未来 Rust owner：** SSH Runtime Integration；Fleet 只拥有命令 intent/receipt。
- **Rust 重写与性能判断：** resource actor 获 lease；所有 error/timeout/cancel 经同一 cleanup，外部结果仍为至少一次尝试。指标：orphan client、重复 exec、timeout 清理率。
- **验证 oracle：** delete-environment 明确成功/失败；远端成功本地断连不重跑；host key mismatch 失败。
- **证据：** `remote-fleet-bootstrap-ssh-provider.ts:57-96,217-378,396-425,580-635`。

### runtime-host/application/remote-fleet/remote-fleet-bootstrap.ts

- **当前 owner：** bootstrap 跨层 DTO、provider mapping 与 result validator。
- **职责与关键 symbols：** envelope、target/provider conversion、bootstrap result validation。
- **旧语义与策略：** target kind 固定映射 provider；idempotency key 只是字段；enrollment token 约定短生命周期、不持久化。
- **状态、存储与副作用：** 纯函数，无 I-O。
- **并发与性能特征：** O(payload)，无队列。
- **调用/依赖边界：** dispatcher/providers 使用此 contract；Runtime command/agent 生命周期关联。
- **故障、恢复与安全：** result validator 对 completed providerKind 仅 string、failed 更弱；未绑定 result commandId 到请求；secret field 检查只深入 managedResources，message/outputSummary 等仍可成为泄露面。
- **迁移分类：** Preserve：target→provider 及 token 不持久化；Intentional Improvement：请求关联的完整 result schema、non-serializable secret type；Defect：validator 不完整；待验证：provider 是否在其他层补验证。
- **未来 Rust owner：** Fleet Domain contract；共用 correlation/receipt 来自 Platform Core。
- **Rust 重写与性能判断：** 无 actor/outbox/storage；使用 tagged enum 与 request-bound validator。指标：非法 result 拒绝率、token 扫描覆盖。
- **验证 oracle：** result commandId/provider 精确匹配；所有持久/日志 DTO 无 token；失败分支同样校验字段。
- **证据：** `remote-fleet-bootstrap.ts:61-80,224-267,294-373`。

### runtime-host/application/remote-fleet/remote-fleet-capability-projection.ts

- **当前 owner：** Fleet capability projection pure core。
- **职责与关键 symbols：** scope normalize、descriptor fingerprint、freshness/prune。
- **旧语义与策略：** 校验 scope 与 endpoint 一致；stale/pruned 时清 descriptors/operation IDs；以 canonical JSON 表示 fingerprint。
- **状态、存储与副作用：** 纯函数；投影由 Runtime state 持久化。
- **并发与性能特征：** 排序+序列化 O(n log n + payload)；无 CAS。
- **调用/依赖边界：** runtime/capability route/reconcile/routing selector。
- **故障、恢复与安全：** “hash”实际为完整 canonical JSON，放大状态/暴露面；`localeCompare`、对象插入顺序/未来遗漏字段可能抖动或漏刷新。
- **迁移分类：** Preserve：scope consistency、stale/prune 行为；Intentional Improvement：版本化 canonical schema + digest；Defect：fingerprint 名实不符且扩大状态；待验证：跨平台 locale 的实际影响。
- **未来 Rust owner：** Platform Core capability grammar；Fleet Domain owns Fleet-specific descriptors/projection policy。
- **Rust 重写与性能判断：** byte-stable sorting + BLAKE3/SHA-256；无 actor/outbox。指标：snapshot size、hash 稳定性、重投影次数。
- **验证 oracle：** 乱序同义 descriptor 同 fingerprint；跨 endpoint scope 抛错；扩展字段的 compatibility policy tests。
- **证据：** `remote-fleet-capability-projection.ts:20-38,49-149`。

### runtime-host/application/remote-fleet/remote-fleet-capability-routes.ts

- **当前 owner：** capability-router adapter。
- **职责与关键 symbols：** operation→Fleet invoke mapping。
- **旧语义与策略：** target 必须 `runtime-endpoint`，禁止 caller 覆盖 runtimeAddress；snapshot/start/stop/sync 转 Remote Fleet service。
- **状态、存储与副作用：** adapter 本身无状态；service invocation 承担 I-O。
- **并发与性能特征：** O(1)，无 backpressure。
- **调用/依赖边界：** Platform capability route→RemoteFleetPort；下游 Runtime。
- **故障、恢复与安全：** 只校验 target kind、未证明 target identity 等于 context scope；status 用 `{}` 调全局 snapshot，可能非 endpoint-local。
- **迁移分类：** Preserve：caller 不能注入 runtimeAddress；Intentional Improvement：scope/target equality guard、endpoint-local query；Defect：范围不一致校验缺口；待验证：route 上游是否已绑定 identity。
- **未来 Rust owner：** Delivery/application adapter；Platform Core owns capability route grammar，Fleet Domain owns operations。
- **Rust 重写与性能判断：** 无 actor/outbox/storage；常量解析。指标：错误 target 拒绝、scope escape 计数。
- **验证 oracle：** scope endpoint 与 target 不同拒绝；status 只读该 endpoint。
- **证据：** `remote-fleet-capability-routes.ts:24-80`。

### runtime-host/application/remote-fleet/remote-fleet-command-dispatch.ts

- **当前 owner：** command→RuntimeAgent envelope compiler。
- **职责与关键 symbols：** `buildRemoteFleetCommandDispatchEnvelope`、v1 protocol、probe/install/start/stop payload builder。
- **旧语义与策略：** 绑定 command/idempotency/agent/node/runtime/endpoint；校验 node/runtime/endpoint 关联；下发 node 清空 publicConfig/secretRefs，target 仅含 secret refs。
- **状态、存储与副作用：** 纯函数，无网络/存储。
- **并发与性能特征：** install secret-name 排序 O(S log S)，其余关联查找；无队列。
- **调用/依赖边界：** Runtime `dispatchQueuedCommand` 调用，随后 host RuntimeAgent dispatcher 传送。
- **故障、恢复与安全：** 输入没有 RuntimeAgent record，`validateAgentId` 只检查存在性、不能单独证明 agent 属该 node；不拥有 retry/deadline/dedupe。
- **迁移分类：** Preserve：最小 agent payload 与 correlation；Intentional Improvement：带 agent ownership projection 的 builder；Defect：关联纵深验证缺口；待验证：Runtime 正常路径是否已先验证。
- **未来 Rust owner：** Fleet Domain command compiler；Platform Core execution envelope 字段；Transport Integration 负责发送。
- **Rust 重写与性能判断：** 不建 actor/outbox；保持纯函数、输入强类型。指标：payload 大小、secret 漏传/泄漏、构建耗时。
- **验证 oracle：** 错 node/runtime/endpoint/agent pairing 拒绝；wire payload 无 public config/plaintext；同 command wire correlation 稳定。
- **证据：** `remote-fleet-command-dispatch.ts:13-71,109-130,279-461`。

### runtime-host/application/remote-fleet/remote-fleet-command-policy.ts

- **当前 owner：** Fleet command admission policy engine。
- **职责与关键 symbols：** `evaluateRemoteFleetCommandPolicy`、unsafe public config/endpoint URL detectors、port/workspace policy。
- **旧语义与策略：** 检查 node enabled/health、node-runtime kind、required secret refs、SSH auth、port exposure、workspace mount；默认拒绝 public exposure 与 node-path mount。
- **状态、存储与副作用：** 纯 decision，无 I-O。
- **并发与性能特征：** 递归扫描 config/payload，无深度/规模上限。
- **调用/依赖边界：** Runtime/connector 在命令前调用；并非远端 authorization 或 observation oracle。
- **故障、恢复与安全：** plaintext key/value、URL userinfo 有积极防护；模式扫描不能替代数据分类、secret manager 或 agent authorization。
- **迁移分类：** Preserve：fail-closed 准入和默认拒绝；Intentional Improvement：有界 typed config decode；Defect：无；待验证：policy 和远端 provider policy 是否一致。
- **未来 Rust owner：** Remote Fleet Domain policy；通用 capability/scope 的类型归 Platform Core。
- **Rust 重写与性能判断：** pure rule engine，无 actor/outbox；限制递归输入。指标：decision latency、拒绝原因稳定性、深输入行为。
- **验证 oracle：** policy matrix/property tests；secret/URL/public port/mount 全部 fail-closed；旧批准集合差分。
- **证据：** `remote-fleet-command-policy.ts:51-96,171-332,438-548,603-740`。

### runtime-host/application/remote-fleet/remote-fleet-command-queue.ts

- **当前 owner：** 纯 command record reducer，不是实际 queue worker。
- **职责与关键 symbols：** `enqueue`、`markRunning/Succeeded/Failed/TimedOut`、`cancel`、`reapTimedOut`、`dedupeByIdempotencyKey`。
- **旧语义与策略：** `queued→running→terminal`，`markFailed` 可作用 queued；idempotency key 去重；每 transition 返回新 Map。
- **状态、存储与副作用：** 内存 Map 参数/返回；无持久化、dispatch、ack/retry worker。
- **并发与性能特征：** 每次 clone Map、idempotency/reap O(N)；无锁。
- **调用/依赖边界：** index 公开；Runtime 有独立 command 路径且未驱动这里的 `reapTimedOut`。
- **故障、恢复与安全：** reducer idempotency 不是远端 delivery guarantee；损坏状态 duplicate 只保留遇到的第一项，缺权威选择。
- **迁移分类：** Preserve：合法 transition 与幂等 lookup；Intentional Improvement：actor/DB 事务持久 command + outbox；Defect：timeout reducer 没有运行时 driver；待验证：是否有未发现调用者。
- **未来 Rust owner：** Remote Fleet Domain reducer；Foundation 提供 transaction/lease，不拥有命令业务状态机。
- **Rust 重写与性能判断：** `HashMap` in actor 可 O(1) mutation，不能借此声称可靠投递；outbox/reaper 独立。指标：transition 吞吐、活跃命令扫描、重启恢复。
- **验证 oracle：** transition table/property test；max-timeout 由实际 scheduler 驱动；crash 后 receipt/outbox 差分。
- **证据：** `remote-fleet-command-queue.ts:6-116,118-376`；Runtime 未使用 reaper 的调用链审计。

### runtime-host/application/remote-fleet/remote-fleet-connectors.ts

- **当前 owner：** RuntimeAgent connector command contract/registry。
- **职责与关键 symbols：** command validator、`dispatchRemoteFleetConnectorCommand`、provider contracts。
- **旧语义与策略：** policy、target kind、declared command、secret refs、channel availability 均在 send 前验证；发送 node copy 去 publicConfig，保留 ref 不带 plaintext。
- **状态、存储与副作用：** 调 `commandChannel.send`；本文件无持久 command state/outbox。
- **并发与性能特征：** registry 查找与验证线性；无 channel backpressure/lease。
- **调用/依赖边界：** Fleet command policy→connector→RuntimeAgent channel/provider registry。
- **故障、恢复与安全：** `RemoteFleetConnectorCommand.idempotencyKey` 在 wire request 构建中丢失，agent 无法收到相同 key；channel result 未校验 command id/type；重复 target contract `find()` 静默选第一个。
- **迁移分类：** Preserve：secret ref only、dispatch 前 policy；Intentional Improvement：wire 必传 idempotency/correlation、registry reject duplicate；Defect：idempotency key 丢失是代码可证；待验证：channel 是否另有 implicit dedupe。
- **未来 Rust owner：** Fleet Domain dispatch application service；connector channel 为 RuntimeAgent Integration。
- **Rust 重写与性能判断：** command actor 在事务内写 intent/outbox，再送 wire key；不承诺远端 exactly-once。指标：重复 send、wrong-result 拒绝、registry 查找。
- **验证 oracle：** 相同 command 重试 wire key 相同；fake channel 回错 ID 拒绝；重复 provider target 初始化失败。
- **证据：** `remote-fleet-connectors.ts:105-123,304-398,431-447,522-554`。

### runtime-host/application/remote-fleet/remote-fleet-credential-host-rpc.ts

- **当前 owner：** host credential write/status RPC validator。
- **职责与关键 symbols：** request validation、allowed credential name/ref、response redaction shape。
- **旧语义与策略：** allowlist fields/name，plaintext 最大 256 KiB；status ref 必为 `remote-fleet://credentials/<id>/<name>`。
- **状态、存储与副作用：** 纯校验；实际 vault 在 host store。
- **并发与性能特征：** O(payload)，无队列。
- **调用/依赖边界：** worker client host router→credential store；与 secret policy 共享 ref language。
- **故障、恢复与安全：** plaintext 主要依靠调用约束，未建立 typed redactor；`nowIso` 宽松 `Date.parse`，审计时间可非规范。
- **迁移分类：** Preserve：allowlist、大小限制、响应不含 plaintext；Intentional Improvement：`SecretString` 与 strict RFC3339；Defect：无；待验证：全调用方是否不日志化 request。
- **未来 Rust owner：** Fleet Domain secure RPC contract；Foundation secret/redaction primitive；vault Infrastructure。
- **Rust 重写与性能判断：** 无 actor/outbox；将 secret request 与 audit DTO 分型。指标：reject 率、明文扫描、解析时间。
- **验证 oracle：** 未知字段/非法 ref/空或超限 plaintext/非规范时间拒绝；响应序列化无 plaintext。
- **证据：** `remote-fleet-credential-host-rpc.ts:103-167,169-277`。

### runtime-host/application/remote-fleet/remote-fleet-credential-store.ts

- **当前 owner：** 本机 Fleet credential vault 与 idempotency receipt store。
- **职责与关键 symbols：** `FileRemoteFleetCredentialStore`、AES-256-GCM、operation receipt、chained secret resolver。
- **旧语义与策略：** 记录以 secretRef 作 AAD 加密；同 operation/name/ref 返回同 receipt；credential 与 receipt 在单份 state 内 temp+rename 写入；key/temp 尝试 `0600`。
- **状态、存储与副作用：** credentials.json、key file、全量 read-copy-write；模块进程内按 path 串行。
- **并发与性能特征：** O(|vault|) 每写；receipt 无清理；跨进程无锁/CAS/fsync；普通 object receipt map 有原型键风险。
- **调用/依赖边界：** credential host RPC、secret resolver、environment/agent/terminal integrations。
- **故障、恢复与安全：** map key 不校验记录内 secretRef，复制有效 record 到新 key 可能按旧 AAD 解密却以新 ref 返回；direct store API 对 name/time 校验不完整；read error 可抛而非 unavailable union。
- **迁移分类：** Preserve：AES-GCM、AAD binding、同 operation receipt、失败不泄密；Intentional Improvement：事务 vault、schema/lock/retention；Defect：key/ref binding 和跨进程丢写可证；待验证：state 文件权限在目标 OS。
- **未来 Rust owner：** Fleet Domain credential ownership；Foundation storage transaction/secret wrapper；具体 vault 为 Infrastructure。
- **Rust 重写与性能判断：** single-writer vault actor 或 DB transaction，将 credential+receipt(+必要 outbox) 原子提交；`HashMap`、schema migration。指标：write latency、receipt growth、crash consistency。
- **验证 oracle：** ciphertext record 复制到另一 key 必失败；双进程不同 operation 不丢写；非法 direct input 写前拒绝；掉电恢复旧/新完整 state。
- **证据：** `remote-fleet-credential-store.ts:88,135-379`。

### runtime-host/application/remote-fleet/remote-fleet-custom-terminal-config.ts

- **当前 owner：** custom terminal pure config validator。
- **职责与关键 symbols：** websocket transport/protocol、endpoint URL、credential ref validator。
- **旧语义与策略：** 仅允许约定 transport/protocol；拒 userinfo/query/fragment 及远端 `ws:`；credential ref name 受限。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** O(fields)。
- **调用/依赖边界：** custom terminal provider 使用；endpoint/capability state 来自 Fleet。
- **故障、恢复与安全：** 任意合法 `wss:` 尚未绑定可信 endpoint identity；若可同时控制 public config/credential ref，Bearer 可能外送。
- **迁移分类：** Preserve：URL/credential fail-closed；Intentional Improvement：endpoint identity/allowlist binding；Defect：跨身份 URL 未验证；待验证：配置写权限与 secret 权限是否同主体。
- **未来 Rust owner：** Fleet Domain config validation；实际 WebSocket 为 Integration。
- **Rust 重写与性能判断：** typed `CustomTerminalConfig::try_from`，无 actor/outbox；将 identity check 放在调用 Integration 前。指标：拒绝矩阵、URL parse 成本。
- **验证 oracle：** 格式合法但不属 endpoint registry 的 URL 拒绝；wire/log 不带 credential。
- **证据：** `remote-fleet-custom-terminal-config.ts:16-91`。

### runtime-host/application/remote-fleet/remote-fleet-docker-target-config.ts

- **当前 owner：** Docker target pure parser/merge/API URL builder。
- **职责与关键 symbols：** layered config merge、image candidates、container name、endpoint/token ref resolve。
- **旧语义与策略：** 拒 public credential material、URL credential/query、unsafe endpoint/ref/container/path；API segment 编码。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** candidate `includes` 去重 O(n²)，argv/candidates 无总量上限。
- **调用/依赖边界：** Docker bootstrap/terminal providers。
- **故障、恢复与安全：** 无 environment 时 connection config 不参与部分 merge、但 endpoint/token 仍来自 connection，加入空 environment 即可改变行为；custom image 无显式 candidates 时回退 Debian；delete 缺 remote ID 时猜默认 name。
- **迁移分类：** Preserve：URL/ref/path 安全、层次显式；Intentional Improvement：统一 merge matrix、strong newtypes、要求 durable remote id；Defect：merge asymmetry/回退风险；待验证：兼容 fallback 的产品意图。
- **未来 Rust owner：** Docker Integration config translation；Fleet Domain 保存 provider-neutral target intent。
- **Rust 重写与性能判断：** pure parse，Set 去重降 O(n²)；不引入 actor/outbox。指标：config 解析、候选数、删除误命中。
- **验证 oracle：** node/connection/environment conflict matrix；custom image pull 失败不得无授权回退；delete 优先 durable ID。
- **证据：** `remote-fleet-docker-target-config.ts:127-192,236-512`。

### runtime-host/application/remote-fleet/remote-fleet-environment-secret-resolver.ts

- **当前 owner：** host environment secret resolver。
- **职责与关键 symbols：** policy-gated ref→`MATCHACLAW_REMOTE_FLEET_SECRET_*` 映射。
- **旧语义与策略：** 合法 ref 才读取 environment；未配置返回 unavailable。
- **状态、存储与副作用：** 读取 process env，无持久化。
- **并发与性能特征：** O(ref length)，无共享 state。
- **调用/依赖边界：** chained secret resolver 供 bootstrap/terminal/agent 使用。
- **故障、恢复与安全：** 将 `-`、`_`、`/` 同化为 `_`，合法 refs 非单射，如 `a-b`/`a_b` 可映射同 env，形成 secret 混淆。
- **迁移分类：** Preserve：先 policy 后解析、缺失不泄密；Intentional Improvement：injective segment encoding/注册表；Defect：映射碰撞可证；待验证：现有 ref 规范是否已禁止冲突。
- **未来 Rust owner：** Integration secret resolver；secret-ref grammar 属 Fleet Domain/Platform Core shared grammar。
- **Rust 重写与性能判断：** base64url/hex segment encoding，无 actor/outbox。指标：查找延迟、collision=0。
- **验证 oracle：** 合法 ref 集到 env name 为单射；已知碰撞 pair 必不同或拒绝。
- **证据：** `remote-fleet-environment-secret-resolver.ts:15-44`；policy 字符集 `remote-fleet-secret-policy.ts:44-46`。

### runtime-host/application/remote-fleet/remote-fleet-k8s-target-config.ts

- **当前 owner：** Kubernetes target pure config/policy。
- **职责与关键 symbols：** endpoint merge、token ref、API/WS URL、resource name build。
- **旧语义与策略：** 仅无 userinfo/path/query/fragment 的 HTTPS origin；namespace/pod/container 受 path segment 验证；public secret key fail-closed。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** O(fields)，terminal argv 无规模上限。
- **调用/依赖边界：** K8s bootstrap/terminal Integration。
- **故障、恢复与安全：** 默认 image `:latest` 不可重现；node/agent ID 可能越过 label 63 字符，截断资源名碰撞；任意 HTTPS bearer endpoint 的信任取决于 config 与 secret 权限绑定。
- **迁移分类：** Preserve：endpoint/namespace/path fail-closed；Intentional Improvement：digest image、长度/碰撞检测、identity binding；Defect：无 label/name collision guard；待验证：API 是否另限制 IDs。
- **未来 Rust owner：** Kubernetes Integration config translation。
- **Rust 重写与性能判断：** pure typed parser/property fuzz；无 actor/outbox。指标：URI matrix、name collision、payload bound。
- **验证 oracle：** 超长 node/agent、相同 truncated name、巨大 argv 与 URI 变体均确定拒绝/编码。
- **证据：** `remote-fleet-k8s-target-config.ts:7`、`readRemoteFleetK8sProviderConfigParts`、`buildK8sResourceName`。

### runtime-host/application/remote-fleet/remote-fleet-lease-manager.ts

- **当前 owner：** lease pure domain rules。
- **职责与关键 symbols：** `canAcquireLease`、`acquireLeaseRecord`、release/expiry projections。
- **旧语义与策略：** `expiresAt <= now` 即到期；release/expiry 返回新 records；按 snapshot 计 max lease。
- **状态、存储与副作用：** 纯函数，无落库。
- **并发与性能特征：** O(n) scan；check/acquire 分离、无线性化。
- **调用/依赖边界：** runtime start/route/reconcile 使用 lease state；Foundation 仅可提供原语。
- **故障、恢复与安全：** 两 scheduler 可各自在同一 snapshot 通过 max=1，再分别持久化，突破容量；now/ttl/max 未 runtime 验证，NaN/负值可污染。
- **迁移分类：** Preserve：expiry 边界与不可变投影；Intentional Improvement：actor 或 DB conditional insert/CAS；Defect：TOCTOU 容量突破可证；待验证：worker 是否唯一实例。
- **未来 Rust owner：** Remote Fleet Domain lease policy；Foundation Kernel 提供 transaction/lease primitive，不能拥有 Fleet allocation decision。
- **Rust 重写与性能判断：** route+acquire 在同 actor/transaction revision 中；不能把 local lease 当远端 runtime reservation。指标：超配=0、lease contention、expiry cleanup。
- **验证 oracle：** max=1 并发 acquire 最终一个成功；无效 now/TTL/max 拒绝；崩溃后 lease expiry 收敛。
- **证据：** `remote-fleet-lease-manager.ts:61-155`。

### runtime-host/application/remote-fleet/remote-fleet-log-stream.ts

- **当前 owner：** log stream contract/cursor/dimension normalizer/redactor。
- **职责与关键 symbols：** `AsyncIterable` port、cursor/timestamp/dimensions normalize、`redactRemoteFleetLogLine`。
- **旧语义与策略：** 多 regex 遮 authorization、CLI secret flag、Bearer/Basic、`sk-*`/`mrf_*`；redactor 异常 fail-closed `[REDACTED]`。
- **状态、存储与副作用：** 无 durable cursor/buffer/backpressure owner。
- **并发与性能特征：** 每行 O(length×patterns)，无行长上限。
- **调用/依赖边界：** terminal/provider log Integration、audit/delivery display 可能消费。
- **故障、恢复与安全：** JSON `{"token":"plain"}`/`api_key` 的带引号键未必匹配 assignment regex，普通秘密可能泄漏；流重连语义未定义。
- **迁移分类：** Preserve：fail-closed redaction；Intentional Improvement：结构化 JSON redaction、有界 line/cursor checkpoint；Defect：quoted JSON key 漏洞需用测试证实；待验证：真实日志格式。
- **未来 Rust owner：** Foundation redaction；Fleet Domain log cursor contract；provider transport Integration。
- **Rust 重写与性能判断：** 不把 terminal output 写入 outbox；若要 resumable stream，单独持久 checkpoint。指标：redaction recall、line latency、内存上限。
- **验证 oracle：** JSON、URL query、quoted/unquoted assignment、Bearer 都无原 secret；超长行受控拒绝。
- **证据：** `remote-fleet-log-stream.ts:46-64,77-129`。

### runtime-host/application/remote-fleet/remote-fleet-metrics.ts

- **当前 owner：** Fleet read-model metrics projection。
- **职责与关键 symbols：** endpoint/runtime/command aggregates、recent failure count。
- **旧语义与策略：** 从 snapshot 扫描统计并排序。
- **状态、存储与副作用：** 纯投影，无 I-O。
- **并发与性能特征：** O(N + E log E)，同 endpoint 多次 scan；未知 status 可能写未声明字段/NaN。
- **调用/依赖边界：** Runtime query/read UI/ops 依赖。
- **故障、恢复与安全：** `recentFailureCount` 实为全历史失败/timeout，名称与时间窗口不符。
- **迁移分类：** Preserve：snapshot-derived、stable ordering；Intentional Improvement：typed exhaustive status、显式 `now/window`；Defect：recent 命名/计算不一致、unknown NaN 风险；待验证：指标消费者的含义。
- **未来 Rust owner：** Remote Fleet Domain query projection；Delivery 展示层不拥有事实。
- **Rust 重写与性能判断：** actor snapshot 上派生/增量 counters；仅在基准证明时优化。指标：N 增长下 query 延迟、内存、unknown status=0。
- **验证 oracle：** unknown enum 不 NaN；提供窗口后 recent 精确；与 TS snapshot 差分。
- **证据：** `remote-fleet-metrics.ts:82-86,176-180,213-222`。

### runtime-host/application/remote-fleet/remote-fleet-model.ts

- **当前 owner：** Fleet domain DTO/state algebra。
- **职责与关键 symbols：** enrollment/lifecycle/command state unions、node/agent/runtime/endpoint/capability/lease/session/audit records。
- **旧语义与策略：** 编译期定义状态形状，无 transition 或 runtime validation；agent 保存 ingress credential hash 而非明文。
- **状态、存储与副作用：** 无运行时副作用；同时是 persisted snapshot 事实形状。
- **并发与性能特征：** 无；开放 `Record<string,unknown>` config/metadata 使后续 scan/serialize 成本由输入决定。
- **调用/依赖边界：** Runtime/store/policy/dispatch/worker contracts 共享。
- **故障、恢复与安全：** model 不保证 config/metadata 安全；将 worker config 混入 domain model，职责轻度耦合。
- **迁移分类：** Preserve：状态代数、secret hash only；Intentional Improvement：外部 DTO/persisted schema/domain state/worker config 分开且运行时 decode；Defect：无；待验证：所有开放 metadata 来源。
- **未来 Rust owner：** Remote Fleet Domain；共同 identity/correlation/capability 字段引用 Platform Core。
- **Rust 重写与性能判断：** enum/newtype/validated schema，不需 actor/outbox；不要以静态类型替代边界 validation。指标：decode reject、schema migration。
- **验证 oracle：** persisted state round-trip、unknown variant reject、明文 credential 不可序列化。
- **证据：** `remote-fleet-model.ts:12-99,180-193,268-303,353-410`。

### runtime-host/application/remote-fleet/remote-fleet-operation-id.ts

- **当前 owner：** operation vocabulary。
- **职责与关键 symbols：** Remote Fleet operation string union/constants。
- **旧语义与策略：** TypeScript 静态封闭集合。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无。
- **调用/依赖边界：** API route、service port、worker contracts。
- **故障、恢复与安全：** 磁盘/HTTP/agent 输入仍可携任意 string，静态 union 不提供边界校验。
- **迁移分类：** Preserve：名称兼容；Intentional Improvement：runtime parsed enum/versioning；Defect：无；待验证：wire 中旧 operation alias。
- **未来 Rust owner：** Fleet Domain operation enum；跨域 command envelope 语法 Platform Core。
- **Rust 重写与性能判断：** serde tagged enum，无 actor/outbox/I-O。
- **验证 oracle：** union 内所有 operation round-trip；未知 operation 拒绝而非 silent fallback。
- **证据：** `remote-fleet-operation-id.ts:1-26`。

### runtime-host/application/remote-fleet/remote-fleet-ops-timeline.ts

- **当前 owner：** ops timeline read projection。
- **职责与关键 symbols：** command/audit correlation、timeline entry/sort/redaction。
- **旧语义与策略：** map/group/sort 全量 sources 后截 `maxEntries`；message 再 redaction；timestamp tie 以 ID 稳定。
- **状态、存储与副作用：** 纯函数，无 I-O。
- **并发与性能特征：** O((C+A) log(C+A))；单 command related audit IDs 无上限。
- **调用/依赖边界：** Runtime state→ops UI/query。
- **故障、恢复与安全：** ISO 之外 `localeCompare` 不可靠；重复 command ID Map 静默覆盖；先全量建再截断浪费。
- **迁移分类：** Preserve：redaction、stable tie-break；Intentional Improvement：time typed sort、分页/上限、duplicate reject；Defect：重复 ID 覆盖与潜在过量关系；待验证：timestamps 是否强制 ISO。
- **未来 Rust owner：** Fleet Domain query projection。
- **Rust 重写与性能判断：** indexed/paginated storage query，避免全历史 materialize；不是改变 timeline 语义。指标：p95 query、memory、关联 ID 数。
- **验证 oracle：** `maxEntries=1` 不携带海量 related IDs；所有 source message 无秘密；非 ISO 明确拒绝/排序规则。
- **证据：** `remote-fleet-ops-timeline.ts:75-108,131-143,255-280`。

### runtime-host/application/remote-fleet/remote-fleet-reconcile.ts

- **当前 owner：** Fleet recovery/reconcile pure planner。
- **职责与关键 symbols：** `buildRemoteFleetReconcilePlan`，restore descriptors、probe agent、reap lease、stale/prune、running runtime probe actions。
- **旧语义与策略：** 仅 current/non-retired capability 恢复；过期 lease 回收；target 有稳定排序。
- **状态、存储与副作用：** 纯计划，不写 state、不发 I-O、无 action receipt/outbox。
- **并发与性能特征：** snapshot scan/sort；无 action ID/依赖 DAG。
- **调用/依赖边界：** Runtime load/recovery、capability/lease/routing/agent integrations。
- **故障、恢复与安全：** `Date.parse` 未校验 NaN，可能悄然漏过期/stale；retired endpoint 可产生重复/冲突动作；外部 action 没有 durable intent。
- **迁移分类：** Preserve：确定性计划与恢复类别；Intentional Improvement：reconcile actor，revision+action intent/outbox；Defect：invalid time 静默决策、无 intent；待验证：执行方是否额外去重。
- **未来 Rust owner：** Remote Fleet Domain reconcile planner/actor；Foundation 只给 storage/task primitive。
- **Rust 重写与性能判断：** plan pure，actor transactional append intent 后执行；不得伪造 probe/reconcile 的外部成功。指标：recovery time、重复 action、事件丢失。
- **验证 oracle：** invalid time/negative threshold 拒绝；崩溃在 intent/外部/receipt 三点注入后收敛。
- **证据：** `remote-fleet-reconcile.ts:84-126,164-194,231-286`。

### runtime-host/application/remote-fleet/remote-fleet-routing-service.ts

- **当前 owner：** Fleet deterministic endpoint selector。
- **职责与关键 symbols：** `selectRemoteFleetEndpoint`、primary/fallback/exclusion reason。
- **旧语义与策略：** labels/operations normalize 后稳定排序；ready 优先、active lease 少优先；stale/pruned/non-current capability 不满足；health/lease busy 取保守值。
- **状态、存储与副作用：** 纯 snapshot selector。
- **并发与性能特征：** index 后约 O(R+C+L+E log E)；route→acquire TOCTOU。
- **调用/依赖边界：** Team endpoint selector adapter、Runtime start/lease、capability projection。
- **故障、恢复与安全：** 缺 now 时 active lease 可永久占位；malformed expiry/duplicate endpoint/current snapshot 可造成错选或 capability union。
- **迁移分类：** Preserve：稳定 tie-break/exclusion reason；Intentional Improvement：route+lease 同 actor transaction、validated unique state；Defect：selector 不能保证 capacity；待验证：snapshot uniqueness 由 store 是否维护。
- **未来 Rust owner：** Remote Fleet Domain routing；共享 endpoint/capability grammar 为 Platform Core。
- **Rust 重写与性能判断：** pure selector + allocation actor，保持选择可解释；不能宣称远端资源预留。指标：选路 p95、超配、fallback quality。
- **验证 oracle：** stale/pruned 不可选、tie 稳定、重复 endpoint 拒绝；max=1 并发 route/acquire 只派一个。
- **证据：** `remote-fleet-routing-service.ts:89-138,239-295,347-416`。

### runtime-host/application/remote-fleet/remote-fleet-runtime-agent-transport-dispatcher.ts

- **当前 owner：** RuntimeAgent accept-command transport Integration。
- **职责与关键 symbols：** target parse、secret resolve、HTTP POST/timeout、accepted response correlation。
- **旧语义与策略：** request 必须回显 requestId/agentId/commandId；idempotency key 随此路径发送；日志只记录 safe IDs/reason/error name。
- **状态、存储与副作用：** secret resolution、HTTP network、日志；无 command state/retry queue/outbox。
- **并发与性能特征：** 单请求 Abort timeout；无 retry/backoff、per-agent limit、response size limit。
- **调用/依赖边界：** Runtime worker host request→agent dispatcher→RuntimeAgent；secret Integration。
- **故障、恢复与安全：** custom resolver throw 归 unavailable，但 fallback resolver throw 可直接 reject；401/timeout/reject 被上层压扁；崩溃后依赖 agent idempotency，不能证明 agent 实现。
- **迁移分类：** Preserve：correlation echo、idempotency wire、safe logs；Intentional Improvement：持久 outbox/per-agent limit/错误分类；Defect：fallback throw 未归一；待验证：agent 的 dedupe lifetime。
- **未来 Rust owner：** RuntimeAgent Transport Integration；Fleet Domain owns dispatch intent/receipt。
- **Rust 重写与性能判断：** async transport task，deadline 与分类 retry；outbox 不保存 secret plaintext。指标：timeout/retry、per-agent concurrency、wrong receipt rejection。
- **验证 oracle：** resolver throw/401/timeout/invalid JSON/wrong command ID 分类；重启重发相同 key 至多执行一次（需真实 agent fixture）。
- **证据：** `remote-fleet-runtime-agent-transport-dispatcher.ts:76-116,123-280`。

### runtime-host/application/remote-fleet/remote-fleet-runtime-launch.ts

- **当前 owner：** runtime launch schema validator/builder。
- **职责与关键 symbols：** provider launch spec、agent request、readiness/capability hints、secret placeholders。
- **旧语义与策略：** plaintext credential/missing ref/mismatch/port/resource 非法生成 issues；payload 只含 refs/placeholders；agent node 保留所需 refs。
- **状态、存储与副作用：** 纯函数，无启动/状态写入。
- **并发与性能特征：** 线性扫描 config；无 payload/array/string 总量限制。
- **调用/依赖边界：** command dispatch/RuntimeAgent/bootstrap provider。
- **故障、恢复与安全：** 不拒 public env/secret env 重名、重复 mount target、重复 port/host-port；unknown provider fields 被忽略；readiness hint 不是可恢复 lifecycle。
- **迁移分类：** Preserve：no plaintext payload、结构化 issue；Intentional Improvement：版本化 typed launch contract/conflict validation；Defect：冲突未拒绝；待验证：provider 是否容忍重复。
- **未来 Rust owner：** Fleet Domain launch contract，具体 provider mapping 在 Integration。
- **Rust 重写与性能判断：** schema decode 有大小上限；actor 仅在完整 readiness receipt 后迁 lifecycle。指标：payload size、validation latency、early-ready=0。
- **验证 oracle：** env/mount/port conflict issue；序列化无 plaintext；ACK 不得早于全 readiness signal 置 ready。
- **证据：** `remote-fleet-runtime-launch.ts:208-227,248-325,368-592,722-826`。

### runtime-host/application/remote-fleet/remote-fleet-runtime.ts

- **当前 owner：** Fleet application aggregate/控制面状态协调者。
- **职责与关键 symbols：** `RemoteFleetRuntime`、`invoke`、`ensureLoaded/load/persist`、`queueCommand`、`dispatchQueuedCommand`、authenticated result、`reconcilePersistedStateAfterLoad`、`close`。
- **旧语义与策略：** state 持 connections/environments/resources/nodes/agents/runtimes/endpoints/capabilities/commands/credential ops/leases/sessions/audit；start 先 queue/`starting`/lease/清 capability，再 dispatch；stop 同理；accepted 不是 running/stopped；agent result 以本地 now 写 terminal state/apply lifecycle。
- **状态、存储与副作用：** 内存 aggregate，经全量 `RemoteFleetStateStore` snapshot；host port 调 capability/secret/bootstrap/terminal/agent transport。
- **并发与性能特征：** Runtime 本身无 mutex，依赖 worker lifecycle queue；commands/audits 无 retention、全量 load/persist O(N)。
- **调用/依赖边界：** `RemoteFleetPort` 上游；worker host bridge 下游；route/lease/policy/reconcile/dispatch pure helpers。
- **故障、恢复与安全：** queue/state 内存改动后外发、操作末尾才 persist，非 durable outbox；ACK 丢失先 fail 后 result 不再套 lifecycle；恢复仅清 unsafe config/过期 lease/session/capability，不 timeout/replay active command 或收敛 starting/stopping；revoke/install 不清 ingress hash，旧 credential 在 installing 可重认证；close 无 closed guard。
- **迁移分类：** Preserve：command correlation、accepted≠completed、secret ref not plaintext；Intentional Improvement：transactional state+outbox、recovery probe/timeout、credential epoch/revocation；Defect：崩溃窗口、active command 复原缺失、revoked credential resurrection；待验证：外层是否定期 reconcile。
- **未来 Rust owner：** **Remote Fleet Domain Module** 的 Fleet actor；Platform Core 提供 endpoint/execution/receipt/capability grammar；Foundation 提供 tx/lease/task/redaction；所有 remote I-O 留 Integration。
- **Rust 重写与性能判断：** 单 Fleet actor 或按 resource 分片但同一 allocation revision 线性化；state mutation 与 dispatch intent 原子提交，outbox 记录 at-least-once attempt/receipt，不承诺 Agent/Docker/K8s/SSH exactly-once；历史 retention/索引替代无界全量 JSON。指标：command recovery、write amplification、actor queue、duplicate dispatch。
- **验证 oracle：** state/outbox crash matrix（intent 前/后、外部成功/本地 receipt 前后）；agent correlation differential；revoke→reinstall credential epoch test；long-run N benchmark。
- **证据：** `remote-fleet-runtime.ts:138-306,968-1200,1643-1778,2017-2120`。

### runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc.ts

- **当前 owner：** host secret resolve contract/validator/redactor。
- **职责与关键 symbols：** `validateSecretResolveRequest`、response/request redactors。
- **旧语义与策略：** resolved 为唯一含 plaintext branch；redacted response 移除 value；拒常见 plaintext 入参字段。
- **状态、存储与副作用：** 纯校验；真正 resolve/authorization 在 host。
- **并发与性能特征：** O(payload)。
- **调用/依赖边界：** worker-host proxy/client→credential/environment resolver→agent/bootstrap/terminal integrations。
- **故障、恢复与安全：** valid DTO 不等于授权，未绑定 commandExecutionId/workerId 到认证主体；未验证对象 redactor 可能原样返回。
- **迁移分类：** Preserve：唯一 plaintext branch、redacted response；Intentional Improvement：auth/policy/resolve 同 actor、secret non-serialize type；Defect：未验证任意对象 redaction 不可靠；待验证：host boundary是否仅 trusted IPC。
- **未来 Rust owner：** Fleet secure host boundary；Foundation secret/redaction primitive。
- **Rust 重写与性能判断：** 无持久 outbox；最小生命周期 `SecretString`，明文不进 audit/message. 指标：secret exposure scope、redaction tests。
- **验证 oracle：** redacted response 序列化无 value；plaintext key variants 拒绝；错误 caller identity 无法 resolve。
- **证据：** `remote-fleet-secret-host-rpc.ts:24-61,111-124,151-261`。

### runtime-host/application/remote-fleet/remote-fleet-secret-policy.ts

- **当前 owner：** canonical secret-ref policy。
- **职责与关键 symbols：** `evaluateRemoteFleetSecretRefPolicy`。
- **旧语义与策略：** 仅 `remote-fleet://`、拒 `..`/空 segment，限制长度和字符。
- **状态、存储与副作用：** 纯 fail-closed rule。
- **并发与性能特征：** O(ref length)。
- **调用/依赖边界：** credential, environment, bootstrap, terminal, connector resolver 共同使用。
- **故障、恢复与安全：** 允许 namespace 下任何合法 path，不限定各 credential schema；caller 若用 trim 前字符串作 key 可能与 canonical identity 分叉。
- **迁移分类：** Preserve：统一 fail-closed grammar；Intentional Improvement：结构化 `SecretRef{namespace,segments}` 唯一 parser；Defect：无；待验证：各 store 是否统一 canonicalize。
- **未来 Rust owner：** Platform Core/ Foundation 可提供通用 opaque ref grammar；Fleet Domain owns `remote-fleet` namespace policy。
- **Rust 重写与性能判断：** 无 actor/outbox/I-O；parse 一次、传 typed ref。指标：cross-resolver canonical equality。
- **验证 oracle：** 同合法 ref 在所有 resolver 得相同 canonical identity；非法 path 都拒绝。
- **证据：** `remote-fleet-secret-policy.ts:15-46`。

### runtime-host/application/remote-fleet/remote-fleet-service.ts

- **当前 owner：** Fleet application service port。
- **职责与关键 symbols：** `RemoteFleetPort.invoke(operationId, params)`、optional `close()`。
- **旧语义与策略：** 薄 facade，实施者决定 worker/persistence；response 采用 `ApplicationResponseOf`。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无。
- **调用/依赖边界：** API/route→worker-backed service 或 direct Runtime。
- **故障、恢复与安全：** 不表达 deadline/cancel、accepted vs complete、worker failure/retryability。
- **迁移分类：** Preserve：薄 port；Intentional Improvement：显式 command acceptance/receipt/deadline/shutdown contract；Defect：无；待验证：上层 UI 的 completion 预期。
- **未来 Rust owner：** Remote Fleet Domain application trait。
- **Rust 重写与性能判断：** 无 actor/outbox/storage；trait 只暴露 typed command/query，actor 内部化。指标：API compatibility/error taxonomy。
- **验证 oracle：** contract tests: accepted/terminal/shutdown error distinct。
- **证据：** `remote-fleet-service.ts:1-7`。

### runtime-host/application/remote-fleet/remote-fleet-ssh-target-config.ts

- **当前 owner：** SSH/VM pure target config parser。
- **职责与关键 symbols：** host/port/user/installCommand/auth secret ref parse。
- **旧语义与策略：** 仅 ssh scheme，拒 URL password/path/query/hash/public plaintext credential；private key 优先、password fallback。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** O(fields)。
- **调用/依赖边界：** SSH bootstrap/terminal provider。
- **故障、恢复与安全：** `installCommand` 仅 nonempty trim，随后远端 shell 执行；host 校验不限制 private/link-local/DNS rebinding；public config 可覆盖 host/port/user，审计 target 与实际可能分叉。
- **迁移分类：** Preserve：credential fail-closed；Intentional Improvement：bootstrap-authorized command policy、known-host/pin/egress control；Defect：自定义 command 权限扩大风险；待验证：写 config 的授权边界。
- **未来 Rust owner：** SSH Integration config translation。
- **Rust 重写与性能判断：** pure `Result<SshTargetConfig>`；不放 actor/outbox。指标：URI/override policy cases。
- **验证 oracle：** 仅 bootstrap-authorized caller 可设置 custom command；sensitive key/URI/override matrix fail-closed。
- **证据：** `remote-fleet-ssh-target-config.ts:39-245`；执行点 `remote-fleet-bootstrap-ssh-provider.ts:580-588`。

### runtime-host/application/remote-fleet/remote-fleet-store.ts

- **当前 owner：** Fleet snapshot persistence port/schema。
- **职责与关键 symbols：** `RemoteFleetPersistedState`、`RemoteFleetStateStore`、empty/deserializer。
- **旧语义与策略：** replace-all snapshot；decoder 对 array 仅过滤非空 id，version 固定产 v1。
- **状态、存储与副作用：** port 无 I-O；实现由 file store 注入。
- **并发与性能特征：** 无 revision/CAS/append/transaction，天然 O(N) decode/encode。
- **调用/依赖边界：** Runtime load/persist 的唯一 storage abstraction。
- **故障、恢复与安全：** 不验证内部 fields/variant/time/ref integrity/secret policy；无 migration/reject，靠 Runtime 局部修复。
- **迁移分类：** Preserve：空 state、完整 snapshot compatibility；Intentional Improvement：schema version/migrations、transaction state+outbox/revision；Defect：permissive decode 让坏状态延迟爆炸；待验证：历史文件真实版本。
- **未来 Rust owner：** Fleet Domain snapshot model；Foundation Storage transaction port。
- **Rust 重写与性能判断：** 若仍 snapshot，需 bounded state/retention；可靠 command 使用 journal/outbox，不以全量 JSON 替代。指标：startup、write bytes、migration time。
- **验证 oracle：** malformed persisted record 拒绝/隔离；state+outbox 原子 crash tests；migration round-trip。
- **证据：** `remote-fleet-store.ts:17-95`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-contracts.ts

- **当前 owner：** terminal domain protocol/validation。
- **职责与关键 symbols：** ticket RPC、control frame、target/size validation、stream path builder。
- **旧语义与策略：** ticket TTL 30 秒/随机 32 bytes；校验 terminal dimensions。
- **状态、存储与副作用：** 纯 contract；ticket state 由 manager 持有。
- **并发与性能特征：** O(1)。
- **调用/依赖边界：** terminal manager、Delivery WebSocket、provider adapters。
- **故障、恢复与安全：** stream path 把 bearer ticket 放 WebSocket query，可能进入 proxy/access/devtools log。
- **迁移分类：** Preserve：short-lived one-time ticket、dimension bounds；Intentional Improvement：first-frame/subprotocol auth；Defect：query ticket exposure；待验证：所有 proxy redaction。
- **未来 Rust owner：** Remote Fleet Domain terminal contract；Delivery/Integration implements WS edge。
- **Rust 重写与性能判断：** 无 durable outbox（terminal bytes/tickets绝不重放/持久）；ticket only digest in manager. 指标：ticket leak=0、handshake latency。
- **验证 oracle：** 0/1001/NaN/fraction dimensions reject；access logs/outbox/state 都无 bearer ticket。
- **证据：** `remote-fleet-terminal-contracts.ts:125-131,157-197`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-custom-provider.ts

- **当前 owner：** custom connector terminal Integration。
- **职责与关键 symbols：** capability gate、secret resolve、remote WebSocket terminal open.
- **旧语义与策略：** 先 policy/ref，拒 URL plaintext/query/fragment；30 秒 open timeout；close guard。
- **状态、存储与副作用：** capability read、secret resolve、WS I-O；无 state/outbox。
- **并发与性能特征：** 无 pause/resume/WS max payload；timeout 后连接竞争待下游。
- **调用/依赖边界：** terminal manager→provider→custom endpoint/secret resolver。
- **故障、恢复与安全：** 只证明 endpoint 有 attach capability，未将 public config URL 绑定该 endpoint；credential 可发送至任意合规 `wss`；timeout 晚到 open 可能 orphan handle。
- **迁移分类：** Preserve：ref gate/close guard；Intentional Improvement：endpoint identity binding、cancellation-aware task/transport limits；Defect：credential exfiltration path；待验证：capability registry 是否强限制 URL。
- **未来 Rust owner：** Custom terminal Integration，Fleet Domain owns session authorization only。
- **Rust 重写与性能判断：** connection task 在 cancel 后关闭晚到 socket；不持久 terminal stream. 指标：orphan connection、payload bound、identity mismatch rejection。
- **验证 oracle：** capability endpoint 与 terminal URL identity mismatch 拒绝；timeout 后 late open 必 close。
- **证据：** `remote-fleet-terminal-custom-provider.ts:116-177,180-340,391-393`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider.ts

- **当前 owner：** Docker exec terminal Integration。
- **职责与关键 symbols：** create exec、hijacked raw stream、resize REST。
- **旧语义与策略：** token policy gate、argv array、不拼 shell；raw stream 支持 pause/resume。
- **状态、存储与副作用：** Docker HTTP/upgrade；handle 保留 bearer token 供 resize；无 persistent session。
- **并发与性能特征：** each resize 独立 async request，无序列/latest-wins；raw socket write false 时 pause。
- **调用/依赖边界：** terminal manager→Docker provider→target config/secret resolver。
- **故障、恢复与安全：** initial `resizeNow` 失败时 exec stream 已开但 handle 未返回，可能泄漏；pause 后未监听 drain resume，输出可永久停；高频 resize 放大/乱序。
- **迁移分类：** Preserve：argv/no-shell、pause capability；Intentional Improvement：scope guard、drain resume、latest-wins resize actor；Defect：initial resize orphan/pause deadlock；待验证：Node stream 是否隐式 resume。
- **未来 Rust owner：** Docker Integration；terminal session actor 属 Fleet Domain.
- **Rust 重写与性能判断：** connection task ownership guard；resize coalesce。指标：open failure close=1、backpressure recovery、resize request count。
- **验证 oracle：** initial resize fail 必 close raw stream；write=false/drain 后继续；100 resize 只最终尺寸且 API 有界。
- **证据：** `remote-fleet-terminal-docker-provider.ts:173-299,374-525`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-k8s-provider.ts

- **当前 owner：** K8s pod discovery/exec WebSocket terminal Integration。
- **职责与关键 symbols：** pod list、exec WS、channel 0/1/2/3/4 codec。
- **旧语义与策略：** token policy gate，API/WS Authorization；从 API 返回数组选第一个 Ready pod；基础 status redaction/truncation。
- **状态、存储与副作用：** secret resolve、K8s HTTP/WS，无 persistence。
- **并发与性能特征：** pod list 无 timeout/cancel；connect timeout 只 settle failed，晚 open socket 可能 orphan。
- **调用/依赖边界：** terminal manager/K8s config/secret resolver。
- **故障、恢复与安全：** K8s Success/Failure 先标 closed，manager 再 close 可能跳过底层 socket close；fallback resolver throw 可能直接 reject；pod selection 非确定。
- **迁移分类：** Preserve：channel codec、token不进日志；Intentional Improvement：cancellation select/唯一 finish/稳定 pod selection；Defect：deadline/late socket cleanup 缺失；待验证：WS library close semantics。
- **未来 Rust owner：** Kubernetes Integration；Fleet terminal session actor。
- **Rust 重写与性能判断：** discovery/connect/socket/close 同一 cancellation scope；terminal no outbox. 指标：hung list termination、late socket=0、close exactly-once。
- **验证 oracle：** hung pod-list deadline；timeout late open 关闭；status 后 exit/socket close 各一次。
- **证据：** `remote-fleet-terminal-k8s-provider.ts:136-306,316-402,435-534`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-manager.ts

- **当前 owner：** stateful terminal gateway/session coordinator。
- **职责与关键 symbols：** pending ticket/active session maps、provider stream↔WS forwarding、backpressure、close/dispose。
- **旧语义与策略：** ticket 只存 SHA-256 digest、timing-safe compare、一次消费/TTL；frame 1 MiB/control 64 KiB/high-low water 4/1 MiB；provider 无 pause/resume 时高水位断开。
- **状态、存储与副作用：** 内存 `pendingTickets/activeSessions`、HTTP upgrade、WS/provider I-O；正确地无 durable stream/outbox。
- **并发与性能特征：** open await 前相同 session 并发重连可覆盖 map；pending ticket 仅 consume/计数时 prune，静置增长；transport 层未设 maxPayload，应用检查晚。
- **调用/依赖边界：** Delivery WS→manager→terminal provider→Docker/K8s/SSH/custom。
- **故障、恢复与安全：** consume 后 provider open pending，close/dispose 找不到 session，late handle orphan；同步 provider write/resize throw 未捕获；ticket query 由 contract 暴露。
- **迁移分类：** Preserve：digest-only ticket、one-time、backpressure cutoff；Intentional Improvement：`sessionId+generation` mailbox/cancel fencing、transport max payload/eager prune；Defect：open-close race/orphan handle；待验证：provider open cancellation ability。
- **未来 Rust owner：** Remote Fleet Domain terminal session actor；WS/providers为 Delivery/Integration。
- **Rust 重写与性能判断：** 每 session actor 线性化 open/reconnect/close/dispose，late handle立即 close；terminal data never durable. 指标：max active handles、buffer bytes、ticket leak、close latency。
- **验证 oracle：** gate open 后 close/dispose handle close exactly once；并发 reconnect 最多一个 active；oversize 在 transport 层拒绝；TTL ticket 自回收。
- **证据：** `remote-fleet-terminal-manager.ts:31-35,69-73,77-192,203-245,287-508`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-providers.ts

- **当前 owner：** terminal provider abstraction/registry/legacy adapter。
- **职责与关键 symbols：** provider registry、SSH/legacy adapter、event normalization。
- **旧语义与策略：** legacy result 使用前验证 write/resize/close/events；registry 按 kind 注册。
- **状态、存储与副作用：** 内存 registry/EventEmitter，无 store。
- **并发与性能特征：** map lookup O(1)；重复 provider kind 后者静默覆盖。
- **调用/依赖边界：** manager uses provider; SSH/custom/Docker/K8s implementations。
- **故障、恢复与安全：** SSH adapter 将 `Uint8Array` 转 UTF-8 string，不保 binary；legacy close 不清 wrapper listener；不透传 pause/resume，manager只能断线。
- **迁移分类：** Preserve：provider contract validation；Intentional Improvement：`Bytes`、duplicate reject、listener cleanup/backpressure trait；Defect：覆盖/二进制损坏/监听泄漏；待验证：terminal 是否只文本。
- **未来 Rust owner：** Fleet Domain terminal provider trait；provider implementations Integration。
- **Rust 重写与性能判断：** session actor 独占 handle，provider只产 stream；无 outbox。指标：binary round-trip、listener count、registry determinism。
- **验证 oracle：** `[ff,00,80]`逐字节到下游；重复 kind reject；legacy close 后 callback 不转发。
- **证据：** `remote-fleet-terminal-providers.ts:28-37,52-109,149-208`。

### runtime-host/application/remote-fleet/remote-fleet-terminal-ssh-provider.ts

- **当前 owner：** SSH/VM PTY terminal Integration。
- **职责与关键 symbols：** secret resolve、SSH client/shell、pause/resume。
- **旧语义与策略：** connect ready timeout 15 秒，错误摘要 1,000 chars，密码/key/token redaction，正常 close 结束 shell/client。
- **状态、存储与副作用：** SSH/PTY I-O，无 persistence。
- **并发与性能特征：** supports pause/resume；`openSession` 与 factory `open` 形状有分裂。
- **调用/依赖边界：** manager→SSH provider→SSH target config/secret resolver。
- **故障、恢复与安全：** shell 前 client error/connect throw 未必 end；随后 ready 可能形成 orphan shell；无 known-host/pin，无法建立 host identity trust。
- **迁移分类：** Preserve：redaction/pause-resume/normal close；Intentional Improvement：known-host/pin、single `finish`/zeroize secret；Defect：pre-open cleanup race；待验证：SSH lib event ordering。
- **未来 Rust owner：** SSH Integration；terminal session lifecycle Fleet Domain。
- **Rust 重写与性能判断：** error/timeout/cancel/close 单 cleanup path；无 persistent terminal bytes。指标：orphan client=0、event race close=1。
- **验证 oracle：** `error→ready→shell` 只失败一次且 client end；无 trusted key拒绝；exit/client close exactly once。
- **证据：** `remote-fleet-terminal-ssh-provider.ts:121-149,255-483,543-675`。

### runtime-host/application/remote-fleet/remote-fleet-worker-client.ts

- **当前 owner：** main-thread worker proxy 与 host-RPC router。
- **职责与关键 symbols：** `WorkerBackedRemoteFleetService`、pending Map、`dispatchRemoteFleetHostRequest`。
- **旧语义与策略：** invoke postMessage/requestId correlation；worker host requests 由主线程 capability/secret/bootstrap/terminal/agent dispatcher 处理；worker error opaque 化。
- **状态、存储与副作用：** Worker、volatile pending promises、IPC；host router 触真实 I-O/state。
- **并发与性能特征：** main 可并行 host request，worker invoke 实际串行；pending 无 timeout/cap；code 0 异常 exit 可能不 reject pending。
- **调用/依赖边界：** `RemoteFleetPort`→worker→host ports；secret plaintext 能经 structured clone 进入 worker memory。
- **故障、恢复与安全：** close 先等 worker close result，卡住 host RPC 可无限等待；opaque error 减少泄露也丢诊断/重试分类。
- **迁移分类：** Preserve：correlation/opaque worker errors；Intentional Improvement：deadline/cancel/supervision、secret最小暴露；Defect：pending/close无界、normal exit pending leak；待验证：Worker exit code约定。
- **未来 Rust owner：** Foundation Kernel worker/IPC supervision，Fleet Domain host-port adapters；secret resolver Integration。
- **Rust 重写与性能判断：** bounded pending + deadlines，worker crash不承担 durable delivery；outbox仍在 Fleet persistence。指标：IPC bytes、pending high-water、shutdown p99。
- **验证 oracle：** host永不返回 close仍有界；code 0 unexpected exit rejects all；secret不出现在 diagnostic payload。
- **证据：** `remote-fleet-worker-client.ts:159-319,340-383,491-808`。

### runtime-host/application/remote-fleet/remote-fleet-worker-contracts.ts

- **当前 owner：** internal worker IPC wire algebra。
- **职责与关键 symbols：** worker request/response、host request/response、main↔worker messages、`serializeRemoteFleetWorkerError`。
- **旧语义与策略：** requestId correlation；opaque fixed error；没有 deadline/cancel/version/replay/ack semantics。
- **状态、存储与副作用：** 无；structured clone payload。
- **并发与性能特征：** cost 随 params/descriptors/result payload，类型无 runtime validation。
- **调用/依赖边界：** worker entry 与 worker client 唯一 IPC boundary。
- **故障、恢复与安全：** typed union 只保证编译期；错误分类被压平，不能区分 transient/invalid/crash/shutdown。
- **迁移分类：** Preserve：correlation、internal detail不泄漏；Intentional Improvement：protocol version/deadline/retryability enum、runtime validation；Defect：无；待验证：跨版本 worker rollout。
- **未来 Rust owner：** Foundation Kernel process/worker communication contract；Fleet-specific host request payload属 Domain。
- **Rust 重写与性能判断：** bounded message size, deadline; no outbox/storage. 指标：serialization、error taxonomy coverage。
- **验证 oracle：** unknown message reject；error无内部 stack；deadline/cancel round-trip。
- **证据：** `remote-fleet-worker-contracts.ts:21-121`。

---

# TeamRun Domain Module

### runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-materialization-adapter.ts

- **当前 owner：** OpenClaw Team agent materialization Integration。
- **职责与关键 symbols：** `OpenClawTeamAgentMaterializationAdapter`、`materialize`、`removeTeamAgents`、TeamBuddy projection/config/workspace file routines。
- **旧语义与策略：** 读取 agents，创建/更新 TeamBuddy agent，写 leader/role workspace，patch OpenClaw config；team-owned 删除，external agent 仅验证存在但仍投影 config/workspace；config set baseHash 冲突只重试一次。
- **状态、存储与副作用：** Gateway `agents.*`/`config.*` RPC、OpenClaw config 全量写、workspace filesystem、managed-agent restore snapshot。
- **并发与性能特征：** roles 串行 RPC/I-O；patch 对 config agent list 查找约 O(role×agents)；workspace无锁 read-modify-write。
- **调用/依赖边界：** Team agent materialization port→OpenClaw gateway/config/filesystem；TeamRuntimeService orchestrates。
- **故障、恢复与安全：** config/filesystem/Gateway 无 saga，config set 失败可留半成品；默认 workspace 基于 teamSkill name 非 teamId，跨同名 team 可能共享/互删；generated file 删除吞所有异常；team-owned 删除前 prefix/TeamBuddy root 检查是保护。
- **迁移分类：** Preserve：TeamRun 控制 role，而非 native subagent；managed ownership/restore、label/path safeguards；Intentional Improvement：provider-local saga/tombstone/lock；Defect：同名 workspace/吞 I-O 错误风险；待验证：TeamSkill name唯一约束。
- **未来 Rust owner：** **OpenClaw Runtime Integration**；绝不移入 TeamRun/Platform Core。Domain 仅定义 materialization desired state/port。
- **Rust 重写与性能判断：** OpenClaw adapter按 role 外部I-O，Domain actor持持久 intent/receipt；不能伪造 OpenClaw config/workspace 原子性。指标：RPC数、冲突、半成品恢复。
- **验证 oracle：** config conflict、workspace/config 中断、external restore、同名 team隔离、非 owned agent不删。
- **证据：** `openclaw-team-agent-materialization-adapter.ts:42-47,105-200,224-279,314-417,468-733`。

### runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-policy-projection.ts

- **当前 owner：** OpenClaw tool/sandbox policy projection。
- **职责与关键 symbols：** `projectTeamRoleToolPolicyToOpenClawTools`。
- **旧语义与策略：** 固定 `profile:'full'`，保持首次出现次序去重 `alsoAllow`，恒 deny `sessions_spawn/sessions_yield/subagents`，sandbox `{mode:'off'}`。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** Set 去重 O(tools)。
- **调用/依赖边界：** materialization adapter→OpenClaw agent config。
- **故障、恢复与安全：** deny native spawn/session delegation 是 TeamRun 自己管理 role session 的 Integration 约束；不应泛化为所有 Matcha runtime policy。
- **迁移分类：** Preserve：OpenClaw projection与禁止 native delegation；Intentional Improvement：把 provider policy version化；Defect：无；待验证：`full` 与 allow/deny 的 OpenClaw 解释。
- **未来 Rust owner：** OpenClaw Runtime Integration，不属于 TeamRun core 或 Foundation。
- **Rust 重写与性能判断：** pure projection，无 actor/outbox/I-O；不要迁成通用 approval/tool harness。指标：config differential。
- **验证 oracle：** role tools stable dedupe；OpenClaw config snapshot；native delegation 仍拒绝。
- **证据：** `openclaw-team-agent-policy-projection.ts:3-27`。

### runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter.ts

- **当前 owner：** OpenClaw endpoint-session materialization Integration。
- **职责与关键 symbols：** `OpenClawTeamRoleSessionMaterializationAdapter`、endpoint session key resolve/materialize/dematerialize。
- **旧语义与策略：** `endpointSessionId→agent:${agentId}:${endpointSessionId}`；仅 local OpenClaw adapter/instance 精确匹配时调用 `sessions.create/delete`，其他 endpoint no-op。
- **状态、存储与副作用：** 一次 OpenClaw RPC/operation，远端 session 是事实源；无本地 store。
- **并发与性能特征：** 无 request coalesce/lock/retry；确定性 key。
- **调用/依赖边界：** `TeamRoleEndpointSessionMaterializationPort`→OpenClaw sessions RPC；SessionRuntime adapter 调用。
- **故障、恢复与安全：** 不做 capability probe、存在性验证、timeout ambiguity 收敛；上游必须保证 agent 下 endpointSessionId 唯一，否则逻辑 session 折叠。
- **迁移分类：** Preserve：opaque endpoint binding、OpenClaw key grammar只留Integration；Intentional Improvement：provider receipt/existence reconciliation；Defect：无；待验证：OpenClaw sessions create idempotency。
- **未来 Rust owner：** OpenClaw Runtime Integration；provider-neutral binding/port留 TeamRun Domain。
- **Rust 重写与性能判断：** 无 actor/outbox store；上游 actor持 materialize intent。指标：remote session leak、reconcile time。
- **验证 oracle：** 同 binding key稳定；非 OpenClaw endpoint无 RPC；timeout后 reconcile存在性。
- **证据：** `openclaw-team-role-session-materialization-adapter.ts:7-51`。

### runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts

- **当前 owner：** TeamRun→Fleet endpoint selection adapter。
- **职责与关键 symbols：** `selectTeamRunRemoteFleetEndpoint`、scope/capability/lease view adaptation。
- **旧语义与策略：** 过滤 scope/endpoint 不一致，映射到 Fleet selector，返回 primary、fallback、完整 exclusion reason。
- **状态、存储与副作用：** 纯函数；输入 snapshot 是观察，不获取 lease。
- **并发与性能特征：** O(endpoints×descriptors)+排序；selection→reservation 有竞态。
- **调用/依赖边界：** Team endpoint requirement→Remote Fleet routing service；无反向 Team state mutation。
- **故障、恢复与安全：** capability/lease freshness是下游 routing policy；不能把选中结果当作 capacity/ownership。
- **迁移分类：** Preserve：可解释 exclusions与 scope filter；Intentional Improvement：选择与 lease acquire 在 Fleet actor原子完成；Defect：若调用者把选择当 reservation 则为边界误用；待验证：Team实际 acquire链。
- **未来 Rust owner：** adapter 可为 Fleet/Team Domain 间 application adapter；Endpoint identity/capability grammar来自 Platform Core。
- **Rust 重写与性能判断：** 保持 pure candidate selection；不建 outbox。指标：选路复杂度、过期 snapshot重选。
- **验证 oracle：** mismatch scope排除；选择后变更 lease必须重取 snapshot；fallback排序稳定。
- **证据：** `remote-fleet-team-endpoint-selector-adapter.ts:87-137,176-369`。

### runtime-host/application/team-runtime/adapters/session-runtime-team-role-session-adapter.ts

- **当前 owner：** Team role session 到 Session Runtime/endpoint 的 adapter。
- **职责与关键 symbols：** `SessionRuntimeTeamRoleSessionAdapter`、ensure/prompt/abort/delete/read window。
- **旧语义与策略：** create local session→materialize endpoint→registry remember；materialize失败清 local/forget；delete先 local、后 endpoint、最后 forget；window 明确 available/pending_hydration/unavailable。
- **状态、存储与副作用：** Session Runtime create/prompt/abort/delete/get-window、AgentRuntimeRegistry、optional endpoint materializer。
- **并发与性能特征：** 固定次数 RPC，无锁/请求合并；同 binding ensure/delete/abort 可交错。
- **调用/依赖边界：** Team role-session port→Session domain/Agent runtime registry/OpenClaw materialization Integration。
- **故障、恢复与安全：** endpoint create timeout成功时本地清理可留 remote session；delete local成功后remote失败时 registry仍记绑定，形成三方不一致；拒 `agent:` grammar 输入保持 endpoint ID opaque。
- **迁移分类：** Preserve：binding validation、pending hydration 不伪装为空、局部补偿；Intentional Improvement：provider/local 状态的 saga/reconcile；Defect：非原子 delete不一致窗口；待验证：下游 delete幂等。
- **未来 Rust owner：** TeamRun Domain outbound port；Session Runtime/OpenClaw 都为 Integration/peer domain，不下沉 Core。
- **Rust 重写与性能判断：** Team actor记录 desired binding/outbox；不能宣称跨 Session/OpenClaw exactly-once。指标：orphan remote session、binding mismatch、hydration latency。
- **验证 oracle：** materialize失败 local清理；remote delete失败后reconcile；202 window保持 pending。
- **证据：** `session-runtime-team-role-session-adapter.ts:15-189`。

### runtime-host/application/team-runtime/domain/team-command-ledger.ts

- **当前 owner：** Team agent command/ledger data contract。
- **职责与关键 symbols：** `TeamAgentCommand`、`TeamGraphPatch`、`TeamCommandLedgerRecord`。
- **旧语义与策略：** runtime/role/session 可选兼容；有 sequence/idempotencyKey/status 字段，无业务算法。
- **状态、存储与副作用：** 仅 types；SQLite adapter 负责持久。
- **并发与性能特征：** 无。
- **调用/依赖边界：** TeamRuntimeService、SQLite ledger、worker IPC。
- **故障、恢复与安全：** 模型不表达 command execution receipt/outbox claim；graph events 不含/不校验 `nodeExecutionId`。
- **迁移分类：** Preserve：command correlation/accepted-rejected record；Intentional Improvement：execution attempt/receipt结构；Defect：无；待验证：可选字段的历史 payload。
- **未来 Rust owner：** TeamRun Domain data model；共用 Execution/Receipt grammar归 Platform Core。
- **Rust 重写与性能判断：** typed command envelope，无 actor/outbox本体；不要把 ledger type误称 delivery log。指标：schema compatibility。
- **验证 oracle：** TS/Rust record round-trip；每 command含不可变 correlation/attempt策略。
- **证据：** `team-command-ledger.ts:5-79`。

### runtime-host/application/team-runtime/domain/team-event.ts

- **当前 owner：** 通用 Team event envelope。
- **职责与关键 symbols：** `TeamEvent`。
- **旧语义与策略：** `type:string` 开放，payload 无 schema/version。
- **状态、存储与副作用：** 纯类型。
- **并发与性能特征：** 无。
- **调用/依赖边界：** TeamRuntime events/projections。
- **故障、恢复与安全：** 无 causal order、idempotency、redaction、replay contract，不能作为可靠 event log。
- **迁移分类：** Preserve：泛化 event兼容；Intentional Improvement：versioned tagged event或只保留内部；Defect：无；待验证：实际 consumers。
- **未来 Rust owner：** TeamRun Domain；若跨域事件才以 Platform Core envelope 包装。
- **Rust 重写与性能判断：** 不建无界 generic event store；outbox需具体 event/receipt。指标：decode/version coverage。
- **验证 oracle：** unknown event处理策略明确；serialisation/redaction contract。
- **证据：** `team-event.ts:1-10`。

### runtime-host/application/team-runtime/domain/team-evidence.ts

- **当前 owner：** Team evidence reference value object。
- **职责与关键 symbols：** workspace path/URI/artifact/inline text variants。
- **旧语义与策略：** 仅描述证据引用。
- **状态、存储与副作用：** 无 I-O，不验证可读性。
- **并发与性能特征：** 无。
- **调用/依赖边界：** Team graph/node result、external workspace/artifact systems。
- **故障、恢复与安全：** 无 path normalization/authorization/size limit；恢复时可读性完全外包。
- **迁移分类：** Preserve：reference而非复制内容；Intentional Improvement：validated URI/path capability与访问检查；Defect：无；待验证：inline text最大尺度。
- **未来 Rust owner：** TeamRun Domain evidence model；具体 storage Integration/Delivery。
- **Rust 重写与性能判断：** typed variants，不把 artefact bytes放 event/outbox。指标：evidence resolution failure、payload size。
- **验证 oracle：** 未授权/path traversal引用拒绝；已有 evidence显示兼容。
- **证据：** `team-evidence.ts:1-29`。

### runtime-host/application/team-runtime/domain/team-instance.ts

- **当前 owner：** Team instance/managed-agent/config-restore model。
- **职责与关键 symbols：** `TeamInstance`、`TeamManagedAgentRecord`、`collectTeamManagedAgentIds`。
- **旧语义与策略：** restore snapshot 描述 external config，ID collect 用 Set去重且保序。
- **状态、存储与副作用：** 纯 data/helper，无存储实现。
- **并发与性能特征：** collect O(n) time/memory。
- **调用/依赖边界：** TeamRuntimeService、OpenClaw materialization。
- **故障、恢复与安全：** configRestore 是补偿描述，不表示事务、回滚完成或 provider receipt。
- **迁移分类：** Preserve：managed ownership/restore intent；Intentional Improvement：explicit desired/applied/restore receipt；Defect：无；待验证：external agent并发修改策略。
- **未来 Rust owner：** TeamRun Domain；OpenClaw config actual state仍属 Integration。
- **Rust 重写与性能判断：** HashSet dedupe，无 actor/outbox；materialization saga另建。指标：restore completeness。
- **验证 oracle：** duplicate agent IDs stable；external restore故障后reconcile。
- **证据：** `team-instance.ts:5-51`。

### runtime-host/application/team-runtime/domain/team-managed-agent.ts

- **当前 owner：** managed agent identity generator。
- **职责与关键 symbols：** `buildTeamManagedAgentId`、`stableHash`。
- **旧语义与策略：** deterministic FNV-1a 32-bit hash，按 JS UTF-16 code unit；无 salt/version/collision registry。
- **状态、存储与副作用：** 纯函数。
- **并发与性能特征：** O(|teamId|+|roleId|)。
- **调用/依赖边界：** materialization/TeamInstance/OpenClaw config。
- **故障、恢复与安全：** 32-bit碰撞和 Unicode跨实现不一致会影响已有 agent identity；不能静默换算法。
- **迁移分类：** Preserve：既有 ID grammar；Intentional Improvement：versioned canonical UTF-8/new identity仅新记录；Defect：collision未登记；待验证：存量 ID分布。
- **未来 Rust owner：** TeamRun Domain identity rule；通用 identity binding可引用 Platform Core。
- **Rust 重写与性能判断：** 忠实实现 legacy hash用于读取；新版本可强hash但迁移映射持久化。指标：collision/ID compatibility。
- **验证 oracle：** golden strings含 Unicode；存量 config ID differential；collision simulate。
- **证据：** `team-managed-agent.ts:1-30`。

### runtime-host/application/team-runtime/domain/team-node-prompt-delivery.ts

- **当前 owner：** node prompt delivery record/data state。
- **职责与关键 symbols：** `TeamNodePromptDeliveryRecord`、delivery status union。
- **旧语义与策略：** status/attempt/settled fields有旧记录可选兼容。
- **状态、存储与副作用：** 类型本身无 store/side effect。
- **并发与性能特征：** 无 claim/lease/fencing token。
- **调用/依赖边界：** TeamRuntimeService scheduler/delivery port。
- **故障、恢复与安全：** 它看似 outbox 但没有 durable claim/ack/retry存储；多 worker recovery可重复投递。
- **迁移分类：** Preserve：delivery identity/status/attempt语义；Intentional Improvement：真正 durable delivery outbox with claim/receipt；Defect：模型被误用为outbox会失可靠性；待验证：state snapshot是否完整持久此字段。
- **未来 Rust owner：** TeamRun Domain outbox record；Foundation提供 transaction/lease primitive。
- **Rust 重写与性能判断：** per delivery idempotency + lease/fencing、state+outbox同事务；不保证下游 prompt exactly-once。指标：duplicate delivery、retry lag、outbox drain。
- **验证 oracle：** multi-worker claim仅一胜；外发成功/本地崩溃重试使用同 key。
- **证据：** `team-node-prompt-delivery.ts:3-31`。

### runtime-host/application/team-runtime/domain/team-run.ts

- **当前 owner：** Team run aggregate/binding model。
- **职责与关键 symbols：** `TeamRunStatus`、`TeamRunRuntimeBinding`。
- **旧语义与策略：** `teamId/currentWorkflowTaskId`可选兼容；`revision`字段无CAS/递增实现；状态枚举无终态约束。
- **状态、存储与副作用：** type only；service snapshot负责持久。
- **并发与性能特征：** 无。
- **调用/依赖边界：** run registry/service/state store/session/materialization.
- **故障、恢复与安全：** binding失效/重绑由外层，model不表达 epoch/receipt。
- **迁移分类：** Preserve：run/status/binding compatibility；Intentional Improvement：revision CAS、binding epoch/terminal transition; Defect：revision无执行语义；待验证：外部读者依赖可选字段。
- **未来 Rust owner：** TeamRun Domain；execution/correlation IDs Platform Core。
- **Rust 重写与性能判断：** event/snapshot version，actor owns transitions；no direct I-O/outbox. 指标：conflict、restore correctness。
- **验证 oracle：** terminal不可逆、revision单调、binding重连/替换测试。
- **证据：** `team-run.ts:3-43`。

### runtime-host/application/team-runtime/graph/definition.ts

- **当前 owner：** Team graph definition/trigger data model。
- **职责与关键 symbols：** `TeamGraphDefinition`、nodes/edges、`readStartNodeTrigger`。
- **旧语义与策略：** `nodeKind/kind`重复，`config/executor`开放 Record；trigger仅 webhook path/cron 基础判断。
- **状态、存储与副作用：** 纯 definitions。
- **并发与性能特征：** 无。
- **调用/依赖边界：** graph index/reducer/scheduler/YAML/TeamRuntimeService。
- **故障、恢复与安全：** 无 schema version/严格 config；不能单独保证环、端口、授权或 secret安全。
- **迁移分类：** Preserve：node/edge/trigger语义；Intentional Improvement：versioned typed schema；Defect：冗余 kind/开放 config易漂移；待验证：历史 graph format。
- **未来 Rust owner：** TeamRun Domain graph model；webhook auth在TeamRun app layer，Delivery仅转发。
- **Rust 重写与性能判断：** adjacency建索引由 index层，definition不带actor/outbox。指标：decode、graph size限制。
- **验证 oracle：** schema compatibility/YAML fixtures、invalid graph rejection。
- **证据：** `graph/definition.ts:56-160`。

### runtime-host/application/team-runtime/graph/export-yaml.ts

- **当前 owner：** graph YAML import/export boundary。
- **职责与关键 symbols：** YAML emit/parse、legacy alias read。
- **旧语义与策略：** output含 version；parse支持 `id/nodeId`、`from/sourceNodeId`、`to/targetNodeId` 等 aliases，但忽略 version、丢 `idempotencyKey/createdAt/groups`，产松散 record。
- **状态、存储与副作用：** string conversion，唯一依赖 YAML lib。
- **并发与性能特征：** O(document)，无 I-O。
- **调用/依赖边界：** package/UI/graph definition/reducer。
- **故障、恢复与安全：** 不是保真恢复格式，也不验证环/端口/完整 schema。
- **迁移分类：** Preserve：legacy alias import、human YAML；Intentional Improvement：明确“display/export”非snapshot，version migration/strict schema；Defect：输出version而解析忽略、信息丢失；待验证：是否有人用作run恢复。
- **未来 Rust owner：** TeamRun Domain import/export adapter。
- **Rust 重写与性能判断：** use typed schema and size bounded parser; no actor/outbox. 指标：round-trip loss、parse reject。
- **验证 oracle：** current/legacy fixtures；字段保真要求明确；YAML不可作为recovery oracle。
- **证据：** `graph/export-yaml.ts:1-3,10-30,44-55,89-145`。

### runtime-host/application/team-runtime/graph/index.ts

- **当前 owner：** workflow plan lowering/adjacency index builder。
- **职责与关键 symbols：** `buildTeamGraphDefinitionFromWorkflowPlan`、`buildTeamGraphIndex`。
- **旧语义与策略：** task/dependency映射 work node和 activate/completed edge；拒 duplicate/unknown task；group重复 task 后者静默覆盖；不拒环。
- **状态、存储与副作用：** 纯构建。
- **并发与性能特征：** O(V+E) time/memory。
- **调用/依赖边界：** package workflow→graph reducer/scheduler。
- **故障、恢复与安全：** cycle/unreachable提交后可永久 pending；重复 group task覆盖缺可解释错误。
- **迁移分类：** Preserve：plan lowering语义；Intentional Improvement：cycle/reachability/duplicate validation；Defect：silent overwrite与环漏检；待验证：workflow允许循环的产品意图。
- **未来 Rust owner：** TeamRun Domain graph compiler。
- **Rust 重写与性能判断：** adjacency `HashMap<Vec>`; topological/SCC validation O(V+E)，只增加提交时成本以消除运行时死等。指标：compile time、invalid graph rejection。
- **验证 oracle：** duplicate/unknown/cycle/unreachable fixtures；valid plan TS/Rust graph differential。
- **证据：** `graph/index.ts:29-107,144-168`。

### runtime-host/application/team-runtime/graph/projection.ts

- **当前 owner：** graph UI/read-model projections。
- **职责与关键 symbols：** snapshot/execution/input/delivery projections。
- **旧语义与策略：** 兼容 from/to、stageId、executionId aliases；纯派生；任一 cancelled attempt可使整体显示 cancelled。
- **状态、存储与副作用：** 无，非权威状态。
- **并发与性能特征：** snapshot O(V+E)，execution O(cumulative attempts)。
- **调用/依赖边界：** TeamRuntime responses/UI/graph run state。
- **故障、恢复与安全：** projection优先级可能掩盖更晚成功/终态；不应反馈写入决策。
- **迁移分类：** Preserve：display aliases与可观察 summary；Intentional Improvement：明确 projection precedence/version；Defect：cancelled priority的业务正确性待验证；待验证：UI依赖字段。
- **未来 Rust owner：** TeamRun Domain query projection；Delivery consumes view。
- **Rust 重写与性能判断：** cache only if profiling; no actor/outbox/storage authority. 指标：large graph render、projection consistency。
- **验证 oracle：** state fixtures differential；cancelled/succeeded mixed attempt expected view明确。
- **证据：** `graph/projection.ts:90-230`。

### runtime-host/application/team-runtime/graph/reducer.ts

- **当前 owner：** Team graph pure reducer/logical actor transition core。
- **职责与关键 symbols：** initial state、`reduceTeamGraphRunState`、edge activation/rework/trigger。
- **旧语义与策略：** `task.completed→WorkNode`和 `completedNodeIds` fallback兼容；每变更重建 input state；trigger可达搜索；只校验 ID/端点。`node.completed/failed` 按 nodeId找 current attempt，事件不校验 attempt/nodeExecutionId；rework后陈旧 callback可影响新 attempt，failed可倒灌 completed/cancelled。重复 Start trigger重置下游attempt但不清旧 ready queue，下游 stale item可使 scheduler hard fail。
- **状态、存储与副作用：** 纯 state in/out，无 I-O/persistence。
- **并发与性能特征：** input rebuild最坏 O(V×E)，trigger reachability；attempt history/queue无界；无事件序/去重/fencing。
- **调用/依赖边界：** graph definition/index→reducer→scheduler→TeamRuntimeService。
- **故障、恢复与安全：** cycle/unreachable可永久 pending；不适合作为单独 durable event replay semantics。
- **迁移分类：** Preserve：activation/rework/legacy completion行为（先用差分确认）；Intentional Improvement：attempt fencing、sequence/idempotency、queue epoch、graph validation；Defect：stale completion和重复 trigger stale queue代码可证；待验证：是否有上游强串行防护。
- **未来 Rust owner：** **TeamRun Domain Module** 的 reducer/state machine；Foundation不拥有 graph rules。
- **Rust 重写与性能判断：** run actor顺序应用 event，node attempt含 execution/fence token；incremental dependency counters避免全图重建。outbox与reducer state事务化，但外部 prompt/agent completion仍至少一次。指标：V/E/attempt增长、stale-event拒绝、schedule latency。
- **验证 oracle：** reducer differential fixtures；rework后旧 completion必须无效；重复 start不可hard fail；cycle拒绝；fault/replay sequence tests。
- **证据：** `graph/reducer.ts:37-96,108-148,168-245,314-359,490-557,622-681`；`graph/scheduler.ts:179-184`。

### runtime-host/application/team-runtime/graph/run-state.ts

- **当前 owner：** graph actor in-memory run-state data model。
- **职责与关键 symbols：** attempts/history、inbound/input state、`readyQueue/readyQueueItems/queuedReadyNodeIds`。
- **旧语义与策略：** 三份同义 queue view 并存；attempt history记录累计。
- **状态、存储与副作用：** data only，最终被 TeamRun snapshot序列化。
- **并发与性能特征：** O(nodes+edges+attempts+queue)，history无界，三视图可漂移。
- **调用/依赖边界：** reducer produces、scheduler/projection/service consumes。
- **故障、恢复与安全：** 非 durable outbox；无 queue item epoch/fence，无法自身识别过期。
- **迁移分类：** Preserve：需要的 attempt/input/ready语义；Intentional Improvement：single canonical queue + derived indexes、bounded/archive history、attempt fence；Defect：重复状态易漂移；待验证：外部是否读取所有三个字段。
- **未来 Rust owner：** TeamRun Domain run actor state。
- **Rust 重写与性能判断：** `VecDeque` + HashSet/index，derived view不持久；actor owns mutation。指标：state bytes、queue operation、snapshot recovery。
- **验证 oracle：** reducer invariant：queue/set/index一致；old snapshot migration；stale item rejection。
- **证据：** `graph/run-state.ts:62-137`。

### runtime-host/application/team-runtime/graph/scheduler.ts

- **当前 owner：** ready work scheduler/control-effect planner。
- **职责与关键 symbols：** `scheduleReadyWorkNodeDeliveries`、delivery、control-node effect。
- **旧语义与策略：** 以 active/blocked localSessionId、session slots 做本调用内限流；返回内存 delivery/effect，不实际发送/持久 ack/retry。
- **状态、存储与副作用：** 纯计算，无 I-O/outbox。
- **并发与性能特征：** O(queue+nodes+scheduled histories)；跨调用无 lease/CAS；遇 stale ready item hard failure。
- **调用/依赖边界：** reducer state→TeamRuntimeService prompt delivery/role session ports。
- **故障、恢复与安全：** 不是任务执行器；不能保证 slot在并行 service call下安全，也没有持久 prompt receipt。
- **迁移分类：** Preserve：ready selection/session slot policy；Intentional Improvement：actor-owned slots、durable delivery claim/receipt、stale item skip/diagnostic；Defect：旧 trigger遗留的stale item hard fail；待验证：slots产品公平性。
- **未来 Rust owner：** TeamRun Domain scheduler; Foundation supplies task/lease primitives.
- **Rust 重写与性能判断：** run actor产 outbox delivery，workers有界并发；不把dispatch执行塞进pure planner。指标：ready latency、slot use、stale discard、queue depth。
- **验证 oracle：** concurrent schedule/retry；stale queue不阻断；delivery order/session capacity differential。
- **证据：** `graph/scheduler.ts:66-224`。

### runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/index.ts

- **当前 owner：** SQLite ledger infrastructure barrel。
- **职责与关键 symbols：** re-export `SqliteTeamCommandLedger`/deps。
- **旧语义与策略：** 无运行时行为。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无。
- **调用/依赖边界：** worker entry imports SQLite implementation。
- **故障、恢复与安全：** 无。
- **迁移分类：** Preserve：module boundary；Intentional Improvement：Rust infra module isolation；Defect：无；待验证：无。
- **未来 Rust owner：** Infrastructure export layer，非 Domain。
- **Rust 重写与性能判断：** 无 actor/outbox/storage logic；只 re-export implementation。
- **验证 oracle：** compile/module linkage。
- **证据：** `infrastructure/worker/local-sqlite/index.ts:1-2`。

### runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-command-ledger.ts

- **当前 owner：** SQLite accepted/rejected command receipt ledger。
- **职责与关键 symbols：** `SqliteTeamCommandLedger`、append、schema/init/read record。
- **旧语义与策略：** `(runId,idempotencyKey)`去重；每 run递增 sequence；保存 command JSON/accepted或rejected时间；schema对 sequence/idempotency/commandId有 unique。
- **状态、存储与副作用：** SQLite WAL、`synchronous=NORMAL`、busy_timeout 5s；`BEGIN IMMEDIATE`。
- **并发与性能特征：** 单写 transaction避免 sequence race；`DatabaseSync`阻塞 worker event loop；每 append dynamic prepare，命中 parse JSON；5秒竞争失败无 retry。
- **调用/依赖边界：** TeamRuntimeService command ledger port→worker SQLite；非 graph delivery state。
- **故障、恢复与安全：** 同 run commandId不同 idempotency先按 key查不到后撞 unique并报错；无 read/replay/claim/ack，绝非 outbox。
- **迁移分类：** Preserve：idempotent accepted/rejected receipt/sequence；Intentional Improvement：DB writer actor/async transaction、明确 commandId conflict；Defect：被当作outbox会错误；待验证：SQLite file durability settings的产品要求。
- **未来 Rust owner：** TeamRun Domain ledger model + Infrastructure SQLite implementation；Foundation可提供 transactional mechanism。
- **Rust 重写与性能判断：** blocking DB放专用 writer；若需要投递另建 outbox表。指标：write contention、p99 append、recovery/duplicate behavior。
- **验证 oracle：** `tests/unit/team-command-ledger.test.ts`；concurrent append、same commandId/different key、busy timeout、crash WAL tests。
- **证据：** `sqlite-team-command-ledger.ts:12-25,40-216`。

### runtime-host/application/team-runtime/infrastructure/worker/team-runtime-worker-entry.ts

- **当前 owner：** Team worker composition root。
- **职责与关键 symbols：** worker FS、SQLite/file state/package/host proxy/TeamRuntimeService/cron assembly、invoke/close handlers。
- **旧语义与策略：** startup组装并 rehydrate active runs后 refresh cron；收到 invoke直接 `void handleInvoke`，可同时悬挂；close关闭 cron/ledger。
- **状态、存储与副作用：** Node FS/stream/crypto/worker port、SQLite、JSON files、host RPC。
- **并发与性能特征：** sync SQLite堵 worker；host RPC invocation可交叠；`writeTextFile`非原子，exists将所有 stat error折 false。
- **调用/依赖边界：** main worker client↔worker；service ports经host proxy回主线程。
- **故障、恢复与安全：** startup failure缓存后所有 invoke fail；close不drain in-flight invokes，可能关闭仍使用 ledger；parentPort close只 reject host RPC，不必然关闭 cron/ledger。
- **迁移分类：** Preserve：rehydrate后scheduler、host boundary；Intentional Improvement：single command mailbox/structured shutdown、atomic file adapter；Defect：正常 close/inflight race；待验证：worker host是否保证顺序。
- **未来 Rust owner：** Foundation worker supervision + TeamRun actor composition；Node具体I-O不进 Domain。
- **Rust 重写与性能判断：** actor mailbox序列化 mutations，DB writer隔离，shutdown先stop intake/drain/cancel再close storage。指标：shutdown p99、inflight error、blocking DB time。
- **验证 oracle：** invoke中close不访问closed ledger；startup error可重试策略；FS stat permission error不等同不存在。
- **证据：** `team-runtime-worker-entry.ts:1-96,154-326`。

### runtime-host/application/team-runtime/ports/team-agent-materialization-port.ts

- **当前 owner：** Team agent materialization outbound port。
- **职责与关键 symbols：** `TeamAgentMaterializationSpec`、materialize/remove contract。
- **旧语义与策略：** spec含 team/endpoint/source/TeamSkill/leader/roles，返回 managed agents。
- **状态、存储与副作用：** interface 无；implementation决定外部状态。
- **并发与性能特征：** 无。
- **调用/依赖边界：** TeamRuntimeService→OpenClaw adapter。
- **故障、恢复与安全：** port不表达 transaction/retry/compensation；不能把OpenClaw config/workspace语义下沉为Domain。
- **迁移分类：** Preserve：provider-neutral desired spec；Intentional Improvement：明确 receipt/compensation result；Defect：无；待验证：其他 Runtime adapter需求。
- **未来 Rust owner：** TeamRun Domain application outbound trait；实现严格 Runtime Integration。
- **Rust 重写与性能判断：** 无 actor/outbox本体；Domain actor记录 intent。指标：materialization outcome/compensation。
- **验证 oracle：** fake port contract；OpenClaw integration contract snapshots。
- **证据：** `team-agent-materialization-port.ts:4-54`。

### runtime-host/application/team-runtime/ports/team-command-ledger-port.ts

- **当前 owner：** command ledger append port。
- **职责与关键 symbols：** `TeamCommandLedgerPort.append`。
- **旧语义与策略：** 只暴露 append(command,status,rejectionReason)，无 read/replay/dispatch。
- **状态、存储与副作用：** port抽象写副作用。
- **并发与性能特征：** 未规定。
- **调用/依赖边界：** TeamRuntimeService→SQLite implementation。
- **故障、恢复与安全：** 不能据此推断 durable delivery/outbox；持久 oracle取决于 infra。
- **迁移分类：** Preserve：accepted/rejected receipt append；Intentional Improvement：若需恢复，独立 read/outbox port；Defect：无；待验证：是否需审计查询。
- **未来 Rust owner：** TeamRun Domain application trait。
- **Rust 重写与性能判断：** append可由 transaction注入；不与delivery outbox混合。指标：append/dedupe latency。
- **验证 oracle：** contract tests idempotent append/duplicate response。
- **证据：** `team-command-ledger-port.ts:1-12`。

### runtime-host/application/team-runtime/ports/team-node-prompt-delivery-port.ts

- **当前 owner：** node prompt delivery outbound contract。
- **职责与关键 symbols：** delivery record/binding/idempotency key→delivered/failed response。
- **旧语义与策略：** 明确传递幂等意图和时间/promptRunId回执。
- **状态、存储与副作用：** interface无持久 claim/retry/ack规定。
- **并发与性能特征：** 未规定。
- **调用/依赖边界：** TeamRuntime service/scheduler→prompt delivery service→role session adapter。
- **故障、恢复与安全：** contract本身不能担保 receiver dedupe或外发成功后的本地崩溃恢复。
- **迁移分类：** Preserve：idempotency argument/receipt shape；Intentional Improvement：durable outbox与receiver receipt区分；Defect：无；待验证：下游 prompt实现的幂等。
- **未来 Rust owner：** TeamRun Domain port，Session/Runtime integration implementation。
- **Rust 重写与性能判断：** actor claim delivery then call port；outbox另存，不记录 prompt plaintext。指标：duplicate/retry/receipt。
- **验证 oracle：** repeated same key receiver behavior；external success/local crash test。
- **证据：** `team-node-prompt-delivery-port.ts:1-23`。

### runtime-host/application/team-runtime/ports/team-notification-port.ts

- **当前 owner：** Team notification outbound port。
- **职责与关键 symbols：** run/subject/message/idempotency key→delivery result。
- **旧语义与策略：** 最小通知 contract。
- **状态、存储与副作用：** 无；channel实现决定。
- **并发与性能特征：** 未规定顺序、容量、retry。
- **调用/依赖边界：** TeamRuntime→Delivery/channel adapter。
- **故障、恢复与安全：** 无 receipt/outbox/channel/redaction语义，message可能含敏感信息需上层控制。
- **迁移分类：** Preserve：port最小性；Intentional Improvement：notification outbox/redacted payload policy；Defect：无；待验证：实际实现/consumer。
- **未来 Rust owner：** TeamRun Domain port，Delivery/Integration implementation。
- **Rust 重写与性能判断：** 无本体actor；outbox可复用Foundation tx primitive但notification业务仍归Team. 指标：delivery retry、duplicate。
- **验证 oracle：** idempotency contract与redaction tests。
- **证据：** `team-notification-port.ts:1-16`。

### runtime-host/application/team-runtime/ports/team-role-session-materialization-port.ts

- **当前 owner：** endpoint session lifecycle port。
- **职责与关键 symbols：** resolve endpoint id、materialize、dematerialize。
- **旧语义与策略：** provider lifecycle的最小抽象。
- **状态、存储与副作用：** 无，remote provider是事实源。
- **并发与性能特征：** 未规定幂等/timeout。
- **调用/依赖边界：** role session adapter→OpenClaw materialization adapter。
- **故障、恢复与安全：** binding输入不等于 remote receipt；无 outbox/reconcile。
- **迁移分类：** Preserve：provider-neutral port；Intentional Improvement：receipt/exists reconciliation；Defect：无；待验证：其他 Runtime的dematerialize语义。
- **未来 Rust owner：** TeamRun Domain outbound trait；OpenClaw实现为 Integration。
- **Rust 重写与性能判断：** no actor/storage; desired binding/outbox in Team actor. 指标：remote orphan rate。
- **验证 oracle：** fake idempotent materialize/dematerialize；provider integration tests。
- **证据：** `team-role-session-materialization-port.ts:1-8`。

### runtime-host/application/team-runtime/ports/team-role-session-port.ts

- **当前 owner：** Team role session application port。
- **职责与关键 symbols：** ensure/remember/prompt/abort/delete/read window、`TeamRoleSessionWindow`。
- **旧语义与策略：** window区分 available、pending hydration、unavailable。
- **状态、存储与副作用：** interface不规定 registry/store/remote I-O。
- **并发与性能特征：** 未定义序列化/compensation。
- **调用/依赖边界：** TeamRuntimeService→SessionRuntime adapter。
- **故障、恢复与安全：** status三态不能自行保证session一致性；接口隐藏local/endpoint跨系统原子性缺口。
- **迁移分类：** Preserve：三态窗口、role binding语义；Intentional Improvement：deadline/receipt/compensation明确化；Defect：无；待验证：abort/delete并发契约。
- **未来 Rust owner：** TeamRun Domain port；Session Domain/Runtime Integration implementation。
- **Rust 重写与性能判断：** Team actor不直接拥有 session internals；outbox用于binding intent。指标：hydrate等待、delete dangling。
- **验证 oracle：** 202/非200不显示空窗口；ensure/delete error/reconcile tests。
- **证据：** `team-role-session-port.ts:5-73`。

### runtime-host/application/team-runtime/team-dependency-plan.ts

- **当前 owner：** Team package dependency preflight planner。
- **职责与关键 symbols：** `buildTeamDependencyPlan`、`buildDependencyPlanItem`、`collectAvailableSkillNames`。
- **旧语义与策略：** 从 catalog/dependencies同步生成 missing bins/env/config/os；builtin source/name可用；坏输入静默为空值。
- **状态、存储与副作用：** 纯计算，不实际探测环境。
- **并发与性能特征：** O(catalog+deps)。
- **调用/依赖边界：** package service/skill catalog/UI preflight。
- **故障、恢复与安全：** plan非真实 install/availability oracle，过度信任 catalog。
- **迁移分类：** Preserve：declarative preflight；Intentional Improvement：显式 unknown/invalid diagnostic；Defect：坏输入静默降级；待验证：builtin命名兼容。
- **未来 Rust owner：** TeamRun Domain planning/query；环境探测为 Integration。
- **Rust 重写与性能判断：** pure stable sort/maps，无 actor/outbox. 指标：catalog规模、diagnostic completeness。
- **验证 oracle：** catalog/dependency matrix；invalid input produces diagnostic而非假可用。
- **证据：** `team-dependency-plan.ts:40-60,92-174`。

### runtime-host/application/team-runtime/team-node-prompt-delivery-service.ts

- **当前 owner：** role-session prompt delivery adapter/service。
- **职责与关键 symbols：** `deliver`、`formatTeamNodePrompt`。
- **旧语义与策略：** 调一次 `promptRoleSession`，成功返回 `deliveredAt/promptRunId`；幂等/确认外包下游 port。
- **状态、存储与副作用：** external prompt I-O；无本地 state/store/retry。
- **并发与性能特征：** 单调用，无 queue。
- **调用/依赖边界：** TeamRuntimeService delivery path→TeamRoleSessionPort。
- **故障、恢复与安全：** success外发后进程崩溃，服务自身不能保存 receipt；prompt内容不应写入通用 outbox/plain logs。
- **迁移分类：** Preserve：prompt shape/receipt；Intentional Improvement：Team durable delivery record+receiver idempotency；Defect：无本地恢复闭环；待验证：下游 prompt dedupe。
- **未来 Rust owner：** TeamRun Domain application service；Session Runtime is Integration/peer domain。
- **Rust 重写与性能判断：** worker从outbox claim后调用，receipt再事务落地；不承诺runtime外部exactly-once。指标：delivery lag、duplicate、prompt body storage=0。
- **验证 oracle：** same key repeated; external success/local crash; no plaintext prompt in durable diagnostic.
- **证据：** `team-node-prompt-delivery-service.ts:5-42`。

### runtime-host/application/team-runtime/team-run-registry.ts

- **当前 owner：** process-local run index。
- **职责与关键 symbols：** upsert/remove/removeTeam/listNonTerminalRunIds/hasNonTerminalRuns。
- **旧语义与策略：** 双索引 `runId→record`、`teamId→Set<runId>`；同步 Map；终态不自动清；revision只存不比较。
- **状态、存储与副作用：** memory only，restart全失。
- **并发与性能特征：** list O(N logN)、removeTeam O(team runs)，无 lock/CAS。
- **调用/依赖边界：** TeamRuntimeService rehydrate/run lifecycle。
- **故障、恢复与安全：** 旧 revision可覆盖新；registry不是恢复事实源。
- **迁移分类：** Preserve：fast local lookup；Intentional Improvement：actor-owned derived index/rebuild from durable state/revision check；Defect：stale overwrite可能；待验证：唯一服务实例。
- **未来 Rust owner：** TeamRun Domain ephemeral actor index，不单独持久。
- **Rust 重写与性能判断：** HashMap/HashSet；terminal主动淘汰/derived rebuild。指标：lookup/list、memory、rebuild time。
- **验证 oracle：** older revision upsert拒绝；restart从store重建；team removal cleans both indexes。
- **证据：** `team-run-registry.ts:3-76`。

### runtime-host/application/team-runtime/team-runtime-cron-scheduler.ts

- **当前 owner：** local cron/retry timer driver。
- **职责与关键 symbols：** `refresh/close/tickOnce/reconcileJobs/fireCronTrigger/reconcileNodePromptRetries`。
- **旧语义与策略：** cron fire前前移 slot，失败不重发该 slot；timer只考虑 retry deadline，否则最多30秒轮询；cron due `Promise.all` 无并发上限，retry snapshot串行；close后已启动I-O仍可完成。
- **状态、存储与副作用：** timer/running/closed/jobs Map，调用 triggerList/fire/runSnapshot/nodePromptRetryDue。
- **并发与性能特征：** unbounded due cron fan-out，timer不是 durable schedule/outbox。
- **调用/依赖边界：** TeamRuntimeService、webhook/graph trigger、prompt delivery retry。
- **故障、恢复与安全：** restart后若 rehydrate只索引binding、不schedule ready/due retry，run可停滞；cron deadline不精确。
- **迁移分类：** Preserve：cron slot不重复/基于due retry；Intentional Improvement：durable schedule/outbox、有界 supervisor、catch-up policy；Defect：cron wake和恢复停滞风险；待验证：任务框架是否另行限流。
- **未来 Rust owner：** TeamRun Domain scheduling policy；Foundation Kernel task supervision/timer primitive。
- **Rust 重写与性能判断：** persist next due/action receipt，supervisor bounded concurrency；不承诺外部 trigger exactly-once。指标：cron jitter、due backlog、recovery delay。
- **验证 oracle：** clock jump/restart/catch-up;大量due任务有界；close后不新增外部副作用。
- **证据：** `team-runtime-cron-scheduler.ts:31-43,45-180,207-250`。

### runtime-host/application/team-runtime/team-runtime-debug-logging.ts

- **当前 owner：** Team debug flag helper。
- **职责与关键 symbols：** `isTeamRuntimeDebugLoggingEnabled`。
- **旧语义与策略：** 每次读 `MATCHACLAW_TEAM_RUNTIME_DEBUG`。
- **状态、存储与副作用：** 读取 env，无存储。
- **并发与性能特征：** O(1)。
- **调用/依赖边界：** Team service/worker diagnostics。
- **故障、恢复与安全：** scheduler未使用此开关，不能弥补 timer错误观测；debug不得泄 prompt/secret。
- **迁移分类：** Preserve：显式 env开关；Intentional Improvement：structured redacted tracing；Defect：无；待验证：已用调用方。
- **未来 Rust owner：** Foundation observability configuration/redaction。
- **Rust 重写与性能判断：** no actor/outbox; cached config only if needed. 指标：debug off overhead、secret leak tests。
- **验证 oracle：** truthy/falsey env matrix；日志不含secret/prompt。
- **证据：** `team-runtime-debug-logging.ts:1-7`。

### runtime-host/application/team-runtime/team-runtime-jobs.ts

- **当前 owner：** background managed-agent deletion job adapter。
- **职责与关键 symbols：** `DELETE_TEAM_MANAGED_AGENTS_JOB`、`TeamRuntimeJobPort`、factory。
- **旧语义与策略：** 提交低优先级任务，最多3次、1秒 retry，丢弃结果；dedupeKey仅 teamId。
- **状态、存储与副作用：** 交给 platform/background task system。
- **并发与性能特征：** teamId级去重不含 endpoint/agent集，可能合并不同删除意图。
- **调用/依赖边界：** TeamRuntimeService→job system→materialization port。
- **故障、恢复与安全：** 无 durable job receipt/外部状态核对；删除安全需adapter ownership checks。
- **迁移分类：** Preserve：后台低优先级重试；Intentional Improvement：desired agent set/receipt作为dedupe语义；Defect：teamId-only dedupe信息丢失；待验证：job system真实dedupe规则。
- **未来 Rust owner：** TeamRun Domain job intent；Foundation Kernel task supervision/retry primitive。
- **Rust 重写与性能判断：** transaction record cleanup intent，由supervisor执行；不让Foundation拥有agent删除业务。指标：coalescing、retry、orphan agents。
- **验证 oracle：** 同team不同endpoint/agent set不错误合并；重试后ownership仍校验。
- **证据：** `team-runtime-jobs.ts:5,19-27`。

### runtime-host/application/team-runtime/team-runtime-operation-id.ts

- **当前 owner：** Team runtime operation vocabulary。
- **职责与关键 symbols：** 25 个 operation ID constants/types。
- **旧语义与策略：** 编译期字符串名，params/result/error未判别关联。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无。
- **调用/依赖边界：** API/capability/worker/service。
- **故障、恢复与安全：** raw operation id不表达auth/schema/timeout。
- **迁移分类：** Preserve：public names；Intentional Improvement：typed command enum with request/result/error mapping；Defect：无；待验证：external aliases。
- **未来 Rust owner：** TeamRun Domain application operation enum。
- **Rust 重写与性能判断：** serde parse，无 actor/outbox。指标：unknown op rejection。
- **验证 oracle：** exhaustive mapping/compatibility fixtures。
- **证据：** `team-runtime-operation-id.ts:1-26`。

### runtime-host/application/team-runtime/team-runtime-package-service.ts

- **当前 owner：** TeamSkill package validator/reader。
- **职责与关键 symbols：** validate/read required files/manifest/dependencies/roles。
- **旧语义与策略：** 串行读必需文件/roles；读异常一律归缺失/无 bind；直接拼 `roles/${role.id}.md`。
- **状态、存储与副作用：** read-only filesystem I-O。
- **并发与性能特征：** role数线性串行 I-O。
- **调用/依赖边界：** TeamRuntimeService/package TeamSkill→dependency plan/materialization。
- **故障、恢复与安全：** role.id未限路径段，可 path traversal；吞权限/编码/I-O错误导致错误诊断。
- **迁移分类：** Preserve：必需文件/manifest语义；Intentional Improvement：canonical package path、parallel bounded reads、typed errors；Defect：role path traversal可证；待验证：role id上游schema。
- **未来 Rust owner：** TeamRun Domain package validation；file system是 Infrastructure。
- **Rust 重写与性能判断：** normalize+ensure child path，bounded concurrent reads（只在角色规模证明时）；无 actor/outbox。指标：I-O latency、escape=0。
- **验证 oracle：** `../`/separator role IDs拒绝；permission与missing区分；package fixtures differential。
- **证据：** `team-runtime-package-service.ts:13-59,91-123`。

### runtime-host/application/team-runtime/team-runtime-port.ts

- **当前 owner：** Team runtime facade port。
- **职责与关键 symbols：** `TeamRuntimePort.invoke/close`。
- **旧语义与策略：** `params:unknown` 与非判别结果。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 未规定。
- **调用/依赖边界：** capability/API→worker-backed service/TeamRuntimeService。
- **故障、恢复与安全：** 没有deadline/cancel/worker-failure typed semantics。
- **迁移分类：** Preserve：薄 facade；Intentional Improvement：typed command/query/receipt/shutdown；Defect：无；待验证：API envelope compatibility。
- **未来 Rust owner：** TeamRun Domain application trait。
- **Rust 重写与性能判断：** no actor/outbox/storage. 指标：contract compatibility。
- **验证 oracle：** operation contract tests and unknown params rejection。
- **证据：** `team-runtime-port.ts:5-8`。

### runtime-host/application/team-runtime/team-runtime-service.ts

- **当前 owner：** TeamRun core orchestration/actor/ledger/recovery/prompt delivery aggregate。
- **职责与关键 symbols：** `TeamRuntimeService`、stable shard `RunActor`、create/run/trigger/graph event、flush/rehydrate/delete、delivery/role binding/managed agents。
- **旧语义与策略：** run按 stable hash进入 shard、同 run `queuedWork`串行、不同 run可并行；state含 graph/deliveries/bindings/dispatch/approval/artifact/message/event projections/processed idempotency Set；缺 graph template时从最近 run反推并回写；命令先改内存后 append accepted ledger；prompt外发在 flushState 前。
- **状态、存储与副作用：** run/team JSON snapshots、in-memory actors/registry、SQLite ledger、role session/prompt/materialization/jobs/notifications ports。
- **并发与性能特征：** event/idempotency/projection arrays无界；flush全量 JSON/复制；team instance无team级队列/CAS，跨 run read-modify-write可丢；actors Map 删除run后不清。
- **调用/依赖边界：** capability/API/worker→service→graph reducer/scheduler、state store/ledger、OpenClaw/Session/notifications integrations。
- **故障、恢复与安全：** ledger非恢复真相，rehydrate只索引/binding、不调度ready/due retry；run file先写、team index后写失败留orphan；load先置 loaded，首读失败不重读；外发成功/flush前崩溃依赖下游 idempotency；删除 run/session→agent job→team instance无补偿。Approval投影是旧Runtime细节，不应升为Matcha Core或Remote agent harness。
- **迁移分类：** Preserve：per-run serial order、graph visible behavior、role session materialization/command receipts；Intentional Improvement：transactional run state+outbox、attempt fencing/recovery scheduler、team-level concurrency control/bounded history；Defect：恢复停滞、orphan index、actor leak、跨run丢写/外发崩溃窗口；待验证：existing tests对每项兼容性。
- **未来 Rust owner：** **TeamRun Domain Module** actor/service；Platform Core仅 identity/execution/capability/receipt；Foundation仅 tx/task/lease/redaction；OpenClaw/Session均 Integration/peer Domain。
- **Rust 重写与性能判断：** run actor是正确串行键，team aggregate变更需team actor/transaction；state+delivery intent同事务、outbox带 idempotency/fence；至少一次外发不可等同外部exactly-once。以 snapshot/event compaction控制N。指标：run queue、flush bytes、recovery time、duplicate prompt、actor count。
- **验证 oracle：** existing `tests/unit/team-runtime-capability.test.ts`；multi-run concurrent mutation、crash matrix、rehydrate ready/retry、external success/local crash、delete saga、large graph benchmark。
- **证据：** `team-runtime-service.ts:627-640,693-708,779-800,848-850,863-1092,1013-1053,1081-1115,1255-1268,1436-1482,1813-1839,1925-1927,2048-2054,2211-2221,2224-2275,2392-2509,2484-2509,2847-2856,3311-3333`。

### runtime-host/application/team-runtime/team-runtime-state-store.ts

- **当前 owner：** Team/run file snapshot store。
- **职责与关键 symbols：** `FileTeamRuntimeStateStore`、run/team path、read/write/list。
- **旧语义与策略：** `runs/<sanitized>.json`/`teams/<sanitized>.json`；ensure dir→temp write→rename；parse JSON即可信；`listTeams`串行读。
- **状态、存储与副作用：** filesystem JSON，无 schema/version/ID回查/lock/CAS/fsync。
- **并发与性能特征：** sanitized ID会碰撞（如 `a/b` 与 `a_b`）；whole file writes；坏 JSON阻断 list/recovery。
- **调用/依赖边界：** TeamRuntimeService/worker FS。
- **故障、恢复与安全：** 多进程/跨actor没有写安全；temp/rename不是持久/原子跨路径完整方案。
- **迁移分类：** Preserve：run/team独立文件和缺失处理；Intentional Improvement：validated schema/revision/transactional storage；Defect：sanitize collision、bad file全表阻断、无CAS；待验证：多进程部署。
- **未来 Rust owner：** Foundation Kernel storage implementation；TeamRun owns schemas/retention.
- **Rust 重写与性能判断：** single writer或transaction DB，atomic run/team index/outbox；并非只换语言。指标：write bytes、corrupt-file isolation、recovery time。
- **验证 oracle：** colliding IDs，one corrupt team不阻塞others，run/index commit crash points。
- **证据：** `team-runtime-state-store.ts:24-29,42-60,77-123`。

### runtime-host/application/team-runtime/team-runtime-webhook-auth.ts

- **当前 owner：** Team webhook secret projection/service。
- **职责与关键 symbols：** `TeamRuntimeWebhookAuthService`、read/create auth projection/settings token。
- **旧语义与策略：** 优先 env，否则 settings；缺失随机生成并持久化；单实例 `inflightToken` single-flight；公开 projection掩码，`getToken`返回明文。
- **状态、存储与副作用：** env/settings read/write、in-memory inflight。
- **并发与性能特征：** 同实例合并，跨实例无CAS/lock；首读 `getAll()`。
- **调用/依赖边界：** webhook route/auth→Team runtime settings/config。
- **故障、恢复与安全：** 无 rotation/revocation/version/audit；跨实例可各生成不同 token；token日志控制依赖调用方。
- **迁移分类：** Preserve：env override与masked projection；Intentional Improvement：secret store CAS/rotation/audit、capability scoped verify；Defect：跨实例token生成race；待验证：settings store是否single-writer。
- **未来 Rust owner：** TeamRun Domain webhook policy；Foundation secret storage/redaction，Delivery verifies request。
- **Rust 重写与性能判断：** transactional create-or-read，token不入outbox/telemetry；no unnecessary actor. 指标：token race=0、rotation propagation。
- **验证 oracle：** concurrent instances get same token; masked APIs never plaintext; rotation invalidates old as policy demands。
- **证据：** `team-runtime-webhook-auth.ts:27-35,47-123`。

### runtime-host/application/team-runtime/team-runtime-worker-client.ts

- **当前 owner：** main-thread Team worker proxy/host I-O dispatcher。
- **职责与关键 symbols：** `WorkerBackedTeamRuntimeService`、pending invoke、worker message/host dispatch。
- **旧语义与策略：** requestId correlation；host request可并发；nonzero exit reject pending，正常 code 0只closed不reject existing；close可重复。
- **状态、存储与副作用：** Worker/pending Map/IPC，host port I-O。
- **并发与性能特征：** pending无timeout/cancel/cap；worker侧是否串行由entry/service决定。
- **调用/依赖边界：** TeamRuntimePort→worker；worker host proxy→main ports。
- **故障、恢复与安全：** pending异常正常退出悬挂；远端 error压成 `Error(message)`丢name/stack；port并发安全外包。
- **迁移分类：** Preserve：correlation/opaque boundary；Intentional Improvement：deadline/abort/supervision、close coalesce；Defect：code0 pending leak/close竞争；待验证：worker终止路径。
- **未来 Rust owner：** Foundation Kernel worker/IPC supervision + Team application adapter。
- **Rust 重写与性能判断：** bounded pending, structured cancellation；durable Team outbox不在worker pending。指标：pending high-water、shutdown/exit completion。
- **验证 oracle：** normal unexpected exit rejects pending；hung host request deadline；double close idempotent。
- **证据：** `team-runtime-worker-client.ts:53-108,116-241,278-290`。

### runtime-host/application/team-runtime/team-runtime-worker-contracts.ts

- **当前 owner：** Team worker IPC ABI。
- **职责与关键 symbols：** config、invoke/close/result/error、host request/response discriminated unions。
- **旧语义与策略：** requestId correlation；`params/result:unknown`；无 protocol version/deadline/cancel/priority/epoch/idempotency。
- **状态、存储与副作用：** 无，structured clone contract。
- **并发与性能特征：** payload size按参数增长。
- **调用/依赖边界：** Team worker entry/client/host proxy。
- **故障、恢复与安全：** `type+ok`唯一 runtime oracle，未做 runtime validation；error taxonomy有限。
- **迁移分类：** Preserve：message names/correlation；Intentional Improvement：versioned validated ABI/deadline/retryability；Defect：无；待验证：所有host payload shapes。
- **未来 Rust owner：** Foundation worker communication contract，Team-specific message payload由Domain拥有。
- **Rust 重写与性能判断：** typed enum/size bound，无 outbox/storage。指标：IPC encode/decode、invalid message rejection。
- **验证 oracle：** unknown/malformed message reject；version negotiation; requestId correlation.
- **证据：** `team-runtime-worker-contracts.ts:15-120`。

### runtime-host/application/team-runtime/team-runtime-worker-host-proxy.ts

- **当前 owner：** worker内 port RPC adapter。
- **职责与关键 symbols：** `TeamRuntimeWorkerHostRpc`、four `WorkerProxy*Port`、pending/rejectAll。
- **旧语义与策略：** 每实例递增 requestId+pending Map；late result仅debug orphan；host error压缩为 `Error(message)`；debug有限 token/key/`sk-`文本清洗。
- **状态、存储与副作用：** in-memory pending、postMessage；无 persistence/outbox。
- **并发与性能特征：** 无timeout/cancel/backpressure；host RPC可无限悬挂。
- **调用/依赖边界：** Team service ports→proxy→main worker client→actual Session/OpenClaw/job/etc。
- **故障、恢复与安全：** `rejectAll`需外部显式调用；文本清洗不应作为secret safe proof；远端 stack/name丢失。
- **迁移分类：** Preserve：orphan response安全处理、minimal error exposure；Intentional Improvement：deadline/cancel/typed redacted error；Defect：unbounded pending；待验证：parent close调用覆盖。
- **未来 Rust owner：** Foundation IPC primitive；TeamRun owns port contracts；actual runtime adapters remain Integration。
- **Rust 重写与性能判断：** bounded pending and cancellation; no durable state. 指标：pending TTL、late response count、secret leak tests。
- **验证 oracle：** host永不响应时超时释放；late receipt不重开状态；diagnostic无plaintext。
- **证据：** `team-runtime-worker-host-proxy.ts:19-25,52-142,145-198`。

---

## 跨文件迁移边界与优先级

1. **TeamRun command/graph/delivery：** Rust 目标必须是 TeamRun Domain 的 per-run actor + attempt fence + state/outbox 同事务。保留同 run 串行和可观察 graph/delivery 顺序；有意改进是把 SQLite accepted ledger 与 prompt delivery record 分开：前者是 receipt ledger，后者才可成为有 claim/lease/receipt 的 outbox。它仍只能达到对外部 Session/OpenClaw 的至少一次尝试，不能虚构 exactly-once。
2. **Remote Fleet lifecycle/command/lease：** Fleet Domain actor 必须线性化 `expire → select → acquire lease → persist command intent`。保留 accepted 与 completed 的区别、agent correlation 和 secret-ref-only wire；有意改进是 transactional outbox、deadline/recovery probe、credential epoch。Docker/K8s/SSH/RuntimeAgent 只能经 receipt/reconcile 收敛，不能由本地 actor声称外部副作用唯一。
3. **Terminal：** terminal ticket、input、output、Authorization、明文 secret 不应进入 durable outbox、replay 或审计 payload。Terminal session应为带 generation/cancellation fence 的内存 actor；只持久化脱敏 lifecycle metadata（如有产品需要）。
4. **Integration 保持外置：** OpenClaw agent config/workspace/session key、Session Runtime session、Docker/K8s/SSH bootstrap/terminal、RuntimeAgent HTTP/protocol 都是 Integration。Matcha Platform Core 不拥有 Team graph、Fleet lifecycle、Remote agent tool harness或 approval decision。
5. **Foundation 的严格边界：** 只提供 task supervision、clock/lease/transaction/storage/redaction/worker communication primitives；不接管 Team/Fleet policy、graph、routing、materialization业务事实。

## 当前 git status 集成与交付增量（工作树快照，未执行）

### 证据范围与判读规则

- 本节只补记本次工作树中 Remote Fleet 的生产交付链和直接边界；它不重开上文 93 个 TypeScript 文件的逐文件 archive、owner 或 Rust 迁移结论，也不把 renderer、Zustand、HTTP response projection 当作 Fleet 的权威状态。
- 下列是静态 source/status 证据，不是已启动的产品行为。没有运行测试、构建、Electron、worker、Docker、Kubernetes、SSH 或 RuntimeAgent；本节的 test 路径仅是后续执行 oracle。
- `runtime-host/application/remote-fleet/**` 是当前 status 中新增的 Fleet Domain/Integration 整体 surface，已由本分片前文的既有 archive 覆盖；为免把同一批文件误计为新的第 94 个文件，本节只列其 active composition role，不复制逐文件审计。
- Electron/preload/renderer 的 Fleet route admission、loopback proxy 和 terminal WebSocket 是支持入口/consumer evidence，不是 Fleet aggregate owner；但目标架构把所有纳管 Runtime 的 lifecycle policy、PID/spawn/restart/log/shutdown 交给 Rust Runtime 的 Local Process Host。因此当前 Electron `process-runtime` 中与 runtime-host、Gateway、app-server 相关的 lifecycle 语义应在其对应迁移功能块中作为**外部旧 owner**重走；不要把这一结论误扩展为 Fleet command、lease、provider或terminal policy归 Electron，也不要把 renderer端状态迁入Rust。

### 当前 status 生产路径与 owner

| 层与 status 路径 | 当前 owner | 当前交付职责与非职责 |
| --- | --- | --- |
| `src/App.tsx` | renderer route composition | 注册 `/remote-fleet`；不拥有 Fleet state。 |
| `src/components/layout/Sidebar.tsx` | renderer navigation | 暴露 Remote Fleet 导航项；不作授权或路由选择。 |
| `src/lib/route-preload.ts` | renderer route loading | lazy/preload `RemoteFleetRoute`；不参与 Fleet lifecycle。 |
| `src/lib/host-api.ts` | renderer transport client | `hostApiFetch`/abort 到本地 Host API 的通用传输边界；不是 Fleet facade 或事实源。 |
| `src/stores/remote-fleet.ts` | renderer projection/action adapter | 请求 snapshot、metrics 和 mutation，保存经压缩的 UI read model；它是缓存，不是 Fleet truth。runtime start/stop/sync 特意经 capability API，不等于普通 Fleet route table。 |
| `src/pages/RemoteFleet/index.tsx` | renderer page orchestration | 初始化/刷新 projection，向子视图分派 action；不裁决 endpoint、lease 或 command 的权威状态。 |
| `src/pages/RemoteFleet/components/RemoteFleetRegistrationSheet.tsx` | renderer registration form/input boundary | 将明文 credential 交给 write-credential，再把返回的 secret-ref 放入配置并清空草稿；不是 credential vault owner。 |
| `src/pages/RemoteFleet/components/RemoteFleetDetailPanel.tsx` | renderer detail projection/action view | 基于 supplied summary 提供 probe/deploy/install/revoke/runtime/endpoint/terminal 操作；可用性提示不是授权事实。 |
| `src/pages/RemoteFleet/components/RemoteFleetResourceBrowser.tsx` | renderer read-only resource index | 对 supplied summaries 做本地搜索、筛选、排序与显示；不调用 Fleet selector。 |
| `src/pages/RemoteFleet/components/RemoteFleetOperationsSection.tsx` | renderer operations projection view | 显示 metrics、command、audit summary 与 projection-gap 文案；文案不是运行时保证。 |
| `src/pages/RemoteFleet/components/RemoteFleetTerminalDrawer.tsx`、`useRemoteFleetTerminal.ts` | renderer terminal presentation/transient transport | 发起/重连/关闭 terminal，并用 ticket-bearing WebSocket path 发送瞬态输入；不持有 durable terminal history。 |
| `src/pages/RemoteFleet/components/remote-fleet-terminal-types.ts`、`remote-fleet-console-types.ts` | renderer local type contracts | 仅 UI 类型；没有 Domain owner。 |
| `src/pages/RemoteFleet/components/remote-fleet-console-shared.tsx` | renderer presentation redaction helper | 对显示文本做敏感字段掩码；不能替代后端或日志 sink 的保密策略。 |
| `src/pages/RemoteFleet/components/RemoteFleetTargetPreview.tsx`、`RemoteFleetTargetPreviewStatusBadge.tsx`、`RemoteFleetTargetPreviewEmptyState.tsx` | stateless renderer target-preview views | 将 supplied endpoint/capability/selector constraints 可视化；不 invoke selector，不 acquire lease，不能成为 routing authority。 |
| `src/i18n/locales/{en,zh,ja,ru}/common.json`、`package.json` | renderer delivery assets/package manifest | 提供 Remote Fleet 文案与 xterm package 交付输入；不证明打包、启动或 terminal 已成功。 |
| `electron/preload/ipc-contract.ts` | preload IPC contract | 保留 renderer `hostapi:fetch`/`hostapi:abort` 等基础设施 channel；不拥有业务状态。 |
| `electron/main/ipc/hostapi-proxy-ipc.ts` | Electron main local Host API proxy | 先校验 route allowlist，再注入本地 Host API bearer 并转发到 loopback runtime host；不是对外 Fleet 网络入口。 |
| `electron/api/route-boundary.ts`、`electron/api/main-api-boundary.json` | Electron API route admission | 声明允许的 Remote Fleet readonly/mutation routes、capability operation 及精确 terminal WebSocket route；只控制 proxy admission。 |
| `electron/api/server.ts`、`electron/api/routes/runtime-host-proxy.ts` | Electron Host API → runtime-host forwarding adapter | `/api/*` 业务请求经 `RuntimeHostManager.request` 转发，upgrade 仅准许 `/api/remote-fleet/terminal/stream`；不拥有 Fleet aggregate。 |
| `runtime-host/api/routes/route-utils.ts` | delivery response sanitation utility | 只读 response 的递归字段剔除基础设施；不是完整的 audit/log/replay redaction proof。 |
| `runtime-host/api/routes/remote-fleet-routes.ts` | delivery/application route adapter | 将 Fleet HTTP operation 映射至 `remoteFleetService.invoke`，并净化 read response；不拥有 Fleet truth。 |
| `runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route.ts` | RuntimeAgent external ingress adapter | 对 RuntimeAgent 原始 HTTP ingress 执行 method/content-type/size/auth header 边界；独立于 renderer proxy chain。 |
| `runtime-host/composition/modules/remote-fleet-application-module.ts` | composition root / integration wiring | 装配 worker service、capability registry、secret/credential、bootstrap、terminal provider、lifecycle cleanup 和 routes；不是 Domain owner。 |
| `runtime-host/composition/runtime-host-module-registry.ts`、`runtime-host/composition/runtime-host-composition.ts`、`runtime-host/composition/runtime-host-server.ts` | composition/server assembly | 注册 `remote-fleet` 模块，把 Fleet facade/terminal manager 交给 HTTP server，并接入独立 ingress 与 terminal upgrade；不拥有 aggregate。 |
| `runtime-host/application/remote-fleet/**` | Fleet Domain + provider/worker Integration | `RemoteFleetRuntime` 协调内存状态、全量 snapshot、command/audit/lease/capability/session projection；worker client/entry 与 file store、credential vault、registry、RuntimeAgent、Docker/Kubernetes/SSH/bootstrap/terminal provider 形成执行边界。外部 provider 仍是 Integration。 |
| `runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts` | TeamRun → Fleet application adapter | 将 endpoint/capability/lease snapshot 适配给 `selectRemoteFleetEndpoint`，返回 primary/fallback/exclusion；只消费 Fleet data，不写 Fleet state、不 acquire lease。 |

### 活跃交付链、路由与 ingress

1. **renderer 主链。** `RemoteFleetPage` 及其 components → `useRemoteFleetStore`（仅 projection/action cache）→ `hostApiFetch` → preload `hostapi:*` IPC → Electron main `hostapi` proxy/allowlist → Electron Host API 的 runtime-host proxy → runtime-host route registry → `remoteFleetRoutes` → `WorkerBackedRemoteFleetService` → worker `lifecycleQueue` → `RemoteFleetRuntime` → file state snapshot、credential vault、capability registry，以及 RuntimeAgent、Docker/Kubernetes/SSH bootstrap 和 terminal integrations。页面收到的是 response projection；权威 mutation/状态归 `RemoteFleetRuntime` 及其持久化/外部边界，不能归 UI/store。
2. **普通 Fleet HTTP routes。** `remoteFleetRoutes` 的 active operation 为：`GET /api/remote-fleet/{snapshot,metrics,terminal/sessions,list-commands,list-audit-events}`；`POST /api/remote-fleet/{register-connection,delete-connection,register-environment,deploy-environment,delete-environment,register,write-credential,remove-node,probe,probe-connection,install-agent,revoke-agent,drain-endpoint,retire-endpoint,terminal/open,terminal/reconnect,terminal/close}`。Electron `route-boundary`/JSON 对应放行同一组 local Host API proxy route；这只是本地代理准入，不能据此描述公开网络暴露或业务 owner。
3. **capability 特例。** renderer 的 runtime `start`、`stop`、`sync` 走 `POST /api/capabilities/execute`（以及 capability list/describe），由 Remote Fleet capability operation route 再进入 Fleet port；它不在上列 `remoteFleetRoutes` operation array 内，不能遗漏或误写成同一个普通 route table。
4. **RuntimeAgent 独立 ingress。** `RuntimeAgent` → runtime-host raw HTTP server 的 `REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH` → `createRuntimeAgentIngressRouteHandler` → `remoteFleetService.invoke('ingestRuntimeAgentIngress', ...)` → worker → `RemoteFleetRuntime`。handler 静态限制 `POST`、`application/json`、最大 64 KiB；Bearer credential 会传入，enrollment header 只用于 heartbeat。它不经过 renderer → Electron Host API proxy 的业务入口。
5. **terminal WebSocket 支线。** terminal open/reconnect 先经普通 mutation route 取得短期 ticket 与 websocket path；renderer terminal hook 以该 path 建立 WebSocket，Electron 精确放行 `/api/remote-fleet/terminal/stream`，runtime-host server 交给 terminal manager/provider。ticket-bearing path、terminal input 和 output 是瞬态 I/O，绝不是 durable outbox、replay 或 audit payload。
6. **TeamRun 下游消费。** `selectTeamRunRemoteFleetEndpoint` 把 current endpoint/capability/lease snapshot 转换后调用 `selectRemoteFleetEndpoint`，仅返回 candidate/fallback/exclusion reason。它不 reservation、更不 acquire lease；`selection → acquire` 间仍需 Fleet actor/transaction 的原子边界，不能将 TeamRun selector 叙述为 Fleet owner。

### 安全边界：静态证据与未核验项

- **必须保持的资料分类。** credential、明文 secret、terminal ticket、terminal input/output、Authorization、idempotency material 不得进入 public snapshot、日志、audit、durable outbox 或 replay。该句是当前/迁移约束，不是由 UI 或单个 sanitizer 自动取得的已验证事实。
- **已有局部静态证据。** Fleet runtime 拒绝 public config/endpoint URL 中的危险明文 credential 形状；registration flow 将输入经 `writeCredential` 转换为 secret-ref，并清除表单 credential drafts；store 的 summary compacting 排除 secret/token/ticket/password/authorization/credential/API key/idempotency/stdout/stderr/log 等命名字段。read route 经过 `sanitizeReadOnlyRouteResponse`，route utility 有默认敏感字段拒绝集合；worker-client 的现有日志形状仅记录 request/operation/type/status/duration/pending 等最小字段。这些分别是特定 source/boundary 的证据。
- **仍未核验。** 上述局部证据不能证明 plaintext 不会抵达所有 request body、exception、audit、replay、provider、browser/devtools、proxy 或 log sink；也不能证明 terminal ticket-bearing URL、input/output 已从这些 sink 全部排除。RuntimeAgent ingress 的 credential header 与 raw body 也必须做 sink-by-sink 审计和运行时 redaction/fault oracle，不能仅凭 typed rejection response 推论端到端安全。

### 可靠性、并发与恢复边界

| 事项 | 当前静态证据 | 仍需 oracle/实现收敛 |
| --- | --- | --- |
| worker 单写与 HOL | worker entry 以一个 `lifecycleQueue` 串行 invoke 与 close；host RPC completion 不进入 aggregate mutation queue。被卡住的 host RPC 因而可形成 head-of-line blocking，阻塞后续 invoke/close。 | deadline、pending cap、取消、close 有界性和 worker 正常 exit 时所有 pending settlement。 |
| local state 与外部 effect | `RemoteFleetRuntime` 是全量 `writeState(toPersistedState())` snapshot；command dispatch、bootstrap、terminal 与 capability registry 是独立 host/provider effect。 | 没有 state+durable outbox 原子事务，就不能声称 Docker/Kubernetes/SSH/RuntimeAgent effect exactly-once；需故障注入验证 effect 前/后 crash、receipt、retry/reconcile。 |
| lease/routing | selector 读取 snapshot 后选择；TeamRun adapter 不 acquire。 | 必须把 `expire → select → acquire lease → persist command intent` 线性化到 Fleet actor/transaction，避免 selection/acquire TOCTOU。 |
| capability projection/recovery | load 后会执行 reconcile；stale/retired projection 可经 registry replace/prune。 | projection prune、恢复、外部 registry 收敛与崩溃窗口不是静态路径存在即可证明；需 crash/fault/real-provider oracle。 |
| secret write/recovery | pending credential write operation 有 status recovery path，snapshot 只应保留 ref/metadata。 | vault 写入、retry、日志/audit redaction 与 credential epoch/idempotence 仍需端到端验证。 |

### 未运行 tests evidence（仅 oracle 路径）

以下文件出现在当前 status 的直接 Remote Fleet 测试面；它们没有在本审计中执行，不能推导为通过、coverage 已闭环或真实 provider 已验证。

- **runtime、worker、state、routing/lease/reconcile：** `tests/unit/remote-fleet-runtime.test.ts`、`remote-fleet-runtime-launch.test.ts`、`remote-fleet-worker-client.test.ts`、`remote-fleet-worker-entry.test.ts`、`remote-fleet-store.test.ts`、`remote-fleet-routing-service.test.ts`、`remote-fleet-lease-manager.test.ts`、`remote-fleet-reconcile.test.ts`、`remote-fleet-residuals.test.ts`、`remote-fleet-metrics.test.ts`、`remote-fleet-ops-timeline.test.ts`、`remote-fleet-audit.test.ts`、`remote-fleet-command-queue.test.ts`、`remote-fleet-command-policy.test.ts`、`remote-fleet-command-dispatch.test.ts`。
- **RuntimeAgent、capability、secret、composition：** `tests/unit/remote-fleet-agent-client.test.ts`、`remote-fleet-agent-ingress.test.ts`、`remote-fleet-runtime-agent-ingress-route.test.ts`、`runtime-host-server-runtime-agent-ingress.test.ts`、`remote-fleet-runtime-agent-transport-dispatcher.test.ts`、`remote-fleet-capability-projection.test.ts`、`remote-fleet-capability-routes.test.ts`、`remote-fleet-secret-policy.test.ts`、`remote-fleet-secret-host-rpc.test.ts`、`remote-fleet-credential-store.test.ts`、`remote-fleet-composition-secret-resolver.test.ts`、`remote-fleet-export-surface.test.ts`、`remote-fleet-production-matrix.test.ts`、`remote-fleet-production-matrix-behavior.test.ts`。
- **provider、terminal、renderer、TeamRun：** `tests/unit/remote-fleet-bootstrap-dispatcher.test.ts`、`remote-fleet-bootstrap-docker-provider.test.ts`、`remote-fleet-bootstrap-k8s-provider.test.ts`、`remote-fleet-bootstrap-ssh-provider.test.ts`、`remote-fleet-connectors.test.ts`、`remote-fleet-log-stream.test.ts`、`remote-fleet-terminal-manager.test.ts`、`remote-fleet-terminal-custom-provider.test.ts`、`remote-fleet-terminal-docker-provider.test.ts`、`remote-fleet-terminal-k8s-provider.test.ts`、`remote-fleet-terminal-ssh-provider.test.ts`、`remote-fleet-page.test.tsx`、`remote-fleet-team-endpoint-selector-adapter.test.ts`。
- **外部与 Host API 边界：** `tests/integration/remote-fleet-docker.integration.test.ts`（仅当 `MATCHACLAW_REMOTE_FLEET_DOCKER_E2E=1` 才启用）以及 `tests/unit/main-api-boundary.test.ts`、`hostapi-proxy-ipc.test.ts`、`host-api-server-boundary.test.ts`、`runtime-host-implementation-boundary.test.ts`。Docker integration 的存在尤其不代表本次已联通 Docker 或验证 terminal。

## 未读/排除、静态限制与源码修改确认

- **未读：0。** inventory 第 12 分片的 93 个现存 `.ts` 均逐文件全文读取；与实际磁盘枚举无差异。
- **本分片排除：** `runtime-host/build/**` 编译产物、依赖目录、测试输出、其它 inventory 分片、非 `.ts` 配置/数据，理由与 `00-inventory.md` 的全局排除一致；它们不计入本分片的 93 个 source files。
- **静态审计限制：** 未运行测试、基准、真实 Docker/K8s/SSH/OpenClaw/RuntimeAgent、故障注入或跨进程压力；所有标为待验证的外部保证必须由目标实现的 differential、fault 与 benchmark oracle 闭环。
- **未改源码确认：** 本审计未修改任何 `runtime-host` 源码、测试、README、inventory、配置或锁文件；本次唯一允许写入的文件是本文档。

### status 增量的精确约束补证

- **持久化与 single-writer 假设：** worker 注入的 `FileRemoteFleetStateStore` 将 `${runtimeDataRootDir}/remote-fleet/state.json` 先写同目录临时文件、再 rename；单 worker 内的 `lifecycleQueue` 使 invoke/close 串行。它不是跨 runtime-host/跨进程 lock、CAS 或 multi-writer merge 协议；若多个 writer 指向同一 root 的 last-writer-wins 风险只能标为**待并发复现**，不能称已证明缺陷。
- **命令与 lease 的实际边界：** command queue 有 `idempotencyKey` 去重、queued/running timeout 与终态迁移规则，但 `RemoteFleetRuntime.queueCommand()` 为每次操作生成新 command id/key；不应由 helper 存在推导 API retry 的端到端去重。route selection 会以 `maxActiveLeases` 排除候选，而当前 start/terminal 的 lease acquire 路径没有由该 selector 自动完成 capacity admission；selector 结果不是 reservation，必须由 future Fleet actor/transaction把 admission、acquire 和 intent commit线性化。
- **RuntimeAgent protocol 的可达集合：** ingress 接受 heartbeat、command progress、command result；Remote Fleet 主动 accept/capability-sync/runtime-lifecycle 等反向类型在此 ingress 不是可接受上行类型。可选 `MATCHACLAW_REMOTE_FLEET_AGENT_INGRESS_URL` 只能是无 username/password/query/fragment、path精确等于 ingress path 的 HTTPS URL；未配置时非-container 安装/部署会被 runtime 拒绝。它们均是当前 TS protocol policy，不应被泛化为所有 future RuntimeAgent transport 的共同语义。
- **terminal 的局部可证明机制：** terminal ticket 是随机值的 hash-only、单次、短 TTL 内存授权（路径含 `sessionId`/`ticket` query）；实际 WebSocket 授权门槛是该 ticket，而 Electron upgrade branch 不重复执行普通 Host API bearer 校验。terminal manager 对控制 frame、binary/provider frame设置各自上限并以高低水位 pause/resume 或关闭慢 consumer；active provider handle/session不属于 Fleet persisted state。上述机制是局部协议事实，不证明 query-bearing ticket不进入所有 access log/devtools sink，也不证明所有 provider 都实现 pause/resume。
- **current oracle：** `remote-fleet-runtime-agent-ingress-route.test.ts`、`runtime-host-server-runtime-agent-ingress.test.ts`、`remote-fleet-terminal-manager.test.ts`、`remote-fleet-worker-entry.test.ts`、`remote-fleet-command-queue.test.ts`、`remote-fleet-runtime.test.ts`、`remote-fleet-reconcile.test.ts` 以及 Docker integration 只是审阅到的测试/fixture source；本次未执行，不能将上述实现细节表述为真实压力、恢复或外部 provider 验证通过。
