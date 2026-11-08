# 运行故障

用于启动/控制连接、插件、渠道、会话、工具、任务及辅助能力异常。先读 maintenance status、inspect、logs，再按本页匹配第一个失败边界；需要原生诊断时用现有命令执行工具调用应用捆绑 CLI，不启动第二个 Gateway。

## 启动与控制的最短判断

```text
应用实际实例/安装/路径
  ├─ 未运行 → 包/执行环境/准备阶段/端口/配置/存储的原错误
  ├─ 运行未就绪 → startup/readiness 与本轮阶段
  ├─ 就绪但控制未连 → 目标/握手/认证/协议
  └─ 控制已连但原功能坏 → 模型/插件/渠道/会话/工具/任务
```

- HTTP liveness 只证明 HTTP 服务器响应；startup、readiness、WS 握手、RPC 能力和业务恢复不同。应用检查 HTTP 就绪后还要建立控制连接，running 不等于 control ready。
- maintenance status 不是全部原生 HTTP/业务探针集合；未返回细节就注明未覆盖，不自行推断或编造健康值。顶层 ok 或日志出现 listener 也不能代替原动作验收。
- Health 快照生成成功不保证所有渠道/队列正常；config-only、not checked、autostart suppressed 不默认判故障。

| 原错误/阶段 | 判断与动作边界 |
|---|---|
| stopped/秒退/启动准备拒绝 | 先读第一条具体拒绝。包入口、权限、空间、配置投影、DB 和运行环境都是候选，不从 stopped 猜认证失败；配置/存储按对应参考处理。 |
| `EADDRINUSE` / another Gateway / bind denied | 需要占用者真实归属，不能仅按端口杀进程、清锁或 force。交由已确认的应用/进程 owner 处理；未证明是本应用就不接管。 |
| HTTP 可通、startup/readiness 未满足 | 保留 pending/failing 阶段、时间与依赖错误；低 CPU 不排除准备依赖阻塞，不靠连续 restart 碰运气。 |
| token missing/mismatch、scope mismatch、pairing required | 缺凭据、错凭据、能力未批与新设备配对不同；只报告安全错误 code，不旋转共享 token、清 identity 或自动批准请求。 |
| Origin、nonce、signature、protocol mismatch | 区分来源、挑战签名/时钟与客户端协议；不关闭认证/来源门，不放宽 wire contract。需要应用兼容修复时报告，不冒充 maintenance 能改协议。 |
| 模型 publication、provider 错误 | 记录可见的准备阶段与错误，按配置/认证参考定位；不把重启当模型 probe，不额外试跑收费请求。 |

## 原生 CLI 诊断（三平台）

直接用现有命令执行工具，不新增 maintenance action。CLI 是应用自身 Electron 的 Node 模式加捆绑 `openclaw.mjs`，不是要求系统安装另一个 Node/OpenClaw。先从 inspect 取得实际 executable、installation、state/config、gatewayCwd 和 gatewayPort；默认目录或 PATH 中的同名命令不能代替这些事实。

### 找到当前安装的程序

| 平台 | 应用 executable | 捆绑入口 |
|---|---|---|
| Windows | 当前安装目录的 `MatchaClaw.exe`，以实际进程/inspect 为准 | `<安装目录>/resources/openclaw/openclaw.mjs` |
| macOS | 当前 `.app/Contents/MacOS/<实际 CFBundleExecutable>`，不假定装在 `/Applications` | 同一 `.app/Contents/Resources/openclaw/openclaw.mjs` |
| Linux | 当前应用进程的实际 executable；注意文件名大小写、AppImage 挂载与真实资源目录，不硬编码 `/opt` | 当前 resources 目录的 `openclaw/openclaw.mjs` |

开发版用当前开发 Electron executable 和项目 `node_modules/openclaw/openclaw.mjs`，不套安装版路径。优先使用 inspect 返回的真实路径；存在 `resources/cli/openclaw.cmd`（Windows）或 `resources/cli/openclaw`（POSIX）包装器也须核其指向同一安装，包装器不会自动带齐实例 state/认证。路径含空格须分别引用，不能拼接后 eval。

### 命令与适用场景

| 入口后的参数 | 能看到什么 | 边界 |
|---|---|---|
| `config validate --json` | 配置与插件 schema、SecretRef 形式的 issues/warnings | 不启动 Gateway，不证明凭据值有效或模型可调用。 |
| `status --json` | Gateway 可达性、渠道/会话/版本等综合状态 | 可能执行 exec SecretRef、插件及写入本地设备认证状态；不是纯静态读取，也不同于 maintenance status。 |
| `health --json` | 已运行 Gateway 的健康快照 | 默认不强制逐渠道 probe，快照成功不代表所有业务健康；不为失败另起 Gateway。 |
| `doctor --lint --json` | 原生规则 findings、severity 与检查覆盖 | 不执行 repair，但可创建临时 SQLite/state 快照、启动配置的 MCP、执行插件/凭据相关逻辑并访问网络。 |

