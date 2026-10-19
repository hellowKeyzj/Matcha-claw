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

## 6. 任务错误诊断增量（2026-10-18）

用户已明确授权任务错误细化：`task.management` 的失败 body 可为 `{success:false,error,failure:{stage,code,rpcCode?,delivery?}}`。三个分类字段只接受封闭枚举，rpcCode 为安全整数；Electron 不透传任意远端 error 文本，而从 code 重建固定消息。Renderer 通过 `AppError.details.taskFailure` 消费已验证的诊断并本地化阶段/原因，不从文本推断原生事实。[VERIFY: src/types/desktop/task-failure.ts:1-87] [VERIFY: src/lib/host-api-transport-contract.ts:147-160] [VERIFY: src/pages/Tasks/index.tsx:177-195]

成功 list/get/create/update/todo shape、HTTP/IPC 外层和写入结果语义保持：`tasks.get` 未找到仍为 200 `{task:null}`；200 `{outcome:'rejected'|'unknown'}` 可附同一 failure，不变为 applied。Electron 本地未取得原生回执仍返回失败，不凭传输 unknown 伪造 200 mutation receipt；不新增自动重试。现有 OpenClaw 两条封闭错误回执仍可接受。[VERIFY: runtime-host/modules/task-manager/src/adapters/loopback/mod.rs:579-705] [VERIFY: electron/main/runtime-host-delivery/transport/task-manager.ts:65-97] [VERIFY: electron/main/runtime-host-delivery/transport/task-manager.ts:147-164]

Matcha 的 `tasks.list/get(kind:"taskList")` 与 `todos.get` 始终读原生已落盘文件，不调用 ensure_native、不取得 Provider 凭据，也不因存在 CLI 改读实时 control；私有读取回执 `instanceId:null`，Host adapter 只在内部验证，不新增 public 字段。Todo 是原生 transcript 主链恢复值，不是实时 AppState；TaskList/Todo 写入仍由 CLI 原生 owner 执行，原 mutation receipt/unknown 与 read NotFound→`task:null` 保持。[VERIFY: matcha-agent/app-server/src/task.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/tasks/mod.rs] [VERIFY: runtime-host/modules/task-manager/src/adapters/loopback/mod.rs]

## 7. redaction boundary

Private bootstrap/control/callback material must not become Renderer API or public runtime config. Public responses must stay redacted: no private key, provider API key, OAuth material, private auth, peer-private DTO, token, path, child stderr or raw native state.
