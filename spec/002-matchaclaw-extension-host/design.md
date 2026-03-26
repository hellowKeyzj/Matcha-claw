# 设计文档 - MatchaClaw 扩展宿主与双插件体系重构

状态：Draft

## 1. 概述

### 1.1 目标

- 把 MatchaClaw 从“半平台化 Electron 应用”升级为“Main Shell + Workbench + Extension Host + OpenClaw Bridge”的明确分层结构
- 固化双插件体系：`OpenClaw Plugin` 与 `MatchaClaw Extension` 各自有独立进程归属、目录归属和接口边界
- 保留现有 `electron/core`、`electron/adapters` 平台化成果，但把它们从“主进程内部抽象”继续演进为“扩展宿主与工作台的共同基础设施”
- 以“宿主调用合同 + 宿主事件合同 + 前端模块合同”先行收束迁移边界，避免在重构期长出第二套 API、事件流和路由事实源
- 为后续把聊天、任务、渠道、设置等能力迁为内置扩展建立统一目录结构和迁移路线

### 1.2 覆盖需求

- `requirements.md` 需求 1
- `requirements.md` 需求 2
- `requirements.md` 需求 3
- `requirements.md` 需求 4
- `requirements.md` 需求 5
- `requirements.md` 需求 6
- `requirements.md` 需求 7

### 1.3 技术约束

- 后端：Electron Main、Node.js 子进程/Utility Process、TypeScript
- 前端：React 19、Vite、TypeScript、Zustand
- 数据存储：继续使用 `electron-store`、本地文件、OpenClaw 既有存储目录
- 认证授权：Renderer 仍不得直接连接 Gateway，必须经 `src/lib/host-api.ts` 与 `src/lib/api-client.ts`
- 外部依赖：OpenClaw Gateway RPC/Event/Hook 文档必须作为真相源

### 1.4 真相源与现状诊断

本设计直接建立在以下现有代码和文档之上：

- `docs/gateway-rpc-api.md`
- `docs/gateway-events-api.md`
- `docs/hook-extension-points.md`
- `electron/main/index.ts`
- `electron/main/ipc-handlers.ts`
- `electron/api/server.ts`
- `electron/core/*`
- `electron/adapters/*`

现状不是“完全单体”，而是“平台化到一半”：

1. 已有平台基础：
   - `electron/core/contracts` 已有契约层
   - `electron/core/application` 已有应用服务
   - `electron/adapters/openclaw` 与 `electron/adapters/platform` 已有适配器雏形
2. 未完成部分：
   - 缺少独立 `Extension Host`
   - 缺少 `MatchaClaw Extension` manifest / lifecycle / SDK
   - Workbench 仍由静态页面枚举驱动，而不是贡献模型驱动
   - Main 仍然过厚，`ipc-handlers.ts` 继续承载大量应用级职责

本次重构不是推翻这些已有分层，而是把它们从“Main 内部应用抽象”推进为“可承载扩展宿主的正式架构”。

## 2. 架构

### 2.1 系统结构

目标结构如下：

```text
┌──────────────────────────────────────────────────────────────┐
│                        MatchaClaw App                        │
├──────────────────────────────────────────────────────────────┤
│  Renderer / Workbench                                       │
│  - App Shell / Layout / Route Container                     │
│  - Contribution Registry Snapshot Consumer                  │
│  - Builtin fallback pages during migration                  │
│  - Only talks through host-api / api-client                 │
├──────────────────────────────────────────────────────────────┤
│  Main Shell (Electron Main)                                 │
│  - Window / Tray / Menu / Updater / OS Integration          │
│  - Process orchestration                                    │
│  - Host API server / thin IPC boundary                      │
│  - Starts Gateway and Extension Host                        │
├──────────────────────────────────────────────────────────────┤
│  Extension Host (new Node.js process)                       │
│  - Extension Loader / Lifecycle / Sandbox boundary          │
│  - Service Registry / Command Router / Contribution Index   │
│  - OpenClaw Bridge                                          │
│  - Runs MatchaClaw Extensions                               │
├──────────────────────────────────────────────────────────────┤
│  OpenClaw Gateway                                           │
│  - OpenClaw core RPC/Event runtime                          │
│  - Runs OpenClaw Plugins                                    │
└──────────────────────────────────────────────────────────────┘
```

