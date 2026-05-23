# ingest（消化素材）

这是最核心的工作流。用户给一个素材进来，AI 做所有的整理工作。

### 前置检查

执行**通用前置检查**（见 `../references/workspace.md`）。

### 隐私自查提示（首次进入 ingest 必须执行）

在开始提取或分析任何内容之前，AI **必须**先对用户说下面这句话，然后等待确认：

> 在开始分析这份素材前，请先快速确认里面**不**包含这些敏感内容：
>
> - 手机号码（如 138xxxxxxxx）
> - 身份证号（18 位数字）
> - API 密钥（`sk-...`、`AIzaSy...`、`OPENAI_API_KEY=`、`ANTHROPIC_API_KEY=`、`Bearer ...`）
> - 明文密码（`password=`、`passwd=`）
> - 其他你不希望进入知识库的个人信息
>
> 如果素材里有上面任何一项，请先用文本编辑器删除或脱敏后再继续。
> llm-wiki **不会**自动过滤这些内容，处理后的内容会进入你的知识库。
>
> 确认无上述内容请回复 `y`，要中止请回复 `n`。

**流程规则**：

- 用户回复 `y`（或"可以"、"继续"、"没有"等明确肯定）→ 继续执行后续步骤
- 用户回复 `n`（或"停"、"取消"等明确否定）→ 终止本次 ingest，提示用户清理后再来
- 其他不明确的回复 → 再问一次，最多两次；两次都不是明确 y/n 则终止
- **绕过规则**：如果用户在当前对话里已经明确说过"素材里没有敏感信息，直接开始"，
  或者用户是在 `batch-ingest` 流程中（已经在顶层确认过一次），AI 可以跳过这一步

**为什么是自查清单而不是脚本**：
- 正则在非结构化文本（聊天记录、笔记）里误报率很高，错过真的敏感词，误报无害的普通词
- 把判断权还给用户，比让脚本决定更可靠
- 对新手更友好，不会遇到看不懂的脚本报错

### 素材提取路由

根据素材类型自动路由到最佳提取方式：

**外挂前置判断**：

- URL 先调用 `bash ${SKILL_DIR}/scripts/source-registry.sh match-url "<url>"`
- 本地文件先调用 `bash ${SKILL_DIR}/scripts/source-registry.sh match-file "<path>"`
- 纯文本粘贴直接调用 `bash ${SKILL_DIR}/scripts/source-registry.sh get plain_text`
- `source-registry.sh` 返回 10 列：`source_id`、`source_label`、`source_category`、`input_mode`、`match_rule`、`raw_dir`、`adapter_name`、`dependency_name`、`dependency_type`、`fallback_hint`
- 调用 `bash ${SKILL_DIR}/scripts/adapter-state.sh check <source_id>`
- 从 `adapter-state.sh check` 的 8 列结果里读取 `state`、`detail`、`recovery_action`、`install_hint`、`fallback_hint`
- 如果 `state=not_installed` / `env_unavailable` / `unsupported` → 不调用外挂，直接按 `detail`、`recovery_action`、`install_hint`、`fallback_hint` 告诉用户下一步
- 只有返回 `available` 时，才继续自动提取

**URL 类素材**（统一走来源总表，不手写域名表）：

> **Chrome 提示**（仅当 `adapter_name=baoyu-url-to-markdown` 时）：
> adapter-state.sh check 会把“提取器可用”与“是否存在 9222 可复用会话”分开表达。
> 如果 check 返回 `available`，正常调用外挂；即使 detail 提示未检测到 9222，也继续执行。baoyu-url-to-markdown 会自己处理 Chrome 启动，**继续执行，不要等待用户确认**。
> 只有在你想复用当前已登录的 Chrome 会话时，才需要手动开启 9222。
> 如果提取仍然失败（通常是页面需要登录态，如 X/Twitter、知乎等），可提示用户开启调试端口复用已登录会话：`open -na "Google Chrome" --args --remote-debugging-port=9222`

