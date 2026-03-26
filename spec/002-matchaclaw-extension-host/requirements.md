# 需求文档 - MatchaClaw 扩展宿主与双插件体系重构

状态：Draft

## 简介

MatchaClaw 现在已经有一层平台化抽象，但还没有真正完成 VS Code 风格的“主壳层 / 工作台 / 扩展宿主”分离。

当前仓库的主要问题不是“没有抽象”，而是抽象层级还停在半路：

- `electron/main/ipc-handlers.ts` 仍然承载大量应用级行为，主进程还不够薄
- `electron/api`、`electron/core`、`electron/adapters` 已经出现平台化方向，但没有独立的 MatchaClaw 扩展宿主进程
- 渲染层页面和 store 仍然是静态编译进应用的工作台能力，不是通过扩展贡献模型注册
- `OpenClaw 插件` 与 `MatchaClaw 自身扩展` 在概念上已经区分，但在宿主边界、目录结构和调用路径上还没有被硬隔离
- 目前对 OpenClaw Gateway 的调用入口较分散，缺少一个专门面向 MatchaClaw 扩展的 `OpenClaw Bridge`

这次重构的目标不是再补一层包装，而是把 MatchaClaw 收敛成明确的双插件架构：

1. **OpenClaw 插件体系**
   运行在 OpenClaw Gateway 内，负责 Agent、Hook、Skill、Channel 等运行时能力扩展。
2. **MatchaClaw 扩展体系**
   运行在 MatchaClaw 自身的独立扩展宿主进程内，负责桌面工作台、页面、命令、菜单、应用服务扩展。

成功后的核心收益有四个：

- 主进程回到极简壳层，不再继续吸收业务复杂度
- MatchaClaw 自身功能可以像 VS Code 扩展一样按模块演进，而不是继续堆静态页面
- OpenClaw 能力通过统一 Bridge 暴露给 MatchaClaw 扩展，调用路径单一
- 后续新增渠道、任务、聊天、设置等工作台能力时，不再要求修改主进程核心骨架

## 术语表

- **System**：MatchaClaw 桌面应用
- **Main Shell**：Electron Main 进程中的宿主壳层，只负责窗口、生命周期、进程编排、最薄边界代理
- **Workbench**：Renderer 中的工作台层，负责路由、布局、扩展贡献渲染、用户交互
- **Extension Host**：独立的 Node.js 宿主进程，运行 MatchaClaw 自身扩展
- **MatchaClaw Extension**：运行在 Extension Host 中的扩展，负责工作台能力扩展
- **OpenClaw Plugin**：运行在 OpenClaw Gateway 中的插件，负责 Agent/Hook/RPC/Channel 扩展
- **OpenClaw Bridge**：Extension Host 内的基础服务，用统一 RPC/Event 模型连接 OpenClaw Gateway
- **Contribution**：扩展向 Workbench 声明的菜单、路由、页面、命令、设置项等 UI/行为注册项

## 范围说明

### In Scope

- 建立 MatchaClaw 自身的独立 Extension Host 进程
- 明确并固化双插件体系：`OpenClaw Plugin` 与 `MatchaClaw Extension`
- 在 Extension Host 内实现 `OpenClaw Bridge`，作为访问 Gateway 的统一入口
- 为 MatchaClaw Extension 定义 manifest、生命周期、上下文 API、服务注册与事件模型
- 为 Renderer Workbench 定义扩展贡献模型，包括路由、导航、菜单、命令、设置页签等注册能力
- 将 Electron Main 收敛为 Main Shell，并建立清晰的 `Main Shell -> Host API -> Extension Host` 调用边界
- 划清“共享领域逻辑”和“扩展 UI 壳层”的职责，避免把现有 `src/pages` 与 `src/stores` 的静态耦合整体平移到扩展体系
- 本期只支持 builtin extension 与本地开发扩展的前端贡献加载，同时为未来第三方远程 UI bundle 预留 manifest、加载器、权限和沙箱挂载点
- 制定从当前仓库结构迁移到目标目录结构的阶段性迁移方案
- 同步约束文档、目录职责文档和架构变更记录

### Out of Scope

- 不修改 OpenClaw 上游源码和 Gateway 内部插件机制
- 不在本期实现远程扩展市场、在线下载和签名校验完整闭环
- 不在本期实现任意第三方远程 UI bundle 的实际加载、分发、签名校验和运行时启用，只保留接口与目录挂载点
- 不把所有现有页面一次性迁完，本期允许按阶段迁移内置能力
- 不在本期引入 Rust sidecar 作为必需架构要件，Rust 仅作为未来扩展实现选项

## 需求

