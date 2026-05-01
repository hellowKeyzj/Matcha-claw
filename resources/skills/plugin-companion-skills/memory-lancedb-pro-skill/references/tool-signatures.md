# Tool Signatures

只用当前实现里的真实参数名。

## 核心记忆工具

`memory_store`

```json
{
  "text": "string",
  "importance": 0.7,
  "category": "preference|fact|decision|entity|reflection|other",
  "scope": "string?"
}
```

`memory_recall`

```json
{
  "query": "string",
  "limit": 3,
  "includeFullText": false,
  "maxCharsPerItem": 180,
  "scope": "string?",
  "category": "string?"
}
```

`memory_forget`

```json
{
  "memoryId": "string?",
  "query": "string?",
  "scope": "string?"
}
```

`memory_update`

```json
{
  "memoryId": "string",
  "text": "string?",
  "importance": 0.8,
  "category": "string?"
}
```

补充：

- `memory_store` 的参数名是 `text`，不是 `content`
- `memory_update` 改 `preference / entity` 文本时可能走 supersede 版本链

## 管理工具

`memory_stats`

```json
{ "scope": "string?" }
```

`memory_list`

```json
{
  "limit": 10,
  "offset": 0,
  "scope": "string?",
  "category": "string?"
}
```

`memory_debug`、`memory_promote`、`memory_archive`、`memory_compact`、`memory_explain_rank` 也存在，但是否对 agent 暴露取决于 `enableManagementTools`。

## self-improvement 工具

`self_improvement_log`

```json
{
  "type": "learning|error",
  "summary": "string",
  "details": "string?",
  "suggestedAction": "string?",
  "category": "string?",
  "area": "string?",
  "priority": "string?"
}
```

`self_improvement_extract_skill` 和 `self_improvement_review` 更偏治理，不是普通记忆问答主路径。
