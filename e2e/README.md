# Electron E2E

面向维护 MatchaClaw 测试的开发者和 AI。真实 Electron 应用由 Serenity/JS Screenplay 驱动，测试不依赖 HTML 设计快照。

```text
Scenario → Task → Interaction → Page
                  ↓             ↑
                Ability       Question

一个测试运行 → 一个专用 Profile → 一个 Electron 实例
```

## 命令

在仓库根目录使用 pnpm（锁定版本见根 package.json），Node.js 24.15.0 及兼容的更新 24.x：

```sh
pnpm install --frozen-lockfile
pnpm run check:e2e
pnpm run test:e2e  # 本地默认 licensed，首次运行前先完成下述激活
# 已构建后定向执行，不再次构建
pnpm --dir e2e test --grep "场景名称"
```

性能测量可设置 `E2E_TRACE_SCREENSHOTS=0`，关闭 trace 连续截帧，避免录屏影响软件合成；默认仍录制，场景结束截图与其他证据不变。

`check:e2e` 执行结构、ESLint 分层、TypeScript 和规则正反例自检；不启动应用。`test:e2e` 再构建并执行真实 Electron。根应用原有的 Playwright 版本不变，子工程独立锁定 Playwright 1.64.0 / Serenity/JS 3.49.0。

## Profile 模式与一次性激活

`E2E_PROFILE` 只接受 `licensed` / `unlicensed`，其他值立即报错；未设置时本地默认 `licensed`，CI 默认 `unlicensed`。配置按模式排除另一类专属 spec，共同账号场景两种模式都会运行，不在同一 run 混跑；`unlicensed` 显式排除整个 `src/scenarios/licensed/`，不靠 skip/fixme 隐藏场景。

- `licensed`：固定专用目录 `e2e/.profiles/licensed/`，user-data 在其下。保留自己生成的身份、许可密文与缓存，成功或失败均不删除；绝不复制日常 profile。激活与测试共用目录排他锁防并发；锁存在即 fail-fast，包括残留锁，不自动抢占。
- `unlicensed`：每 run 创建临时 profile，保留原未授权门禁断言，成功后清理。

首次使用 `licensed` 前，在已准备应用工件的本机执行：

```sh
pnpm --dir e2e license:activate
```

该脚本使用本机 bundled Bun 加载既有 TS owner，仅通过正常 UI 一次性激活专用持久 Profile；key 只从 stdin 读取，不写入源码、报告、命令行或环境变量。激活时不录 trace、screenshots 或 raw console。后续 `pnpm run test:e2e` 只复用原生授权，不每次激活，不增加测试放行旁路。

显式运行未授权负向场景：

```powershell
$env:E2E_PROFILE='unlicensed'; pnpm run test:e2e
```

```sh
# Git Bash
E2E_PROFILE=unlicensed pnpm run test:e2e
```

## World 独立环境准备

World 存储启用已纳入正式场景 [world-storage.spec.ts](src/scenarios/licensed/world-storage.spec.ts)：只填 PostgreSQL 连接，经真实表单启用空库，核对 canonical active/ready、完整授权行摘要和六目录，再重复连接确认 World／Storage／Release／授权不变。不需要管理员初始化文件，也不创建业务 Task。

Windows 使用专用 `licensed` Profile 下的 CurrentUser DPAPI JSON 凭据文件，内容为 `{ "connectionString": "…" }`；`E2E_WORLD_STORAGE_CONNECTION_FILE` 只传文件绝对路径，不能传 DSN。数据库须为自有 loopback `world_*` 空库，运行账号非超级用户且拥有建 schema 权限；测试不创建数据库、不迁移 schema、不读日常 Profile。输入期间暂停 trace，清空密码控件后恢复录制，DSN 不进入步骤参数、notes、日志或报告。

```powershell
$env:E2E_WORLD_STORAGE_CONNECTION_FILE='<专用 licensed Profile 下的 DPAPI 文件绝对路径>'
pnpm --dir e2e test src/scenarios/licensed/world-storage.spec.ts
# 上次运行结束后，再执行同一命令验证跨进程自动恢复
pnpm --dir e2e test src/scenarios/licensed/world-storage.spec.ts
```

首次空库运行记录 `fresh`，在专用 Profile 写入只含安全事实的 `world-storage-baseline.json`；后续独立 run 记录 `restored`，先不输入、不提交，核对自动恢复，再验证重复连接。两次 run 各自仍是一个 worker／Electron，场景不重启应用；baseline 不覆盖，库已非空却缺原 baseline 时明确失败，不补初始化。已有库运行不能冒称覆盖空库。OpenClaw 未就绪时提前关闭的场景不纳入此业务回归，也不为此放宽公共退出检查。

旧 `scripts/world-setup.ts` 保留历史 local/personal 与 Task 输入追溯，其中管理员首配和手填编号入口已过时，不用于新存储启用或替代正式场景。其他 World 业务仍需各自真实 Task、包或模型前提；存储 ready 不代表完整业务验收通过。

## 真实运行前提

