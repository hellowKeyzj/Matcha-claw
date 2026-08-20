# Owner/state 开放项

这些项目不是 Rust 设计偏好，而是当前源码、运行时行为或两套实现之间仍缺少的事实裁决。未关闭前不得把对应 Rust asset 宣称为最终 owner。

| ID | 开放项 | 影响 | 关闭所需证据 |
| --- | --- | --- | --- |
| `O-01` | Electron 已通过 `DirectRuntimeHost` 启动 Rust executable：stdio bootstrap/private control 为当前 active launch path；仍缺完整 delivery compatibility、restart/fault 与 product route 证明 | 全部 Rust cutover | production launch trace、bootstrap/env/port mapping、private control readiness、graceful stop/restart/fault trace、legacy compatibility route proof |
| `O-02` | Rust → Electron parent callback 的完整事件/job wiring 尚未闭合；base URL/token/client/receiver 已接入，但不能替代各 owner payload/恢复证明 | shell、gateway event、runtime-job projection | parent callback recorder + token/timeout/response validation trace + owner-specific event/job recovery proof |
| `O-03` | TS capability execute 与 Rust fixed transports 的最终 authority 和兼容范围 | 所有 capability、scope、target、authorization | Renderer request matrix、Rust response matrix、正式 signed-decision mapping |
| `O-04` | `policyScope`、`ownerModuleId`、`routeOwnerId` 是否只是 metadata 还是授权边界 | capability security | source + policy decision + negative test proof |
| `O-05` | `gateway:channel-status` 的真实 payload shape | channel event compatibility | real runtime event trace，覆盖 login wrapper 和 native status 两路径 |
| `O-06` | TS `/api/channels/snapshot` 与 Rust channel route 的兼容投影 | Channels page/store | unchanged Renderer trace；字段、错误、空值和事件恢复矩阵 |
| `O-07` | `gateway.auth.token` 如何通过 Rust private config projection | settings/OpenClaw apply | secret-safe write/readback proof；禁止写入 public config projection |
| `O-08` | Settings JSON、security policy、license durable paths 与最终 native authority | settings/security/license cutover | owner source walk、read/write/apply/readback trace |
| `O-09` | Session legacy JSONL、app-server events、snapshot、canonical projection 的 seq crosswalk | history/live event parity；Matcha/OpenClaw native history 已能生产 source-backed `Incomplete(SessionView)`，Matcha/OpenClaw live delta 已接入 Host apply；但 source epoch/cursor、Host seq/cursor、eventId、runId/messageId 与 recovery marker 的完整跨层语义仍未形成 cutover 证明 | seq/run/message compatibility fixture；大 transcript 超限语义；Host-local epoch/cursor 与 peer source epoch/cursor 的 crosswalk（不能把 chat seq 当 cursor）；`eventId` 语义；Matcha source epoch/generation；OpenClaw epoch/gateway sequence 贯穿 Host；跨 provider mismatch proof；gap/duplicate/restart/overflow/disconnect end-to-end recovery oracle；不能以 integration seam 或 `session.delta` Electron bridge 代替 Host cutover |
| `O-10` | Rust Matcha/OpenClaw public timeline 只能给 bounded/incomplete native projection，不能冒充完整 canonical transcript/timeline | Renderer timeline compatibility；`host/src/session_timeline.rs` 已从 native bounded facts 生产 `Incomplete(SessionView)` 并经 `/api/sessions/load|window` 交付；Matcha/OpenClaw snapshot assembler 当前都明确 `Incomplete`；旧 command-response snapshot patch 与 legacy bridge/compat surface 仍需单独裁决 | unchanged-client consumer audit；必要时定义 adapter-only mapping，不改 client；完整/不可用 fixture 的一致结果；删除或证明不可达的旧 fallback、snapshot patch 与 rich timeline legacy writer；recovery/restart/Windows/package proof；不得以 bounded history/transport 或 integration seam 代替 Host cutover |
| `O-11` | generic RuntimeJob 如何由每个具体 owner 投影到旧 job API | diagnostics、connector status、cron 及 Toolchain 等 async API | 各保留 owner 的 state/receipt 与旧 API recovery harness；Toolchain 必须保留 `hostUvInstallAll` 的异步 `RuntimeJobSubmission`、`runtimeHost.jobGet` 与 `runtime-job:done/progress` 兼容投影；private control command 不暴露给 Renderer，不建立 Host-wide job owner |
| `O-12` | Rust diagnostics archive 与 TS `diagnostics.collect` 是否是同一 public behavior | diagnostics compatibility | unchanged Renderer trace、parent snapshot、archive receipt/download/error matrix |
| `O-13` | Connector schema v1/v3、secret references、OpenClaw private projection 的最终迁移协议 | external connectors | two-version fixture、secret resolver proof、single-writer cutover plan |
| `O-14` | Rust connector observed status 是否实现 TS 主动 MCP HTTP probe 语义 | connector management/session status | probe timeout/error/content-type matrix；session Gateway status matrix |
| `O-15` | Remote Fleet、Team webhook、runtime-agent ingress 的最终 external API owner | non-Renderer ingress | separate ingress contract and lifecycle/terminal trace |
| `O-16` | platform/diagnostics 的 process and filesystem ownership | operational APIs；Toolchain process/path owner 落在 OpenClaw Integration + Foundation execution，public adapter 与 owner-local terminal projection 仍在接线 | process ownership proof、path/permission/redaction fixture；Toolchain native fault/integration、Windows/package 与旧 owner 清理证据仍未闭合 |
| `O-17` | Rust workspace/crate/module最终边界 | implementation layout | 本目录所有 owner 表关闭到可执行切换块后再设计；不得按现有半成品目录直接扩展 |

## 关闭规则

每个开放项必须同时具备：

1. 当前 TS/Electron/peer 行为的证据；
2. Rust wire/owner 模型的明确映射；
3. 未修改 Renderer/Electron 的兼容验证；
4. 旧 owner 的停止条件，避免双 owner/双写；
5. 失败、超时、断连、结果未知和事件丢失语义。

`OPEN` 项不能通过“加一个 fallback”隐藏。没有证据时保持 `Unknown` 或明确阻塞 cutover。
