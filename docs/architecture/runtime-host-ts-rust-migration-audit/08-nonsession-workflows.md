# 08 非 Session workflow 审计

> 范围：`runtime-host/application/workflows/**` 中除 Session workflow 外的当前工作树 TypeScript 源。已按 `00-inventory.md` 的 08 分片逐个完整读取；CodeGraph 用于核对 composition/service 到 workflow 的调用关系。本文是旧 TS 的事实记录，不是 Rust 实施批准。

## 覆盖

- 清单路径：49；当前存在：49；完整读取：49；未读：0；排除：0。
- 已读文件清单：

```text
runtime-host/application/workflows/channel-runtime/channel-activation-workflow.ts
runtime-host/application/workflows/channel-runtime/channel-config-mutation-workflow.ts
runtime-host/application/workflows/channel-runtime/channel-config-workflow.ts
runtime-host/application/workflows/channel-runtime/channel-runtime-workflow.ts
runtime-host/application/workflows/cron/cron-job-mutation-workflow.ts
runtime-host/application/workflows/cron/cron-operations-workflow.ts
runtime-host/application/workflows/diagnostics/diagnostics-collection-workflow.ts
runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow.ts
runtime-host/application/workflows/platform-runtime/platform-native-tool-workflow.ts
runtime-host/application/workflows/platform-runtime/platform-run-session-workflow.ts
runtime-host/application/workflows/platform-runtime/platform-runtime-operations-workflow.ts
runtime-host/application/workflows/platform-runtime/platform-tool-runtime-workflow.ts
runtime-host/application/workflows/platform-runtime/platform-tool-state-workflow.ts
runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow.ts
runtime-host/application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow.ts
runtime-host/application/workflows/plugin-runtime/plugin-catalog-discovery-workflow.ts
runtime-host/application/workflows/plugin-runtime/plugin-runtime-operations-workflow.ts
runtime-host/application/workflows/provider-account/provider-account-mutation-workflow.ts
runtime-host/application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow.ts
runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow.ts
runtime-host/application/workflows/provider-model/provider-models-operations-workflow.ts
runtime-host/application/workflows/provider-model/provider-models-projection-workflow.ts
runtime-host/application/workflows/provider-models-store/provider-models-store-persistence-workflow.ts
runtime-host/application/workflows/provider-oauth/provider-oauth-completion-workflow.ts
runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow.ts
runtime-host/application/workflows/provider-store/provider-store-persistence-workflow.ts
runtime-host/application/workflows/runtime-bootstrap/gateway-prelaunch-workflow.ts
runtime-host/application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow.ts
runtime-host/application/workflows/runtime-host/runtime-host-operations-workflow.ts
runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow.ts
runtime-host/application/workflows/security-emergency/security-emergency-response-workflow.ts
runtime-host/application/workflows/security-operations/security-gateway-operations-workflow.ts
runtime-host/application/workflows/security-operations/security-operations-workflow.ts
runtime-host/application/workflows/security-policy/security-policy-store-workflow.ts
runtime-host/application/workflows/security-policy/security-policy-sync-workflow.ts
runtime-host/application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow.ts
runtime-host/application/workflows/settings-store/settings-store-workflow.ts
runtime-host/application/workflows/skill-install/clawhub-skill-install-workflow.ts
runtime-host/application/workflows/skill-install/local-skill-import-workflow.ts
runtime-host/application/workflows/skill-install/preinstalled-skills-workflow.ts
runtime-host/application/workflows/skill-install/skill-bundle-transfer-workflow.ts
runtime-host/application/workflows/skill-runtime/skill-runtime-workflow.ts
runtime-host/application/workflows/skill-runtime/skills-operations-workflow.ts
runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow.ts
runtime-host/application/workflows/task-runtime/task-operations-workflow.ts
runtime-host/application/workflows/task-runtime/task-runtime-workflow.ts
runtime-host/application/workflows/toolchain-install/uv-python-install-workflow.ts
runtime-host/application/workflows/usage/token-usage-history-workflow.ts
runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow.ts
```

### runtime-host/application/workflows/channel-runtime/channel-activation-workflow.ts

- **当前 owner：** Channel 领域激活策略编排；不拥有 channel 配置或登录会话状态。
- **当前事实：** `activate` 以 `channelUsesLoginSession` 分支：直连 channel 提交后台激活 job，登录型 channel 先准备插件、再创建 login session；`cancelSession` 只接受登录型 channel。
- **职责与关键 symbols：** `ChannelActivationWorkflow`；`DIRECT_CHANNEL_ACTIVATION_STRATEGY` 是未注入策略的默认值。
- **旧语义与策略：** 非登录型返回 `accepted(job)`，登录型等待 `prepareChannelPlugin`、`start` 后返回 `ok`；错误由依赖向上传播，错误 channel 取消返回 `badRequest`。
- **状态、存储与副作用：** 本身无状态；提交 channel job、安装/准备插件、读写登录会话由端口实现。
- **并发与性能特征：** 单请求常数次 await，无本地去重或锁；实际串行键由 jobs/login-session 实现决定。
- **调用/依赖边界：** 上游为 channel service/routes；下游为 `ChannelConfigPort`、`ChannelLoginSessionService`、`ChannelJobPort`。
- **故障、恢复与安全：** 不吞掉准备或登录错误；对非登录型取消明确拒绝；凭据不在此流经。
- **迁移分类：** Preserve：策略分支、accepted 与 ok 响应边界。Intentional Improvement：可把激活命令的 receipt/correlation 归 Platform Core，理由是当前仅透传 job；兼容影响是需维持异步响应形状，oracle 为 route 测试。Defect：无已证实项。待验证：登录 session 与 direct job 同时请求的冲突语义。
- **未来 Rust owner：** Domain Module（Channel）；后台提交原语分拆至 Foundation Kernel。
- **Rust 重写与性能判断：** 无性能优化结论。旧成本为一次策略判断及至多两次外部调用；不变量是两条激活路径和响应状态不变；指标为端到端激活延迟与重复请求数；oracle 为 channel runtime/config 单测及 gateway trace。
- **验证 oracle：** direct/login channel 的 activate/cancel route contract、插件准备失败、login start 失败。
- **证据：** 本文件；`application/channels/channel-activation-strategy.ts`、`channel-jobs.ts`、`channel-login-session-service.ts`。

### runtime-host/application/workflows/channel-runtime/channel-config-mutation-workflow.ts

- **当前 owner：** Channel 配置变更后的 gateway 重启编排。
- **当前事实：** `executeActivateDirect` 保存配置后重启；`executeDeleteConfigDirect` 删除配置后重启；只有 parent shell 显式成功才返回成功。
- **职责与关键 symbols：** `ChannelConfigMutationWorkflow`、私有 `restartGateway`。
- **旧语义与策略：** 配置写成功而重启失败时抛错，不回滚已写配置；顺序严格为 mutate 后 restart。
- **状态、存储与副作用：** 无内存状态；通过 `channelConfig` 修改运行配置并发 `gateway_restart` IPC/RPC。
- **并发与性能特征：** 每次串行两个 I/O；没有合并多个重启请求。
- **调用/依赖边界：** 上游为 Channel job 执行；下游 `ChannelConfigPort` 与 `ParentShellPort`，属于 runtime-host 到桌面宿主边界。
- **故障、恢复与安全：** 失败消息取 parent error；无补偿或幂等标记。
- **迁移分类：** Preserve：持久化在前、重启在后且重启失败可见。Intentional Improvement：以 Foundation Kernel 的带 correlation 的重启命令替换裸 request，理由是可观察恢复；兼容影响是仍须报告同一失败，oracle 为模拟 parent failure。Defect：无已证实项。待验证：调用方是否允许重试造成多次重启。
- **未来 Rust owner：** Domain Module（Channel）负责意图；Delivery 负责 Electron 重启 port；Foundation Kernel 可拥有命令监管。
- **Rust 重写与性能判断：** 旧成本为一次配置写和一次 restart；不变量为不得在配置成功前重启；指标为重启次数/配置到可用时间；oracle 为顺序 trace 与失败注入，不能据此宣称极致优化。
- **验证 oracle：** 保存/删除成功、config 失败、restart 失败且配置保留。
- **证据：** 本文件；`application/channels/channel-runtime.ts`、`application/runtime-host/parent-shell-port.ts`。

### runtime-host/application/workflows/channel-runtime/channel-config-workflow.ts

- **当前 owner：** Channel 配置、派生插件配置协调；真实配置状态 owner 是注入的 repository/projection。
- **当前事实：** 保存要求 record 与非空 trim 后的 `channelType`；配置 channel 前安装外部插件；所有保存/删除/配置插件协调后都调用派生 plugin state reconciliation。
- **职责与关键 symbols：** `ChannelConfigWorkflow`；`reconcileConfiguredChannelPlugins`、`saveChannelConfig`、`deleteChannelConfig`、`validateChannelConfig`、`replaceConfigContents`。
- **旧语义与策略：** 配置 channel 集合去重后按输入顺序串行安装；`delete` 以 section 是否存在决定 changed；凭据校验目前固定 valid；派生 projection 整体替换原 config 内容。
- **状态、存储与副作用：** 自身无状态；读/patch/updateDirty runtime config，安装 managed plugin，重算 plugin 派生状态。
- **并发与性能特征：** 配置 channel 插件安装为串行 N 次 await；reconcile 总是声明 `changed: true` 并整对象删除/复制，成本随 config 大小增长。
- **调用/依赖边界：** 上游 channel activation/mutation 与 prelaunch maintenance；下游 config store、channel projection、plugin projection/provisioner。
- **故障、恢复与安全：** payload 无效早拒绝；安装或 projection 错误直接传播；未在本层处理 secret。
- **迁移分类：** Preserve：channelType 规范化、先装插件再写 channel、删除后派生重算。Intentional Improvement：Rust 可做结构化 section mutation 避免全 config 替换；兼容影响是序列化字段与 changed 语义必须等价，oracle 为 config differential fixture。Defect：`validateChannelCredentials` 永远 valid 是当前占位行为，但是否应校验无外部契约证据，列待验证而非缺陷。待验证：repository 是否提供跨请求互斥。
- **未来 Rust owner：** Domain Module（Channel）；对 OpenClaw config 的具体 projection 为 Runtime Integration；插件安装为 Native Runtime Edge。
- **Rust 重写与性能判断：** 旧成本为 N 个串行安装和 O(config) replace；不变量是安装顺序及最终投影；指标为配置操作 I/O、写入字节和插件安装次数；oracle 为配置 golden、并发 mutation trace；未证实可安全并行化。
- **验证 oracle：** channel config unit tests、配置删除 idempotency、插件安装失败、派生 plugin state fixture。
- **证据：** 本文件；`application/channels/channel-runtime.ts`、`application/plugins/runtime-plugin-service.ts`、prelaunch workflow。

### runtime-host/application/workflows/channel-runtime/channel-runtime-workflow.ts

- **当前 owner：** Channel 运行态快照缓存与 gateway 调用编排。
- **当前事实：** 内存缓存保存最近 gateway status、ready/error/updatedAt；gateway ready 时 `snapshot` 尝试刷新，失败则以缓存加配置投影降级；非 ready 时只投影缓存。
- **职责与关键 symbols：** `ChannelRuntimeWorkflow`、`snapshot`、`refreshSnapshot`、`probeSnapshot`、`connect`、`disconnect`、`requestQr`、`fetchAndCache`。
- **旧语义与策略：** accountId 为空映射 `channelType-default`；connect/disconnect/QR 成功后强制刷新；QR 非 record 或缺字段归为空字符串；失败只更新 error 并抛出，保留旧缓存。
- **状态、存储与副作用：** 四个实例内缓存字段；读取配置、调用 gateway channel RPC，无持久化。
- **并发与性能特征：** 无 single-flight；并发 snapshot/connect 会重复 `channelsStatus`，后完成者覆盖缓存。
- **调用/依赖边界：** 上游 channel service/routes；下游 `GatewayChannelPort`、`ChannelConfigPort`、`projectChannelsSnapshot`。
- **故障、恢复与安全：** gateway 未就绪和启动错误由 readiness helper 区分；降级只返回已缓存数据，不伪造新状态。
- **迁移分类：** Preserve：ready/cache/error 字段、降级投影、操作后刷新。Intentional Improvement：可用 Domain Module 内按 runtime endpoint 的 single-flight snapshot；兼容影响是只消除重复 RPC、不改变结果，oracle 为并发 trace。Defect：无已证实项。待验证：缓存实例生命周期及多 endpoint 隔离。
- **未来 Rust owner：** Domain Module（Channel）；gateway port 实现归 Runtime Integration。
- **Rust 重写与性能判断：** 旧成本为重复 status RPC 和全量投影；不变量为最后成功快照、失败保留旧数据；指标为并发 RPC 数、快照延迟、stale 时长；oracle 为 mock gateway 调用计数和 snapshot fixture。
- **验证 oracle：** gateway unavailable、status failure with cache、QR 字段缺失、connect/disconnect refresh。
- **证据：** 本文件；`application/gateway/gateway-readiness.ts`、`channel-snapshot-projection.ts`。

### runtime-host/application/workflows/cron/cron-job-mutation-workflow.ts

