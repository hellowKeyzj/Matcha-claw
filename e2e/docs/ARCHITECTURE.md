# Electron E2E 架构

E2E 是独立测试子工程，使用 Playwright Test + Serenity/JS；它通过真实桌面 UI 验证产品，不导入仓库业务 `src`、Electron Main 或 Rust 内部实现。

## 八层与依赖

```text
Scenario ──→ Fixture ──→ Ability ──→ Config
   │                        ↑
   ├──→ Task ──→ Interaction┘
   │      │           │
   └──→ Question ──→ Page
          ↑     Task ──┘
```

实际允许边如下；未列出的一律拒绝，包含类型导入和字面量动态导入。

| 层 | 可依赖的本地层 | 职责 |
|---|---|---|
| Scenario | Fixture、Task、Question | 业务意图、步骤编排、Ensure 断言 |
| Task | Task、Interaction、Page、Question | 可复用业务动作 |
| Question | Question、Page | 读取业务结果，不执行 UI 动作 |
| Interaction | Interaction、Page、Ability | 原子操作，必要时使用能力 |
| Page | Page | 纯定位声明，不读取或操作 UI |
| Fixture | Fixture、Config、Ability | runner 配置、Actor 注入、worker 生命周期 |
| Ability | Ability、Config | Electron、profile、文件系统等资源边界 |
| Config | Config | 纯配置与路径解析 |

第三方包不是全层通行证。`scripts/eslint-rules.mjs` 按层与具名符号限定导入；新增 API 先判断语义，不按包名整体放行。

- Scenario 仅从 `fixtures/serenity.ts` 导入 `test`（或明确导出的 `it/describe`），使用 Tasks、Questions、`@serenity-js/assertions` 和有限 core 业务辅助。不导入 web、Playwright、Electron、Node I/O，不构建 Actor、不 setup，不调用定位器或 DOM。
- Page 仅使用 web 的 `By`、`PageElement`、`PageElements` 和必要 core 纯类型/格式辅助；不使用 Click、Enter、Navigate、Browse 能力，不调用定位结果的读取或动作方法。
- Question 使用 core 的 Question/读取组合与 web 的 Text、Value、Attribute 等读取 API；不使用 Click、Enter、Navigate 或 native escape。
- 原始 Playwright 与 Node I/O 留在 Ability；Fixture 仅连接公开适配器、类型与生命周期，并独占持久 Ability 的构造和 Actor 注入。Interaction 只通过 `actor.abilityTo(...)` 使用已有能力，不调用 `whoCan`、不重建能力、不用 Actor 类型强转绕过注入；八层依赖不变。Config 只允许必要的 Node 路径解析。

## Shared Profile + Shared Electron Instance

```text
一次 run
  └─ 单 worker Fixture
       └─ 一个专用 profile + 一个 Electron 应用
            ├─ 同一 Electron 的 loopback DevTools → 公开 browser fixture
            └─ Actor 借 BrowseTheWebWithPlaywright.usingElectronApp(sharedApp)
```

`E2E_PROFILE` 只接受 `licensed` / `unlicensed`，其他值 fail-fast；未设置时本地默认 `licensed`，CI 默认 `unlicensed`。runner 配置按模式排除另一类专属 spec，共同账号场景两种模式均运行；两种模式不能在同一 run 混跑，`unlicensed` 保留原未授权门禁断言并显式排除整个 `src/scenarios/licensed/`，不以 skip/fixme 代替发现边界。

- `licensed` 固定使用 `e2e/.profiles/licensed/`，user-data 在该目录下。保留此专用 profile 自己生成的身份、许可密文和缓存，成功或失败均不删除，绝不复制日常 profile。激活与测试共用目录排他锁防并发；锁存在即 fail-fast，包括残留锁，不自动抢占。
- `unlicensed` 每 run 创建临时 profile，成功后清理，不借用持久 profile 的授权状态。

固定配置为 `workers: 1`、`retries: 0`、`maxFailures: 1`、`fullyParallel: false`。测试 worker fixture 是唯一生命周期入口；Ability 执行资源操作，Actor 只借用已有 Electron，不在场景结束时关闭、重启或更换它。公开 browser fixture 必须连接该 Electron 的真实 CDP 端点，不启动辅助浏览器、不伪造 browser、不调用 Serenity 私有实现。

`license:activate` 是一次性准备入口，通过本机 bundled Bun 加载既有 TS owner，在正常 UI 中激活同一专用持久 profile，不建立另一套资源 owner。key 只从 stdin 读取，不写入源码、报告、命令行或环境变量；激活流程不录 trace、screenshots 或 raw console。后续测试仅复用原生授权，不逐 run 重新激活，也不添加 license/auth/mock 放行路径。