依赖方向：

```text
Renderer Workbench
  -> host-api / api-client
  -> Host API contract
  -> Main Shell / Host API
  -> Extension capability facade
  -> OpenClaw Bridge
  -> OpenClaw Gateway

OpenClaw Plugin 只属于 Gateway
MatchaClaw Extension 只属于 Extension Host
```

这里的关键点不是“Renderer 透传调用 Extension Host API”，而是：

1. Renderer 只能调用 `host-api/api-client` 定义的宿主能力。
2. Main Shell / Host API 负责把这些宿主能力映射到 Extension Host 命令、贡献快照或 Gateway 代理。
3. Extension Host 内部的 loader、router、service 等实现细节不向 Renderer 暴露。

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `Renderer Workbench` | 渲染工作台、消费扩展贡献、发起用户操作 | Host API 快照、用户输入 | 页面渲染、宿主能力调用 |
| `Main Shell` | OS 壳层、进程编排、最薄边界代理 | Electron 生命周期、Renderer 请求 | 窗口控制、进程状态、协议转发 |
| `Host API` | 给 Renderer 暴露稳定宿主契约，而不是透传 Extension Host 内部 API | Renderer HTTP/IPC 请求 | 结构化应用响应 |
| `Extension Host` | 加载 MatchaClaw Extension、维护生命周期、对外暴露扩展能力 | 扩展 manifest、Main 控制命令、Gateway 状态 | 扩展命令、贡献快照、扩展事件 |
| `OpenClaw Bridge` | 统一 Gateway RPC/Event 接入 | Gateway RPC/Event | Bridge Service API |
| `OpenClaw Gateway` | 运行 OpenClaw 核心和 OpenClaw Plugin | RPC/Event/Hook | 核心能力、插件能力、事件流 |

### 2.2.1 宿主调用合同

迁移期不能只喊“Renderer 只能走 `host-api/api-client`”，还必须把“能调什么”写成硬合同。否则现有 `invokeIpc('xxx')`、`hostApiFetch('/api/xxx')`、`window.electron.ipcRenderer.on('xxx')` 只会再外包一层。

宿主调用合同规则：

1. Renderer 侧只允许依赖按领域收口的 typed contract，例如 `gateway-runtime`、`team-runtime`、`channels`、`updates`、`license`、`diagnostics`、`extension-workbench`。
2. `src/lib/api-client.ts` 内部可以继续保留迁移期兼容层，但裸 channel 字符串不得继续从页面、store、feature 模块向外扩散。
3. Main Shell / Host API 必须先定义宿主能力，再决定这些能力由 Main 本地实现、转发到 Extension Host，还是代理到 Gateway。
4. 新增 Extension Host 能力时，先扩展宿主合同，再实现 Host API -> Extension Host 映射；禁止先暴露临时 IPC 再补文档。

这样做的目的，是把“是否允许访问某能力”从调用约定，收敛成可以做 contract test 和边界门禁的显式资产。

### 2.2.2 宿主事件合同

Workbench 不能只吃“贡献快照”，还必须有稳定事件合同。当前系统真实依赖的事件至少包括 Gateway 状态、Gateway 通知、聊天流、频道状态、OAuth、二维码和更新状态。

宿主事件合同规则：

1. 事件来源分三类：`main-owned`（窗口、更新、OAuth、二维码等）、`gateway-forwarded`（Gateway 规范化事件）、`extension-host`（扩展状态、贡献变化、扩展自定义事件）。
2. 状态型事件必须支持“新订阅立即拿到最近快照或最近版本号”，避免 Renderer 订阅晚于状态变化时丢失关键信息。
3. 瞬时事件必须定义是否可重放、是否允许去重，以及断线恢复后的补偿策略。
4. Renderer 只订阅宿主事件名，不直接订阅 Main 内部事件名、Extension Host 内部事件名或 Gateway 原始帧结构。