- **当前 owner：** Cron job 读模型缓存、mutation 与 delivery 修复策略。
- **当前事实：** 保存 jobs snapshot；仅 gateway ready 才 refresh；识别 isolated `agentTurn` 的无 channel announce delivery，提交 repair，并以 `mode:none` 修正读模型。
- **职责与关键 symbols：** `CronJobMutationWorkflow`、`refreshJobsSnapshot`、`executeDeliveryRepair`、CRUD/trigger、`buildUpdatePatch`、`needsDeliveryRepair`。
- **旧语义与策略：** create 固定 `wakeMode:next-heartbeat`、`sessionTarget:isolated`；update 规范化 schedule/message/agent/delivery 并用当前快照合并校验；每个 mutation 后刷新；启动连接错误返回旧 snapshot 而非抛出。
- **状态、存储与副作用：** 内存 job snapshot/error/timestamp；gateway cron RPC；提交异步 delivery repair；trigger 委托 scheduled-agent workflow。
- **并发与性能特征：** 无锁；refresh 全量 list、逐 job map/filter；repair 串行 update 所有不合法 job。
- **调用/依赖边界：** 上游 `CronOperationsWorkflow`、cron jobs service；下游 `GatewayCronPort`、cron model、`ScheduledAgentTriggerWorkflow`。
- **故障、恢复与安全：** 普通 list 失败记 error 后抛；启动阶段保持旧读模型；repair 失败传播；无 secret。
- **迁移分类：** Preserve：wire 格式、更新校验、mutation 后刷新、启动期旧快照降级。Intentional Improvement：将 delivery repair 变为带 receipt 的幂等 reconciliation；兼容影响是不得暴露无效 delivery，oracle 为 malformed cron fixture。Defect：无 channel 的 announce delivery 被代码明确当作待修复历史数据，不应复制为目标状态。待验证：repair 与用户 update 的竞争顺序。
- **未来 Rust owner：** Domain Module（Cron）；任务提交/重试归 Foundation Kernel；gateway projection 归 Runtime Integration。
- **Rust 重写与性能判断：** 旧成本为每 mutation 的全量 list 和 repair 的逐项 RPC；不变量为最终 gateway job 与 read model；指标为 refresh RPC/作业数、repair 完成时间、错误保留；oracle 为 list/update trace 和 fault injection。
- **验证 oracle：** cron route tests、delivery repair fixture、gateway startup connection error、update delivery merge。
- **证据：** 本文件；`application/cron/cron-model.ts`、`cron-jobs.ts`、`scheduled-agent-trigger-workflow.ts`。

### runtime-host/application/workflows/cron/cron-operations-workflow.ts

- **当前 owner：** Cron HTTP/application 命令校验、job submission 与 usage 查询门面。
- **当前事实：** list 在 gateway ready 时仅提交 refresh，立即返回缓存；create/update/delete/toggle/trigger 在通过输入校验后返回 accepted job；usage first-read 同步填缓存并请求后台刷新。
- **职责与关键 symbols：** `CronOperationsWorkflow`、`usageRecent`、`listJobs`、CRUD 操作与 `normalizeLimit`。
- **旧语义与策略：** create 要求合法 delivery；toggle/trigger 严格 id/boolean；query limit 优先 URL、接受数值或字符串、floor 且下限零；执行端委托 mutation workflow。
- **状态、存储与副作用：** 无自有状态；读 token-usage cache，提交 cron jobs，调用 mutation workflow。
- **并发与性能特征：** list 是 nonblocking submit；首次 usage query 可同步扫描；无请求合并。
- **调用/依赖边界：** 上游 cron routes；下游 `CronRuntimeJobPort`、usage repository、gateway readiness、`CronJobMutationWorkflow`。
- **故障、恢复与安全：** 解析错误转 `badRequest`；执行错误由 job/下游承担；只读 usage 不暴露配置 secret。
- **迁移分类：** Preserve：accepted 异步 mutation、snapshot 字段、limit 规范化。Intentional Improvement：可把 job receipt 定为 Platform Core execution grammar；兼容影响为保留 accepted contract，oracle 为 route response fixtures。Defect：无已证实项。待验证：usage refresh 是否可能与同步 refresh 重复扫描。
- **未来 Rust owner：** Domain Module（Cron）；Receipt/Correlation 分拆至 Matcha Platform Core。
- **Rust 重写与性能判断：** 旧成本为首次 usage scan，其他路径为常数调用；不变量为 query limit/accepted 时机；指标为 p95 usage 首读与 refresh 提交数；oracle 为 usage/cache 与 cron route tests。
- **验证 oracle：** invalid payload、gateway readiness、usage limit 0/negative/fraction、async job response。
- **证据：** 本文件；`cron-job-mutation-workflow.ts`、`application/usage/token-usage-history.ts`。

### runtime-host/application/workflows/diagnostics/diagnostics-collection-workflow.ts

- **当前 owner：** 诊断采集输入装配与 license-gated job 提交。
- **当前事实：** 优先 payload，其次 parent `host_diagnostics_snapshot`，最后本机环境构造 appInfo；缺 userDataDir/runtimeDataRootDir 返回 bad request；读取 host snapshot 失败静默退为空。
- **职责与关键 symbols：** `DiagnosticsCollectionWorkflow`、`execute`、`buildRuntimeHostAppInfo`、`readHostDiagnosticsSnapshot`。
- **旧语义与策略：** 采集本身异步 accepted；gateway status 可来自 host snapshot，runtime paths 只取 body；调用 license gate 并传其 data。
- **状态、存储与副作用：** 无自有状态；读取 environment/version、请求 parent shell、调用 license gate、提交 diagnostics job。
- **并发与性能特征：** 可并行化的读当前按顺序完成；无缓存。没有证据表明这是热点。
- **调用/依赖边界：** 上游 `RuntimeHostOperationsWorkflow`/routes；下游 diagnostics、license、parent shell、runtime environment。
- **故障、恢复与安全：** host snapshot 失败被有意降级；必要路径仍拒绝；诊断 payload 的 redaction 归 diagnostics service，未在此证明。
- **迁移分类：** Preserve：payload/snapshot/default 优先级及 host snapshot 的 best-effort。Intentional Improvement：诊断应经 Foundation Kernel redaction/secret policy 后再交付；兼容影响需保持字段可用，oracle 为含 secret fixture。Defect：无已证实项。待验证：`DiagnosticsService` 是否对 app/gateway payload 完整脱敏。
- **未来 Rust owner：** Delivery（桌面诊断装配）；secret/redaction 机制归 Foundation Kernel。
- **Rust 重写与性能判断：** 旧成本为一次 parent RPC、license gate 和 job 提交；不变量为 fallback 层级；指标为诊断提交延迟与脱敏漏检数；oracle 为 parent failure 模拟和 redaction fixture。
- **验证 oracle：** body complete/incomplete、parent success/failure、license gate failure、diagnostics job payload snapshot。
- **证据：** 本文件；`application/support/diagnostics.ts`、`application/license/service.ts`、`runtime-host-operations-workflow.ts`。

### runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow.ts

- **当前 owner：** Gateway connection/readiness 命令门面及 control-ui 配对批准筛选。
- **当前事实：** `status` 返回连接 state；`recover` 规范化 manual reason/正 timeout；`ready` 采用默认 methods 或正常化的 required methods；仅批准 clientId 为 `openclaw-control-ui` 的 pending pairing。
- **职责与关键 symbols：** `GatewayReadinessWorkflow`、`status`、`recover`、`ready`、`approvePendingControlUiPairingRequests`、`toGatewayControlReadinessOptions`。
- **旧语义与策略：** pairing list timeout 10s、每个 approve 15s 串行；没有 requestId 或 clientId 不匹配即跳过；readiness 原样保留 phase/retryable/missing/code/details。
- **状态、存储与副作用：** 无本地状态；gateway connection API 与 device pairing RPC。
- **并发与性能特征：** pairing approval O(pending) 串行 RPC；没有去重或幂等确认。
- **调用/依赖边界：** 上游 gateway routes/desktop readiness probe；下游 `GatewayConnectionPort`、`GatewayRpcPort`。
- **故障、恢复与安全：** 只批准硬编码 control-ui client，缩小配对权限；RPC 错误直接传播，不部分成功包装。
- **迁移分类：** Preserve：ready 的诊断字段和仅 control-ui pairing 过滤。Intentional Improvement：将 pairing authorization 放到 Runtime Integration 的明确 capability/policy；兼容影响是过滤集合不得扩大，oracle 为 mixed pending fixture。Defect：无已证实项。待验证：partial approval 后失败的重试幂等性。
- **未来 Rust owner：** Runtime Integration（OpenClaw readiness/pairing）；Delivery 调用其 endpoint。
- **Rust 重写与性能判断：** 旧成本为 pending 数量的串行 RPC；不变量为不批准非 control-ui；指标为批准延迟、错误后已批准数量；oracle 为 RPC trace/fault injection。无证据支持并行批准。
- **验证 oracle：** readiness default/custom methods、recover 参数、mixed client pairing、approve failure。
- **证据：** 本文件；`application/gateway/gateway-runtime-port.ts`、`gateway-readiness.ts`。

### runtime-host/application/workflows/platform-runtime/platform-native-tool-workflow.ts

- **当前 owner：** 平台原生 tool 安装、发现同步、审计编排。
- **当前事实：** install 后必须重新 list 并 `upsertNative`，然后 append install audit；reconcile 同样先 list/upsert 再 reconcile，并记录 discovered/missing/conflicts 计数。
- **职责与关键 symbols：** `PlatformNativeToolWorkflow`、`installNativeTool`、`reconcileNativeTools`。
- **旧语义与策略：** driver 成功但 registry/audit 失败会使方法失败；没有回滚已安装 tool；审计时间取 clock。
- **状态、存储与副作用：** 本身无状态；runtime install/list、tool registry 写、reconciler、append-only audit。
- **并发与性能特征：** 每次 install/reconcile 都全量 list；无 per-tool serialization。
- **调用/依赖边界：** 上游 platform tool state/runtime workflows；下游 `AgentRuntimeDriver`、`ToolRegistryPort`、`ReconcilerPort`、audit sink。
- **故障、恢复与安全：** 错误传播；audit 记录 source spec，是否含敏感信息未在本文件证明。
- **迁移分类：** Preserve：install→discover→registry→audit 顺序与 reconciliation report。Intentional Improvement：将 audit payload 做 secret-safe projection；兼容影响为 audit 中不再泄漏敏感 source，oracle 为 secret fixture。Defect：无已证实项。待验证：tool install 的外部幂等语义。
- **未来 Rust owner：** Matcha Platform Core（effective tool/receipt grammar）；Runtime Integration（driver）；Foundation Kernel（audit append）。
- **Rust 重写与性能判断：** 旧成本为每操作全量 installed list；不变量为 registry 反映 driver 观察值；指标为 list 次数、工具数下 reconciliation 时延、audit append 成功率；oracle 为 driver/registry differential trace。
- **验证 oracle：** install success、list failure、registry/audit failure、reconcile report fixture。
- **证据：** 本文件；`shared/platform-runtime-contracts.ts`、`platform-tool-state-workflow.ts`。

### runtime-host/application/workflows/platform-runtime/platform-run-session-workflow.ts

- **当前 owner：** 跨 runtime run 的 context assemble、execute、event/audit 发射编排。
- **当前事实：** `start` 顺序 assemble→driver.execute→publish `run.started`→append audit；`abort` driver.abort 后发布/审计 `run.aborted`。
- **职责与关键 symbols：** `PlatformRunSessionWorkflow`、`start`、`abort`。
- **旧语义与策略：** `eventTx` 透明传给 driver；runId 由 driver 分配；任何 event/audit 错误向上传播，不补偿已启动/中止的 runtime run。
- **状态、存储与副作用：** 无本地状态；context assembly、runtime side effect、event bus、audit sink。
- **并发与性能特征：** 单 run 内严格串行三次外部动作；无 durable outbox。
- **调用/依赖边界：** 上游 `RunSessionService`、platform facade；下游 context assembler、agent runtime driver、event bus、audit sink。
- **故障、恢复与安全：** 已执行 run 但 event/audit 失败的恢复语义未定义；无 secret 处理。
- **迁移分类：** Preserve：run identity 来自 driver、started/aborted event/audit 内容和顺序。Intentional Improvement：使用 Foundation Kernel append/outbox，使执行结果与事实记录可恢复；兼容影响是事件至少一次语义须明确，oracle 为 execute 后 append failure fault injection。Defect：无已证实项。待验证：目前 caller 对已执行但异常返回的处理。
- **未来 Rust owner：** Matcha Platform Core（run identity/receipt/correlation）；Foundation Kernel（事实追加）；Runtime Integration（driver）。
- **Rust 重写与性能判断：** 旧成本为三次串行 I/O，非 CPU 问题；不变量为 execute 成功前不可发 started；指标为 run start latency、event/audit 丢失与重复；oracle 为 ordered trace 和 crash/fault recovery test。
- **验证 oracle：** assembly/execute/publish/audit 各阶段失败、abort trace、event payload fixture。
- **证据：** 本文件；`application/platform-runtime/run-session-service.ts`、`shared/platform-runtime-contracts.ts`。

### runtime-host/application/workflows/platform-runtime/platform-runtime-operations-workflow.ts

- **当前 owner：** Platform runtime API 输入校验与 job/同步操作分派。
- **当前事实：** start run 直接执行；abort 要 runId；install/reconcile 返回 job receipt；list/query/upsert/set enabled 通过 facade；tools 只接受有 string id 的对象。
- **职责与关键 symbols：** `PlatformRuntimeOperationsWorkflow`、runtime health/run/tool methods、`readQueryPayload`。
- **旧语义与策略：** `includeDisabled` 仅等于字符串 `true`；缺 source/toolId 返回 bad request；install 为 accepted、set enabled 为 ok。
- **状态、存储与副作用：** 无状态；调用 platform facade、提交 platform jobs、执行 tool runtime workflow。
- **并发与性能特征：** 纯 facade/validation；真正队列与工具成本在下游。
- **调用/依赖边界：** 上游 platform routes；下游 platform facade/jobs/`PlatformToolRuntimeWorkflow`。
- **故障、恢复与安全：** 输入筛选避免无 id tool；下游异常传播；source 内容的安全策略不在此层。
- **迁移分类：** Preserve：同步与 accepted 命令的路由边界、input filter。Intentional Improvement：以 typed command/query schema 替代 `unknown as AssembleRequest`；兼容影响是无效 payload 更早拒绝，oracle 为现有 API fixtures。Defect：无已证实项。待验证：startRun 请求的完整 schema 校验需求。
- **未来 Rust owner：** Delivery（API command/query adapter）；Platform Core 提供 execution/tool contracts。
- **Rust 重写与性能判断：** 旧成本主要为下游 I/O；不变量为 response code/shape；指标为 validation rejection 与 job submit latency；oracle 为 route contract tests，不能从薄门面推断优化收益。
- **验证 oracle：** missing runId/source/toolId、includeDisabled query、install/reconcile receipt、tool list/query fixtures。
- **证据：** 本文件；`application/platform-runtime/platform-runtime-port.ts`、`platform-tool-runtime-workflow.ts`。

