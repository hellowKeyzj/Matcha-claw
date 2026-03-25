# 设计文档 - 聊天页虚拟列表重构

状态：DONE

## 1. 概述

### 1.1 目标

- 让聊天页滚动行为完全建立在虚拟列表模型之上，不再混用普通 DOM 列表时期的定位手段
- 把“切会话到底部”和“当前会话 Sticky Bottom”写成明确语义，而不是靠多个 effect 的执行顺序推断
- 保留虚拟列表带来的长会话性能收益，同时降低滚动逻辑的回归概率
- 把“性能不退化”写成显式验收边界：不回退全量消息渲染，不引入新的整页级重复渲染热点

### 1.2 覆盖需求

- `requirements.md` 需求 1
- `requirements.md` 需求 2
- `requirements.md` 需求 3
- `requirements.md` 需求 4

### 1.3 技术约束

- 后端：不改 OpenClaw Gateway RPC 和事件协议
- 前端：React 19、TypeScript、Zustand、`@tanstack/react-virtual`
- 数据存储：沿用现有 chat store 的消息与会话快照
- 认证授权：不涉及
- 外部依赖：`@tanstack/react-virtual` 的 `scrollToIndex(...)` 与浏览器 `ResizeObserver`

## 2. 架构

### 2.1 系统结构

本次重构只在渲染层完成，结构分成三层：

1. **聊天运行时层**
   由 `useChatStore` 提供当前会话的历史消息、流式消息、发送状态和会话切换结果。
2. **聊天行建模层**
   在聊天页内部先把“历史消息 + 底部临时内容”整理成统一的 `ChatRow[]`。
3. **虚拟滚动控制层**
   由滚动状态机和虚拟列表执行器共同决定什么时候滚到底部、什么时候停止自动吸底。

数据流方向固定为：

`chat store -> ChatRow 建模 -> ChatScrollMachine -> useVirtualizer -> 视口`

### 2.2 模块职责

| 模块 | 职责 | 输入 | 输出 |
| --- | --- | --- | --- |
| `useChatStore` | 提供会话消息和运行时状态 | Gateway 事件、历史加载、会话切换 | 当前会话消息、流式状态、发送状态 |
| `ChatRow builder` | 把历史消息和临时底部内容转成统一聊天行 | `messages`、`streamingMessage`、`sending`、`pendingFinal` 等 | `ChatRow[]` |
| `ChatScrollMachine` | 维护 `opening/sticky/detached` 模式和待执行滚动命令 | `ChatRow[]`、`currentSessionKey`、视口状态、滚动事件 | 当前滚动模式、待消费命令 |
| `ChatScrollOrchestrator` | 把状态机命令和 virtualizer/viewport 接起来，直到命令真正完成 | `ChatScrollMachine` 状态、virtualizer、viewport | 滚动执行、命令完成确认 |
| `Chat page` | 组合渲染视口、虚拟列表和输入区 | `ChatRow[]`、滚动控制结果 | 稳定的聊天页 UI |

### 2.3 关键流程

#### 2.3.1 打开会话到最新消息

1. 用户在左侧点击一个会话，store 切换 `currentSessionKey`
2. 聊天页根据新会话消息构建新的 `ChatRow[]`
3. 滚动状态机进入 `opening`，并生成 `open-to-latest` 待执行命令
4. 视口挂载、虚拟列表测量、聊天行更新都会驱动 orchestrator 尝试执行该命令
5. 只要还没有确认到达最新聊天行底部，该命令就保持待消费状态，不依赖某一次 `onChange(...)` 恰好成功
6. 只有在确认视口已经回到底部附近后，才清空这次 `open-to-latest` 命令

#### 2.3.2 当前会话内继续吸底

1. 用户原本位于底部附近，`isStickyBottom = true`
2. 新消息、流式消息或处理中提示导致 `ChatRow[]` 末尾发生变化
3. 滚动状态机生成 `follow-append` 待执行命令
4. orchestrator 在 virtualizer 和 viewport 都可用时执行底部定位
5. 如果用户期间已经向上滚动离开底部附近，则取消这次同步

#### 2.3.3 用户上翻历史后停止自动吸底

1. 用户主动滚动视口离开底部阈值
2. 滚动状态机切到 `detached`
3. 后续即使列表末尾新增聊天行，也不会自动滚动到底部
4. 只有当用户重新回到底部附近，或重新打开会话时，才恢复自动吸底

## 3. 组件和接口

### 3.1 核心组件

覆盖需求：1、2、3、4

- `ChatRow builder`：统一生产虚拟列表真正渲染的聊天行
- `ChatScrollMachine`：统一表达滚动语义
- `ChatScrollOrchestrator`：统一消费滚动命令
- `Chat viewport`：只负责渲染视口和转发真实用户滚动事件

### 3.2 数据结构

覆盖需求：1、2、3

