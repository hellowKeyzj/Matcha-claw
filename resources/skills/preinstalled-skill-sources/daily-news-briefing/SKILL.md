---
name: daily-news-briefing
description: "Universal daily news briefing generator. Aggregates and summarizes the latest news on ANY topic the user specifies (AI, finance, geopolitics, sports, tech, science, etc.) from multiple sources. Activates when user asks for today's news, daily briefing, or latest updates on any subject — e.g. '给我今天的AI资讯', '帮我整理一下美股新闻', '科技行业有什么新动态', '今日财经简报'."
---

# 📰 Universal Daily News Briefing

> Aggregates the latest news on **any topic** from multiple sources and delivers concise summaries with direct links.

## When to Use This Skill

Activate this skill when the user:

- Asks for today's news / latest updates on **any topic**
- Requests a daily briefing or news summary
- Mentions wanting to know what's happening in a specific field or industry
- Says: "给我今天的XX资讯" / "帮我整理XX新闻" / "XX有什么新动态"
- Examples of supported topics: AI、科技、财经、美股、A股、加密货币、地缘政治、体育、科学、游戏、医疗...

**Key principle: The topic is determined by the user's input, not hardcoded.**

---

## Workflow Overview

```
Step 0: Identify Topic & Scope from User Input
      ↓
Phase 1: Information Gathering
  ├─ Direct website fetching (3-5 topic-relevant news sites)
  └─ Web search with date filters
      ↓
Phase 2: Content Filtering
  ├─ Keep: Last 24-48 hours, significant developments
  └─ Remove: Duplicates, minor updates, off-topic content
      ↓
Phase 3: Categorization (topic-adaptive)
  └─ Organize into 4-6 relevant subcategories
      ↓
Phase 4: Output Formatting
  └─ Present with links and structure
```

---

## Step 0: Identify Topic & Scope

Before gathering news, extract from the user's message:

| Field          | How to determine                                                          |
| -------------- | ------------------------------------------------------------------------- |
| **Topic**      | Explicit mention ("AI", "财经", "美股") or inferred from context          |
| **Scope**      | Global / regional / company-specific                                      |
| **Time range** | Default: last 24 hours; adjust if user specifies ("this week", "最近3天") |
| **Language**   | Match user's language; default: Chinese for Chinese users                 |
| **Depth**      | Brief / Standard (default) / Deep                                         |

If the topic is unclear, ask: "您想了解哪个领域的日报？（例如：AI、科技、财经、地缘政治等）"

---

## Phase 1: Information Gathering

### Step 1.1: Select Topic-Relevant Sources

Choose 3-5 primary sources based on the identified topic:

**AI / Technology:**

- 机器之心: https://www.jiqizhixin.com/
- 36氪 AI频道: https://36kr.com/information/AI/
- 量子位: https://www.qbitai.com/
- 新智元: https://www.atyun.com/
- AI Hub Today: https://ai.hubtoday.app/

**Finance / Markets (Global):**

- 雪球全球市场: https://xueqiu.com/

**Finance / Markets (China / A股):**

- 财联社: https://www.cls.cn/
- 东方财富: https://www.eastmoney.com/
- 新浪财经: https://finance.sina.com.cn/

**Crypto / Web3:**

- Decrypt: https://decrypt.co/

**Geopolitics / World News:**

- 参考消息: http://www.cankaoxiaoxi.com/
- 环球网: https://www.huanqiu.com/

**Science:**

- 中国科学报: https://news.sciencenet.cn/
- Science Daily: https://www.sciencedaily.com/
- 果壳网: https://www.guokr.com/

**Sports:**

- 虎扑体育: https://www.hupu.com/
- 新浪体育: https://sports.sina.com.cn/

> If the topic doesn't match a preset category above, search for the top 3-5 authoritative sources for that domain dynamically.

### Step 1.2: Execute Web Search Queries

Use `web_search` with date-filtered queries:

**Query Template** (adapt keywords to the identified topic):

```
General:   "[TOPIC] news today" OR "[TOPIC] latest updates" after:[YESTERDAY_DATE]
Events:    "[TOPIC] announcement" OR "[TOPIC] breaking news" after:[YESTERDAY_DATE]
Analysis:  "[TOPIC] trends" OR "[TOPIC] analysis" after:[YESTERDAY_DATE]
```

For Chinese topics, also search in Chinese:

```
"[主题] 最新消息 今日"
"[主题] 新动态"
```

**Best Practices**:

- Always use current date or yesterday's date in filters
- Execute 2-3 queries across different angles
- Prioritize results from last 24-48 hours

### Step 1.3: Fetch Full Articles (Top 10-15)

For the most relevant stories found:

- Fetch full article content using `web_fetch`
- Ensures accurate summarization vs. just using snippets

---

