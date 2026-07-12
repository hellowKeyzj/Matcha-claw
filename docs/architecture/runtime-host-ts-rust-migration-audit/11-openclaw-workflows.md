# 11 — OpenClaw Workflows / Service 文件级迁移审计

> **静态审计状态：完成（只读，未改运行时源码）。** 本报告记录当前 TypeScript 工作树中 OpenClaw workflow/service 的迁移证据，不是已批准的 Rust 实施计划。

## 范围、完整清单与方法

- **Inventory 核对：** 先以 Python 枚举 `runtime-host/application/adapters/openclaw/workflows/**/*.ts`，得到 **16** 个现存文件；加上 `00-inventory.md` 第 11 分片指定的 `openclaw-service.ts`，合计 **17**。逐路径与 inventory 第 432–450 行完全一致：无缺失、无额外文件。
- **全文走读清单（17 / 17）：**
  1. `runtime-host/application/adapters/openclaw/openclaw-service.ts`
  2. `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-agent-model-store-workflow.ts`
  3. `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow.ts`
  4. `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-store-workflow.ts`
  5. `runtime-host/application/adapters/openclaw/workflows/openclaw-capability-routing-projection-workflow.ts`
  6. `runtime-host/application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow.ts`
  7. `runtime-host/application/adapters/openclaw/workflows/openclaw-plugin/openclaw-plugin-config-workflow.ts`
  8. `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow.ts`
  9. `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-config-workflow.ts`
  10. `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow.ts`
  11. `runtime-host/application/adapters/openclaw/workflows/openclaw-security-plugin-config-workflow.ts`
  12. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow.ts`
  13. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow.ts`
  14. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow.ts`
  15. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-subagent-template-workflow.ts`
  16. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow.ts`
  17. `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow.ts`
- **调用链追踪方法：** 在 `.codegraph/` 索引上追踪 composition 注册、workflow→facade/projection、provider/channel/security/workspace application service、capability router/route、Gateway/CLI 边界。图谱已证实 `OpenClawProviderModelsProjectionWorkflow`、`OpenClawCustomMediaPluginConfigWorkflow`、`OpenClawCapabilityRoutingProjectionWorkflow` 分别经对应 projection service 及 `registerOpenClawInfrastructure` 装配；workspace query/maintenance 经 `OpenClawWorkspaceService` 与 `registerOpenClawInfrastructure` 装配；CLI workflow 经 `registerOpenClawApplicationServices` 装配。通用 capability HTTP 入口为 `api/routes/capability-routes.ts` → `CapabilityRouter.execute`，它校验 scope、target、descriptor 与 operation 后才分派。没有证据表明本分片任何配置/文件 workflow 直接拥有或调用 OpenClaw Gateway；Gateway 是 runtime transport/event bridge 的相邻边界。
- **总体边界结论：** `openclaw.json`、`auth-profiles.json`、agent `models.json`、Weixin state、OpenClaw plugin、workspace template、OpenClaw CLI 及其工具权限均是 OpenClaw-specific projection/operation，归 **Runtime Integration / Native Runtime Edge**。Provider、channel、security、workspace 等产品意图各自留在 **Domain Module**；endpoint/capability/scope/identity/correlation 的通用语法归 **Matcha Platform Core**。本分片不迁移 OpenClaw 的 LLM loop、tool policy、tool harness、sandbox、native approval 或 agent prompt 执行策略到 Matcha。

## 文件记录

### runtime-host/application/adapters/openclaw/openclaw-service.ts

- **当前 owner：** OpenClaw-specific control/query facade；自身不拥有环境、workspace、provider snapshot、template、CLI 或工具权限状态。
- **职责与关键 symbols：** `OpenClawServiceDeps`、`OpenClawService`；`status`/`ready` 查询环境，`dir`/`configDir`/`skillsDir`/workspace 方法投影路径，template/provider/CLI 方法转发下游，`toolPermissionMode` 与 `setToolPermissionMode` 转发 OpenClaw runtime-config projection。
- **旧语义与策略：** `ready` 只取 environment snapshot 的 `packageExists`，不检查 build、entry 或 Gateway；`subagentTemplate` 先 `decodeURIComponent`，解码失败保留原字串；其他方法不加缓存、默认、验证或错误转换。工具权限 mode 是 OpenClaw runtime config 的同步请求，不是 Matcha 通用授权决策。
- **状态、存储与副作用：** facade 无状态。下游可读 OpenClaw 环境/config/workspace、template 或 provider snapshot；`setToolPermissionMode` 可改 native config。无直接 Gateway RPC、文件写入或事件投递。
- **并发与性能特征：** 无锁、队列、缓存或批处理；调用成本和并发语义完全继承各 dependency。`ready` 每次重新取 status。
- **调用/依赖边界：** composition 注入 environment、config repository、workspace service、template service、provider snapshot、runtime-config service 和 CLI workflow；CodeGraph 显示其关联 application/route 注册与通用 capability route 的校验入口。它位于 Delivery/API 的 OpenClaw 查询面之外，不是 provider/security/workspace 领域事实源，也不在 Gateway event chain 中。
- **故障、恢复与安全：** 除 URI 解码失败外透明传播下游异常；不 redaction。provider config 及 tool mode 的公开投影不得携带 key/token；`providersConfig` 的实际脱敏责任须由 snapshot projection 和 Delivery serializer 验证。
- **迁移分类：** **Preserve：** `ready=packageExists`、URI 解码 fallback、透明转发及现有返回形状。**Intentional Improvement：** 将 native tool permission mode 标为私有 OpenClaw projection，禁止作为 Matcha tool-policy/harness 的 owner。**Defect：** 无已证实缺陷。**待验证：** `providersConfig` 是否已在所有 API/diagnostics 路径脱敏。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawControlFacade`；通用 `EndpointId`、capability identity/scope 仅依赖 **Matcha Platform Core**。产品 security domain 可以下达抽象 desired policy，但不可让此 facade 成为 Matcha policy engine。
- **Rust 重写与性能判断：** 将返回类型显式化为只读 status/template/provider summaries 与 private native-config commands；不需要 actor。配置变更仍经 Edge 的 keyed config writer；无外部 receipt/ack 证据，不建立 outbox。若 Domain 需要可靠投递 desired configuration，应由 Domain own outbox，Edge 只执行 projection。指标是 facade 调用数、下游 I/O 和 config mutation latency，而非凭空声称性能提升。
- **验证 oracle：** status/ready/build fixture、无效 percent-encoding、template/provider/CLI forwarding mock、tool mode round-trip；公共 route/diagnostics 的 secret-redaction snapshot。
- **证据：** 本文件第 10–83 行；`workflows/openclaw-workspace/openclaw-cli-command-workflow.ts`；`projections/openclaw-runtime-config-service.ts`；CodeGraph 的 `registerOpenClawApplicationServices`、`capability-routes.ts` → `CapabilityRouter.execute`。

### runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-agent-model-store-workflow.ts

