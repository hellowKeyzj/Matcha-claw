# LLM Wiki — MCP 工具参考

共用服务器：**`matcha`**。本文使用模型侧名称 **`matcha__wiki_*`**；服务器注册名称为对应的 `wiki_*`，由运行时加上服务器前缀供模型调用。

共 15 个 Wiki 工具。每次调用自动使用用户在 **Wiki 页或 Chat 输入框**选择的**全局当前库**，不绑定会话。模型不指定目标库，状态与列表只供查看，不是调用前置步骤。

全部输入为 JSON 对象，`additionalProperties: false`，不可添加表中未列出的字段。成功结果是返回 DTO 的 JSON，放在 MCP `content: [{type: "text", text: "<DTO JSON>"}]` 中；没有额外 `ok` 包装。下文展示解析后的 DTO。

所有状态变更工具均需用户明确要求；默认只读。

---

## matcha__wiki_status

输入：`{}`。只读，查看 运行组件 状态与当前库。

返回字段：

| 字段 | 含义 |
|---|---|
| `stateRoot` | Wiki 状态存储路径。 |
| `currentProject` | 当前库摘要，未选库时为 null。 |
| `projectCount` | 登记的库数量。 |
| `pendingChangeCount` | 当前变化队列条目数，不代表导入完成数。 |
| `layout` | 当前库布局状态，未选库时为 null。 |

`currentProject` 与下节 `projects[]` 共用库摘要 DTO：`projectId`、`title`、`rootPath`、`isCurrent`、`createdAtMs`、`openedAtMs`。

`layout` 为布尔字段对象：`rawSources`、`rawAssets`、`wikiEntities`、`wikiConcepts`、`wikiSources`、`wikiQueries`、`wikiComparisons`、`wikiSynthesis`、`wikiMedia`、`llmWiki`、`lancedb`、`fileSnapshot`、`fileChangeQueue`、`embeddingRevisions`。

---

## matcha__wiki_projects

输入：`{}`。只读，查看已登记的库。

```json
{
  "currentProjectId": "wiki-example",
  "projects": [
    {
      "projectId": "wiki-example",
      "title": "Research Notes",
      "rootPath": "C:/Users/me/wiki/research",
      "isCurrent": true,
      "createdAtMs": 0,
      "openedAtMs": 0
    }
  ]
}
```

`currentProjectId` 可为 null；它和 `projectId` 都是返回事实，不是工具输入或会话绑定。此工具只查看列表，不改变当前库。用户要换库时在 Wiki 页或 Chat 输入框切换，后续调用自动跟随；不需要先刷新列表。

---

## matcha__wiki_files

输入：`{directory?}`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `directory` | string 或 null | `""` | 库内相对目录；空字符串为库根目录。 |

返回**该目录的直接子项**，不是递归文件树：

```json
{
  "root": "wiki",
  "entries": [
    {
      "relativePath": "wiki/concepts",
      "isDirectory": true,
      "size": 0,
      "modifiedAtMs": 0
    }
  ]
}
```

`root` 为请求中的目录；目录大小与时间以实际结果为准。需要更深层内容时，对返回的目录继续调用此工具。

---

## matcha__wiki_read_file

输入：`{relativePath, limit?}`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `relativePath` | 非空 string，必填 | — | 当前库内文件相对路径，例如 `wiki/concepts/rope.md`。 |
| `limit` | 非负 integer 或 null | `0` | 0 为全文；正整数取前若干字符，不是行数或字节数。 |

```json
{
  "relativePath": "wiki/concepts/rope.md",
  "content": "# Rotary Position Embedding\n...",
  "revision": {
    "id": "example-revision",
    "size": 1234,
    "modifiedAtMs": 0
  }
}
```

`revision` 描述完整文件，即便本次 `content` 被 `limit` 截短。只能读取文本；无效路径、不存在的文件、目录与非 UTF-8 内容映射为 `Invalid params`。路径不允许绝对路径或 `..` 穿越，不尝试绕过限制。

---

## matcha__wiki_search

输入：`{query, limit?}`。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | 非空 string，必填 | — | 不能是纯空白。 |
| `limit` | 非负 integer 或 null | `20` | 后端将检索数量限制在 `[1, 50]`。 |

```json
{
  "query": "rope rotary position embedding",
  "hits": [
    {
      "relativePath": "wiki/concepts/rope.md",
      "title": "Rotary Position Embedding",
      "score": 0.0315,
      "snippets": ["通过旋转 Q 和 K 引入位置信息……"],
      "titleMatch": true,
      "vectorScore": 0.94,
      "images": [{"url":"wiki/media/rope-diagram.png","alt":"RoPE diagram"}],
      "content": null,
      "graphRelatedTo": []
    }
  ],
  "mode": "hybrid",
  "tokenHits": 78,
  "vectorHits": 14,
  "graphHits": 0
}
```

