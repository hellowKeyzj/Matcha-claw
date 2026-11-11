# Matcha App Plugins SDK

独立 npm 包 `@matcha/app-plugins-sdk`，需要 Node.js ≥22.15、npm，不依赖 Matcha 源码。产品 Agent 在当前普通对话中使用制作 Skill、原生文件／终端／网络工具和本 SDK；外部开发者可取得同一 SDK 下载包后在自己的终端开发。原生工具权限照常生效，插件后台是受信任本地代码，不是 OS 沙箱。开发安装仅支持新插件 ID，不读取已安装源码、不覆盖已有插件。

## 取得 SDK 与连接

调用 `app_plugins_sdk({})` 创建开发实例；已有实例用 `app_plugins_sdk({developmentId})` 取回连接。返回的 `development` 是 `{developmentId,baseUrl,token}`，`sdk.url` 是该实例的 SDK 下载地址。用原生网络工具携 `Authorization: Bearer <development.token>` 下载 `sdk.url`，不要跟随重定向，也不要寻找或复制 Matcha 私有 MCP token。

下载包与解包内容各放新建空目录；先阅读包内 README 和 `dist/*.d.ts`。将 `development` 原样存入项目外的私有 `connection.json`，CLI 也接受完整返回中的外层 `development` 对象。`baseUrl` 必须是实际 HTTP loopback 地址 `127.0.0.1` 或 `[::1]`、显式端口及 `/development/<developmentId>` 路径，不能自行替换域名或实例 ID。

连接仅用于本地 HTTP 鉴权，不代表聊天身份。不要把 token 写入源码、聊天、日志或命令历史，不要提交或打包连接文件。POSIX／Git Bash 写文件前设 `umask 077`，写后 `chmod 600`；Windows 还须确认 ACL 仅允许当前用户，`chmod` 不替代 ACL。

## 初始化、构建与预览

下面三个路径由原生工具准备；项目目录必须不存在或为空。SDK 始终安装下载的本地 `.tgz`，不依赖远端同名 SDK 发布包。`init` 不安装依赖。

```sh
SDK_ARCHIVE="/absolute/path/matcha-app-plugins-sdk.tgz"
PROJECT="/absolute/path/new-plugin"
CONNECTION="/private/path/connection.json"

npm exec --yes --package="$SDK_ARCHIVE" -- \
  matcha-app-plugin init "$PROJECT" --id example.my-app --backend typescript
npm --prefix "$PROJECT" install --save-dev "$SDK_ARCHIVE"

# 仅本地构建，不访问 Matcha 或联网下载资源。
npm --prefix "$PROJECT" run build
# 持续构建并直接上传 ZIP；首次成功上传后请求打开 Matcha 预览。
npm --prefix "$PROJECT" run dev -- --connection "$CONNECTION"
```

在另一终端使用项目中的 CLI，变量与上面相同。

```sh
CLI="$PROJECT/node_modules/@matcha/app-plugins-sdk/tooling/cli.mjs"
node "$CLI" status --connection "$CONNECTION"
# 手动重开预览；热更新不会反复抢焦点。
node "$CLI" preview --connection "$CONNECTION"
node "$CLI" inspect --connection "$CONNECTION" --entry index.html
# target 必须来自刚取得的真实快照，不是 selector。
node "$CLI" act --connection "$CONNECTION" --entry index.html --type fill --target '<snapshot-id>' --value hello
node "$CLI" act --connection "$CONNECTION" --entry index.html --type click --target '<fresh-snapshot-id>'
node "$CLI" call --connection "$CONNECTION" --name echo --arguments '{"text":"hello"}'
# 大参数也可用 --arguments @/absolute/path/input.json。
node "$CLI" status --connection "$CONNECTION"
node "$CLI" install --connection "$CONNECTION" --digest '<latest-successful-sha256>'
```

- `build [directory] --connection <file>`：一次构建、上传成功后请求预览。
- `watch [directory] --connection <file>` 与 `dev`：首次成功上传后只请求一次预览；失败或错过显示可显式运行 `preview`。`dev` 必须带连接；不带连接的 `build`／`watch` 仅本地构建，不联网。
- `pack <built-directory> <output.zip>`：仅打包已构建文件，输出必须在输入目录外且尚不存在。生成项目可用 `npm --prefix "$PROJECT" run pack`。包限制统一为 ZIP ≤256 MiB、解压总量 ≤512 MiB、单文件 ≤384 MiB、最多4096个文件；Host 与打包工具共用 SDK 限额。
- 退出 watch 不会安装或停止 Host 开发实例。显式 `stop --connection <file>` 才关闭该实例；它不停止已安装正式插件。

构建／ZIP 校验失败保留上一成功预览；新 revision 后台启动失败不能当作旧版本仍 ready。`status` 提供 revision、最新 digest、最多 128 条脱敏日志及 32 条事件（单事件 ≤64 KiB），不是持久日志存储。

