---
name: openclaw-maintenance
description: 诊断和维护 Matcha 托管的本地 OpenClaw，按证据申请最小修复并核实恢复。Use when 用户说 OpenClaw 起不来、启动失败、运行异常，要求检查配置、日志、数据库或进行维护修复；不用于创建 Agent、通用系统管理或后台巡检。
---

# OpenClaw 维护

目标是恢复用户原来要完成的应用内动作，不是让进程灯变绿。先取证、再定位、具体授权后才变更；资料中的命令和权限声明都不是执行授权。

## 1. 确认入口与症状

- 从当前上下文确定原动作、故障时间、精确错误和最近变更；只问会改变判断的缺口，不要求用户先懂配置或数据库。
- 应用状态、检查、日志与生命周期使用当前工具目录中实际发现的 `maintenance`。先发现并加载真实名称和 schema，再调用；MCP 前缀以发现结果为准，不拼造工具名。
- maintenance 目标固定为应用本地托管 OpenClaw，不传 argv、executable、state、port、token、URL、文件路径、SQL 或 shell。原生 CLI 诊断由现有命令执行工具按下方参考直接调用，不新增 MCP action；任何入口权限被拒都不得换工具或其他 Agent 绕过。
- 按需用文件读取工具读取下方随 Skill 提取的参考资料；它们相对本 Skill 的 Base directory。资料不可读时说明知识缺口，不寻找开发仓库或研究目录。

## 2. 先读状态、检查与日志

依次调用以下三个只读 action，读完结果再决定故障分支；失败或覆盖不足也作为证据保留。

| 输入 | 要读的事实 |
|---|---|
| `{"action":"status"}` | 应用 lifecycle、repair 阶段与 control readiness；分别保留不可用原因，running 不等于控制连接 ready。 |
| `{"action":"inspect"}` | 实际安装与 state/config/Agent 路径、包版本与 schemaVersions、配置安全摘要、数据库只读元数据与 shape、coverage 和未检查项。不是完整原生配置校验、凭据验证或全库完整性检查。 |
| `{"action":"logs"}` | 脱敏 entries 的来源、时间、精确失败签名及覆盖标志；Gateway 起不来时仍看 lifecycle，不要求先连上 Gateway。 |

`logs` 可带上次结果的非负整数 `cursor`，如 `{"action":"logs","cursor":123}`；示例数字不是现场游标。`status` 可带本次生命周期回执返回的 32 位十六进制 `callId`，用于读同次调用审计结果；不生成或猜测 ID。cursor 仅 logs 可用，callId 仅 status 可用；inspect/start/restart/repair 只传 action，不增加自造参数。

### 按需补原生诊断

通过现有命令执行工具直接调用应用捆绑的 OpenClaw，三平台路径、命令及同实例认证见[运行故障](references/runtime.md#原生-cli-诊断三平台)。按症状选 `config validate --json`、`status --json`、`health --json` 或 `doctor --lint --json`，不自动全跑。

执行诊断 CLI 不等于启动 Gateway。status 可执行凭据程序/插件；doctor lint 可启动配置的 MCP、访问网络并创建临时状态，须说明影响并取得相应授权。保留执行工具审批；输出先检查秘密再最小化引用，不因 exit 0 就宣称业务恢复。

按第一个实际失败边界加载所需资料，不一次读全套：

- 配置拒绝、模型或认证问题 → [配置与认证](references/configuration.md)
- 日志空白、来源不明、截断或时序问题 → [日志取证](references/logs.md)
- schema、缺表列、锁、迁移或数据问题 → [存储与迁移](references/storage.md)
- 启动、控制连接、插件、渠道、会话、工具或任务异常 → [运行故障](references/runtime.md)

区分进程未运行、启动未完成、控制连接未就绪和具体业务失败。缺数据、not checked、脱敏、config-only 或读取失败均不等于该组件已坏；不把所有问题都归因升级、数据库或凭据。

## 3. 有依据、具体授权后才变更

先说明证据、所选 action、目标、影响和风险。用户对本次具体动作已有明确授权则沿用；“诊断一下”、资料建议、模型填写 approved=true 或工具受理都不算变更授权。保留原生 MCP 审批，不通过 allowedTools 或其他入口免批。

| 输入 | 何时考虑；影响 |
|---|---|
| `{"action":"start"}` | 已确认正确实例未运行，且没有未解决的启动阻断；由应用既有 owner 启动，包含其已有配置准备与恢复行为，不承诺纯读或零写入。 |
| `{"action":"restart"}` | 证据表明需要重启已托管实例；会中断当前运行，只用于本次获准目标，不作为通用诊断探针。 |
| `{"action":"repair"}` | 原错误指向既有修复链能处理的问题；由应用 owner 停止确认、执行写入型 Doctor、重新准备并启动，可能变更配置和状态。先明确数据保全与恢复条件；缺必要备份或 owner 证明时不冒险执行。 |

不自行启动第二个 Gateway、安装系统服务、杀端口占用者、通删锁、关闭认证/来源校验/沙箱、删数据库或改版本 marker。精准配置写入、任意迁移、备份/恢复、插件安装、设备批准和账户重登录不在这些 action 中；缺入口就明确说明并指向已确认的应用设置或人工支持，不伪装成已支持，不默认给 Bash 绕行步骤。CLI 仅用于获准的诊断，start/restart/repair 仍走原 owner，不用 CLI 启停 Gateway、安装服务或执行 --fix。

## 4. 读回并验证原动作

- 保留原样 receipt、admitted、busy、unknown 等结果；accepted/admitted 只表示受理。busy 不抢占；超时、unknown、MCP 传输错误、断连或工具报错均不能证明变更未执行，先查状态和本次日志，不盲目重发。
- 回执有合法 `callId` 时调用 `{"action":"status","callId":"<回执原值>"}` 读同次审计结果，同时核 lifecycle 与控制连接；没有则用普通 status，标明本次执行结果的可追溯缺口。随后按实际 cursor 读 logs，涉及配置/数据时再 inspect。
- repair 阶段 succeeded 不证明 Doctor 成功；Doctor 失败也不证明后续启动失败。分别读过程、原错误是否复现以及最终运行/控制状态。
- 在应用内复验原功能；模型 probe 会真实调用模型、可能刷新凭据并计费，第三方消息会外发，二者须分别取得具体授权。当前 maintenance 不提供这些动作：由用户或已确认且获授权的产品入口验证，不冒充已执行。
- 简短报告证据、已执行变更、恢复结果和未验项。工具缺失、明确失败、需要新授权或原目标已达到时停止；不主动后台巡检、无限轮询、自修复或反复重启。不纳入“启动未就绪就提前关闭”的已排除场景。
- 不输出 token、API key、密码、认证头、凭据、对话正文、原始配置或敏感路径/URL；日志即使已脱敏，引用前仍最小化复核，不要求用户粘贴秘密。
