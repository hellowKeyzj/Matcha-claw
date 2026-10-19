# 首次实现共享契约

状态：**FROZEN**，2026-10-16。当前用户已授权按本目录约束持续并行实现；此前 docs-only 的限制仅描述上一项任务，不阻止本次实现。未列入本契约的功能沿用能力矩阵的条件与缺口，禁止伪造支持。

## 1. 工程与边界

- 独立工程：`matcha-agent/app-server/`，Cargo package/bin `matcha-app-server`，library `matcha_app_server`；Rust 2024、1.97。一个 crate、职责 modules，不依赖 runtime-host crate。
- 主代理唯一持有 `Cargo.toml`、`Cargo.lock`、`src/lib.rs`、`src/main.rs`、`src/rpc.rs` 和本文。其余文件由任务卡独占。
- Tokio 多线程 runtime；Axum HTTP/WS；serde/serde_json；rusqlite WAL；uuid；thiserror；futures-util；必要平台 API。仅添加实际消费的依赖。
- 用户已明确授权以“带高级 claudecode 开发的思想定位修复”Vite 构建与初始化两项缺陷，可修改必要 CLI 构建/源码，不重写 CLI 引擎；现有 TS app-server 仍只读。独立 Server 不复用旧 TS app-server，不修改 Host/Renderer，不在此次自动删除旧服务。
- 原生功能有入口才接入；没有确定性外部入口的 Team/Workflow 等提供真实观察/能力说明，不通过模型 prompt 冒充管理操作。
- 当前验证状态：Vite alias key 与共享 `.claude.json` 非原子写截断导致的初始化 exit 1 根因均已修复；CLI 保持同步 API，以唯一持锁 fresh read→updater 一次→temp flush/原子 rename→成功后 cache 路径提交，不保留无锁或截断 fallback。资源等待不重放业务请求或 updater。最终正式 Vite 产物 state 1 module ID/1 chunk、646 split chunks，4×8 CLI 完整非模型链及并发 RMW/失败保全验证通过；不放宽 Rust 身份校验。原旧 Bun 产物已实证 migrationVersion 经无锁/非原子 fallback 抛 EBUSY 后自然 exit 0 的同型机制；配置单路径及共享同步 fatal exit 1 已修复，原两次历史无栈，不追认各次精确触发。Rust→真实 CLI migration rename EBUSY 注入已验证唯一 Failed terminal、安全因果诊断、旧 file/cache 保全和进程回收；真实 stderr broken pipe 直接观测 EPIPE 后仍 fatal exit 1，不改 Rust 契约或增加失败重试。旧 dist 未覆盖、验证产物不设默认，runtime-host 未切换；模型/外部/跨平台未验。历史、证据与未验边界见 [progress.md](progress.md)。

## 2. 共用接口

所有下面接口为 crate 内公开。异步接口不持锁等待模型；错误在各模块内部定义，RPC 投影使用 `rpc::Error`，不创建全局业务错误 enum。

### rpc（主代理）

```rust
pub type Result<T = serde_json::Value> = std::result::Result<T, Error>;
// Public fields only; use constructors because Error also owns a private, non-serialized cause.
pub struct Error { /* private source */ pub code: i64, pub message: String, pub data: Option<serde_json::Value> }
impl Error {
  pub fn new(code: i64, kind: &str, message: impl Into<String>) -> Self;
  pub fn invalid(message: impl Into<String>) -> Self;
  pub fn not_found(resource: &str) -> Self;
  pub fn conflict(kind: &str, message: impl Into<String>) -> Self;
  pub fn unavailable(kind: &str, message: impl Into<String>) -> Self;
  pub fn internal(kind: &str) -> Self;
  pub fn method(method: &str) -> Self;
  pub fn with_data(self, data: serde_json::Value) -> Self;
  pub fn with_source(self, source: impl std::error::Error + Send + Sync + 'static) -> Self;
}
pub fn params<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T>;
pub fn value<T: serde::Serialize>(value: T) -> Result<serde_json::Value>;
pub fn now_ms() -> u64;
```

JSON-RPC 标准错误保留原值；应用错误使用 -32001 not found、-32002 conflict、-32003 unavailable、-32004 native failure、-32005 storage、-32006 outcome unknown、-32007 unauthorized；`data.kind` 为稳定具体原因。输出错误不包含原始 stderr/source/路径/环境。`with_data` 合并而不丢失 kind。

### config（Agent 01）