### runtime-host/application/workflows/platform-runtime/platform-tool-runtime-workflow.ts

- **当前 owner：** Platform tool/run facade 的极薄执行适配。
- **当前事实：** 将 facade 结果包为 `{runId}`、`{success:true}`、`{toolId}` 或 `{report}`，不做校验、缓存或错误转换。
- **职责与关键 symbols：** `PlatformToolRuntimeWorkflow` 的四个 `execute*` 方法。
- **旧语义与策略：** abort 成功后固定 success；所有错误透明传播。
- **状态、存储与副作用：** 无状态；全部副作用通过 `RuntimeHostPlatformFacade`。
- **并发与性能特征：** 常数层转发，无本地成本。
- **调用/依赖边界：** 上游 operations workflow/jobs；下游 platform facade，最终到 platform run/native tool workflows。
- **故障、恢复与安全：** 无吞错、无安全决策。
- **迁移分类：** Preserve：返回包裹形状。Intentional Improvement：可被 Delivery adapter 内联；兼容影响仅 API DTO，oracle 为 route fixtures。Defect：无已证实项。待验证：是否有外部直接依赖该 class。
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 旧成本为一次 facade 调用，无可证实的优化成本；不变量为传参/返回 DTO；指标为 route latency；oracle 为 facade mock contract。
- **验证 oracle：** start/abort/install/reconcile success/error passthrough。
- **证据：** 本文件；`platform-runtime-operations-workflow.ts`、`platform-runtime-port.ts`。

### runtime-host/application/workflows/platform-runtime/platform-tool-state-workflow.ts

- **当前 owner：** Tool registry、local/gateway ledger 之间的状态投影协调。
- **当前事实：** native install/reconcile 后刷新 gateway ledger；platform tools upsert 后把 platform registry snapshot 写入 local ledger；enable/disable 后全量 list、更新 gateway ledger/registry/audit。
- **职责与关键 symbols：** `PlatformToolStateWorkflow`、native methods、`upsertPlatformTools`、`setToolEnabled`。
- **旧语义与策略：** enable 分支调用 driver enable，else disable；state refresh 在 driver 操作成功后；audit 不记录 list 内容。
- **状态、存储与副作用：** 自身无字段；driver RPC、两类 in-memory ledger、registry、audit sink。
- **并发与性能特征：** set enabled 固定额外全量 list；ledger/registry 无协调锁。
- **调用/依赖边界：** 上游 platform facade；下游 native workflow、driver、ledgers、tool catalog service。
- **故障、恢复与安全：** driver 失败不改 ledger；driver 成功后后续同步失败可留陈旧 ledger；恢复机制未见。
- **迁移分类：** Preserve：driver 是 native truth、操作后刷新、审计字段。Intentional Improvement：将 observed ledger 更新设为 runtime observation receipt；兼容影响是最终一致窗口需可测，oracle 为 driver-success/ledger-failure trace。Defect：无已证实项。待验证：多调用者对同一 tool 的并发 enable/disable。
- **未来 Rust owner：** Matcha Platform Core（desired/applied/observed tool protocol）；Runtime Integration（driver observation）；Foundation Kernel（audit）。
- **Rust 重写与性能判断：** 旧成本为 enable/disable 后全量 list；不变量为 ledger 不早于 driver；指标为每次切换 list 次数、ledger stale window；oracle 为 mock call order/reconciliation test。
- **验证 oracle：** enable/disable、driver/list failure、ledger/registry/audit failure、platform snapshot fixture。
- **证据：** 本文件；`platform-native-tool-workflow.ts`、`application/platform-runtime/state/*.ts`。

### runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow.ts

- **当前 owner：** Managed plugin companion skill 的配置投影与文件安装。
- **当前事实：** autoEnable companion skills 写 `skills.entries[slug].enabled`；安装前创建 skills root，若目标已有 `SKILL.md` 即跳过；在 candidate roots 找 source `SKILL.md`，找不到抛错。
- **职责与关键 symbols：** `PluginCompanionSkillWorkflow`、`getSlugsForPlugin`、`applyConfigState`、`reconcileConfigStates`、`ensureInstalled`。
- **旧语义与策略：** 未定义 companion skill 是 no-op；保持原 entry 其他字段；所有 managed definition 都参与 startup config reconcile。
- **状态、存储与副作用：** config 由调用方持有并原地修改；文件系统创建目录/复制目录。
- **并发与性能特征：** 逐 skill 串行 exists/copy；重复安装依赖目标 manifest 检查，未加锁。
- **调用/依赖边界：** 上游 plugin companion service/lifecycle runner；下游 managed catalog、workspace roots、plugin filesystem。
- **故障、恢复与安全：** 仅以 SKILL.md 作为已安装判据；copy 中断的恢复语义未定义；source 路径由 catalog 定义。
- **迁移分类：** Preserve：autoEnable 投影、已有 manifest 不覆盖、source root 搜索顺序。Intentional Improvement：安装应采用 staging+atomic rename；兼容影响是半拷贝目录不再被误认，oracle 为 copy 中断 fault injection。Defect：无已证实项。待验证：目录复制是否保留/拒绝符号链接。
- **未来 Rust owner：** Native Runtime Edge（plugin/skill 文件布局）；Domain Module（Skill）拥有用户状态。
- **Rust 重写与性能判断：** 旧成本为每 skill filesystem traversal/copy；不变量为用户已存在的 skill 不覆盖；指标为复制 I/O、失败残留、重复安装次数；oracle 为 temp-dir fixtures。
- **验证 oracle：** no definitions、autoEnable projection、existing manifest、source missing、copy failure。
- **证据：** 本文件；`application/plugins/plugin-companion-skill-service.ts`、`managed-plugin-catalog.ts`。

### runtime-host/application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow.ts

- **当前 owner：** Managed runtime plugin catalog、enabled set、config transition 与 lifecycle side effects 协调。
- **当前事实：** 只安装 catalog 管理的 plugin；catalog discovery 并发查 registry 后按 id 排序；set enabled 正规化、过滤 channel-derived/未知项、先安装、在 `updateDirty` 中应用 config/transition，再运行 side effect。
- **职责与关键 symbols：** `RuntimePluginLifecycleWorkflow`、ensure/list/set/sync methods、`computeTransitionLifecycleState`、`listConfiguredManagedPluginIdsFromConfig`。
- **旧语义与策略：** 空 plugin id 返回当前 enabled；startup 与 transition 都先原地 replace config，再调用 side effects；configured plugins 从 allow 和 enabled entries 并集取值。
- **状态、存储与副作用：** workflow 无字段；读写 runtime config，安装插件，registry discovery，lifecycle config/side effects。
- **并发与性能特征：** catalog discovery uses `Promise.all`；安装 enabled plugins 串行；config 全对象 replace。
- **调用/依赖边界：** 上游 plugin runtime service、prelaunch；下游 config repository/projection、managed catalog/installer、lifecycle runner。
- **故障、恢复与安全：** 任何 install/config/side-effect 错误向上传播；config 已写而 side effect 失败时无补偿。
- **迁移分类：** Preserve：managed-only/filter 规则、transition set diff、config-before-side-effect。Intentional Improvement：用 desired/applied plugin state 及可重放 reconciliation 替代裸 side effect；兼容影响是需维持 enabled projection，oracle 为 transition failure trace。Defect：无已证实项。待验证：side effects 是否幂等以及 config mutex 覆盖范围。
- **未来 Rust owner：** Native Runtime Edge（OpenClaw plugin config/install）；Matcha Platform Core（desired/applied/observed protocol）。
- **Rust 重写与性能判断：** 旧成本为全 config replacement、串行安装、全 catalog registry probes；不变量为有效 plugin 集和 transition 顺序；指标为安装 I/O、transition 恢复时长、重复 side effect 数；oracle 为 config golden/side-effect fault tests。
- **验证 oracle：** unmanaged/channel-derived filtering、enable/disable diff、startup lifecycle、installer/config/side-effect failures。
- **证据：** 本文件；`application/plugins/runtime-plugin-service.ts`、`plugin-lifecycle-registry.ts`、composition plugin module。

### runtime-host/application/workflows/plugin-runtime/plugin-catalog-discovery-workflow.ts

- **当前 owner：** Runtime plugin 文件发现到 catalog DTO 的纯 I/O projection。
- **当前事实：** 构造 discovery 的四个 location roots；每 plugin 并发读取 manifest/package.json；description/version 有 manifest 优先 fallback；kind 由 policy 推断；最终按 platform、kind、id 排序。
- **职责与关键 symbols：** `PluginCatalogDiscoveryWorkflow`、`discover`、`pickCatalogVersion`、`pickCatalogDescription`、`compareCatalogPlugins`。
- **旧语义与策略：** bundled source 为 managed，其余 manual；companion skill slug 仅非空时输出；任一 discovery/read error 的整体行为取决于下游 Promise 拒绝，未局部吞错。
- **状态、存储与副作用：** 无状态；扫描多个目录和读取 JSON/text，无写入。
- **并发与性能特征：** discovered plugins 的 manifest/package read 以 Promise.all 并发；内存 materialize 全 catalog 后排序，O(n log n)。
- **调用/依赖边界：** 上游 plugin runtime service；下游 plugin-engine discovery/manifest loader、file system、kind policy、companion skill service。
- **故障、恢复与安全：** 路径由 environment location port 提供；manifest/package parse 故障是否中止全发现需要下游验证。
- **迁移分类：** Preserve：root precedence、metadata fallback、catalog sort/controlMode。Intentional Improvement：可流式/增量缓存 discovery，但须先证明 large catalog；兼容影响是排序和完整失败语义，oracle 为 catalog golden 与 malformed plugin fixture。Defect：无已证实项。待验证：discovery 对单个坏 package 的隔离约定。
- **未来 Rust owner：** Native Runtime Edge。
- **Rust 重写与性能判断：** 旧成本为 O(n) metadata I/O 与 O(n log n) sort；不变量为同输入的 ordered catalog；指标为 discovered count、scan time、read count；oracle 为 fixture directory differential benchmark。
- **验证 oracle：** bundled/manual plugin、manifest/package fallback、sort order、bad manifest/package behavior。
- **证据：** 本文件；`plugin-engine/plugin-discovery.ts`、`plugin-manifest-loader.ts`、`plugin-companion-skill-service.ts`。

### runtime-host/application/workflows/plugin-runtime/plugin-runtime-operations-workflow.ts

- **当前 owner：** Plugin runtime API snapshot/catalog and set-enabled job adapter.
- **当前事实：** runtime/catalog 都 enqueue refresh 后立即返回当前 snapshot/job；catalog 装饰 enabled、channel group 与 `channel-config` controlMode；setEnabled 只接受完全由 string 构成的 array。
- **职责与关键 symbols：** `PluginRuntimeOperationsWorkflow`、`runtime`、`catalog`、`setEnabled`、`decoratePluginCatalogEntry`。
- **旧语义与策略：** payload `enabled !== false` 默认 true；channel-derived 覆盖原 group/control mode；不等待 refresh。
- **状态、存储与副作用：** 无自有状态；enqueue refresh、读 runtime snapshot/catalog、提交 enable job。
- **并发与性能特征：** 每个 GET 可 enqueue refresh；catalog 建 Set 并线性 decorate，O(n)。
- **调用/依赖边界：** 上游 plugin routes；下游 `PluginRuntimePort`、plugin job port、catalog projection。
- **故障、恢复与安全：** 只能通过 input bad request 失败；refresh/job 生命周期由下游；无 secret。
- **迁移分类：** Preserve：stale snapshot + refresh job、channel derived catalog decoration、enabled default。Intentional Improvement：Foundation Kernel 可合并同一 refresh key 的任务；兼容影响为仍提供 refresh receipt，oracle 为 repeated GET trace。Defect：无已证实项。待验证：连续 GET 当前是否形成无界 refresh backlog。
- **未来 Rust owner：** Delivery；plugin truth/projection分别为 Native Runtime Edge/Runtime Integration。
- **Rust 重写与性能判断：** 旧成本为每 GET enqueue 与 O(n) decorate；不变量为读取不阻塞 refresh；指标为 queued refresh 数、catalog p95；oracle 为 job manager instrumentation 和 catalog fixture。
- **验证 oracle：** invalid pluginIds、enabled false、channel-derived decoration、rapid runtime/catalog calls。
- **证据：** 本文件；`application/plugins/plugin-runtime-service.ts`、`plugin-runtime-jobs.ts`。

### runtime-host/application/workflows/provider-account/provider-account-mutation-workflow.ts

- **当前 owner：** Provider account/API-key mutation 及模型、routing、runtime projection 的级联协调。
- **当前事实：** create/update 规范化 account，修改 account/apiKeys store，sync projection，再 sync models；delete API-key-only 删除 key/投影 secret，完全删除还移 models/routes/config（custom media 不移 provider config）。
- **职责与关键 symbols：** `ProviderAccountMutationWorkflow`、`executeCreate`、`executeUpdate`、`executeDelete`、`syncStoreToProjection`。
- **旧语义与策略：** update 不存在 account/invalid updates 直接抛；空 apiKey 删除；delete 先删除 dependent model/route，再清 provider config，最后写 store/project。
- **状态、存储与副作用：** 读写 provider JSON store（含 apiKeys）、runtime provider secret/config projection、models/routing stores。
- **并发与性能特征：** 多个依赖 I/O 串行；无事务，失败可留下部分投影状态。
- **调用/依赖边界：** 上游 provider account service/jobs；下游 provider store/projection、models service、capability routing service。
- **故障、恢复与安全：** API key 原文进入 store/projection port；本层不记录 key；多阶段失败无 compensation。
- **迁移分类：** Preserve：account normalization、apiKey-only 语义、删除时 dependent cleanup 和 custom-media 分支。Intentional Improvement：secret 转为 Foundation Kernel private projection，provider store 不应成为公开 runtime config；兼容影响是 projected credential lookup，oracle 为 key redaction/storage fixture。Defect：无已证实项。待验证：store/projection partial failure recovery。
- **未来 Rust owner：** Domain Module（Provider）；secret/redaction 为 Foundation Kernel；OpenClaw config/auth projection为 Runtime Integration。
- **Rust 重写与性能判断：** 旧成本为链式多 store/RPC；不变量为删除后 models/routes 不再引用 credential；指标为 mutation latency、partial projection repair、secret exposure count；oracle 为 crash-point fault injection和 provider fixtures。
- **验证 oracle：** create/update/delete/apiKeyOnly/custom-media、invalid account、sync failure/retry。
- **证据：** 本文件；`application/providers/account-runtime.ts`、`provider-models-service.ts`、`capability-routing-service.ts`。