这样做的目的，是让 builtin extension 迁移后仍然能消费统一的运行时变化，而不是各自再接一条旁路事件链。

### 2.2.3 前端模块合同

前端扩展贡献如果没有模块合同，设计虽然写了 builtin/local-dev 可行，但构建链和运行时都无法落地。

前端模块合同规则：

1. builtin extension 前端贡献必须通过构建期注册表接入，不允许运行时随意 `eval`、`require` 或拼接组件导入路径。
2. manifest 中的 `frontend` 至少要能表达 `moduleId`、`entry`、`slots`、`prefetchPolicy`、`errorBoundary` 这类加载元数据。
3. Workbench 的路由预热、导航预取和错误隔离要从同一份前端模块元数据派生，不能继续在 `App.tsx`、`Sidebar.tsx` 里各写一套。
4. 本地开发扩展可以走开发态目录扫描或 dev registry，但生产构建只允许 builtin extension 使用打包产物清单。

这样做的目的，是把“贡献能否显示出来”从运行时猜路径，收敛成 Vite/Electron 都可验证的构建合同。

### 2.3 目录结构设计

目标目录结构如下：

```text
electron/
├── shell/                         # Main Shell 物理目录，承载 Electron 宿主壳层
│   ├── index.ts
│   ├── window.ts
│   ├── tray.ts
│   ├── menu.ts
│   ├── updater.ts
│   ├── process/
│   │   ├── gateway-supervisor.ts
│   │   └── extension-host-supervisor.ts
│   └── bridge/
│       ├── host-api-bridge.ts
│       └── extension-host-ipc.ts
├── api/                           # Host API
├── gateway/                       # Gateway 管理与协议适配
├── core/                          # 平台契约与应用服务
└── adapters/                      # OpenClaw / 平台适配实现

packages/
├── matchaclaw-extension-host/     # 新增：独立扩展宿主进程
│   └── src/
│       ├── index.ts
│       ├── loader/
│       ├── lifecycle/
│       ├── router/
│       ├── services/
│       │   ├── openclaw-bridge.ts
│       │   ├── service-registry.ts
│       │   └── contribution-registry.ts
│       ├── sandbox/
│       └── context/
├── matchaclaw-extension-sdk/      # 新增：扩展 API、类型、上下文接口
└── openclaw-*-plugin/             # 保留：OpenClaw Plugin

extensions/
├── builtin/
│   ├── workbench-core/
│   ├── chat/
│   ├── tasks/
│   ├── channels/
│   ├── settings/
│   └── dashboard/
└── experimental/

src/
├── features/                      # 共享领域逻辑：模型、应用服务、view-model
├── workbench/                     # 工作台壳层：布局、路由容器、贡献渲染
├── lib/
│   ├── host-api.ts
│   └── api-client.ts
└── pages/                         # 迁移期保留，逐步拆到 features + builtin extension UI 壳层
```

关键边界规则：

1. `packages/openclaw-*` 只表示 OpenClaw Plugin，不得混入 MatchaClaw 扩展协议。
2. `packages/matchaclaw-extension-host` 只运行 MatchaClaw Extension，不直接承载 OpenClaw Plugin 逻辑。
3. `src/features` 存放共享领域逻辑，只包含模型、应用服务、view-model 等可复用能力，不直接承载 Workbench 布局壳层。
4. `extensions/builtin/*/frontend` 或等价前端目录只负责扩展 UI 壳层、贡献注册和页面组合，不直接承载跨扩展共享业务规则。
5. `src/pages` 属于迁移期目录，迁移时必须先把共享领域逻辑拆到 `src/features`，再把 UI 壳层收敛为 builtin extension 前端贡献实现。

### 2.3.1 共享领域逻辑与扩展 UI 壳层拆分

迁移现有 `src/pages` 与 `src/stores` 时，必须先回答“这段代码到底是在描述业务事实，还是在描述 Workbench 页面壳层”：

1. 共享领域逻辑：
   - 包括领域模型、应用服务、查询/命令编排、可复用 view-model。
   - 放到 `src/features/<domain>/` 或等价共享目录。
   - 可以被 builtin extension、Workbench 容器和测试复用。
