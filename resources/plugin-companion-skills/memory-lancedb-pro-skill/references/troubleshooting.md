# Troubleshooting

## 缺失召回

按这个顺序排：

1. 数据是否真的进了 LanceDB
2. scope 是否可访问
3. `autoRecall` 是否开启
4. recall query 是否足够具体
5. 是否被治理过滤

## 缺失捕捉

按这个顺序排：

1. `autoCapture` 是否开启
2. `extractMinMessages` 是否满足
3. `smartExtraction` 是否拿到可用 LLM 来源
4. smart extraction 失败后，regex fallback 是否仍无结果

## 常见误判

| Symptom | Real Cause | What To Check |
|---------|------------|---------------|
| `memory_recall` 查不到 | 记忆可能没进 LanceDB，也可能进了文件链路 | 先跑 `openclaw memory-pro list --limit 10 --json` |
| smart extraction 初始化失败 | 没有可用 LLM 来源 | 查 `llm.*`、`embedding.apiKey`、OpenClaw 默认模型来源 |
| 以为 local MiniLM 覆盖了全部模型 | 实际只覆盖 embedding | 不要把 embedding 和 smart extraction LLM 混为一谈 |
| 聊天里看不到自动回忆 | `autoRecall` 没开、query 太弱、scope 不可见、结果被过滤 | 按 recall 排障顺序查 |
| 插件启用了但 agent 没法用 `memory_list` | management tools 默认未必暴露 | 区分 CLI 可用和 tool 暴露 |
| 看到 `MEMORY.md` 有内容就以为插件写入成功 | 可能只是文件链路写入 | 要用 `memory-pro` CLI 或 `memory_recall` 验证 LanceDB |
