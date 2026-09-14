# Event contract: child → Electron → Renderer

## 1. Universal Renderer envelope

Renderer receives one IPC channel:

```json
{
  "eventName": "session:update",
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
| `session:update` | legacy child session/gateway ingress sends parent gateway event; current Rust session canonical path additionally emits safe `session.delta` through private control and Electron bridge. | legacy union includes `session_info_update`, `session_item_chunk`, `session_item`, `plan`; Rust `session.delta` is strictly decoded and mechanically applied by Renderer store. [session-adapter-types.ts](../../runtime-host/shared/session-adapter-types.ts#L470-L512)、[control.ts](../../electron/main/runtime-host-delivery/control.ts)、[gateway.ts](../../src/stores/gateway.ts) |
| `task:snapshot` | task runtime projection; OpenClaw task manager operations now have a Rust RuntimeDriver/Owner path, but this event remains a Renderer-visible projection, not a Task durable owner. | `{ sessionKey, scope?, tasks, todos?, source, enableEdit?, uri? }`; task center consumer. |
| `gateway:channel-status` | child channel / gateway projection. | Renderer expects root `channelId` / `status`; see `OPEN` shape discrepancy below. |
| `runtime-host:status` | Electron-generated observed child status. | `{ status, hostLifecycle, runtimeLifecycle, activePluginCount, pid?, error?, updatedAt }`. |
| `runtime-host:error` | Electron-generated child status failure. | `{ status, message, pid?, updatedAt }`. |
| `runtime-host:restart` | Electron detects child recovery. | `{ previousPid?, pid?, status, recoveredAt }`. |
| `matcha-agent:status` | Electron bridges Rust `matcha.lifecycle` safe events. | `{ processState, ready, port: null, pid: null, lastError: null, updatedAt }`; Settings consumes it as a best-effort hint and `/api/matcha-agent/app-server/status` remains the recovery query. |
| owner/facade operation event | typed owner-local operation projection. | optional fast-path hint; query remains the recovery path. |
| `oauth:code`, `oauth:success`, `oauth:error` | Electron/OAuth path, not child gateway-event allowlist. | Providers Settings consumes them; child callback does not define these names. |

## 4. child → parent gateway-event allowlist

```text
gateway:lifecycle
gateway:notification
session:update
task:snapshot
gateway:channel-status
gateway:error
team:event
```

Source: [parent-transport-contracts.ts](../../runtime-host/shared/parent-transport-contracts.ts#L9-L21)。

### Confirmed transformations

- `gateway:lifecycle` → Electron publishes `gateway:status`, not the raw child payload.
- `gateway:error`, `session:update`, `task:snapshot`, `gateway:channel-status`, `team:event` are forwarded by host event bridge.
- Rust `session.delta` is a safe event produced by Host canonical session apply path and bridged separately from legacy rich `session:update`; it does not carry raw peer transcript state.
- Rust `matcha.lifecycle` is a safe lifecycle hint produced from Matcha peer supervisor state and bridged as `matcha-agent:status`; it does not carry app-server port, pid, path, token, stderr or peer-private payloads.
- `team:event` is produced only from Organization-owned durable TeamRun events after projection through `TeamRunPublicEvent`; native/runtime-private TeamRun payloads are unsupported and must not be emitted.
- `gateway:notification` is `ALLOWLISTED-UNCONFIRMED`: current source walk found bridge/allowlist but no confirmed child producer or Renderer consumer.

Bridge evidence: [host-event-bridge.ts](../../electron/main/host-event-bridge.ts)。

## 5. session ordering and recovery

Child gateway ingress serializes conversation processing per session, but different sessions may run in parallel. Parent forwarding is fire-and-forget, so HTTP completion and Renderer delivery are not a global ordered log. The child may buffer ingress while runtime is unavailable; this buffer is bounded and does not provide durable replay.

Renderer chat event-routing uses session identity/run behavior to filter and to trigger recovery polling for terminal/update kinds; it is not the `host:event` envelope definition. See [event-routing.ts](../../src/stores/chat/event-routing.ts)。

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
