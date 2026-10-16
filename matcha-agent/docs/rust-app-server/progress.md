# Rust App Server 实现进度

更新：2026-10-17。此前 Host 原生接入的构建、类型与隔离非模型证据保留；后续合同修正按下面增量记录，不沿用此前成绩宣称修后通过。Electron UI / 收费模型 E2E 未验；2026-10-16 独立 Server 验证仍为历史。

共享工程和接口见 [contracts.md](contracts.md)。生产入口：`matcha-agent/app-server/`，独立单 crate，不依赖 runtime-host。

## 2026-10-17 后续合同修正

当前源码已落实真实默认 `matcha` 的补缺、不可删除与同一 Agent 目录准备，以及 directory 失败、Chat 未选择、Skills 原生身份、Channels 默认账号、Usage 空页、Todo 持久时间和 Provider summary 的窄合同修正；机制见对应模块文档与 [运行目录](runtime-layout.md)。源码存在不等于增量验收。

主代理已运行既有 Rust 库测试：Provider 74/74；Channels / Cron / RuntimeDirectory / Skills / TaskManager / Usage 分别29/16/4/17/8/7，共81/81；Connector 26、Matcha adapter 56（另1 ignored）、Plugins 1，共83 passed / 1 ignored。这些不是 Electron UI 或模型闭环；末次稳定源 Plugins lib 既有测试也已 exit 0。

native Windows dev target build 通过。主代理在全新隔离 home 验证默认 list/default 字段、canonical workspace/runtime/state、delete/retire/大写 alias 拒绝、修改 name/description 后重启保留、`CLAUDE.md` imports 幂等，以及已有 canonical 内容与配置扩展保全；三次 `server.shutdown` 均 exit 0，modelCalls=0，报告目录为临时 `matcha-default-native-goF9H3`。首次连接失败源于验证命令未等 stderr 完整地址行、端口被截断；改为等待换行后通过，无产品更改，不记为产品缺陷或已验 UI。

统一 Host 与全部 native adapter 的 Windows x64 `cargo check --locked --offline --target x86_64-pc-windows-msvc -p runtime-host` exit 0（2m38，既有 warnings），闭合 Plugins 写入期未导出错误；末次稳定源 `--jobs1` 增量 Host check 也 exit 0（18.87s），Plugins lib 1/1 通过，重复不累加。Host 隔离测试未进入行为：首轮受 Windows pagefile 1455 与既有 `mcp_stdio` fixture 参数漂移阻断；jobs1 缩目标最终因磁盘不足在 binary 编译 exit 101，三个 test 均未执行，不归为产品行为失败，也不记通过。

最终稳定源 TypeScript 检查期间1309份文件 hash 无变化：Renderer 正式与 Electron noncomposite 均 exit 0；Electron 正式 exit 2，仅13条 TS6307 与 baseline 逐诊断完全相同，新增/消失均0。Agent transport/route 58/58；四组 Agent store/page 64/131，67项旧 scope fixtures 失败；Tasks 19/27，8项失败为6项旧 operation mock 与2项旧 unsupported 空成功断言；Teams 最终16/48，32项失败数量与 baseline 相同，取代早先14/46口头计数。以上为既有测试/类型层，不是 live UI、真实 Team 执行或模型验收。本轮 CLI 只做 tsc、未重新 bundle，未复制 dist 或启停用户应用；源码修正尚未成为已验证的运行产物，未完成项不由下方此前接入成绩补齐。

## 2026-10-17 此前 Host 原生接入验证

- 当前调用链为 Renderer / Electron 既有 API + `RuntimeScope` → Host 业务 owner → endpoint-selected typed ops → Matcha adapter 共享 `Client` → 独立 Rust Server → 原生 CLI。Host 不复制 transcript，不提供任意 native RPC 透传，不建立旧 TS Server fallback；OpenClaw 保持独立 peer。
- integration 采用 `matcha-app-server-v1`，一条共享控制连接及各自拥有的 Session replay/live 订阅；业务 adapter 从 `MatchaRuntimeDriver::native_client()` 取得同一 Client。Server 继续拥有管理与 durable 事实，CLI 继续拥有执行、原生协作与 transcript。
- `scope` 贯穿产品 GET / POST 与 Host typed owner 选路；Provider / MCP secret 保持私有内存投影。Usage recent / session timeseries 来自真实 durable results，未知不补零，累计 cost/modelUsage 不逐轮累加。sealed 的 Host 授权 membership 与原生 CLI 加载是不同事实，不能由 installed/enabled 推断当前会话已经加载。

### 1. 静态、构建、类型与既有测试

本轮统一构建及既有测试由主代理执行；各行独立，不相加为用例总数。

