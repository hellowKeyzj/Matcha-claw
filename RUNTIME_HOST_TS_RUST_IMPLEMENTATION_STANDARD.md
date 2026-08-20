# Runtime Host Rust 代码规范

> 这是一份面向长期维护的代码规范。它只规定 Rust 代码应当如何命名、分层和控制文件职责，不把迁移流程、发布流程或项目管理要求混入实现规范。

## 1. 核心原则

### 1.1 先划职责，再写代码

每个新 module、type 和函数都必须回答：

- 它拥有哪一种事实、资源或规则？
- 谁调用它？
- 它改变什么状态，或读取什么观察？
- 它的失败由谁处理？
- 它在哪个边界停止？

如果一个对象同时负责协议解析、状态转换、文件写入、重试、事件发布和错误投影，先拆职责，不要靠增加注释或继续加私有函数掩盖边界问题。

### 1.2 事实、机制和投影分开

```text
事实 owner       保存可写 canonical state
机制             提供不理解业务的能力
adapter          翻译外部协议或 native runtime
projection       从事实生成可重建的对外视图
```

不要因为一个 struct 被多个模块调用，就把它升级为全局 owner；不要因为两个类型字段相似，就把它们合并成通用状态。

### 1.3 类型表达不可混淆的语义

不能互换的 ID、时间、字节数、端口、序列号、revision 和路径，不要长期以裸 `String`、`u64` 或 `usize` 在业务核心传递。优先使用 newtype、enum 和判别结构，让非法组合无法自然构造。

## 2. crate、目录与 module

### 2.1 crate 的边界

只有以下情况才值得建立 crate：

- 独立的事实 owner；
- 独立的协议或 trust boundary；
- 独立的编译依赖/feature 边界；
- 至少一个真实 consumer，且其边界需要独立演进。

不要为以下原因建 crate：

- 缩短 import；
- 一个 type 一个 crate；
- 复制旧 TypeScript 目录；
- 为未来功能预留；
- 制造“core/kernel/common”形式上的中间层。

crate 依赖方向应表现真实的 ownership，不得通过 re-export 隐藏反向依赖。

### 2.2 module 的边界

module 是同一语义上下文内的内聚边界，不是文件收纳箱。以下内容通常应放在一起：

- 一个资源的 identity、状态、合法转换和错误；
- 一个协议的 wire decode、验证和 DTO 映射；
- 一个 owner 的 command、query 和 projection；
- 一个生命周期对象的 operation、terminal outcome 和 shutdown。

以下内容通常应分开：

- wire DTO 与领域类型；
- 状态转换与 I/O；
- native protocol 与产品领域事实；
- command 与 event；
- canonical state 与 cache/projection；
- graceful stop 与 physical kill。

模块名必须让调用者从路径看懂上下文。禁止新增以下跨语义垃圾桶：

```text
common/ shared/ utils/ helpers/ base/ misc/ types/ impl/
```

### 2.3 文件不是责任单位

不要机械执行“一种 type 一个文件”，也不要把多个独立 owner 塞进一个大文件。文件应围绕责任、生命周期或协议变化。

推荐：

```text
process/supervision/     # 一个生命周期机制
session/hydration/       # 一个 session 读取/重建责任
transport/dispatch/      # 一个协议边界
```

不推荐：

```text
types.rs                 # 混合所有领域类型
helpers.rs               # 混合所有辅助函数
services.rs              # 混合所有业务 service
```

## 3. 命名

### 3.1 Rust 基本形式

| 项目 | 形式 | 示例 |
| --- | --- | --- |
| package | lowercase kebab-case | `matcha-agent` |
| crate/module/file/function/field | `snake_case` | `matcha_agent`、`request_stop` |
| struct/enum/trait/type alias/variant | `UpperCamelCase` | `ProcessIdentity`、`SupervisorPhase` |
| const/static | `SCREAMING_SNAKE_CASE` | `DEFAULT_STOP_DEADLINE` |

initialism 按一个词处理：

```text
HttpClient   RpcError   ProcessId   Utf8Path
http_client  rpc_error  process_id  utf8_path
HTTP_TIMEOUT RPC_VERSION
```

