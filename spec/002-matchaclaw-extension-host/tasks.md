# 任务清单 - MatchaClaw 扩展宿主与双插件体系重构（人话版）

状态：Draft

## 这份文档是干什么的

这份任务清单用来把“独立扩展宿主 + 双插件体系 + VS Code 风格分层”拆成能执行的阶段任务。

每一步都会回答：

- 这一步到底做什么
- 做完后能看到什么结果
- 依赖什么
- 主要改哪些文件
- 这一步明确不做什么
- 怎么验证

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写状态
- `CANCELLED`：取消，不做了，但要写原因

规则：

- 只有 `状态：DONE` 的任务才能勾选成 `[x]`
- `BLOCKED` 必须写清楚卡在哪里
- `CANCELLED` 必须写清楚为什么不做
- 每做完一个任务，必须立刻更新这里

---

## 阶段 1：先把边界和骨架立起来

- [ ] 1.0 先固化宿主调用合同、宿主事件合同和前端模块合同
  - 状态：TODO
  - 这一步到底做什么：先把“Renderer 到运行时到底能调什么、订阅什么、加载什么前端模块”写成实现级合同，并把现有散落的 raw IPC / raw 事件名 / 静态路由预热逻辑收束到兼容层，避免 Extension Host 一进场就长出第二套 API。
  - 做完你能看到什么：后续无论能力最终落在 Main、Extension Host 还是 Gateway，Renderer 侧都只面对一份宿主合同，而不是继续在页面和 store 里散落 channel 字符串。
  - 先依赖什么：无
  - 开始前先看：
    - `design.md` §2.2.1「宿主调用合同」
    - `design.md` §2.2.2「宿主事件合同」
    - `design.md` §2.2.3「前端模块合同」
  - 主要改哪里：
    - `src/lib/api-client.ts`
    - `src/lib/host-api.ts`
    - `src/lib/host-events.ts`
    - `electron/api/routes/`
    - `electron/api/event-bus.ts`
    - `electron/preload/index.ts`
    - `vite.config.ts`
  - 这一步先不做什么：先不引入 Extension Host，不迁业务页面。
  - 怎么算完成：
    1. 新能力先加宿主合同，再决定由谁实现
    2. Renderer 侧不再新增裸 channel 调用和裸事件名订阅
    3. builtin extension 前端模块已有最小加载元数据合同
  - 怎么验证：
    - Host contract / host event contract 契约测试
    - Renderer 边界检查脚本
    - 前端模块注册表最小 smoke test
  - 对应需求：`requirements.md` 需求 3、需求 4、需求 5、需求 7
  - 对应设计：`design.md` §2.2.1、§2.2.2、§2.2.3、§6.2、§6.3

- [ ] 1.1 新建 MatchaClaw Extension Host 包和 SDK 骨架
  - 状态：TODO
  - 这一步到底做什么：新增 `packages/matchaclaw-extension-host` 与 `packages/matchaclaw-extension-sdk`，先把扩展宿主进程入口、manifest 类型、扩展上下文接口和最小生命周期接口建起来，并为未来远程 UI bundle 预留 manifest/权限字段挂载点。
  - 做完你能看到什么：仓库里第一次正式出现“MatchaClaw 自身扩展”的独立宿主与 SDK，不再借用 OpenClaw Plugin 目录表达另一套系统。
  - 先依赖什么：1.0
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §2.3「目录结构设计」
    - `design.md` §3.3.1、§3.3.2
  - 主要改哪里：
    - `packages/matchaclaw-extension-host/`
    - `packages/matchaclaw-extension-sdk/`
    - `package.json`
    - `tsconfig.json` 及构建脚本
  - 这一步先不做什么：先不迁业务页面，不做 Bridge，不做渲染层接入。
  - 怎么算完成：
    1. 扩展宿主包可以独立编译和启动
    2. SDK 里已有 manifest、`ExtensionModule`、`ExtensionContext` 基础类型
    3. manifest 已能区分“本期可运行能力”和“未来远程 UI bundle 预留字段”
  - 怎么验证：
    - `pnpm run typecheck`
    - 新增宿主入口最小启动测试
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §2.3、§3.3.1、§3.3.2