`inspect`／`act` 需要真实 application 预览已挂载；多入口包显式指定 `--entry`。动作仅 click／fill，DOM 变化后 opaque node ID 失效，须重新 inspect；不支持 eval 或任意 JS。`applied` 不是 trusted user gesture，也不证明业务成功。application 先检查预览中的实际 DOM、工具结果、日志与业务产物，再按用户安装意图提交**最新成功上传且已验证的精确 digest**。成功安装终结开发预览／后台，正式插件必须脱离 watch 独立运行。请求有大小限制、超时／Abort 和 redirect 拒绝，不自动重试 mutation；取消或超时不证明外部副作用回滚，安装结果未知时先用 `app_plugins_list` 核实，不盲重试。

## 页面工作区身份

每个 `contributes.applications[]` 可声明 `scope:'session'|'workspace'`，省略为 `session`，不是整个插件统一选择，也不在每次打开时询问用户。`placement` 仍只控制独立路由／聊天工作区入口，不表示页面归属或授权；独立路由不获取当前聊天身份。

- `session`：工作区页面归属当前会话／草稿，保留原 compose 与草稿晋升；普通切会话清理该页，不把旧页面重新绑定到另一个会话。
- `workspace`：工作区页面跨会话保留同一实例，不传 `sessionIdentity`、`workspaceDraftId` 或 compose 回调，不提供当前会话媒体／文件能力，也不广告标准 `ui/message` 能力；切会话不会获得或重绑当前聊天授权。关闭、停用、卸载或更新仍按原生命周期处理，不等于跨应用重启持久化。

`window.matchaApp.context` 在每次 iframe 生命周期内冻结。会话工作区页的 `sessionIdentity` 仅在正式会话中存在；可选 `workspaceDraftId` 是当前草稿实例的 opaque ID，同一草稿创建正式会话时保留，普通切会话不传递。它只用于插件自己的文档承接，不授予会话、媒体或文件权限；插件应在原文档 owner 内幂等绑定，并拒绝将已归属另一会话的文档重新绑定。开发预览按 application 的声明保留工作区页面，但始终没有聊天身份或 compose；预览恢复列表保留原生命周期。

`scope` 不是后台权限沙箱：正式后台仍按显式目标调用 SDK，`imageEditor` 仍使用用户点击图片所属的明确会话身份，不从独立页面推断当前会话。

## Application 图标（SDK 1.6）

`contributes.applications[]` 可声明 `icon:{paths:["M4 4h16v16H4z"]}`，并声明 `minSdkVersion:"1.6.0"`。图标为 24×24 单色描边 SVG，宿主沿既有 stroke／currentColor 样式渲染；仅接受1–16条非空、各≤1024字符且至少含一个路径命令的 `d` 数据，字符限 SVG 路径命令 `MmZzLlHhVvCcSsQqTtAa`、数字、空格、逗号、点、正负号和 `eE`。不接受额外字段、SVG markup、URL 或脚本，不提供任意 HTML 或全局图标注册。

宿主将可工作区打开的应用放在“打开页面”列表，不为每个安装应用新增主侧栏按钮；`placement:"both"` 保留独立路由并提供工作区入口，`scope` 仍独立决定会话归属。未声明图标时使用通用窗口图标。

## 页面打开与文档资源（SDK 1.5）

依赖以下页面能力的插件声明 `minSdkVersion:"1.5.0"`，需要包含相应实现的新 Host，更新插件包不会更新运行中的 Host。

`window.matchaApp.openApplication({applicationId,data?})` 只打开当前插件、当前 digest 中已声明且当前容器允许的 application；目标沿原 application singleton 页面身份复用，不销毁已有未保存文档。首次打开数据来自冻结的 `context.data`；目标已存在时，通过 `subscribe` 收到 `{topic:'application.open',data:{data?}}`。插件在自己的文档 owner 中确认替换和处理取消，调用返回不代表目标已经接受文档。独立路由不取得聊天身份；不能借此跨 placement 或把 session 页面变成 workspace 页面。积压打开事件在第一个订阅者注册时交付，应用应在一个订阅入口分发业务事件，避免无关订阅抢先消费。

`window.matchaApp.documentResources.create({entry:{path,data,mimeType},resources:[{path,data,mimeType}]})` 创建只读、不可变的资源快照，返回 `{id,url,rootUrl}`；`data` 是 canonical base64，路径为文档内相对路径。每份快照有独立随机 URL 根，用于隔离预览中的标准相对 URL、module import 和 fetch，不接受本机路径、不提供任意文件服务器。`release({id})` 释放客户端持有；frame 关闭、插件停用或 digest 改变会撤销资源。输入及实际字节仍受 Host 预算限制，不能用插件 ZIP 限额推导页面传输容量。

