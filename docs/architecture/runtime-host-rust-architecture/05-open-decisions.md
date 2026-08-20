# 05. 设计前置条件与开放裁决

这些项目按当前证据分为：

- `CONFIRMED`：架构边界已经可以直接作为实现依据；
- `OPEN`：需要运行时采样或逐 owner 设计，但不阻断无关业务 block；
- `BLOCKED`：存在两个 active seam 或事实源冲突，不能宣称替代完成。

Foundation 的 in-process execution 机制已经确认；未决的只是跨平台 process custody 细节，不应阻断使用 `OwnedTask<T>`、`OperationHandle<T>`、`ServiceHandle<T>` 开发业务 owner。

| ID | 状态 | 需要裁决 | 关闭标准 |
| --- | --- | --- | --- |
| `A-01` | `BLOCKED` | DirectRuntimeHost/framed/signed transports 与 `/dispatch` 的 active/替代关系 | Electron route trace、同一 operation mapping、old seam deletion boundary |
| `A-02` | `CONFIRMED` | Electron child lifecycle 与 Rust peer lifecycle 的 exact ownership | launch/ready/stop/restart/crash trace；两层 state matrix |
| `A-03` | `BLOCKED` | parent callback 的 Rust concrete client | token、version、timeouts、accepted/error、best-effort recorder |
| `A-04` | `CONFIRMED` | Renderer capability descriptor 与 signed decision 保持双层，不互相替代 | list/describe/execute 与 signed transport 的逐 route mapping |
| `A-05` | `OPEN` | `/api/channels/snapshot` 保持 public route，native channel status 作为 source adapter | runtime payload sampling、unchanged Renderer trace |
| `A-06` | `OPEN` | gateway:channel-status wrapper/native shape 保持 opaque，禁止 unwrap/rewrap | login/native 两路径实测 trace |
| `A-07` | `CONFIRMED` | settings/security/license 保持三个独立 owner；Rust projection 不等于 native authority | 各 owner 的后续实现与行为映射 |
| `A-08` | `OPEN` | 禁止隐式 seq/run/message crosswalk；Matcha adapter 单独定义；大 transcript 保持 bounded/incomplete 语义 | replay/hydration fixture、gap/overflow/restart/unknown matrix |
| `A-09` | `OPEN` | 当前 Rust SessionProjection 不宣称覆盖 TS canonical client projection | Renderer consumer inventory、snapshot/window/event differential |
| `A-10` | `OPEN` | Unknown 按具体 operation owner 处理，不通用映射为 succeeded | 每个 async consumer 的 terminal/recovery matrix |
| `A-11` | `BLOCKED` | connector v1/v3/schema/secret/status parity 尚未闭合 | version fixture、single writer、MCP probe/readback matrix |
| `A-12` | `CONFIRMED` | Fleet runtime-agent ingress、Fleet command 与 Organization webhook/Team ingress 分离 | 各 external ingress 的后续协议实现 |
| `A-13` | `CONFIRMED` | Organization 通过 typed effect ports，由 Host composition 注入，不直接依赖 peer crate | 各 port 的真实 consumer/source walk |
| `A-14a` | `CONFIRMED` | Foundation in-process execution：`OwnedTask` / `TaskHandle` / `OperationHandle` / `ServiceHandle` 可供业务 owner 复用，不拥有 RuntimeJob facts | 已确认：继续作为底层机制使用 |
| `A-14b` | `OPEN` | Foundation platform-specific process custody mechanisms | Windows/POSIX implementation evidence、fault smoke 和实际 peer consumer |
| `A-15` | `BLOCKED` | final physical workspace move and package artifact | 单一 `runtime-host/` workspace、artifact path、Electron launch plan、旧目录不可达 |

## 当前设计状态

```text
外部契约基线       已建立
Owner/state mapping 已建立
Rust architecture   主要边界已确认；A-01/A-03/A-11/A-15 阻塞，A-05/A-06/A-08/A-09/A-10/A-14b 开放
Foundation execution 已确认，可供业务 owner 使用
Rust crate实现      按真实 owner block 继续推进
业务 owner cutover  按各 owner 的实际行为和 active path 单独判断
```

`OPEN` 只影响对应 owner 的下一步设计或运行时取样，不阻断无关业务 block。`BLOCKED` 表示该边界存在冲突，不能宣称已替代，但也不要求暂停其他 owner 的独立开发。

任何项目关闭时都记录：现行行为 → Rust owner → 兼容 projection → 失败/恢复 → 旧 owner 处理方式。不得用 fallback、dual write 或 shadow state 隐藏冲突。
