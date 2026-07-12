# 05 — Platform Runtime、Gateway 与 Runtime Host 文件级 TS → Rust 迁移审计

> **静态审计状态：完成（当前主工作树快照）。** 本报告是旧 TypeScript 的文件级事实与迁移证据，不是 Rust 实施批准，也不声称外部 Gateway/Runtime 已提供可靠投递、exactly-once、持久 replay 或取消确认。
>
> **方法与范围：** 先按仓库 `.codegraph` 追踪 platform identity/endpoint/execution、Gateway readiness/control，以及 Runtime Host service/composition/route 边界；后以 Python 在当前主工作树递归枚举并逐一 `Path.read_text(encoding='utf-8')` 完整读取。`00-inventory.md` 的 05 分片预期 **31** 个；当前目录名实际为 `application/platform-runtime/**`（而非用户描述中的 `application/platform/**`），枚举结果为 gateway 4 + platform-runtime 17 + runtime-host 10 = **31**，与 inventory 完全一致。
>
> **边界判断：** Matcha Platform Core 只能拥有共同 identity/capability/execution/receipt/correlation grammar；Foundation Kernel 只能拥有任务监管、存储、secret/redaction 与进程/机制原语；Gateway/OpenClaw 专有 API、readiness、plugin/driver 适配归 Runtime Integration；路由/facade/Delivery 不是事实源。Platform 工具/插件目录的具体业务状态不可被误升格为全平台 Core。

## 已读文件（31/31）

```text
runtime-host/application/gateway/gateway-capability-service.ts
runtime-host/application/gateway/gateway-readiness.ts
runtime-host/application/gateway/gateway-runtime-port.ts
runtime-host/application/gateway/service.ts
runtime-host/application/platform-runtime/audit-sink.ts
runtime-host/application/platform-runtime/context-assembler.ts
runtime-host/application/platform-runtime/index.ts
runtime-host/application/platform-runtime/local-event-bus.ts
runtime-host/application/platform-runtime/platform-jobs.ts
runtime-host/application/platform-runtime/platform-runtime-port.ts
runtime-host/application/platform-runtime/policy-engine.ts
runtime-host/application/platform-runtime/run-session-service.ts
runtime-host/application/platform-runtime/runtime-manager-service.ts
runtime-host/application/platform-runtime/service.ts
runtime-host/application/platform-runtime/state/gateway-plugin-state-ledger.ts
runtime-host/application/platform-runtime/state/local-plugin-state-ledger.ts
runtime-host/application/platform-runtime/state/tool-registry-store.ts
runtime-host/application/platform-runtime/state/tool-registry-view-ledger.ts
runtime-host/application/platform-runtime/tool-catalog-service.ts
runtime-host/application/platform-runtime/tool-executor.ts
runtime-host/application/platform-runtime/tool-reconciler.ts
runtime-host/application/runtime-host/bootstrap-jobs.ts
runtime-host/application/runtime-host/bootstrap.ts
runtime-host/application/runtime-host/parent-shell-port.ts
runtime-host/application/runtime-host/prelaunch-maintenance-cache.ts
runtime-host/application/runtime-host/prelaunch-plugin-maintenance.ts
runtime-host/application/runtime-host/runtime-jobs-service.ts
runtime-host/application/runtime-host/runtime-long-task-service.ts
runtime-host/application/runtime-host/runtime-state.ts
runtime-host/application/runtime-host/runtime-task-ports.ts
runtime-host/application/runtime-host/service.ts
```

---

### runtime-host/application/gateway/gateway-capability-service.ts

- **当前 owner：** Gateway 专有 plugin-method availability guard，属 Runtime Integration；不拥有 plugin/catalog 或任务事实。
- **职责与关键 symbols：** `TASK_MANAGER_GATEWAY_PLUGIN`、`SUBAGENT_GATEWAY_PLUGIN` 声明允许方法；`GatewayCapabilityService.requirePluginMethod` 先白名单断言，再读单方法 readiness。
- **旧语义与策略：** 定义未含方法立即抛错；ready 返回 `null`；未 ready 返回 `unavailable`、固定 `PLUGIN_CAPABILITY_UNAVAILABLE`、Gateway 报告的 missing methods；timeout 完全下传。无 retry、无本地 status cache、unknown 只经 port 传递。
- **状态、存储与副作用：** 无自身状态；一次 Gateway readiness RPC/网络副作用。
- **并发与性能特征：** O(白名单长度) includes + 一次远端 probe；并发调用不合并，不推定远端结果稳定。
- **调用/依赖边界：** subagent/task capability 与 module registry 调用；依赖 `GatewayConnectionPort.inspectGatewayMethodReadiness`，不直接控制 Gateway。
- **故障、恢复与安全：** Gateway 异常传播；失败消息披露 plugin ID/method 缺失但不处理 token；没有恢复。
- **迁移分类：** Preserve：白名单拒绝、null/503 分流和错误 code。Intentional Improvement：可在 Runtime Integration 以短生命周期 capability snapshot coalescing 降低重复 probe，须保持每请求 timeout 与 stale 语义。待验证：调用者是否把 `null` 以外一律映射为 HTTP 503。
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** `GatewayPluginCapability` 使用 typed `PluginId/MethodName`、借用/不可变 capability snapshot；只消除重复探测成本，指标为 probe 数、readiness p95、stale window；不转移 Gateway plugin 事实。
- **验证 oracle：** `tests/unit/runtime-host-subagent-routes.test.ts`；白名单/ready/missing/timeout/Gateway-error differential fixture。
- **证据：** 本文件；`gateway-runtime-port.ts`；CodeGraph `GatewayCapabilityService` callers。

### runtime-host/application/gateway/gateway-readiness.ts

- **当前 owner：** Gateway connection-state 的窄判定与启动错误字符串分类 helper，属 Runtime Integration。
- **职责与关键 symbols：** `isGatewayReadyForSnapshot` 默认 250ms，要求 `state==='connected' && gatewayReady===true`；`isGatewayStartupConnectionError` 匹配五种小写错误片段。
- **旧语义与策略：** 非 record、timeout/任何 rejection 均返回 false；只接受严格双条件，无 retry；错误分类把非 `Error` 强转字符串，unknown 不抛。
- **状态、存储与副作用：** 无本地状态；只读 Gateway state 的网络/I-O。
- **并发与性能特征：** 每次一次 probe，O(1) 本地判断；无缓存/去重，快照刷新频率决定远端压力。
- **调用/依赖边界：** Skill runtime 与 runtime job snapshot 调用；具体 connection client 在 openclaw bridge/Runtime Integration 分片。
- **故障、恢复与安全：** 设计上故障降级为 not-ready，可能掩盖诊断根因；字符串分类脆弱且不接触 secret。
- **迁移分类：** Preserve：250ms 默认、严格 connected+ready、probe failure=false。Intentional Improvement：用结构化 transport error code 替代 substring；兼容影响需让旧文本分类作为 versioned fallback。Defect：无已由代码证明。待验证：250ms 是否足以覆盖所有 snapshot caller 的截止时间。
- **未来 Rust owner：** Runtime Integration；共享 deadline primitive 属 Foundation Kernel。
- **Rust 重写与性能判断：** typed connection snapshot + bounded deadline；测 readiness false-positive/false-negative、probe p95 和并发 probe 数，TS/Rust 状态矩阵差分。
- **验证 oracle：** Gateway readiness/skill-runtime tests，连接拒绝、hang-up、非 record、超时 fault injection。
- **证据：** 本文件；`gateway-runtime-port.ts`；CodeGraph `GatewayReadinessPort` callers。

### runtime-host/application/gateway/gateway-runtime-port.ts

