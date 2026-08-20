# Owner 总表

本表只列已从当前实现重建出的业务事实边界。`Renderer store`、`Electron manager` 和 Host facade 多数是 projection/orchestration，不因名字中有 Store/Service 就自动成为事实 owner。

## 1. 进程与协议

| 领域 | 当前事实 owner | 主要状态 | 外部效果 | Rust 最终责任 |
| --- | --- | --- | --- | --- |
| Electron child process | `LocalProcessRuntime` / `RuntimeHostProcessAdapter` | parent lifecycle、PID、readiness、crash、restart | fork、stop、restart、backoff | 不接管 Electron parent process manager；兼容 child `/health` 和启动语义 |
| Electron parent manager | `RuntimeHostManager` | manager lifecycle、child state、gateway bridge、errors | child 编排、parent callback、host event bridge | 不复制；Rust 只提供 parent 所需 child wire 行为 |
| TS child runtime health | `RuntimeHostStateService` | child lifecycle、uptime、plugin count、transport stats | `/health`、`/api/runtime-host/health` | 提供同一 child health/application projection，不能混入 parent lifecycle |
| `/dispatch` transport | Electron `RuntimeHostClient` + child dispatch handler | request/response envelope、timeout、body limit、validation | HTTP dispatch、错误映射 | 实现 v1 wire contract；默认 30s、超大 body 413 |
| Parent callback | Electron internal routes + TS `ParentTransportClient` | token、callback acceptance、best-effort event result | shell action、gateway event、runtime-job event | 提供同一 loopback callback contract；Rust wiring尚未闭合 |

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
| Diagnostics | 当前 TS `DiagnosticsService` + global queue；Rust archive 是独立候选 | archive job/receipt、HostState snapshot、bundle | filesystem archive、redaction、download | 兼容 diagnostics API；保留 parent snapshot、jobGet 和 receipt 语义 |
| External connectors | TS `connectors.json` + OpenClaw `mcp.servers` + probes | desired、persisted、applied、global/session observed | file mutation、projection、network probe、Gateway status | 候选 `ConnectorStore`/`ExternalConnectorOwner`；先解决 schema、secret、status parity 和 cutover |
| License | TS `NodeLicenseRuntime` | encrypted key、hash cache、device identity、gate snapshot | gate event、revalidation | 只有完成行为与 secret boundary 证明后才接管 |
| Security policy | durable policy JSON + security-core/Gateway apply | desired/persisted/applied/observed audit/enforcement | policy write、plugin/Gateway apply | 适配 native policy owner；不以 Rust rule catalog 代替完整 policy owner |
| Settings | TS `SettingsStoreWorkflow` | desired/persisted/applied/ready | settings write、Gateway apply/restart | 先闭合 runtime data path 和 token private projection，再决定接管 |
| Platform runtime health | `OpenClawRuntimeDriver` / Gateway bridge | port reachable、connection state、lastError | health check、runtime control | 与 Rust Host admission、OpenClaw control readiness、Gateway live status 分字段映射；不能用 Gateway probe 决定 Host ok |
| uv/toolchain | Rust OpenClaw Toolchain owner-local operation/projection；Electron `/api/capabilities/execute` public adapter；`/api/toolchain/uv/check` status projection | uv available、Python ready、install result/terminal receipt | Foundation-contained `uv python install 3.12` 与 `uv python find 3.12` readiness readback | 恢复 `hostUvInstallAll` 异步 `RuntimeJobSubmission`；`runtimeHost.jobGet` + `runtime-job:done/progress` 只作兼容投影。private control command 不暴露给 Renderer；adapter、terminal/native、Windows/package 与 cutover 证据未闭合，保持 `IMPLEMENTED` |
| Remote Fleet/Team | Rust Host `organization` / `fleet` domains under `runtime-host` state root；native/remote runtime remains external | endpoint、node、terminal、team run、audit、webhook token、fleet credentials | remote API、WebSocket、webhook、agent ingress | 独立 owner；durable facts/credentials 落在 `%APPDATA%/MatchaClaw/runtime-host`，不能塞入 generic RuntimeJob、OpenClaw state 或 Matcha app-server state |

## 5. Foundation 后台执行机制与兼容异步投影

Foundation 已有 `execution` 机制，供具体业务 owner 持有后台 operation：

```text
OwnedTask<T>
  -> TaskHandle（取消）
  -> OperationHandle<T>（一次可 join 的 operation）
  -> ServiceHandle<T>（长生命周期 service）
```

它提供 task 生命周期、取消和 join，不提供业务状态、优先级、通用重试、持久化、结果 retention 或全局 job registry。

```text
具体领域 owner operation/task/run
  -> foundation execution handle
  -> owner-local/native state
  -> old job id compatibility projection
  -> runtimeHost.jobGet + runtime-job:done/progress
```

`runtime-job:done` 是低延迟通知；`runtimeHost.jobGet` 是丢事件、竞态和恢复的可查询路径。它不是 cron、session、connector、diagnostics 或 usage 的事实源。