### 检索模式

后端根据当前配置与可用索引执行关键词、向量检索及图谱扩展，可能返回 `keyword`、`vector` 或 `hybrid`。向量不可用时可退回关键词；`hybrid` 也可能涉及图谱扩展，不应仅凭模式断言向量命中。

`tokenHits`、`vectorHits`、`graphHits` 分别报告关键词、向量与图谱扩展命中数量。**不同 `mode` 的分数尺度不同，不套用跨模式硬阈值**；在同一响应内参考排序和相对差距，并读正文验证。

### 命中字段

| 字段 | 说明 |
|---|---|
| `relativePath` | 库内页面相对路径，读取与引用使用它。 |
| `title` | 优先取页面开头元数据中的 `title:`，否则取第一个 `# ` 一级标题；都没有时，用去掉 `.md` 后缀的文件名，并将连字符替换为空格。 |
| `score` | 排序分数，不是事实置信度。 |
| `snippets` | 字符串数组，不是单个 `snippet`。关键词命中的片段以查询词或定位词为中心，保留前后约 80 个字符；仅由向量命中的片段取实际匹配文本块的前约 160 个字符，若有标题层级则加在片段前，例如“章节 > 小节：匹配内容……”。 |
| `titleMatch` | 查询词或短语是否匹配标题，标题匹配会影响排序。 |
| `vectorScore` | 原始向量相似度，可为 null；不作为通用事实阈值。 |
| `images` | 从正文 `![alt](url)` 中提取并按 URL 去重的图片引用数组，每项为 `{url, alt}`，可用于向用户展示页面中的图解。 |
| `content` | 此搜索工具不返回正文，值为 null。 |
| `graphRelatedTo` | 图谱扩展关联线索数组，需要读取相关页面核实。 |

不要把返回字段改称 `results`、`path` 或单数 `snippet`。

---

## matcha__wiki_graph

输入：`{}`。无过滤或数量参数；在返回数据中查找节点与邻居。

返回 `{nodes, edges, communities}`：

- `nodes[]`：`{id, label, kind, relativePath, linkCount, community}`。
- `edges[]`：`{from, to, confidence, weight}`。
- `communities[]`：`{id, nodeCount, cohesion, topNodes}`。

沿 `from` / `to` 匹配节点 `id` 可找关联；`relativePath` 可用于读取与引用。图谱关系不替代正文证据，不把边字段改称 `source` / `target`。

---

## matcha__wiki_rescan_sources

输入：`{}`。**改变状态，需要用户明确要求。**

扫描受跟踪文件，比较并更新文件快照，写入变化队列。返回与 `matcha__wiki_status` 相同的 DTO，可据 `pendingChangeCount` 报告队列条目数。

**不是导入处理，不是全量重建索引**；不返回旧版的 `changedTasks` 或 `result.queue`，也不保证导入、页面生成或向量索引完成。

---

## matcha__wiki_import_source

输入：`{sourcePath}`。**改变状态，需要用户明确要求。**

`sourcePath`：必填非空 string，待导入的本地源文件路径。外部文件会复制到当前库的 `raw/sources/`；应使用用户明确提供的实际路径，不猜测文件位置。

返回：`{sourceRelativePath, pageRelativePath, revision}`，其中 `revision` 的结构与读取文件相同。按真实返回报告导入结果。

---

## matcha__wiki_import_folder

输入：`{folderPath}`。**改变状态，需要用户明确要求。**

`folderPath`：必填非空 string，待导入的本地文件夹路径。不能是当前库本身或其内部文件夹。

返回：`{imported, skipped}`。

- `imported[]`：与导入单文件的返回 DTO 相同。
- `skipped[]`：`{path, reason}`。

不能把跳过的文件报告成成功导入。

---

## matcha__wiki_refresh_sources

输入：`{}`。**改变状态，需要用户明确要求。**

刷新当前库源文件，处理变化；这不是查看列表或检索前置步骤，也不等于全量重建索引。

返回：`{imported, deleted, moved, skipped}`。

- `imported[]`：`{sourceRelativePath, pageRelativePath, revision}`。
- `deleted[]`：与删除源文件的返回 DTO 相同。
- `moved[]`：`{oldSourceRelativePath, newSourceRelativePath, updatedPages, movedSummary}`，`movedSummary` 可为 null。
- `skipped[]`：`{path, reason}`。

---

## matcha__wiki_apply_generated_pages

输入：`{sourcePath, files}`。**改变状态，需要用户明确要求。**

