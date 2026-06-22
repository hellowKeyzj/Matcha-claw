# 《matcha-agent编码宪法》

## 1. 【语义先于简短】：名字必须暴露领域状态，而不是压缩字符数

【原则名称】：语义先于简短：变量、函数、类型名应让调用点自己解释自己。

【深层动机】：  
该代码库长期处理模型流、工具调用、权限、远程桥接、SDK 协议、队列和会话状态。真正危险的不是名字长，而是名字模糊导致状态误判。源码更偏好 `shouldReportRunningForMessage`、`isEligibleBridgeMessage`、`resultType: 'alreadyInWorkingDirectory'` 这类“读起来像业务判断句”的命名，而不是 `ok`、`flag`、`data`、`handle` 这类上下文贫乏的符号。

【规范要求】：
- 布尔函数必须优先使用 `is / has / should / can` 开头。
- 副作用函数必须用动作动词开头，如 `enqueue`、`flush`、`close`、`resolveAndPrepend`。
- 联合类型必须使用明确判别字段，如 `reason`、`type`、`resultType`、`action`。
- 禁止用裸 `ok: boolean` 表达多种业务失败。
- 变量名可长，但必须长在“领域语义”上，而不是长在实现细节上。

【宪法判例】：

❌ 违宪写法

```ts
type Result = {
  ok: boolean
  err?: number
}

function chk(m: Message) {
  return m.type === 'user' || m.type === 'assistant'
}
```

✅ 宪法写法

```ts
type AddDirectoryResult =
  | { resultType: 'success'; directoryPath: string }
  | { resultType: 'emptyPath' }
  | { resultType: 'pathNotFound'; absolutePath: string }
  | { resultType: 'alreadyInWorkingDirectory'; workingDir: string }

function isEligibleBridgeMessage(message: Message): boolean {
  return (
    message.type === 'user' ||
    message.type === 'assistant' ||
    (message.type === 'system' && message.subtype === 'local_command')
  )
}
```

---

## 2. 【状态必须显式】：复杂流程用判别联合和 transition 驱动，禁止布尔堆叠

【原则名称】：状态必须显式：所有可恢复、可终止、可重试的流程都应有命名状态。

【深层动机】：  
模型调用不是一次函数调用，而是多轮状态机：streaming、工具执行、中断、压缩、token 预算、stop hook、max turn、错误恢复都可能改变下一步行为。源码用 `Terminal` / `Continue` 的 `reason` 明确表达转移原因，而不是散落多个布尔变量。这样可以防止“`isDone && hasError && shouldRetry` 到底代表什么”的组合爆炸。

【规范要求】：
- 任何循环型流程必须定义显式 transition 类型。
- 终止状态和继续状态必须分离。
- 状态字段必须命名为原因，而不是结果，例如 `reason: 'aborted_tools'` 优于 `aborted: true`。
- 禁止多个布尔值共同决定核心流程下一步。
- 每个新增状态必须说明它属于“终止”还是“继续”。

【宪法判例】：

❌ 违宪写法

```ts
let done = false
let retry = false
let compact = false
let aborted = false

if (!done && retry && compact && !aborted) {
  await runAgain()
}
```

✅ 宪法写法

```ts
type Terminal =
  | { reason: 'completed' }
  | { reason: 'aborted_streaming' }
  | { reason: 'aborted_tools' }
  | { reason: 'prompt_too_long' }
  | { reason: 'max_turns'; turnCount: number }

type Continue =
  | { reason: 'reactive_compact_retry' }
  | { reason: 'max_output_tokens_recovery'; attempt: number }
  | { reason: 'token_budget_continuation' }
  | { reason: 'next_turn' }

function nextState(result: Continue | Terminal) {
  switch (result.reason) {
    case 'reactive_compact_retry':
      return retryAfterCompact()
    case 'completed':
      return finish()
  }
}
```

---

## 3. 【函数管规则，类管生命周期】：纯规则函数优先，类只用于资源边界

【原则名称】：函数管规则，类管生命周期：业务判断保持纯函数，长期资源才封装成 class。

【深层动机】：  
源码明显偏函数式组合：桥接消息处理被抽为“不闭包 bridge-specific state”的纯 helper，协作者通过参数传入。与此同时，`SSETransport`、`SerialBatchEventUploader`、`BoundedUUIDSet` 这类需要持有 timers、queue、AbortController、close/flush 生命周期的对象才使用 class。其哲学是：规则可测试、资源可回收。

【规范要求】：
- 解析、过滤、判定、转换逻辑优先写成纯函数。
- 不要为了“组织代码”创建 class。
- class 必须有明确生命周期资源：队列、连接、timer、abort、缓存、订阅、句柄。
- class 必须提供清理入口，如 `close()`、`flush()`、`discard()`。
- 纯函数不得隐式读取模块级可变状态，依赖必须作为参数传入。

【宪法判例】：

❌ 违宪写法

```ts
class MessageHelper {
  constructor(private bridgeState: BridgeState) {}

  isEligible(message: Message) {
    return this.bridgeState.enabled && message.type === 'user'
  }
}
```