- **当前 owner：** Gateway 专有 transport/control/channel/cron/security contract；是 Runtime Integration 边界，不是 Platform Core 的通用 runtime grammar。
- **职责与关键 symbols：** 连接/health/diagnostics/capability/readiness DTO；`DEFAULT_GATEWAY_BASE_METHODS`；`normalizeGatewayMethods` 去非字符串、trim、去重且保留首次顺序；`inspectGatewayMethods` 计算缺失集合；各 Gateway port interface。
- **旧语义与策略：** readiness phase 仅 ready/starting/unavailable；required method 空数组经 helper 可得到 ready；capability null 代表未知/不可读并使非空需求 missing；timeout 由各 port 可选参数承接，无重试和持久 status。
- **状态、存储与副作用：** 合同/纯 helper 无状态；实现方可网络、socket、重连、Gateway 变更。
- **并发与性能特征：** method normalize/inspect 为 O(n+m) 临时 Set；没有定义 RPC 背压、调用线性化或 snapshot 一致性。
- **调用/依赖边界：** readiness workflow、Gateway/agent/security/channel/cron capability 与 OpenClaw bridge 实现共同依赖；不能由 Delivery 作为事实源。
- **故障、恢复与安全：** `details?: unknown`、lastError、issue 可含未净化 runtime 数据；contract 不承诺 Gateway 对 abort/recover/RPC 的可靠性或 idempotency。
- **迁移分类：** Preserve：方法 normalization、base-method literals、readiness/diagnostic wire shape。Intentional Improvement：将 public diagnostics 与 private/redacted transport detail 分开，且明确 deadline/cancel receipt；兼容需版本化。待验证：method capabilities 的版本/TTL 与 Gateway 实际语义。
- **未来 Rust owner：** Runtime Integration；仅若跨 runtime 公共化 execution/receipt identity 才抽入 Matcha Platform Core。
- **Rust 重写与性能判断：** `GatewayControlReadiness`/method enums 或 validated strings、immutable capability snapshot；不把 OpenClaw RPC 拆入 Core。指标是 snapshot alloc、method-set comparison、redaction leak；oracle 是 DTO/normalization golden 与 Gateway mock faults。
- **验证 oracle：** `tests/unit/runtime-host-gateway-ready.test.ts`、process Gateway route/heartbeat tests；method whitespace/duplicate/null corpus。
- **证据：** 本文件；Gateway readiness workflow；OpenClaw bridge capability/client source。

### runtime-host/application/gateway/service.ts

- **当前 owner：** Delivery-facing facade；不拥有 Gateway state、readiness 策略或控制连接。
- **职责与关键 symbols：** `GatewayService` 逐项代理 workflow 的 `status/recover/ready/approvePendingControlUiPairingRequests`。
- **旧语义与策略：** 无默认、校验、retry、错误映射、缓存或幂等逻辑；保留下游 Promise/response。
- **状态、存储与副作用：** 无；副作用全在 `GatewayReadinessWorkflow`/Gateway port。
- **并发与性能特征：** O(1) 转发；不序列化调用。
- **调用/依赖边界：** route/module/token 使用；仅依赖 workflow，保持 Delivery→application 单向。
- **故障、恢复与安全：** 下游错误原样传播；不接触 secret。
- **迁移分类：** Preserve：薄 facade。Intentional Improvement：无；Rust 不应复制为事实 owner。待验证：route HTTP 错误映射。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 一个 command/query handler，调用 Runtime Integration service；无性能重写依据。
- **验证 oracle：** `runtime-host-gateway-ready`、Gateway route integration 的 forwarding spy。
- **证据：** 本文件；`workflows/gateway-readiness/gateway-readiness-workflow.ts`；CodeGraph callers。

### runtime-host/application/platform-runtime/audit-sink.ts

- **当前 owner：** 进程内 audit event 收集机制；实际是测试/临时 observation store，不是可靠审计事实源。
- **职责与关键 symbols：** `InMemoryAuditSink.append` append array；`snapshot` 浅复制数组。
- **旧语义与策略：** append 永远 resolve；event payload 不 clone，调用者若后续突变对象会改写保留引用；无 retention、idempotency、timestamp 验证、retry 或 status。
- **状态、存储与副作用：** 私有内存 `AuditEvent[]`；进程结束丢失。
- **并发与性能特征：** append O(1)，snapshot O(n) 浅复制；单线程中无锁，但 async caller interleave 保持调用完成顺序而非业务因果顺序。
- **调用/依赖边界：** platform run/tool workflows 写；composition 可注入；不是 route/Delivery 事实。
- **故障、恢复与安全：** 无失败路径、durability、redaction 或访问控制；payload 可含敏感 metadata。
- **迁移分类：** Preserve：当前进程内 best-effort ordering。Intentional Improvement：若审计是产品需求，应由 Foundation Kernel 追加式、redacted durable audit port 承担；兼容影响是 crash 后可读性变化。Defect：作为可靠审计使用将丢失/可变，但当前代码未证明承诺可靠审计。
- **未来 Rust owner：** Foundation Kernel（通用 append/redaction/storage）；平台 domain 只发布事实。
- **Rust 重写与性能判断：** bounded channel→append-only store/cursor，事件 envelope deep copy/serialize；指标为 append latency、drop/backpressure、crash recovery、secret leak；oracle 为 fault/crash tests 与 immutable payload differential。
- **验证 oracle：** platform workflow event fixtures；新增 mutation-after-append、capacity、persistence/crash tests。
- **证据：** 本文件；`platform-run-session-workflow.ts`、`platform-native-tool-workflow.ts`。

### runtime-host/application/platform-runtime/context-assembler.ts

- **当前 owner：** platform-run 的 context assembly policy；工具选择属该平台 runtime domain，不是 Core identity/execution grammar。
- **职责与关键 symbols：** `ContextAssembler.assemble` 读取 effective enabled tools，若配置 policy 则并行 `authorizeTool`，`filterAllowedTools` 排除 deny；补 system prompt/resource bindings/credentials 默认。
- **旧语义与策略：** systemPrompt 默认空字符串、bindings 默认空数组、credentials 默认模块级 `{}`；无 policy 时全部 effective tools 通过；有 policy 时任一 authorize rejection 令整个 assemble reject；仅 `allow:false` 排除，unknown `allow` 视为允许；requested tool ID 的过滤由 registry 负责。
- **状态、存储与副作用：** 无自身存储；读取 registry，可能调用多项 policy I-O；返回的 request arrays/object 直接引用输入或 registry values。
- **并发与性能特征：** `Promise.all` 对所有工具无界并发，O(n) decisions/Set；大工具集会对 policy backend 突发请求。
- **调用/依赖边界：** run workflow → runtime driver；依赖 ToolRegistry/Policy ports；credentials 可含 token，禁止把它写入 audit/event/public receipt。
- **故障、恢复与安全：** policy 未注入等于 allow-all；没有 policy timeout/retry/redaction；credential object 传播到 driver。
- **迁移分类：** Preserve：默认值、deny-only filter、policy absent allow-all。Intentional Improvement：Foundation deadline/bounded concurrency + secret handle，不改变 policy decisions；未知 authorization 应先定义而非擅改。待验证：policy absence 是否在生产 composition 中允许。
- **未来 Rust owner：** Domain Module（platform tool/run context）；secret transport与并发机制为 Foundation Kernel。
- **Rust 重写与性能判断：** `RunContext` 仅带 secret handles，`FuturesUnordered` 限流 policy checks；保持 tool ordering；指标为 policy fan-out、assemble p95、credential exposure；oracle 为 input/tool/policy decision matrix 和 timeout fault tests。
- **验证 oracle：** ToolRegistry/Policy 输入矩阵：systemPrompt/bindings/credentials 默认值、无 policy allow-all 与仅 `allow:false` 的 deny-only 过滤、任一 policy rejection 整体失败、registry tool 顺序保持；待补 policy timeout 与有界 fan-out fault tests。
- **证据：** 本文件；`platform-run-session-workflow.ts`；`ToolRegistryStore`、`PolicyEngine`。

### runtime-host/application/platform-runtime/index.ts

- **当前 owner：** platform-runtime public import/re-export surface；无领域状态。
- **职责与关键 symbols：** 重导出 context, ledger, policy, run/manager/catalog/reconciler/store 和 shared types/facade。
- **旧语义与策略：** 无默认、执行、timeout、unknown、retry 或 status；路径稳定性是唯一可观察语义。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** import-time re-export，无运行时算法。
- **调用/依赖边界：** composition module 使用；不应作为 Core registry 或 Delivery route。
- **故障、恢复与安全：** 破坏 export 名称会造成 build/API import 失败；无 secret。
- **迁移分类：** Preserve：public symbol grouping（若仍有 TS consumers）。待验证：这是内部 barrel 还是外部 package surface。
- **未来 Rust owner：** 无独立 owner；Rust crate/module exports 随各真实 owner 分拆。
- **Rust 重写与性能判断：** 不做翻译性 facade；按 Domain/Runtime Integration/Foundation crate 的真实 API 重导出。
- **验证 oracle：** TypeScript compilation/import consumer scan；Rust compile-time API tests。
- **证据：** 本文件；`composition/modules/platform-runtime-module.ts`。