### runtime-host/application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow.ts

- **当前 owner：** Capability routing JSON file persistence、normalization 与 stat cache。
- **当前事实：** cache key 是 size+mtime；命中返回深 clone；read/parse/stat 异常返回 schema v1 empty store；write ensure parent、pretty JSON，再清 cache。
- **职责与关键 symbols：** `ProviderCapabilityRoutingStorePersistenceWorkflow`、`read`、`write`、routing/ref clone/normalize helpers。
- **旧语义与策略：** 仅六种 route field；primary 缺失即丢 route，fallback 过滤无效 ref，timeout 必须正 finite floor；不保留未知字段。
- **状态、存储与副作用：** instance cache 与文件 read/stat/write。
- **并发与性能特征：** 每 read 至少 stat；cache miss JSON parse/deep clone；write 清缓存；无文件锁或 atomic rename。
- **调用/依赖边界：** 上游 capability routing service/workflow；下游 storage path/file system。
- **故障、恢复与安全：** 任何读故障 indistinguishably 视为空，可能掩盖损坏/权限问题；此为当前事实而非已证实缺陷。
- **迁移分类：** Preserve：schema v1 normalization、copy-on-read、missing/corrupt read empty fallback。Intentional Improvement：区分 not-found 与 corrupt/permission，并用 atomic write；兼容影响需定义首次启动 fallback，oracle 为 corrupt file fault test。Defect：无已证实项。待验证：调用者是否依赖读错误被吞掉。
- **未来 Rust owner：** Domain Module（Provider routing）；文件机制可由 Foundation Kernel 提供。
- **Rust 重写与性能判断：** 旧成本为 stat+可能 JSON parse/O(routes) clone；不变量为 caller 不可修改 cache、正常化输出；指标为 cache hit rate/read latency/损坏恢复；oracle 为 file mutation cache tests 和 corruption fixture。
- **验证 oracle：** missing/malformed file、cache hit invalidation、unknown/invalid routes、write failure。
- **证据：** 本文件；`provider-capability-routing-workflow.ts`、`application/providers/capability-routing-store.ts`。

### runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow.ts

- **当前 owner：** Provider capability route domain state、catalog pruning 与 OpenClaw routing projection 双向转换。
- **当前事实：** read 先按模型 catalog prune 并写回，再在有 routing 时只同步 stale projection；无 routing 时尝试从 runtime projection import。write 先投影、后写 store。
- **职责与关键 symbols：** `ProviderCapabilityRoutingWorkflow`、read/write/sync/remove/prune、decode/convert/prune helpers。
- **旧语义与策略：** 路由须 primary，fallback 过滤；仅固定六 capability；custom media 使用 special provider/model encoding；TTS projection 只写 providerKey，import 取第一个同 provider 的 TTS model。
- **状态、存储与副作用：** 无内存状态；读写 routing/models/provider credentials stores，读写 runtime projection。
- **并发与性能特征：** read 使用 JSON stringify 全对象比较；每 capability 重复构建 set、projection conversion 有重复调用；无 transaction/lock。
- **调用/依赖边界：** 上游 provider services/account/model workflows；下游 routing store、credentials/models stores、routing projection port。
- **故障、恢复与安全：** invalid payload bad request；credential normalization 可能写回；write projection 成功但 store 写失败可分叉。
- **迁移分类：** Preserve：六 capability grammar、primary/fallback pruning、custom-media and TTS encoding。Intentional Improvement：Platform Core 应拥有 capability/scope grammar，Domain Module 维护 provider routing truth；兼容影响是 TTS lossy projection 必须显式保留或替换，oracle 为 round-trip differential fixtures。Defect：TTS 的 modelId 不能从 runtime projection round-trip 是已证实的有损表示，不应静默当完整投影复制。待验证：现有 runtime 协议能否扩展 model-level TTS。
- **未来 Rust owner：** Matcha Platform Core（Capability grammar）；Domain Module（Provider state）；Runtime Integration（OpenClaw projection）。
- **Rust 重写与性能判断：** 旧成本为 stringify comparisons、重复 set/projection 构造和多 store I/O；不变量为有效 route/filter 顺序；指标为 read/write latency、projection drift、round-trip loss；oracle 为 property/differential route fixtures。
- **验证 oracle：** invalid payload、missing model pruning、credential deletion、custom media route、TTS import/export loss case。
- **证据：** 本文件；`application/providers/capability-routing-service.ts`、`provider-store-model.ts`、custom media projection helpers。

### runtime-host/application/workflows/provider-model/provider-models-operations-workflow.ts

- **当前 owner：** Provider models API decoding, label/selectable projection and mutation facade.
- **当前事实：** read operations hydrate catalog lazily and join normalized accounts; selectable output derives providerKey/runtime ref/label and locale-sorts; replace validates credential exists and returns bad request for decode/domain errors.
- **职责与关键 symbols：** `ProviderModelsOperationsWorkflow`、read/readAll/readSelectable/replace、`decodeModelList`。
- **旧语义与策略：** modelId/capabilities required；capability 只接受 catalog enum、去重但保序；同 credential duplicate modelId 整体拒绝；数值取正整数。
- **状态、存储与副作用：** 无自有状态；读 credentials，委托 projection workflow 读写/sync。
- **并发与性能特征：** accounts 和 hydrated models 并发读取；readSelectable O(n log n) 排序；credential normalization 可引起写回。
- **调用/依赖边界：** 上游 provider model routes/service；下游 models projection workflow、provider credentials store/key resolver。
- **故障、恢复与安全：** account/validation errors 转 `badRequest`；不回显 API key；projection errors 转字符串 bad request。
- **迁移分类：** Preserve：strict decode、duplicate rejection、custom-media ref、label/sort order。Intentional Improvement：typed request schema 代替 `unknown` decoder；兼容影响保持相同 invalid input rejection，oracle 为 API fixtures。Defect：无已证实项。待验证：sorting locale/browser contract。
- **未来 Rust owner：** Domain Module（Provider）；Delivery 负责 API decoding DTO。
- **Rust 重写与性能判断：** 旧成本为 O(n) join 与 O(n log n) sort；不变量为 selectable order/ref；指标为 catalog size 下 latency/allocations；oracle 为 model fixture benchmark and contract tests.
- **验证 oracle：** invalid credential/models/capability/duplicate、custom-media selectable、empty hydrate、sort fixture。
- **证据：** 本文件；`provider-models-projection-workflow.ts`、`provider-model-capabilities.ts`。

### runtime-host/application/workflows/provider-model/provider-models-projection-workflow.ts

- **当前 owner：** Provider model catalog persistence、runtime model/custom-media/agent projection、model-route pruning。
- **当前事实：** 空 catalog 时从 runtime projection import 并写 store；replace/remove 后同步 runtime models 且 prune routes；sync 执行 account normalization、构造 text/custom-media maps、replaceAll、再逐 provider upsert agent models。
- **职责与关键 symbols：** `ProviderModelsProjectionWorkflow`、hydrate/replace/remove/sync/import、validation and projection helpers。
- **旧语义与策略：** credential capability 不支持即抛；不具 baseUrl/api 的 text account 不投影；runtime model cost 固定全零；import 按 credential+model 去重并过滤不允许能力。
- **状态、存储与副作用：** 读写 models/credentials stores，写 runtime model/custom media projection、agent model projection、routing prune。
- **并发与性能特征：** sync 依次处理 accounts/models，反复以 spread 建模型数组，逐 provider agent upsert；全量 replace；无 transaction。
- **调用/依赖边界：** 上游 provider models operations/account mutation/gateway prelaunch；下游 stores、projection writers、routing service、agent identity/models.
- **故障、恢复与安全：** credentials normalization 可写回；任何中途投影失败可使多 projection 不一致；api key 不写入 model map。
- **迁移分类：** Preserve：capability filtering、custom-media split、valid refs、全零 cost compatibility。Intentional Improvement：将 provider private auth 与 public model projection 分离，并以 reconciliation repair multi-sink projection；兼容影响是 projections eventually converge，oracle 为 stage fault injection。Defect：无已证实项。待验证：全零 cost 是否被 UI/计费语义依赖。
- **未来 Rust owner：** Domain Module（Provider catalog）；Runtime Integration（OpenClaw/agent projections）；Foundation Kernel（private secret projection/reconciliation support）。
- **Rust 重写与性能判断：** 旧成本为全量 map rebuild、数组复制、逐 agent/provider writes；不变量为 normalized model set/valid refs；指标为 accounts×models projection latency、I/O writes、drift repair time；oracle 为 fixtures and multi-sink failure tests。
- **验证 oracle：** hydrate import、invalid capability、custom media, missing baseUrl/api、remove prunes routes、writer failure.
- **证据：** 本文件；`application/providers/provider-models-service.ts`、`custom-media-runtime-projection.ts`、`provider-capability-routing-workflow.ts`。

### runtime-host/application/workflows/provider-models-store/provider-models-store-persistence-workflow.ts

- **当前 owner：** Provider models JSON persistence and stat-keyed defensive cache.
- **当前事实：** cache uses size/mtime and clone-on-read; malformed/missing read yields `{schemaVersion:1,models:[]}`; write pretty JSON and clears cache.
- **职责与关键 symbols：** `ProviderModelsStorePersistenceWorkflow`、read/write、model/store normalization helpers。
- **旧语义与策略：** model requires trim credential/model and nonempty known capabilities; duplicate credential+model drops later record; positive numeric fields floor; unknown fields dropped.
- **状态、存储与副作用：** in-memory cache plus file stat/read/write.
- **并发与性能特征：** stat each read; cache miss JSON parse/deep clone O(models); no lock/atomic write.
- **调用/依赖边界：** upstream provider models projection/service; downstream models storage path/file system.
- **故障、恢复与安全：** read exceptions collapse to empty; no secret fields deliberately modeled.
- **迁移分类：** Preserve：schema, normalization, clone isolation and empty fallback。Intentional Improvement：atomic write and distinguish corrupt from absent; compatibility impact requires explicit startup policy, oracle is corrupt-file fixture。Defect：无已证实项。待验证：是否有 external process concurrently writing this file。
- **未来 Rust owner：** Domain Module（Provider）；Foundation Kernel可提供文件/atomic persistence primitive。
- **Rust 重写与性能判断：** 旧成本为 stat+parse+clone; 不变量 is canonical deduped catalog; 指标 cache hit/read latency/corruption recovery; oracle cache invalidation and golden JSON tests.
- **验证 oracle：** invalid models/capabilities/duplicates, cache hit/miss, malformed/missing/write failure.
- **证据：** 本文件；`application/providers/provider-models-store.ts`、`provider-models-projection-workflow.ts`。

### runtime-host/application/workflows/provider-oauth/provider-oauth-completion-workflow.ts

- **当前 owner：** OAuth completion 的 token private projection 与 provider account/projection 同步。
- **当前事实：** browser flow 先构造/写 account、再保存 token、再 sync projection；device flow 先保存 token、再构造 account/base URL、写 account 并 sync；projection normalization 修改 store 会再写。
- **职责与关键 symbols：** `ProviderOAuthCompletionWorkflow`、`completeBrowser`、`completeDevice`、input types、`asProviderCredential`。
- **旧语义与策略：** browser token email/project/account subject 选择有优先级；device base URL normalize 后若缺 scheme 添加 https；existing account 传 builder 保留其语义。
- **状态、存储与副作用：** 读写 provider store，写 OAuth token profile，写 provider runtime projection。
- **并发与性能特征：** 3+ 个串行持久化动作；无 OAuth transaction/idempotency key。
- **调用/依赖边界：** 上游 OpenClaw OAuth/application service；下游 provider account builder/store/projection policy/auth profiles。
- **故障、恢复与安全：** access/refresh token 只交 auth profile port，但 account 已写与 token 写失败、或 token 已写与 account 写失败会产生部分状态；恢复未定义。
- **迁移分类：** Preserve：provider-specific account builder、base URL normalization、token key selection。Intentional Improvement：将 token 作为 Foundation Kernel private secret transaction/reconciliation input；兼容影响是 account/token recovery receipt，oracle 为 each-stage failure injection。Defect：无已证实项。待验证：OAuth callback retry 与相同 accountId 的幂等性。
- **未来 Rust owner：** Domain Module（Provider identity/account）；Foundation Kernel（secret/token）；Runtime Integration（runtime-specific OAuth projection）。
- **Rust 重写与性能判断：** 旧成本为多 sink serial write；不变量 is token never enters public config and account matches key; 指标 completion latency/partial-state recovery; oracle redaction plus crash-point tests.
- **验证 oracle：** browser/device input, URL normalization, existing account, token/store/projection staged failures.
- **证据：** 本文件；`application/providers/provider-oauth-account-service.ts`、`provider-projection-sync-plan.ts`。

### runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow.ts

