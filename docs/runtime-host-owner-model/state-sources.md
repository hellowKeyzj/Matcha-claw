# 状态源与状态转换

## 1. 四种状态

```text
desired      用户/Renderer 想要达到的状态
persisted    owner 已把状态写入 durable store 或 native store
applied      状态已投影给 Gateway、OpenClaw config 或 peer runtime
observed     从 Gateway、peer、外部系统或 readback 得到的事实
```

它们不是同一枚举，也不保证同步完成。一个 mutation 的正确模型应至少能表达：

```text
requested
  -> persisted / rejected / unknown
  -> applied / apply_failed / unknown
  -> observed / unavailable / unknown
```

请求返回成功只能说明该 API 定义的那一阶段成功，不能扩展解释为后续阶段已完成。

## 2. 各领域事实源

### Runtime state roots

```text
%APPDATA%/MatchaClaw/runtime-host
  = MatchaClaw Host durable state: organization-facts.log, Team webhook token,
    fleet-facts.log, fleet-private/
%APPDATA%/MatchaClaw/openclaw
  = OpenClaw native/config state: openclaw.json, Gateway token, private projection
%APPDATA%/MatchaClaw/matcha-agent/app-server
  = matcha-agent app-server native state: session/run/event/snapshot stores
```

Host-owned Organization/Fleet durable facts must not be written under OpenClaw state or matcha-agent app-server state. OpenClaw private projection still owns OpenClaw config/auth material; matcha-agent app-server still owns peer-native session and run artifacts.

### Settings / security
```text
SettingsStoreWorkflow
  -> settings durable document
  -> OpenClaw/private projection
  -> Gateway/plugin apply
  -> ready/observed state
```

```text
security.policy.json
  -> policy sync
  -> security-core plugin/Gateway
  -> audit/enforcement observation
```

关键约束：

- settings store 不是 OpenClaw applied config；
- policy persisted 不是 enforcement active；
- License 产品门禁已退休，不再有 license gate/raw key owner、public route、capability 或事件；
- 当前 Rust 已有 OpenClaw config document store 和 rule catalog，但不能据此宣称 settings/security 已完成接管；
- TS `gateway.auth.token` 与 Rust sensitive-field guard 的冲突必须在切换前解决。

### Channel

```text
OpenClaw config.channels       -> configured identity
Gateway channels.status        -> live account/connection state
LoginSessionService (memory)   -> QR/login lifecycle
Conversation runtime            -> pairing request
Renderer Zustand store          -> UI/cache projection
```

`/api/channels/snapshot` 与当前 Rust `/api/channels/status` 不是天然同一契约。`gateway:channel-status` 的 wrapper/native payload shape 需要真实运行 trace，不得在 Rust 或 bridge 中擅自 unwrap/rewrap。

### Provider

```text
curated JSON reference catalog = modelId-keyed built-in discovery/import draft defaults
user input / saved provider catalog = final desired/persisted model facts
OpenClaw private projection      = consumer of saved catalog only
```

Curated reference 不成为 runtime fact owner；OpenClaw projection 不按模型名猜 `contextWindow`，只使用已保存 catalog 中的字段。

### Cron / usage

```text
Renderer mutation
  -> typed command
  -> OpenClaw Gateway control dispatcher RPC
  -> native definition/run/receipt
  -> history projection

Manual forced run
  -> dedicated cron execution event connection
  -> terminal receipt/status
```

```text
transcript JSONL
  -> token usage parser
  -> usage cache
  -> dashboard projection
```

Gateway response 丢失时，operation outcome 必须保留 `Unknown`，不能选择性伪造 succeeded 或 failed。`usage.refreshHistory` 不是 usage fact owner。

### Session

Session 不是一个单一 durable source：

```text
legacy transcript JSONL   = conversation content/recovery source
app-server events.jsonl   = runtime/protocol event source
app-server snapshot       = event projection
app-server index           = catalog/metadata projection
canonical state            = runtime-host in-memory rebuildable projection
render/timeline/window     = UI read projections
activeSessionKey store    = pointer persistence only
```

身份必须保留：

```text
endpoint + agentId + sessionKey
```

并区分：

```text
endpointSessionId / app-server sessionId = peer-native durable session id
runId       = one runtime execution scope
messageId   = message identity
seq         = ordering value; different layers are not automatically interchangeable
```

Rust 可以读取 transcript、snapshot、event replay，并生成 bounded hydration/window；不能成为 legacy JSONL writer，也不能把 hydration snapshot冒充 canonical transcript owner。

### External connectors

```text
connectors.json             = desired/persisted connector definitions
OpenClaw mcp.servers        = applied configuration projection
MCP HTTP probe              = global observed connectivity (TS)
Gateway mcpServerStatus/list= session observed state
Renderer store              = cache/projection
```

当前 Rust 候选 store 已有 revision、writer lock、atomic commit、desired/applied receipt，但还不等于行为兼容，因为：

- TS version 1 与 Rust version 3 的读取/写入互通未证明；
- TypeScript secret references 与 Rust `deny_unknown_fields` schema 不一致；
- Rust 当前 MCP HTTP status 是 `Unknown`，而 TS 会主动 probe；
- Rust provider-models transport 已启动，但尚未证明完整 Electron public route / signed loopback product path cutover。

## 3. 事件与状态的关系

事件是状态变化的通知或 replay input，不是所有领域的 durable authority：

```text
owner operation event  = best-effort completion/progress hint; query is recovery path
host:event             = delivery projection, no ack/replay
Gateway channel event  = native event projection, shape must be preserved
app-server events.jsonl= peer runtime event fact source
```

缺失事件时，客户端恢复依赖 query/read path；缺失 readback 时，结果应是 `Unknown`，而不是用通知送达推断业务成功。

## 4. 切换时的证明义务

每个领域 owner cutover 必须能回答：

1. desired 由谁接收，输入字段是否原样保留？
2. persisted 写入哪个 store，失败和 commit outcome unknown 如何表达？
3. applied 如何确认，config write 和 runtime apply 是否分开？
4. observed 从哪个 native/外部 readback 得到，是否有 TTL/刷新/unknown？
5. event/projection 如何到 Renderer，丢失后如何 query 恢复？
6. old TS writer 何时停止，是否存在双写或双 owner？
7. 旧 route、错误码、timeout、HTTP status、owner operation projection 是否仍一致？
