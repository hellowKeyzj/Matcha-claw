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

既有 `team.runtime` 增加五个 operation，不新建 capability、Team/roles 或执行 queue；请求沿原 team target，精确指定 runId。target 必须 exact `{kind:'team',teamId}`，与 input.teamId 相等；input 必须具有下表全部字段，不能缺省或附加字段，不能仅在 target 携带 teamId。[VERIFY: src/services/openclaw/team-runtime-client.ts:957-1008] [VERIFY: electron/api/routes/team-runtime-capability.ts:112-133] [VERIFY: runtime-host/modules/organization/src/capability.rs:45-49] [VERIFY: runtime-host/modules/organization/src/application/design.rs:65-98]

| operation | exact input | 200 结果 |
| --- | --- | --- |
| `team.designStart` | `{teamId,runId,idempotencyKey}` | `{success:true,outcome:'designing'}` |
| `team.designContinue` | `{teamId,runId,proposalId,idempotencyKey}` | 同上 |
| `team.designExit` | `{teamId,runId,designEpoch}` | `{success:true,outcome:'intake'}` |
| `team.designSnapshot` | `{teamId,runId}` | exact-run `TeamDesignSnapshot` |
| `team.designGraphPatch` | teamId、runId、designEpoch、expectedGraphVersion、commandId、idempotencyKey、operations | 更新后的同 run `TeamDesignSnapshot` |

snapshot 固定 `{success,teamId,runId,startGate,graphVersion,designEpoch,graph,roles}`，版本为 64 lowercase hex 的 definition codec SHA256，不含 layout。确认与继续设计仍核当前 proposalId；返回讨论统一调用 designExit，匹配设计 epoch 后回原 Intake，清设计授权但保留 graph/角色/run；Intake 可重放且不提交新事实、不清新讨论 generation，Started、普通 ProposalPending、设计态错 epoch 拒绝。两前端回读同一 exact run；事件 `team:changed {}` 不承载图或 proposal 数据。此处记录源码契约，不宣称实际模型/native/UI 验收通过。[VERIFY: src/types/team-design.ts:108-145] [VERIFY: src/stores/teams.ts:1052-1071] [VERIFY: runtime-host/modules/organization/src/application/design.rs:150-156] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:370-381] [VERIFY: runtime-host/modules/organization/src/store/durable.rs:380-404] [VERIFY: runtime-host/modules/organization/src/owner/actor.rs:1721-1739] [VERIFY: runtime-host/modules/organization/src/store/codec.rs:1236-1241]

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
