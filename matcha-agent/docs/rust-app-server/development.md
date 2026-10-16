# Rust app-server 开发约定

本页供并行开发 Agent 接任务、实现和交付；只规定执行边界，不另建一套编码标准。

## 1. 事实源与文档分工

- 编码前读根 [CODING_CONSTITUTION.md](../../../CODING_CONSTITUTION.md) §26：在最终语义的最窄正确边界修改，不叠补丁层。
- Rust 命名、模块、可见性和错误遵循 [实现规范](../../../RUNTIME_HOST_TS_RUST_IMPLEMENTATION_STANDARD.md) §1–5；引用它不代表归入 runtime-host。
- 写任务说明时按 [提示词指南](../../../docs/agents/prompt-writing-guide.md) §1、5、13、14、18、20，写触发条件、动作、失败处理和验证，不写品质口号。
- [README.md](README.md) 是入口；[architecture.md](architecture.md) 说明责任，不在本页复制架构。
- [capabilities.md](capabilities.md) 记录源码支持；[runtime-layout.md](runtime-layout.md) 说明运行家目录与物理布局。
- [protocol-execution.md](protocol-execution.md) 负责协议与并发 CLI 执行；[diagnostics.md](diagnostics.md) 负责具体错误与排查。
- 文档举例不等于已实现；能力是否存在以对应源码与实际调用链为证，矛盾交给主 owner 收口。

## 2. 已定目标与未定事项

- **已定**：独立 Rust app-server；不是 runtime-host integration 改造，也不是把现有 CLI 改写成 Rust。
- **已定**：一个 Server 进程共用一个异步 runtime，承载多 CLI 会话；不按产品 Agent 或会话各建 Server/runtime。
- **当前授权**：用户已明确授权以“带高级 claudecode 开发的思想定位修复”Vite 构建与初始化两项缺陷，可修改必要 CLI 构建/源码；不重写 CLI 引擎。工具执行、模型调用、上下文构建继续由 CLI 拥有，不在 Server 重写。
- **已定**：每个产品 Agent 有独立 workspace；不新增产品级 projects 分区，CLI 原生 projects 仅是物理存储细节。
- **FROZEN**：独立 `matcha-agent/app-server/` 工程，package/bin `matcha-app-server`、lib `matcha_app_server`；不接入 runtime-host Cargo workspace。精确共享接口以 [contracts.md](contracts.md) 为准。
- 未逐项标为 FROZEN 的 IDs、配置路径、API、event、errors、store 契约和导出面，不因本页列举而自动冻结。
- 发现源码不支持的理想能力时，记录缺口与受影响任务；不伪造成功、不顺势开发缺失能力。

## 3. 接任务后怎么动手

1. 读取任务卡、独占文件和依赖契约；确认目标对象与只读边界，不用目录名推测行为。
2. 沿本功能的入口、直接调用方/被调用方、状态事实源和验证入口读源码；复用已有 parser、schema、类型和夹具。
3. 遇到 OPEN 共享依赖，向其 owner 提交具体缺口；只继续不依赖它的研究或独立工作，不猜类型写下游。
4. 输入明确后直接实现最终保留路径；不先搭临时 bridge、fallback 或兼容壳等以后替换。
5. 修改已有路径时，同一任务闭合实现、被取代路径清理和残留检查；独立 Server 不以此为由删除或改写现有 CLI。
6. 碰到范围外问题只报告；不借编译错误、文档补充或“顺手优化”扩大任务。

## 4. 按真实职责落模块

以下是逻辑落点，不是目录冻结，也不是一次性创建清单；实际路径须等源码落点定案。

| 逻辑落点 | 承担的责任 | 不放什么 |
| --- | --- | --- |
| `src/main.rs` | 参数入口、配置加载调用、资源装配与启动/退出协调 | 业务规则、协议解析、存储实现 |
| `config` | Server 自有配置的解析、校验与路径解析 | CLI 配置规则的第二份实现 |
| `gateway` | 已冻结的对外协议、输入校验与调用分派 | 会话事实、CLI 内部逻辑 |
| `agent` | 产品 Agent 身份、workspace 绑定与自身规则 | projects 产品分区、会话全量状态 |
| `session` | Server 自有会话事实、关联与读取规则 | CLI transcript 的平行事实源 |
| `run` | 一次执行的归属、状态转换与终止结果 | 工具、模型或上下文运行引擎 |
| `cli` | CLI 子进程、协议读写与真实资源回收 | 模型请求、工具实现、产品通用内核 |
| `diagnostics` | 安全日志与对外诊断投影 | 吞并各功能模块的状态和业务错误 |

