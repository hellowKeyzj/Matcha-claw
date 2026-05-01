---
name: browser-relay
description: "MatchaClaw Browser Relay 浏览器自动化 skill。用于所有需要真实浏览器环境的任务，包括：访问动态网页、使用登录态页面、点击/输入/提交表单、读取页面结构、截屏/PDF 取证、上传文件、检查网络请求或页面错误、查看和修改 cookies / storage，以及任何需要通过 `browser` 工具完成的页面交互。默认优先使用 relay 模式；`direct-cdp` 仅在用户明确要求或排障时使用。"
---

# browser-relay Skill

## 前置检查

在开始浏览器操作前，先检查 Browser Relay 当前是否可用：

- 先调用 `browser` 的 `action: "status"`
- 需要列出现有标签页时，再调用 `action: "tabs"`
- 需要看浏览器实例情况时，再调用 `action: "profiles"`

如果未就绪，不要直接猜测浏览器状态，要先引导用户完成以下事项：

- 在 MatchaClaw 中启用 **Browser Relay** 模式
- 安装并启用 **MatchaClaw Browser Relay** Chrome 扩展
- 点击扩展图标，确认 badge 进入可用状态
- 在目标窗口点击 **Use This Window**

扩展 badge 含义：

| Badge | 含义 |
|------|------|
| `ON` | 已连接，可执行 relay 浏览器操作 |
| `...` | 正在连接 relay |
| `!` | 连接失败或 relay 不可用 |
| 空白 | relay 关闭 |

如果用户没有明确要求，不主动切到 `direct-cdp`。它是排障/调试路径，不是默认主路径。

## 浏览哲学

**像人在浏览器里完成任务一样思考，但用更稳的结构化动作去执行。**

执行网页任务时，不要把浏览器当成“只能机械点点点”的工具，而要围绕目标判断每一步：

**① 拿到请求**  
先明确用户到底要什么：是找信息、操作页面、读取证据，还是完成一段网页登录后的流程。先定义成功标准。

**② 选择起点**  
根据任务性质决定第一步：

- 已知 URL，先 `open` 或 `navigate`
- URL 不明确但任务需要真实页面，先进入一个最可能到达目标的入口页
- 已经有目标页并且用户希望继续当前页面，优先复用当前目标页

**③ 过程校验**  
每次动作后的结果都要用来更新判断：

- 页面结构和预期一致吗
- 当前路径在推进目标吗
- 这是站点限制、登录限制，还是目标本来就不存在

发现方向错了就调整，不要在错误路径上反复重试。

**④ 完成判断**  
任务完成后就停，不为了“多做一点”而继续扰动页面；如果创建了 agent 自己的标签页，结束时要清理。

## 浏览器动作选择

| 场景 | 优先动作 |
|------|---------|
| 检查浏览器是否在线 | `status` |
| 看当前可操作标签页 | `tabs` |
| 打开新页面 | `open` |
| 已有目标页内跳转 | `navigate` |
| 看当前页面结构、拿可操作 ref | `snapshot` |
| 点击、输入、提交、等待、执行页面内动作 | `act` |
| 页面太长，需要触发懒加载 | `scroll` |
| 操作前想确认 ref 对不对 | `highlight` |
| 保存截图证据 | `screenshot` |
| 导出页面 PDF | `pdf` |
| 上传文件 | `upload` |
| 检查页面错误 | `errors` |
| 检查网络请求 | `requests` |
| 看或改 cookies | `cookies` |
| 看或改 local/session storage | `storage` |
| 执行 JS 表达式 | `console` 或 `act -> evaluate` |

### Browser Tool 核心分层

| 分层 | 动作 | 作用 |
|-----|------|------|
| 浏览器状态层 | `status` `profiles` `tabs` | 判断浏览器是否可用、目标页在哪里 |
| 目标管理层 | `open` `focus` `close` `close_agent_tabs` | 管理标签页和执行目标 |
| 页面理解层 | `snapshot` `highlight` | 读取页面结构、定位可交互元素 |
| 页面执行层 | `act` `navigate` `scroll` `dialog` `upload` | 真正推动页面动作 |
| 证据与诊断层 | `screenshot` `pdf` `errors` `requests` `cookies` `storage` `console` | 保存结果、排障、取证 |

## 进入浏览器层后：`snapshot` 是眼睛，`act` 是手

进入 Browser Relay 之后，不要上来就盲点。

优先采用这条基本循环：

```text
open / focus / navigate
        |
        v
    snapshot
        |
        v
确认页面结构、拿到 ref、判断下一步
        |
        v
 act(click/type/fill/select/wait/evaluate/...)
        |
        v
    snapshot
```

### `snapshot` 的职责

- 看当前页面是不是对的
- 看有哪些可交互元素
- 拿后续 `act` 要用的 ref
- 判断是否已经完成任务

### `act` 的职责

`act` 不是单一动作，而是一组页面内动作：

