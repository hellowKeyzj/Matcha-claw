# 02 — Composition / Core / Services 文件级迁移审计

> 审计日期：2026-07-11；事实来源为工作树当前内容。本文只记录 `runtime-host/composition/**`、`runtime-host/core/**`、`runtime-host/services/**` 中当前存在的 `.ts` / `.cjs`，不将当前 TS 实现当作未来 Rust 设计批准书。

## 实际读取范围、方法与排除

- **CodeGraph 已读：**先后以 `runtime-host composition root module registry container job lifecycle registration manifest`、`createRuntimeHostProcess RuntimeHostContainer RuntimeHostModuleRegistry RuntimeJobRegistry RuntimeHostLifecycle`、`validateRegistrationOwners validateResolveImports RuntimeJobQueue RuntimeHostLifecycle BackgroundTaskManager` 追踪 composition root、system/application module registry、container、route registry、job/lifecycle 注册与验证链。
- **Python 完整枚举并逐文件读完：**38 个文件、9,339 行、391,861 UTF-8 bytes。已读路径：
  - `runtime-host/composition/application-service-registry.ts`
  - `runtime-host/composition/application-services.ts`
  - `runtime-host/composition/container.ts`
  - `runtime-host/composition/gateway-auto-recovery.ts`
  - `runtime-host/composition/gateway-device-identity-adapters.ts`
  - `runtime-host/composition/license-node-runtime.ts`
  - `runtime-host/composition/modules/acp-connector-module.ts`
  - `runtime-host/composition/modules/agent-runtime-module.ts`
  - `runtime-host/composition/modules/external-connectors-application-module.ts`
  - `runtime-host/composition/modules/gateway-bridge-module.ts`
  - `runtime-host/composition/modules/openclaw-application-module.ts`
  - `runtime-host/composition/modules/openclaw-infrastructure-module.ts`
  - `runtime-host/composition/modules/openclaw-route-module.ts`
  - `runtime-host/composition/modules/operations-application-module.ts`
  - `runtime-host/composition/modules/operations-route-module.ts`
  - `runtime-host/composition/modules/platform-runtime-module.ts`
  - `runtime-host/composition/modules/plugin-runtime-module.ts`
  - `runtime-host/composition/modules/remote-fleet-application-module.ts`
  - `runtime-host/composition/modules/runtime-application-module.ts`
  - `runtime-host/composition/modules/runtime-infrastructure-module.ts`
  - `runtime-host/composition/modules/runtime-route-module.ts`
  - `runtime-host/composition/modules/session-route-module.ts`
  - `runtime-host/composition/modules/session-runtime-module.ts`
  - `runtime-host/composition/parent-transport-client.ts`
  - `runtime-host/composition/plugin-file-system-adapter.ts`
  - `runtime-host/composition/route-registry.ts`
  - `runtime-host/composition/runtime-host-composition.ts`
  - `runtime-host/composition/runtime-host-infrastructure-adapters.ts`
  - `runtime-host/composition/runtime-host-module-registry.ts`
  - `runtime-host/composition/runtime-host-runner.ts`
  - `runtime-host/composition/runtime-host-runtime-module-registry.ts`
  - `runtime-host/composition/runtime-host-server.ts`
  - `runtime-host/composition/runtime-host-tokens.ts`
  - `runtime-host/composition/runtime-route-composition.ts`
  - `runtime-host/core/jobs.ts`
  - `runtime-host/core/lifecycle.ts`
  - `runtime-host/core/registry.ts`
  - `runtime-host/services/background-task-manager.ts`
- **本分片内未读：**无；枚举结果中没有 `.cjs`，故没有 `.cjs` 记录。
- **明确排除路径：**`runtime-host/application/**`、`runtime-host/api/**`、`runtime-host/openclaw-bridge/**`、`runtime-host/plugin-engine/**`、`runtime-host/shared/**`、`runtime-host/tests/**`（如存在）以及 `tests/**`，均在用户分配边界外；`docs/**`（本报告除外）、`build/**`、`dist/**`、依赖目录、测试输出与生成物也不在本分片。它们不是静默遗漏，而是不属于本次独占目录。

## Composition root、注册链与 manifest 的实际边界

**当前事实。**`createRuntimeHostProcess` 的顺序是：建立 `RuntimeHostContainer` → 注册并解析 Node infrastructure → 强制读取 parent URL/token，安装 job 事件回传 → system modules 的 `infrastructure`、`services`、`resolve/connect` 阶段 → 注册 runtime snapshot/parent shell/parent event value → application services 与 connect → application routes/dispatcher → 解析 server 所需 facade 与 terminal manager → 注册 dispatcher token → system jobs、application jobs、system lifecycle、application lifecycle → 两套 owner/import 验证 → 构建 HTTP server/runner。初始化异常直接上抛；没有阶段性反注册或已创建资源的回滚。

**当前事实。**system manifest 的顺序为 `infrastructure`、`openclaw-infrastructure`、`acp-connector`、`matcha-agent-runtime`、`gateway-bridge`、`platform-runtime`、`plugin-runtime`、`agent-runtime`、`session-runtime`；application service 顺序为 `application-foundation`、`external-connectors`、`remote-fleet`、`openclaw`、`license`、`runtime`、`operations`、`sessions`。lifecycle 的 cleanup 在 `RuntimeHostLifecycle.stop()` 中逆注册顺序执行；background start 以 `setImmediate` 延后一轮后按注册顺序 fire-and-forget。

**manifest 能验证。**`RuntimeHostModuleRegistry` 校验模块名/manifest id、重复模块和重复 export、声明的 stage 对应实现、每个静态 import 是否可由本模块或 external export 提供、静态 import/connect module 图是否无环；运行时收集 container/facade resolve edge 后，校验跨模块 token 已 export 且 from-module 已声明 import；并校验已归属的 singular DI/job/lifecycle/route 注册若为 manifest export，其注册 owner 不冲突。

**manifest 不能验证。**它不要求 manifest export 实际被注册，也不要求每个实际注册都在 exports；`contribution` 明确跳过 export-owner 冲突验证，且多贡献 owner 被折叠为 `null`。只会捕捉在带 resolution owner 的实际路径上发生的 resolve，懒加载、未执行请求路径、工厂内部异步延迟 resolve 均可能遗漏。它不证明 token 后的**storage/file/schema owner、业务事实（fact）owner、API 认证/输入/响应 owner、worker script/IPC owner、secret 生命周期/redaction、provider 语义、恢复、幂等、事务、并发或性能**。因此 Rust 迁移只能把 manifest 机制放进 Foundation Kernel；不能据此将这些领域状态机塞进 Kernel，也不能把 Platform Core 扩张成 R2 God module。

---

### runtime-host/composition/application-service-registry.ts

- **当前 owner：**Foundation primitive；是 application facade 的机械 composition registry，不拥有业务 state。
- **职责与关键 symbols：**`ApplicationServiceRegistry` 注册 lazy facade resolver、container facade，维护 facade token map、active resolution owner 与 facade resolve edges。
- **旧语义与策略：**token/owner trim 后不能为空，重复 facade 立即拒绝；`registerContainerFacade` 在被取用时切换 container resolution owner；同 owner 或无 caller owner 的 resolve 不记 edge。
- **状态、存储与副作用：**仅进程内 `Map`/数组；无文件、网络、secret、日志或 provider 注册；无 job/lifecycle 注册。
- **并发与性能特征：**同步 Map O(1)，edge 数组无上限且每次 resolve 追加；Node 单线程下 owner 作用域靠 `try/finally` 恢复，异步 resolver 若在 scope 外 resolve 不能被归因。
- **调用/依赖边界：**由 `application-services.ts` 创建，module registry 的 connect/routes 和 composition root 解析 facade；依赖 `RuntimeHostContainer`、typed token key。
- **故障、恢复与安全：**未注册/重复/空 token 或 owner throw；无 cleanup；不保存 secret。`resolve` 工厂异常原样传播。
- **迁移分类：**Preserve：唯一 facade、owner context、resolve-edge 采集；Intentional Improvement：Rust 用显式 construction graph/typed capability registry，避免依赖动态字符串与漏采集异步 edge；待验证：edge 是否覆盖所有 lazy 路径。
- **未来 Rust owner：**Foundation Kernel（模块装配校验机制）；领域 facade 的实际 API owner 留在各 Domain Module/Runtime Integration。
- **Rust 重写与性能判断：**以静态 trait bundle 或显式 registry 取代无界 edge 累积；保持错误语义。指标：boot validation 覆盖率、装配时间、edge 内存；oracle：container/implementation-boundary 单测与启动 trace。
- **验证 oracle：** container/implementation-boundary 单测与启动 trace。
- **证据：**本文件 `register*`/`resolve`；`application-services.ts`、`runtime-host-module-registry.ts`。

### runtime-host/composition/application-services.ts

- **当前 owner：**机械 composition；只包装 application facade registry 的创建及 services→connect 两阶段。
- **职责与关键 symbols：**`createApplicationServiceRegistry`，`registerRuntimeHostApplicationServices`。
- **旧语义与策略：**固定先 `registerRuntimeHostModuleServices` 后 `connectRuntimeHostModuleServices`；连接阶段只能看到前一阶段完整注册。
- **状态、存储与副作用：**自身无状态；其调用会写 container/facade registry；不直接注册 secret/log/provider/job/lifecycle。
- **并发与性能特征：**同步、线性遍历 module 顺序；没有并行或回滚。
- **调用/依赖边界：**由 composition root 调用，委托 application module registry。
- **故障、恢复与安全：**任一 module 阶段失败向上抛，先前注册保留；无 cleanup。
- **迁移分类：**Preserve：services 后 connect 的依赖顺序；Intentional Improvement：Rust boot transaction 应在失败时显式 dispose 已构造的资源；待验证：现有调用是否依赖部分注册残留。
- **未来 Rust owner：**Foundation Kernel（装配 orchestration）。
- **Rust 重写与性能判断：**无需性能重写；保留确定性顺序。oracle：boot failure fault injection 与 manifest validation。
- **验证 oracle：** boot failure fault injection 与 manifest validation。
- **证据：**本文件第 13–20 行；`runtime-host-composition.ts`。

### runtime-host/composition/container.ts

