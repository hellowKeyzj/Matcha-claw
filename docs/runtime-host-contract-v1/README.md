# Runtime Host Contract Baseline v1

> Rust `runtime-host` 迁移的观察基线。它固定现有客户端可观察行为；仅本轮显式批准的 call-log/Calls 与具体 admit consumer 作为契约增量，不授权其他 Renderer、preload 或 Electron API 改动。

## 使用方式

| 需要回答的问题 | 文档 |
| --- | --- |
| 哪些边界属于本次替换，谁是权威来源？ | [scope.md](scope.md) |
| Electron 与 child 的 HTTP envelope、错误和超时是什么？ | [transport.md](transport.md) |
| Renderer 实际怎样调用 Host API 和 capability？ | [renderer-api.md](renderer-api.md) |
| 已注册的 child route、Host API 暴露与 legacy rejection 是什么？ | [routes.md](routes.md) |
| `host:event`、事件 payload、顺序和丢失语义是什么？ | [events.md](events.md) |
| child 如何调用 Electron parent？ | [parent-callbacks.md](parent-callbacks.md) |
| child 如何启动、ready、停止、重启和代理 WebSocket？ | [lifecycle.md](lifecycle.md) |
| 统一 call log 与原 owner 长操作怎样分工？ | [async-projection.md](async-projection.md) |
| 现有测试证明了什么，还缺什么？ | [verification.md](verification.md) |
| 当前源码、类型、文档之间有哪些未裁决差异？ | [open-items.md](open-items.md) |
| TS 真实行为对应哪些 owner、事实源和状态平面？ | [runtime-host-owner-model/README.md](../runtime-host-owner-model/README.md) |

## 冻结原则

```text
Renderer / page / store
  → preload IPC
  → Electron Host API
  → DirectRuntimeHost control 或 signed loopback product route
  → Rust Owner actor
  → Rust 内部 owner

Rust 替换 child 与其内部实现；Renderer/preload contract 不因迁移改变。
```

1. **Renderer 实际消费者优先。** 请求字段、返回字段、错误处理、timeout、轮询和事件消费以 `src/` 调用方为首要证据。
2. **Electron 是 child 的协议客户端。** 当前 Rust active path 是 `DirectRuntimeHost` private control + signed loopback product routes；旧 `/dispatch`、`/health`、root lifecycle compatibility endpoints 已废除。
3. **TS 内部类型不是自动契约。** 只有经过 HTTP、IPC、事件或 CLI 可观察到的字段才进入本基线。
4. **显式 legacy rejection 也是现有行为。** 已禁用的旧 route 不能被 Rust 悄悄恢复成另一种成功语义。
5. **`OPEN` 不是设计建议。** 它表示源码、测试或旧文档之间的真实差异；在 Rust 实现前必须显式裁决，不能被默认猜测掩盖。

## 证据状态

| 标记 | 含义 |
| --- | --- |
| `CONFIRMED` | 当前源码已直接证明。 |
| `LEGACY-REJECTED` | child 仍注册该路径，但明确返回拒绝。 |
| `ALLOWLISTED-UNCONFIRMED` | 可被桥接，但当前盘点未找到已确认 producer 或 consumer。 |
| `OPEN` | 当前实现、类型、测试或旧文档存在差异，尚未作迁移裁决。 |

本目录记录的是当前仓库状态；不以旧的 [runtime-host-transport-v1.md](../runtime-host-transport-v1.md) 单独作为完整真相。后者是较早的最小 transport 说明，已知差异见 [open-items.md](open-items.md)。

## Matcha MCP 启动契约

Host 与 MCP 分发同一 `runtime-host` 二进制（Windows 为 `.exe`）。Host 无参数启动；MCP 使用 `runtime-host mcp --state-dir <absolute directory>`，在创建 Host runtime/bootstrap 前同步分流到独立 stdio 进程，原 21 项工具的 schema、顺序与协议不变。统一入口为 library public `mcp` module 的 `run`，main 调用 `runtime_host::mcp::run`；`host/src/mcp/{mod,stdio,client,discovery,route}.rs` 只负责 stdio 组合与私有 transport，不创建第二个 Team/Wiki owner。产品托管 executable/args 保持该命令；手工旧 `runtime-host-mcp` 路径须改为新命令，不分发兼容二进制。[VERIFY: runtime-host/host/src/main.rs:10-21] [VERIFY: runtime-host/host/src/lib.rs:1-9] [VERIFY: runtime-host/host/src/mcp/mod.rs:3-9] [VERIFY: runtime-host/host/src/mcp/stdio.rs:14-64] [VERIFY: runtime-host/integrations/openclaw/src/native_config/connector/preset.rs:108-121]

