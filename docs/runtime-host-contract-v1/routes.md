# child business route inventory

## 分类说明

- `Renderer allowlisted`：Electron 接受 Renderer `hostapi:fetch` 并可到达该业务 path。
- `child direct`：child 注册，但未确认是 Renderer IPC public path；可能供 CLI、测试或内部直连使用。
- `LEGACY-REJECTED`：path 仍注册，返回明确 bad request；它是当前可观察行为。
- `main-owned`：Electron 在 child 前处理，见 [scope.md](scope.md)。

Renderer public entry 由 Electron [capabilities.ts](../../electron/api/routes/capabilities.ts)、[sessions.ts](../../electron/api/routes/sessions.ts)、[cron.ts](../../electron/api/routes/cron.ts)、[channels.ts](../../electron/api/routes/channels.ts)、[providers.ts](../../electron/api/routes/providers.ts)、[runtime-topology.ts](../../electron/api/routes/runtime-topology.ts) 等 route 维持；Rust child 的 Host-owned loopback 入口是 [host HTTP server](../../runtime-host/host/src/http/server.rs)，private control 在 [runtime-host/host/src/control/](../../runtime-host/host/src/control/) 中只处理 framed wire/ready/EOF/outcome/event loop。业务 handler/adapter 位于对应 owner module；loopback router 只消费 installed `ModuleCatalog` 派生的 route descriptors，不保留 compatibility/business special-case。legacy root compatibility module 已删除，不再注册 `GET /health`、`POST /dispatch`、`POST /lifecycle/restart` 或 `POST /lifecycle/stop`。`ModuleDescriptor.effects` 声明 effect ownership，Host 安装路径把 Foundation `ModuleScope` registrations 映射给 Platform catalog 校验 scoped registrations。team/fleet/session 等业务入口是 owner module descriptors，loopback listener 才是 Host transport extension。Platform loopback outcome 支持 Response/Stream/Upgrade，当前 Host 统一 loopback server 直接写回 session stream 与 fleet terminal upgrade outcome；统一 listener 自身作为 Host transport extension scope 管理。[VERIFY: runtime-host/platform/src/module.rs:141-204] [VERIFY: runtime-host/platform/src/module.rs:239-304] [VERIFY: runtime-host/platform/src/loopback.rs:152-218] [VERIFY: runtime-host/host/src/module_registry/install.rs] [VERIFY: runtime-host/host/src/http/router.rs] [VERIFY: runtime-host/modules/sessions/src/adapters/loopback/mod.rs:73-85] [VERIFY: runtime-host/host/src/http/server.rs:20-40] 旧 `runtime-host/composition/*.ts` route composition 已是历史来源，不是当前 active owner。

## A. transport and child operational surface

