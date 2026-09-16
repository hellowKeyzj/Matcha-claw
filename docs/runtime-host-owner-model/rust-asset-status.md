# 当前 Rust 资产状态

> 这是现有实现的证据分类，不是保留清单。`CANDIDATE` 只表示有可复用的局部机制；不表示当前目录、crate 或 public DTO 已被冻结。

## 1. 可以复用的机制

| 机制 | 当前资产 | 证据结论 | 状态 |
| --- | --- | --- | --- |
| Host actor boundary | `host/src/owner.rs`、`host/src/owner/actor.rs` | transport/control 通过 Handle 串行进入 actor-owned Host；这是 Host mutable state serialization，不是业务事实 owner | CANDIDATE |
| Host admission/read projection | `host/src/composition/admission.rs`、`host/src/control/lifecycle.rs`、`diagnostics.rs` | `HostState.ok` 只来自 Host phase Ready；Gateway health/control readiness 与 peer lifecycle 分字段读取 | CANDIDATE |
| Foundation execution mechanism | `foundation/src/execution/*` | `OwnedTask`、`OperationHandle`、`ServiceHandle` 提供 cancellation/join/owned task 生命周期；不拥有业务事实或 Host-wide generic operation | CONFIRMED |
| Matcha protocol client | `integrations/matcha-agent/src/session/client/*` | session/load/transcript/snapshot/replay/subscribe client | CANDIDATE |
| Matcha hydration | `integrations/matcha-agent/src/session/hydration/*` | strict decode、bounded projection、unknown/incomplete | CANDIDATE |
| Event cursor/projector | `integrations/matcha-agent/src/session/events.rs` | session/run binding、gap/duplicate/stale rejection | CANDIDATE |
| OpenClaw connector projection | `integrations/openclaw/src/projection/connector/*` | desired/applied projection、readback、safe outcome mapping | CANDIDATE |
| Revisioned connector store | `domains/environment/src/connector_store.rs` | lock、atomic write、revision、recovery outcome | CANDIDATE |
| Typed cron provider | `integrations/openclaw/src/cron/provider.rs` | native cron command mapping and typed unknown outcome | CANDIDATE |
| Diagnostics archive | `host/src/diagnostics/archive/*` | bounded/redacted/atomic archive and opaque receipt | CANDIDATE |
| Signed authorization verifier | `host/src/transport/authorization.rs` | signed decision exact binding、expiry、replay protection | CANDIDATE |

## 2. 当前不能当作最终 owner 的资产

| 资产 | 不能直接推导出的结论 |
| --- | --- |
| `host/src/composition/host/mod.rs` | 不能证明 Host 应拥有全部业务事实；它当前是 composition container |
| `host/src/owner.rs` | 不能证明全局 actor 等于业务 owner；只是 mutation serialization boundary |
| `host/src/transport/*` | 不能证明这些 fixed transports 已接入 Electron 当前 Host API |
| `domains/*` | 不能证明当前 domain 划分就是最终 workspace/crate 划分 |
| `integrations/openclaw/*` | 不能证明 settings/security/license/channel/cron 的完整 native authority 已迁移 |
| `integrations/matcha-agent/*` | 不能证明 Rust 已拥有 transcript writer 或 canonical UI state |
| Rust connector status | 不能替代 TS 主动 MCP HTTP probe；当前 HTTP status 会是 `Unknown` |
| Rust capability directory | 不能替代 TS dynamic descriptor/router；当前与 `control/dispatch.rs` 还有重复与 drift |
| Rust process entrypoint | 不能证明 Electron adapter 已能启动它；当前 Electron 仍启动 Node/TS child |

## 3. 已确认的 Rust/TS 接缝缺口

1. Electron 当前通过 `DirectRuntimeHost` 启动 Rust executable，使用 stdin/stdout bootstrap/private control readiness；这证明 delivery active path，不证明全部 legacy `/dispatch`/product route cutover。
2. Rust Host 到 Electron parent callback 的 base URL/token/client/receiver 已接入；session/owner-event payload 与 owner-specific recovery wiring 尚未完整闭合。
3. Rust provider-models/external-connector transport 会在 Rust control loop 中启动，但 full Electron public route/unchanged-client cutover 尚未证明。
4. Rust fixed capability descriptors 有两套 construction，内容不一致；TS `bootstrap` scope 也未对齐。
5. TypeScript connector schema version 1 与 Rust version 3 的双向兼容未证明。
6. TypeScript secret references 与 Rust strict connector schema 不一致，private projection/resolver 未闭合。
7. Rust Matcha public timeline 当前 `run_id` / `sequence` 为空，尚无正式 seq crosswalk。
8. canonical state 没有独立 durable snapshot；当前是由 transcript/live events rebuild 的内存 projection。
9. 已删除项：generic RuntimeJob public contract 已从 TS composition 删除；各具体 owner 的 accepted-only completion projection 仍需分别完成 owner/facade typed operation query/event 与 recovery/readback 证明。Toolchain install 不走该 projection，而由 Electron adapter 等待 Rust private native result。
10. Foundation `execution` 已提供 `OwnedTask`、`TaskHandle`、`OperationHandle`、`ServiceHandle`；它是业务后台 operation 的生命周期机制，不是 Host-wide generic operation owner。

## 4. 资产处理规则

- 先保留可证明的机制和测试 oracle；
- 再按 owner/state mapping 重命名或重组；
- 不为迁移方便保留错误的 owner；
- 不因 Rust 已有类型而改变外部契约；
- 不在没有 cutover proof 的情况下删除 TS owner；
- 不把 compatibility projection 当作 canonical fact store。