✅ 宪法写法

```ts
function isEligibleBridgeMessage(message: Message): boolean {
  if ((message.type === 'user' || message.type === 'assistant') && message.isVirtual) {
    return false
  }

  return (
    message.type === 'user' ||
    message.type === 'assistant' ||
    (message.type === 'system' && message.subtype === 'local_command')
  )
}

class SerialBatchEventUploader<T> {
  private pending: T[] = []
  private draining = false
  private closed = false

  async enqueue(events: T | T[]): Promise<void> {
    if (this.closed) return
    this.pending.push(...(Array.isArray(events) ? events : [events]))
    void this.drain()
  }

  close(): void {
    this.closed = true
    this.pending = []
  }
}
```

---

## 4. 【依赖注入要窄】：可替换性来自小而准的依赖面，不来自大而全的上下文对象

【原则名称】：依赖注入要窄：只注入测试和边界真正需要替换的东西。

【深层动机】：  
源码中的 `QueryDeps` 只暴露 `callModel`、`microcompact`、`autocompact`、`uuid`，注释明确说这是为了让测试注入 fake，而不是每个模块都 spy。它没有把整个世界塞进依赖容器。相反，工具执行上下文虽然很大，但那是因为工具层本身就是 I/O 边界。核心循环依赖面越窄，越不容易被 mock 污染和抽象膨胀拖垮。

【规范要求】：
- 核心逻辑依赖必须小而稳定。
- 测试替换点应放在副作用边界：模型 API、文件系统、网络、UUID、时间。
- 禁止引入全局 service locator。
- 禁止为了测试把纯函数也 DI 化。
- 新增依赖必须能回答：哪个测试或哪个外部边界需要替换它？

【宪法判例】：

❌ 违宪写法

```ts
type QueryDeps = {
  api: ApiClient
  logger: Logger
  settings: Settings
  tools: ToolRegistry
  state: AppState
  telemetry: Telemetry
  fs: FileSystem
}
```

✅ 宪法写法

```ts
type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}

function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

---

## 5. 【边界先分流】：入口只做启动分派，核心运行时按需加载

【原则名称】：边界先分流：CLI entrypoint 必须先处理 fast-path，再加载完整运行时。

【深层动机】：  
该项目非常重，完整 CLI、React Ink、工具注册、MCP、provider、远程桥接都会带来模块加载和内存成本。源码入口优先处理 `--version`、daemon worker、ACP、bridge、remote 等路径，最后才动态导入完整 `main.tsx`。这不是微优化，而是“运行模式边界即加载边界”的架构信念。

【规范要求】：
- 高频轻量命令不得加载完整 CLI。
- 特殊运行模式必须在入口处分流。
- 大模块必须动态 import，且只在需要时加载。
- entrypoint 不得承载业务逻辑，只负责模式选择和 bootstrap。
- 禁止在入口顶层 import 重型模块。

【宪法判例】：

❌ 违宪写法

```ts
import { runFullCli } from './main'
import { initMcp } from './mcp'
import { startRepl } from './screens/REPL'

if (args.includes('--version')) {
  console.log(version)
}
```

✅ 宪法写法

```ts
async function main() {
  if (args.includes('--version')) {
    console.log(version)
    return
  }

  if (args.includes('--daemon-worker')) {
    const { runDaemonWorker } = await import('../daemon/worker')
    return runDaemonWorker()
  }

  if (args.includes('bridge')) {
    const { runBridge } = await import('../bridge/bridgeMain')
    return runBridge()
  }

  const { main: runFullCli } = await import('../main')
  return runFullCli()
}
```

---

## 6. 【协议边界稳定】：SDK、CLI、Remote 共享消息协议，不共享内部调用栈

【原则名称】：协议边界稳定：跨运行时集成通过 NDJSON/control protocol，而不是直接 import 核心。

【深层动机】：  
SDK 不是把 `query()` 直接暴露给调用者，而是启动 CLI 子进程，用 stream-json / NDJSON 通信。权限、hook、elicitation、MCP 通过 `control_request` / `control_response` 反向代理。这种隔离牺牲了一点进程成本，但换来稳定协议、崩溃隔离、宿主回调隔离，以及 CLI/headless/remote 多形态复用同一消息模型。

【规范要求】：
- 跨进程、SDK、remote、bridge 必须走显式协议。
- 子进程不得直接访问 SDK host 的函数。
- 所有 host callback 必须封装成 control request。
- stdout/stderr 必须保持机器可解析边界，禁止混入非协议文本。
- 协议消息必须有 `type` 和 request/response ID。

【宪法判例】：

❌ 违宪写法

```ts
// SDK 直接 import 内部 query，和 CLI 共享内存状态
import { query } from '../../query'

export async function ask(prompt: string) {
  return query({ messages: [{ type: 'user', text: prompt }] })
}
```

✅ 宪法写法

```ts
class ProcessTransport {
  start() {
    this.child = spawn(cliPath, [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ])
  }

  send(message: SDKControlResponse | SDKUserMessage) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }
}