按失败边界选一项，不自动全跑。status/doctor 执行前说明上述影响，取得对应授权；不默加 `--all`、`--deep`、`--verbose`、`--allow-exec` 或 `--fix`。doctor lint 的 exit 1 可表示发现问题，须读 JSON；运行失败也可能返回 1 或 2，不能只按数字判断。config exit 1 要区分校验不通过、缺文件与执行异常。

### 同一配置与实例

在临时命令进程内设置 `ELECTRON_RUN_AS_NODE=1`、`OPENCLAW_NO_RESPAWN=1`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_DIR` 和指向实际文件的 `OPENCLAW_CONFIG_PATH`；cwd 使用 inspect 的 gatewayCwd。可用 `NODE_DISABLE_COMPILE_CACHE=1`、`OPENCLAW_LOG_LEVEL=silent` 减少编译缓存/普通日志写入，但这不是插件/MCP 沙箱。

Windows 示例在一次性 PowerShell 子进程运行；变量先赋为核实后的绝对路径，不原样执行占位符，不用 setx 或修改 shell profile：

```powershell
# $exe/$entry/$state/$config/$cwd 均来自当前实例，不从 PATH 猜测
$env:ELECTRON_RUN_AS_NODE = '1'
$env:OPENCLAW_NO_RESPAWN = '1'
$env:OPENCLAW_STATE_DIR = $state
$env:OPENCLAW_CONFIG_DIR = $state
$env:OPENCLAW_CONFIG_PATH = $config
Set-Location -LiteralPath $cwd
& $exe $entry config validate --json
# 立即保留 $LASTEXITCODE；按上表选择其他参数，不重建 Gateway
```

macOS/Linux，以及 Windows Git Bash 使用 POSIX 语法；Windows 路径须先转换成当前 shell 可用的形式：

```sh
# exe/entry/state/config/cwd 均先绑定当前实例的实际路径
(cd "$cwd" &&
  ELECTRON_RUN_AS_NODE=1 OPENCLAW_NO_RESPAWN=1 \
  OPENCLAW_STATE_DIR="$state" OPENCLAW_CONFIG_DIR="$state" \
  OPENCLAW_CONFIG_PATH="$config" "$exe" "$entry" config validate --json)
# 立即保留 $?；退出子 shell 不改变原 shell 的 cwd/env
```

status/health 涉及 Gateway 时，还须核实际目标和认证：当前应用非 TLS 地址为 `ws://127.0.0.1:<实际 gatewayPort>/ws`，完整 `/ws` 路径不能丢。`OPENCLAW_GATEWAY_URL` 可指定该目标，仅设置 PORT 不能压过配置的 remote 模式。health 的 env URL 覆盖使用对应 env token/password；status 首次 probe 仍可能配置凭据优先，不能只设 URL/TOKEN 就声称同实例。核不清目标、配置引用或认证来源则停止该检查，报告缺口；不修改配置来让检查通过。

认证仅在已有获准的私密注入方式可用时通过子进程环境提供 `OPENCLAW_GATEWAY_TOKEN` 或 `OPENCLAW_GATEWAY_PASSWORD`，不放 argv、不打印、不要求用户粘贴，也不读取无关凭据。没有可用认证就保留认证检查未完成。TLS 实例另须核证书 pin，不能关闭校验或用非 TLS 代替；doctor 的外部 provider/MCP 访问不受 Gateway URL 限制。

保留执行工具原审批，使用其有界执行与输出限制。超时、截断、取消或清理未确认都不能当检查完成；仅清理本次确证自有的诊断进程。不要将原始 JSON/stderr 整包贴回对话：只摘必要错误、配置字段路径、规则 ID 和 severity，隐藏秘密、会话正文与敏感路径/URL。三平台说明不等于三平台已实机验证。

## 生命周期只走既有 owner

start、restart、repair 均需对本次具体动作授权，沿应用既有 admission/审计链执行。应用注入路径、端口、认证与运行环境；shell 中的同名 CLI 或展示命令不能复刻此链。禁止安装系统服务、另起前台 Gateway、自己 stop/kill/relaunch 或重写 supervisor。

