# 存储与迁移

用于 newer schema、no such table/column、SQLite locked、迁移阻断或数据疑似损坏。先用 maintenance inspect 看有界只读元数据/shape，再与同次 status/logs 对照；没有真实证据不认定数据库就是根因。

## 先确认文件角色，不先比较数字

以下仅是默认布局地图，实际目标以 inspect 的应用 state、配置与 Agent 发现结果为准，不据此直接访问文件。

| 对象 | 默认相对位置/性质 | 维护含义 |
|---|---|---|
| 共享库 | `<state>/state/openclaw.sqlite` | 共享控制面、配置机器状态、cron、审批、配对等 canonical 数据，不是 cache。 |
| Agent 库 | `<state>/agents/<id>/agent/openclaw-agent.sqlite` | 会话、原始 transcript、认证与派生索引混存；agentDir/session store 可外置，默认目录扫描不等于覆盖所有数据。 |
| 插件/隔离库 | 各 owner 自有路径 | 自有 schema/ledger，不能套共享或 Agent 的版本号；未覆盖者明确未检查。 |
| 旧 JSON/JSONL | sessions、auth、cron 等旧文件 | 多数是迁移材料；存在不等于当前权威，更不能当 SQLite 故障后的运行 fallback。 |
| memory/vector | Agent 派生表、独立插件存储等 | FTS/vec 可能可重建，但原始记忆、LanceDB 数据、origins、tombstones 与 canonical sessions 不是可删索引。 |

package version 是发行身份；包声明的 `schemaVersions.state/agent` 是各角色支持值，不是“所有 DB 都必须等于该数”。不要将研究基线版本或默认路径硬编码成现场结论。

可见时分别读 `user_version`、primary schema_meta 的 role/agent_id/schema_version/app_version，以及共享库 contentVersion。写入构建戳 app_version 不要求永远等于当前包版本；共享有效内容版本也可能高于已发布 marker。合法延迟发布不等于允许手工对齐数字。

## 读检查的边界

inspect 只返回实际覆盖的元数据/shape 与安全摘要，不读取凭据/会话正文，不执行任意 SQL，不创建缺失库、不迁移、不加载扩展、不 checkpoint/VACUUM。SQLite 使用原生只读、WAL-aware 连接；不写数据库内容，但 SQLite 可能创建或维护协调 sidecar，不承诺文件系统零写。有界 shape 检查不是完整原生 schema oracle、全库 integrity/FK 检查、备份或迁移演练；不把“inspect 成功”称数据库完全健康。

同号 marker 不证明表列完全相同；有些表/nullable 列按需创建。缺表列必须区分目标选错、role 错、可延迟项、未完成迁移与 canonical drift，不能从一条错误猜 DDL 手补。

需要原生 findings 时，可在说明影响并获相应授权后直接调用捆绑 CLI 的 `doctor --lint --json`，不是 repair、备份、迁移演练或全库完整性检查。默认 runtime-tool-schemas 可创建临时 SQLite/state 快照、启动配置的 MCP runtime，provider checker 会执行插件代码；不承诺零写入或零外部副作用，不每次自动执行。exit 1 可能包含 findings，也可能运行失败，结合 JSON 判读；超时/截断不算检查完成，清理未确认不代表资源已回收。不追加 --fix、--all、--allow-exec 或任意 SQL；三平台调用方式见[运行故障](runtime.md#原生-cli-诊断三平台)。

## 按错误分流

| 签名 | 判断与停止线 |
|---|---|
| `no such table` / `no such column` | 对照实际 role、Agent、包支持值和已覆盖 shape；optional 缺失不等于损坏。由对应原生 owner 处理，不创建空表或空库压掉错误。 |
| `uses newer schema version` | 核具体库角色、有效版本与真实安装；需要兼容构建或已验证的迁移前恢复点。不降 marker、不让旧 Doctor 写新库，不承诺 repair 可向下迁移。 |
| marker/role/Agent 归属不一致 | 保留原件与错误，查历史和实际 owner；禁止改 agent_id、schema_meta 或 content marker 冒充迁移。 |
| `SQLITE_BUSY` / `SQLITE_LOCKED` | 查同次维护/真实 writer 归属，文件存在本身不证明死锁；不删 WAL/SHM/锁、不杀未知进程、不反复抢 repair。 |
| readonly / disk full / I/O error | 区分权限、空间、挂载与存储错误；I/O error 本身不证明磁盘满，更不证明 corruption。维护工具没有任意系统修复能力。 |
| `SQLITE_CORRUPT` / `SQLITE_NOTADB` | 停在保全与人工恢复分支；先协调停止写入并保留原件/sidecar，由有能力的 owner 验证恢复点，不继续 start/restart/repair 碰运气。当前工具无 stop/备份/恢复 action，明确需用户/应用支持处理。 |
| SQLite unsafe/unavailable / native binding / ABI | 检查真正执行 Gateway 的应用 Electron/Node/SQLite 兼容性；系统 node/sqlite3 正常不是证明，迁移数据不能补运行时依赖。 |
| fts5 / sqlite-vec / embedding index | 区分引擎/扩展、派生索引和原始来源；召回降级不代表整个 Agent 库可重建。无定向 owner 工具就不执行 reset/index。 |

## repair 能做什么，不能承诺什么

有证据表明是现有 Doctor 支持的启动阻断，且用户已具体授权停机与配置/状态变更、必要恢复条件明确时，才由 maintenance repair 调应用既有链。它可能执行受支持的迁移，但不是任意 SQL、通用迁移器、损坏库恢复器、插件升级器或备份创建工具。

跨共享库/多个 Agent/插件的升级不是一个 ACID 大事务；部分已提交后降包不会撤销变更。不因 repair 受理就认定所有库升级完成；保留阶段与 Doctor 结果，再由兼容应用读回 status/inspect/logs。仍被 newer、归属冲突、未知依赖或人工恢复门阻断时停止，不无限重复。

## 数据保全原则

- WAL/SHM/journal 与锁是事务/生命周期材料，不是 cache。活跃主文件的简单复制不是 WAL-aware 一致副本；不要把 immutable 模式强套 live WAL 库。
- 恢复点需覆盖实际共享/Agent/session store、插件、配置/凭据与文件资产，外置 workspace/store 也可能仍指向原件。单库、config-only 或脱敏快照不等于完整回退点。
- 备份/恢复须由有能力的 owner 在另行授权下完成，核保密、空间、停写、目标与可恢复性；maintenance 没有对应 action，不声称已备份，不以 shell 补齐。先确认必要保全条件，否则不开始数据风险修复。
- 不 DROP 表、删库、改版本数字/写入戳、删 quarantine，或把 redacted 结果覆盖真实数据。只重建由 owner 明确标为 derived 的内容也仍需适配入口与授权。
- 最终需兼容 owner 接受必要数据、原阻断消失且应用原功能恢复；未检查的 integrity、外置 store、插件或恢复点明确列出。工具未覆盖不等于它们已坏或已通过。

上游资料中的 database preflight 针对合法取得的 standalone 共享库副本，不是所有 Agent/插件库通用验证；migrate 是跨其他助手系统导入，不是 SQLite schema 升级器。两者均不是本 Skill 可额外调用的 maintenance action。