class ControlHost {
  async dispatchControlRequest(request: SDKControlRequest) {
    if (request.request.subtype === 'can_use_tool') {
      return this.options.canUseTool?.(request.request)
    }
  }
}
```

---

## 7. 【核心与 I/O 隔离】：模型、工具、UI、传输都必须挂在窄边界上

【原则名称】：核心与 I/O 隔离：核心 query loop 不知道 provider、UI、transport 的具体实现。

【深层动机】：  
源码中 `query.ts` 通过 `deps.callModel` 调模型；provider 差异压在 `services/api` 和 adapter 层；工具统一通过 `Tool.ts` / `tools.ts` 装配；REPL、headless、SDK、remote 只是替换 I/O adapter。这样核心循环只理解“消息流、tool_use、tool_result、transition”，不被 OpenAI/Gemini/Grok、Ink UI、SSE/WebSocket、MCP 细节污染。

【规范要求】：
- 核心循环不得直接构造 provider SDK client。
- UI 不得直接绕过工具注册表执行工具。
- transport 不得侵入 query internals。
- 工具池必须由统一入口组装、过滤、排序、去重。
- 新 provider 必须转换为内部统一事件形状。

【宪法判例】：

❌ 违宪写法

```ts
async function query(messages: Message[]) {
  if (process.env.USE_OPENAI) {
    return openai.chat.completions.create(...)
  }

  if (isRepl) {
    renderInkSpinner()
  }

  if (tool.name === 'Bash') {
    await exec(tool.input)
  }
}
```

✅ 宪法写法

```ts
async function* query(params: QueryParams, deps = productionDeps()) {
  for await (const event of deps.callModel(params)) {
    if (event.type === 'assistant') yield event
    if (event.type === 'tool_use') yield await runTools(event)
  }
}

function assembleToolPool(permissionContext, mcpTools) {
  return dedupeAndSort([
    ...getTools(permissionContext),
    ...filterMcpTools(mcpTools),
  ])
}
```

---

## 8. 【流式是一等模型】：不要等待完整结果；系统围绕事件流增量演进

【原则名称】：流式是一等模型：模型响应、工具结果、transport 事件都应被增量消费。

【深层动机】：  
Claude Code 的用户体验依赖实时反馈，模型 streaming、tool_use、tool_result、usage、stop reason、原始 stream event 都在流中推进。源码不是“请求 → 完整响应 → 再处理”，而是 `for await` 消费 raw stream，并同时产出可显示消息和底层事件。这允许 UI、SDK、遥测、工具执行在同一事件源上协作。

【规范要求】：
- 模型响应必须按 stream event 处理。
- 工具调用应在可执行时尽早进入调度。
- 底层 raw event 和上层 message event 应分层保留。
- 禁止为了简化控制流而等待完整模型响应。
- 长任务必须能持续上报 progress 或状态。

【宪法判例】：

❌ 违宪写法

```ts
const response = await client.messages.create(params)
const text = response.content.map(x => x.text).join('')
return { type: 'assistant', text }
```

✅ 宪法写法

```ts
for await (const part of stream) {
  switch (part.type) {
    case 'message_start':
      yield { type: 'stream_event', event: part }
      break

    case 'content_block_delta':
      yield { type: 'assistant_delta', delta: part.delta }
      break

    case 'message_delta':
      yield { type: 'usage_update', usage: part.usage }
      break
  }
}
```

---

## 9. 【取消必须贯穿协议】：Abort 不是停止 Promise，而是维护 transcript 一致性

【原则名称】：取消必须贯穿协议：中断要清理资源，也要补齐协议语义。

【深层动机】：  
模型可能已经发出 `tool_use`，工具可能正在 streaming，用户可能远程 interrupt。如果只是 `abort()` 掉当前 Promise，会留下半截 transcript：有 tool_use 没有 tool_result，有子进程没杀，有 UI 状态没复位。源码的取消链路围绕 `AbortSignal` 贯穿 streaming、tool executor、remote interrupt、cleanup，并在必要时生成 synthetic tool_result 维持协议配对。

【规范要求】：
- 所有长生命周期操作必须接收 `AbortSignal` 或持有子 `AbortController`。
- 中断后必须清理 timer、子进程、pending resolver、stream 引用。
- 如果上游协议要求成对消息，中断也必须补齐结果。
- 禁止 fire-and-forget 后无取消入口。
- 禁止吞掉 abort reason。

【宪法判例】：

❌ 违宪写法

```ts
async function runTool(input: Input) {
  const child = spawn('long-task')
  return await child.output()
}
```

✅ 宪法写法

```ts
async function runTool(input: Input, signal: AbortSignal) {
  const controller = new AbortController()

  signal.addEventListener('abort', () => {
    controller.abort(signal.reason)
    child.kill()
  })

  try {
    return await execute(input, controller.signal)
  } finally {
    cleanupTimers()
    clearInFlightReferences()
  }
}
```

---

## 10. 【队列要有背压】：异步并发默认受控，顺序敏感链路必须串行

【原则名称】：队列要有背压：系统可以并发隐藏延迟，但不得并发失控。

【深层动机】：  
源码不盲目 `Promise.all`。模型 streaming 期间可以 prefetch skill/tool，工具摘要可 fire-and-forget；但事件上传、状态同步、remote transport 这类顺序敏感路径使用单 drain loop、batch、backoff、queue limit、flush。其核心判断是：能隐藏延迟的并发化，必须保序的串行化，可能积压的加背压。

【规范要求】：
- 网络写入队列必须有最大容量。
- 顺序敏感上传必须最多一个 in-flight。
- 失败批次必须能重排回队首或明确 drop。
- producer 在队列满时必须 await，而不是无限 push。
- 只有无顺序依赖、无共享可变状态的任务才允许并发执行。

【宪法判例】：

❌ 违宪写法

```ts
function enqueue(event: Event) {
  pending.push(event)
  void Promise.all(pending.map(send))
}
```

✅ 宪法写法

```ts
async function enqueue(events: Event | Event[]) {
  const items = Array.isArray(events) ? events : [events]

  while (pending.length + items.length > maxQueueSize && !closed) {
    await new Promise<void>(resolve => backpressureResolvers.push(resolve))
  }

  pending.push(...items)
  void drain()
}