- 安装根 Electron 与原生依赖，并按原项目脚本准备 Bun、Git Bash、OpenClaw、Matcha CLI、Rust Host 和 App Server；`build:vite:e2e` 只构建桌面代码，不替代 native 构建。系统 PATH 须有现成的 Python 3.12，确保隔离环境的 `uv python find 3.12` 成功，避免应用自身的工具链准备触发下载安装。
- 复用现有 `vite.config.ts` 的 E2E mode，输出到 `e2e/.cache/app/`，不覆盖日常 `dist/`、`dist-electron/`。构建脚本保留生产 Main/preload 的 CommonJS 包边界，避免继承 E2E 工程的 ESM 类型。默认缓存构建的运行时工作目录仍为仓库根。`E2E_MAIN` 指定其他 `dist-electron/main/index.js` 时，须提供包含桌面与 native 工件的完整应用工程根；Main、preload、Renderer、工具预检和启动 cwd 绑定同一工程根，不再混用仓库 native。专用 Profile 仍固定在本仓库；回执记录实际 cwd/Renderer URL 与启动前四工件路径/hash。两种模式均通过该页面的公开 IPC 读取安全许可回执，证明 preload 桥实际可用；不依赖 Electron 未承诺的 preload getter，也不把磁盘身份当作进程加载或 Host ready 证明。
- 按上述模式选择专用 Profile；场景共用它和同一应用，不读取日常真实账号、授权或模型密钥。`licensed` 复用专用 Profile 的原生授权，`unlicensed` 验证未授权门禁，不添加 E2E 放行旁路。
- 单 worker、禁止并行、无重试、首次失败停止，避免 Playwright 更换 worker 后悄悄启动另一应用。场景应声明起点并恢复自己修改的 UI 状态，不清空共享 Profile。
- Serenity 的 Browser fixture 通过本次 Electron 的随机 loopback DevTools 端点连接同一应用；不是另启 Chromium，也不连接日常应用。Actor 借用 Electron，不拥有关闭权。

新增场景先读 [AGENTS.md](AGENTS.md) 与 [架构规则](docs/ARCHITECTURE.md)。报告位于 `e2e/playwright-report/`、`e2e/serenity-report/`，失败证据位于 `e2e/test-results/`；Serenity HTML Reporter 不需要 Java。完整运行结果以命令退出码与 `test-results/results.json` 的 worker errors 为准，不能只看 Serenity 的场景通过数。激活状态、shutdown 及最近实测以 [验证记录](docs/VALIDATION.md) 为准，未运行的结果不得写成通过。

## 当前页面实现与验收

2026-10-25 用户要求按当前页面重新实现，不再沿旧页面机械迁移。用例以现有页面、自然导航和当前业务结果为依据：进入页面 → 操作 → 验证结果 → 恢复自有现场。旧 **27 spec / 38 case** 仅提供有效业务要求；页面流程与公开 API 安全边界分别验证，不用 API 成功替代 UI。八层框架、单 Profile / Electron / worker、180 秒整例预算不变；启动就绪等待按用户要求设为180秒，worker资源预算270秒，包含启动与退出余量。

重写尚未验收完成。Provider 本地认证冲突、Cron 重叠对话框、Tasks 读取409、原生picker控件及产品退出等历史失败不能仅因重写而宣布解决；缺少可信 TeamSkill、渠道沙箱、真实模型等前提时如实记录，不安装、换凭据或伪造成功。

[历史迁入总账](../.scratch/e2e-full-migration-20261025/inventory.md) 保留旧 case、当时源码指纹和独立运行证据；[旧用例清单](docs/LEGACY_INVENTORY.md) 保留历史业务要求。它们不作为当前页面重写后的验收。发现数以当前配置实际发现为准，CI 不运行 `licensed`。

当前实现与真实结果统一维护在 [验证记录](docs/VALIDATION.md)。源码实现、质量检查、单例断言、完整运行与旧文件删除分别报告，不拼接不同选集或工件成绩；命令非零、worker errors、原生退出未证明都不能被场景通过数覆盖。

结构门禁拒绝所有 Git 索引中仍受控且磁盘仍存在的 `tests/e2e` 文件，包括原四个白名单路径；未 stage 的删除不误报，不要求 `git add`，也不扫描 ignored 本地诊断。旧 spec、公共 fixture 和根旧 `playwright.config.ts` 暂留，逐项真实验收或有据退役后才精确删除；不放行规则，不把源码交付当迁移完成。

## CI 与合并限制

所有 PR 和 merge queue 都运行 `E2E architecture` 与 `Electron E2E (Windows)`，不使用路径过滤跳过规则检查。工作流构建真实 Windows Host、App Server、CLI 与桌面工件，再运行测试并上传报告。

仓库管理员仍须在 GitHub 的 main 分支保护或 ruleset 中：

1. 将上述两个 job 设为必需状态检查，禁止失败时合并；使用 merge queue 时也要求同名检查。
2. 要求 CODEOWNERS 审核，禁止直接推送与管理员绕过；规则、fixture、Ability、配置和 CI 的修改按 `.github/CODEOWNERS` 审核。
3. 禁止通过修改检查器、锁文件或 workflow 来让违规代码变绿。

本地文件不能启用远端分支保护；未启用上述设置前，不声称已强制禁止合并。ESLint 是代码治理，不是阻挡恶意开发者的安全沙箱。