- **当前 owner：** Provider account store 到 runtime config/auth/agent-model projections 的同步编排。
- **当前事实：** normalizes store, derives plan, removes active providers not desired, discovers agent ids once, per account syncs config and saves/removes provider keys, optionally upserts agent provider entry; returns key count/storeModified.
- **职责与关键 symbols：** `ProviderProjectionSyncWorkflow`、`syncProviderStore`、projection port contracts。
- **旧语义与策略：** providerKey 与 accountId 不同则清理旧 account key；无 apiKey 时清理两个可能 key；only baseUrl+api enables agent model projection.
- **状态、存储与副作用：** no local state; config removal/sync, secret save/remove, agent ID discovery and model writes.
- **并发与性能特征：** active removal and account plans are sequential; agent IDs discovered once; no batching/transaction.
- **调用/依赖边界：** upstream provider store sync, gateway prelaunch, OAuth completion; downstream projection policy/key resolver and OpenClaw auth/config/agent-model ports.
- **故障、恢复与安全：** apiKey is delivered only to secret port; one failure stops later accounts, leaving partial desired projection; no compensation.
- **迁移分类：** Preserve：desired provider deletion, key rename cleanup, no-key cleanup, agent model eligibility。Intentional Improvement：reconciliation must record per-provider applied state and retry failed items; compatibility impact is eventual convergence only, oracle is partial-failure repair trace。Defect：无已证实项。待验证：active provider source completeness and secret port durability.
- **未来 Rust owner：** Domain Module（Provider desired state）；Runtime Integration（OpenClaw config/auth projection）；Foundation Kernel（secret/retry/reconciliation primitives）。
- **Rust 重写与性能判断：** 旧成本为 sequential remote/config writes O(providers); 不变量 is no undesired active provider/key remains; 指标 sync latency, failed-item retry, stale providers; oracle snapshot diff plus injected write failures.
- **验证 oracle：** add/remove/rename/no-key, multi-agent projection, partial failures and retry.
- **证据：** 本文件；`application/providers/store-sync.ts`、`provider-projection-sync-plan.ts`、gateway prelaunch workflow。

### runtime-host/application/workflows/provider-store/provider-store-persistence-workflow.ts

- **当前 owner：** Provider account/API-key JSON persistence and defensive cache.
- **当前事实：** read cache keyed size/mtime and returns clone; invalid/missing/parse error becomes schema v2 empty accounts/apiKeys; write serializes full store and clears cache.
- **职责与关键 symbols：** `ProviderStorePersistenceWorkflow`、read/write、normalization/clone helpers。
- **旧语义与策略：** accounts retain only record values; apiKeys retain only string values; unknown top-level fields dropped; no account semantic validation here.
- **状态、存储与副作用：** memory cache; provider-store file stat/read/write.
- **并发与性能特征：** O(accounts+keys) clone every result; stat every read; no locking/atomic rename.
- **调用/依赖边界：** upstream account/OAuth/model/routing workflows; downstream provider store storage and runtime file system.
- **故障、恢复与安全：** raw apiKeys are persisted in this file store; errors silently read as empty, and write is not atomic in this layer.
- **迁移分类：** Preserve：schema v2/filter/clone/read fallback。Intentional Improvement：move API keys to Foundation Kernel secret store and make public account store non-secret; compatibility impact requires migration/import and oracle verifies no key in public projection. Defect：plain `apiKeys` file persistence is a security design concern, but encryption/permissions are outside this file; therefore not proven as an isolated implementation defect. 待验证：at-rest protection provided by environment.
- **未来 Rust owner：** Domain Module（Provider account metadata）；Foundation Kernel（secret storage and redaction）。
- **Rust 重写与性能判断：** 旧成本为 stat+JSON clone and full-file rewrite; 不变量 is account/key mapping and absent/corrupt bootstrap behavior; 指标 read/write I/O, cache hit rate, secret exposure; oracle migration and file fault tests.
- **验证 oracle：** invalid top level/maps, cache invalidation, missing/malformed store, secret redaction/migration fixture.
- **证据：** 本文件；`application/providers/provider-store-repository.ts`、`provider-account-mutation-workflow.ts`。

### runtime-host/application/workflows/runtime-bootstrap/gateway-prelaunch-workflow.ts

- **当前 owner：** Gateway launch 前 settings/provider/plugin/workspace/security 全栈编排与 launch plan 构造。
- **当前事实：** 缺 gateway token 时生成 `matchaclaw-`+16 hex 并写 setting；prelaunch 可覆盖 token，依序 sync proxy/token、workspace identity、sanitize、browser mode/idle、plugin maintenance、provider stack、security policy；launch plan 包含 provider env 和 channel summary。
- **职责与关键 symbols：** `GatewayPrelaunchWorkflow`、settings/plan/prelaunch/template migration、`buildProviderEnvMap`、provider env and token helpers。
- **旧语义与策略：** browser relay 先确保 plugin；proxy disabled 时 launch sync 保留 existing；provider env 按 provider type 覆盖同 env var，loaded count 仍逐 key 计数；API key 放入返回 launch plan env。
- **状态、存储与副作用：** settings/provider store read/write，runtime config/plugin/workspace/security/provider/model/routing projections，多项 filesystem/network side effect。
- **并发与性能特征：** 长序列多 I/O；无 overall transaction；prelaunch maintenance has its own cache workflow.
- **调用/依赖边界：** upstream runtime bootstrap jobs/host operations/composition lifecycle; downstream most operational domains and runtime integration.
- **故障、恢复与安全：** failure stops later steps and may leave partial config; launch plan contains raw provider env secrets and must remain private to delivery/process boundary.
- **迁移分类：** Preserve：ordering, gateway token bootstrap, browser relay/plugin prerequisite, provider env mapping and channel skip decision。Intentional Improvement：launch plan must carry secret handles/private environment projection, not generally serializable raw keys; compatibility impact is process launch adapter, oracle is no-secret log/DTO fixture. Defect：returned `providerEnv` is secret-bearing by construction; its exposure outside trusted process boundary is a security risk, but actual exposure needs caller trace verification. 待验证：prelaunch idempotence and concurrent execution serialization.
- **未来 Rust owner：** Delivery（host/gateway launch orchestration）；Runtime Integration（OpenClaw config）；Foundation Kernel（secret/redaction, task supervision）；Domain Modules保留各自事实。
- **Rust 重写与性能判断：** 旧成本为 serial multi-domain I/O; 不变量 is prerequisite order and resulting launch config; 指标 cold-start duration, step failure recovery, secret leakage; oracle ordered trace, crash-point and redaction tests—no basis for “extreme” optimization.
- **验证 oracle：** first token bootstrap, incoming token/proxy, relay, no channels, provider key/env, each prelaunch stage failure.
- **证据：** 本文件；`application/runtime-host/bootstrap.ts`、prelaunch maintenance, provider/security/plugin workflows.

### runtime-host/application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow.ts

- **当前 owner：** Prelaunch maintenance file-cache policy and deterministic cache-key helpers.
- **当前事实：** missing cache reads as empty; unreadable cache/key makes task execute with cache-unavailable; matching key skips; task false prevents cache update; key is recomputed after task before write.
- **职责与关键 symbols：** `PrelaunchMaintenanceCacheWorkflow`、`runTask`、`stableJson`、`pathSignature`、`directoryChildrenSignature`、`buildPrelaunchMaintenanceCacheKey`。
- **旧语义与策略：** cache schema fixed 1; directory signature sorts then caps first 200 entries and stat-signs children; cache write failure is ignored by `runTask` because write result is not inspected.
- **状态、存储与副作用：** workflow itself stateless; reads/writes JSON cache; scans directory and stats paths.
- **并发与性能特征：** directory signature O(min(n,200)) stats in parallel; no cache file lock; stableJson recursively sorts object keys.
- **调用/依赖边界：** upstream `PrelaunchPluginMaintenanceService`; downstream runtime filesystem/clock and maintenance task closures.
- **故障、恢复与安全：** cache is optimization only—unavailable executes task; cache write failure degrades to repeat work; directory names/signatures may reveal no secret by design.
- **迁移分类：** Preserve：cache never suppresses task on unreadable/key failure; final key after work; deterministic JSON ordering. Intentional Improvement：use atomic locked cache write if concurrent prelaunch exists; compatibility impact only cache-hit rate, oracle task execution trace. Defect：`writeCache` boolean is discarded, so reported cache-miss does not prove cache persisted; this is an evidenced observability/accuracy defect, not a task correctness defect. 待验证：whether simultaneous host processes share cache path.
- **未来 Rust owner：** Foundation Kernel。
- **Rust 重写与性能判断：** 旧成本为 up to 200 stats plus JSON serialization; 不变量 is cache may only skip when key exact; 指标 cache hit rate, redundant task runs, scan time; oracle deterministic key and failed-write tests.
- **验证 oracle：** missing/corrupt cache, key failure, task false/throw, changed post-task key, write failure, 201+ directory entries.
- **证据：** 本文件；`application/runtime-host/prelaunch-maintenance-cache.ts`。

### runtime-host/application/workflows/runtime-host/runtime-host-operations-workflow.ts

- **当前 owner：** Runtime-host route-level application command/query facade.
- **当前事实：** launch preparation returns accepted prelaunch job; settings/plan/diagnostics are delegated; job list accepts optional type; job lookup requires trim jobId.
- **职责与关键 symbols：** `RuntimeHostOperationsWorkflow`、prepare/plan/settings/lifecycle/diagnostics/job methods。
- **旧语义与策略：** payload proxy/token fields only accepted at exact primitive types; lifecycle returns `ok` job from bootstrap; missing id `badRequest`.
- **状态、存储与副作用：** no state; delegates bootstrap, diagnostics and runtime jobs services.
- **并发与性能特征：** thin adapter; only downstream job query/submit cost.
- **调用/依赖边界：** upstream runtime-host routes; downstream bootstrap service, diagnostics workflow, runtime jobs service.
- **故障、恢复与安全：** no error remapping beyond bad request; launch secret restrictions depend on bootstrap/route boundary.
- **迁移分类：** Preserve：accepted/ok response forms and field filtering. Intentional Improvement：Delivery may use typed commands; compatibility impact preserve DTO/status, oracle route tests. Defect：无已证实项。待验证：job data redaction in `list/get`.
- **未来 Rust owner：** Delivery。
- **Rust 重写与性能判断：** 旧成本为 facade delegation; 不变量 response contract; 指标 route latency/job submit latency; oracle mock service route fixtures. No warranted algorithmic optimization.
- **验证 oracle：** missing jobId, payload filtering, prelaunch accepted receipt, job list/type/get contracts.
- **证据：** 本文件；`application/runtime-host/bootstrap.ts`、`runtime-jobs-service.ts`、diagnostics workflow。

### runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow.ts

- **当前 owner：** Manual Cron agent trigger compatibility flow with temporary profile switch and restoration.
- **当前事实：** isolated agentTurn jobs are temporarily switched to main/now/systemEvent, force-run, polled each second up to 15 minutes, and restored in finally; switch failure falls back to native force-run.
- **职责与关键 symbols：** `ScheduledAgentTriggerWorkflow`、`shouldUseManualRunProfileSwitch`、`buildManualRunPatches`、`waitForRunCompletion`、`restoreCronJobConfig`。
- **旧语义与策略：** job not found throws; skipped already-running/not-due restores immediately; run failure restores then rethrows; wait errors warn but restore; restore errors only warn; original delivery restored only for isolated target.
- **状态、存储与副作用：** no durable local state; multiple gateway list/update/run RPCs and logs.
- **并发与性能特征：** polling O(900) max list calls per run (1s ×15m); concurrent manual triggers can overwrite each other’s temporary patch; no lock.
- **调用/依赖边界：** upstream CronJobMutationWorkflow; downstream GatewayCronPort, clock/timer/logger.
- **故障、恢复与安全：** robust finally restoration attempt; but crash/process kill between temporary patch and restore has no durable recovery record.
- **迁移分类：** Preserve：eligible-job predicate, fallback native run, restoration patch and timeout. Intentional Improvement：replace config mutation/polling with runtime-native manual execution command/receipt; compatibility impact must retain prompt/session behavior, oracle gateway trace. Defect：temporary gateway config mutation is an accidental compatibility workaround and should not become target state machine. 待验证：gateway guarantees surrounding `runCronJob` and concurrent manual trigger behavior.
- **未来 Rust owner：** Domain Module（Cron） owns requested execution; Matcha Platform Core owns execution receipt; Runtime Integration implements OpenClaw manual run.
- **Rust 重写与性能判断：** 旧成本为 update+force-run+up to 900 list polls; 不变量 is original config restoration and fallback behavior; 指标 polls/run, restoration latency, abandoned temporary patches; oracle crash/concurrency fault tests.
- **验证 oracle：** normal/manual-ineligible, update failure fallback, run failure, skipped run, timeout/wait error, restore error.
- **证据：** 本文件；`cron-job-mutation-workflow.ts`、`application/gateway/gateway-runtime-port.ts`。

### runtime-host/application/workflows/security-emergency/security-emergency-response-workflow.ts

- **当前 owner：** Security emergency lockdown policy persistence and best-effort live gateway action.
- **当前事实：** always derives/writes lockdown policy; if gateway running then independently attempts policy sync and emergency run; returns success/lockdownApplied even when either live operation fails, exposing errors in fields.
- **职责与关键 symbols：** `SecurityEmergencyResponseWorkflow`、`execute`、`syncPolicy`、`runEmergency`。
- **旧语义与策略：** gateway not running skips live effects; sync error does not prevent emergency action; neither error rolls back persisted lockdown.
- **状态、存储与副作用：** reads/writes security policy file/repository; calls gateway running/sync/emergency.
- **并发与性能特征：** serial policy write then up to two serial gateway RPCs; no lock/version guard.
- **调用/依赖边界：** upstream security operations/jobs; downstream policy repository, emergency policy builder, GatewaySecurityPort.
- **故障、恢复与安全：** fail-closed local policy persistence is prerequisite; gateway errors are captured rather than hidden; retry/reconciliation occurs elsewhere only if invoked.
- **迁移分类：** Preserve：persist lockdown before live calls and error-reporting result. Intentional Improvement：Foundation Kernel should durably record emergency command/outcomes for retry; compatibility impact is same result fields plus receipt, oracle gateway failure fixture. Defect：无已证实项。待验证：concurrent policy writes during emergency.
- **未来 Rust owner：** Domain Module（Security）；Foundation Kernel（durable command/audit/retry）；Runtime Integration（gateway effects）。
- **Rust 重写与性能判断：** 旧成本为 one file write and up to two RPCs; 不变量 is persisted lockdown survives gateway outage; 指标 lockdown commit time/live action success/retry; oracle ordered trace and gateway fault injection.
- **验证 oracle：** gateway stopped, sync failure, emergency failure, both failure, policy write failure.
- **证据：** 本文件；`application/security/security-emergency-policy.ts`、`security-operations-workflow.ts`。