### runtime-host/application/platform-runtime/local-event-bus.ts

- **当前 owner：** 进程内 best-effort event fan-out mechanism；不是 durable platform event log。
- **职责与关键 symbols：** `LocalEventBus.publish` 同步 `EventEmitter.emit` 后 async resolve；`subscribe` 返回 off closure。
- **旧语义与策略：** listener 按 Node EventEmitter 注册顺序同步运行；listener 抛错会使 publish reject；无 listener 时成功；无 retry、ack、replay、retention、subscriber exception isolation 或 typed topic。
- **状态、存储与副作用：** EventEmitter listener registry、同步 callback side effect；无持久化。
- **并发与性能特征：** publish O(listener count)，慢 listener 阻塞所有后续 listener/调用完成；默认 EventEmitter listener warning threshold 可能出现；无背压。
- **调用/依赖边界：** run workflow 发布 started/aborted；订阅者在 composition/runtime 内；不作为 Delivery 事实源。
- **故障、恢复与安全：** process restart丢事件；payload 引用共享且无 redaction；外部 runtime receipt 不可由 publish 成功推断。
- **迁移分类：** Preserve：本地同步、best-effort fanout。Intentional Improvement：Foundation bounded broadcast with explicit overflow/isolated subscriber policy；需保持 event ordering contract或明确版本化。Defect：无可靠性承诺的证据。待验证：是否存在异步/throwing subscriber。
- **未来 Rust owner：** Foundation Kernel 的通用 event mechanism；平台 domain 拥有事件事实语义。
- **Rust 重写与性能判断：** bounded broadcast/watch channel 或 append cursor；消除慢 listener阻塞，指标为 fanout p95、lag/drop、subscriber panic isolation；oracle 是 listener order/throw/late subscribe fault matrix。
- **验证 oracle：** Platform run tests；新增 no-listener、throwing listener、slow subscriber、restart no-replay tests。
- **证据：** 本文件；`platform-run-session-workflow.ts`。

### runtime-host/application/platform-runtime/platform-jobs.ts

- **当前 owner：** platform native-tool job submission mapping；任务 queue mechanism 不在此文件。
- **职责与关键 symbols：** two job IDs；`createPlatformJobPort` 将 install source 提交为 `platform.installNativeTool`，dedupe key 为 JSON source；reconcile 使用固定 key。
- **旧语义与策略：** install 指定 queue 未设置，取底层默认；source JSON key 受对象属性插入顺序影响且 `JSON.stringify` 可能抛/忽略 undefined；相同 reconcile 去重；返回成功 job snapshot，不执行工作、无 retry/status 本地逻辑。
- **状态、存储与副作用：** 无；将 payload/queue options 交 Foundation queue。
- **并发与性能特征：** stringify O(source size)；dedupe correctness取决于 queue，语义相同而不同 key 顺序会重复提交。
- **调用/依赖边界：** operations workflow submit；`RuntimeLongTaskSubmissionPort` 提供 queue；执行在 platform workflows。
- **故障、恢复与安全：** source 可能含 metadata/secret，被用作 key 与 queue payload，当前未 redaction；queue 的 persistence/retry 未由本文件证明。
- **迁移分类：** Preserve：job literals、reconcile single dedupe key、accepted-before-execute。Intentional Improvement：canonical/redacted source fingerprint 与 typed idempotency key；兼容影响为等价 source 合并，须以 queue traces 验证。Defect：JSON key 的属性顺序/不可序列化风险可由代码证明，但是否会发生待验证。
- **未来 Rust owner：** Domain Module 定义 platform job types；Foundation Kernel 拥有 enqueue/dedupe/queue storage。
- **Rust 重写与性能判断：** canonical serialized `ToolSource` hash（不含 secret）+ durable job receipt；测 dedupe hit/miss、enqueue latency、crash recovery；oracle 为 equivalent source ordering and job submission differential。
- **验证 oracle：** operations job definitions/route tests；JSON key permutation、duplicate reconcile、queue rejection fault tests。
- **证据：** 本文件；`platform-runtime-operations-workflow.ts`；`runtime-task-ports.ts`。

### runtime-host/application/platform-runtime/platform-runtime-port.ts

- **当前 owner：** platform runtime facade contract；含 run/tool domain API，不是全 runtime/endpoint Core contract。
- **职责与关键 symbols：** `RuntimeHostPlatformFacade` 声明 health、native tool install/reconcile、run start/abort、tool list/mutation/execute。
- **旧语义与策略：** 类型层不指定 default、idempotency、timeout、receipt、unknown 或 retry；`eventTx?: unknown` 是未建模的 transport/event injection。
- **状态、存储与副作用：** 无；实现可调用 driver、tool registry、queue/network。
- **并发与性能特征：** 无实现；没有 backpressure/cancellation guarantee。
- **调用/依赖边界：** platform workflows/facade composition；driver 是 Runtime Integration，Tool catalog 为 Domain Module；Core 仅可共享 `RunId`/receipt grammar。
- **故障、恢复与安全：** credentials/eventTx 的安全归实现；contract 不承诺 abort 已被外部 runtime 接收。
- **迁移分类：** Preserve：接口能力边界。Intentional Improvement：将 start/abort 转为 typed execution command/receipt，deadline/cancel outcome 显式化；需版本协商。待验证：eventTx 的真实类型/安全边界。
- **未来 Rust owner：** Domain Module（tool/run operations）+ Matcha Platform Core（仅 RunId/receipt correlation）；Runtime Integration 实作 driver bridge。
- **Rust 重写与性能判断：** async trait，opaque `EventTx` 改 capability-limited sink，避免 `unknown` 透传；oracle 为 command/result contract and abort timeout faults。
- **验证 oracle：** platform route/workflow integration、driver mock compile/contract tests。
- **证据：** 本文件；`platform-runtime-operations-workflow.ts`、platform composition。

### runtime-host/application/platform-runtime/policy-engine.ts

- **当前 owner：** 可配置 blocked-tool policy 的内存 implementation；实际 policy source/authorization domain不在此。
- **职责与关键 symbols：** `PolicyEngine.blockedToolIds`；`authorizeTool` 返回 deny reason `tool_blocked:<id>` 或 allow。
- **旧语义与策略：** 仅 tool ID 精确 Set membership；忽略 action/session/metadata；默认 allow；无 mutation API、expiry、timeout、retry、status 或 audit。
- **状态、存储与副作用：** constructor 注入的内存 Set；无 I-O/persistence。
- **并发与性能特征：** O(1) membership；外部持有 Set 可在运行时突变，读取无同步。
- **调用/依赖边界：** `ContextAssembler` 可选依赖；不应承担 Gateway/RBAC/security policy 事实。
- **故障、恢复与安全：** deny reason泄露 tool ID；进程重启重置；空/unknown ID只按 Set 匹配后默认允许。
- **迁移分类：** Preserve：blocked Set/default allow。Intentional Improvement：将真正授权决策交专属 Security/Policy Domain，platform 只调用 port；若保留本实现，用 immutable snapshot。待验证：此类是否仅测试 fixture。
- **未来 Rust owner：** Domain Module（专属 policy/security domain）；Foundation 可提供 immutable config storage，不归 Platform Core。
- **Rust 重写与性能判断：** `HashSet<ToolId>` immutable `Arc` snapshot；指标为 policy decision latency/config swap；oracle 为 blocked/unblocked/action/session matrix。
- **验证 oracle：** ContextAssembler fixtures；新增 unknown tool、mutated config/restart tests。
- **证据：** 本文件；`context-assembler.ts`；composition platform module。

### runtime-host/application/platform-runtime/run-session-service.ts