async function drain() {
  if (draining || closed) return
  draining = true

  try {
    while (pending.length > 0 && !closed) {
      const batch = takeBatch()
      try {
        await send(batch)
      } catch {
        pending = batch.concat(pending)
        await sleep(retryDelay())
      }
    }
  } finally {
    draining = false
  }
}
```

---

## 11. 【最新状态可合并，历史事件不可覆盖】：状态同步和事件审计必须使用不同数据结构

【原则名称】：最新状态可合并，历史事件不可覆盖：不要用同一种队列表达两种语义。

【深层动机】：  
源码区分 event uploader 和 worker state uploader。事件要保序、重试、批处理；状态只关心最新值，因此 1 个 in-flight + 1 个 pending patch，后来的 patch 合并覆盖旧值。这体现了“事件是历史，状态是投影”的心智模型，避免状态同步无限积压，也避免事件审计丢历史。

【规范要求】：
- 表示历史的 event 必须保序，不得 last-write-wins。
- 表示当前状态的 patch 可以合并、覆盖、压缩。
- 设计队列前必须先声明它承载的是 event 还是 state。
- 禁止把状态轮询结果追加成无限事件。
- 禁止把审计事件 coalesce 成最新值。

【宪法判例】：

❌ 违宪写法

```ts
// 把状态变化当事件无限堆积
stateQueue.push({ status: 'running' })
stateQueue.push({ status: 'running', progress: 10 })
stateQueue.push({ status: 'running', progress: 20 })
```

✅ 宪法写法

```ts
// 状态投影：只保留最新 pending patch
function enqueueStatePatch(patch: WorkerStatePatch) {
  pendingPatch = mergePatch(pendingPatch, patch)

  if (!inFlight) {
    void flushLatestState()
  }
}

