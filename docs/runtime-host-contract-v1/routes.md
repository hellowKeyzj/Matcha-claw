# child business route inventory

## 分类说明

- `Renderer allowlisted`：Electron 接受 Renderer `hostapi:fetch` 并可到达该业务 path。
- `child direct`：child 注册，但未确认是 Renderer IPC public path；可能供 CLI、测试或内部直连使用。
- `LEGACY-REJECTED`：path 仍注册，返回明确 bad request；它是当前可观察行为。
- `main-owned`：Electron 在 child 前处理，见 [scope.md](scope.md)。

Renderer public entry 由 Electron [capabilities.ts](../../electron/api/routes/capabilities.ts)、[sessions.ts](../../electron/api/routes/sessions.ts)、[cron.ts](../../electron/api/routes/cron.ts)、[channels.ts](../../electron/api/routes/channels.ts)、[providers.ts](../../electron/api/routes/providers.ts)、[runtime-topology.ts](../../electron/api/routes/runtime-topology.ts) 等 route 维持；Rust child 的 fixed loopback/control transports 在 [runtime-host/host/src/transport/](../../runtime-host/host/src/transport/) 与 [runtime-host/host/src/control/](../../runtime-host/host/src/control/) 中实现。旧 `runtime-host/composition/*.ts` route composition 已是历史来源，不是当前 active owner。

## A. transport and child operational surface

| Method | Path | Classification | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | child direct | root child health; outside `/dispatch`. |
| `POST` | `/dispatch` | child direct | v1 envelope entrypoint. |
| `POST` | `/lifecycle/restart` | child direct | internal child lifecycle restart. |
| `POST` | `/lifecycle/stop` | child direct | child stop. |
| `GET` | `/api/runtime-host/health` | Renderer allowlisted | application health projection. |
| `GET` | `/api/runtime-host/transport-stats` | Renderer allowlisted | dispatch metrics projection. |
| `GET` | `/api/runtime-host/provider-env-map` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/host-bootstrap-settings` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/gateway-launch-plan` | Renderer allowlisted | sanitized projection. |
| `GET` | `/api/runtime-host/team-webhook-auth` | Renderer allowlisted | public auth projection. |
| `GET` | `/api/runtime-host/operations?owner=` | retired | generic operation query projection removed; async completion is exposed only through an owner/facade typed operation query/event. |
| `GET` | `/api/runtime-host/usage/recent` | Renderer allowlisted | current code registers via cron route module. |
| `GET` | `/api/workbench/bootstrap` | Renderer allowlisted | workbench bootstrap. |
| `GET` | `/api/plugins/runtime` / `/api/plugins/catalog` | Renderer allowlisted | plugin projections. |

Evidence: [capabilities.ts](../../electron/api/routes/capabilities.ts)、[cron.ts](../../electron/api/routes/cron.ts)、[runtime-host-delivery/control.ts](../../electron/main/runtime-host-delivery/control.ts)、[transport/](../../runtime-host/host/src/transport/)、[control/dispatch.rs](../../runtime-host/host/src/control/dispatch.rs)。

## B. capability and topology surface