Team/Wiki callbacks 共用现有 signed loopback listener，分别进入已有 `OrganizationHandle` 与 `WikiModule.handle()`。唯一 `ModuleCatalog` 中的 `host.mcp` requires `organization/runtime.directory/wiki`，同名 scope 管理 `host.mcp.team.call`、`host.mcp.wiki.call` 两条 route 的注册与 disposal；沿原 route snapshot/Router，不新增 listener、owner、queue 或 registry。私有 endpoint 为 `/internal/team/mcp`、`/internal/wiki/mcp`，分别绑定 `team-mcp-local/team.mcp`、`wiki-mcp-local/wiki.mcp`；签名仍核 endpoint/family/tool、tool subject、body SHA256 revision、replay 与 30 秒 decision validity，Team native resolver 授权不变。共享 discovery 为 `mcp-private/mcp.json`，保留原私有权限、每启动 key、zeroize 与 Drop byte-owner 比较，无旧 `team-mcp.json` 读写或 fallback；`matcha-mcp.json` command/args 与 peer policy 不变，key 不进入 public DTO/config/log/CallLog。[VERIFY: runtime-host/host/src/app/service.rs:111-150] [VERIFY: runtime-host/host/src/module_registry/install.rs:17-100] [VERIFY: runtime-host/host/src/composition/host/owners/runtime.rs:643-652] [VERIFY: runtime-host/host/src/mcp/mod.rs:19-44] [VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/host/src/mcp/discovery.rs:28-115]

共同 client 只持有一套 current-thread Tokio runtime 与 no-proxy/no-redirect HTTP client，每次实际调用刷新 discovery。Team 保留 30 秒请求期限与 1MiB request/response 上限；Wiki 仅 body 接收限 30 秒，不新增 execution/response deadline 或 response cap。Wiki JSONL 输入仍无限，Content-Length 外层仍限 1MiB，Platform framing/parser/budgets 不变。私有 body 仍是严格 `{name,arguments}`；Wiki 成功为 HTTP 200 原 DTO，InvalidParams 为 400、Internal 为 503，client 映回原 ToolCallError，不新增 Execution 错误或通用 wire envelope。[VERIFY: runtime-host/host/src/mcp/client.rs:18-118] [VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs:122-139] [VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs:317-333] [VERIFY: runtime-host/platform/src/mcp/protocol.rs:1-126]

本节同步冻结的 owner/transport 事实，不代表完整实机验收；已执行检查、既有失败与未运行项见 [2026-10-14 MCP 验证段](../architecture-knowledge/modules/runtime-delivery/dev.md#2026-10-14-mcp-同-owner-验证)。

## Wiki MCP 当前库契约

共用 `matcha` MCP 保留 TeamRun 6 项、Wiki 15 项工具。Wiki 工具不接受 `projectId`，也不开放模型选库；当前库以 Host 已有常驻 Wiki owner 状态为权威，UI 成功 create/open/set-current 与 MCP 共享同一 handle，启动后新增库立即可见。原 command binding/query snapshot 时点保留，切库不改变已绑定操作。逐 call 重读 persisted latest 的 `ReloadProjects` 及独立 Wiki owner 已删除；外部直接改 JSON 不是正式 setter，旧 reload 的磁盘损坏/读取失败边界不能宣称逐字保持，不建立 disk cache 或第二持久状态。内部 Wiki 产品 API 的项目参数、返回与业务契约不变，不新增 Renderer HTTP、IPC 或会话绑定接口。[VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs:75-146] [VERIFY: runtime-host/modules/wiki/src/api.rs:1103-1145] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs:668-674] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs:837-910]

Wiki callback facade 只保留原 15 项 schema/allowlist 与顺序，解析、原 owner API 调用、DTO 序列化与失败映射由 `WikiHandle::execute_mcp` 承接，全部 await 原最终 DTO、不返回 202。read limit=0/full、search 20、retrieve 8、optional null/default、source paths 不 trim、query 非空、空 files/content 与 apply 空 reviews 的原参数规则保留；成功直接返回原 CamelCase/null DTO，embed 为 `{success:true}`，不新增通用 wrapper。MCP source import/folder/refresh 显式选择 crate-private `IngestMode::SourceOnly`，在原 parse/commit LLM 边界选 None；产品/UI、watcher、retry/resume 入口仍为 `Configured`。成功工作把 mode 记录到既有 project drain 的 `processed: Option<IngestMode>`，混合成功批次 `Configured` 占优；claim 取该批次模式，不取最后 finisher 的模式。纯 `SourceOnly` 批次仅 rules-only review、无审查 LLM，混批履行既有 `Configured` review，不为 MCP source processing 新增模型要求。`finish_source_work`、`sweep_reviews_after_drain` 与 `StageReviewSweep` 保持原不带 mode 的签名；不修改全局 WikiShared 或新增 DTO/config 字段。来源锁/任务事实、图片/页面/embedding 与 cancellation/drain/join 保留，apply 原先显式 None 的生成边界不变。[VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs:28-139] [VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs:141-333] [VERIFY: runtime-host/modules/wiki/src/api.rs:231-645] [VERIFY: runtime-host/modules/wiki/src/api.rs:867-927] [VERIFY: runtime-host/modules/wiki/src/application/commands.rs:20-38] [VERIFY: runtime-host/modules/wiki/src/application/commands.rs:176-188] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs:1858-1901] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs:2949-3099] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs:3393-3420] [VERIFY: runtime-host/modules/wiki/src/api/sweep.rs:20-50] [VERIFY: runtime-host/modules/wiki/src/sweep/mod.rs:33-37] [VERIFY: runtime-host/modules/wiki/src/sweep/mod.rs:87-100] [VERIFY: runtime-host/modules/wiki/src/sweep/mod.rs:116-122] [VERIFY: runtime-host/modules/wiki/src/owner/sweep.rs:22-84]

