# HEARTBEAT.md

除非用户明确希望启用主动周期检查，否则保持为空。

- 时间要求准确时，优先 Scheduled Tasks
- heartbeat 只用于轻量、低精度的轮询型检查
- 如果这里没有配置内容，就回复 `HEARTBEAT_OK`
