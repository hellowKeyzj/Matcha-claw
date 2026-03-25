# 任务清单 - 聊天页虚拟列表重构（人话版）

状态：DONE

## 这份文档是干什么的

这份任务清单用来保证这次重构不是“边改边猜”。每一步都会写清楚：

- 这一步到底改什么
- 做完后能看到什么变化
- 先依赖什么
- 主要动哪些文件
- 怎么验证这一步不是假完成

## 状态说明

- `TODO`：还没开始
- `IN_PROGRESS`：正在做
- `BLOCKED`：被外部问题卡住
- `IN_REVIEW`：已经有结果，等复核
- `DONE`：已经完成，并且已经回写状态
- `CANCELLED`：取消，不做了，但要写原因

规则：

- 只有 `状态：DONE` 的任务才能勾选成 `[x]`
- `BLOCKED` 必须写清楚卡在哪里
- `CANCELLED` 必须写清楚为什么不做
- 每做完一个任务，必须立刻更新这里

## 阶段 1：先把模型和测试基线立住

- [x] 1.1 建立统一聊天行模型
  - 状态：DONE
  - 这一步到底做什么：把历史消息、流式消息、处理中提示、打字提示梳理成统一的 `ChatRow[]` 设计和代码入口，不再允许一半进虚拟列表、一半留在列表外面。
  - 做完你能看到什么：聊天页渲染时有一份明确的聊天行来源，后面所有滚动定位都能只看这份数据。
  - 先依赖什么：无
  - 开始前先看：
    - `requirements.md` 需求 2、需求 3
    - `design.md` §2.1「系统结构」
    - `design.md` §3.2「数据结构」
  - 主要改哪里：
    - `src/pages/Chat/index.tsx`
    - `src/pages/Chat/` 下新增的聊天行建模文件（如需要）
  - 这一步先不做什么：先不重写滚动逻辑，只把“谁算一条聊天行”这件事理清楚。
  - 怎么算完成：
    1. 历史消息和底部临时内容都能通过统一数据结构表达
    2. 不再需要靠额外 DOM 节点才能表达“最后一条”
  - 怎么验证：
    - 新增或更新 `ChatRow` 相关单元测试
    - 人工走查 `Chat` 页面不再同时维护两套底部内容来源
  - 对应需求：`requirements.md` 需求 2、需求 3
  - 对应设计：`design.md` §2.1、§3.2、§6.3

- [x] 1.2 把当前回归测试改成真正覆盖虚拟列表主路径
  - 状态：DONE
  - 这一步到底做什么：整理并补强测试，让“切会话到底部”“当前会话继续吸底”“用户上翻后停止吸底”都直接围绕虚拟列表行为断言。
  - 做完你能看到什么：后面重构时只要滚动语义偏了，测试会第一时间失败。
  - 先依赖什么：1.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2、需求 4
    - `design.md` §2.3「关键流程」
    - `design.md` §7.1、§7.2
  - 主要改哪里：
    - `tests/unit/chat-scroll-bottom.test.ts`
    - `tests/unit/chat-session-switch-ux.test.tsx`
  - 这一步先不做什么：先不为未来功能写超前测试，只锁定本次重构必须守住的主路径。
  - 怎么算完成：
    1. 三条主路径都有明确测试
    2. 测试命名和断言能直接说明滚动语义
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-scroll-bottom.test.ts tests/unit/chat-session-switch-ux.test.tsx`
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 4
  - 对应设计：`design.md` §2.3、§7.1、§7.2

### 阶段检查

- [x] 1.3 阶段检查：确认虚拟列表输入已经单一化
  - 状态：DONE
  - 这一步到底做什么：检查聊天页是不是已经用统一聊天行模型作为后续滚动控制的唯一输入。
  - 做完你能看到什么：可以进入滚动控制重构，而不是带着混合输入继续往前做。
  - 先依赖什么：1.1、1.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：本阶段涉及的聊天页和测试文件
  - 这一步先不做什么：不开始做时序优化，不加新 UI。
  - 怎么算完成：
    1. 聊天行模型已经能表达末尾所有内容
    2. 测试已经能覆盖虚拟列表主路径
  - 怎么验证：
    - 人工走查
    - 本阶段测试命令通过
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3、需求 4
  - 对应设计：`design.md` §2.1、§3.2、§7.1、§7.2

## 阶段 2：重写滚动控制语义

- [x] 2.1 用显式滚动状态替换分散的 ref + effect 逻辑
  - 状态：DONE
  - 这一步到底做什么：把聊天页里“切会话到底部”“当前会话 sticky bottom”“末尾追加后待同步”整理成明确状态，不再靠多个分散 effect 拼结果。
  - 做完你能看到什么：滚动逻辑能用少量明确状态解释，不需要继续靠补帧猜测浏览器时序。
  - 先依赖什么：1.3
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2
    - `design.md` §3.3.2「chatScrollMachine(...)」
    - `design.md` §4.2「状态流转」
  - 主要改哪里：
    - `src/pages/Chat/index.tsx`
    - `src/pages/Chat/` 下新增的滚动控制文件（如需要）
  - 这一步先不做什么：先不做额外性能优化，也不动 store 协议。
  - 怎么算完成：
    1. 切会话和当前会话滚动语义都能由显式状态解释
    2. 旧的临时时序补丁被删掉或降到最小
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-scroll-bottom.test.ts tests/unit/chat-session-switch-ux.test.tsx`
    - 代码走查，确认没有再靠多段 `requestAnimationFrame` 猜测结果
  - 对应需求：`requirements.md` 需求 1、需求 2
  - 对应设计：`design.md` §3.3.2、§4.2、§6.1、§6.2

