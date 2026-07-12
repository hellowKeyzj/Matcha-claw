# 10 — OpenClaw projections：TS → Rust 文件级迁移审计

> **静态审计状态：** 已完成；本报告是旧 `runtime-host` 的事实审计，不是批准的 Rust 实施计划。
> **范围核对：** 与 `00-inventory.md` 的 10 分片一致：当前存在 37 个 `.ts`，已完整读取 37 个，未读 0。

## 已读文件清单（37）

1. `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-projection.ts`
2. `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status-jobs.ts`
3. `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status.ts`
4. `runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection.ts`
5. `runtime-host/application/adapters/openclaw/projections/openclaw-agent-tool-config-projection.ts`
6. `runtime-host/application/adapters/openclaw/projections/openclaw-anthropic-messages-max-tokens.ts`
7. `runtime-host/application/adapters/openclaw/projections/openclaw-capability-routing-service.ts`
8. `runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection.ts`
9. `runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts`
10. `runtime-host/application/adapters/openclaw/projections/openclaw-channel-plugin-bindings.ts`
11. `runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer-rules.ts`
12. `runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer.ts`
13. `runtime-host/application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service.ts`
14. `runtime-host/application/adapters/openclaw/projections/openclaw-injected-plugin-catalog-platform-policy.ts`
15. `runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog.ts`
16. `runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer.ts`
17. `runtime-host/application/adapters/openclaw/projections/openclaw-oauth-plugin-registration.ts`
18. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-catalog-kind-policy.ts`
19. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-channel-config.ts`
20. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-model.ts`
21. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service.ts`
22. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-discovery-state.ts`
23. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-install-record.ts`
24. `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-skill-sync.ts`
25. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-accounts-projection-port.ts`
26. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-rules.ts`
27. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-service.ts`
28. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-entry-builder.ts`
29. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-model-pruning.ts`
30. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-models-service.ts`
31. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules.ts`
32. `runtime-host/application/adapters/openclaw/projections/openclaw-provider-snapshot.ts`
33. `runtime-host/application/adapters/openclaw/projections/openclaw-proxy-sync.ts`
34. `runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-service.ts`
35. `runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync.ts`
36. `runtime-host/application/adapters/openclaw/projections/openclaw-security-plugin-config-service.ts`
37. `runtime-host/application/adapters/openclaw/projections/openclaw-subagent-config-projection.ts`

## 横向调用链与状态语义

- **事实源链：** Matcha 的 connector、provider、channel、security、settings、subagent 与 plugin 领域命令是 desired 的来源；本分片将其翻译为 OpenClaw 的 config、extensions workspace、私有 auth/profile 或 runtime RPC。OpenClaw config / workspace 是**下游 projection**，不是 Matcha Platform Core 的事实源。
- **applied 边界：** `OpenClawConfigRepository.updateDirty()` / `patchSection()` 在进程内 `withOpenClawConfigLock()` 中 read → mutate → changed-only write。成功返回最多证明 config write 已 applied；本分片未证明底层写入采用 temp-file、rename 或 fsync，不能声称 config 的跨进程/断电原子性。
- **restart 边界：** 多处写入 `commands.restart = true`。它是 OpenClaw config 内的可重启命令标记，不是 `GatewayProcessController.restart()` 调用，也不证明 restart 已执行或已生效。
- **observed 边界：** `ExternalConnectorOpenClawMcpStatusProvider` 是本分片唯一将 Gateway RPC 结果转换为 `pending` / `unknown` / `disconnected` / `connected` 的实现；它经低优先级、session-key 去重的 refresh job 查询 `mcpServerStatus/list`。其他 config projection 只有 desired/applied，不能把 config 成功写盘误报为 runtime connected。
- **所有权：** Matcha Platform Core 只应拥有跨 Runtime 的 desired/applied/observed、receipt、correlation 通用协议；OpenClaw config schema、plugin/workspace 操作、native auth 与 Gateway 协议应落在 **Domain Module（Environment / Extension）＋ Runtime Integration（Native Runtime Edge）**。不得把 OpenClaw config tree 迁入 Platform Core。

---

### runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-projection.ts

- **当前 owner：** External Connector 到 OpenClaw MCP config 的下游 projection；connector store 是 Matcha source-of-truth。
- **职责与关键 symbols：** `ExternalConnectorOpenClawMcpProjectionService.sync()`、`projectExternalConnectorToOpenClawMcpServer()`、`buildOpenClawMcpServerId()`；生成 stdio/http server 条目并清理旧 `matcha-external.*` / system-runtime ID。
- **旧语义与策略：** desired 是 enabled 的 `ExternalConnectorSpec`；disabled、非 MCP、`secretEnv` 或 `secretHeaders` 的 connector 返回 `notProjectable`。stdio/http public env/header 被复制；system-runtime 使用 packaged/development CLI 路径解析。applied 是 `mcp.servers` section 的差异更新并标记 restart；observed 不在本文件。
- **状态、存储与副作用：** 读取 connector specs、写 OpenClaw `mcp.servers` config；不直接启动进程、写 workspace 或查询 Gateway。
- **并发与性能特征：** connector projection 用 `Promise.all`；合并为单次 `patchSection`。现有深比较是 `JSON.stringify`，成本随 server JSON 大小线性增长、且依赖对象键顺序。
- **调用/依赖边界：** 上游 `ExternalConnectorProjectionSourcePort`；下游 config repository；状态下游由同目录 MCP status provider 经 Gateway bridge 查询。
- **故障、恢复与安全：** 明确拒绝需要 private secret projection 的 secret 值，避免复制到公开 config；config I/O 错误传播。无 config rollback/compensation；`commands.restart` 非实际 restart；无 `unknown/disconnected/connected` 处理。
- **迁移分类：** Preserve：可投影条件、server ID、旧 ID 清理、无变更不写和 private-secret 拒绝。Intentional Improvement：以结构化 equality 替代 JSON 字符串比较时必须保持字段省略与比较语义。Defect：无证据。
- **未来 Rust owner：** Domain Module（External Connector desired spec）＋ Runtime Integration / Native Runtime Edge（OpenClaw MCP projection）。
- **Rust 重写与性能判断：** 旧成本为每次全量 JSON stringify 和 O(n) server reconciliation；可使用 typed server map / stable canonical comparison。保留：一次 config patch、拒绝 secret、旧 ID 删除。指标：projection latency、JSON allocation、写入次数/字节。oracle：connector→config golden trace、secret fault case、n-server benchmark。
- **验证 oracle：** `tests/unit/external-connector-openclaw-mcp-projection.test.ts`；补 disabled、stale-ID、private secret、system-runtime packaged/dev path、write-failure fixtures。
- **证据：** 本文件 28–233 行；`openclaw-config-repository.ts` 40–64 行；`external-connector-openclaw-mcp-status.ts` 38–220 行。

### runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status-jobs.ts

- **当前 owner：** Gateway MCP observed-status 刷新的 job 提交适配器。
- **职责与关键 symbols：** `OPENCLAW_MCP_SERVER_STATUS_REFRESH_JOB`、`createOpenClawMcpServerStatusRefreshJobPort()`、`buildOpenClawMcpStatusRefreshDedupeKey()`。
- **旧语义与策略：** desired 是对某 `sessionKey` 的观测请求；applied 是向 long-task service 提交 low queue job，按 job-name+sessionKey 去重且使用共享 refresh cooldown；observed 由完成 job result 产生，本文件不解释状态。
- **状态、存储与副作用：** 无本地状态或文件 I/O；调用 runtime task queue。
- **并发与性能特征：** 纯 O(|sessionKey|) dedupe-key 形成；并发合并依赖 `RuntimeLongTaskSubmissionPort`，而非本文件锁。
- **调用/依赖边界：** 被 MCP status provider 注入；依赖 runtime-host long-task ports 与 `RUNTIME_REFRESH_JOB_COOLDOWN_MS`。
- **故障、恢复与安全：** 不持有 secrets；提交失败语义由 task port 决定。无 retry/rollback、无 config/restart；没有自行把 pending 写成 connected。
- **迁移分类：** Preserve：low queue、dedupe key 格式、cooldown。Defect：无证据；待验证：task service 在进程重启后的 job persistence。
- **未来 Rust owner：** Foundation Kernel（job dedupe/queue primitive）＋ Runtime Integration（OpenClaw status job binding）。
- **Rust 重写与性能判断：** 旧成本可忽略；不要为一条 key 拼接引入 actor。若迁移 task kernel，保留 dedupe/cooldown；指标：重复请求合并率、队列等待、RPC 次数；oracle：并发同 session trace、cooldown fault/benchmark。
- **验证 oracle：** 提交参数与 dedupe-key table test；与 status provider 的 repeated-call integration trace。
- **证据：** 本文件 1–30 行；status provider 163–179 行。

### runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status.ts

- **当前 owner：** OpenClaw Gateway MCP server 的 observed downstream-status provider。
- **职责与关键 symbols：** `ExternalConnectorOpenClawMcpStatusProvider.listStatuses()`、`refreshOpenClawMcpServerStatusesForJob()`、`listOpenClawMcpServerStatuses()`。
- **旧语义与策略：** source desired 为 connector spec；先复用 projection 的 projectability，disabled→`disabled`、不可投影→`unsupported`、可投影→`pending`。job 未完成为 `pending/refreshing`；capability/RPC 不可用为 `unknown`；status list 缺 server 或 `available:false` 为 `disconnected`；`available!==false` 为 `connected`。这是 observed，不推断 config applied。
- **状态、存储与副作用：** 不写 config；通过 long-task cache 读取/提交刷新，再经 Gateway RPC `mcpServerStatus/list` 获取 session 观测。
- **并发与性能特征：** base status `Promise.all`；后台 refresh 经 session dedupe；RPC 分页上限 100，使用 `Map` 去重覆盖同名 server。每页 30 秒超时。
- **调用/依赖边界：** 上游 external-connector service/status context；下游 gateway capability/RPC 与 refresh job port；复用 MCP projection server ID。
- **故障、恢复与安全：** capability 或 RPC 异常不抛给列表调用方而变 `unknown`；team-role local session 未给 endpoint session ID 时也为 unknown。无 secret 读取、无 restart。无主动 retry，靠下一轮 refresh。
- **迁移分类：** Preserve：四类状态的证据门槛、session-key 选择、分页、timeout、job-cache 语义。Defect：无证据；待验证：OpenClaw `available` 缺失是否应继续视作 connected。
- **未来 Rust owner：** Domain Module（External Connector status model）＋ Runtime Integration / Native Runtime Edge（Gateway protocol observer）。
- **Rust 重写与性能判断：** 旧成本是分页 RPC、JSON decode 和一次 connector 全量 map；不能用 config successful apply 代替 RPC。可用 streaming/typed decode 仅在保持 page order、timeout 与 unknown mapping 下优化；指标：RPC latency、page count、pending→terminal latency、allocation；oracle：Gateway transcript、timeout/capability/malformed-page fault injection、page-count benchmark。
- **验证 oracle：** `tests/unit/external-connector-openclaw-mcp-status.test.ts`；补 server absent、`available:false`、team-role、分页 cursor、job succeeded unavailable cases。
- **证据：** 本文件 38–310 行；job adapter 16–30 行；MCP projection 85–130 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection.ts

- **当前 owner：** 已配置 OpenClaw subagent 的 skill allowlist view / CAS mutation projection。
- **职责与关键 symbols：** `readAgentSkillConfig()`、`setAgentSkillConfig()`、`applyAgentSkillConfig()`、skill option/requirements normalization。
- **旧语义与策略：** desired 为 `SetAgentSkillConfigCommand`；先以 revision 防止 stale write，拒绝未配置 agent、未知/noncanonical/unselectable skill。无显式 list 时继承 defaults；defaults 为空则继承当前 runtime selectable skills。applied 是 `SubagentConfigProjectionPort.replaceConfig()` 成功写 config；skill runtime refresh 是 availability observed，不是 Gateway connected。
- **状态、存储与副作用：** 读取/全量复制 subagent config，调用 skill runtime 的 refresh/canonicalization/validation；自身不写 skill workspace、plugin 或 Gateway。
- **并发与性能特征：** 乐观并发（hash revision），每次 view 可刷新 skill status；数组去重采用 `includes`，当前预期小集合为 O(n²)。
- **调用/依赖边界：** 上游 agent-skill contracts；下游 subagent config projection 与 skill-runtime workflow；最终 config write 由 OpenClaw config repository 串行化。
- **故障、恢复与安全：** stale 返回 latest view 而非覆盖；runtime refresh error 传播。无 secrets/redaction、rollback 或 restart marker；不产生 `unknown/disconnected/connected`。
- **迁移分类：** Preserve：revision CAS、unsupported/invalid result、inherit-vs-explicit 语义、canonical key 保持。Intentional Improvement：当 skill 数量证实增长后改用 ordered set。Defect：无证据。
- **未来 Rust owner：** Domain Module（Skill / Subagent desired policy）＋ Runtime Integration（OpenClaw config projection）。
- **Rust 重写与性能判断：** 旧成本是 config clone、每 read refresh、线性去重；保留 validation-before-write 和 stale result。指标：CAS conflict rate、refresh latency、config clone bytes、selection cardinality；oracle：command/revision trace、skill status fault injection、N-skill benchmark。
- **验证 oracle：** stale revision、agent missing、inherit/default/explicit、noncanonical/blocked/missing-requirement skill fixtures。
- **证据：** 本文件 17–417 行；`openclaw-subagent-config-projection.ts` 68–117 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-agent-tool-config-projection.ts

- **当前 owner：** OpenClaw subagent tool policy view / CAS mutation projection，tool catalog 的 observed source 是 Gateway RPC。
- **职责与关键 symbols：** `readAgentToolConfig()`、`setAgentToolConfig()`、`readToolCatalog()`、`normalizeToolsCatalogResult()`、`applyAgentToolConfig()`。
- **旧语义与策略：** desired 为 inherit 或 profile+allow+deny。先 CAS revision、验证 agent 与 policy key；`tools.catalog` 返回 empty groups 视为 runtime error。applied 是配置 replace；observed 是 60s `tools.catalog` RPC 的 profiles/groups/tool metadata，不能由 config 写成功推断。
- **状态、存储与副作用：** 读写 subagent config；网络/RPC 仅读 Gateway catalog；无 workspace/plugin 操作。
- **并发与性能特征：** 每 read/set 至少可能一次 60s RPC；catalog option 去重和 key set 线性构建；config 以 CAS 避免 lost update。
- **调用/依赖边界：** 上游 agent-tool contracts；下游 subagent config projection 与 `GatewayRpcPort`；Gateway connectivity/timeout error 从 RPC 原样传播。
- **故障、恢复与安全：** stale 重读 catalog 后返回 latest；空 groups 抛出要求 reconnect 的错误。无 secret handling、rollback、restart 或 `unknown/disconnected/connected` 映射；调用者须将 RPC failure 映射到 UI state。
- **迁移分类：** Preserve：policy-key grammar（`*`、group、plugin、MCP wildcard）、catalog required groups、CAS。Defect：无证据；待验证：每次 read 都同步 RPC 的 UX 成本。
- **未来 Rust owner：** Domain Module（Subagent tool policy）＋ Runtime Integration / Native Runtime Edge（Gateway catalog translator）。
- **Rust 重写与性能判断：** 旧成本由 RPC 主导，非 TS loop；若加 TTL catalog cache 会改变 observed freshness，必须显式改进。保留即时 catalog、60s timeout 与 validation。指标：catalog p50/p99、RPC rate、stale conflict、payload bytes；oracle：Gateway catalog transcripts、timeout/empty/malformed fault、high-cardinality benchmark。
- **验证 oracle：** configured/missing agent、invalid allow/deny、inherit, stale CAS、core/plugin/MCP tool-key matrix。
- **证据：** 本文件 34–481 行；Gateway RPC 103–106 行；subagent config projection 72–108 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-anthropic-messages-max-tokens.ts

- **当前 owner：** Anthropic-messages provider/model token-limit 的纯 compatibility policy。
- **职责与关键 symbols：** constants、`isAnthropicMessagesApi()`、`normalizePositiveMaxTokens()`、`resolveAnthropicMessagesDefaultMaxTokens()`、`withAnthropicMessagesModelMaxTokens()`。
- **旧语义与策略：** desired 是 existing positive finite integer（floor 后保留），否则默认 32768；MiniMax provider/base URL/model ID 默认 131072。无 config applied 或 runtime observed。
- **状态、存储与副作用：** 无状态、I/O、secret、workspace、plugin、network 或 restart。
- **并发与性能特征：** O(1) normalisation，返回原对象仅在既有值已规范时成立，否则 shallow copy。
- **调用/依赖边界：** 被 provider entry builder 使用；属于 OpenClaw provider config schema policy。
- **故障、恢复与安全：** 非 finite、非数值、非正数安全降级；无 error/rollback/status。
- **迁移分类：** Preserve：MiniMax 判定与 floor/default 规则。Defect：无证据；待验证：OpenClaw / provider 当前 token upper bound。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** 旧成本可忽略；typed enum/provider classifier 可避免字符串重复 lower-case，但必须保留 exact URL/model matching。指标：zero allocation、policy throughput；oracle：provider/baseURL/model/maxTokens truth-table 与 microbenchmark。
- **验证 oracle：** positive fraction、NaN/Infinity、MiniMax 三种识别路径、normal provider fixtures。
- **证据：** 本文件 1–54 行；provider entry builder 41–95 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-capability-routing-service.ts

- **当前 owner：** capability route 至 OpenClaw `agents.defaults` / `messages.tts` 的 schema adapter；routing domain 本身不在此处拥有。
- **职责与关键 symbols：** route types、`applyRouteToAgentsDefaults()`、`applyTtsProvider()`、read functions、`OpenClawCapabilityRoutingService`。
- **旧语义与策略：** desired 为 chat/image/video/music model route 与 tts provider；空 route 删除对应 field、不制造空对象，非空写 `provider/model` primary+fallbacks。applied/read 由 workflow 委托；read 的 config 值是 downstream config snapshot，非 Gateway observed。
- **状态、存储与副作用：** helpers 仅改入参 config；service facade 委托 workflow，自己无 I/O/secret。
- **并发与性能特征：** O(route/fallback count)；无锁，锁与写入由 workflow/repository。
- **调用/依赖边界：** 上游 provider capability-routing domain；下游 OpenClaw capability-routing projection workflow 与 config repository。
- **故障、恢复与安全：** malformed model ref 被忽略为 undefined；无 rollback、restart marker、private secret 或 connection state。
- **迁移分类：** Preserve：path mapping、delete-on-empty、fallback parse/serialization。Defect：无证据；待验证：route update 是否应 emit restart marker 由 workflow 决定。
- **未来 Rust owner：** Domain Module（Provider capability routing desired state）＋ Runtime Integration（OpenClaw projection）。
- **Rust 重写与性能判断：** 旧成本为小 JSON object mutation；不要过度抽象。若 typed config 转换，保留 no-noise-diff。指标：diff bytes、route conversion latency；oracle：route→config and config→route golden round trips、malformed refs fault tests。
- **验证 oracle：** 6 capabilities、empty deletion、fallback filtering、TTS section cleanup fixtures。
- **证据：** 本文件 1–176 行；workflow interface imported at 18 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection.ts

- **当前 owner：** OpenClaw channel config schema projection，含 channel/plugin activation metadata；Channel domain 是 desired source。
- **职责与关键 symbols：** `OpenClawChannelPluginProjection`、`OpenClawChannelConfigProjection`、credential uniqueness、strict schema / Feishu / Discord conversion helpers。
- **旧语义与策略：** desired 是 channel/account config；按 strict dingtalk、Feishu top-level default、一般 accounts 三种 layout 写 config。拒绝跨 account 相同 bot credential；删除 stale accounts；Discord `guildId/channelId` 转 guilds map 且裁剪字段；WhatsApp default enabled。applied 仅是调用方持久化后的 config；observed connectivity 不在此处。
- **状态、存储与副作用：** helpers 原地改 config；仅 module-static maps/sets，无直接 file/network/process I/O。`getChannelFormValues()` 会返回选中 account 的非 `enabled/updatedAt` string values，因此包含 credential 的公开边界必须由 route/DTO 另证实。
- **并发与性能特征：** credential scan O(account count)，Discord deep JSON clone/scan O(guild config size)；无自身锁。
- **调用/依赖边界：** 实现 channel runtime、prelaunch plugin、runtime plugin catalog、cron delivery、activation strategy ports；持久化交由 channel workflow/repository，登录 session service 通过 save/restart callback 触发。
- **故障、恢复与安全：** duplicate credential 直接抛错避免 bot 双绑定；缺 `channelType` 抛错。无 transaction/rollback/restart invocation；无 `unknown/disconnected/connected`。credential form 输出是否到非私有调用方为待验证，不能据此断言泄露缺陷。
- **迁移分类：** Preserve：layout special cases、unique credential rejection、Discord sanitization、alias/delivery semantics。Defect：无证据。
- **未来 Rust owner：** Domain Module（Environment / Channel desired config）＋ Runtime Integration / Native Runtime Edge（OpenClaw schema projection）。
- **Rust 重写与性能判断：** 旧成本为 deep JSON clone 和 account scans；可以 typed channel variants 减少 clone，但必须保留 exact layout、stale deletion、error text/condition。指标：save latency、JSON allocation、credential scan size、diff bytes；oracle：channel/account golden fixtures、duplicate credential and malformed config fault tests、large Discord benchmark。
- **验证 oracle：** `tests/unit/channel-runtime-config.test.ts`、`tests/unit/openclaw-config-mutex.test.ts`；补 form redaction boundary integration test。
- **证据：** 本文件 15–420 行；channel bindings 7–82 行；CodeGraph callers in openclaw infrastructure module。

### runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts

- **当前 owner：** WhatsApp / OpenClaw-Weixin native QR login state machine、private credential materialization 与 post-success channel projection coordinator。
- **职责与关键 symbols：** `OpenClawChannelLoginSessionService.start/cancel()`、Weixin QR fetch/poll、WhatsApp Baileys socket/auth-dir lifecycle、event emission、`commit*ConfigAfterLoginSuccess()`。
- **旧语义与策略：** desired 是 start(channel, account/config)；only WhatsApp/Weixin supported，立即返回 queued session key。Weixin poll: wait/scan retry、最多 3 次 expired QR refresh、confirmed 时必须有 bot ID/token；WhatsApp QR→socket open→creds or 15s fallback success、logged-out / transient reconnect limits。applied：Weixin token 写私有 account store，WhatsApp credentials 存 runtime data auth dir；成功后才 save channel config 并调用 actual `restartGateway()`。observed：gateway channel-status events（QR/success/error），不是 generic connected enum。
- **状态、存储与副作用：** 单例内存 state（active login, abort controller, socket, retry, pending maps）；Weixin HTTP fetch/long-poll；WhatsApp runtime module load/socket；private filesystem auth directory；gateway event emission、config write、restart callback。
- **并发与性能特征：** 单一 Weixin login 与单一 WhatsApp active socket；同 account WhatsApp repeat request re-emit QR，不同 account stop then switch。poll 1s、Weixin request 35s、QR fetch 8s、overall 480s；QR PNG renderer 为 O(pixel count) CPU/Buffer/deflate。
- **调用/依赖边界：** implements channel login port; depends filesystem/runtime/workflow/id/timer/logger/event bridge/channel config/restart; Gateway observation/status follows emitted events and later gateway restart, not config marker.
- **故障、恢复与安全：** Weixin AbortError terminates safely; timeout/error emit events; WhatsApp login-created auth dir is removed on failed/cancelled attempt, logged-out cleanup occurs, cleanup errors only log warning. No atomic multi-resource transaction: private credential write, channel config, restart may partially succeed; no compensation for config-after-restart failure. Token is not copied to channel config by success payload, but source config supplied to `start()` is not generally redacted.
- **迁移分类：** Preserve：time limits, retry caps, queued response, success-only config commit, auth-dir cleanup, event names/payload shapes. Intentional Improvement：explicit persisted login receipt/recovery journal only if preserving observable events and cleanup semantics. Defect：no proven defect; post-credential/config/restart compensation is a documented migration gap, not evidence of current failure.
- **未来 Rust owner：** Domain Module（Environment / Channel login state machine）＋ Runtime Integration / Native Runtime Edge（Weixin/Baileys transports and private auth store）。
- **Rust 重写与性能判断：** 旧成本是 polling, socket callbacks, dynamic module loading and manual PNG rendering. An async actor per channel type can serialize state while preserving one-active-session behavior; do not parallelize state transitions. Metrics: QR-to-success latency, retry count, auth-dir cleanup success, poll/RPC bytes, PNG CPU/memory. Oracle: event trace replay, timeout/abort/network/logged-out fault injection, concurrent-start and QR-size benchmarks.
- **验证 oracle：** start/cancel, Weixin wait/expired/confirmed/incomplete credentials, WhatsApp open/creds/timeout/reconnect/logged-out, config/restart failure and auth-dir cleanup tests need coverage.
- **证据：** 本文件 242–814 行, especially 261–345, 410–490, 556–564, 646–813; `channel-login-session-service` port import at 5 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-channel-plugin-bindings.ts

- **当前 owner：** channel ↔ OpenClaw plugin static compatibility table。
- **职责与关键 symbols：** bindings constants、built-in/plugin-backed/strict-schema sets、bidirectional lookups。
- **旧语义与策略：** desired is fixed canonical mapping; Feishu/WeCom legacy plugin IDs are reverse-compatible. No applied config write or observed Gateway state.
- **状态、存储与副作用：** module initialization builds two private maps; no I/O, secrets, workspace, restart.
- **并发与性能特征：** constant-size O(n) initialization, amortized O(1) lookup; no lock.
- **调用/依赖边界：** used by channel projection, plugin config/channel mirror, sanitizer rules.
- **故障、恢复与安全：** unknown lookup returns undefined/false; no retry/rollback/connection state.
- **迁移分类：** Preserve：all IDs, legacy reverse lookup, channel-derived definition. Defect：无证据；待验证：exported mutable `Set` 是否被外部变更。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** 旧成本仅一次 Map 构建；static table + match/immutable map sufficient. Keep mapping/legacy priority; metrics lookup p99/allocation; oracle full truth-table and concurrent-read benchmark.
- **验证 oracle：** each channel, canonical/legacy/unknown ID table tests.
- **证据：** 本文件 1–82 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer-rules.ts

- **当前 owner：** OpenClaw config compatibility / normalization rule set；not config storage owner。
- **职责与关键 symbols：** `applyOpenClawConfigSanitizerRules()` plus plugin path, OAuth, tool, provider, bootstrap, strict channel, Discord and Feishu rules.
- **旧语义与策略：** desired is a canonical config derived in fixed rule order: delete misplaced skills/stale Kimi key, ensure restart/tool defaults/OpenAI runtime/bootstrap/skipBootstrap, remove stale paths, migrate plugin/channel layouts and ensure MiniMax OAuth. Rules mutate in-memory config only; applied belongs outer sanitizer/repository; no Gateway observed.
- **状态、存储与副作用：** config mutation and info logs; async `fileExists`, bundled discovery, OAuth-rule dependency. Feishu credential fields may move inside config; Kimi `apiKey` is removed. No universal redaction/private projection.
- **并发与性能特征：** config traversal O(tree); plugin path checks and discovery sequential; locking is external.
- **调用/依赖边界：** called only by config sanitizer; depends environment/OAuth service/channel bindings/logger.
- **故障、恢复与安全：** dependency errors propagate; no rollback/compensation. `commands.restart` only marker. No status enum behavior.
- **迁移分类：** Preserve：rule order, exact cleanup/migration, no-change false. Intentional Improvement：produce auditable structured change-set while preserving final config/log order. Defect：无证据；schema freshness 待验证。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost is full JSON traversal plus serial stats; use ordered typed/JSON transforms, do not parallelize order-sensitive I/O/logs. Metrics processing latency, stat count, allocation, diff bytes; oracle ordered fixture trace, file/OAuth fault injection, config-size benchmark.
- **验证 oracle：** rule-level and composed golden fixtures, missing/permission/OAuth faults.
- **证据：** 本文件 58–673 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer.ts

- **当前 owner：** config repair operation coordinator；storage owner remains config repository。
- **职责与关键 symbols：** `sanitizeOpenClawConfig()` and restart-marker helper.
- **旧语义与策略：** if observed config path missing, log and skip; otherwise desired is rules output. applied only when `updateDirty` reports changed; then write and set marker. It does not observe whether OpenClaw loaded it.
- **状态、存储与副作用：** checks path, locked config RMW, logs; calls OAuth discovery and environment path services.
- **并发与性能特征：** repository serializes in-process RMW; lock-held work includes full rules / directory discovery / stat work.
- **调用/依赖边界：** runtime config service → sanitizer → config repository/environment/OAuth service; no gateway restart manager call.
- **故障、恢复与安全：** errors propagate; no write-after-reload check, rollback or compensation. Secret behavior arises only from rules; logs do not include key values.
- **迁移分类：** Preserve：missing-file skip, changed-only write, restart marker/log. Intentional Improvement：staged fsync/rename only if storage contract adopts crash recovery. Defect：无证据。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost one lock-held full RMW; single writer preserves behavior. Metrics lock wait, write latency/bytes, crash recovery; oracle config trace and staged-write fault injection / benchmark.
- **验证 oracle：** absent/no-change/change, OAuth and write failure, no Gateway restart/observed-status side effect.
- **证据：** 本文件 7–51 行；repository 40–64 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service.ts

- **当前 owner：** custom-media plugin config facade；actual strategy/I/O belongs delegated workflow。
- **职责与关键 symbols：** exported media types; `readAll()` / `replaceAll()`.
- **旧语义与策略：** desired is provider→model map; applied is workflow replacement of OpenClaw plugin config; returned view is config projection, not Gateway observed.
- **状态、存储与副作用：** facade has no state/I/O; downstream workflow writes config.
- **并发与性能特征：** constant delegation here; downstream full map rebuild/comparison needs separate benchmark.
- **调用/依赖边界：** composition injects service and `OpenClawCustomMediaPluginConfigWorkflow`; no direct Gateway/restart.
- **故障、恢复与安全：** delegated errors propagate; headers may be persisted by workflow, so private-secret classification requires upstream contract verification. No rollback/status behavior here.
- **迁移分类：** Preserve：thin facade and errors. Intentional Improvement：private auth reference rather than raw secret headers only if domain contract declares headers secret. Defect：无证据。
- **未来 Rust owner：** Domain Module（Provider/custom-media desired state）＋ Runtime Integration。
- **Rust 重写与性能判断：** no local cost. For downstream full-map cost, preserve replacement/model semantics; metrics lock time, allocations, config bytes; oracle provider trace, secret-boundary check, I/O fault and scale benchmark.
- **验证 oracle：** `tests/unit/openclaw-custom-media-plugin-config-service.test.ts`; add secret/header boundary cases.
- **证据：** 本文件 1–25 行；workflow import at 1–5 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-injected-plugin-catalog-platform-policy.ts

- **当前 owner：** injected plugin catalog platform defaulting policy。
- **职责与关键 symbols：** `normalizePlatform()`.
- **旧语义与策略：** accepts only `matchaclaw` / `openclaw`; every other input defaults to `openclaw`. No applied/observed state.
- **状态、存储与副作用：** none: no config, filesystem, secret, workspace, restart.
- **并发与性能特征：** O(1), zero I/O.
- **调用/依赖边界：** implements injected plugin catalog port; composition supplies it.
- **故障、恢复与安全：** silent unknown fallback; no error/retry/rollback/status.
- **迁移分类：** Preserve：accepted values and fallback. Intentional Improvement：explicit unknown diagnostics only with protocol revision. Defect：无证据。
- **未来 Rust owner：** Runtime Integration.
- **Rust 重写与性能判断：** no meaningful old cost; enum conversion must preserve `Other→OpenClaw`. Metrics allocations/throughput; oracle valid/invalid input table and microbenchmark.
- **验证 oracle：** matchaclaw/openclaw/null/unknown/object matrix.
- **证据：** 本文件 1–8 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog.ts

- **当前 owner：** managed OpenClaw channel/capability plugin definition catalog, not installed-state owner。
- **职责与关键 symbols：** channel/capability/all definitions; `OpenClawManagedPluginCatalog` list/find methods.
- **旧语义与策略：** desired is fixed IDs, source-dir fallback order, companion skill auto-enable metadata; capability definition has priority in `findDefinition`. No applied installation or observed runtime state.
- **状态、存储与副作用：** static data only; no I/O, secrets, workspace, config, restart.
- **并发与性能特征：** lists return array reference; linear lookup over small fixed arrays.
- **调用/依赖边界：** used by managed installer/channel provision/prelaunch and plugin workflows.
- **故障、恢复与安全：** unknown returns undefined; no rollback/status.
- **迁移分类：** Preserve：catalog content/order/sourceDirs/companions/capability-first lookup. Defect：无证据；registry-version sync 待验证。
- **未来 Rust owner：** Domain Module（Extension catalog desired inventory）＋ Runtime Integration.
- **Rust 重写与性能判断：** small linear scan is cheaper than speculative hash map. Preserve order; only optimize after high-frequency lookup benchmark. Metrics lookup latency/allocation; oracle full catalog equality and source-order trace.
- **验证 oracle：** known/unknown IDs, companion skill definitions and precedence fixtures.
- **证据：** 本文件 1–78 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer.ts

- **当前 owner：** managed plugin registry discovery, installation/version skip and manifest ID patch side-effect owner。
- **职责与关键 symbols：** `discoverRegistryPlugin()`、source/target signatures、`ensureDefinitionInstalled()`、`patchInstalledPluginId()`。
- **旧语义与策略：** desired is catalog definition; scan registry roots then `sourceDirs` in declared order. If installed manifest/version matches and not force, skip; otherwise ensure root → remove target → copy source → patch manifest/entry IDs → assert manifest. applied proves disk contents only; Gateway loaded/connected remains unobserved.
- **状态、存储与副作用：** reads manifests/package/entry files; removes/copies OpenClaw extensions directory and writes patched texts. No config lock or install-record write.
- **并发与性能特征：** serial root/source probing; signature reads and full directory copy grow with tree size; no per-plugin exclusion lock.
- **调用/依赖边界：** install locations/filesystem/catalog/manifest loader/group policy; called by prelaunch/channel/plugin lifecycle paths.
- **故障、恢复与安全：** missing source retains existing target only for non-force; otherwise throws. Evidence shows non-atomic `remove→copy→patch→check`, with no staging/backup/compensation; this is a migration improvement target, not a proven user-visible defect. No secrets/status/restart.
- **迁移分类：** Preserve：root/source selection, skip/force, canonical patch. Intentional Improvement：stage+validate+atomic switch with old-target compensation. Defect：无 proven incident evidence.
- **未来 Rust owner：** Domain Module（Extension lifecycle desired plan）＋ Runtime Integration / Native Runtime Edge（filesystem installer）。
- **Rust 重写与性能判断：** old costs: serial stats/reads/full tree copy and partial-failure exposure. Preserve selection/patch behavior; staged install metric: scan syscalls, copy throughput, disk peak, install latency, failed-install recovery. Oracle: selection trace, each copy/patch/rename fault, directory-size benchmark.
- **验证 oracle：** prelaunch/plugin runtime tests named by CodeGraph; add concurrent same-ID, copy/patch failure, old-target preservation and atomic-switch tests.
- **证据：** 本文件 82–261 行, especially 174–209; CodeGraph call/test relations.

### runtime-host/application/adapters/openclaw/projections/openclaw-oauth-plugin-registration.ts

- **当前 owner：** bundled OAuth plugin manifest discovery, canonical/stale registration rules and in-memory discovery cache。
- **职责与关键 symbols：** discovery helpers, `applyOAuthPluginRegistration*()`, `OpenClawOAuthPluginRegistrationService`.
- **旧语义与策略：** observed input is `<openclawDir>/dist/extensions` manifests; desired registration is provider-matched canonical ID plus stale IDs, fallback `${provider}-auth`. Apply mutates supplied config allow/entries only; outer caller owns applied write, runtime observed absent.
- **状态、存储与副作用：** directory read/JSON parse; cache keyed only by extensions directory; malformed entries/unreadable directory silently ignored. No OAuth token reads/writes/logging.
- **并发与性能特征：** cold scan O(entries) serial exists/read; warm O(1); concurrent first discoveries can duplicate scan because no mutex.
- **调用/依赖边界：** sanitizer requests discovery/enable; config repository gives root; runtime filesystem/logger are downstream.
- **故障、恢复与安全：** failed discovery can fall back to synthetic ID; no retry/cache invalidation/rollback; no connected state or restart. Silent fallback product impact is pending verification, not defect.
- **迁移分类：** Preserve：provider/legacy parsing, malformed-ignore, fallback, stale cleanup, canonical enable. Intentional Improvement：directory signature/explicit reload cache invalidation with safe diagnostics. Defect：无证据。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost cold scan and stale cache. Preserve cache semantics unless intentional invalidation change. Metrics scan latency, read count, cache hit, memory; oracle manifest-selection trace, malformed/permission faults, cold/warm benchmark.
- **验证 oracle：** matching/no-match/legacy/malformed/unreadable fixtures, idempotent apply/removal tests.
- **证据：** 本文件 25–339 行；sanitizer 17–47 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-catalog-kind-policy.ts

- **当前 owner：** discovered plugin → catalog kind pure classification policy。
- **职责与关键 symbols：** `OpenClawPluginCatalogKindPolicy.inferPluginKind()`.
- **旧语义与策略：** extension sources always third-party; otherwise `@matchaclaw/` package is builtin; otherwise only matchaclaw platform is builtin. No applied/observed config.
- **状态、存储与副作用：** none.
- **并发与性能特征：** O(package-name length), no I/O/lock.
- **调用/依赖边界：** implements plugin catalog policy port; discovery workflow supplies inputs.
- **故障、恢复与安全：** null/non-string package name degrades safely; no status/secret/rollback.
- **迁移分类：** Preserve：source-first precedence/default third-party. Defect：无证据；future extension kind policy 待验证。
- **未来 Rust owner：** Runtime Integration.
- **Rust 重写与性能判断：** no meaningful old cost; enum/source matcher retain precedence. Metrics throughput/allocations; oracle source/package/platform truth table.
- **验证 oracle：** extension, package prefix, missing package, two platform fixtures.
- **证据：** 本文件 1–21 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-channel-config.ts

- **当前 owner：** channel config → plugin entry mirror and unconfigured external plugin-dir cleanup policy。
- **职责与关键 symbols：** configured builtin/external listing, `mirrorPluginBackedChannelStateToOpenClawConfig()`, `cleanupUnconfiguredExternalChannelPluginDirs()`.
- **旧语义与策略：** observed config determines enabled configured channels; desired mirror copies enabled/defaultAccount/accounts for Discord/QQBot/WhatsApp plugin entries and sanitizes Discord fields. Cleanup desired retains only externally configured dirs; applied removes each other binding dir. Neither confirms Gateway loaded state.
- **状态、存储与副作用：** mirror returns cloned config; cleanup stats/removes `<configDir>/extensions/*`. Accounts are JSON-copied with no redaction; whether those include public-sensitive credentials requires route/domain boundary verification.
- **并发与性能特征：** full deep clone plus channel scan; cleanup serial stat/remove per fixed binding; no transaction with config write.
- **调用/依赖边界：** uses channel bindings/config repository/plugin FS/model; plugin config workflow persists returned tree.
- **故障、恢复与安全：** clone/removal errors propagate; deletion has no backup/rollback, mid-batch leaves partial cleanup. No restart/status mapping.
- **迁移分类：** Preserve：enabled test/sort, plugin-backed restriction, Discord conversion, binding-order cleanup. Intentional Improvement：recoverable reconciliation journal for config+filesystem. Defect：无 evidence of failure.
- **未来 Rust owner：** Domain Module（Environment / Channel desired state）＋ Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost deep clone, scan, serial filesystem work. Preserve outputs/deletion order; typed model only if benchmark reduces clone cost. Metrics allocations, stat/remove count, cleanup latency, partial-failure recovery; oracle transform trace, per-remove fault, scale benchmark.
- **验证 oracle：** builtin/external/disabled cases, Discord field fixture, account mirror, deletion failure/reconcile tests.
- **证据：** 本文件 16–188 行; bindings 7–82 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-model.ts

- **当前 owner：** plugin config JSON normalization/clone/cleanup helper policy。
- **职责与关键 symbols：** legacy ID map, record guard, canonical allow/deny/entries readers, `cleanupPluginContainer()`, `cloneConfig()`.
- **旧语义与策略：** desired is canonical plugin IDs: legacy Feishu/WeCom map to canonical; when lark exists, bare Feishu is suppressed. Helpers produce transient config, not applied write or observed runtime status.
- **状态、存储与副作用：** no I/O; `cloneConfig()` uses JSON stringify/parse, so undefined/non-JSON values are lost by design if present.
- **并发与性能特征：** clone O(config JSON bytes) with duplicate peak memory; entries/allow scans linear.
- **调用/依赖边界：** shared by plugin config, skill sync, sanitizer, security policy and discovery helpers.
- **故障、恢复与安全：** record guards prevent arrays/null; no secret redaction, rollback, restart or status behavior. JSON clone preservation for non-JSON config is pending verification.
- **迁移分类：** Preserve：legacy normalization, lark-vs-feishu deletion, empty-container cleanup. Defect：no evidence; JSON-only clone limitation is an explicit compatibility constraint to test.
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost full stringify/parse; `serde_json` deep clone could retain JSON semantics but must not accidentally preserve invalid JS-only values. Metrics clone bytes/allocation/time; oracle legacy/empty/JSON edge golden tests and large config benchmark.
- **验证 oracle：** allow/deny/entries canonicalization, legacy collision, empty cleanup, JSON clone edge cases.
- **证据：** 本文件 1–83 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service.ts

- **当前 owner：** manually managed/channel-derived OpenClaw plugin desired state merger and workflow facade。
- **职责与关键 symbols：** manual reads, effective/owned/trusted set resolution, `applyEnabledPluginIdsToOpenClawConfig()`, `applyManuallyManagedPluginIdsToOpenClawConfig()`, service facade.
- **旧语义与策略：** desired is manual IDs plus configured channel/builtin requirements; source config is downstream input, catalog/bundled discovery are native capability inputs. Applies canonical IDs, disables owned absent IDs, preserves unrelated trusted allow entries, excludes bundled provider plugins, mirrors plugin-backed channel state and syncs plugin skills. It returns next config; workflow/repository is applied boundary; no Gateway observed.
- **状态、存储与副作用：** reads discovery roots/manifests and clones config; no direct write here except facade delegation. No raw secret handling.
- **并发与性能特征：** repeated bundled discovery in several helpers and JSON clone; set operations linear. Any write lock is outside helper but workflow likely calls it inside a config RMW.
- **调用/依赖边界：** bootstrap normalizer, catalog/bindings/model/discovery/channel/skill helpers, config workflow; invoked by browser mode/runtime plugin paths.
- **故障、恢复与安全：** filesystem discovery errors follow helper behavior; no rollback/compensation/restart marker/status. Trusted allowlist preserves non-owned entries by design.
- **迁移分类：** Preserve：ownership boundary, bundled-provider exclusion, canonical IDs, manual/channel merge, unrelated allowlist preservation. Intentional Improvement：memoize discovery only with invalidation and semantic trace. Defect：无证据。
- **未来 Rust owner：** Domain Module（Extension desired selection）＋ Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old costs are repeated directory scans and full config clone. Retain ordering/ownership; cache discovery with source signatures only if measured. Metrics manifest reads, lock duration, config allocation, plugin reconciliation latency; oracle plugin-set/config trace, malformed manifest fault, plugin-count benchmark.
- **验证 oracle：** runtime plugin/prelaunch tests, browser native/relay transitions, legacy/bundled/unrelated allowlist matrices.
- **证据：** 本文件 37–281 行; CodeGraph `applyEnabledPluginIds…` call chain.

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-discovery-state.ts

- **当前 owner：** OpenClaw runtime plugin discovery and enabled-state resolution adapter。
- **职责与关键 symbols：** `readDiscoveredPluginState()`, `resolveEnabledPluginIdsFromDiscoveredState()`, bundled-provider/bundled discovery helpers.
- **旧语义与策略：** observed filesystem manifests across ordered runtime roots form discovery; desired enabled state derives from global enabled, allow/deny, per-entry and source defaults. Workspace plugins require explicit allow/enable; bundled defaults require `enabledByDefault`; first root wins duplicate ID. No config write/applied or Gateway observed.
- **状态、存储与副作用：** directory listing/read manifest only; unreadable root is skipped; no secrets/writes.
- **并发与性能特征：** roots and entries serial, O(root entries); reads only manifest candidates; no cache/lock.
- **调用/依赖边界：** depends location rules/plugin ID/config repository/filesystem/model helpers; used by plugin config and sanitizer.
- **故障、恢复与安全：** list failure silently skips root; missing/malformed JSON falls back to directory name via normalizer. No retry/rollback/status.
- **迁移分类：** Preserve：root order, first-wins duplicate behavior, source-specific enable rules, skip unreadable roots. Defect：无证据；silent skip diagnostics 待验证。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost serial scans; do not parallelize if it changes first-wins order/error suppression. Metrics scan latency, directory/file reads, duplicate collisions; oracle ordered discovery trace, unreadable/malformed faults, many-plugin benchmark.
- **验证 oracle：** root precedence, workspace explicit enable, bundled default, allow/deny/entry override and duplicate fixtures.
- **证据：** 本文件 1–199 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-install-record.ts

- **当前 owner：** OpenClaw `plugins.installs` metadata pure upsert transformer。
- **职责与关键 symbols：** `InstallSource`, params, `upsertPluginInstallRecord()`.
- **旧语义与策略：** desired is nonblank plugin ID/source/path/spec/version; updates source and supplied normalized optional fields, preserves existing `installedAt/resolvedAt`, fills missing timestamps. applied is caller config write only; no observed install/runtime health.
- **状态、存储与副作用：** no I/O; returns structural config copy on change, otherwise original reference.
- **并发与性能特征：** shallow record comparisons O(field count); no lock.
- **调用/依赖边界：** intended for plugin install workflow/config mutation; no Gateway link in this file.
- **故障、恢复与安全：** blank ID no-op; no secret field policy, rollback, restart, status.
- **迁移分类：** Preserve：timestamp fill-once, optional trim/omit, no-op reference behavior. Defect：无证据.
- **未来 Rust owner：** Domain Module（Extension install receipt metadata）＋ Runtime Integration（OpenClaw config serializer）。
- **Rust 重写与性能判断：** old cost negligible; immutable typed record update preserves fields. Metrics allocation/update throughput; oracle timestamp/idempotency golden trace and microbenchmark.
- **验证 oracle：** empty ID, initial upsert, repeat upsert, whitespace options, preexisting timestamps.
- **证据：** 本文件 1–110 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-plugin-skill-sync.ts

- **当前 owner：** enabled plugin state → OpenClaw skill entry enablement projector。
- **职责与关键 symbols：** declared-path skill collection, discovery map, `applyPluginSkillStateToConfig()`, `syncPluginSkillsToOpenClawConfig()`.
- **旧语义与策略：** desired is enabled plugin IDs; observed input is plugin manifests/SKILL.md filesystem; applies `skills.entries[skillId].enabled` for every discovered declared skill. `sync…` always returns changed true after replacement, even if effective config is equal; it does not mark restart or prove skill runtime loaded.
- **状态、存储与副作用：** reads manifests/directories/SKILL.md; public helper returns config; sync performs locked config update via repository. No secret processing.
- **并发与性能特征：** plugin discovery may run in parallel per plugin after initial discovery; per declared path directory traversal; config clone-like structural copy. Always-write behavior can cause needless I/O.
- **调用/依赖边界：** used by plugin config service; depends plugin discovery/location context/config repository/filesystem.
- **故障、恢复与安全：** malformed manifest/discovery per plugin is silently ignored; config write errors propagate. No rollback/compensation/restart/status. The unconditional changed result is code evidence of unnecessary write potential, but no measured impact or user failure: **待验证，不标 defect**.
- **迁移分类：** Preserve：manifest/SKILL discovery, enabled mapping, malformed-ignore. Intentional Improvement：changed-only write after structural equality, preserving final config; Defect：none proven.
- **未来 Rust owner：** Domain Module（Extension/Skill desired relation）＋ Runtime Integration。
- **Rust 重写与性能判断：** old costs are scans plus potential unconditional full config write. If optimizing, retain enable mapping and error suppression; metrics write count/bytes, scan latency, lock time; oracle skill-map trace, malformed/I/O faults, plugin/skill scale benchmark.
- **验证 oracle：** declared single/nested skill paths, enabled/disabled plugins, malformed manifests, no-effective-change write-count test.
- **证据：** 本文件 13–164 行, especially 144–163。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-accounts-projection-port.ts

- **当前 owner：** Provider account store → private auth/config projection port adapter。
- **职责与关键 symbols：** `OpenClawProviderAccountsProjectionPort`, API-key resolution and cleanup-key resolution.
- **旧语义与策略：** Matcha provider store/account is desired source; resolve checks local account ID then runtime projection key alias. Sync delegates store reconciliation; cleanup removes both canonical/runtime and original keys. Applied is delegated auth/config mutation; no Gateway observed.
- **状态、存储与副作用：** reads `store.apiKeys` in memory; delegates secret removal to auth-profile port and config removal to provider port. No direct config or network I/O.
- **并发与性能特征：** O(1) lookup/set construction; concurrency delegated to stores/workflows.
- **调用/依赖边界：** implements ProviderAccountsProjectionPort; depends provider sync/key resolver/private auth/config projection ports.
- **故障、恢复与安全：** API keys are returned only to caller and not logged/persisted in this file; private removal boundary is explicit. No rollback if secret removal and config removal are orchestrated separately elsewhere; no status/restart.
- **迁移分类：** Preserve：alias lookup fallback, de-duplicated cleanup keys, private auth separation. Defect：无证据.
- **未来 Rust owner：** Domain Module（Provider account desired/secret policy）＋ Runtime Integration / Native Runtime Edge（private auth projection）。
- **Rust 重写与性能判断：** no material cost; retain secret non-logging and cleanup-key order/set semantics. Metrics lookup latency and secret-projection audit events; oracle alias/cleanup trace and secret redaction inspection.
- **验证 oracle：** direct/aliased/missing API key, duplicate key cleanup, delegated remove failures.
- **证据：** 本文件 1–71 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-rules.ts

- **当前 owner：** provider-specific OpenClaw config cleanup/upsert rules。
- **职责与关键 symbols：** `ensureGatewayLocalMode()`, Moonshot Kimi base URL rule, provider/models/auth-profile removals.
- **旧语义与策略：** desired provider config enforces local gateway mode; Moonshot provider selects CN/global base URL and deletes stale `kimi.apiKey`; removal deletes provider entry/profile keys. Helpers mutate config, not applied write; no runtime observed.
- **状态、存储与副作用：** pure in-memory JSON mutation; no direct secret store I/O. Explicit Kimi key deletion supports private projection rather than config secret duplication.
- **并发与性能特征：** linear profile scan; no lock.
- **调用/依赖边界：** provider projection workflows use these rules; keys from provider projection rules.
- **故障、恢复与安全：** tolerant missing records; no rollback, marker, connection state. Authentication profile deletion has no compensation in this helper; caller transaction semantics absent.
- **迁移分类：** Preserve：local mode, exact Moonshot endpoints, API-key deletion, profile/provider cleanup. Defect：无证据。
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge.
- **Rust 重写与性能判断：** tiny JSON transformation; retain field deletion/endpoint values. Metrics diff bytes/profile scan time; oracle Moonshot and removal fixtures, secret-absence assertion, scale profile benchmark.
- **验证 oracle：** both Moonshot keys, missing sections, provider/profile removal and Kimi key deletion.
- **证据：** 本文件 1–94 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-service.ts

- **当前 owner：** provider config workflow facade plus process-env map builder。
- **职责与关键 symbols：** `OpenClawProviderConfigService`, `buildProviderEnvVars()`, re-exported registry resolver.
- **旧语义与策略：** desired provider override is delegated to workflow; `buildProviderEnvVars` maps nonempty type/API key to registry env name. applied config effect belongs workflow; returned env map is private runtime projection, not Gateway observed.
- **状态、存储与副作用：** no own I/O/state; API key enters an in-memory environment map and is not logged here.
- **并发与性能特征：** linear provider array construction; no lock.
- **调用/依赖边界：** provider registry/workflow are downstream; account store should remain source truth.
- **故障、恢复与安全：** keys are intentionally projected as env values, so caller must keep map private and avoid serialization; this file has no redaction/rollback/status. No code evidence of public exposure.
- **迁移分类：** Preserve：workflow facade, registry env mapping, empty-key omission. Defect：无证据.
- **未来 Rust owner：** Domain Module（Provider secret policy）＋ Runtime Integration / Native Runtime Edge（private env projection）。
- **Rust 重写与性能判断：** old cost negligible; retain mapping and no logging. Metrics allocation/provider count; oracle env-map golden and secret-redaction audit test.
- **验证 oracle：** supported/unsupported type, blank key, duplicate env key behavior.
- **证据：** 本文件 1–35 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-entry-builder.ts

- **当前 owner：** provider override → `models.providers` entry pure builder。
- **职责与关键 symbols：** override/options types, `upsertOpenClawProviderEntry()`, model max-token/runtime-pin helpers.
- **旧语义与策略：** desired includes base URL/API/key env/headers/auth-header/replaced keys; removes aliases, preserves unrelated existing fields/models, normalizes Anthropic model/provider token limits, removes `maxTokens` for other APIs and pins OpenAI/Codex `agentRuntime:pi` when absent. Applied is caller config write; no observed health.
- **状态、存储与副作用：** only config mutation; `apiKey` stores env variable name rather than raw secret, while headers are copied as given and require upstream private classification.
- **并发与性能特征：** model array map linear; reference comparison marks changes even when structurally equal reconstructed values, potentially producing writes depending on caller.
- **调用/依赖边界：** provider config workflow; consumes Anthropic token and provider key rules.
- **故障、恢复与安全：** record guards; no rollback/restart/status. Raw key is not accepted except named env reference; raw secret headers remain a boundary to verify, not proven defect.
- **迁移分类：** Preserve：field mutation/removal, alias removal, token/runtimes. Intentional Improvement：structural equality only after preserving write/noise semantics. Defect：none proven.
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old costs: linear model rewrite and potentially unnecessary diff from reconstructed objects. Preserve final JSON; metrics write rate, model transform latency, config bytes; oracle provider config trace, header secret-boundary check, model-count benchmark.
- **验证 oracle：** Anthropic/MiniMax/non-Anthropic max tokens, OpenAI pin, replacement keys, headers empty/nonempty fixtures.
- **证据：** 本文件 1–133 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-model-pruning.ts

- **当前 owner：** agent default/per-agent model reference cleanup policy after provider/model removal。
- **职责与关键 symbols：** provider and valid-ref prune functions, primary/fallback promotion logic.
- **旧语义与策略：** desired is removal of provider refs or unknown refs; preserve non-model strings, filter invalid/duplicate fallbacks, promote first valid fallback to primary, delete model field if no primary remains. No applied repository write or Gateway observed.
- **状态、存储与副作用：** in-memory config mutation only; no secrets/I/O.
- **并发与性能特征：** scans defaults plus agent list and fallbacks; equality uses JSON stringify per changed candidate.
- **调用/依赖边界：** used by provider-model projection workflow when replacing/removing provider model entries.
- **故障、恢复与安全：** malformed/non-object values retained; no rollback/restart/status.
- **迁移分类：** Preserve：promotion order, dedupe, delete-on-empty. Defect：无证据。
- **未来 Rust owner：** Domain Module（Provider model desired set）＋ Runtime Integration（OpenClaw config cleanup）。
- **Rust 重写与性能判断：** old costs per-agent scans/stringify. Preserve fallback order and malformed handling; metrics agent/model count latency, allocation, fields pruned; oracle prune golden cases and high-cardinality benchmark.
- **验证 oracle：** primary removal with fallback promotion, all removed, duplicates, valid-ref filter and malformed values.
- **证据：** 本文件 1–172 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-models-service.ts

- **当前 owner：** provider-model projection workflow facade。
- **职责与关键 symbols：** exported types; `readAll()` / `replaceAll()`.
- **旧语义与策略：** desired model map and optional valid refs are delegated; applied is workflow config update; read is downstream config view, not model availability/Gateway observed.
- **状态、存储与副作用：** none locally.
- **并发与性能特征：** constant delegation; workflow owns full replacement cost.
- **调用/依赖边界：** composition/provider models workflow; no direct gateway/restart.
- **故障、恢复与安全：** delegated errors propagate; no secret/rollback/status behavior locally.
- **迁移分类：** Preserve：facade contract. Defect：无证据.
- **未来 Rust owner：** Domain Module（Provider model desired state）＋ Runtime Integration.
- **Rust 重写与性能判断：** no local optimization. If optimizing workflow, retain replace-all/valid-ref pruning; metrics config write bytes/latency; oracle model-map trace and I/O fault/scale benchmark.
- **验证 oracle：** provider-model workflow tests and replace/read round trip.
- **证据：** 本文件 1–26 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules.ts

- **当前 owner：** provider identity/OAuth endpoint/env-name compatibility policy。
- **职责与关键 symbols：** provider key resolution, legacy key, OAuth type/target/base URL/API/auth-header/env helpers.
- **旧语义与策略：** desired maps Matcha vendor/account identity to OpenClaw key: custom/ollama multi-instance suffix, MiniMax CN alias, OpenAI browser OAuth Codex key. It sets OAuth API/base URL/env names; no config applied or runtime observed.
- **状态、存储与副作用：** pure constants/string transforms; no raw token or secret values.
- **并发与性能特征：** O(identifier length), static sets.
- **调用/依赖边界：** provider account/config workflows and sanitizer; feeds provider entry/auth projection.
- **故障、恢复与安全：** normalization strips unsafe chars; unknown provider defaults to type key. No rollback/restart/status.
- **迁移分类：** Preserve：all constants, suffix derivation, CN/global mappings and OAuth API/env semantics. Defect：无 evidence; provider contract freshness pending verification.
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** string work minor; typed provider enum may improve clarity but retain unknown fallback and sanitize exactness. Metrics allocation/key resolution latency; oracle full provider/account truth table and microbenchmark.
- **验证 oracle：** custom/ollama UUID suffix, MiniMax CN, OpenAI oauth browser, base URL normalization, unknown provider.
- **证据：** 本文件 1–165 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-provider-snapshot.ts

- **当前 owner：** downstream OpenClaw config/auth-profile provider snapshot reader; it is not the Matcha provider source-of-truth.
- **职责与关键 symbols：** `OpenClawProviderSnapshotService.getSnapshot/getActiveProviders/getProvidersConfig()`, auth profile aggregation.
- **旧语义与策略：** observed input is config `models.providers`, default model, enabled `*-auth` plugins and auth profile stores. It clones provider entries, adds default-model provider and auth providers (empty entry if absent). Config/auth read error yields empty snapshot and warning, not connected/disconnected status.
- **状态、存储与副作用：** reads config and each discovered agent auth profile; no writes/secrets returned beyond raw provider config object may contain runtime fields.
- **并发与性能特征：** auth profile stores are read serially per agent; snapshot clone linear in provider/config count.
- **调用/依赖边界：** used by OpenClaw service status/config query; depends config repository/auth repository/logger.
- **故障、恢复与安全：** broad catch masks any config/auth error as empty snapshot; this is documented behavior, not enough evidence to label defect. No private key extraction/logging, rollback/restart/Gateway state.
- **迁移分类：** Preserve：provider inference and fail-closed-to-empty snapshot. Intentional Improvement：typed partial-error receipt only if callers retain existing empty result behavior or contract changes. Defect：无 evidence.
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge; provider domain remains source owner.
- **Rust 重写与性能判断：** old costs serial profile reads and cloning. Concurrent reads could reorder errors but output set is unordered; only do after trace verification. Metrics read latency/profile count/allocations/error-empty rate; oracle config+auth trace, per-store fault, many-agent benchmark.
- **验证 oracle：** config provider/default/plugin/auth combinations; read failure produces exact empty shape.
- **证据：** 本文件 1–116 行; OpenClaw service imports it at `openclaw-service.ts` 1–17.

### runtime-host/application/adapters/openclaw/projections/openclaw-proxy-sync.ts

- **当前 owner：** Matcha proxy settings → OpenClaw Telegram account proxy config projection。
- **职责与关键 symbols：** `ProxySettings`, `syncProxyConfigToOpenClaw()`, normalization helpers.
- **旧语义与策略：** desired is app proxy enabled/server/bypass settings, but only server becomes Telegram default-account `proxy`; bypass rules are deliberately unused. Disabled preserve mode retains existing proxy and logs skip; otherwise blank deletes proxy. applied is locked config RMW; no observed network/Gateway reachability.
- **状态、存储与副作用：** reads/writes config only; creates telegram accounts/default account if Telegram section exists, but does nothing if section absent.
- **并发与性能特征：** O(1) mutation under repository lock; no external network probe.
- **调用/依赖边界：** runtime config service delegates here; config repository/logger downstream.
- **故障、恢复与安全：** write errors propagate; no restart marker, rollback or status verification. `proxyBypassRules` unused is code fact; whether omission is product defect is **待验证**.
- **迁移分类：** Preserve：scheme normalization, absent Telegram no-op, preserve-disabled default, delete semantics. Intentional Improvement：support bypass only after OpenClaw schema/product decision. Defect：none proven.
- **未来 Rust owner：** Domain Module（Environment settings desired state）＋ Runtime Integration。
- **Rust 重写与性能判断：** negligible transformation; preserve no-op/preserve behavior. Metrics write count/latency; oracle enabled/disabled/preserve/absent section trace and config-write fault test.
- **验证 oracle：** protocol/no-protocol, disabled with/without preserve, empty proxy, absent Telegram, bypass compatibility decision.
- **证据：** 本文件 4–101 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-service.ts

- **当前 owner：** runtime-config operation facade wiring sanitize/proxy/token/browser/session/tool policies.
- **职责与关键 symbols：** `OpenClawRuntimeConfigService` methods.
- **旧语义与策略：** Matcha settings/token commands are desired; each method delegates to specialized projection. applied is delegated config update; no method observes Gateway reload/connection.
- **状态、存储与副作用：** no local state; holds config/OAuth/environment/plugin filesystem/logger dependencies and delegates.
- **并发与性能特征：** no local work; downstream config repository serializes mutations.
- **调用/依赖边界：** OpenClaw service exposes tool permission methods; application composition constructs dependencies; downstream all relevant projection helpers.
- **故障、恢复与安全：** errors propagate. Gateway token must remain private but facade does not redact it; implementation writes it in runtime config projection. No compensation/status itself.
- **迁移分类：** Preserve：method/return contracts and delegation. Defect：无 evidence.
- **未来 Rust owner：** Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** facade has no cost; avoid a generic config layer that moves OpenClaw tree into Platform Core. Metrics are downstream operation latency; oracle delegate call/argument trace and error propagation test.
- **验证 oracle：** one spy/contract test per delegated operation plus integration config fixtures.
- **证据：** 本文件 1–53 行; `openclaw-service.ts` 76–83 行.

### runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync.ts

- **当前 owner：** OpenClaw native runtime config mutation policies: tool permission, gateway token/control UI, browser/default SSRF policy/mode, session idle.
- **职责与关键 symbols：** tool mode read/sync, gateway token, browser config/mode, session idle, restart marker.
- **旧语义与策略：** desired comes from Matcha settings/token/browser mode. Tool `default/fullAccess` maps `fs.workspaceOnly`, deletes legacy exec fields; token forces token auth/local mode and allowed origins; browser defaults enable/profile/SSRF relaxations; mode toggles browser vs relay plugin and deny list; session default only when no reset policy. applied is repository patch/update plus marker when changed (browser mode marks unconditionally); no actual restart/observed Gateway state.
- **状态、存储与副作用：** config RMW; browser mode reads plugin filesystem/discovery. Gateway token is directly persisted in `gateway.auth.token`; it is a private runtime config field, not rejected/redacted here. Whether any public query serializes it must be verified outside scope.
- **并发与性能特征：** patches are small except browser mode, which lock-holds plugin discovery/config clone and always writes; no network I/O.
- **调用/依赖边界：** runtime config service/OpenClaw service; plugin config service/filesystem; config repository/logger. Gateway process restart is elsewhere.
- **故障、恢复与安全：** config/filesystem error propagates; no rollback after partial browser transformation because all changes are one config mutation. Browser mode forces SSRF relaxations as policy; security appropriateness is a product decision, not a code-proven defect. No `unknown/disconnected/connected` mapping.
- **迁移分类：** Preserve：exact permission/browser/session/token paths, legacy field deletion, allowed origins, restart marker semantics. Intentional Improvement：private secret store indirection for gateway token only with compatible OpenClaw auth delivery. Defect：no proven exposure.
- **未来 Rust owner：** Domain Module（Environment/Security desired policy）＋ Runtime Integration / Native Runtime Edge.
- **Rust 重写与性能判断：** old cost is browser-mode lock-held discovery/full config rewrite; retain plugin result/marker behavior. Metrics lock wait, manifest reads, config bytes, write count; oracle config transition traces, secret-redaction boundary audit, filesystem/write fault and plugin-count benchmark.
- **验证 oracle：** permission two-mode, token/origins/local mode, native/relay/disabled browser plugin set, session reset guard, changed/no-change and marker fixtures.
- **证据：** 本文件 13–410 行; plugin config service 197–267 行; repository 40–64 行.

### runtime-host/application/adapters/openclaw/projections/openclaw-security-plugin-config-service.ts

- **当前 owner：** security policy runtime payload → `security-core` plugin config projection facade。
- **职责与关键 symbols：** `applySecurityPolicyToOpenClawPluginConfig()`, `OpenClawSecurityPluginConfigService.applyPolicy()`.
- **旧语义与策略：** desired is `SecurityPolicyPayload.runtime`; it clones config, merges runtime fields into `plugins.entries.security-core.config`, cleans empty containers. applied is delegated workflow apply; no Gateway observed.
- **状态、存储与副作用：** pure helper plus workflow facade; no direct file/network/secret operations.
- **并发与性能特征：** JSON clone O(config size); no lock locally.
- **调用/依赖边界：** implements security plugin projection port; workflow/config repository apply downstream.
- **故障、恢复与安全：** payload fields are copied without redaction; policy contract must distinguish secret fields upstream. No rollback/restart/status in this file.
- **迁移分类：** Preserve：merge precedence (`runtime` overwrites existing), fixed plugin ID, cleanup. Defect：无 evidence.
- **未来 Rust owner：** Domain Module（Security desired policy）＋ Runtime Integration / Native Runtime Edge。
- **Rust 重写与性能判断：** old cost full JSON clone. Preserve merge/cleanup; typed patch only if it maintains unknown config fields. Metrics allocation/diff bytes/apply latency; oracle policy→config golden, private-field audit, I/O fault and config-size benchmark.
- **验证 oracle：** initial/merge/overwrite/empty plugin-container fixtures; delegated error propagation.
- **证据：** 本文件 1–44 行。

### runtime-host/application/adapters/openclaw/projections/openclaw-subagent-config-projection.ts

- **当前 owner：** OpenClaw `agents` config read/display and optimistic-CAS mutation projection for subagent description/model/skills.
- **职责与关键 symbols：** read/display, set methods, `readConfig`, `replaceConfig`, `updateAgentEntry`, snapshot/hash helpers.
- **旧语义与策略：** desired comes from subagent commands; reads return cloned full config/hash/path/time. `replaceConfig` compares supplied revision to hash inside locked RMW and returns `staleRevision` rather than overwriting. Point updates normalize agent ID, create absent entry, delete fields for undefined, dedupe displayed skill arrays. applied is config write after repository lock; no Gateway observed/restart marker.
- **状态、存储与副作用：** config read/write, snapshot clone via JSON stringify/parse; clock/hash/path are injected. Returned snapshot includes full config; route boundary must ensure private config fields are not exposed—this file has no redaction.
- **并发与性能特征：** in-process serialized RMW plus optimistic revision conflict; full config clone/hash each read/replacement; skills dedupe uses linear `includes`.
- **调用/依赖边界：** implements subagent config port; consumed by agent skill/tool projections and subagent routes; config repository is storage boundary.
- **故障、恢复与安全：** stale conflict is explicit; I/O/hash errors propagate. No rollback/restart/status. Full-config DTO redaction exposure is pending route audit, not a proven defect.
- **迁移分类：** Preserve：CAS semantics, update/create/delete behavior, snapshot revision/path/updatedAt, display normalization. Intentional Improvement：structured canonical subagent document only if hash/copy semantics and stale receipts remain compatible. Defect：无 evidence.
- **未来 Rust owner：** Domain Module（Subagent desired configuration）＋ Runtime Integration / Native Runtime Edge（OpenClaw config document）。
- **Rust 重写与性能判断：** old costs full JSON clone/hash and linear dedupe. Preserve revision calculation timing and conflict result; metrics clone/hash latency, lock wait, conflict rate, config bytes; oracle revision trace, concurrent CAS/write fault, agent/skill cardinality benchmark.
- **验证 oracle：** `tests/unit/runtime-host-subagent-routes.test.ts`; add full-config redaction boundary, concurrent set/replace and non-JSON/clone behavior fixtures.
- **证据：** 本文件 14–219 行; agent skill/tool projections use its read/replace contracts.

## 反向覆盖核对与静态状态

- **Inventory → report：** `00-inventory.md` 的 10 分片 37 个路径均各有且仅有一条 `###` 文件记录；当前路径枚举亦为 37。
- **已读：** 37；**未读：** 0。
- **明确排除：** 无额外 production `.ts`；按用户范围未读取/审计 `runtime-host/build/**`、依赖目录、测试输出、其它 inventory 分片以及非 projection 源。它们不是本报告的文件记录对象。
- **源修改：** 无。此次工作树唯一创建/覆盖文件为本报告；未改 `runtime-host` 源、测试、README、`00-inventory.md`、其它报告、配置或锁文件。
- **静态状态：** 仅完成源码/CodeGraph 调用链审计；未运行测试、未执行 OpenClaw/Gateway、未验证真实 secret exposure、实际 restart、文件崩溃原子性或运行时连接，因此这些均未被误记为 observed 事实。

## 当前 Git status 增量边界（2026-07-12）

- 本分片 inventory 内没有 projection production source status 改动。`electron/main/process-runtime/**`、Gateway manager、renderer、CI与 app-server都不因邻近 OpenClaw 调用而变成 config projection owner。
- 当前 Electron Gateway/runtime-host/app-server process lifecycle 是目标 Rust Local Process Host 的外部旧 owner，仅其受管 lifecycle policy、spawn/attach、readiness、restart/backoff、logs、shutdown、PID/provenance与process-tree语义随对应 runtime-host功能块迁移；它不把 OpenClaw config tree、plugin/workspace/auth projection、LLM/tool harness或native approval上收给 Rust Core。
- OpenClaw config写入成功仍只表示 applied，而非 Gateway connected/ready或外部 effect completion；renderer和 Host API response都是 Delivery consumer evidence。Rust cutover、actual config application、restart和secret-safe projection均未执行验证。