- **当前 owner：** platform run workflow 的 facade；不拥有 run state、receipt或外部 execution。
- **职责与关键 symbols：** `RunSessionService.start/abort` 代理 `PlatformRunSessionWorkflow`。
- **旧语义与策略：** 无 validation/default/retry/timeout/idempotency；start 返回下游 run ID，abort 完成即 resolve。
- **状态、存储与副作用：** 无；workflow 会 assemble、driver execute/abort、event/audit。
- **并发与性能特征：** O(1) delegation；不对同 run serialize。
- **调用/依赖边界：** facade composition 使用；下游 workflow/driver 不是 Delivery route事实。
- **故障、恢复与安全：** 异常传播；`eventTx unknown` 未检查；abort 不代表外部 runtime 可靠取消。
- **迁移分类：** Preserve：薄代理。Intentional Improvement：无；不要创建重复 Rust service 层。待验证：调用者是否需要 start accepted 与 completed 的不同 receipt。
- **未来 Rust owner：** Delivery/application facade；共同 run correlation归 Matcha Platform Core。
- **Rust 重写与性能判断：** thin handler into Domain command service；无独立性能优化。
- **验证 oracle：** platform run workflow mock forwarding，start/abort success/error differential。
- **证据：** 本文件；`platform-run-session-workflow.ts`；CodeGraph `RunSessionService` callers。

### runtime-host/application/platform-runtime/runtime-manager-service.ts

- **当前 owner：** runtime driver health 和 native tool workflow facade；driver protocol为 Runtime Integration，tool state 为 platform domain。
- **职责与关键 symbols：** `runtimeHealth` 调 driver；install/reconcile 代理 native-tool workflow。
- **旧语义与策略：** health不转换 status；install/reconcile无 defaults/retry/timeout/idempotency；错误传播。
- **状态、存储与副作用：** 无自有状态；driver 可网络/process，workflow 更新 registry/audit。
- **并发与性能特征：** O(1) facade；不合并 health/read 或 tool operations。
- **调用/依赖边界：** platform root facade 组合；依赖 `AgentRuntimeDriver` 与 workflow，避免 Delivery 直接依赖 driver。
- **故障、恢复与安全：** 所有 driver failure裸传播；health detail可能含敏感 runtime information，未净化。
- **迁移分类：** Preserve：delegation。Intentional Improvement：把 driver diagnostics 分私有/public view；必须保持 status mapping。待验证：driver health concurrent safety。
- **未来 Rust owner：** Runtime Integration（driver）+ Domain Module（tool workflow）；本 facade归 Delivery/application。
- **Rust 重写与性能判断：** 不独立翻译；typed health view 和 redacted diagnostic port。指标为 health latency、tool operation receipt；oracle 为 driver mock response/error tests。
- **验证 oracle：** platform routes/workflows；health/install/reconcile forwarding fixture。
- **证据：** 本文件；`platform-native-tool-workflow.ts`；platform composition。

### runtime-host/application/platform-runtime/service.ts

- **当前 owner：** route/capability-facing PlatformService facade；Delivery-adjacent application layer，不拥有 tools/runs/jobs。
- **职责与关键 symbols：** 11 个 methods 将 unknown payload/URL/ToolSource 转交 `PlatformRuntimeOperationsWorkflow`。
- **旧语义与策略：** 无本地解释；`reconcileTools` 不额外 await，其他方法通常 await；所有 validation/default/accepted job response在 workflow；无 retry/cache/idempotency。
- **状态、存储与副作用：** 无；workflow 可能 enqueue job、调用 driver、mutate registry。
- **并发与性能特征：** O(1) 转发；并发和 queue backpressure由下游决定。
- **调用/依赖边界：** platform capability/operations route/composition 调用；下游 workflow是实际 application policy；route不为事实源。
- **故障、恢复与安全：** 错误传播；unknown payload未在本层解码；不接触 credentials。
- **迁移分类：** Preserve：method-to-operation mapping。Intentional Improvement：不需要独立 Rust owner；将 input decode留在 Delivery，domain command typed化。待验证：`reconcileTools` return type的 HTTP serialization。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 直接 command/query handlers调用 Domain service；不增加第二 facade。指标仅 handler overhead；oracle 为 platform route request/response differential。
- **验证 oracle：** `tests/unit/runtime-host-process-platform-routes.test.ts`；workflow spy/invalid payload tests。
- **证据：** 本文件；`platform-runtime-operations-workflow.ts`；CodeGraph callers。

### runtime-host/application/platform-runtime/state/gateway-plugin-state-ledger.ts

- **当前 owner：** gateway/native tool discovery 的进程内 snapshot ledger；不是真正 Gateway plugin source of truth。
- **职责与关键 symbols：** `setAll` clear+以 `source:'native'` 重建 Map；`list` 返回 values array。
- **旧语义与策略：** 同 ID最后一个输入获胜；每次 `setAll` 全量替换；只复制 top-level object，metadata共享；无 enabled/default/unknown校验、无 retry/status。
- **状态、存储与副作用：** `Map<ToolId, ToolDefinition>` 内存；重启丢失。
- **并发与性能特征：** setAll O(n)并存在 clear→populate 中间态；JS 无 await于循环内，所以单 call同步，但跨 async reader仅在调用边界观察。list O(n)。
- **调用/依赖边界：** ToolStateWorkflow 从 driver `listInstalledTools`刷新；ToolReconciler读取；driver/Gateway 仍是事实来源。
- **故障、恢复与安全：** malformed/duplicate input未防护；metadata可能含敏感数据；无 atomic snapshot对外保证。
- **迁移分类：** Preserve：native source overwrite、last-ID-wins、full refresh。Intentional Improvement：immutable snapshot swap并提供 revision，消除 clear window；兼容影响仅移除不可观察中间状态。待验证：duplicate ID是否 runtime 合法。
- **未来 Rust owner：** Domain Module 的 platform tool projection；Runtime Integration 负责 driver fetch。
- **Rust 重写与性能判断：** `Arc<HashMap<ToolId, ToolDefinition>>` atomic replacement；指标为 refresh alloc/read contention/snapshot consistency；oracle 为 duplicate/order/full replacement differential。
- **验证 oracle：** Platform tool-state/reconciler tests；concurrent read-during-refresh fault test。
- **证据：** 本文件；`platform-tool-state-workflow.ts`、`tool-reconciler.ts`。

### runtime-host/application/platform-runtime/state/local-plugin-state-ledger.ts

- **当前 owner：** local/platform tool projection ledger；不是 persistent tool catalog。
- **职责与关键 symbols：** `setAll` full replace、`upsert` single set、`list` values；强制 `source:'platform'`。
- **旧语义与策略：** input same ID last wins；`upsert`不合并旧字段；top-level clone；无 enable filter/retry/validation/status。
- **状态、存储与副作用：** 内存 Map、重启清空；无外部 I-O。
- **并发与性能特征：** setAll O(n)、upsert O(1)、list O(n)；没有 locking/snapshot version。
- **调用/依赖边界：** ToolStateWorkflow 在 platform registry snapshot 后 setAll；ToolReconciler读取；ToolRegistryStore承载 effective view。
- **故障、恢复与安全：** metadata引用/unknown未防护，无法恢复；无 access control。
- **迁移分类：** Preserve：platform source normalization、full/single replace。Intentional Improvement：immutable revisioned projection，避免读者看到变更间隙。待验证：ledger 与 registry 同步失败时哪个应优先。
- **未来 Rust owner：** Domain Module（platform tool catalog projection）。
- **Rust 重写与性能判断：** revisioned `HashMap` snapshot；测 upsert/read p95、reconcile consistency；oracle 为 setAll/upsert/duplicate differential。
- **验证 oracle：** tool-state workflow tests；registry/ledger divergence fault tests。
- **证据：** 本文件；`platform-tool-state-workflow.ts`、`tool-reconciler.ts`。

### runtime-host/application/platform-runtime/state/tool-registry-store.ts