2. 扩展 UI 壳层：
   - 包括路由注册、菜单贡献、页面布局组合、扩展级 loading/error 壳层。
   - 放到 `extensions/builtin/<extension>/frontend/` 或等价扩展目录。
   - 只消费共享领域逻辑和 Host API，不反向定义核心业务事实。

这样做的目的不是“多一层目录”，而是防止旧页面把状态、布局和业务规则继续绑死在一起。

### 2.4 关键流程

#### 2.4.1 启动流程

1. Main Shell 启动 Electron，并初始化 Host API、窗口、托盘、更新等壳层能力。
2. Main Shell 拉起 OpenClaw Gateway。
3. Main Shell 拉起 Extension Host。
4. Extension Host 建立 `OpenClaw Bridge` 与 Main 控制链路。
5. Extension Host 扫描 `extensions/builtin` 与本地已安装扩展目录，加载 manifest。
6. Extension Host 生成贡献快照并上报给 Main / Host API。
7. Renderer Workbench 读取贡献快照，生成路由、导航和命令入口。

#### 2.4.2 扩展调用 OpenClaw 流程

1. MatchaClaw Extension 通过 `context.getService('openclaw-bridge')` 获取 Bridge。
2. 扩展调用 `bridge.call(method, params)`。
3. Bridge 通过 Gateway 协议与 OpenClaw Gateway 通信。
4. Gateway 将请求路由到 OpenClaw 核心或对应 OpenClaw Plugin。
5. Bridge 将结果返回给 Extension Host 中的扩展。
6. 若扩展需要通知 Workbench，则通过扩展事件或贡献状态更新回传。

#### 2.4.3 Workbench 贡献渲染流程

1. Extension Host 激活扩展后，收集其 manifest、运行时贡献和前端模块元数据。
2. Contribution Registry 生成统一快照，并为状态型数据生成单调递增版本号。
3. Main Shell / Host API 对 Renderer 暴露“只读贡献快照 + 宿主事件流”，而不是只给一次性静态结构。
4. Renderer Workbench 根据快照构建侧栏、路由、命令面板、设置分组，并根据事件流增量更新状态。
5. 用户触发命令或打开页面时，Renderer 先调用 Host API 定义的宿主能力。
6. Main Shell / Host API 再把宿主能力映射到 Extension Host 命令、贡献查询、事件订阅或 Gateway 代理。

#### 2.4.4 前端扩展贡献加载策略

1. 本期前端贡献只支持 builtin extension 与本地开发扩展。
2. builtin extension 以前端模块注册表的形式进入构建产物；Workbench 根据注册表解析 `moduleId -> entry chunk -> slot`。
3. 本地开发扩展只在开发模式下允许目录扫描或 dev registry，不进入生产打包闭环。
4. 远程 UI bundle 只保留 manifest、加载器、权限和沙箱的挂载点，运行时默认禁用。
5. 即使未来开启远程 UI bundle，也必须继续走 Host API 的能力边界，而不是让远程前端直接拿到 Gateway 或 Extension Host 内部对象。

#### 2.4.5 扩展故障恢复流程

1. 单个扩展激活失败时，Extension Host 记录错误并将该扩展标记为 `degraded`。
2. Contribution Registry 只移除或禁用该扩展相关贡献，不影响其它扩展。
3. 若 Extension Host 整体异常退出，Main Shell 检测到退出事件并按策略重启。
4. Renderer Workbench 收到状态变化后显示降级提示，而不是静默失效。

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4、5、6、7

- `ExtensionHostProcess`：独立进程入口，负责扩展发现、加载、生命周期管理
- `ExtensionLoader`：扫描扩展目录、读取 manifest、解析依赖与激活顺序
- `ExtensionContextFactory`：为扩展提供 API、服务、事件、日志和存储上下文
- `ContributionRegistry`：汇总所有扩展的路由、菜单、命令、设置贡献
- `OpenClawBridgeService`：统一管理 Gateway RPC 和事件订阅
- `WorkbenchContributionConsumer`：Renderer 侧消费贡献快照并生成 UI

