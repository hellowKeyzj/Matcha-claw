# 范围与权威边界

## 进程与协议图

```text
Renderer
  └─ window.electron.ipcRenderer.invoke('hostapi:fetch' | 'hostapi:abort')
       └─ Electron main Host API loopback server / route boundary
            └─ DirectRuntimeHost private control 或 signed loopback product transport
                 └─ Rust Owner actor / fixed owner transport

Rust child
  └─ POST Electron /internal/runtime-host/gateway-events
       └─ ParentCallbackReceiver → HostEventBus
            └─ webContents.send('host:event', { eventName, payload })
                 └─ Renderer host-event hub
```

`Renderer` 不直接连接 child 端口，也不拥有 child token。Rust 替代的是 child server 与其内部 owner，不是 Host API、preload 或 Renderer client。

## 四个必须保留的边界

| 边界 | 迁移要求 | 首要证据 |
| --- | --- | --- |
| Renderer ↔ preload/Electron IPC | 不改 channel、参数、返回 envelope、abort 或订阅语义。 | [ipc-contract.ts](../../electron/preload/ipc-contract.ts#L1-L94)、[preload/index.ts](../../electron/preload/index.ts#L15-L96)、[host-api.ts](../../src/lib/host-api.ts#L274-L332) |
| Electron ↔ child request transport | Renderer-facing Host API 不变；Rust 通过 DirectRuntimeHost private control 或 signed loopback product transport 承接当前 active path，legacy `/dispatch` 只作为兼容/历史面逐项裁决。 | [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[bootstrap.ts](../../electron/main/runtime-host-delivery/bootstrap.ts)、[runtime-host/host/src/transport/](../../runtime-host/host/src/transport/) |
| child ↔ Electron parent callback | Rust 使用 loopback HTTP callback receiver、dispatch token、body 和 best-effort/response语义；终态 active receiver 覆盖 gateway-events，shell-actions 仍按实际接线单独裁决；不保留通用异步 operation callback。 | [parent-callback.ts](../../electron/main/runtime-host-delivery/parent-callback.ts)、[parent_callback.rs](../../runtime-host/host/src/parent_callback.rs) |
| Electron ↔ child process lifecycle | Rust binary 接受 one-shot bootstrap、private control ready、stdin EOF shutdown、forceKill 与 explicit restart；不再把旧 Node child env/IPC shutdown 当当前 active lifecycle。 | [direct-host.ts](../../electron/main/runtime-host-delivery/direct-host.ts)、[lifecycle-owner.ts](../../electron/main/runtime-host-delivery/lifecycle-owner.ts)、[main.rs](../../runtime-host/host/src/main.rs) |

## 谁拥有哪层事实

| 层 | Owner | Rust 是否可重设计 |
| --- | --- | --- |
| 页面状态、UI loading、client polling | Renderer | 否 |
| IPC allowlist、Host API token、child fork、parent-only shell/OAuth action | Electron main | 否 |
| child transport、route dispatch、业务适配、child 自己的生命周期 | Rust runtime-host | 是，但必须投影回既有 wire contract |
| OpenClaw / matcha-agent 的原生会话、gateway、能力授权和配置事实 | peer runtime | 不应复制为 Host 的第二真相 |

## Host API 公开面的三种状态

Electron 的 route boundary 不能与 child 注册表混为一谈。

| 状态 | 含义 |
| --- | --- |
| `main-owned` | Electron 在 Host API 层处理；同 path 的 child route 不会从 Renderer Host API 到达。 |
| `renderer-allowlisted` | Renderer 可经 `hostapi:fetch` 请求；main 再转发或自行处理。 |
| `child-direct / CLI` | legacy child route 或 Rust product transport 已注册，但不是 Renderer IPC allowlist；仍可能被 CLI、测试或直接 child transport 使用。 |

完整边界 allowlist 见 [route-boundary.ts](../../electron/api/route-boundary.ts#L13-L217)，完整 child route 分类见 [routes.md](routes.md)。

### Electron main-owned，而非 Rust child 的 API

以下是迁移时不得从 Electron 移走的典型面：

- `/api/gateway/{status,health,start,stop,restart,control-ui}`
- `/api/matcha-agent/app-server/{status,restart}`
- `/api/files/save-image`
- `/api/diagnostics/{memory,gateway-snapshot}`
- `/api/logs*` 与 `/api/openclaw/logs*`
- `POST /api/runtime-host/restart`
- `/internal/runtime-host/*`

来源：[route-boundary.ts](../../electron/api/route-boundary.ts#L13-L38)。child 可能存在同名业务 route，但对 Renderer Host API 而言 main-owned route 优先。

## 额外外部入口

它们不应被遗漏，也不等同于 Renderer 兼容面。

| 入口 | 属于 Rust child | 认证/传输 | 证据 |
| --- | --- | --- | --- |
| `matcha runtime invoke` 等 CLI | 待裁决 | legacy 直连 `/dispatch` 是历史兼容面；当前 Rust delivery 不把它自动视为 active cutover 证据。 | [routes.md](routes.md)、[open-items.md](open-items.md) |
| TeamRun webhook | 是 | `POST /api/team-runtime/webhooks/<path>`；Bearer 或 `x-matchaclaw-webhook-token`；Rust Organization/Team owner 仍需外部 ingress cutover proof。 | [routes.md](routes.md) |
| Remote Fleet runtime-agent ingress | 是 | Electron API server ingress proxy → Rust Fleet transport → Rust handler → FleetHandle core path；不是 Renderer IPC，也不是 Host API bearer；`Authorization` 与 enrollment header 必须原样透传到 Rust `fleetTransportPort`。 | [routes.md](routes.md) |
| Remote Fleet terminal WebSocket | 是 | Electron 精确代理 `/api/remote-fleet/terminal/stream` 到 Rust Fleet terminal prefix；FleetOwner keyed lanes 已有 Rust 侧证据，覆盖 terminal provider open、dispatch、connection/environment/resource lifecycle；live recovery、query refresh、terminal provider failure owner-local settlement 已通过。 | [routes.md](routes.md)、[lifecycle.md](lifecycle.md) |

## 不纳入 Rust 最终内部架构的旧机制

- TS container/module registry 的具体形状；
- TS 全局异步 operation queue/registry、priority policy 和 generic operation projection；
- TS workflow/port/interface 的逐文件翻译；
- 为兼容旧行为而保留 TS owner、fallback 或 bridge。

这些不是可观察 contract。Rust 只需要实现对应业务结果，并在边界输出既有请求、响应和事件。
