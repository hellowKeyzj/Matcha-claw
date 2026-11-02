---
name: app-plugin-create
description: 制作、开发和调整尚未安装的 Matcha 插件，使用独立 SDK 完成 reader 文件阅读器、connector 连接器和 application 应用的构建、预览、持续修改与按意图安装。Use when 用户要求创建插件、开发阅读器、接入连接器、制作应用，或继续修改尚未安装的插件；不用于修改、更新或覆盖已安装插件。
---

# Matcha 插件制作

在当前对话中使用原生文件、终端、网络工具与独立 SDK 完成需求，不要求选择 runtime scope、换 Agent、开启新会话、填写制作向导、申请限时制作授权或重复确认。原生工具的目录、终端、网络及敏感操作权限仍然有效；被拒绝时不换入口绕过。

## 1. 确定实际结果

- 从当前需求和已有上下文确定功能与验收动作；只有影响结果的业务歧义才问用户，不先让用户填写类别或语言。
- 按用途选择 reader（Files 中阅读文件）、connector（已有连接界面的 MCP HTTP 连接配置贡献）、application（独立界面及可选后台）；按 SDK manifest 表达，确有需要可组合合法贡献。
- application 后台按需求选择 TypeScript、Python 3.12 或 Rust；不把所有插件都做成 application，也不为 reader／声明式 connector 强加后台。
- 以下 `app_plugins_*` 仅为逻辑工具名。先从当前 peer 的工具广告／发现入口取得真实名称与 schema；deferred 工具用现有搜索／执行入口加载后调用，不假设跨 peer 共用前缀。
- 调用 `app_plugins_list` 避开所有已安装 ID；只创建新 ID 或继续当前尚未安装的工程。不得读取、编辑、更新或覆盖已安装插件；遇到冲突另选新 ID，不用卸载规避 new-only。

## 2. 获取连接与独立 SDK

1. 调用 `app_plugins_sdk({})` 自主创建开发实例；继续当前对话已知的活跃实例时调用 `app_plugins_sdk({developmentId})`，不为每次修改另建实例。
2. 保存返回的 `development`，其连接 JSON 为 `{ "developmentId": "<实际 ID>", "baseUrl": "<实际 loopback 地址>", "token": "<本次连接 token>" }`。SDK CLI 统一用 `--connection <connection.json>`；也接受外层 `{ "development": ... }`。不拼旧 grant、过期字段或 CLI UUID。
3. 用返回的 `sdk.url` 与本次连接的 Bearer token 下载本地 SDK `.tgz`。不寻找主 MCP token，不索取 Matcha 源码，不猜远端 npm 包版本。
4. 下载物与解包物各放新空目录；从其目录之外执行工具。先阅读包内 README、所需公共声明及 CLI 帮助，再按其真实命令使用本地 tgz 初始化、安装 SDK 和构建，不猜参数或重新实现 SDK。
5. 在原生权限允许的位置创建新空工程目录；连接文件放私有位置并排除版本控制和打包。POSIX 使用仅当前用户可读写的权限，Windows 核对当前用户 ACL；token 不写入源码、manifest、公共日志、命令回显或最终回答。

本 Skill 只编排工作；构建、协议、模板、依赖和平台工件规则以实际下载 SDK 的 README／公共合同为准，按需读取，不复制一套 SDK 文档。

## 3. 构建、预览与持续修改

- 使用原生工具编写工程、准备所需依赖／编译工具；采用 SDK 模板和 build 配置。Rust 先按 README 编译真实目标工件；Python 遵守 3.12 与依赖锁定规则，不打包开发环境路径。
- SDK `build --connection` 构建、验包、上传并请求真实 Matcha preview；持续修改用 `watch`／`dev --connection`，首次成功上传请求一次 preview，后续热更新不反复抢焦点。需要重开时使用 SDK `preview --connection`，不强制跳转独立页面或新聊天。
- `watch` 不带 connection 只代表本地构建，不能声称已上传。保留每次成功上传的实际 revision／digest；构建失败、后台失败与上一成功版本分开判断。
- 使用 SDK `status` 查看当前 revision、后台、脱敏日志和事件；用 `inspect`／`act`／`call` 检查、操作、修复后再构建。较大二进制走 SDK ZIP 上传，不经过模型消息／base64；小型 UTF-8 工程才可按实际 schema 用 `app_plugins_build({developmentId,manifest,files})`。
- 开发连接只认证本地 HTTP 开发实例，不是聊天权限或会话身份。MCP 不提供 SessionIdentity，不拼 CLI UUID、不宣称预览绑定调用方；不假定开发预览可 compose。标准 MCP Apps 仅使用宿主实际广告的能力。

## 4. 用真实功能验收

| 类型 | 必须观察的结果 |
| --- | --- |
| application | 在真实预览操作用户所需流程，核对最终 DOM、工具返回和业务产物；有后台则通过 `call` 验证声明工具。 |
| reader | 在实际 Files reader surface 打开代表性文件，核对输入、内容显示与错误反馈；不能拿 application DOM 或自报 ready 冒充。 |
| connector | 区分“已贡献配置表单”“已配置连接”和“真实连通／工具可用”；按现有连接流程配置并验证实际请求，不能把安装或表单显示当连通证明。 |

- application 的 `inspect` 需要真实挂载的预览；`act` 只用最新快照的 opaque node ID 执行 click／fill，DOM 改变后重新 inspect，不猜 selector、不 eval。`applied` 不等于业务成功，也不是可信用户手势。
- 编译通过、ZIP 合法、上传成功、enabled／ready、日志无报错都不能单独算功能验收。缺实际 surface、凭据、权限或外部条件时明确记录未验项，不降低标准或伪报完成。
- 发布、发送、写外部数据等操作遵守原生权限及用户实际意图；失败或超时且效果未知时先读 status、日志及目标系统事实，不盲重发 mutation，不宣称副作用已回滚。

例如：“做一个回显应用并安装”应走新 application 工程 → 真实预览输入并提交 → 核对回显内容与工具返回 → 安装；“先试做一个看板”则完成 application 预览与实际交互验证后保留预览，不自动安装。

## 5. 按用户意图交付与收尾

- 用户已要求“做好并安装”：application 先在真实预览验证功能；reader／connector 未安装前无法进入正式贡献面，先完成构建、验包与声明核对。随后直接以最新成功上传且已完成相应核对的精确 digest 调 SDK `install --connection ... --digest ...`，或 `app_plugins_install({developmentId,digest})`，不再追加制作／安装确认。reader／connector 安装后沿正式入口验收；缺连接凭据或可观察 surface 时如实列为未验，安装成功不等于功能通过。
- 用户只要求试做、预览或先看效果：停在 preview，继续当前对话修改；后来要求安装时核对最新 revision／digest 与验证结果后安装，不要求新会话。
- 安装成功终结开发预览；正式插件必须脱离 watch 独立工作。通过 `app_plugins_list`／`app_plugins_status({pluginId})` 核对安装事实，按类型核对正式入口；尚未实测的正式运行结果单列说明。
- 安装结果不明时先读开发状态和已安装列表，不重复安装或重新创建同 ID。退出 watch 不等于安装或停止实例；不再需要的未安装实例按 SDK `stop --connection` 收尾，只停止本次持有的 watcher／开发实例，不杀未知进程、不删用户工程。
- 简短交付工程位置、插件 ID、已验证功能、安装或预览状态、未验项及清理结果；不包含 token 或其他秘密。达到本次目标后停止。
