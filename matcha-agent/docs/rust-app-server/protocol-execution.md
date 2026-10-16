# 协议、并发与 CLI 执行

状态：传输选择和执行原则已定；精确 wire schema、订阅恢复协议与运行状态枚举待对应 block 冻结。

## 1. 客户端边界

```text
runtime-host / SDK / 控制台
  ├─ WebSocket + JSON-RPC 2.0 → 调用、控制、流和事件
  └─ HTTP                    → 健康/版本、需要时的文件传输
                                 │
                          Server 功能模块
                                 │
                          CLI 执行适配
                                 │ stdio NDJSON
                              原生 CLI
```

客户端不直接访问 CLI 进程或内部 IPC。模块接口不依赖 WebSocket 类型；gateway 只做协议边界和分发，不成为业务 owner。

- JSON-RPC 请求 ID 只配对请求和响应；一条连接允许多个请求同时在途。
- HTTP health 只报告实际检查的层级，进程存活不等于 CLI/模型/工具全部 ready；version 不作为能力可用性证明。
- 长任务的接收回执与最终结果分开；即时返回必须表达实际知道的事实。
- 事件用 notification 推送，关联对应 Session/Run；业务错误不全部压成 JSON-RPC `internal_error`。
- 方法按能力模块归属；此前 `agents.list`、`session.prompt` 等名称可作讨论示例，不视为整套新 RPC 已冻结。
- 本地连接、远程 TLS、浏览器 token 传递的准确方式需在 gateway block 冻结；不把旧共享 token 能力说成多用户授权。

## 2. 多会话运转

```text
请求接收 ─→ 对应 Session 的执行协调 ─→ CLI stdin
                     │
CLI stdout ─→ 协议解码 ─→ 运行事实/事件 ─→ 状态投影/客户端
CLI stderr ─→ 有界诊断采集
CLI exit   ─→ 进程退出事实 ─→ 所属 Run/Session 结算
```

- 单个 Rust 进程共用 Tokio 异步运行时；不同 Session 可以独立并行，不为每个 CLI 配专用 OS 线程。
- CLI 按执行需要启动，同一 Session 多轮复用；不是每个客户端连接或每条 prompt 启动一个新进程。客户端连接不拥有会话进程，断连不自动取消 Run；显式关闭/取消由对应模块处理。
- 同一原生会话不同时灌入多个独立业务 prompt：原生 print 会合并排队输入。独立 Run 的归属与排队由 Server 保持。
- 控制循环不能等待整次模型执行完才处理消息。审批答复、取消、退出观察与输出读取在执行期间持续可用。
- 只串行化真正需要有序的会话状态/写入，不用全局业务锁串行全部会话；不持锁等待模型或长工具。
- 目录扫描、历史解码、压缩/序列化等重计算与阻塞操作不得长期占用异步 I/O 执行线程。
- 不默认每模块一个 actor/mailbox；并发结构由资源所有权和实际写入竞争决定。

## 3. CLI 的现有执行入口

可复用的 headless 通道：`-p --input-format stream-json --output-format stream-json --verbose`；需要 partial stream 时再启用对应已有参数。由 Server 接收原生工具审批时使用 `--permission-prompt-tool stdio`，不能假设仅开启 stream-json 就会转交权限请求。

stdin 保持打开供多轮输入；stdout/stderr 独立持续读取。慢客户端的发送或诊断写入不能直接阻塞 CLI 输出读取或其他会话。

| 动作 | 已核实的原生语义 |
|---|---|
| initialize | 一次性初始化；可注入 prompt、agents、hooks 等，不是可反复调用的发现入口 |
| prompt | 向 stdin 写入原生 `user` 消息；不是 `prompt` 控制请求 |
| 模型/权限模式 | 已有控制 handler；模型 ACK 不证明 Provider 已替换 |
| 审批/Hook/elicitation | CLI 反向请求 Server，按原生 request_id 返回 control_response |
| interrupt | 请求中断当前执行；ACK 不表示取消终态，也不自动清空全部后台任务 |
| stop_task | 控制当前原生进程中可停止的任务，不等于任意跨会话调度 |
| resume/continue/fork | 启动恢复路径，不是进程内任意切换 Session 的 RPC |
| end_session/EOF | 收尾与退出路径；必须读取剩余输出并等待实际 OS exit |

