# Event contract: child → Electron → Renderer

## 1. Universal Renderer envelope

Renderer receives one IPC channel:

```json
{
  "eventName": "session.delta",
  "payload": {}
}
```

`host:event` is allowlisted by preload. The Renderer hub creates one lower-level IPC listener and fan-outs by `eventName`; it only validates that `eventName` is a string. Sources: [ipc-contract.ts](../../electron/preload/ipc-contract.ts#L56-L78)、[host-events.ts](../../src/lib/host-events.ts#L49-L116)。

## 2. Delivery semantics (must not be accidentally strengthened or weakened)

| Segment | Current semantics |
| --- | --- |
| child → Electron gateway event | best-effort HTTP callback; 3s timeout; no response-envelope validation, retry, persistence or replay. |
| Electron manager event buses | in-memory `EventEmitter`; no persistence, cursor or replay. |
| Electron → Renderer | `webContents.send('host:event', ...)`; no ack/retry; absent window or unsubscribed listener loses event. |
| Owner operation observer | owner/facade typed query is the recovery path; typed events are best-effort hints only. |

These are existing observable recovery semantics. Rust must not assume events are durable. Sources: [parent-transport-client.ts](../../runtime-host/composition/parent-transport-client.ts)、[runtime-host-manager.ts](../../electron/main/runtime-host-manager.ts)、[host-event-bridge.ts](../../electron/main/host-event-bridge.ts)。

## 3. Renderer-visible event families

| Renderer event | Producer / bridge behavior | Payload contract / consumers |
| --- | --- | --- |
| `gateway:status` | Electron transforms child `gateway:lifecycle` into public gateway snapshot. | `GatewayStatus`: process/transport state, port, pid?, readiness, errors/issue, diagnostics, `updatedAt`; consumed by [gateway.ts](../../src/stores/gateway.ts#L217-L228)。 |
| `gateway:error` | child bridge or Electron gateway manager. | `{ message, issue? }`; consumer prioritizes `issue.message`. [gateway.ts](../../src/stores/gateway.ts#L229-L240) |
| `session.delta` | Integration → Sessions owner/state → signed `/api/sessions/events` SSE → Electron strict decode → authorized complete identity page IPC；不走 private control/legacy callback。 | `{sessionKey,identity,epoch,seq,cursor,runId?,changes}`；top key 必须匹配 identity，routeKey/native cursor/generation 禁止公开。`itemsReplaced` 按 exact IDs/anchor 原子应用。[VERIFY: electron/main/host-event-bridge.ts:98-105] [VERIFY: src/types/session/snapshot.ts:873-897] |
| `session.resync` | Sessions successful sync commit 与 Main authorized-only reconnect recovery 沿同一既有链投递。 | strict `{identity,epoch,seq}`，Renderer 同 identity 再 observe；不是假 delta、不含 reason-only/native cut/run/message。[VERIFY: runtime-host/modules/sessions/src/owner/observation.rs:821-825] [VERIFY: electron/main/renderer-event-routes.ts:173-198] [VERIFY: src/stores/chat/store.ts:291-304] |
| `task:snapshot` | task runtime projection; OpenClaw task manager operations now have a Rust RuntimeDriver/Owner path, but this event remains a Renderer-visible projection, not a Task durable owner. | `{ sessionKey, scope?, tasks, todos?, source, enableEdit?, uri? }`; task center consumer. |
| `gateway:channel-status` | child channel / gateway projection. | Renderer expects root `channelId` / `status`; see `OPEN` shape discrepancy below. |
| `runtime-host:status` | Electron-generated observed child status. | `{ status, hostLifecycle, runtimeLifecycle, activePluginCount, pid?, error?, updatedAt }`. |
| `runtime-host:error` | Electron-generated child status failure. | `{ status, message, pid?, updatedAt }`. |
| `runtime-host:restart` | Electron detects child recovery. | `{ previousPid?, pid?, status, recoveredAt }`; active Call observers re-read the same callId. |
| `call:changed` | Rust CallLog transaction commit → private control → Electron bridge. | `{callId, revision}`; safe hint only, observers query the same identity. |
| `calls:resync` | Rust CallLog broadcast lag → `calls.resync` → Electron bridge. | `{}`; active Call observers and Calls store re-read, no periodic fallback. |
| `team:changed` | Organization 既有 schedule watch → Host `OrganizationChanged` → private control `organization.changed` → Electron bridge。 | strict `{}`；只提示已观察的 exact teamId/runId 回读，不携 prompt、runId 或 graph，不恢复旧 rich `team:event`。watch 可合并通知，事件不是 durable 数据源。[VERIFY: runtime-host/host/src/composition/events.rs:40-67] [VERIFY: runtime-host/host/src/composition/host/mod.rs:342] [VERIFY: runtime-host/host/src/control/wire.rs:373-374] [VERIFY: electron/main/runtime-host-delivery/control.ts:475-479] [VERIFY: electron/main/host-event-bridge.ts:135-137] [VERIFY: src/stores/teams.ts:976-998] |
| `runtime-host:disconnected` | Main observes loss of the active control channel, including replacement. | `{}`; ends observation as unconfirmed, not business failure or execution cancellation. |
| `package:changed` | Main CloudAccountService stores terminal result/TTL, or invalidates an old account epoch. | `{operationId}`; Renderer re-reads the specific Main package result, without bytes/token/epoch. |
| `matcha-agent:status` | Electron bridges Rust `matcha.lifecycle` safe events. | `{ processState, ready, port: null, pid: null, lastError: null, updatedAt }`; Settings consumes it as a best-effort hint and `/api/matcha-agent/app-server/status` remains the recovery query. |
| `openclaw:questions-changed` | OpenClaw native `question.requested/resolved` → Integration unit hint → 原 private control `openclaw.questions.changed` → Electron bridge。 | `{}`；不含问题、答案、identifier 或 secret。当前 OpenClaw local 会话回读 typed `question.list`；提示不是待答事实或终态，丢失后沿连接恢复/页面恢复回读，不轮询。[VERIFY: runtime-host/integrations/openclaw/src/session/ingest.rs:238-241] [VERIFY: runtime-host/host/src/control/event_projection.rs:54-60] [VERIFY: electron/main/runtime-host-delivery/control.ts:474-477] |
| owner/facade operation event | typed owner-local operation projection. | optional fast-path hint; query remains the recovery path. |
| `oauth:code`, `oauth:success`, `oauth:error` | Electron/OAuth path, not child gateway-event allowlist. | Providers Settings consumes them; child callback does not define these names. |

## 4. child → parent gateway-event allowlist

```text
gateway:lifecycle
gateway:notification
task:snapshot
gateway:channel-status
gateway:error
team:event
```

`session:update` 已从 Rust parent callback enum/parser 移除，不能经通用出口发送；Session 使用上节专用 SSE 链。[VERIFY: runtime-host/host/src/parent_callback.rs:51-70] [VERIFY: runtime-host/host/src/parent_callback.rs:130-149]

### Confirmed transformations

- `gateway:lifecycle` → Electron publishes `gateway:status`, not the raw child payload.
- `gateway:error`, `task:snapshot`, `gateway:channel-status`, `team:event` are forwarded by host event bridge；legacy `session:update` 不再是 Session 生产出口。
- Rust `session.delta/session.resync` 属于 Sessions-owned SSE 链，Main 完整 identity + 页面授权过滤后定向 `host:event`；不进入 control SafeEvent、通用 HostEventBus 或 legacy rich `session:update`。native transcript/history authority 留在 peer/Integration。[VERIFY: electron/main/host-event-bridge.ts:98-105] [VERIFY: electron/main/renderer-event-routes.ts:122-152]
- Rust `matcha.lifecycle` is a safe lifecycle hint produced from Matcha peer supervisor state and bridged as `matcha-agent:status`; it does not carry app-server port, pid, path, token, stderr or peer-private payloads.
- `team:event` is produced only from Organization-owned durable TeamRun events after projection through `TeamRunPublicEvent`; native/runtime-private TeamRun payloads are unsupported and must not be emitted.
- `gateway:notification` is `ALLOWLISTED-UNCONFIRMED`: current source walk found bridge/allowlist but no confirmed child producer or Renderer consumer.

Bridge evidence: [host-event-bridge.ts](../../electron/main/host-event-bridge.ts)。

## 5. session ordering and recovery

Sessions 以完整 identity lane 归并 ingress；public epoch/seq/cursor 是 owner 提交水位，不是 native history opaque cursor 或 Gateway replay frontier。sync 在 OwnedTask 读取，baseline 三方归并保留并发已接受 facts/明确删除，成功 commit 单次推进公开 seq/cursor 并发 resync，不造 delta。空 changes native event 可只推进私有 frontier。[VERIFY: runtime-host/modules/sessions/src/domain/model.rs:1606-1794] [VERIFY: runtime-host/modules/sessions/src/owner/observation.rs:262-316]

Renderer 按完整 identity recordKey 与 epoch/seq 判断 stale/duplicate/gap；gap/resync 回读确切 identity，无 global ordering 或 durable Renderer replay 承诺。SSE lag 结束 stream，Main 重连只恢复已授权 identities。OpenClaw history cut 为 Snapshot，Matcha 只有实际 events.replay 到 snapshot cut 后才报告 EventFrontier；事实完整性独立于 cut，非原子 seam 保留。当前七切片及未授权 live 均见 Session / Chat dev OPEN，不沿用旧 polling/test 结果。[VERIFY: src/stores/chat/store-state-helpers.ts:1951-2045] [VERIFY: electron/main/renderer-event-routes.ts:155-169] [VERIFY: runtime-host/integrations/openclaw/src/session/event_router.rs:52-62] [VERIFY: runtime-host/integrations/matcha-agent/src/session/adapters/observation.rs:257-287]

## 6. `gateway:channel-status` shape risk — `OPEN`

One channel-login projection produces:

```json
{
  "eventName": "gateway:channel-status",
  "payload": { "channelId": "...", "status": "..." },
  "updatedAt": 0
}
```

while the gateway store reads root-level `update.channelId` / `update.status`. The bridge currently forwards payload without an observed unwrap. This is a current compatibility ambiguity, not permission to silently normalize Rust output. Before cutover, trace actual emitted payload and preserve the client-observed shape. Evidence: [openclaw-channel-login-session-service.ts](../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts)、[gateway.ts](../../src/stores/gateway.ts#L250-L259)。

## 7. Event fixture requirements

For each cutover owner, capture normalized traces with:

```text
eventName
payload JSON (dynamic IDs/timestamps normalized)
source operation
consumer
whether event is required or only fast-path notification
```

Do not use event timing or global ordering as a hard equivalence condition where current semantics do not guarantee it. Preserve per-session identity, terminal state meaning and client recovery behavior.
