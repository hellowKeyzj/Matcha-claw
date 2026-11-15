# Debugging Playbook

本文是 MatchaClaw 定位类任务的团队规范。它服务于问题定位、故障修复、异常行为分析和回归排查：先帮助工程师建立正确归因顺序，再决定修复落点。

它不是事故流水账，也不是替代 [CODING_CONSTITUTION.md](../../CODING_CONSTITUTION.md) 或 [layered-architecture.md](../architecture/layered-architecture.md) 的新架构事实来源。编码原则仍以 `CODING_CONSTITUTION.md` 为准；分层和依赖方向仍以 `docs/architecture/layered-architecture.md` 为准。

## 1. 使用规则

定位类任务开始规划前必须先读本文。

开始前判断中必须体现：

- 本次命中的 debugging principle / diagnostic pattern。
- 本次定位的最小复现边界或真实最小闭环。
- 第一轮验证如何证明问题归属。
- 哪些外层表象链路暂不作为第一优先级。

如果本文没有覆盖当前问题，不要强套旧 pattern；先按总原则定义最小闭环和归属验证，完成后再判断是否需要沉淀新 pattern。

## 2. 总原则

### P1. 真实闭环优先

不要先沿用户可见表象逐层猜。先定义真实调用方、真实协议、真实服务和真实结果。具体失败现象不能停留在 discussion；一旦进入 diagnosis 或 bugfix，必须先写出真实最小闭环。

推荐格式：

```text
真实调用方 X 通过协议 Y 调用服务 Z，并拿到结果 R。
```

### P2. 生产同款优先

优先使用生产同款 SDK、runtime、config、command、env 和 identity 复现问题。手写 probe 只能作为辅助，不能替代真实调用方验证。

### P3. 先证明归属，再改代码

每个发现必须先分类，再决定是否修：

- 诊断增强
- 外围症状
- 必要前置条件
- 稳定性修复
- 最终根因

发现一个真实问题不等于已经找到最终根因。

### P4. 协议问题读双方实现

遇到跨进程、跨 runtime 或跨协议问题时，必须同时读 client serialize / send / timeout 逻辑和 server parse / handle / response 逻辑。

适用协议包括但不限于 stdio、JSON-RPC、MCP、WebSocket、SSE、HTTP streaming、IPC、gateway RPC 和 provider SDK transport。

### P5. 修复落到真实失败边界

修复点必须落在真实失败边界。不要因为 UI、route 或 status projection 暴露了错误，就把协议、进程、identity 或 config 问题修到表象层。

### P6. 验证闭环必须证明行为恢复

验证不能只证明“没有报错”。必须证明真实调用方完成原本失败的业务闭环，并覆盖曾经走偏的关键假设。

### P7. 修复前读完整失败链路

进入 bugfix 前，必须读完当前失败边界涉及的真实入口、调用方、协议 / transport、owning workflow、状态事实源、下游返回和验证入口。不要只读报错行、UI 表象、单个 projection 或用户给出的修法就开始改。

## 3. Diagnostic Patterns

### DP-001 Integration status failure / unavailable result

#### Trigger

用户或系统看到某个具体失败现象：能力不可用、状态未知、等待中、调用失败、超时、返回空结果、结果被投影成失败，或无法证明下游连通；且该能力背后依赖 runtime、connector、provider、gateway、子进程或外部协议。

上游 runtime、worker、app-server 或 gateway 已经产出 completed / delivered / success，但产品层仍显示等待中、pending、streaming 或没有最终结果，也命中本 pattern。上游完成只是中间信号，不是产品闭环完成。

如果用户已经指定症状修法，例如去重、过滤、fallback、吞错、延长 timeout、替换 status 或 UI 掩盖，也仍然命中本 pattern。用户给出的修法只能作为假设，不能绕过归因。

#### First principle

bugfix 先归因，不修表象。先验证真实下游闭环，不先相信 UI/status/API/projection 表象，也不把用户指定的症状修法当成根因。

#### Real minimum loop

进入 diagnosis 或 bugfix 后，先用一句话写清真实最小闭环：

```text
真实调用方 X 通过协议 Y 调用服务 Z，并拿到结果 R。
```

其中 X 必须是真实入口或生产同款调用方，不是方便手写的 probe；Y 必须是实际协议、transport、SDK 或 IPC 边界；Z 必须是真实服务、runtime、connector、provider、gateway 或 owning workflow；R 必须是业务结果，不是 UI 文案、status 字符串或 projection 形状。