### runtime-host/application/workflows/security-operations/security-gateway-operations-workflow.ts

- **当前 owner：** Security gateway operation pass-through adapter.
- **当前事实：** nine methods map one-to-one to `GatewaySecurityPort`, passing URL/optional scan/feed/actions/snapshot parameters unchanged.
- **职责与关键 symbols：** `SecurityGatewayOperationsWorkflow` and query/audit/integrity/scan/advisory/remediation methods.
- **旧语义与策略：** no validation, transformation, retry, cache, or error map; gateway result/error is authoritative.
- **状态、存储与副作用：** no local state; gateway RPC side effects/query.
- **并发与性能特征：** constant wrapper overhead; downstream controls performance.
- **调用/依赖边界：** upstream `SecurityOperationsWorkflow`; downstream `GatewaySecurityPort`.
- **故障、恢复与安全：** no swallowing; authorization/input policy must be route/gateway-owned.
- **迁移分类：** Preserve：method-to-port mapping. Intentional Improvement：inline into Runtime Integration capability adapter if no independent caller; compatibility impact method DTOs, oracle security route mocks. Defect：无已证实项。待验证：authorization owner for arbitrary feedUrl/scanPath.
- **未来 Rust owner：** Runtime Integration。
- **Rust 重写与性能判断：** 旧成本为一次 port call; 不变量 arguments/result/errors; 指标 gateway operation latency; oracle mock contract. No optimization claim.
- **验证 oracle：** all method argument forwarding and error propagation.
- **证据：** 本文件；`security-operations-workflow.ts`、`application/gateway/gateway-runtime-port.ts`。

### runtime-host/application/workflows/security-operations/security-operations-workflow.ts

- **当前 owner：** Security application API orchestration, validation and async job submission.
- **当前事实：** policy write persists then returns accepted policy-sync job; read/sync delegates; audits/remediation either submit job or execute gateway workflow; actions filter strings and payload fields default safely.
- **职责与关键 symbols：** `SecurityOperationsWorkflow`, policy/audit/emergency/integrity/scan/advisory/remediation methods.
- **旧语义与策略：** `scanPath`, feed URL, snapshotId optional; invalid remediation action payload becomes empty action list rather than bad request; async operation calls jobs, execute variants call workflow.
- **状态、存储与副作用：** no local state; policy repository writes/reads and job submission/gateway delegation.
- **并发与性能特征：** thin dispatch; queue/retry behavior belongs to `SecurityJobPort`.
- **调用/依赖边界：** upstream security routes/service; downstream policy repository/jobs/sync/emergency/gateway operation workflows.
- **故障、恢复与安全：** writePolicy does not await sync; direct execution errors propagate; input filtering prevents nonstring actions.
- **迁移分类：** Preserve：write then accepted sync, async/direct operation split, payload defaults. Intentional Improvement：typed security commands with receipts/correlation; compatibility impact route DTOs, oracle API tests. Defect：empty/invalid actions are accepted as empty remediation request; intent is unclear, so 待验证 rather than defect. 待验证：job dedupe and authorization of feed URL/actions.
- **未来 Rust owner：** Domain Module（Security）；Foundation Kernel（jobs/retries）；Delivery（API adapter）。
- **Rust 重写与性能判断：** 旧成本为 service delegation; 不变量 accepted timing and action filter; 指标 job queue/load and direct execution latency; oracle route fixture/mocked job tests.
- **验证 oracle：** policy write/sync, malformed scan/remediation payload, each direct operation mapping.
- **证据：** 本文件；`application/security/security-jobs.ts`、security policy/emergency/gateway workflows。

### runtime-host/application/workflows/security-policy/security-policy-store-workflow.ts

- **当前 owner：** Security policy JSON file location, normalization and persistence.
- **当前事实：** policy is `<runtimeDataRoot>/policies/security.policy.json`; read normalizes valid parsed file or normalized empty object; write normalizes then ensures directory and pretty-writes.
- **职责与关键 symbols：** `SecurityPolicyStoreWorkflow`, `getFilePath`, `read`, `write`, `readPolicyFile`.
- **旧语义与策略：** unknown/invalid file content becomes normalizer output; read errors are silently defaulted; no schema version field in this workflow.
- **状态、存储与副作用：** no memory state; filesystem read/write/ensure directory.
- **并发与性能特征：** one full JSON read/write, no cache/lock/atomic rename.
- **调用/依赖边界：** upstream security service/operations/emergency/sync; downstream policy normalizer/filesystem/runtime root port.
- **故障、恢复与安全：** unreadable/corrupt policy becomes default policy, potentially concealing operator state; write errors propagate.
- **迁移分类：** Preserve：path and normalization/default semantics until an approved migration. Intentional Improvement：atomic write plus distinguish absent from corrupt/read-denied, with explicit fail-closed policy decision; compatibility impact must be validated, oracle corrupt/read-error fixture. Defect：no proof that default-on-read-error violates current contract. 待验证：desired fail-open/fail-closed behavior on corrupt security policy.
- **未来 Rust owner：** Domain Module（Security）；Foundation Kernel may supply durable storage primitives.
- **Rust 重写与性能判断：** 旧成本为完整 file JSON I/O; 不变量 normalizer output and path; 指标 read/write latency, corruption detection, policy recovery; oracle golden policy and fault tests.
- **验证 oracle：** missing/malformed policy, normalization, directory/write failure, path layout.
- **证据：** 本文件；`application/security/security-policy-normalizer.ts`、`security-emergency-response-workflow.ts`。

### runtime-host/application/workflows/security-policy/security-policy-sync-workflow.ts

- **当前 owner：** Security policy to gateway retry policy.
- **当前事实：** reads policy once; attempts gateway sync at most five times, sleeping exactly 1000 ms between first four failures; returns attempt count or throws final message including reason.
- **职责与关键 symbols：** `SecurityPolicySyncWorkflow`, constants `POLICY_SYNC_MAX_ATTEMPTS`/`POLICY_SYNC_RETRY_DELAY_MS`, `execute`.
- **旧语义与策略：** fixed delay (not exponential), no retry classification/cancel/deadline; final unknown error is stringified.
- **状态、存储与副作用：** no state; reads policy, gateway RPC, timer sleep.
- **并发与性能特征：** serial max five attempts and four seconds of planned wait; concurrent callers duplicate retries.
- **调用/依赖边界：** upstream security operations/jobs/composition; downstream policy repository, GatewaySecurityPort, timer.
- **故障、恢复与安全：** all retries exhausted surface error; no secret in message except what gateway error contains.
- **迁移分类：** Preserve：one policy read, max count/delay, final failure behavior. Intentional Improvement：Foundation Kernel retry primitive may add cancellation/deadline/jitter only with compatibility decision; oracle must preserve five-attempt trace where no policy changes. Defect：no retryability classification is a limitation, not proven defect. 待验证：gateway idempotency and caller cancellation requirements.
- **未来 Rust owner：** Domain Module（Security） selects policy sync; Foundation Kernel owns retry/deadline primitive; Runtime Integration owns gateway call.
- **Rust 重写与性能判断：** 旧成本 up to five RPC plus 4s fixed sleeps; 不变量 attempts/order and final error; 指标 success attempt distribution, retry latency, duplicated retries; oracle fake timer/gateway trace.
- **验证 oracle：** immediate success, each failure count, final error formatting, timer calls.
- **证据：** 本文件；`security-operations-workflow.ts`、`application/security/security-jobs.ts`。

### runtime-host/application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow.ts

- **当前 owner：** Settings persistence-to-runtime config/plugin/gateway restart synchronization.
- **当前事实：** patch/set always persist first; only explicit proxy/browserMode fields submit sync job; reset/execution sync proxy with `preserveExistingWhenDisabled:false`; relay browser mode ensures plugin then syncs and restarts gateway.
- **职责与关键 symbols：** `SettingsRuntimeConfigSyncWorkflow`, reset/patch/setValue/execute, sync submission and browser restart helpers.
- **旧语义与策略：** no runtime config port means reset/browser sync no-op; explicit browser mode with missing gateway control skips restart; restart error propagates after config sync.
- **状态、存储与副作用：** no local state; settings file writes, async job submission, runtime config/plugin mutation, gateway restart.
- **并发与性能特征：** patch requires getAll after write only if sync needed; browser mode serial plugin/config/restart; no debounce for many settings patches.
- **调用/依赖边界：** upstream settings service/routes/jobs; downstream settings repository/jobs, runtime config/plugin repository, gateway control.
- **故障、恢复与安全：** persisted setting may diverge if later sync/restart fails; proxy values may be sensitive operational config but no secret handling is shown.
- **迁移分类：** Preserve：explicit-field trigger, persist-before-submit, relay prerequisite/restart, reset preservation flag. Intentional Improvement：desired/applied/observed settings state with reconciliation; compatibility impact requires preserving immediate persisted read and accepted job, oracle staged failure trace. Defect：无已证实项。待验证：concurrent patches/restart coalescing.
- **未来 Rust owner：** Domain Module（Settings）；Runtime Integration（OpenClaw config）；Delivery（gateway restart）；Foundation Kernel（job/reconciliation）。
- **Rust 重写与性能判断：** 旧成本为串行 write/job and possibly plugin/config/restart; 不变量 trigger set/order; 指标 restart count, setting-to-applied time, divergence repair; oracle settings/gateway mock traces.
- **验证 oracle：** unrelated patch no job, proxy/browser patch, relay plugin, restart failure, reset and absent ports.
- **证据：** 本文件；`application/settings/settings-jobs.ts`、`settings-store-workflow.ts`、gateway prelaunch workflow。

### runtime-host/application/workflows/settings-store/settings-store-workflow.ts

- **当前 owner：** Runtime-host settings JSON persistence, defaults and per-key normalization.
- **当前事实：** getAll overlays normalized raw settings on defaults, resolves language from stored/default locale; patch reads full settings then normalizes/writes all; reset writes defaults with detected locale.
- **职责与关键 symbols：** `SettingsStoreWorkflow`, getAll/patch/setValue/reset, normalization/language helpers.
- **旧语义与策略：** unknown keys are retained; known bool is true-only, number finite or default, strings typed/default, browserMode normalizes; locale supports only en/zh/ja and chooses first candidate.
- **状态、存储与副作用：** no memory cache; full JSON file read/write, environment locale/path operations.
- **并发与性能特征：** each patch whole-file read/merge/write O(settings size); no locking or compare-and-swap, so concurrent patches can lose updates.
- **调用/依赖边界：** upstream settings service/runtime-config sync/prelaunch; downstream settings defaults, filesystem/environment.
- **故障、恢复与安全：** read errors default silently; write errors propagate; unknown keys may persist untyped data.
- **迁移分类：** Preserve：default overlay, known-key normalization, language fallback, unknown-key retention. Intentional Improvement：use versioned/atomic settings storage with typed schema while retaining unknown-key compatibility only if required; oracle concurrent patch and settings golden tests. Defect：read-modify-write without visible lock can lose concurrent updates, but concurrent caller evidence is absent—待验证, not proven defect. 待验证：whether unknown settings are intentional extension points.
- **未来 Rust owner：** Domain Module（Settings）；Foundation Kernel（storage primitive）。
- **Rust 重写与性能判断：** 旧成本 full-file O(n) read/write; 不变量 normalization/default values; 指标 patch latency, lost-update rate, write bytes; oracle concurrency and malformed-file fixtures.
- **验证 oracle：** missing/malformed, all key-type normalization, browser mode, locale candidates, reset, concurrent patch trace.
- **证据：** 本文件；`application/settings/defaults.ts`、`settings-runtime-config-sync-workflow.ts`。

### runtime-host/application/workflows/skill-install/clawhub-skill-install-workflow.ts

- **当前 owner：** ClawHub install/uninstall command and local lock-file cleanup.
- **当前事实：** install requires trim slug, adds optional version/force, runs configured registry fallback and throws non-ok; uninstall recursively removes skill dir then best-effort removes its lock entry.
- **职责与关键 symbols：** `ClawHubSkillInstallWorkflow`, `executeInstall`, `executeUninstall`, `removeLockEntry`.
- **旧语义与策略：** lock absent/no slug/malformed JSON is no-op; lock rewrite only when `skills[slug]` exists; uninstall success is returned after directory removal even if lock cleanup parsing fails.
- **状态、存储与副作用：** no memory state; CLI process, skill directory deletion, lock JSON read/write.
- **并发与性能特征：** one CLI or directory deletion; no lock around lock-file read/modify/write.
- **调用/依赖边界：** upstream skills jobs/service; downstream ClawHub CLI runner, filesystem, skills root/lock path.
- **故障、恢复与安全：** slug required but path safety relies on caller/CLI/filesystem; lock cleanup suppresses errors deliberately.
- **迁移分类：** Preserve：registry fallback command args and uninstall lock cleanup best-effort. Intentional Improvement：use structured package registry/install receipt; compatibility impact preserve command failure text and lock state, oracle CLI/filesystem fixtures. Defect：无已证实项。待验证：path traversal protection for slug and CLI runner escaping.
- **未来 Rust owner：** Domain Module（Skill catalog intent）；Native Runtime Edge（ClawHub CLI/package layout）。
- **Rust 重写与性能判断：** 旧成本为外部 CLI/full directory delete and lock JSON rewrite; 不变量 installed/uninstalled observable state; 指标 install duration, orphan lock entries, failed cleanup; oracle temp-dir plus mocked CLI tests.
- **验证 oracle：** required slug/version/force, CLI failure, lock missing/malformed/entry, deletion failure.
- **证据：** 本文件；`application/skills/clawhub-cli.ts`、`application/skills/clawhub.ts`。

### runtime-host/application/workflows/skill-install/local-skill-import-workflow.ts

