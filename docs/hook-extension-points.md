---
read_when:
  - 你要基于插件扩展 OpenClaw 行为
  - 你要确认 Hook 的完整插入点、可修改字段、执行顺序和异常语义
summary: OpenClaw 插件 Hook 完整插入点与使用说明（24 个 Hook）
title: Hook 插入点与使用
---

# Hook 插入点与使用

## 1. 适用范围

本文描述的是 **插件 Hook（`api.on(...)`）**，对应源码：

- `src/plugins/types.ts`（Hook 名称、event/context/result 类型）
- `src/plugins/hooks.ts`（执行模型、合并规则、优先级）
- `src/plugins/hook-runner-global.ts`（全局 runner 生命周期）

不包含老的内部 `HOOK.md` 事件脚本机制。

## 2. 执行模型（先看这个）

### 2.1 优先级与顺序

- 所有 Hook 按 `priority` **降序**执行（值越大优先级越高）。
- 修改型 Hook：串行执行并合并结果。
- 观察型 Hook：并行执行（`Promise.all`）。

### 2.2 错误语义

- 全局默认 `catchErrors=true`（见 `initializeGlobalHookRunner`）。
- Hook 抛错默认仅记录日志，不中断主流程。

### 2.3 同步 Hook（热路径）

以下两个 Hook 必须同步返回，返回 Promise 会被忽略并告警：

- `tool_result_persist`
- `before_message_write`

## 3. 完整插入点清单（24）

| Hook | 类型 | 主要触发位置 | 返回值 |
|---|---|---|---|
| `before_model_resolve` | 修改型（串行） | `src/agents/pi-embedded-runner/run.ts` | `{ modelOverride?, providerOverride? }` |
| `before_prompt_build` | 修改型（串行） | `src/agents/pi-embedded-runner/run/attempt.ts` | `{ systemPrompt?, prependContext?, prependSystemContext?, appendSystemContext? }` |
| `before_agent_start` | 修改型（串行，兼容层） | `run.ts` + `run/attempt.ts` | 兼容组合结果（同上 + model/provider override） |
| `llm_input` | 观察型（并行） | `run/attempt.ts` 发起模型调用前 | `void` |
| `llm_output` | 观察型（并行） | `run/attempt.ts` 模型返回后 | `void` |
| `agent_end` | 观察型（并行） | `run/attempt.ts` 收尾阶段 | `void` |
| `before_compaction` | 观察型（并行） | `compact.ts`、`run.ts` overflow 分支 | `void` |
| `after_compaction` | 观察型（并行） | `compact.ts`、`run.ts` overflow 分支 | `void` |
| `before_reset` | 观察型（并行） | `src/auto-reply/reply/commands-core.ts`（/new /reset） | `void` |
| `message_received` | 观察型（并行） | `src/auto-reply/reply/dispatch-from-config.ts` | `void` |
| `message_sending` | 修改型（串行） | `infra/outbound/deliver.ts`、`telegram/bot/delivery.replies.ts`、`channels/plugins/outbound/slack.ts` | `{ content?, cancel? }` |
| `message_sent` | 观察型（并行） | `infra/outbound/deliver.ts`、`telegram/bot/delivery.replies.ts` | `void` |
| `before_tool_call` | 修改型（串行） | `src/agents/pi-tools.before-tool-call.ts`（工具执行前） | `{ params?, block?, blockReason? }` |
| `after_tool_call` | 观察型（并行） | `src/agents/pi-embedded-subscribe.handlers.tools.ts` | `void` |
| `tool_result_persist` | 修改型（串行，同步） | `src/agents/session-tool-result-guard-wrapper.ts` | `{ message? }` |
| `before_message_write` | 修改型（串行，同步） | `src/agents/session-tool-result-guard-wrapper.ts` | `{ block?, message? }` |
| `session_start` | 观察型（并行） | `src/auto-reply/reply/session.ts` | `void` |
| `session_end` | 观察型（并行） | `src/auto-reply/reply/session.ts` | `void` |
| `subagent_spawning` | 修改型（串行） | `src/agents/subagent-spawn.ts`（线程绑定准备） | `{ status:"ok", threadBindingReady? }` 或 `{ status:"error", error }` |
| `subagent_delivery_target` | 修改型（串行） | `src/agents/subagent-announce.ts`（回传目标解析） | `{ origin? }` |
| `subagent_spawned` | 观察型（并行） | `src/agents/subagent-spawn.ts` | `void` |
| `subagent_ended` | 观察型（并行） | `subagent-spawn.ts`、`subagent-registry-completion.ts`、`gateway/session-reset-service.ts` | `void` |
| `gateway_start` | 观察型（并行） | `src/gateway/server.impl.ts` | `void` |
| `gateway_stop` | 观察型（并行） | `src/gateway/server.impl.ts`、`src/cli/program/message/helpers.ts` | `void` |

