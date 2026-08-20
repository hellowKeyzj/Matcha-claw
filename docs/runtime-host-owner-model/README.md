# Runtime Host Owner / State Model

> 在不修改 Renderer、Electron、preload、page UI 和既有客户端 API 的前提下，从当前 TS、Electron、peer runtime 与 Rust 代码重建的事实源与责任边界。
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

1. Renderer、Electron、preload、page/store 调用代码不因 Rust 设计而修改。
2. Rust 必须提供既有 API 的相同输入、输出、错误和可观察行为。
3. Rust Host 不复制 peer-native session、run、approval、transcript、tool、model 或 lifecycle 事实。
4. Rust 不重建 Host-wide 通用 `RuntimeJobQueue` / `RuntimeJobRegistry`；只保留旧客户端需要的完成投影。
5. Runtime address 的身份边界固定为 `RuntimeEndpoint`、`SessionIdentity(endpoint + agentId + sessionKey)` 与 `RuntimeScope`；`endpointSessionId` 是 peer-local 元数据，不是 Host identity。
6. 不能从现有 `runtime-host-rust/` 目录反推最终架构。
7. 任何 `OPEN` 项在 owner cutover 前必须由源码、测试或运行时 trace 显式裁决。