- **当前 owner：** effective native/platform tool registry 的进程内 projection store；不是 Gateway 或 native driver事实源。
- **职责与关键 symbols：** two maps；`upsertNative/upsertPlatform`只增加/覆盖不删除；`setEnabled`同时更新两个同 ID；`listEffective` native在前、platform在后拼接后 filter；`filterWithQuery`默认排 `enabled:false`、requested IDs Set filter。
- **旧语义与策略：** source 强制；unknown ID `setEnabled` 静默 no-op；有跨 source同 ID时 list保留两项且 toggle都改；全量 driver refresh并不删除已消失 native record，除非别处重建实例；requested空数组等价无筛选。
- **状态、存储与副作用：** 两个内存 Map；async API无实际 await/I-O；重启丢失。
- **并发与性能特征：** upsert O(n)、toggle O(1)、effective list O(N)+filter；每 query新建 merged array/Set，无锁和分页。
- **调用/依赖边界：** ContextAssembler/ToolCatalog/ToolState/NativeToolWorkflow 与 platform facade；driver/native reality在 Runtime Integration。
- **故障、恢复与安全：** 不验证 definitions、metadata浅拷贝且可含 secret；stale entries与 duplicate IDs 可误导执行/展示。
- **迁移分类：** Preserve：source split、list ordering、filter/default、unknown toggle no-op。Intentional Improvement：明确 canonical collision/removal reconciliation；现有 `upsertNative` 不删除 stale native 是可从代码确认的 projection defect（若 listInstalledTools代表全量；该前提仍待 adapter contract验证）。
- **未来 Rust owner：** Domain Module；持久 catalog机制若需要归 Foundation Kernel，runtime discovery归 Runtime Integration。
- **Rust 重写与性能判断：** keyed `ToolKey{source,id}`、immutable query snapshot和清晰 tombstone/full-sync API；测 list latency/allocation、stale/duplicate ratio；oracle 是 TS valid query differential、full-sync removal/collision fault corpus。
- **验证 oracle：** platform tool workflows/routes；includeDisabled/requested/collision/removed-upstream fixtures。
- **证据：** 本文件；`context-assembler.ts`、`platform-native-tool-workflow.ts`、`platform-tool-state-workflow.ts`。

### runtime-host/application/platform-runtime/state/tool-registry-view-ledger.ts

- **当前 owner：** registry read projection facade；不拥有 tool state。
- **职责与关键 symbols：** `ToolRegistryViewLedger.snapshot(query={})` 直接调用 `listEffective`。
- **旧语义与策略：** 默认空 query；其余 filtering/status/unknown由 registry定义；无 retry/cache/snapshot persistence。
- **状态、存储与副作用：** 仅 registry reference；无 I-O。
- **并发与性能特征：** O(registry list)，不复制/lock beyond downstream。
- **调用/依赖边界：** 供视图/consumer读取 registry；不应被当作事实或 runtime driver。
- **故障、恢复与安全：** registry rejection传播；返回 metadata无 redaction。
- **迁移分类：** Preserve：empty-query delegation。Intentional Improvement：可删除此单方法层，若无独立 read-model semantics。待验证：生产调用者是否存在。
- **未来 Rust owner：** Domain Module read model，或随 registry合并。
- **Rust 重写与性能判断：** 不单独建 actor/storage；使用 registry immutable snapshot。oracle 为 query forwarding/empty default test。
- **验证 oracle：** registry query tests，composition reference scan。
- **证据：** 本文件；`ToolRegistryStore` contract。

### runtime-host/application/platform-runtime/tool-catalog-service.ts

- **当前 owner：** platform tool catalog mutation service和best-effort audit producer；工具 catalog仍在 registry。
- **职责与关键 symbols：** `listEffective`代理；upsert/set enabled后 append audit，clock打时间。
- **旧语义与策略：** write registry成功后才 audit；audit失败使整个 mutation reject，尽管 registry已经变更，重试会再写/再audit；无 rollback/idempotency/timeout；list默认为 `{}`。
- **状态、存储与副作用：** 无本地状态；registry内存 mutate、audit sink append。
- **并发与性能特征：** list O(registry N)；mutation两个顺序 await，无 per-tool serialization；并行 toggle可交错，audit order按完成而非意图顺序。
- **调用/依赖边界：** ToolStateWorkflow、platform facade/workflows调用；audit机制不应成为 catalog事实源。
- **故障、恢复与安全：** audit failure留下已提交但报失败；audit payload只计数/id/boolean，未写 credentials，仍应由 sink redaction policy保证。
- **迁移分类：** Preserve：registry-before-audit及 audit event shape。Intentional Improvement：Foundation transactional outbox/append policy或明确 best-effort audit，避免 false failure；兼容影响须定义 mutation receipt。Defect：audit reject导致已变更操作看似失败是代码可证的原子性缺口。
- **未来 Rust owner：** Domain Module（catalog command）；Foundation Kernel（audit persistence/outbox）。
- **Rust 重写与性能判断：** catalog actor写事实并同事务写 outbox或返回 committed-with-audit-pending；指标为 command latency/audit lag/duplicate event；oracle 为 audit failure/retry and event ordering fault injection。
- **验证 oracle：** platform tool state routes；新增 failing audit sink、duplicate mutation、concurrent toggle tests。
- **证据：** 本文件；`platform-tool-state-workflow.ts`、`audit-sink.ts`。

### runtime-host/application/platform-runtime/tool-executor.ts

- **当前 owner：** in-process platform tool handler dispatch registry；不拥有 tool catalog、authorization或 execution receipt。
- **职责与关键 symbols：** handler Map；`register` replace、`unregister` delete、`executeTool` missing→`{ok:false,error:'tool_handler_not_found:<id>'}`，否则 await handler。
- **旧语义与策略：** duplicate register last wins；unregister unknown no-op；handler errors/rejections传播，只有 absent handler被结果化；无 default, timeout, retry, policy check, run/session validation或 audit。
- **状态、存储与副作用：** Map of function closures；handler自己的副作用未知/不应假设可靠。
- **并发与性能特征：** lookup O(1)，execution并行且不对同 tool/run serialize；register/unregister与await handler可交错，已拿到的 closure仍执行。
- **调用/依赖边界：** facade `executePlatformTool`，handlers由 composition/Native Runtime Edge注入；不能把 foreign tool harness移入 Platform Core。
- **故障、恢复与安全：** arbitrary args/handler boundary无 sanitization；不存在 crash recovery/cancel/redaction；error字符串泄露 requested tool ID。
- **迁移分类：** Preserve：last-registration-wins、missing-as-result、handler failures propagate。Intentional Improvement：capability-scoped typed handler + Foundation deadline/cancel; security policy先在 domain层决定。待验证：是否有 handler registration/execute tests。
- **未来 Rust owner：** Domain Module 的 tool dispatch；Native Runtime Edge/Runtime Integration提供具体 handler；Foundation提供deadline/cancel primitives。
- **Rust 重写与性能判断：** `HashMap<ToolId, Arc<dyn ToolHandler>>`、bounded execution semaphore；指标为 handler queue depth/cancel latency/missing rate；oracle 是 register/unregister/handler error/race tests。
- **验证 oracle：** platform capability/workflow integration；新增 concurrent unregister-during-run、timeout and untrusted args tests。
- **证据：** 本文件；`platform-runtime-port.ts`、Platform capability routes。

### runtime-host/application/platform-runtime/tool-reconciler.ts

- **当前 owner：** Gateway/native snapshot与local platform projection的 comparison service；不拥有 Gateway truth，也不修复 missing/conflict。
- **职责与关键 symbols：** `collectById` last wins；`isConflict`只比 version/默认 enabled；`reconcileTools`按 gateway map找 discovered/conflicts、按 local找 missing，发现仅 upsert native，missing/conflict仅 audit alert。
- **旧语义与策略：** gateway和local同 ID但 source/name/metadata不同而 version/enabled相同不冲突；无 gateway ID→registry 删除；discovered才入 registry；alert仅当 missing/conflicts非空；无 retry、timeout、idempotency key或 status。
- **状态、存储与副作用：** 瞬时 Maps/arrays；可能 mutation registry、append audit；ledgers读取均为内存 snapshot。
- **并发与性能特征：** O(G+L) time/memory；在 ledger reads 与 registry/audit awaits间可发生刷新，报告不是原子全局 snapshot。
- **调用/依赖边界：** NativeToolWorkflow与 RuntimeManager 调用；gateway ledger来自 runtime driver，local ledger来自 catalog，audit为辅助。
- **故障、恢复与安全：** registry/audit failure传播，可能有部分 discovered已写；metadata不进 audit；不应从报告推导外部 Gateway 已修复/一致。
- **迁移分类：** Preserve：discovered/missing/conflict定义和只写 discovered。Intentional Improvement：将 reconcile作为 revisioned observation，报告source revision且明示非修复；若需修复建独立 command。待验证：version+enabled 是否完整冲突定义。
- **未来 Rust owner：** Domain Module（platform tool reconciliation）；Runtime Integration供应 gateway/native snapshots；Foundation提供audit store。
- **Rust 重写与性能判断：** read immutable source revisions、linear merge（sorted IDs或 HashMap）和 one command receipt；指标为 G/L规模 p95/alloc、revision skew、partial-write recovery；oracle 是 matrix golden and injected registry/audit failure differential。
- **验证 oracle：** platform native/tool-state workflow tests；发现/缺失/冲突/duplicate/revision-race fixtures。
- **证据：** 本文件；both ledger files、`platform-native-tool-workflow.ts`。