- [x] 2.2 改成由虚拟列表 `onChange(...)` 驱动底部同步
  - 状态：DONE
  - 这一步到底做什么：把底部定位挂到虚拟列表自身的测量/范围更新回调上，让“滚到底部”发生在虚拟列表确认尺寸之后。
  - 做完你能看到什么：吸底不再依赖普通 DOM 底部锚点或双帧补丁，而是建立在虚拟列表自己的更新时机上。
  - 先依赖什么：2.1
  - 开始前先看：
    - `requirements.md` 需求 1、需求 2、需求 3
    - `design.md` §2.3.1、§2.3.2
    - `design.md` §5.3「处理策略」
  - 主要改哪里：
    - `src/pages/Chat/index.tsx`
    - `src/pages/Chat/` 下的滚动控制或虚拟列表封装文件
  - 这一步先不做什么：不把审批 dock 强行并入聊天行，除非验证确实需要。
  - 怎么算完成：
    1. 底部同步由虚拟列表回调消费待处理意图
    2. `scrollIntoView(...)` 不再承担主定位职责
  - 怎么验证：
    - 相关单元测试和页面测试通过
    - 人工检查代码路径只剩一套主定位模型
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3
  - 对应设计：`design.md` §2.3.1、§2.3.2、§3.3、§5.3、§6.3

### 阶段检查

- [x] 2.3 阶段检查：确认滚动语义已经可直接解释
  - 状态：DONE
  - 这一步到底做什么：检查聊天页现在是不是已经能直接回答“为什么这次会吸底 / 不吸底”，而不是只能看 effect 时序。
  - 做完你能看到什么：滚动行为的解释成本明显下降，可以进入清理和验收阶段。
  - 先依赖什么：2.1、2.2
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：聊天页相关实现与测试文件
  - 这一步先不做什么：不再补新能力。
  - 怎么算完成：
    1. 主链路行为都能通过状态和流程解释
    2. 旧的混合滚动模型已经清掉
  - 怎么验证：
    - 人工走查
    - 关键测试命令通过
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3
  - 对应设计：`design.md` §2.3、§4.2、§6.1、§6.2、§6.3

## 阶段 3：清理、验证和交接

- [x] 3.1 清理旧滚动补丁并补足说明
  - 状态：DONE
  - 这一步到底做什么：删掉不再需要的底部锚点主逻辑、重复 helper 和无效状态，把最终模型写清楚。
  - 做完你能看到什么：聊天页代码比现在更短、更集中，后续开发者能更快理解。
  - 先依赖什么：2.3
  - 开始前先看：
    - `requirements.md` 全文
    - `design.md` §3、§4、§5
  - 主要改哪里：
    - `src/pages/Chat/index.tsx`
    - 可能新增的 `src/pages/Chat/*` 辅助文件
    - 本 Spec 文档（如需要同步）
  - 这一步先不做什么：不趁机重做聊天页其它 UI。
  - 怎么算完成：
    1. 旧的时序补丁已经删除
    2. 剩余 helper 和状态命名能直接表达语义
  - 怎么验证：
    - 代码走查
    - 相关测试全通过
  - 对应需求：`requirements.md` 需求 2、需求 3、需求 4
  - 对应设计：`design.md` §3.1、§3.3、§5.3、§7.4