可信后台的 `context.rendering.renderDocument({entry,document,payload?})` 可使用同形状的输入资源快照；`document` 与原 `html` 互斥，不接受 UI lease、任意 URL 或本机路径。动态文档在无 Node／preload 的隔离窗口执行作者脚本；可信 `entry` 必须是自包含 ESM，由 Host 读取后仅在 isolated world 加载，不向作者页面发布包资源或原生端口。后台 worker 收到 `{document:true,payload}`，原 `html` 模式不变；`ready` 等待当前资源与布局稳定，`print` 对当前 DOM 导出 PDF，不重新装载静态 HTML。输入和结果仍受服务信封预算限制，长轮询／持续动画不保证达到稳定状态。

这些能力的源码接线与构建检查不等于真实应用中的导航、资源渲染或导出验收。

## Manifest 与三种后台

贡献由 `manifest.json` 选择：`contributes.readers`、`connectors`、`applications`、`tools` 可按包规则合法组合，不由连接固定类别。`init --kind application|reader|connector` 仅选择起始模板（传一个实际值）；后台只支持 TypeScript、Python 3.12 和 Rust。公共合同见 `dist/index.d.ts`，manifest／ZIP 校验规则见 `dist/package.d.ts`。

依赖下述服务的插件声明正式字段 `minSdkVersion:"1.2.0"`；它只接受 `major.minor.patch`，不是 semver range，`apiVersion` 仍为 `1`。Host 激活时拒绝高于当前 SDK 的最低版本；旧宿主不支持该字段或服务时，需要升级应用，不能只更新插件包。[VERIFY: sdk/app-plugins/src/manifest.ts:56-67] [VERIFY: sdk/app-plugins/src/package.ts:65-80] [VERIFY: electron/main/app-plugins/host.ts:235-241]

- **TypeScript**：默认 `--backend typescript`，manifest 使用 `apiVersion:1` 和 `main`。`app-plugin.build.json.backend` 经 esbuild 输出 CommonJS；UI TS／TSX、CSS 和资源内联为自包含 HTML。后台导出 `activate(context)`，使用 `registerTool`、`publish`、`log`、`context.models`，返回 disposer 收尾。
- **Python 3.12**：`--backend python`，manifest 使用 `backend:{language:"python",entry,pythonVersion:"3.12"}`，不与 `main` 共存。SDK 只复制入口／资源，不安装 Python 依赖；需要依赖时将 `pyproject.toml`／`uv.lock` 成对加入 build `assets`，原生工具生成锁文件，不打包开发 venv。Matcha 用随应用交付的 uv 建 digest 隔离环境并 `uv sync --locked`；首用可能下载解释器／依赖，缺 uv 应修复应用安装，不 fallback 系统 Python。
- **Rust**：`--backend rust`，先 `cargo build --manifest-path "$PROJECT/Cargo.toml" --release --locked`，再 SDK build／dev。SDK 只复制工件，不运行 cargo。init 按当前 `win32|darwin|linux`、`x64|arm64` 填写 manifest 与 assets；换目标平台须重新编译并同步 `backend.platform/arch/entry`，不能只改标签。

reader／connector 起始模板不带后台，不能给它们的 init 搭配 Python／Rust；需要组合贡献时修改 manifest 与构建配置。不要打包宿主凭据、开发缓存或宿主源码路径。正式 CJS 共用一个 utilityProcess；Python／Rust 每实例有 owned stdio 进程，开发后台与正式实例隔离。关页面只停止观察，不终止正式后台任务；停用／更新／卸载由 Host 清理，未确认真实退出前保留执行目录。

## 可信人工确认

正式 TypeScript 后台可在正在执行的工具内调用 `await context.requestConfirmation({title,description,confirmLabel,details:[{label,value}]}, signal?)`。标题≤200字符、说明≤4000字符、按钮≤80字符、最多32项详情（label≤200、value≤24000字符），整个请求 JSON UTF-8≤64KiB；宿主全文显示详情，不截断。返回 `true` 仅来自 iframe 外宿主确认按钮的一次人工决定，用户取消返回 `false`；没有唯一可用的前台应用页面、视图隐藏／失焦等情况抛出 `code: "approval_unavailable"`，调用取消、完成、停用、更新或进程退出会使未决确认失效。开发预览目前不提供确认 owner，明确返回 unavailable。

这不是持久审批或通用权限。插件必须在请求内展示完整影响对象与精确版本，确认后重新核对业务 revision；不能保存一个布尔值供别次调用使用。模型和 iframe 只能发起业务调用，不能提交批准；`_meta.ui.visibility` 不提供安全隔离。后台代码本身仍为可信本地代码，不是 OS 沙箱。

Python／Rust 使用等价反向 JSON-RPC `matcha/requestConfirmation`，params 为 `{callId,request:{title,description,confirmLabel,details}}`；`callId` 必须原样取本次 Host `tools/call` 的 `id`（也等于 `_meta.progressToken`），结果是 JSON boolean，错误码在 `error.data.code`。反向请求必须持续读响应；用 `notifications/cancelled {requestId}` 取消它，Host 也在外层调用结束／取消时强制失效。不可从并发调用借用 callId。该方法不是标准 MCP，不对外提供 approve 工具。