- `Paths: Clone`；`Paths::new(root: PathBuf)`，`root(&self)->&Path`，`config_file()->PathBuf`，`database()->PathBuf`，`agent_dir(&str)->rpc::Result<PathBuf>`，`workspace(&str)->rpc::Result<PathBuf>`，`runtime(&str)->rpc::Result<PathBuf>`，`state(&str)->rpc::Result<PathBuf>`。Agent ID 为 ASCII 字母数字及 `-_`、非空，避免任意路径。
- `pub fn validate_id(&str)->rpc::Result<()>`；`validate_agent_id_available(config:&Config,agent_id:&str)->rpc::Result<()>` 复用中央身份/路径碰撞校验，在 Agent 创建的首次磁盘副作用前及最终提交时调用。
- `Config: Clone + Serialize + Deserialize + Default`，camelCase：`listen: SocketAddr`（默认 127.0.0.1:0）、`auth_token_env: Option<String>`、`cli: CliConfig`、`agents: BTreeMap<String,AgentConfig>`、`providers: BTreeMap<String,Value>`、`schedules: BTreeMap<String,Value>`、`channels: BTreeMap<String,Value>`。
- `CliConfig`：`command: PathBuf`（默认 ccb）、`args: Vec<String>`、`env: BTreeMap<String,String>`。env 的 value 是**来源环境变量名**，不是明文值；私密执行 env 仅由 CLI 启动投影解析，Task 读取只复用非秘密的列表绑定/Todo 上下文规则，不读取 Provider Key。 [VERIFY: matcha-agent/app-server/src/cli/projection.rs] [VERIFY: matcha-agent/app-server/src/task/context.rs]
- `AgentConfig: Clone + Serialize + Deserialize + Default`：`name: String`、`model: Option<String>`、`provider: Option<String>`、`system_prompt: Option<String>`、`append_system_prompt: Option<String>`、`settings: Value`（默认 {}）、`tools: Option<Vec<String>>`、`allowed_tools: Vec<String>`、`disallowed_tools: Vec<String>`、`channels: Vec<String>`；camelCase。
- `ConfigStore: Clone`；克隆共享同一个 confirmed/unresolved 状态，不复制配置事实源。`ConfigStore::open(paths: Paths)->rpc::Result<Self>` async（不存在则创建默认配置）；`paths(&self)->&Paths` 返回按启动 cwd 解析的绝对根；`snapshot(&self)->Config` async；`update<F,R>(&self,F)->rpc::Result<R>` async，其中 `F: FnOnce(&mut Config)->rpc::Result<R> + Send`、`R: Send`。先校验、原子持久化，再更新内存；单 writer，不覆盖失败前配置。提交 -32006 后保留最后确认 snapshot、冻结后续 update 并明确 unresolved 状态，重启读回恢复，不自动重试或假回滚。
- 原生默认身份为真实 `kind=Agent` 的 `matcha`，不是占位项。`open` 缺省补入、已有定义不覆盖，update 校验必须保留；默认 delete/retire/finish_deletion 均拒绝。`agents.list` 返回真实 `defaultId="matcha"` 与 `selectionRequired=false`，不迁移旧身份、历史或路径；默认目录使用同一 Agent 布局且不授予 custody。[VERIFY: matcha-agent/app-server/src/config/mod.rs:254-278] [VERIFY: matcha-agent/app-server/src/config/validation.rs:82-110] [VERIFY: matcha-agent/app-server/src/agent.rs:74-79] [VERIFY: matcha-agent/app-server/src/agent.rs:165-172] [VERIFY: matcha-agent/app-server/src/agent.rs:318] [VERIFY: matcha-agent/app-server/src/agent.rs:444-445] [VERIFY: matcha-agent/app-server/src/agent/retirement.rs:20-26] [VERIFY: runtime-host/integrations/matcha-agent/src/agents/projection.rs:33-45]
- 公共配置 API 只返回明确的安全字段；settings 不接受 env/凭据，以原生 auth 或来源环境变量引用传递秘密。不要构造通用 JSON Patch 平台。

### persistence（Agent 02）

