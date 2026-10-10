# Renderer API 与 capability contract

## 1. Renderer 到 Host API 的固定入口

Renderer 的统一入口是 `hostApiFetch()`：

```ts
hostApiFetch(path, {
  method,
  headers,
  body,
  timeoutMs,
  signal,
})
```

它会生成 request ID，经 `hostapi:fetch` 发送给 Electron；`AbortSignal` 触发时另发 `hostapi:abort`。Renderer 不接触 Host API bearer token 或 child dispatch token。来源：[host-api.ts](../../src/lib/host-api.ts#L274-L332)、[hostapi-proxy-ipc.ts](../../electron/main/ipc/hostapi-proxy-ipc.ts#L35-L132)。

固定 IPC contract：

```text
hostapi:fetch({ requestId?, path?, method?, headers?, body?, timeoutMs? })
hostapi:abort({ requestId? })
hostapi:base-url()
```

来源：[ipc-contract.ts](../../electron/preload/ipc-contract.ts#L1-L78)、[hostapi-proxy-ipc.ts](../../electron/main/ipc/hostapi-proxy-ipc.ts#L8-L22)。

## 2. capability 是主要业务入口

Renderer 的 session、workspace、provider、channel、skill、plugin、cron 等大部分 mutation 通过：

```http
POST /api/capabilities/execute
```

```json
{
  "id": "session.prompt",
  "operationId": "sessions.prompt",
  "scope": { "kind": "..." },
  "target": { "kind": "..." },
  "input": {}
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `id` | 非空 capability ID。 |
| `operationId` | 非空 operation ID。 |
| `scope` | 必须为现有 `RuntimeScope`；不接受旧 `runtimeAddress`。 |
| `target` | 可为 `null`，否则必须是现有 `CapabilityTarget`。 |
| `input` | operation-specific JSON；可为 `undefined`。 |

来源：[capability-routes.ts](../../runtime-host/api/routes/capability-routes.ts#L17-L91)、[host-api.ts](../../src/lib/host-api.ts#L610-L643)。

相关 discovery API：

| Method | Path | 返回 |
| --- | --- | --- |
| `GET` | `/api/capabilities/list` | `{ capabilities }` |
| `POST` | `/api/capabilities/describe` | `{ capability }`，body `{ id, scope }` |
| `POST` | `/api/capabilities/execute` | operation-specific data / application response |

## 3. 已确认 Renderer capability families

此表记录 Renderer 已引用的 capability ID 与 operation family；完整 descriptor/target schema 以 runtime capability descriptor 和相应 wrapper 为准。

| capability ID | Renderer operation / 用途 | 关键 wrapper / evidence |
| --- | --- | --- |
| `workspace.file` | `files.readText`、`writeText`、`stagePaths`、`stageBuffer`、`thumbnail`、`readBinary`、`stat`、`listDir` | [host-api.ts](../../src/lib/host-api.ts#L424-L512) |
| `session.management` | `sessions.list`、`window`、`delete`、`rename`、`archive`、`unarchive`、`updateStatus`、`switch`、`resume`、`state`、`sessions.permission.get/set` | [host-api.ts](../../src/lib/host-api.ts#L546-L555)、[host-api.ts](../../src/lib/host-api.ts#L822-L1168) |
| `session.prompt` | `sessions.create`、`load`、`abort`、`prompt`、`sendWithMedia` | [host-api.ts](../../src/lib/host-api.ts#L840-L855)、[host-api.ts](../../src/lib/host-api.ts#L924-L1065) |
| `session.approval` | `approvals.list`、`approvals.resolve` | [host-api.ts](../../src/lib/host-api.ts#L1000-L1025) |
| `session.modelSelection` | `sessions.patchModel`；成功响应返回结构化 `modelState` | [host-api.ts](../../src/lib/host-api.ts#L1421-L1448) |
| `provider.routing` | provider routing capability projection；provider accounts/models 仍有 direct Host API reads/writes/discovery | [capability-routing.ts](../../src/lib/capability-routing.ts)、[provider-accounts.ts](../../src/lib/provider-accounts.ts)、[provider-models.ts](../../src/lib/provider-models.ts)、[provider-model-catalog.ts](../../src/lib/provider-model-catalog.ts) |
| `integration.channel` | channel integration operations | [channel-runtime.ts](../../src/lib/channel-runtime.ts) |
| `skill.management` | skill operations / import / gateway sync | [skills.ts](../../src/stores/skills.ts)、[Skills/index.tsx](../../src/pages/Skills/index.tsx) |
| `plugin.runtime` | plugin runtime operations | [plugins-store.ts](../../src/stores/plugins-store.ts)、[plugin-manager-client.ts](../../src/services/openclaw/plugin-manager-client.ts) |
| `scheduler.cron` | cron create/update/delete/toggle/trigger | [cron.ts](../../src/stores/cron.ts) |
| `settings.runtime` | 已从 Renderer capability envelope 退休；Settings 使用扁平 intent `GET /api/settings` + `POST /api/settings/desired`，由 Electron Main 适配到 Rust desired transport | [settings-runtime.ts](../../src/lib/settings-runtime.ts)、[settings-desired.ts](../../electron/api/routes/settings-desired.ts) |
| `security.runtime` | security operations | [security-runtime.ts](../../src/lib/security-runtime.ts) |
| `subagent.management` / `subagent.skills` / `subagent.tools` | agent and subagent configuration | [subagents.ts](../../src/stores/subagents.ts)、[agent-skill-config.ts](../../src/stores/agent-skill-config.ts)、[agent-tool-config.ts](../../src/stores/agent-tool-config.ts) |
| `team.runtime` | team package/run/graph/trigger/role chat/approval/cancel/delete operations；Rust Organization module path 已解码为 Organization owner command；TeamRun scheduler/watch/reconciliation 由 Organization coordinator 承接；unsupported legacy projection返回 unavailable/unknown/rejected，不伪造成功 | [team-runtime-client.ts](../../src/services/openclaw/team-runtime-client.ts)、[team_runtime_control.rs](../../runtime-host/modules/organization/src/application/team_runtime_control.rs)、[command.rs](../../runtime-host/modules/organization/src/owner/command.rs)、[coordinator.rs](../../runtime-host/modules/organization/src/owner/coordinator.rs) |

Provider model discovery/import 的 Renderer/Electron public DTO 不扩展：discovery response 仍只允许 `modelId`、`capabilities`、`contextWindow`、`maxTokens`、`timeoutMs`、`aspectRatio`、`resolution`、`quality`；`source`、`checkedAt`、`apiKey`、`baseUrl`、`headers`、`runtimeModelRef`、`accountId` 等 reference/private 字段不得暴露。

`OPEN`: 这不是对每个 operation input/output 的替代类型定义；对应 Renderer wrapper 和 runtime capability descriptor 是字段级权威。后续 Rust cutover 应以 operation family 为单元采集实际 request/response fixture。

### ExistingTeam 工作流设计增量

既有 `team.runtime` 提供以下设计与统一启动 operation；`team.designRun`、`team.designContinue` 和 proposal confirm/continue/cancel 已删除。target 必须 exact `{kind:'team',teamId}`，与 input.teamId 相等；input 必须具有下表全部字段，不能缺省或附加字段，不能仅在 target 携带 teamId。不新建 capability、Team/roles 或执行 queue。[VERIFY: src/services/openclaw/team-runtime-client.ts:946-1008] [VERIFY: electron/api/routes/team-runtime-capability.ts:109-133] [VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:485-512] [VERIFY: runtime-host/modules/organization/src/application/design.rs:50-125]

| operation | exact input | 200 成功结果 |
| --- | --- | --- |
| `team.designStart` | `{teamId,runId,idempotencyKey}` | `{success:true,outcome:'designing'}` |
| `team.runStart` | `{teamId,runId,designEpoch:null|string,expectedGraphVersion,idempotencyKey}` | `{success:true,outcome:'started'}` |
| `team.designExit` | `{teamId,runId,designEpoch}` | `{success:true,outcome:'intake'}` |
| `team.designSnapshot` | `{teamId,runId}` | exact-run `TeamDesignSnapshot` |
| `team.designGraphPatch` | `{teamId,runId,designEpoch,expectedGraphVersion,commandId,idempotencyKey,operations}` | 更新后的同 run `TeamDesignSnapshot` |

启动门禁只有 `Intake / Designing / Started`，讨论与设计统一调用 `team.runStart`，不等待模型控制块或 proposal。store 冻结同 exact-run snapshot 的 epoch/version；Intake 必须显式传 `designEpoch:null`，Designing 必须传当前 epoch。后端独立 `RunStart` command 进入 `store.start_run`，在原 WriterLock 内刷新事实，核 team/run、Active lifecycle、阶段/epoch、definition hash 和完整图，一次提交 Started。完整图要求 Start/End、Work/Review 正文及现有 role/sessionRef binding、每个节点的非 Rework 起止路径；校验失败保持原阶段。新提交沿原 `RunStarted` wake 唤醒 scheduler；已 Started 的同 team/run 请求返回 started，不再次提交或唤醒，也不重验 epoch/version。idempotencyKey 仍严格校验 opaque 格式，幂等来自 gate，不新增 key 账本。[VERIFY: src/stores/teams.ts:1040-1053] [VERIFY: runtime-host/modules/organization/src/application/team_runtime.rs:485-512] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:336-379] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs:588-604] [VERIFY: runtime-host/modules/organization/src/application/design.rs]

snapshot 固定 `{success,teamId,runId,startGate,graphVersion,designEpoch,graph,roles}`；gate 为 `{status:'intake'|'started'}` 或 `{status:'designing',designEpoch,graphVersion}`，没有 proposal 字段。版本为 64 lowercase hex 的 definition codec SHA256，不含 layout。designExit 匹配 epoch 后回 Intake、清设计授权，保留 graph/角色/run；Intake 重放不提交，Started 或设计态错 epoch 拒绝。动作成功或失败均回读同一 exact run，错误保持可见；未知提交不能承诺未落盘。`team:changed {}` 只提示回读。旧 codec tag 1 消费三项 proposal 字段后读为 Intake；tag 4 消费旧设计待确认字段后读为 Designing，保留 epoch、清 generation。新写仅用 tag 0/2/3，不恢复活动待确认态。[VERIFY: src/types/team-design.ts:81-104] [VERIFY: src/types/team-design.ts:156-164] [VERIFY: src/stores/teams.ts:264-311] [VERIFY: runtime-host/modules/organization/src/application/design.rs:329-338] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:201-252] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1648-1663] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:2559-2586]

Chat 的 Intake 显示“开始设计 / 启动”，Designing 显示查看图标签与“返回讨论 / 启动”，两态调用同一 store `startRun`；请求期间的“启动中”只是瞬时 UI 状态，不是 durable gate。发送、审批、send gate、snapshot loading/mutation 阻塞写动作；Started 不再显示启动前控制，普通聊天继续，后端不再注入讨论或设计 prompt。TeamChat 的 proposal 卡片与三选交互已删除。此处只记录源码契约，不代表部署、并发实测或真实模型/native 端到端验收。[VERIFY: src/pages/Chat/ChatInput.tsx:1386-1436] [VERIFY: src/pages/Chat/index.tsx:869-884] [VERIFY: src/pages/Chat/index.tsx:1612-1626] [VERIFY: src/pages/Teams/TeamChat.tsx] [VERIFY: runtime-host/modules/organization/src/application/start_gate_control.rs]

### TeamRun 运行中任务正文与 Renderer 边界

运行中读写复用 MCP `team_graph_context` / `team_graph_patch`，不是新增 Renderer operation；上表设计/启动 input 与 `TeamDesignSnapshot` 不扩展 execution authority。Host 仅在节点发送的局部 message 追加 `<team_run_authority>`，签名绑定 team/run/delivery/nodeExecutionId；私有 MCP route 验证后剥离 token，只将 typed scope 交给 Organization。`team-mcp-local` 仍只是本机 transport principal，不证明 native caller/role 身份；签名私钥不投影到 discovery 或 public DTO，不新增 token DTO/ledger，authority 不回写 canonical graph、Activity 或 delivery prompt。注入后的发送正文可进入 native transcript，不能据此承诺 Renderer/history 永远不可见。[VERIFY: runtime-host/host/src/composition/host/ports/organization.rs:368-393] [VERIFY: runtime-host/host/src/team_mcp/authority.rs] [VERIFY: runtime-host/host/src/team_mcp/route.rs:95-136] [VERIFY: runtime-host/modules/organization/src/adapters/mcp/tools.rs]

运行期读写与画布仍共享 Organization canonical graph；MCP 只改 work/review prompt，不扩 Renderer 图编辑操作。patch 不驱动调度，已有 Activity/同次 retry 保留原快照，新 Activity/rework 消费新正文；节点 completion 的在线 `<team_message>` 仅接受 summary/decision，仍由原 scheduler 推进。完整 MCP 输入与结果见 [Team MCP 契约](README.md#team-mcp-同-owner-契约增量)。[VERIFY: runtime-host/modules/organization/src/store/runtime_graph.rs] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs:642-661] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:2023-2041] [VERIFY: runtime-host/modules/organization/src/run/delivery/model.rs:405-443]

### TeamSkill dependencyPlan 响应

`team.dependencyPlan` 保持原 packagePath 请求与 Rust 响应：`{status:'available',plan:{selectionId,packageName,packageVersion,items,canProceed}} | {status:'invalid'} | {status:'unavailable'}`。available 的 item 为 `{kind,name,required,purpose,status,severity,installable}`；Renderer 必须先判 status 再读取 `.plan`，不能当旧平铺 plan 使用，也不要求未返回的 sourcePath/missing* 数组。这里只适配现有服务契约，不重裁协议或 owner。[VERIFY: runtime-host/modules/organization/src/application/team_runtime_control.rs:696-745] [VERIFY: src/services/openclaw/team-runtime-client.ts:142-152] [VERIFY: src/services/openclaw/team-runtime-client.ts:801-808] [VERIFY: src/services/openclaw/team-runtime-client.ts:1283-1306] [VERIFY: src/pages/Teams/index.tsx:314-348]

### Provider account 认证契约

`ProviderAccountAuthMode` 新增 `Token`、`CliReuse`，wire 分别为 `token`、`cliReuse`；其余值仍为 `apiKey`、`oauthBrowser`、`oauthDevice`、`local`。登录交互方式不等于返回的凭据类型：

| 入口 | 私密凭据 / 保存的 account `authMode` | OpenClaw native projection |
| --- | --- | --- |
| OpenRouter 浏览器登录 | ApiKey / `apiKey` | `api_key` profile |
| GitHub Copilot 设备登录 | Token / `token` | `token` profile |
| OpenAI 浏览器 / 设备登录 | OAuth / `oauthBrowser` 或 `oauthDevice` | `oauth` profile |
| Anthropic setup-token | Token / `token` | native `token` profile，不冒充 API key 或 OAuth |
| Anthropic CLI 复用 | 无复制凭据 / `cliReuse` | native `anthropic` provider，`agentRuntime: { "id": "claude-cli" }` |

`providers:storeAccount` 的 `apiKey` / `token` 仅交给 Main 私密入口；Host account 与 public response 不携带 secret。`cliReuse` 仅用于 Anthropic chat account，既不复制 CLI secret，也不保存 credential reference；`token` 用于 Anthropic / GitHub Copilot chat account。品牌和套餐只表达为现有 account 的 provider / endpoint，不新增 plan owner。

Native 模型发现需要 OpenClaw Gateway 运行，离线返回 `Unavailable`；Host 按 native provider 筛选模型，Zen/Go 的逐模型协议由 native catalog 独占。此处记录契约，不宣称真实登录或 live 模型发现已验证。私密存储链见 [layered-architecture.md](../architecture/layered-architecture.md#63-integration-独占-peer-specific-private-semantics)。来源：[provider account model](../../runtime-host/modules/provider/src/domain/account.rs)、[provider accounts loopback](../../runtime-host/modules/provider/src/adapters/loopback/accounts.rs)、[provider-private-auth.ts](../../electron/main/ipc/provider-private-auth.ts)、[provider_models/mod.rs](../../runtime-host/integrations/openclaw/src/native_config/provider_models/mod.rs)。

## 4. session prompt 的关键兼容语义

`hostSessionPrompt()` 按 `media` 是否非空选择 operation：

```text
无 media → sessions.prompt
有 media → sessions.sendWithMedia
```

请求语义包含：

- `sessionKey`；
- 可选 `endpointSessionId`；
- `sessionIdentity`；
- `message`；
- 可选 `idempotencyKey`；
- 可选 `deliver`；
- media 的 `filePath`、`mimeType?`、`fileName?`、`fileSize?`、`preview?`。

`sessionIdentity` 是 `endpoint + agentId + sessionKey`；`endpointSessionId` 只是 peer runtime 本地 session id，不参与 Host 侧 identity。

session prompt timeout 是 `10s`，abort `5s`，model patch `15s`。来源：[host-api.ts](../../src/lib/host-api.ts#L33-L47)、[host-api.ts](../../src/lib/host-api.ts#L985-L1065)。

Session catalog/view 的模型事实使用 `modelState`，不再暴露裸 `model` 作为 public session state：`selected` 是用户/会话选择并作为 Chat picker 显示权威，`active` 只表达运行中 fallback 事实，`overrideSource` 为 `user | auto`，`selectionId` 是可选 catalog selection id；`sessions.patchModel` 输入字段仍是 `modelSelectionId`，成功响应必须返回 `{ outcome: "succeeded", modelState }`，Renderer 会先用返回值更新当前 session meta 再异步刷新 catalog。来源：[model.rs](../../runtime-host/modules/sessions/src/domain/model.rs#L106-L132)、[host-api.ts](../../src/lib/host-api.ts#L1421-L1448)、[Chat/index.tsx](../../src/pages/Chat/index.tsx#L1082-L1088)、[Chat/index.tsx](../../src/pages/Chat/index.tsx#L1267-L1281)。

Chat transport 进一步固定：调用会传 `deliver: false`、保持 idempotency key，并把空 message + attachment 转为 fallback prompt。来源：[send-transport.ts](../../src/stores/chat/send-transport.ts)。

## 5. Renderer 直接使用的非-capability Host API

| Method | Path | 现有 Renderer wrapper / consumer | child / main status |
| --- | --- | --- | --- |
| `GET` | `/api/openclaw/{status,ready,dir,config-dir,subagent-templates,workspace-dir,task-workspace-dirs,skills-dir,cli-command,tool-permission-mode}` | [host-api.ts](../../src/lib/host-api.ts#L358-L409)；`tool-permission-mode` 现无 Renderer wrapper | child business route |
| `PUT` | `/api/openclaw/tool-permission-mode` | 现无 Renderer wrapper；保留为旧 public route contract | child business route |
| `GET` | `/api/toolchain/uv/check` | [host-api.ts](../../src/lib/host-api.ts#L406-L409) | Electron calls `toolchainTransport.status()` and returns only `{ installed }` |
| `POST` | `/api/toolchain/uv/prepare` | [host-api.ts](../../src/lib/host-api.ts#L411-L416) | Electron calls `toolchainTransport.prepare()` and returns only public outcome |
| `GET` | `/api/runtime-{adapters,connectors,endpoints}/...` | [host-api.ts](../../src/lib/host-api.ts#L558-L608) | child topology projection |
| `POST` | `/api/runtime-connectors/{connect,disconnect}` | [host-api.ts](../../src/lib/host-api.ts#L578-L598) | `LEGACY-REJECTED` by child; Renderer wrapper exists, so replacement must preserve observed rejection unless API migration is separately approved. |
| `POST` | `/api/gateway/stop` | [gateway.ts](../../src/stores/gateway.ts#L355) | Electron main-owned, not child |

The Electron public allowlist is authoritative for which Renderer `hostapi:fetch` requests are accepted: [route-boundary.ts](../../electron/api/route-boundary.ts#L190-L217)。

## 6. Response and error behavior Renderer relies on

Renderer proxy decoder:

- IPC success is `{ ok:true, data:{status, ok, json?, text?} }`;
- non-2xx `status` or `ok:false` causes an error;
- server `{ error: string }`、`{ error:{message} }` 或 `{ message }` is converted into message;
- `204` returns `undefined`;
- JSON wins over text.

来源：[host-api-transport-contract.ts](../../src/lib/host-api-transport-contract.ts#L1-L128)。

因此 Rust 不能因为内部错误模型变化而改变已返回到 Host API 的 JSON error shape、状态码或 `null`/field omission 行为。