## 独立 Agent 与团队执行（SDK 1.1）

正式已启用后台使用 `context.execution`，Python／Rust 使用等价 `matcha/execution/<operation>`，params 原样传对应 input，不套 request。输入按公共 `isAppExecutionRequest` 校验；请求、结果 JSON 各至多1 MiB，图 YAML 至多768 KiB UTF-8。此能力需要包含 SDK 1.1 执行实现的宿主；旧宿主不能只升级插件取得能力。开发连接不授予运行权限，开发后台不提供 execution；缺失时明确不可用，不退回当前聊天或直接模型。

| 操作 | 输入与结果 |
| --- | --- |
| `listAgents({})` | 返回显式 `{endpoint,agentId,name,ready}` 目录 |
| `createSession({endpoint,agentId})` | 返回 `{outcome:'created',session:{identity,endpointSessionId}}`，或 target_rejected／unknown |
| `sendMessage({identity,message,idempotencyKey})` | 返回 accepted＋runId／queued，或 target_rejected／unknown；受理不等于完成 |
| `sendAndWaitSession({identity,message,idempotencyKey})` | 在发送前建立原生观察，取得本次 exact run 终态和原生输出；断流、缺事件或超时为 unknown，不用 final 消息或空闲快照猜成功 |
| `readSession({identity,runId})` | 只读经原生证明归属请求 run 的输出；complete/messagesStatus 仅表示该原生最终输出完整，不保证该 run 全部 assistant 历史、全部 text blocks 或整个 SessionView 完整，也不代表业务成功。itemId 仅为真实原生身份，只提供 run result 时为 null；runtime 缺完整当前事实时为 null |
| `cancelSession({identity,runId})` | 返回 requested／target_rejected／unknown；requested 不等于原生取消已完成 |
| `listTeams({})` | 只读既有 Teams 目录投影，目录不可用抛错，不返回假空列表 |
| `createTeamRun(...)` | 显式 scope、teamId、packagePath、sourceType、runId、idempotencyKey，必要时 sourceAgentId；创建 Run，不是创建团队定义 |
| `readTeamRun({scope,teamId,runId})` | 读取状态、版本、designEpoch／graphVersion、artifacts及messagesStatus；当前类型区分 complete／incomplete／unavailable，只有 complete 才表示正文视图完整，不能将 incomplete／unavailable 当作暂时空消息；摘要／contentRef不是产物正文 |
| `importTeamGraph({...target,yaml,idempotencyKey})` | 通过既有图导入合同绑定真实任务，不提供 teamId＋一句话的隐式执行 |
| `startTeamRun({...target,designEpoch,expectedGraphVersion,idempotencyKey})` | 按精确图版本启动，started 不等于业务完成 |
| `cancelTeamRun({...target,idempotencyKey,reason?})` | 请求取消，不保证已撤销外部效果 |

Matcha adapter 原样返回 QueryEngine 的 `result.result`（最后 assistant 的最后 content block 为 text 时的文本），不拼接 transcript。

历史 SDK 1.1.1 为当时固定空 `messages` 的 Organization snapshot 明确投影 `unavailable`；这是旧阶段限制，不是新版本永远不可读的承诺。当前 Main `readTeamRun` 消费原生 `team.runSnapshot`／`team.designSnapshot`，已写入按 messagePage／messageCursor 聚合正文、核同 revision及当前attempt归属的消费者；只暴露完整单条消息，超预算或不完整返回 `incomplete`，失效快照清空旧结果。公共响应仍≤1 MiB，不能仅凭 Team `completed` 或部分消息声称完整交付；该消费者源码不证明原生producer／分页整链或真实运行已验。[VERIFY: sdk/app-plugins/src/execution.ts:94-100] [VERIFY: electron/main/app-plugins/execution.ts:286-423]

完整形状见 `AppExecutionInputs/Results`。持久保存执行身份与请求键后再发送；unknown 不自动重发。新会话不创建独立工作区或 OS 沙箱，运行时继续拥有原生工作区、工具和权限。执行目标不读取当前 Chat 选择。Team scope 保留原生 runtime／Agent 语义，团队目录仅用于发现，不是授权。标准 MCP Apps `compose`／`ui/message` 仍只暂存草稿，与此后台执行 API 分开。

## 团队原生审批（SDK 1.3.0）

依赖本节能力的插件声明 `minSdkVersion:"1.3.0"`，`apiVersion` 仍为 `1`；宿主必须包含此审批实现，旧宿主不能只换 SDK。正式后台沿原 `context.execution` 读取／人工处理原生 TeamRun 审批，不新增审批工具或审批 owner，也不包含 Commerce UI。`window.matchaApp` 不提供后台 execution 直连，开发后台仍不可用。[VERIFY: sdk/app-plugins/package.json:2-3] [VERIFY: sdk/app-plugins/src/execution.ts:140-169,239-242]