## 4. 修改结果合并规则（关键）

### 4.1 `before_model_resolve`

- `modelOverride`、`providerOverride`：**高优先级先到先得**（后续不覆盖）。

### 4.2 `before_prompt_build`

- `systemPrompt`：后执行的结果可覆盖前者。
- `prependContext`：按执行顺序拼接。
- `prependSystemContext`：按执行顺序拼接。
- `appendSystemContext`：按执行顺序拼接。

### 4.3 `message_sending`

- `content`：后执行可覆盖前者。
- `cancel`：后执行可覆盖前者。

### 4.4 `before_tool_call`

- `params` / `block` / `blockReason`：后执行可覆盖前者。

### 4.5 `subagent_spawning`

- 任一 Hook 返回 `status:"error"`，整体即错误。
- `threadBindingReady` 取 OR（任一 true 即 true）。

### 4.6 `subagent_delivery_target`

- 一旦已有 `origin`，后续不再覆盖（高优先级优先）。

### 4.7 `before_message_write`

- 任一 Hook 返回 `{ block: true }`，立即阻断写入。
- 若返回 `{ message }`，后续 Hook 看到的是修改后的 message。

### 4.8 `tool_result_persist`

- 同步串行改写 `message`，最终结果写入 transcript。

## 5. 最小可用示例

```ts
// plugins/my-hook-plugin/index.ts
module.exports = {
  id: "my-hook-plugin",
  name: "My Hook Plugin",
  register(api) {
    // 1) 工具前置拦截
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (event.toolName === "exec" && !ctx.sessionKey) {
          return { block: true, blockReason: "缺少 sessionKey，拒绝执行" };
        }
        return { params: { ...event.params, _fromHook: true } };
      },
      { priority: 100 },
    );

    // 2) 出站消息改写
    api.on("message_sending", async (event) => {
      return { content: `[hook] ${event.content}` };
    });

    // 3) 网关启动观察
    api.on("gateway_start", async (event) => {
      api.logger.info(`[my-hook-plugin] gateway started at :${event.port}`);
    });
  },
};
```

## 6. 使用建议（面向后续功能开发）

1. 需要“改写请求”的场景优先用修改型 Hook（`before_*`）。
2. 需要“审计/埋点”的场景优先用观察型 Hook（`*_end`、`message_*`、`llm_*`）。
3. 涉及 transcript 热路径时，优先使用同步 Hook：
   - `tool_result_persist`
   - `before_message_write`
4. 需要跨插件确定覆盖权时，明确设置 `priority`，并在插件文档写清优先级约定。

## 7. 调试清单

- 先确认插件是否加载（插件列表/启动日志）。
- 确认 `hasHooks(hookName)` 为 true（否则不会进入对应分支）。
- 修改型 Hook 看“结果是否被后续低优先级覆盖”。
- 同步 Hook 禁止 `async`，否则结果会被忽略。
- 若行为未生效，先查调用链是否触达对应触发点（见第 3 节文件位置）。