- `Database: Clone`；`open(path: &Path)->rpc::Result<Self>` async。
- `call<F,T>(&self,F)->rpc::Result<T>` async，`F: FnOnce(&mut rusqlite::Connection)->rpc::Result<T> + Send + 'static`，`T: Send+'static`。SQLite 工作放 `spawn_blocking`；同一 handle 单连接互斥，业务 owner 可打开自己的连接，不用全局业务锁。
- `atomic_write(path:&Path, bytes:&[u8])->rpc::Result<()>` async：同目录临时文件、显式写/flush/提交；Windows 覆盖替换正确，不先删除目标导致窗口丢失。保留具体 storage kind，提交无法确认区分结果未知。
- 表归属各模块，建表使用 `CREATE TABLE IF NOT EXISTS`，不造 migration framework。

### diagnostics（Agent 03）

- `Diagnostics: Clone`；`open(paths:&config::Paths)->rpc::Result<Self>` async。
- `record(&self, owner:&str, operation:&str, kind:&str, context:Value)->rpc::Result<()>` async。context 只接收调用点安全字段，模块内部再做限长/防秘密策略，绝不回退原文。
- `dispatch(&self,method:&str,params:Value)->rpc::Result<Value>` async；`diagnostics.query`。
- `retention_status(&self)->rpc::Result<Value>` async 返回 count/oldestAtMs/newestAtMs；`prune(&self,before_ms:u64)->rpc::Result<Value>` async 只删除自身 `at_ms < before_ms` 诊断记录并返回 deleted。无自动清理，不跨其他 owner 的表。
- 不记录原始 prompt/tool/stdout/stderr/env；使用适用 agentId/sessionId/runId/instanceId/nativeRequestId、阶段和具体原因。不得以观测失败覆盖业务成功。

## 3. CLI 执行接口

### cli::protocol（Agent 04）

- `NativeMessage` enum：`Result(Value)`、`ControlRequest { request_id:String, request:Value }`、`ControlResponse { request_id:String, response:Value }`、`ControlCancel { request_id:String }`、`Message(Value)`。`decode(&[u8])->rpc::Result<NativeMessage>`；按真实原生形状解码 response/cancel。
- `user_message(session_id:&str,message_id:&str,content:Value)->Value`；`control_request(request_id:&str,request:Value)->Value`；`control_response(request_id:&str,response:Value)->Value`；保留原生 snake_case 字段，input 支持字符串/原生内容数组。`control_response` 第二参是内层 `{subtype:"success",response:payload}` 或 `{subtype:"error",error:safeText}`，函数注入 `request_id` 再包外层；解码的 ControlResponse.response 同样保留完整内层，不丢失 success/error。
- native stdout 不向诊断透传。未知合法消息保留为 Message；畸形/缺必需字段显式失败。

### cli::process（Agent 05）

- `Launch { command:PathBuf, args:Vec<String>, env:BTreeMap<String,String>, cwd:PathBuf }`（env 为完整私有 child 环境，已继承并筛除冲突再解析引用，禁 Debug 原文）。process 不依赖 provider 业务，用 env_clear/完整环境传入；环境投影与 native env 名由 cli/projection 与 provider 唯一管理。
- `Process: Clone`；`spawn(Launch)->rpc::Result<(Process,mpsc::Receiver<Output>)>` async。
- `Output`：`Stdout(Vec<u8>)`、`StdoutClosed`（stdout EOF，及时拒绝 pending，不能只等 OS exit）、`Stderr`（只通知观察，不转存原文）、`Exited { code:Option<i32>, signal:Option<i32> }`、`ReadFailed { stream:&'static str, kind:String }`。
- `send(&self, bytes:Vec<u8>)->rpc::Result<()>` async（已含末尾 LF）；`finish_input(&self)->rpc::Result<()>` async（仅关 stdin，不限制命令自然运行时间）；`close(&self)->rpc::Result<()>` async（关 stdin、等待、必要时强制回收自己进程树）；`pid(&self)->Option<u32>`。
- stdout/stderr 独立排空；平台只按自有句柄/进程组回收。正常关闭等待沿用现有 5 秒资源回收窗口，非业务 deadline；不自动重启/重发。队列容量是 stdio 局部机制，不是会话数量限制，必须说明依据。

### cli（Agent 06，独占 cli/mod.rs、command.rs、projection.rs）