`readTeamRun({scope,teamId,runId})` 新增 `approvals: readonly AppTeamApproval[]`，保留该 run 的全部公开审批记录，包括已解决的历史；不能按 current attempt 筛选或猜测关联。字段严格来自 canonical SDK，不是原生私有审批全文。[VERIFY: sdk/app-plugins/src/execution.ts:93-134] [VERIFY: electron/main/app-plugins/team-approvals.ts:14-38] [VERIFY: electron/main/app-plugins/execution.ts:290-305] [VERIFY: runtime-host/modules/organization/src/run/public_projection.rs:1273-1277,1424-1448]

| `AppTeamApproval` 字段 | 形状 |
| --- | --- |
| `approvalId`、`runId`、`stageId`、`roleId`、`reason`、`requestedAction` | string |
| `subject` | `stage`／`work_node`／`human_decision` |
| `nodeId` | string 或 null（stage 为 null） |
| `status` | `pending`／`approved`／`denied`／`aborted` |
| `decision` | `approve`／`deny`／`abort` 或 null |
| `createdAt`、`resolvedAt` | number；resolvedAt 可为 null |

`resolveTeamApproval(input,signal?)` 的 SDK input 是 `{scope,teamId,runId,approvalId,decision,idempotencyKey,note?,language?}`，target 沿用 `AppTeamRunTarget`；`approvalId` 与 `idempotencyKey` 均须匹配 `[A-Za-z0-9._:-]{1,128}`。`decision` 为 `approve|deny|abort`；可选 `note` 非空白、不含 NUL、UTF-8≤256字节；`language` 仅 `en|zh|ja|ru`，默认 `en`。`note` 是本次提交的备注，不是公开 approval 字段。CJS 必须在本插件当前工具调用内使用 `context.execution.resolveTeamApproval`；Python／Rust 仅此操作的反向方法为 `matcha/execution/resolveTeamApproval`，params 为 `{...SDKinput,callId}`，`callId` 原样来自本次 Host `tools/call` 的 `id`，不可借用并发／旧调用。其他 execution wire 仍原样传 SDK input，不加 callId、不套 request。[VERIFY: sdk/app-plugins/src/execution.ts:109-122,224-229] [VERIFY: sdk/app-plugins/src/language.ts:1-3] [VERIFY: electron/main/app-plugins/worker.ts:84-100] [VERIFY: electron/main/app-plugins/stdio-runtime.ts:269-339]

Main 先从 native `team.runSnapshot` 读取真实 pending `work_node`／`human_decision`，在 iframe 外可信确认中完整展示原生公开事实、目标 scope／team／run、本次决定及备注；人工确认后重新读取并核对整条审批一致，才向原生 `team.approvalResolve` 单次派发。取消弹窗返回 `cancelled`，不写 deny；没有可用前台或 active tool call 抛 `code:"approval_unavailable"`（stdio 为 `error.data.code`）。审批不存在、已解决、确认期间变更或 subject 为 stage，返回 `target_rejected`。[VERIFY: electron/main/app-plugins/team-approvals.ts:40-84] [VERIFY: electron/main/app-plugins/confirmation.ts:30-57]

`recorded`／`replayed` 仅表示原生决定回执，不表示工作完成；派发后回执不明为 `unknown`，先 `readTeamRun` 读回同 run／approvalId，不换 key 重提或盲重试。WorkNode 原生只记账，不恢复／重派节点、不执行 requestedAction 或工具；HumanDecision 按 approve／deny／abort 推进 `approved`／`rejected`／`aborted` 分支，abort 不等于取消整个 run。运行时工具权限审批始终独立。[VERIFY: electron/main/app-plugins/team-approvals.ts:73-90] [VERIFY: runtime-host/modules/organization/src/store/facts.rs:1833-1915] [VERIFY: runtime-host/modules/organization/src/run/control/resolution.rs:110-132]

原生未公开的风险正文、业务附件和审批备注不能补造成 `risk`／`note`／attempt fence 等公开字段；插件可按原合同读取 `messages`／`artifacts` 辅助展示，但不能拿这些材料另造审批事实 owner，摘要／contentRef 仍不是附件正文。

```ts
// 已有工具 handler 内；input: AppTeamApprovalResolveRequest，key 已在发起前保留。
const target = { scope: input.scope, teamId: input.teamId, runId: input.runId };
const snapshot = await context.execution.readTeamRun(target, signal);
const approval = snapshot.approvals.find(a => a.approvalId === input.approvalId);
if (approval?.status === 'pending' && approval.subject !== 'stage') {
  const receipt = await context.execution.resolveTeamApproval(input, signal);
  const latest = await context.execution.readTeamRun(target, signal);
  // 展示 receipt.outcome 与 latest 中同一 approvalId；unknown 不重提，不据回执宣称工作完成。
}
```