| 检查 | 最终结果 | 证据边界 |
|---|---|---|
| Rust Server build / fmt / clippy | 均 exit 0；clippy 为 `--all-targets -- -D warnings` | `bfksqwgce` / `b3d2sxrdx`；不代表运行或跨平台通过 |
| Rust Server `cargo test --locked` | exit 0，所有 suite 为 0 tests | 仅计测试目标编译 |
| Windows x64 完整 Host build | exit 0，最终 `bzy4njzku` | 已含 Team 身份校验、upload 错误映射、scoped sealed pathname 和 membership 修正；bundled protoc / 早期磁盘耗尽不再是构建阻塞 |
| Matcha integration lib | 最终 `bcrioy0zw` exit 0，56 passed / 0 failed / 1 ignored | 已含最终 membership/query 源码；packaged 真实产物 fixture 仍 ignored，不计打包验证 |
| Platform / Security lib | 分别 26/26、13/13 | 既有测试，不代替外部环境验证 |
| Host module_platform_contract / delivery fixtures | 分别 27/27、51/51 | delivery 为既有三组 Vitest fixtures |
| TaskManager / Cron / Provider / Skills / Workspace lib | 分别 8/8、16/16、74/74、17/17、14/14 | Skills 在最终 Host 构建时重验通过 |
| Renderer / Electron / CLI TypeScript | 均 exit 0；最终 Renderer 为 `bov2uw49c`；card model inline 6/6 | card model 非 UI 运行；sealed card 仅修 Matcha membership 和“当前会话加载未确认”文案，不开放 toggle，不改变 OpenClaw |
| CLI messages / sessionStorage；sealed 模块 Biome | 既有 75 tests、0 fail；六个 sealed 模块检查 exit 0 | 非模型检查，不等于真实技能执行 |
| crate DAG / Main API boundary | 最终 `b2a43l65b` exit 0 | trait boundary 曾扫描 0 files，不作为覆盖证据 |

### 2. 本轮实际非模型验证

均使用本次隔离 home/config、真实 native 协议与结果，不调用收费模型、账户或外网业务；不把 202/admission、ACK 或 Host ready 当作 native applied。各 owner 的 checks / RPC / 生命周期阶段分组记录，不跨组汇总。

| 链路 | 已观察结果 | 范围限制 |
|---|---|---|
| 独立 Server 管理与资源 | 管理/退休 20 项；Session 52 RPC / 两次启动；Agent 13 checks；workspace/media 23 checks，均正常退出 | 不替代 Host 或 UI 接入验证 |
| Policy / MCP / Cron | Policy 21、MCP 57 checks；Cron 真实 receipt seq 1..7、missed 为 null，相关 Server 均 exit 0 | 本地配置/协议与 receipt，不扩称外部 MCP、OAuth 或模型调度执行 |
| 原生 CLI TaskList / Todo | TaskList CRUD 8 项；Todo 恢复 12 项，completed 三次 close/resume 保持空、pending 两次逐字段一致，runs/runtimeTasks 为 0 | 同毫秒恢复选旧记录的缺陷已在原 sessionStorage owner 复用 leafUuids 修正；无新持久来源字段或 fallback |
| CLI sealed canonical 边界 | 两种顺序的 deserialize → JSON → deserialize 30/30，通过原 canonical owner 修复；普通消息合并、UUID、换行及 no-op identity 保留 | 不等于新 CLI reader 的真实技能加载/执行 |
| Host → Server → source CLI 基础链 | 10 项：Host ready、Matcha controlReady、Agent create/update、Session create/rename/delete、TaskList ensure、Todo get、Agent delete；stdin EOF 后 Host exit 0 / stderr 0 | 先单独等待 Matcha `controlReady`，不是仅等 Host ready；本轮不发 prompt |
| Host owned lifecycle | 七个生命周期/退出阶段通过：Host ready、native ready、stop、start、restart、OpenClaw 保持关闭、stdin EOF exit 0 / stderr 0；三代 owned Server 均确认退出（`bmdr1e687`） | stop/start/restart 均为真实 CallLog terminal succeeded；无强杀或陌生端口进程清理 |
| Host Team / 普通 Session | 修后 `bz1ch5t44` exit 0：唯一新 runCreate 为 created，runList sessions=2 / snapshot roles=2，两 Agent 与 Session 身份不同；69 字符 worker 上普通 typed Session create exact identity、delete succeeded；cancel/readback cancelled，Team delete 202 → CallLog succeeded/tombstoned，source Agent 保留 | 三个 Session durable cleanup 完整、live sessions/runs 为 0；两 Team Agent rootAbsent、Team materialization 为 TombstonedConfirmed。未启动 Team native execution，不扩称 hard crash / unconfirmed retirement / External 动态验证 |
| Host 本地 sealed 加密/CAS 管理 | 一次 export 202 → CallLog succeeded/accepted；自产包 SHA / manifest digest / runtime target 核对通过，真实 raw 32B 授权密钥仅在内存中用于 AES-GCM/AAD 解密，两文件共 66,105 B（含 66,000 B binary）路径/大小/hash/内容逐项 exact，无 cloud metadata，native source 已不存在 | 不使用假 lease/keyring，不将明文放进 sealed 包；未启动 CLI reader |
| Host scoped sealed status / merged | 最终 `bte5ag753` exit 0：status 200 / ready=true / issues=0 / entry=1 / installed=true / runtime=matcha-agent；merged 200，source=matcha-sealed、raw enabled=true / typed disabled=false | 仅授权 membership 已验；selectable/eligible 仍 false、native candidates=0，不能宣称当前会话已加载。Host EOF exit 0 / stderr 0，业务端口均拒绝连接；六张 native 业务表均 0，包 SHA 与 mutation 数未变 |

Host 验证在 Bun 下仅补 `electron.app` 的静态 export，访问即抛错；issuer、bootstrap、control、transport、native 业务均未 mock。它不是 Electron 主进程或 Renderer UI E2E。Provider 空配置也不能当作私有内存 projection 已被直接观察。

