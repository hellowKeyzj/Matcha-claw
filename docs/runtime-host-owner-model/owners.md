# Owner 总表

本表只列已从当前实现重建出的业务事实边界。`Renderer store`、`Electron manager` 和 Host facade 多数是 projection/orchestration，不因名字中有 Store/Service 就自动成为事实 owner。

## 1. 进程与协议

| 领域 | 当前事实 owner | 主要状态 | 外部效果 | Rust 最终责任 |
| --- | --- | --- | --- | --- |
| Electron child process | `DirectRuntimeHost` / `RuntimeHostLifecycleOwner` | parent lifecycle、PID、readiness、crash、restart | spawn、stdin EOF stop、forceKill、restart replacement | 不接管 Electron parent process manager；Rust 提供 private control ready 和 EOF shutdown |
| Electron parent manager | `RuntimeHostManager` | manager lifecycle、child state、gateway bridge、errors | child 编排、parent callback、host event bridge | 不复制；Rust 只提供 parent 所需 child wire 行为 |
| Rust Host private health | `host-system-control` private control descriptor | Host admission lifecycle、safe peer projection | `host.health`、`host.runtime.snapshot` | 提供 Host-private projection，不能混入 Electron process-manager lifecycle |
| Signed loopback product transport | Electron route transports + installed Rust module routes | signed decision、route deadline/body policy、owner DTO decode | HTTP product route、SSE/WS outcome、错误映射 | 由具体 owner module/facade 承接业务；不恢复 legacy `/dispatch` envelope |
| Parent callback | Electron internal routes + TS `ParentTransportClient` | token、callback acceptance、best-effort event result | shell action、gateway event、owner operation event | 提供同一 loopback callback contract；generic operation callback 已删除，typed operation event 由具体 facade 定义 |

## 2. Peer runtime 与 session

| 领域 | 当前事实 owner | 主要状态 | 外部效果 | Rust 最终责任 |
| --- | --- | --- | --- | --- |
| Matcha native runtime | Matcha app-server / worker | native session、run、approval、transcript、tool、model、lifecycle | native protocol、event log、transcript、process | 通过 `MatchaPeer` 做 protocol/lifecycle adapter；不建立第二 canonical owner |
| Legacy transcript | matcha-agent `Project` / transcript pipeline | JSONL message、`uuid`、`parentUuid`、compact、metadata、sidechain | append、replace、recovery、history read | 只读 native history；不重写 JSONL writer、parent-chain recovery |
| App-server runtime events | app-server `EventStore` + `events.jsonl` | eventId、sessionId、seq、runId、workerId、payload | append、replay、publish | 读取 replay/subscribe，做 cursor 和安全 projection |
| App-server index/snapshot | `SessionIndex` / `SnapshotStore` | catalog、metadata、event-envelope projection | list/read/readback | 视为 peer projection，不当作 Host canonical transcript |
| Host canonical timeline | 当前 TS runtime-host canonical reducer/projection | canonical state、timeline、render items、window | Renderer/UI projection | 不在 Rust peer integration 中复制；迁移时另行裁决是否整体接管 |
| Session identity | shared runtime address + peer native session | endpoint + agentId + sessionKey；另有 endpointSessionId | 路由、隔离、hydration | 维护结构化 identity；runId 是 run scope，messageId 是 message identity |

## 3. OpenClaw、channel、cron、usage

| 领域 | 当前事实 owner | 主要状态 | 外部效果 | Rust 最终责任 |
| --- | --- | --- | --- | --- |
| OpenClaw config | OpenClaw config store / `openclaw.json` | configured desired/persisted config | config write、下游 apply | 做 private projection/adapter；不把 Host generic config 当事实源 |
| Gateway live state | OpenClaw Gateway native subsystem | backend WebSocket connection、pending RPC、event ingress、runtime readiness | authenticated WS、request/response/event multiplex、shutdown | Rust Integration 持有单条 control dispatcher；保留 unknown/unavailable，不伪造成功，不跨连接重放 mutation |
| Provider catalog/reference | Provider owner saved catalog + user input；built-in curated JSON reference catalog 按 modelId 提供 discovery/import draft defaults | modelId、capabilities、contextWindow、maxTokens、timeoutMs、aspectRatio、resolution、quality | discovery/import draft、saved catalog persistence、OpenClaw private projection | 用户手填/已保存 catalog 是最终事实；OpenClaw projection 只消费 saved catalog，不按模型名猜 contextWindow |
| Channel configured identity | OpenClaw `config.channels` | enabled/account/configured channel | config persistence | 读取/投影 OpenClaw authority |
| Channel live status | Gateway `channels.status` | account/connection/health | status RPC/event | 读取 native status；不使用 Renderer Zustand 作 authority |
| Channel login | in-memory login session service | QR、pending、success、error、cancel | login flow、event | 适配 login session；payload shape 需 trace |
| Pairing request | OpenClaw conversation runtime | pending/approved/rejected pairing | conversation command/event | 通过 peer/Gateway adapter，不与 channel config 合并 |
| Cron definitions/runs | OpenClaw Gateway native cron | schedule、delivery、run、receipt、history | control RPC、forced-run event lane、delivery | typed protocol adapter；不建 Host cron fact store；mutation 丢失响应保留 unknown |
| Token usage | transcript JSONL + parser | usage records/cache | dashboard refresh | 读取 transcript facts；`usage.refreshHistory` 只是刷新触发器 |

