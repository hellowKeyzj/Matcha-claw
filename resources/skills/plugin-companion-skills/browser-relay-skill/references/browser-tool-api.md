# Browser Tool API 参考

## 基础原则

- 工具名是 `browser`
- 默认连接模式是 `relay`
- `direct-cdp` 只在明确要求或排障时使用
- 页面理解优先走 `snapshot`
- 页面执行优先走 `act`

## 状态与目标管理

### `action: "status"`

用途：

- 确认 Browser Relay 是否在线
- 看扩展是否已连接
- 看当前连接类型和 tab 数

### `action: "profiles"`

用途：

- 看当前有哪些浏览器实例可用
- 判断 relay / direct-cdp 的运行情况

### `action: "tabs"`

用途：

- 列出现有标签页
- 判断哪个 tab 是当前目标
- 看 `isAgent` / `isRetained` 等状态

### `action: "open"`

用途：

- 新开页面
- 创建 agent 自己的工作 tab

常见字段：

| 字段 | 说明 |
|------|------|
| `url` | 要打开的地址 |
| `retain` | 是否保留 tab，不随 `close_agent_tabs` 一起关掉 |

### `action: "focus"`

用途：

- 切到已知 `targetId` 的 tab

### `action: "close"`

用途：

- 关闭指定 `targetId`

### `action: "close_agent_tabs"` / `closeagenttabs`

用途：

- 统一清理 agent 自己创建的页面

## 页面理解

### `action: "snapshot"`

用途：

- 读取当前页面结构
- 获取后续 `act` 需要的 ref
- 判断当前页面是否正确

常见字段：

| 字段 | 说明 |
|------|------|
| `targetId` | 可选，显式指定目标页 |
| `selector` | 只截取局部区域 |
| `frame` | 指定 frame |
| `interactive` | 强调交互元素 |
| `compact` / `efficient` | 紧凑输出 |
| `depth` | 限制结构深度 |

### `action: "highlight"`

用途：

- 在真实页面高亮某个 ref
- 操作前确认 ref 是否命中正确元素

## 页面执行

### `action: "act"`

`act` 通过 `request.kind` 执行页面动作。

| kind | 用途 |
|------|------|
| `click` | 点击 |
| `type` | 输入文本 |
| `fill` | 一次填多个字段 |
| `select` | 选择下拉项 |
| `press` | 键盘按键 |
| `hover` | 悬停 |
| `drag` | 拖拽 |
| `scrollIntoView` | 把元素滚到视口 |
| `wait` | 等待条件成立 |
| `evaluate` | 页面上下文执行 JS |
| `resize` | 改页面尺寸 |
| `scroll` | 页面内滚动 |
| `close` | 关闭当前页 |

### `action: "navigate"`

用途：

- 在已有页面里跳到新 URL

常见字段：

| 字段 | 说明 |
|------|------|
| `url` | 新地址 |
| `waitUntil` | 等待条件 |
| `timeoutMs` | 超时 |

### `action: "scroll"`

用途：

- 触发懒加载
- 把长页面滚到目标位置

常见字段：

| 字段 | 说明 |
|------|------|
| `scrollDirection` | 滚动方向 |
| `scrollAmount` | 滚动距离 |

### `action: "dialog"`

用途：

- 预先处理 alert / confirm / prompt

### `action: "upload"`

用途：

- 给文件输入框设置文件

常见字段：

| 字段 | 说明 |
|------|------|
| `paths` | 文件路径数组 |
| `inputRef` | file input 的 ref |
| `element` | 备用元素定位 |

## 证据与诊断

### `action: "screenshot"`

用途：

- 保存视觉证据
- 向用户展示页面实际状态

常见字段：

| 字段 | 说明 |
|------|------|
| `ref` / `element` | 局部截图目标 |
| `fullPage` | 全页截图 |
| `type` | `png` / `jpeg` |
| `savePath` | 保存路径，优先使用工作区内相对路径 |

### `action: "pdf"`

用途：

- 导出当前页面 PDF

### `action: "errors"`

用途：

- 查看页面错误
- 用 `clear` 清空历史错误再复验

### `action: "requests"`

用途：

- 查看网络请求
- 用 `filter` 聚焦目标请求
- 用 `clear` 清空后重新观察

### `action: "cookies"`

支持：

- `operation: "get"`
- `operation: "set"`
- `operation: "clear"`

### `action: "storage"`

支持：

- `storageType: "local" | "session"`
- `operation: "get" | "set" | "clear"`

### `action: "console"`

用途：

- 执行 JS 表达式

注意：

- 当前这不是“看控制台日志”的专用动作
- 需要传 `expression`
- 想做页面上下文判断时，也可以用 `act -> evaluate`