## Team MCP 同 owner 契约增量

MCP `team_graph_patch` 不开放 `set_node_position` 或坐标参数，MCP 专属入口拒绝该操作；图布局由画布负责。Renderer 拖动/整理沿原 graph patch 保存位置，domain 坐标操作、持久化与 snapshot 不变；这是 MCP 输入范围的显式收窄，不删除后端布局能力。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:42-101] [VERIFY: src/pages/Teams/TeamRunGraphCanvas.tsx]

设计 `team_graph_context` / `team_graph_patch` 的业务失败保留 `success:false` 与可读 `error`，并返回明确的 `errorCode`；图校验可附安全 nodeId/edgeId，区分端口/action、缺失端点、图版本/base、设计凭据及幂等冲突。原因来自实际失败的原校验，不以重新预检推断。内部持久化错误不暴露细节，结果不确定时要求先读回；不承诺失败一定未落盘。无凭据脱敏 context 与设计成功 snapshot 保留；运行期 prompt 读写使用下述任务上下文与业务执行校验。`team_node_event` 只接收 progress/request_input/request_approval，删除 complete/reject 与 deliveryId/receipt/nodeId/attemptNumber/summary/outputPort 六个终态字段；真实 terminal hook、approval/decision/evidence 能力保留。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:317-333] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:316-369][VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:101] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:167] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:399-640]

Team 六工具名称不变；stdio facade 从独立 Team store 路径收束为 Host fixed caller，经现有 loopback listener 的私有 POST `/internal/team/mcp` 调用同一 OrganizationHandle。该入口不是 Renderer route 或通用 store API，不增加网络 listener/执行 queue；Wiki 同样进入既有 WikiHandle，15 项工具及原 DTO 保留，当前库权威见上节。[VERIFY: runtime-host/host/src/mcp/stdio.rs:14-40] [VERIFY: runtime-host/modules/organization/src/adapters/mcp/team_run.rs:4-21] [VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/host/src/app/service.rs:111-150]

私有调用签名绑定 `team-mcp-local`、tool subject、body SHA256 revision 与 30 秒有效期；此 principal 不代表 native session/role 授权。Host 每启动的 discovery key 不进入 public DTO。Matcha 的私有 launch 投影仅含 command/args，worker env 只传文件路径并沿原 MCP policy；不改变 Renderer Sessions 输入或会话绑定。[VERIFY: runtime-host/host/src/mcp/client.rs:18-118] [VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/host/src/mcp/discovery.rs:28-115] [VERIFY: matcha-agent/src/app-server/main.ts:210-216] [VERIFY: matcha-agent/src/services/mcp/config.ts:1097-1115] [VERIFY: matcha-agent/src/services/mcp/config.ts:1194-1266]

