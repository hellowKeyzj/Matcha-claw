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
- `pack <built-directory> <output.zip>`：仅打包已构建文件，输出必须在输入目录外且尚不存在。生成项目可用 `npm --prefix "$PROJECT" run pack`。
- 退出 watch 不会安装或停止 Host 开发实例。显式 `stop --connection <file>` 才关闭该实例；它不停止已安装正式插件。

构建／ZIP 校验失败保留上一成功预览；新 revision 后台启动失败不能当作旧版本仍 ready。`status` 提供 revision、最新 digest、最多 128 条脱敏日志及 32 条事件（单事件 ≤64 KiB），不是持久日志存储。

`inspect`／`act` 需要真实 application 预览已挂载；多入口包显式指定 `--entry`。动作仅 click／fill，DOM 变化后 opaque node ID 失效，须重新 inspect；不支持 eval 或任意 JS。`applied` 不是 trusted user gesture，也不证明业务成功。application 先检查预览中的实际 DOM、工具结果、日志与业务产物，再按用户安装意图提交**最新成功上传且已验证的精确 digest**。成功安装终结开发预览／后台，正式插件必须脱离 watch 独立运行。请求有大小限制、超时／Abort 和 redirect 拒绝，不自动重试 mutation；取消或超时不证明外部副作用回滚，安装结果未知时先用 `app_plugins_list` 核实，不盲重试。

## Manifest 与三种后台

贡献由 `manifest.json` 选择：`contributes.readers`、`connectors`、`applications`、`tools` 可按包规则合法组合，不由连接固定类别。`init --kind application|reader|connector` 仅选择起始模板（传一个实际值）；后台只支持 TypeScript、Python 3.12 和 Rust。公共合同见 `dist/index.d.ts`，manifest／ZIP 校验规则见 `dist/package.d.ts`。

- **TypeScript**：默认 `--backend typescript`，manifest 使用 `apiVersion:1` 和 `main`。`app-plugin.build.json.backend` 经 esbuild 输出 CommonJS；UI TS／TSX、CSS 和资源内联为自包含 HTML。后台导出 `activate(context)`，使用 `registerTool`、`publish`、`log`、`context.models`，返回 disposer 收尾。
- **Python 3.12**：`--backend python`，manifest 使用 `backend:{language:"python",entry,pythonVersion:"3.12"}`，不与 `main` 共存。SDK 只复制入口／资源，不安装 Python 依赖；需要依赖时将 `pyproject.toml`／`uv.lock` 成对加入 build `assets`，原生工具生成锁文件，不打包开发 venv。Matcha 用随应用交付的 uv 建 digest 隔离环境并 `uv sync --locked`；首用可能下载解释器／依赖，缺 uv 应修复应用安装，不 fallback 系统 Python。
- **Rust**：`--backend rust`，先 `cargo build --manifest-path "$PROJECT/Cargo.toml" --release --locked`，再 SDK build／dev。SDK 只复制工件，不运行 cargo。init 按当前 `win32|darwin|linux`、`x64|arm64` 填写 manifest 与 assets；换目标平台须重新编译并同步 `backend.platform/arch/entry`，不能只改标签。

reader／connector 起始模板不带后台，不能给它们的 init 搭配 Python／Rust；需要组合贡献时修改 manifest 与构建配置。不要打包宿主凭据、开发缓存或宿主源码路径。正式 CJS 共用一个 utilityProcess；Python／Rust 每实例有 owned stdio 进程，开发后台与正式实例隔离。关页面只停止观察，不终止正式后台任务；停用／更新／卸载由 Host 清理，未确认真实退出前保留执行目录。

## Python／Rust stdio

随包 `templates/python/README.md`、`templates/rust/README.md` 和入口代码给出完整实现。stdout 仅 UTF-8 换行 JSON-RPC 2.0（一行一个 JSON，不用 Content-Length），诊断写 stderr 或日志通知。Host 以 MCP `2025-11-25` 执行 `initialize` → `notifications/initialized` → `tools/list`；初始化 `params._meta.matcha` 提供 `{pluginId,version,packagePath,storagePath}`，路径仅供后台使用。

`tools/list` 必须精确匹配 manifest 的名称、描述、schema 和 metadata，不分页、不动态变更。`tools/call` 接收 `{name,arguments,_meta:{progressToken}}`，返回完整 `{content,structuredContent?,isError?,_meta?}`，由 Host 校验 schema。持续读协议以接收反向响应与取消，不能等待模型结果时堵住读循环。

| Matcha 扩展方法 | 原 params（不套 `{request:...}`） |
| --- | --- |
| `matcha/models/list` | `{kind:"image"|"video"}` |
| `matcha/models/generate` | `AppModelRequest` |
| `matcha/models/generateText` | `AppTextModelRequest` |
| `matcha/models/submitVideo` | `AppModelRequest`，`kind:"video"` |
| `matcha/models/queryVideo`、`matcha/models/collectVideo` | `{task:<完整 AppVideoTask>}` |

这些不是任意 MCP Host 都支持的标准方法。结果保留完整 SDK 合同。事件用 `notifications/matcha/event {topic,data}`（topic 1–200 字符、data 为 JSON），日志用 `notifications/message`，进度用 `notifications/progress` 回传本次 progressToken。`notifications/cancelled {requestId,reason?}` 取消对应请求，并传播到它发起的反向模型请求；EOF／关闭停止新请求并清理 owned 子任务。已发生的外部效果或费用不保证撤销，不自动重放失败调用。

## UI、reader 与 connector

application 使用自包含 HTML。标准 MCP Apps UI 只使用 Host 实际 advertise 的 capability，不假定 openLinks、updateModelContext 或 message 始终可用。`window.matchaApp` 的完整扩展见公共声明；正式 application 的 compose／标准 `ui/message` 只暂存可编辑聊天草稿，不自动发送。开发预览没有聊天身份，不提供 compose，不能依赖 session／workspace 能力；ready 握手不等于交互验收。

reader 模板仅 `window.matchaReader.onInput/ready/error`，不提供 Host API、Node、native path 或工具能力；不承诺 SDK `inspect`／`act` 支持 reader DOM。connector 仅声明 MCP HTTP 表单贡献，没有 application DOM；安装不创建已认证连接、不证明网络可达。二者安装前先构建、验包、核对声明；用户已要求安装时直接安装最新已验证 digest，再从实际 Files reader／connector 入口验收，不增加确认或安装门槛。缺少凭据或可用 surface 时如实标注未验，不把构建／安装当作功能成功。手动完整 ZIP 导入保留原信任确认。

本地 init／build／pack 仅证明各自构建边界，不能替代真实 Agent 制作、Matcha UI、正式 stdio 或 MCP Apps 互操作验收。