#### 3.2.1 `ChatRow`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `key` | `string` | 是 | 虚拟列表稳定 key | 同一会话内唯一 |
| `kind` | `'message' \| 'streaming' \| 'activity' \| 'typing'` | 是 | 聊天行类型 | 只允许白名单枚举 |
| `message` | `RawMessage \| null` | 否 | 历史消息或流式消息内容 | `kind='message'/'streaming'` 时可用 |
| `streamingTools` | `ToolStatus[] \| undefined` | 否 | 流式工具状态 | 仅 `kind='streaming'` 使用 |
| `timestamp` | `number \| null` | 否 | 该行的时间信息 | 允许为空 |

#### 3.2.2 `ChatScrollState`

| 字段 | 类型 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- | --- |
| `mode` | `'opening' \| 'sticky' \| 'detached'` | 是 | 当前滚动模式 | 会话切换默认 `opening` |
| `command` | `'open-to-latest' \| 'follow-append' \| 'none'` | 是 | 当前待执行滚动命令 | 未确认完成前不可丢失 |
| `lastRowKey` | `string \| null` | 是 | 上一次已确认的末尾聊天行 key | 用于判断末尾是否变化 |
| `rowCount` | `number` | 是 | 当前聊天行数量 | 用于识别末尾追加与 streaming 稳定更新 |
| `viewportReady` | `boolean` | 是 | 视口是否已挂载且可读尺寸 | 未 ready 时不能消费命令 |
| `isNearBottom` | `boolean` | 是 | 当前视口是否位于底部阈值内 | 只反映当前位置，不直接代表用户意图 |

### 3.3 接口契约

覆盖需求：1、2、3、4

#### 3.3.1 `buildChatRows(...)`

- 类型：Function
- 路径或标识：`Chat/buildChatRows`
- 输入：历史消息、流式消息、发送状态、工具状态、审批等待状态
- 输出：按渲染顺序排好的 `ChatRow[]`
- 校验：
  - 同一个渲染周期内 `key` 必须稳定
  - 临时底部内容只能通过 `kind` 扩展，不允许再单独渲染到虚拟列表外部
- 错误：
  - 输入为空时返回空数组
  - 非法 `kind` 不进入输出

#### 3.3.2 `chatScrollMachine(...)`

- 类型：Function / Reducer
- 路径或标识：`Chat/chatScrollMachine`
- 输入：当前状态 + 领域事件（切会话、聊天行变化、视口位置变化、用户主动脱离底部、命令完成）
- 输出：
  - 当前滚动模式
  - 当前待执行命令
- 校验：
  - 只允许通过真实用户输入触发的脱离事件切换 `sticky/detached`
  - 切会话后默认进入 `opening + open-to-latest`
  - 命令只有在确认到底部成功后才能消费
- 错误：
  - 非法事件组合必须保持幂等，不得生成无意义命令

#### 3.3.3 `useChatScrollOrchestrator(...)`

- 类型：Function / Hook
- 路径或标识：`Chat/useChatScrollOrchestrator`
- 输入：`ChatScrollState`、`ChatRow[]`、虚拟列表实例、视口元素、内容容器元素
- 输出：
  - 绑定给视口的滚动处理函数
  - 绑定给视口的用户输入标记函数
  - 绑定给 virtualizer 的更新处理函数
  - 一次次尝试消费当前命令，直到确认成功
- 校验：
  - 视口未 ready 或行列表为空时不能消费命令
  - 不允许把程序化滚动产生的中间 `scroll` 误判成用户上翻
  - 不允许依赖某一次幸运 `onChange(...)` 才能完成打开到底部
  - 命令成功后必须显式回写 machine，而不是隐式依赖局部 ref 清空
- 错误：
  - 空列表时不调用 `scrollToIndex(-1, ...)`
  - 内容高度还在变化时保持命令 pending，等待 virtualizer 更新或 `ResizeObserver` 再次触发

## 4. 数据与状态模型

### 4.1 数据关系

- `RawMessage[]` 是业务事实
- `ChatRow[]` 是渲染派生数据，不回写 store
- `ChatScrollState` 是页面本地滚动控制状态，不进入持久化

三者关系固定为：

`RawMessage[] -> ChatRow[] -> ChatScrollState -> Orchestrator 执行滚动`

### 4.2 状态流转

| 状态 | 含义 | 进入条件 | 退出条件 |
| --- | --- | --- | --- |
| `Opening` | 会话切换后等待首屏落到最新消息 | `currentSessionKey` 改变 | 确认回到底部附近 |
| `Sticky` | 用户希望跟随最新消息 | 初始进入会话；用户滚回底部附近；`Opening` 成功完成 | 用户主动上翻离开底部阈值 |
| `Detached` | 用户正在查看历史，不跟随最新消息 | 用户主动上翻离开底部阈值 | 用户滚回底部附近；重新打开会话 |
| `OpenToLatest` | 打开会话后的待执行命令 | `Opening` 模式产生 | 确认到底部成功 |
| `FollowAppend` | 底部附近追加消息后的待执行命令 | `Sticky` 下末尾行变化 | 确认到底部成功 |