- **当前 owner：**Foundation primitive；进程内 DI container，而非业务 owner。
- **职责与关键 symbols：**`RuntimeHostContainer` 的 singular factory/value、multi-contribution、缓存 resolve、registration/resolution owner 和诊断描述符。
- **旧语义与策略：**singular token 与 contribution 不可混用；重复 singular/contribution 拒绝；factory 首次 resolve 后缓存；contributions 每次 resolve 重建全部值；owner scope 以 `try/finally` 恢复，resolve factory 临时把 owner 切为注册 owner。
- **状态、存储与副作用：**内存 Map/数组与 resolve-edge 日志；间接工厂可产生任意副作用；自身无 job/lifecycle/secret/log/provider。
- **并发与性能特征：**无 cycle detection；递归 factory 环会栈溢出而非给出依赖环；contributions 是 O(n) 建造且不缓存，edges 无界。JS 同步 factory 才能正确保留 dynamic owner。
- **调用/依赖边界：**所有 composition modules 注入/解析 token；registration descriptors 交给两套 module registry 验证。
- **故障、恢复与安全：**缺 token/重复注册 throw；factory throw 不缓存、可后续重试；没有 dispose、scope 或 secret isolation。
- **迁移分类：**Preserve：singular/contribution 排他、lazy singleton、owner diagnostics；Intentional Improvement：Rust 构建期 DAG/cycle error、显式 shutdown/drop graph 和 bounded diagnostics；Defect：没有 DI cycle detection（代码事实）；待验证：是否有依赖当前重复 factory 的可观察副作用。
- **未来 Rust owner：**Foundation Kernel。
- **Rust 重写与性能判断：**静态 DAG 或 typed provider map，multi-bindings 按需或一次物化；消除重复构造/无界 edges。指标：冷启动、重复 resolve、cycle failure 可诊断性；oracle：core framework tests 与 boot traces。
- **验证 oracle：** core framework tests 与 boot traces。
- **证据：**本文件 `resolve`/`resolveContributions`；`core/registry.ts` validation。

### runtime-host/composition/gateway-auto-recovery.ts

- **当前 owner：**错误耦合：Gateway/OpenClaw 故障启发式被放在 composition 目录，但它是 runtime-specific 恢复策略。
- **职责与关键 symbols：**`GatewayAutoRecovery.observe/reset`；同 session 同一 `Cannot read properties of` 错误连续 3 次后重启一次。
- **旧语义与策略：**非目标 event、正常/provider error 清除该 session count；全 gateway 生命周期仅 `attempted` 一次；`pending` 防重复；重启失败吞掉，finally 仍标记 attempted 并清 count。
- **状态、存储与副作用：**内存 session error count、attempted/pending；调用 `requestRestart`，可 warn log；无存储、provider/secret 注册、job/lifecycle hook。
- **并发与性能特征：**Map O(1)，异步 restart 未 await；同事件循环防重，但没有每 session queue/跨进程协调；session key 空值会共用桶。
- **调用/依赖边界：**依赖 session update contract、runtime logger、外部 restart port；由范围外 caller 提供 event 流。
- **故障、恢复与安全：**只处理字符串前缀，可能误/漏分类；restart rejection 静默；reset 不重置 `attempted`，与注释“重新连接后重置连续计数”一致但不允许第二次自动重启。
- **迁移分类：**Preserve：3 次阈值、pending 防抖、一次性保险丝；Intentional Improvement：Runtime Integration 用结构化 gateway fault code 与有界/可观测 retry；待验证：前缀分类和“一次”是否为产品契约。
- **未来 Rust owner：**Runtime Integration（OpenClaw gateway adapter），不能放 Foundation/Platform Core。
- **Rust 重写与性能判断：**每 endpoint actor 持有计数并记录 recovery receipt；没有已证据的性能瓶颈。oracle：连续异常、provider error、restart failure、reconnect trace。
- **验证 oracle：** 连续异常、provider error、restart failure、reconnect trace。
- **证据：**本文件；`SessionUpdateEvent` contract。

### runtime-host/composition/gateway-device-identity-adapters.ts

- **当前 owner：**错误耦合：Node crypto/file adapter 位于 composition，但是真实 Runtime Integration 的 device identity persistence。
- **职责与关键 symbols：**`NodeGatewayDeviceCrypto`（Ed25519 generation/fingerprint/sign/raw public key）和 `NodeGatewayDeviceIdentityRepository.loadOrCreateDeviceIdentity`。
- **旧语义与策略：**读 version=1 JSON；public key fingerprint 与 stored id 不同则覆写 id；缺失/坏 JSON 一律生成新 keypair；写前 mkdir，mode `0600`，chmod best-effort。
- **状态、存储与副作用：**私钥/公钥 JSON 写入指定路径，使用 Node crypto 与 clock；不注册 token/job/lifecycle/log/provider。
- **并发与性能特征：**同步 `generateKeyPairSync` 阻塞 event loop；无文件锁/atomic rename，两个 load-or-create 可竞态生成并覆盖；key 生成与文件 I/O 都在启动路径。
- **调用/依赖边界：**由 runtime infrastructure module 注册为 `gateway.deviceCrypto`、`gateway.deviceIdentityRepository`，gateway bridge 注入。
- **故障、恢复与安全：**读取错误被视为可恢复并覆盖身份；写失败上抛；private key 落盘权限意图明确，但 Windows chmod 仅 best-effort。
- **迁移分类：**Preserve：Ed25519、SHA-256 fingerprint、version/repair、private file permission；Intentional Improvement：原子 write+rename、跨进程 lock、OS keystore；待验证：坏 identity 允许无提示轮换是否可兼容。
- **未来 Rust owner：**Runtime Integration（OpenClaw gateway identity）；secret material 的加密/权限 primitive 可复用 Foundation Kernel，但 identity owner 不迁入 Kernel。
- **Rust 重写与性能判断：**用 `ed25519-dalek`/平台安全存储，避免 sync blocking 与竞态；指标：identity recovery、启动 P99、轮换率；oracle：valid/mismatch/corrupt/multi-process fixture。
- **验证 oracle：** valid/mismatch/corrupt/multi-process fixture。
- **证据：**本文件；`modules/runtime-infrastructure-module.ts`、`modules/gateway-bridge-module.ts`。

### runtime-host/composition/license-node-runtime.ts

- **当前 owner：**错误耦合：完整 License 领域状态机、持久化和网络策略置于 composition；非纯 Node adapter。
- **职责与关键 symbols：**`NodeLicenseRuntime`、`validateLicenseKey`、bootstrap/revalidate、AES-GCM secret、cache、hardware/install identity、online/offline policy 和 gate snapshot。
- **旧语义与策略：**本地格式早拒绝；online-required/optional/offline-local 分支；server timeout AbortController；在线失败时可用 cache grace，optional 再降级本地校验；revalidate 指数退避（30m 至 6h、±20%）；全局 gate bootstrap 去重、定时器替换、near-expiry 主动续期。
- **状态、存储与副作用：**进程全局 snapshot/promise/timer/listener/hardware promise；user-data 下 AES-256-GCM license secret、cache、identity JSON；POST license endpoint；读取 Windows registry/macOS ioreg/Linux machine-id；将 sanitized gate 事件回调。license key 不进 snapshot/cache（cache 只 hash），但 `storedKey()` 可返回明文给调用者。
- **并发与性能特征：**bootstrap 只有 started flag，但手动和 timer revalidate 无单飞互斥，可并行写 cache/secret；tmp 写 secret 后先备份、删除旧文件再 rename，非原子且崩溃窗口；硬件 id cache；全局状态使多实例共享。
- **调用/依赖边界：**operations module 仅 license 分支注册 runtime/service，并将 sanitized gate event 经 parent transport 发出；直接依赖 Node env/fs/crypto/fetch/child process，而不经 runtime ports。
- **故障、恢复与安全：**读密文/缓存失败吞为 null；腐坏密文可用内存最近成功 key 自愈；server error 映射代码；timer retry；clear 删除 secret/cache。AES material 由 product/install id 派生，非 OS keystore；备份 `.bak` 有相同密文敏感性；消息可能包含网络 error 文本。
- **迁移分类：**Preserve：policy modes、validation codes、cache grace/expiry/device binding、sanitized gate、retry timing；Intentional Improvement：把 License 领域状态机迁 Domain Module，platform secret store/atomic write/async singleflight 放 Foundation；Defect：直接 Node globals 与多 revalidate 写竞争；待验证：builtin endpoint/product、backup 保留、offline fallback 都是产品契约还是过渡策略。
- **未来 Rust owner：**License Domain Module；secret encryption/key storage、timer primitive 归 Foundation Kernel；HTTP/device adapter 归 Runtime Integration。绝不塞入 Platform Core。
- **Rust 重写与性能判断：**license actor 串行状态迁移；keyring 加密；atomic durable replacement；保留 network/cache decisions。指标：并发 revalidate、crash recovery、secret exposure、next-retry accuracy；oracle：license fixtures、clock/fault injection、offline differential trace。
- **验证 oracle：** license fixtures、clock/fault injection、offline differential trace。
- **证据：**本文件；`modules/operations-application-module.ts`、license service contract。

### runtime-host/composition/modules/acp-connector-module.ts

- **当前 owner：**机械 composition；把 ACP concrete protocol connector 贡献进 agent runtime。
- **职责与关键 symbols：**`createAcpConnectorRegistrationFactory`、`registerAcpConnectorModule`。
- **旧语义与策略：**每次 contribution resolve 创建 `AcpProtocolAdapter`、endpoint templates 与 stdio transport factory；没有配置分支。
- **状态、存储与副作用：**仅 DI contribution `runtime.connectorRegistrationFactories`；实际 stdio process 由之后 connector 使用时产生；无 job/lifecycle/secret/log。
- **并发与性能特征：**contribution 每次 resolve 新 factory/object；通常 startup 一次；无 cleanup registration。
- **调用/依赖边界：**system registry `acp-connector` infrastructure stage；agent runtime module resolve contributions 后注册 connector。
- **故障、恢复与安全：**注册本身不失败（除 token conflict）；transport lifecycle 不在此文件闭环。
- **迁移分类：**Preserve：ACP 在 capability registry 的可发现 connector；Intentional Improvement：显式 Runtime Integration manifest 声明 process shutdown owner；待验证：connector factories 是否可安全多次实例化。
- **未来 Rust owner：**Runtime Integration（ACP）；Foundation Kernel 仅保留 multi-binding mechanics。
- **Rust 重写与性能判断：**静态 connector descriptor+factory，避免重复无谓构造；oracle：agent runtime connector discovery/integration test。
- **验证 oracle：** agent runtime connector discovery/integration test。
- **证据：**本文件；`agent-runtime-module.ts`、`runtime-host-runtime-module-registry.ts`。

### runtime-host/composition/modules/agent-runtime-module.ts

