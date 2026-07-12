# 09 — OpenClaw Runtime / Infrastructure 文件级迁移审计

> **静态审计状态：完成（仅事实走读，未改运行时源码）。** 本文记录的是当前 TypeScript 工作树的迁移证据，不是已批准的 Rust 实施计划。

## 范围、方法与覆盖

- **清单基线：** `00-inventory.md` 的 09 分片列出 23 个文件；以 Python 对 `runtime-host/application/adapters/openclaw/{infrastructure,runtime,gateway}/**/*.ts` 重新枚举，得到 **23** 个现存 `.ts`。两者一致，**无范围差异**。
- **方法：** Python 枚举后完整读取下列每个文件；在存在的 `.codegraph/` 索引上追踪 composition registration、adapter/profile、endpoint/session routing、Gateway、canonical event、approval、config/auth 的调用关系。补充读取的图谱节点为 `composition/modules/openclaw-infrastructure-module.ts`、`agent-runtime/contracts/agent-runtime-registry.ts`、`gateway/gateway-runtime-port.ts`、`workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts`。
- **架构结论：** `registerOpenClawInfrastructure` 贡献 `OpenClawRuntimeAdapter`；registry 先注册 protocol、native endpoint 与 capability descriptors，随后为 native endpoint 以 Gateway port 创建 transport。Gateway bridge 将 OpenClaw conversation/approval 通知按 endpoint/session ingress 到 canonical timeline；配置、workspace、auth profile 和 runtime data layout 则是 OpenClaw 原生文件布局的投影。Endpoint ID、capability descriptor、session identity/correlation 的共同语法应归 **Matcha Platform Core**；本分片保留的 OpenClaw profile、Gateway RPC、事件及文件格式翻译归 **Runtime Integration / Native Runtime Edge**。Foundation 只提供任务监管、secret/redaction 与 I/O 原语，不能取得 OpenClaw 业务 owner。
- **非目标：** 不迁移或重实现 OpenClaw 的 LLM loop、tool harness、sandbox、native approval 执行策略或内部 agent 行为；本分片只适配其已暴露的文件/协议边界。

### 已读文件（23 / 23）

1. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-agent-model-repository.ts`
2. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-profile-store.ts`
3. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-provider-keys.ts`
4. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-store.ts`
5. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-mutex.ts`
6. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository.ts`
7. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository.ts`
8. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-runtime-data-layout.ts`
9. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-subagent-template-service.ts`
10. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-context-merge.ts`
11. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-rules.ts`
12. `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service.ts`
13. `runtime-host/application/adapters/openclaw/runtime/openclaw-approval-adapter.ts`
14. `runtime-host/application/adapters/openclaw/runtime/openclaw-profile.ts`
15. `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter.ts`
16. `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-driver.ts`
17. `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity.ts`
18. `runtime-host/application/adapters/openclaw/runtime/openclaw-session-artefact-resolver.ts`
19. `runtime-host/application/adapters/openclaw/runtime/openclaw-session-metadata-resolver.ts`
20. `runtime-host/application/adapters/openclaw/runtime/openclaw-transport.ts`
21. `runtime-host/application/adapters/openclaw/runtime/openclaw-v4-canonical-adapter.ts`
22. `runtime-host/application/adapters/openclaw/runtime/openclaw-v4-protocol-adapter.ts`
23. `runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge.ts`

## 文件记录

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-agent-model-repository.ts

- **当前 owner：** OpenClaw agent-model 文件存储 workflow 的薄 repository facade；不拥有 provider 或模型业务规则。
- **职责与关键 symbols：** `OpenClawAgentModelRepositoryPort`、`OpenClawAgentModelRepository`；把按 agent 列表 upsert/remove provider model 的请求原样交给 `OpenClawAgentModelStoreWorkflow`。
- **旧语义与策略：** 两个异步操作都透传 workflow 返回的“发生修改的 agent ID”数组；无输入规范化、合并、重试或本地默认值。
- **状态、存储与副作用：** 自身无状态；下游 workflow 才读写 OpenClaw agent model 文件。
- **并发与性能特征：** 无队列、锁、缓存或批次策略；性能和并发语义完全由 workflow 决定。
- **调用/依赖边界：** composition 注册为 `openclaw.agentModelRepository`；provider projection sync 和 provider config workflow 经该 port 操作原生 agent 模型数据。
- **故障、恢复与安全：** 不捕获下游异常；不记录或暴露 key/token，自身无 redaction。
- **迁移分类：** **Preserve：** 返回值和异常透明性。**待验证：** workflow 对部分 agent 失败时是否原子、是否可安全重试。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawAgentModelStore` port 实现；provider 领域只依赖 typed `UpsertProviderModels { agent_ids, provider, entry }` / `RemoveProviderModels` contract。
- **Rust 重写与性能判断：** 以 typed request/result 替换 `unknown` 外泄；由该 edge 在每个 agent 文件 I/O 上使用有界并发（或单 writer）执行，保持当前“具体更新集合”而非虚构批次原子性。无现有成本证据支持更激进优化。
- **验证 oracle：** 使用多 agent fixture 对比 changed-agent list；注入某一 agent 的读/写失败，确认 Rust 不把未证实的成功伪报为已更新；测量 N 个 agent 的 I/O 次数和峰值并发。
- **证据：** 本文件 `OpenClawAgentModelRepository`；`composition/modules/openclaw-infrastructure-module.ts` 注册及 `ProviderProjectionSyncWorkflow` 注入。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-profile-store.ts

- **当前 owner：** OpenClaw auth profile 应用 workflow 的服务 facade；auth profile 的真实变更策略在 `OpenClawAuthProfileWorkflow`。
- **职责与关键 symbols：** `OpenClawAuthProfileService`，并再导出 `removeProfileFromStore`、`removeProfilesForProvider`；暴露 OAuth token 与 API key 的保存、读取、移除。
- **旧语义与策略：** 每个方法仅 await/return workflow；`getOAuthToken` 默认 `main`，其余 agent ID 可省略；无额外认证、缓存或错误转换。
- **状态、存储与副作用：** 自身无状态；调用会透传至 agent `auth-profiles.json` 的读写，因而可处理 access/refresh token 与 API key。
- **并发与性能特征：** 不串行化 auth profile 文件；没有 cache，逐调用 I/O 由 workflow 完成。
- **调用/依赖边界：** composition 注册为 `openclaw.authProfileService`；provider accounts projection 和 provider sync 使用其受限 API，而非直接持有 workflow。
- **故障、恢复与安全：** 未在 facade 捕获错误；不得把 token/key 置入日志、公开 capability response 或诊断包。当前防泄漏要依赖 workflow/logger 和外层 redaction，facade 无机械保障。
- **迁移分类：** **Preserve：** service 与 workflow 间透明的操作、`main` 默认。**待验证：** 多请求同时写同一 auth profile 时的覆盖语义；不能据此宣称 token 写入幂等。
- **未来 Rust owner：** **Native Runtime Edge** 的私有 `OpenClawAuthProfileStore`；Foundation 提供 encrypted-secret/redaction primitive，不能拥有 provider 选择或 OpenClaw profile 语义。
- **Rust 重写与性能判断：** 用不实现 `Debug`/serde 默认脱敏的 `SecretString` 传递 access、refresh、API key；按 agent ID 的 bounded single-writer mailbox（或 transactional file adapter）保护 read-modify-write。这个改进消除并发覆盖窗口，但须明确为 **Intentional Improvement**，不声称外部 Runtime 有 ack/replay/idempotency。
- **验证 oracle：** fixture 覆盖 OAuth/API-key/profile removal；并发同/异 agent 写入 fault test；日志和序列化审计验证 secret 不出现；当前 workflow 单测 `tests/unit/openclaw-auth-profile-store.test.ts` 是起点。
- **证据：** 本文件；`workflows/openclaw-auth/openclaw-auth-profile-workflow.ts`；composition 注册行 464–470（CodeGraph）。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-provider-keys.ts