- `Cli: Clone`；`Cli::start(spec:LaunchSpec,diagnostics:Diagnostics)->rpc::Result<(Cli,mpsc::Receiver<CliEvent>)>` async；`request(&self,request:Value)->rpc::Result<Value>` async；`send_user(&self,session_id:&str,message_id:&str,content:Value)->rpc::Result<()>` async；`respond(&self,request_id:&str,response:Value)->rpc::Result<()>` async；`close(&self)->rpc::Result<()>` async；`instance_id(&self)->&str`。
- `LaunchSpec { pub config:config::Config, pub agent:config::AgentConfig, pub agent_id:String, pub session_id:String, pub paths:config::Paths, pub resume:bool, pub fork_from:Option<String> }`。
- `CliEvent`：`Message(Value)`、`Result(Value)`、`Request { request_id:String, request:Value }`、`Cancel { request_id:String }`、`Exited { code:Option<i32>, signal:Option<i32> }`、`Fault(rpc::Error)`。
- 此层独立读取/配对控制响应，request 不依赖 session 主循环处理输出才能完成。EOF/exit 拒绝全部 pending；取消/关闭不遗留任务。
- `model_requires_restart(&self)->bool` 返回实际实例启动环境是否存在阻断原生 set_model 的固定模型覆盖，不从后来配置推断。
- `cli/idle` 对 control/response 持有同实例 admission lease 至真实完成，完成时间参与连续 5 分钟空闲窗口；`prepare_to_sleep` 独占封口并使用 CLI strict schema `{subtype:"prepare_to_sleep"}` → `{status:"ready"|"busy"|"resident"}`。busy/resident 恢复准入，未知 ACK 不当 ready；`exited_gracefully` 还要求输出无 fault 与真实进程退出证据。 [VERIFY: matcha-agent/app-server/src/cli/idle.rs] [VERIFY: matcha-agent/app-server/src/cli/process/mod.rs] [VERIFY: matcha-agent/src/entrypoints/sdk/controlSchemas.ts]
- `pub(crate) fn has_autonomous_inputs(&self)->bool` 返回当前实例的启动输入风险：同一次 `channels(&spec)` 筛选后的渠道集合非空，或实际 launch env 未禁用原生 cron 且 launch cwd 的 `.claude/scheduled_tasks.json` 存在非空 tasks；文件无法读懂/确认时保守视为风险，文件缺失或 tasks 为显式空数组不构成该风险。判断归 CLI 启动层，复用实际投影，不检查无原生消费者的 `Agent.settings.scheduled_tasks`，不在 Session 缓存第二份事实。此值仅为启动快照，不证明后续 CronCreate、原生文件变动或自主输入永不发生；Session 仍以观察到的外来输入、多 result 和 proactive 状态累积歧义，不清除已有风险。新实例须在 consumer 启动及 managed user 发送前将启动风险 OR 入 active。
- start 在进程与独立输出 reader 启动后返回，不等待 initialize ACK；实例内部只发送一次 initialize。Server 显式要求 sandbox 时，ACK 后使用既有原生 get_settings 核验 merged effective，业务校验由 policy 拥有；不满足 required/fallback/exclusions/platform 条件则初始化失败关闭，不发送 managed user，也不声称已观测 OS 隔离。`initialized(&self)->rpc::Result<Value>` async 观察同一回执（多次等待不重发）。Session 必须先运行启动事件消费者，再等待 initialized；原生启动 hooks 可在 ACK 前产生任意数量 progress，禁止因此使用无界队列、丢事件或 backlog 杀进程。启动投影启用 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` 和 `--replay-user-messages`，移除 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`（字符串 0 仍会触发）供终态、UUID 关联且不自动重发未知 Run。
- `cli::command::run(config:&Config,paths:&Paths,agent_id:&str,args:Vec<String>)->rpc::Result<CommandOutput>` async；`CommandOutput { pub code:Option<i32>, pub stdout:String }`。run 拒绝非零 exit；`run_observed` 同签名仅返回真实 exit/输出，供已核实 `auth status` exit1 JSON 等原生命令契约解释，不能把所有非零当成功。stderr 不原文对外。单次命令须可取消并回收，不私设统一业务 timeout。
- `cli::projection::environment(config:&Config,paths:&Paths,agent_id:&str)->rpc::Result<BTreeMap<String,String>>` async；CLAUDE_CONFIG_DIR、provider env 引用、来源 env 缺失具体失败，不把空串假凭据。Server settings 单写 `state/settings.json`，原生命令经原生 `--settings` 加载；会话使用同一设置构建的完整 JSON `--settings`，只按该会话匹配的 enabled channel 覆写 `enabledPlugins["weixin@builtin"]`，不将差异写到共享文件。微信 fastpath 仅投影 env/cwd，不在 weixin 子命令前插入设置参数。`WEIXIN_STATE_DIR` 固定为 `runtime/channels/weixin`，禁止继承或自定义覆盖；否则原生会读取全局凭据。`runtime/settings.json` 归 CLI 原生命令/持久审批，不混写、不合并规则来源。原生 trusted `autoMemoryDirectory` 显式指向 `runtime/memory/`，不复制 Git/Bun.hash 路径算法，不覆盖 CLI auth store。