- **当前 owner：**错误耦合：Agent Runtime 的 registry/capability routing 构造在 composition；实体业务能力不应由 Foundation 持有。
- **职责与关键 symbols：**注册 `agentRuntime.registry`、`agentRuntime.capabilityRouter`、`agentRuntime.application`；`resolveAgentRuntimeModule`。
- **旧语义与策略：**先以 adapter/connector contributions 建 registry，再创建 router；router 固定包含 agent-run routes 并 flatten 其他 capability contribution；application 组合 registry/router。
- **状态、存储与副作用：**container singleton 内存 registry/router；adapter/connector 可能含 runtime side effect；无存储/secret/log/job/lifecycle 注册。
- **并发与性能特征：**contributions 每次 resolve 建造；capability operation array 每次 `operations()` 调用重新展开；无锁，取决于 runtime registry 内部。
- **调用/依赖边界：**依赖 gateway chat/RPC、ACP/OpenClaw/Matcha adapter contributions、session/external/openclaw/operations route contributions；其 token 是大量上层 Domain Module 的契约。
- **故障、恢复与安全：**重复 adapter/connector 的拒绝语义在 registry 之外；缺 gateway/contribution 解析 throw；无 cleanup。
- **迁移分类：**Preserve：adapter/connector discovery 与 capability route aggregation；Intentional Improvement：Matcha Platform Core 应拥有跨 runtime identity/capability grammar 和 registry facade，具体 adapter 在 Runtime Integration，不能变为 R2 God module；待验证：dynamic route list 是否允许运行时变化。
- **未来 Rust owner：**Matcha Platform Core（registry/capability grammar）+ Runtime Integration（各 concrete factory）；composition 仅 wiring。
- **Rust 重写与性能判断：**typed `Vec<Arc<dyn Connector>>` 在 boot 固化，按需 capability lookup；指标：capability lookup、启动构建、注册错误；oracle：registry/capability route tests。
- **验证 oracle：** registry/capability route tests。
- **证据：**本文件；system manifest 和 `session-runtime-module.ts`。

### runtime-host/composition/modules/external-connectors-application-module.ts

- **当前 owner：**错误耦合：External Connector domain store/probe/service 和 route contribution 在 composition 集中构造。
- **职责与关键 symbols：**注册 JSON store/repository/MCP catalog/connection probe/service，贡献 capability routes，注册 facade/routes。
- **旧语义与策略：**存储依赖 runtime data root+filesystem，catalog 读 environment，probe 使用 HTTP+clock；service 将 connector 变更接到 agent runtime registry。
- **状态、存储与副作用：**外部 connector JSON、环境读取、HTTP probing；注册 API route 与 capability provider；无 job/lifecycle。
- **并发与性能特征：**全为 lazy singleton；网络 probe 由 service 调度；无本文件锁、队列或 cleanup。
- **调用/依赖边界：**application manifest `external-connectors` 声明这些 imports/exports；OpenClaw module connect 阶段注册其 downstream projection/status provider。
- **故障、恢复与安全：**DI 缺失上抛；本文件没有 secret redaction，具体 connector credential 归领域实现；没有 store migration/cleanup。
- **迁移分类：**Preserve：Connector storage、MCP program catalog、registry/capability integration、route facade；Intentional Improvement：Domain Module 明确 owns connector facts/storage，OpenClaw projection 留 Runtime Integration；待验证：store schema/concurrency 在范围外。
- **未来 Rust owner：**External Connector Domain Module；HTTP/environment adapter 为 Runtime Integration/Foundation ports。
- **Rust 重写与性能判断：**不要因 wiring 重写做性能宣称；对 JSON store 采用领域定义的 atomic persistence。指标/Oracle：connector CRUD、probe timeout、OpenClaw downstream sync。
- **验证 oracle：** connector CRUD、probe timeout、OpenClaw downstream sync。
- **证据：**本文件；`runtime-host-module-registry.ts`、`openclaw-application-module.ts`。

### runtime-host/composition/modules/gateway-bridge-module.ts

- **当前 owner：**错误耦合：OpenClaw gateway client fallback、endpoint control 和 cleanup 被 composition 承担；应为 Runtime Integration。
- **职责与关键 symbols：**gateway client construction、unavailable client、`gateway.endpointControlState`/`bridgeClient`/`runtime`/`bridge` 注册、`setSessionRuntime` 与 lifecycle cleanup。
- **旧语义与策略：**gateway port parse 失败不阻断 boot，改注册 unavailable client，所有 RPC/readiness 返回明确 unavailable/throw；bridge 在 connect 后才注入 session runtime；cleanup 调 client close。
- **状态、存储与副作用：**closure 中 `sessionRuntimeService`；读取 env port/settings token/device identity，建立 gateway transport；logger；注册 `gateway.bridge` cleanup lifecycle。
- **并发与性能特征：**session runtime mutation 单变量，无同步；client lazy singleton；endpoint resolution 强制恰好一个 runtime.host capability；没有 reconnect worker 管理于本文件。
- **调用/依赖边界：**system manifest imports OpenClaw gateway data/factory/settings、agent registry、dispatch route；session module connect 调 `setSessionRuntime`。
- **故障、恢复与安全：**invalid port 降级而非 crash；gateway token 延迟 async read；unavailable error 原样 message；close 为同步、cleanup 函数未 await（但现有 API是 void）。
- **迁移分类：**Preserve：未配置 gateway 的可诊断 degraded port、session 后连接、close lifecycle；Intentional Improvement：OpenClaw adapter actor 管理 connection/readiness/recovery，避免 composition closure；待验证：parse error 降级而非 boot fail 的产品要求。
- **未来 Rust owner：**Runtime Integration（OpenClaw gateway）；lifecycle registration primitive 归 Foundation Kernel。
- **Rust 重写与性能判断：**一个 gateway actor 维护 session binding/connection state，显式 shutdown await；指标：degraded response、close time、reconnect race；oracle：invalid port/readiness/cleanup integration tests。
- **验证 oracle：** invalid port/readiness/cleanup integration tests。
- **证据：**本文件；`runtime-host-runtime-module-registry.ts`、`session-runtime-module.ts`。

### runtime-host/composition/modules/openclaw-application-module.ts

- **当前 owner：**错误耦合：单个 composition module 组装 channels/providers/settings/skills/subagents/ClawHub/external MCP projection 等多个 Domain Module，成为 wiring 的业务聚合点。
- **职责与关键 symbols：**`registerOpenClawApplicationServices`、connect、capability route contribution、15 类 job definitions、4 个 background services；OpenClaw provider model normalizer 与 stable config hash。
- **旧语义与策略：**每类业务 workflow/repository/service 以 lazy token wiring；facades 暴露 settings/provider/channel/openclaw/skills/subagent/clawhub；connect 阶段把 external connector 注册为 OpenClaw projection/status provider；job payload 对部分 string/object 必填字段 fail-fast；background start 不 await任务结果。
- **状态、存储与副作用：**provider/channel/settings/skills/subagent/OpenClaw config 的实际存储都在下游；HTTP、gateway、parent shell/gateway events、logger、runtime task queue；注册 provider capability routes 与 job/lifecycle。provider credentials 经 store/projection workflow，不在此文件直接 log/持久化。
- **并发与性能特征：**容器 lazy singleton；jobs 统一 queue concurrency；background channel/skill/external sync fire-and-forget；`stableStringify` 递归排序对象用于 hash，成本 O(n log n) key sort，无 cycle guard。
- **调用/依赖边界：**application manifest `openclaw` 的 imports/exports/connectImports 表示其依赖系统 OpenClaw infrastructure、gateway、plugins、runtime ports，并与 external connectors 相连；routes 由独立 route module 注册。
- **故障、恢复与安全：**job handlers 仅局部 input 验证，错误由 job queue 记录/retry；parent event emit rejection 吞掉；业务 recovery 在下游；manifest 不能证明 provider secret、OpenClaw config 或每一 projection 的真实 owner。
- **迁移分类：**Preserve：各 service 的 port wiring、capability/API facade、job names/payload validation、background triggers；Intentional Improvement：按 Provider、Channels、Settings、Skills、Subagent、External Connector Domain Module 拆 manifest，OpenClaw-specific projections 放 Runtime Integration；Defect：composition 模块跨越过多领域（结构事实）；待验证：每个 background trigger 的幂等性。
- **未来 Rust owner：**各 Domain Module + OpenClaw Runtime Integration；Foundation 只保留 job/lifecycle mechanics，Platform Core 仅能力 grammar，不能接收此聚合。
- **Rust 重写与性能判断：**按领域独立 construction bundle，不做“大 OpenClaw service”替代；对 stable config hash 保留 canonicalization 并测试 cycle/large config。指标：boot coupling、config sync latency、job success/retry；oracle：各领域 route/job fixture 与 OpenClaw projection differential。
- **验证 oracle：** 各领域 route/job fixture 与 OpenClaw projection differential。
- **证据：**本文件；`runtime-host-module-registry.ts` openclaw manifest、`openclaw-route-module.ts`。

### runtime-host/composition/modules/openclaw-infrastructure-module.ts

- **当前 owner：**错误耦合：一个 infrastructure registration 文件既是 OpenClaw Runtime Integration adapter registry，又将 provider/channels/settings/security/usage/file/session/skill 等领域 storage port 投射到 OpenClaw 路径。
- **职责与关键 symbols：**`registerOpenClawInfrastructure` 注册 OpenClaw environment/config/auth/workspace/projections、gateway factory、platform driver、provider stores、channel/plugin/settings/skill/ClawHub 等数十 token；辅助 factory 编码路径/投影规则。
- **旧语义与策略：**环境布局按 explicit env→resources→node_modules，config dir env→`~/.openclaw`；以 `createRequire` 从 OpenClaw package resolve channel modules；runtime adapter contribution；provider key/policy、auth/config projection 统一映射到 OpenClaw。
- **状态、存储与副作用：**实际 OpenClaw config/auth/workspace/filesystem、process env、动态 module resolution、HTTP/CLI/FS adapters；注册 provider projections（潜在 credentials）、security policy storage/plugin config、usage transcript layout、session resolver。logger 注入到若干 workflow。
- **并发与性能特征：**所有实例 lazy；多处 factory 重复取 environment/config；路径候选数组与 `createRequire` 在被调用时产生；没有 file lock 或 init cleanup。动态 require/文件系统成本集中在首次 use。
- **调用/依赖边界：**system manifest `openclaw-infrastructure` 声明大量 exports，是 gateway/plugin/application modules 的外部依赖来源；它直接 import 许多 Domain Module ports，反映反向耦合。
- **故障、恢复与安全：**invalid/missing runtime module resolve 会在使用时抛；env 路径可改变 data owner；provider auth/config 的 secret handling 留下游；本层没有全局 secret redaction/rotation/atomic owner validation。
- **迁移分类：**Preserve：OpenClaw layout precedence、runtime module resolution、specific projection policy、native adapter identity；Intentional Improvement：每个 Domain Module 定义自己的 storage/projection port，OpenClaw adapter crate 实现它们，禁止 OpenClaw registry 拥有业务 facts；Defect：跨领域 storage projection hub；待验证：所有候选路径的发行兼容性。
- **未来 Rust owner：**Runtime Integration（OpenClaw adapters）；各 storage/fact owner 仍是 Provider/Channel/Settings/Security/Usage/Session/Skill Domain Module；Foundation 仅文件/secret primitives。
- **Rust 重写与性能判断：**以 typed adapter traits、lazy discovery cache 和明确 config namespace 取代 token 大杂烩；指标：packaged/unpackaged resolve、cold start、path failure diagnostics；oracle：Windows/macOS/Linux layout fixture、OpenClaw config projection tests。
- **验证 oracle：** Windows/macOS/Linux layout fixture、OpenClaw config projection tests。
- **证据：**本文件；system manifest exports；`openclaw-application-module.ts` imports。