### 3.2 数据结构

覆盖需求：1、2、3、4、6、7

#### 3.2.1 `matchaclaw.extension.json`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `id` | `string` | 是 | 扩展唯一标识 | 全局唯一 |
| `name` | `string` | 是 | 扩展名称 | 非空 |
| `version` | `string` | 是 | 版本号 | semver |
| `kind` | `'builtin' \| 'local' \| 'experimental'` | 是 | 扩展来源类型 | 白名单枚举 |
| `activationEvents` | `string[]` | 是 | 激活时机 | 支持 `onStartupFinished`、`onCommand:*`、`onRoute:*` |
| `backend` | `object` | 否 | Extension Host 后端入口 | 有后端时必填 `entry` |
| `frontend` | `object` | 否 | Workbench 前端贡献信息 | 至少支持 `moduleId`、`entry`、`slots`、`prefetchPolicy`、`errorBoundary`；本期仅允许 builtin/local-dev，可预留 remote 配置字段，但必须默认禁用 |
| `dependencies` | `string[]` | 否 | 对其它 MatchaClaw 扩展的依赖 | 仅允许声明已知扩展 |
| `openclawDependencies` | `string[]` | 否 | 依赖的 OpenClaw Plugin / 服务 | 用于运行前校验 |

#### 3.2.2 `ExtensionContributionSnapshot`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `version` | `number` | 是 | 快照版本号 | 单调递增 |
| `routes` | `RouteContribution[]` | 是 | 路由贡献 | Workbench 只读消费 |
| `menus` | `MenuContribution[]` | 是 | 导航 / 菜单贡献 | 排序稳定 |
| `commands` | `CommandContribution[]` | 是 | 命令贡献 | `id` 全局唯一 |
| `settingsSections` | `SettingsContribution[]` | 是 | 设置页签或分组贡献 | 允许为空 |
| `frontendModules` | `FrontendContributionModule[]` | 是 | 前端模块加载元数据 | 只读；由构建注册表和运行时状态共同派生 |
| `extensions` | `ExtensionRuntimeState[]` | 是 | 扩展运行状态 | 用于 UI 展示与调试 |

#### 3.2.3 `WorkbenchEventEnvelope`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `sequence` | `number` | 是 | 事件序号 | 在同一宿主事件流内单调递增 |
| `event` | `string` | 是 | 宿主事件名 | 只能来自宿主事件合同 |
| `source` | `'main-owned' \| 'gateway-forwarded' \| 'extension-host'` | 是 | 事件来源 | 白名单枚举 |
| `replayable` | `boolean` | 是 | 是否允许重放给新订阅方 | 状态型事件通常为 `true` |
| `payload` | `unknown` | 否 | 事件载荷 | JSON 可序列化 |
| `emittedAt` | `number` | 是 | 发送时间戳 | Unix epoch ms |

#### 3.2.4 `ExtensionRpcEnvelope`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `requestId` | `string` | 是 | 请求唯一 ID | 同一链路唯一 |
| `extensionId` | `string` | 是 | 目标扩展 ID | 必须可解析 |
| `method` | `string` | 是 | 扩展方法名 | 非空 |
| `params` | `unknown` | 否 | 参数 | JSON 可序列化 |
| `source` | `'renderer' \| 'main' \| 'extension-host'` | 是 | 请求来源 | 白名单枚举 |

### 3.3 接口契约

覆盖需求：2、3、4、5、6、7

#### 3.3.1 `ExtensionModule`

- 类型：Function / Module Contract
- 路径或标识：`matchaclaw-extension-sdk/ExtensionModule`
- 输入：`ExtensionContext`
- 输出：`activate()` / `deactivate()` 生命周期对象
- 校验：
  - 扩展必须显式声明自己的 `id`
  - 激活失败必须抛出可记录错误，而不是 silent fail
- 错误：
  - manifest 缺失、入口缺失、依赖未满足、激活异常

示意接口：

