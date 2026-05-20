# Browser Tool API 参考

工具名是 `browser`。默认使用 relay；除非用户明确要求或正在排障，不传 `connectionMode`。

## 快速模板

### 新开工作页并读取

```json
{"action":"open","url":"https://example.com"}
```

```json
{"action":"snapshot","compact":true}
```

### 复用当前目标页

```json
{"action":"snapshot","compact":true}
```

如果报“没有当前目标”，再用：

```json
{"action":"status"}
```

```json
{"action":"tabs"}
```

### 选择明确 tab

```json
{"action":"tabs"}
```

```json
{"action":"focus","targetId":"TARGET_ID_FROM_TABS"}
```

### 点击

```json
{"action":"act","request":{"kind":"click","ref":"e5","timeoutMs":8000}}
```

### 输入并回车

```json
{"action":"act","request":{"kind":"type","ref":"e3","text":"matcha claw","submit":true}}
```

### 批量填表

```json
{
  "action":"act",
  "request":{
    "kind":"fill",
    "fields":[
      {"ref":"e3","type":"text","value":"Ada"},
      {"ref":"e4","type":"text","value":"ada@example.com"},
      {"ref":"e5","type":"checkbox","value":true}
    ]
  }
}
```

### 等页面变化

```json
{"action":"act","request":{"kind":"wait","text":"Success","timeoutMs":15000}}
```

```json
{"action":"snapshot","compact":true}
```

### 长页面找内容

先过滤，不要先无限滚动：

```json
{
  "action":"snapshot",
  "compact":true,
  "filter":{"keywords":["pricing","enterprise"],"contextLines":2,"maxMatches":20}
}
```

需要触发懒加载时：

```json
{"action":"scroll","scrollDirection":"down","scrollAmount":900}
```

```json
{"action":"snapshot","compact":true}
```

### 截图 / PDF 证据

```json
{"action":"screenshot","fullPage":false}
```

```json
{"action":"screenshot","ref":"e7"}
```

```json
{"action":"pdf","savePath":"artifacts/page.pdf"}
```

### 诊断页面

```json
{"action":"errors"}
```

```json
{"action":"requests","filter":"api"}
```

```json
{"action":"requests","clear":true}
```

## 动作清单

### 状态与目标

| action | 用途 |
|------|------|
| `status` | 检查 relay/扩展/连接状态 |
| `profiles` | 查看浏览器实例概况 |
| `tabs` | 列出可操作 tab |
| `open` | 新建 agent 工作 tab |
| `focus` | 切到指定 `targetId` |
| `close` | 关闭指定 tab |
| `close_agent_tabs` / `closeagenttabs` | 清理 agent 创建的 tab |

### 页面理解

| action | 用途 |
|------|------|
| `snapshot` | 获取 ARIA 页面结构和 refs |
| `highlight` | 高亮 ref，确认将要操作的元素 |

`snapshot` 常用字段：

| 字段 | 说明 |
|------|------|
| `targetId` | 指定 tab |
| `selector` | 截取局部 DOM |
| `frame` | 指定 frame |
| `interactive` | 只强调交互元素 |
| `compact` / `efficient` | 紧凑输出 |
| `depth` | 限制结构深度 |
| `filter` | 按 keywords / roles 裁剪上下文 |

### 页面执行

`act` 通过 `request.kind` 执行动作。

| kind | 用途 |
|------|------|
| `click` | 点击 |
| `type` | 输入文本 |
| `fill` | 批量填字段 |
| `select` | 下拉选择 |
| `press` | 键盘按键 |
| `hover` | 悬停 |
| `drag` | 拖拽 |
| `scrollIntoView` | 滚入视口 |
| `wait` | 等待文本、URL、selector、loadState、时间或函数 |
| `evaluate` | 页面上下文执行 JS |
| `resize` | 改 viewport |
| `scroll` | 页面内滚动 |
| `close` | 关闭当前页 |

其他执行动作：

| action | 用途 |
|------|------|
| `navigate` | 在已有 tab 跳转 URL |
| `scroll` | 触发页面滚动 |
| `dialog` | 预设 alert/confirm/prompt 处理 |
| `upload` | 设置文件输入 |

### 证据与状态

| action | 用途 |
|------|------|
| `screenshot` | 保存视觉证据 |
| `pdf` | 导出 PDF |
| `errors` | 读取页面 JS 错误 |
| `requests` | 读取网络请求 |
| `cookies` | get/set/clear cookies |
| `storage` | get/set/clear localStorage/sessionStorage |
| `console` | 执行 JS expression |

## 恢复套路

### ref 失效

```json
{"action":"snapshot","compact":true}
```

重新选择 ref。必要时：

```json
{"action":"highlight","ref":"e5","durationMs":2000}
```

### 页面没加载完

```json
{"action":"act","request":{"kind":"wait","loadState":"domcontentloaded","timeoutMs":10000}}
```

或等待具体文本/selector，再 `snapshot`。

### 操作到了错误页面

```json
{"action":"tabs"}
```

选择正确 `targetId` 后：

```json
{"action":"focus","targetId":"TARGET_ID_FROM_TABS"}
```

### 需要页面内 JS 判断

优先用 `act -> evaluate`，可绑定 ref：

```json
{
  "action":"act",
  "request":{
    "kind":"evaluate",
    "ref":"e5",
    "fn":"(el) => ({ text: el.innerText, disabled: el.disabled === true })"
  }
}
```

全页表达式可用 `console`：

```json
{"action":"console","expression":"document.title"}
```

注意：`console` 不是读取 console log 的工具。