### runtime-host/application/runtime-host/bootstrap-jobs.ts

- **当前 owner：** Runtime Host bootstrap command→long-task submission mapping；queue execution/state在 Foundation机制。
- **职责与关键 symbols：** two job string IDs、`GatewayPrelaunchInput`、`createRuntimeHostBootstrapJobPort`；gateway prelaunch用 `critical` + fixed dedupe key，workspace migration固定 dedupe key。
- **旧语义与策略：** 所有 gateway prelaunch输入不论 token/proxy差异共用 dedupe key；结果是 queue snapshot accepted，不立即执行；无 input validation/retry/status/timeout在本层。
- **状态、存储与副作用：** 无；queue enqueue。
- **并发与性能特征：** O(1)，相同 dedupe key下的合并/replace语义完全取决于 queue实现，不能臆称 latest payload获胜。
- **调用/依赖边界：** BootstrapService/operations workflow调用；`RuntimeLongTaskSubmissionPort`为mechanism。
- **故障、恢复与安全：** input包含 gateway token/proxy，直接进入 job payload；本层无 secret envelope/redaction；queue persistence和retry待证。
- **迁移分类：** Preserve：job ID、critical prelaunch、accepted submission。Intentional Improvement：secret reference而非 token payload并为 dedupe 定义 payload conflict policy；兼容影响需使用 queue trace验证。待验证：same-key不同 input的队列行为。
- **未来 Rust owner：** Runtime Host/Bootstrap Domain定义命令，Foundation Kernel拥有 queue/dedupe/storage/secret。
- **Rust 重写与性能判断：** typed job payload只含 secret handle，dedupe key+payload hash receipt；指标为 dedupe collision、queue latency、restart recovery；oracle 为 duplicate/mixed-payload queue fault tests。
- **验证 oracle：** bootstrap/provider-sync and runtime operations tests；critical queue/dedupe trace fixture。
- **证据：** 本文件；`runtime-long-task-service.ts`、`runtime-host-operations-workflow.ts`。

### runtime-host/application/runtime-host/bootstrap.ts

- **当前 owner：** Runtime Host bootstrap facade/orchestrator boundary；具体 Gateway config/provider/Workspace事实在 workflows及各领域。
- **职责与关键 symbols：** `RuntimeHostBootstrapService` submits jobs、delegates settings/launch-plan/prelaunch/template migration；`buildProviderEnvMap`纯调用 workflow export；`onGatewayLifecycle`接受任意 payload但恒返回 null。
- **旧语义与策略：** submit与execute两个路径同时存在；设置/plan read async；provider env map无参数；`onGatewayLifecycle`即使 `state:'running'` 也 no-op，未保存状态；无 retry/timeout/idempotency/secret处理自身。
- **状态、存储与副作用：** 无状态；jobs enqueue与 delegated workflow可能读写 settings/config/workspace/providers。
- **并发与性能特征：** facade O(1)；submit与direct execute未被互斥，可能并发触发相同 prelaunch，实际防重依赖 queue/下游，未证明。
- **调用/依赖边界：** RuntimeHostOperationsWorkflow、composition；Gateway prelaunch workflow负责 config/projection，Delivery不为bootstrap事实源。
- **故障、恢复与安全：** delegated errors传播；launch plan/provider env可包含 gateway token/API key，禁止经 route/public logs暴露；当前 types没有 privacy boundary。
- **迁移分类：** Preserve：delegation、submit vs direct execute surface、no-op lifecycle结果。Intentional Improvement：删除/实现 no-op lifecycle必须先确认路由兼容；将 plan分 public/redacted 与 private secret injection。待验证：direct execute的生产调用与 lifecycle no-op是否遗留。
- **未来 Rust owner：** Delivery/application facade；Bootstrap domain workflow；Foundation secret/job primitives；Gateway-specific projection Runtime Integration。
- **Rust 重写与性能判断：** typed bootstrap command + public launch summary/private secret materialization；保持 job acceptance；指标为 duplicate prelaunch、secret leaks、bootstrap duration；oracle 是 settings/plan/job differential和 concurrent submission faults。
- **验证 oracle：** `tests/unit/runtime-host-bootstrap-provider-sync.test.ts`、runtime-host-service tests；Gateway prelaunch workflow fixtures。
- **证据：** 本文件；`gateway-prelaunch-workflow.ts`、`runtime-host-operations-workflow.ts`。

### runtime-host/application/runtime-host/parent-shell-port.ts

- **当前 owner：** Runtime Host→parent shell transport contract/adapter；Delivery/desktop integration，不是 Gateway lifecycle owner。
- **职责与关键 symbols：** `ParentShellPort.request/mapResponse`；`ParentShellGatewayControl.restartGateway`请求 literal `gateway_restart`。
- **旧语义与策略：** no payload restart action；请求结果原样返回，未调用 `mapResponse`；无 timeout/retry/idempotency/status check。
- **状态、存储与副作用：** 无；parent IPC/transport side effect由 port实现。
- **并发与性能特征：** O(1) transport delegation，重复 restart可并发，外部语义未知。
- **调用/依赖边界：** Runtime host operations/parent transport contracts；Electron/parent process拥有实际 restart。
- **故障、恢复与安全：** transport errors传播；action固定减少任意 action注入，但 upstream payload可能含 private detail；无 authentication在此。
- **迁移分类：** Preserve：`gateway_restart` literal和 delegation。Intentional Improvement：typed command receipt/deadline；不能假定 parent restart幂等。待验证：`mapResponse`实际调用位置。
- **未来 Rust owner：** Delivery（desktop/parent transport）；Foundation可提供IPC deadline mechanism。
- **Rust 重写与性能判断：** typed IPC command with redacted response mapping；测 restart request latency/failure, not Gateway recovery success；oracle为 mock parent action/payload/error tests。
- **验证 oracle：** parent transport/host IPC tests；duplicate restart and timeout faults。
- **证据：** 本文件；`shared/parent-transport-contracts.ts`、composition parent transport adapter。

### runtime-host/application/runtime-host/prelaunch-maintenance-cache.ts

- **当前 owner：** runtime data-dir cache workflow adapter；cache policy/JSON I-O在 workflow，当前文件选择 path和转发。
- **职责与关键 symbols：** re-exports stable key/signature/result helpers；`PrelaunchMaintenanceCacheRepository.directoryChildrenSignature/runTask`，cache file固定 `matchaclaw-gateway-prelaunch-maintenance-cache.json`。
- **旧语义与策略：** task name联合体只允许三类；cache path=`runtime data dir`+filename；maxEntries默认200由下游；无本层 retry/status/locking。
- **状态、存储与副作用：** 无自身状态；下游读写运行时目录 JSON cache。
- **并发与性能特征：** forwarding O(1)；同 cache file多 task/进程写时没有锁在此或下游 workflow中，存在 lost-update 风险。
- **调用/依赖边界：** PrelaunchPluginMaintenance调用；workflow实现 signature/read/write；runtime data layout注入。
- **故障、恢复与安全：** cache解析/I-O失败由 workflow降级为执行 task；path来自 runtime port；cache key含目录/插件签名，不应含 secret，待审计实际 providers。
- **迁移分类：** Preserve：cache filename/task names/path placement、cache failure fallback。Intentional Improvement：Foundation file lock/atomic write和schema versioned record；兼容影响为并发下结果稳定。Defect：并发 write lost update需要有并发调用证据，现标待验证。
- **未来 Rust owner：** Foundation Kernel（cache storage/atomic I-O）；Bootstrap/Plugin domain仅给 task/key。
- **Rust 重写与性能判断：** versioned JSON/SQLite cache with atomic replace/lock, bounded directory signature; 指标 cache hit rate、I/O、concurrent integrity；oracle cache-hit/miss/corrupt/parallel-task fault corpus。
- **验证 oracle：** prelaunch maintenance cache workflow unit tests；cache path and task-name golden.
- **证据：** 本文件；`prelaunch-maintenance-cache-workflow.ts`、`prelaunch-plugin-maintenance.ts`。