```ts
export interface ExtensionModule {
  activate(context: ExtensionContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
```

#### 3.3.2 `ExtensionContext`

- 类型：Object Contract
- 路径或标识：`matchaclaw-extension-sdk/ExtensionContext`
- 输入：由 Extension Host 在激活时注入
- 输出：提供扩展 API
- 校验：
  - 扩展只能通过上下文访问宿主能力
  - 不允许直接拿到 Main Shell 私有对象
- 错误：
  - 请求未知服务、重复注册命令、非法贡献声明

示意接口：

```ts
export interface ExtensionContext {
  readonly extensionId: string;
  readonly storagePath: string;
  registerCommand(commandId: string, handler: (params?: unknown) => Promise<unknown>): void;
  registerContribution(contribution: ExtensionContribution): void;
  getService<T>(serviceName: string): T;
  events: {
    emit(event: string, payload: unknown): void;
    on(event: string, listener: (payload: unknown) => void): () => void;
  };
  log: {
    info(message: string, meta?: unknown): void;
    warn(message: string, meta?: unknown): void;
    error(message: string, meta?: unknown): void;
  };
}
```

#### 3.3.3 `WorkbenchEventBusContract`

- 类型：Service Contract
- 路径或标识：`packages/matchaclaw-extension-host/src/services/workbench-event-bus.ts`
- 输入：宿主内部状态变化、Gateway 规范化事件、扩展事件
- 输出：`WorkbenchEventEnvelope`
- 校验：
  - 状态型事件必须有稳定事件名和可选重放语义
  - Renderer 看到的事件名不能泄漏 Gateway 原始握手帧或 Main 内部实现细节
- 错误：
  - 未知事件、非法来源、序号回退、不可序列化载荷

示意接口：

```ts
export interface WorkbenchEventBusContract {
  publish(event: WorkbenchEventEnvelope): void;
  snapshot(event: string): WorkbenchEventEnvelope | null;
  subscribe(event: string, listener: (event: WorkbenchEventEnvelope) => void): () => void;
}
```

#### 3.3.4 `OpenClawBridgeService`

- 类型：Service Contract
- 路径或标识：`packages/matchaclaw-extension-host/src/services/openclaw-bridge.ts`
- 输入：Gateway method、params、event name
- 输出：RPC 结果、事件订阅、连接状态
- 校验：
  - Bridge 只暴露稳定 API，不把底层 Gateway 握手细节泄漏给扩展
  - 统一使用现有文档中允许的 RPC/Event 方法
- 错误：
  - Gateway 未连接、方法不可用、权限不足、超时、事件订阅断开

示意接口：

```ts
export interface OpenClawBridgeService {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  status(): 'connecting' | 'connected' | 'degraded' | 'disconnected';
  call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  on(event: string, listener: (payload: unknown) => void): () => void;
}
```

#### 3.3.5 `WorkbenchContributionRegistry`

- 类型：Service Contract
- 路径或标识：`packages/matchaclaw-extension-host/src/services/contribution-registry.ts`
- 输入：扩展注册的贡献
- 输出：稳定快照
- 校验：
  - 同一命令 ID、同一路由 path 冲突时必须有明确冲突策略
  - 快照必须是只读派生，不允许 Renderer 侧直接改写
- 错误：
  - 贡献冲突、无效排序、缺少必要字段

## 4. 数据与状态模型

### 4.1 数据关系

核心关系如下：

1. `matchaclaw.extension.json` 是扩展静态事实源。
2. `ExtensionRuntimeState` 是宿主运行态事实源。
3. `ExtensionContributionSnapshot` 是从静态事实和运行态派生出来的只读结构视图。
4. `WorkbenchEventEnvelope` 是宿主推送变化的只读事件视图。
5. Renderer Workbench 只消费“快照 + 事件流”，不直接管理扩展内部状态。

关系链：

```text
Manifest + Runtime State
  -> Contribution Registry
  -> Snapshot
  -> Workbench UI

Main-owned / Gateway-forwarded / Extension-host Events
  -> Workbench Event Bus
  -> Event Stream
  -> Workbench UI
```

