# 旧 E2E 迁移与历史清单

更新日期：2026-10-25。面向 E2E 维护者的历史清单。用户已要求按当前页面重新实现；本文件与历史总账只保留旧业务要求及当时证据，不代表当前源码或新一轮验收。

## 范围与结论

用户已授权全部 **27 份旧 spec / 38 个旧 case** 迁移。既有核心 3 spec / 5 case 保留原迁入目标，其余 **24 spec / 33 case** 的 20 slice 已交付源码适配及 migrate/merge/retire 判定；忽略状态不表示过时，也不证明可以删除。

既有核心 `app-smoke.spec.ts` 承接到 `e2e/src/scenarios/licensed/chat.spec.ts`；`chat/chat.spec.ts` 承接到同目录的 `chat.spec.ts` 与 `session-capabilities.spec.ts`；`settings-proxy.spec.ts` 承接到同目录的 `settings-proxy.spec.ts`；逐 case 对应、真实标题/行号、源码和目标 SHA-256 及报告证据见 [全量总账](../../.scratch/e2e-full-migration-20261025/inventory.md)。下表保留其余 24 spec 的历史分组，标题所述不自动成为当前产品契约。

`source_implemented` 仅表示源码实现，不等于静态或真实验收；全量迁移尚未真实验收完成，slice15/16 原生 picker UI 链源码已补齐、真实仍未验，公开 API 场景不替代 UI 验收；整例预算已统一为 180 秒，slice13 原生观察仍为 120 秒、worker 启动仍为 90 秒；预算适配尚须真实验收。发现数以当前配置实际发现为准，运行结果统一见 [验证记录](VALIDATION.md)，独立 run 与 Host epoch 逐一见全量总账。新 Host 目录适配 target 已通过，picker 仍实际失败，不能用公开 API invalid 局部代替；Team 生命周期未验。最终稳定四例断言全过但 teardown worker error/Main exit1/native 无 settle，整轮仍失败；此前输入漂移轮保留失败，不拼接为全绿。38 个旧 case 全量 acceptance 均为 unverified，旧入口保留。

## 2026-10-27：核心旧入口逐文件退役

- `tests/e2e/app-smoke.spec.ts` 已删除：当前 `licensed/chat.spec.ts:17` 经正常本地入口验证 Chat workspace、输入可见且可用、无登录/许可门禁；r4 `licensed-current-targets-1793055576926320800` 此例通过，Main 与 native 正常退出。旧页面标题不是当前 UI 契约。
- `tests/e2e/settings-proxy.spec.ts` 已删除：当前 `licensed/settings-proxy.spec.ts:16` 完整覆盖原启用/禁用保存要求，并验证同 call confirmed、刷新持久化和精确恢复。r3 `licensed-current-targets-1793052092440576700` 此例通过，Main/native 正常退出。
- 两轮选集仍分别因 Team 失败而整体失败；单文件退役不表示整套通过。旧 `chat/chat.spec.ts` 的 PNG/公开能力链未完成，旧 fixture 仍被它消费，二者保留。上方及下表均为历史记录，不倒写旧成绩。

## 2026-10-27：按用户明确要求删除最后两份受控旧入口

已删除 `tests/e2e/chat/chat.spec.ts` 与 `tests/e2e/fixtures/electron.ts`。当前聊天与附件场景继续由 `e2e/src/scenarios/licensed/chat.spec.ts`、`session-capabilities.spec.ts` 承接；本次是用户明确要求的旧入口退役，不以图片、纯文本或附件业务验收通过为依据，原失败与未验项目保留。上节“二者保留”为删除前历史状态；ignored 旧诊断文件不在本次删除范围。

## 其余 24 份旧 spec 的历史分组

