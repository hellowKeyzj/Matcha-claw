# Python 3.12 App Plugin

独立模板，仅用标准库。`manifest.json` 声明 `schemaVersion: 1`、`apiVersion: 1` 和 Python `backend`，不使用 `main`。Echo 工具在本地回显，不调用模型、不产生模型费用；`index.html` 通过宿主注入的 `window.matchaApp.call('echo', {message})` 调用并订阅事件，支持中英日俄。主程序保持闭源，插件仅依赖公开 SDK 和协议。

## 开发与打包

在项目目录的 **Agent 原 native 终端**准备代码和依赖，不借宿主安装过程联网构建。SDK CLI 的 `build` / `watch` / `dev` / `pack` 由初始化时生成的 package scripts 提供；先运行 `npm run build`，需要安装包时运行 `npm run pack`。已有项目也可运行已安装的 `matcha-app-plugin build .` / `matcha-app-plugin pack dist python-echo.zip`。

`app-plugin.build.json` 的 `assets` 是目标路径到源路径的映射：`{"main.py":"main.py"}`；增加本地模块或资源时逐个加入。`html` 为 `{"index.html":"index.html"}`，HTML 必须自包含。SDK 只复制 Python 文件，不执行 Python、依赖安装或 Python 构建脚本。`manifest.json` 自动纳入包；无需打包本说明、构建配置、开发 `.venv`、缓存或凭据。

无第三方依赖时 **同时不提供** `pyproject.toml` 和 `uv.lock`，本模板即此模式。有依赖时必须在包根 **同时提供** 非空的 `pyproject.toml` 和 `uv.lock`，并把两者加入 `assets`。在原 native 终端用 Python 3.12 和 uv 准备、锁定并验证依赖及目标平台的离线可用性。宿主在独立 venv 中执行 **offline + frozen** 依赖准备，不下载依赖、不改锁文件；缓存不完整或依赖不可离线安装会明确失败。不要把开发 venv 打进包。

仅做语法验证（缓存只生成在插件目录的 `__pycache__`，不打包）

```sh
python3.12 -I -m py_compile main.py
```

## 后台协议

Python 3.12 运行 `main.py`，stdin/stdout 使用 UTF-8 newline JSON-RPC 2.0，每帧最多 128 MiB。stdout 只能输出协议，勿 `print()` 调试。日志用 `await self.log('info', message)` → `notifications/message`；事件用 `await self.publish(topic, data)` → `notifications/matcha/event`。启动脚本/不可恢复的传输错误才使用 stderr 定位。

初始化读取 `initialize.params._meta.matcha = {pluginId, version, packagePath, storagePath}`，保存为简单的不可变 `Context`（Python 属性使用 snake_case）。`notifications/initialized` 后接收 `tools/list`、`tools/call`；`ping` 随时响应。`tools/list` 原样返回随包 manifest 的工具声明；扩展工具时同时修改 manifest 与 `call_tool`，在执行前验证输入。结果使用 `{content, structuredContent?, isError?, _meta?}`，不要把 rich result 压成 JSON 文本。`report_progress` 发送标准 `notifications/progress`。

### 反向调用宿主模型

在异步工具中调用 **已实现** 的 `await self.request_model(operation, request)`。六个 operation 与公开 SDK 一致：`list`、`generate`、`generateText`、`submitVideo`、`queryVideo`、`collectVideo`；生成可能收费，Echo 不走此路径。参数直接发送为原 `request`，不加 `{request: ...}` 包装；返回完整 result，宿主 JSON-RPC 错误以 `ModelError`（继承 `RpcError`）的 `.code`、消息和 `.data` 保留；未在工具内处理时转为 `isError` rich result，元数据保留 code/data。

```python
result = await self.request_model('generateText', {'prompt': 'Summarize this text'})
# result: {'text': ...}; 其他字段与 SDK App*ModelRequest / App*ModelResult 一致。
```

图片/视频请求遵守 SDK 的 `selectionId` 和原始 base64 字段；凭据由宿主保管。工具任务与 stdio 读循环独立，多个工具与模型请求可并发（各最多 128 个）；不要在工具中同步阻塞或脱离工具任务 fire-and-forget 模型调用。需要阻塞 I/O 时使用 `asyncio.to_thread`，需要超时时在调用处使用 `asyncio.timeout`。并发组合模型调用时使用 `asyncio.TaskGroup`，让异常或取消同时收束子任务；勿用会在首个失败后遗留其他请求的裸 `gather`。

双向 `notifications/cancelled {requestId, reason?}` 取消关联任务/pending；工具取消传播给正在 await 的反向模型请求，迟到响应丢弃，stdin EOF 取消所有运行任务并退出。取消意味着停止等待/请求停止，**不回滚外部效果、不撤销已发生费用、不自动重试**。禁止吞掉 `asyncio.CancelledError`；不要用 `asyncio.shield` 脱离工具的取消链。