- [ ] 1.2 用 Main Shell 拉起并监控 Extension Host
  - 状态：TODO
  - 这一步到底做什么：新增扩展宿主进程管理器，把 Extension Host 纳入应用启动、退出、崩溃恢复链路；这一阶段先用语义边界和别名收口，不把 `electron/main -> electron/shell` 的物理目录迁移绑进同一批实现。
  - 做完你能看到什么：应用启动时会同时管理 Gateway 和 Extension Host，而不是只有 Gateway 一个外部运行时。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 2、需求 5、需求 7
    - `design.md` §2.1「系统结构」
    - `design.md` §2.4.1、§2.4.5
  - 主要改哪里：
    - `electron/main/index.ts`（或过渡别名入口）
    - `electron/main/process/extension-host-supervisor.ts`
    - `electron/main/bridge/extension-host-ipc.ts`
    - `tests/unit/` 下新增宿主管理测试
  - 这一步先不做什么：先不做物理目录 rename，先不让 Renderer 直接消费扩展贡献。
  - 怎么算完成：
    1. Main Shell 能拉起、停止、检测和重启 Extension Host
    2. Extension Host 异常退出时不会把主进程带崩
    3. 主壳层职责已经收口为 shell 语义，但物理目录 rename 仍可后置
  - 怎么验证：
    - 扩展宿主 supervisor 集成测试
    - 人工杀进程验证恢复语义
  - 对应需求：`requirements.md` 需求 2、需求 5、需求 7
  - 对应设计：`design.md` §2.1、§2.3、§2.4.1、§2.4.5、§4.2

- [ ] 1.3 把 Main 进程里的应用边界拆成 Main Shell 与 Host API Bridge
  - 状态：TODO
  - 这一步到底做什么：把当前 `ipc-handlers.ts` 里与扩展宿主相关的职责抽出，并让 Host API、事件总线和前端模块注册表都挂到 1.0 定义的宿主合同上；Renderer 侧只看到宿主契约，不能把 Extension Host 内部 API 和内部事件名直接透出来。
  - 做完你能看到什么：Main 里“窗口/托盘/更新/系统能力”和“扩展宿主转发/Host API”边界明显清晰。
  - 先依赖什么：1.2
  - 开始前先看：
    - `requirements.md` 需求 5、需求 6
    - `design.md` §2.2「模块职责」
    - `design.md` §6.2「Renderer 不直接穿透到底层运行时」
  - 主要改哪里：
    - `electron/main/ipc-handlers.ts`（或过渡别名路径）
    - `electron/api/server.ts`
    - `electron/api/context.ts`
    - `electron/api/event-bus.ts`
    - `electron/main/bridge/host-api-bridge.ts`
  - 这一步先不做什么：先不清理所有历史业务代码，先完成边界抽离。
  - 怎么算完成：
    1. Main Shell 只保留宿主壳层与协议桥接职责
    2. 与扩展调用相关的新入口不再直接塞进 `ipc-handlers.ts`
    3. Host API 输出的是稳定宿主能力和稳定事件名，不是 Extension Host 内部方法清单
  - 怎么验证：
    - 主进程边界走查
    - 关键 Host API 路径回归测试
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §2.2、§2.4.1、§6.2

### 阶段检查

- [ ] 1.4 阶段检查：宿主边界已经站住
  - 状态：TODO
  - 这一步到底做什么：只检查“独立 Extension Host + Main Shell 薄边界”是否已经成立。
  - 做完你能看到什么：后续可以在这个骨架上接 Bridge 和贡献模型，而不是继续把逻辑放回主进程。
  - 先依赖什么：1.1、1.2、1.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段相关文件
  - 这一步先不做什么：不迁业务页面，不加新功能。
  - 怎么算完成：
    1. MatchaClaw Extension Host 已独立存在
    2. Main Shell 已具备扩展宿主管理职责
    3. 新边界和宿主合同已有最小测试保护
  - 怎么验证：
    - 人工走查
    - 宿主管理测试通过
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 5
  - 对应设计：`design.md` §2.1、§2.3、§4.2

