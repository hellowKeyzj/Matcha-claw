# child → Electron parent callbacks

## Common transport

Rust child calls Electron parent over loopback HTTP, not Electron IPC. Current Rust delivery receives callback material in the private bootstrap frame.

```text
base URL: bootstrap parentCallbackBaseUrl
header:   x-runtime-host-dispatch-token: bootstrap parentCallbackDispatchToken
content:  application/json
version:  1
```

The bootstrap fields are process-private and must not become Renderer API. Sources: [bootstrap.ts](../../electron/main/runtime-host-delivery/bootstrap.ts)、[parent-callback.ts](../../electron/main/runtime-host-delivery/parent-callback.ts)、[parent_callback.rs](../../runtime-host/host/src/parent_callback.rs)。

| Path | Method | Body | Timeout | Delivery semantics |
| --- | --- | --- | --- | --- |
| `/internal/runtime-host/shell-actions` | `POST` | `{ version, action, payload? }` | `15s` in Rust client | Rust client enum exists; current Electron `ParentCallbackReceiver` does not expose this path, so active wiring remains pending. |
| `/internal/runtime-host/gateway-events` | `POST` | `{ version, eventName, payload }` | `3s` | receiver validates token/content/event name, emits HostEventBus, returns accepted. |

Sources: [parent-callback.ts](../../electron/main/runtime-host-delivery/parent-callback.ts)、[parent_callback.rs](../../runtime-host/host/src/parent_callback.rs)。

## Parent response envelope

```json
{
  "version": 1,
  "success": true,
  "status": 200,
  "data": {}
}
```

or:

```json
{
  "version": 1,
  "success": false,
  "status": 403,
  "error": { "code": "FORBIDDEN", "message": "..." }
}
```

Electron validates callback token; wrong token is `403`. Non-POST is `405`; bad content/body/version/event name is rejected before forwarding. Current receiver returns version/status envelopes without the legacy error-code body; do not claim shell/action envelope parity until that path is wired. Payload itself is primarily opaque at this boundary.

## Shell action allowlist

Rust `ParentCallbackClient` still defines these shell actions, but current Electron `ParentCallbackReceiver` does not expose the shell-actions path. Treat shell action callback as `IMPLEMENTED` client-side and `BLOCKED` for active parent wiring until a receiver/contract test exists.

| action | known payload | parent meaning |
| --- | --- | --- |
| `shell_open_path` | `{ path }` | Electron opens local path. |
| `gateway_restart` | optional `{ reason? }` | restart accepted/queued; does **not** mean gateway is ready. |
| `host_diagnostics_snapshot` | none | returns Electron/host diagnostic projection. |
| `provider_oauth_start` | `{ provider, accountId, flowId, region?, label? }` | starts native OAuth/device flow. |
| `provider_oauth_cancel` | `{ flowId, accountId, vendorId }` | cancels native flow. |
| `provider_oauth_submit` | `{ code, flowId, accountId, vendorId }` | submits native OAuth input. |

## Gateway event callback

Allowed event names are listed in [events.md](events.md). Existing call sites commonly use:

```ts
void parentTransport.emitParentGatewayEvent(...).catch(() => undefined)
```

Therefore failure to deliver must not change the underlying business result; it is a notification failure. Rust must not turn this into a new durable event system without separately changing the client/event contract.

## Owner operation notification

Async owners do not publish completion through a generic parent callback. When notification is useful, the concrete owner/facade defines a typed operation event; its query path remains the recovery path.

## Security boundary

- Parent dispatch token is process-private, generated in Electron and redacted in child logs.
- Renderer never receives it.
- `/internal/runtime-host/*` is main-owned and bypasses Host API bearer auth only because it requires this separate token.

Sources: [server.ts](../../electron/api/server.ts)、[runtime-host-manager.ts](../../electron/main/runtime-host-manager.ts)、[runtime-host-internal.ts](../../electron/api/routes/runtime-host-internal.ts)。

## Required Rust compatibility tests

Before a Rust child replaces TS, record and verify for all three callback families:

```text
method, path, token present/matching, content type,
version, action/eventName, payload, timeout,
parent success/failure mapping, call count
```

Current receiver tests cover only the wired callback families they exercise; shell-actions and owner-specific typed operation event/query recovery remain cutover blockers. See [verification.md](verification.md)。