- **当前 owner：** 每个 OpenClaw agent `models.json` 的 native file projection；不拥有产品 provider/model 的事实源。
- **职责与关键 symbols：** `OpenClawAgentModelEntry`、`OpenClawAgentModelProviderEntry`、`OpenClawAgentModelStoreWorkflow`；`upsertProviderInAgentModels`、`removeProviderFromAgentModels`、`readModelsJson`、`writeModelsJson` 和模型/header 正规化 helpers。
- **旧语义与策略：** upsert 规范化 provider/baseUrl/api，任一为空即返回空 touched list；逐 agent read-modify-write，保留 provider 未管理字段，强制删除旧 `apiKey`/`apiKeyEnv`，按输入替换或初始化 `models`，只保留非空字符串 header、正整数窗口/token 和非负有限 cost。读/parse 失败时 upsert 以空对象继续。remove 仅在文件/目标 provider 存在时改写；其 read/JSON parse 错误向上抛出，和 upsert 的容错不同。
- **状态、存储与副作用：** 无内存状态；读写 `<config>/agents/<agentId>/agent/models.json`，写前创建父目录。`headers` 可能承载认证信息，故这是 private native projection，不能投影至公共 config/logs。
- **并发与性能特征：** 对 agent ID 串行循环，N 个 agent 为 O(N) 次完整 JSON read/write；无 file lock、原子 replace、cache 或批次原子性。config repository 的 mutex 不覆盖此独立文件。
- **调用/依赖边界：** `OpenClawAgentModelRepository` 是薄 facade；CodeGraph 将它连至 `OpenClawProviderConfigWorkflow`、provider projection sync 和 composition 的 infrastructure registration。上游 provider domain/capability/route 产生模型意图，workflow 仅写 OpenClaw agent 文件；无 Gateway/CLI 直接调用。
- **故障、恢复与安全：** upsert 的损坏 JSON fallback 可在随后写入时覆盖原文件；remove 失败会停止调用。无日志；写入不是已证实的 crash-safe 操作。agent ID 从上游传入，本层不验证路径成分，是否永远来自受信任 agent discovery 尚待验证。
- **迁移分类：** **Preserve：** 正规化、去除 `apiKey`/`apiKeyEnv`、touched-agent 返回值、upsert/read-error fallback 与 remove/error-propagation 的差异。**Intentional Improvement：** 以 `SecretString`/private header projection 替换可序列化裸字串，并区分 missing、invalid、I/O。**Defect：** 无已证实缺陷。**待验证：** 并发覆盖、写中断、agent ID path containment 与损坏文件应否保留。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawAgentModelsStore`；产品 `ModelRef`/provider identity 可由 **Matcha Platform Core** 共享，但 OpenClaw JSON schema 不进入核心。
- **Rust 重写与性能判断：** 每 agent key 的 single-writer mailbox，blocking filesystem 在有界 executor；只在 profile 证明需要时对多个不同 agent 有界并发。保留“逐 agent 成功集合”而不伪造事务/外部确认；本地投影无 outbox。测量 N-agent write count、p95、峰值打开文件与部分失败结果。
- **验证 oracle：** 多 agent models fixture，空/坏 JSON、无效 header/模型/cost、legacy key 移除、缺失 provider、某一 agent 写失败、并发同 agent、日志/serde secret scan。
- **证据：** 本文件第 30–169 行；`infrastructure/openclaw-agent-model-repository.ts`；`workflows/openclaw-provider/openclaw-provider-config-workflow.ts` 第 69–107 行；CodeGraph 的 provider-model projection callers。

### runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow.ts

- **当前 owner：** OpenClaw agent auth profile 的读改写策略；不拥有 Matcha provider account 生命周期。
- **职责与关键 symbols：** `removeProfilesForProvider`、`removeProfileFromStore`、`OpenClawAuthProfileWorkflow`；OAuth/API key 的 save/get/remove、`resolveAgentIds`、`markProfileCurrent`、`getApiKeyFromAuthProfilesStore`。
- **旧语义与策略：** provider 删除同时清理 `profiles`、`order`、`lastGood`；按 profile ID 删除在 type 不符时保留 profile 也不清其引用。save OAuth/API key 默认写所有发现 agent，profile ID 固定 `${provider}:default`，更新 order/lastGood；OAuth provider 没有 API key 时跳过 key write。get OAuth 只查指定 agent/default profile；get API key 按 lastGood、order、default、再扫描所有 profiles 的优先级返回首个可用 key。agent 列表为空回退 `main`。
- **状态、存储与副作用：** workflow 无持久内存状态；经 repository 读写每 agent `auth-profiles.json`。access token、refresh token 和 API key 都是 secret，只可留在 private auth projection，禁止出现在 public config、capability response、diagnostics 或日志。
- **并发与性能特征：** save/remove 对 agent 串行 read-modify-write；key lookup 至少线性扫描候选，再可能 O(profile count) fallback；无锁、版本、retry、cache 或跨文件原子性。
- **调用/依赖边界：** auth store facade 与 provider config workflow 使用这些 rules；provider account/projection sync 从 provider domain 到 OpenClaw auth file 的链路经此处。CodeGraph 和 09 分片记录 composition 注册 auth service；它不调用 Gateway/CLI。
- **故障、恢复与安全：** `getOAuthToken` 捕获并 warn 后返回 null，其他读写通常抛出；save/remove 日志只写 provider/agent IDs，不直接写 secret，但 error object 是否可能携带 secret 尚未由 logger/redaction 实现证明。API key 读取结果必须只提供给 private Runtime Integration 代码。
- **迁移分类：** **Preserve：** profile/reference cleanup、读取优先级、`main` fallback、OAuth 空 key 跳写、get OAuth best-effort null。**Intentional Improvement：** `SecretString` 默认不实现 Debug/公开序列化，按 agent 的 private single-writer actor 防止 read-modify-write 覆盖。**Defect：** 无已证实缺陷。**待验证：** malformed store fallback 后是否会造成 credential 覆盖、并发写、logger 对 error 的脱敏。
- **未来 Rust owner：** **Native Runtime Edge** 的 private `OpenClawAuthProfilesStore`；Foundation Kernel 只提供 encrypted-secret/redaction 与受监管 I/O 原语，不能拥有 provider selection；provider account 意图留在 Provider **Domain Module**。
- **Rust 重写与性能判断：** 用 tagged `ApiKey`/`OAuth` enum、每 agent 有界 mailbox、blocking file worker；同一用户动作涉及多 agent 时记录逐 agent outcome，不伪造 all-or-nothing。无直接 Runtime acknowledgement，故不设 outbox；若 provider domain 要可靠协调，应以领域 outbox 指向 typed Edge command。指标为文件 I/O、队列等待、部分失败和 secret-leak audit。
- **验证 oracle：** OAuth/key save/get/remove、provider bulk removal/order/lastGood、OAuth empty-key、空 agent discovery、损坏/权限失败、并发同/异 agent、error log/JSON serialization redaction fixtures；现有 `tests/unit/openclaw-auth-profile-store.test.ts` 是起点。
- **证据：** 本文件第 10–239 行；`workflows/openclaw-auth/openclaw-auth-store-workflow.ts`；`workflows/openclaw-provider/openclaw-provider-config-workflow.ts` 第 69–88 行；09 分片的 auth facade/composition 证据。

### runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-store-workflow.ts

- **当前 owner：** `auth-profiles.json` 文件布局、JSON helper 与 agent directory discovery；不定义 profile 选择策略。
- **职责与关键 symbols：** auth store/version/profile union types、`OpenClawAuthStoreWorkflow` 的 path/read/write/discover/config-read，`readJsonFile`、`writeJsonFile`。
- **旧语义与策略：** profile path 固定为 `<config>/agents/<agentId>/agent/auth-profiles.json`；read 成功须有 truthy `version` 和 object `profiles`，否则返回 fresh `{version:1,profiles:{}}`；read error 会 warn。write 直接 pretty JSON。discovery 只接受 `agents/*/agent` 目录，缺失/异常/空结果都回退 `['main']`。generic JSON read 对 missing/parse/I-O 全部返回 null。
- **状态、存储与副作用：** 无内存状态；读 OpenClaw config、列目录、创建父目录、读写 native auth JSON。数据可含 OAuth refresh/access/API key；它是 private secret store，严禁 whole-store logging 或公开投影。
- **并发与性能特征：** discovery 逐条 `exists`，O(directory entries) I/O；无 lock/cache。直接 `writeTextFile` 无本文件可见的 temp/rename/atomicity保证。
- **调用/依赖边界：** `OpenClawAuthRepository` facade 供 auth-profile workflow、provider snapshot/config 等使用；composition 注入 config repository/filesystem/logger。它是 provider domain → private auth projection 的文件末端，不经过 Gateway、CLI 或 capability router。
- **故障、恢复与安全：** 读取失效被折叠为 fresh store，可能掩盖 missing、坏 JSON 与权限错误；`readAuthProfiles` 会记录 error。并无代码证实 error formatter 会去除路径或敏感内容。agent ID 未在此处做 path parser，安全依赖上游来源，待验证。
- **迁移分类：** **Preserve：** path/layout、version/profiles gate、main fallback、generic JSON null 和 read auth fresh-store fallback。**Intentional Improvement：** Rust 内部返回 `Missing`/`Invalid`/`Io` 区分，公开旧 API 如需可仍投影 fresh result；写入改为 crash-safe private file primitive。**Defect：** 无已证实缺陷；不能仅据广泛 catch 断言为缺陷。**待验证：** 旧损坏文件覆盖、跨进程互斥、agent path trust 与 logger redaction。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawAuthFileStore`；Foundation Kernel 提供 secret/redaction、atomic file primitive 与受限 blocking I/O。
- **Rust 重写与性能判断：** filesystem 访问经有界 blocking executor，按 agent keyed writer 与 auth-profile workflow 共用；不要把 parse failure 自动解释为可安全删除 credential。无需 outbox：这是 local native file projection，不是经证实的外部可靠投递。指标为 discovery I/O、auth write count、crash recovery 和敏感数据零泄漏。
- **验证 oracle：** current JSON、missing、invalid、permission error、empty/malformed agents directory、write interruption、multi-process contention（待补），以及 error/log redaction fixture。
- **证据：** 本文件第 5–112 行；`infrastructure/openclaw-auth-store.ts` facade；`OpenClawAuthProfileWorkflow` repository dependency；09 分片第 85–98 行。

### runtime-host/application/adapters/openclaw/workflows/openclaw-capability-routing-projection-workflow.ts

- **当前 owner：** Matcha capability routing 到 `openclaw.json` agents/messages 字段的 OpenClaw projection；不拥有通用 capability identity 或 provider routing 事实源。
- **职责与关键 symbols：** `OpenClawCapabilityRoutingProjectionWorkflow.read`、`replace`、`ensureAgentsDefaults`；使用 `ROUTE_CAPABILITIES`、`AGENTS_DEFAULTS_KEY`、model/TTS conversion helpers。
- **旧语义与策略：** read 只读取 agents.defaults 的 chat/image/media routes 与 `messages.tts.provider`，忽略无效 shape。replace 对每个 route 单独 upsert/delete；任意 media route 存在时写 `mediaGenerationAutoProviderFallback=false`，否则删除该字段；写/删 TTS provider；无差异比较而始终返回 `changed:true`。
- **状态、存储与副作用：** 无内存状态；经 config repository 在 process-local config mutation 临界区改整份 OpenClaw config。仅管理指定路径，provider credential/model catalog 不在本 workflow。
- **并发与性能特征：** 每次 replace 为完整 config read-modify-write/JSON serialization；repository 提供 process 内串行化，未证实跨进程 lock；无 cache、retry、batch merge 或 Gateway RPC。
- **调用/依赖边界：** `OpenClawCapabilityRoutingService` 是 facade，CodeGraph 显示其由 infrastructure module 装配；产品 `CapabilityRoutingService`/store、provider capability operation routes 和 `/api/capabilities/execute` 的 descriptor/operation 分派是上游链路。无直接 OpenClaw Gateway 调用；配置由 native runtime 后续消费。
- **故障、恢复与安全：** config read/write/mutation error向上抛出；routing value 本身不应有 secret，但完整 config 可含 Runtime-sensitive fields，不能记录 whole config。没有 rollback、ack、replay 或 Runtime 实际应用确认。
- **迁移分类：** **Preserve：** field-level add/remove、media fallback flag、TTS mapping、invalid shape ignore。**Intentional Improvement：** no-op diff 后返回 `changed:false`，仅在对既有 forced-write 行为/mtime 影响明确评审后采用。**Defect：** 无已证实缺陷。**待验证：** force-write 是否被外部 watcher 当作语义事件、跨进程并发与 native Runtime 的 reload/restart 确认。
- **未来 Rust owner：** config schema translation 为 **Runtime Integration / Native Runtime Edge**；`CapabilityId`、scope/route descriptor grammar 为 **Matcha Platform Core**；provider routing desired state 为 Provider **Domain Module**。
- **Rust 重写与性能判断：** typed `OpenClawRoutingProjection` command 发送至 config single-writer actor；只在 hash/diff 不同才 write 是明确性能改进，消除无意义全 JSON write，且保持字段输出。无 outbox，除非 provider domain 已有 durable desired-state event；不可由此捏造 Gateway apply receipt。指标为 config write count、bytes、p95 mutation、native reload observable trace。
- **验证 oracle：** chat/image/media/TTS fixture、empty route deletion、invalid nested shapes、media flag matrix、unchanged replacement write-count differential、concurrent mutations、config redaction scan；CodeGraph 指出的该 workflow 无直接覆盖测试，需补 route-to-config integration fixture。
- **证据：** 本文件第 14–58 行；`projections/openclaw-capability-routing-service.ts` 第 157–168 行；`application/providers/capability-routing-service.ts`、`api/routes/capability-routes.ts`、`CapabilityRouter.execute` 的图谱链路。

### runtime-host/application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow.ts

- **当前 owner：** OpenClaw Weixin native account state-file projection；不拥有 Channel domain 的账号/登录会话事实。
- **职责与关键 symbols：** `SaveOpenClawWeixinAccountParams`、`OpenClawWeixinAccountStoreWorkflow.saveAccount`；state/accounts/index path resolvers、JSON/index/user read、account write/remove。
- **旧语义与策略：** state root 优先 `OPENCLAW_STATE_DIR`、再 legacy `CLAWDBOT_STATE_DIR`、再 runtime data root；save 建目录，读 index，若传非空 `userId` 并行读取现有 account 的 userId，识别同一 user 的其他账户为 stale；先写新 account、再删除 stale 的三类文件，最后将 index 更新为保留 IDs 加当前 ID。无 userId 时不清 stale。读取不存在/坏 JSON 均视为空/未知。
- **状态、存储与副作用：** 无内存状态；写 `accounts/<accountId>.json`（包含 token、baseUrl、savedAt、可选 userId）、删 `.sync.json`/`.context-tokens.json`、写 `accounts.json`。token 是 secret，全部为 private native state，绝不能进入 public config、logs 或诊断。
- **并发与性能特征：** stale detection 对 existing IDs 以无界 `Promise.all` 并发读取；随后删除顺序串行，删除每账户内三文件并行。无 lock、atomic group commit、cache 或总账户上限。
- **调用/依赖边界：** CodeGraph 显示由 `registerOpenClawApplicationServices` 构造，依赖 Channel login runtime port；Channel domain 的 login/account flow 是上游，OpenClaw channel/plugin config 是下游 native format。没有证据显示它直接走 Gateway；通用 route/capability 只能经 Channel service/operation route 间接到达。
- **故障、恢复与安全：** 新 account 写后，stale deletion 或 index 写失败会留下部分完成状态；代码没有 rollback。读取错误静默降级；不写日志。`normalizedAccountId` 在此处没有 path validation，虽名称表示上游已归一，是否抗 traversal 必须验证，不能据此宣称漏洞。
- **迁移分类：** **Preserve：** env precedence、同 user stale 判定、写→删→index 顺序、无 userId 不清理、best-effort index/account parsing。**Intentional Improvement：** private `SecretString`、account-key parser、每 state root single-writer actor、有限文件读取并发。**Defect：** 无已证实缺陷。**待验证：** account ID source/path containment、并发 save、partial state 是否被 OpenClaw 正确恢复。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawWeixinStateProjection`；channel account/login state 与 recovery strategy属 Channel **Domain Module**，Foundation 仅提供 secret file/I-O and keyed serialization。
- **Rust 重写与性能判断：** 执行一个 account-state transactional command；不能把 multi-file local write 宣称为 external delivery 或建造假 outbox。可使用 staged temp files/manifest 作为明确 crash-consistency 改进，保留最终 index/account content；读取并发改为有界。指标是 accounts 数量下的 FD/并发、save latency、partial-write recovery、token leak audit。
- **验证 oracle：** env precedence、重复 account、同/异 user stale、无 userId、损坏 index/account、每个删除/index write failure、并发 saves、path traversal fixture、JSON/log/diagnostic secret-redaction scan。
- **证据：** 本文件第 17–113 行；`application/channels/channel-login-session-service.ts` port；CodeGraph 的 `registerOpenClawApplicationServices` 构造关系与 channel/application 链路。

### runtime-host/application/adapters/openclaw/workflows/openclaw-plugin/openclaw-plugin-config-workflow.ts

- **当前 owner：** Matcha-managed plugin selection 到 OpenClaw plugin config/directory 的 native projection；不拥有通用 plugin catalog 或 capability identity。
- **职责与关键 symbols：** managed ID set、`OpenClawPluginConfigWorkflow.readEnabledPluginIds`/`syncEnabledPluginIds`、`replaceConfigContents`。
- **旧语义与策略：** read 从 config/manual management rule 取得 IDs 后，只返回 catalog 定义的 Matcha-managed plugins。sync 先 `normalizePluginIds`，排除由 channel 派生的 ID；在 config `updateDirty` 内将手动管理 IDs 应用为 next config、解析 effective IDs、全量替换 mutable config 内容；config 成功后才清理未配置 external-channel plugin dirs，返回 effective list。
- **状态、存储与副作用：** 无内存状态；读/写 OpenClaw config、读 plugin filesystem，并可能删除 plugin directories。native plugin config/dir 是 Edge 资源，不应成为产品 plugin domain 的 canonical store。
- **并发与性能特征：** config 更新继承 process 内 config mutex；plugin discovery/cleanup 成本由 projection helpers 决定。没有 cache/retry；cleanup 在 config commit 后执行，不与 config 写形成单一事务。
- **调用/依赖边界：** `OpenClawPluginConfigService` facade 调用它；CodeGraph 显示该 service 有单元测试及 composition/application plugin projection 链路。产品 plugin lifecycle/capability route 是上游；没有直接 Gateway/CLI 责任，OpenClaw runtime 以后自行加载 native plugin。
- **故障、恢复与安全：** config apply 异常传播且不 cleanup；cleanup 异常会在 config 已提交后向上抛，形成可观察的 partial success。workflow 不处理 secret，但不得把完整 config 或 plugin config 写入公开 logs。目录清理边界/符号链接安全取决于 filesystem helper，待验证。
- **迁移分类：** **Preserve：** managed-only read filter、normalization、channel-derived exclusion、commit 后 cleanup 顺序、effective IDs 返回。**Intentional Improvement：** 记录 `ConfigApplied/CleanupFailed` 的 typed result 或 reconciliation job，前提是保持当前 config-first 结果可观察。**Defect：** 无已证实缺陷；post-commit cleanup failure 是否产品错误语义尚未证明。**待验证：** cleanup 幂等性、concurrent sync、path containment。
- **未来 Rust owner：** OpenClaw config/file projection 为 **Native Runtime Edge**；插件期望状态、catalog、lifecycle在 Plugin **Domain Module**；通用 capability/scope 属 **Matcha Platform Core**。
- **Rust 重写与性能判断：** Edge config single-writer actor 后投递有界 cleanup reconciliation command；若 Domain 要 durable retry，可由 Domain outbox 记录 desired plugin set，不能由 OpenClaw tool harness 反向拥有。测量 config writes、directory scans/removals、cleanup failure/reconcile time；保持 channel-derived exclusion。
- **验证 oracle：** managed/unmanaged/channel-derived ID matrix、normalization、unchanged config、cleanup missing/failing directory、config failure不 cleanup、cleanup failure后 config snapshot、concurrent sync、plugin directory confinement fixture；现有 `tests/unit/openclaw-plugin-config-service.test.ts` 是基础。
- **证据：** 本文件第 15–67 行；`projections/openclaw-plugin-config-service.ts`；`projections/openclaw-plugin-channel-config.ts`；CodeGraph 的 plugin service callers/composition registration。

### runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow.ts

- **当前 owner：** custom media provider/model 到 MatchaClaw OpenClaw media plugin config 的 native projection；不拥有媒体 provider/model 领域事实。
- **职责与关键 symbols：** media provider/model types、`readAll`、`replaceAll`、model/header/number normalizers、`buildProvidersConfig`、plugin enable/entry helpers、legacy media route rewrite。
- **旧语义与策略：** read 仅从 `plugins.entries[MATCHACLAW_MEDIA_PLUGIN_ID].config.providers` 返回含至少一个有效模型的 providers，按模型 ID 去重。replace 建立有效 baseUrl/apiProtocol 的 provider map；非空输入时确保 plugin allow/enabled；替换 plugin providers、删除当前/legacy provider 的 `models.providers` nodes，并把 image/video/music legacy `<provider>/<model>` refs 改为 `${MATCHACLAW_MEDIA_PROVIDER_ID}/<provider>/<model>`。headers 过滤空键值，模型 fields 大多保留输入值。
- **状态、存储与副作用：** 无内存状态；在 config mutex 内读/写 OpenClaw config。headers 可能是 credential-bearing，因此 plugin config 必须是 private projection，不得出现在公共 config/logs。
- **并发与性能特征：** 每次完整 config JSON update；模型去重 O(n)，`deepEqual` 以 `JSON.stringify` 比较 provider config，成本与规模线性且对象键插入顺序影响 equality。无 cache/retry/外部 I/O/Gateway。
- **调用/依赖边界：** `OpenClawCustomMediaPluginConfigService` 仅转发此 workflow；CodeGraph 指向 provider-model capability operations、provider projection service 及 infrastructure composition。Provider domain 形成 input，OpenClaw plugin/config 是下游；没有 direct Gateway 或 CLI task。
- **故障、恢复与安全：** config errors传播；无 rollback/Runtime apply acknowledgement。providerMap 未出现的旧 `models.providers` 节点是否应保留是当前规则的一部分，不能擅自判为 stale bug。没有日志；header/URL 输入信任、secret redaction 和 config serialization 边界待验证。
- **迁移分类：** **Preserve：** valid provider gate、read normalization/dedupe、plugin enable rule、model node removal、legacy media route rewrite及排序。**Intentional Improvement：** typed private headers、stable structural equality和 no-op `changed:false`；必须对比 bytes/mtime。**Defect：** 无已证实缺陷。**待验证：** omitted provider cleanup、legacy route grammar、header secret source/红线。
- **未来 Rust owner：** **Native Runtime Edge** 的 OpenClaw media-plugin projection；custom media capability/model intent归 Provider **Domain Module**；provider/capability identity grammar归 **Matcha Platform Core**。
- **Rust 重写与性能判断：** `BTreeMap` 或 canonical serialization 支持稳定 diff，config single-writer actor 防止 RMW 覆盖；不建 outbox，除非 Provider domain 的 desired-state command 已经持久化。消除的旧成本仅限相等更新下的无谓整份 JSON 写，需测 write count、bytes、p95 与 route output差分。
- **验证 oracle：** malformed/duplicate models、headers/number normalization、empty/nonempty map、enable transitions、legacy/current provider replacements、model node removal、route rewrite primary/fallbacks、byte-stable no-op、secret-redaction fixture；现有 `tests/unit/openclaw-custom-media-plugin-config-service.test.ts` 是基础。
- **证据：** 本文件第 24–253 行；`projections/openclaw-custom-media-plugin-config-service.ts`；`application/providers/custom-media-runtime-projection.ts`；CodeGraph 的 custom-media service/provider capability callers。

### runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-config-workflow.ts

- **当前 owner：** provider lifecycle 对 OpenClaw config/auth/agent-model/OAuth plugin 的协调 projection；不拥有 provider account 的 canonical lifecycle。
- **职责与关键 symbols：** `OpenClawProviderConfigWorkflow.syncProviderConfig`、`removeProvider`、agent ID/model/config removal helpers、`markRestartCommand`。
- **旧语义与策略：** sync 仅为 OAuth-plugin provider resolve registration；在 config update 中确保 Moonshot Kimi search base URL，且仅 baseUrl/api 都存在才 upsert provider entry，可能注册 OAuth plugin。remove 先扩展 legacy provider aliases、逐 agent 删除 auth profiles，之后尝试删除 agent `models.json`（失败 warn 后继续），最后尝试 config 中 OAuth registration/provider/auth profiles/agent references 删除并写 `commands.restart=true`（失败 warn 后继续）。agent discovery 空结果回退 main。
- **状态、存储与副作用：** 无本地状态；可修改多个 agent auth files、agent model files、OpenClaw config/OAuth plugin registration，记录 provider/profile/agent identifiers 的 info/warn。`override.headers` 可能机密；`apiKeyEnv` 是 reference 而非本文件所见的 secret value，仍不可随整个 config 公开。
- **并发与性能特征：** auth profile loop 串行；agent-model/config 写后序执行；config update 有 process-local mutex，但 auth/models 独立且无跨文件事务、lock、retry或outbox。复杂度随 agent 数与 profile/model size 线性。
- **调用/依赖边界：** provider application projection sync/service 是上游，CodeGraph 把 agent model projection workflow、provider models service、provider capability operations 及 composition 接到此链。API/capability 的共同执行入口仍是 `capability-routes`→`CapabilityRouter`；workflow 自身没有 Gateway/CLI calls，`commands.restart` 只是写 native config command。
- **故障、恢复与安全：** auth profile read/write 错误会使 remove 停止；模型/config 删除错误会被 warn 并让 `removeProvider` 成功返回，故可形成部分删除。日志不写 key/token，但 error 对象 redaction待验证。没有 compensation、native restart completion、ack、replay 或 idempotency证明。
- **迁移分类：** **Preserve：** sync guard、OAuth resolution、alias expansion、删除顺序、model/config best-effort、restart marker。**Intentional Improvement：** 显式 `ProviderProjectionOutcome` 分项结果和 reconciliation；不要把当前成功返回误解为 OpenClaw 已完全应用。**Defect：** 无已证实缺陷；部分删除是否应升级为 failure 是产品策略待定。**待验证：** restart command 的消费者/完成语义、provider alias 完整性、并发生命周期操作。
- **未来 Rust owner：** Provider **Domain Module** 拥有 provider desired state/remove saga；具体 OpenClaw auth/config/model/OAuth writes 为 **Runtime Integration / Native Runtime Edge** steps。共享 provider/model/capability identity归 **Matcha Platform Core**。
- **Rust 重写与性能判断：** Domain 可持久化 `RemoveProvider` saga/outbox，Edge worker 按稳定 operation ID 执行 typed private commands、持久化每步 outcome，避免伪装 external ack；Edge 内 config writer + per-agent auth/model writers。此为有意可靠性改进，保持现有删除集合和 best-effort policy需明确版本化。指标为 agent 数、步骤失败/重试、最终 config/profile/model convergence、重启观察时间。
- **验证 oracle：** sync baseUrl/api/OAuth fixture；alias/auth/profile deletion、多 agent、model failure继续、config failure继续、auth failure中止、restart marker、secret log scan；现有 provider projection/model service tests和 mock config filesystem 作为差分起点。
- **证据：** 本文件第 35–158 行；`infrastructure/openclaw-auth-provider-keys.ts`、`openclaw-agent-model-repository.ts`、OAuth/provider projection helpers；CodeGraph 的 provider models/projection/composition chain。

### runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow.ts

- **当前 owner：** provider 模型清单到 `openclaw.json.models.providers` 的 native projection；文件头也明确它不是 MatchaClaw 模型事实源。
- **职责与关键 symbols：** provider model types/map、`readAll`、`replaceAll`、model decode/normalizers、provider node add/remove、`applyModelsToProviderNode`。
- **旧语义与策略：** readAll 跳过 malformed provider/model，输出有效模型列表。replaceAll 仅处理输入 map 中的 providers：先去掉 `replaceProviderKeys`，若 baseUrl/api 无效则删除该 provider；否则写 baseUrl/api、Anthropic Messages maxTokens rule、`apiKeyEnv` 到 native `apiKey` 字段、headers/authHeader、完整 models。每模型 name=id，保留输入/window/token，Anthropic 特殊默认 token，未给 cost 时写全零 cost；可选 `validModelRefs` 时 pruning agent model refs。
- **状态、存储与副作用：** 无内存状态；整份 OpenClaw config read-modify-write。header 可能敏感，`apiKeyEnv` 是 secret reference；二者只可存在 private native projection，公共 provider/model API 不得回显。
- **并发与性能特征：** config mutex 内按 map/models 线性变换，可能有完整 config parse/stringify；无 cache、diff/no-op gate、retry、Gateway/CLI 或 external confirmation。未在 map 中的 provider 不会由本方法自动删除，除非作为 replace key。
- **调用/依赖边界：** `OpenClawProviderModelsService` facade 及 `ProviderModelsProjectionWorkflow`/provider model operations 使用；CodeGraph 确认其由 `registerOpenClawInfrastructure` 构造、并关联 `tests/unit/openclaw-provider-models-service.test.ts`。Provider models domain/store 是上游，OpenClaw config 是下游。
- **故障、恢复与安全：** config failure传播；没有 rollback/native reload ack。输入 headers、model metadata 的 validation有限；不能从未出现 provider 的保持行为直接推断为 stale-data defect。
- **迁移分类：** **Preserve：** decoder 容错、map-only replace、legacy provider removal、invalid config delete、Anthropic max-token rule、zero cost、valid ref pruning。**Intentional Improvement：** typed `SecretRef`/private header and structural diff；仅在兼容审查后 no-op 不写。**Defect：** 无已证实缺陷。**待验证：** `apiKey` 对 env reference 的 OpenClaw schema、omitted-provider lifecycle、Anthropic defaults 与外部 Runtime versions。
- **未来 Rust owner：** projection/schema为 **Native Runtime Edge**；模型 catalog/selection事实在 Provider **Domain Module**，模型/provider identity 与 capability grammar归 **Matcha Platform Core**。
- **Rust 重写与性能判断：** typed serde config section + config single-writer actor；若 Provider domain 有 durable sync job，使用其 outbox 记录 desired revision，Edge 不伪造 `OpenClaw applied` receipt。消除的可证实成本是无变更时整份 config write（若 diff 引入）；指标为 model count 下 JSON bytes/write count、p95、prune correctness。
- **验证 oracle：** malformed model/provider、legacy key replace、invalid baseUrl/api delete、Anthropic/non-Anthropic token/cost、header/auth header、valid ref prune、omitted provider、config write failure和 secret-redaction fixtures；现有 `tests/unit/openclaw-provider-models-service.test.ts`。
- **证据：** 本文件第 1–207 行；`projections/openclaw-provider-models-service.ts`；provider model application workflow/operations 的 CodeGraph callers；`openclaw-anthropic-messages-max-tokens.ts`、provider pruning helpers。

### runtime-host/application/adapters/openclaw/workflows/openclaw-security-plugin-config-workflow.ts

- **当前 owner：** Security domain policy 到 OpenClaw security-plugin config 的薄 native projection；不拥有产品 security policy 或 OpenClaw tool-harness enforcement。
- **职责与关键 symbols：** `OpenClawSecurityPluginConfigWorkflow.applyPolicy`、`replaceConfigContents`。
- **旧语义与策略：** 对每个 `SecurityPolicyPayload` 在 config `updateDirty` 中调用 `applySecurityPolicyToOpenClawPluginConfig`，将结果全量复制回 mutable config，固定返回 `changed:true`；没有本地 validation、diff、merge、retry或权限判定。
- **状态、存储与副作用：** 无内存状态；写 OpenClaw config；具体 plugin config 规则在 projection service。它不直接执行 tool、sandbox、Gateway 或 approval。
- **并发与性能特征：** 继承 config repository 的 process-local串行 read-modify-write，整份 JSON I/O；无 cache/outbox/actor。
- **调用/依赖边界：** security application workflow/service 形成上游 policy，CodeGraph 显示 infrastructure module 构造此 workflow；security capability/route 通过通用 capability router 分派到 domain，再到 projection。没有直接 Gateway/CLI 链路。
- **故障、恢复与安全：** config error传播；没有 native Runtime apply confirmation或回滚。policy/config 可能含安全敏感规则，不能记录完整 payload/config；该文件本身不处理 secret/redaction。
- **迁移分类：** **Preserve：** security policy projection、replace contents、force changed write。**Intentional Improvement：** 将 Domain policy evaluation 与 Edge config translation保持隔离，并只有 diff 变化时写；该改进不得把 OpenClaw tool policy/harness 迁成 Matcha execution policy。**Defect：** 无已证实缺陷。**待验证：** plugin config 的 runtime reload semantics、force-write watcher依赖和 projection service 完整性。
- **未来 Rust owner：** `SecurityPolicyPayload` 的规则/事实归 Security **Domain Module**；OpenClaw plugin config encoding归 **Native Runtime Edge**；Foundation Kernel提供 config task supervision/redaction，不能拥有 security domain semantics。
- **Rust 重写与性能判断：** typed `ApplyOpenClawSecurityProjection` 投递 config single-writer actor；无外部 acknowledgement不建 Edge outbox。若 policy domain要求可靠投递，可由其 own outbox/reconciliation。测量 unchanged policy write count、mutation latency、native observed config/version；保持 projection output differential。
- **验证 oracle：** policy preset/override matrix、config replacement/unchanged fixture、write failure、concurrent security/provider mutations、whole-config/payload redaction scan和 native plugin integration fixture（待补）。
- **证据：** 本文件第 1–24 行；`projections/openclaw-security-plugin-config-service.ts`；`application/security/security-policy-types.ts`；CodeGraph 的 `registerOpenClawInfrastructure` 构造关系与 capability route 通用链路。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow.ts

- **当前 owner：** OpenClaw native CLI launcher command discovery；不拥有 CLI execution、task lifecycle 或 shell policy。
- **职责与关键 symbols：** `OpenClawCliCommandResult`、`OpenClawCliCommandWorkflow.cliCommand`。
- **旧语义与策略：** 先取 status；package 不存在返回失败；entry 不存在返回失败；若 sibling `.bin/openclaw(.cmd)` 存在，返回平台特定 shell command，Windows 为 `& '<path>'`、其他为 `"<path>"`；否则回退 `node '<entry>'`/`node "<entry>"`。只返回 command text，不启动进程。
- **状态、存储与副作用：** 无状态；只读取 filesystem status/path existence/platform；无写入、Gateway RPC、进程启动或事件。
- **并发与性能特征：** 常数数量的 file probes；无 lock/cache/retry/queue。
- **调用/依赖边界：** `OpenClawService.cliCommand` 转发；CodeGraph 证实 workflow 经 `registerOpenClawApplicationServices` 装配。Delivery/UI/API 可查询 command；真正 CLI/process launcher 是另一个边界，和 Gateway/event transport 无直接关系。
- **故障、恢复与安全：** expected missing package/entry映射为 typed failure，filesystem probe error则传播。返回 shell text，路径中的引号/不可信 environment layout 是否可能构成 command-injection 取决于下游 shell 执行和 layout trust，当前无完整调用证据，待验证；不记录路径以外的敏感环境。
- **迁移分类：** **Preserve：** check order、失败文案含路径、`.cmd` 选择、bin-first/node-fallback。**Intentional Improvement：** Rust 对内部返回 typed `Executable { program, args }`，只有 Delivery shell adapter 最后渲染旧 command string，避免核心层持有 shell grammar。**Defect：** 无已证实缺陷。**待验证：** command text 的所有 consumers、quoting 跨平台兼容和路径 trust。
- **未来 Rust owner：** discovery/projection归 **Native Runtime Edge**；最终进程启动属于 **Delivery**/Foundation supervised-process primitive；不把 OpenClaw CLI/tool harness迁入 Matcha domain。
- **Rust 重写与性能判断：** 无 actor/outbox；读 probes使用有界 blocking I/O。typed command消除命令字符串反复 parse/quoting 风险，而输出兼容由 renderer fixture保障。指标为 probe latency与 command rendering differential，不宣称启动吞吐提升。
- **验证 oracle：** missing package、missing entry、Windows/Unix bin present、node fallback、paths with spaces/quotes、filesystem error及 consumer shell rendering integration fixture。
- **证据：** 本文件第 5–35 行；`openclaw-service.ts` 第 73–75 行；CodeGraph 的 `registerOpenClawApplicationServices` 和 `OpenClawEnvironmentRepository` status/path methods。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow.ts