- 每个功能模块拥有自己的接口、规则、状态及实际需要的资源/存储；无状态模块不用补状态。
- 存储随事实 owner 放置，先证明需要保存什么、谁写谁读；不预设数据库或全局万能 Store。
- 纯规则优先函数；持有进程、连接、task 等资源时，才定义对应的停止、回收与失败语义。
- 不强制每模块有 trait、线程、actor、DB 或 `init/start/stop` 空方法；没有真实实现就不建文件和目录。
- 只在独立责任、变化轴或真实消费边界出现时拆模块/crate；不机械按行数或一个类型一个文件拆分。
- 不造通用 plugin/kernel，不用跨领域 `common/utils/types` 收纳尚未想清归属的内容。

## 5. 命名、状态与错误

- package 用 lowercase kebab-case；crate、模块、文件、函数、字段用 `snake_case`。
- 类型、trait、variant 用 `UpperCamelCase`；常量和 static 用 `SCREAMING_SNAKE_CASE`。
- 缩写按词处理：`HttpClient`、`RpcError`、`SessionId`；常量可用 `HTTP_TIMEOUT`。
- 路径已有上下文就省去重复产品/模块前缀；保留身份、动作、单位和状态语义，不为短而缩成 `mgr/svc/proc`。
- 不把 `Manager/Service/Helper/Processor` 当默认分层；名称必须说明持有什么事实、资源或稳定角色。
- 不机械禁止标准库 `Read/Write`、惯用泛型 `T` 或边界已冻结的 `Data`；判断调用点语义是否完整。
- 不同身份、顺序、消息和执行归属不得混用；共享 ID 类型及 wire 拼写由契约 owner 定，不在下游自造 alias。
- 核心流程用能表达合法转换和终止原因的类型；不以多组 bool、空串或泛化 `Failed` 抹平状态。
- `Option` 表示合法缺失，`Result` 表示失败；保留错误来源及调用方需要分支处理的原因。
- 业务错误留在其事实/动作边界；主 owner 统一跨边界映射，不让 `diagnostics` 或万能 Error 吞并差异。
- wire DTO、领域状态与持久化形状不共用万能 struct；只向真实消费者暴露所需接口。
- 对外错误和日志不泄漏密钥、完整环境、私密路径或原始请求体；具体分类与排查查 diagnostics 文档。

## 6. 共享面先冻结，再并行

- 主代理为每个共享面指定唯一 owner：IDs、配置与路径、API/event/errors、store 契约、exports、Cargo 清单及锁文件。
- 该 owner 先从源码与目标语义提出契约，标出 **FROZEN** 的具体定义、权威位置和受影响消费者。
- 未定内容明确标 **OPEN**，附缺少的输入和负责人；不能用“基本确定”冒充冻结。
- 新增核心协议必须明确字段、必填/缺失语义、关联关系、错误与事件边界；不能静默把示例 JSON 当最终契约。
- 这些定义放回对应事实文档或实际共享定义；本页不重复维护一份字段表。
- 共享定义由单 owner 先落定；其余 Agent 不并发修改同一类型、导出入口、配置路径或 Cargo 文件。
- 只有依赖已冻结且文件无冲突的下游才能写实现；OPEN 期间允许只读研究及与该依赖无关的独立任务。
- 契约需变更时，先回到其 owner 更新定义并通知消费者；不由某个下游偷偷补字段、默认值或兼容分支。
- 跨模块错误、事件归属或状态事实源冲突，由主 owner 裁定；局部 Agent 不各自加映射来绕开冲突。

## 7. 并行派发与任务卡