外部 wire、操作系统 API 或品牌已经冻结的拼写，可以只在边界保留原拼写；内部名称仍保持 Rust 形式。

### 3.2 类型命名

类型名表达以下之一：

- 身份：`SessionId`、`EndpointRef`；
- 值域：`ByteCount`、`Revision`；
- 稳定角色：`Supervisor`、`Catalog`、`Store`、`Probe`；
- 状态面：`SupervisorPhase`、`ApplyStatus`、`ConnectionState`；
- 协议事实：`EventEnvelope`、`CommandReceipt`。

不要默认使用：

```text
Manager  Service  Helper  Processor  Controller  Handler  Data  State  Info
```

如果这些词确实是外部协议或产品稳定术语，必须由 module 上下文补足其语义，不能把它们当作默认架构层。

### 3.3 状态、命令与事件

三者使用不同的类型和词形：

```rust
pub enum SupervisorPhase {
    Idle,
    Starting,
    Running,
    Stopping,
    ShutDown,
}

pub enum SupervisorCommand {
    Start,
    RequestStop,
    Restart,
}

pub enum SupervisorEvent {
    ProcessStarted { process_id: ProcessId },
    ProcessExited { exit_code: Option<i32> },
}
```

- 状态表示当前可达阶段；
- 命令表示意图；
- 事件表示已经发生的事实；
- 不用多个 bool 拼出状态机；
- 不用 `Unknown`、`Failed` 这种没有领域上下文的 variant 隐藏不同原因。

### 3.4 函数和 method

函数名表达动作或明确查询：

```text
launch
request_stop
persist
publish
read_transcript
observe_status
reconcile_revision
```

无副作用的判断使用：

```text
is_*   has_*   can_*   should_*
```

构造和转换遵循 Rust 约定：

- `new`：不会失败、没有 I/O、输入已完整合法；
- `try_new`：需要校验、解析或取得资源；
- `from`/`into`：明确的值转换，不隐藏副作用；
- `as_*`：借用视图或不取得所有权的转换；
- `get_*`：只用于真正的 lookup/fetch；普通 accessor 用领域名，如 `phase()`、`endpoint()`。

不要把启动、网络、持久化或隐式全局查找藏进 `new`、`from` 或 accessor。

### 3.5 field 与局部变量

名称必须携带角色、单位和可空语义：

```rust
stop_deadline: Duration
observed_at: Instant
payload_bytes: ByteCount
endpoint_session_id: NativeSessionId
```

避免：

```text
data item value flag state ctx req res mgr svc proc
```

小作用域内上下文明确时，`tx`、`rx`、`cfg`、`spec` 可以使用；跨 module field、public API、日志字段应写完整名称。

bool 使用正向语义：

```text
is_ready
has_pending_restart
restart_requested
```

`Option<T>` 表示合法缺失；`Result<T, E>` 表示动作、I/O 或解析失败。不要用空字符串、`0`、magic number 或 bool 隐藏它们。

## 4. API、错误与可见性

### 4.1 public API

- `pub` 是长期承诺，只为真实 consumer 暴露；
- public item 必须在预期 import path 中自解释；
- 不把旧 TS owner、迁移阶段、文件组织或底层句柄写进 public 类型名；
- wire DTO、领域类型、持久化类型分别命名，不共用一个万能 struct；
- `pub(crate)` 优先于过早 `pub`；
- 不用 re-export 掩盖错误依赖方向。

### 4.2 错误

错误应按失败边界和领域动作命名：

```text
LaunchError
TransportDecodeError
SessionReadError
ConfigPersistError
```

variant 表达调用方可以分支处理的原因：

```text
InvalidInput
NotReady
Timeout
ConnectionClosed
PermissionDenied
CommitUnknown
OutcomeUnknown
```

错误类型不应向 Renderer、parent transport 或日志的公开面泄露：

- secret；
- 绝对路径；
- argv/environment；
- SQL 或底层数据库细节；
- provider 原始 body；
- backtrace。

可以保留内部 source/context，但对外 projection 应使用稳定、安全的错误类型。

### 4.3 可见性与生命周期

持有文件句柄、连接、task、channel、timer、process handle 或 cache 的 struct 才应成为资源 owner，并拥有显式的 `stop`、`close` 或 `join` 语义。纯规则优先写成 module-level function，不为一次转换制造对象。