本轮真实失败及修复保留：Team 首轮已物化但公开 sessions/roles 为 0，因合法 69 字符 Agent ID 被 Session 的 64 字符校验过滤；修后复用 `SessionIdentity` 既有的 `MAX_ID_BYTES=256` 字节上限，未放宽 OpenClaw 原语法。scoped sealed status 首次 400 因 exact route matcher 收到带 query 的 path，修为 pathname，signed scope / DTO 不变；已授权 sealed merged 首次 enabled=false，修为 membership=true，未冒充 native 加载确认。三者均由 fresh build 后的上述真实读回闭合，不抹去先前观测。

### 3. 保留失败与未验边界

| 检查 | 保留结果 | 定位与处理边界 |
|---|---|---|
| sealed-resource lib | 27 passed / 1 failed | `cloud_directory_and_removal_reject_unverified_metadata_or_manifest`：`unwrap_err` 得到 `Ok(false)`。HEAD 源码已有坏 manifest 扫描 trace+continue 与测试期待 Err 的矛盾；未执行 HEAD 测试，不称历史测试实跑失败，不扩修 cloud producer 或改测试追绿 |
| Host module_boundary_contract | 19/21，两个失败 | HEAD 已有 string/path/signature 断言漂移，不等同生产 private 泄露；未改断言 |
| Sessions / Organization 既有 lib 测试 | 分别 115 / 3 处编译错误 | 前置签名、async、完整 identity 调用漂移；不是生产 Host 构建失败，未删除测试或行为追绿 |

- `C:/Windows/Temp` 隔离启动仍未通过：只读 ACL 与源码对照定位到首步 OpenClaw `CanonicalStateDir::provision` 的祖先 `READ_CONTROL` 门槛，尚未到叶目录私有化、token 或 Matcha factory；与 HEAD 旧链相同，不归为新 Matcha provisioning 回归。E 盘隔离成功不代表该 C 盘失败已解决，也不覆盖任意 Windows 路径。
- basic fixture 的 `CLAUDE_CODE_SIMPLE → NO_COLOR=1` 会关闭 skill discovery，不能照搬为技能安装前提；该策略拒绝与 upload adapter 错把 Unavailable 压成 Rejected 是两件事。后者已窄修，负场景真实得到 public 503/unknown、固定 `skill_discovery_disabled`、`ResponseReceived` / partial=false；numeric code 未动态捕获，最终结构化 trace 未重测，不补写为通过。后续技能纯管理验证删除 SIMPLE 映射，父环境也不含该变量；其余禁外联开关=1，未启 CLI。
- 未验：Electron UI / 完整 Host → CLI → Renderer E2E、收费模型与真实技能 reader/加载/执行、cloud lease、真实账户/OAuth/微信/外部 MCP 网络，以及 macOS/Linux、跨平台进程/文件安全、打包分发与 packaged fixture。2026-10-16 的模型成绩不计为本轮证明；Supported family、目录存在、编译通过均不替代这些验证。

## 2026-10-16 独立 Server 交付与验证（历史）

以下 owner 编号与授权范围属于当日独立 Server 开发，不是当前接入轮次的分工。

| owner | 独占责任 | 状态 | 验证 |
|---|---|---|---|
| 主代理 | Cargo、装配、共享 RPC、契约、集成 | 首轮实现及无模型、已授权双模型真实链验证通过 | Windows x64 check/build/release/fmt/clippy 通过；实际已验和未验范围见下文 |
| 01 | config / 运行路径 | 已交付，Clone 共享 confirmed/unresolved 状态 | 配置读写及既有文件原子覆盖实测通过；提交未知路径未注入验证 |
| 02 | persistence / 原子提交 | 已交付，修复 Windows 目标检查句柄阻塞原子替换 | Windows 既有配置与文件重复覆盖实测通过；Unix 待平台验证 |
| 03 | diagnostics | 已交付，含安全 cause 字段与显式清理入口 | consumer 首错安全诊断查询、retention 边界实测通过 |
| 04 | cli/protocol；接续 usage | 已交付 | 真实双模型 NDJSON 与完整 native.result 实测通过；全部 11 Session usage 按 query tokens/每 CLI 最新累计快照核对通过 |
| 05 | cli/process | 已交付，含两项资源清理失败路径修正 | Windows 真实双模型多实例、close/resume 新实例及持句柄确认退出通过；Unix 未运行 |
| 06 | cli 适配 / command / projection | 已交付，含微信单 poller 与 required sandbox merged 检查 | Bun/Vite 非模型完整链、并发 RMW 与失败保全通过；配置截断及同型异常自然 exit 0 机制已实证修复，原两次历史无栈不追认精确触发 |
| 07 | Agent 管理 | 已交付 | Agent 创建/配置提交/删除实测通过；跨 Agent 身份竞态仅源码核验 |
| 08 | workspace / 文件传输 | 已交付 | Windows 重复覆盖、越界拒绝、HTTP 二进制传输实测通过 |
| 09 | memory / prompt / instructions | 已交付 | memory CRUD、Prompt 替换和 instructions 列举实测通过；持久 memory 注入模型上下文未验，不以普通会话记忆恢复代替 |
| 10 | skills；接续 tool | 已交付 | skill 安装/列举/移除、真实实例 35 工具目录实测通过；技能执行未验 |
| 11 | plugins；接续 retention | 已交付 | retention 管理边界实测通过；真实插件安装/网络未验 |
| 12 | MCP | 已交付，project 配置字面 JSON 原子 RMW | 并发 add/remove、unknown 字段与 env 引用保留实测通过；真实连接/OAuth 未验 |
| 13 | provider / models / native auth | 已交付 | 八类 Provider 定义 CRUD、已授权自定义 endpoint 的 OpenAI-compatible 双模型真实请求及 usage 核对通过；native auth 登录、其他模型/协议未验 |
| 14 | permission / sandbox / hook settings | 已交付，含 merged required sandbox 业务校验 | permissions/hooks 配置与 Windows 显式 sandbox 拒绝实测通过；OS 隔离未验 |
| 15 | events / durable cursor | 已交付 | 真实双模型 raw→durable 内容/顺序、WS live/replay、重启订阅恢复及工具执行时 WS live 专项通过 |
| 16 | session / run / recovery | 已交付，含原生 proactive 开关 | 真实双模型并发隔离、同 Session 多轮串行、close/resume 记忆恢复、排队及执行中取消后复用通过；本地命令 fork、proactive false ACK/reset 已验，模型 fork/复杂恢复未验 |
| 17 | approval / question / hook pending | 已接线，delivery 与 availability 分责 | 真实模型 Write/Edit/Read allow、Write deny 无文件副作用、重复审批幂等/冲突拒绝、AskUserQuestion 回传通过；hook 执行回传未验 |
| 18 | native task / Team / Workflow；接续 history | 已交付 | 本地命令及真实模型 transcript 历史读取/分页通过，模型 close/resume 新实例恢复记忆通过；模型 fork/compact/snip 复杂恢复未验 |
| 19 | schedule / channel | 已交付，含 owned 提交、关闭与绑定守卫 | 管理 CRUD、手动与 UTC once 触发/receipt、本地命令投递实测通过；微信登录未验 |
| 20 | HTTP / WebSocket / 使用说明 | 已交付，接齐新增方法 | HTTP/WS 鉴权、batch、二进制传输、并发查询及 Ctrl+Break 关闭实测通过 |

