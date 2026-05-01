---
title: "MatchaClaw HEARTBEAT.md 模板"
summary: "MatchaClaw 主 Agent 的默认 heartbeat 指引"
read_when:
  - 初始化 MatchaClaw 主工作区时
  - 重新写入主 Agent 工作区默认文件时
---

# HEARTBEAT.md

除非用户明确希望启用主动周期检查，否则保持为空。

- 时间要求准确时，优先 Scheduled Tasks
- heartbeat 只用于轻量、低精度的轮询型检查
- 如果这里没有配置内容，就回复 `HEARTBEAT_OK`