### runtime-host/application/runtime-host/prelaunch-plugin-maintenance.ts

- **当前 owner：** Gateway launch前的 plugin/channel maintenance orchestration；plugin/channel领域事实与实际安装仍在各 repository/Runtime Integration。
- **职责与关键 symbols：** cache key builders；`cleanupStaleBuiltinExtensionsForGatewayLaunch`删除存在的 stale extension dirs；`reconcileConfiguredChannelPluginsForGatewayLaunch`强制安装 configured channel plugins；`ensureConfiguredManagedPluginsForGatewayLaunch`强制安装 configured managed plugins。
- **旧语义与策略：** configured/enabled ID排序后用于部分 key；stale cleanup逐项存在→删除，缺失跳过；cache hit时返回局部 `removed=[]`或原 ID列表而不执行；task成功才logger info；任一 file/plugin/channel错误传播，无重试；forceInstall true。
- **状态、存储与副作用：** 读 data/distribution/cwd、channel/plugin signatures，删除目录，安装/同步 plugin，读写cache，写日志。
- **并发与性能特征：** stale cleanup串行 filesystem I-O；key construction多个 signatures可 await；max 200 children signature在workflow意味着超过项变化可能不使 key改变；未按 runtime/profile加锁，重复 launch可并发维护。
- **调用/依赖边界：** GatewayPrelaunchWorkflow调用；依赖 channel config、runtime plugin repo、file system、cache repository；Gateway/Native Runtime仍是实际 plugin owner。
- **故障、恢复与安全：** 删除只针对 projection声明 ID与 config extensions path，但path traversal safety依赖 ID source；cache write失败可能导致下次重做；日志列出 plugin IDs；不能假设 force install/remote catalog可靠或幂等。
- **迁移分类：** Preserve：task顺序、cache-key输入、missing dir skip、forceInstall、失败传播。Intentional Improvement：per-runtime maintenance actor/file lock、validated plugin IDs、atomic cache；兼容需保持每个 task的observable result。待验证：200-entry截断是否会漏失关键变化、plugin ID的路径安全保证。
- **未来 Rust owner：** Domain Module（Plugin/Channel maintenance orchestration）+ Runtime Integration（Gateway/native plugin操作）；Foundation Kernel（cache/fs lock）。
- **Rust 重写与性能判断：** keyed maintenance actor，bounded/possibly parallel signature reads但保留 delete/install顺序；消除重复 concurrent I/O，指标 cold/warm launch、cache hit、deletes/installs、lock wait；oracle directory/plugin fake differential与 crash-between-delete/install tests。
- **验证 oracle：** `tests/unit/runtime-host-prelaunch-plugin-maintenance.test.ts`、prelaunch cache and bootstrap tests。
- **证据：** 本文件；`gateway-prelaunch-workflow.ts`；CodeGraph callers。

### runtime-host/application/runtime-host/runtime-jobs-service.ts

- **当前 owner：** queued runtime job read facade；queue truth/storage在 Foundation queue port。
- **职责与关键 symbols：** `list(type?)` trim nonempty type并输出 queue/registeredTypes/jobs；`get(jobId)`返回 job或null，均 `success:true`。
- **旧语义与策略：** whitespace type当无 filter；unknown type返回空 jobs仍成功；unknown job返回 null仍成功；无 pagination/timeout/retry/status recomputation。
- **状态、存储与副作用：** 无；同步读取 queue snapshot/query port。
- **并发与性能特征：** list成本由 queue list决定，可能全量 O(N)；一次 list依次调用三个 port方法，非原子快照，queue可在期间变化。
- **调用/依赖边界：** RuntimeHostOperationsWorkflow/RuntimeHostService与 route使用；不执行或修改 jobs。
- **故障、恢复与安全：** queue query异常传播；payload/security redaction由 job snapshot port，当前 facade不净化。
- **迁移分类：** Preserve：success+null/empty query shape、type trim。Intentional Improvement：Foundation返回带 revision的单一 query snapshot及 redacted public job view；兼容影响须版本化。待验证：job payload是否暴露给该 API。
- **未来 Rust owner：** Delivery query facade；Foundation Kernel（job state/query storage）。
- **Rust 重写与性能判断：** one consistent `JobQueueSnapshot{revision,...}` read；指标 list p95/alloc/snapshot skew；oracle empty/unknown/type whitespace and concurrent queue mutation tests。
- **验证 oracle：** runtime-host operations/route tests；mock queue response snapshot fixture。
- **证据：** 本文件；`runtime-task-ports.ts`、`runtime-host-operations-workflow.ts`。

### runtime-host/application/runtime-host/runtime-long-task-service.ts

- **当前 owner：** long task submit facade；queue policy mechanism不在本类。
- **职责与关键 symbols：** `RuntimeLongTaskService.submit` 默认 `{}` options，调用 `jobQueue.enqueue` 并包 `{success:true,job}`。
- **旧语义与策略：** success只在 enqueue同步返回后给出；不表示 execution成功；type/payload不验证；options原样转发；dedupe/retry/priority/status均由 queue定义。
- **状态、存储与副作用：** 无；queue enqueue可能内存/持久化副作用。
- **并发与性能特征：** O(1) wrapper；并发 ordering/dedupe完全取决于 queue。
- **调用/依赖边界：** platform/bootstrap jobs使用；Foundation task queue是下游。
- **故障、恢复与安全：** enqueue throw传播；payload可能含 token/secret，无 redaction；不可凭 `success:true`推断 external task delivery。
- **迁移分类：** Preserve：accepted submission envelope/default options。Intentional Improvement：明确定义 accepted receipt与 durable/enqueued distinction、secret handles；待验证：enqueue持久性/throws contract。
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** typed `JobCommand`/`AcceptedReceipt`，bounded durable queue；指标 enqueue latency/duplicate/restart recovery，oracle queue mock and crash fault tests。
- **验证 oracle：** bootstrap/platform job submission integration；enqueue throw/dedupe options fixture。
- **证据：** 本文件；`runtime-task-ports.ts`、bootstrap/platform jobs。

### runtime-host/application/runtime-host/runtime-state.ts

- **当前 owner：** Runtime Host local lifecycle/plugin/transport status projection；事实 inputs由 process lifecycle/catalog/transport统计注入，当前文件不是它们的 owner。
- **职责与关键 symbols：** `createHealthPayload`以 clock/pid算 uptime；local plugin/runtime/health/payload builders；`RuntimeHostStateService.health/transportStats`包装 injected state/health/stats。
- **旧语义与策略：** health ok仅 lifecycle `running`；plugin active仅running+enabled set；nonrunning固定 error `runtime-host child is <state>`且 degradedPlugins总空；uptime可因 clock回拨为负；transport stats逐字段复制；generatedAt来自 clock；unknown plugin IDs在 enabled列表中保持但无 catalog plugin投影。
- **状态、存储与副作用：** service无内部 state；依赖 closures读取外部内存 lifecycle/catalog/counters；无 I-O。
- **并发与性能特征：** plugin map/filter O(P)，transport O(1)；闭包多次读取无atomic snapshot要求，可能混合不同时刻状态。
- **调用/依赖边界：** RuntimeHostService、composition/route使用；lifecycle来自 runtime host runner，plugin catalog来自 bootstrap config，transport counters来自 dispatch。
- **故障、恢复与安全：** injected provider errors传播；状态仅本地投影，不能证明 child/Gateway真正活跃；plugin catalog description等可能面向public，需上游净化。
- **迁移分类：** Preserve：running判定、plugin active规则、payload keys/error文字（若API兼容）。Intentional Improvement：atomic revisioned state sample、单调 clock clamp uptime≥0、public/private diagnostic split；兼容影响必须金丝雀比对。Defect：负 uptime在系统时钟回拨下可由计算直接导出；是否可观察待验证。
- **未来 Rust owner：** Runtime Host Domain的 local projection；Foundation Kernel提供 clock/process/counter primitive；Delivery仅呈现。
- **Rust 重写与性能判断：** immutable `RuntimeHostStateSnapshot`一并取样，`Instant`计uptime；指标 snapshot skew/alloc/uptime correctness；oracle lifecycle×plugin golden + clock rollback/concurrent counter faults。
- **验证 oracle：** runtime host service/routes tests；health/transport fixtures、monotonic-clock test。
- **证据：** 本文件；composition runtime application module；`RuntimeHostService`。

