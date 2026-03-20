# Security Core v2 重构验收清单（功能不回退）

## 1. 验收目标

- 本次重构只允许“内部结构升级”，不允许“对外行为缩水”。
- 对外契约以 `security-core` 现状为准：HTTP 路由、Gateway 方法、5 个 Hook、策略模型、审计行为。
- 任一关键项不通过，禁止进入下一阶段迁移。

## 2. 对外契约冻结（必须保持）

### 2.1 Gateway 方法

必须继续可用：

- `security.policy.sync`
- `security.audit.query`
- `security.audit.latest`
- `security.monitor.status`
- `security.quick_audit.run`
- `security.emergency.run`
- `security.integrity.check`
- `security.integrity.rebaseline`
- `security.skills.scan`
- `security.advisories.check`
- `security.remediation.preview`
- `security.remediation.apply`
- `security.remediation.rollback`

### 2.2 Hook 链路

必须继续注册并执行：

- `before_agent_start`
- `before_tool_call`
- `tool_result_persist`
- `message_received`
- `after_tool_call`

## 3. 关键行为验收项

### 3.1 运行时拦截

- destructive 命中时按 `severity -> action` 生效（`block/confirm/warn/log`）。
- secrets 命中时按 `severity -> action` 生效（含 `redact`）。
- `confirm` 通过 `_clawguardian_confirm` 确认后放行，且清理确认标记。
- exec-style 工具命中 `confirm` 时注入 `ask: "always"`。
- allowlist tool/session 命中时绕过阻断逻辑。

### 3.2 输出扫描与分流

- `tool_result_persist` 命中 secret/pii 时，严格按 action 分流。
- `confirm` 在 `tool_result_persist` 中必须降级为 `block`（同步 hook 不支持交互）。
- `block` 时替换输出为阻断文本；`redact` 时返回脱敏文本。

### 3.3 审计与可观测性

- 命中事件写入审计队列，`security.audit.query` 可分页查询。
- `security.monitor.status` 返回 hook 延迟统计，包含 `count/p50/p95/last/max`。
- 启动期审计可通过 `security.audit.latest` 查询到最新报告。

### 3.4 安全动作中心

- 一键体检、应急、完整性检查/重建、技能扫描、通告检查、修复预览/应用/回滚必须保持可调用。

## 4. 现有测试覆盖映射

已覆盖（当前存在）：

- 网关方法注册与 5 hooks 注册：
  - `tests/unit/security-core-plugin.test.ts`
- `policy.sync` / `audit.query` / `audit.latest`：
  - `tests/unit/security-core-plugin.test.ts`
- `before_tool_call` 关键动作（block/confirm/redact/warn）：
  - `tests/unit/security-core-plugin.test.ts`
- `tool_result_persist` 关键动作（block/redact/confirm降级）：
  - `tests/unit/security-core-plugin.test.ts`
- hook latency（p50/p95）：
  - `tests/unit/security-core-plugin.test.ts`
- destructive 跨平台检测：
  - `tests/unit/security-destructive-detector.test.ts`
- HTTP 路由到 Gateway RPC 代理：
  - `tests/unit/security-routes.test.ts`

当前缺口（重构前补齐）：

- `message_received` 的命中审计行为（当前主要测“已注册”，缺行为断言）。
- `after_tool_call` 的成功/失败审计行为（当前主要测“已注册”，缺行为断言）。
- `security.skills.scan` / `security.advisories.check` / `security.remediation.preview|rollback` 的返回语义断言。
- `allowlist` 绕过分支专门测试。
- `extraSecretPatterns/extraDestructivePatterns` 缓存与命中行为测试。

## 5. 重构阶段门禁

### 阶段 A：测试护栏

- 补齐第 4 节“当前缺口”测试。
- 通过后冻结基线测试结果。

### 阶段 B：模块重组

- 完成目录与模块边界迁移（core/application/adapters）。
- 不改对外契约，不改 API 名称。

### 阶段 C：行为对比

- 全量运行安全相关单测，必须 100% 通过。
- 对关键路径做快照对比（blockReason、audit decision、redact 结果）。

### 阶段 D：收尾

- 清理废弃路径与重复代码。
- 更新 `CHANGE.md` 与模块边界文档。

## 6. 一票否决项

- 任一 `security.*` 方法缺失或返回结构变化（未同步前端）。
- 任一 Hook 未触发或安全分流行为变化。
- `tool_result_persist` 从“降级 block”回退到“静默放行”。
- 审计链断裂（query/latest/status 不可用）。