---

## 阶段 2：把 OpenClaw Bridge 和扩展运行时做出来

- [ ] 2.1 在 Extension Host 内实现 OpenClaw Bridge
  - 状态：TODO
  - 这一步到底做什么：在扩展宿主内新增 `openclaw-bridge.ts`，统一 Gateway RPC、事件订阅、连接状态和错误映射。
  - 做完你能看到什么：MatchaClaw 扩展能通过单一服务访问 OpenClaw 核心与 OpenClaw 插件能力。
  - 先依赖什么：1.4
  - 开始前先看：
    - `requirements.md` 需求 3、需求 7
    - `design.md` §2.4.2
    - `design.md` §3.3.4
    - `docs/gateway-rpc-api.md`
    - `docs/gateway-events-api.md`
  - 主要改哪里：
    - `packages/matchaclaw-extension-host/src/services/openclaw-bridge.ts`
    - `packages/matchaclaw-extension-host/src/services/service-registry.ts`
    - `tests/unit/` 下新增 Bridge 测试
  - 这一步先不做什么：先不做 OpenClaw 上游协议扩展。
  - 怎么算完成：
    1. 扩展能统一 `call/on/off`
    2. Bridge 对 Gateway 断连、超时和方法不可用有一致错误语义
  - 怎么验证：
    - Bridge 单元测试
    - 对接 Gateway 的集成测试
  - 对应需求：`requirements.md` 需求 3、需求 7
  - 对应设计：`design.md` §2.4.2、§3.3.4、§5.3

- [ ] 2.2 实现扩展 Loader、生命周期和运行时状态机
  - 状态：TODO
  - 这一步到底做什么：实现 manifest 扫描、依赖解析、激活事件、`activate/deactivate` 生命周期和扩展运行态记录。
  - 做完你能看到什么：扩展不再是“导进来就跑”，而是有正式的宿主状态机和日志语义。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2、需求 7
    - `design.md` §3.1「核心组件」
    - `design.md` §4.2.1「扩展状态」
  - 主要改哪里：
    - `packages/matchaclaw-extension-host/src/loader/`
    - `packages/matchaclaw-extension-host/src/lifecycle/`
    - `packages/matchaclaw-extension-host/src/context/`
    - `tests/unit/` 下新增生命周期测试
  - 这一步先不做什么：先不把前端页面迁成扩展贡献。
  - 怎么算完成：
    1. 宿主能扫描扩展并按状态流转管理
    2. 依赖缺失、激活失败、重复注册等异常有显式状态
  - 怎么验证：
    - 生命周期单元测试
    - 宿主最小端到端测试
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 7
  - 对应设计：`design.md` §3.1、§4.2.1、§5.1

- [ ] 2.3 建立扩展命令路由和 Host API -> Extension Host 调用链
  - 状态：TODO
  - 这一步到底做什么：让 Main / Host API 能把命令调用、状态查询、扩展事件订阅映射到 Extension Host，并把 Renderer 请求收束为受控宿主能力和受控事件流，而不是透传 Extension Host API。
  - 做完你能看到什么：Renderer 之后可以通过标准链路调用扩展命令，不需要再新增一批随意 IPC。
  - 先依赖什么：2.2
  - 开始前先看：
    - `requirements.md` 需求 3、需求 5
    - `design.md` §2.4.2、§3.2.3、§6.2
  - 主要改哪里：
    - `electron/api/routes/`
    - `electron/api/event-bus.ts`
    - `electron/main/bridge/extension-host-ipc.ts`
    - `src/lib/host-api.ts`
    - `src/lib/api-client.ts`
    - `src/lib/host-events.ts`
  - 这一步先不做什么：先不接 Workbench 贡献 UI。
  - 怎么算完成：
    1. Host API 能调用 Extension Host 命令
    2. Renderer 仍保持 `host-api/api-client` 单入口
    3. Renderer 侧看不到 Extension Host 内部方法名、内部对象结构和内部事件名
  - 怎么验证：
    - API 调用链测试
    - 事件订阅/重放合同测试
    - 不允许 Renderer 新增直连 Gateway/IPC 的边界检查
  - 对应需求：`requirements.md` 需求 3、需求 5
  - 对应设计：`design.md` §2.4.2、§3.2.3、§6.2

