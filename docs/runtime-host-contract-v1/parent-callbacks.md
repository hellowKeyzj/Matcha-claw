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
| `/internal/runtime-host/shell-actions` | `POST` | `{ version, action, payload }` | `15s` in Rust client | receiver validates token/content/action/payload, executes the allowlisted Electron shell action, returns opened/failure envelope. |
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

Electron validates callback token; wrong token is `403`. Non-POST is `405`; bad content/body/version/event name/action/payload is rejected before forwarding. Current generic validation failures return version/status envelopes without the legacy error-code body. `shell.openPath` failure returns `500` with `SHELL_OPEN_PATH_FAILED`.

## Shell action allowlist

Electron `ParentCallbackReceiver` only accepts `shell_open_path` on this path. Other Rust client enum variants are not wired parent actions and are rejected.

| action | payload | parent meaning |
| --- | --- | --- |
| `shell_open_path` | `{ path: string }`; trimmed non-empty, no NUL, absolute Windows or POSIX path | Electron opens local path via `shell.openPath`. |

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
