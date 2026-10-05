---
name: llm-wiki
description: "通过 Matcha 共用 MCP 服务器 matcha 查询用户的 LLM Wiki 知识库，支持页面检索、正文读取、目录、知识图谱和源文件任务查看。仅在用户明确提到 LLM Wiki、我的 wiki、我的知识库 / knowledge base，或要求查询 wiki 页面、知识图谱、扫描 wiki 源文件时触发；不用于泛指笔记、本地文件、Obsidian、Notion、Apple Notes、Logseq 等其他工具或开放网络检索。自动使用用户在 Wiki 页或 Chat 输入框选择的全局当前库，不绑定会话。默认只读；导入、刷新、扫描、写入、删除与嵌入仅在用户明确要求时执行。"
---

# LLM Wiki MCP 技能

通过共用 MCP 服务器 **`matcha`** 调用模型侧 **`matcha__wiki_*`** 工具。此 Skill 只提供指令与契约，不需要客户端库或脚本。

把 wiki 当作用户维护的**私人、结构化知识库**：页面在 `wiki/`，原始资料在 `raw/sources/`，页面链接构成知识图谱。

## 何时触发

仅当用户明确指向 **LLM Wiki / wiki / 知识库**：

- “我的 wiki / 我的知识库 / LLM Wiki 怎么解释 X？”
- “在我的 wiki / 知识库里搜 X。”
- 指定 wiki 页面的标题或文件名，要求读取或查找关联。
- 要求查看 wiki 图谱 / 知识图谱 / 概览 / 结构。
- 在 wiki 源文件目录添加或修改资料后，明确要求扫描、导入或刷新。
- “用我的 wiki 作为上下文 / 根据我的知识库回答。”
- 明确提到某个 wiki 库；调用仍只针对用户界面选择的当前库。

**不触发**：

- 未限定工具的“搜索我的笔记”或“在我的 notebook 里找”。
- 明确指向 Obsidian / Notion / Roam / Logseq / Apple Notes 等其他工具。
- 明确指向 Anki / Readwise / Pocket。
- 泛指“搜索我的文件 / Documents 文件夹”。
- 一般知识、时事或用户明确要求开放网络搜索。

不确定时问一句：“你指的是 LLM Wiki 知识库，还是其他工具？”不要擅自读取 wiki。

## 快速开始

直接使用下列工具名与 JSON 参数；路径必须来自实际返回：

```text
matcha__wiki_search {"query":"rope embedding","limit":5}
matcha__wiki_read_file {"relativePath":"wiki/concepts/rope.md","limit":0}
```

需要正文上下文时可直接用 `matcha__wiki_retrieve_context {"query":"rope embedding"}`。不要把状态查询或库列表查看变成检索前置步骤。

## 标准流程

1. **检索**：`matcha__wiki_search {query, limit?}`，默认 20 条。结果在 `hits`，包含 `relativePath`、`title`、`snippets` 数组、`score` 等，不含正文（`content: null`）。
2. **读取**：按真实 `hits[].relativePath` 调用 `matcha__wiki_read_file {relativePath, limit?}`。默认 `limit: 0` 读取全文，正整数只取前若干字符。也可用 `matcha__wiki_retrieve_context {query, limit?}`：同一检索算法，默认 8 条，命中附带正文。
3. **引用并回答**：依据读到的内容，引用每个页面的 `relativePath`，保留正文中实际存在的来源链接。无结果、证据不足或页面互相矛盾时明确说明，不能编造或把常识冒充库内结论。

### 如何看分数

`score` 的尺度取决于 `mode`（`keyword` / `vector` / `hybrid`）。仅比较同一响应内的排序与相对差距，再读正文核实；不要跨模式使用固定阈值。`vectorScore` 是可为空的向量相似度，不等于事实置信度。`graphRelatedTo` 表示图谱扩展线索，不证明页面支持答案。

### 当前库

当前库由用户在 **Wiki 页或 Chat 输入框**切换，是**全局状态，不绑定会话**。每次调用自动使用调用时的当前库，不由模型指定目标库，也不缓存会话级库绑定。

`matcha__wiki_status {}` 和 `matcha__wiki_projects {}` 只用于查看。用户要求查另一库时，请用户在界面切换后再继续原查询，不自动改库、不代为解析库标识、不要求先刷新列表才能检索。