ExistingTeam 讨论与设计复用原 `team.runtime`，以 `team.runStart` 统一启动；exact input 为 `{teamId,runId,designEpoch:null|string,expectedGraphVersion,idempotencyKey}`，成功为 `{success:true,outcome:'started'}`。门禁只有 Intake/Designing/Started，snapshot gate 无 proposal 字段；旧 designRun、designContinue、proposal operations 与模型控制块启动链已删除。Intake 传 null，Designing 传当前 epoch；后端独立 RunStart command 在原 WriterLock 内核 exact team/run、Active lifecycle、阶段/epoch、definition hash 与完整图后一次提交 Started，再沿原 RunStarted wake/scheduler 推进。校验失败保持原阶段；Started 同 team/run 重放不提交、不再次唤醒，opaque key 仅作输入校验。designStart/Exit/Snapshot/GraphPatch 保留；退出设计清授权但保留图、角色与 run，Intake 重放不提交，Started/错 epoch 拒绝。旧 codec tag 1 只读为 Intake，tag 4 只读为 Designing、保留 epoch 并清 generation；新写仅 tag 0/2/3。完整字段见 [Renderer API 设计增量](renderer-api.md#existingteam-工作流设计增量)。[VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:485-512] [VERIFY: runtime-host/modules/organization/src/application/design.rs] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:336-406] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:201-252] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:2559-2586] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs:588-604] [VERIFY: runtime-host/modules/organization/src/owner/step_runtime.rs:43-47]

MCP graph context 的无凭据 `current_node/graph_summary` 保留 redacted query，epoch/generation 必须同时提供才读设计完整图；运行期 `run_prompts` 要求 teamId/runId/nodeId/nodeExecutionId 来自本次任务上下文，不能混入设计凭据；Organization 校验真实运行阶段与当前执行，拒绝不 fallback。设计 patch 携 exact team/run、epoch/generation、expectedGraphVersion、command/idempotency 与 base graph/workflow plan，Renderer patch 不携模型 generation；均进入同一 owner transaction，统一由 draft.command 将原请求 fingerprint 写入 event GraphPatch 的 typed command identity，ledger 重放核验后才 resolve；codec 新 tag 4 承载该字段，旧 tag 0 保留原正文历史解释，不伪造 metadata 操作或新建 receipt store。[VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:217-307] [VERIFY: runtime-host/modules/organization/src/store/design.rs:33-65] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1218-1230] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1393-1409]`sessionRef` 必须匹配当前 role 在本 run 的既有 binding，不是 native session identity。TeamChat 与 Chat 页面里的 TeamLeader 会话运行面共享同 run 原生图；普通 session 无 Team 设计入口或协议，成员会话不获 leader control。[VERIFY: src/pages/Chat/index.tsx:681-683] [VERIFY: runtime-host/modules/organization/src/application/start_gate_control.rs] `team:changed {}` 只是 exact-run 回读提示，不新增 store/queue/iframe。源码契约与执行验证分列，实际结果见 [Team 设计验证边界](../architecture-knowledge/modules/team-task-organization/dev.md#existingteam-工作流设计本轮验证边界)。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:42-143] [VERIFY: runtime-host/modules/organization/src/store/design.rs] [VERIFY: runtime-host/modules/organization/src/application/design.rs] [VERIFY: src/stores/teams.ts:1042-1088]

设计节点 Work/Review 必须显式 roleId；共享 JSON patch 的 config.sessionRef 可省略，由原锁内在 ledger 重放判定之后按当前 Run 的唯一角色绑定派生。零绑定拒绝、多绑定要求明确选择；显式错误值不作缺省，完整 JSON/YAML 导入仍须 sessionRef。缺省状态保留在原请求指纹，不用派生值改变幂等身份。[VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:62-120] [VERIFY: runtime-host/modules/organization/src/store/design.rs] nodeId/edgeId 是新对象 ID，不与引用 ID 混用，prompt/title/outputArtifactKind 保留文本。Work 分组与 Join policy 已退役，当前输入拒绝 groupId/group/config.join；Join 全部入边必须 Gate；共享 JSON 边请求在解析端口后，按源端口动作与目标约束的交集处理缺省 action：唯一候选派生，多候选要求显式选择，零候选拒绝，不默认 Activate。草稿可无入边但不能启动执行。所有 Gate 要求源当前 attempt 为 Completed 且出口匹配，实际 Failed 不会因 completed 端口放行；Join 自动输出 joined，并按历史输入 fence、逐跳 payload 向下游透传上游摘要引用。返工仍使用原消费者失效与节点 maxAttempts，不直接返工 Join。dependency 只在 Work→Work 允许 `{}` 或部分字段省略并从两端 taskId 派生，其他端点仍须两 opaque ID，不把全部历史 metadata 强化成外键。结构与业务校验分别生效，typed 错误沿原安全 envelope 返回。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs:144-244] [VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:160-169] [VERIFY: runtime-host/modules/organization/src/run/graph/definition.rs:779-823]

ScriptReview 的共享 patch 配置为必填 `config.rule`，仅接受 `pass_through / assert_all_upstream_completed / assert_no_blocking_gate / assert_artifact_exists`；历史缺规则不默认放行。HumanDecision 保持空配置，由原 owner 为 Ready attempt 生成审批并等待；`team_approval_resolve` 按已保存 subject 结算 HumanDecision 或 WorkNode，调用本身不证明真人授权，Work 只记审批账、不推进节点。`team_graph_context` 的 `current_node.approvals` 返回同 Run、同节点当前 execution 的 `{approvalId,subject,status,decision}`，不含 reason/note；`graph_summary.approvals` 为空。该查询恢复结果可见性，不承诺自动通知或 native continuation。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs] [VERIFY: runtime-host/modules/organization/src/run/context.rs:305-331] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:1619-1764]

设计凭据、expectedGraphVersion 与 baseGraphId/baseWorkflowPlanId 继续显式传入；当前 facade 只有工具名/参数，私有 transport principal 不携可信 session/turn 上下文，不能自动选择全局当前 Run、补凭据或刷新版本绕过冲突。版本冲突须重读并重新决定修改，不原样换新版本重发。[VERIFY: runtime-host/host/src/mcp/client.rs:18-118] [VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:245-304]