- 按文件、模块或明确路由划独占写边界；所有开发 Agent 写当前工作区，不创建 worktree。
- 主代理不同时写已派发文件；需要接手时先停止该文件的并行写入并确认交接。
- 新文件也要声明 owner；共享 `main.rs/lib.rs/mod.rs` 装配和 exports 由指定 owner 串行整合。
- Agent 发现必须越界修改时先交回缺口与建议，不直接编辑另一 Agent 文件。
- 主代理收到交付后按依赖就绪继续派发可并行任务，不等待所有无关任务结束，也不要求用户手动触发调度。
- 并行任务使用普通 Agent，不使用 workflow；子代理未经主代理分派，不继续派生写入任务。

每张任务卡只写足以执行的字段，不为每个字段再生成一份报告：

```text
owner: 唯一负责人
files: 独占可写文件；共享文件的写入 owner
依赖: 所需任务/契约及 FROZEN 或 OPEN 状态
inputs: 源码、事实文档和已定业务输入
output/contract: 本次可交付行为、接口及明确不做的内容
旧路径边界: 被替代路径如何收口；只读或必须保留的路径
验证: 现有入口、预期结果与需要的真实链路证据
```

- 无被替代路径就写“不涉及”；不能把现有 CLI 标成待删旧实现。
- 交付只报改动文件、契约影响、验证结果与阻塞；不把待办或研究结论写成实现完成。

## 8. 验证与完成口径

- 实现任务优先复用既有构建、检查、测试和原生验证入口；先确认命令不会修改任务外文件。
- 未获用户明确授权不编写测试代码；不创建顺手验证脚本，也不跑会修改全仓的 lint-fix/precheck。
- Rust 工程和 package 尚 OPEN 时，不编造 `cargo -p` 命令；定案后使用真实 manifest/package 的定向检查。
- 每项验证报告执行命令与结果；失败写失败，跳过写原因和未覆盖边界，不把“未运行”归为通过。
- 编译、mock 或静态检查只能证明对应层级；要求真实链路证明的行为，必须有真实入口到结果的证据才称实现完成。
- 真实链路证据按任务覆盖并发会话、Agent/workspace 归属、执行事件及资源回收；具体场景以 protocol-execution 为准。
- 模块通过不代表整条链路完成；未接线、协议未冻或真实运行未验证，明确标记当前状态。
- 文档整理阶段只做文档校验；本次已获授权进入生产实现，按 [contracts.md](contracts.md) 与 [进度](progress.md) 交付。无模型、无账号登录的服务/CLI 本地验证可以执行，外部发布或敏感外发仍须单独授权。
- 当前 Vite alias key 与 CLI 共享配置截断导致的初始化 exit 1 根因均已修复；最终正式产物保留 splitting（state 1 module ID/1 chunk、646 split chunks），4×8 CLI 完整非模型链、240 次并发 RMW 与真实 reader 无损坏，以及 Windows 占用/EACCES 失败保全均已验证。同步持锁 fresh read→updater 一次→temp flush/原子 rename→成功后 cache；ELOCKED 与 Windows EPERM 仅等待资源，不重放业务请求或 updater。原旧 Bun 产物现已实证 migrationVersion 提交经无锁/非原子 fallback 抛 EBUSY、异常后自然 exit 0 的同型机制；配置单路径与共享同步 fatal exit 1 已修复并有真实 CLI 验证，不靠 Rust 重试。原两次历史无栈，不追认各次精确触发；Rust→真实 CLI migration rename EBUSY 注入已验证唯一 Failed terminal、安全因果诊断、旧 file/cache 保全和进程回收；真实 stderr broken pipe 直接观测 EPIPE 后仍 fatal exit 1。旧 dist 未覆盖，验证产物不设默认，runtime-host 未切换；模型/外部/跨平台未验。细节和历史保留在 [进度](progress.md)。

## 9. 交付前短检查

- 文件是否都在独占范围内，共享面是否由唯一 owner 冻结，OPEN 是否仍被如实标记？
- 执行接入是否有真实源码入口或明确缺口，新增管理能力是否在任务范围内，模块是否各有归属且无空目录、平行事实源和临时兼容路径？
- 验证是否有结果，失败/跳过是否说明，完成声明是否只覆盖已有证据？
- 必要 CLI 构建/源码修改仅限本次获授权的两项缺陷；禁止重写 CLI 引擎或改 Host/Renderer、旧 TS app-server、CLAUDE.md 及任务外代码，禁止无关优化与擅自新增能力。
- 满足本任务交付条件即停止，不追加 scaffold、测试、全仓修复或第二套标准。
