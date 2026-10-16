# 真实模型链路测试

用于维护工程师复验 Rust app-server→真实 CLI→模型的已验场景，不是全产品、所有协议或所有平台认证。此前实测见 [进度记录](../../../docs/rust-app-server/progress.md)。

2026-10-17 Windows x64 正式套件实测：deepseek-v4.1-flash/glm-5.3-flash 的 24 个 case 全部通过，覆盖 5 Session、双模型 history close/resume、工具精确路径审批及实时 raw/durable/live/usage；7 个预持 CLI 句柄均确认退出，Server exit 0，无强杀或 Key 文件泄漏，观察到 22 个 thinking block。离线 Node audit 21/21、全项目 Bun 6,042/0、CLI typecheck 及正式 Rust release/Vite 构建通过；首轮失败报告保留，修正仅在审计器，不改产品或伪造 stop。

## 环境

- Python 3.10+（启动器只用标准库，无需 pip 安装）。
- Node.js 22+、Bun 1.3+、Rust 1.97；CLI 项目依赖已安装。
- 可用的 HTTPS OpenAI-compatible Chat Completions endpoint、模型名和 Key。

所有命令从仓库根目录执行。真实套件会调用模型并可能收费；只有明确运行命令才发请求，不自动重放业务请求，失败也不自动修改产品。

## 运行

PowerShell 最短操作（示例地址/模型须替换）：

```powershell
$env:MATCHA_TEST_BASE_URL = 'https://example.com/v1'
$env:MATCHA_TEST_MODELS = 'model-a,model-b'
python -I matcha-agent/app-server/tests/live/run.py
```

- `MATCHA_TEST_BASE_URL` 是 HTTPS Chat Completions API 根地址，例如 `/v1`，不是完整 `/chat/completions` 路径。
- `MATCHA_TEST_MODELS` 为逗号分隔模型列表；只填一个模型仍运行多 Session 场景。
- 不设置 `MATCHA_TEST_KEY` 时通过 getpass 隐藏输入 Key。换 Key 时重新运行并在提示中输入；换模型只改 `MATCHA_TEST_MODELS`。若环境已有旧 Key，先用 `Remove-Item Env:MATCHA_TEST_KEY -ErrorAction SilentlyContinue` 清除。
- CI 通过密钥注入设置 `MATCHA_TEST_KEY`；不把 Key 写进命令、shell 历史、`.env`、配置或仓库。

默认执行 Cargo release 和正式 Vite 构建；CLI 输出到新的 `target/live-cli-*` 目录，不覆盖 `dist`。已有构建可复用，两个路径均为绝对路径：

```powershell
python -I matcha-agent/app-server/tests/live/run.py --server 'E:/build/matcha-app-server.exe' --cli 'E:/build/bundle/cli.js'
```

可选参数：

| 参数 | 含义 |
|---|---|
| `--bun`、`--node` | 指定真实可执行文件路径，不传 shim 或 shell 命令。 |
| `--timeout` | 测试端 deadline，默认 180 秒，不是产品业务超时。 |
| `--require-thinking` | 要求观察到 thinking；默认未观察到时明确记 `notObserved`，不据此误判失败。 |

离线审计自检不调用模型：

```sh
node --test matcha-agent/app-server/tests/live/audit.test.mjs
```

## 覆盖与结果

真实套件覆盖正文、多 Session 上下文隔离、同 Session 排队/串行复用、实际并发、Write/Read/Edit 审批、deny 无文件副作用、AskUserQuestion、排队与执行中取消后复用、历史分页及 close/resume；核对 raw CLI→durable→WS 的顺序、text/thinking/tool 重组和 usage。没有 thinking 时的结果受上述选项控制；内部 cost 不是供应商账单。已确认 `native_interruption_observed` 的消息允许因中断截断并计入 `interruptedMessages`，未确认中断的普通消息缺少 message_stop 仍失败，不笼统认定全部消息完整。

启动器在系统 TEMP 新建隔离根目录，分别保存 server、home、cwd 和 raw；`capture.mjs` 旁路记录真实 CLI stdout，不改写送入 Rust 的输入。只管理/终止本次自建进程，不修改现有 Agent 或用户 runtime。

- 读取输出的隔离根目录下 `report.json` 和 `cleanup.json`；退出码非零表示失败，按报告定位，不把失败改写为通过。
- 原始 NDJSON、CLI transcript 留在临时目录，含合成模型输出/思考；不提交、不公开，完成排查后自行清理。
- 报告不含原始思考或 Key；文件 Key 字节扫描发现泄漏视为失败。secret 只经环境变量/内存引用传递，不读取本机真实凭据，不外发仓库内容。

仍未覆盖 UI/Renderer、其他模型协议、native auth 登录、hook 执行回传、外部 MCP/OAuth/微信/插件、持久 memory 注入、模型 fork/compact/snip 复杂恢复、技能执行及跨平台；通过只证明所测链路，不证明模型推理质量。服务/API 用法见 [app-server README](../../README.md)。