运行期仍使用原两个工具，exact 输入如下；不新增 Renderer route 或工具名。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs:56-134]

| 工具 | 运行期输入 |
| --- | --- |
| `team_graph_context` | `{teamId,runId,nodeId,nodeExecutionId,view:'run_prompts'}` |
| `team_graph_patch` | `{teamId,runId,nodeId,nodeExecutionId,expectedGraphVersion,commandId,idempotencyKey,operations:[{op:'set_node_prompt',nodeId,prompt}]}` |

两工具各使用一份根级 object schema；patch 的 `operations.items` 统一声明设计操作和 `set_node_prompt`，不再合并两套同名数组。顶层 nodeId/nodeExecutionId 标识当前调用节点执行，operations 中的 nodeId 标识修改目标；设计与运行操作不能混批。工具按请求的 view/操作意图进入现有业务入口，Organization 在原事务内核验真实阶段；不增加模型可选的 mode，不把传入标识视为身份认证。[VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs] [VERIFY: runtime-host/modules/organization/src/application/team_mcp.rs]

context 成功为 `{outcome:'available',teamId,runId,graphVersion,nodes,edges}`：全图节点含 nodeId/kind/title，work/review 另含 roleId/prompt；边含 edgeId、两端 node/port 与 action。patch 成功为 `{success:true,outcome:'applied'|'replayed',teamId,runId,graphVersion}`，不重复返回图。owner 同 WriterLock 刷新事实并核 Active Started、当前在途 Activity/Delivery 与 execution fence；patch 复用原 ReplaceNode/ledger，不发布调度 wake。replay 不重复 apply，但原 transact 仍追加 facts frame。已有 Activity 及同次 retry 保留快照，新 Activity/rework 使用新正文；原 summary/decision 完成链继续推进 scheduler，dispatch 不再派任务。[VERIFY: runtime-host/modules/organization/src/store/runtime_graph.rs] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:1296-1319] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs:642-661] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:2023-2041]

运行期 patch 不携 designEpoch/promptGeneration 或 baseGraphId/baseWorkflowPlanId，只改已有 work/review 正文。Host 直接发送原任务正文，不再签发或注入执行凭据；MCP 到 Host 的原通信签名、principal 与请求 revision 校验保留。模型传入的四个上下文标识只用于业务定位，不证明调用者身份；Organization 核验执行是否仍有效，不能据此声称阻止冒用另一个有效执行的标识。未引入 session 自动绑定、插件、原生私有字段或第二授权存储，不修改 OpenClaw。未知提交仍先回读。[VERIFY: runtime-host/host/src/mcp/route.rs:27-165] [VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:395-410] [VERIFY: runtime-host/modules/organization/src/store/runtime_graph.rs]

## Wiki 三项维护能力契约增量

本轮明确批准的原版去重、导入排空审查、缺页链接能力新增以下 `/api/wiki` 产品入口，不改变 MCP 的 15 项工具或当前库合同。[VERIFY: runtime-host/modules/wiki/src/adapters/loopback/mod.rs] [VERIFY: runtime-host/modules/wiki/src/adapters/mcp/mod.rs]

| 入口 | 返回 |
| --- | --- |
| POST `/dedup/detect`、`/dedup/merge`、`/dedup/retry`、`/dedup/resume` | strict 202 `CallReceipt` |
| GET `/dedup/state`、POST `/dedup/cancel`、`/dedup/exclude` | 200 `WikiDedupState` |
| GET `/page-links` | 200 `WikiPageLinks` |
| POST `/missing-page/create` | strict 202 `CallReceipt` |
| POST `/missing-page/cancel` | 200 `{cancelled:boolean}` |

五个新增 operation 为 `dedup.detect|merge|retry|resume`、`missing-page.create`。detect/create 的结果由原 Wiki typed result 槽保存，分别为 `{projectId,groups}`、`{projectId,path}`，终态后按 callId/operation/projectId 领取和核对；merge/retry/resume 不新建结果服务。DTO 输入保留可选 projectId；检测、缺页创建及取消用 taskId 固定本次执行，merge 输入 group/canonicalSlug，链接查询用 relativePath，创建用 title/linkingPath/draft。GET 使用既有 read scope，POST 使用 write scope；detect/create admission 与 typed result 读取沿原 local Main principal 边界。Call Log 不保存 prompt、正文或凭据。accepted、辅助索引更新和真实模型/实机验证是不同事实。[VERIFY: runtime-host/modules/wiki/src/domain/maintenance.rs] [VERIFY: runtime-host/modules/wiki/src/call.rs] [VERIFY: runtime-host/modules/wiki/src/call_result.rs] [VERIFY: runtime-host/modules/wiki/src/adapters/loopback/mod.rs] [VERIFY: src/types/wiki-call-result.ts]

## Wiki 选区助手契约增量