### 4.2 状态流转

#### 4.2.1 扩展状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `discovered` | 已发现 manifest，尚未解析入口 | 扫描目录后 | 入口解析成功或失败 |
| `resolved` | 入口和依赖校验完成 | 入口可用、依赖可满足 | 触发激活 |
| `activating` | 正在执行 `activate` | 满足激活事件 | 激活成功或失败 |
| `active` | 扩展可提供命令和贡献 | 激活成功 | 停用、崩溃、卸载 |
| `degraded` | 扩展部分失效但宿主仍存活 | 激活失败、运行时报错、依赖中断 | 重试成功或停用 |
| `stopped` | 扩展停止 | 手动停用、宿主关闭 | 再次启动 |

#### 4.2.2 Bridge 状态

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `connecting` | 正在与 Gateway 建立连接 | Extension Host 启动 | 成功或失败 |
| `connected` | Bridge 可正常调用和订阅 | 握手成功 | Gateway 断连或错误 |
| `degraded` | Bridge 存活但 Gateway 暂不可用 | Gateway 重启、超时、部分方法不可用 | 连接恢复或完全断开 |
| `disconnected` | Bridge 不可用 | 宿主关闭或连接中断 | 重连开始 |

## 5. 错误处理

### 5.1 错误类型

- `ExtensionManifestInvalid`：扩展 manifest 非法
- `ExtensionDependencyMissing`：扩展依赖未满足
- `ExtensionActivationFailed`：扩展激活失败
- `ContributionConflict`：贡献 ID/path 冲突
- `BridgeUnavailable`：OpenClaw Bridge 不可用
- `GatewayMethodUnavailable`：Bridge 调用了当前基线未支持的方法
- `ExtensionHostCrashed`：宿主进程退出

### 5.2 错误响应格式

```json
{
  "detail": "扩展 chat 在激活阶段失败",
  "error_code": "EXTENSION_ACTIVATION_FAILED",
  "field": "extensions.builtin.chat.backend.entry",
  "timestamp": "2026-03-26T00:00:00Z"
}
```

### 5.3 处理策略

1. manifest 校验错误：
   - 阻止该扩展激活
   - 记录结构化日志
   - 不影响其它扩展
2. 贡献冲突：
   - 启动阶段直接失败该扩展或拒绝冲突贡献
   - 快照不得进入不确定状态
3. Bridge 不可用：
   - 向扩展返回一致错误语义
   - Workbench 展示“运行时未连接”而不是空白
4. Extension Host 崩溃：
   - Main Shell 负责检测与重启
   - Renderer 根据扩展状态快照进入降级模式

## 6. 正确性属性

### 6.1 属性 1：双插件边界单一归属

*对于任何* 扩展或插件，系统都应该满足：`OpenClaw Plugin` 只能运行在 Gateway，`MatchaClaw Extension` 只能运行在 Extension Host。

**验证需求：** `requirements.md` 需求 1、需求 2

### 6.2 属性 2：Renderer 不直接穿透到底层运行时

*对于任何* Renderer 发起的运行时调用，系统都应该满足：必须经过 `host-api/api-client -> Main Shell / Host API -> Extension Host / Gateway` 的明确边界；Renderer 调用的是宿主契约，不是 Extension Host 内部 API 的透传镜像，也不允许直接连接 Gateway。

**验证需求：** `requirements.md` 需求 3、需求 5

### 6.3 属性 3：Workbench 只有一个贡献事实源

*对于任何* 菜单、路由、命令、设置入口，系统都应该满足：Workbench 只从 `ExtensionContributionSnapshot` 派生 UI，而不是同时维护静态枚举和动态枚举两套事实源长期并存。

**验证需求：** `requirements.md` 需求 4、需求 6

### 6.4 属性 4：单扩展故障不扩散

*对于任何* 单个 MatchaClaw Extension 的运行时错误，系统都应该满足：故障首先被限制在该扩展或 Extension Host 恢复链路内，而不是直接打穿 Main Shell 与整个 Workbench。

**验证需求：** `requirements.md` 需求 2、需求 7