| 参数 | 类型 | 说明 |
|---|---|---|
| `sourcePath` | 非空 string，必填 | 对应源文件路径，可使用实际返回的 `raw/sources/...` 相对路径。 |
| `files` | array，必填 | 每项严格为 `{path, content}`。 |
| `files[].path` | 非空 string，必填 | 待应用页面路径。 |
| `files[].content` | string，必填 | 页面正文，允许空字符串。 |

MCP 输入不接受额外的审核字段或任意文件写入参数。仅应用用户要求范围内的页面，不用它自行“修复”检索结果。

返回：`{writtenPages: [{relativePath, revision}]}`。以返回的页面路径为准，不假定所有请求路径原样落盘。

---

## matcha__wiki_delete_source

输入：`{sourcePath, fileAlreadyDeleted?}`。**改变状态，需要用户明确要求删除范围。**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sourcePath` | 非空 string，必填 | — | 要删除的源文件路径，可使用实际 `raw/sources/...` 相对路径。 |
| `fileAlreadyDeleted` | boolean 或 null | `false` | 仅文件确已删除时设 true，跳过删除源文件本身，继续清理相关内容。 |

返回：`{sourceRelativePath, deletedPages, updatedPages, deletedMedia}`。操作涉及源文件及相关生成页面、引用和媒体；按实际返回报告，不擅自扩大删除范围。

---

## matcha__wiki_source_tasks

输入：`{}`。只读，查看当前库导入和生成任务。

返回 `{tasks: [...]}`，任务字段：`id`、`projectId`、`sourcePath`、`kind`、`status`、`addedAtMs`、`updatedAtMs`、`retryCount`、`error`、`stage`、`progress`、`cancelRequestedAtMs`。

- `kind`：`created` / `modified` / `deleted` / `moved` / `imported` / `generated`。
- `status`：`pending` / `running` / `done` / `failed` / `cancelled`。
- `error`、`stage`、`progress`、`cancelRequestedAtMs` 可为 null。

这些是状态事实，不是新的调用参数。不要从任务存在推断已完成，也不要无限轮询。

---

## matcha__wiki_embed_page

输入：`{relativePath}`。**改变状态，需要用户明确要求。**

`relativePath`：必填非空 string，当前库内页面相对路径。为这一页写入本地向量索引，依赖当前嵌入配置可用；不是全库重建。

成功返回：`{"success": true}`。索引或嵌入配置不可用时映射为 `Internal error`，不要声称已经嵌入。

---

## matcha__wiki_retrieve_context

输入：`{query, limit?}`。只读。

参数与 `matcha__wiki_search` 一致，唯独默认 `limit: 8`。**使用同一检索算法**，返回同一搜索 DTO，命中的 `content` 附带正文；它不是另一套问答接口。结果仍在 `hits`，`snippets` 仍为数组。

读取正文后引用实际 `relativePath` 与正文里的来源链接。无法支持答案时明确说明证据不足。

---

## 限制与错误

### 输入约束

- 每个工具只接受自己的 参数定义 字段；必填字符串非空，`query` 不能纯空白。
- 可选字段省略或 null 使用默认值；`limit` 必须为非负整数，`fileAlreadyDeleted` 必须为布尔值或 null。
- 搜索和上下文检索数量限制在 `[1, 50]`；读取的 `limit: 0` 则表示全文。
- `files` 只列目录直接子项，不提供分页或递归参数；图谱不提供过滤参数。
- 文件读取是 UTF-8 文本读取，库内路径不能穿越目录。不要沿用其他接口的文件大小或速率限制。

### 错误映射

Wiki 工具适配层将失败统一映射到 JSON-RPC 错误，而不是带业务错误字段的成功 DTO：

| 错误 | Wiki 实际映射 | 处理 |
|---|---|---|
| `-32602` / `Invalid params` | 参数定义 / 参数解析失败；当前库未选择、库不存在、输入或路径无效、路径越界、文件不存在、目录、非文本。 | 检查参数与实际路径；未选库时请用户在界面选择。错误不细分原因，不能据此编造诊断。 |
| `-32603` / `Internal error` | 取消、运行组件 不可用、状态不可用、文件读写、索引异常或序列化失败。 | 如实说明失败，不无限重试，不把失败当作空库或已成功。 |

共用服务器对未知工具也返回 `Invalid params`，对未知 JSON-RPC 方法返回 `-32601` / `Method not found`。使用当前提供的 15 个 Wiki 工具，不猜测其他调用入口。

工具或连接不可用时，说明当前无法访问，检查 Matcha 与运行时的工具可用性；不绕过运行时读取或写入。

## 来源

原始文档来源：<https://github.com/nashsu/llm_wiki_skill>。本地适配的参数、调用分发和错误依据 `runtime-host/modules/wiki/src/adapters/mcp/mod.rs`，返回结构依据 Rust Wiki DTO 与共用 MCP 服务器。