选区固定流程新增 POST `/api/wiki/selection/generate`、`/selection/apply`（strict 202 CallReceipt），GET `/selection/task`、POST `/selection/cancel`（200 WikiSelectionTask）。输入保留可选 projectId，生成用 taskId/relativePath/intent/instruction/selection/history/modelRef；选区仅 prefix/selectedText/suffix/sourceMapped，不跨层传 Rust 字节 offset。task 返回本次 projectId/taskId/relativePath/intent/status/content/references/error，apply typed result 为 `{projectId,relativePath,content}`。四入口沿 signed Wiki capability 与 `electron-main-local` principal，task 为 read scope，其余 write；Call Log 仅 operation `selection.generate|apply` 与 outcome，内容不进入审计。[VERIFY: runtime-host/modules/wiki/src/domain/selection.rs] [VERIFY: runtime-host/modules/wiki/src/adapters/loopback/mod.rs] [VERIFY: src/types/wiki-selection.ts] [VERIFY: src/types/wiki-call-result.ts] [VERIFY: electron/main/runtime-host-delivery/transport/wiki/index.ts]

生成投影保留模块内最多 32 槽和 2MiB 正文，不永久保存选区问答或跨重启恢复；先 stage 注册取消，再 admit 既有 workflow，202 只证明接单。接受必须校验现存项目内 Markdown 的完整快照后在 Commit lane 替换并直接保存，不创建页面或重写 schema/date；成功消费本次 callId/operation/project/path 的 typed result，刷新失败不重复应用。源码与可靠预览映射都可改写，无法映射仍可问答；有效原版 prompt/history/上下文/采样保持，无 Agent Loop。[VERIFY: runtime-host/modules/wiki/src/selection/mod.rs] [VERIFY: runtime-host/modules/wiki/src/selection/prompts.rs] [VERIFY: runtime-host/modules/wiki/src/owner/selection_edit.rs] [VERIFY: runtime-host/modules/wiki/src/application/commands.rs] [VERIFY: src/pages/Wiki/components/SelectionAssistantPanel.tsx]

## Wiki 来源任务进度契约增量

既有 POST `/api/wiki/source-tasks` 与 `/source-task/cancel` 仍返回 200 `WikiSourceTasksReceipt`，输入、授权与路由不变。任务新增可空 `completed/total/stageStartedAtMs`；`progress` 为当前阶段真实计数比例，未知总数为 null，不再用固定阶段值冒充整任务百分比。阶段为 `parse/extract-images/commit/caption/analyze/generate/repair/review/write/index/embed` 及既有终态；write 计处理候选页，embed 计完成尝试，不等于成功写入/嵌入计数。导入保持任务身份，完成延至来源自身媒体、snapshot、embedding 尝试之后；整批排空 review 不属于单个来源进度。取消仍作用于既有来源任务与 token，已写入副作用不回滚。原 import strict 202、Call Log 安全 counts 和最终核验不变，进度不进入公共 job 或 Call Log 正文。[VERIFY: runtime-host/modules/wiki/src/domain/model.rs] [VERIFY: runtime-host/modules/wiki/src/api.rs] [VERIFY: runtime-host/modules/wiki/src/adapters/loopback/mod.rs] [VERIFY: runtime-host/modules/wiki/src/owner/actor.rs] [VERIFY: runtime-host/modules/wiki/src/owner/source_lifecycle.rs] [VERIFY: src/pages/Wiki/wiki-model.ts]

## 已裁决事项