## 5. 错误处理

### 5.1 错误类型

- `ViewportMissing`：视口节点尚未挂载
- `VirtualizerNotReady`：虚拟列表还未产出有效 item 或 total size
- `RowModelDrift`：底部临时内容未进入统一聊天行模型

### 5.2 错误响应格式

这次重构不新增用户可见错误格式。错误以开发期日志和测试失败为主。

```json
{
  "detail": "chat virtual scroll state invalid",
  "error_code": "CHAT_VIRTUAL_SCROLL_INVALID_STATE",
  "field": "command.type",
  "timestamp": "2026-03-25T00:00:00Z"
}
```

### 5.3 处理策略

1. 输入验证错误：构建 `ChatRow[]` 时过滤非法行，不让无效数据进入虚拟列表
2. 业务规则错误：如果同时出现“列表外临时行”和“列表内末尾定位”，测试必须直接失败
3. 外部依赖错误：虚拟列表实例未就绪时保持命令 pending，等待下一次条件满足
4. 重试、降级或补偿：不使用多段 `requestAnimationFrame` 猜测时序，统一由 command pending + `onChange(...)` / `ResizeObserver` 条件重试驱动

## 6. 正确性属性

### 6.1 属性 1：会话切换首屏一致性

*对于任何* 已有历史消息的会话，系统都应该满足：每次打开该会话时，首屏定位语义一致，默认落在最新聊天行底部。

**验证需求：** `requirements.md` 需求 1

### 6.2 属性 2：用户滚动意图优先于布局抖动

*对于任何* 列表高度变化，只要用户没有通过真实输入主动离开底部附近，系统都应该继续保持 Sticky Bottom；只要用户主动上翻，系统都不应自动覆盖该意图。

**验证需求：** `requirements.md` 需求 2

### 6.3 属性 3：滚动定位只有一个坐标系

*对于任何* 聊天底部定位操作，系统都应该满足：定位依据来自统一的 `ChatRow[]` 末尾索引，而不是混用虚拟列表索引和额外 DOM 底部锚点。

**验证需求：** `requirements.md` 需求 3

### 6.4 属性 4：性能不回退

*对于任何* 长会话或持续 streaming 更新，系统都应该满足：仍使用虚拟列表渲染可视区附近聊天行，不把滚动正确性修复建立在全量消息渲染回退上。

**验证需求：** `requirements.md` 非功能需求 1

## 7. 测试策略

### 7.1 单元测试

- `buildChatRows(...)` 是否正确把历史消息和临时底部行合并成统一顺序
- `chatScrollMachine(...)` 是否正确维护 `opening/sticky/detached` 和待执行命令
- orchestrator 是否在条件满足前保持命令 pending，而不是依赖一次 lucky `onChange(...)`
- 程序化滚动经过旧位置时，是否不会误触发 `USER_DETACHED`

### 7.2 集成测试

- 切换会话后是否稳定打开到最新消息底部
- 当前会话位于底部附近时，追加新消息或流式消息后是否继续吸底
- 用户离开底部附近后，追加消息是否不会强拉回底部
- 点击左侧 `AGENT` 与点击左侧 `智能体会话` 两条真实入口是否都落到当前会话最新消息底部

### 7.3 端到端测试

- 长会话下切换 agent、发送消息、接收流式回复的完整主链路
- 历史消息较长时滚动到中段，再切到其它会话再切回，是否仍然默认显示最新消息

### 7.4 验证映射

| 需求 | 设计章节 | 验证方式 |
| --- | --- | --- |
| `requirements.md` 需求 1 | `design.md` §2.3.1、§4.2、§6.1 | `chat-session-switch-ux` 回归测试 |
| `requirements.md` 需求 2 | `design.md` §2.3.2、§2.3.3、§4.2、§6.2 | `chat-scroll-bottom` 与页面级吸底测试 |
| `requirements.md` 需求 3 | `design.md` §3.2、§3.3、§6.3 | `ChatRow` 建模测试和代码走查 |
| `requirements.md` 需求 4 | `design.md` §7.1、§7.2 | 测试文件新增与稳定性验证 |
| `requirements.md` 非功能需求 1 | `design.md` §1.1、§6.4、§7.2 | 保留 virtualizer 渲染路径 + 不回退全量渲染的代码走查与测试 |

## 8. 风险与待确认项

### 8.1 风险

- 当前聊天页文件过大，若不先拆出 `ChatRow builder` 和滚动控制器，重构后仍然会难维护
- 流式消息和工具状态本来是列表外 DOM，如果迁移成统一聊天行时边界没写清，会出现重复渲染或漏渲染
- 若继续保留 `scrollIntoView(...)` 作为主路径，重构目标会再次被破坏

### 8.2 待确认项

- 审批等待区是否继续保留在输入框上方的独立 dock，而不是进入聊天行模型
- 是否要在本次重构里顺手把聊天滚动控制抽成独立 hook / 文件，还是先在 `Chat` 页面内落稳后再拆