## 2026-10-16 交付范围与未运行边界（历史）

- 已接齐本契约的真实管理入口；Windows x64 无模型管理链及用户授权自定义 endpoint 的 OpenAI-compatible 协议、deepseek-v4.1-flash/glm-5.3-flash 真实模型链已验，覆盖并发隔离、多轮串行、工具审批/问答、执行中取消、模型 close/resume、历史分页、事件、工具执行时 WS live 与 usage 核对。三轮共 11 Session、12 CLI、27 Run（25 succeeded、2 cancelled）；proactive 仅运行 false，未开启自主模型执行。
- 微信初次 QR、精确 flowId 重开、单 poller 与私有状态投影已实现；未进行真实账号扫码/登录/消息验证，不据配置通过宣称在线。
- required sandbox merged 校验已接初始化，拒绝 unsafe exclusions/required/fallback/platform 配置；Windows 显式启用拒绝已验，macOS/Linux/WSL2 的 OS 隔离未运行。
- 仍未验：Renderer/UI、其他远端模型或其他协议、native auth 登录、hook 执行回传、外部 MCP/OAuth/插件/微信登录、模型 fork/compact/snip 复杂恢复、技能执行、持久 memory 注入，以及跨平台进程/文件与 OS 隔离。不因已授权双模型通过扩称其他能力；普通会话记忆恢复不代替持久 memory 注入验证。
- Vite 重复 bootstrap STATE 已由一行 alias key 修复，正式产物通过 Rust 双 CLI 非模型闭环；首轮 Bun 验证仍保留为历史。旧 dist 未覆盖，验证产物不设产品默认配置；Rust 不建兼容双身份或自动切换构建的旁路。
- CLI 共享 `.claude.json` 非原子写截断导致的初始化 exit 1 根因已在 config.ts/file.ts 修复；最终正式产物通过 4×8 CLI 完整非模型链、240 次并发 RMW、真实 reader 及 Windows 失败保全验证。旧 Bun 产物已直接复现 migrationVersion 提交经无锁/非原子 fallback 抛 EBUSY、异常后自然 exit 0 的同型机制，配置单路径及同步 fatal exit 1 已修复；原两次历史无栈，不追认各次精确触发，不凭成功次数合并归因。
- 旧 dist 未覆盖，验证产物不设产品默认，runtime-host 未切换；模型验证仅限本次已授权 endpoint/协议/模型与合成内容，不扩大其他外部或跨平台结论。
- 没有确定性原生入口的完整 Team/Workflow CRUD、精确暂停等不伪造支持；范围以能力矩阵与各 owner limitations 为准。

## 2026-10-16 验证授权边界（历史）

- 用户已明确授权以“带高级 claudecode 开发的思想定位修复”Vite 构建与初始化两项缺陷，可修改必要 CLI 构建/源码；不重写 CLI 引擎，不动 Host/Renderer 或旧 TS app-server，不删除旧服务，不加过渡代理或 fallback。
- 本轮 verification-only：不改产品源码、不落测试/临时脚本、不 commit/push；模型请求仅限用户明确授权的 endpoint 与合成内容，secret 仅经 env/内存引用。不读取本机凭据、不真实登录或发送渠道消息、不向其他 endpoint 请求或外发仓库内容，其他外部行为仍须单独授权。
- 性能结论限于下方单机、无 CLI 负载样本；不宣称生产极限、跨平台或全部外部功能通过。

## 独立 Server 集成验证记录（历史）

以下按验证顺序保留独立 Server 与 CLI 的历史，不是本轮 Host 集成记录；当时的授权边界、缺陷状态和待验项不替代顶部当前状态。

