# E2E PR 检查清单

- [ ] 用业务结果描述场景；Scenario 只编排 fixture test、Tasks、Questions 和 Ensure，不接触定位器、原始 Playwright、DOM、Node I/O 或 Actor setup。
- [ ] 变更落在正确层，符合 [依赖白名单](ARCHITECTURE.md#八层与依赖)；Page 只有定位，Question 只有读取，类型导入也不跨层。
- [ ] 持久 Ability 仅由 Fixture 构造并授予 Actor；Interaction 只用 `actor.abilityTo(...)`，不 `whoCan`、不重建能力、不用 Actor 类型强转绕过注入。
- [ ] 文件位置和后缀正确；不新增 barrel、动态路径 import、require、符号链接、JS/替代 TS 扩展或 suppression。
- [ ] 共用同一专用 profile 和 Electron；不增加 worker/retry/并行，不逐例关闭或重启，不引入辅助 browser 或 SDK 私有方法。
- [ ] 场景可独立从声明起点执行，恢复自己修改的状态；不依赖前例，不清空共享 profile，不绕过真实 auth/license。
- [ ] 页面流程来自当前页面源码和真实用户操作，不沿旧布局/入口机械迁移；旧27 spec / 38 case的有效业务要求仍有承接或明确退役依据。公开API安全边界与UI旅程分开，不拿API成功代替UI。账号/许可基础保留，发现数以当前配置为准，`unlicensed` 显式排除整个 `licensed/`，不靠skip/fixme，CI不运行licensed。
- [ ] 最终退役时 `tests/e2e` 不再有磁盘仍存在的 Git 受控文件，包括原四路径；旧 spec 逐项真实验收或有据退役后才精确删除，并收口公共 fixture 和根旧配置，不冒称源码交付即允许删除。
- [ ] `pnpm --dir e2e verify` 通过；保留 135 lint、64 层间边与原 8 结构样例，验证原四路径与新增受控旧文件拒绝、未 stage 删除放行、ignored 诊断不扫描，不要求本轮 `git add`。改治理规则时断言真实 ruleId 与 severity，不能用解析失败充数。
- [ ] `pnpm run test:e2e` 通过真实桌面验证；或明确记录未运行原因、缺少的真实前提及未验证业务，不把静态检查当 E2E 成功。
- [ ] 失败证据和报告不泄露密钥、账号或日常 profile；主失败与各项 cleanup 错误同时保留，释放不被 UI 恢复阻断。关闭弹窗核集合数量，不让 SDK 吞掉重复定位异常后冒充关闭。只清理本次测试拥有且效果已确认的资源，未知 mutation 先核同次公开回执，不重发、盲恢复或终止未知进程。
- [ ] 修改 fixture、Ability、治理配置/脚本或 CI 时，相关 owner 已审核；没有通过放宽门禁隐藏失败。
- [ ] 报告将代码迁入、静态验证、真实 UI 验证和旧文件删除分开陈述；按 run/source manifest/Host hash 独立记录，不拼选集或 epoch。输入漂移保留失败；case 全过或 selectedSuitePassed 不能覆盖退出码、worker errors、native shutdown 未证明。未注入真实模型凭据或伪造 queued 成功，公开 API 局部不代替失败的 picker UI；缺少真实前提和失败如实记录。

当前页面重写尚未真实验收；[历史迁入总账](../../.scratch/e2e-full-migration-20261025/inventory.md) 与 [旧清单](LEGACY_INVENTORY.md) 只保留旧业务要求、去向和历史证据，不代表新实现通过。当前结果核对 [验证记录](VALIDATION.md)，不复用旧成绩；Main 正常退出不等于全部子进程正常。

管理员另行核对 GitHub 必需检查、CODEOWNERS、merge queue 和禁止绕过设置；本清单和本地脚本不等于远端分支保护。