- **当前 owner：** Local directory/zip/markdown skill import, manifest validation and staging cleanup.
- **当前事实：** source must exist; creates time/random staging dir; directory finds exactly one SKILL.md, zip extracts to staging, markdown becomes staging skill; validates name/description frontmatter; refuses existing destination; finally removes staging.
- **职责与关键 symbols：** `LocalSkillImportWorkflow`, execute/import preparation, zip extraction, manifest/dir functions; exported `normalizeSkillKey`, `normalizeBundleFilePath`, `collectTextFiles`, `validateSkillManifest`.
- **旧语义与策略：** zip uses platform PowerShell/ditto/unzip then Python fallback; skill key normalizes whitespace/invalid chars and timestamp fallback; recursive directory copy reads all entries; directory with zero/multiple manifests rejects.
- **状态、存储与副作用：** temp/staging and target filesystem writes, external archive commands, logger.
- **并发与性能特征：** recursive scans/copies are serial DFS; ZIP expansion can be large; timestamp+random prevents staging collision, but target existence is check-then-copy without lock.
- **调用/依赖边界：** upstream skills operations; downstream runtime filesystem/command/environment/clock/logger.
- **故障、恢复与安全：** finally removes staging; target may be partially copied if copy fails; path helpers reject absolute/traversal bundle paths, but extracted ZIP entry handling depends on extractor.
- **迁移分类：** Preserve：accepted source forms, one-manifest rule, frontmatter requirement, destination no-overwrite, cleanup. Intentional Improvement：extract/copy into validated staging and atomic rename with archive entry policy; compatibility impact only partial-install handling, oracle malicious archive/interrupted-copy fixture. Defect：no confirmed zip-slip exploit in the selected command implementations; treat archive containment as 待验证.
- **未来 Rust owner：** Domain Module（Skill）；Foundation Kernel（safe filesystem/temp primitive）；Native Runtime Edge（OS command integration if retained）。
- **Rust 重写与性能判断：** 旧成本为递归 scan/copy and external extraction; 不变量 no destination overwrite and valid manifest; 指标 bytes/files, import latency, cleanup residuals, rejected unsafe paths; oracle temp filesystem and archive security fixtures.
- **验证 oracle：** missing/unsupported source, dir zero/multiple manifest, invalid frontmatter, zip fallback, existing target, copy/extract failure and cleanup.
- **证据：** 本文件；`skills-operations-workflow.ts`、`skill-bundle-transfer-workflow.ts`。

### runtime-host/application/workflows/skill-install/preinstalled-skills-workflow.ts

- **当前 owner：** Preinstalled skill manifest installation, marker ownership and enabled-state synchronization.
- **当前事实：** absent manifest/source returns success empty (logs source absence); only source dirs with SKILL.md install; target with no marker is user-managed and untouched; marker version mismatch logs but deliberately does not overwrite/update.
- **职责与关键 symbols：** `PreinstalledSkillsWorkflow`, execute, ensure skill/state, manifest/lock/marker readers, copy.
- **旧语义与策略：** lock version overrides manifest version then unknown; new install writes marker with time, persists enabled state if possible, submits gateway update; state persist failure does not fail installation.
- **状态、存储与副作用：** filesystem copy/marker JSON; skill config write; gateway update job; logs.
- **并发与性能特征：** each spec serial and recursive copy; no lock; copies only missing target, no automatic upgrade.
- **调用/依赖边界：** upstream skills jobs/service/prelaunch; downstream workspace candidates, filesystem, config repository/job port.
- **故障、恢复与安全：** bad manifests/markers become empty/null and skip or treat user-managed; copy failure propagates; no secret processing.
- **迁移分类：** Preserve：ownership marker protects user skill, autoEnable sync, no automatic marker-version overwrite. Intentional Improvement：record installation outcome/retry for partial copy-state-job sequence; compatibility impact is no overwrite policy stays, oracle marker fixture. Defect：version mismatch is intentionally logged/skipped, not an upgrade defect. 待验证：desired behavior for corrupted marker with Matcha-owned target.
- **未来 Rust owner：** Domain Module（Skill）；Native Runtime Edge（bundled skill distribution）。
- **Rust 重写与性能判断：** 旧成本为串行 directory copies; 不变量 user-managed targets unchanged; 指标 preinstall duration, skipped/installed count, residual partial dirs; oracle temp-dir marker tests.
- **验证 oracle：** absent manifest/source, missing source skill, fresh install, user target, marker state/default, version mismatch, state write failure.
- **证据：** 本文件；`application/skills/skills-jobs.ts`、`skill-runtime-workflow.ts`。

### runtime-host/application/workflows/skill-install/skill-bundle-transfer-workflow.ts

- **当前 owner：** Skill bundle export/import with bundle path validation and enable/update effects.
- **当前事实：** export de-dupes requested keys, skips noninstalled manifests, recursively includes sorted text files; import normalizes valid bundles, requires SKILL.md, skips existing valid skill after enabling it, otherwise writes all files then validates and enables.
- **职责与关键 symbols：** `SkillBundleTransferWorkflow`, export/import, normalize/import bundle, `enableImportedSkill`.
- **旧语义与策略：** empty/invalid bundle input returns success empty; existing dir without SKILL.md throws; import does not clean partially written bundle if later write/validation fails; every import submits refresh status after loop.
- **状态、存储与副作用：** reads/writes skills filesystem, updates local config, submits gateway update/refresh jobs.
- **并发与性能特征：** files/bundles serial writes; export holds all contents in memory; no total file/byte limit in this workflow.
- **调用/依赖边界：** upstream skills operations; downstream skills repository/jobs/filesystem and local-import exported validators.
- **故障、恢复与安全：** `normalizeBundleFilePath` rejects absolute/traversal paths; manifest validation occurs after writes; config failure makes import error after files remain.
- **迁移分类：** Preserve：bundle validation, SKILL.md requirement, existing-user skip/enable, sorted export. Intentional Improvement：prevalidate all files and stage+atomic publish with byte/file quotas; compatibility impact error timing/partial directories, oracle malicious/partial bundle fixture. Defect：partial import residue is current observable risk but no test/caller contract establishes it as intended; classify as Intentional Improvement target. 待验证：maximum acceptable bundle size.
- **未来 Rust owner：** Domain Module（Skill）；Foundation Kernel（safe transfer/filesystem limits）。
- **Rust 重写与性能判断：** 旧成本为全部文件内存导出及 memory export and serial write import; 不变量 validated paths and no existing valid skill overwrite; 指标 bundle bytes/files, peak memory, partial residue; oracle round-trip and path traversal tests.
- **验证 oracle：** empty/invalid/missing manifest, traversal paths, existing good/bad target, config/job failure, export order.
- **证据：** 本文件；`local-skill-import-workflow.ts`、`skills-operations-workflow.ts`。

### runtime-host/application/workflows/skill-runtime/skill-runtime-workflow.ts

- **当前 owner：** Skill runtime status cache, canonical identity resolution, installed/bundled filesystem inventory and gateway update coordination.
- **当前事实：** `status` submits async refresh only if ready; refresh gateway `skills.status`, merges installed inventory/config/gateway data, saves cache; startup connection failure returns old payload; canonical keys resolve config, file inventory and status identities case-insensitively.
- **职责与关键 symbols：** `SkillRuntimeWorkflow`, status/refresh/key methods/update, inventory/status merge/parsing helpers.
- **旧语义与策略：** local config enabled wins over gateway disabled; only installed and not allowlist-blocked skills display; managed inventory overlays bundled by key; manifest read failure warns and retains fallback metadata; gateway update returns string error rather than throws.
- **状态、存储与副作用：** cached snapshot/ready/error/time; gateway RPC, file scans/reads, config read, refresh job submit, logs.
- **并发与性能特征：** no single-flight refresh; inventory scans directories and manifest files serially; status merge materializes maps/sorts O(n log n).
- **调用/依赖边界：** upstream skills operations/routes/jobs; downstream gateway readiness/RPC, skills config, workspace/filesystem, jobs.
- **故障、恢复与安全：** startup errors preserve cache; other refresh errors record+throw; manifest errors per file are isolated; skill config apiKey is included in status config—its exposure depends on API caller and must be verified.
- **迁移分类：** Preserve：snapshot metadata, config precedence, canonical identity rules, display filters, gateway update best-effort return. Intentional Improvement：skill status must project secret config as redacted/private data; compatibility impact API may no longer carry raw apiKey, oracle redaction fixture. Defect：including `apiKey` in returned `config` is an evidenced secret-bearing projection; whether it reaches untrusted delivery remains 待验证. 待验证：concurrent refresh deduplication.
- **未来 Rust owner：** Domain Module（Skill）；Runtime Integration（gateway status）；Foundation Kernel（secret/redaction）；Delivery consumes safe view.
- **Rust 重写与性能判断：** 旧成本为重复 filesystem inventory and O(n log n) merge/sort; 不变量 ordered visible status and key resolution; 指标 refresh RPC/scans, p95 status, secret leaks; oracle status golden, cache/failure and redaction tests.
- **验证 oracle：** gateway unavailable/error, config vs gateway disabled, bundled/managed overlay, invalid manifests, canonical/noncanonical keys, apiKey redaction.
- **证据：** 本文件；`application/skills/store.ts`、`skills-operations-workflow.ts`、`gateway-readiness.ts`。

### runtime-host/application/workflows/skill-runtime/skills-operations-workflow.ts

- **当前 owner：** Skill operations API validation, local config mutation, gateway job submission and plugin dependency projection refresh.
- **当前事实：** local import/preinstall enqueue jobs; bundle import executes synchronously; config/state validate canonical key; batch state persists locally then refreshes plugin projection and best-effort status; single mutations return accepted gateway update job.
- **职责与关键 symbols：** `SkillsOperationsWorkflow`, import/update/effective/preview methods, validation, `applyUpdates`, dependency refresh.
- **旧语义与策略：** source/key/mutations are validated; batch de-dupes trimmed keys and local failure returns server error; refresh status failure only warns; plugin dependency refresh rewrites whole config via `updateDirty`.
- **状态、存储与副作用：** no fields; skills config writes, import/bundle workflows, jobs, plugin config update, logs.
- **并发与性能特征：** batch canonical lookup and update; dependency refresh full config replace; no transactional coupling of local skill config and gateway job.
- **调用/依赖边界：** upstream skills routes/service; downstream skills repository/jobs/runtime, import/bundle, plugin config repository/projection.
- **故障、恢复与安全：** local persist precedes gateway update; sync failure returned/in job; `apiKey` accepts raw string into repository, downstream redaction needed.
- **迁移分类：** Preserve：canonical-key enforcement, batch semantics, persist-before-gateway job, plugin dependency refresh. Intentional Improvement：private skill secret storage and durable reconciliation of local/gateway state; compatibility impact accepted jobs retained, oracle staged failure/redaction tests. Defect：无已证实项。待验证：gateway update idempotence and batch partial local mutation behavior.
- **未来 Rust owner：** Domain Module（Skill）；Foundation Kernel（secret/retry）；Runtime Integration（plugin/gateway projection）；Delivery（API adapter）。
- **Rust 重写与性能判断：** 旧成本为完整 plugin config rewrite and multiple dependent operations; 不变量 local config must persist before update submit; 指标 update latency, projection drift, secret exposure; oracle config/gateway trace and redaction fixture.
- **验证 oracle：** invalid keys/payloads, batch dedupe/failure, import/bundle errors, status refresh warning, plugin projection output.
- **证据：** 本文件；`skill-runtime-workflow.ts`、`application/skills/store.ts`、`runtime-plugin-service.ts`。

### runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow.ts

- **当前 owner：** Subagent gateway capability/RPC facade with stale-while-refresh snapshot cache and workspace initialization after create.
- **当前事实：** only `agents.list` snapshot kind; snapshot checks capability, starts background refresh without await, returns cached ready view or empty refreshing view; refresh is single-flight per method and generation guards stale completion; mutating call can invalidate all snapshots.
- **职责与关键 symbols：** `SubagentRuntimeWorkflow`, snapshot/call/createAgent/refresh/clear payload helpers.
- **旧语义与策略：** capability check uses 5s, RPC uses 60s; create performs gateway create first then workspace init, so init failure returns error after created agent; refresh errors cached as string and result null rather than thrown to snapshot caller.
- **状态、存储与副作用：** maps for snapshot/promise/error plus generation; gateway RPC/capability and workspace filesystem init.
- **并发与性能特征：** single-flight prevents duplicate `agents.list`; invalidation lets old tasks finish but prevents stale write; cache maps unbounded only by fixed one kind today.
- **调用/依赖边界：** upstream subagent service/routes; downstream gateway capability/RPC and workspace port.
- **故障、恢复与安全：** unavailable capability returns its application response; workspace initialization lacks compensation for already-created agent; errors do not leak params here.
- **迁移分类：** Preserve：stale-while-refresh response, single-flight, generation invalidation, create-before-workspace order. Intentional Improvement：model creation/workspace materialization as durable multi-step Domain command with recovery; compatibility impact agents created despite workspace failure must be surfaced, oracle fault trace. Defect：no confirmed defect; missing compensation is a recovery gap. 待验证：whether agent deletion/retry is safe after init failure.
- **未来 Rust owner：** Domain Module（Subagent/Agent identity）；Runtime Integration（OpenClaw agent API）；Foundation Kernel（task supervision/recovery）。
- **Rust 重写与性能判断：** 旧成本为一次 RPC per active refresh, eliminated duplicates via single-flight; 不变量 cached result not overwritten after invalidation; 指标 RPC count, snapshot staleness, create recovery; oracle concurrency and staged failure tests.
- **验证 oracle：** capability unavailable, first/cached snapshot, refresh failure, invalidation race, create RPC/init failures.
- **证据：** 本文件；`application/subagents/service.ts`、`gateway-capability-service.ts`。

### runtime-host/application/workflows/task-runtime/task-operations-workflow.ts