- Windows x64 `cargo check`、`cargo build`、`cargo build --release`、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 已整体通过。初次 lint 失败已由各 owner 定向修复，未删行为或加全局 allow。
- 隔离临时 HOME/USERPROFILE/CLAUDE_CONFIG_DIR、无凭据环境下，现有 `dist/cli.js --version` 返回 2.8.1、exit 0。
- 同样隔离环境中，仅发送原生 initialize 与 end_session control，不发送 user prompt：两次 control_response 均 success、request_id 正确位于内层，CLI exit 0、stderr 0 字节。此证据只覆盖现有 CLI 的无模型原生控制入口，不代表新 Rust 服务端到端已验证。
- 首次 Python 输出解码因 Windows 默认 GBK 失败；显式 UTF-8 后上述控制验证通过。
- 隔离原生 CLI 仅发送 `/version`：initialize → running → init/tools → assistant → result success（is_error=false）→ idle → end_session ACK，exit 0、stderr 0 字节，无模型调用。该本地命令没有 user UUID ACK；Session 必须在 result 后 idle 时诚实结算 unknown，不能永挂或猜测归属。此证据仍非 Rust 进程链验证。
- `/version` 首次 probe 错把 idle 字段当 status，触及验证端等待期限后只终止该 probe 自建进程；改读 session_state_changed.state 后上述完整链通过。
- Rust 实机已验证 HTTP health/version、WS 未初始化/错误 token/成功初始化与能力表、Windows 独立进程组 Ctrl+Break graceful exit 0。首次客户端失败后未关闭 WS 导致验证超时，已修复一次性验证命令的退出逻辑。
- 完整 API 首次失败在 Agent 定义提交：Windows MoveFileExW 覆盖现有配置返回 osCode 5。02 用隔离 ctypes 四格证明是本 owner 保留目标检查句柄到提交导致；改为 temp 带原 DACL 创建后显式关闭目标检查句柄，修后既有配置与文件重复覆盖均实测通过。
- 隔离完整 API 链已通过：WS 鉴权、Agent/配置提交、workspace 路径拒绝与重复写、HTTP 二进制传输、memory CRUD、skill 安装/发现/移除、lazy Session、cursor ahead、订阅、JSON-RPC batch、空 usage、retention 边界、Session 关闭与 Agent 删除。服务 Ctrl+Break graceful exit 0，无强杀；此轮未启动 CLI Run。
- Rust→CLI 双会话首测曾受上述文件提交故障阻塞。修后两条真实 CLI 均返回 initialize PID，但 system/init、assistant、native.result 未进入 durable 事件，tools 因当前 instanceId 为空未完成验证。用完全相同 argv 直连 CLI 实证：running/idle 的 session_id 匹配请求，而 init/assistant/result 不匹配；06 正定位原生双身份机制，不放宽校验或改写原生事实。两条 unknown Run 不能当作执行成功，复用、usage、live events 和已知 PID 回收仍待闭环。
- 重启隔离 Rust 服务后，两条真实 `/version` transcript 的历史读取与分页均通过：各 2 条 user，total=2；limit=1 的第一页 nextOffset=1，末页 null。未验证复杂 compact/snip、模型历史、resume 或 fork。
- Windows release 隔离管理补验通过：八类 Provider 定义 CRUD/非法输入、双 Prompt 替换、permission/hook 配置、原生 Windows 显式 sandbox 拒绝、禁用 schedule CRUD/五字段 cron 拒绝、禁用微信绑定与 status。未启动 CLI、账户、网络或模型。
- 同一次 release 本地单连接样本：256 个并发 `sessions.native`，总 22.50 ms，客户端 p50 8.64 ms / p95 12.48 ms；进程创建到 listen 日志 58.63 ms；管理操作后 Working Set 10,608,640 B、Private Bytes 3,403,776 B。仅为此机器一次无 CLI/模型负载样本，不代表生产吞吐、尾延迟或跨平台性能。Server Ctrl+Break exit 0，无强杀。
- 原生输出缺失根因已通过同 argv 直连及 Rust 首错诊断双重证实：Session 收到 `native_session_mismatch`（-32004）后关闭 CLI，并非管道或 decoder 静默丢消息。已补 consumer 首错安全诊断，实测 query 保留 causeKind/causeCode，不含原文。源码只有一个 bootstrap STATE，但当前 Vite 产物将 setup/SDK 状态与 ask/init/result 的 STATE 拆成独立实例；正式 Vite 构建输出到新空目录后同样复现，不能通过重建消除，不建立双 ID 兼容模型。
- project MCP 配置实测通过：并发 add/remove 保留未知字段、已有服务器及 `${ENV}` 字面引用，拒绝明文 env；完成后与初始文档精确相等。taskList/Team/Workflow 空资料观察、capabilities 和 instructions.list 入口通过；未启动原生协作执行或连接任何 MCP 服务。
- 不修改 CLI 源码、构建脚本或旧 dist，使用现有 Bun.build 配置仅指定新空输出目录：双 `/version` 的所有状态/init/assistant/result 身份均正确，确认缺陷仅在 Vite 构建路径。该路径的修复不属于本工程，本次未修改。
- Rust release 对此 Bun 产物的完整链通过：双 CLI PID 独立、各观察 35 个原生工具、init/assistant/result 完整、result 事件 runId:null、usage 各 1；同 Session 同时提交两条本地命令，串行执行并复用同 PID/instance，usage=3；实时收到 26 条 session.event。显式 close 后 instanceId 清空，提前持有的两条 Windows 进程句柄均已终止；Server Ctrl+Break exit 0，无强杀。Run 缺 ACK 保持 unknown，不称模型成功或取消通过。
- 本地命令原生恢复验证通过：真实历史存在的 Session close→resume（不立即启动）→`/version` 新实例同身份；close→fork→`/version` 新实例新身份，源仍 closed，拒绝 fork 到原身份。所有原生 result 身份匹配，累计持有的 4 条进程句柄均在结束后终止。只覆盖本地命令历史，不扩展为复杂压缩/工具恢复或模型续跑保证。
- 调度真实无模型执行通过：手动 Run receipt 从 submitted 到真实本地命令 outcomeUnknown；7 字段 UTC once 自动触发，仅一条 cron receipt，nextFireMs=null，同实例 usage=2。随后同 Session 并发提交 6 条 `/version`，队尾 before-send 取消，其余 5 条串行完成、usage=7；进程句柄退出和 Ctrl+Break exit 0 均通过。此取消证据不覆盖模型执行中的 interrupt 竞态。
- proactive false 实测通过：初始 unobserved→原生 ACK（同实例）→disabled；非法 bool 拒绝；lazy Session 返回 native_instance_absent、delivery:notSent 且不启动；关闭重置 unobserved。同期复验双 CLI 完整事实、tools/usage、串行复用、实时事件及进程退出均通过。未发送 true，不宣称自主 tick/模型运行通过。
- 启动输入风险复验发现具体缺陷：仅配置 disabled 渠道及绑定另一 lazy Session 的 enabled 渠道，两条真实 `/version` 均被误标 `native_result_ownership_ambiguous`，而非缺 ACK 的 `native_input_not_acknowledged`；提前持有的两个 CLI 句柄均退出，Server exit 0、无强杀。根因是 Session 依据 Agent.channels 非空及无原生消费者的 settings.scheduled_tasks 猜测，而 CLI 已有实际筛选；真实原生 cron 文件位于 workspace/.claude/scheduled_tasks.json。已由 CLI 实例提供启动快照，删除 Session 重复推断及缓存；修后同一隔离场景两条 Run 均恢复为正确缺 ACK 原因，多轮复用、各 35 工具、usage、26 条 live 事件通过，两个提前持有的进程句柄均退出，Server exit 0、无强杀。此次 fmt/clippy/release 也通过；未扩称普通模型 ACK 归属或原生 cron 执行已验。
- 定时启动快照五项隔离验证通过：仅 settings 同名键、原生 tasks 空数组、非空数组、畸形 JSON、实际禁用 cron 的环境值（含大小写/首尾空白）。每项真实 CLI 连续三轮 `/version` 复用并核对 reason、native.result 和 usage；非空/不可确认保守歧义，空/禁用/非原生 settings 键不误判，五个持有的进程句柄均退出、Server 均 exit 0、无强杀。非空样本使用无效任务项，不触发真实定时/模型执行；读权限失败路径未注入。
- 上述补验的首个双实例 settings-only 尝试并非全绿：一个 CLI 初始化出现 native_response_lost（delivery unknown，原生 exit 0），另一个正常，安全诊断已保留；未证明该瞬态根因、未用重试修改产品掩盖。随后将启动快照分支隔离到单实例，五项均通过；不能据此声称双实例初始化从无失败。
- 用户随后明确授权定位修复 Vite 构建与初始化两项缺陷，必要 CLI 构建/源码可改，但不重写 CLI 引擎，不动 Host/Renderer 或旧 TS app-server；此前 CLI 只读和构建缺陷未修的记录保留为当时历史。
- Vite 根因已证：alias key `'src/'` 未匹配普通 `src/*` import，Windows 两种 separator 的 module ID 指向同一 realpath，产生双 bootstrap STATE。最终仅将 [vite.config.ts](../../vite.config.ts#L130) alias 改为 `src: resolve(projectRoot, 'src/')`，未加 normalizePath、关闭 splitting、升级依赖或 Rust 身份旁路；正式图 `state.ts` 为 1 个 module ID、1 个 chunk，保留 645 个 split chunks。
- 正式 Vite 验证产物 `target/vite-state-final-Ekw6Kx/bundle/cli.js` 的 Rust 双 CLI 实测 `bo7vi1o22` exit 0：两独立 PID、各 35 tools、native init/assistant/result 身份匹配、多轮串行复用、usage、26 条 live events 均通过；两条提前持有的进程句柄确认退出，Server exit 0、无强杀。旧 dist 未覆盖，验证产物不设为产品默认配置；首轮 Bun 证据仍有效，但不再是唯一通过的构建路径。
- **修复前记录**：初始化缺陷仍未归因：8 并发 `--debug` 复现仍为 exit 0；真正 `MATCHACLAW_TRACE=1` 复现为 7 成功、1 失败 exit 1，不能认定与首轮 exit 0 同因。后续启动成功不构成根因证据，不据此宣称已修，也不自动重试掩盖未知结果。
- Rust `failure_context` 已补齐 instanceId/nativeRequestId 与白名单 close reason→stage 映射，`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、release 构建 exit 0；这只证明安全因果缺口修正通过对应检查，不是初始化根因修复。
- **修复前记录**：真正 TRACE 的 exit 1 已进一步定位：`init.ts` enableConfigs 阶段解析共享 `.claude.json` 抛出 ConfigParseError，进入 gracefulShutdownSync(1)。绕过 Rust，直接让共享 runtime 的 8 个原生 CLI 保持 stdin 打开、只发 initialize，第二组再次出现 1 个 CLI exit 1/stdout 为空/stderr 固定 UnexpectedEOF，其余 7 个成功，证实本次首因是 CLI 共享配置非原子写截断。CLI 持久化 owner 正定位修复，尚未改动；早先两次 exit 0 没有直接因果证据，仍单独待归因，不能合并为同因或宣称初始化已修。
- 配置截断 exit 1 根因修复已落 [config.ts](../../src/utils/config.ts) 与 [file.ts](../../src/utils/file.ts)：保留同步 API，唯一同步持锁 fresh read→updater 一次→temp flush/原子 rename→成功后 cache；初建以 realpath:false 获取锁，仅 ELOCKED 按 5 ms 等待资源竞争。删除两条无锁 fallback、孤立 saveConfig 与非原子截断 fallback，不重放业务请求或 updater。
- 修后额外真实 Bun 高频 reader + 8 writer RMW 曾发现 Windows rename 短暂 EPERM，表现为安全失败而非文件损坏。最终仅在原 rename 边界为 win32 EPERM 增加同一 temp 的 250 ms 资源等待窗口、每次至多 5 ms；其他错误立即抛出，超窗保全旧 file/cache，不重新读取、计算或运行 updater。
- 最终源码正式 Vite 产物 `target/vite-config-atomic-nzp4c8or/bundle/cli.js` 的 state 图为 1 module ID/1 chunk、646 split chunks，保留 splitting；CLI typecheck 和 git diff 空白检查通过。`btv1m8jqx` 四组各 8 个、共 32 个独立 CLI 全部完成真实 `/version` 链，各观察 35 tools，验证同 Session 串行复用、usage/live（每组 68 条）。32 个提前持有的进程句柄均确认退出，4 个 Server exit 0，无强杀；缺 ACK 的 Run 仍为 unknown，不称模型成功。四组 runtime/debug 共 64 文件中 Config file corrupted/UnexpectedEOF/Failed to atomic/Failed to save with lock 均为 0，四份 `.claude.json` 均可解析；该原生启动路径不维护 numStartups，本轮不以它验证启动计数。
- 独立 RMW 场景 `b2revcxpg`：8 worker×30 次、共 240 次全写入，updater 恰好每 worker 30 次，无丢更新且保留未知字段，直接断言 numStartups=240。真实 Bun reader 18,600 次观察 invalid=0/io=0，无强杀；此计数不冒充上述 CLI 启动场景的证据。
- Windows 真实持文件句柄（无 FILE_SHARE_DELETE）场景 `bzeaae0xa`：持续占用时 268.9 ms 返回 EPERM，file/cache 保旧、updater 仅执行一次、temp/lock 已清理；释放后 global/project 提交均成功。EACCES 注入 `bu93l8isu` 保留原 cause、旧 file/cache，完成 temp/lock 清理且后续提交成功。验证的是安全失败与恢复，不声称持续占用时提交必成功。
- **修复前记录**：本轮仅将已证配置截断 exit 1 根因修复收口；原两次 exit 0 当时仍独立 **OPEN**，32 次成功不能替代其直接归因。旧 dist 未覆盖、验证产物不设默认，runtime-host 未切换，模型/外部/跨平台未验范围不变。
- 旧 Bun 原产物不改的真实复现 `bxdm57678`：共享 runtime 的 8 个 CLI 保持 stdin 打开，`matcha-native-init0-cause8-pwotnetd` 的 slot 0/1 均 stdout=0/exit 0；probe_uncaught 为 EBUSY/open，栈为 writeFileSync→旧 file.ts:469 非原子 fallback→旧 config.ts:1142 saveConfig→:871 无锁 fallback→main:489 migrationVersion 提交→:1129 preAction。随后 beforeExit(0)、exitCode=null、stdinDestroyed=false、flowing=null，无 process.exit 调用。此为新复现同型机制的直接证据，已由配置单路径修复与 fatal 修复闭合；原两次历史没有栈，不追认各次精确触发。
- [gracefulShutdown.ts](../../src/utils/gracefulShutdown.ts) 的 uncaughtException/unhandledRejection 两 handler 统一调用同步 exitOnFatalError：先设 exitCode=1，再记录白名单 name/errno、固定 stderr、同步终端 cleanup，finally forceExit(1)；诊断/stderr/cleanup 异常也不绕过退出。不运行异步 hooks/正常 graceful，不输出 raw message/stack/secret，不加 Rust 重试。CLI typecheck exit 0；正式产物 `target/vite-init-fatal-ze7ut458/bundle/cli.js` 为 1 STATE module/chunk、646 split chunks，同源多入口 exports 产物为 648 split chunks、仅用于注入验证，不设默认。
- `beupfsr5m` 七项已运行：真实 CLI migrationVersion 11 提交点注入 FsOperations.renameSync EBUSY，exit 1/stdout=0，file/cache 保持 version 10、temp/锁清理；uncaught、unhandled、已在 graceful(0)、诊断失败、closedStderr、secretReason 均 exit 1/stdout=0、无敏感 marker。closedStderr 关闭 fd 2 后仍有 stderr，仅证明该样本退出，不证明 stderr 写失败分支；后续 `b00a1tg91` 关闭真实 stderr 读端，同步 write(2) 直接观测 EPIPE，fatal 仍 exit 1/stdout=0，无强杀，补齐该分支实证。
- `bmp77crrk` 正式产物 Rust 8 CLI 实测通过：8 个独立 PID、各 35 tools、68 条 live events、同 Session 串行复用、预持进程句柄全部回收、Server exit 0，无强杀。Rust 失败链补验 `bsb3cagv8` exit 0（`matcha-rust-init-fatal-hb_u_j6e`）：通过现有配置合法前缀启动同源 exports 真实 CLI，仅对 migrationVersion 11 提交的 FsOperations.renameSync 注入 EBUSY；原生 exit 1、stdout 无 native.result，Run 仅一个 Failed/native_initialize_failed terminal，instance 清除。诊断保留 causeCode=-32006/causeKind=native_response_lost/delivery=unknown/stage=stdout_eof 及正确 instanceId/nativeRequestId；file/cache 保旧 version 10、temp/锁清理，预持一个进程句柄确认退出，Server Ctrl+Break exit 0，无强杀，未改 Rust 契约或添加失败重试。此前 `b92lwq2hu` 因验证器误用禁用的 `--` prefix 未启动 CLI，`b1yehrkkq` 因错误期待 exitCode（实际 cli.exited.code）失败，均仅修验证器，不算产品失败或通过。CLI typecheck/正式构建通过；`b0qirgnt7` Rust fmt --check 与 clippy --all-targets -D warnings exit 0，`b5spuasiv` 新增文件 Biome 格式检查 exit 0。旧 dist 未覆盖、验证产物不设默认，runtime-host 未切换，模型/外部/平台未验范围不变。

## 2026-10-16 真实模型验证

- 本轮仅验证，不改产品源码、不落测试脚本、不 commit/push；用户授权的自定义 endpoint 以 OpenAI-compatible 协议调用 deepseek-v4.1-flash/glm-5.3-flash，仅发送合成内容。三轮共 11 Session、12 个真实 CLI、27 Run 终态：25 succeeded、2 cancelled（排队 cancelled_before_send、执行中 native_interruption_observed 各一）；4 个 native running 区间实际重叠，同 Session 多轮串行、独立进程/marker 隔离、取消后复用、close/resume 新实例恢复会话记忆及历史分页通过，不代替持久 memory 注入验证。
- Write/Edit/Read 链（2 allow）、deny Write 无文件副作用、重复审批幂等/冲突拒绝及 AskUserQuestion Green 回传通过。7 tool_use/7 tool_result（Write 2、Read 3、Edit 1、AskUserQuestion 1），文件工具路径全部位于隔离根目录；33 条模型消息、13 个 thinking block、5,159 个 delta，共 5,543 条 native events 的原始 CLI→Rust durable 顺序/内容与完整重组核对通过；正文/思考逐块重组、tool input JSON、工具 ID 配对零错，不打印原始思考或在仓库保存模型内容。
- 执行时 WS live 共 413 条（双模型 6 Run 的 340 条＋Read 工具专项 73 条），与 durable/replay 严格按接收顺序、seq 逐条一致。工具专项 1 GLM Session/1 CLI/1 succeeded Run/1 Read use/result，70 条 native 与 raw 结构一致，顺序为 stream tool start < assistant tool_use < tool_result < native.result < run.terminal，文件 token 结果与最终正文精确一致；原双模型实时样本的 332 条 native 亦与 raw 一致。重启首轮 Server 的 5,195 条订阅恢复回放全部一致，包含工具事件；最后工具 Session 的只读 WS 恢复亦通过。
- 全部 11 Session 的 usage.get 已逐条核对 26 个 native.result（排队取消无 result）：query tokens 求和，每 CLI 累计 cost/modelUsage 取最新 snapshot，不逐轮重复累加；internal cost 不是供应商账单，不宣称总费用。最后工具 Session 的无 key 只读补验 `b9172mjt8` 通过，未启动新 CLI 或调用模型，Server exit 0。
- 原失败报告保留：首轮验证器对未要求空格的 markerSECOND 使用过窄断言、raw 按 PID 文件名而非真实启动顺序排序；离线完整复核及实时补验均通过，非产品故障。工具专项原报告仍因 JSON.stringify 的 cost 表示严格比较失败，独立 live-tool-audit.json 通过；仅 cost 字段使用明确浮点容差（原样本 3.47e-18、工具样本两字段 8.67e-19），文本/思考/工具/UUID/顺序仍严格。`ouy23vy4` 仅 Node 命令转义解析失败，未启动 CLI/调用模型，Server 正常 exit 0，不计样本。
- 证据仅在系统临时区：`matcha-live-model-6jj2i66d`（report.json 原失败保留，offline-stream-audit.json、offline-isolation-audit.json、usage-and-ws-recovery-audit.json 通过）、`matcha-live-followup-n3fmpiw1`（report.json、更新后的三轮 combined-stream-audit.json、cleanup.json 通过）、`matcha-tool-live-jyf7nig8`（report.json 原失败保留，live-tool-audit.json 通过）；关联任务 `bjvlodb9i`、`b0plev23n`、`bas1o2vpj`。12 个提前持有的 CLI 句柄确认退出，无强杀；前两轮 3 次 Server 及最终只读补验 Server 均优雅 exit 0，最终 138 个隔离文件 key 字节扫描零泄漏，secret 仅 env/内存引用，未读取本机真实凭据或外发仓库内容。原失败报告保留，不覆盖为全绿；结论仅为所测范围通过，不证明 UI 渲染或模型推理质量，其余未验项以顶部清单为准。
