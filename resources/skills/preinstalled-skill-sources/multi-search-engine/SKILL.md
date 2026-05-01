---
name: "multi-search-engine"
description: "凡是需要使用 web_search 搜索任何信息时必须优先激活。覆盖所有联网查询场景：新闻、资讯、事件、价格、人物、公司、热点等。结合多引擎覆盖（百度/微信/集思录等中文源），并自动读取原文确认内容完整性。适用于任何需要联网查询的场景。"
---

# Multi Search Engine v2.1.0

结合 web_search 工具 + 多引擎爬取，覆盖中英文全场景，并强制读原文确认内容完整性。

---

## 🔁 标准搜索工作流（必须遵守）

### Step 1：并联搜索

同时使用两条路径获取结果：

**路径A — web_search（快速结构化）**
```
web_search({"query": "关键词", "count": 10})
```

**路径B — 多引擎 web_fetch（补充中文/专项源）**

根据问题类型选择引擎（见下方引擎选择策略），用 `web_fetch` 爬搜索结果页。

### Step 2：筛选原文

从两条路径的结果中，综合标题 + 摘要，挑选 **2~4 篇**最相关的文章 URL。

**选文章的判断标准（优先级从高到低）：**
1. 来源权威（官网、知名媒体、专业平台）
2. 时效性（优先最新内容）
3. 标题与问题高度匹配
4. 摘要显示内容完整、有实质信息

### Step 3：读原文

对每篇选中的文章执行 `web_fetch` 读取原文：
```
web_fetch({"url": "文章URL", "maxChars": 8000})
```

> ⚠️ 禁止仅凭摘要回答，必须读原文确认内容完整性。

### Step 4：综合回答

整合 web_search 结果 + 多引擎结果 + 原文内容，给出完整准确的回答。

---

## 🗺️ 引擎选择策略

| 场景 | 优先引擎 |
|------|---------|
| 中文资讯、国内动态 | 百度、头条、搜狗 |
| 微信公众号文章 | 微信搜狗 |
| 可转债、基金、投资 | 集思录 |
| 国际新闻、英文内容 | Google HK、DuckDuckGo |
| 隐私敏感查询 | DuckDuckGo、Startpage |
| 数学/换算/知识计算 | WolframAlpha |
| 代码/技术问题 | DuckDuckGo Bangs (`!gh`, `!so`) |

---

## Search Engines

### Domestic (8)
- **Baidu**: `https://www.baidu.com/s?wd={keyword}`
- **Bing CN**: `https://cn.bing.com/search?q={keyword}&ensearch=0`
- **Bing INT**: `https://cn.bing.com/search?q={keyword}&ensearch=1`
- **360**: `https://www.so.com/s?q={keyword}`
- **Sogou**: `https://sogou.com/web?query={keyword}`
- **WeChat**: `https://wx.sogou.com/weixin?type=2&query={keyword}`
- **Toutiao**: `https://so.toutiao.com/search?keyword={keyword}`
- **Jisilu**: `https://www.jisilu.cn/explore/?keyword={keyword}`

### International (9)
- **Google**: `https://www.google.com/search?q={keyword}`
- **Google HK**: `https://www.google.com.hk/search?q={keyword}`
- **DuckDuckGo**: `https://duckduckgo.com/html/?q={keyword}`
- **Yahoo**: `https://search.yahoo.com/search?p={keyword}`
- **Startpage**: `https://www.startpage.com/sp/search?query={keyword}`
- **Brave**: `https://search.brave.com/search?q={keyword}`
- **Ecosia**: `https://www.ecosia.org/search?q={keyword}`
- **Qwant**: `https://www.qwant.com/?q={keyword}`
- **WolframAlpha**: `https://www.wolframalpha.com/input?i={keyword}`

---

## Advanced Operators

| Operator | Example | Description |
|----------|---------|-------------|
| `site:` | `site:github.com python` | Search within site |
| `filetype:` | `filetype:pdf report` | Specific file type |
| `""` | `"machine learning"` | Exact match |
| `-` | `python -snake` | Exclude term |
| `OR` | `cat OR dog` | Either term |

## Time Filters（Google/Bing）

| Parameter | Description |
|-----------|-------------|
| `tbs=qdr:h` | Past hour |
| `tbs=qdr:d` | Past day |
| `tbs=qdr:w` | Past week |
| `tbs=qdr:m` | Past month |
| `tbs=qdr:y` | Past year |

## Bangs Shortcuts (DuckDuckGo)

| Bang | Destination |
|------|-------------|
| `!g` | Google |
| `!gh` | GitHub |
| `!so` | Stack Overflow |
| `!w` | Wikipedia |
| `!yt` | YouTube |

## WolframAlpha Queries

- Math: `integrate x^2 dx`
- Conversion: `100 USD to CNY`
- Stocks: `AAPL stock`
- Weather: `weather in Beijing`

---

## Documentation

- `references/international-search.md` - International search guide

## License

MIT