- **当前 owner：** OpenClaw auth profile provider 名称兼容规则的纯 helper；不拥有 profile 数据或 auth 决策。
- **职责与关键 symbols：** 常量 `AUTH_PROFILE_PROVIDER_KEY_MAP` / reverse map；`normalizeAuthProfileProviderKey`、`expandProviderKeysForDeletion`、`addProvidersFromProfileEntries`。
- **旧语义与策略：** 将 `openai-codex → openai`、`google-gemini-cli → google`；删除时返回给定 key 加其已知 legacy aliases；扫描 records 时仅接受字符串 `provider` 并写入 caller 的 `Set`。
- **状态、存储与副作用：** 模块加载时构造静态 reverse map；后续无 I/O 和网络；唯一外部可见变更是传入 `Set`。
- **并发与性能特征：** O(profile count) 扫描、O(1) map lookup；无可变全局状态（静态 maps 不再修改）。
- **调用/依赖边界：** 被 auth/profile/provider projection 规则用于把 OpenClaw 原始 provider key 映射到产品层候选集合。
- **故障、恢复与安全：** 对非对象/非字符串安全跳过；不涉及 secret，未记录日志。
- **迁移分类：** **Preserve：** 两个 alias 映射、删除扩展顺序和忽略 malformed profile。**待验证：** legacy alias 是否仍为 OpenClaw 所需的完整集合，不能把 map 的局部知识扩大为 Runtime 兼容保证。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawProviderKey` newtype/alias table；产品 provider identity 的共同 grammar 仍属于 **Matcha Platform Core**。
- **Rust 重写与性能判断：** `match`/静态 slice 实现，`BTreeSet` 或 `HashSet` 由调用方选择；无共享可变状态和无 I/O，不需要 actor 或性能重写。
- **验证 oracle：** table-driven fixture：正向归一、反向删除、未知 provider、malformed profiles；基准只需大 profile 集合扫描的线性上界。
- **证据：** 本文件三导出函数；其导入方可由 provider/auth workflows 与 projection rules 的 CodeGraph 引用复核。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-store.ts

- **当前 owner：** OpenClaw `auth-profiles.json` workflow 的 repository facade 与类型再导出；不直接定义认证策略。
- **职责与关键 symbols：** 再导出 `AUTH_PROFILE_FILENAME`、`AUTH_STORE_VERSION`、JSON helpers/types；`OpenClawAuthRepository` 代理 profile path、read/write、agent discovery 与 `openclaw.json` read。
- **旧语义与策略：** 所有方法纯转发；默认 agent 为 `main`。Profile 的 fresh-store fallback、JSON 解析容错、directory 创建和 order/lastGood 规则位于下游 workflow，而不在这里。
- **状态、存储与副作用：** 无本地状态；通过 workflow 读写原生 auth JSON 和列举 `agents/*/agent`。
- **并发与性能特征：** 无锁、cache、批处理；每次请求都进入 workflow I/O。
- **调用/依赖边界：** `OpenClawAuthProfileWorkflow`、provider snapshot/config workflow 依赖该 repository；composition 将 `OpenClawAuthStoreWorkflow` 注入。
- **故障、恢复与安全：** facade 不吞错误；由于返回 store 中的 token/key，它是私有 auth boundary，不能跨公开 API/telemetry。读取失败的“fresh store”恢复行为来自下游，不能被误称为 credential 恢复成功。
- **迁移分类：** **Preserve：** private repository port、默认 `main`、workflow error surface。**待验证：** JSON 写入的 crash consistency 和跨进程互斥；当前证据只有 process 内调用链。
- **未来 Rust owner：** **Native Runtime Edge**；typed `AuthProfilesRepository` 只在 OpenClaw integration 内部暴露，Foundation 提供受监管 secret I/O 与 redaction。
- **Rust 重写与性能判断：** 将 profile union 建模为严格 tagged enum，读路径返回 `Result<Option<_>>`，区分 missing、invalid、I/O；使用 bounded blocking-file executor。不要将当前 JSON helper 的“读失败即空”扩展成 silent credential deletion。
- **验证 oracle：** current-format JSON、缺失、损坏、权限失败及 legacy provider fixture；写中断/rename fault injection；secret-redaction snapshot。
- **证据：** 本文件；`workflows/openclaw-auth/openclaw-auth-store-workflow.ts`（CodeGraph 读到的路径、版本与 fallback）；composition 行 444–452。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-mutex.ts

- **当前 owner：** 单 Node 进程内 `openclaw.json` read-modify-write 的可重入串行化机制。
- **职责与关键 symbols：** module `AsyncLocalStorage<symbol>`、`lockQueue`、`activeToken`；`withOpenClawConfigLock`。
- **旧语义与策略：** 同 async call chain 且 token 等于 active token 时直接重入；其他 task 排入 Promise tail。前一个 task rejection 被 `catch(() => undefined)` 吸收以继续队列；`finally` 清 active token 并 release gate。
- **状态、存储与副作用：** 进程级 mutable queue/token；不直接文件/网络 I/O，但它决定 config repository 写的临界区。
- **并发与性能特征：** 全局单 FIFO-ish Promise chain，无容量上限、取消、deadline 或跨进程锁；重入避免嵌套死锁。长 I/O/用户 mutate 会阻塞所有 config mutation。
- **调用/依赖边界：** 仅由 `OpenClawConfigRepository.updateDirty` / `patchSection` 调用；覆盖所有走这两个 API 的 projection/workflow，不覆盖直接写文件者。
- **故障、恢复与安全：** task 异常仍向本调用者传播，队列继续；`activeToken` finally 清理。没有进程崩溃恢复、文件锁、跨实例互斥或 secret 处理。
- **迁移分类：** **Preserve：** 单进程同调用链重入和异常后续队列继续。**待验证：** FIFO 公平性、跨进程安全。**Intentional Improvement 候选：** bounded command mailbox + deadline/cancellation；必须写明会改变排队/取消可见性。
- **未来 Rust owner：** **Foundation Kernel** 提供通用 keyed async serialization primitive；**Native Runtime Edge** 仅绑定 key `openclaw-config`，不把 OpenClaw 业务状态机下放 Foundation。
- **Rust 重写与性能判断：** 一个有界 `mpsc` single-writer actor 持有 config mutation 请求，提供 reentrancy-free typed composition（避免 `AsyncLocalStorage` token）；blocking file I/O 交给有界 executor。指标：队列深度、wait time、mutation latency；不能宣称跨 Runtime ack/replay。
- **验证 oracle：** 同链嵌套调用、前一 task panic/error、100 个并发 mutation、队列饱和/timeout fault；对比最终 JSON 与 TS 串行 fixture。
- **证据：** 本文件行 1–37；`openclaw-config-repository.ts` 两个 mutation 方法。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository.ts

- **当前 owner：** OpenClaw config JSON 的 read/write、dirty update 和 section patch adapter；不拥有具体 section projection 规则。
- **职责与关键 symbols：** `OpenClawConfigRepositoryPort`、`OpenClawConfigUpdateResult`、`OpenClawConfigPatchResult`、`OpenClawConfigRepository`；`read`、`write`、`updateDirty`、`patchSection` 和三个路径 getter。
- **旧语义与策略：** update 先读，再让 caller mutate 同一 record，仅 `changed` 为真才整份写回；section patch 在 changed 时用 value 覆盖或以 `undefined` 删除顶层 section。两者在 process-local config mutex 内执行；callback 的 result 即便 unchanged 仍返回。
- **状态、存储与副作用：** 自身无 cache；通过 environment/config-file workflow 对 `<OPENCLAW_CONFIG_DIR>/openclaw.json` 读写；整个 config object 是传递给 callback 的可变对象。
- **并发与性能特征：** 全局串行 read-modify-write，整份 JSON I/O/序列化；无版本号、compare-and-swap、跨进程 lock、cache 或 bounded queue（mutex 的 Promise queue 无界）。
- **调用/依赖边界：** 65 个以上 callers（CodeGraph），包括 config sanitizer、plugin/channel/provider/security/runtime projections；composition 将它接至 auth、workspace、session metadata 等 ports。
- **故障、恢复与安全：** read/mutate/write 失败向上抛出；unchanged 不写。此层不 redaction，config 可以含 Runtime auth/config；不应直接记录完整对象。没有恢复/rollback 语义。
- **迁移分类：** **Preserve：** `changed` gating、顶层 `undefined` 删除、callback sees full config、过程内串行。**待验证：** config-file workflow 的 parse/atomic-write 和多进程行为。**Intentional Improvement 候选：** atomic replace/optimistic revision，需以 crash fixture 证明且不可称为 TS 既有语义。
- **未来 Rust owner：** **Native Runtime Edge** 的 typed `OpenClawConfigStore`；每个 OpenClaw section 的 schema/translation也留在 Runtime Integration/Edge。**Matcha Platform Core** 仅保留 endpoint/capability 共用 schema。
- **Rust 重写与性能判断：** 用 typed section patch command 和 bounded single-writer actor；配置文件操作置于 bounded blocking I/O pool，必要时 temp+fsync+rename 作为明确改进。保留“无变更不写”的 I/O oracle，测量 JSON bytes、write count、p95 mutation latency 与恢复时间。
- **验证 oracle：** differential fixture 覆盖 unchanged、replace、delete、callback error；权限/parse/write failure injection；并发 mutation；config 中 secret 的日志/redaction scan。
- **证据：** 本文件；`openclaw-config-mutex.ts`；`composition/modules/openclaw-infrastructure-module.ts` 行 441–443 及多个 projection port 注入。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository.ts

- **当前 owner：** OpenClaw 发行目录、配置目录、Runtime Host 数据文件、bundled tools/plugins/templates/ClawHub 候选路径的环境投影；并代理配置文件与状态 workflow。
- **职责与关键 symbols：** `OpenClawStatusSnapshot`、`OpenClawEnvironmentRepository`；路径和环境 getters、`getOpenClawStatus`、`read/writeOpenClawConfigJson`、`ensureParentDir`、各类候选列表。
- **旧语义与策略：** `MATCHACLAW_OPENCLAW_DIR`、`OPENCLAW_CONFIG_DIR` 及多个 `MATCHACLAW_*` override 优先；`~` 展开为 host home；未配置时 OpenClaw config 默认为 `~/.openclaw`，distribution 依次 resources/openclaw、workingDir/node_modules。候选通过去重、过滤空字符串、resolve 处理；Windows tool 加 `.exe`。
- **状态、存储与副作用：** 无内存业务状态；读取 process/system environment；创建 parent directory；代理 config JSON I/O 和 OpenClaw build status file checks。无 Gateway 网络调用。
- **并发与性能特征：** getter 常数时间，candidate arrays 很小；无缓存，status/I/O 由下游 workflow；无锁。
- **调用/依赖边界：** composition 的核心 OpenClaw native layout provider，派生 settings/provider/models/capability-routing 文件路径、Gateway runtime data、skills/plugins/toolchain/runtime data 和 workspace source ports。
- **故障、恢复与安全：** path getters 不验证候选存在；I/O 错误由 port 传播。`getProcessEnv` 能含 secrets，严禁向 public topology/log/diagnostics 直接投影；此类 class 不做 redaction。
- **迁移分类：** **Preserve：** 环境优先级、home expansion、platform executable 命名、候选排序与去重。**待验证：** `expandHomePath` 对特殊 `~user`、环境输入和 packaged resource layout 的兼容。**Intentional Improvement：** 将 environment snapshot 显式白名单化，避免任意 process env 跨边界。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawEnvironmentLayout`; Foundation 提供受控 env/filesystem capability 与 secret redaction，不拥有路径政策。
- **Rust 重写与性能判断：** 启动时将所需 env 解析为 immutable typed layout，向下游只给最小 typed paths；文件检查走 bounded blocking I/O。可测成本是重复 path resolve/文件 probe；只有 profile 显示热点才 cache。
- **验证 oracle：** Windows/macOS/Linux path fixture、每种 override precedence、packaged/resources 和 dev layout、missing path/permission faults；assert 输出不含 token/完整 env。
- **证据：** 本文件；composition 的 `createOpenClawEnvironmentLayout` 与行 429–443 注册、各 runtime data/skill/plugin port builders。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-runtime-data-layout.ts

- **当前 owner：** OpenClaw runtime data 的诊断 bundle 与 token-usage transcript layout adapter。
- **职责与关键 symbols：** `OpenClawRuntimeDataLayout` 实现 `DiagnosticsRuntimeBundleLayoutPort` / `TokenUsageTranscriptLayoutPort`；helpers `walkFilesRecursively`、`listAgentIdsWithSessionDirs`、`extractSessionIdFromTranscriptFileName`。
- **旧语义与策略：** diagnostics 收集 cutoff 后 runtime logs、所有 agent `sessions.json` 和近期 `.jsonl`、白名单 workspace 文件、extension plugin manifests、且把 `openclaw.json` 标记 `redactJson: true`。Transcript listing 合并 config agent IDs 与实际 directory IDs，排除 deleted JSONL，接受 `.jsonl.reset.*`，最后按 mtime 降序。目录/文件 stat/read/JSON 错误通常跳过相应位置继续。
- **状态、存储与副作用：** 只读 filesystem，返回 bundle entry / transcript metadata；不上传、不删除、不执行 Gateway。`redactJson` 是交给 diagnostics downstream 的意图标记，并非本文件实际 redaction。
- **并发与性能特征：** 深度优先递归、逐项串行 `list/stat`；诊断 entries 与 transcript metadata 全量积在内存，目录深度/文件量无上限；排序 O(n log n)。
- **调用/依赖边界：** composition 以同一实例注册 `usage.transcriptLayout` 和 `diagnostics.runtimeLayout`；外部依赖 `RuntimeFileSystemPort`、diagnostics/token-usage contracts。
- **故障、恢复与安全：** 多数 directory/stat/parse 失败被吞掉（结果不完整而不报错）；config 才标记 JSON redaction，log/jsonl/workspace files 可能含敏感内容，实际 bundle redactor 的覆盖需另行验证。没有 replay/ack 保证。
- **迁移分类：** **Preserve：** 文件选择、cutoff、session filename 排除、mtime 排序、缺失目录 best-effort。**待验证：** `redactJson` 的消费端是否也保护 JSONL/log/workspace secrets。**Intentional Improvement 候选：** 显式 partial-result diagnostics 而非静默遗漏。
- **未来 Rust owner：** **Native Runtime Edge** 的 OpenClaw layout enumerator；diagnostics/usage 领域拥有消费策略，Foundation 只提供 bounded filesystem traversal 与 redaction mechanism。
- **Rust 重写与性能判断：** 使用有界目录遍历/`spawn_blocking` worker pool 和 backpressure，stream entries 给 bundle writer，避免全量递归/累积；保留当前文件集合和排序 oracle。指标：大目录的峰值内存、打开文件数、扫描耗时、遗漏/错误计数。
- **验证 oracle：** synthetic runtime tree 的 differential manifest、deleted/reset filenames、config-vs-directory agent union、missing/stat faults、secret-bearing config/jsonl redaction test、10k files benchmark。
- **证据：** 本文件；`diagnostics-bundle.ts`、`token-usage-history.ts` ports；composition 行 583–587。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-subagent-template-service.ts

- **当前 owner：** OpenClaw subagent template catalog workflow 的 minimal facade。
- **职责与关键 symbols：** re-export template types；`SubagentTemplateService.listCatalog`、`getTemplate`。
- **旧语义与策略：** 无参数 catalog 查询直传；template ID 保持 `unknown` 给 workflow 验证，返回 detail 或 `null`；不做默认、格式变换或缓存。
- **状态、存储与副作用：** 无状态，无直接 I/O；下游依据 environment source candidates 和 filesystem 读模板。
- **并发与性能特征：** 无队列/cache；每次调用下游执行其扫描/读取成本。
- **调用/依赖边界：** composition 将 template workflow 注册后以此 facade 输出给 subagent/workspace API；模板本身属于 OpenClaw 原生资源投影。
- **故障、恢复与安全：** 不捕获 I/O/parse error；ID 不受信任但这里不拼路径。无 secret/redaction 处理。
- **迁移分类：** **Preserve：** `unknown` ID 交给唯一 workflow validator、`null` 缺失结果。**待验证：** template 文件内容的 trust model 和 path traversal 防护必须在 workflow 证实。
- **未来 Rust owner：** **Native Runtime Edge**；typed `TemplateId` parser 位于 template adapter，产品 subagent domain 只消费 catalog/detail contract。
- **Rust 重写与性能判断：** 可一次目录 snapshot + immutable catalog cache，但仅在 template source 变更/invalidation contract 明确后；否则保持每次 discovery。所有 blocking reads 走有界 I/O。
- **验证 oracle：** valid/unknown/malformed ID，candidate precedence、missing directory 与 unreadable file fixture；catalog latency / source scan count benchmark。
- **证据：** 本文件；composition 行 520–527；`workflows/openclaw-workspace/openclaw-subagent-template-workflow.ts`。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-context-merge.ts

- **当前 owner：** MatchaClaw managed context 注入 OpenClaw workspace bootstrap Markdown 的文件 mutation adapter。
- **职责与关键 symbols：** suffix/HTML marker constants；`mergeContextSection`、`stripFirstRunSection`、`mergeWorkspaceContext`、`ContextMergeResult`。
- **旧语义与策略：** 仅处理 contextDir 的 `*.matchaclaw.md`，映射为同名 `.md` target；workspace 或 contextDir 不存在即空结果。若 target 缺失计数；已有 begin/end marker 时替换其间内容，否则尾部追加。仅 `AGENTS.md` 在合并前按启发式删除 OpenClaw `## First Run` section；写入仅在合并产物与原始内容不同。
- **状态、存储与副作用：** 无持久内存 state；读取 context/target、可能写 workspace Markdown，并 info log merged/First Run strip；无网络/Gateway。
- **并发与性能特征：** 目录项和文件逐个串行 I/O；内容整体读入内存；无 lock，两个并行 merge 可产生 lost update。
- **调用/依赖边界：** workspace maintenance workflow 调用；依赖 `RuntimeFileSystemPort` 和 logger，产物是 OpenClaw workspace 提示上下文，不是 Matcha 领域事实。
- **故障、恢复与安全：** context list 失败静默空结果；target/snippet read/write error传播。HTML markers 不是安全边界；inject 的上下文会进入 OpenClaw prompt files，必须把 secret 排除在 snippets 之外；未做 redaction。对 marker 顺序/重复 marker 的行为未验证。
- **迁移分类：** **Preserve：** suffix mapping、missing count、marker replacement/append、conditional write、First Run stripping。**待验证：** malformed/duplicate markers 和 concurrent writer。**Intentional Improvement 候选：** atomic write + per-workspace serialization，同时须保留文本输出 fixture。
- **未来 Rust owner：** **Native Runtime Edge** 的 OpenClaw workspace projection；若 TeamRun context content 有独立事实 owner，内容由相应 **Domain Module** 提供，edge 只写 marker section。
- **Rust 重写与性能判断：** typed `ManagedContextSection`、每 workspace bounded writer actor、temp+rename；不将 Markdown parser/LLM semantics 引入核心。指标：写入次数、lost-update fault、large file memory/latency。
- **验证 oracle：** exact text differential（新文件、已有 marker、First Run、target/context 缺失），read/write failure injection、并发 merge、secret-lint fixture。
- **证据：** 本文件；`OpenClawWorkspaceMaintenanceWorkflow.mergeContextSnippets` 的注入关系；workspace service facade。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-rules.ts

- **当前 owner：** OpenClaw config 到 main/session/task workspace directory 的纯路径解析规则。
- **职责与关键 symbols：** `resolveMainWorkspaceDir`、`resolveWorkspaceDirForSession`、`resolveTaskWorkspaceDirs`；agent/session parsing、home expansion、subagent slug 与 TeamBuddy-root 排除 helpers。
- **旧语义与策略：** main 优先 `agents.defaults.workspace`，再 `agents.list` 中 `main`/`isDefault`，否则 `<config>/workspace`；`agent:<id>:` session 对应配置 workspace，否则 `<config>/workspace-subagents/<slug>`。task roots 以 `Set` 去重并排除 `<config>/teambuddy` 内目录；无效值忽略；纯数字/空 slug 变为 `agent`。
- **状态、存储与副作用：** 无 I/O/网络/global state，输入 config 和 config dir，输出 resolved absolute paths。
- **并发与性能特征：** 对 agents list 线性扫描；`resolveTaskWorkspaceDirs` O(n) Set；无锁/cache。
- **调用/依赖边界：** workspace query/maintenance 通过 config repository 使用；task workspace、session/workspace services 最终消费路径。
- **故障、恢复与安全：** malformed config 容错回退；只阻止 TeamBuddy 内 root 被列入 task roots，不证明其他任意配置路径安全，也不检查 symlink。未涉及 secret/redaction。
- **迁移分类：** **Preserve：** 优先序、`agent:` session grammar、slug fallback、TeamBuddy exclusion。**待验证：** Windows relative/drive/symlink 语义和外部 OpenClaw 对 agents config 的完整解释；不可声称 path policy 等于 sandbox。
- **未来 Rust owner：** **Native Runtime Edge**，将 OpenClaw config shape 解析为 `WorkspaceResolution`; 通用 endpoint/session identity grammar留在 **Matcha Platform Core**。
- **Rust 重写与性能判断：** serde parsed config 的只读 resolver、`PathBuf` canonicalization 需谨慎（不得改变不存在路径的 current behavior）；不需要 actor。对不可信路径的 allowlist/realpath policy若引入，是明确安全改进并需兼容评审。
- **验证 oracle：** precedence、malformed records、subagent names、Teambuddy sibling/child、Unix/Windows path fixtures；N-agent linear scan benchmark。
- **证据：** 本文件行 1–141；workspace query workflow 的 config port。

### runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service.ts

- **当前 owner：** OpenClaw workspace query/maintenance workflow 的 API facade；workspace policy不在其自身。
- **职责与关键 symbols：** `OpenClawWorkspacePort`、`OpenClawWorkspaceService`；配置/skills/preview/main/session/task dirs、workspace initialization/identity/template migration/context merge 的转发。
- **旧语义与策略：** query 与 mutation 依据两个 Pick workflow 分流；所有 async method直接 await，`ensureIdentityFile` 的 options 默认 `{}`；不改写结果、没有额外 validation。
- **状态、存储与副作用：** 自身无 state；maintenance workflow 可以创建目录、写 identity/template/context 文件；query workflow 读 config/filesystem。
- **并发与性能特征：** 无 lock/cache/queue；依赖下游 file operation 的并发语义。
- **调用/依赖边界：** composition 注册 `openclaw.workspaceService`，投影为 session config directory、task workspace、skills workspace 等多类 ports。
- **故障、恢复与安全：** facade 透明传播错误；因 identity/workspace 内容可进入 prompt，不能将其当作 secret store，也不做 redaction。
- **迁移分类：** **Preserve：** read/write API 边界、`ensureIdentityFile` empty options default、workflow 返回 shape。**待验证：** downstream create/write atomicity与并发。
- **未来 Rust owner：** **Native Runtime Edge**；应将 query 和 mutating commands 分成 typed ports，领域端只请求 workspace reference，不能取得 OpenClaw filesystem owner。
- **Rust 重写与性能判断：** `WorkspaceQuery`（read-only）与 bounded `WorkspaceMutation` queue 分离；不添加预读/cache，除非测得反复 config resolution 是瓶颈。记录 I/O、mutation latency 和 partial-write recovery。
- **验证 oracle：** workflow result fixture、createDir true/false、identity/template/context operation failure injection；现有 workspace workflow tests若有应在迁移测试清单中补入。
- **证据：** 本文件；composition 行 471–483、568–571、591–594；各 query/maintenance workflows。

### runtime-host/application/adapters/openclaw/runtime/openclaw-approval-adapter.ts

- **当前 owner：** OpenClaw Gateway approval notification 到 canonical approval event 的协议翻译器；不做/不拥有 OpenClaw approval 的授权或执行。
- **职责与关键 symbols：** `OpenClawApprovalAdapter.translateNotification`；`normalizeRequestedPayload`、`normalizeResolvedPayload`、`normalizeOpenClawApprovalNotification`、时间/command/decision readers。
- **旧语义与策略：** 识别 exec/plugin requested/resolved 四种 method；从 top-level/data/request 兼容读取 ID/session/run/title/command/decisions/timestamps；无 ID 或 session 则保留原 notification 交给 canonical builder。requested 缺 created time 时使用 caller `nowMs`，seconds 量级时间转 ms；allowed decisions 限制为 allow-once/allow-always/deny、去重。最终强制 OpenClaw protocol/endpoint identity。
- **状态、存储与副作用：** 无状态、I/O、网络或 Gateway RPC；仅返回 canonical events。
- **并发与性能特征：** 每通知常数或小数组线性处理；无缓存/队列。
- **调用/依赖边界：** `OpenClawRuntimeAdapter.approvalNotifications` 被 `SessionGatewayIngressWorkflow` 经 registry resolve，然后 canonical timeline commit；canonical approval builder 是跨 runtime consumer。
- **故障、恢复与安全：** malformed payload 安全降级为原 notification，而 canonical builder 决定是否产生 event；保留 `request` 可携带 command/敏感参数，adapter 没有 redaction。没有审批 ack、replay、幂等或 decision enforcement 保证。
- **迁移分类：** **Preserve：** 四 method、嵌套字段优先序、时间归一、decision whitelist、无效 payload 非抛出。**待验证：** OpenClaw 方法/字段演进和 canonical builder 对原 notification 的行为。
- **未来 Rust owner：** **Runtime Integration** 的 typed OpenClaw approval decoder；canonical approval event grammar 属于 session/platform contracts，Foundation 只供应 secret redaction primitive。OpenClaw native approval executor仍留 OpenClaw。
- **Rust 重写与性能判断：** versioned `serde` envelope + explicit `UnknownApprovalNotification` outcome；敏感 `request` 在进入 diagnostics/telemetry 前应用 redaction policy。无 actor需求；吞吐 benchmark 以 malformed/large request decode latency 为准。
- **验证 oracle：** nested/top-level fixture matrix、seconds/ms timestamps、invalid decisions、missing ID/session、exec/plugin differential outputs；fuzz unknown JSON；redaction snapshot。
- **证据：** 本文件；`sessions/canonical/canonical-approval-events.ts` builder；`SessionGatewayIngressWorkflow.consumeEndpointNotification`（CodeGraph）；`tests/unit/runtime-host-pending-approval-store.test.ts` 被图谱标为覆盖关联。

### runtime-host/application/adapters/openclaw/runtime/openclaw-profile.ts

- **当前 owner：** 静态 OpenClaw local runtime endpoint profile 声明。
- **职责与关键 symbols：** `openClawRuntimeEndpointProfile`：ID/protocol/instance/display name、`main` default/dynamic agents、capability flags、agent storage/key namespace。
- **旧语义与策略：** 固定声明 `openclaw-local`、`openclaw-v4`、`local`；宣称 chat/streaming/tools/approvals/replay/modelSelection 能力。该声明不是 Gateway readiness 探测，也不验证具体 RPC method。
- **状态、存储与副作用：** module constant；无 I/O、网络、cache 或副作用。
- **并发与性能特征：** 无。
- **调用/依赖边界：** `OpenClawRuntimeAdapter` 将 profile 放入 `endpoints` 并用它构造 runtime/agent scoped capability descriptors；registry 为 adapter 增加 native `runtimeAdapterId` 后注册 endpoint。
- **故障、恢复与安全：** 无异常/secret处理；静态 `replay: true` 只表达 adapter 具备 transcript replay path，不能据此保证 Gateway transport 的 replay/ack/idempotency。
- **迁移分类：** **Preserve：** endpoint/protocol/instance literals、agent namespace/keying、能力宣告。**待验证：** 每个宣告在不同 OpenClaw version 的实际可用性；Gateway readiness 只检查 base methods。
- **未来 Rust owner：** endpoint ID/capability descriptor 的共同 grammar归 **Matcha Platform Core**；这个 OpenClaw binding/profile归 **Runtime Integration**。
- **Rust 重写与性能判断：** 用 immutable typed `RuntimeEndpointProfile` 注册；capability availability 应由 observed Gateway readiness 覆盖，不把静态 bool 当网络保证。没有性能工作。
- **验证 oracle：** registry snapshot fixture、duplicate native endpoint rejection、capability descriptor snapshot，以及 versioned Gateway capability matrix。
- **证据：** 本文件；`openclaw-runtime-adapter.ts` 行 261–270；`AgentRuntimeRegistry.registerRuntimeAdapter`（CodeGraph）。

### runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter.ts

- **当前 owner：** OpenClaw native runtime 在 Matcha runtime registry 的装配、capability projection 和 transport factory。
- **职责与关键 symbols：** `CAPABILITY_OWNERS`、`openClawEndpointRef`、descriptor builders、`OpenClawRuntimeAdapter`（protocol/endpoints/approvalNotifications/capabilities/createTransport）。
- **旧语义与策略：** 固定 adapter ID；创建 V4 protocol/approval adapter，基于 app/runtime/agent/workspace scopes 组合 descriptors。未知 capability owner 会 throw；target agent metadata由 scope 推导；所有这里列出的 descriptors 标记 native/available。transport 无视传入 endpoint 内容，返回以 Gateway port 构造的 `OpenClawRuntimeTransport`。
- **状态、存储与副作用：** constructor fields 创建一次、无持久存储；注册时向 `AgentRuntimeRegistry` 写 protocol/adapter/endpoint/capability maps；transport 后续产生 Gateway I/O。
- **并发与性能特征：** capabilities 在 construction 时一次性生成；agent IDs 当前一项但 profile 可以扩展；无 queue/cache/lock。
- **调用/依赖边界：** composition 的 runtime adapter registration factory `new OpenClawRuntimeAdapter()`；registry 再将 native endpoint 路由到 `createTransport(... nativePorts.gateway())`。依赖 shared capability/address contracts 和 OpenClaw protocol/transport。
- **故障、恢复与安全：** missing owner fail-fast；重复 adapter/protocol/endpoint 的注册错误由 registry抛出。无 secret。capability `available` 不是 Gateway/RPC 成功保证。
- **迁移分类：** **Preserve：** capability list、scope/owner routing、native endpoint binding、fail-fast unknown owner。**Intentional Improvement：** 将静态 availability 与 observed endpoint readiness分层，以避免过度承诺；必须保留 descriptor ID/scope compatibility。**待验证：** dynamic agent discovery 对 descriptor 刷新的需求。
- **未来 Rust owner：** **Runtime Integration**；`EndpointId`、`RuntimeEndpointRef`、capability/scope/operation descriptor共同语法归 **Matcha Platform Core**，而 OpenClaw-specific binding/transport factory不归核心。
- **Rust 重写与性能判断：** typed registry registration object，descriptor builder保持纯函数；对动态 agent用受控 diff update，不引入无界 subscription。测量 startup descriptor build、registry snapshot稳定性；没有 TS 性能瓶颈证据。
- **验证 oracle：** `tests/unit/capability-registry.test.ts`、`agent-runtime-registry.test.ts`、`runtime-adapter-connector-registry.test.ts` 与 `session-runtime-fixture.ts`（CodeGraph关联）；descriptor/topology differential snapshot、unknown owner/duplicate registration fault。
- **证据：** 本文件；composition `createRuntimeAdapterRegistrationFactory` 行 372–376；registry `registerRuntimeAdapter` 与 `RuntimeTransportRouter`（CodeGraph）。

### runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-driver.ts

- **当前 owner：** 平台级 `AgentRuntimeDriver` 到 OpenClaw bridge/Gateway 操作的适配器；不拥有 OpenClaw tool execution 本身。
- **职责与关键 symbols：** `OpenClawRuntimeBridge` contract、`normalizeToolList`、`OpenClawRuntimeDriver` 的 health/tool lifecycle/execute/abort。
- **旧语义与策略：** health 以 `portReachable` 判 running，并报告 connection state/error；tool catalog接受 array 或 `tools/plugins/items/data/groups` 形状，按 ID 去重、缺省 enabled true/source native；install 取 `toolId`、`id`，否则 source spec；execute 取 `runId`/`id`，缺失时本地拼 `<sessionId>-<randomId>`；abort直传 bridge。
- **状态、存储与副作用：** 无本地持久状态；所有 install/uninstall/enable/disable/start/abort 和连接查询经 bridge 产生 Gateway/平台副作用。
- **并发与性能特征：** list tools O(n) Map dedupe；无重试、queue、cache、lock；操作并发语义由 bridge/Gateway 决定。
- **调用/依赖边界：** composition 注册为 `platform.runtimeDriverFactory`，以 gateway bridge 强转为 `OpenClawRuntimeBridge`；消费 shared platform runtime contracts 与 ID generator。
- **故障、恢复与安全：** bridge错误除 health normalisation外直传；synthetic run ID 只是在 response 缺 ID 时给上层关联，**不证明** OpenClaw 已受理、支持 idempotency 或可由该 ID abort；无 secret handling。
- **迁移分类：** **Preserve：** health mapping、catalog polymorphic parsing/dedup、fallback IDs。**待验证：** fallback run ID 是否可被后续事件关联，缺失真实 run ID 是否为缺陷；不能把它升级为 at-least-once/idempotent 语义。
- **未来 Rust owner：** **Runtime Integration** 的 OpenClaw platform driver；`RunId`/execution receipt/correlation共同模型归 **Matcha Platform Core**，任务 supervision/deadline primitives归 Foundation。
- **Rust 重写与性能判断：** `ToolCatalogPayload` versioned decoder，`StartRun` 返回 `GatewayAccepted { runtime_run_id: Option<_> }` 与 local correlation分开，避免把 fallback 伪装成 Runtime receipt；所有 RPC 放入 bounded client permit。测量 catalog decode和 RPC latency。
- **验证 oracle：** catalog-shape fixture（重复、缺 ID、groups）；Gateway success/error/missing-ID fault；verify returned correlation against ensuing event trace，而非假设 ack。
- **证据：** 本文件；composition 行 500–505；shared `platform-runtime-contracts.ts`；Gateway bridge implementation evidence。

### runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity.ts

- **当前 owner：** OpenClaw adapter/protocol/endpoint/instance 的静态 identity literals。
- **职责与关键 symbols：** `OPENCLAW_RUNTIME_ADAPTER_ID = openclaw`、endpoint `openclaw-local`、protocol `openclaw-v4`、instance `local`。
- **旧语义与策略：** 无派生、校验或 fallback；所有引用共享这些 exact strings。
- **状态、存储与副作用：** 无。
- **并发与性能特征：** 无。
- **调用/依赖边界：** profile、runtime adapter、approval/canonical/protocol adapters，以及 composition 的 `gateway.runtimeEndpointId` 都依赖它；registry native endpoint key是 `adapterId:instanceId`。
- **故障、恢复与安全：** 无错误/secret/redaction；字符串冲突由 registry registration失败发现。
- **迁移分类：** **Preserve：** exact literal identity及其稳定性；变更是公开 topology/session/canonical event compatibility break。**待验证：** 多 OpenClaw instance支持需求，当前代码只声明 local。
- **未来 Rust owner：** literal binding由 **Runtime Integration**；ID newtypes、native endpoint key/correlation grammar由 **Matcha Platform Core**。
- **Rust 重写与性能判断：** compile-time constants/newtypes；不需要 actor、I/O或benchmark。
- **验证 oracle：** topology/canonical event/approval fixture中全量 identity equality；registry duplicate-key test。
- **证据：** 本文件；profile、adapter、protocol/approval/canonical adapters、composition行 598–599。

### runtime-host/application/adapters/openclaw/runtime/openclaw-session-artefact-resolver.ts

- **当前 owner：** Matcha session external artifact pointer 到 OpenClaw transcript path 的严格解析器。
- **职责与关键 symbols：** `OpenClawSessionArtefactResolver.resolveExternalArtefactPaths`；record/string helpers。
- **旧语义与策略：** JSON parse 后必须为 record、`traceSchema === openclaw-trajectory-pointer`、`schemaVersion === 1`、非空 `sessionId`；仅 `runtimeFile` 以 `.jsonl` 结尾才返回单元素路径，否则空数组。所有 parse/type异常返回空数组。
- **状态、存储与副作用：** 无状态、无 filesystem read、无网络；只把 pointer text 映射为候选 path。
- **并发与性能特征：** 单次 JSON parse O(pointer length)，无 cache/queue。
- **调用/依赖边界：** composition 注册为 `sessionExternalArtefactResolver`；session storage repository 在需要外部 trajectory 时消费其返回的路径。
- **故障、恢复与安全：** malformed/unknown version fail closed为空；不规范路径、不检查是否在 OpenClaw root，调用方必须把结果当不可信 external pointer。无 redaction；pointer content可能敏感但此处不记录。
- **迁移分类：** **Preserve：** schema/version gate、`.jsonl` suffix、fail-closed空结果。**待验证：** path containment/symlink policy和 pointer producer format；没有证据可称当前返回路径已授权。
- **未来 Rust owner：** **Runtime Integration** 的 OpenClaw artifact pointer decoder；session artifact ownership在 Session **Domain Module**，Foundation提供 path/I-O guardrails。
- **Rust 重写与性能判断：** serde tagged pointer + `PathBuf` validation；在实际打开前使用 runtime-root containment capability。不要将 parse失败变成 retry/replay；无性能热点证据。
- **验证 oracle：** version/schema/missing fields/invalid JSON/non-jsonl fixtures；absolute/relative/traversal/symlink fault tests；differential exact path output。
- **证据：** 本文件；composition 行 594–596；`sessions/session-storage-repository.ts` port。

### runtime-host/application/adapters/openclaw/runtime/openclaw-session-metadata-resolver.ts

- **当前 owner：** 从 OpenClaw config 解析 session 默认模型的 adapter。
- **职责与关键 symbols：** `OpenClawSessionMetadataResolver` 实现 `SessionDefaultModelResolverPort`；`resolveDefaultModel` 调 `resolveAgentConfigDefaultModel`。
- **旧语义与策略：** 读取 config 后按 session identity 解析 agent default model；任何 read/parse/resolver error 都返回 `null`，即“未知/无默认模型”，不抛出。
- **状态、存储与副作用：** 无 cache；每次调用经 config repository 读 OpenClaw JSON；无写、Gateway或网络。
- **并发与性能特征：** 单次完整 config read/parse成本由 repository承担；无去重或锁（read不经 config mutex）。
- **调用/依赖边界：** composition 注册为 `sessionDefaultModelResolver`；session metadata repository拥有通用模型解析 helper/消费场景。
- **故障、恢复与安全：** broad catch 隐藏 I/O/parse/logic error并返回 null，避免 session query失败但丢失可诊断性；无 secret log。不能将 null当作“OpenClaw已确认无模型”。
- **迁移分类：** **Preserve：** best-effort null fallback。**待验证：** 应否区分 absent/default、invalid config、I/O failure；现有代码不足以判定 broad catch 为缺陷。
- **未来 Rust owner：** config read/projection在 **Native Runtime Edge**；default model resolution 的 session metadata contract在 Session **Domain Module**，二者由 typed result连接。
- **Rust 重写与性能判断：** 返回 `Result<Option<ModelRef>, ModelResolutionError>` 给内部观测层，公开行为仍可投影为 null；使用 read-through snapshot only if config revision/invalidation已定义。指标：config read rate、null reason counters、p95 resolution。
- **验证 oracle：** model precedence fixture、missing config、invalid JSON/I/O failure；legacy TS API differential仍期望 null，同时验证内部 error telemetry已脱敏。
- **证据：** 本文件；composition 行 595–597；`sessions/session-metadata-repository.ts` helper/port。

### runtime-host/application/adapters/openclaw/runtime/openclaw-transport.ts

- **当前 owner：** Matcha runtime session commands 到 OpenClaw Gateway chat/RPC 的 transport adapter。
- **职责与关键 symbols：** `resolveApprovalMethod`；`OpenClawRuntimeTransport.sendPrompt`、`abortSession`、`resolveApproval`、`patchSessionModel`。
- **旧语义与策略：** prompt 合并 object payload，覆盖 sessionKey/message，并将 `runId` 作为 `idempotencyKey` 传 `chatSend`；结果 `success !== false` 即成功，保留 string error/payload，throw 转 `{success:false,error:String(error)}`。abort 先并行 deny 已知 approval IDs（5s、每个错误吞掉），再 `chat.abort`（5s，失败传播）；`plugin:` ID选 plugin approval RPC，否则 exec；model patch以 `sessions.patch`、10s调用。
- **状态、存储与副作用：** 无本地状态；所有操作均为 Gateway network/RPC side effect。
- **并发与性能特征：** approval denial 使用未限流 `Promise.all`；无 transport queue、retry、cache或cancellation；一次 abort 中 approval requests 可大量并发。
- **调用/依赖边界：** `OpenClawRuntimeAdapter.createTransport` 经 `AgentRuntimeRegistry.RuntimeTransportRouter`为 native session生成；依赖 GatewayChatPort/GatewayRpcPort。approval notification的反向路径由 gateway event bridge/approval adapter，而非本类。
- **故障、恢复与安全：** sendPrompt 明确降级为失败 result；abort approval denial best-effort但最终 abort error暴露；resolve/patch errors向上抛。`idempotencyKey` 仅是发送字段，**代码没有证据证明 OpenClaw 支持、接受或持久化幂等**；没有 ack/replay保证。request payload可能含敏感内容，不能打日志。
- **迁移分类：** **Preserve：** RPC names、timeout、plugin ID routing、prompt result/error mapping、abort先 deny后 abort且 deny失败不阻塞。**待验证：** idempotency field语义、abort与resolve approval的真实 Runtime guarantees。**Intentional Improvement 候选：** approval denial bounded fan-out；需记录延迟/顺序变化。
- **未来 Rust owner：** **Runtime Integration** 的 typed OpenClaw Gateway client; generic run/receipt/session command grammar属于 **Matcha Platform Core**，RPC connection supervision/timeout primitives由 Foundation提供。
- **Rust 重写与性能判断：** `PromptRequest/PromptOutcome`、`ApprovalDecision`、`PatchModel` typed protocol；per-endpoint bounded RPC semaphore，abort的 approval fan-out bounded且保持“尽力后 abort”。指标：RPC latency/timeouts、in-flight approvals、prompt failure mapping；不得伪造 external ack/replay/idempotency。
- **验证 oracle：** mock Gateway transcript比对 method/params/timeouts，success:false/throw payload、plugin/exec IDs、denial partial failures、chat.abort failure、sessions.patch fixture；load test大量 approval IDs。
- **证据：** 本文件；gateway port lines 95–102（CodeGraph）；adapter `createTransport`；registry router lines 709–717（CodeGraph）。

### runtime-host/application/adapters/openclaw/runtime/openclaw-v4-canonical-adapter.ts

- **当前 owner：** OpenClaw V4 live/replay event 到 Matcha canonical session events 的有状态协议翻译器；不拥有 canonical timeline/reducer或 OpenClaw agent execution。
- **职责与关键 symbols：** `OpenClawV4ConversationEvent` union、`OpenClawV4Adapter.translate`；live chat snapshot/turn/tool binding states；chat/thinking/tool/plan/session-message/usage/artifact/run activity/phase translators；TeamRun prompt-envelope stripping helpers。
- **旧语义与策略：** 严格按 event type 分发，不满足所需 session/run/seq/role字段时返回空。chat维护 snapshot/delta/replacement、terminal lifecycle和 synthetic owner keys；tool lifecycle生成 started/updated/completed/failed，state-only task tools转换 plan而不显示普通 tool；usage/artifact原样 clone入 canonical；run phase映射 started/final/error/aborted并可附 Gateway transport issue。replay session message使用 adapter-level high-confidence owner binding。TeamRun envelope只在特定 marker/description组合成立时从 user content剥离，避免将产品内部 prompt显示为用户历史。
- **状态、存储与副作用：** 三个内存 Map：chat snapshots、assistant turns、tool owner bindings；无文件/网络/Gateway side effect。每个 emitted event可包含 `origin.raw` 或 cloned provider payload，之后由 session timeline持久化/显示。
- **并发与性能特征：** 假定对同一 adapter instance 的调用按 JS event loop顺序；无锁。TTL 10分钟且每次 translate prune，所有 Map 最大128，按 insertion order剔除；message content/JSON fingerprint/structuredClone 成本与 payload大小线性。不同 session共享128预算，可能使活跃 session互相淘汰。
- **调用/依赖边界：** `OpenClawV4ProtocolAdapter`持有实例；Gateway bridge→session ingress→registry protocol event adapter调用它。依赖 canonical events、transcript/task/tool normalizers；timeline/reducer在外部提交事件。
- **故障、恢复与安全：** 多数 malformed event静默丢弃；`stableEventFingerprint` JSON stringify失败退回 String；no persistent cursor/replay checkpoint。raw payload未在此处redact，可能含 tool args/results；transport issue附带 details亦可能敏感。它不承诺 event delivery、dedupe、ack或 replay completeness，event ID只是适配器构造的标识。
- **迁移分类：** **Preserve：** V4 event mapping、synthetic vs adapter binding confidence、state-only tool→plan、bounded TTL/cache、TeamRun display sanitation、lifecycle/error mapping。**待验证：** 128/10min eviction是否可导致可见同run关联退化、`Date.now()` fallback的测试稳定性、raw payload redaction链。**Intentional Improvement：** 把 TeamRun envelope grammar移到 TeamRun **Domain Module** 的 sanitizer contract；OpenClaw adapter仅调用它，避免 Runtime Integration拥有 TeamRun业务语义。
- **未来 Rust owner：** OpenClaw event decoder/translation为 **Runtime Integration**；canonical event identity/receipt/correlation grammar为 **Matcha Platform Core**，session timeline/turn state为 Session **Domain Module**；绝不迁入 OpenClaw LLM loop、tool harness/sandbox/internal approval。
- **Rust 重写与性能判断：** versioned typed event enum；按 `(endpoint,session,run,lane)` 分片的 bounded state actor或 keyed state store，TTL/LRU有明确容量指标；payload clone/redaction在 crossing boundary处完成。消除当前共享128 map和重复 JSON clone的成本，但保留输出 event sequence/fields。指标：events/s、p95 translate、state bytes/eviction、canonical event count/order。
- **验证 oracle：** `tests/unit/canonical-runtime-contracts.test.ts`、`tests/unit/session-adapter-service.test.ts`（CodeGraph关联）；captured live/replay fixture做 event-by-event differential，delta/replace/terminal/tool ordering、state-only tasks、TeamRun envelope、malformed/oversized/TTL-eviction fuzz与benchmark。
- **证据：** 本文件全部 translator与 `MAX_CHAT_SNAPSHOT_BUFFERS`/TTL；`openclaw-v4-protocol-adapter.ts`；session gateway ingress canonical commit路径。

### runtime-host/application/adapters/openclaw/runtime/openclaw-v4-protocol-adapter.ts

- **当前 owner：** OpenClaw V4 protocol registration wrapper，负责 live event eligibility、transcript replay entry和 message identity policy。
- **职责与关键 symbols：** `OpenClawV4RuntimeEventAdapter`、`OpenClawV4RuntimeReplayAdapter`、`OpenClawV4ProtocolAdapter`；TeamRun prompt envelope strip helpers及 sync/async message iterators。
- **旧语义与策略：** `canTranslate`要求 context protocol ID匹配、input为 non-null object；translate先尝试清理 TeamRun user prompt envelope再交 V4 adapter。replay接受 string/iterable 或 async iterable，逐条 transcript parse、清理后生成 canonical replay events，固定 OpenClaw identity。message ID调用 session-identity-scoped builder。
- **状态、存储与副作用：** protocol adapter fields长期持有 event adapter（其内有有界内存状态）；replay为 iterator/async iterator，通常 streaming，不直接文件/Gateway I/O。
- **并发与性能特征：** replay懒迭代，sanitization逐条处理，不全量物化 transcript；但底层 event adapter的128/TTL state仍共享。没有队列、锁、ack/cursor持久化。
- **调用/依赖边界：** `OpenClawRuntimeAdapter.protocol` 注册到 `AgentRuntimeRegistry`；session ingress用 endpoint protocol查 `eventAdapter`；session transcript replay路径调用 `replayAdapter`。
- **故障、恢复与安全：** 非对象不可翻译；具体 parse/iterator错误由下游 parser/consumer处理。prompt envelope清理不等于 secret redaction；不承诺 transcript replay完整、重放幂等或 Gateway支持 replay。
- **迁移分类：** **Preserve：** protocol ID gate、sync/async lazy replay、fixed identity、message ID policy与 prompt sanitation。**Intentional Improvement：** TeamRun sanitizer contract外移到 Domain Module。**待验证：** transcript parser对损坏中间行的恢复语义。
- **未来 Rust owner：** **Runtime Integration** 的 `OpenClawV4ProtocolAdapter`；session identity/message-ID共同语法归 **Matcha Platform Core**，transcript timeline归 Session Domain Module。
- **Rust 重写与性能判断：** `Stream<Item=Result<TranscriptLine>>` + backpressure，避免无限 read-ahead；opaque `ReplayCursor` 仅在实际 source提供时定义，不能凭此 adapter捏造 cursor/ack。指标：巨型 transcript峰值内存、首事件延迟、parse error比率。
- **验证 oracle：** string/iterable/async iterable同一 transcript输出差分、wrong protocol/non-object、TeamRun content stripping、broken line fault；long JSONL stream benchmark。
- **证据：** 本文件；`OpenClawV4Adapter`；`AgentRuntimeRegistry.getProtocol` 与 session ingress lines 48–67（CodeGraph）。

### runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge.ts

- **当前 owner：** OpenClaw Gateway client 的 lifecycle/readiness/conversation/approval ingress 桥接、有限缓冲、session序列化和 parent delivery协调；不拥有 Gateway socket protocol实现或 session canonical reducer。
- **职责与关键 symbols：** `RuntimeHostGatewayBridgeDeps`、`createRuntimeHostGatewayClient`、session identity helpers、pending queues、per-session `conversationEventChains`、run→session index、restart request、Gateway callbacks。
- **旧语义与策略：** 未取到 session runtime时缓存 notification/conversation；runtime就绪后先 flush notifications、再按 map insertion order逐 session顺序消费 conversations。每 session新 event链接前一 Promise保持该 session串行；显式 session key优先，缺失时尝试 1000-entry run→session LRU-ish map。connection epoch倒退忽略；new connected epoch触发 runtimeHost gatewayLifecycle capability、reset auto recovery并异步探测 base Gateway methods。restart经 parent shell action，非 success/HTTP>=400抛错；session update同时交 auto recovery、Team node settled dispatch、parent event。
- **状态、存储与副作用：** 内存：epochs/readiness revision、per-session chains、最多1000 pending runtime events、最多1000 run mapping、notifications head。网络/IPC：创建 OpenClaw Gateway client、read token、probe/RPC readiness；向 parent emit Gateway/session/channel/error事件；dispatch internal capability route；可请求父进程 Gateway restart；更新 registry endpoint control state。
- **并发与性能特征：** conversation按 session严格 Promise链、不同 session可并发；pending总上限1000，满时**日志警告并直接丢弃新事件**；notifications用 array/head减少 shift但flush时重置。flush在 notification/conversation失败时只是 warn/继续；全局 pending可能影响活跃 session。run map按 insertion order淘汰，不是时间/确认驱动。
- **调用/依赖边界：** OpenClaw bridge `createGatewayClient` 提供 raw events/client state；`GatewaySessionRuntimePort` 是 Session service 的 `consumeEndpointConversationEvent/Notification`；registry endpoint control state保留 observed Gateway readiness；parent transport/route dispatcher是 Delivery边界。composition Gateway module创建/注入本 client（CodeGraph追到 gateway client和session ingress）。
- **故障、恢复与安全：** parent emits大多 `.catch(() => undefined)`，delivery失败不重试；conversation ingress错误warn后丢弃；pending queue满明确丢弃；onGatewayError尝试附 snapshot后fallback基础 error。token只通过 `readGatewayToken`传给 client，不应日志化。没有 durable queue、ack、replay、exactly-once或 external idempotency保证；`transportEpoch`只防止已观察的旧 connection state覆盖。
- **迁移分类：** **Preserve：** session-key parsing、per-session order、bound 1000、queue-full drop+warn、run mapping回退、epoch/revision stale-readiness抑制、restart failure mapping、best-effort parent delivery。**待验证：** pending notifications先于所有 conversations的跨 session排序是否产品契约、queue drop可接受性、auto-recovery的实际 restart策略。**Intentional Improvement 候选：** 明确 overload outcome/metrics或有界 durable spool；只有 Gateway/source提供可验证 cursor/ack后才可引入重放，不能伪造。
- **未来 Rust owner：** OpenClaw Gateway event/client bridge为 **Runtime Integration**；parent IPC/renderer dispatch是 **Delivery** 的消费者；endpoint identity/capability/session correlation为 **Matcha Platform Core**；Foundation提供 supervised task、deadline、bounded channel、redaction机制。OpenClaw native Gateway/approval policy仍不迁入 Matcha。
- **Rust 重写与性能判断：** supervised connection task + per-session bounded mailbox/actor、global bounded ingress budget与显式 `Dropped{reason}` metric；readiness probe携 transport epoch/revision cancellation token，RPC/fileless I/O受 semaphore限制。保持每-session顺序与已知 drop语义，除非批准新 contract。指标：queue depth/drops、p95 ingress-to-session latency、active sessions、reconnect/readiness time、parent emit failures。
- **验证 oracle：** `tests/unit/gateway-event-bridge.test.ts`（gateway port图谱关联）及 session adapter fixtures；multi-session ordering、runtime unavailable→flush、queue 1000/1001、run ID fallback/eviction、stale epoch/readiness, restart/parent/ingress fault injection；soak benchmark measuring bounded memory and no cross-session starvation claim beyond observed policy。
- **证据：** 本文件行 132–453；`gateway/gateway-runtime-port.ts`；`SessionGatewayIngressWorkflow` lines 44–109、198–333（CodeGraph）；`openclaw-bridge/client.ts` 调用链。

## 未读、排除与源改动确认

- **未读（本分片范围）：** **0**。Python 实际枚举 23，已读列表和上述文件记录均为 23。
- **范围差异：** **0**。`00-inventory.md` 的 09 分片预期 23，与工作树现存 `.ts` 完全一致。
- **明确排除：** `runtime-host/build/**` 编译产物、依赖目录、测试输出/临时目录，以及 inventory 分配给其他分片的 OpenClaw projections、workflows、composition、bridge、session/domain 文件；它们不是本报告的逐文件范围。为建立调用证据而通过 CodeGraph读取的 composition/registry/gateway/session ingress 节点不改变此分片的 23 文件计数。
- **无源改动确认：** 本审计未修改 `runtime-host` 源码、测试、README、inventory、配置或锁文件；唯一创建/覆盖目标为本报告。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **OpenClaw Runtime Integration / Native Runtime Edge 仍由 TypeScript owner 保留；Rust cutover 未证实。** status 修改了 `openclaw-profile.ts`、`openclaw-v4-canonical-adapter.ts` 与 `openclaw-gateway-event-bridge.ts`；这些仍是 active TS configuration/protocol/event translation，而非 Rust replacement。
- **生产 active path：** Electron 新 `process-runtime/openclaw-gateway-process-manager.ts` / `OpenClawGatewayProcessAdapter` 监督本地 Gateway；runtime-host `gateway-bridge-module.ts` 建立 client，`openclaw-infrastructure-module.ts` 注册 `OpenClawRuntimeAdapter`/native endpoint，`AgentRuntimeRegistry` 解析 transport；conversation/approval notifications 由 `OpenClawGatewayEventBridge` → `SessionGatewayIngressWorkflow` → canonical timeline，profile/config/runtime-data adapters 仍访问 OpenClaw native layout。`openclaw-v4-canonical-adapter.ts` 继续把 Gateway payload 映为 lane/run/session canonical events。
- **外部旧 owner 与 current-vs-target 边界：** 删除的 `electron/gateway/**` supervisor 已由 `electron/main/process-runtime/openclaw-gateway/**` 当前实现替代。其受管 Gateway launch/attach、readiness、restart/recovery、logs、shutdown、PID/provenance 与 process-tree 语义是 Rust Local Process Host 必须承接的外部旧 owner；这不改变 runtime-host OpenClaw adapter/client 作为协议 semantic owner，也不把 OpenClaw native profile/config/session semantics移交给 Matcha。`openclaw-profile.ts` 与 v4 canonical/event bridge仍是 evolving TS protocol path。
- **旧策略与 future owner：** Preserve OpenClaw profile/file-format、Gateway RPC/event correlation、canonical translation及 per-session ingress ordering。终态 Rust 在 Runtime Integration 实现同一 adapter，Native Runtime Edge保留具体 OpenClaw layout；Rust Runtime/Local Process Host接管受管 Runtime lifecycle，Foundation仅提供 I/O/secret/redaction/supervision primitives，不能获得OpenClaw policy owner。新的 local supervisor、profile mutation、event order、reconnect/recovery与secret-safe projection均仍**未执行验证**。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/openclaw-auth-profile-store.test.ts tests/unit/openclaw-v4-protocol-adapter.test.ts tests/unit/runtime-host-process-openclaw-bridge.test.ts tests/unit/gateway-event-bridge.test.ts tests/unit/openclaw-gateway-process-manager.test.ts tests/unit/openclaw-gateway-process-adapter.test.ts`；`pnpm run typecheck`。本次均**未运行**。