## Phase 2: Content Filtering

### Filter Criteria

**Keep**:

- News from last 24-48 hours (preferably today)
- Major announcements, significant events, notable developments
- Verified information from authoritative sources

**Remove**:

- Duplicate stories (keep most comprehensive version)
- Minor updates or marketing fluff
- Content older than 3 days (unless highly significant)
- Off-topic content

---

## Phase 3: Categorization (Topic-Adaptive)

Dynamically define 4-6 subcategories based on the topic. Examples:

**AI / Tech topic:**

- 🔥 重大发布 (Major Announcements)
- 🔬 研究突破 (Research & Papers)
- 💰 行业动态 (Industry & Business)
- 🛠️ 工具应用 (Tools & Applications)
- 🌍 政策监管 (Policy & Regulation)

**Finance / 财经 topic:**

- 📈 市场行情 (Market Movements)
- 🏢 公司动态 (Corporate News)
- 🌐 宏观经济 (Macro & Economy)
- 💹 资金流向 (Capital & Investment)
- 📊 数据报告 (Data & Reports)

**Geopolitics topic:**

- ⚡ 突发事件 (Breaking Events)
- 🤝 外交动态 (Diplomacy)
- 🪖 军事安全 (Military & Security)
- 📉 经济制裁 (Economic Measures)
- 🗳️ 国内政治 (Domestic Politics)

**Other topics**: Derive relevant categories from the subject matter.

---

## Phase 4: Output Formatting

Use this template, substituting `[TOPIC]` with the actual topic:

```markdown
# 📰 [TOPIC] 日报 · [Current Date]

**主题**: [TOPIC]
**时间范围**: [Time range, e.g., 过去24小时]
**来源数量**: [X] 篇文章 · [Y] 个来源

---

## [Category Emoji] [Category Name]

### [Headline 1]

**摘要**: [One-sentence overview]

**要点**:

- [Key detail 1]
- [Key detail 2]
- [Key detail 3]

**影响/意义**: [Why this matters - 1 sentence]

📅 **来源**: [Publication Name] · [Publication Date]
🔗 **链接**: [URL]

---

### [Headline 2]

[Same format]

---

## [Next Category]

[Same format]

---

## 🎯 今日要点

1. [Most important development]
2. [Second most important]
3. [Trend worth watching]

---

_生成时间: [Timestamp] | 下次更新: 明日同时_
```

**Output language**: Match the user's language (Chinese input → Chinese output, English input → English output).

---

## Customization Options

After providing the initial briefing, offer:

### Focus / Filter

- "要我只看某类子板块吗？比如只看市场行情 / 只看研究论文"
- Specific company or entity focus

### Depth

- **Brief**: Headlines + 2-3 bullets
- **Standard**: Summaries + key points (default)
- **Deep**: Include analysis and expert reactions

### Time Range

- Last 24 hours (default)
- Last 3 days / Last week / Custom

### Format

- By category (default)
- Chronological
- By significance

---

## Follow-up Interactions

| User says                                  | Action                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| "Tell me more about [story X]"             | Fetch full article, provide detailed summary + analysis |
| "What are experts saying about [topic Y]?" | Search for expert opinions and analysis pieces          |
| "Change topic to [Z]"                      | Re-run workflow with new topic                          |
| "Only show [subcategory]"                  | Filter and reorganize output                            |
| "用中文/英文给我"                          | Switch output language                                  |

---

## Quality Standards

- ✅ All links valid and accessible
- ✅ No duplicate stories
- ✅ All items timestamped (preferably today)
- ✅ Summaries accurate (not hallucinated)
- ✅ Links lead to original sources
- ✅ Mix of sources (not all from one publication)
- ✅ Categories match the topic (not generic)

### Error Handling

- `web_fetch` fails → Skip, try next source
- Search returns no results → Expand date range or try different query
- Content is paywalled → Use available excerpt, note limitation
- Topic is ambiguous → Ask user to clarify before proceeding

---

## Examples

### Example 1: AI 资讯

**User**: "给我今天的AI资讯"
**Action**: Topic=AI, run full workflow, present structured AI briefing

---

### Example 2: 财经日报

**User**: "帮我整理一下今日财经新闻"
**Action**: Topic=Finance/财经, select finance sources, categorize into market/macro/corporate

---

### Example 3: 地缘政治

**User**: "美伊局势最新动态"
**Action**: Topic=US-Iran/Geopolitics, search focused queries, present geopolitics briefing

---

### Example 4: 自定义主题

**User**: "游戏行业今天有什么新动态？"
**Action**: Topic=Gaming Industry, dynamically select gaming news sources, adapt categories accordingly

---

### Example 5: 周报模式

**User**: "给我本周的科技新闻汇总"
**Action**: Topic=Tech, time range=last 7 days, present weekly digest