## 4. 业务模块入口

除下方特例，各叶子模块导出一个 async free function `dispatch(method:&str,params:Value,config:&ConfigStore)->rpc::Result<Value>`；仅获得自己的直接依赖。各自 DTO/错误/文件在独占模块内；方法不支持返回 `Error::method`，不得空成功。

| Agent | 文件/模块 | 方法家族与直接依赖 |
|---|---|---|
| 07 | agent.rs | `agents.list/get/create/update/delete`；默认 workspace 生命周期、配置 writer。dispatch 另收 `sessions:&Sessions`，删除/改绑定须避免活动资源。删除不默认物理抹盘。 |
| 08 | workspace/ | `workspace.list/read/write/mkdir/remove`、content 上传下载原语；根为 Agent workspace，真实 canonical 边界，拒绝 symlink 逃逸；dispatch 标准签名。另导出 `read_file(config,&str,&str)->rpc::Result<Vec<u8>>`、`write_file(config,&str,&str,&[u8])->rpc::Result<()>` async，供 HTTP。 |
| 09 | memory.rs、prompt.rs | `memory.list/read/write/delete`、`prompts.get/set`、`instructions.list/read/write`；文本原生文件、实际发现根、不要造向量库。标准 dispatch；两个模块各自函数。 |
| 10 | skill.rs | `skills.list/get/install/remove`；真实 SKILL.md 与引用目录，安装只复制内容不执行脚本；标准 dispatch，原生 user skills 投影到对应 runtime。 |
| 11 | plugin.rs | `plugins.list/install/uninstall/enable/disable/update/reload`；CLI 已有子命令；dispatch 另收 `sessions:&Sessions`（reload 走控制），不复制消费者。 |
| 12 | mcp.rs | `mcp.list/get/add/remove/status/reconnect/toggle/authenticate`；命令持久面与控制实时面分清，dispatch 另收 sessions。 |
| 13 | provider.rs | `providers.list/get/set/remove`、`models.list`、`auth.status/login/logout`；env 引用与 native auth，dispatch 另收 sessions；不返回 secret。 |
| 14 | policy.rs | `permissions.get/set`、`sandbox.status/set`、`hooks.get/set`；原生 settings 投影、apply_flag_settings/set_permission_mode；dispatch 另收 sessions；显式 sandbox 要求不得静默裸跑。 |
| 18 | task.rs、team.rs、workflow.rs | `tasks.list/get/create/update/stop`、`todos.get/write`、`teams.list/get`、`workflows.list/get` 与能力说明；taskList/todo 读取原生落盘资料，写入仍调 CLI 原生 owner；runtime task/Team/Workflow 不造 start/CRUD。dispatch 使用 sessions 窄接口。 [VERIFY: matcha-agent/app-server/src/task.rs] |
| 19 | schedule/、channel.rs | `schedules.list/get/create/update/delete/run`、`channels.list/configure/status/login/pair`；dispatch 另收 sessions；schedule 自有 durable 触发/receipt，微信复用原生命令。 |

各方法 ID 字段：Agent 相关 `agentId`，会话 `sessionId`，其余资源 `id`/`name`，文件 `path`（相对 workspace/各原生根），JSON camelCase。精确模块特有 DTO 由其唯一 owner 在实现处冻结并报告；gateway 不复制类型、只按方法家族转发。

TaskList/Todo 读取的绑定规则由 `task/context.rs::initial` 持有，仅复用 CLI projection 的环境名/凭据来源隔离机制，不走完整 execution environment 或解密。优先读取 CLI 在 `runtime/session-env/<UUID>/task-context.json` 原子保存的精确 `{listId:<sanitized string>,todoV2:<bool>}`；无文件才用既有非秘密 env / `--team-name` headless 规则。该文件只绑定原生 owner，不存 tasks 镜像或秘密。[VERIFY: matcha-agent/app-server/src/task/context.rs] [VERIFY: matcha-agent/app-server/src/task/files.rs] [VERIFY: matcha-agent/src/utils/tasks.ts] [VERIFY: matcha-agent/src/cli/print.ts]

### events（Agent 15）