// 事件审计：必须保序上传
function enqueueEvent(event: SessionEvent) {
  eventQueue.push(event)
  void drainSerially()
}
```

---

## 12. 【外部依赖默认不可靠】：网络、MCP、远程服务必须限时、重试、退避、可降级

【原则名称】：外部依赖默认不可靠：任何网络或外部进程都不应被信任为及时、正确、持续可用。

【深层动机】：  
源码处理 CCR、MCP、SSE、HTTP upload 时充满 timeout、Retry-After、指数退避、jitter、auth failure 分类、buffer 上限、liveness watchdog。它默认外部世界会断线、卡死、限流、返回重复事件、返回坏 JSON、给过期 token。系统的自治能力来自“不惊讶”。

【规范要求】：
- 所有外部请求必须有 timeout 或 abort。
- 429 必须尊重 `Retry-After`。
- 重连必须指数退避并加 jitter。
- auth 失败、网络失败、超时必须分类处理。
- 辅助能力失败不得阻断核心结果，除非它是安全边界。
- buffer、dedup set、pending queue 必须有上限。

【宪法判例】：

❌ 违宪写法

```ts
while (true) {
  const res = await fetch(url)
  handle(await res.json())
}
```

✅ 宪法写法

```ts
try {
  const res = await fetch(url, { signal })

  if (res.status === 429) {
    throw new RetryableError('rate limited', parseRetryAfter(res))
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: { type: 'auth' } }
  }

  return { ok: true, data: await res.json() }
} catch (error) {
  if (signal.aborted) return { ok: false, error: { type: 'aborted' } }
  return { ok: false, error: { type: 'network' } }
}
```

---

## 13. 【安全先于便利】：权限判断必须 deny 优先，危险路径不可被工作目录豁免

【原则名称】：安全先于便利：权限系统必须先排除危险，再考虑 allow。

【深层动机】：  
源码的路径权限检查先匹配 deny rules，再处理内部可编辑路径，再做综合安全校验，最后才判断是否在 allowed working directory。顺序非常关键：如果“工作目录内可写”先命中，`.claude`、`.git`、settings、MCP 配置、shell profile 等提权入口就可能被 acceptEdits 绕过。该系统把安全边界当成排序问题，而不仅是规则集合问题。

【规范要求】：
- deny 规则必须优先于 allow 规则。
- 写入操作必须先做危险路径安全检查。
- 工作目录内不等于安全。
- `.git`、`.claude`、settings、MCP 配置、shell profile、credential 文件必须特殊保护。
- 禁止用字符串 `includes` 做路径安全判断，必须 normalize / realpath / path segment 校验。
- 自动编辑模式不得绕过危险路径检查。

【宪法判例】：

❌ 违宪写法

```ts
function canWrite(path: string, cwd: string) {
  if (path.startsWith(cwd)) return true
  if (denyRulesMatch(path)) return false
  return false
}
```

✅ 宪法写法

```ts
function isPathAllowed(resolvedPath: string, context: ToolPermissionContext, operationType: FileOperationType) {
  const permissionType = operationType === 'read' ? 'read' : 'edit'

  const denyRule = matchingRuleForInput(resolvedPath, context, permissionType, 'deny')
  if (denyRule) {
    return { allowed: false, decisionReason: { type: 'rule', rule: denyRule } }
  }

  if (operationType !== 'read') {
    const safetyCheck = checkPathSafetyForAutoEdit(resolvedPath)
    if (!safetyCheck.safe) {
      return {
        allowed: false,
        decisionReason: {
          type: 'safetyCheck',
          reason: safetyCheck.message,
        },
      }
    }
  }

  if (pathInAllowedWorkingPath(resolvedPath, context)) {
    return operationType === 'read' || context.mode === 'acceptEdits'
      ? { allowed: true }
      : { allowed: false }
  }
}
```

---

## 14. 【模型输出不可直接执行】：schema 校验之后还要语义校验

【原则名称】：模型输出不可直接执行：LLM 生成的工具输入必须先结构化校验，再业务校验。

【深层动机】：  
工具调用参数来自模型，模型不是可信调用方。源码先用 Zod schema `safeParse`，失败就返回模型可理解的 validation error；通过 schema 后还调用工具自己的 `validateInput` 做语义校验。结构正确不代表安全正确，例如路径存在性、权限范围、组合约束都属于 schema 之外。

【规范要求】：
- 所有工具输入必须有 schema。
- schema 失败不得执行工具。
- schema 通过后必须允许工具做语义校验。
- 校验失败应返回结构化错误给模型，而不是抛未知异常。
- 禁止“猜测修复”模型参数后继续执行危险动作。

【宪法判例】：

❌ 违宪写法

```ts
async function executeTool(toolCall: ToolCall) {
  return tools[toolCall.name].call(JSON.parse(toolCall.input))
}
```

✅ 宪法写法

```ts
async function executeTool(tool: Tool, rawInput: unknown) {
  const parsed = tool.inputSchema.safeParse(rawInput)

  if (!parsed.success) {
    return {
      type: 'validation_error',
      message: formatZodError(parsed.error),
    }
  }

  const semanticError = await tool.validateInput?.(parsed.data)

  if (semanticError) {
    return {
      type: 'validation_error',
      message: semanticError,
    }
  }

  return tool.call(parsed.data)
}
```

---

## 15. 【沙箱不能静默失效】：安全承诺失败时必须可见，不得自动降级

【原则名称】：沙箱不能静默失效：用户启用的安全边界不可悄悄变成普通执行。

【深层动机】：  
源码对 sandbox 的态度是“双层防线”：应用层权限检查仍存在，OS 级 sandbox 额外拦截 settings、skills、bare git repo 等逃逸点。如果用户显式启用沙箱但平台或依赖不可用，源码返回可见原因，而不是继续裸跑。安全机制最大的敌人不是失败，而是失败后仍让用户以为它成功。

【规范要求】：
- 用户显式启用 sandbox 时，不可静默 fallback 到非 sandbox。
- sandbox 必须 deny 写入配置、技能、裸仓库逃逸点。
- sandbox 后应清理可能被植入的逃逸文件。
- sandbox 不能替代应用层权限检查。
- sandbox 不可用时必须给出用户可理解的原因。

【宪法判例】：

❌ 违宪写法

```ts
try {
  return await runInSandbox(command)
} catch {
  return await runNormally(command)
}
```

✅ 宪法写法

```ts
const sandbox = await prepareSandbox(config)

if (!sandbox.available && config.required) {
  return {
    ok: false,
    reason: sandbox.reason,
    message: 'Sandbox was requested but is not available on this system.',
  }
}