对照：[print dispatcher](../../src/cli/print.ts#L3038)、[StructuredIO](../../src/cli/structuredIO.ts#L493)、[原生恢复](../../src/cli/print.ts#L5133)。源码可用入口仍受构建开关、平台、账户和配置限制，见 [能力矩阵](capabilities.md)。

不从 Rust 直接 import TS 内部模块，不保留旧 Bun app-server 作为隐形业务 owner。需要原生命令管理插件/MCP/认证时，通过 cli 模块复用已存在命令，不重写执行本体。

## 4. 轻量进程管理

```text
Session → CLI 执行实例 → OS Child
             ├─ 句柄与 stdio
             ├─ 初始化/控制请求与输出解码
             └─ 正常退出、异常退出与资源回收
```

- 进程层只拥有资源和原生观察；Run/Session 层拥有业务状态，不在上下各维护一套业务执行状态机。
- 可以在 cli 模块内分开协议、进程和配置职责，但不复制现有 runtime-host 的多层 Supervisor/Resource Owner/Adapter 与通用策略接线。
- 正常关闭、中断、强制终止是不同动作；先走已支持的正常路径，异常时清理自己持有且证明归属的进程树，随后回收退出结果。
- 平台差异在进程边界内部处理；不因追求短代码而遗留工具/MCP 子进程或终止未知端口占用者。
- 不自动把进程重启等同重新执行 prompt；副作用已可能发生时，不能盲目重试。
- 不默认创建通用进程池、任意进程 adopt/attach、每会话 guardian 或复杂重启策略。确有平台回收需要时只实现该机制。
- 保温/闲置回收、重启策略、数量/时间限制尚未定，不由实现 Agent 偷加默认值。

“更轻”是减少抽象和重复状态，不是声称比现有实现测得更快；CLI 本身的内存、工具子进程和 Provider 限流仍是总体成本。

## 5. 事件与持久化

- 领域命令表达意图，事实事件表达已发生的结果；不能把任意管理调用都改成广播后等待。
- 会话内事件顺序明确，不要求跨全部会话建立全局顺序；原生请求 ID/消息 UUID 不能改名替代业务 Run ID/事件序号。
- 对需要可靠回放的管理事实，先明确提交结果再发布。Run terminal、审批决定不能静默丢弃或被进度覆盖。
- 文本增量允许合批，进度/心跳允许合并；不能默认每个 token 单独同步刷盘。
- 明确区分可回放事实与瞬时更新；若某类增量不能回放，协议必须给出恢复视图的实际方式，不承诺无条件 exactly-once。
- replay、live subscribe 与客户端恢复点必须形成无漏事件的切换；准确 cursor、去重和过期语义在 events block 冻结。
- 写盘失败、投影失败、连接发送失败分别处理，不把“写入成功但分发失败”返回成“操作未发生”。

## 6. 背压与性能边界

采用现有异步 I/O、合批和局部有序处理；不为“高性能”预建配额平台、分布式调度或通用消息中间件。

不得无界保留永不消费的数据；也不得暗自加入全局并发上限、默认断连、任意丢事件、超时或重试策略。实际队列边界、慢消费者处理与恢复方式必须连同可观测结果写入对应契约，由当前负载和资源事实证明。诊断内容必须有明确采集范围，避免整段 stderr、prompt 或秘密无限驻留。

验证关注多会话并行、同会话顺序、执行中控制可达、慢消费者隔离、进程退出回收与错误关联；先用既有验证入口，不未经用户授权新增测试。