- `Events: Clone`；`open(database:Database)->rpc::Result<Self>` async。
- `Event: Clone+Serialize+Deserialize` camelCase：`session_id:String, seq:u64, run_id:Option<String>, kind:String, at_ms:u64, payload:Value`。
- `query_kinds(&self,session_id:&str,after_seq:u64,through_seq:u64,kinds:&[&str],limit:usize)->rpc::Result<Vec<Event>>` async，为 usage 的真实结果计量提供 SQLite 定向过滤（不扫描全部 token payload），after 排他/through 包含。
- `append(&self,session_id:&str,run_id:Option<&str>,kind:&str,payload:Value)->rpc::Result<Event>` async；`append_batch(&self,session_id:&str,run_id:Option<&str>,items:Vec<(String,Value)>)->rpc::Result<Vec<Event>>` async。
- `replay(&self,session_id:&str,after_seq:u64,limit:usize)->rpc::Result<Vec<Event>>` async；`latest(&self,session_id:&str)->rpc::Result<u64>` async；`watch(&self,session_id:&str)->tokio::sync::watch::Receiver<u64>` async。
- 存储提交后推进 watch，watch 仅做唤醒，WS 从 durable cursor 拉取，慢客户端不阻塞 producer；watch 建立后 replay，可消除 replay/live 缝隙。过期/失败明确，不假 exactly-once。
- 文本更新尽量批量提交；不每 token fsync；保留管理事实顺序。

### session（Agent 16；history.rs 独占移交 Agent 18）