本节说明源码合同；正式 Host UI、真实审批和完整 S2 尚未验收，局部类型／构建与合成边界验证不等于真实业务通过。集中证据见本轮 SDK 审批实施记录。

## 后台应用服务（SDK 1.2）

正式已启用后台通过 `context.workspace`／`knowledge`／`credentials`／`capabilities` 调用，所有方法均为 `(input, signal?) => Promise<result>`；Python／Rust 使用等价 `matcha/<service>/<operation>`，params 就是对应 input，不套 `{request:...}`。这些是后台 API，不挂到 `window.matchaApp`。Host 用当前 manifest ID／digest 绑定实例，SDK 不接受 caller 自报 pluginId；开发后台不提供这些服务，返回 `unavailable`，不能用开发 token 获得正式权限。[VERIFY: sdk/app-plugins/src/api.ts:184-188] [VERIFY: sdk/app-plugins/src/services.ts:12-14,134-144] [VERIFY: electron/main/app-plugins/host.ts:107-111,274-280] [VERIFY: electron/main/app-plugins/worker.ts:96-106]

| 服务 | 操作与关键合同 |
| --- | --- |
| `workspace` | `readText`／`readBinary`／`stat`／`listDir`／`writeText`／`writeBinary` 均显式传 `{endpoint,agentId,relativePath}`；读可加 `maxBytes`，目录可加 `includeHidden`，写分别加 `content`／canonical base64 `data`。仅 `listDir` 允许 `relativePath:""` 表示根；文本内容≤2 MiB，二进制解码≤4 MiB。沿原签名 Workspace transport 和 native 授权，不取当前 Chat、不返回 `rootPath`。这不修改 UI `saveWorkspaceFile` 或原生文件入口的预算与手势要求。 |
| `knowledge` | `list({})` 返回 `{projects:[{projectId,title,isCurrent}]}`；`listDir({projectId,relativePath})` 单层列举库内目录，`relativePath:""` 表示根，返回 `{projectId,relativePath,entries:[{relativePath,isDirectory,size,modifiedAtMs}]}`，entry 路径相对项目根；`read({projectId,relativePath})` 返回完整 content／revision；`search`／`retrieveContext` 用 `{projectId,query,limit?}` 返回相对路径 hits／snippets／可空 content。`archive({projectId,requestKey,title,sourceUrl?,mainFile,attachments?})` 中每个文件为 `{relativePath,mimeType,contentBase64}`，单件解码≤6 MiB；`archiveStatus({projectId,requestKey})` 查询同一归档。复用现 Wiki owner，不公开项目 `rootPath`。 |
| `credentials` | `availability({})` 返回 `{available:true}` 或 `{available:false,reason}`；`get({key}) -> {value:string|null}`、`set({key,value}) -> {stored:true}`、`delete({key}) -> {deleted:true}`。key 为1–128位 ASCII 字母／数字开头、后续字母／数字／`.`／`_`／`-`，value UTF-8≤64 KiB；每插件≤128项、加密前 payload≤512 KiB。只访问本插件命名空间，不提供全局账号管理。 |
| `capabilities` | `describe({target?:{endpoint,agentId}})` 返回 `{sdkVersion,operations:[{id,status,reason?,limits}]}`，status 为 `available`／`unavailable`／`request-dependent`。Workspace 未给 target 时依请求而定；execution 仍依 native target／run、models 仍依模型／Provider。能力描述只是当时观察，不是授权或执行成功保证。 |

以上形状与输入 guard 归 canonical SDK；Main 另核结果和字节预算。service 请求／结果 payload 各≤8 MiB，完整 CJS IPC envelope／stdio JSON-RPC 帧也各≤8 MiB（stdio 包含末尾换行），不是8 MiB内容再额外加信封。[VERIFY: sdk/app-plugins/src/services.ts:4-6,15-120,169-202] [VERIFY: electron/main/app-plugins/workspace.ts:26-50,80-119,123-166] [VERIFY: electron/main/app-plugins/knowledge.ts:46-101,116-169] [VERIFY: electron/main/app-plugins/services.ts:25-67,99-116] [VERIFY: electron/main/app-plugins/protocol.ts:77-114] [VERIFY: electron/main/app-plugins/stdio-runtime.ts:168-175,180-198,215-224,302-330]

归档回执 `accepted:true`／`saveState:'saved'` 只证明文件已保存，逐文件 `parseState`／`indexState` 另报后续处理；`indexState` 是 source/page 索引，不证明向量 embedding 成功。持久保存 projectId／requestKey；归档派发后断流、取消或回执无效为 `outcome-unknown`，先用同 key 查 `archiveStatus`，不要换 key 重提或把保存成功写成解析／检索全部完成。[VERIFY: sdk/app-plugins/src/services.ts:39-58] [VERIFY: electron/main/app-plugins/knowledge.ts:18-20,124-159]

