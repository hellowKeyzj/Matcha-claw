# Electron ↔ child transport

## 0. current transport shape

当前 Rust child 的 active delivery 面已经切到 `DirectRuntimeHost`：Electron 启动 Rust executable 后，通过 stdin 写入一次 length-prefixed bootstrap，再通过 stdin/stdout private control framed wire 等待 `ready`、发送 host-private commands、接收 safe events。旧 root HTTP endpoints `GET /health`、`POST /dispatch`、`POST /lifecycle/restart`、`POST /lifecycle/stop` 已从 Rust Host compatibility module 删除，不再是必须保留的 child contract。

Host-owned HTTP listener 仍存在，但它只是 loopback substrate：router 只消费 installed `ModuleCatalog` route descriptors，业务 DTO decode 位于具体 owner module adapter/facade；SSE/WS 是 `RouteOutcome::Stream` / `RouteOutcome::Upgrade`，不是独立 Host-owned listener。OpenClaw gateway、Matcha app-server、Matcha MCP stdio 不属于此 server。

Sources: [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[control.ts](../../electron/main/runtime-host-delivery/control.ts)、[host http server](../../runtime-host/host/src/http/server.rs)、[host http router](../../runtime-host/host/src/http/router.rs)、[module install](../../runtime-host/host/src/module_registry/install.rs)、[platform loopback](../../runtime-host/platform/src/loopback.rs)。

## 1. retired root endpoints

| Method | Path | 状态 | Replacement |
| --- | --- | --- | --- |
| `GET` | `/health` | retired | private control `host.health`。 |
| `POST` | `/dispatch` | retired | Electron signed loopback product transports to installed module routes；private control 不承载 business command enum。 |
| `POST` | `/lifecycle/restart` | retired | Electron child restart: `POST /api/runtime-host/restart` → `RuntimeHostLifecycleOwner.restart()`；peer runtime restart: `/api/runtime-control/lifecycle/restart`。 |
| `POST` | `/lifecycle/stop` | retired | Electron child stop: `DirectRuntimeHost.stop()` closes stdin/EOF；peer runtime stop: `/api/runtime-control/lifecycle/stop`。 |

不要恢复 legacy compatibility island、root dispatch envelope、root lifecycle route 或 router hard-code branch。

## 2. private control wire

Private control command envelope is internal to Electron ↔ Rust child delivery:

```json
{ "name": "host.health" }
```

Current Host-private command vocabulary comes from installed private-control descriptors and is limited to:

- `host.health`
- `host.runtime.snapshot`

The wire timeout max is 120s and frame max is 1MiB. The command vocabulary is not HTTP route passthrough and not a business command enum; capability list/describe/execute, session send, team runtime, skills/plugins, fleet mutation and provider rules must stay in their owning module routes/facades.

Sources: [control.ts](../../electron/main/runtime-host-delivery/control.ts)、[private_control.rs](../../runtime-host/host/src/module_registry/private_control.rs)、[module.rs](../../runtime-host/platform/src/module.rs)。

## 3. loopback product transport

Renderer still calls the existing Electron Host API / preload IPC surface. Electron routes either remain main-owned or call signed loopback transports into Rust installed module routes. Rust HTTP substrate rules:

- one listener bound by Host service startup;
- route registry from installed module descriptors;
- body policy, deadline and timeout response selected from matching route descriptor;
- response/stream/upgrade written from `platform::loopback::RouteOutcome`;
- unknown route returns JSON 404;
- no legacy root endpoint special-case in router.

Sources: [service.rs](../../runtime-host/host/src/app/service.rs)、[router.rs](../../runtime-host/host/src/http/router.rs)、[server.rs](../../runtime-host/host/src/http/server.rs)。

## 4. Electron Host API wrapping

Renderer does not talk to Rust private control or child loopback port. Electron Host API proxy keeps the public envelope:

1. Renderer `hostapi:fetch` enters Electron Host API boundary;
2. Electron validates route ownership / allowlist;
3. Electron either handles a main-owned route or calls a Rust delivery transport;
4. Rust returns the module/public response projection;
5. Electron IPC returns `{ ok: true, data: { status, ok, json|text } }` or `{ ok: false, error }`.

Sources: [hostapi-proxy-ipc.ts](../../electron/main/ipc/hostapi-proxy-ipc.ts)、[runtime-host-proxy.ts](../../electron/api/routes/runtime-host-proxy.ts)、[host-api-transport-contract.ts](../../src/lib/host-api-transport-contract.ts)。

## 5. timeout baseline

| 方向 | 当前值 | 说明 |
| --- | --- | --- |
| Renderer → Electron Host API proxy | 默认 `30s`，请求可覆盖 | Renderer-facing API timeout。 |
| Electron → Rust private control ready/command | ready 上限 `120s`；command max `120s` | `DirectRuntimeHost` / `RuntimeHostControlClient`。 |
| Electron → Rust signed loopback product route | route/transport 自己定义 deadline；Host router 默认 `30s` | 不经 legacy `/dispatch` envelope。 |
| Rust child → Electron shell callback | `15s` | parent-owned shell effect。 |
| Rust child → Electron gateway event | `3s`，best effort | event accepted 不等于业务 terminal success。 |

## 6. redaction boundary

Private bootstrap/control/callback material must not become Renderer API or public runtime config. Public responses must stay redacted: no private key, provider API key, OAuth material, private auth, peer-private DTO, token, path, child stderr or raw native state.