如果问题跨越 runtime / adapter / projection / renderer，R 必须写到最终产品状态，而不能停在上游完成信号。例如：`app-server run.completed` 只证明 app-server 完成；只有 `renderer pending cleared + assistant item visible + runtime activeRunId=null/runPhase=done` 才证明 chat turn 闭环完成。

如果写不出来，说明还没准备好讨论修法，更没准备好改代码。

#### First-round probes

第一轮验证必须落在最接近失败边界的一跳，目标是判断失败发生在调用前、传输中、服务侧、返回映射侧，还是表象投影侧。

1. 用生产同款 SDK/runtime/config/command/env/identity 直接调用真实最小闭环。
2. 如果真实调用方到服务之间有协议边界，读取并验证双方实现：client serialize/send/timeout 与 server parse/handle/response。
3. 验证子进程或外部 runtime 是否按同一 command/env/identity 启动。
4. 验证协议握手、请求 payload、响应 payload 和错误映射是否与真实调用方一致。
5. 如果事件跨越 runtime / adapter / projection，先冻结字段映射：外部 runtime session id → endpointSessionId → canonical sessionKey → renderer sessionKey；再验证每一跳实际 envelope 使用的字段名。
6. 验证业务结果 R 是否正确返回给真实调用方；跨到 renderer 的闭环必须验证最终产品状态，而不是只验证上游 completed。
7. 如果问题涉及队列、串行资源、agent session、worker job 或跨 runtime turn，分别写清 owning workflow 生命周期和下游 runtime/session 生命周期，并找出真正释放同一资源的 terminal signal。
8. 只有完成上述归属后，才回头解释 UI/API/status/projection 为什么表现为失败。

#### Attribution rule

只有当真实最小闭环失败，且能定位到调用前置条件、进程启动、协议握手、身份/config、业务处理、响应解析、返回映射或表象投影中的具体边界时，才开始修代码。

发现一个外围症状不等于完成归因。以下结论都不足以开修：UI 显示 unknown、status 变成 unavailable、projection 少字段、route 返回空、timeout 变长、日志里有 warning、用户提出“过滤一下”。

如果真实最小闭环成功，再查外层 route、store、projection、缓存或渲染；此时修复也必须落在被证明失败的外层边界，而不是倒回下游服务侧猜测。

#### Fix boundary rule

修复应落在已证明的失败边界：

- 调用前置条件缺失：修真实调用方或 owning workflow 的输入准备。
- 协议不匹配：修 protocol boundary。
- 进程启动错误：修 command/env/runtime resolver。
- config 陈旧：修 config projection / invalidation。
- identity 错配：修 identity mapping；跨 runtime 事件要修外部 session id / endpointSessionId / canonical sessionKey 的映射 owner，不要在 renderer 或 UI 文案层猜。
- 生命周期边界错配：修拥有调度、队列或资源占用事实的 workflow；不要把 tool call complete、submitted、delivered 当成下游 runtime/session turn 的 final/error/aborted。
- 服务侧业务结果错误：修 owning workflow/capability。
- 响应解析或返回映射错误：修 adapter/client mapping。
- 表象投影错误：修 route/store/projection/rendering 中被证明失败的一跳。

不得因为外层状态失败而优先修改 Renderer、route 或泛化 timeout。去重、过滤、fallback、吞错、延长 timeout、替换 status 和 UI 掩盖只有在它们本身就是被证明的真实失败边界时才允许作为修复；否则都属于绕过归因。

#### Verification closure

至少包含一个真实调用方闭环验证，以及必要的单元测试或边界测试。验证描述必须说明它证明了哪一个曾失败的环节。

验证必须证明真实闭环恢复：真实调用方 X 通过协议 Y 调用服务 Z，并拿到业务结果 R。只证明 UI 不再报错、status 变了、projection 字段存在、warning 消失或 timeout 变长，都不能作为 bugfix 完成证据。

对 runtime chat / session turn 接入，完成证据必须覆盖终端产品状态：上游 terminal event 已被 ingestion 接收，canonical lifecycle 投影为 final/error/aborted，runtime active state 被清空，renderer pending / streaming 状态结束，assistant result 可见。只证明 worker ready、app-server run.completed 或 gateway delivered 不足以宣告完成。

如果修复涉及串行资源、队列调度、agent session、worker job 或跨 runtime turn，验证必须覆盖同一资源连续排队和不同资源可并发两个方向：上游业务事件 complete/submitted/delivered 不应释放同一资源；只有下游 terminal signal 才能释放。

#### Common wrong paths