`Drop` 只做无需报告结果的尽力清理；需要确认的 flush、commit、stop、join 和 shutdown 都走显式的可失败函数。

## 5. 文件规模与职责边界

### 5.1 不设机械上限，但禁止无边界增长

文件行数不是架构边界，因此不以某个固定数字自动要求拆分。与此同时，“不设上限”不等于允许文件无限膨胀：一个文件大到无法在局部上下文中理解其 owner、状态转换、错误和副作用时，就是设计信号，而不是值得维护的终态。

普通手写生产文件应当保持在**一个责任可以被完整审阅和讲清楚的范围**内。文件明显进入大文件规模时，必须重新检查职责是否漂移；通常应优先寻找真实边界，但不能仅凭行数强拆。大型、稳定且内聚的协议表、状态机或生成内容可以保留，前提是它们确实只有一个变化原因。

行数只能作为观察信号：它可以提醒 reviewer 回看职责、耦合和变化轴，但不能单独构成失败条件、拆分理由或合并理由。统计工具可以报告行数，不能把行数报告解释成代码质量结论。

### 5.2 何时应该拆分

只有出现真实的语义边界时才拆分，例如：

- 不同的事实 owner 或资源 owner；
- 不同的生命周期、并发模型或 shutdown 责任；
- wire 解码、领域规则、持久化 I/O、外部副作用之间形成独立变化轴；
- public contract 与 private implementation 需要不同可见性；
- 不同平台、feature 或协议分支可以独立演进；
- 一个部分可以在不加载另一部分的情况下被独立测试或复用；
- 文件中的类型需要不同的错误模型、权限边界或 trust boundary；
- 读者必须在同一文件的多个无关区域之间跳转，才能理解一次状态转换。

拆分后，每个新 module 都必须有一个能用一句话说明的责任，并且调用路径仍然比拆分前更容易理解。为了拆分而增加的 facade、re-export、间接调用和跨 module 状态传递，不能被“文件变小”抵消。

### 5.3 何时不应该拆分

以下理由本身不足以拆分：

- 达到某个行数；
- 一个 type 一个文件；
- 减少 import 长度；
- 让目录看起来对称；
- 复制旧 TypeScript 目录；
- 把几个相互依赖的状态类型分散到多个文件；
- 把代码移动到 `utils`、`common` 或 `types`。

如果文件仍然围绕同一个 owner、协议或生命周期，且类型、状态转换、错误和 I/O 放在一起能让调用者更容易理解，就不要为了追求小文件而拆分。`main.rs` 和 `lib.rs` 同样按职责判断：入口、导出和 composition 应保持清楚，混入业务规则、协议细节或资源生命周期时才拆出。

### 5.4 generated code 与测试

生成代码应与手写逻辑隔离，并由生成工具维护；不能为了满足人工文件偏好手工压缩或拆改生成结果。

测试代码按被验证的责任组织。测试文件可以与对应的状态、规则和 fixture 保持邻近；只有在测试拥有不同领域、生命周期或 fixture 语义时才拆分。测试文件不因行数自动拆分。

### 5.5 文件复查问题

当文件变长或结构变复杂时，reviewer 只需要判断：

1. 它是否仍只有一个 owner、协议或生命周期责任？
2. 类型、状态转换、错误和副作用是否仍能沿一条局部路径理解？
3. 是否出现多个独立变化轴、重复上下文或跨领域条件分支？
4. 拆分后是否会形成更清楚的 public boundary，还是只增加间接层？
5. 如果不拆分，能否用一句话解释为什么这些内容必须共同演进？

结论不是“超过某行就拆”，而是：**不允许无理由的大文件，也不允许为了行数制造碎片化模块。**

## 6. Review 时只问四件事

1. 这个名字是否准确表达当前语义，而不是旧 TS 文件名？
2. 这个 module 是否只有一个清楚的 owner/协议/生命周期责任？
3. 这个 public API 是否有真实 consumer，且没有泄露内部实现？
4. 这个文件变长是因为责任变复杂，还是因为边界已经漂移？

代码规范的目标是让系统更容易理解和演进，而不是用形式化门槛替代工程判断。