| `request.kind` | 用途 |
|---------------|------|
| `click` | 点击元素 |
| `type` | 输入文本 |
| `fill` | 批量填表单 |
| `select` | 选择下拉项 |
| `press` | 键盘按键 |
| `hover` | 悬停 |
| `drag` | 拖拽 |
| `scrollIntoView` | 将元素滚入视口 |
| `wait` | 等文本、URL、selector、loadState 或等待时间 |
| `evaluate` | 在页面上下文执行 JS |
| `resize` | 改页面尺寸 |
| `scroll` | 页面内滚动 |
| `close` | 关闭当前页面 |

不确定某个 ref 对不对时，先 `highlight` 再 `act`。

## 浏览器 Relay 模式

### 默认模式：`relay`

`relay` 是主路径。

它的特点：

- 走 MatchaClaw Browser Relay 扩展
- 能天然复用用户 Chrome 的登录态
- 默认目标遵循 **已选择窗口 + 当前 attach 页面**
- `open` 和 `focus` 会把实际执行页面切到前台，保证用户看到的页面和自动化页面一致

### 调试模式：`direct-cdp`

只有在这些场景才考虑：

- 用户明确要求用 `direct-cdp`
- relay 扩展暂时不可用，需要排障确认
- 你在做浏览器连接层问题定位

不要默认切 `direct-cdp`，也不要把它当作普通任务的首选模式。

### 默认目标语义

> [!IMPORTANT]
> Browser Relay 不是“任意猜一个标签页来操作”，而是有明确默认目标的。

| 语义 | 说明 |
|-----|------|
| 一个 Chrome profile | 对应一个 browser instance |
| **Use This Window** | 选择默认执行窗口 |
| 默认目标 | 该窗口当前已 attach 的页面 |
| 没有当前 attach 页面 | 直接失败，不猜别的 tab |
| 显式传 `targetId` | 覆盖默认目标 |

## 页面内导航与状态处理

### 打开页面

- 需要新建自己的工作页面，优先 `open`
- 已有目标页但只需切到它，优先 `focus`
- 已在目标 tab 内继续跳转，优先 `navigate`

### 登录判断

登录判断的核心不是“站点有没有登录按钮”，而是：

**目标内容拿到了吗？**

如果目标内容已经可读，不要多此一举地要求用户重新登录。  
只有在确认内容被登录墙挡住，而且登录能解决问题时，才提示用户在自己的 Chrome 里完成登录，然后继续。

### 用户标签页与 agent 标签页

默认优先创建 agent 自己的工作标签页，不主动污染用户当前已有标签页。

任务结束后：

- 单页任务可 `close`
- 批量或分治任务可 `close_agent_tabs`

## 程序化动作与 GUI 交互

浏览器内同样有两种路径：

- **程序化路径**：`navigate`、`evaluate`、直接调用页面状态
- **GUI 路径**：`snapshot -> act(click/type/fill/select/...)`

选择原则：

| 场景 | 更适合 |
|-----|-------|
| URL 明确、跳转稳定 | 程序化路径 |
| 表单、按钮、站内流程 | GUI 路径 |
| 动态页面、复杂前端状态 | 先 `snapshot` 再 GUI |
| 不确定站点规则 | 先按真实用户交互探路 |

站点内真实交互得到的结果，比你手工猜页面状态更可靠。

## 信息核实类任务

核实网页信息时，目标是一手页面本身，而不是更多二手转述。

| 信息类型 | 优先来源 |
|---------|---------|
| 官网说明 | 官网原文页面 |
| 产品现状 | 产品后台或公开产品页 |
| 登录后数据 | 用户自己的真实浏览器页面 |
| 页面行为 | 当前页面的 DOM、请求、报错、本地状态 |

如果浏览器页面已经能直接看到原始内容，就不要退回抽象总结。

## 并行调研：子 Agent / 多标签页分治

任务包含多个彼此独立的网页目标时，可以合理分治：

- 每个子任务自己 `open` 新 tab
- 各自执行 `snapshot -> act -> snapshot`
- 各自收口后关闭自己创建的 tab

适合分治：

| 适合 | 不适合 |
|------|--------|
| 多个独立页面、多个独立来源 | 串行依赖很强的单流程任务 |
| 批量读取多个站点或多个结果页 | 只需轻量查看一个页面 |
| 每个子任务都有独立完成标准 | 下一步必须依赖上一步结果 |

## 任务结束

任务完成后：

- 保留用户自己的原有页面
- 关闭 agent 自己创建的页面
- 如有需要，补一张截图或导出 PDF 作为证据
- 不要无意义地继续滚动、刷新或试探页面

## References 索引

| 文件 | 何时加载 |
|------|---------|
| `references/browser-tool-api.md` | 需要看 Browser 工具动作、参数、典型调用方式时 |
| `references/troubleshooting.md` | relay 不通、目标页不对、扩展未连接、`direct-cdp` 排障时 |