return runWithPermissionsAndSandbox(command, sandbox)
```

---

## 16. 【错误要分类自治】：预期失败返回判别结果，未知异常才抛出

【原则名称】：错误要分类自治：可预期失败是业务状态，不是异常。

【深层动机】：  
源码中路径不存在、不是目录、权限拒绝、附件下载失败、控制消息无法处理等经常被转为显式结果或 best-effort skip。只有未知系统异常才 rethrow。这让调用方可以决定 UI 文案、重试、降级，而不是所有失败都变成一条 `failed`。

【规范要求】：
- 用户输入错误、资源不存在、权限不足、网络非 200 属于预期失败。
- 预期失败应返回判别联合或 `undefined`，不得直接 throw。
- 未知异常必须保留并上抛。
- 错误结果必须包含足够上下文供用户行动。
- best-effort 功能失败可降级，但必须避免泄漏敏感信息。

【宪法判例】：

❌ 违宪写法

```ts
function validateDirectory(path: string) {
  if (!existsSync(path)) {
    throw new Error('failed')
  }
}
```

✅ 宪法写法

```ts
function validateDirectory(path: string): AddDirectoryResult {
  if (path.trim() === '') {
    return { resultType: 'emptyPath' }
  }

  try {
    const stat = statSync(path)

    if (!stat.isDirectory()) {
      return { resultType: 'notADirectory', directoryPath: path }
    }

    return { resultType: 'success', directoryPath: path }
  } catch (error) {
    if (isNotFoundError(error)) {
      return { resultType: 'pathNotFound', absolutePath: path }
    }

    throw error
  }
}
```

---

## 17. 【用户错误可行动，调试日志可定位】：文案克制但必须给下一步

【原则名称】：用户错误可行动，调试日志可定位：错误消息不是宣泄，是恢复路径。

【深层动机】：  
源码测试用户可见错误消息：预算超限要包含金额、参数、新会话建议；结构化输出失败提示简化 schema；目录错误提示是不是想添加父目录。调试日志则使用 `[bridge:repl]` 等命名空间并带关键字段。它避免“Failed”这种无价值错误，也避免把内部栈或敏感体直接丢给用户。

【规范要求】：
- 用户消息必须说明发生了什么、为什么、下一步做什么。
- 不要使用恐吓式大写安全文案。
- 调试日志必须带命名空间。
- 调试日志必须带关键上下文字段，如 type、subtype、uuid、status、elapsed。
- 禁止裸 `console.log('bad')` 或 `throw new Error('failed')`。
- 禁止用户可见错误泄露 token、完整请求体、私密路径。

【宪法判例】：

❌ 违宪写法

```ts
throw new Error('failed')
console.log('bad message')
```

✅ 宪法写法

```ts
return {
  action: 'invalid',
  reason: `Unknown sub-command "${subCommand}". Use: list | create CRON PROMPT | delete ID | run ID`,
}

logForDebugging(
  `[bridge:repl] Ignoring control_request subtype=${request.subtype} request_id=${requestId}`,
)
```

---

## 18. 【遥测必须安全】：进入日志、遥测、webhook 的内容必须先脱敏、限长、稳定化

【原则名称】：遥测必须安全：观测系统只能接收安全摘要，不能接收原始秘密。

【深层动机】：  
源码定义 telemetry-safe error，webhook sanitizer 覆盖 GitHub/Anthropic/AWS/npm/Slack/token/password 等模式，debug 输出限长且 secret 局部遮盖。它区分“用户可读错误”“遥测错误名”“调试上下文”，避免把代码、路径、URL、Authorization、API key 送进遥测系统。

【规范要求】：
- token、secret、Authorization、API key、password 必须脱敏。
- 日志和遥测必须限长。
- sanitizer 自身失败时必须返回安全占位符，不能返回原文。
- telemetry error message 必须稳定，不依赖 minified class name。
- 禁止把完整请求/响应体直接写日志。

【宪法判例】：

❌ 违宪写法

```ts
logEvent('tool_error', {
  error: error.stack,
  request,
  responseBody,
})
```

✅ 宪法写法

```ts
logEvent('tool_error', {
  errorName: stableErrorName(error),
  errno: getErrno(error),
  message: telemetrySafeMessage(error),
})

function debugBody(raw: string) {
  const redacted = redactSecrets(raw)
  return redacted.length <= DEBUG_MSG_LIMIT
    ? redacted
    : `${redacted.slice(0, DEBUG_MSG_LIMIT)}... (${redacted.length} chars)`
}
```

---

## 19. 【缓存必须声明失效边界】：缓存不是偷懒，是有边界的性能契约

【原则名称】：缓存必须声明失效边界：任何 memoize 都必须知道什么时候过期。

【深层动机】：  
源码缓存 command loading、tool index、resolved paths、prompt cache eligibility、JSON parse，但也在动态技能变化时清理多层缓存。它同时警惕缓存对象被污染：JSON parse LRU 使用前浅拷贝，避免修改缓存值导致脏复用。缓存是性能工具，也是正确性债务。

【规范要求】：
- 每个缓存必须有 key 设计和失效策略。
- 缓存值如果会被调用方修改，必须拷贝后返回。
- 动态插件、技能、工具变化必须清理相关缓存。
- session-stable latch 必须明确说明为什么会话内不更新。
- 禁止无边界全局缓存外部可变结果。

【宪法判例】：

❌ 违宪写法

```ts
let toolsCache: Tool[] | undefined

function getTools() {
  if (!toolsCache) {
    toolsCache = loadTools()
  }

  return toolsCache
}
```

✅ 宪法写法

```ts
const toolsByKey = new Map<string, ToolIndex>()