- 如果 `source_category=manual_only` → 不调用外挂，直接使用 `fallback_hint`
- 如果 `adapter_name=wechat-article-to-markdown` → 执行 `wechat-article-to-markdown "<URL>"`
- 如果 `adapter_name=youtube-transcript` → 调用 `youtube-transcript`
- 如果 `adapter_name=baoyu-url-to-markdown` → 调用 `baoyu-url-to-markdown`

**本地文件**：
- 统一走 `bash ${SKILL_DIR}/scripts/source-registry.sh match-file "<path>"`
- 命中后直接读取，不调用外挂

**纯文本粘贴**：
- 统一视为 `plain_text`
- 直接使用用户提供的文本

**统一回退规则**：

- 对自动提取结果，统一运行 `bash ${SKILL_DIR}/scripts/adapter-state.sh classify-run <source_id> <exit_code> <output_path>`
- 从 `classify-run` 返回的 8 列结果里读取 `state`、`detail`、`recovery_action`、`fallback_hint`
- 如果返回 `runtime_failed` → 按 `detail`、`recovery_action`、`fallback_hint` 告诉用户“这次自动提取失败，可以先重试一次；如果还不行，就改走手动入口”
- 如果返回 `empty_result` → 按 `detail`、`recovery_action`、`fallback_hint` 告诉用户“自动提取没有拿到有效正文，请手动补全文本后继续”
- 其他状态也使用同一份返回结果，不再手写第二套回退文案

### 内容分级处理

根据素材长度和信息密度自动选择处理级别：

**判断标准**：
- 素材内容 > 1000 字 → **完整处理**
- 素材内容 <= 1000 字（短推文、小红书笔记等）→ **简化处理**

### 完整处理流程（长素材 > 1000 字）

1. **提取素材内容**：按上面的路由获取素材文本

2. **保存原始素材**到 `raw/` 对应目录：
   - 根据素材类型保存到对应目录（articles/、tweets/、wechat/、xiaohongshu/、zhihu/ 等）
   - 文件名格式：`{日期}-{短标题}.md`
   - 如果是 URL 类素材，在文件头部记录原始 URL

   **图片检测与追踪**：保存素材后，扫描内容中是否包含图片引用（`![` 或 `<img` 或 `.png`/`.jpg`/`.gif`/`.svg` URL）。如果检测到图片：
   - 告诉用户："素材包含 {N} 张图片引用。图片链接可能失效，建议手动下载到 `raw/assets/`（Obsidian 用户可在设置中绑定快捷键一键下载附件）"
   - 在后续 source 页面的 frontmatter 中：
     - `images`：记录检测到的图片引用数量
     - `image_paths`：如果用户已将图片下载到 `raw/assets/`，用 YAML block list 格式记录路径；如果尚未下载，保持为空数组 `[]`。示例：
       ```yaml
       image_paths:
         - raw/assets/2026-01-15-fig1.png
         - raw/assets/2026-01-15-fig2.jpg
       ```
   - 不阻塞 ingest 流程，仅做提醒
   - 用户后续下载图片后，可以手动更新 source 页面的 `image_paths`，或在下次 lint 时由 AI 辅助补全

3. **读取上下文**：
   - 优先顺序：`purpose.md` > `.wiki-schema.md` > `index.md`
   - 如果 `purpose.md` 存在，先读取其中的核心目标、关键问题和研究范围
   - 用 `purpose.md` 指导后续实体、主题、关联的取舍和权重

4. **缓存检查**：
   - 在进入 LLM 处理前，先运行：
     ```bash
     bash ${SKILL_DIR}/scripts/cache.sh check “<raw 文件路径>”
     ```
   - 如果返回 `HIT` 或 `HIT(repaired)` → 跳过本次 LLM 调用，直接读取已有 wiki 页面，并告诉用户这是”无变化，直接复用已有结果”
     - `HIT(repaired)` 表示缓存自愈修复成功（上次 update 被跳过但 source 页面存在且 source_path 匹配）
   - 如果返回 `MISS:<reason>` → 继续执行下面的两步流程
     - `MISS:no_entry` — 首次处理此素材（正常情况）
     - `MISS:hash_changed` — 素材内容有变化，需要重新处理
     - `MISS:no_source` — 有缓存记录但 source 页面被删除了
     - `MISS:repaired_needs_verify` — 找到同名 source 页面但 source_path 不匹配，需要重新处理以确认关联正确