- **当前 owner：** OpenClaw config file (`openclaw.json`) 的 raw JSON read/write/replace mechanics；不拥有 section-level config 策略。
- **职责与关键 symbols：** `OpenClawEnvironmentConfigFileWorkflow.readOpenClawConfigJson`、`writeOpenClawConfigJson`、strict parse helpers、recoverable replacement error classifier。
- **旧语义与策略：** missing config 读为 `{}`；存在文件必须 parse 为 record，否则 throw `Invalid OpenClaw config JSON: <path>`。写入先 create config dir，写 `.<basename>.<pid>.<timestamp>.tmp`，rename 覆盖；rename 若为 `EPERM`/`EACCES`/`EBUSY` 则直接写目标并尝试删 temp；其他错误或外层错误均 best-effort cleanup temp 后 rethrow。
- **状态、存储与副作用：** 无内存状态；filesystem create/read/write/rename/remove。整个 config 可含 Runtime credential/reference，故只允许 private config boundary处理，禁止以完整 JSON 进入 logs/公开 API。
- **并发与性能特征：** 每 write 物化全 JSON content；本 workflow不持有 lock，常规 config repository 的 process-local mutex是相邻保证，直接 caller/跨进程不受它保护。无 fsync、revision/CAS/cache。
- **调用/依赖边界：** `OpenClawEnvironmentRepository` 代理此 workflow，`OpenClawConfigRepository` 调它供 provider/plugin/security/routing等所有 projection 使用；CodeGraph 的 infrastructure registration把该 config port扩散到 application services。没有 direct Gateway/CLI，native runtime 后续解释文件。
- **故障、恢复与安全：** 错误清理临时文件后传播；fallback direct write降低 rename-lock failure时的失败率，却失去 rename replace路径。无证据证明 fsync/crash durability、Windows replace semantics或跨进程互斥。错误内容带 path，但不主动带 config content。
- **迁移分类：** **Preserve：** missing→empty、invalid record throw、temp naming、rename-first、三类 recoverable fallback、cleanup/rethrow。**Intentional Improvement：** atomic write with fsync/parent sync与 typed failure原因；必须用 crash/Windows fixtures证明并明确这种 durability改变。**Defect：** 无已证实缺陷。**待验证：** fallback 覆盖时的损坏窗口、temp collision、跨进程 writer。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawConfigFileStore`；Foundation Kernel提供 atomic/private file primitive与 blocking I/O supervision；section schema仍在 Edge。
- **Rust 重写与性能判断：** 由 Edge keyed config actor串行化，worker 进行 temp-write/fsync/atomic replace；无 outbox，因为它是本地 projection而没有 remote receipt。可测旧成本为每 mutation完整 JSON materialization；指标是 write bytes、p95、crash recovery、temp residue和 Windows lock fallback rate。
- **验证 oracle：** missing/valid/array/scalar/invalid JSON、rename success、EPERM/EACCES/EBUSY fallback、other rename error、write failure cleanup、interrupted write/restart、多进程 contention及 config secret-redaction scan。
- **证据：** 本文件第 12–73 行；`infrastructure/openclaw-environment-repository.ts`、`infrastructure/openclaw-config-repository.ts`；09 分片第 115–128 行的 config mutex/repository 调用证据。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow.ts

- **当前 owner：** OpenClaw installation directory 的轻量 observed-status projection。
- **职责与关键 symbols：** `OpenClawEnvironmentStatusWorkflow.getOpenClawStatus`、`readPackageVersion`、JSON record parser。
- **旧语义与策略：** `packageExists` 要求 root dir 和 `package.json` 都存在；`isBuilt` 独立检查 `dist`；entry path固定 `<dir>/openclaw.mjs`，不在此检查 entry；仅 packageExists 时尝试读取 package version，坏/不可读/无效 version都省略 version而不失败。因此 `isBuilt` 可与 packageExists 不一致，属于当前 observed fields而非 readiness verdict。
- **状态、存储与副作用：** 无状态，只读 filesystem/package JSON；无 config写、Gateway、CLI启动、网络或日志。
- **并发与性能特征：** 常数数量 exists/read/parse；无 cache、lock、queue或retry。多个 status caller会重复 probes。
- **调用/依赖边界：** `OpenClawEnvironmentRepository.getOpenClawStatus` 和 `OpenClawService.status/ready` 消费；CLI command workflow 再检查 entry。composition 为 services/CLI 提供同一 environment layout；和 Gateway readiness不同，不能混同。
- **故障、恢复与安全：** version read errors吞掉并返回无 version；exists error行为由 port传播。只暴露文件路径/version，不含 secret；公开拓扑层仍不应回显任意 environment。
- **迁移分类：** **Preserve：** package/built 独立判定、entry/dir fields、version best-effort omission。**Intentional Improvement：** 可把 `installed`、`built`、`entryPresent` 做成明确 observed facts，保持现有 `ready` mapping兼容。**Defect：** 无已证实缺陷。**待验证：** `dist` 是否是全部支持安装形式的 build signal、version parse失败的诊断需求。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawInstallationProbe`；通用 endpoint observed readiness/identity模型归 **Matcha Platform Core**，Gateway readiness仍由 Runtime Integration bridge拥有。
- **Rust 重写与性能判断：** 无 actor/outbox；有限 blocking probes。仅在 startup/status polling profile显示热点时缓存短 TTL snapshot，并保留显式 refresh。指标为 probe I/O、status latency和 stale-window；当前无优化必要证据。
- **验证 oracle：** dir/package/dist/entry 的组合矩阵、valid/invalid/missing version、permission/error、`OpenClawService.ready` 和 CLI workflow 双层判定差分。
- **证据：** 本文件第 12–55 行；`openclaw-service.ts` 第 23–29 行；`openclaw-cli-command-workflow.ts` 第 20–35 行；`infrastructure/openclaw-environment-repository.ts`。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-subagent-template-workflow.ts