- 把具体失败现象停留在 discussion，只讨论 UI/status 表象，不写真实最小闭环。
- 先改 timeout。
- 先去重、过滤、fallback、吞错、替换 status 或用 UI 掩盖。
- 先加大量 UI/route 日志，却不验证最接近失败边界的一跳。
- 只测试我方 server 已知支持的 happy path。
- 只证明 status/projection/UI 变化，没有证明真实调用方拿到业务结果。
- 只证明上游 worker/app-server/gateway completed，没有证明 downstream ingestion、canonical lifecycle 和 renderer terminal state。
- 没有先冻结跨进程字段映射，把 `sessionId`、`endpointSessionId`、`sessionKey`、`sessionIdentity` 当成可互换字段。
- 把第一个真实问题当成最终根因。
- 把 owning workflow 的 complete/submitted/delivered 当成下游 runtime/session turn 的结束信号。
- 没读真实 SDK/runtime 的 serialize、spawn、timeout、parse 或 response mapping 实现。

#### Applies to

runtime integration、connector status、provider SDK、gateway RPC、MCP/stdin-stdout server、外部进程、worker、daemon、跨进程 IPC、session/runtime projection。

#### Does not apply to

纯 UI 排版、纯文案、已由单元测试最小复现的纯函数错误、无下游依赖的静态数据展示问题。

## 4. Case Cards

默认定位顺序由 Diagnostic Patterns 承载。完整案例只在仍会改变默认第一轮定位顺序时保留在本文主体；已被 pattern 覆盖的案例迁移到 [debugging-case-archive.md](./debugging-case-archive.md)。

### Case: Organization schema 升级被包装为 bootstrap 配置错误

#### Status

active

#### Source incident

2026-11-12，TeamRun 从节点累计预算改为批次／出口返工预算，SQLite schema 从 1 升至 2；用户启动开发应用后 Host 退出。

#### Symptom

只显示 `runtime-host bootstrap configuration is invalid`，外层随后报 `Runtime-host process failed`，无法区分配置、目录与组织数据版本。

#### Real minimum loop

Electron 发送 bootstrap → Host `into_parts` 打开 Organization SQLite → store 校 schema → 回报启动结果。现场只读 `PRAGMA user_version` 为 1，当前 store 明确拒绝 1 并返回 `MigrationRequired`；Host 将该错误映射为无来源的 `BootstrapError`。

#### Wrong path taken

只提供显式离线迁移命令，没有闭合已有用户的应用升级流程；又保留了用户已不需要的旧 log 探测／迁移入口。不能仅凭 bootstrap 文案认定 JSON 配置坏了，也不能让用户删除数据库或手改版本号。

#### Correct first-round plan

同时核 bootstrap producer／consumer、实际使用的存储路径、数据库版本与拒绝分支；只读现场版本，不启动 recovery 或重放 native effect。区分历史 log 是否被访问，不能因其曾存在就归因于它。

#### Fix boundary

升级责任属于 Organization store 的 schema 升级与原启动结果链，不在 Renderer 吞错。只保留 SQLite 运行路径；可机械迁移的结构与无法无损推导的新业务额度分开，后者需要明确策略，不静默换算或清历史。

#### Verification closure

现场 SQLite v1 与旧 log 不存在已只读确认；旧 log 生产恢复／迁移及启动探测已删除。当前仍只有 SQLite v1→v2 显式离线转换；自动升级、业务额度确认与真实应用恢复尚未实现／验收。随后用户明确表示未发布且无需保留数据，授权本次重置；确认Host未运行后仅删除Organization的state.sqlite／-wal／-shm，其他目录与native数据保留。该特定授权不构成默认删库策略，且未证明重置后应用已启动。

#### Reusable rule

schema 升级的交付包含已有数据的升级体验，而不只是新库可用。使用 DP-001 的真实入口／双方协议归因，保留足以定位具体拒绝边界的安全错误；结构迁移成功不等于业务语义可无损推导。

#### Applies to

持久化格式升级、bootstrap 统一错误及旧数据导致的启动失败。

#### Does not apply to

OpenClaw 启动未就绪时提前关闭的排除场景；也不授权自动修改用户数据库。

### Case: Windows Host PDB LIMIT 与运行期启动失败分层

#### Status

active

#### Source incident

2026-11-12，用户开发构建在最终 Host 链接报 `LNK1318: PDB LIMIT (12)`、Cargo101；此前已有独立的 Organization SQLite版本启动失败。

#### Real minimum loop

`pnpm dev` → `scripts/dev.mjs` → 原生build脚本 → Cargo／MSVC最终链接 → 复制dist → Electron启动。当前失败停在链接、尚未进入该次Host运行；只读E盘余0.240GiB，失败PDB为0.741GiB、header页4096，不将未完成产物当作成功二进制或“大于4GiB”的证据。