- `Sessions: Clone`；`open(config:Arc<ConfigStore>,database:Database,events:Events,interactions:Interactions,diagnostics:Diagnostics)->rpc::Result<Self>` async。
- `dispatch(&self,method:&str,params:Value)->rpc::Result<Value>` async：`sessions.create/list/get/close/resume/fork/setModel/setMode/setProactive`、`runs.submit/list/get/cancel`、`sessions.native`（查询初始化与观察到的 native 状态，不能 passthrough 任意命令）。
- `sessions.setProactive {sessionId,enabled:bool}` 只控制已存在实例，不懒启动；复用原生 `{subtype:"set_proactive",enabled}`，返回 `{sessionId,instanceId,enabled,nativeAcknowledged:true}` 只代表开关 ACK，不证明自主 tick 或模型已执行。每 Agent 既有短 guard 串行开关，接受后的 owned task 不因客户端断连夹断；不跨 Session 数据锁等待控制响应。snapshot 增加 `proactive:"unobserved"|"enabled"|"disabled"|"outcomeUnknown"`，表示本实例最后开关事实，默认 unobserved，不猜原生默认。发送前先标 outcomeUnknown 并令已 active Run 归属 ambiguous；成功 ACK 且实例仍匹配才确认 enabled/disabled，notSent 可还原上次开关事实，其他错误保留 unknown，不能凭错误文本猜未应用。关闭或替换实例重置；该状态不清除原有 channel/cron 自主输入事实，也不撤回 active 的歧义。后续 managed Run 使用启动自主输入事实 OR proactive enabled/unknown，不能冒领自主结果。未编入 feature 时保留原生具体 control error，不伪造支持。
- `submit(&self,session_id:&str,content:Value)->rpc::Result<String>` async（返回 runId）；`control(&self,session_id:&str,request:Value)->rpc::Result<Value>` async；`respond(&self,session_id:&str,instance_id:&str,request_id:&str,response:Value)->rpc::Result<()>` async；`is_agent_active(&self,agent_id:&str)->bool` async；`shutdown(&self)->rpc::Result<()>` async；`native_snapshot(&self,session_id:&str)->rpc::Result<Value>` async。
- Session 身份 UUID 与 CLI session_id 稳定对应；首次启动 `--session-id`，恢复 `--resume`；主工作目录始终对应 Agent。每会话一个串行 prompt 执行者，不同会话并发，控制/审批不等模型终结。
- `native_files(session_id)` 只提供该 managed Session 的 Agent/UUID/runtime/workspace；`persisted_history(session_id)` 只读原生 transcript 主链。两者不启动 CLI、不解析 Provider 凭据、不承接 TaskList schema/锁或 Todo 恢复业务。taskList/todo 读取回执内部 `instanceId:null`；对外 product DTO 不因此扩展。 [VERIFY: matcha-agent/app-server/src/session/mod.rs] [VERIFY: matcha-agent/app-server/src/task.rs] [VERIFY: runtime-host/integrations/matcha-agent/src/tasks/mod.rs]
- 同一 Session executor 在连续空闲 5 分钟后调用 `prepare_to_sleep`；忙、驻留、非持久化或仅内存不可恢复状态不回收，包括 initialize 的 systemPrompt/appendSystemPrompt 等配置及 live set_model 等 session-only 控制态，不保证所有普通会话都可回收。CLI 在原子输入封口后 flush transcript/事件/stdout 并复查，ready 后 Session 独立 sleep handoff 才 close/join 并验证 transcript/真实 graceful exit；未知握手或清理不伪作安全成功。不调用取消队列的 `close_execution`，逻辑 Session 保持 open；新消息先进入原 durable 队列，再按同 UUID resume 新 instance，旧未知 Run 不重发。 [VERIFY: matcha-agent/app-server/src/session/idle.rs] [VERIFY: matcha-agent/app-server/src/session/execution.rs] [VERIFY: matcha-agent/app-server/src/session/instance.rs] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/src/cli/structuredIO.ts]
- `agent_guard(&self,agent_id:&str)->tokio::sync::OwnedMutexGuard<()>` async：每 Agent 配置变更和会话创建/启动登记之间的短期互斥，不跨模型轮；`control_instance(&self,session_id:&str,instance_id:&str,request:Value)->rpc::Result<Value>` async：原子选定实例，防重启误控。
- `control` / `control_instance` 返回原生业务 payload；`control_observed(&self,session_id:&str,request:Value)->rpc::Result<Value>` async 返回 `{sessionId,instanceId,response}`，供需要同次实例证据的 MCP 观察，复用同一路径不再发一次请求。
- 写入前可证明未发送的错误带 `data.delivery="notSent"`，写入中失效/无法证明的返回 -32006、`delivery="unknown"`；错误包装不丢该证据，成功写入也不代表原生已应用。
- native_snapshot 稳定形状 `{sessionId,agentId,instanceId,launching,initialize,tasks,tools,proactive}`；proactive 是本实例原生开关的四态投影，不是独立 tick owner。launching 来自真实准入状态，initialize 为首次控制回执 payload，tasks 按 task_id 保留最后原生通知，tools 为最后观察到的 stream `system/init.tools` 字符串数组、未观察为 null，均随执行实例重置，不保存无限消息数组。Session status=`open|closed`；Run status=`queued|starting|running|cancelRequested|succeeded|failed|cancelled|outcomeUnknown`。native result 事件 kind=`native.result`，terminal 另为 `run.terminal`，保留原生 usage/modelUsage/total_cost_usd。
- 原生 result 不等于 OS exit，result.uuid 也不是输入 messageId。唯一 managed 输入、匹配 UUID ACK、单 result 与排空 idle 的已知串行边界才可归属该 Run 的结果；额外输入/task_notification/多 result 等混合证据无法证明归属时，Run 为 outcomeUnknown。所有 native.result 即时持久化为会话事实、runId:null，唯一归属仅在 terminal 中确认。未发送前的 startup idle 不终结；已发送且观察到 running/requires_action→idle 的周期即使缺 ACK，也以 native_input_not_acknowledged 结束 unknown 并释放执行槽，不能永挂。task_started 本身不等于额外顶层 prompt。取消 ACK 不终结；进程失联/重启恢复中的未决 Run 不自动重发。重启恢复管理行但不恢复已结束进程句柄。
- 原生内容事件供产品读取而非诊断；native tool/task/Team 状态不可凭空补造。history.rs 只读原生 transcript，Agent 18 独占实现：`locate(runtime:&Path,workspace:&Path,session_id:&str)->rpc::Result<Option<PathBuf>>` async、`read(path:&Path,session_id:&str,offset:usize,limit:usize)->rpc::Result<Value>` async，返回 `{messages,total,nextOffset}`。只定位指定 Agent runtime/projects，不另建 transcript writer、不加未被原生历史消费者证明的文件大小上限。

### interaction（Agent 17）

- `Interactions:Clone`；`open(database:Database,events:Events)->rpc::Result<Self>` async。
- `observe(&self,session_id:&str,run_id:Option<&str>,instance_id:&str,request_id:&str,request:Value)->rpc::Result<()>` async；`cancel(&self,session_id:&str,instance_id:&str,request_id:&str)->rpc::Result<()>` async；`close_instance(&self,session_id:&str,instance_id:&str)->rpc::Result<()>` async。
- `dispatch(&self,method:&str,params:Value,sessions:&Sessions)->rpc::Result<Value>` async；`approvals.list/respond`、`questions.list/respond`、`hooks.pending/respond`。request subtype 依真实 CLI 分流；未知 subtype 明确拒绝，不默认允许。
- 决定发送≠原生应用，竞争/重复/迟到保留具体结果。持久待办不等于重启后仍可回复原生已死请求。

