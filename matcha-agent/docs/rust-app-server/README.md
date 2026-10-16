# Rust App Server 开发基线

状态：独立 Rust Server 已实现，此前 Host 原生接入已有 Windows x64 构建、类型与所列非模型链路证明；后续默认 Agent / 目录及合同修正须单独计增量验证，不能沿用此前成绩。Electron UI / 收费模型 E2E 未验。更新日期：2026-10-17。Server 共享接口见 [contracts.md](contracts.md)，当前验证、保留失败与未验范围见 [progress.md](progress.md)。

面向后续并行开发 Agent。这里记录已经讨论对齐的目标、源码能力边界与开发约定，不把规划当成当前架构，也不授权直接开始编写全部模块。

## 1. 已对齐的目标

- 独立、常驻的 Rust App Server，提供完整的 Matcha Agent 管理能力；`runtime-host` 是客户端/integration，不承接服务端业务 owner。
- 对照 OpenClaw 的完整管理面查漏，不以旧 TS app-server 或当前 runtime driver 支持范围作为功能上限。
- 现有 CLI 继续负责 Agent Loop、模型请求、工具执行、上下文、原生子 Agent/Team 及 transcript；已按真实缺口修复构建/配置持久化并补原生控制入口，不重写执行引擎。
- 所有功能按真实职责模块化；共用轻量异步机制，不默认每模块一个 crate、进程、线程、actor、数据库或 trait。
- 多 CLI 会话可以并行；同一会话的执行与事实顺序明确。代码精简、高效，不堆策略框架，不暗自增加配额、超时、自动重试或功能限制。
- 每个 Agent 有自己的一个工作目录；该目录内不再引入产品级 Project 层次。不同 Agent 不默认共用 workspace。
- 从首次实现起保留真实异常分支、具体错误与因果链；轻量不等于吞错、合并结果或延后补齐失败路径。
- 对外采用 WebSocket + JSON-RPC 2.0；HTTP 承担健康/版本及需要时的文件传输；内部 CLI 协议不公开穿透。

## 当前接入形状

```text
Renderer / Electron 既有 API + RuntimeScope
  → Host 业务 owner → endpoint-selected typed ops
  → MatchaRuntimeDriver::native_client() → peer 共享 Client
  → 独立 Rust App Server → 原生 CLI
```

- Server 是 Agent / Session / Run、durable events 和资源管理 owner；CLI 仍是执行与 transcript 事实源，Host 只消费安全投影，不建立 transcript shadow 或任意 native RPC 透传。
- integration 使用 `matcha-app-server-v1` 的 JSON-RPC 控制连接及独立 Session replay/live 订阅；业务 adapter 复用同一个 Client，不重建传输或盲重试写请求。
- 产品 GET 使用 JSON query `scope`，内部将 endpoint 传到 typed owner lookup；OpenClaw 与 Matcha 是独立 peer，不按 first/default/fallback 选 runtime，也不合并两者 usage。Provider / MCP 私密值只走内存投影，持久配置保留引用。
- 此前接入的真实非模型验证覆盖独立 Server / CLI、Host typed 基础管理与 owned lifecycle、Team 物化/角色投影/普通 Session/取消删除及 durable 清理，以及本地 sealed 二进制上传、加密/CAS、scoped status/merged。Host 授权 sealed membership 已验（raw enabled=true / typed disabled=false），selectable/eligible 仍 false；card 仅表达“已安装并启用·当前会话加载未确认”，不开放 toggle，也不证明新 CLI 已加载或执行技能。
- Host 验证使用真实 issuer/bootstrap/control/transport，Bun 仅提供访问即抛错的 `electron.app` 静态外壳，不是 Electron 主进程/UI E2E。构建、既有测试、真实动态、保留失败与未验项分列于 [progress.md](progress.md)；旧独立 Server 模型成绩不计本轮，不能由 Supported family、编译或资源目录推断完整可用。

## 2. 分层阅读

| 文档 | 唯一关注点 | 谁必须读 |
|---|---|---|
| [architecture.md](architecture.md) | 边界、owner、模块框架与依赖 | 所有实现 Agent |
| [capabilities.md](capabilities.md) | 当前源码支持、接入方式、缺口与条件 | 相关业务模块 Agent |
| [runtime-layout.md](runtime-layout.md) | 运行家目录、Agent workspace、配置与数据归属 | 配置、存储、CLI、Session Agent |
| [protocol-execution.md](protocol-execution.md) | 客户端协议、多会话并发、事件、进程管理 | 网关、执行、Session、Run、事件 Agent |
| [diagnostics.md](diagnostics.md) | 具体错误、结果语义、因果关联、诊断 | 所有实现 Agent |
| [development.md](development.md) | 命名、目录、共享契约冻结、并行分工与验证 | 所有实现 Agent |

无需为一个叶子功能重读所有长文；入口、架构、开发约定和诊断约定必读，其余按任务依赖读取。

## 3. 设计状态的含义

- **已定**：本轮用户明确对齐的目标与边界，不允许子任务自行改裁。
- **基线**：用于后续落地的具体设计形状；精确字段/接口未冻结前，不得据此生成下游实现。
- **OPEN**：仍需源码或接口设计闭合，不代表功能无须实现，也不代表已经支持。
- **FROZEN**：具体 owner 在对应文档记录了可供下游编译的接口、状态、错误、路径与验证边界。不能仅凭聊天中的 JSON/目录示例宣称冻结。

本目录不是完整协议规范；生产源码落点、Cargo 工程、首次运行配置及共享接口、错误码和存储机制已在 [contracts.md](contracts.md) 冻结。方法专有 DTO 以对应 owner 源码和 [使用说明](../../app-server/README.md) 为准，不预设额外资源限制。

## 4. 事实源

- 当前生产入口：[Rust App Server](../../app-server/README.md) 与 [Host integration](../../../runtime-host/integrations/matcha-agent/src/lib.rs)；历史参考：[Matcha Agent 架构](../matcha-agent-architecture.md)、[TS app-server 架构](../matcha-agent-app-server-architecture.md)，不能据旧文档判断当前 Server owner 或能力上限。
- 能力最终依据：当前 [src](../../src/) 及真实调用到的 [packages](../../packages/)，不是类型声明、目录名或命令名称。
- OpenClaw 对照：[原生方法表](../../../docs/openclaw-source/src/gateway/methods/core-descriptors.ts)、[模块装配](../../../docs/openclaw-source/src/gateway/server-methods/core-handlers.ts)。本地源码快照不证明当前安装包全部能力可用。
- 代码质量：[编码宪法](../../../CODING_CONSTITUTION.md)；Rust 命名与职责组织参考 [Rust 代码规范](../../../RUNTIME_HOST_TS_RUST_IMPLEMENTATION_STANDARD.md)。参考其工程原则，不继承旧 runtime-host 的全部实现层级。
- 新文档与当前实现矛盾时，先区分“目标改变”与“事实错误”。不静默改写旧协议，不把设计目标写进现状文档当作完成。

## 5. 开发启动条件

主代理先确定本次可交付 block，并冻结该 block 的共享面：入口、owner、输入输出、状态/错误、配置路径、旧路径处理与验证。随后按独占文件/模块并行；无需等全平台所有接口一次性设计完，但任何下游不能猜测它依赖的 OPEN 契约。

独立 Rust Server 已进入 Host 原生接入；本目录 contracts.md 记录 Server 基线，本轮接入接口以实际 owner 源码及调用链为准，未闭合项不推定支持。模块写完、集成编译通过、真实链路验收分别记录，不提前声明全功能完成。
