---
name: web-extract
description: "获取社交/内容网站数据，Bilibili/知乎/微博/Reddit/HN/V2EX/雪球/微信读书/BOSS直聘/arXiv 等 60+ 站点的结构化数据，自动复用Chrome登录态，零风险。"
allowed-tools: Bash(python:*)
---

# web-extract Skill

**核心规则：对已支持的站点和命令，优先用 web-extract（L1 站点能力包）；L1 未命中或执行失败时，降级使用 browser 操作浏览器完成任务。**

web-extract 不是通用的网页抓取工具，而是针对**已知主流站点**预置了专属适配器（L1 站点能力包），直接返回干净的结构化数据（JSON），无需解析 HTML、无需处理反爬，并自动复用用户 Chrome / Edge 已登录状态访问个人内容。

当 L1 能力包无法覆盖用户需求时（命令不存在或执行失败），应降级使用 browser 操作浏览器完成信息获取任务。

**适合用 web-extract 的场景：**

- 获取某个已知站点的热榜、排行、订阅流等聚合数据（如 Bilibili 热门、知乎热榜、Hacker News Top）
- 在已登录账号下抓取个人内容（如微读书摘、B站收藏、Twitter 时间线）
- 搜索特定站点内的内容（如搜索 Bilibili 视频、Reddit 帖子、Stack Overflow 问题）
- 对已支持站点执行写操作（如发推特、发微博、在BOSS直聘打招呼）
- 需要稳定结构化输出，而不是原始 HTML 或网页截图

**不适合用 web-extract、应直接使用 browser 的场景：**

- 目标站点不在支持列表中 → 直接使用 browser 操作浏览器完成任务
- 需要访问任意 URL 的原始内容 → 使用 browser 或 web_fetch
- 通用搜索引擎查询 → 使用 browser 或搜索工具

---

## 核心脚本

`run.py` — 跨平台统一入口，使用 `Path(__file__).resolve()` 自动定位脚本路径，无需 `cd` 切换目录，macOS 和 Windows 命令结构完全相同。

**`run.py` 位于本 SKILL.md 的同级目录。** 执行前先确认本文件的实际读取路径，取其所在目录作为 `<skill_path>`。

### 统一执行命令

```
python <skill_path>/run.py --site <站点> --command <命令> [--arg KEY=VALUE ...]
```

## 命令行参数

| 参数              | 说明                                                          |
| ----------------- | ------------------------------------------------------------- |
| `--list`          | 列出所有可用的站点和命令，支持用 `--site` 过滤                |
| `--site`          | 站点标识，如 `bilibili`、`zhihu`、`hackernews`                |
| `--command`       | 命令名，如 `hot`、`search`、`top`                             |
| `--arg KEY=VALUE` | 命令参数，可重复使用；多值参数用逗号分隔（见使用方式 Step 2） |

**执行规则（必须遵守）：**

1. 始终使用 `run.py` 作为入口，不要直接调用 `scripts/web-extract.py`
2. 始终使用绝对路径，不要使用相对路径
3. Windows 下多条命令之间用 `;` 分隔，不要用 `&&`（PowerShell 不支持 `&&`）
4. 禁止使用 `pty` 模式，PTY 会在输出中注入 ANSI 控制序列，破坏 JSON 结构

---

## 使用方式

### Step 1：查看支持的站点和命令

web-extract 支持的站点和命令是动态注册的，在执行任何命令前，先通过 `--list` 查看完整列表：

```
python <skill_path>/run.py --list
```

如果已知站点名称，可以只看该站点的命令：

```
python <skill_path>/run.py --list --site bilibili
```

`--list` 返回的每条记录包含：

- `site`：站点标识，如 `bilibili`
- `command`：命令名，如 `hot`、`search`
- `description`：命令简介
- `strategy`：认证方式，`cookie` 或 `header` 表示需要 Chrome / Edge 已登录，`public` 表示无需登录
- `args`：参数列表，每项包含 `name`、`required`、`default`、`help`

---

### Step 2：根据用户需求匹配并执行

拿到列表后，从中找到最符合用户意图的 `site` 和 `command`，然后执行：

```
python <skill_path>/run.py --site bilibili --command hot
```

构造参数时，参考 `--list` 返回的 `args` 字段：

- `required: true` 的参数需要从用户的描述中提取，如果用户没有提供，可以询问
- `required: false` 的参数按需传入，不确定时省略即可，适配器会使用 `default` 值

使用 `--arg key=value` 传递参数，无需 JSON、无引号转义，Windows/macOS 写法完全一致：

```
python <skill_path>/run.py --site bilibili --command search --arg query=Python教程
python <skill_path>/run.py --site bilibili --command search --arg query=Python教程 --arg limit=5
python <skill_path>/run.py --site bilibili --command hot --arg limit=10
```