- **当前 owner：** OpenClaw subagent template directory/catalog 的 discovery、metadata extraction与内容读取；不拥有 Matcha subagent domain policy或 OpenClaw agent harness执行。
- **职责与关键 symbols：** template/catalog types、`OpenClawSubagentTemplateWorkflow.listCatalog`/`getTemplate`、metadata/list/detail readers、identity/category parsing/sorting helpers。
- **旧语义与策略：** 对 source candidates 依序选第一个存在、可读且有 templates 的目录；坏 source 静默继续下一个，均失败返回空 catalog。template 必须是 source 下目录且至少有一个五个允许文件；list 从 `IDENTITY.md` heading/首行与 `AGENTS.md` 首条正文提取显示信息，metadata 只接受正规 id/order；按 order/id 排序。getTemplate 先 list 验证 exact id，再只读取允许文件，空/非字符串 ID 返回 null。
- **状态、存储与副作用：** 无持久 state；只读 candidate directory、catalog JSON、Markdown。读取的 agent prompts/template 内容可能包含不受信任指令，但并非 secret store；secret 必须禁止进入此类 prompt 文件及 public catalog/logs。
- **并发与性能特征：** 每次 list/get 都可扫描 candidate、目录、每 template 的五个 exists和多个完整文件；逐项 await，多次 `getTemplate` 会重复 list。无 cache/lock/queue，内存随 catalog与文件内容增长。
- **调用/依赖边界：** `SubagentTemplateService` facade、`OpenClawService.subagentTemplates/subagentTemplate`、workspace/application route 是上游链；CodeGraph 将 source candidates连到 environment repository、workflow连到 workspace service/composition。它不调用 Gateway/CLI；template 被 OpenClaw native agent harness消费，但本项目不迁移该 harness。
- **故障、恢复与安全：** candidate/list/read errors通常吞掉并 fall through/null；detail中一个 file read failure会使该 source被跳过。ID因先来自 list result而不直接任意 join，降低 path traversal面；symlink/source trust和 template 内容的 prompt-injection治理未由本文件证明。无 secret redaction。
- **迁移分类：** **Preserve：** candidate precedence、malformed-source fallthrough、allowed file白名单、metadata/identity fallback、排序、invalid ID null。**Intentional Improvement：** source snapshot cache只在明确 invalidation/mtime策略后引入；将 template content标为 untrusted native prompt input。**Defect：** 无已证实缺陷。**待验证：** source directory trust/symlink、content permission、read-error应否诊断。
- **未来 Rust owner：** **Native Runtime Edge** 的 `OpenClawTemplateCatalog`; 产品 subagent domain 只消费 typed catalog/detail contract；绝不把 AGENTS/SOUL/TOOLS prompt/harness语义迁入 Matcha Platform Core。
- **Rust 重写与性能判断：** bounded blocking directory walker、允许的文件名 enum、可选 immutable snapshot cache；无 actor/outbox。若 cache被采用，要测扫描次数、first-list latency、失效后可见性和最大内容内存，同时以 exact catalog/detail fixtures守住行为。
- **验证 oracle：** candidate precedence、missing/malformed catalog、missing/partial template files、identity heading/emoji/summary、category fallback/order、unknown/encoded ID、unreadable file、symlink/trust和 prompt-secret lint fixture；现有 workspace-template migration tests可复用部分 filesystem fixture。
- **证据：** 本文件第 4–352 行；`infrastructure/openclaw-subagent-template-service.ts`；`openclaw-service.ts` 第 39–50 行；CodeGraph 的 workspace query/maintenance/template composition关系。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow.ts