5. **Step 1：结构化分析**：
   - 输入：原始内容 + `purpose.md` + 现有 wiki 结构（至少读取 `index.md` 概要）
   - 输出：JSON 格式的分析结果，不持久化，只在当前 ingest 流程里临时传递
   - JSON 至少包含 `entities`、`topics`、`connections`
   - `confidence` 是必需字段，缺失就视为格式异常并触发单步回退

   ```json
   {
     "source_summary": "一句话概括",
     "entities": [{"name": "xxx", "type": "concept", "relevance": "high", "confidence": "EXTRACTED", "evidence": "原文摘录或推理依据"}],
     "topics": [{"name": "xxx", "importance": "high"}],
     "connections": [{"from": "A", "to": "B", "type": "因果", "confidence": "INFERRED", "evidence": "推理依据"}],
     "contradictions": [{"claim_a": "...", "claim_b": "...", "context": "..."}],
     "new_vs_existing": {"new_entities": [], "updates": []}
   }
   ```

   置信度赋值规则（AI 必须遵守）：
   - EXTRACTED：信息直接出现在原文里，字面可以找到。**应在 `evidence` 字段提供原文摘录**（建议 ≤50 字）；缺失时脚本会发出 WARN 但不阻塞
   - INFERRED：信息是从多处原文推断出来的，原文没有直接说。**应在 `evidence` 字段说明推理依据**；缺失时脚本会发出 WARN 但不阻塞
   - AMBIGUOUS：原文说法不清楚，或者有歧义。`evidence` 可选
   - UNVERIFIED：信息来自 AI 的背景知识，原文没有证据。`evidence` 可选

   Step 1 完成后，必须执行验证：
   1. mkdir -p {wiki_root}/.wiki-tmp
   2. 将 Step 1 JSON 写入 {wiki_root}/.wiki-tmp/step1-latest.json
   3. 调用 bash ${SKILL_DIR}/scripts/validate-step1.sh {wiki_root}/.wiki-tmp/step1-latest.json
   4. 验证完成后删除 {wiki_root}/.wiki-tmp/step1-latest.json

   如果脚本返回非 0，自动回退到单步 ingest（不进行 Step 2）。

6. **Step 2：页面生成**：
   - 输入：原始内容 + `purpose.md` + Step 1 的分析结果 + 现有相关 wiki 页面
   - **上下文加载规则**：只读取 Step 1 中 `new_vs_existing.updates` 列出的已有页面；如果某页超过 2000 字，只读取 frontmatter + 需要更新的章节
   - 输出：所有需要创建或更新的 wiki 页面内容
   - Step 2 负责完成原流程中的素材摘要、实体页、主题页、index、log 更新

7. **容错回退**：
   - 如果 Step 1 不是有效 JSON，或者缺少 `entities`、`topics`、`confidence` 等必需字段，自动回退到原来的单步流程
   - 回退时，所有本次新生成内容统一加上：
     ```markdown
     <!-- confidence: UNVERIFIED -->
     ```
   - 同时在页面顶部加注释说明本次处理因格式问题降级，避免出现“部分标注、部分没标注”的状态