### runtime-host/composition/modules/openclaw-route-module.ts

- **当前 owner：**机械 composition；仅把已构造的 OpenClaw 相关 application service 投递为 route dependencies。
- **职责与关键 symbols：**`OpenClawRouteServices`、`registerOpenClawRoutes`，依次注册 settings/provider/capabilityRouting/providerModels/channel/openclaw/skills/subagents/clawhub routes。
- **旧语义与策略：**固定 namespace 与 route definition 数组；所有服务由上层 facade 先解析，route module 自身不持有业务逻辑。
- **状态、存储与副作用：**向 route registry 写 handler entries；无 storage、secret/log/provider creation、job/lifecycle。
- **并发与性能特征：**注册 O(route count)，handler invoke 在 route registry 处理；无缓存/并行。
- **调用/依赖边界：**由 application module registry 的 `openclaw.registerRoutes` 调用，deps 来自 facades。
- **故障、恢复与安全：**重复 route key 由 registry 拒绝；route auth/input/error 的真实责任在下游 definition，不在此文件。
- **迁移分类：**Preserve：route namespace 到 domain service 的绑定；Intentional Improvement：Delivery 层声明 typed endpoint table，不把 HTTP contract 塞 Domain/Kernel；待验证：route registration ordering 是否影响 prefix matching。
- **未来 Rust owner：**Delivery；被调 service 留各 Domain Module/Runtime Integration。
- **Rust 重写与性能判断：**静态 route table，无性能问题；oracle：route index/HTTP contract tests。
- **验证 oracle：** route index/HTTP contract tests。
- **证据：**本文件；`runtime-host-module-registry.ts`、`route-registry.ts`。

### runtime-host/composition/modules/operations-application-module.ts

- **当前 owner：**错误耦合：cron/files/platform/security/usage/team/task/toolchain/license 的多领域组装与 job/lifecycle 集中在一个 `operations` module。
- **职责与关键 symbols：**`registerOperationsApplicationServices`（含 license-only 分支）、capability route contribution、`registerOperationsJobs`（cron/security/team/usage/toolchain/platform）、`registerOperationsLifecycle`。
- **旧语义与策略：**license-only 仅装 license runtime/service并回传 sanitized gate event；完整分支装 cron history/jobs、file workflow、platform、security policy、usage、worker-backed TeamRuntime、task、UV；job handler 对关键 ID/source/action 做结构性校验；background 触发 cron list；cleanup fire-and-forget 关闭 team worker。
- **状态、存储与副作用：**cron history/usage/security policy/files/workspace、gateway RPC/security/cron、worker script、parent events、environment settings、shell/command execution；注册 capabilities/jobs/lifecycle/facades。Team worker 和 security/cron 业务事实均不由此文件定义却被这里聚合。
- **并发与性能特征：**job queue 控制并发；worker-backed TeamRuntime 延迟创建；`startCronJobsRefresh`/worker close 使用 `void`，background/cleanup 不等待内部 promise；任务 background manager 轮询也从此注入。
- **调用/依赖边界：**manifest 声明大量跨域 import，导出多数 operation service 与 capability routes；runtime/HTTP modules 通过 facades/route module 消费。
- **故障、恢复与安全：**job queue 负责失败/retry；payload validator 防止部分空 ID；parent event rejection 吞掉；worker close rejection 未被 lifecycle await 捕获（其 outer function同步返回）；security secret/policy 实际保护在下游，manifest 无法验证。
- **迁移分类：**Preserve：每个 job type、input fail-fast、cron refresh、team worker shutdown、license gate event；Intentional Improvement：拆为 Cron、Files、Security、Usage、TeamRun、Tasks、Toolchain、License、Platform 各 Domain Module，worker I/O为 Runtime Integration；Defect：`operations` 是跨域 composition god module；待验证：cleanup 需要 await close 的行为和 cron startup 幂等。
- **未来 Rust owner：**各 Domain Module；Team/OpenClaw worker bridge 为 Runtime Integration；Foundation 仅 job/scheduler mechanics；Platform Core 不承接 domains。
- **Rust 重写与性能判断：**按 domain actor/worker supervisor 分拆，显式 await shutdown；消除中心 wiring 的 blast radius而非声称吞吐提升。指标：boot dependency graph、worker teardown、job queue latency；oracle：job fixtures、cron/security/team fault injection。
- **验证 oracle：** job fixtures、cron/security/team fault injection。
- **证据：**本文件；`runtime-host-module-registry.ts` operations manifest；`core/jobs.ts`/`core/lifecycle.ts`。

### runtime-host/composition/modules/operations-route-module.ts

- **当前 owner：**机械 composition；将 cron/file/license/toolchain/security/platform service 绑定为 HTTP routes。
- **职责与关键 symbols：**`OperationsRouteServices`、`registerOperationsRoutes`。
- **旧语义与策略：**固定 `cron_usage`、`files`、`license`、`toolchain_uv`、`security`、`platform` namespace；无其他策略。
- **状态、存储与副作用：**仅 route registry 写入；不创建 secret/provider/job/lifecycle。
- **并发与性能特征：**O(route count) startup，无并发控制。
- **调用/依赖边界：**application registry routes stage，services 经 operations facade 解析。
- **故障、恢复与安全：**duplicate key 由 registry 拒绝；auth/error mapping 在 route definitions。
- **迁移分类：**Preserve：delivery bindings；Intentional Improvement：Delivery route table 对应各 domain API；待验证：namespace 是公开 API compatibility surface。
- **未来 Rust owner：**Delivery。
- **Rust 重写与性能判断：**无证据需要优化；oracle：HTTP route contract/404 matcher tests。
- **验证 oracle：** HTTP route contract/404 matcher tests。
- **证据：**本文件；`runtime-host-module-registry.ts`、`route-registry.ts`。

### runtime-host/composition/modules/platform-runtime-module.ts

- **当前 owner：**错误耦合：Platform Runtime 的 in-memory state ledgers/workflows 被 composition root 构造；但跨 runtime execution grammar 的真实 owner 是 Platform Core。
- **职责与关键 symbols：**注册 tool registry/ledgers/policy/audit/event bus/runtime driver/reconciler/workflows/services，`createRuntimeHostPlatformFacade`。
- **旧语义与策略：**runtime driver 由 `platform.runtimeDriverFactory`（当前 OpenClaw integration）制造；facade 暴露 health/tool install/reconcile/run/abort/list/upsert/enable/execute；audit/event/state ledger 都本地内存。
- **状态、存储与副作用：**多个 singleton in-memory ledger/bus/audit；runtime driver 调 gateway；无持久 storage、secret/log/job/lifecycle 注册。
- **并发与性能特征：**状态对象无锁/actor；tool registry/ledgers由下游同步访问；facade async 转发；restart 后内存 state 消失。
- **调用/依赖边界：**system `platform-runtime` imports gateway runtime/driver factory，exports driver/facade；operations module 消费 `platform.facade`。
- **故障、恢复与安全：**缺 driver factory/gateway 在 resolve 时 throw；无 lifecycle cleanup/persistence/replay；audit 不是 durable fact source。
- **迁移分类：**Preserve：execution facade、runtime driver seam、tool reconciliation semantics；Intentional Improvement：Matcha Platform Core 拥有 identity/capability/execution/receipt grammar，Domain Module owns domain tool facts，Foundation owns durable task/fact mechanisms；待验证：in-memory-only ledgers 是否故意临时。
- **未来 Rust owner：**Matcha Platform Core（跨 runtime facade/protocol）；Runtime Integration 实现 OpenClaw driver；不能演化为 God module。
- **Rust 重写与性能判断：**actor/typed state store只在需要持久/recovery时引入；先定义 receipt/replay oracle。指标：tool reconcile latency、restart recovery、event loss；oracle：platform workflow tests/differential gateway trace。
- **验证 oracle：** platform workflow tests/differential gateway trace。
- **证据：**本文件；`openclaw-infrastructure-module.ts` driver factory、operations module。

### runtime-host/composition/modules/plugin-runtime-module.ts

- **当前 owner：**错误耦合：Plugin domain workflow/registry/job/lifecycle wiring 位于 composition；不能迁入 Foundation。
- **职责与关键 symbols：**注册 companion skill/lifecycle workflows/repository/jobs/registry/runtime facade；refresh/set-enabled job definitions；catalog-refresh background service。
- **旧语义与策略：**enabled IDs 与 injected catalog 来自 env 并经 policy parse；set-enabled payload 过滤 string、去重或删除；refresh 执行 registry；background 只 enqueue refresh。
- **状态、存储与副作用：**plugin config/catalog/managed installer/filesystem、gateway control、logger、runtime task jobs；注册 plugin jobs/lifecycle，无 direct secret handling。
- **并发与性能特征：**registry lazy；environment parse boot-time；set enabled 按数组 `includes` 过滤（O(n*m)）；refresh 通过 job queue；background start不 await enqueue。
- **调用/依赖边界：**system module imports OpenClaw plugin infrastructure/gateway/lifecycle；runtime application service consumes plugin runtime/repository；OpenClaw module uses config projection.
- **故障、恢复与安全：**job payload tolerated to empty list；delegated failures job queue；no explicit cleanup; catalog refresh may run after lifecycle stopped only via registry semantics out of scope。
- **迁移分类：**Preserve：plugin catalog/enable job names, policy projection seam, refresh trigger；Intentional Improvement：Plugin Domain Module owns catalog/config facts，OpenClaw plugin adapter owns native install/config projection；待验证：env fallback and injected catalog security policy。
- **未来 Rust owner：**Plugin Domain Module + OpenClaw Native Runtime Edge/Runtime Integration；Foundation only jobs.
- **Rust 重写与性能判断：**use set for enable mutation if large catalogs; retain ordered result semantics. Metrics: catalog refresh, config write, enable mutation; oracle: plugin runtime/job tests.
- **验证 oracle：** plugin runtime/job tests.
- **证据：**本文件；system registry plugin manifest；`core/jobs.ts`/`core/lifecycle.ts`。

### runtime-host/composition/modules/remote-fleet-application-module.ts