- **当前 owner：** OpenClaw workspace 内 Matcha-managed template、identity、legacy bootstrap 与 context snippet 的文件维护投影；不拥有 Session/TeamRun/agent prompt 的业务语义。
- **职责与关键 symbols：** `initializeAgentWorkspace`、`ensureIdentityFile`、`ensureDefaultIdentity`、`migrateMainAgentTemplatesIfNeeded`、`mergeContextSnippets`及 template/candidate/read helpers；`mainAgentTemplate`/`emptyWorkspace` 初始化结果类型。
- **旧语义与策略：** initialize 可建目录，否则不存在即空；`emptyWorkspace` 无改动，template 初始化只 exclusive 写缺失文件，若当前内容与 upstream snapshot一致才替换为 managed template，之后删 legacy `BOOTSTRAP.md`。identity 也先 exclusive write，或仅在内容等于 upstream identity时替换，永远尝试删 bootstrap。default identity 遍历 task workspace。main migration 仅当 managed/upstream `AGENTS.md` 均存在，且每文件当前等于 upstream时替换。context merge 找到首个 context dir后对各 task workspace 调 helper，缺失 context 仅 debug/空结果。
- **状态、存储与副作用：** 无持久内存 state；创建目录、exclusive/普通 Markdown write、删 bootstrap、读取 resources/OpenClaw templates、写 context snippets、info/debug/warn 日志。workspace Markdown会进入 OpenClaw prompt/harness，严禁写入 secret；本 workflow 不可成为 Matcha tool policy owner。
- **并发与性能特征：** task workspace 及 template file大多串行 I/O；内容整体读入内存；无 per-workspace lock/atomic multi-file transaction/rollback。并行维护可能出现 lost update；多个文件迁移中断可部分完成。
- **调用/依赖边界：** `OpenClawWorkspaceService` facade 向 workspace/session/skill/subagent application services暴露；CodeGraph 确认 maintenance 依赖 query workflow和 environment repository，且有 `tests/unit/runtime-host-workspace-template-migration.test.ts`。它不直接调用 Gateway/CLI，OpenClaw在后续 native runtime读取这些文件。
- **故障、恢复与安全：** required managed/upstream目录缺失时 warning并无迁移；多个 optional template/read error常静默；显式 filesystem write/remove errors通常传播。内容 equality依赖 CRLF归一+trimEnd，不是内容安全验证；context/template source trust、prompt injection、secret leak、并发写均待验证。
- **迁移分类：** **Preserve：** createDir/no-dir、empty workspace、exclusive write、仅替换未定制 upstream template、fallback identity、bootstrap removal、candidate precedence、task-workspace aggregation。**Intentional Improvement：** Edge 内按 workspace keyed mutation actor、atomic per-file write和 typed partial result；Domain 提供已审查 context content，Edge仅套 marker。**Defect：** 无已证实缺陷。**待验证：** current-vs-upstream equality对用户定制的完整兼容、并发维护、partial migration/recovery、prompt content governance。
- **未来 Rust owner：** file/layout mechanics为 **Native Runtime Edge**；Session/TeamRun/Skill等 Domain Module 只产生受审查的抽象 context/template request；Foundation Kernel提供 file mutation/serialization，不能吸收 OpenClaw prompt/harness规则。
- **Rust 重写与性能判断：** 每 workspace bounded writer actor，filesystem进 blocking pool；多文件操作返回逐项 outcome而不是伪原子结果。无 external outbox；若 Domain context需要可靠投递，Domain outbox只记录 desired context revision。可测旧成本为重复全文读写和并发 lost-update风险：指标为 write count、p95、partial recovery、最大文件内存和 prompt-secret lint。
- **验证 oracle：** missing/existing/createDir、empty/template init、upstream-equal replacement与user-customized preservation、fallback identity、bootstrap deletion、multi-workspace aggregation、managed/upstream candidate precedence、context missing/merge error、concurrent writes、interrupted migration及现有 workspace template migration tests。
- **证据：** 本文件第 8–371 行；`infrastructure/openclaw-workspace-context-merge.ts`；`infrastructure/openclaw-workspace-service.ts`；CodeGraph 的 `OpenClawWorkspaceMaintenanceWorkflow` callers/tests。

### runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow.ts

- **当前 owner：** OpenClaw config 到 config/skills/main/session/task workspace path 的只读 resolver facade；不拥有 generic workspace identity或 filesystem contents。
- **职责与关键 symbols：** `OpenClawWorkspaceQueryWorkflow` 的 config/skills/readme/preview/main/session/task methods；使用 OpenClaw-specific `resolveMainWorkspaceDir`、`resolveWorkspaceDirForSession`、`resolveTaskWorkspaceDirs`。
- **旧语义与策略：** config/skills/readme path为同步 string join；preview 读一次 config，返回 skills、main、tasks（可有重复，未在此去重）；main/session/task each read config并调用 rules。session key不在本层验证，规则层解释 `agent:` grammar及 fallback。
- **状态、存储与副作用：** 无内存 state；路径 getter无 I/O，preview/main/session/task只读 OpenClaw config；不创建目录、不读 workspace 内容、不写 config、不调用 Gateway/CLI。
- **并发与性能特征：** 无 lock/cache；每 async query均可能完整 config read/parse。规则计算为小型 agent list线性扫描；高频 preview/query会重复 I/O。
- **调用/依赖边界：** `OpenClawWorkspaceService`、maintenance workflow、session config directory、skills/operations workspace ports使用；CodeGraph 显示 query workflow由 infrastructure module构造并被 workspace service/maintenance调用。路径可能作为 Delivery/API query 输出，但 capability router 不应赋予调用者对任意 native path 的写权。
- **故障、恢复与安全：** config read error传播；workflows不做 path existence、canonicalization、symlink containment或 `skillKey`/session key parser。是否这些输入仅来自 trusted domain contracts需要调用方证据，故不能断言漏洞；paths和 workspace prompt内容都不应含 secret。
- **迁移分类：** **Preserve：** current path composition、每次 async query fresh config、preview ordering、rules layer的 main/session/task resolution。**Intentional Improvement：** typed `WorkspaceRef`/validated skill key，若引入 realpath/allowlist必须明确为安全行为变化，不能改变不存在路径的当前输出。**Defect：** 无已证实缺陷。**待验证：** API consumers是否将返回 path用于授权、cross-platform/symlink语义、preview重复项契约。
- **未来 Rust owner：** OpenClaw config-to-path projection为 **Native Runtime Edge**；generic endpoint/session identity grammar为 **Matcha Platform Core**；workspace product intent和authorization归相应 **Domain Module**。
- **Rust 重写与性能判断：** pure resolver读取 typed config snapshot；不要在无 revision/invalidation契约时加 cache。无 actor/outbox；阻塞 config read交有界 executor。可测指标是 config read rate、query p95和 N-agent resolution；只有 profile证实热点才缓存。
- **验证 oracle：** config/skills/readme paths、main/session/task precedence、`agent:` session、malformed config、preview ordering/duplicates、missing config/I-O error、Unix/Windows path、symlink/path containment与 Delivery authorization fixture。
- **证据：** 本文件第 1–45 行；`infrastructure/openclaw-workspace-rules.ts`；`infrastructure/openclaw-workspace-service.ts`；CodeGraph 的 query workflow callers及 workspace/operations port builders。