### schedule（Agent 19 额外接口）

`start(config:Arc<ConfigStore>,sessions:Sessions,events:Events,diagnostics:Diagnostics)->rpc::Result<tokio::task::JoinHandle<()>>` async；`shutdown()->rpc::Result<()>` async 停止新触发并等待已认领提交，main 随后 join scheduler，不 abort 已接受提交。调度执行通过自有会话/已配置 session，不能持有主会话执行权重叠灌入 prompt；CLI native cron 与 Server durable schedule 不双触发。

Channel 自有登录流程与进程，提供 `shutdown()->rpc::Result<()>` async 显式回收；不创建通用登录任务平台。enabled 微信绑定唯一 agent/source/session，CLI 只将匹配的登记投影为原生 channel source。

### tool（Agent 10 接续）

`dispatch(method:&str,params:Value,config:&ConfigStore,sessions:&Sessions)->rpc::Result<Value>` async；`tools.list {sessionId,instanceId}`、`tools.get {sessionId,instanceId,name}`。仅投影该实例最后实际 stream init 的工具名称；未观察返回具体 unavailable，实例不符拒绝，不启动 query 或模型，不制造 schema、授权状态或调用入口。

### usage（Agent 04 接续）

`dispatch(method:&str,params:Value,config:&ConfigStore,sessions:&Sessions,events:&Events)->rpc::Result<Value>` async；`usage.get {sessionId}`、`usage.list {agentId?,limit?,beforeSessionId?}`。只从 durable `cli.started` / `native.result` 观察查询：query usage 是每次 ask 计数，native cost/modelUsage 为实例累计快照，不能逐 Run 相加。恢复基线、异常占位或字段不明返回 unknown，不补零、不建第二账本。事件过滤使用 `query_kinds`，会话列表使用真实分页。

### retention（Agent 11 接续）

`dispatch(method:&str,params:Value,config:&ConfigStore,diagnostics:&Diagnostics)->rpc::Result<Value>` async；`retention.status {}`、`retention.prune {beforeMs}`。只观察/显式清理 diagnostics；不物理删除 native transcript、Session、Run 或 events，不新增统一清理框架。

### gateway（Agent 20，独占 gateway/ 与 app-server/README.md）

- `pub async fn serve(config:Arc<ConfigStore>,sessions:Sessions,events:Events,interactions:Interactions,diagnostics:Diagnostics)->rpc::Result<()>`。gateway 装配各家族 dispatcher；不得改 lib.rs/main.rs/Cargo。
- HTTP `/health`、`/version`、`/files/{agentId}/{*path}`（GET/PUT），WS `/ws`。WS initialize 协商 `matcha-app-server-v1` 并认证，HTTP文件也必须同等认证；非 loopback 无 token 拒绝启动。不加多租户/RBAC。静态管理 token 从 env 解析，不写日志/URL。
- JSON-RPC 2.0，method 按上述表。`initialize`/`server.capabilities` 只 advertise 真接线；`events.replay` 和 `events.subscribe` 按 sessionId/afterSeq，推送 `session.event`；订阅返回后持续按 durable seq 拉取，断连不取消业务 Run。batch/notification 遵守 JSON-RPC；请求并发、单 socket writer、资源可关闭。
- 将各模块具体 DTO/方法整理在 app-server/README.md，给真实调用与验证使用；不声称未验证能力完成。

## 5. 交付与滚动派发

20 个 Agent 分别独占以上边界；契约变更只向主代理提交，禁止抢写共用文件。不用 workflow/worktree，不派生代理。每个 Agent 读相关文档和实际 TS 入口后实现；不再做全仓审计。允许定向 rustfmt 自有文件，主代理统一 Cargo 检查，避免 20 个 cargo 抢同一 target。

不新增测试/临时脚本。复用既有工具进行 Cargo check/clippy、文档校验、真实服务 HTTP/WS/CLI 链路验证；外部模型/渠道/账号调用不因开发授权而自动发送。禁止读取本机凭据文件。真实能力与当前平台未验证的部分诚实报告。