所有场景共享所选模式的专用 profile，不能依赖执行顺序；每例声明业务起点，恢复自己改变的 UI 状态。不清空 profile，不接管日常应用或账号。需要登录、授权或模型密钥的业务，应使用真实合法前提；当前无密钥基础场景不能冒充完整业务覆盖。

## 文件规则

`src` 必须且只能有八个真实目录：`abilities/config/fixtures/interactions/pages/tasks/questions/scenarios`。

- Page、Task、Question、Interaction、Ability 分别使用 `*.page.ts`、`*.task.ts`、`*.question.ts`、`*.interaction.ts`、`*.ability.ts`；Scenario 使用 `*.spec.ts`。
- 文件和业务子目录用小写 kebab-case；允许按业务嵌套子目录。
- Fixture 只有 `src/fixtures/serenity.ts`，Config 只有 `src/config/electron.ts`，不新增平行入口。
- 空层可保留空的根级 `.gitkeep`。禁止符号链接/junction、JS/JSX、TSX/MTS/CTS、声明文件和未知源文件。
- 使用指向 e2e/src 的相对模块路径，NodeNext 推荐 `.js` 后缀；禁止跨项目导入、别名逃逸、默认/namespace 第三方导入和 re-export/barrel 转发。
- 禁止运行时 `require`、`createRequire`、代码生成和非字面量动态 import；第三方动态 import 不能绕过具名导入白名单。
- 禁止 `eslint-disable`、`@ts-ignore`、`@ts-nocheck`、`@ts-expect-error`；`noInlineConfig: true` 与 `reportUnusedDisableDirectives: error` 固定开启。
- Scenario 禁止 `test.use/extend/skip/fixme/only`、`describe.parallel/configure`、生命周期 hook、raw Playwright fixture、Actor setup；别名、字面量属性和属性解构也受检查。

## 当前页面与断言边界

当前页面源码和真实用户流程决定定位、导航与操作顺序；旧spec只提供仍有效的业务要求，不决定新页面结构。

- 页面旅程先走可见入口与正常控件，再读取公开事实验证实际结果；不以API写入替代页面操作。
- 公开API安全边界单独表述，固定错误与脱敏断言不因页面重写而退役。
- 页面没有的操作可以保留既有公开入口，但不能称为UI操作；不存在的页面入口不在测试中伪造。
- 原生picker等OS交互归Ability，仅操作本次应用的精确目标。业务前提不足、产品错误和非零退出都保留失败，不用延时、mock或改变预期洗绿。

## 门禁与剩余边界

```sh
pnpm --dir e2e verify  # 结构 → ESLint → tsc → 真实 lint 正反例；不启动或构建应用
pnpm --dir e2e test    # 使用已准备的应用工件，执行真实 UI
pnpm run test:e2e      # 仓库统一构建/测试入口
```

结构检查只遍历本子工程 `src`；旧目录通过 `git ls-files` 取得索引路径，只拒绝磁盘仍存在的全部受控 `tests/e2e` 文件，不再保留四路径白名单。索引中未 stage 的删除不误报，不依赖 `git diff` 或要求 `git add`；ignored 本地诊断不扫描。

当前页面重写保留账号、许可及旧27 spec / 38 case的有效业务要求；发现数以当前配置为准，CI不运行licensed。整例180秒、worker资源预算270秒（其中启动就绪等待180秒，另留启动与退出余量）、Cron原生观察120秒；不注入凭据或伪造queued成功。

[历史迁入总账](../../.scratch/e2e-full-migration-20261025/inventory.md) 与 [旧清单](LEGACY_INVENTORY.md) 不代表当前重写验收；实际结果统一见 [验证记录](VALIDATION.md)。旧spec、公共fixture和根旧配置逐项真实验收或有据退役后才精确删除，不放行规则。每轮按源码与工件指纹独立记录；输入漂移、非零退出、worker error及原生退出未证明均保留失败，场景通过数不能覆盖整轮失败。

`check-enforcement.mjs` 在独占临时目录生成 `src`，使用相同 ESLint 配置和真实已安装插件验证合法示例与越界反例，断言真实 ruleId、error severity；保留 135 个 lint 样例、全部 64 条层间边与原 8 个结构样例，并用隔离 Git 仓库验证新旧受控路径拒绝、未 stage 删除放行及 ignored 诊断不扫描。finally 仅清理自己创建的目录，无网络、不启动应用。新增规则时同时补充合法和违规样例，不能把解析失败或 missing-rule 当作成功阻止。

这些是防误用的代码治理，不是不可绕过的安全沙箱；静态 AST 不能证明任意程序的运行语义。规则、fixture、Ability 与 CI 修改仍需人工审核。GitHub 必需检查、CODEOWNERS、禁止直接推送和管理员绕过必须由仓库管理员在分支保护/ruleset 设置，本地文件不能保证 PR 一定不可合并。