- **当前 owner：** Task tool API allowlist/parameter validation, background task output/stop and snapshot facade.
- **当前事实：** only six task/Todo methods accepted; every invoke needs sessionKey; method-specific taskId/subject/Todo old/new arrays required; background task missing returns ok success false rather than not-found error.
- **职责与关键 symbols：** `TaskOperationsWorkflow`, invoke/output/stop/snapshot methods, static task-method set.
- **旧语义与策略：** params sessionKey takes precedence then body; running output adds guidance; stop inability returns success false message; all valid calls delegate runtime workflow.
- **状态、存储与副作用：** no state; gateway task workflow and optional BackgroundTaskManager.
- **并发与性能特征：** validation O(1); actual waits/stop and snapshots downstream.
- **调用/依赖边界：** upstream task routes/service/session integration; downstream TaskRuntimeWorkflow and background manager.
- **故障、恢复与安全：** strict allowlist prevents arbitrary gateway task method; optional manager safely reports missing; authorization of sessionKey occurs downstream.
- **迁移分类：** Preserve：method allowlist, required params, success-false background semantics. Intentional Improvement：unify task receipts with Platform Core execution grammar without changing tool responses; oracle task route fixtures. Defect：无已证实项。待验证：session ownership authorization at delivery/runtime boundary.
- **未来 Rust owner：** Domain Module（Task）；Matcha Platform Core（execution/receipt）；Delivery（tool API adapter）。
- **Rust 重写与性能判断：** 旧成本为可忽略的 validation; 不变量 allowed methods and response DTO; 指标 task invoke/output latency; oracle mocked runtime/background contracts.
- **验证 oracle：** unsupported/missing values, TodoWrite arrays, missing/running/stopped background task, snapshot forwarding.
- **证据：** 本文件；`task-runtime-workflow.ts`、`services/background-task-manager.ts`。

### runtime-host/application/workflows/task-runtime/task-runtime-workflow.ts

- **当前 owner：** Gateway task-plugin execution, workspace scoping, normalized task/todo snapshot production and event emission.
- **当前事实：** requires task-manager plugin capability before RPC; adds workspaceDir if caller did not provide; TaskCreate/Update follow with authoritative TaskList snapshot; TodoWrite emits direct todos snapshot; replay normalizes scope/tasks/todos and builds `agent:///...` URI.
- **职责与关键 symbols：** `TaskRuntimeWorkflow`, call/build/emit snapshot, scope/list/todo normalizers, trace logger.
- **旧语义与策略：** capability timeout 5s, RPC 60s; unrecognized status becomes pending; malformed tasks/todos are dropped; fallback scope parses `agent:<id>:` session key; caller-supplied workspaceDir overrides resolver.
- **状态、存储与副作用：** no cache; gateway RPC, capability calls, async workspace resolution, optional session event callback, conditional console trace.
- **并发与性能特征：** write methods add an extra TaskList RPC; no per-session ordering/serialization; normalization is linear in returned lists.
- **调用/依赖边界：** upstream TaskOperationsWorkflow/session timeline; downstream Gateway RPC/capability, workspace resolver, session snapshot event contract.
- **故障、恢复与安全：** capability unavailable returns response/null; RPC errors propagate; workspaceDir override is a trust boundary whose authorization is not checked here.
- **迁移分类：** Preserve：method timeouts, workspace injection, post-write authoritative snapshot, normalization and event source. Intentional Improvement：session-scoped task state/event append should be Domain Module with Foundation Kernel ordered facts; compatibility impact preserves task/todo snapshot payload, oracle gateway transcript differential. Defect：caller-provided `workspaceDir` can bypass resolver by design; authorization evidence absent, so 待验证. 待验证：same-session concurrent writes/order and workspace path trust.
- **未来 Rust owner：** Domain Module（Task）；Matcha Platform Core（execution correlation）；Runtime Integration（task plugin）；Foundation Kernel（ordered fact/event mechanism）。
- **Rust 重写与性能判断：** 旧成本为写入 RPC plus full TaskList snapshot; 不变量 event reflects gateway authoritative state; 指标 RPCs/write, snapshot latency, out-of-order events; oracle mock call order/concurrent session tests.
- **验证 oracle：** capability unavailable, each write/read, malformed task/todo, fallback scope, workspace override/resolver, snapshot failure.
- **证据：** 本文件；`task-operations-workflow.ts`、`shared/session-adapter-types.ts`、`gateway-capability-service.ts`。

### runtime-host/application/workflows/toolchain-install/uv-python-install-workflow.ts

- **当前 owner：** uv discovery and Python 3.12 installation command adapter.
- **当前事实：** checks bundled uv candidates first then PATH; install uses bundled candidate else `uv`, explicitly reports PATH absence; executes `uv python install 3.12` with hidden window and returns stdout/stderr/error text on failure.
- **职责与关键 symbols：** `UvPythonInstallWorkflow`, `checkInstalled`, `executeInstall`, candidate/PATH helpers.
- **旧语义与策略：** PATH probe uses `where.exe` Windows or `which` elsewhere with 5s timeout; bundled candidate bypasses PATH probe; install errors are converted to `{success:false,error}` rather than thrown.
- **状态、存储与副作用：** no state; filesystem existence and command process invocation.
- **并发与性能特征：** candidate scan O(candidates); one PATH subprocess and installation subprocess; no install single-flight.
- **调用/依赖边界：** upstream toolchain jobs/routes; downstream uv runtime port, command executor, filesystem.
- **故障、恢复与安全：** hidden window; error output may contain environment details; no cancellation/deadline for actual install beyond executor default.
- **迁移分类：** Preserve：candidate preference, platform PATH discovery, Python version, error result DTO. Intentional Improvement：Foundation Kernel-managed process execution with cancellation/deadline/output redaction; compatibility impact same success/error behavior, oracle command mock. Defect：无已证实项。待验证：parallel install and expected process timeout.
- **未来 Rust owner：** Native Runtime Edge（uv/toolchain）；Foundation Kernel（process supervision）；Delivery initiates command.
- **Rust 重写与性能判断：** 旧成本为子进程 probing/install; 不变量 selection and command args; 指标 probe/install duration, concurrent installs, stderr redaction; oracle fake executor/platform tests.
- **验证 oracle：** bundled/path/missing uv, Windows/non-Windows command, executor error fields.
- **证据：** 本文件；`application/toolchain/uv-service.ts`、`toolchain-jobs.ts`。

### runtime-host/application/workflows/usage/token-usage-history-workflow.ts

- **当前 owner：** Token usage transcript scan, cache and recent query projection.
- **当前事实：** cache keeps aggregate entries and per-file `{size,mtime,entries}`; scan lists transcript files, reuses unchanged file parses, ignores individual file errors after dropping that cache entry, evicts absent files, sorts newest-first and enforces limit.
- **职责与关键 symbols：** `TokenUsageHistoryWorkflow`, recent/refresh/isReady/scan, `normalizeLimit`.
- **旧语义与策略：** undefined/nonfinite limit is infinity, negative floors to zero; file scan stops once accumulated entries reaches finite limit before final timestamp sort; `recent` returns copy/slice; refresh marks cache ready even empty.
- **状态、存储与副作用：** in-memory aggregate/file cache; transcript layout listing, filesystem stat/read, JSONL parsing.
- **并发与性能特征：** sequential file stat/read/parse; cache key size+mtime; final sort O(k log k); limited scan can omit newer entries if layout order is not newest-first.
- **调用/依赖边界：** upstream cron usage query and usage jobs; downstream runtime data/layout/filesystem/parser.
- **故障、恢复与安全：** per-file errors are isolated; transcript content parsing may include sensitive metadata, but returned entry projection is parser-owned.
- **迁移分类：** Preserve：limit semantics, per-file cache, error isolation, descending timestamp output. Intentional Improvement：ensure transcript layout order or use bounded top-k so finite limit is globally newest without reading all files; compatibility impact only if unsorted layout exists, oracle shuffled-file fixture. Defect：finite early break before final sort is an evidenced conditional correctness defect when `listSessionTranscriptFiles` is not guaranteed newest-first; ordering guarantee is 待验证.
- **未来 Rust owner：** Domain Module（Usage）；Foundation Kernel may provide cursor/file observation cache.
- **Rust 重写与性能判断：** 旧成本为串行 scan/parse and O(k log k) sort; 不变量 newest N entries and unchanged-file reuse; 指标 files read, bytes parsed, query latency, cache hit rate; oracle ordered and deliberately shuffled transcript fixtures.
- **验证 oracle：** limit 0/finite/infinite, unchanged/changed/removed file cache, malformed file, timestamp ordering/shuffled layout.
- **证据：** 本文件；`application/usage/token-usage-history.ts`、`token-usage-parser.ts`、`cron-operations-workflow.ts`。

### runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow.ts

- **当前 owner：** Workspace file read/write/list/staging/thumbnail operations and session-identity-bound path authorization.
- **当前事实：** read text/binary limits respectively 2 MiB/50 MiB; text rejects NUL-detected binary; writes cap text at 2 MiB; staging cap binary at 50 MiB; workspace file/staging targets must carry matching endpoint/scope metadata and resolved paths must be inside session workspace root when roots port exists.
- **职责与关键 symbols：** `WorkspaceFileRuntimeWorkflow`, read/write/stat/list/stage/thumbnail methods and target/path/media authorization helpers.
- **旧语义与策略：** list hides dotfiles unless requested and blacklists named heavy dirs; writes protect existing symlink mismatch and nearest parent containment; staged paths get random ID; outgoing media URL resolves record and checks owner/session identity; all preview errors map to a small error vocabulary.
- **状态、存储与副作用：** no persistent local state except outbound files/records; broad filesystem I/O, base64 encode/decode, runtime data store and workspace root calls.
- **并发与性能特征：** reads entire accepted file into memory/base64 (binary output expands roughly 4/3); multi-stage and thumbnails run mostly serially; directory listing materializes/sorts all eligible entries; thumbnail embeds full image up to 2 MiB.
- **调用/依赖边界：** upstream file routes/service and workspace/session scope contracts; downstream runtime filesystem, id generator, environment, runtime data store, runtime address contracts.
- **故障、恢复与安全：** all read/write/list preview failures are caught and mapped; staging errors intentionally throw; path containment resolves real paths to resist traversal/symlink escape; `thumbnails` direct filePath branch does not call workspace target validation, but route trust contract is not in this file.
- **迁移分类：** Preserve：byte limits, MIME map, target/scope/endpoint checks, workspace root containment, owner matching, error vocabulary. Intentional Improvement：Foundation Kernel should supply capability-scoped file handles rather than re-authorizing raw paths; compatibility impact requires identical allowed/denied outcomes, oracle traversal/symlink/session mismatch tests. Defect：no proven bypass from `thumbnails` because caller/route authorization is uninspected; mark 待验证. 待验证：base64 decoder strictness, symlink behavior on all platforms, and route-level authorization for direct thumbnail paths.
- **未来 Rust owner：** Domain Module（Workspace/File）；Matcha Platform Core（runtime/session identity/scopes）；Foundation Kernel（capability/secret-safe file access）；Delivery returns previews.
- **Rust 重写与性能判断：** 旧成本为 full-buffer I/O/base64, O(n log n) directory sort and serial staging; 不变量 limits/authorization/error codes; 指标 peak memory, bytes encoded, list latency, blocked traversal rate; oracle security corpus plus size-bound benchmarks. Streaming is only justified for endpoints whose response contract can remain equivalent.
- **验证 oracle：** too large/binary/not-found/not-directory, hidden/blacklist list, traversal/absolute/symlink/session/endpoint mismatch, stage buffer/path caps, outgoing media owner mismatch, thumbnail limits.
- **证据：** 本文件；`application/files/file-service.ts`、`application/agent-runtime/contracts/runtime-address.ts`、workspace/session adapters。

## 当前 Git status 增量复核（2026-07-12）

- **分类：** **非 Session workflows 仍为 TypeScript application orchestration；Rust cutover 未证实。** 当前 status 修改了 `gateway-readiness-workflow.ts`、`runtime-bootstrap/gateway-prelaunch-workflow.ts`、`runtime-host/runtime-host-operations-workflow.ts`、`skill-runtime/skill-runtime-workflow.ts` 等，仍由 TS service/composition 调用。
- **生产 active path：** routes/capabilities → corresponding application service → workflow → Gateway/Platform/Runtime ports。启动侧由 Electron local-process runtime 监督 OpenClaw Gateway 和 runtime-host child；host 内 `GatewayPrelaunchWorkflow`、readiness workflow、runtime-host operations 与 skill runtime 仍消费这些 TS ports。新增 Remote Fleet service 的 bootstrap/agent transport 也由 composition 内 `WorkerBackedRemoteFleetService` 委托 worker，但它本身属于新增 TS application domain，未迁入 Rust。
- **外部旧 owner 与 current-vs-target 边界：** Electron 的旧 `electron/gateway/**` orchestration 已被 `electron/main/process-runtime/openclaw-gateway/**` 当前实现替代。workflow 不取得 supervisor/domain owner；但其调用的 prelaunch、port/control readiness、recovery failure mapping 共同界定了 Rust Local Process Host 要承接的外部旧 lifecycle 语义。Rust 迁移时必须将 workflow 的准备/策略与 Runtime Integration 的 Gateway-specific adapter、Foundation process primitive、Rust Runtime lifecycle policy分开，而不能把整个 Electron 目录永久排除。当前没有 Rust workflow replacement。
- **旧策略与 future owner：** Preserve workflow 的 command/query response、Gateway readiness/prelaunch failure mapping、job/port delegation及各领域持久化边界。future Rust 可按 Domain Module 实现具体 workflow，Foundation 提供 jobs/I-O/deadline/进程原语，Runtime Integration 适配 Gateway，Rust Runtime 决定受管 Runtime lifecycle；Electron仅保留桌面 Delivery。不得依据静态 status 宣称 external readiness、bootstrap recovery、plugin/skill actions 或 Remote Fleet worker 投递已验证。
- **未运行 oracle：** `pnpm exec vitest run tests/unit/runtime-host-bootstrap-provider-sync.test.ts tests/unit/runtime-host-service-injected-routes.test.ts tests/unit/runtime-host-gateway-ready.test.ts tests/unit/runtime-host-gateway-lifecycle.test.ts tests/unit/gateway-control-ready-probe.test.ts tests/unit/local-process-runtime-start-failure.test.ts tests/unit/remote-fleet-runtime.test.ts`；`pnpm run typecheck`。本次均**未运行**。