### 阶段检查

- [ ] 2.4 阶段检查：扩展已经能真正跑起来
  - 状态：TODO
  - 这一步到底做什么：检查扩展宿主是不是已经能发现扩展、激活扩展、调用 OpenClaw、返回结果。
  - 做完你能看到什么：不是只有目录骨架，而是已有一条最小扩展执行闭环。
  - 先依赖什么：2.1、2.2、2.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段相关文件
  - 这一步先不做什么：不迁大页面。
  - 怎么算完成：
    1. 最小 Hello Extension 可激活
    2. 最小 Bridge 调用链可跑通
    3. Host API 到扩展命令链路可验证
  - 怎么验证：
    - 集成测试
    - 手工运行最小扩展示例
  - 对应需求：`requirements.md` 需求 2、需求 3、需求 7
  - 对应设计：`design.md` §2.4.2、§3.3.1、§3.3.4、§4.2

---

## 阶段 3：把 Workbench 变成贡献驱动

- [ ] 3.1 实现 Contribution Registry 和贡献快照
  - 状态：TODO
  - 这一步到底做什么：让扩展能注册路由、菜单、命令、设置分组，并由宿主生成统一快照；同时把前端模块元数据和宿主事件所需的状态版本号一起纳入 registry，但本期不启用远程加载。
  - 做完你能看到什么：Workbench 有了单一贡献事实源，不再只能靠静态页面枚举。
  - 先依赖什么：2.4
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6、需求 7
    - `design.md` §2.4.3
    - `design.md` §3.2.2、§3.3.5
    - `design.md` §6.3
  - 主要改哪里：
    - `packages/matchaclaw-extension-host/src/services/contribution-registry.ts`
    - `packages/matchaclaw-extension-sdk/`
    - `tests/unit/` 下新增贡献冲突和快照测试
  - 这一步先不做什么：先不完全删除静态页面。
  - 怎么算完成：
    1. 宿主能稳定生成贡献快照
    2. 同一路由 / 命令冲突有明确拒绝策略
    3. 快照同时携带前端模块加载元数据，且 manifest 已保留远程前端贡献挂载点但运行时默认关闭
  - 怎么验证：
    - Contribution Registry 单元测试
    - 快照结构契约测试
  - 对应需求：`requirements.md` 需求 4、需求 6、需求 7
  - 对应设计：`design.md` §2.4.3、§3.2.2、§3.3.5、§6.3

- [ ] 3.2 在 Renderer 新建 Workbench 贡献消费层
  - 状态：TODO
  - 这一步到底做什么：在 `src/workbench/` 建立“贡献快照 + 宿主事件流”消费层，把侧栏、路由、命令面板、设置入口都改成从快照和事件派生，并先把共享领域逻辑从页面壳层里拆出来。
  - 做完你能看到什么：Renderer Workbench 开始真正从扩展贡献渲染 UI。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6
    - `design.md` §2.1「系统结构」
    - `design.md` §2.3.1「共享领域逻辑与扩展 UI 壳层拆分」
    - `design.md` §2.4.3
  - 主要改哪里：
    - `src/features/`
    - `src/workbench/`
    - `src/App.tsx`
    - `src/components/layout/Sidebar.tsx`
    - `src/lib/host-api.ts`
  - 这一步先不做什么：先不迁所有历史页面实现，只先让贡献驱动的容器跑起来。
  - 怎么算完成：
    1. 侧栏和路由至少有一部分入口来自贡献快照
    2. Workbench 对单扩展贡献失败有局部降级，而不是整页崩溃
    3. 被接入的入口已经把共享领域逻辑和扩展 UI 壳层拆开，而不是直接复刻旧页面结构
    4. 状态型宿主事件在后订阅或重连场景下仍能恢复关键 UI 状态
  - 怎么验证：
    - Renderer 贡献渲染测试
    - Workbench 事件重放 / 重连测试
    - 手工验证至少一个贡献入口可见
  - 对应需求：`requirements.md` 需求 4、需求 6
  - 对应设计：`design.md` §2.1、§2.4.3、§6.3

