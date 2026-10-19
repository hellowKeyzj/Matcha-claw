# Matcha App Server

独立 Rust 2024 / Axum 0.8 服务；CLI 是执行后端，不依赖旧 TS app-server 或 runtime-host。共享 Rust 契约见 [contracts](../docs/rust-app-server/contracts.md)，方法参数的事实源是下表所链接的 owner 模块；网关不复制其 DTO。

当前原生切换装配沿用 `matcha-app-server-v1`；Server 仍独立，不依赖 runtime-host，不兼容旧业务 wire DTO，也不重写 CLI 引擎。

## 验证状态

以下为此前主代理统一验证的 **Windows x64** 实测范围，不等于其他平台/账户/外部服务均已验证。主代理最近统一 `cargo check --offline --locked` 已通过，覆盖 sealed 与调度订阅装配，但不覆盖随后新增的 retirement。此前 sealed 装配的 `cargo test --offline --locked` 已完成编译链接（lib/main/doc 均 0 tests），不证明行为。新增方法、媒体与删除/关闭装配尚未完成本轮链路验证，路由登记不是运行通过声明。

- **构建**：`cargo build`、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、release 构建通过。
- **隔离 API**：认证、原子配置、workspace/HTTP 原字节、memory/skill/instructions、游标/batch、空 usage、retention/关闭；8 种 Provider CRUD/非法输入、双 Prompt 替换、permissions/hooks 配置、Windows 显式 sandbox 拒绝、disabled schedule CRUD/五字段 cron 拒绝、disabled 微信绑定/status 均通过。MCP project 字面配置并发 add/remove 保留未知字段及 env 引用、拒绝明文凭据通过；原生 taskList/team/workflow 空目录观察及 capabilities 通过。这些管理检查未调用账户/模型网络，不证明第三方连接或协作执行可用。
- **首轮真实 CLI 非模型闭环（Bun）**：使用按现有 `Bun.build` 配置构建且保持 bootstrap STATE 单例的 CLI 产物，双 Session `/version` 均验证独立 PID/instance、身份匹配、各 35 个已观察 tools、完整 init/assistant/result 与各 usage=1；同 Session 并发提交两个 `/version` 串行执行并复用同 PID/instance，累计 usage=3。实时收到 26 条 `session.event`；未获得输入 ACK 的结果 runId 保持 null，Run 诚实为 unknown，不冒领为已确认 Run/模型成功。
- **首轮正式 Vite 修复与复验**：alias key `'src/'` 未匹配普通 `src/*` import，Windows 两种 separator 的 module ID 指向同一 realpath，导致重复 bootstrap STATE；仅将 [vite.config.ts](../vite.config.ts#L130) 的 alias 改为 `src: resolve(projectRoot, 'src/')`。该轮 `state.ts` 只有 1 个 module ID、1 个 chunk，保留 645 个 split chunks；未加 normalizePath、关闭 splitting、升级依赖或放宽 Rust 身份校验。验证产物 `target/vite-state-final-Ekw6Kx/bundle/cli.js` 的 Rust 双 CLI 实测 `bo7vi1o22` exit 0：两独立 PID、各 35 tools、init/assistant/result 身份匹配、多轮串行复用、usage、26 条 live events 均通过，提前持有的两条进程句柄确认退出，Server exit 0、无强杀。旧 dist 未覆盖，验证产物不设为产品默认配置。
- **共享配置截断 exit 1 根因修复**：[config.ts](../src/utils/config.ts) / [file.ts](../src/utils/file.ts) 保留同步 API，唯一持锁 fresh read→updater 一次→temp flush/原子 rename→成功后 cache；初建使用 realpath:false，仅 ELOCKED 按 5 ms 等待锁竞争，删除两条无锁 fallback、孤立 saveConfig 和非原子截断 fallback。Windows rename 仅对 EPERM 使用同一 temp 在 250 ms 窗口内、每次至多 5 ms 等待资源；其他错误立即抛出，超窗保全旧 file/cache，不重跑 updater 或业务请求。已证截断失败链为共享 `.claude.json` 截断→enableConfigs ConfigParseError→gracefulShutdownSync(1)；下述 exit 0 同型机制另有直接复现证据，不据退出码合并归因。
- **配置修复产物与并发验证**：`target/vite-config-atomic-nzp4c8or/bundle/cli.js` 的 state 图为 1 module ID/1 chunk、646 split chunks；CLI typecheck、git diff 空白检查通过。`btv1m8jqx` 四组各 8 个独立 CLI 全部完成 `/version` 链、各 35 tools、同 Session 串行复用、usage/live（每组 68 条）；32 个预持进程句柄均确认退出、4 个 Server exit 0，无强杀；四组 runtime/debug 共 64 文件无配置损坏/UnexpectedEOF/原子提交或持锁保存失败标记，四份 `.claude.json` 均可解析。`b2revcxpg` 的 8×30 次 RMW 全写入、updater 恰好每 worker 30 次、无丢更新且保留未知字段，真实 Bun reader 18,600 次 invalid=0/io=0。Windows 持文件句柄占用和 EACCES 注入均验证失败时旧 file/cache、原 cause 与 temp/lock 清理，释放/恢复后提交成功；完整边界见 [进度](../docs/rust-app-server/progress.md)。缺输入 ACK 的 Run 仍为 unknown，不称模型成功。
- **同型自然 exit 0 机制与 fatal 修复**：旧 Bun 复现 `bxdm57678` 的两个实例均 stdout=0/exit 0，真实栈定位旧无锁/非原子 fallback 的 EBUSY，随后 beforeExit(0)，exitCode=null、stdin 未销毁/未 flowing，无 process.exit 调用。[gracefulShutdown.ts](../src/utils/gracefulShutdown.ts) 两个 fatal handler 共用同步 exitOnFatalError：先标 exitCode=1→只记安全 name/errno→固定 stderr→同步终端 cleanup→forceExit(1)，诊断/stderr/cleanup 异常也由 finally 确保退出，不运行异步 hooks/正常 graceful，不记录 raw message/stack/secret，不增加 Rust 重试。CLI typecheck 通过；`beupfsr5m` 的真实 CLI migrationVersion 11 rename EBUSY 注入为 exit 1/stdout=0，旧 file/cache version 10 保全且 temp/锁清理；uncaught/unhandled、已在 graceful(0)、诊断失败和 secretReason 等样本均 exit 1/stdout=0、无敏感 marker。正式产物 `target/vite-init-fatal-ze7ut458/bundle/cli.js` 保持 1 STATE module/chunk、646 split chunks；`bmp77crrk` 的 Rust 8 CLI 完整链通过（各 35 tools、68 live events、串行复用、预持句柄全部回收、Server exit 0，无强杀）。同源多入口 exports 产物的 648 split chunks 仅用于注入验证，不设默认。
- **调度与队列取消（非模型）**：手动 schedule receipt 从 submitted 经真实 `/version` 执行后收口为 settled unknown；七字段 UTC once 到期仅产生一条 cron receipt，nextFireMs=null，同 CLI instance 复用。六个并发 `/version` 的队尾 Run 在发送前取消，其余五个完整串行执行；不将缺 ACK 的执行误标成功。
- **主动模式关闭（非模型）**：`sessions.setProactive {enabled:false}` 使现有实例从 unobserved 经原生 ACK（同 instance、enabled=false）到 snapshot disabled；字符串 `"false"` 返回 -32602；未启动的 lazy Session 返回 native_instance_absent/delivery:notSent 且不启动 CLI，关闭后 proactive 重置 unobserved。未开启 true 或主动模型执行。
- **历史与回收**：两条真实 `/version` transcript 经 Rust 服务重启后，`sessions.get` 历史读取及 limit=1 分页通过，每条均读到 2 条 user；close 后实例清除，预先持有的两个 OpenProcess 句柄均确认子进程退出，独立进程组 Ctrl+Break 使 Server graceful exit 0，无强杀。双 CLI 原生事实、usage、串行复用、实时事件与持句柄确认退出已再次复验。

**当前限制**：

- **历史证据边界**：原旧 Bun 产物保持 stdin 打开的 8 并发复现已取得 EBUSY/open 栈：migrationVersion 提交→旧 config 无锁 fallback→旧 file 非原子 fallback→writeFileSync，随后无 process.exit 调用而自然 exit 0；同型缺陷已实证并修复。原两次历史没有栈，不能声称恢复了各次精确触发，也不把自然 exit 0 与截断 exit 1 混成同一失败链。
- **失败链补验已通过**：`bsb3cagv8` 用现有配置合法前缀启动同源真实 CLI，仅在 migrationVersion 11 rename 注入 EBUSY，原生 exit 1、无 native.result；Run 仅一个 Failed/native_initialize_failed terminal、instance 清除，安全诊断保留 causeCode=-32006/causeKind=native_response_lost/delivery=unknown/stage=stdout_eof 及正确 instanceId/nativeRequestId。旧 file/cache version 10、temp/锁清理及预持句柄退出均确认，Server Ctrl+Break exit 0，无强杀，不改 Rust 契约或重试。`b00a1tg91` 关闭真实 stderr 读端后同步 write(2) 直接观测 EPIPE，fatal 仍 exit 1/stdout=0、无强杀；此前仅关闭 fd 2 的样本不作为该分支证据。本轮 Rust fmt --check、clippy --all-targets -D warnings 及新增文件 Biome 格式检查均 exit 0。
- 旧 dist 未覆盖，最终验证产物不设为产品默认配置，runtime-host 未切换。Windows rename 的 EPERM 资源等待有 250 ms 边界，持续占用超窗仍会安全失败，不声称所有提交必成功。
- 真实 `/version` 的 resume/fork 及已授权 endpoint 的 OpenAI-compatible 双模型真实请求已通过，模型 close/resume、工具审批/问答、取消与事件/usage 核对见 [进度](../docs/rust-app-server/progress.md)；仍未覆盖 UI、其他模型/协议、native auth/hook/外部 MCP/OAuth/插件/微信登录、持久 memory 注入、技能执行、模型 fork/compact/snip 复杂恢复及跨平台。

**本轮检查（2026-10-18，主代理统一回报）**：App Server `cargo check/test --offline --locked`、`cargo clippy --all-targets -- -D warnings` 均 exit0（test 为 0 tests，不证明行为）；Host `cargo check -p matcha-agent -p runtime-host --lib` exit0、有 warnings；task-manager 8/8、CLI typecheck 与六套既有测试 71/71、既有离线 audit 21/21、范围 diffcheck 通过。两轮真实隔离 WebSocket 原盘读取及 proper-lockfile 互操作通过：CLI/Provider source 均不存在仍可读，内部 instance 为 null，无 CLI 启动；持锁拒绝、释放后成功。

**本轮未通过/未验边界**：全 crate fmt 检查仍因五份旧 dirty 文件格式失败；CLI 九文件 Biome 中三文件格式失败及一条 info，核心失败位置有 HEAD/开工观察的旧存证据，其余六文件通过，不能称格式检查全绿。冻结后 print 又补齐与原生持久化一致的 resident 条件：`cleanupPeriodDays=0`、`CLAUDE_CODE_SKIP_PROMPT_HISTORY` 为真、test 未启用 `TEST_ENABLE_SESSION_PERSISTENCE`；新 bundle 已构建，末次独立 typecheck exit0，Biome 仍三文件格式失败/一条 info、非全绿。最新 bundle 的真实 stdin initialize→prepare_to_sleep 在 `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` 时精确返回 `{status:'resident'}`，EOF 自然 exit0，无强杀、模型 Run 或 JSONL；仅动态覆盖该条件，另外两项同源条件为静态核对，既有 71 tests 在此微改前运行，不宣称覆盖此 guard。既有检查不覆盖 Host private prepare 的完整应用链。

**本轮真实空闲闭环（主代理回报，最终工件已只读核对）**：第二完整窗口中 plain Session 在 290148ms 仍为原实例，原生 idle 后 300055ms 记录 ready/native_sleep_safe；旧进程的预持句柄在恢复前已确认退出。同 Server、同 UUID 恢复为新 instance，history 由 5 条增至 8 条且旧前缀保留；resident 样本等待自身 ACK=resident 后仍保留实例。`tasks.create` 的 persisted/applied 回执与随后原盘 list 一致；Todo write 回执 stateApplied/transcriptPersisted 为 true、transcriptMessageId 非空，随后独立只读 Server 重启后的 todos.get 与原 content/status/activeForm/updatedAt 一致，instanceId=null、source 为 persisted native files、未启动 CLI，7 项断言均 true。Todo 读回不是同 Server 休眠恢复；原 result.json 的 failed 保留，原因为 driver 比较 JSON.stringify 属性顺序误判，不是生产 Todo 失败。第二窗口三个、首窗口两个预持进程句柄全部确认退出，第二及只读 Server 均自然 exit0，无强杀。休眠样本使用 Jf7lbh4e bundle、未启用 skip 条件；最新 guard 的 SKIP=1 证据来自 VcGsSWg9，不混为同产物成绩。最初无 transcript 前置的 `/version` 不计通过；首窗口在 300070ms 取得 safe，但 driver 提前断言 resident 并 shutdown，不作同 Server 恢复证据。隔离临时工件：`matcha-idle-real-ocw7aoik/second-window-verified.json`、`todo-readback.json`；首窗口保留于 `first-window.json`。上述历史成绩不代替本轮验证。

## 真实模型测试

固定套件的环境、换模型/Key、构建复用、离线自检与报告说明见 [tests/live/README.md](tests/live/README.md)。从仓库根运行 `python -I matcha-agent/app-server/tests/live/run.py`；须先设置测试 endpoint/模型，Key 默认隐藏输入。命令会产生真实模型请求并可能收费；正式套件已于 2026-10-17 在 Windows x64 以 deepseek-v4.1-flash/glm-5.3-flash 验证，24 个 case 全部通过，仅代表所测范围。

## 运行配置

二进制入口：`matcha-app-server [--home DIRECTORY]`；家目录依次取 `--home`、`MATCHA_AGENT_HOME`、`~/.matcha-agent`（Windows 使用 USERPROFILE）。首次启动由配置 owner 创建 `matcha-agent.json`。

**Electron 托管目录（2026-10-18）**：正常启动与独立 Server 统一默认 `~/.matcha-agent`，不再默认使用 Electron userData 下的 `matcha-agent/app-server`。Electron 的 `getMatchaAgentHome()` 在 `MATCHA_AGENT_HOME` 存在时直接按 Node `resolve` 解析（包括空串，不 trim、不展开 `~`）；否则仅 `MATCHACLAW_E2E=1` 且 `MATCHACLAW_E2E_USER_DATA_DIR` trim 后非空时，隔离到 `<e2eUserData>/matcha-agent`。该根经 bootstrap `matcha.storageRoot` 交给 Rust Integration 原有 `--home`；Electron AppData 的 Host state/logs 不迁移。[VERIFY: electron/utils/paths.ts:46-70] [VERIFY: electron/main/runtime-host-delivery/bootstrap-resources.ts:199-202,240-254] [VERIFY: runtime-host/integrations/matcha-agent/src/lifecycle/launch.rs:225-233] [VERIFY: matcha-agent/app-server/src/main.rs:24-57]

本机已在用户确认退出、复核 Electron/Host/Server/CLI 全部退出后完成离线迁移到 `~/.matcha-agent`，保留旧根原数据备份；不是自动迁移或仅 rename。新根的 3 条会话历史已由真实 Server 只读验证，未启动 CLI/Run、未请求模型；真实模型 resume、UI 与跨平台仍未验，见 [目录与验证账](../docs/rust-app-server/runtime-layout.md#8-2026-10-18-electron-托管根统一)。

```json
{
  "listen": "127.0.0.1:0",
  "authTokenEnv": "MATCHA_APP_SERVER_TOKEN",
  "cli": { "command": "ccb", "args": [], "env": {} },
  "agents": {},
  "providers": {},
  "schedules": {},
  "channels": {}
}
```

- `authTokenEnv` 指环境变量名，不是 token 本身；省略或 null 仅允许 loopback。配置了引用但来源缺失/非 Unicode/为空/含不可见 ASCII 时启动失败，不降级为免认证。HTTP Bearer 和 WS initialize 使用同一个可见 ASCII token。
- 非 loopback 没有 token 则拒绝启动；有 token 也不是 TLS。仅在可信网络部署，公网须由受控 TLS 入口保护，不能直接暴露明文 token/内容。
- `listen` 支持端口 0；stderr 输出 `matcha-app-server listening on http://<实际地址>`，不输出 token。`config.update` 仅存储，监听地址、token 需重启；不热换当前 listener/已认证连接。config 提交结果无法确认时 commitState/application 为 unresolved，snapshot 保留最后确认值且后续写入冻结，须重启读回，不自动重试。
- `cli.env` 是 `{目标环境变量名: 来源环境变量名}`；不存明文凭据。CLI/Provider 的解析与原生投影归对应 owner；网关不读取本机凭据文件。
- Ctrl+C（Windows 也支持 Ctrl+Break）或已认证的 `server.shutdown {}` 使用同一个关闭入口：停止接收连接，关闭传输/订阅，并行调用 `Sessions.shutdown` 解除原生 pending，再等待已接收调用及连接任务；main 再关闭 scheduler/channel 并做幂等 Session 清理。`server.shutdown` 返回 `{status:"stopping"}`，writer flush 后触发关闭；已受理但连接丢失仍继续关闭。ACK 不是清理完成证据，须观察真实进程退出。普通连接断开本身不取消 Run、不关闭/删除 Session。

## HTTP

| 路径 | 行为 |
|---|---|
| `GET /health` | `{ "ok": true, "scope": "http" }`，只表示 HTTP handler 存活，不证明数据库/CLI/模型可用。 |
| `GET /version` | `{serverVersion,protocolVersion:"matcha-app-server-v1"}`，不是能力可用性证明。 |
| `GET /files/{agentId}/{path}` | 读取 Agent workspace 相对文件；返回 `application/octet-stream` 原字节。 |
| `PUT /files/{agentId}/{path}` | 原字节写入 workspace；成功 204；父目录须已存在。 |
| `PUT /media/{agentId}/{sessionId}?fileName=...&mimeType=...` | 原字节暂存；200 返回 `{reference,name,mimeType,size}`，不是执行/发送消息。 |
| `POST /media/{agentId}/{sessionId}/{reference}` | 空 body，200 返回一次消费的原字节；响应丢失不能重取同一 reference。 |
| `GET /sealed-skills/{sessionId}/catalog` | per-instance Bearer capability；200 返回 `{agentId,skills:[...]}` 描述与文件清单，无文件原文。 |
| `GET /sealed-skills/{sessionId}/read/{skillKey}/{path}` | 同 capability，另需 `x-matcha-sealed-package-sha256`；200 返回内部 `{contentBase64,packageSha256,meteringBinding?}`，不是公开文件下载接口。 |
| `GET /ws` | WebSocket 升级；业务认证在 initialize。 |

文件与媒体请求使用 `Authorization: Bearer <token>`；loopback 未配置 token 才可省略。不从 URL/query、Cookie 或 WebSocket subprotocol 读取凭据。HTTP 错误为 `{error:{code,message,data:{kind,...}}}`；参数 400、缺失 404、冲突 409、不可用 503、无凭据 401（`WWW-Authenticate: Bearer`）、Origin/Host 拒绝 403，其余 500。

`/ws`、文件、媒体与 sealed 请求检查 Host/Origin：Host 端口必须等于真实监听端口；loopback Host 仅 `localhost` 或绑定 IP；有 Origin 时必须是 `http` 同 Host/端口，拒绝跨站、`null` Origin、userinfo 和重复 Origin/Host。不信任 Forwarded/X-Forwarded-*；无 Origin 的本地原生客户端可用。未实现 CORS/跨源浏览器应用，TLS 反代若保留 https Origin 会被拒绝，部署需保持该明确的后端同源边界，不能靠开放任意 Origin 绕过。

文件路径/链接边界由 [workspace](src/workspace/) 唯一校验：相对 slash 路径，拒绝 `.`/`..`、反斜线、重复/尾斜线、链接/reparse 逃逸及 Windows 特殊文件名；不允许任意绝对路径。HTTP GET/PUT 当前调用整文件 `Vec<u8>` 原语，上传/下载整体驻留内存，不声称流式大文件传输，也未增加任意文件大小配额。PUT 完整 body 接受后由已追踪任务持有写入直至提交/清理结束；HTTP 断连不取消该任务，服务关闭等待它完成，响应丢失时仍须读回确认而非盲重试。

媒体复用 [workspace](src/workspace/media.rs) 的 Agent/Session 活性与归属校验；上传 body 完整接受后，暂存及消费任务由连接任务 tracker 托管，HTTP 断连不撤回已经接受的操作。引用为随机值、30 秒有效、一次消费，过期按操作惰性回收；无自动 timer。Session 删除持同一 Agent guard，在删除 intent 后精确清除该 Session 暂存，不误删其他 Session；媒体本身不持久化，也不承诺流式大文件。

sealed HTTP 只接受 [sealed owner](src/sealed/) 绑定到真实 Agent/Session/CLI instance 的随机 capability，管理 token 不能代替；重复 Authorization/SHA 头拒绝。成功 JSON 为 no-store/nosniff，disabled 保持 403，unknown/unauthorized/package changed 分别按 owner 返回 404/401/409。Host reader 来源仅内存，逐次读取重验授权、原清单 SHA/大小；无 workspace/native skills 明文 fallback，不写内容到事件/诊断。只读请求可随 HTTP 取消，不增加后台 tracker；仅 loopback listener 且已有 Host reader 的未来 CLI 获得 guard 和三项 sealed env；缺 reader 不注入，非 loopback 保留普通带 token 部署但 project 写入前返回 sealed_listener_unavailable，不新增第二 listener。CLI 关闭/失败 spawn 由 Instance guard 撤销 capability。此处仅说明已接线机制，未完成本轮 sealed live 验证。

## WebSocket JSON-RPC 2.0

客户端先发送并等待 initialize 成功，再提交其他调用（batch 内没有初始化顺序保证）。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"matcha-app-server-v1","token":"<从私有来源取得>"}}
```

成功结果包含 `protocolVersion`、`serverVersion`、实际接线 `methods`、notifications 和传输语义。未配置 token 时省略 `token`；错误 token 返回 `-32007 unauthorized`，协议不匹配 `-32003 unsupported_protocol`（带 supportedProtocolVersions），重复初始化 `-32002 already_initialized`；失败不认证连接。`server.capabilities {}` 需已初始化。

- 一帧为一个 JSON 值：单请求或 batch；JSON-RPC ID 支持 string/number/null，按原值回显。省略 ID 才是 notification，合法 notification 即使执行失败也不回复。
- 解析失败 `-32700`、非法 request/ID `-32600`、未知方法 `-32601`、参数错误 `-32602`、内部错误 `-32603`；不能识别的 ID 回 null。参数省略视为 `{}`，显式 params 只能 object/array，方法 DTO 由 owner 校验。
- 空 batch 是单个 Invalid Request；混合 batch 返回所有需回应条目的响应数组，顺序可不同；全部 notification 不发送任何帧，绝不发空数组。batch 没有业务事务/串行顺序保证。
- 同连接允许并发在途，响应可能乱序；请求 ID 仅用于调用方配对，不是 runId/seq/nativeRequestId，也不是重试幂等键。变更提交后响应断送不能推断未发生，不自动重发。
- 一个 socket 只有一个 writer。读端持续接收后续请求，batch 全项并发，不以在途数量暂停读取，避免等待中的控制调用饿死后续审批/取消。已接收任务持有至完成并在关闭时 join，无人为 Session/Run/调用并发上限。单发送通道最多一帧，发送者在本 socket 局部等待，不另建无界输出队列；事件积压留在 durable events，不因慢消费者丢 terminal。
- WS framing/大小采用 Axum/tungstenite 自带默认值；没有新增业务 deadline、默认闲置断连或请求重试。大 batch 仍需持有输入与完整响应数组；持续提交但不读响应会让本连接在途任务及其结果占用内存，当前未实现调用配额或响应落盘。独立慢 socket 不持全局业务锁或阻塞 CLI producer。

应用错误保持 owner 具体 kind：`-32001` not found、`-32002` conflict、`-32003` unavailable、`-32004` native failure、`-32005` storage、`-32006` outcome unknown、`-32007` unauthorized。对外不透传 stderr、原始错误、完整环境或私密路径；诊断失败不改写业务成功。

### 可回放订阅

```json
{"jsonrpc":"2.0","id":2,"method":"events.replay","params":{"sessionId":"<已有Session UUID>","afterSeq":0,"limit":128}}
{"jsonrpc":"2.0","id":3,"method":"events.subscribe","params":{"sessionId":"<已有Session UUID>","afterSeq":0}}
```

- `events.replay` → `{sessionId,events,nextSeq,latestSeq}`；默认 afterSeq=0、limit=128，limit=0 允许空页；afterSeq 排他、seq 升序。latestSeq 是观察时刻水位，不是不可变快照；afterSeq 超前或缺 seq 明确报错，不返回假空成功。
- `events.subscribe` → `{sessionId,afterSeq,latestSeq,delivery:"durable_replay_then_live"}`；先校验真实 Session，再建 watch，再按 durable cursor 拉取。订阅响应经单 writer 发出后才发事件（notification 订阅无响应，执行后生效）。每页128，不限制流长度。
- 通知：`{"jsonrpc":"2.0","method":"session.event","params":{sessionId,seq,runId,kind,atMs,payload}}`。seq 只在 Session 内排序；以 `(sessionId,seq)` 去重/恢复，客户端保存实际收到的 seq。没有 exactly-once 承诺。
- 每连接可订阅不同 Session；相同 Session 再订阅替换旧 cursor，可能已有旧通知在本 socket 流水线中。暂无 unsubscribe 方法，关闭连接可释放全部订阅。
- watch 只唤醒，未发送 payload 不驻留全局内存。慢消费者暂停本连接 durable 拉取，不阻塞事件提交/CLI。断连不删除 durable 事件或 Session；重连从最后已收到 seq 重放，terminal 不被进度替换。
- 后续 replay/watch 失败以 `events.subscriptionError {sessionId,error}` 结束该订阅；恢复后由客户端显式重订阅，不静默丢事件/重试。Session 删除提交后唤醒已有 watch，下一次 durable 读取以 `session_deleting` 或 not found 明确终止；删除中/缺失 Session 不返回假空 replay，也不允许迟到 append/interaction flush 复活。当前 events owner 不自动保留期清理。

### 全局调度回执订阅

`schedules.subscribe {afterSeq:u64}` 返回 `{afterSeq,latestSeq,delivery:"durable_replay_then_live"}`；同连接仅保留一个调度订阅，重复调用替换旧游标，不影响 Session 订阅。来源为 [schedule changes](src/schedule/changes.rs) 的全局 durable receipt 序列，不依赖 Session 事件。先注册 watch 再验证/读取，订阅 ACK 经唯一 writer 发出后开始回放；每页 128，游标排他，不限制总流长度。

通知 `schedules.receipt {seq,receiptId,scheduleId,status,runId:null|string}`；每条成功 flush 后推进投递游标，客户端仍须按实际收到的 seq 保存/去重，不承诺 exactly-once 或接收方已消费。ahead/gap 由 owner 明确拒绝；流错误发 `schedules.subscriptionError {afterSeq,code,message,data}` 后终止，afterSeq 是最后成功投递游标，保留原 code/data.kind。断连只释放 owned stream，不取消调度或 Run；恢复由客户端显式携最后已收游标重订阅，不自动重放变更请求。该增量尚未完成本轮运行验证。

## 已接线方法与参数

`tasks.capabilities {}`、`teams.capabilities {}`、`workflows.capabilities {}` 经各自模块返回实际原生入口与条件，不以有方法名代替底层支持。

以下都经各模块 dispatcher，不开放任意 native control passthrough。字段 camelCase；业务模块普遍拒未知字段，以链接处最终 serde 定义为准。`?` 表示可选；字符串 `<...>` 为调用示例占位，不是固定值。能力列出仅证明路由接线，不证明账户、平台、CLI 构建门控和第三方服务已可用。

| 模块 / 方法 | 主要参数与语义 |
|---|---|
| [config](src/config/) `config.get/update` | get `{}`；update `{listen?,authTokenEnv?:string\|null,cli?:{command?,args?,env?}}`，cli.env 整 map 替换；返回安全 config / `{config,application:"stored_only"}`，不返回 args/任意 provider/channel/schedule 原文。 |
| [agent](src/agent.rs) `agents.list/get/create/update/mutate/configuration/delete/deletion.get` | list/configuration `{}`，get `{agentId}`；create `{agentId,definition,owner?,files?}`，update `{agentId,definition,revision?}` 完整替换公开 definition；mutate `{agentId,revision?,patch}` 保留省略字段，nullable 字段显式 null 清除。definition 由 [definition](src/agent/definition.rs) 定义，含 name/description/model/provider/prompts/settings/tool/channel 配置。view 返回 revision、相对 paths 与 managed `{kind,owner,token}` / external `{kind}` custody；应用 futureCliInstances。delete `{agentId,deleteFiles?:false,expectedCustody?,expectedOwner?}`；物理删除须本机 custody marker/token 匹配，external 禁止；清理 Session 并保留 durable 删除 receipt。deletion.get `{agentId,expectedOwner?,expectedCustody?}` 读取 complete/pending 清理事实，不把缺资源当完成。 |
| [agent retirement](src/agent/retirement.rs) `agents.retire` | `{agentId,expectedOwner}` 两项必填、拒未知字段；显式清理 managed data 并永久退休该身份，无可选 deleteFiles/path 策略。返回现 deletion view，含顶层 owner、`state:"absent"\|"deleted"`、retired:true、cleanupComplete；absent 的 dataDeleted:false、无 custody token，不证明历史从未创建，完成只看 cleanupComplete。已有 Session 须先完成原生清理再移 Agent data；孤儿目录必须 exact owner/严格 JSON marker 与无链接 custody 证明，否则保持 unknown/拒绝，不盲删。保留数据的 deleteFiles:false intent 不允许升级。清理失败可返回 cleanupComplete:false/pending 及 cleanupFailure，不把 RPC 成功当完成。`agents.deletion.get {agentId,expectedOwner}` 读回同一事实，无需 deleteFiles:true 或伪造 token；原 agents.delete 对 absent receipt 仍 not found。已受理变更由原 mutation task 持有，断连不撤销。 |
| [agent files](src/agent/files.rs) `agents.files.list/get/set` | list `{agentId}`；get `{agentId,name}`；set `{agentId,name,content,expectedRevision?:sha256\|"missing"}`。仅受限工作区 md，CAS 冲突 `agent_file_revision_stale` 带 latestView；返回 missing/size/updatedAtMs/content/revision。 |
| [agent tools](src/agent/tools.rs) `agents.tools.get/set` | get `{agentId}`；set `{agentId,revision,selection:{type:"inherit"}\|{type:"policy",profile:"native"\|"default",allow:[],deny:[]}}`；返回工具配置与 futureCliInstances，不冒充已观察原生 tools。 |
| [workspace](src/workspace/) `workspace.stat` | `{agentId,path}` → `{agentId,path,name,kind,size,mtimeMs}`，只观察真实文件元数据，不读取原文；媒体走上表 HTTP，不额外开放 prepare RPC。 |
| [workspace](src/workspace/) `workspace.list/read/write/mkdir/remove` | 均 agentId；list path 可省略/空串为根；其余 path 必填。read `encoding?:"utf8"\|"bytes"`；write 再加 `content:string\|number[]` 与匹配 encoding，bytes=0..255。mkdir 单层；remove 文件/空目录，不递归。 |
| [memory](src/memory.rs) `memory.list/read/write/delete` | `{agentId,scope?:"auto"\|"user"\|"project"\|"local",name?}`；read/delete 加 path，write 加 content。非 auto 必填 native AgentTool name；仅 .md 单文件，不维护 MEMORY.md 索引；持久化后下次 Session 读取，不宣称 live reload。 |
| [prompt](src/prompt.rs) `prompts.get/set` | get `{agentId}`；set `{agentId,systemPrompt:string\|null,appendSystemPrompt:string\|null}` 两项必填完整替换。null 保留原生默认 builder/不追加，空串拒绝。 |
| [prompt](src/prompt.rs) `instructions.list/read/write` | `{agentId,scope?:"workspace"\|"user",directory?}` list；read/write 用 path，write 加 content。实际候选根内 CLAUDE.md/rules 文件，不扫描用户系统 home/managed/祖先，不证明当前 native 缓存已加载。 |
| [skill](src/skill.rs) `skills.list/get/install/remove` | list `{scope:"agent",agentId}`；get/remove 再加 name；install `{scope:"agent",agentId,name,trust:true,source:{type:"content",skillMd,resources?:[{path,bytes}]}\|{type:"local",path:<绝对目录>}}`。只复制普通 SKILL.md/资源，不执行脚本或下载；runtime/skills 实际发现根，library/plugin scope 不可用、不隐式覆盖。新 Session 仍受原生策略/构建门控。install 可选 `replace:false`，替换走 stage/retire/restore，不预先删除旧技能。 |
| [skill upload](src/skill/upload.rs) `skills.upload.begin/chunk/commit` | begin `{scope:"agent",agentId,slug,size,sha256,force,trust:true,idempotencyKey?}`；chunk `{scope:"agent",agentId,uploadId,offset,bytesBase64}`；commit `{scope:"agent",agentId,uploadId,sha256?}`。begin/chunk 返回 uploadId/receivedBytes/expiresAt/sha256，commit 返回真实 install receipt 与上传信息。10 分钟 TTL、8 槽、32 MiB archive/64 MiB 解包/1 MiB chunk；文件留在 Agent runtime，重启 receiving 可续，committing 不确认时禁止盲重试，committed receipt 可读回；无后台任务或额外 shutdown hook。 |
| [sealed](src/sealed/) `sealedSkills.project` | `{reader:{endpoint,token}}`，endpoint 仅精确 Host loopback HTTP origin；私有来源仅内存，不进 config/readback/日志。返回 `{projected:true,application:"futureCliInstances"}`，不证明现存 CLI 已应用。每次 Server generation 须由 Host 私有 Peer lane 重投；未来 CLI Instance 获取当时 reader snapshot；无 reader 不授予 capability 或 sealed env，不回退文件系统。 |
| [plugin](src/plugin.rs) `plugins.list/install/uninstall/enable/disable/update/reload` | list `{agentId}`；install/enable/update `{agentId,id,scope?}`；uninstall 再加 keepData?；disable id? 与 all? 互斥；reload `{sessionId}`。id 为 name 或 name@marketplace；scope user/project/local（update 另 managed）。变更不自动 reload，原生文字回执未知返回 outcome unknown；reload partial/0错误均不证明观察完整。 |
| [mcp](src/mcp.rs) `mcp.list/get/add/remove` | list `{agentId}`，get 加 name，add `{agentId,name,scope?,server:<native stdio/http/sse>}`；remove 必填 scope。stdio server 为 `{type:"stdio",command,args?,env?:{KEY:"${SOURCE_ENV}"}}`；http/sse 为 `{type,url,headers?,oauth?}`。env 只完整 `${NAME}`，header 只完整引用或 `Bearer ${NAME}`；oauth 仅 clientId/callbackPort/authServerMetadataUrl/xaa，不接明文 secret/clientSecret；list/get 原生命令可能临时 health probe；project scope 对 `.mcp.json` 安全原子 RMW 保留字面 env 引用，原生策略加载时判定，不改 OAuth 凭据；local/user 用原生命令。持久配置变更不偷偷替换活跃会话 server 集合。 |
| [mcp projection](src/mcp/projection.rs) `mcp.config.get/set` | get `{}` → `{servers:[{name,transport,enabled}],configurationOnly:true,scope:"hostManagedOverlay"}`；set `{servers:{name:{enabled,server:<native/envrefs>}},privateSources:{sourceName:secret}}` → `{persisted:true,changed,projection:"nextLaunch",live:"notApplied"}`。私有来源仅内存投影，不写日志/公开 readback；配置观察不是 MCP 健康探测。 |
| [mcp](src/mcp.rs) `mcp.status/reconnect/toggle/authenticate` | status `{sessionId}`；reconnect 加 name；toggle 加 name/enabled；authenticate 加 name/callbackUrl?（启动或提交原生 OAuth）。ACK 不证明已连接，需 status；OAuth 交换后可能还需 reconnect。 |
| [provider](src/provider/) `providers.list/get/set/remove` | list `{}`；get/remove `{id}`；set `{id,provider:{kind,model?,baseUrl?,env:{nativeName:sourceName}}}` 完整替换。仅 env 引用；被 Agent 使用时不能 remove；变更只供未来 CLI，不自动重启。 |
| [provider projection](src/provider/projection.rs) `providers.project` | `{providers:{id:ProviderConfig},privateSources:{sourceName:secret},retiredProviderIds:[id]}`；私有 source 仅控制连接/内存，返回只含 env 引用、changed/application:"futureCliInstances"/requiresRestart/affectedAgentIds/activeAgentIds/privateSourcesReady/credentialValidation:"notPerformed" 与 cleanup removed/blocked IDs。被引用退休项保留并明确 blocked，不假称 live applied 或凭据有效。 |
| [provider](src/provider/) `models.list`、`auth.status/login/logout` | models `{sessionId}` 读取已观察 initialize，不额外 probe。auth `{agentId}`，status 不验证凭据；login 仅支持有确定 headless 环境引用的 first-party 流程，否则明确 interactive_oauth_required；login/logout 活跃 Agent 拒绝。 |
| [policy](src/policy/) `permissions.get/set`、`sandbox.status/set`、`hooks.get/set` | 均 `{agentId,sessionId?}`；set 分别加 permissions/sandbox/hooks native patch，严格拒 null/未知字段。permissions 可选 allow/deny/ask、defaultMode（default/acceptEdits/bypassPermissions/plan/dontAsk/auto）、disableBypassPermissionsMode:"disable"、additionalDirectories；数组替换 Server desired。hooks 按原生事件名 patch，`[]` 清 desired；callback 归 interaction。sandbox network/filesystem 按子字段 patch，enabled 强制 failIfUnavailable/禁 unsandboxed fallback，不允许 excludedCommands。只允许 owner schema，不接通用 settings patch。返回 configured/nativeObservation 或 persisted/live/restartRequired 分阶段事实，不把元数据当 OS 隔离；additionalDirectories/sandbox 修改要重启；原生数组 merge 不能移除旧规则/Hook，删除/替换须重启，纯追加才可能 live apply；Windows 显式沙箱不可用不裸跑。 |
| [session](src/session/) `sessions.create/list/get/close/resume/fork/setModel/setMode/native` | create `{agentId,sessionId?:UUID,model?,mode?}`；list `{agentId?,limit?:100,beforeSessionId?:UUID}` → `{sessions,nextBeforeSessionId}`；其余以 sessionId 定位，精确可选字段见 dispatch。native 只查询实际观察，不接任意原生命令。close 不删除真实 Session/原生 transcript。 |
| [session](src/session/) `sessions.rename/delete` | rename `{sessionId,title}` → Session view，title 非空单行；所有 Session view 新增 title 与 providerId/modelSelectionId/providerFingerprint。delete `{sessionId,expectedAgentId?}` 只允许 closed/quiescent；传 expectedAgentId 时对 live Session、deleting intent 与 completed 墓碑均核 Agent，不符 session_agent_mismatch，随机 missing 仍 not found。成功 `{sessionId,deleted:true,cleanupComplete:true,scope:"session"}`。先拒绝渠道/调度/未物化 fork 引用，持久 deleting intent/永久 UUID 墓碑，再依序清媒体、停止并 join executor、删除原生 UUID artifacts、清 Interactions/Events/管理记录，最后移除内存；任一失败保留原 code/kind，追加 deleteStage/cleanupComplete:false，不以部分删除当成功。deleting 可发现并重试但不恢复业务；只有曾有 managed Session、清理已完成且管理记录已移除的墓碑重试回同一 deleted receipt，随机 missing 与 absent-retirement 仍 not found。close 保留 transcript；delete 精确删除 Agent runtime 的 `projects/*/<UUID>.jsonl`、同 UUID 子树及 `file-history/<UUID>/`、`session-env/<UUID>/`，拒绝链接/reparse，不删共享 workspace/task，不允许已删除 UUID 重建。setModel 新增 providerId?/modelSelectionId?/providerFingerprint?，具体绑定检查归 Session/provider owner。 |
| [session retirement](src/session/retirement.rs) `sessions.retire` | `{sessionId,expectedAgentId}` 两项必填，拒未知字段；返回 `{sessionId,retired:true,cleanupComplete:true,scope:"session",state:"absent"\|"deleted"}`。state 记录首次 retirement intent 时是否存在 managed Session，absent 不证明历史从未创建。永久 UUID intent 阻止迟到 create；已有 Session 须先 closed/quiescent，沿原删除清理；无 managed 记录时只证明全部精确 UUID artifacts 缺席，不盲删无归属证明的原生文件。空 JSONL/sidecar、链接或 IO 不确定均保留 pending 并报错，不 purge 共享 workspace/task。已受理操作不因调用断连取消；失败保留原错误并附 retireStage/cleanupComplete:false，join 不确定为 session_retire_unknown。原 delete 不放宽。 |
| [session](src/session/) `sessions.setProactive` | `{sessionId,enabled:boolean}`，仅控制现有 CLI 实例；原生构建/特性 gate 不支持时明确报错，不隐式启动实例。开关 ACK 不证明已执行 tick 或模型调用；snapshot proactive 为 unobserved/enabled/disabled/outcomeUnknown。false 的 ACK/状态、错误类型及 lazy Session 不启动路径已实测；本轮未开启 true 或主动模型执行。 |
| [session](src/session/) `runs.submit/list/get/cancel` | submit `{sessionId,content:string\|native array}` → queued receipt/runId；get/cancel `{runId}`；list `{sessionId,limit?:100,beforeRunId?:UUID}` → `{runs,nextBeforeRunId}`，createdAtMs+UUID 降序排他。排队与终态分开，cancel ACK 非 terminal；失联表达 outcomeUnknown，不自动重发。 |
| [interaction](src/interaction/) `approvals.list/respond`、`questions.list/respond`、`hooks.pending/respond` | list/pending `{sessionId,runId?,instanceId?,includeResolved?:false}` → `{items:[...]}`；respond `{sessionId,instanceId,nativeRequestId,response}`，response 按 permission/askUserQuestion/elicitation/hookCallback tagged schema（[native.rs](src/interaction/native.rs)）。业务 request 保留 native snake_case，仅授权客户端；事件不含原 tool input/prompt。response 必须带 `type:"permission"|"askUserQuestion"|"elicitation"|"hookCallback"`；permission decision.behavior 为 allow/deny，question answer.action 为 answer/decline，elicitation action 为 accept/decline/cancel，hook output 为原生 Sync/Async HookJSONOutput，不是批准布尔。成功回安全 receipt，不带 request/response；相同已 sent response 幂等回 receipt，不重发，冲突决定拒绝。availability、delivery、nativeApplication 分开，stdio 已发送不等于 applied；默认 list 仅仍 pending/未预留项。未知/迟到请求不默认允许，持久待办不代表原生仍存活。 |
| [tool](src/tool.rs) `tools.list/get` | list `{sessionId,instanceId}`，get 再加 name；只读同一原生实例已观察的 `native_snapshot.tools`，不启动 query/模型。原生 init stream 可能到 turn 才出现，不是 control initialize；未观察明确 unavailable，不把空列表假作真实能力。 |
| [task](src/task.rs) `tasks.list/get/stop` | runtime `{agentId,kind:"runtime",sessionId,id?}`；taskList `{agentId,kind:"taskList",sessionId,instanceId?,listId?,id?}`，get 必填 id。taskList 始终读取原生事项文件，不因有无 CLI 改走 control，不调用 ensure_native 或解析 Provider 凭据；参与同一 proper-lockfile 锁协议，沿用原生 schema 与文件 birthtime/mtime 时间。内部读取回执 `instanceId:null`，不证明实时实例状态。stop `{agentId,sessionId,instanceId,id}` 仅当前已观察可控运行任务，不用于 TaskList 事项；ACK 不是终态。 |
| [task](src/task.rs) `tasks.create/update` | `{agentId,sessionId,instanceId?,listId?,input}`；create input 必填 subject/description，update 必填 taskId 和至少一个变更，status 为 pending/in_progress/completed/deleted。只调用 CLI 原生 TaskList owner 与既有锁；返回 `{kind:"taskList",agentId,sessionId,instanceId,receipt}`，变更须有原生 persisted/applied receipt，不以 control ACK 确认。 |
| [task](src/task.rs) `todos.get/write` | get `{agentId,sessionId,instanceId?}` 始终从原生 transcript 主链按 CLI 的未完成 tool-use 过滤、latest TodoWrite 与 activeTodos 规则恢复，内部 `instanceId:null`；只表示已落盘内容，不冒充实时 AppState.todos，也不启动 CLI。write 加 oldTodos/newTodos，item 为 `{content,status,activeForm}`，仍由 CLI 原生 owner 校验旧值、拒绝运行中写入；须有 stateApplied/transcriptPersisted/transcriptMessageId 与实际保存时间才确认写入，不能把 ACK 或内存变更冒充持久化；无独立 Host/Server Todo 账本。 |
| [team](src/team.rs) `teams.list/get` | `{agentId,sessionId?,id?}`；get 必填原生 roster 目录 id；只读真实资料，Team 不等于服务端会话池，不造 CRUD/start。 |
| [workflow](src/workflow.rs) `workflows.list/get` | `{agentId,kind:"source"\|"run",sessionId?,id?}`；get 的 source id 为脚本名，run id 为原生 run 目录。只读真实脚本/receipt，不造 start/pause/exactly-once。 |
| [schedule](src/schedule/) `schedules.list/get/create/update/delete/run/history/subscribe` | list `{agentId?}`；get `{id,limit?}`；create `{id?,agentId,prompt,cron?\|schedule?,name?,model?,delivery?,enabled?,recurring?,sessionId?}`；update 同字段且 id 必填完整替换，可加 expectedRevision；delete `{id,expectedRevision?}`，run `{id}`，history `{id,limit?:20}` 删除后仍可查 receipt；subscribe `{afterSeq:u64}` 见全局调度回执订阅。schedule 为 `{kind:"cron",expr,tz?}`（五/六字段、IANA 时区/DST、Sunday 0/7、DOM/DOW OR）、`{kind:"at",at:<RFC3339>}` 或 `{kind:"every",everyMs,anchorMs?}`；与原 cron 字段互斥，原 cron 保留六/七字段 UTC 语义。delivery 默认 `{mode:"none"}`，announce 明确 unavailable。view 返回 revision/runningReceipt/lastReceipt/lastFinishedReceipt；submitted 非 Run terminal，offline/unknown 不重发同一 receipt，删除不取消已提交 Run。 |
| [channel](src/channel.rs) `channels.list/configure/status/login/pair` | list `{agentId?}`；configure `{id,agentId,enabled,source:"plugin:weixin@builtin",sessionId?}` 完整替换，enabled 要 sessionId；status `{id}`；login `{id,restartFlowId?}`，未传复用在途 flow，restart 必须匹配当前 flowId 且确认旧登录停止/回收后才启动；pair `{id,code:<6位数字>}`。login 返回 flowId/status/qrUrl/qrUnavailable/error，status 轮询 QR 与实例观察，launching 与 instanceId 区分启动中/已有 consumer，nativeServers 仅含微信 server 的 name/status/channelCapability，不代表账户在线或健康；qrRefreshObservable:false，原生刷新只在不透传的 stderr，返回的首个 QR 可能已过期，不承诺新鲜，需用户显式 restart。不返回凭据，配置应用下次 Session 启动，不等于账户在线。仅真实原生入口，不冒充统一 Bot 平台。 |
| [channel operations](src/channel/operations.rs) `channels.login.cancel/stop/logout/delete` | login.cancel `{id,flowId?}`；其他 `{id}`。cancel 等登录 flow 停止并 join，cleanupConfirmed:true、accountStatus:"notInspected"，flow 进度为 cancelled；stop 真实关闭绑定 Session 并确认 instance absent 且不在 launching；logout 先停止登录/consumer 后调用该唯一 binding 的原生账号 clear，delete 再原子删配置 binding 与 Agent.channels。nativeAccessRetained:true 明示剩余原生权限，不假报全面撤销。pair 与 stop/logout/delete 共用 Agent admission 与 operations tracker，防原生 access 写入与 clear 并发；shutdown 等待已接受操作后再回收登录流程；失败保留原 kind 与阶段事实，原生账号 clear 失败为 outcome unknown，之后配置删除失败为 outcome partial/credentialsCleared:true。 |
| [diagnostics](src/diagnostics.rs) `diagnostics.query` | `{afterId?:0,limit?:100,owner?,operation?,kind?,agentId?,sessionId?,runId?,instanceId?,nativeRequestId?}`，nativeRequestId 必须附 instanceId；安全结构化升序分页，绝不返回 raw stderr/stdout/prompt/env。 |
| [usage](src/usage/) `usage.get/list` | get `{sessionId}`；list `{agentId?,limit?:100,beforeSessionId?:UUID}` → `{usage,nextBeforeSessionId}`；基于已观察原生 usage/事件；unknown 为 null，不伪装零；cost/modelUsage 按 CLI instance 保留原生累计快照，不跨 Run 重复相加；不自行制造预算执行或硬配额。 |
| [usage timeline](src/usage/timeline.rs) `usage.recent/sessionTimeseries/limits` | recent `{limit?:100,before?:{atMs,sessionId,seq}}`；sessionTimeseries `{agentId,sessionId,limit?,before?}`；limits `{}` → `{defaultLimit:100,maxLimit:1000,scope:"readPagination"}`，不是预算。分页 `{entries,nextBefore,coverage:"observedDurableResultsOnly",nativeOutcomeUnknown}`，DESC(atMs,sessionId,seq)，基于 durable native.result 与同实例 cli.started，以 `(Session,instanceId,uuid)` 去重；缺身份/计量或未知终态保持 unknown。返回 per-query tokens，不把实例累计 cost/modelUsage 当每次请求成本；无影子账本或假零。 |

`retention.status {}` / `retention.prune {beforeMs}` 委托 [retention](src/retention.rs)，仅显式删除指定时间前的安全 diagnostics；status 返回 scope:"diagnostics"、nativeTranscriptDeletion:false、automaticPrune:false，prune 拒未来时间。无自动保留期，不清理 events、Sessions、Run、workspace 或 native transcript。

TaskList/Todo 的读取绑定由 CLI 在恢复出最终 UUID 后原子保存到 `runtime/session-env/<UUID>/task-context.json`，精确为 `{listId:<sanitized string>,todoV2:<boolean>}`；原生 Team binding 变化时仍由同一 CLI owner 更新。它只保存原生绑定，不镜像 tasks/Todo 或秘密；文件缺失时，Server 按现有非秘密 env 与 `--team-name` 的 headless 规则解析同一语义，不要求 Provider Key。写入仍可能懒启动 CLI，不把读取与执行混为一条路径。 [VERIFY: matcha-agent/src/utils/tasks.ts] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/app-server/src/task/files.rs] [VERIFY: matcha-agent/app-server/src/task/context.rs]

### 连续空闲休眠

每个 Session 复用自己的串行 executor 计时，连续空闲 5 分钟才发 CLI schema 的 `prepare_to_sleep`；排队、运行、发送、取消、控制/审批在途或原生 busy 都不能回收。CLI 在同一 JS turn 封输入并检查真实状态：busy/resident 保持实例；Team/Channel/cron/proactive、非持久化或仅内存不可恢复状态保持驻留；后者包括 initialize 的 systemPrompt/appendSystemPrompt 等配置及 live set_model 等 session-only 控制态，不能推断所有普通会话都可回收。具备恢复条件时先落盘 transcript、flush 事件/stdout，再复查后返回 ready；不是“idle=true 即可杀进程”。[VERIFY: matcha-agent/app-server/src/session/idle.rs] [VERIFY: matcha-agent/app-server/src/session/execution.rs] [VERIFY: matcha-agent/app-server/src/cli/idle.rs] [VERIFY: matcha-agent/src/cli/print.ts] [VERIFY: matcha-agent/src/cli/structuredIO.ts] [VERIFY: matcha-agent/src/entrypoints/sdk/controlSchemas.ts]

ready 后由 Session 独立 sleep handoff 关闭实例、等待输出 consumer join、确认 transcript 与真实 graceful exit，不调用会取消排队 Run 的 `close_execution`；只有这些证据齐全才记录安全休眠，握手/清理不确定保持 unknown。逻辑 Session 仍 open、UUID 不变；新消息仍先进入原 durable 队列，再通过同 UUID 原生 resume 启动新 instance，不创建替代会话或重发旧未知 Run。上述为落盘机制，实跑状态见验证范围。[VERIFY: matcha-agent/app-server/src/session/idle.rs] [VERIFY: matcha-agent/app-server/src/session/mod.rs] [VERIFY: matcha-agent/app-server/src/session/instance.rs] [VERIFY: matcha-agent/app-server/src/cli/process/mod.rs]

### Run 归属与原生观察

同 Session 内 Server prompt 串行提交；自主输入启动风险取自 CLI 实际投影后本 Session 启用的 Channel，以及实际 launch env/cwd 下原生 cron 的启动快照，不因存在任意渠道定义就判风险；原生 cron 文件是 `workspace/.claude/scheduled_tasks.json`，不是 `Agent.settings` 的同名 key。
启动快照不能保证后续工具/原生文件变更不产生输入；proactive、foreign user 或多个 result 等事实仍保守判断归属，无法证明 result 唯一属于当前 Run 时以 `outcomeUnknown` / `native_result_ownership_ambiguous` 收口，不冒领结果或自动重发。
原始事实保留在 Session 事件/原生 transcript；`cancelRequested`/interrupt ACK 不构成 cancelled terminal，须有原生中断事实。

最小调用序列（每步先等上一条响应，UUID 用真实返回值替换）：

```json
{"jsonrpc":"2.0","id":10,"method":"agents.create","params":{"agentId":"local","definition":{"name":"Local"}}}
{"jsonrpc":"2.0","id":11,"method":"sessions.create","params":{"agentId":"local"}}
{"jsonrpc":"2.0","id":12,"method":"events.subscribe","params":{"sessionId":"<sessions.create返回的sessionId>","afterSeq":0}}
{"jsonrpc":"2.0","id":13,"method":"runs.submit","params":{"sessionId":"<同一sessionId>","content":"<用户授权的输入>"}}
```

创建/调用例子不是已执行的模型验证，也不会自动授权外部请求；不要把文档占位 token/Session 当成可用凭据或运行事实。