- **当前 owner：**错误耦合：Fleet credential/secret resolution、worker/terminal/bootstrap provider wiring 混在 application composition。
- **职责与关键 symbols：**register bootstrap/terminal contributions、`RemoteFleetTerminalManager`、`WorkerBackedRemoteFleetService`、capability routes、lifecycle cleanup/routes；ingress URL validation。
- **旧语义与策略：**ingress env optional；若提供须 HTTPS、无 credentials/query/hash且路径精确；secret chain 先 file credential 再 environment；SSH/Docker/K8s bootstrap与SSH/VM/Docker/K8s/custom terminal providers按贡献顺序；custom provider reads snapshot recursively through fleet service。
- **状态、存储与副作用：**file credential store、env secrets、HTTP/command/timer、worker JS script、terminal sessions、logger；注册 route/capability/lifecycle。credentials 不直接输出但具体 log redaction在下游。
- **并发与性能特征：**worker-backed service；terminal manager provider registry；`remoteFleet.service` 间接被 custom terminal provider resolve，lazy resolution可能形成运行时自引用但在调用 snapshot 时才发生；cleanup uses `void` close for worker，terminal dispose synchronous。
- **调用/依赖边界：**application manifest remote-fleet import runtime ports/agent registry; HTTP server adds ingress and WebSocket terminal; facade exported.
- **故障、恢复与安全：**invalid ingress crashes construction; lifecycle cleanup won't await worker close; secret resolver order explicit; no manifest-level proof of credential encryption/ownership.
- **迁移分类：**Preserve：strict ingress URL, resolver precedence, provider set, worker/terminal cleanup；Intentional Improvement：Fleet Domain Module owns fleet/credential facts, secret store primitive Foundation, transport/worker integration Runtime Integration; await shutdown. 待验证：custom terminal recursive snapshot behavior。
- **未来 Rust owner：**Fleet Domain Module + Runtime Integration; Foundation Kernel for secret/redaction and task/worker mechanics.
- **Rust 重写与性能判断：**supervised worker/terminal actors with bounded streams; no claim until profiling. Metrics: terminal concurrency, worker shutdown, secret lookup latency; oracle: ingress validation, credential, WebSocket and worker fault fixtures.
- **验证 oracle：** ingress validation, credential, WebSocket and worker fault fixtures.
- **证据：**本文件；`runtime-host-server.ts`、`runtime-host-module-registry.ts`。

### runtime-host/composition/modules/runtime-application-module.ts

- **当前 owner：**错误耦合：runtime bootstrap/diagnostics/gateway/plugin/workbench application services are co-wired here; it spans support and runtime orchestration.
- **职责与关键 symbols：**register gateway/plugin/prelaunch/bootstrap/diagnostics/state/runtime/workbench services, capability route, diagnostics/bootstrap jobs, workspace-template lifecycle trigger.
- **旧语义与策略：**prelaunch combines settings/provider/plugins/security/workspace; jobs dispatch to services; lifecycle background submits workspace migration; state service uses injected snapshots/transport stats; facades expose runtime/gateway/plugin/workbench.
- **状态、存储与副作用：**filesystem/config/provider projection/gateway, command executor, parent shell, diagnostics bundle, task queue; job/lifecycle/capability registrations; no direct secret registration, but prelaunch consumes provider/security ports.
- **并发与性能特征：**lazy singleton graph; background submits job without await; state snapshots call plugin registry on query; job work queue controls concurrency.
- **调用/依赖边界：**application manifest imports cross-domain dependencies, exports four services; routes bind runtime endpoints; composition root injects snapshots/transport stats before services stage.
- **故障、恢复与安全：**missing boot dependencies fail lazily; job queue records handler faults; no compensation around prelaunch composition; diagnostics can access environment/process.
- **迁移分类：**Preserve：bootstrap sequencing, diagnostics jobs, health snapshot semantics, migration trigger；Intentional Improvement：separate Runtime Bootstrap/Diagnostics/Workbench Domain services and make provider/security projections explicit dependencies; 待验证：workspace migration exactly-once/dedupe behavior。
- **未来 Rust owner：**Runtime Bootstrap/Diagnostics Domain Modules; Delivery for workbench endpoints; Platform Core only cross-runtime contracts.
- **Rust 重写与性能判断：**use supervised bootstrap task with receipt/idempotency; metrics: boot/prelaunch duration, diagnostics latency, repeated migration; oracle: bootstrap job and health fixtures.
- **验证 oracle：** bootstrap job and health fixtures.
- **证据：**本文件；`runtime-host-composition.ts` injection order；application manifest.

### runtime-host/composition/modules/runtime-infrastructure-module.ts

- **当前 owner：**机械 composition，且含 Foundation primitive binding：把 Node ports、job queue/lifecycle/logger/timer/device identity 组装到 runtime container。
- **职责与关键 symbols：**runtime data root path resolution、`RuntimeHostInfrastructure`、register/resolve infrastructure、job queue cleanup registration。
- **旧语义与策略：**data root precedence env then OS app-data conventions; Node adapters registered lazily; logger `runtime-host-app`; queue gets registry/logger/scheduler/clock; aliases tasks/taskLookup/jobQueries; cleanup stops queue.
- **状态、存储与副作用：**DI registrations、console log sink、Node network/fs/process adapters；job queue/lifecycle are process state；device identity adapter registration；no provider registration。
- **并发与性能特征：**all factories lazy; resolving infrastructure eagerly resolves nearly every adapter; job queue default concurrency 2; data root pure path calculation.
- **调用/依赖边界：**composition root calls first; system infrastructure lifecycle consumes returned object; all modules import these external tokens.
- **故障、恢复与安全：**OS path fallback behavior; queue stop awaits active jobs; adapter construction failures propagate; credentials not owned except gateway identity token.
- **迁移分类：**Preserve：runtime data directory precedence, named ports, queue/lifecycle base availability; Intentional Improvement：Foundation Kernel exposes platform-neutral ports and host supplies implementations; device identity moves OpenClaw integration; 待验证：current root compatibility across packaging.
- **未来 Rust owner：**Foundation Kernel (ports/jobs/lifecycle/log primitives) + Runtime Integration (gateway identity adapter).
- **Rust 重写与性能判断：**explicit host context avoids string DI; retain two-worker default only if workloads require it. Metrics: boot allocations/job throughput/path compatibility; oracle: OS path fixtures, core framework tests.
- **验证 oracle：** OS path fixtures, core framework tests.
- **证据：**本文件；`runtime-host-composition.ts`、`core/jobs.ts`。

### runtime-host/composition/modules/runtime-route-module.ts

- **当前 owner：**机械 composition；runtime/workbench/plugin/gateway delivery bindings。
- **职责与关键 symbols：**`RuntimeRouteServices`、`registerRuntimeRoutes`; runtime host route supplies health/stats/env map/bootstrap plan/jobs and webhook auth.
- **旧语义与策略：**runtime route injects closures rather than full service to select exposed operations; fixed namespaces.
- **状态、存储与副作用：**route registry only; no secret/provider/job/lifecycle registration.
- **并发与性能特征：**constant startup work; closures resolve no new objects.
- **调用/依赖边界：**application registry routes stage; runtime facades from `runtime-application-module.ts` and team auth operations facade.
- **故障、恢复与安全：**route authorization/response policy delegated; exposing `providerEnvMap` makes its redaction contract a downstream concern.
- **迁移分类：**Preserve：public routes and selected facade methods; Intentional Improvement：Delivery layer typed DTO/redaction tests; 待验证：provider env map exposure safety.
- **未来 Rust owner：**Delivery.
- **Rust 重写与性能判断：**no optimization claim; oracle：HTTP contract and secret-redaction integration tests.
- **验证 oracle：** HTTP contract and secret-redaction integration tests.
- **证据：**本文件；`runtime-host-module-registry.ts` routes stage.

### runtime-host/composition/modules/session-route-module.ts

- **当前 owner：**机械 composition；Session and capability/topology routes binding。
- **职责与关键 symbols：**`SessionRouteServices`、`registerSessionRoutes`。
- **旧语义与策略：**session definitions get SessionRuntimeService directly; capability and topology get AgentRuntimeApplicationService.
- **状态、存储与副作用：**only route registration; no job/lifecycle/provider/secret/log.
- **并发与性能特征：**O(route count), no local execution policy.
- **调用/依赖边界：**`sessions` application module creates facades for agent runtime and session runtime, then invokes this route binding.
- **故障、恢复与安全：**registration duplicate failure delegated; auth/input semantics downstream.
- **迁移分类：**Preserve：route/service association; Intentional Improvement：Delivery contracts separated from Session Domain APIs; 待验证：route ordering interaction.
- **未来 Rust owner：**Delivery.
- **Rust 重写与性能判断：**static router table; oracle：session/capability topology route tests.
- **验证 oracle：** session/capability topology route tests.
- **证据：**本文件；`runtime-host-module-registry.ts` sessions module.

### runtime-host/composition/modules/session-runtime-module.ts

- **当前 owner：**错误耦合：Session domain's full storage/state/timeline/execution graph composition lives under runtime-host composition.
- **职责与关键 symbols：**identity resolver; storage/store/catalog/model/timeline/snapshot/ingress/hydration/approval/lifecycle/command/run/prompt workflows/services; capability contribution; catalog/hydration jobs; state flush/catalog refresh lifecycle.
- **旧语义与策略：**stored valid session identity wins, else selects first chat+agent namespace endpoint; supports native vs connector endpoint addresses; session gateway events are emitted best-effort; lifecycle flushes persisted runtime store then starts catalog refresh; jobs route catalog/hydration to service.
- **状态、存储与副作用：**session config/files/transcripts/runtime store, timeline/execution graph in memory, gateway chat/transport, parent session events, logger, runtime task queue; capability/job/lifecycle registration. No direct secret owner.
- **并发与性能特征：**lazy singleton state store shared by flows; operation coordinator mediates operations downstream; first matching endpoint selection is linear over endpoint list and order-sensitive; no cleanup of active session transport beyond workflow's `stopSessionEvents` on lifecycle operation.
- **调用/依赖边界：**system `session-runtime` imports agent registry/OpenClaw session ports; connects to gateway bridge after system modules resolve; operations Team adapter and sessions route facade consume `session.runtime`.
- **故障、恢复与安全：**invalid stored identity falls back silently; unsupported endpoint throws; event emission rejection swallowed; flush errors lifecycle logs/continues; manifest does not prove transcript/fact ownership or worker/session recovery completeness.
- **迁移分类：**Preserve：session identity addressing, persisted-store flush, catalog/hydration jobs, event behavior; Intentional Improvement：Session Domain Module owns timeline/state/storage/recovery; Platform Core owns endpoint/execution address grammar; Runtime Integration resolves OpenClaw artifacts/default model; Defect：domain graph assembled in composition; 待验证：endpoint selection first-match semantics.
- **未来 Rust owner：**Session Domain Module + Matcha Platform Core (address grammar) + Runtime Integration (OpenClaw ports); no Kernel business state machine.
- **Rust 重写与性能判断：**per-session actor with durable fact append/cursor only after defining replay semantics; index endpoint mappings rather than linear scan when needed. Metrics: hydration/replay, flush time, event loss, memory/session; oracle：session unit/e2e fixtures and restart differential.
- **验证 oracle：** session unit/e2e fixtures and restart differential.
- **证据：**本文件；system registry session manifest; `gateway-bridge-module.ts`; operations module.