| Method | Path | Classification | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/capabilities/list` | Renderer allowlisted | capability discovery. |
| `POST` | `/api/capabilities/describe` | Renderer allowlisted | `{ id, scope }`. |
| `POST` | `/api/capabilities/execute` | Renderer allowlisted | main business mutation/operation protocol；Rust private control backs team.runtime、skills/plugins and selected OpenClaw operations, but the private command vocabulary is not exposed to Renderer；`hostUvInstallAll` 直接走 `platform.runtime`/`toolchain.installUv`、target=`platform-runtime`，Electron adapter 调 Rust `openclaw.toolchain.install-uv` 并等待真实结果；Remote Fleet start/stop/sync 不走 capability execute，直接走 `/api/remote-fleet/*` → signed Rust `/api/fleet`；其他 accepted-only async operation 使用 owner/facade typed operation query/event。 |
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
| `GET` | `/api/provider-models`, `/api/provider-models/selectable` | Renderer allowlisted |
| `GET` | `/api/capability-routing` | Renderer allowlisted |
| `GET` | `/api/channels/snapshot`, `/api/channels/pairing/:channelType` | Renderer allowlisted |
| `POST` | `/api/channels/config/validate`, `/api/channels/credentials/validate` | Renderer allowlisted |
| `GET` | `/api/skills/status`, `/api/skills/effective` | Renderer allowlisted |
| `POST` | `/api/skills/clawhub/install` | Renderer allowlisted; Rust Skills runtime ops executes legacy ClawHub CLI |
| `POST` | `/api/skills/readme` | child direct; not present in current Electron public allowlist |
| `POST` | `/api/clawhub/search` | Renderer allowlisted; Rust external ClawHub registry search |
| `GET` | `/api/subagents/*` | `LEGACY-REJECTED` (registered as POST routes) |

Legacy rejections within this family:

- `POST /api/provider-accounts/validate`; `GET /api/provider-accounts/:id/api-key`; `GET /api/provider-accounts/:id`;
- `GET /api/provider-models/:id`;
- `GET /api/channels/config/:channelType`;
- all listed subagent routes.

Evidence: [openclaw-routes.ts](../../runtime-host/api/routes/openclaw-routes.ts#L35-L61)、[settings-routes.ts](../../runtime-host/api/routes/settings-routes.ts#L17-L33)、[provider-routes.ts](../../runtime-host/api/routes/provider-routes.ts#L20-L40)、[provider-models-routes.ts](../../runtime-host/api/routes/provider-models-routes.ts#L16-L34)、[channel-routes.ts](../../runtime-host/api/routes/channel-routes.ts#L29-L62)、[skills-routes.ts](../../runtime-host/api/routes/skills-routes.ts#L13-L17)、[subagent-routes.ts](../../runtime-host/api/routes/subagent-routes.ts#L7-L23)。

## E. operations: platform, security, license, cron, files

| Method | Path | Classification |
| --- | --- | --- |
| `GET` | `/api/platform/runtime/health`, `/api/platform/tools` | Renderer allowlisted |
| `POST` | `/api/diagnostics/archive`, `/api/diagnostics/archive/download` | Renderer allowlisted; main-owned diagnostics archive receipt/download surface |
| `POST` | `/api/platform/tools/query` | child direct; not in current public allowlist |
| `GET` | `/api/toolchain/uv/check` | Renderer allowlisted |
| `GET` | `/api/security`, `/api/security/destructive-rule-catalog`, `/api/security/audit` | Renderer allowlisted |
| `GET` | `/api/license/gate`, `/api/license/stored-key` | Renderer allowlisted |
| `GET` | `/api/cron/jobs`, `/api/cron/session-history` | Renderer allowlisted |
| `POST` | `/api/files/{read-text,read-binary,stat,list-dir,thumbnails,write-text,stage-paths,stage-buffer,thumbnail}` | `LEGACY-REJECTED`; use capability execution |

Evidence: [route-boundary.ts](../../electron/api/route-boundary.ts#L172-L173)、[toolchain.ts](../../electron/api/routes/toolchain.ts#L8-L29)、[security-routes.ts](../../runtime-host/api/routes/security-routes.ts#L16-L20)、[license-routes.ts](../../runtime-host/api/routes/license-routes.ts#L12-L15)、[file-routes.ts](../../runtime-host/api/routes/file-routes.ts#L18-L38)。

## F. external connector and Remote Fleet

### External connector

| Method | Path | Classification |
| --- | --- | --- |
| `GET` | `/api/external-connectors`, `/mcp-server-programs`, `/status` | Renderer allowlisted |
| `POST` | `/probe`, `/session-status`, `/get`, `/upsert`, `/remove` | Renderer allowlisted |

Evidence: [external-connector-routes.ts](../../runtime-host/api/routes/external-connector-routes.ts#L18-L59)。

### Remote Fleet

| Method | Paths | Classification |
| --- | --- | --- |
| `GET` | `/api/remote-fleet/snapshot`, `/metrics`, `/terminal/sessions`, `/list-commands`, `/list-audit-events` | Renderer allowlisted |
| `POST` | register-connection/delete-connection/register-environment/delete-environment; write credential; remove node; probe/probe-connection; install/revoke agent; deploy/delete environment; drain/retire endpoint; start/stop runtime; sync capabilities; terminal open/reconnect/close | Renderer allowlisted; legacy node registration `/api/remote-fleet/register` 已关闭，不是 public active route；node dispatch receipts (`accepted/completed/rejected/outcomeUnknown`) 与 owner-local begin/terminal receipts 已投影为现有 renderer `command` payload |
| `WS` | Electron public `/api/remote-fleet/terminal/stream` → Rust Fleet terminal prefix | Renderer allowlisted WebSocket |
| `POST` | `/api/remote-fleet/runtime-agent/ingress` | external RemoteAgent ingress, not Renderer IPC；Electron API server ingress proxy → Rust Fleet transport → Rust handler → FleetHandle core path 已接入 |

Current route/transport evidence: [fleet.ts](../../electron/api/routes/fleet.ts)、[Electron API server](../../electron/api/server.ts)、[fleet transport](../../electron/main/runtime-host-delivery/transport/fleet.ts)、[Rust fleet transport](../../runtime-host/host/src/transport/fleet.rs)、[Rust fleet server](../../runtime-host/host/src/transport/fleet/server.rs)。

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

Route handlers return `{ status, data }`, which child `/dispatch` wraps in the v1 outer envelope. Most `routeResponder.value()` operations become status `200` on success; `routeResponder.result()` preserves an application response’s status. Read-only routes may sanitize secret-like fields. See [route-utils.ts](../../runtime-host/api/routes/route-utils.ts#L51-L180) and [transport.md](transport.md)。
