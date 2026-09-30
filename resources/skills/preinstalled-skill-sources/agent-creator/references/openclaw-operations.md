# 注册与配置操作

## 1. 准备参数

准备已确认的英文 ID、显示名称、简介和工作区绝对路径。工作区为 `<当前 OpenClaw 状态目录>/workspace-subagents/<id>/`；相对路径按进程工作目录解析，不能直接传入。

状态目录使用当前实例已知信息，无法确定时说明缺口；`openclaw config file --json` 仅返回配置文件路径，不单独作为状态目录依据。文件工具检查目标已有内容，覆盖前确认。

需要读取目标配置时，使用对应当前实例且已获授权的本机 CLI：

```bash
openclaw config get agents.entries.researcher --json
```

将 `researcher` 替换为本次 ID。查询失败不等于目标不存在；没有 CLI 读取能力时保留未确认项，**不单独委托 `openclaw` 核实或补查配置**。

## 2. 普通会话创建

普通 `openclaw` 工具接受 `message`、可选 `sessionId`。以下示例替换本次值，创建后的操作使用返回的真实 ID；没有真实会话 ID 时省略 `sessionId`。

### 注册永久身份

```json
{"message":"创建永久 Agent researcher，工作区使用 <工作区绝对路径>，继承全局默认模型，不传 model。返回最终创建结果、真实 agentId 和工作区绝对路径，不追加配置核实。"}
```

### 保存显示名称与简介

注册后直接使用对应当前实例且已获授权的 CLI，替换创建返回的真实 ID：

```bash
openclaw agents set-identity --agent researcher --name "研究助手" --json
openclaw config set agents.entries.researcher.description "核实资料来源并交付带证据的研究结论，适合文献梳理与事实核验。"
```

**不再委托 `openclaw` 设置名称或简介，不先尝试专家通道再回退 CLI。**缺少 CLI 授权时报告配置未完成，继续独立且获授权的文件步骤。

## 3. 已具备本机 CLI 时

CLI 对应当前实例且 exec 获授权时，可以直接执行以下完整操作，不再委托专家重复创建：

```bash
openclaw agents add researcher --workspace "<工作区绝对路径>" --non-interactive --json
openclaw agents set-identity --agent researcher --name "研究助手" --json
openclaw config set agents.entries.researcher.description "核实资料来源并交付带证据的研究结论，适合文献梳理与事实核验。"
```

逐步执行，使用实际返回 ID，并按当前 shell 引用参数。创建以英文 ID 作为位置参数，省略模型、认证复制和渠道绑定。`set-identity` 保存展示名称，角色文件另由文件工具写入。

## 4. 处理结果

- 明确成功：保存结果，继续剩余配置和文件写入，**不追加配置核实调用或查询命令**。
- ID 已存在：请用户决定复用或另建。
- 只有进度信息、超时或结果不明：按需用 CLI `config get` 确认缺失事实；无法读取时报告未确认，不重复创建。
- 权限拒绝：停止相关操作，不切换工具或命令绕过。
- 专家通道推理运行错误：不重试专家调用，不主动查询、测试或修复模型、推理路由、provider、认证或插件运行时。使用已有授权的本机 CLI 完成剩余配置；没有 CLI 时报告配置未完成，继续获授权的文件步骤。
- 其他失败：保留成功项，继续独立且获授权的步骤，报告具体缺口。

角色文件仍逐份读回。写入成功不代表已完成试运行；CLI 返回重启提示时报告提示，不自行重启 Gateway。创建任务不执行 onboarding、认证修复或全局模型修改。

## 5. 用户要求试运行时

使用获授权的目标会话入口，或：

```bash
openclaw agent --agent <真实 ID> --message "<已确认的试运行任务>" --json
```

不添加发送或发布参数。
