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

### Promoted case index

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