凭据由 Main `safeStorage` 加密、私有目录／原子文件持久化，同插件串行读改写；Linux `basic_text` 或系统加密不可用时失败关闭，不回退明文。`get` 的明文只供可信后台使用，不放进工具结果、UI／模型上下文、事件或日志；SDK 不暴露凭据文件路径或任意解密接口。该命名空间边界不把后台变成 OS 沙箱。[VERIFY: electron/main/app-plugins/credentials.ts:41-54,57-91,94-165] [VERIFY: electron/main/app-plugins/services.ts:99-110]

service 错误用 `AppServiceError.code`：`invalid-request`、`unavailable`、`outcome-unknown`、`cancelled`、`response-too-large`、`not-found`、`conflict`、`permission-denied`、`storage-unavailable`；stdio 对应 `error.data.code`，不依赖错误文案分支。写入派发后的 `outcome-unknown` 表示可能已改文件或产生外部效果，不自动重试；取消只停止观察，不证明回滚。SDK 1.2 的源码／类型及本文合同不替代正式三语言、系统密钥库、归档或 native 业务实测。[VERIFY: sdk/app-plugins/src/services.ts:6-10] [VERIFY: electron/main/app-plugins/workspace.ts:15-16,149-157] [VERIFY: electron/main/app-plugins/protocol.ts:88-94] [VERIFY: electron/main/app-plugins/stdio-runtime.ts:327-331]

## 可信后台桌面能力

正式后台使用只读 `context.desktop`，Python／Rust 使用 `matcha/desktop/<operation>`，params 原样传 input。沿既有后台 service 协议和实例身份校验，不提供开发后台、`window.matchaApp` 或任意 UI 路径入口。

| 操作 | 输入与结果 |
| --- | --- |
| `systemLocale({})` | SDK 1.5，由 Electron `app.getSystemLocale()` 返回 `{locale:string}`；是系统地区事实，不是页面语言或 `navigator.language`。 |
| `openExternal({url})` | 仅绝对 `http:`／`https:`／`mailto:` URL，拒绝凭据、空白及控制字符；交系统默认应用打开后返回 `{opened:true}`，不证明网页加载成功。 |
| `revealFile({path})` | 必须是存在的绝对本机路径，拒绝 UNC／设备路径及解析到网络的链接；只在文件管理器定位，绝不执行文件，返回 `{revealed:true}`。 |
| `pickFile({extensions})` | `extensions` 为1–64个不带点／通配符的1–32位字母数字扩展名。Main 以现主窗口为 parent 打开单选 `openFile` 原生文件选择器，返回 `{path:string|null}`；取消为 null，无可用主窗口为 `unavailable`。 |

本机路径只供可信后台使用，不得进入工具结果、模型、事件、日志或 opaque UI；UI 后续操作应使用插件后台持有的 opaque 暂存标识。文件选择不是业务确认，不替代原有可信人工确认。`capabilities.describe` 包含 `desktop.*`；`pickFile` 为依主窗口与用户选择而定，其他操作的 available 不保证本次 URL／路径或系统应用可用。沿既有取消／`outcome-unknown` 语义，不自动重试。旧宿主不能仅更新 SDK 获得此能力。[VERIFY: sdk/app-plugins/src/services.ts] [VERIFY: electron/main/app-plugins/desktop.ts] [VERIFY: electron/main/app-plugins/services.ts]

## 后台启动与持久待办（SDK 1.1）

声明 `background:true` 且具有 `main` 或 `backend` 的已启用插件，在宿主运行环境就绪后沿原生命周期激活；缺省仍按工具调用懒激活。插件自行持有业务定时器和 SQLite 进度，返回 disposer 负责取消并等待自身资源。关闭页面不停止正式后台；禁用、更新、卸载和退出仍按原 owner 退役。应用关闭或操作系统睡眠时不保证按时运行，重启后由业务 owner 恢复到期任务。

持久待审批由插件保存完整业务内容、依据版本及状态；重开页面后，普通工具调用现有可信确认，再由业务 owner 复核并原子消费。自动策略须在可信确认中完整展示动作范围、目标、预算和有效期，授权绑定精确配置版本，变更后失效；不能持久化一个通用 approved 布尔值。Host 不新增全局审批数据库或任务队列。

## 模型媒体合同

CJS `context.models` 与下述 stdio 扩展共用合同。既有 `list`／`generate`／`generateText`／`submitVideo`／`queryVideo`／`collectVideo` 输入输出不变；`generate` 仍只接受图片／视频。新增 `generateSpeech`、`transcribe`、`generateMusic` 均返回 `AppModelResult {outputs:[{data,mimeType}]}`，`data` 是 base64；转写是 `text/plain` UTF-8 base64，不另返回 `{text}`。`transcribe` 当前须显式传已配置模型的 `selectionId`；其他音频方法可使用对应路由。协议、认证或选项不支持时返回错误，不换模型重提。

