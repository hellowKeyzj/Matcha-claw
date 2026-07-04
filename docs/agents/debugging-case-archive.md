# Debugging Case Archive

本文是 [debugging-playbook.md](./debugging-playbook.md) 的案例归档。它用于保存已经被 Diagnostic Pattern 覆盖、已经过期、或只在少数场景下有参考价值的定位案例。

默认定位类任务只需要读取 `docs/agents/debugging-playbook.md`。本文不是默认必读材料，只有在 playbook 明确指向、当前问题与某个归档案例高度相似，或需要追溯历史细节时才读取。

## 1. 使用规则

- `debugging-playbook.md` 保存默认定位原则、Diagnostic Patterns、少量 active Case Cards。
- 本文保存 `promoted` / `archived` Case Cards。
- 新案例不要直接写入本文；先进入 playbook，经过抽象或过期后再迁移到本文。
- 本文案例不应改变第一轮定位顺序；能改变第一轮定位顺序的内容必须回写到 playbook 的 Diagnostic Pattern。
- 本文不得保存聊天流水、完整命令输出或长篇事故报告。

## 2. 读取触发

只有满足至少一个条件时才读取本文：

1. `debugging-playbook.md` 的某个 pattern 或 active case 明确引用本文案例。
2. 当前问题与归档案例的 Source incident / Root cause boundary 高度相似，需要追溯细节。
3. 准备新增或合并 case，需要检查是否已有同类历史案例。
4. reviewer pass 要确认本次经验应进入 active playbook 还是 archive。

## 3. 归档状态

### promoted

案例已经抽象进 Diagnostic Pattern。本文只保留短卡片，用来说明 pattern 的来源和关键误判点。

### archived

案例已经过期、一次性太强，或不再适合作为默认定位依据。本文只保留可追溯摘要。

## 4. 迁移规则

从 `debugging-playbook.md` 迁移案例到本文时：

1. 保留 Case Card 固定字段。
2. 将 `Status` 改为 `promoted` 或 `archived`。
3. 压缩 `Wrong path taken`、`Correct first-round plan` 和 `Verification closure`，只保留未来仍有价值的信息。
4. 如果案例中的 Reusable rule 已进入 Diagnostic Pattern，写明对应 pattern id。
5. 删除所有一次性命令、日志片段、聊天上下文和与当前规则无关的实现细节。

如果迁移后发现某条信息仍会改变默认定位顺序，应先更新 `debugging-playbook.md` 的 Diagnostic Pattern，再归档案例。

## 5. 归档 Case Card 模板

```md
## Case: <short name>

### Status

promoted | archived

### Linked pattern

DP-xxx 或 `none`

### Source incident

### Symptom

### Surface path

### Real minimum loop

### Wrong path taken

### Missed first probe

### Root cause

### Root cause boundary

### Correct first-round plan

### Fix boundary

### Verification closure

### Reusable rule

### Applies to

### Does not apply to

### Archive note

为什么该案例进入 archive，而不是继续留在 playbook 主体。
```

## 6. 当前归档案例

## Case: OpenClaw MCP status timeout

### Status

promoted

### Linked pattern

DP-001 Integration status failure / unavailable result

### Source incident

Matcha system-runtime MCP 在当前会话连接器中显示等待/未知，`mcpServerStatus/list` 和 `/api/external-connectors/session-status` 超时。

### Symptom

外层看到 session connector status 请求超时，gateway RPC `mcpServerStatus/list` 超时，OpenClaw 报 MCP server connection timed out。

### Surface path

Renderer status component → external connector store → Electron host API → runtime-host route → downstream status provider → OpenClaw gateway RPC。

### Real minimum loop

OpenClaw MCP runtime 通过 stdio JSON-RPC 调用 Matcha `system-runtime mcp-stdio`，完成 `initialize` 和 `tools/list`，拿到 TeamRun command tools。

### Wrong path taken

先沿 UI/status/gateway RPC 表象逐层排查，并过早处理 timeout、cached catalog、stale runtime/config 等外围问题。

### Missed first probe

没有第一时间用 OpenClaw `createSessionMcpRuntime(...).getCatalog()` 直接验证真实 MCP runtime 闭环；手写 probe 只测了 Content-Length，没有模拟 OpenClaw SDK 的 newline-delimited JSON-RPC framing。

### Root cause

OpenClaw 使用的 MCP SDK stdio transport 发送 newline-delimited JSON-RPC；Matcha MCP server 当时只支持 Content-Length framing。

### Root cause boundary

runtime-host R4 MCP stdio protocol boundary。

### Correct first-round plan

1. 直接跑 OpenClaw runtime `getCatalog()`。
2. 用同一 command/env 拉起 `system-runtime mcp-stdio`。
3. 分别 probe Content-Length 和 newline-delimited JSON-RPC framing。
4. 读取 OpenClaw MCP SDK stdio serialize 实现。
5. 只修 MCP stdio parser/response framing。

### Fix boundary

修 `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts`；不要修 Renderer、generic route、TeamRun core 或 OpenClaw business projection。

### Verification closure

OpenClaw runtime `getCatalog()` 返回 `team_node_event` 和 `team_graph_patch`；system-runtime MCP framing 单测同时覆盖 Content-Length 和 newline-delimited JSON-RPC。

### Reusable rule

集成类状态失败先验证真实协议闭环；手写 probe 必须模拟真实调用方 SDK，而不是只测我方已知 happy path。

### Applies to

MCP、stdio JSON-RPC、gateway runtime、子进程工具服务、provider SDK transport、跨进程协议适配。

### Does not apply to

纯 UI 展示错误、纯 DTO 文案映射错误、已经由单元测试直接复现的业务纯函数错误。

### Archive note

该案例已经被 DP-001 覆盖。默认定位顺序应由 DP-001 承载，完整案例只作为追溯材料保留。