## 4. Capability、platform 与 operations

| 领域 | 当前事实 owner | 主要状态 | 外部效果 | Rust 最终责任 |
| --- | --- | --- | --- | --- |
| TS capability contract | `CapabilityRegistry` / capability modules / `CapabilityRouter` | descriptor、scope、target、operation、availability | `/api/capabilities/*`、execute | 若替换该入口，必须保持完整输入校验和结果语义；不能用 Rust fixed directory 自动替代 |
| Authorization | 当前 TS request/target validation；Rust fixed transports 有 signed decision verifier | scope、target binding、principal、correlation、expiry | allow/deny、safe transport | 明确在切换点的 authorization adapter；TS metadata 不能凭空等同 signed decision |
| Diagnostics | 当前 TS `DiagnosticsService` + Rust archive candidate | archive operation/receipt、HostState snapshot、bundle | filesystem archive、redaction、download | 兼容 diagnostics API；终态使用 diagnostics-owned operation query/event，不走已删除的 Host-wide generic lookup |
| External connectors | TS `connectors.json` + OpenClaw `mcp.servers` + probes | desired、persisted、applied、global/session observed | file mutation、projection、network probe、Gateway status | 候选 `ConnectorStore`/`ExternalConnectorOwner`；先解决 schema、secret、status parity 和 cutover |
| License | retired product surface | none | none | License gate、route、event、capability、secret owner 与本地 license 服务脚本均已删除；云账号/billing/subscription/quota 仍由 Cloud Account 体系负责 |
| Security policy | durable policy JSON + security-core/Gateway apply | desired/persisted/applied/observed audit/enforcement | policy write、plugin/Gateway apply | 适配 native policy owner；不以 Rust rule catalog 代替完整 policy owner |
| Settings | TS `SettingsStoreWorkflow` | desired/persisted/applied/ready | settings write、Gateway apply/restart | 先闭合 runtime data path 和 token private projection，再决定接管 |
| Platform runtime health | `OpenClawRuntimeDriver` / Gateway bridge | port reachable、connection state、lastError | health check、runtime control | 与 Rust Host admission、OpenClaw control readiness、Gateway live status 分字段映射；不能用 Gateway probe 决定 Host ok |
| `uv/toolchain` | `runtime-host/modules/toolchain::NativeToolchain` + `ToolchainModule` owner loopback | uv available、Python 3.12 readiness、prepare terminal result | Renderer lazy `hostToolchainPrepare()` → Electron `/api/toolchain/uv/prepare` → `toolchainTransport.prepare()`；`/api/toolchain/uv/check` → `toolchainTransport.status()` → `{ installed }` | OpenClaw 与 matcha-agent 只消费 private env projection；Foundation 只提供 bounded process/env patch primitives；不走 `platform.runtime` capability，不走 OpenClaw business owner，不走 Host private control command |
| Remote Fleet/Team | Rust Host `organization` / `fleet` domains under `runtime-host` state root；native/remote runtime remains external | endpoint、node、terminal、team run、audit、webhook token、fleet credentials | remote API、WebSocket、webhook、agent ingress | 独立 owner；durable facts/credentials 落在 `%APPDATA%/MatchaClaw/runtime-host`，不能塞入 Host-wide generic operation state、OpenClaw state 或 Matcha app-server state |

## 5. Foundation 后台执行机制与 owner-local 异步 operation

Foundation 已有 `execution` 机制，供具体业务 owner 持有后台 operation：

```text
OwnedTask<T>
  -> TaskHandle（取消）
  -> OperationHandle<T>（一次可 join 的 operation）
  -> ServiceHandle<T>（长生命周期 service）
```

它提供 task 生命周期、取消和 join，不提供业务状态、优先级、通用重试、持久化、结果 retention 或全局 generic operation registry。

```text
具体领域 owner operation/task/run
  -> foundation execution handle
  -> owner-local/native state
  -> owner/facade typed query
  -> owner/facade typed event hint
```

typed operation event 是低延迟通知；owner/facade query 是丢事件、竞态和恢复的可查询路径。Host-wide generic operation 不是 cron、session、connector、diagnostics 或 usage 的事实源。
