# delete（删除素材）

### 触发关键词

"删除素材"、"remove"、"delete source"、"移除"

### 前置检查

执行**通用前置检查**（见 `../references/workspace.md`）。如果没有可用知识库，提示用户先初始化。

### 步骤

1. **识别目标素材**：
   - 在 `raw/` 下搜索用户提到的素材名
   - 如果匹配到多个候选，先列出候选文件让用户确认

2. **扫描影响范围**：
   - 先运行：
     ```bash
     bash ${SKILL_DIR}/scripts/delete-helper.sh scan-refs "<wiki 根目录>" "<素材文件名>"
     ```
   - 用脚本返回的页面列表作为引用扫描结果
   - 逐页判断是“删除整页”还是“保留页面但移除该素材引用”

3. **安全确认**：
   - 如果影响超过 5 个页面时，先把受影响页面完整列给用户，再做二次确认
   - 如果某个实体或主题只被这个素材引用，提示用户是否连同页面一起删除

4. **执行级联清理**：
   - 删除 `raw/` 下对应原始文件
   - 删除 `wiki/sources/` 下对应素材摘要页
   - 对 `wiki/entities/`、`wiki/topics/`、`wiki/comparisons/`、`wiki/synthesis/` 中仍需保留的页面，只移除该素材相关的引用段落
   - 更新 `index.md`
   - 在 `log.md` 追加删除记录
   - 标记 `wiki/overview.md` 需要重新生成

5. **清理缓存**：
   - 删除完成后，对对应 raw 文件运行：
     ```bash
     bash ${SKILL_DIR}/scripts/cache.sh invalidate "<raw 文件路径>"
     ```

6. **断链检查**：
   - 用 grep 或 `delete-helper.sh` 再扫一遍指向已删除页面的链接
   - 清理明确可判定的断链；如果归属不清，保留原文并提示用户后续人工确认

7. **向用户报告结果**：

   **zh**：
   ```
   已删除：
     - raw/articles/2024-01-15-ai-article.md
     - wiki/sources/2024-01-15-ai-article.md
   已更新（移除引用）：
     - wiki/entities/AI-Agent.md
     - wiki/topics/大语言模型.md
   需要重新生成：
     - wiki/overview.md
   ```
   （英文版按「输出语言规则」生成，结构相同。）

---
