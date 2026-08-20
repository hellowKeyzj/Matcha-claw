# Open items and observed drift

These are factual mismatches or missing proof discovered during baseline construction. They are **not** permission to change Renderer/Electron during the Rust migration. Each must be explicitly decided at the relevant owner/transport cutover.

| ID | Observation | Evidence | Required disposition |
| --- | --- | --- | --- |
| `T-01` | **RESOLVED：** Electron 主进程 → child `/dispatch` 的兼容默认超时采用源码实际值 `30s`；旧文档的 `15s` 已过时。CLI caller 的 `15s` 是另一层调用策略，不改变 Electron contract。 | [runtime-host-transport-v1.md](../runtime-host-transport-v1.md#L91-L97)、[runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L12-L13) | 已按 `30s` 更新旧 transport 文档；不要与 child → parent shell/event timeout 混淆。 |
| `T-02` | **澄清完成：** child 收到超过 1 MB 的 `/dispatch` 请求时返回 `413 / PAYLOAD_TOO_LARGE`；这是 child 对输入的业务无关拒绝，不是 Renderer 新错误。shared union/旧文档漏记。 | [dispatch-envelope.ts](../../runtime-host/api/dispatch/dispatch-envelope.ts#L3-L38)、[transport-contract.ts](../../runtime-host/shared/transport-contract.ts#L5-L24) | 基线按实际 wire 行为记录；Rust 应兼容该响应。无需修改 Renderer。 |
| `T-03` | **澄清完成：** `INVALID_TRANSPORT_PAYLOAD` 只在 Electron 解析到 child 的非法响应时由 Electron 本地生成；它不是 Rust 应主动返回的 child error。 | [runtime-host-client.ts](../../electron/main/runtime-host-client.ts#L53-L91) | 作为 Electron client-side validation error 单独记录；Rust 只需始终返回合法 v1 envelope。无需修改 Renderer。 |
| `T-04` | **裁决完成：** child health 状态与 Electron process-manager 状态属于不同层；不能共用一个 enum。 | [runtime-host-transport-v1.md](../runtime-host-transport-v1.md#L28-L35)、[transport-contract.ts](../../runtime-host/shared/transport-contract.ts#L44-L51)、[lifecycle.md](lifecycle.md) | child 保留 `starting/running/stopping/stopped/error`；Electron 可有 `idle/restarting`。Rust 实现 child 层，不能把 parent 状态塞进 `/health`。 |
| `T-05` | **验证缺口：** 现有测试 harness 没有接收并记录 production 的 `/internal/runtime-host/runtime-jobs`，而 child 会吞掉 callback 失败。 | [runtime-host-api-harness.ts](../../tests/contract/helpers/runtime-host-api-harness.ts)、[runtime-host-composition.ts](../../runtime-host/composition/runtime-host-composition.ts#L97-L104) | 不是产品 API 选择；在 Rust 接管异步 operation 前补录制/断言，证明旧 Renderer 能收到或通过 `jobGet` 恢复。 |
| `T-06` | `gateway:channel-status` 可能被包装成 `{ eventName, payload, updatedAt }`，但一个 Renderer consumer 读取根级 `channelId/status`。 | [openclaw-channel-login-session-service.ts](../../runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts)、[gateway.ts](../../src/stores/gateway.ts#L250-L259) | 仍需实际运行 trace 确认；在确认前 Rust 不得自行 unwrap 或重新包装。 |
| `T-07` | `gateway:notification` and `team:event` are allowlisted/bridged but no confirmed active child producer/Renderer consumer found in this static pass. | [parent-transport-contracts.ts](../../runtime-host/shared/parent-transport-contracts.ts#L9-L21)、[host-event-bridge.ts](../../electron/main/host-event-bridge.ts) | Mark as allowlisted opaque compatibility surface until proven dead or active. Do not silently remove. |
| `T-08` | `POST /api/runtime-connectors/{connect,disconnect}` has Renderer wrapper but child currently returns explicit legacy rejection; Electron public allowlist does not list it. | [host-api.ts](../../src/lib/host-api.ts#L578-L598)、[runtime-topology-routes.ts](../../runtime-host/api/routes/runtime-topology-routes.ts#L35-L43)、[route-boundary.ts](../../electron/api/route-boundary.ts#L190-L217) | Preserve current observed failure or make an approved client/API change; do not “fix” it opportunistically in Rust. |
| `T-09` | Some child business paths overlap Electron main-owned paths (especially gateway). | [gateway-routes.ts](../../runtime-host/api/routes/gateway-routes.ts#L16-L21)、[route-boundary.ts](../../electron/api/route-boundary.ts#L13-L38) | Classify actual public route owner before each cutover; child registration alone is insufficient. |
| `T-10` | Team webhook and remote-agent ingress are child external APIs outside Renderer Host API compatibility. | [team-runtime-webhook-routes.ts](../../runtime-host/api/routes/team-runtime-webhook-routes.ts)、[remote-fleet-runtime-agent-ingress-route.ts](../../runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route.ts) | Include them in server replacement scope, but test separately from Renderer APIs. |

## Resolution rule

For an `OPEN` item:

1. cite current client and server evidence;
2. decide whether the current observed behavior or a separately approved API migration wins;
3. update baseline doc, executable contract test and implementation in the same owner block;
4. never hide a decision by adding TS fallback or dual owner.
