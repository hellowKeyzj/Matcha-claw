# 配置与认证

用于配置拒绝、Unknown model、凭据不可用、401/403/429 或修改后被覆盖。先读 maintenance 的 status、inspect、logs；需要原生配置校验时用现有命令执行工具，按[运行故障](runtime.md#原生-cli-诊断三平台)调用应用捆绑 CLI。

## 先确定配置 owner

- 以 inspect 返回的实际安装、state/config 与 Agent 路径为准。终端 PATH 中的同名 OpenClaw、默认 home 或工作区包版本都不能代表应用运行实例；不另执行 CLI 来猜路径。
- 应用以 Electron 的 Node 环境运行 Gateway，并注入 state/config、端口、认证与私有投影。终端环境变量正确，不证明应用进程获得同样的值；不索要完整环境或启动 argv。
- 启动前会应用 Provider、Settings、Security 等已保存状态；`configurationRejected` 也可能来自这些 preparation 阶段，不只 JSON 语法。受管字段从对应应用设置修正，手改原生文件可能被下一次投影覆盖。
- 原生 OpenClaw 支持 JSON5、`$include`、`${VAR}` 和旧配置兼容；应用直接配置读取并不等于完整原生解析器。inspect 的解析/安全摘要不能证明 includes、环境展开、插件 schema、SecretRef 或所有原生约束通过。
- 日志被脱敏、字段未在摘要中列出或 coverage 未覆盖，均不能证明原字段不存在。不要要求用户提供原始配置来补齐秘密。

## 按精确错误分层

| 错误/现象 | 要区分的事实与下一步 |
|---|---|
| JSON、include、unknown key、类型/枚举错误 | 保留安全的 issue path 与错误签名，确认是主配置、include 还是应用投影阶段；不删除整个 gateway/plugins/channels。精确写入无 maintenance 入口时报告限制。 |
| 新版本写过配置、未来版本保护 | 核实际包与写入版本；`meta.lastTouchedVersion` 是写入戳，不是数据库版本。寻找兼容应用/人工支持，不删戳绕过。 |
| `Unknown model: provider/model` | 精确 ID、provider 注册目录与默认模型选择是不同层；显示在选择目录不代表已注册，更不代表远端可用。先看应用模型设置与同次日志。 |
| missing auth / SecretRef unavailable | 区分引用的 alias/source、应用未注入变量、file/store/exec 来源不可用、选中 profile 缺失；只报告来源类别，不输出值。inspect 不取凭据验证，repair 也不是自动重新登录。 |
| 401/403 | 区分 Gateway 握手、代理身份、模型 provider 或渠道端；不能仅凭状态码换所有 key、批准设备或关闭认证。 |
| 429 / billing / rate_limit | 区分 Gateway 认证尝试限流、provider 限流与余额/账单；不自动充值、换账号、清 cooldown 或反复重发收费请求。 |
| fallback 后失败或模型变化 | 模型候选、同 provider 的 profile 顺序、cooldown/disabled 是独立事实；保留可见的失败链，不只归因最终一条错误。 |
| API 协议/endpoint 不匹配 | 区分 provider 与模型级覆盖；schema 接受字段不代表端点支持该协议。精确改动须由有能力的 owner 处理。 |

## 解释字段时用的最小地图

这些是定位词，不是当前工具支持写入的承诺，也不是所有版本/插件的通用模板。

| 范围 | 易混点 |
|---|---|
| `gateway.mode`、`bind`、`port` | 本地/远程角色、绑定方式与端口不同；实际注入值可不同于 JSON，不为连接失败扩大到 LAN。 |
| `gateway.auth`、`remote`、`controlUi.allowedOrigins` | 本地认证、远程目标认证、浏览器来源属于不同边界；不清身份、删 TLS pin 或放宽来源校验。 |
| `agents.defaults.model`、`models` 与 `models.providers` | 默认选择、模型元数据目录、provider 注册不是同一件事；`baseUrl` 与协议 `api` 也须对应。 |
| `agents.entries` 与旧 `agents.list` | 原生正式 roster 使用 entries，合法 list 可兼容读取；同时存在时 entries 优先，不合并。应用适配可能仍有旧形状消费者，不能机械替换 roster 或重新分配 ID。 |
| provider `auth` 与 profile `mode` | `api-key` 与 `api_key` 属不同字段的枚举，不能互换；元数据 profile 不是完整凭据存储。 |
| `plugins.entries.<id>.config`、`channels.<id>` | 字段由实际插件 schema 决定，不照搬第三方模板；缺元数据与真正配置拼错要分开。 |

凭据解析受显式绑定、locked profile、调用方 precedence 和引用失败门禁影响，不存在可保证的统一“环境变量永远优先”规则。不要为验证优先级读取或回显所有凭据。

## 最小修复与停止线

1. 先定位具体 owner 与错误层。应用已提供的设置由用户在对应入口修正；不能确认入口时报告所需精确能力，不虚构工具或菜单。
2. 只有错误确属既有 repair 链可处理、用户理解会停机与写配置/状态并具体授权，才考虑 maintenance repair；不承诺它能修复任意插件 schema、远端账号或手工迁移。
3. 写盘、重新投影、Gateway 启动、控制连接和业务恢复是不同结果。按原错误读回 status/logs，涉及配置再 inspect，最终在应用中验证原动作。
4. 需要模型请求时单独明确 provider/模型、费用与凭据使用并获授权；maintenance 没有 probe action，不能用“检查健康”暗中调用模型。

## 原生配置诊断

- 直接调用捆绑 CLI 的 `config validate --json`，补 inspect 未覆盖的原生静态 schema/SecretRef 形式校验；保留必要 issues/warnings 字段路径。通过不证明凭据可解析、远端认证有效、模型可调用或配置已应用。
- `status --json` 可执行 exec SecretRef、插件，且认证不统一遵循环境优先；先核同实例目标、配置与凭据来源，不因“检查凭据”默认执行。
- `doctor --lint --json` 可创建临时状态、启动配置的 MCP、执行插件并访问网络，须说明影响并获相应授权。普通 Doctor、non-interactive 或 --fix 可写入/迁移；repair 仍使用应用已有链，不手动执行写入型 Doctor。

三平台路径、命令语法与同实例约束统一见[运行故障](runtime.md#原生-cli-诊断三平台)，不新增 MCP action。上游配置 writer 会保护 authored/include/env 与版本信息；脱敏快照或展开对象不能覆盖原文件。部分 dry-run 也可能解析 SecretRef；权限被拒不换入口绕过，不索取秘密或直接执行凭据程序。