#### Correct first-round plan

先从最深层错误区分编译、链接、投递与运行；核失败产物、目标profile、实际linker参数和磁盘余量。LIMIT字样不能直接证明磁盘错误，低余量也不能支持无界重试、cargo clean或关闭所有调试信息。

#### Fix boundary

Host自身MSVC最终链接单点设置 `/PDBPAGESIZE:16384`，不向所有crate注入RUSTFLAGS、不新增构建入口；实际大Host重链与磁盘空间分别验证，不触业务库或dist。

#### Verification closure

Cargo metadata发现Host构建脚本；真实小规模MSVC链接产出的PDB页16384，脚本MSVC／GNU分支均通过、exit0／Job0，自有临时产物已清。E盘资源不足，完整Host重链与应用启动未验；此前schema自动升级仍未实现，两处不能相互替代验收。

#### Reusable rule

“起不来”先落到真实失败阶段；保留构建、投递、启动及业务恢复各自证据，未完成调试产物不证明成功，也不为恢复启动盲删缓存／数据。

#### Applies to

Windows MSVC PDB LIMIT、大型Rust Host链接失败、磁盘资源阻塞。

#### Does not apply to

证明本例LIMIT的唯一内部原因；该结论需资源恢复后的原大型链接验证，不能仅凭小载具或页大小推出。

### Case: Organization async 分派耗尽 Windows worker 栈

#### Status

active

#### Source incident

2026-11-14，真实同 Run 的 OpenClaw＋Matcha Agent 已完成三段文件交接；第二 Run 两侧 running 时请求取消，Host 退出，多个页面随后 unavailable。

#### Real minimum loop

Renderer `team.runCancel` → 原 capability／HTTP／CallScope → Organization command dispatcher → `run_cancel` → `run_native_lease` → Foundation mailbox send → native 取消与原 Store 结算。此次崩溃停在 lease 查询的 mpsc send poll 序言，尚未成功发送 RunCancel，不能归为两个 runtime 的 native abort 故障。

#### Root cause

同次 Windows Event、dump、匹配 EXE／PDB 与 PE unwind／反汇编确认：旧通用 Team async dispatcher 的 poll 单帧 963,680 字节，叠加 HTTP、审计、trace、capability 与 lease/send 耗尽实际 2 MiB worker 栈。future 搬运尺寸为 15,880 字节，不能用 future 本体大小代替 poll 栈帧；未发现本次由取消递归或 drop 递归触发的证据。

#### Correct first-round plan

先核故障工件与 PDB 身份、实际线程栈边界及最后业务阶段，再分别测构造／搬运、poll、drop 和同步嵌套累计。异步 await 不保证父 poll 先退栈；源码出现 Box 或旧符号消失也不证明峰值已经下降。

#### Fix boundary

在真实异质分派边界同步选择操作，各分支独立 future；构造同样需隔离，非内联闭包工厂应接收 `FnOnce() -> Future`，不能先构造全部分支 future 再传给装箱函数。首轮真实工件仍有352,216B同步构造帧，证明仅将每个 arm 写成 `Box::pin(async ...)` 不足以闭环。全局与 lane 状态在原 owner 生命周期内稳定持有，避免完整状态反复按值穿 Work／Completion；恢复／删除管线在 item 边界隔离。保留原 owner、准入、审计、trace、lease／slot、取消与 join，不普遍装箱、不新增 spawn，也不增线程栈或切 release 掩盖。[VERIFY: runtime-host/modules/organization/src/future.rs] [VERIFY: runtime-host/modules/organization/src/owner/handle.rs] [VERIFY: runtime-host/modules/organization/src/owner/actor.rs] [VERIFY: runtime-host/modules/organization/src/owner/native_operations.rs] [VERIFY: runtime-host/modules/organization/src/call/workflow.rs]

#### Verification closure

根因由原运行证据确认；第三轮同配置 dev 工件的 Team selector 构造帧6,552B、run_cancel poll5,768B、ManualTeamCreate trace poll248B（PE 口径不含返回地址）。按源码与机器 call target 核对的取消前置链固定帧小计281,920B，含返回地址但不是完整线程动态峰值。第四轮已撤回 TeamDelete 回流的 reserve／permit.send，恢复原 send_command 的准入与关闭竞争语义，同时把命令与发送 future 构造留在非内联工厂；当前匹配工件的 batch／removal item poll 分别1,608／1,288B，submit selector776B。第四轮 Clippy／Host build通过；原样回归切片仍83／84通过，唯一失败在精确修前亦复现；前轮完整库测试有156项编译错误，第四轮未重跑全库，详见 [Organization Dev Notes](../architecture-knowledge/modules/team-task-organization/dev.md)。未重启用户实例、部署 dist 或重放真实 cancel/delete；离线测量不能代替业务闭环。