function getToolIndex(tools: Tool[]) {
  const key = tools.map(tool => tool.name).sort().join(',')

  const cached = toolsByKey.get(key)
  if (cached) return cached

  const index = buildToolIndex(tools)
  toolsByKey.set(key, index)
  return index
}

function clearDynamicSkillCaches() {
  commandCache.clear()
  pluginCache.clear()
  skillIndexCache.clear()
}
```

---

## 20. 【冷启动优先，热路径克制】：性能优化先保启动路径，再保交互路径

【原则名称】：冷启动优先，热路径克制：不要让低频能力拖累启动和交互。

【深层动机】：  
项目的 Bun/JSC 环境对大 bundle 解析敏感，源码通过代码分割、动态 import、`--version` 零额外加载、重模块按需加载控制 RSS 和启动延迟。交互时则让后台任务在滚动期间 early-return，复用稳定空数组，hoist 热路径对象，减少 React/Ink 重渲染。性能哲学不是到处微优化，而是识别“启动”和“交互”这两条用户感知路径。

【规范要求】：
- 启动入口不得引入低频重模块。
- 命令、insights、插件、技能等低频能力必须按需加载。
- UI 滚动或输入热路径中，后台任务应主动退让。
- 状态更新应尽量保持引用稳定，避免无意义重渲染。
- 热路径微优化必须有明确位置，不得牺牲全局可读性。

【宪法判例】：

❌ 违宪写法

```ts
import './commands/insights'
import './remote-control'
import './all-tools'
import './screens/REPL'

export async function main() {
  if (args.includes('--version')) console.log(version)
}
```

✅ 宪法写法

```ts
export async function main() {
  if (args.includes('--version')) {
    console.log(version)
    return
  }

  if (command === 'insights') {
    const { runInsights } = await import('./commands/insights')
    return runInsights()
  }

  const { runCli } = await import('./main')
  return runCli()
}
```

---

## 21. 【注释解释约束，不翻译代码】：注释只服务于隐藏原因、历史包袱和安全边界

【原则名称】：注释解释约束，不翻译代码：代码说明 what，注释说明 why。

【深层动机】：  
源码里的注释常用于解释 bundle isolation、compat session ID、NDJSON U+2028/U+2029、网络文件名不可信、缓存稳定性、测试 escape hatch。它很少逐行解释“这里设置变量”。注释承担的是维护者无法从代码直接看出的上下文。

【规范要求】：
- 只在隐藏约束、安全边界、性能取舍、协议兼容、测试逃生门处写注释。
- 禁止注释重复函数名和代码行为。
- 注释应说明“为什么不能用更简单做法”。
- escape hatch 必须注明适用范围和禁止生产使用。
- 性能注释必须说明成本来源。

【宪法判例】：

❌ 违宪写法

```ts
// Set draining to true
this.draining = true

// Loop while pending has items
while (this.pending.length > 0) {
  await send(this.pending.shift())
}
```

✅ 宪法写法

```ts
// Drain loop. At most one instance runs at a time; ordering matters because
// server-side writes collide when concurrent sessions retry the same stream.
private async drain(): Promise<void> {
  if (this.draining || this.closed) return
  this.draining = true
}
```

---

## 22. 【代码密度靠早返回维持】：紧凑可以，但嵌套不可以

【原则名称】：代码密度靠早返回维持：高密度代码必须通过小函数和早返回保持可扫读。

【深层动机】：  
源码并不追求空洞留白，很多函数紧凑。但它大量使用小 predicate、早返回、语义分段，避免深层嵌套。桥接消息、标题提取、调度判断、debug truncation 都是这种风格：短函数、强命名、少注释、低嵌套。

【规范要求】：
- 超过两层嵌套时优先早返回或抽 predicate。
- 一个函数只处理一个语义阶段。
- 空行用于分隔阶段，不用于装饰。
- 小 helper 应以业务语义命名，而不是 `helper1`。
- 禁止把解析、权限、执行、格式化塞进一个大函数。

【宪法判例】：

❌ 违宪写法

```ts
function extractTitle(message: Message) {
  if (message.type === 'user') {
    if (!message.isMeta) {
      if (!message.toolUseResult) {
        if (!message.isCompactSummary) {
          return getText(message)
        }
      }
    }
  }

  return undefined
}
```

✅ 宪法写法

```ts
function extractTitleText(message: Message): string | undefined {
  if (message.type !== 'user') return undefined
  if (message.isMeta || message.toolUseResult || message.isCompactSummary) {
    return undefined
  }
  if (message.origin && message.origin.kind !== 'human') return undefined

  return getHumanText(message)
}
```

---

## 23. 【权限上下文不可变】：安全决策输入必须深不可变，状态变更必须显式

【原则名称】：权限上下文不可变：安全判断不能被执行过程悄悄改写。

【深层动机】：  
源码把 `ToolPermissionContext` 定义为 `DeepImmutable`，而 `ToolUseContext` 中状态变更通过 `setAppState(f)`、`updateFileHistoryState(updater)` 等显式函数完成。安全输入不可变，应用状态变更可追踪，这防止工具执行中途改写权限环境或绕过审批。

【规范要求】：
- 权限上下文必须不可变。
- 工具不得直接 mutate AppState。
- 状态更新必须通过 updater 函数。
- 临时决策状态必须有明确作用域。
- 禁止工具在执行中写入 alwaysAllow/alwaysDeny 规则，除非走专门权限配置流程。

【宪法判例】：

❌ 违宪写法

```ts
async function runTool(context: ToolUseContext) {
  context.permission.mode = 'acceptEdits'
  context.appState.messages.push(systemMessage)
}
```

✅ 宪法写法

```ts
type ToolPermissionContext = DeepImmutable<{
  mode: PermissionMode
  alwaysAllowRules: ToolPermissionRulesBySource
  alwaysDenyRules: ToolPermissionRulesBySource
}>