图谱或交叉引用问题：

- `matcha__wiki_graph {}` 返回 `nodes`、`edges`、`communities`；在返回数据里按节点 `id`、`label`、`relativePath` 查找，沿边的 `from` / `to` 找邻居。
- 需要回答相关页面的具体内容时再读取正文，不从边关系推断未核实的语义。

源文件变化请求：

- 仅用户明确要求扫描时调用 `matcha__wiki_rescan_sources {}`，更新文件快照与变化队列，返回状态 DTO（含 `pendingChangeCount`）。
- 扫描**不是导入处理，也不是全量重建索引**；不能宣称页面已生成或索引已更新。查看源文件任务用 `matcha__wiki_source_tasks {}`，按真实状态报告。

## 工具契约

共 15 个 Wiki 工具；下表均为模型侧名称。所有调用只接受列出的参数，`?` 表示可选。

| 工具 | 参数 | 用途 |
|---|---|---|
| `matcha__wiki_status` | `{}` | 查看当前库和 运行组件 状态。 |
| `matcha__wiki_projects` | `{}` | 查看已登记的库。 |
| `matcha__wiki_files` | `{directory?}` | 列出目录直接子项，默认空字符串即库根目录。 |
| `matcha__wiki_read_file` | `{relativePath, limit?}` | 读取文本，默认 0 为全文。 |
| `matcha__wiki_search` | `{query, limit?}` | 检索，无正文，默认 20。 |
| `matcha__wiki_graph` | `{}` | 读取图谱。 |
| `matcha__wiki_rescan_sources` | `{}` | 扫描快照差异；改变状态。 |
| `matcha__wiki_import_source` | `{sourcePath}` | 导入源文件；改变状态。 |
| `matcha__wiki_import_folder` | `{folderPath}` | 导入文件夹；改变状态。 |
| `matcha__wiki_refresh_sources` | `{}` | 刷新源文件；改变状态。 |
| `matcha__wiki_apply_generated_pages` | `{sourcePath, files: [{path, content}]}` | 应用生成页面；改变状态。 |
| `matcha__wiki_delete_source` | `{sourcePath, fileAlreadyDeleted?}` | 删除源文件及相关页面，布尔值默认 false；改变状态。 |
| `matcha__wiki_source_tasks` | `{}` | 查看导入和生成任务。 |
| `matcha__wiki_embed_page` | `{relativePath}` | 为单页建立向量索引；改变状态。 |
| `matcha__wiki_retrieve_context` | `{query, limit?}` | 同算法检索并附带正文，默认 8。 |

参数类型、返回字段及错误见 [api-reference.md](api-reference.md)，不要猜测额外参数。

## 错误处理

- `-32602` / `Invalid params`：参数不符合 参数定义，或未选当前库、路径无效、文件不存在、是目录或非文本。检查已知输入；必要时请用户在界面选库。错误不区分上述原因，不武断诊断，也不盲目重试。
- `-32603` / `Internal error`：取消、运行组件 / 状态 / 文件读写 / 索引异常被统一映射到此错误。说明调用失败，不循环重试、不声称库无内容。
- 工具不可用或连接失败：说明当前无法访问 Wiki 工具，请检查 Matcha 与运行时工具可用性；不绕过运行时使用其他入口。

## 使用礼仪

- **引用路径与来源**：使用真实页面路径；来源链接只能来自已读取内容。
- **默认只读**：用户要求回答、检索或读取，不构成扫描、导入、刷新、写入、删除、嵌入的授权。写操作前明确范围。
- **按需读取与输出**：理解结论所需的证据要读；用户未要求时不要倾倒全文。
- **尊重当前库**：不偷偷换库、不把会话绑定到旧库；跨库比较需用户逐次切换，保留各次实际读到的证据并标注库名。
- **不绕过工具写文件**：不直接修改 `wiki/` 或 `raw/sources/`；使用对应的写工具或桌面界面的导入流程。

## 另见

- [api-reference.md](api-reference.md) — 完整工具参数、返回 DTO 与错误映射。
- [examples.md](examples.md) — 对话请求与 MCP 调用模式。
- [README.md](README.md) — 人类用户的启用、前提与排障说明。
- 原始文档来源：<https://github.com/nashsu/llm_wiki_skill>。
