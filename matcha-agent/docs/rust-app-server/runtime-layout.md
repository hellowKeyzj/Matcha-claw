# 运行家目录与配置

状态：首次实现目录、配置与存储已在 [contracts.md](contracts.md) 冻结；运行验证状态见 [progress.md](progress.md)。

## 1. 已定的语义

- 像 `.openclaw` 一样，Server 有自己的运行家目录、主运行配置、Agent 数据和会话数据。它不是源码/安装目录。
- 每个 Agent 有自己的一个 workspace；该 workspace 内不再划分 Project，不默认创建第二套项目实体。
- 同一 Agent 的多个 CLI 会话使用该 Agent 的 workspace；上下文与 transcript 仍按 Session 独立。
- 不同 Agent 不默认共享工作目录。曾提出的“所有 Agent 共用一个 workspace”是误解，已撤回。
- CLI 的 `projects/<cwd-key>/` 仅是现有物理存储布局；不在 workspace 内，也不引入产品 Project 概念。

默认 `matcha` 与其它 Agent 使用同一 `agents/<agent-id>/{workspace,runtime,state}` 布局。`ConfigStore::open` 仅在缺失时补入该真实 Agent，保留已有定义；幂等准备目录，并复用原 `CLAUDE.md` imports 初始化，不覆盖已有原生指令、不授予 custody。delete、retire、删除续段及配置校验保护默认身份；不扫描或迁移旧身份、路径和历史。此处记录当前机制，构建与运行证明见 [progress.md](progress.md)。[VERIFY: matcha-agent/app-server/src/config/mod.rs:45-59] [VERIFY: matcha-agent/app-server/src/config/mod.rs:254-278] [VERIFY: matcha-agent/app-server/src/agent/storage.rs:31-96] [VERIFY: matcha-agent/app-server/src/agent/files.rs:64-92] [VERIFY: matcha-agent/app-server/src/agent.rs:155-172] [VERIFY: matcha-agent/app-server/src/config/validation.rs:82-110]

## 2. 目录基线

```text
~/.matcha-agent/
├─ matcha-agent.json              # 主运行配置、默认值、Agent 定义/绑定
├─ agents/
│  └─ <agent-id>/
│     ├─ workspace/               # 该 Agent 的唯一默认工作目录
│     ├─ state/
│     │  └─ settings.json        # Server 执行投影，通过原生 --settings 消费
│     └─ runtime/                 # 该 Agent 的 CLI 原生数据根
│        ├─ settings.json        # CLI 原生命令/持久审批写入，不由 Server 覆盖
│        ├─ memory/              # 由原生 autoMemoryDirectory 显式指定
│        ├─ channels/weixin/     # WEIXIN_STATE_DIR，独立于全局微信凭据
│        ├─ skills/              # skills.install 的 Agent 专属发现根
│        ├─ projects/
│        │  └─ <cwd-key>/
│        │     ├─ <session-id>.jsonl
│        │     └─ …              # 原生子 Agent、恢复等关联数据
│        └─ …                    # CLI 原生 Agent 记忆、Team 等目录
└─ state/
   └─ app-server.sqlite3          # 各 owner 自有管理表、durable events、诊断
```

目录按实际持有资源懒创建；管理存储为 SQLite WAL，各模块拥有自己的表，不建立通用业务状态 owner。没有 CLI 消费入口的根级共享 skills/plugins 目录不提前创建。

Agent 专属 Prompt/指令/记忆的位置须结合 CLI 实际消费路径确定；不凭名称额外建立一个 CLI 不读取的 memory/agents 目录并宣布接入完成。

## 3. CLI 路径映射

```text
AgentId
   ├─ cwd                  → agents/<agent-id>/workspace/
   └─ CLAUDE_CONFIG_DIR     → agents/<agent-id>/runtime/
                                  └─ projects/<cwd-key>/<session-id>.jsonl
```