8. **生成素材摘要页**（`wiki/sources/{日期}-{短标题}.md`）：
   - 参考 `templates/source-template.md` 的格式
   - frontmatter 里保留 `sources: []` 字段；如果这次 ingest 有明确来源，按实际 raw/source 引用填入
   - 包含：基本信息、核心观点、关键概念、与其他素材的关联、原文精彩摘录
   - 对 Step 1 中标记为 `INFERRED` 或 `AMBIGUOUS` 的关系，用 HTML 注释保留置信度：
     ```markdown
     <!-- confidence: INFERRED -->
     <!-- confidence: AMBIGUOUS -->
     ```
   - **写入 source 页面时，必须使用 `create-source-page.sh`**（自动更新缓存）：
     ```bash
     # 先把页面内容写到临时文件
     echo "<页面内容>" > /tmp/source-content.tmp
     # 调用脚本原子写入 + 缓存更新
     bash ${SKILL_DIR}/scripts/create-source-page.sh "<raw 文件路径>" "wiki/sources/{日期}-{短标题}.md" /tmp/source-content.tmp
     ```
   - 如果脚本返回 `SUCCESS` → 写入和缓存都已更新
   - 如果脚本返回 `ERROR` → 写入或缓存失败，检查报错信息后重试

9. **更新或创建实体页**（`wiki/entities/`）：
   - 对每个关键概念，检查 `wiki/entities/` 下是否已有对应页面
   - 如果已有 → 追加新信息，更新"不同素材中的观点"部分
   - 如果没有 → 创建新实体页，参考 `templates/entity-template.md`
   - 使用 `[[实体名]]` 语法做双向链接

10. **更新或创建主题页**（`wiki/topics/`）：
   - 识别素材涉及的主要研究主题
   - 如果已有对应主题页 → 更新素材汇总表和核心观点
   - 如果没有 → 创建新主题页，参考 `templates/topic-template.md`

11. **更新 index.md**：
   - 在对应分类下添加新条目
   - 更新概览统计数字

12. **更新 log.md**：
   - log.md 追加格式：`## {日期} ingest | {素材标题}`
   - 记录新增和更新的页面列表
   - 注意：缓存更新已在 Step 8 通过 `create-source-page.sh` 自动完成，此处无需再调用 `cache.sh update`

13. **向用户展示结果**（按 `WIKI_LANG` 切换语言）：

   **中文（zh）**：
   ```
   已消化：{素材标题}

   新增页面：
   - {素材摘要页}
   - {新实体页1}
   - {新主题页1}

   更新页面：
   - {已有实体页2}（追加了新信息）

   发现关联：
   - 这篇素材和 [[已有素材]] 在 {某概念} 上有联系

   别名建议：（仅当发现新的同义词关系时显示）
   - 建议添加到别名词表：{术语A} = {术语B}
   ```
   （英文版按「输出语言规则」生成，结构相同。）

### 简化处理流程（短素材 <= 1000 字）

适用于短推文、小红书笔记、简短评论等。

1. **保存原始素材**到对应 `raw/` 目录
   - **图片检测与追踪**：同完整处理流程，扫描图片引用并提醒用户；在 source 页面 `images` 和 `image_paths` frontmatter 字段记录数量和路径
2. **读取上下文并检查缓存**：
   - 仍然优先读取 `purpose.md`
   - 仍然先运行 `bash ${SKILL_DIR}/scripts/cache.sh check "<raw 文件路径>"`
   - 如果缓存命中（`HIT` 或 `HIT(repaired)`），直接复用已有结果
3. **生成简化摘要页**（`wiki/sources/`）：
   - frontmatter 里写入 `sources: []`
   - 只包含基本信息和核心观点
   - 不写"原文精彩摘录"部分
   - **写入 source 页面时同样使用 `create-source-page.sh`**（自动更新缓存）
4. **提取 1-3 个关键概念**：
   - 如果对应实体页已存在 → 追加一句话说明
   - 如果不存在 → 在摘要页中用 `[待创建: [[概念名]]]` 标记
5. **更新 index.md 和 log.md**（缓存已由 `create-source-page.sh` 自动更新）
6. **跳过**：主题页创建/更新、overview 更新

7. **向用户展示简化结果**（按 `WIKI_LANG` 切换语言）：

   **中文（zh）**：
   ```
   已消化：{素材标题}（短内容，简化处理）

   新增：
   - 素材摘要页

   待完善：
   - [待创建: [[概念名]]]（积累更多素材后整理）
   ```
   （英文版按「输出语言规则」生成，结构相同。）

---
