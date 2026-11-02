# Rust App Plugin

先按 SDK 初始化提示安装下载的 SDK 包。在生成的项目目录，用目标平台原生终端执行：

```sh
cargo build --release --locked
npm run build
```

依赖已缓存时可给 Cargo 加 `--offline`。SDK 只复制 `target/release/matcha-app-plugin-rust[.exe]`，不会调用 Cargo；不要将 `CARGO_TARGET_DIR` 指向其他目录，除非同步修改构建配置的 assets 源路径。SDK 初始化按当前平台填写 manifest 的 `backend.platform/arch/entry` 和 assets 路径；默认源模板是 Windows x64，不能把一份二进制当作跨平台产物。其他平台须在相应原生环境构建并分别打包。

包中只有 manifest、自包含 `index.html` 与 `bin/backend[.exe]`，不含 Cargo 工程、target 目录或开发库。将 SDK 构建出的包安装到 Matcha 后打开 Rust Echo；页面显示真实的工具富结果与 `echo.completed` 事件。直接用浏览器打开 HTML 不会连接后端。`echo` 只在本地回传文本，不调用模型、不产生模型费用。

`src/main.rs` 使用 NDJSON JSON-RPC 2.0 MCP stdio：`initialize`（支持 `2025-11-25`、`2025-06-18`、`2024-11-05`）、`notifications/initialized`、`tools/list`、`tools/call`、`ping` 与 `notifications/cancelled`。stdout 只写协议，诊断写 stderr；stdin EOF 退出。初始化上下文来自 `params._meta.matcha` 的 `pluginId/version/packagePath/storagePath`。工具清单从 manifest 编译进二进制，改 manifest 后必须重新编译。

`HostContext` 提供 `publish`、`log`、`report_progress` 与 `list_models/generate/generate_text/submit_video/query_video/collect_video`。模型 helper 把原始 SDK request 对象直接作为 `matcha/models/*` 的 params，返回原业务 result；不持有 provider 密钥。例如在工具 worker 内显式调用 `host.generate_text(json!({"prompt": "…"}), cancelled)`，才会发起可能收费的模型请求；模板不会自动调用它。字段约束以公开 SDK 的 `App*Model*Request` 为准。

主线程持续读 stdin 并分发反向响应；工具最多并发 16 个，模型等待上限 20 分钟（对齐宿主媒体请求上限）且每 100ms 检查取消。取消工具会连带通知取消它正在等待的模型 request，并清理等待项。添加工具时把业务放在 `call_tool`，在长循环中检查 `cancelled`；模型 helper 只在工具 worker 调用，不在 reader 中调用。单条输入/输出上限 128 MiB。返回值保留 MCP `content` 块（示例含 text 与 resource）、`structuredContent` 和 `_meta`，不将富结果压成 JSON 文本。