| 分组 | 文件 | 声明数 | 标题所表达的业务范围 |
|---|---|---:|---|
| 启动与运行时 | [setup-runtime-profile.spec.ts](../../tests/e2e/setup-runtime-profile.spec.ts) | 1 | 新配置进入本地工作区，setup/license 门槛 |
| 启动与运行时 | [openclaw-lifecycle-e2e.spec.ts](../../tests/e2e/openclaw-lifecycle-e2e.spec.ts) | 1 | listener 与 control readiness |
| 启动与运行时 | [gateway-routes-o014.spec.ts](../../tests/e2e/gateway-routes-o014.spec.ts) | 1 | 当前生命周期、控制路径与旧 gateway route 不复活 |
| 启动与运行时 | [openclaw-o016.spec.ts](../../tests/e2e/openclaw-o016.spec.ts) | 3 | 环境状态脱敏、子代理模板与未知详情拒绝、旧 readiness route 不假成功 |
| Provider | [provider-routing-o008.spec.ts](../../tests/e2e/provider-routing-o008.spec.ts) | 1 | Renderer IPC unavailable、拒绝、未知能力与脱敏 |
| Provider | [providers-validation.spec.ts](../../tests/e2e/providers-validation.spec.ts) | 2 | 空 API key 拒绝且不泄露、本地账户与模型验证 |
| 渠道与连接器 | [channels-o009.spec.ts](../../tests/e2e/channels-o009.spec.ts) | 1 | Channels 自然入口与脱敏状态 DTO |
| 渠道与连接器 | [channel-control-functional.spec.ts](../../tests/e2e/channel-control-functional.spec.ts) | 1 | 已配置沙箱账户的 UI 控制与确认状态 |
| 渠道与连接器 | [external-connectors.spec.ts](../../tests/e2e/external-connectors.spec.ts) | 1 | Electron / Rust Host 连接器保存、探测、删除 |
| 会话与历史 | [openclaw-session-catalog-e2e.spec.ts](../../tests/e2e/openclaw-session-catalog-e2e.spec.ts) | 2 | 桌面 capability 会话目录、创建 |
| 会话与历史 | [session-routes-o027.spec.ts](../../tests/e2e/session-routes-o027.spec.ts) | 2 | 合法会话创建、列举、读取；畸形输入拒绝且不回显 |
| 会话与历史 | [openclaw-session-lifecycle-functional.spec.ts](../../tests/e2e/openclaw-session-lifecycle-functional.spec.ts) | 1 | 变更、运行、中止、删除及目录一致性 |
| 会话与历史 | [matcha-history-producer.spec.ts](../../tests/e2e/matcha-history-producer.spec.ts) | 1 | 公共会话真实 turn、公共历史导出与重启恢复 |
| 会话与历史 | [usage-history.spec.ts](../../tests/e2e/usage-history.spec.ts) | 1 | Dashboard 公共 usage 投影 |
| Cron 与任务 | [cron-o011.spec.ts](../../tests/e2e/cron-o011.spec.ts) | 1 | 当前计划任务入口与已删除 Cron route 不复活 |
| Cron 与任务 | [cron-lifecycle-functional.spec.ts](../../tests/e2e/cron-lifecycle-functional.spec.ts) | 2 | Cron 创建、刷新、开关、更新、触发、删除；畸形触发拒绝 |
| Cron 与任务 | [task-manager-ui.spec.ts](../../tests/e2e/task-manager-ui.spec.ts) | 1 | Task Center 的真实 TaskCreate 拒绝与隐私投影 |
| Cron 与任务 | [task-lifecycle-functional.spec.ts](../../tests/e2e/task-lifecycle-functional.spec.ts) | 1 | Task 生命周期及 Task Center / Chat Tasks 一致性 |
| Team 与 Subagent | [teams-delivery.spec.ts](../../tests/e2e/teams-delivery.spec.ts) | 1 | 无效 TeamSkill 经 Renderer / Electron / Rust 拒绝 |
| Team 与 Subagent | [team-lifecycle-functional.spec.ts](../../tests/e2e/team-lifecycle-functional.spec.ts) | 2 | 公共 Host 选择边界、可信 TeamSkill 实体化、运行图与清理 |
| Team 与 Subagent | [subagents-o030.spec.ts](../../tests/e2e/subagents-o030.spec.ts) | 3 | 当前 Subagents UI / 读取、拒绝 / unavailable、旧 route 不复活 |
| Team 与 Subagent | [subagent-configuration-functional.spec.ts](../../tests/e2e/subagent-configuration-functional.spec.ts) | 1 | 固定 agent 配置、有限技能选择、投影重载持久化 |
| 安全与诊断 | [security-policy.spec.ts](../../tests/e2e/security-policy.spec.ts) | 1 | 桌面安全策略保存与恢复 |
| 安全与诊断 | [diagnostics-archive.spec.ts](../../tests/e2e/diagnostics-archive.spec.ts) | 1 | Settings 保存 Rust 诊断归档且不暴露路径 |

## 迁移判定与验收边界

- 按独立业务契约选择场景，不逐文件机械搬迁。生命周期、持久化、恢复、跨页面一致性与拒绝 / 脱敏分别判断。
- 优先核对会话 catalog / O-027 / lifecycle，以及 readiness / gateway 的重叠；标题相似尚不能证明重复。
- 已删除 route 的负向约束须回到现行契约确认，不把历史编号当成退役依据。
- 沙箱账户、可信 TeamSkill、固定 agent、真实模型 turn 等环境与权限前提尚未核验，不执行或读取其私有材料。
- 全部 27 spec / 38 case 已纳入本轮授权；旧 spec、公共 fixture 与根旧配置暂留，逐项真实验收或有据退役后才精确删除，不把 20 slice 源码交付当成全量验收或删除授权。