### 需求 1：双插件体系必须有硬边界

**用户故事：** 作为平台架构维护者，我希望 `OpenClaw Plugin` 和 `MatchaClaw Extension` 在进程、目录、职责和调用边界上清晰分离，以便后续扩展不会再次把两套系统混成一团。

#### 验收标准

1. WHEN 开发者查看项目目录和架构文档 THEN System SHALL 明确区分 `OpenClaw Plugin` 与 `MatchaClaw Extension` 的运行位置、职责和接口
2. WHEN 新增一个 MatchaClaw 扩展 THEN System SHALL 不要求把它放进 OpenClaw Gateway 插件目录，也不要求主进程直接承载其业务逻辑
3. WHEN 新增一个 OpenClaw 插件 THEN System SHALL 不要求改 MatchaClaw Workbench 扩展宿主协议，除非它需要被 MatchaClaw 以 Bridge 方式消费

### 需求 2：MatchaClaw 必须有独立的 Extension Host 进程

**用户故事：** 作为主进程维护者，我希望 MatchaClaw 自身扩展运行在独立宿主进程里，而不是继续堆进 Electron Main，以便主进程保持稳定、边界清晰，并具备扩展故障隔离能力。

#### 验收标准

1. WHEN 应用启动 THEN System SHALL 由 Main Shell 负责拉起并监控 Extension Host 进程
2. WHEN 单个 MatchaClaw Extension 激活失败或抛出未处理异常 THEN System SHALL 不导致 Main Shell 或 Renderer 直接崩溃
3. WHEN Extension Host 异常退出 THEN System SHALL 能检测、上报并按策略恢复，而不是把错误静默吞掉

### 需求 3：OpenClaw 能力必须通过统一 Bridge 暴露给 MatchaClaw Extension

**用户故事：** 作为 MatchaClaw 扩展开发者，我希望以统一方式访问 OpenClaw 的核心方法、插件方法和事件，而不用关心 Gateway 协议细节，以便扩展开发边界稳定。

#### 验收标准

1. WHEN MatchaClaw Extension 需要调用 OpenClaw 核心或插件能力 THEN System SHALL 通过 `OpenClaw Bridge` 提供统一 `call/on/off` 模型
2. WHEN Gateway 方法或事件来自 OpenClaw 核心与 OpenClaw 插件 THEN System SHALL 保持对扩展开发者的调用方式一致
3. WHEN Renderer 需要访问扩展经 OpenClaw Bridge 暴露的结果 THEN System SHALL 经由 Main Shell / Host API / Extension Host 标准链路访问，而不是直接从 Renderer 连接 Gateway
4. WHEN Renderer 发起扩展相关请求 THEN System SHALL 先转换为 Host API 定义的受控能力调用，而不是把 Extension Host 的内部 API 透传到 Renderer

### 需求 4：Workbench 必须基于扩展贡献模型渲染

**用户故事：** 作为桌面应用功能开发者，我希望页面、菜单、命令、设置入口等工作台能力由扩展声明式贡献，而不是硬编码在根应用里，以便后续新增能力不必继续修改 App 骨架。

#### 验收标准

1. WHEN 一个 MatchaClaw Extension 声明路由、侧栏菜单、命令或设置分组 THEN System SHALL 能把这些贡献注册到 Workbench
2. WHEN Workbench 渲染导航结构 THEN System SHALL 基于贡献快照生成，而不是只依赖静态页面枚举
3. WHEN 单个扩展的前端贡献加载失败 THEN System SHALL 仅隔离该贡献区域，并保留工作台其它部分可用

### 需求 5：Electron Main 必须收敛为 Main Shell

**用户故事：** 作为架构维护者，我希望 Electron Main 只保留窗口、托盘、更新、系统能力和进程编排，而不继续吸收应用业务决策，以便系统复杂度不再沿着主进程失控增长。

#### 验收标准

1. WHEN 开发者检查 Main Shell 代码 THEN System SHALL 只保留宿主壳层职责和最薄的协议转发
2. WHEN 新增聊天、任务、渠道、设置等应用业务 THEN System SHALL 优先落到 Extension Host 或 Workbench 服务，而不是先加到 `ipc-handlers.ts`
3. WHEN 主进程暴露给 Renderer 的能力增加 THEN System SHALL 通过固定边界层扩展，而不是继续增加无约束的直连 IPC 杂项
4. WHEN Renderer 访问扩展能力 THEN System SHALL 由 Main Shell / Host API 暴露稳定宿主契约，而不是允许 Renderer 直接面向 Extension Host 内部方法编程

### 需求 6：重构必须支持渐进迁移，而不是一次性推倒