#### Reusable rule

async 栈故障分别核 future 本体、构造／搬运、poll 与 drop，并计算同线程同步嵌套；运行期故障必须使用匹配工件，不能把离线帧改善写成实机验收。

#### Applies to

Rust 宽异步分派、泛型并发管线与多层 async 包装累计耗栈。

#### Does not apply to

要求所有 async 机械 Box／spawn，或据此归因 OpenClaw 启动未就绪时提前关闭的排除场景。

### Promoted case index

- [MCP schema 超大整数上限触发模型 502](./debugging-case-archive.md#case-mcp-schema-超大整数上限触发模型-502) — 新增/修改工具数值 schema，或裸 API 成功而带工具请求失败时，先核已有数值精度签名；2026-11-03 首次、2026-11-07 maintenance 复发，不能据此泛化所有 502。
- [OpenClaw MCP status timeout](./debugging-case-archive.md#case-openclaw-mcp-status-timeout) — DP-001 来源案例；关键教训是集成类状态失败先验证真实协议闭环，手写 probe 必须模拟真实调用方 SDK。
- [Matcha-agent app-server completed but UI pending](./debugging-case-archive.md#case-matcha-agent-app-server-completed-but-ui-pending) — DP-001 补充案例；关键教训是 runtime 接入完成证据必须到 renderer terminal state，不能停在上游 `run.completed`。

## 5. 新增 Diagnostic Pattern 模板

新增 pattern 必须使用以下字段，不得自由追加散文式复盘。

```md
### DP-xxx <Pattern name>

#### Trigger

#### First principle

#### Real minimum loop

#### First-round probes

#### Attribution rule

#### Fix boundary rule

#### Verification closure

#### Common wrong paths

#### Applies to

#### Does not apply to
```

## 6. 新增 Case Card 模板

真实案例只能作为 Case Card 进入本文；不得粘贴聊天记录、命令流水或长篇事故报告。

```md
### Case: <short name>

#### Status

active | promoted | archived

#### Source incident

#### Symptom

#### Surface path

#### Real minimum loop

#### Wrong path taken

#### Missed first probe

#### Root cause

#### Root cause boundary

#### Correct first-round plan

#### Fix boundary

#### Verification closure

#### Reusable rule

#### Applies to

#### Does not apply to
```

## 7. 迭代学习与规则沉淀

每次完成问题定位或故障修复后，必须判断本次是否暴露出可复用经验。

### 写入位置判断

- 如果是新的定位方法、归因顺序、probe 策略、复现策略或验证闭环，写入本文。
- 如果是已有 pattern 的补充，不新增案例，优先更新已有 Diagnostic Pattern。
- 如果是一次性项目细节，不写入长期文档。
- 如果是已被 pattern 覆盖但仍有追溯价值的案例，迁移到 [debugging-case-archive.md](./debugging-case-archive.md)，不留在本文主体。
- 如果是项目架构事实变化，更新 `docs/architecture/layered-architecture.md` 和相关 SVG。
- 如果是稳定编码原则变化，且不属于定位方法，建议沉淀到 `CODING_CONSTITUTION.md`。
- 如果是 `/code` 命令自身的流程缺口，建议更新 `.claude/commands/code.md`。
- 不得把聊天复盘、流水账、临时命令输出直接追加到本文。

### 新增经验门槛

新增经验必须满足至少一个条件：

1. 能改变下一次定位问题的第一轮排查顺序。
2. 能减少误判或无效修改。
3. 能明确某类问题的最小复现边界。
4. 能定义新的验证闭环。
5. 能防止把修复落到错误架构层。

不满足这些条件的内容，不进入本文。

### 收敛规则

- 能并入已有 pattern 的，不新增 pattern。
- 第二个相似 case 出现时，必须抽象或更新 Diagnostic Pattern。
- 被 pattern 覆盖的 case 应标记为 `promoted`，只保留短摘要；如果不再需要默认读取，迁移到 [debugging-case-archive.md](./debugging-case-archive.md)。
- 过期或一次性的 case 应标记为 `archived` 并迁移到 [debugging-case-archive.md](./debugging-case-archive.md)，不作为默认定位依据。
- 本文主体应以 principles 和 Diagnostic Patterns 为主，Case Cards 只保留能改变未来定位顺序的证据。
- 归档案例不能改变默认第一轮定位顺序；如果能改变，必须先回写本文的 Diagnostic Pattern。
