---
name: memory-lancedb-pro
description: "MatchaClaw 中 memory-lancedb-pro 的使用、验证、调优与排障 skill。用于： (1) 验证插件是否真正启用并接管 memory slot，(2) 检查 LanceDB 记忆写入、召回、autoCapture、autoRecall 是否正常，(3) 诊断 smart extraction、local-minilm、OpenClaw 默认模型继承、management tools 暴露等问题，(4) 区分 LanceDB 记忆与 MEMORY.md / daily memory 文件链路，(5) 给出当前实现下可执行的配置、验证、维护与故障定位步骤。"
---

# memory-lancedb-pro

## Overview

这个 skill 用来处理 **MatchaClaw 当前集成形态** 下 `memory-lancedb-pro` 的日常使用、验证、调优和排障。

它只覆盖这一条长期记忆链路：

| Area | Role | Notes |
|------|------|-------|
| `memory-lancedb-pro` | LanceDB 长期记忆插件 | 负责记忆写入、召回、autoCapture、autoRecall |
| `memory_store` / `memory_recall` / `openclaw memory-pro ...` | 主要操作入口 | 都指向 LanceDB 记忆链路 |
| `MEMORY.md` / `memory/YYYY-MM-DD.md` | 文件记忆链路 | 不是 LanceDB，不是 `memory_recall` 数据源 |

### Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ MatchaClaw Runtime Host                                    │
│                                                             │
│  Plugin enable lifecycle                                    │
│  ├─ plugins.slots.memory = memory-lancedb-pro              │
│  ├─ inject default config                                  │
│  └─ auto-install + auto-enable companion skill             │
│                                                             │
│  memory-lancedb-pro                                         │
│  ├─ embedding: local-minilm or configured provider         │
│  ├─ storage: LanceDB                                       │
│  ├─ autoRecall hook: before_prompt_build                   │
│  ├─ autoCapture hook: agent_end                            │
│  ├─ smartExtraction: LLM-backed extraction                 │
│  └─ tools / CLI: memory_store, memory_recall, stats...     │
└─────────────────────────────────────────────────────────────┘
```

## Reference Files

| Reference | Coverage |
|-----------|----------|
| [references/runtime-defaults.md](references/runtime-defaults.md) | 宿主接管、默认配置、关键路径 |
| [references/tool-signatures.md](references/tool-signatures.md) | 真实工具签名和参数注意事项 |
| [references/verification-playbooks.md](references/verification-playbooks.md) | 最小验证、端到端验证、自动捕捉/自动回忆验证 |
| [references/troubleshooting.md](references/troubleshooting.md) | 缺失召回、缺失捕捉、常见误判 |
| [references/smart-extraction-llm.md](references/smart-extraction-llm.md) | smart extraction 的 LLM 来源解析规则 |

## Key Paths

| Path | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | OpenClaw 主配置 |
| `~/.openclaw/extensions/memory-lancedb-pro/` | 已安装插件目录 |
| `~/.openclaw/skills/memory-lancedb-pro-skill/` | companion skill 安装目录 |
| `~/.openclaw/memory/lancedb-pro/` | LanceDB 数据目录 |
| `~/.openclaw/workspace/MEMORY.md` | 文件记忆主文件，不是 LanceDB |
| `~/.openclaw/workspace/memory/` | daily memory 目录，不是 LanceDB |

## Daily Workflow

### 1. Identify The Memory Path

先判断当前信息是否属于“长期记忆”，不要按术语词面判断。

优先当作长期记忆处理：

- 用户稳定偏好
- 已确认决定
- 长期有效规则
- 跨会话仍应成立的背景事实
- 缺少历史上下文会明显影响当前任务质量的信息

不优先当作长期记忆处理：

- 一次性步骤
- 临时细节
- 只对当前这一轮有效的信息
- 执行过程里的路径、命令、工作目录、流程提示

判断原则：

- 看这件事是否应该跨轮次、跨会话继续成立
- 看不记住它以后，后续是否大概率重复犯错、重复追问或丢失连续性
- 不要靠“记忆 / 回忆 / 存储”这类词来判断

### 2. Verify Runtime Health

先跑这两个检查：

```bash
openclaw memory-pro stats
openclaw memory-pro list --limit 10 --json
```

如果这两步不通，不要先分析 prompt，先查插件状态、slot 接管和数据目录。

### 3. Confirm Host Ownership

需要确认宿主是否真的接管了这条 memory slot 时，核对：

- `plugins.slots.memory === "memory-lancedb-pro"`
- `plugins.entries["memory-lancedb-pro"].enabled === true`
- `skills.entries["memory-lancedb-pro-skill"].enabled === true`

### 4. Route The Memory

确定属于长期记忆后，再判断走哪条链路。

走 `memory-lancedb-pro`：

- 需要运行时自动记忆
- 需要后续自动召回
- 需要跨会话检索和继续使用
- 属于偏好、事实、决定、实体这类可被持续查询的信息

走长期稳定沉淀链路：

- 血泪教训
- 错误示范 / 反模式
- 长期稳定规则
- 长期偏好（可选）
- 已验证、可复发、高代价、长期有效，不写以后大概率还会再犯的问题

不要放进长期稳定沉淀链路：

- 执行手册
- 路径说明
- 模板 / contract
- 工作目录
- 流程步骤

### 5. Choose The Execution Path

- 用户想知道“插件有没有真的工作”：
  先做验证
- 用户说“为什么没记住 / 没召回 / 没生效”：
  先判定是哪一段链路失效，再做排障
- 用户想知道“配置现在应该是什么”：
  再去看 runtime defaults
- 用户想知道“具体工具怎么调”：
  再去看 tool signatures

### 6. Escalate By Failure Type

- 自动记忆没入库：
  去看 `references/verification-playbooks.md` 和 `references/troubleshooting.md`
- 已有记忆但聊天没用上：
  去看 `references/verification-playbooks.md` 和 `references/troubleshooting.md`
- smart extraction 报错：
  去看 `references/smart-extraction-llm.md`
- agent 叫不出某个工具：
  先区分是 CLI 问题还是 management tools 暴露问题，再看 `references/tool-signatures.md`

## Common Issues

| Symptom | Cause | Where To Look |
|---------|-------|---------------|
| `memory_recall` 查不到 | 可能没进 LanceDB，也可能进了文件链路 | `references/troubleshooting.md` |
| smart extraction 初始化失败 | 没有可用 LLM 来源 | `references/smart-extraction-llm.md` |
| 聊天里看不到自动回忆 | `autoRecall` 没开、query 太弱、scope 不可见、结果被过滤 | `references/troubleshooting.md` |
| 插件启用了但 agent 没法用 `memory_list` | management tools 默认未必暴露 | `references/tool-signatures.md` |
| 看到 `MEMORY.md` 有内容就以为插件写入成功 | 可能只是文件链路写入 | `references/troubleshooting.md` |

## Reference Loading Rule

不要一次加载全部 reference。  
先按当前问题类型，只读最相关的那一份或两份。