| Method | Path | Classification | Notes |
| --- | --- | --- | --- |
| private control | `host.health` | Electron child-private | replaces retired root `GET /health`; not Renderer API. |
| private control | `host.runtime.snapshot` | Electron child-private | host/private runtime snapshot; not Renderer API. |
| retired | `GET /health` | retired | legacy root compatibility removed. |
| retired | `POST /dispatch` | retired | legacy v1 envelope removed; product traffic uses signed loopback module routes. |
| retired | `POST /lifecycle/restart` | retired | child process restart is Electron `POST /api/runtime-host/restart`; peer lifecycle restart is `/api/runtime-control/lifecycle/restart`. |
| retired | `POST /lifecycle/stop` | retired | child process stop is `DirectRuntimeHost.stop()`/stdin EOF; peer lifecycle stop is `/api/runtime-control/lifecycle/stop`. |
| `GET` | `/api/runtime-host/health` | Renderer allowlisted | application health projection. |
| `GET` | `/api/runtime-host/transport-stats` | Renderer allowlisted | transport metrics projection. |
| `GET` | `/api/runtime-host/provider-env-map` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/host-bootstrap-settings` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/gateway-launch-plan` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/team-webhook-auth` | Renderer allowlisted | public auth projection. |
| `GET` | `/api/runtime-host/operations?owner=` | retired | generic operation query projection removed; async completion is exposed only through an owner/facade typed operation query/event. |
| `GET` | `/api/runtime-host/usage/recent` | Renderer allowlisted | current code registers via cron route module. |
| `GET` | `/api/workbench/bootstrap` | Renderer allowlisted | workbench bootstrap. |
| `GET` | `/api/plugins/runtime` / `/api/plugins/catalog` | Renderer allowlisted | plugin projections. |

Evidence: [capabilities.ts](../../electron/api/routes/capabilities.ts)、[cron.ts](../../electron/api/routes/cron.ts)、[runtime-host-delivery/control.ts](../../electron/main/runtime-host-delivery/control.ts)、[private_control.rs](../../runtime-host/host/src/module_registry/private_control.rs)、[http/router.rs](../../runtime-host/host/src/http/router.rs)。

## B. capability and topology surface

| Method | Path | Classification | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/capabilities/list` | Renderer allowlisted | capability discovery. |
| `POST` | `/api/capabilities/describe` | Renderer allowlisted | `{ id, scope }`. |
| `POST` | `/api/capabilities/execute` | Renderer allowlisted | main business mutation/operation protocol；business execution 走 Electron route → signed loopback module route → owner module/facade，不走 Rust private control；Toolchain prepare 不走 capability execute，改走 dedicated `/api/toolchain/uv/prepare`；Remote Fleet start/stop/sync 不走 capability execute，直接走 `/api/remote-fleet/*` → signed Rust `/api/fleet`；其他 accepted-only async operation 使用 owner/facade typed operation query/event。 |
| `GET` | `/api/runtime-adapters/list` | Renderer allowlisted | Runtime Endpoint Directory projection; current Rust surface is fixed local OpenClaw/Matcha peers, not dynamic registry. |
| `GET` | `/api/runtime-adapters/instances/list` | Renderer allowlisted | Runtime Endpoint Directory projection. |
| `GET` | `/api/runtime-connectors/list` | Renderer allowlisted | Runtime Endpoint Directory projection. |
| `GET` | `/api/runtime-endpoints/list` | Renderer allowlisted | Runtime Endpoint Directory projection; readiness controls availability and private PID/token/path/raw state are not exposed. |
| `POST` | `/api/runtime-connectors/connect` | `LEGACY-REJECTED` | must return legacy rejection. |
| `POST` | `/api/runtime-connectors/disconnect` | `LEGACY-REJECTED` | must return legacy rejection. |