- [x] 3.2 最终检查点
  - 状态：DONE
  - 这一步到底做什么：确认这次重构真的把聊天页滚动模型收敛了，而不是只是换了一批新补丁。
  - 做完你能看到什么：需求、设计、代码和测试可以一一对上，后续接手的人能快速理解。
  - 先依赖什么：3.1
  - 开始前先看：
    - `requirements.md`
    - `design.md`
    - `tasks.md`
  - 主要改哪里：当前 Spec 全部文件和聊天页相关实现
  - 这一步先不做什么：不再追加新需求。
  - 怎么算完成：
    1. 关键路径测试已通过
    2. 类型检查通过
    3. 主要风险和剩余待确认项已记录
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-scroll-bottom.test.ts tests/unit/chat-session-switch-ux.test.tsx`
    - `pnpm run typecheck`
    - 按 Spec 文档逐项人工核对
  - 对应需求：`requirements.md` 全部需求
  - 对应设计：`design.md` 全文

## 阶段 4：重构成健壮滚动模型（本轮）

- [x] 4.1 先用失败测试复现“点击左侧会话仍停在旧消息位置”
  - 状态：DONE
  - 这一步到底做什么：补一个覆盖真实点击链路的失败测试，至少覆盖“点击左侧 `AGENT` 后，聊天页必须落到当前会话最新消息底部”，并让测试不再依赖理想化微任务时序。
  - 做完你能看到什么：当前实现会明确失败，证明问题已经被自动化复现。
  - 先依赖什么：现有 Spec 与聊天页重构上下文
  - 主要改哪里：
    - `tests/unit/chat-session-switch-ux.test.tsx` 或新增更贴近真实点击链路的测试文件
    - `tests/unit/agent-sessions-pane.test.tsx`（如需要联动）
  - 这一步先不做什么：先不改生产代码。
  - 怎么算完成：
    1. 失败测试直接描述真实用户路径
    2. 失败原因是“没有落到最新消息底部”，而不是测试环境拼装错误
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-agent-click-scroll.test.tsx`
  - 对应需求：`requirements.md` 需求 1、需求 4、非功能需求 3

- [x] 4.2 引入滚动状态机和命令消费模型
  - 状态：DONE
  - 这一步到底做什么：新增纯 reducer/纯函数，把 `opening/sticky/detached` 和 `open-to-latest/follow-append` 这些语义从页面 effect 中抽出来。
  - 做完你能看到什么：滚动语义可以直接解释，不再靠零散的本地补丁状态去拼结果。
  - 先依赖什么：4.1
  - 主要改哪里：
    - `src/pages/Chat/` 下新增 `chat-scroll-machine.ts`
    - `tests/unit/` 下新增对应纯函数测试
  - 这一步先不做什么：先不调整 UI 布局。
  - 怎么算完成：
    1. 会话切换和末尾追加都能转成明确事件
    2. 状态机能表达“命令 pending，直到确认完成”
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-scroll-machine.test.ts tests/unit/chat-scroll-bottom.test.ts`
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3

- [x] 4.3 用 orchestrator 替换当前脆弱的滚动控制 hook
  - 状态：DONE
  - 这一步到底做什么：把聊天页改成“统一时间线模型 + 状态机 + orchestrator”的结构，只有当视口和 virtualizer 条件满足时才消费命令，并在成功确认前持续重试。
  - 做完你能看到什么：点击左侧 `AGENT`、点击左侧会话、当前会话新增消息三条路径都走同一套滚动命令模型。
  - 先依赖什么：4.2
  - 主要改哪里：
    - `src/pages/Chat/index.tsx`
    - `src/pages/Chat/useChatScrollOrchestrator.ts`
    - `src/pages/Chat/chat-scroll-machine.ts`
    - `src/pages/Chat/chat-row-model.ts`（按需要微调）
  - 这一步先不做什么：不回退全量消息渲染，不动 chat store 协议。
  - 怎么算完成：
    1. 打开会话到底部不再依赖单次幸运 `onChange(...)`
    2. 当前会话内吸底和用户上翻语义保持不变
    3. 虚拟列表仍然是唯一渲染主路径
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-agent-click-scroll.test.tsx tests/unit/chat-session-switch-ux.test.tsx`
    - 代码走查确认没有回退为全量消息渲染
  - 对应需求：`requirements.md` 需求 1、需求 2、需求 3、非功能需求 1

- [x] 4.4 验证“性能不退化”并回写文档
  - 状态：DONE
  - 这一步到底做什么：确认聊天页仍保留虚拟列表，不把正确性修复建立在撤销性能优化之上，并把实现结果同步回 Spec/CHANGE。
  - 做完你能看到什么：这轮重构既修滚动语义，也明确守住性能边界。
  - 先依赖什么：4.3
  - 主要改哪里：
    - `spec/001-chat-virtual-list-refactor/*.md`
    - `CHANGE.md`
  - 这一步先不做什么：不追加额外功能。
  - 怎么算完成：
    1. 测试与类型检查通过
    2. 文档里明确记录“未回退全量渲染”
  - 怎么验证：
    - `pnpm test -- tests/unit/chat-scroll-machine.test.ts tests/unit/chat-agent-click-scroll.test.tsx tests/unit/chat-scroll-bottom.test.ts tests/unit/chat-session-switch-ux.test.tsx`
    - `pnpm run typecheck`
  - 对应需求：`requirements.md` 非功能需求 1、非功能需求 3