- Electron `DirectRuntimeHost` 通过 stdio 长度帧写入一次 bootstrap，并等待 Rust private control ready；Renderer 不直接接触该 private control。
- private control command timeout 上限为 **120s**，frame 上限为 **1MiB**；wire 只承载 `{ name, input }` 私有命令 envelope，具体 command vocabulary 来自 installed module descriptors/private-control snapshot，不是 HTTP route 透传，也不是业务 command enum。
- Host-owned loopback transport 已收敛为一个 Rust loopback server；route registry 来自 installed `ModuleCatalog` descriptors，SSE/WS 是 route outcome，不是独立 Host-owned listener。legacy `/health`、`/dispatch`、`/lifecycle/*` compatibility module 已删除；OpenClaw gateway、Matcha app-server、Matcha MCP stdio 不属于此 server。
- Capability Catalog 与 Runtime Endpoint Directory 已由 Rust 投影 fixed OpenClaw/Matcha local peer surface；capability descriptors 来自 installed owner module providers，availability 可随 readiness 降级，不代表 owner cutover；capability list/describe 不进入 private control business command。
- Electron 主进程不再经 legacy child `/dispatch` 进入 Rust；产品请求走 signed loopback module routes，Host-private 状态走 private control。
- legacy dispatch envelope 的 `PAYLOAD_TOO_LARGE` / `INVALID_TRANSPORT_PAYLOAD` 只保留为历史测试/迁移证据，不是 Rust final-form active contract。
- Host private health/snapshot 与 Electron process-manager lifecycle 分层处理，不强行统一枚举。
- **旧 generic RuntimeJob public contract 已删除，不是待办：** 不存在 `runtimeHost.jobGet`、`runtime-job:*`、generic `RuntimeJob*` DTO 或 `job_compatibility`；文档中的这些名称只用于标识已删除项，禁止重新引入。
- **Toolchain final path 已冻结：** Setup 已退休；Renderer 进入主界面后 lazy 调 `prepareToolchain()`，Electron `POST /api/toolchain/uv/prepare` 经 `toolchainTransport.prepare()` 调 modules/toolchain 原 owner bounded queue，持久 accepted 后返回 202 `CallReceipt`；MainLayout warmup 只需接单，不等待安装终态。真实 prepare outcome 由 owner 写入 call-log typed detail，不等同 receipt；`GET /api/toolchain/uv/check` 仍经 `toolchainTransport.status()` 只投影 UV `{ installed }`。[VERIFY: runtime-host/modules/toolchain/src/api.rs:91-130] [VERIFY: runtime-host/modules/toolchain/src/adapters/loopback.rs:94-111] [VERIFY: electron/api/routes/toolchain.ts:16-35] [VERIFY: src/lib/toolchain.ts:1-7] [VERIFY: src/App.tsx:70-83]
- **ClawHub marketplace route 不变：** `POST /api/clawhub/search` 由 Rust external `ClawHubRegistryClient` 执行 registry HTTP search，不经 RuntimeDriver 或 OpenClaw Gateway；`POST /api/skills/clawhub/install` 仍经 Skills runtime ops，但底层执行 legacy ClawHub CLI + registry fallback。

## 当前迁移决定