### runtime-host/composition/parent-transport-client.ts

- **当前 owner：**错误耦合：parent-shell HTTP protocol adapter belongs to Delivery/Runtime Integration, not generic composition.
- **职责与关键 symbols：**`createParentTransportClient`; validates versioned parent response, invokes shell action, emits gateway/job events, maps response.
- **旧语义与策略：**POST JSON with dispatch token header; shell timeout `DISPATCH_TIMEOUT_MS`; event timeout min(dispatch, 3s); shell response strictly validates object/version/status/success/error; events intentionally ignore response body/status.
- **状态、存储与副作用：**HTTP requests with bearer-like dispatch token; AbortController/scheduled cancellation; no local persistence/job/lifecycle/provider/log.
- **并发与性能特征：**each request gets independent timer/controller; concurrent calls independent; JSON serializes arbitrary payload; no retry/backpressure.
- **调用/依赖边界：**composition root constructs it from required env and installs as parent shell/event sink; gateway/session/license/tasks use its methods.
- **故障、恢复与安全：**finally cancels timer; malformed shell response throws; event HTTP errors propagate to caller, but most callers deliberately catch-and-drop; token never logged here but transport error might include URL/text downstream.
- **迁移分类：**Preserve：wire version/token/header/path/timeouts and strict shell response validation; Intentional Improvement：typed parent IPC/HTTP client with explicit event delivery policy/backpressure; 待验证：event non-2xx should be ignored versus propagated (client presently returns after request if client doesn't throw).
- **未来 Rust owner：**Delivery/Runtime Integration; timeout primitive Foundation Kernel.
- **Rust 重写与性能判断：**reuse HTTP client/pool and cancellation token; do not silently add retries. Metrics：request timeout, dropped event count, serialization cost; oracle：transport contract fixtures/fault injection.
- **验证 oracle：** transport contract fixtures/fault injection.
- **证据：**本文件；`runtime-host-composition.ts`.

### runtime-host/composition/plugin-file-system-adapter.ts

- **当前 owner：**错误耦合：Node plugin filesystem concrete adapter is under composition; it is a Native Runtime Edge adapter.
- **职责与关键 symbols：**`NodePluginFileSystem` implements exists/read JSON/list/mkdir/rm/cp/write/signature.
- **旧语义与策略：**read JSON returns null for any read/parse/non-record failure; exists nulls all access errors; remove/copy recursive force; path signature returns null on stat failure.
- **状态、存储与副作用：**direct filesystem mutations and copies; no DI registration by itself, job/lifecycle/log/provider/secret handling.
- **并发与性能特征：**async FS operations; recursive `cp`/`rm` potentially large/unbounded; no atomic write/lock.
- **调用/依赖边界：**OpenClaw infrastructure registers singleton as `plugins.fileSystem`; plugin/channel config projections and plugin module consume it.
- **故障、恢复与安全：**many read existence failures collapse to null/false, writes propagate; recursive remove follows Node semantics; path sandboxing is absent in this adapter and must be enforced by caller.
- **迁移分类：**Preserve：null/false read probes and recursive operations only if callers rely on them; Intentional Improvement：capability-scoped path validation, atomic write and cancellation for bulk copy; 待验证：force remove behavior/permission contract.
- **未来 Rust owner：**Native Runtime Edge (OpenClaw plugin filesystem), using Foundation filesystem primitive.
- **Rust 重写与性能判断：**stream/cancel large copies; metrics：copy size/time, path escape rejection, atomicity; oracle：plugin install/config file fixtures.
- **验证 oracle：** plugin install/config file fixtures.
- **证据：**本文件；`openclaw-infrastructure-module.ts`.

### runtime-host/composition/route-registry.ts

- **当前 owner：**Foundation primitive for route registration/indexing, although it contains Delivery-specific handler adaptation.
- **职责与关键 symbols：**`RuntimeHostRouteRegistry`, canonical route definition key, owner scope, `registerDefinitions/list/index/dispatcher`.
- **旧语义与策略：**key includes namespace/method/exact/prefix/regex; duplicate key rejected by core registry; each handler catches exception and converts to 500 `{success:false,error:String(error)}`; dispatcher built from current index.
- **状态、存储与副作用：**in-memory handler registry/owner map; route definition invocation may side-effect downstream; no job/lifecycle/provider/secret direct registration.
- **并发与性能特征：**index rebuilt whenever `index()`/`dispatcher()` called; route list maps all entries; no dynamic mutation synchronization. Error string can allocate/leak message.
- **调用/依赖边界：**created by runtime-route-composition; module registry associates registration owner; HTTP `/dispatch` consumes dispatcher.
- **故障、恢复与安全：**empty owner/duplicate key throws; handler error swallowed into 500 data; no structured redaction/error mapping in this layer.
- **迁移分类：**Preserve：unique route key, matcher binding, route owner diagnostics; Intentional Improvement：Delivery error taxonomy/redaction, immutable compiled route table after boot; Defect：`String(error)` can expose internals if route error is returned; 待验证：clients depend on exact 500 body.
- **未来 Rust owner：**Delivery; registry mechanics can use Foundation Kernel primitive but HTTP semantics remain Delivery.
- **Rust 重写与性能判断：**compile route trie/index once after registration; preserve matcher priority. Metrics：dispatch P50/P99, route table build, redaction; oracle：route index/dispatcher/error tests.
- **验证 oracle：** route index/dispatcher/error tests.
- **证据：**本文件；`runtime-route-composition.ts`、`runtime-host-server.ts`.

### runtime-host/composition/runtime-host-composition.ts

- **当前 owner：**机械 composition root; it owns startup ordering, not domain state.
- **职责与关键 symbols：**`createRuntimeHostProcess`, required env validation, wiring of container/infrastructure/system/application/routes/jobs/lifecycle/server/runner.
- **旧语义与策略：**strict parent URL/token; default port when parse fails; described fixed phase order; job done/progress upstream delivery errors dropped; validates both module registries before server construction.
- **状态、存储与副作用：**creates process-local DI graph, parent HTTP transport, server and runner; registers snapshot/transport/parent values; starts no listener until returned `start`; provider/secret registrations delegated.
- **并发与性能特征：**eagerly resolves core system modules/facades/terminal manager, then lazily retains many services; initialization serial; no rollback/dispose if a later phase fails; job queue event emits independently.
- **调用/依赖边界：**main entrypoint upstream; drives every file in this audit's registration chains; HTTP server downstream.
- **故障、恢复与安全：**missing parent env fails boot; invalid module owner/import fails before listen; partially constructed worker/client resources may leak on setup error because no lifecycle stop in catch; dispatch token enters HTTP headers only.
- **迁移分类：**Preserve：phase order, parent transport requirement, validation-before-listen, lifecycle runner API; Intentional Improvement：Rust bootstrap plan with dependency DAG and rollback guard; Defect：no compensation for failed post-registration bootstrap; 待验证：whether port parse fallback is expected for malformed values.
- **未来 Rust owner：**Foundation Kernel composition/bootstrap mechanism; each constructed slice stays its proper owner.
- **Rust 重写与性能判断：**construct RAII resource graph then commit listener; reduce partial boot leaks, not speculative speed. Metrics：boot time/failure cleanup/resource leaks; oracle：missing env/module failure/worker leak fault tests.
- **验证 oracle：** missing env/module failure/worker leak fault tests.
- **证据：**本文件; CodeGraph composition chain; system/application registries.

### runtime-host/composition/runtime-host-infrastructure-adapters.ts

- **当前 owner：**Foundation primitive implementations for this Node host; concrete process/fs/network adapters are host Runtime Integration details.
- **职责与关键 symbols：**Node HTTP/process/environment/command/filesystem/id/clock/log/scheduler/TCP probe/timer adapters.
- **旧语义与策略：**environment trims env and copies process env; scheduler clamps negative delay; TCP probe resolves once on connect/timeout/error/close; exclusive write uses `wx` and returns false for all errors; filesystem line stream supports bounded streaming by caller.
- **状态、存储与副作用：**direct Node fetch/process/exec/fs/net/console/timers/random; no DI registration itself, jobs/lifecycle/provider/secret owner.
- **并发与性能特征：**execFile async but buffers stdout/stderr per Node default; file reads often whole file; TCP socket cleanup; `NodeRuntimeTimer.sleep` cannot cancel; scheduler tasks one timeout each.
- **调用/依赖边界：**runtime infrastructure module registers every adapter; used throughout modules via runtime ports.
- **故障、恢复与安全：**filesystem exclusive write collapses permission/disk errors to false; TCP probe treats every event after first as harmless; command/process errors propagate; no command sanitization (caller responsibility); console logger emits raw message supplied.
- **迁移分类：**Preserve：port-level results, timer cancellation, TCP single-settlement, OS environment fields; Intentional Improvement：distinguish expected exists from I/O error in exclusive write, cancellation/deadline for sleeps/exec streaming; 待验证：callers rely on false-for-any-error.
- **未来 Rust owner：**Foundation Kernel port contracts; Node implementation is Runtime Integration/host edge.
- **Rust 重写与性能判断：**Tokio async I/O, process output limits/streaming, cancellable sleep; metrics：probe timeout accuracy, command memory, file stream memory; oracle：runtime port contract tests/fault injection.
- **验证 oracle：** runtime port contract tests/fault injection.
- **证据：**本文件；`modules/runtime-infrastructure-module.ts`.

### runtime-host/composition/runtime-host-module-registry.ts

- **当前 owner：**mechanical composition manifest for application modules, but the mega module grouping is an erroneous coupling boundary.
- **职责与关键 symbols：**defines application/route module manifests and phases; exposes services/connect/jobs/lifecycle/routes execution and registration diagnostics/validation.
- **旧语义与策略：**two registry instances share module schema but routes list order differs; each phase wraps registration/resolution owners; application registry validates container/job/lifecycle/route ownership and container+facade resolve edges; routes registry validates facade edges.
- **状态、存储与副作用：**static module arrays and registry objects; calling stages registers DI/jobs/lifecycle/routes; manifests name provider registrations but do not create provider secrets themselves.
- **并发与性能特征：**serial deterministic order; static manifest validation at module registry construction; dynamic resolve edges grow until validation; no parallel boot.
- **调用/依赖边界：**called by application-services, route composition, composition root; delegates to module files and `core/registry.ts`.
- **故障、恢复与安全：**module stage failure is annotated with module/stage then throws; validation only as described in preface; no cleanup after a failed stage.
- **迁移分类：**Preserve：declared dependency graph, phase/owner instrumentation, validation before listen; Intentional Improvement：split manifests by actual domains and generate typed graph; Defect：application `openclaw`/`operations` ownership scope is too broad; 待验证：all runtime resolves occur while owner context is active.
- **未来 Rust owner：**Foundation Kernel for manifest mechanics; manifests belong to each Domain Module/Runtime Integration crate, not a Platform Core God module.
- **Rust 重写与性能判断：**compile-time composition plus runtime diagnostic graph; preserve serial dependency order. Metrics：undeclared dependency detection, boot errors, manifest drift; oracle：core framework and implementation-boundary tests.
- **验证 oracle：** core framework and implementation-boundary tests.
- **证据：**this file; `core/registry.ts`; `runtime-host-composition.ts`.

### runtime-host/composition/runtime-host-runner.ts

- **当前 owner：**mechanical composition runner; server lifecycle bridge.
- **职责与关键 symbols：**`RuntimeHostServerRunner.start/shutdown`, signal binding, server cleanup registration.
- **旧语义与策略：**register cleanup and bind SIGTERM/SIGINT once; start listens only localhost then marks running/starts background; server error marks lifecycle error; shutdown is single-flight, marks stopping then lifecycle stop, optional process exit.
- **状态、存储与副作用：**in-memory shutdown promise/flags; Node HTTP listener and process signal handlers; lifecycle/log/process control; no provider/secret/job registration except server cleanup lifecycle.
- **并发与性能特征：**single-flight shutdown; `start` lacks an equivalent start promise/guard, so concurrent starts can invoke `listen` twice; signal callbacks fire-and-forget shutdown.
- **调用/依赖边界：**composition root constructs after HTTP server; lifecycle owns cleanup ordering.
- **故障、恢复与安全：**listen error listener is removed on success/error; signal handler errors not surfaced; process exit after cleanup; server close may wait for open connections per Node.
- **迁移分类：**Preserve：localhost binding, lifecycle state order, idempotent shutdown, signal behavior; Intentional Improvement：single-flight start and graceful connection deadline; Defect：no concurrent-start guard (code fact); 待验证：whether process exit is always desired by embedding main.
- **未来 Rust owner：**Delivery/host runtime supervisor, using Foundation lifecycle primitives.
- **Rust 重写与性能判断：**supervisor state machine; metrics：shutdown duration/connection drain, duplicate start behavior; oracle：signal/listen failure tests.
- **验证 oracle：** signal/listen failure tests.
- **证据：**this file; `core/lifecycle.ts`, `runtime-host-server.ts`.

### runtime-host/composition/runtime-host-runtime-module-registry.ts

- **当前 owner：**mechanical system composition manifest, with some erroneous cross-layer module identities (`openclaw-infrastructure`, `matcha-agent-runtime`) encoded together.
- **职责与关键 symbols：**system module interfaces/context, nine module manifests, registry stages, system infrastructure/services/resolve-connect/jobs/lifecycle, validation/diagnostics.
- **旧语义与策略：**serial phases: infrastructure then services then resolve all five modules then connect, later jobs/lifecycle; owner wrapping applies container and job/lifecycle registry; system module resolution order gateway/platform/plugin/agent/session; session connects gateway bridge.
- **状态、存储与副作用：**static registry; each module delegates DI/provider contributions/lifecycle/job registration; `matcha-agent-runtime` contribution factory; no own storage/secrets.
- **并发与性能特征：**serial boot; all core modules resolved eagerly; partial registration remains after stage error; resolver execution builds runtime adapter/connector contributions.
- **调用/依赖边界：**composition root calls every exported phase; `core/registry.ts` validates manifests/runtime edges; application registry treats its system exports as external.
- **故障、恢复与安全：**stage error wraps module/stage; validation runs only near end of composition root; no rollback; module manifest does not prove OpenClaw/provider secret or Session storage ownership.
- **迁移分类：**Preserve：system phase ordering, bridge/session connect after full resolution, owner diagnostics; Intentional Improvement：separate Foundation system manifest from concrete runtime integrations; Defect：system registry conflates generic mechanism and specific runtime wiring; 待验证：eager resolve order dependency.
- **未来 Rust owner：**Foundation Kernel owns manifest runner; OpenClaw/ACP/Matcha adapters each Runtime Integration; Session/Plugin ownership remains Domain Module.
- **Rust 重写与性能判断：**typed boot layers with rollback stack; metrics：system boot time, leakage on failing adapter, validation coverage; oracle：manifest cycle/owner tests and boot trace.
- **验证 oracle：** manifest cycle/owner tests and boot trace.
- **证据：**this file; `runtime-host-composition.ts`, `core/registry.ts`.

### runtime-host/composition/runtime-host-server.ts

- **当前 owner：**Delivery edge; HTTP/WebSocket endpoint composition rather than domain owner.
- **职责与关键 symbols：**transport stats, webhook token timing-safe comparison/body hasher/request id, HTTP health/lifecycle/team webhook/fleet ingress/dispatch router, terminal WebSocket upgrade, server close.
- **旧语义与策略：**binds health GET, lifecycle restart/stop POST, TeamRun webhook path, Fleet ingress path, dispatch POST, else structured 404; webhook failure produces 500 generic message; fleet ingress failure produces 503 rejection; nonterminal upgrade always destroy socket.
- **状态、存储与副作用：**HTTP server/sockets, mutable transport stats supplied by caller, logs warnings; token is SHA-256 hashed then timing-safe compared; no storage/provider/job registration.
- **并发与性能特征：**Node request concurrency; each webhook/ingress async is detached; dispatch handler owns body limits elsewhere; upgrade terminal delegation may hold sockets; `server.close` has no forced socket deadline.
- **调用/依赖边界：**composition root supplies lifecycle, TeamRuntime, Fleet, route dispatcher/terminal manager; runner supplies shutdown cleanup.
- **故障、恢复与安全：**generic webhook error avoids exposing detail to caller but logs string; lifecycle restart simply marks running/start background (does not reconstruct services); stop sends response before detached shutdown; timing-safe auth protects equal-length digest timing.
- **迁移分类：**Preserve：paths/methods/status responses, local server, token constant-time comparison, ingress rejection; Intentional Improvement：Delivery middleware with explicit request body/deadline/socket shutdown policy; 待验证：restart semantics after stopped/error and open WebSocket drain.
- **未来 Rust owner：**Delivery; Team/Fleet services remain Domain Modules.
- **Rust 重写与性能判断：**Axum/Hyper route table and graceful shutdown with connection tracking; metrics：dispatch P99, webhook auth timing, close latency; oracle：HTTP/websocket ingress contract tests.
- **验证 oracle：** HTTP/websocket ingress contract tests.
- **证据：**this file; `runtime-host-composition.ts`, `runtime-host-runner.ts`.

### runtime-host/composition/runtime-host-tokens.ts

- **当前 owner：**Foundation primitive for typed token labels; not owner of the services named by tokens.
- **职责与关键 symbols：**branded `RuntimeHostToken`, trim/validation helpers, `RUNTIME_DISPATCH_ROUTE_TOKEN` and application facade token constants.
- **旧语义与策略：**brand disappears at runtime; all tokens are trimmed strings and empty token rejects; constants standardize service lookup keys.
- **状态、存储与副作用：**no state/side effects; no DI registration, job/lifecycle/provider/secret/log.
- **并发与性能特征：**constant-time string trim; no meaningful cost.
- **调用/依赖边界：**container/facade/registries and composition root use these labels; imports types from many domains, which creates compile-time centrality.
- **故障、恢复与安全：**only empty key throws; type branding cannot prevent colliding raw strings at runtime.
- **迁移分类：**Preserve：stable service identity where TS components interoperate; Intentional Improvement：Rust trait/interface ownership and typed handles eliminate global string namespace; Defect：runtime string token collision remains possible; 待验证：any external code relies on literal keys.
- **未来 Rust owner：**Foundation Kernel composition mechanism; named service APIs remain their domain owner.
- **Rust 重写与性能判断：**zero-cost typed IDs/trait bundles; oracle：manifest/key compatibility tests for remaining bridge boundary.
- **验证 oracle：** manifest/key compatibility tests for remaining bridge boundary.
- **证据：**this file; `container.ts`, `application-service-registry.ts`.

### runtime-host/composition/runtime-route-composition.ts

- **当前 owner：**mechanical composition; builds application route registry and exposes handlers.
- **职责与关键 symbols：**`createRuntimeHostRouteRegistry`, `createRuntimeHostRouteHandlers`.
- **旧语义与策略：**construct new route registry each call, register all module routes under owner/resolution scopes, then return registry/list.
- **状态、存储与副作用：**new in-memory registry and route handler closures; invokes route registration only; no provider/secret/log/job/lifecycle.
- **并发与性能特征：**each call recompiles all route entries/index later; composition root calls once, but exported handler creator duplicates work if callers call it.
- **调用/依赖边界：**composition root makes dispatcher; module registry provides route phase; route registry receives definitions.
- **故障、恢复与安全：**route registration errors propagate; no cleanup.
- **迁移分类：**Preserve：routes only after application services/connect; Intentional Improvement：one immutable compiled delivery router per boot; 待验证：any caller relies on fresh route registry.
- **未来 Rust owner：**Delivery composition, using Foundation manifest mechanics.
- **Rust 重写与性能判断：**avoid rebuild per helper call; metric：route compile allocations; oracle：route ordering/matcher tests.
- **验证 oracle：** route ordering/matcher tests.
- **证据：**this file; `runtime-host-composition.ts`, `runtime-host-module-registry.ts`.

### runtime-host/core/jobs.ts

- **当前 owner：**Foundation primitive; in-memory job registry/queue and scheduling mechanics, not domain job owner.
- **职责与关键 symbols：**`RuntimeJobRegistry`, `RuntimeJobQueue`, progress/checkpoint/yield context, priority queues, dedupe/retry/retention/stop.
- **旧语义与策略：**priority strict `critical→default→low`; default concurrency 2, attempts 1, retry 250ms; dedupe coalesces queued/running and optional cooldown uses last finished; result envelope/drop retention; payload nulled on finish; queue stop cancels timers, fails queued, waits active; yield after 12ms wall time via `setImmediate`.
- **状态、存储与副作用：**all jobs/payloads/results/errors/timers in memory; event sink emits progress/done; logger writes failures; no durable storage, provider/secret registration, lifecycle hook (registered externally).
- **并发与性能特征：**bounded running concurrency but unbounded pending queues/maps; strict priority can starve lower queues; list/latest scan/sort O(n); pending compaction amortized; handler cannot be forcibly cancelled and stop waits indefinitely for active work; `Date.now` rather than injected clock controls yielding.
- **调用/依赖边界：**runtime infrastructure creates registry/queue; modules register owner-attributed definitions; long-task services and background manager query queue; composition installs parent event sink.
- **故障、恢复与安全：**handler error retries only fixed delay/no jitter then records string error; event sink exceptions are not caught in `finish`/progress and can affect queue path; no crash recovery because state volatile; payload may contain secrets until finish and is retained while queued/running.
- **迁移分类：**Preserve：job IDs/status/progress/dedupe/priority/retry/retention semantics; Intentional Improvement：Foundation Kernel durable supervision with cancellation/deadline/backpressure and secret-aware payload policy; Defect：unbounded queue/starvation/no active cancellation are code facts, but product remediation priority is待验证。
- **未来 Rust owner：**Foundation Kernel; domain modules own job definition/payload/fact semantics, Platform Core only shared execution receipt grammar.
- **Rust 重写与性能判断：**bounded channels, weighted fairness, cancellation token, durable receipt/event append if recovery needed; preserve priority/dedupe observable behavior. Metrics：queue depth, wait P99 by priority, memory, shutdown time, lost jobs; oracle：core job tests plus deterministic clock/fault/restart tests.
- **验证 oracle：** core job tests plus deterministic clock/fault/restart tests.
- **证据：**this file; `modules/*` job registrations; runtime infrastructure cleanup.

### runtime-host/core/lifecycle.ts

- **当前 owner：**Foundation primitive; process lifecycle registry/state mechanics.
- **职责与关键 symbols：**definitions helper; `RuntimeHostLifecycle` state, registration owner, background start, reverse stop/cleanup.
- **旧语义与策略：**initial `starting`; mark running/stopping/error; duplicate names reject; `startBackgroundServices` honors env disable, schedules `setImmediate`, starts each at most once, logs and continues on error; stop sets stopped before reverse service stop then reverse cleanup, logs and continues failures.
- **状态、存储与副作用：**in-memory lists/sets/owners/state; logger; Node `process.env` direct read; no storage/provider/secret/job registry.
- **并发与性能特征：**background starts are fire-and-forget, no start promise or readiness; calling restart while pending `setImmediate` can interact by name set; shutdown serial awaits stop/cleanup; unbounded registration lists but boot-fixed normally.
- **调用/依赖边界：**infrastructure creates it; modules add background/cleanup with owner; runner marks state and invokes stop; module registries validate registration owners.
- **故障、恢复与安全：**cleanup failures don't block subsequent cleanup; no timeout/cancellation; cleanup task must be correctly async-returning—`void` wrappers cannot be awaited; state error does not automatically stop resources.
- **迁移分类：**Preserve：unique registration, background-once, reverse teardown, best-effort continuation; Intentional Improvement：Foundation supervisor with readiness, cancellation/deadline and structured shutdown outcome; Defect：background failure only logs and cannot transition lifecycle/trigger remediation; 待验证：desired failure policy.
- **未来 Rust owner：**Foundation Kernel.
- **Rust 重写与性能判断：**join-set/supervisor and ordered Drop/shutdown plan; metrics：service readiness, stop timeout, cleanup failures; oracle：lifecycle unit tests and shutdown fault injection.
- **验证 oracle：** lifecycle unit tests and shutdown fault injection.
- **证据：**this file; `runtime-host-runner.ts`, every lifecycle registration module.

### runtime-host/core/registry.ts

- **当前 owner：**Foundation primitive; generic registry and module manifest validation, not business module owner.
- **职责与关键 symbols：**`RuntimeHostRegistry`, manifest/stage descriptors, `RuntimeHostModuleRegistry` static validation, owner diagnostics, runtime resolve-import validation, cycle detection, ordered `run`.
- **旧语义与策略：**generic key uniqueness; validates id/stage/export/import/connect graphs at construction/register; detects static cycles via DFS; runtime validation only for captured cross-owner resolve edges; stage run preserves declared array order and wraps error context.
- **状态、存储与副作用：**in-memory maps/arrays only; no storage/secret/log/provider/job/lifecycle itself.
- **并发与性能特征：**static validation O(modules+imports+edges); resolve diagnostics may grow in container/facade; DFS recursion can overflow on very deep module graphs (not current scale); no mutation synchronization.
- **调用/依赖边界：**system/application registries instantiate it; route registry uses generic registry; container/facade/lifecycle/job descriptors feed validation.
- **故障、恢复与安全：**fails fast on duplicates/missing imports/stage mismatch/cycles; intentional gaps listed in preface; it does not verify actual domain boundary or secret/storage owner.
- **迁移分类：**Preserve：manifest uniqueness/declarations/cycle detection/owner diagnostics; Intentional Improvement：typed crate manifests plus generated dependency report and explicit resource ownership; Defect：exports can be declared but never registered and unexported registrations pass owner validation; 待验证：whether stricter enforcement breaks current composition.
- **未来 Rust owner：**Foundation Kernel (module composition/manifest mechanics only).
- **Rust 重写与性能判断：**compile-time graph where possible, iterative DFS for arbitrary graphs; metrics：validation duration/drift detection; oracle：core framework/implementation-boundary tests and negative manifest fixtures.
- **验证 oracle：** core framework/implementation-boundary tests and negative manifest fixtures.
- **证据：**this file; `runtime-host-module-registry.ts`, `runtime-host-runtime-module-registry.ts`.

### runtime-host/services/background-task-manager.ts

- **当前 owner：**错误耦合：a task-facing application service is under generic services; its task semantics should align with Task Domain, while job query remains Foundation.
- **职责与关键 symbols：**register/get/list-by-session/wait/cancel/clear/output/stop; maps runtime jobs to background task snapshots.
- **旧语义与策略：**registered tasks override same ID silently; unknown cancel false; cancel marks local cancelled before optional cancel callback; job snapshots map succeeded→completed/failed→failed/all other→running; session lookup combines registered tasks and scans job results for `sessionKey`; wait polls 250ms until terminal/missing/deadline.
- **状态、存储与副作用：**in-memory custom task registrations; queries job queue; timer sleeps; optional callbacks may process/IO; no direct persistence/log/secret/provider/lifecycle registration.
- **并发与性能特征：**polling O(timeout/250ms), no event subscription; `getTasksBySession` scans every registered task and every job, and only checks `job.result.sessionKey` rather than payload; no retention/eviction for registered custom tasks except explicit clear.
- **调用/依赖边界：**runtime infrastructure registers `runtime.backgroundTasks`; operations Task workflow consumes it; job queue serves query port.
- **故障、恢复与安全：**cancel callback errors propagate after status marked cancelled; status getter/output getter exceptions propagate; registered map can leak; raw stdout/stderr/result exposed without redaction.
- **迁移分类：**Preserve：task snapshot facade and job status projection; Intentional Improvement：Task Domain owns task UI/session association, Foundation exposes evented supervision/query; replace polling with receipt/event subscription and redaction policy; Defect：registered task overwrite and unbounded map/scanning are code facts; 待验证：whether IDs intended unique and output may contain secrets.
- **未来 Rust owner：**Task Domain Module for background task projection; Foundation Kernel for job query/timer/event mechanics.
- **Rust 重写与性能判断：**index by session, bounded retention, watch channel for completion; preserve timeout semantics. Metrics：wait wake latency, session listing complexity/memory, output redaction; oracle：task routes/tests and job lifecycle fixtures.
- **验证 oracle：** task routes/tests and job lifecycle fixtures.
- **证据：**this file; `modules/runtime-infrastructure-module.ts`, `modules/operations-application-module.ts`, `core/jobs.ts`.

---

## 完成核对

- **范围数量：**38 / 38 当前存在 `.ts` / `.cjs` 已逐文件记录；`.cjs` 为 0。
- **报告：**`docs/architecture/runtime-host-ts-rust-migration-audit/02-composition-core.md`。
- **未读项：**本分片边界内无；边界外和生成/测试/依赖路径已在开头明确排除。
- **源代码改动确认：**未创建或修改 `runtime-host/composition/**`、`runtime-host/core/**`、`runtime-host/services/**` 的任何源文件、测试或 README；本任务唯一预期新增文件是本报告。工作树中原有的源文件修改不归因于本审计。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **Composition / Core / Services 仍由 TypeScript 语义 owner 保留；Rust cutover 未证实。** `runtime-host/composition/**`、`core/{registry,jobs,lifecycle}.ts` 与 `services/background-task-manager.ts` 没有被 Rust 实现替代的证据。
- **生产 active path：** `runtime-host/main.ts:createRuntimeHostProcess` → `composition/runtime-host-composition.ts:createRuntimeHostProcess` → `RuntimeHostContainer`、system/application module registry、route registry、job/lifecycle registration、`runtime-host-server.ts` / runner。当前修改的 `gateway-bridge-module.ts`、`operations-application-module.ts`、`runtime-application-module.ts`、`session-runtime-module.ts`、两个 module registry、tokens、root/server 仍在该 TS 装配链；新增 `remote-fleet-application-module.ts` 也在此链注册服务、capability contribution、route 与 cleanup。
- **外部旧 owner 与 current-vs-target 边界：** 删除的 Electron `runtime-host-process-manager.ts` 已迁到 `electron/main/process-runtime/runtime-host-process-manager.ts` → `createLocalProcessRuntime` → `RuntimeHostProcessAdapter`，但这只是当前 TS 位置重构。最终 Rust Local Process Host 必须接管其中属于受管 Runtime 的 lifecycle policy、spawn/attach、readiness、restart/backoff、logs、shutdown、process-tree cleanup 与 PID/provenance；Electron 不再是该语义的最终 owner。composition 仍装配 TS Gateway、session、plugin 与 application factories，尚没有 Rust lifecycle/rollback/teardown owner。
- **旧策略与 future owner：** 继续保留 manifest/container/route/job/lifecycle 的既有注册顺序和 failure propagation；Rust Foundation 可承接通用装配与监督机制，Rust Runtime/Integration 承接受管 Runtime lifecycle，Gateway/session/fleet 业务 owner 仍留在各自 Domain/Runtime Integration 边界。Electron 主进程只保留 Delivery composition/client 职责。当前 Rust 等价与 active-path cutover均未证明。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/runtime-host-core-framework.test.ts tests/unit/runtime-host-implementation-boundary.test.ts tests/unit/runtime-host-route-composition.test.ts tests/unit/runtime-host-process-manager-compatibility.test.ts tests/unit/remote-fleet-export-surface.test.ts`；`pnpm run typecheck`；`pnpm run build:runtime-host-process`。本次均**未运行**。