Evidence: [capabilities.ts](../../electron/api/routes/capabilities.ts#L164-L283)、[route-boundary.ts](../../electron/api/route-boundary.ts#L201-L207)、[runtime-topology-routes.ts](../../runtime-host/api/routes/runtime-topology-routes.ts#L12-L51)。

## C. session legacy routes

Session mutation is now capability-first. The child nevertheless registers these legacy paths, so the rejection/read behavior remains part of the current contract.

| Method | Path | Classification | Current behavior |
| --- | --- | --- | --- |
| `POST` | `/api/sessions/list` | child direct | valid legacy read-only session list after endpoint validation；response `sessionIdentity` uses canonical `endpoint + agentId + sessionKey`, while `endpointSessionId` remains peer-local metadata. |
| `POST` | `/api/sessions/approvals` | child direct | valid legacy read-only approvals query after identity validation. |
| `POST` | `/api/sessions/permission` | internal signed transport | only reached from Electron `session.management` `sessions.permission.get/set`; request must bind `scope.identity == target.identity == input.sessionIdentity` and `input.sessionKey == identity.sessionKey`. |
| `POST` | `/api/sessions/window`, `/api/sessions/state` | `LEGACY-REJECTED` | explicitly rejected because they may hydrate session state; use capability execution. |
| `POST` | `/api/sessions/create`, `/load`, `/prompt`, `/patch`, `/rename`, `/delete`, `/archive`, `/unarchive`, `/status`, `/switch`, `/resume`, `/abort`, `/approval/resolve` | `LEGACY-REJECTED` | explicit rejection; use `/api/capabilities/execute` with an appropriate capability target. |

Electron’s public Renderer allowlist does not currently expose these legacy session paths; Renderer uses the capability contract in [renderer-api.md](renderer-api.md)。

Evidence: [session-routes.ts](../../runtime-host/api/routes/session-routes.ts#L36-L144)。

## D. OpenClaw / provider / settings / skills / channel reads

| Method | Path / pattern | Classification |
| --- | --- | --- |
| `GET` | `/api/openclaw/status`, `/ready`, `/dir`, `/config-dir`, `/subagent-templates`, `/workspace-dir`, `/task-workspace-dirs`, `/skills-dir`, `/cli-command`, `/tool-permission-mode` | Renderer allowlisted |
| `GET` | `/api/openclaw/subagent-templates/:templateId` | Renderer allowlisted |
| `PUT` | `/api/openclaw/tool-permission-mode` | Renderer allowlisted |
| `GET` | `/api/settings`, `/api/settings/:key` | Renderer allowlisted; public snapshot excludes secrets/native raw config |
| `POST` | `/api/settings/desired` | Renderer Settings public intent; Electron Main adapts to signed Rust desired transport |
| `GET` | `/api/provider-accounts`, `/api/provider-accounts/:id/has-api-key` | Renderer allowlisted |
| `GET` | `/api/provider-models`, `/api/provider-models/selectable`, `/api/provider-models/discover` | Renderer allowlisted |
| `GET` | `/api/capability-routing` | Renderer allowlisted |
| `GET` | `/api/channels/snapshot`, `/api/channels/pairing/:channelType` | Renderer allowlisted |
| `POST` | `/api/channels/config/validate`, `/api/channels/credentials/validate` | Renderer allowlisted |
| `GET` | `/api/skills/status`, `/api/skills/effective` | Renderer allowlisted |
| `POST` | `/api/skills/clawhub/install` | Renderer allowlisted; Rust Skills runtime ops executes legacy ClawHub CLI |
| `POST` | `/api/skills/readme` | child direct; not present in current Electron public allowlist |
| `POST` | `/api/clawhub/search` | Renderer allowlisted; Rust external ClawHub registry search |
| `GET` | `/api/subagents/*` | `LEGACY-REJECTED` (registered as POST routes) |

渠道适配按已授权的 ClawX 行为对齐，native 基线为 OpenClaw `2026.9.2`；当前 Renderer 入口以 `src/lib/channel-runtime.ts` 为准：

- `POST /api/channels/delete-config`（`channels.config.delete`）接收 `{ channel, accountId? }`：省略 `accountId` 删除全渠道；显式非空 `accountId` 仅删除该账户，不能将省略值补成 `default`。返回 `{ outcome: "confirmed" | "target_rejected" | "unknown" }`；transport 的 `accountId` 为 `Option<String>`。
- `POST /api/channels/config/read` 读取配置；`POST /api/channels/configure` 提交配置；`POST /api/channels/login` 编排登录。非 running 的 form/read 使用本地插件原生 channel schema；企微无此 schema，使用既有 ClawX/产品 `botId` / `secret` 表单 descriptor，其字段语义由实际插件 account reader 核验，不称 native schema。read 从 native config store 投影非敏感标量，不发 RPC；running 仍使用 Gateway schema/config，失败不回退离线。登录取得 native 账户后，以该账户执行配置 finalization，成功后才返回 connected。配置、绑定、登录材料仍由 Integration / native owner 持有，Host 不复制成 durable facts。
- `POST /api/channels/config/read` 成功返回 `{ success: true, values, agentId }`：`values` 仅含安全渠道字段，独立的 `agentId: string | null` 只表示当前渠道/账号明确的简单 route binding；无绑定或绑定冲突返回 `null`，不把 wildcard、channel-level、peer-specific 或 ACP binding 推断成账号绑定，也不推断 `main`。schema 无字段时仍读取绑定。Rust loopback 对应严格 `{ values, agentId }`，Electron 校验后转发；绑定事实仍由 OpenClaw 持有，不增加 UI 缓存或 Host store。
- `GET /api/channels/snapshot`：`runtime_running` 来自既有 supervisor。非 running 时通过 native config store 读取、零 RPC；微信账户读取 `openclaw-weixin/accounts.json` 索引，未登录保留已配置渠道项但不造 `default`。running 时读取 native 状态，RPC 失败不盲目回退本地。OpenClaw SQLite state 不等同于微信插件账户 JSON/index。

configure/delete 已接入 native config store：非 running 时锁内原子提交；running 时 `config.get` / `config.set` 使用 `baseHash`，文档相等为 `Noop`，已有同 owner binding 不重排。`MayHaveReached` 先只读 native store 确认，未确认才 RPC readback，不以本地重写兜底。登录 finalization 与普通 configure 均在同次配置事务内浅 merge：省略字段保留，提交的对象/数组整体替换，显式空串/null 原值覆盖而非删除；native 拒绝的值不绕过校验。仅精确识别 native `INVALID_REQUEST` / `config changed since last load; re-run config.get and retry` 为 CAS 冲突，最多三次提交，每次重新读取文档/baseHash 并应用原始变更；其他错误不重试。删除按全渠道/账户范围清理配置与 bindings，最后账户删除时清渠道；微信最后账户以插件索引判断，登录材料由微信 helper 清理。OpenClaw `2026.9.2` pairing 清理在 `state/openclaw.sqlite` 的 `channel_pairing_allow_entries` / `channel_pairing_requests` 两表内，按 `channel_key` 与可选 `account_id` 事务删除，不创建表、不混用插件旧 allowFrom 文件。

WhatsApp 删除在每次配置提交前按 native 账户继承/覆盖与 Gateway cwd 解析 `authDir`，构造 cleanup plan；提交确认后才清理。managed `credentials/whatsapp` 严格子目录可递归删除，legacy OAuth 根仅清 Baileys 文件；共享目录、外部路径、父根、symlink/reparse escape 与越界 OAuth override 在提交前拒绝。CAS 耗尽返回 `target_rejected`，提交后清理失败返回 `unknown`。离线表单仅投影有依据的标量字段，不以空表单表示成功；微信 `2.4.8` 的真正 channel schema 仅含 `replyProgressMessages`，不混用插件级配置 schema。插件未安装、来源歧义或 schema 不可读仍返回 `unknown`；当前本地 `2026.9.2` 安装包未包含 WhatsApp extension，未验证其离线表单。上述不表示所有 ClawX 边缘行为或真实登录/删除现场已验证。

当前实现依据：`runtime-host/modules/channels/src/adapters/loopback/delete.rs`、`runtime-host/modules/channels/src/owner/actor.rs`、`runtime-host/integrations/openclaw/src/surfaces/channels/adapter.rs`、`runtime-host/integrations/openclaw/src/surfaces/channels/gateway/status.rs` 与 `surfaces/channels/gateway/config.rs`、`surfaces/channels/gateway/config/{mutation,credentials}.rs`。

`/api/provider-models/discover` response 只保留 public model option 字段：`modelId`、`capabilities`、`contextWindow`、`maxTokens`、`timeoutMs`、`aspectRatio`、`resolution`、`quality`；不返回 `source`、`checkedAt`、`apiKey`、`baseUrl`、`headers`、`runtimeModelRef`、`accountId`。

Legacy rejections within this family:

- `POST /api/provider-accounts/validate`; `GET /api/provider-accounts/:id/api-key`; `GET /api/provider-accounts/:id`;
- `GET /api/provider-models/:id`;
- `GET /api/channels/config/:channelType`;
- all listed subagent routes.

Evidence: [openclaw-routes.ts](../../runtime-host/api/routes/openclaw-routes.ts#L35-L61)、[settings-routes.ts](../../runtime-host/api/routes/settings-routes.ts#L17-L33)、[provider-routes.ts](../../runtime-host/api/routes/provider-routes.ts#L20-L40)、[provider-models-routes.ts](../../runtime-host/api/routes/provider-models-routes.ts#L16-L34)、[channel-routes.ts](../../runtime-host/api/routes/channel-routes.ts#L29-L62)、[skills-routes.ts](../../runtime-host/api/routes/skills-routes.ts#L13-L17)、[subagent-routes.ts](../../runtime-host/api/routes/subagent-routes.ts#L7-L23)。

## E. operations: platform, security, cron, files

| Method | Path | Classification |
| --- | --- | --- |
| `GET` | `/api/platform/runtime/health`, `/api/platform/tools` | Renderer allowlisted |
| `POST` | `/api/diagnostics/archive`, `/api/diagnostics/archive/download` | Renderer allowlisted; main-owned diagnostics archive receipt/download surface |
| `POST` | `/api/platform/tools/query` | child direct; not in current public allowlist |
| `GET` | `/api/toolchain/uv/check` | Renderer allowlisted; Electron projects `toolchainTransport.status()` from modules/toolchain owner loopback to `{ installed }` |
| `POST` | `/api/toolchain/uv/prepare` | Renderer allowlisted; Electron calls `toolchainTransport.prepare()` and returns public outcome |
| `GET` | `/api/security`, `/api/security/destructive-rule-catalog`, `/api/security/audit` | Renderer allowlisted |
| `GET` | `/api/cron/jobs`, `/api/cron/session-history` | Renderer allowlisted |
| `POST` | `/api/cron/jobs/{create,update,delete,toggle}` | Renderer allowlisted; fixed Cron capability envelope，成功接单仅 strict 202 CallReceipt |
| `POST` | `/api/cron/results` | Renderer allowlisted；`{callId,command,jobId?}` 绑定本次 create/update/delete（toggle→update），短读 exact job / `{removed}` |
| `POST` | `/api/files/{read-text,read-binary,stat,list-dir,thumbnails,write-text,stage-paths,stage-buffer,thumbnail}` | `LEGACY-REJECTED`; use capability execution |

Evidence: [route-boundary.ts](../../electron/api/route-boundary.ts#L172-L173)、[toolchain.ts](../../electron/api/routes/toolchain.ts#L8-L88)、[security-routes.ts](../../runtime-host/api/routes/security-routes.ts#L16-L20)、[file-routes.ts](../../runtime-host/api/routes/file-routes.ts#L18-L38)。

### Cron model 字段

`GET /api/cron/jobs` 的 `jobs[]` 与 create/update/toggle 完成后从 `/api/cron/results` 领取的 `CronJob` 使用 `model?: string`：有覆盖时返回非空字符串，无覆盖时省略字段，不返回 `null`，也不填入解析后的默认模型。

create/update 的 capability envelope `input.model` 使用 `model?: string | null`：

| 操作 | 省略 / `undefined` | `null` | 非空字符串 |
| --- | --- | --- | --- |
| `cron.create` | 不设覆盖，跟随 Agent 默认模型策略 | 同省略 | 设置任务模型覆盖 |
| `cron.update` | 保留现有覆盖 | 清除覆盖，恢复 Agent 默认模型策略 | 设置任务模型覆盖 |

Renderer store 的 create 白名单保留 `model`，update 沿现有输入透传；JSON 序列化省略 `undefined`、保留 `null`。Electron 只校验和转发公开 DTO，不解析默认模型；OpenClaw 仍是 Cron 原生事实与模型执行策略的 owner。

Evidence: [Cron types](../../src/types/cron.ts)、[Cron store](../../src/stores/cron.ts)、[Cron route](../../electron/api/routes/cron.ts)、[Cron transport](../../electron/main/runtime-host-delivery/transport/cron.ts)。

## F. external connector and Remote Fleet

### External connector

| Method | Path | Classification |
| --- | --- | --- |
| `GET` | `/api/external-connectors`, `/mcp-server-programs`, `/status` | Renderer allowlisted |
| `POST` | `/probe`, `/session-status`, `/get`, `/upsert`, `/remove` | Renderer allowlisted；`/session-status` 请求体为 `sessionIdentity` + 可选 `endpointSessionId`，`endpointSessionId` 是 peer runtime session metadata，不参与 Host identity。 |

Evidence: [external-connectors.ts](../../electron/api/routes/external-connectors.ts)、[external.ts](../../electron/main/runtime-host-delivery/transport/connectors/external.ts)、[connectors loopback adapter](../../runtime-host/modules/connectors/src/adapters/loopback/external.rs)。

### Remote Fleet

| Method | Paths | Classification |
| --- | --- | --- |
| `GET` | `/api/remote-fleet/snapshot`, `/metrics`, `/terminal/sessions`, `/list-commands`, `/list-audit-events` | Renderer allowlisted |
| `POST` | register-connection/delete-connection/register-environment/delete-environment; write credential; remove node; probe/probe-connection; install/revoke agent; deploy/delete environment; drain/retire endpoint; start/stop runtime; sync capabilities; terminal open/reconnect/close | Renderer allowlisted; legacy node registration `/api/remote-fleet/register` 已关闭，不是 public active route；node dispatch receipts (`accepted/completed/rejected/outcomeUnknown`) 与 owner-local begin/terminal receipts 已投影为现有 renderer `command` payload |
| `WS` | Electron public `/api/remote-fleet/terminal/stream` → unified Rust loopback server Fleet terminal route | Renderer allowlisted WebSocket；route upgrade outcome, not an independent Host-owned listener |
| `POST` | `/api/remote-fleet/runtime-agent/ingress` | external RemoteAgent ingress, not Renderer IPC；Electron API server ingress proxy → Rust Fleet transport → Rust handler → FleetHandle core path 已接入 |

Current route/transport evidence: [fleet.ts](../../electron/api/routes/fleet.ts)、[Electron API server](../../electron/api/server.ts)、[fleet transport](../../electron/main/runtime-host-delivery/transport/fleet.ts)、[Rust fleet module route](../../runtime-host/modules/fleet/src/adapters/loopback/mod.rs)、[host HTTP server](../../runtime-host/host/src/http/server.rs)。

FleetOwner 当前仍保留单 Fleet durable authority；owner-local keyed lanes 已通过 Rust 侧证据，覆盖 terminal provider open、dispatch、connection/environment/resource lifecycle；Remote Fleet mutation payload projection、live recovery、startup Pending replay scanner、query refresh、terminal provider failure owner-local settlement 与 focused tests 已通过；不拆 per-target/per-resource owner。focused fault/backpressure、process restart/terminal replay、package/Windows、SSH bootstrap gates 未全闭合。

## G. gateway routes: distinguish same-name main ownership

child registers:

```text
GET  /api/gateway/status
POST /api/gateway/recover
POST /api/gateway/ready                     LEGACY-REJECTED
POST /api/gateway/control-ui/auto-approve   LEGACY-REJECTED
```

But Electron marks `/api/gateway/status` and several gateway lifecycle routes as main-owned. Renderer Host API reaches Electron’s gateway manager for those main-owned paths, not necessarily the child registration. Do not use child route existence alone to infer public client behavior.

Evidence: [gateway-routes.ts](../../runtime-host/api/routes/gateway-routes.ts#L14-L21)、[route-boundary.ts](../../electron/api/route-boundary.ts#L13-L38)。

## Route response rule

Rust module route handlers return `platform::loopback::RouteOutcome`; the Host HTTP substrate writes Response/Stream/Upgrade directly. There is no legacy `/dispatch` outer envelope on the Rust final path. Public responses must remain redacted; owner module adapters own DTO decode and projection. See [transport.md](transport.md)。
