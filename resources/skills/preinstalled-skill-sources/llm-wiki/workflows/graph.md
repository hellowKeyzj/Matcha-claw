# graph（知识图谱 · Mermaid + 交互式 HTML）

### 触发关键词

"画个知识图谱"、"看看关联图"、"graph"、"知识库地图"、"展示知识关联"

### 前置检查

执行**通用前置检查**（见 `../references/workspace.md`）。如果没有可用知识库，提示用户先初始化。

1. **扫描双向链接**：
   - 遍历 `wiki/` 下所有 `.md` 文件
   - 提取每个文件中的 `[[链接]]` 语法，建立关系列表：`页面A → 页面B`

2. **生成 Mermaid 图表文件** `wiki/knowledge-graph.md`：
   ````markdown
   # 知识图谱

   > 自动生成 | {日期} | 共 {N} 个节点，{M} 条关联

   ```mermaid
   graph LR
     A[概念1] --> B[概念2]
     A --> C[素材1]
     D[主题1] --> A
     D --> E[概念3]
   ```

   查看方式：用 Typora、VS Code（Markdown Preview Enhanced）、或直接在 GitHub 上查看。
   ````

   **生成规则**：
   - 节点名用中括号 `[名称]`，名称太长则截断到 10 字
   - 只展示有双向链接关系的节点（孤立节点不纳入图谱）
   - 如果关系超过 50 条，只保留被引用次数最多的 30 个节点，避免图谱过于密集
   - **默认全部使用 `A --> B` 无标注箭头**，不自动判断关系类型

   **可选：手动美化图谱**（生成后由用户自己做，AI 不自动处理）：

   生成的 `wiki/knowledge-graph.md` 默认只有 `-->` 箭头。如果用户希望图谱更清楚地
   表达关系类型，可以：

   1. 用编辑器打开 `wiki/knowledge-graph.md`
   2. 参考 `.wiki-schema.md` 里的"关系类型词汇表"（实现 / 依赖 / 对比 / 矛盾 / 衍生）
   3. 把最重要的 3-5 条箭头改写成 `A -->|实现| B` 之类的带标注写法
   4. 保存后用 Obsidian / VS Code / Typora 重新渲染

   AI 在 graph 工作流里**不自动打标**——因为自动判断关系类型需要额外阅读整段上下文，
   成本高且准确率难保证。人类对"哪些关系最值得打标"的判断更可靠。
   用户如果明确要求 AI 给某几条边打标，可以单独说"把 A 和 B 之间的关系标成'实现'"，
   AI 再手动修改 `wiki/knowledge-graph.md` 对应的那一行。

2b. **生成交互式图谱数据**（`wiki/graph-data.json`）：

   ```bash
   bash ${SKILL_DIR}/scripts/build-graph-data.sh "$WIKI_ROOT"
   ```

   脚本会扫描 `wiki/{entities,topics,sources,comparisons,synthesis,queries}/*.md`，
   解析同行 `[[双向链接]]` 与 `<!-- confidence: EXTRACTED|INFERRED|AMBIGUOUS -->` 注释，
   调用本地 Node helper 计算 3 信号边权重（共引强度 / 来源重叠 / 类型亲和度）、Louvain 社区和规则 insights，
   并写入 `wiki/graph-data.json`（内容 >2MB 自动降级，单节点只留 500 行；图规模超预算时 insights 自动降级）。
   图谱数据构建只依赖 `node`。

2c. **图谱运行时说明**：
   - 图谱基础构建现在依赖 `node`
   - 不需要额外 `npm install`
   - `node` 只用于运行随仓库分发的本地 helper

2d. **生成交互式图谱 HTML**（东方编辑部 × 数字山水风）：

   ```bash
   bash ${SKILL_DIR}/scripts/build-graph-html.sh "$WIKI_ROOT"
   ```

   生成 `wiki/knowledge-graph.html`。脚本把 `graph-data.json`（已做 `</script>` 转义）
   内嵌进 `<script id="graph-data" type="application/json">`，离线双击即可打开。
   页面保持三栏国风布局：左侧文献索引，中间数字山水图谱，右侧常驻节点详情。
   包含搜索、社区筛选、节点视觉分层、首屏推荐预览、摘要、正文、相邻节点、洞察、小地图和关系置信度图例。

3. **读取 insights 并向用户展示结果**（按 `WIKI_LANG` 切换语言）：

   先读取 insights：
   ```bash
   node ${SKILL_DIR}/scripts/graph-analysis.js inspect-insights "$WIKI_ROOT/wiki/graph-data.json"
   ```

   **zh**：
   ```
   知识图谱已生成！

   共 {N} 个节点，{M} 条关联

   图谱洞察：
   - 惊人连接：{from} ↔ {to}（跨社区，权重 {weight}）{如有}
   - 桥节点：{node}（连接 {count} 个社区）{如有}
   - 知识缺口：{node}（度数 {degree}，建议补充素材）{如有}
   - 稀疏社区：{community}（密度 {density}）{如有}

   查看方式：
   - 交互式（推荐）：双击 wiki/knowledge-graph.html
     （建议 Chrome / Firefox；Safari 若提示"已阻止脚本"，
      可在 wiki/ 下跑 `python3 -m http.server 8000` 再访问）
   - Mermaid 静态图：wiki/knowledge-graph.md
     （Obsidian / VS Code Markdown Preview Enhanced / GitHub / Typora 均可渲染）

   孤立页面（未纳入图谱）：
   - [[某页面]]（建议添加到相关实体页或主题页）
   ```

   （英文版按「输出语言规则」生成，结构相同。各洞察类别为空时省略该行。）

---
