# Runtime Host Owner / State Model

> 从当前 TS、Electron、peer runtime 与 Rust 代码重建的事实源与责任边界；除本轮显式批准的 call-log/Calls 与具体 admit consumer 外，不改变既有客户端 API。
>
> 本目录不是 Rust crate 设计，也不是当前 `runtime-host/` 资产的认可清单。owner/state 关系必须由 active code 与迁移账本共同裁决。

## 渐进式阅读

| 问题 | 文档 |
| --- | --- |
| 系统中有哪些事实源、owner 和状态平面？ | [owners.md](owners.md) |
| desired、persisted、applied、observed 分别在哪里？ | [state-sources.md](state-sources.md) |
| peer runtime、Host facade、integration 和 platform 如何分工？ | [peer-boundaries.md](peer-boundaries.md) |
| 当前 Rust 资产能证明什么、不能证明什么？ | [rust-asset-status.md](rust-asset-status.md) |
| 哪些问题阻塞后续模型与切换裁决？ | [open-items.md](open-items.md) |

## 与契约基线的关系

先读 [runtime-host-contract-v1/README.md](../runtime-host-contract-v1/README.md)。

```text
外部契约基线
  -> owner / fact source / state mapping
  -> Rust final model
  -> crate / module layout
  -> owner cutover
  -> 删除旧 TS owner
```

外部契约基线固定客户端可观察行为；本目录只回答“谁拥有事实、状态如何变化、Rust 应负责哪一层”。

## 状态词的严格含义

```text
desired    用户或 Renderer 请求的目标状态
persisted  已写入该 owner 的 durable store / native store
applied    已投影给下游 runtime、Gateway 或 peer 的状态
observed   从下游 runtime、Gateway 或外部系统读回的事实
```

以下关系不能省略：

```text
persisted != applied != observed
config write != runtime ready != connected != operation succeeded
```

## 证据标签

- `CONFIRMED`：源码、测试或真实调用链直接证明。
- `INFERRED`：由多个已确认调用点推导，但没有单一声明作为权威。
- `OPEN`：存在多个实现、缺少 consumer/producer 证据或需要运行时采样。
- `CANDIDATE`：Rust 已有实现可作为候选，但尚未完成客户端 cutover 证明。

## 当前硬约束

1. Renderer、Electron、preload、page/store 调用代码不因 Rust 设计任意修改；本轮显式批准的 call-log/Calls 与具体 admit consumer 除外。
2. Rust 必须提供既有 API 的相同输入、输出、错误和可观察行为。
3. Rust Host 不复制 peer-native session、run、approval、transcript、tool、model 或 lifecycle 事实。
4. 旧 generic RuntimeJob public contract 已删除：不存在 `RuntimeJobQueue` / `RuntimeJobRegistry`、`runtimeHost.jobGet`、`runtime-job:*`、generic `RuntimeJob*` DTO 或 `job_compatibility`。本轮批准统一持久 call log：`modules/call-log` 单写调用记录/history，原 owner/facade 仍拥有业务队列、执行、canonical facts、native ports 与终态；`CallId` 不替代 native/business identity，不保存通用 args/results/raw/secrets，也不 replay 未完成操作。当前源码覆盖与接线/验证 OPEN 见 [Call Log / Calls](../architecture-knowledge/modules/call-log/README.md)。[VERIFY: runtime-host/platform/src/call.rs:221-225] [VERIFY: runtime-host/modules/call-log/src/store.rs:76-95]
5. ClawHub marketplace search 是 third-party external registry lookup，不是 durable Domain owner，也不是 OpenClaw Gateway native skill RPC；安装请求仍归 Skills runtime ops，但执行方是 legacy ClawHub CLI + registry fallback。
6. Runtime address 的身份边界固定为 `RuntimeEndpoint`、`SessionIdentity(endpoint + agentId + sessionKey)` 与 `RuntimeScope`；`endpointSessionId` 是 peer-local 元数据，不是 Host identity。
7. 不能从现有 `runtime-host-rust/` 目录反推最终架构。
8. sealed skill package 是 `runtime-host` 的 host-level concrete owner/facade；OpenClaw 与 matcha-agent 是消费者。`openclaw.json` 只保存 `skills.<key>.enabled`，不保存明文 package material；加密包可存放在 `runtime-local`，OpenClaw 源码改动通过 bundle patch 投递。
9. 任何 `OPEN` 项在 owner cutover 前必须由源码、测试或运行时 trace 显式裁决。