## 未读、排除与源改动确认

- **未读（本分片范围）：0。** Python 枚举的 16 个 `workflows/**/*.ts` 加 inventory 指定 `openclaw-service.ts` 共 17 个，均已全文读取并在上文各有一条文件记录。
- **范围差异：0。** `00-inventory.md` 第 11 分片预期 17 个文件，与当前工作树现存清单逐路径一致。
- **明确排除：** `runtime-host/build/**` 编译产物、依赖目录、测试输出/临时目录，以及 inventory 分给其他分片的 OpenClaw infrastructure/projections/runtime/gateway、composition、API routes、capability/domain/bridge 文件。这些不是本报告的逐文件对象；为调用链证据经 CodeGraph 读取/追踪的 composition、service/projection、route、capability router、Gateway/CLI 相邻节点不增加本分片计数。
- **无源改动确认：** 本审计未修改 `runtime-host` 源码、测试、README、inventory、任何其他报告、配置或锁文件；本次唯一写入目标为本报告。

## 当前 Git status 增量边界（2026-07-12）

- 本分片 inventory 内没有 workflow/service production source status 改动。已修改的 TeamRun `openclaw-team-role-session-materialization-adapter.ts` 归 12，不应因依赖 OpenClaw RPC而改列本分片。
- Electron process-runtime/Gateway launch、Host API、renderer和CI只可作为 workflow 的 Delivery/topology/oracle evidence；OpenClaw CLI discovery/config workflow不拥有 child PID、Electron quit或桌面 shell。反过来，当前 Electron 中承载受管 Runtime lifecycle的语义是目标 Rust Local Process Host的外部旧 owner，必须在对应 lifecycle slice走读，而不应被本分片或 Electron目录永久吸收。
- OpenClaw native config/auth/template/workspace/CLI仍为 Runtime Integration或Native Runtime Edge；其产品 desired state仍在相应 Domain Module。没有 Rust cutover、OpenClaw CLI execution或文件写入/restart/secret redaction的运行验证。