repair 的已有链为：停止并确认 → 写入型 Doctor → 应用重新准备/投影 → 启动 → ready effects。Doctor 可能改配置/数据，不是 lint。失败、超时或 spawn failure 在某些路径仍可能继续后续准备/启动，所以必须分别保留 Doctor 与最终恢复结果；repair snapshot 的 succeeded 不代表 Doctor exit=0 或业务恢复。

- admitted/accepted 是受理，不是完成。保存 receipt；有返回的 32 位十六进制 callId 则用 status 携带原值查同次审计，同时读取 lifecycle/control readiness。
- busy 不抢占。超时、unknown/unknown-delivery、MCP 传输错误、断连或工具报错先查状态与日志，不能推断“没执行”而再次提交；缺同次结果时说明未知。
- 无新证据不重复同一 repair/restart；新的动作或更大影响需要对应授权。完成本次读回与原症状验证即停止，不变成后台巡检。

## 控制正常后的功能分流

以下为解释日志与应用现有界面的维护地图；maintenance 不提供定向插件/渠道/会话/RPC/浏览器执行，也不以 shell 补全。

| 症状 | 最小归因事实 | 安全恢复与验收边界 |
|---|---|---|
| 插件 missing/disabled/schema 拒绝 | 可见的 ID/来源/版本、enabled/status/error、有效 policy 与 schema；元数据存在不证明模块执行。 | 区分有效 deny、配置拼错与插件元数据缺失。不删 deny/放大 allow，不为消错整段删除；由所属应用入口修正已确认项，原能力另验。 |
| 重复插件/旧路径/依赖缺失/SDK incompatible | 选中的来源、package owner、failure phase、依赖或兼容错误；同名目录不证明残留。 | 不盲卸载、重装、npm install 或删除安装索引。卸载可能影响同包多个能力，兼容包修复需具体入口与授权；模块加载本身也可能执行第三方代码。 |
| 渠道断线/401/网络错误 | 区分 configured/enabled/linked/running、账户、同次错误与 probe 时间；插件 blocked 先修插件，旧 probe 不代表当前。 | DNS/proxy 与 token 错误分开；connected 不证明有发送权限。维护不提供单账户重连/登录，指向已确认入口；重登录/登出可能改凭据，不冒充无损重连。 |
| DM 不回/配对待批 | 同一 channel/account/sender、配对状态与 dmPolicy；DM pairing、设备 pairing、command owner 不是同一权限。 | 不改 open/通配 allow、不自动批准。批准发送者可能还影响命令 owner，需核真人与具体授权；外发通知/测试消息另授权。 |
| 群消息不触发/路由错 Agent | 群准入、mention、平台 scopes/intent、account/binding/peer、预期 Agent/session 分开。 | 先按原 mention/群策略验证；不靠取消 mention、扩大群授权或重配对治疗路由。精确绑定修改无工具时如实报告。 |
| 会话卡住/排队/writer claim | 对齐 session/run、队列阶段、长工具、存储错误；typing 不证明模型已开始。 | 当前工具运行、lane 排队与 writer ownership 拒绝不同；不删旧锁、interrupt/reset、重放 run 或清库。重放可能重复外发/计费，另需授权与真实入口。 |
| 工具 unavailable/exec 待批/沙箱拒绝 | 区分未注册、有效策略 deny、审批 pending、backend 不可达及具体 Agent/session。 | 不扩大 allowlist、不改 YOLO、不关闭 sandbox；审批由用户核请求。重建沙箱可能删除远端 workspace，不能当普通诊断。 |
| Cron 未触发/成功未送达 | 区分调度启用、时区/下次时间、run 与 delivery、suppression reason；none/NO_REPLY 可为有意静默。 | 不取消 quiet hours/DM 安全策略强求回包。手工 run 可调用模型/工具和发消息，不是读历史；无对应授权和入口就不执行。 |
| Browser/Node 不可用 | paired、online、前台、OS 权限、命令批准、endpoint/attach-only 与具体功能能力不同。 | 浏览器 status/deep 检查可能主动连接或读取页面，不作为默认静态诊断。不碰真实 profile/cookies，不 reset；设备权限交用户，实际辅助调用另授权。 |

## 能验证到哪一层

maintenance status/inspect/logs 与原生 CLI 只证明各自返回的覆盖；没有全部插件/provider/渠道、外置存储与平台分支的完整健康结论。不因缺细节就把组件判坏，也不把命令执行成功说成业务恢复或三平台实机已验证。

恢复验收要回到用户原应用内动作，确认正确实例、原错误不再复现、所需控制与授权满足、数据与未涉及配置保留。模型 probe/第三方消息单独获授权，当前 maintenance 无该 action 时交给用户或已确认的产品入口，并明确未验项。“启动未就绪就提前关闭”的超时场景已排除，不重新排查或阻塞本次维护。
