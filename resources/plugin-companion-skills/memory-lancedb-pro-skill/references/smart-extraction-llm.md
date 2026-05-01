# Smart Extraction LLM

这是配置与运行时解析规则，不是日常使用规则。

只有在排 `smart extraction` 初始化失败、`autoCapture` 不入库、或要解释模型来源时，才需要读这一份。

## 解析顺序

smart extraction 需要 LLM 时，插件按这个顺序找可用来源：

1. `llm.apiKey`
2. `embedding.apiKey`
3. OpenClaw 默认模型来源解析出的 provider api key
4. `OPENAI_API_KEY`

模型与 baseURL 也会按类似顺序 fallback：

1. `llm.model`
2. OpenClaw 默认模型
3. 插件内置默认模型名

## 关键结论

- 如果写了显式 `llm.*`，按 `llm.*` 走。
- 如果没写 `llm.apiKey`，插件会继续尝试 `embedding.apiKey`、OpenClaw 默认模型来源、`OPENAI_API_KEY`。
- `embedding.provider = "local-minilm"` 只说明向量 embedding 走本地 MiniLM。
- 它不自动等于 smart extraction 的 LLM 也有可用本地来源。
- 在 MatchaClaw 场景里，不一定必须显式写 `llm.*`，但必须确认 OpenClaw 默认模型来源可用。