async function runTool(context: ToolUseContext) {
  context.setAppState(prev => ({
    ...prev,
    messages: [...prev.messages, systemMessage],
  }))
}
```

---

## 24. 【测试替换副作用，不替换真规则】：可测试性来自纯函数和底层 mock，而不是业务模块 mock

【原则名称】：测试替换副作用，不替换真规则：mock 网络、文件、时间，不 mock 被测业务。

【深层动机】：  
项目说明强调 Bun 的 `mock.module` 是进程全局，会污染测试文件。源码通过纯函数、窄 deps、底层 axios/mock、共享 log/debug mock 来提高可测试性。测试哲学是：业务规则越真实越好，副作用边界越可替换越好。

【规范要求】：
- 纯函数必须直接测真实实现。
- mock 只放在网络、文件系统、auth、settings、log/debug 等副作用边界。
- 禁止 mock 同目录被测业务模块。
- mock specifier 必须与真实 import 路径一致。
- 新增复杂规则时优先抽纯函数，而不是扩大 mock。

【宪法判例】：

❌ 违宪写法

```ts
mock.module('src/commands/schedule/triggersApi.js', () => ({
  listTriggers: () => fakeTriggers,
}))

test('launch schedule', async () => {
  await launchSchedule()
})
```

✅ 宪法写法

```ts
const axiosHandle = setupAxiosMock()

beforeAll(() => {
  axiosHandle.useStubs = true
  axiosHandle.stubs.get = async url => {
    if (url.endsWith('/triggers')) return { data: fakeTriggers }
  }
})

test('launch schedule', async () => {
  await launchSchedule()
})
```

---

## 25. 【绝对禁忌清单】：这些写法在 matcha-agent 体系内默认违宪

【原则名称】：绝对禁忌清单：便利性不得越过协议、安全、状态和性能边界。

【深层动机】：  
该源码的“无形之手”不是某个单一模式，而是一组红线：不要信任模型输入，不要静默降级安全，不要让队列无限增长，不要让 SDK 侵入核心，不要让入口加载全世界，不要用模糊布尔表达复杂状态。违反这些红线，短期代码会更少，长期系统会更不可控。

【规范要求】：
- 禁止模型参数不经 schema/语义校验直接执行。
- 禁止 `Bash(*)`、解释器通配、Agent 全量 allow 这类权限捷径。
- 禁止 sandbox 失败后静默裸跑。
- 禁止工作目录内自动豁免危险文件。
- 禁止无上限 queue / buffer / dedup set。
- 禁止跨 SDK/remote 直接 import 内部 runtime 绕过协议。
- 禁止 provider 细节渗透进 query loop。
- 禁止用多个布尔拼复杂状态机。
- 禁止用户错误只写 `failed`。
- 禁止日志、遥测、webhook 记录原始 secret。
- 禁止入口顶层 import 低频重模块。
- 禁止测试 mock 被测业务上层模块。

【宪法判例】：

❌ 违宪写法

```ts
import { runFullCli } from './main'
import { query } from './query'

const allowAll = 'Bash(*)'

async function handleToolCall(call: ToolCall) {
  const input = JSON.parse(call.input)
  return tools[call.name].call(input)
}

async function sdkAsk(prompt: string) {
  return query({ messages: [{ type: 'user', text: prompt }] })
}

try {
  await runInSandbox(command)
} catch {
  await runNormally(command)
}
```

✅ 宪法写法

```ts
async function handleToolCall(tool: Tool, rawInput: unknown, context: ToolUseContext) {
  const parsed = tool.inputSchema.safeParse(rawInput)
  if (!parsed.success) return inputValidationError(parsed.error)

  const semanticError = await tool.validateInput?.(parsed.data)
  if (semanticError) return inputValidationError(semanticError)

  const permission = await canUseTool(tool, parsed.data, context)
  if (permission.behavior !== 'allow') return permissionDenied(permission)

  return tool.call(parsed.data, context)
}

class MatchaQuery {
  private transport = new ProcessTransport()

  async start(prompt: string) {
    await this.transport.start([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ])

    this.transport.send({ type: 'user', message: prompt })
  }
}
```

---

## 总纲

matcha-agent 的编码宪法可以压缩为一句话：

**用显式状态驯服复杂流程，用窄边界隔离外部世界，用受控队列管理异步副作用，用安全优先的校验链保护执行环境，用语义命名和可行动错误让系统在失败时仍然可理解、可恢复、可演进。**
