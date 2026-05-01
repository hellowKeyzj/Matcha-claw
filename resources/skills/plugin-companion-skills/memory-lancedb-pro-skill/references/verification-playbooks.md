# Verification Playbooks

## 最小验证

先跑这两个：

```bash
openclaw memory-pro stats
openclaw memory-pro list --limit 10 --json
```

目标：

- CLI 正常
- 数据库可读
- 能看到统计或列表结果

如果这两步都不通，不要先分析 prompt，先查插件状态和数据目录。

## Plugin Ownership

需要确认宿主是否真的接管了这条 memory slot 时，核对：

- `plugins.slots.memory === "memory-lancedb-pro"`
- `plugins.entries["memory-lancedb-pro"].enabled === true`
- `skills.entries["memory-lancedb-pro-skill"].enabled === true`

## End-to-End

按这个顺序验证：

1. `openclaw memory-pro stats`
2. `openclaw memory-pro list --limit 10 --json`
3. 手动写入一条明确偏好或事实
4. 手动召回同一条
5. 再测自动捕捉
6. 再测自动回忆

## Manual Write / Manual Recall

适合验证“底层库是不是通的”。

做法：

1. 用 `memory_store` 写入一句非常具体的话
2. 立即用关键词执行 `memory_recall`
3. 预期能查到同一条

如果查不到，优先排：

1. 记忆是否真的写入 LanceDB
2. scope 是否限制了访问
3. 查询词是否过短或太泛

## Auto-Capture Verification

适合验证“聊天结束后是否自动提取并入库”。

做法：

1. 在聊天里明确说一个偏好、规则或事实
2. 完成一轮对话
3. 用 `openclaw memory-pro list --limit 10 --json` 或 `memory_recall` 检查是否入库

没入库时重点看：

- `autoCapture`
- `extractMinMessages`
- `smartExtraction`
- LLM 来源

## Auto-Recall Verification

适合验证“已有记忆是否会自动注入 prompt”。

做法：

1. 先保证库里已有相关记忆
2. 发一个足够具体、明显依赖旧记忆的问题
3. 看回复是否明显用了旧记忆

没触发时重点看：

- 数据是否真的进了 LanceDB
- `autoRecall`
- recall query 是否足够具体
- scope 是否可访问
- 记忆是否被治理过滤