- Renderer、Electron、preload 和页面 API **不因 Rust 移植任意改动**；本轮显式批准的 Calls 页面、查询/提示与具体 admit consumer 属于契约增量，不授权其他 API 重裁。
- Rust 内部 **不建立跨 owner 的通用执行 queue、registry 或 compatibility projection**；新增 `modules/call-log` 只持久化调用记录与 revision history，业务执行仍入原 owner queue。
- 已批准后台化由原八项扩展至 Provider discover、Connector probe/status/sessionStatus、Channel disconnect/logout、Cron create/update/delete（toggle→update）、Skills 配置/启停/批量/卸载/产物、Subagents 创建/更新/删除/配置/包安装/export/exportCloud、Team materialize/manual create/runDelete/delete、Wiki rescan/applyGeneratedPages/deleteSource/source-task.retry/source-task.resume、Runtime stop；这些公共长操作成功接单只返回 strict 202 `CallReceipt`，原 execution owner/queue 不迁入 CallLog。必要完整 payload 由具体模块有限、非消费 typed result 领取，不存入审计 detail；sealed cloud 包只走 Main 私有交接。Sessions 整块、team.runCreate 与条件候选不在此批；原 MCP/内部完成屏障保留 await。各模块接线与实际验证分开记录，详见 [async-projection.md](async-projection.md)。[VERIFY: runtime-host/modules/provider/src/api.rs] [VERIFY: runtime-host/modules/connectors/src/api.rs] [VERIFY: runtime-host/modules/skills/src/result.rs] [VERIFY: runtime-host/modules/subagents/src/application/results.rs] [VERIFY: runtime-host/modules/organization/src/call.rs] [VERIFY: runtime-host/modules/wiki/src/api.rs] [VERIFY: runtime-host/host/src/composition/peer/handle.rs]
- Main 六个长入口不迁入 Rust CallLog：完整 child restart 返回 restartId、读取同次状态；updater download 短返 accepted、沿原事件完成；Cloud package download/install preparation/agent upload/skill upload confirm 返回独立 operationId，通过 `/api/packages/operation-result` 领取闭合 typed result。包字节、授权 lease 与凭证不公开，native install/export 仍使用独立 CallReceipt。[VERIFY: electron/api/routes/runtime-host-process.ts] [VERIFY: electron/main/updater.ts] [VERIFY: electron/api/routes/packages.ts] [VERIFY: src/types/cloud-package-operation.ts]
- `platform::call` 字段、安全 detail、commit 后 `call.changed {callId, revision}` 与 original await/admit 分界见 [async-projection.md](async-projection.md)；当前真实覆盖与 PASS/FAIL/未测只维护于 [Call Log / Calls 唯一验收账](../architecture-knowledge/modules/call-log/dev.md#接线--验证-open)。[VERIFY: runtime-host/platform/src/call.rs:126-179] [VERIFY: runtime-host/modules/call-log/src/lib.rs:169-195]
- 新 Rust owner、crate、状态模型和切换顺序必须在本基线之上推导，不能从现有 `runtime-host-rust/` 目录反推契约。

## Session 本轮显式合同与收口

Session public identity 为 endpoint + 非空 agentId + sessionKey；view/delta 保留 epoch/seq/cursor，delta 携完整 identity 且顶层 key 一致，不含 routeKey。`itemsReplaced` 是一条明确 old IDs、surviving anchor 与 reconciled items 的原子展示变化，不重写旧 generic message/tool 匹配、不放宽现有预算。observe/release 使用既有 capability family 与 fixed signed routes，lease 是接收资源不是 native 权限；delta/resync 沿既有 Session SSE → Main identity 定向 IPC 链，native opaque cursor/generation/cut 不公开。[VERIFY: runtime-host/modules/sessions/src/ports.rs:62-142] [VERIFY: src/types/session/snapshot.ts:814-897] [VERIFY: electron/main/runtime-host-delivery/transport/sessions/observation.ts:9-76]

这是一轮已授权 Session 合同增量，不代表任意 API 重裁；实际 producer、七切片接线、main cargo/tsc 与禁区核验状态见 [Session / Chat Dev Notes](../architecture-knowledge/modules/session-chat/dev.md#当前收口状态--open)。旧测试验绿不作为本轮证据，live 未授权始终 OPEN，不能称实机完成。

## OpenClaw 问答本轮显式合同

普通 `ask_user` 待答事实来自 OpenClaw native question record，不从工具 running 或历史窗口派生。`openclaw.question` 的 typed list/resolve 输入绑定完整 SessionIdentity，只支持 OpenClaw local；请求 ID 使用原生值，不再按工具调用 hash 推导。秘密问题不进入普通问答 DTO，Matcha 暂不启用。`openclaw:questions-changed {}` 只是权威回读提示，不携带原始问题/答案，不改变 Session public DTO。Renderer 交互属于 composer，历史工具记录不承载表单；本轮真实验证状态见 Session / Chat dev。[VERIFY: src/types/openclaw-question.ts:3-41] [VERIFY: runtime-host/integrations/openclaw/src/session/ingest.rs:238-241]

## 完整性的边界

本基线已按所有进程边界和已注册 route 分类；它不把业务内部的每个 TS interface 再抄一遍。每个请求/响应的细粒度字段权威仍保留在对应 Renderer wrapper、route decoder 和 shared DTO 源码中，并由本目录给出入口和证据位置。

动态值如 `pid`、port、token、request ID、run ID、时间戳和 trace ID 在后续比对中必须归一化，不能作为字面 fixture 值冻结。

## OpenClaw Goal 显式合同增量

本轮批准目标创建、查看、编辑、暂停、恢复、完成、阻塞、清除及原生状态同步，仅 OpenClaw 启用。创建复用普通 send 的 `intent: {kind:'goalStart',issuedAtMs}`；管理使用 `session.goal` / `sessions.goal.update|clear`，输入固定完整 `sessionIdentity`、native `endpointSessionId`、`goalId`、`operationId` 与 `issuedAtMs`。编辑仅改 objective；其余 update 动作为 pause/resume/complete/block，可携 note。原生 Goal 是唯一 authority，receipt 的 succeeded/replayed 不等于当前 Goal 或 run 已终态。[VERIFY: src/types/session-goal.ts] [VERIFY: runtime-host/modules/sessions/src/domain/goal.rs] [VERIFY: docs/openclaw-source/docs/tools/goal.md]

`SessionView.goal` 与 `goalChanged` 区分 `known` 有值、`known` null、`unknown`、`unsupported`；native 状态保留 `active/paused/blocked/complete/budget_limited/usage_limited`，预算及使用量仅作只读事实，不提供预算设置。能力要求 live handshake 广告 `session-goal-start-v1`，endpoint/agent 的 `capabilities.supportsGoal` 不能静态宣告；同步复用同 socket 的 `sessions.subscribe` 与既有 ordered ingress，必须覆盖管理操作、模型自主 update 和 `chat.run.settled` 后预算状态，不以轮询补齐。不改发送图标，不新建 Host store、续轮队列或文字 fallback。[VERIFY: src/types/session/snapshot.ts] [VERIFY: runtime-host/integrations/openclaw/src/session/goal.rs] [VERIFY: docs/openclaw-source/packages/gateway-protocol/src/server-capabilities.ts] [VERIFY: docs/openclaw-source/src/gateway/server-methods/chat-send-agent-dispatch.ts]

公共契约与各端生产链已接线，endpoint/agent supportsGoal、同 socket subscribe/describe 和权威 GoalChanged 均有源码；main 五 crate 离线生产编译 PASS，但既有 tests 仍 FAIL、真实 app/Goal RPC/UI 未运行，不称全功能完成。PASS/FAIL/未运行事实维护于 [Session / Chat Goal 验证账](../architecture-knowledge/modules/session-chat/dev.md#2026-10-08-openclaw-goal--接线与验证)。[VERIFY: runtime-host/integrations/openclaw/src/gateway/client.rs] [VERIFY: runtime-host/integrations/openclaw/src/session/event_router.rs] [VERIFY: runtime-host/modules/runtime-directory/src/directory.rs]