- [ ] 3.3 迁移第一批内置能力为 builtin extensions
  - 状态：TODO
  - 这一步到底做什么：把 `chat / tasks / channels / settings` 明确作为第一批 builtin extension 迁移名单，但按复杂度分层推进：先 `settings -> channels -> tasks`，待事件总线与前端模块加载稳定后，再迁 `chat`，验证新架构不是空壳。
  - 做完你能看到什么：内置能力可以不再直接绑在根应用里，而是作为 MatchaClaw Extension 贡献给 Workbench。
  - 先依赖什么：3.2
  - 开始前先看：
    - `requirements.md` 需求 4、需求 6
    - `design.md` §2.3「目录结构设计」
    - `design.md` §2.3.1「共享领域逻辑与扩展 UI 壳层拆分」
    - `design.md` §4.1「数据关系」
  - 主要改哪里：
    - `extensions/builtin/chat/`
    - `extensions/builtin/tasks/`
    - `extensions/builtin/channels/`
    - `extensions/builtin/settings/`
    - `src/features/`
    - `src/pages/` 与 `src/stores/` 中被迁移的部分
  - 这一步先不做什么：不强求一次迁完所有内置页面。
  - 怎么算完成：
    1. `chat / tasks / channels / settings` 都进入第一批迁移排期和目录骨架
    2. 至少一个低复杂度能力已经通过扩展贡献驱动工作台入口跑通完整链路
    3. `chat` 迁移前，事件总线与前端模块加载闭环已先验证稳定
    4. 被迁移能力的新旧实现没有长期双写漂移
  - 怎么验证：
    - 被迁移能力的页面级测试
    - 手工验证工作台入口可用
  - 对应需求：`requirements.md` 需求 4、需求 6
  - 对应设计：`design.md` §2.3、§4.1、§6.3

### 阶段检查

- [ ] 3.4 阶段检查：Workbench 已从静态枚举转向贡献模型
  - 状态：TODO
  - 这一步到底做什么：确认 Workbench 已有单一贡献事实源，而不是又叠了一层新旧并存的混乱壳。
  - 做完你能看到什么：后续迁更多内置能力时，有清晰、可复用的标准路径。
  - 先依赖什么：3.1、3.2、3.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段相关文件
  - 这一步先不做什么：不扩市场和第三方安装。
  - 怎么算完成：
    1. Workbench 已消费贡献快照
    2. 至少一批 builtin extension 已上线
    3. 旧静态入口开始收敛
  - 怎么验证：
    - 贡献渲染回归测试
    - 人工走查导航与路由来源
  - 对应需求：`requirements.md` 需求 4、需求 6
  - 对应设计：`design.md` §2.4.3、§4.1、§6.3

---

## 阶段 4：清理旧逻辑、补齐治理和验收

- [ ] 4.1 清理主进程遗留业务逻辑与直连入口
  - 状态：TODO
  - 这一步到底做什么：把已经迁到 Extension Host / Workbench 的能力从主进程旧入口里删除，避免新旧逻辑长期并存。
  - 做完你能看到什么：主进程代码量和职责开始明显收敛。
  - 先依赖什么：3.4
  - 开始前先看：
    - `requirements.md` 需求 5、需求 6
    - `design.md` §2.2「模块职责」
    - `design.md` §6.2「Renderer 不直接穿透到底层运行时」
  - 主要改哪里：
    - `electron/shell/ipc-handlers.ts`
    - `electron/preload/index.ts`
    - `electron/api/routes/`
    - `src/lib/api-client.ts`
  - 这一步先不做什么：不扩第三方扩展安装。
  - 怎么算完成：
    1. 已迁移能力的旧主进程入口被删掉
    2. Renderer 不再新增新的直连 IPC/直连 Gateway 路径
  - 怎么验证：
    - 边界检查脚本
    - 全量回归测试
  - 对应需求：`requirements.md` 需求 5、需求 6
  - 对应设计：`design.md` §2.2、§5.3、§6.2