**用户故事：** 作为当前仓库维护者，我希望这次架构重构能分阶段迁移现有能力，以便在不中断现有产品可运行性的前提下完成切换。

#### 验收标准

1. WHEN 开始引入 Extension Host THEN System SHALL 允许现有静态页面和新扩展贡献在一段时间内并存
2. WHEN 某个内置能力从静态实现迁移到 MatchaClaw Extension THEN System SHALL 提供清晰的迁移边界、回滚点和验证路径
3. WHEN 阶段性迁移尚未完成 THEN System SHALL 保持单一事实源，不允许新旧两套业务逻辑长期并存且互相漂移
4. WHEN 现有页面迁入 builtin extension THEN System SHALL 先拆出共享领域逻辑，再由扩展 UI 壳层消费，避免旧页面状态和扩展壳层重新耦合

### 需求 7：架构重构必须补齐观测、日志和故障语义

**用户故事：** 作为长期维护者，我希望扩展发现、激活、调用、Bridge 通信和故障恢复都有可观测证据，以便后续排障不再靠猜。

#### 验收标准

1. WHEN Extension Host 启动、扩展激活、Bridge 连接或调用失败 THEN System SHALL 记录结构化日志和明确错误语义
2. WHEN Workbench 贡献快照更新或扩展状态变化 THEN System SHALL 有统一事件和状态模型可追踪
3. WHEN 发生扩展崩溃、调用超时、Bridge 断连 THEN System SHALL 定义用户可见降级策略和开发侧排查入口

## 非功能需求

### 非功能需求 1：性能

1. WHEN 应用冷启动 THEN System SHALL 在不明显劣化现有首屏交互时间的前提下拉起 Extension Host，并允许扩展分阶段激活
2. WHEN Renderer 请求扩展贡献快照或调用扩展命令 THEN System SHALL 保持单次调用延迟在可交互范围内，不引入明显卡顿
3. WHEN 扩展数量增长 THEN System SHALL 通过按需激活、分层加载和缓存策略控制启动与运行时开销

### 非功能需求 2：可靠性

1. WHEN 单个 MatchaClaw Extension 故障 THEN System SHALL 优先隔离到该扩展，不把故障扩散到 Main Shell 与 Workbench 全局
2. WHEN OpenClaw Gateway 未就绪、重启或暂时断连 THEN System SHALL 允许 Bridge 进入降级状态，并对扩展返回一致错误语义
3. WHEN 应用升级或内置扩展迁移 THEN System SHALL 提供兼容窗口或明确切换计划，避免工作台结构随机失效

### 非功能需求 3：可维护性

1. WHEN 新增工作台能力 THEN System SHALL 有明确归属：Main Shell、Workbench 服务、Extension Host、OpenClaw Plugin 其中之一
2. WHEN 开发者排查问题 THEN System SHALL 能沿 `Renderer -> Host API -> Main Shell -> Extension Host -> OpenClaw Bridge -> Gateway` 链路追踪
3. WHEN 目录结构变更 THEN System SHALL 同步维护文档和边界说明，避免系统失忆
4. WHEN `electron/main` 语义迁移为 `electron/shell` THEN System SHALL 同步更新目录职责说明、启动链路和开发文档，避免“路径名还是 Main、职责已经变 Shell”这种认知漂移

### 非功能需求 4：安全性

1. WHEN MatchaClaw Extension 调用宿主能力 THEN System SHALL 仅通过显式暴露的上下文 API 访问，不允许随意触达主进程私有能力
2. WHEN Renderer 与扩展通信 THEN System SHALL 继续遵守 `host-api/api-client` 单一入口约束
3. WHEN 未来引入第三方扩展 THEN System SHALL 已预留权限、能力白名单和签名校验的挂载点
4. WHEN 未来启用第三方远程 UI bundle THEN System SHALL 复用本期预留的 manifest、加载器、权限和沙箱挂载点，而不是另起一套平行机制

## 成功定义

- 仓库中新增一套可落地的 MatchaClaw Extension Host 架构说明，而不是继续把“扩展化”停留在口头层面
- `OpenClaw Plugin` 与 `MatchaClaw Extension` 的边界被写成硬规则，后续开发不再混淆
- 未来主进程新增业务功能时，默认路径从“加 IPC/加主进程逻辑”变成“加扩展 / 加工作台服务”
- 至少有一条清晰的迁移路径，能把现有聊天、任务、渠道、设置等能力逐步迁入扩展模型
- 第一批 builtin extension 迁移名单明确为 `chat / tasks / channels / settings`
- 文档、任务和目录责任说明能够支持后续多人接手，而不是只对当前上下文有效