原生根目录由 `CLAUDE_CONFIG_DIR` 决定：[envUtils.ts](../../src/utils/envUtils.ts#L7)。主 transcript 路径使用原生项目目录和 Session ID：[sessionStorage.ts](../../src/utils/sessionStorage.ts#L205)。

- Rust 负责确定该次执行的 Agent、cwd、原生根与 Session ID；映射保持稳定，供重新启动/resume 定位。
- cwd-key 的编码与恢复路径不是新协议字段，不自行发明替代算法；相关实现需对照原生路径规则后冻结。已恢复会话可能保留自己的 `sessionProjectDir`，不能只凭当前 cwd 推断其路径。
- 不能把 JSONL 任意搬成 `agents/<id>/sessions/<id>.jsonl`，再假设原 CLI 会自动找到。
- workspace 改名/迁移、resume 的原路径关联以及原生文件迁移，必须明确设计，不静默扫描多个旧根兜底。
- worktree 是明确启用的原生执行能力，不是默认项目层次；是否在首个版本提供及具体路径仍 OPEN。

## 4. 主配置与执行投影

主配置为根目录的 `matcha-agent.json`。根目录按 `--home`、`MATCHA_AGENT_HOME`、平台用户目录下 `.matcha-agent` 的顺序选择；相对根按 Server 启动 cwd 绝对化。字段与调用样例见 [contracts.md](contracts.md#configagent-01) 和 [使用说明](../../app-server/README.md)。

| 配置内容 | 归属与应用 |
|---|---|
| Server 监听、连接认证 | listen 默认 127.0.0.1:0；authTokenEnv 引用来源环境变量，非 loopback 无 token 拒绝启动 |
| CLI 可执行文件/入口及必要启动信息 | cli 配置；不把开发命令硬编码为发行启动方式 |
| Agent 定义、默认模型/Provider、Prompt 与能力引用 | agents 按 Agent ID 登记；providers/schedules/channels 由各业务模块校验 |
| MCP、Skills、Plugins、Hooks 与权限选择 | 各模块校验，经现有 CLI 支持的入口投影 |
| 执行期间允许覆盖的模型/模式等 | 对应 Session/Run 请求；仅接收真正支持的字段 |
| Session、Run、审批、调度与回放状态 | 管理存储，不写回主运行配置充当状态数据库 |
| token/API key/刷新凭据 | 私有解析或原生凭据存储，不进入公开配置查询与日志 |

Server 管理配置的预期方向是“全局默认 → Agent 设置 → 操作允许的会话/执行覆盖”。这不是覆盖 CLI managed/project 等原生策略的授权；二者须分开解析，准确优先级按支持字段冻结。

`state/settings.json` 是 Server 执行投影，原生命令通过 `--settings` 加载，不是第二个人工配置事实源；会话改用同一构建的完整 JSON 参数，仅覆写该会话微信 plugin 启用布尔，不污染共享文件。原生微信默认启用且 MCP 连接后即开始轮询，单筛 `--channels` 不足以隔离消费者。微信 fastpath 只使用统一 cwd/env，`WEIXIN_STATE_DIR` 固定在该 Agent runtime 下，不读取全局微信状态。

`runtime/settings.json` 保留 CLI 原生命令与审批持久化，避免两个 writer 混写同一文件。Server 配置成功、投影成功、当前 CLI 已应用是不同结果。显式 sandbox 启动还须核验原生 merged effective 中 exclusions/required/fallback/platform；设置安全不等于已观测 OS 隔离。

## 5. 原生资源发现不能假设

每 Agent 独立 `CLAUDE_CONFIG_DIR` 会改变原生用户 Skills、Plugins、MCP、记忆与凭据的发现根。共享 `skills/`、`plugins/` 不会因为目录存在就被所有 CLI 识别。

各能力 owner 必须选用已核实的加载入口：已有配置路径、插件目录参数、原生命令或有明确语义的物化；不盲目复制秘密、不双写原生安装注册表、不靠随意符号链接掩盖发现规则。具体投影由当前模块任务冻结。

## 6. 读写责任与恢复

- CLI 是原生 transcript 及其关联恢复数据的 writer；Server 可以实现受控只读历史查询，不另写一份原生对话历史。
- Server 事件用于运行管理与回放，不承担模型上下文恢复；管理索引缺失不等于原生会话已删除。
- close、从列表移除、归档元数据与物理删除必须诚实区分。不能把删除索引当作删除 JSONL。
- 默认保留、备份、清理任务和迁移格式均需按当前交付范围明确，不从旧 CLI 默认值猜成新 Server 的全局策略。

## 7. 共享面与验证

根目录、身份与路径校验、配置 schema、存储 writer 和提交责任均以 [contracts.md](contracts.md) 为共享接口。Agent ID 的平台大小写/保留名称碰撞由 config 集中校验；Session ID 为 UUID。原生 transcript 定位只扫描指定 Agent runtime/projects 并核对原生会话信息，不自行替换 cwd-key 编码。

实现存在不等于跨平台运行已验证；平台、CLI、提交不确定与资源清理的证据统一记录在 [progress.md](progress.md)。

## 8. 2026-10-18 Electron 托管根统一

Electron 托管与独立 Server 正常启动统一默认 `~/.matcha-agent`；不再以 Electron userData 下 `matcha-agent/app-server` 为第二套默认，也不添加旧根 fallback、双目录扫描或自动隐式迁移。这里只统一 Matcha Agent-owned home，Electron AppData 中的 Host state/logs 不迁移。[VERIFY: electron/utils/paths.ts:46-70,83-92] [VERIFY: electron/main/runtime-host-delivery/bootstrap-resources.ts:199-202,240-254]

- Electron：`MATCHA_AGENT_HOME` 只要存在就直接交 Node `resolve`，含空串（解析为 Electron cwd）；不 trim、不展开 `~`。变量不存在时，仅 `MATCHACLAW_E2E=1` 且 `MATCHACLAW_E2E_USER_DATA_DIR` trim 后非空才使用 `<e2eUserData>/matcha-agent`，否则使用 `os.homedir()/.matcha-agent`。[VERIFY: electron/utils/paths.ts:46-56]
- 注入链为 `getMatchaAgentHome()` → bootstrap `matcha.storageRoot` → Rust Integration 原有 `--home <storage_root>`，不改变 Integration 启动契约。独立 Server 仍按 `--home > MATCHA_AGENT_HOME > USERPROFILE/HOME/.matcha-agent` 选择根，再绝对化、canonicalize；E2E 例外仅在 Electron resolver。[VERIFY: electron/main/runtime-host-delivery/bootstrap-resources.ts:109-111,199-202,248-254] [VERIFY: runtime-host/integrations/matcha-agent/src/lifecycle/launch.rs:225-233] [VERIFY: matcha-agent/app-server/src/main.rs:24-57] [VERIFY: matcha-agent/app-server/src/config/mod.rs:210-232]

**现场迁移记录（非产品迁移规则）**：目标原本不存在；用户确认退出后，主代理复核 Electron/Host/Server/CLI 全部退出，再备份、离线重定位并发布 `~/.matcha-agent`。旧 active 根移为同父 `app-server.pre-home-move-20261018-220040` 原数据备份，不再作 active 根或 fallback。SQLite `managed_sessions.record` 持久化绝对 workspace/runtime/transcript 路径，原生 JSONL 保存 cwd，transcript 定位还关联原生 projects 目录；仅 rename 不保证恢复。本次仅重定位已确认受搬迁影响的会话 workspace/runtime、cwd-key 桶、JSONL 顶层 cwd 与原生 metadata 的 cwd/autoMemoryDirectory，用户自选外部 workspace 保持不动，不做全局路径替换。[VERIFY: matcha-agent/app-server/src/config/mod.rs:210-232] [VERIFY: matcha-agent/app-server/src/session/dispatch.rs:233-258] [VERIFY: matcha-agent/app-server/src/session/record.rs:19-43,270-281] [VERIFY: matcha-agent/app-server/src/session/history.rs:287-313,353-380] [VERIFY: matcha-agent/src/utils/sessionStorage.ts:199-225,437-439,1070-1088]

本机新根发布与真实 Server 的 3 条会话只读恢复检查已完成；真实模型 resume、UI、跨平台仍未验。文件/逐表保全、原生路径重定位、临时失败与检查详情单列于 [Integration 验证账](../../../docs/architecture-knowledge/modules/openclaw-matcha-integrations/dev.md#2026-10-18-matcha-agent-家目录统一--验证边界)；迁移工具仅为本机临时工具，不进入仓库或产品启动链。