- [ ] 4.2 补齐扩展状态、日志、故障恢复和观测
  - 状态：TODO
  - 这一步到底做什么：把扩展状态快照、Bridge 状态、宿主重启、结构化日志和用户可见降级提示补全。
  - 做完你能看到什么：系统故障不再只能看控制台猜，维护者有正式证据链。
  - 先依赖什么：4.1
  - 开始前先看：
    - `requirements.md` 需求 7
    - `design.md` §4.2、§5
    - `design.md` §7.2、§7.3
  - 主要改哪里：
    - `packages/matchaclaw-extension-host/src/`
    - `electron/shell/process/extension-host-supervisor.ts`
    - `src/workbench/` 中的状态提示组件
    - 日志与测试文件
  - 这一步先不做什么：不扩市场、权限模型二期。
  - 怎么算完成：
    1. 扩展和 Bridge 状态可见
    2. 宿主崩溃、扩展失败、Gateway 断连都有明确日志与 UI 语义
  - 怎么验证：
    - 故障注入测试
    - 手工断开 Gateway / 杀宿主进程验证
  - 对应需求：`requirements.md` 需求 7
  - 对应设计：`design.md` §4.2、§5、§7.2、§7.3

- [ ] 4.3 同步文档、目录职责和打包链路
  - 状态：TODO
  - 这一步到底做什么：让 README、CHANGE、打包脚本、路径说明、开发者文档都能反映新架构，并在这一阶段再做 `electron/main -> electron/shell` 的物理目录迁移和别名清理。
  - 做完你能看到什么：新接手的人可以看文档理解系统，不需要猜“扩展宿主到底在哪”。
  - 先依赖什么：4.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `CHANGE.md`
    - `README*.md`
  - 主要改哪里：
    - `CHANGE.md`
    - `README.md`
    - `README.zh-CN.md`
    - `README.ja-JP.md`
    - 打包与启动脚本
  - 这一步先不做什么：不追加功能。
  - 怎么算完成：
    1. 文档能说明双插件体系和目录边界
    2. 打包链路知道如何包含 Extension Host 和 builtin extensions
    3. `electron/main` 的过渡别名已清理，物理目录与语义一致
  - 怎么验证：
    - 文档走查
    - 打包 smoke test
  - 对应需求：`requirements.md` 非功能需求 3
  - 对应设计：`design.md` §2.3、§7.4

### 最终检查

- [ ] 4.4 最终检查点
  - 状态：TODO
  - 这一步到底做什么：确认这次架构重构真的把 MatchaClaw 带到“双插件体系 + 独立扩展宿主”的目标上，而不是只加了几个目录名。
  - 做完你能看到什么：需求、设计、任务、代码、验证证据能一一对应。
  - 先依赖什么：4.1、4.2、4.3
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
    - `CHANGE.md`
  - 主要改哪里：当前 Spec 相关全部文件与最终实现文件
  - 这一步先不做什么：不再追加新需求。
  - 怎么算完成：
    1. Main Shell / Workbench / Extension Host / OpenClaw Bridge 边界已成立
    2. 双插件体系目录和协议已落地
    3. 至少有一批 builtin extension 完成迁移验证
    4. 日志、故障恢复、文档和打包链路已同步
  - 怎么验证：
    - `pnpm run typecheck`
    - `pnpm test`
    - 关键集成测试与 smoke test
    - 按 Spec 文档逐项人工核对
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文
