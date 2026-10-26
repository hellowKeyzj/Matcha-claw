# E2E 开发约定

先读仓库 `CODING_CONSTITUTION.md`、本目录 `README.md`、`docs/ARCHITECTURE.md`；提交前按 `docs/E2E_PR_CHECKLIST.md` 核对。

## 写在哪里

- 新业务用例只写 `src/scenarios/**/*.spec.ts`，从 `src/fixtures/serenity.ts` 导入 test，使用注入的 actor；动作放 Task/Interaction，读取放 Question，定位放 Page。
- 八层依赖白名单是架构契约，类型导入也遵守；不导入应用源代码，不加 barrel、运行时 require 或非字面量 import。
- 持久 Ability 只由 Fixture 构造并授予 Actor；Interaction 仅通过 `actor.abilityTo(...)` 使用已有能力，不调用 `whoCan`、不重建能力、不用 Actor 类型强转绕过注入。
- 第三方 API 按语义分层，不按包名全放行。Page 只有纯定位，Question 只有读取，Scenario 不写 DOM/定位器、Playwright/Node I/O、Actor setup 或 test modifiers/hooks。
- 文件按层使用 `.page.ts/.task.ts/.question.ts/.interaction.ts/.ability.ts/.spec.ts`，小写 kebab-case；fixture 只 `serenity.ts`，config 只 `electron.ts`。不加 JS、TSX/MTS/CTS、声明文件、未知目录或符号链接。
- 不用 `eslint-disable`、`@ts-ignore`、`@ts-nocheck`、`@ts-expect-error` 消音。遇到规则冲突先检查职责，不默认放宽治理。

## 资源模型

`E2E_PROFILE` 只接受 `licensed` / `unlicensed`；未设置时本地默认 `licensed`，CI 默认 `unlicensed`。一次 run 不混跑两种模式；runner 配置排除另一模式的专属 spec，共同账号场景两种模式均运行，`unlicensed` 保留原未授权门禁断言并显式排除整个 `src/scenarios/licensed/`，不靠 skip/fixme 隐藏用例。

`licensed` 固定使用 `e2e/.profiles/licensed/`，user-data 在其下；只保留自己生成的身份、许可密文与缓存，成功或失败均不删除，绝不复制日常 profile。激活与测试共用目录排他锁；锁存在即 fail-fast，包括残留锁，不自动抢占。`unlicensed` 每 run 新建临时 profile，成功后清理。

一次 run 只有一个专用测试 profile、一个 Electron、一个 worker；retries 0、maxFailures 1、fullyParallel false。测试 worker fixture 拥有唯一生命周期入口，Ability 执行资源操作；Actor 借 `BrowseTheWebWithPlaywright.usingElectronApp(sharedApp)`，不得逐场景关闭/重启应用。公开 browser fixture 连接同一 Electron 的真实 CDP，不另起浏览器、不 fake browser、不用 SDK 私有方法。

场景共享 profile，但不能依赖前例；显式回到业务起点，恢复自己的 UI 修改。原始失败与各项清理失败必须同时保留，资源释放不被 UI 恢复阻断；未知 mutation 先核同次公开回执，不重发或盲恢复。不能用单元素 `isVisible() === false` 证明弹窗关闭，重复定位异常可能被 SDK 转成 false，关闭应核弹窗集合数量。不使用日常 profile，不增加测试专用 auth/license 放行，不靠后台 API 替代 UI 验收。`pnpm --dir e2e license:activate` 仅通过正常 UI 一次性激活专用持久 profile，使用本机 bundled Bun 加载既有 TS owner；key 只从 stdin 读取，禁止写入源码、报告、命令行或环境变量，激活时不录 trace、screenshots 或 raw console。后续测试只复用原生授权，不每次激活。需要外部账号或密钥时如实说明前提，不伪报验证。

## 验证与改动边界

```sh
pnpm --dir e2e verify
pnpm --dir e2e test  # 已有应用工件
pnpm run test:e2e   # 根统一入口，含构建
```

`verify` 不构建或启动应用；结构、ESLint、类型与真实 lint 正反例都必须通过。改规则时给同配置自检补合法与违规例；不要把 missing-rule、解析失败或 lint 被忽略当成功。

2026-10-25 用户要求按当前页面重新实现，不沿旧页面机械迁移。先读当前页面及真实调用链，再实现自然导航、操作、结果验证与自有现场恢复；旧27 spec / 38 case只提供有效业务要求，原20 slice总账及成绩保留为历史。账号和许可基础场景保留，发现数以当前配置实际发现为准，CI 不运行 `licensed`。页面操作与公开API安全边界分别验证，不用API写入替代UI；恢复与只读核对脚本同样先完成本地进入，reload后按实际落点重新进入，不在登录页先做后台业务核对。保留运行时连接等待，不注入凭据或伪造queued成功。

当前重写尚未真实验收。旧 case 去向见 [历史迁入总账](../.scratch/e2e-full-migration-20261025/inventory.md) 与 [旧用例清单](docs/LEGACY_INVENTORY.md)，当前结果统一见 [验证记录](docs/VALIDATION.md)。各 run 按源码与工件指纹独立记录，输入漂移、非零退出、worker error、原生退出未证明均保留失败；场景通过数、锁释放或进程清空不能代替完整验收。历史产品失败不因重写宣布解决，本轮不扩产品修复。

结构检查拒绝 Git 索引中仍受控且磁盘仍存在的全部 `tests/e2e` 文件，原四路径也不例外；未 stage 的删除不误报，不要求 `git add`，不扫描 ignored 本地诊断。旧 spec、公共 fixture 和根旧配置暂留，逐项真实验收或有据退役后才精确删除；不放行规则，不把源码交付当迁移完成。整次 run 成功须同时核对命令退出码与 worker errors；临时规则验证只能清理自己创建的目录。

不为绕门禁改根依赖/锁文件、产品行为或 CI。规则属于防误用治理而非安全沙箱；GitHub 必需检查与禁止合并由仓库设置实现，不能声称本地配置保证远端合并安全。