### runtime-host/application/runtime-host/runtime-task-ports.ts

- **当前 owner：** Runtime Host task queue contracts；定义机制边界，不拥有任务领域事实。
- **职责与关键 symbols：** submission/enqueue/lookup/query ports与 `RuntimeLongTaskSubmission{success:true,job}`。
- **旧语义与策略：** type/payload/options未约束；lookup unknown返回null；query lists没有 pagination/cursor/revision、deadline、cancel、retry/idempotency或 persistence guarantee。
- **状态、存储与副作用：** 类型合同无状态；实现可 queue/storage。
- **并发与性能特征：** 无实现；合同未表达 ordering/backpressure/atomic snapshot。
- **调用/依赖边界：** bootstrap/platform job adapters与 services依赖；实现由 composition infrastructure注入。
- **故障、恢复与安全：** job payload可能含 secret；contract不定义redaction/access control，也不表示 `success:true`等于执行成功。
- **迁移分类：** Preserve：accepted envelope、null lookup、job snapshot delegation。Intentional Improvement：Foundation typed job kind/payload schema、receipt lifecycle/revision/redaction/deadline model。待验证：所有 queue implementations对dedupe/retry的实际保证。
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** sealed `JobKind` + typed/serialized payload、`JobReceipt`/cursor query、durable storage selected by requirements；指标 queue throughput/latency/recovery/snapshot consistency；oracle contract/property tests。
- **验证 oracle：** queue/job tests与 bootstrap/platform request traces；duplicate/restart/redaction cases。
- **证据：** 本文件；`runtime-long-task-service.ts`、bootstrap/platform job ports。

### runtime-host/application/runtime-host/service.ts

- **当前 owner：** Runtime Host API/application facade；不拥有 lifecycle, bootstrap, job queue或 diagnostics事实。
- **职责与关键 symbols：** `RuntimeHostService` delegates health/transportStats to state and bootstrap/provider/launch/lifecycle/diagnostics/job operations to workflow.
- **旧语义与策略：** health/stat synchronous; plan/settings/diagnostics async; no local validation/default/retry/timeout/status/idempotency; exact downstream return preserved.
- **状态、存储与副作用：** no own state; effects are state reads or operation workflow calls.
- **并发与性能特征：** O(1) delegation; no coordination between lifecycle/launch/jobs calls.
- **调用/依赖边界：** capability/route, composition tokens/modules, diagnostics and OpenClaw infrastructure consume it; Delivery boundary should remain a projection/command entry.
- **故障、恢复与安全：** downstream exceptions propagate; provider env/launch plan can contain secrets, so a Rust delivery response must not expose private values without an explicit projection; no recovery logic here.
- **迁移分类：** Preserve: façade operation mapping and sync/async observable shape. Intentional Improvement: split public views from secret-bearing operation outputs; no duplicate Rust state service. 待验证：各 route 对 delegation exception 的 HTTP mapping。
- **未来 Rust owner：** Delivery facade; Runtime Host/Bootstrap domain services own use cases; Foundation owns shared state/job mechanisms; Gateway-specific calls stay Runtime Integration.
- **Rust 重写与性能判断：** thin command/query endpoints over typed use cases, retaining no cache; measure only handler overhead and response redaction, with route differential oracle.
- **验证 oracle：** `tests/unit/runtime-host-service.test.ts`、`runtime-host-service-injected-routes.test.ts`、runtime route composition tests。
- **证据：** 本文件；`runtime-host-operations-workflow.ts`、`runtime-state.ts`；CodeGraph callers。

## 未读、排除与静态审计限制

- **未读：0。** `00-inventory.md` 的 05 清单 31 路径与当前主工作树 Python 枚举 31 个 `.ts` 完全一致；没有 `application/platform/**` 当前 `.ts`，inventory 实际路径为 `application/platform-runtime/**`，已按实际清单全量读取。
- **排除：** `runtime-host/build/**`、依赖目录、测试输出、临时目录，以及 `runtime-host/package.json`/`tsconfig.json`，理由与 inventory 明确排除项一致；它们不是本分片逐文件 TypeScript source。workflow、composition、route、shared contract与测试仅作为调用链证据读取，不作为 05 文件记录。
- **限制：** 结论来自静态全文走读、CodeGraph 调用关系及现有测试路径；未启动 Gateway、外部 runtime、queue 或插件安装，因而不把端到端可靠性、外部取消、持久性、实际并发/重连表现当成已证事实。所有未由本分片代码/测试闭环的推断均标为待验证。
- **源代码改动确认：** 本次只创建本报告；未修改 runtime-host 源码、测试、README、`00-inventory.md`、其他报告、配置或锁文件。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **Platform Runtime / Gateway / Runtime Host 仍由 TypeScript owner 保留；Rust cutover 未证实。** 当前改动触及 `gateway-runtime-port.ts`、`runtime-host/{bootstrap,bootstrap-jobs,service}.ts`、gateway readiness/prelaunch/runtime-host operations workflows，以及 Electron local-process runtime；没有 Rust service 进入生产 path 的证据。
- **生产 active path：** Electron `bootstrapMainApplication` 启动 Matcha-agent app-server、再 `RuntimeHostManager.start()`，Gateway autostart 由 `GatewayManager.start()` 触发；`RuntimeHostManager` 通过新 `process-runtime/runtime-host-process-manager.ts` / `RuntimeHostProcessAdapter` 创建 host child，child 的 bootstrap/service/workflow 继续经 composition 与 Gateway port 运作。Gateway 则通过 `process-runtime/openclaw-gateway-process-manager.ts`、`OpenClawGatewayProcessAdapter`、`LocalProcessRuntime` 执行 prelaunch、readiness、recovery 与 lifecycle；runtime-host 中的 gateway readiness 仍为其 TS consumer/projection。
- **外部旧 owner 与 current-vs-target 边界：** 已删除 `electron/gateway/**` 与 `electron/main/runtime-host-process-manager.ts` 的 process policy、launch/recovery/public status 已迁入 `electron/main/process-runtime/openclaw-gateway/**` 和 generic local-process runtime。这是当前 TS relocation，但其中的受管 Runtime lifecycle 语义——desired lifecycle、launch/attach、port/control readiness、restart/backoff、log、shutdown、process-tree cleanup、PID/provenance 与 public lifecycle observation——是 Rust Local Process Host 的外部旧 owner，必须随 runtime-host 迁移而切走，不能永久留 Electron。Gateway protocol/control translation 仍与该物理生命周期切片分离。
- **旧策略与 future owner：** Preserve Gateway readiness/control、bootstrap/provider sync、job/lifecycle 与 public facade 的 timeout/error/command behavior。终态 Rust Runtime 拥有 lifecycle policy，Rust Local Process Host 承接进程实现，Gateway-specific control仍为 Runtime Integration，platform/tool state不得误升 Foundation；Electron保留桌面 Delivery/API client，而非 Runtime PID/lifecycle truth。健康、recovery、external attachment 的真实端到端表现与 Rust cutover仍**未证明**。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/local-process-runtime-lifecycle.test.ts tests/unit/local-process-runtime-start-failure.test.ts tests/unit/openclaw-gateway-process-manager.test.ts tests/unit/openclaw-gateway-process-adapter.test.ts tests/unit/runtime-host-bootstrap-provider-sync.test.ts tests/unit/runtime-host-service.test.ts tests/unit/runtime-host-gateway-ready.test.ts`；`pnpm run typecheck`。本次均**未运行**。
