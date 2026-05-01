# Runtime Defaults

## 宿主接入事实

启用 `memory-lancedb-pro` 后，MatchaClaw 当前会统一做这几件事：

1. `plugins.slots.memory = "memory-lancedb-pro"`
2. 补插件默认配置
3. 安装 companion skill 到 `~/.openclaw/skills/memory-lancedb-pro-skill`
4. `skills.entries["memory-lancedb-pro-skill"].enabled = true`

## 默认运行配置

缺省情况下，MatchaClaw 会补这些值：

```json
{
  "embedding": {
    "provider": "local-minilm",
    "model": "all-MiniLM-L6-v2"
  },
  "autoCapture": true,
  "autoRecall": true,
  "smartExtraction": true,
  "extractMinMessages": 5,
  "extractMaxChars": 8000,
  "sessionMemory": {
    "enabled": false
  }
}
```

## 配置快照

当前 MatchaClaw 默认会把插件落成接近下面这个状态：

```json
{
  "plugins": {
    "slots": {
      "memory": "memory-lancedb-pro"
    },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "local-minilm",
            "model": "all-MiniLM-L6-v2"
          },
          "autoCapture": true,
          "autoRecall": true,
          "smartExtraction": true,
          "extractMinMessages": 5,
          "extractMaxChars": 8000,
          "sessionMemory": {
            "enabled": false
          }
        }
      }
    }
  },
  "skills": {
    "entries": {
      "memory-lancedb-pro-skill": {
        "enabled": true
      }
    }
  }
}
```

## 关键路径

| Path | Purpose |
|------|---------|
| `~/.openclaw/openclaw.json` | OpenClaw 主配置 |
| `~/.openclaw/extensions/memory-lancedb-pro/` | 已安装插件目录 |
| `~/.openclaw/skills/memory-lancedb-pro-skill/` | companion skill 安装目录 |
| `~/.openclaw/memory/lancedb-pro/` | LanceDB 数据目录 |
| `~/.openclaw/workspace/MEMORY.md` | 文件记忆主文件，不是 LanceDB |
| `~/.openclaw/workspace/memory/` | daily memory 目录，不是 LanceDB |

## 判断口径

- 诊断时优先看最终运行配置，不要只看 README 或零散配置片段。
- CLI 可用，不等于 management tools 一定已暴露给 agent。
