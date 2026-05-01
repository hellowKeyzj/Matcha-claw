---
name: memory-lancedb-pro
description: "MatchaClaw 中 memory-lancedb-pro 的使用、验证、调优与排障 skill。用于： (1) 验证插件是否真正启用并接管 memory slot，(2) 检查 LanceDB 记忆写入、召回、autoCapture、autoRecall 是否正常，(3) 诊断 smart extraction、local-minilm、OpenClaw 默认模型继承、management tools 暴露等问题，(4) 处理用户的长期偏好、事实、决定和跨会话上下文，(5) 给出当前实现下可执行的验证、配置确认、维护与故障定位步骤。"
---

# memory-lancedb-pro

## 概述

这个 skill 只服务于 MatchaClaw 当前集成形态下的 `memory-lancedb-pro`。

它处理的是一条基于 LanceDB 的长期记忆链路，重点是：

- 长期偏好、稳定事实、已确认决定、跨会话上下文
- `memory_store` / `memory_recall` / `openclaw memory-pro ...` 这套入口
- `autoCapture` / `autoRecall` / `smartExtraction` 是否真正生效
- 插件是否被宿主正确接管并成为默认 memory backend

**核心特性**：
- **宿主接管**：插件启用后由 MatchaClaw 把它接到 `plugins.slots.memory`
- **默认本地嵌入**：默认走 `local-minilm` + `all-MiniLM-L6-v2`
- **自动捕捉与自动召回**：默认启用 `autoCapture`、`autoRecall`
- **惰性智能提取**：`smartExtraction` 按当前可用 LLM 来源初始化
- **可验证**：既可走聊天行为验证，也可走 `openclaw memory-pro` CLI 验证

---

## 快速入口

| 用户意图 | 先做什么 |
|---------|---------|
| “帮我记住这个” | 先判断是不是长期记忆；是的话优先走 `memory_store` |
| “你刚才怎么没记住” | 先分辨是没写入，还是写入了但没召回 |
| “这个插件到底有没有生效” | 先跑 `openclaw memory-pro stats` 和 `list` |
| “为什么聊天里没用上之前记忆” | 先查 `autoRecall`、query 具体度、scope 可见性 |
| “smart extraction 为什么报错” | 先查 LLM 来源解析，再看 fallback 是否接管 |
| “现在默认配置应该是什么” | 再去看 runtime defaults，不要先猜配置 |

---

## 快速验证

### 最小验证

先跑这两条：

```bash
openclaw memory-pro stats
openclaw memory-pro list --limit 10 --json
```

预期：

- `stats` 能正常返回库统计
- `list` 能正常返回现有记忆，哪怕是空数组也算链路已通

如果这两步不通，不要先分析 prompt，先查插件启用、slot 接管、数据目录和 management tools。

### 聊天侧验证

适合验证“这条链路在真实对话里是不是活的”。

```text
用户: 记住：我希望你默认用中文回复。
   |
   v
1. 判断为长期偏好
2. 优先直接写入 memory_store
3. 再发一个依赖该偏好的后续请求
4. 观察后续回复是否稳定延续这个偏好
```

---

## 一级判断规则

### 先判断是不是长期记忆

优先按长期记忆处理：

- 用户稳定偏好
- 长期有效规则
- 已确认决定
- 跨会话仍成立的背景事实
- 缺了就会反复追问、反复犯错的信息

不优先按长期记忆处理：

- 一次性步骤
- 临时上下文
- 只对当前这一轮有效的细节
- 过程性命令、路径、工作目录、执行提示

### 再判断走哪条写入路径

| 场景 | 默认路径 |
|-----|---------|
| 用户明确要求“记住这个” | `memory_store` |
| 偏好 / 事实 / 决定在自然对话里出现 | `autoCapture + smartExtraction` |
| 经验教训、错误复盘、行为改进 | `self_improvement_log` |

---

## 工具与入口

### 核心入口

| 入口 | 用途 |
|-----|------|
| `memory_store` | 手动写入长期记忆 |
| `memory_recall` | 召回相关长期记忆 |
| `openclaw memory-pro stats` | 看记忆库状态 |
| `openclaw memory-pro list --limit 10 --json` | 看最近记忆是否真的入库 |

### 管理入口

| 入口 | 用途 | 注意 |
|-----|------|------|
| `memory_list` | 列出记忆 | 依赖 management tools 暴露 |
| `memory_stats` | 查看统计 | 依赖 management tools 暴露 |
| `memory_update` | 更新记忆 | 先确认目标 ID |
| `memory_forget` | 删除记忆 | 只删确认无误的条目 |

---

## 铁律

1. **先判断，再写入**：不是所有“看起来重要”的话都该进长期记忆。
2. **先查后存**：写入前先 `memory_recall`，避免重复和脏记忆。
3. **验证优先**：怀疑插件失效时，先跑 `stats` 和 `list`，不要先猜。
4. **先分段定位**：问题先分为写入、提取、召回、工具暴露、宿主接管五段。
5. **修完要复验**：修复后必须按同一条用户路径再走一遍。
6. **不要把聊天表象当根因**：回复没体现记忆，不等于一定没入库。

---

## 故障排除

| 问题 | 优先判断 |
|-----|---------|
| `memory_recall` 查不到 | 是没进库，还是 query 太泛 |
| 聊天里没体现旧记忆 | 是没召回，还是召回了但没被回答使用 |
| smart extraction 初始化失败 | 是 LLM 来源不可用，还是 fallback 没接住 |
| 插件启用了但工具不可见 | 是 management tools 没暴露，不一定是插件没生效 |
| CLI 正常但聊天不生效 | 重点查 autoCapture / autoRecall 链路 |

---

## 深度参考

| Reference | Coverage |
|-----------|----------|
| [references/runtime-defaults.md](references/runtime-defaults.md) | 宿主接管、默认配置、关键路径 |
| [references/tool-signatures.md](references/tool-signatures.md) | 工具签名、参数和管理工具暴露 |
| [references/verification-playbooks.md](references/verification-playbooks.md) | 最小验证、端到端验证、自动捕捉 / 自动召回验证 |
| [references/troubleshooting.md](references/troubleshooting.md) | 缺失召回、缺失捕捉、常见误判 |
| [references/smart-extraction-llm.md](references/smart-extraction-llm.md) | smart extraction 的 LLM 来源解析规则 |

---

## Reference Loading Rule

不要一次加载全部 reference。

- 先按当前问题类型只读最相关的一份
- 需要第二层细节时再补读第二份
- 顶层 `SKILL.md` 负责一级判断
- 具体配置、验证步骤、排障细节放到 references