视频 `AppVideoTask` 始终只有 `kind`／`selectionId`／`accountId`／`modelId`／`endpointId`／`remoteId` 六字段；`kind` 为 `openai-video`／`google-video`／`openrouter-video`／`dashscope-video`／`ark-video`。完整原回执用于查询／收集，不拼装新回执，不把 `remoteId` 当 URL；`isAppVideoTask` 提供共用严格校验。状态仍为 `queued`／`in-progress`／`completed`／`failed`／`unknown`；`failed` 表示任务无法取得生成结果，可能对应原生失败、取消或过期。请求体最多 48 MiB、输出解码合计最多 64 MiB，沿原 models 权限和取消链；取消／超时不保证上游撤单或退款，未知结果不自动重试。

## Python／Rust stdio

随包 `templates/python/README.md`、`templates/rust/README.md` 和入口代码给出完整实现。stdout 仅 UTF-8 换行 JSON-RPC 2.0（一行一个 JSON，不用 Content-Length），诊断写 stderr 或日志通知。Host 以 MCP `2025-11-25` 执行 `initialize` → `notifications/initialized` → `tools/list`；初始化 `params._meta.matcha` 提供 `{pluginId,version,packagePath,storagePath}`，路径仅供后台使用。

`tools/list` 必须精确匹配 manifest 的名称、描述、schema 和 metadata，不分页、不动态变更。`tools/call` 接收 `{name,arguments,_meta:{progressToken}}`，返回完整 `{content,structuredContent?,isError?,_meta?}`，由 Host 校验 schema。持续读协议以接收反向响应与取消，不能等待模型结果时堵住读循环。

| Matcha 扩展方法 | 原 params（不套 `{request:...}`） |
| --- | --- |
| `matcha/desktop/<operation>` | 上述 `AppDesktopInputs[operation]`，openExternal／revealFile／pickFile／systemLocale，仅可信后台 |
| `matcha/workspace/<operation>` | 上述 `AppWorkspaceInputs[operation]`，六项操作 |
| `matcha/knowledge/<operation>` | 上述 `AppKnowledgeInputs[operation]`，含 listDir／archive／archiveStatus 共七项 |
| `matcha/credentials/<operation>` | 上述 `AppCredentialsInputs[operation]`，四项操作，不接受 pluginId |
| `matcha/capabilities/describe` | `{target?:{endpoint,agentId}}` |
| `matcha/models/list` | `{kind:"image"|"video"}` |
| `matcha/models/generate` | `AppModelRequest` |
| `matcha/models/generateText` | `AppTextModelRequest` |
| `matcha/models/generateSpeech` | `AppSpeechModelRequest`：`{prompt,selectionId?,voice?,language?}` |
| `matcha/models/transcribe` | `AppTranscriptionModelRequest`：`{audio:{data,mimeType},selectionId?,language?}` |
| `matcha/models/generateMusic` | `AppMusicModelRequest`：`{prompt,selectionId?,durationSeconds?}` |
| `matcha/models/submitVideo` | `AppModelRequest`，`kind:"video"` |
| `matcha/models/queryVideo`、`matcha/models/collectVideo` | `{task:<完整 AppVideoTask>}` |

这些不是任意 MCP Host 都支持的标准方法。结果保留完整 SDK 合同。事件用 `notifications/matcha/event {topic,data}`（topic 1–200 字符、data 为 JSON），日志用 `notifications/message`，进度用 `notifications/progress` 回传本次 progressToken。`notifications/cancelled {requestId,reason?}` 取消对应请求，并传播到它发起的反向模型请求；EOF／关闭停止新请求并清理 owned 子任务。已发生的外部效果或费用不保证撤销，不自动重放失败调用。

## UI、reader 与 connector

application 使用自包含 HTML。标准 MCP Apps UI 只使用 Host 实际 advertise 的 capability，不假定 openLinks、updateModelContext 或 message 始终可用。`window.matchaApp` 的完整扩展见公共声明；正式 application 的 compose／标准 `ui/message` 只暂存可编辑聊天草稿，不自动发送。开发预览没有聊天身份，不提供 compose，不能依赖 session／workspace 能力；ready 握手不等于交互验收。

reader 模板仅 `window.matchaReader.onInput/ready/error`，不提供 Host API、Node、native path 或工具能力；不承诺 SDK `inspect`／`act` 支持 reader DOM。connector 仅声明 MCP HTTP 表单贡献，没有 application DOM；安装不创建已认证连接、不证明网络可达。二者安装前先构建、验包、核对声明；用户已要求安装时直接安装最新已验证 digest，再从实际 Files reader／connector 入口验收，不增加确认或安装门槛。缺少凭据或可用 surface 时如实标注未验，不把构建／安装当作功能成功。手动完整 ZIP 导入保留原信任确认。

本地 init／build／pack 仅证明各自构建边界，不能替代真实 Agent 制作、Matcha UI、正式 stdio 或 MCP Apps 互操作验收。