**`--arg` 使用规则：**

- 多个参数重复写 `--arg`，每个 `--arg` 对应一个 `key=value`
- 数字值由 Server 端按适配器声明自动转换，无需手动处理类型
- 当参数支持多个值时（`help` 中含 "comma-separated" 或 "逗号分隔"），用逗号拼接在同一个值里，**不要**重复写 `--arg`：
  ```
  --arg job-type=full-time,contract
  --arg images=a.jpg,b.jpg,c.jpg
  ```

---

### 高频站点命令速查表

以下为常用站点的核心命令，可直接使用，无需先 `--list`。完整列表请通过 `--list` 查询。

| 站点        | 命令     | 说明           | 必选参数  | 常用可选参数                        |
| ----------- | -------- | -------------- | --------- | ----------------------------------- |
| bilibili    | hot      | B站热门视频    | —         | `limit`(默认20)                     |
| bilibili    | search   | 搜索B站视频    | `query`   | `limit`(默认20)                     |
| bilibili    | ranking  | B站排行榜      | —         | `limit`(默认20)                     |
| zhihu       | hot      | 知乎热榜       | —         | `limit`(默认20)                     |
| zhihu       | search   | 知乎搜索       | `query`   | `limit`(默认10)                     |
| weibo       | hot      | 微博热搜       | —         | `limit`(默认30)                     |
| weibo       | search   | 搜索微博       | `keyword` | `limit`(默认10)                     |
| weibo       | feed     | 微博关注时间线 | —         | `limit`(默认15)                     |


**示例：**

```
python <skill_path>/run.py --site bilibili --command hot --arg limit=10
```

---

### 决策流程（L1 优先，L4 browser 兜底）

```
用户请求获取网站信息
  ↓
速查表中有对应站点/命令？
  ├─ 是 → 直接执行 web-extract（无需 --list）
  └─ 否 → --list 查询是否有匹配的站点和命令
              ↓
           --list 中有对应命令？
              ├─ 是 → 执行 web-extract
              └─ 否 → 降级使用 browser
  ↓
执行成功？
  ├─ 是 → 返回结构化数据
  └─ 否（执行报错）→ 降级使用 browser 重试任务
```

**降级规则：**

- **L1 命令未命中**：`--list` 中无匹配站点或命令时，使用 browser 操作浏览器，按用户意图完成信息获取
- **L1 执行失败**：run.py 返回执行错误时，使用 browser 操作浏览器重试同一任务

---

## 常见场景示例

> 以下示例用 `<skill_path>` 占位，执行时替换为本 SKILL.md 所在目录的实际路径。

### 场景一：获取热榜/排行

```
python <skill_path>/run.py --site bilibili --command hot
python <skill_path>/run.py --site zhihu --command hot
python <skill_path>/run.py --site hackernews --command top
```

### 场景二：搜索站点内容

```
python <skill_path>/run.py --site bilibili --command search --arg query=Python教程
python <skill_path>/run.py --site bilibili --command hot --arg limit=10
```

### 场景三：获取个人内容（需已登录 Chrome / Edge）

```
python <skill_path>/run.py --site weread --command shelf
python <skill_path>/run.py --site bilibili --command history
```

---

## 展示规范

拿到 JSON 数据后向用户展示时，遵循以下规范：

1. 使用 Markdown 表格展示，列顺序参考命令返回的字段顺序
2. 英文标题或内容，**必须附上中文翻译**
3. 链接使用紧凑图标格式 `[🔗](url)`，不要使用 `[title](url)` 展开链接
4. 关键指标（score、views、likes 等）保留原始数字
5. 如果返回数据为空，提示用户可能原因（未登录 / 站点暂时不可用）

示例（HackerNews top）：

| #   | 原标题                       | 中文翻译               | 链接              | 分  | 评论 |
| --- | ---------------------------- | ---------------------- | ----------------- | --- | ---- |
| 1   | The 49MB web page            | 那个 49MB 的网页       | [🔗](https://...) | 388 | 196  |
| 2   | Show HN: I built a local LLM | 展示：我做了个本地 LLM | [🔗](https://...) | 312 | 84   |

---

## 注意事项

- 需要登录状态的命令（strategy 为 cookie 或 header）依赖用户 Chrome 或 Edge 浏览器的已登录状态，若抓取结果为空或报错，请告知用户确认 Chrome 或 Edge 中已登录对应站点
- 公开数据命令（strategy 为 public）无需登录，如 Hacker News、Wikipedia、V2EX、arXiv 等
- web-extract 抓取的是结构化数据，不是原始 HTML，通常可以直接用于分析和展示
- macOS 若提示 `python: command not found`，改用 `python3` 替代 `python`