## 7. 测试策略

### 7.1 单元测试

- 扩展 manifest 解析与校验
- 宿主调用合同和事件合同校验
- 扩展依赖解析与加载顺序
- Contribution Registry 冲突检测与快照生成
- 前端模块注册表解析与加载元数据校验
- OpenClaw Bridge RPC/Event 封装与错误映射
- Extension Context API 边界与服务注册

### 7.2 集成测试

- Main Shell 启动 Extension Host、心跳监控、异常恢复
- Renderer 读取贡献快照并消费宿主事件流
- 扩展命令调用经过 Main / Host API / Extension Host 到达扩展处理器
- 扩展通过 Bridge 调用 OpenClaw Gateway 的主链路

### 7.3 端到端测试

- 启动应用后内置扩展贡献出现在工作台
- 点击工作台入口，成功打开由扩展提供的页面或命令
- 重新连接、热重载或后订阅场景下，状态型事件能按合同重放
- OpenClaw Gateway 暂停/重启时，扩展与 Workbench 降级语义正确
- 单扩展崩溃后应用仍可继续使用其它工作台能力

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | `design.md` §2.1、§2.3、§6.1 | 目录走查 + 边界测试 |
| `requirements.md` 需求 2 | `design.md` §2.4.1、§2.4.5、§4.2、§6.4 | 宿主启动/崩溃恢复集成测试 |
| `requirements.md` 需求 3 | `design.md` §2.4.2、§3.3.4、§5.3 | Bridge 合同测试 + Gateway 集成测试 |
| `requirements.md` 需求 4 | `design.md` §2.4.3、§3.2.2、§3.3.5、§6.3 | Workbench 贡献快照渲染测试 |
| `requirements.md` 需求 5 | `design.md` §2.1、§2.2、§2.3、§6.2 | Main Shell 边界门禁测试 |
| `requirements.md` 需求 6 | `design.md` §2.3、§2.3.1、§4.1、§4.2 | 迁移阶段回归测试 |
| `requirements.md` 需求 7 | `design.md` §5、§7.1、§7.2 | 日志/状态/故障语义测试 |

## 8. 风险与已确认决策

### 8.1 风险

- 当前 `src/pages` 与 `src/stores` 仍是静态工作台实现，若迁移时不先划清“共享领域逻辑”和“扩展 UI 壳层”，容易把老耦合原样搬进扩展体系
- 若不先固化宿主调用合同和宿主事件合同，Extension Host 很容易变成“新进程 + 新接口名”，而不是收束现有宿主边界
- Electron + Vite 下的“前端扩展贡献”如果一步到位做成任意动态 bundle，会让本期范围失控
- `ipc-handlers.ts` 过大，若没有分阶段拆迁，很容易在迁移期形成新旧逻辑双写混乱
- OpenClaw Bridge 若不严格绑定现有文档基线，后续升级 OpenClaw 时会出现协议漂移

### 8.2 已确认决策

- Renderer 到运行时的链路固定为 `host-api/api-client -> Main Shell / Host API -> Extension Host / Gateway`，Host API 只暴露宿主契约，不透传 Extension Host 内部 API。
- 三份合同必须先行落地：宿主调用合同、宿主事件合同、前端模块合同。没有合同先不进入大规模 builtin extension 迁移。
- 迁移现有页面时，必须先拆“共享领域逻辑”和“扩展 UI 壳层”；前者进入 `src/features` 或等价共享目录，后者进入 builtin extension 前端目录。
- 本期前端扩展贡献只支持 builtin extension 和本地开发扩展；任意第三方远程 UI bundle 仅保留挂载点，不进入实际加载范围。
- `electron/main -> electron/shell` 的物理目录迁移不与 Extension Host 引入绑成同一阶段；先用语义和别名收口边界，目录 rename 放到后续 cleanup 阶段。
- 第一批 builtin extension 迁移名单固定为 `chat / tasks / channels / settings`。
- 第一批 builtin extension 的落地顺序按复杂度分层：先 `settings / channels / tasks`，待事件总线与前端模块加载稳定后，再迁 `chat`。
