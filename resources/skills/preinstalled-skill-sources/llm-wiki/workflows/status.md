# status（查看状态）

### 前置检查

执行**通用前置检查**（见 `../references/workspace.md`）。如果没有可用知识库，提示用户先初始化。

### 步骤

1. 先运行 `bash ${SKILL_DIR}/scripts/source-registry.sh list` 读取来源总表
2. 获取知识库路径（按 `../references/workspace.md` 的 CWD 检查逻辑）
3. 统计：
   - 按来源总表中的 `source_label` 和 `raw_dir` 逐项统计 `raw/` 文件数
   - `wiki/entities/` 下的页面数
   - `wiki/topics/` 下的页面数
   - `wiki/sources/` 下的页面数
   - `wiki/comparisons/` 和 `wiki/synthesis/` 下的页面数
   - `purpose.md 是否存在`
4. 读取 `log.md` 最后 5 条记录
5. 读取 `index.md` 获取主题概览
6. 运行 `bash ${SKILL_DIR}/scripts/adapter-state.sh summary-human` 获取外挂状态
7. 运行 `node ${SKILL_DIR}/scripts/source-signal-coverage.js <wiki_root>` 获取来源信号覆盖数据，从返回 JSON 的 `summary` 中读取：
   - `ok`（已参与）、`missing_sources`（缺少 sources）、`empty_sources`（sources 为空）、`invalid_sources`（格式无效）、`not_applicable`（当前不参与）
8. **输出报告**（按 `WIKI_LANG` 切换语言）：

   **zh**：
   ```
   知识库状态：{主题}

   素材分布（按来源总表）：
   - {source_label}：{N}
   - {source_label}：{N}
   ...

   Wiki 页面：{总数} 页
     - 实体页：{N}
     - 主题页：{N}
     - 素材摘要：{N}
     - 对比分析：{N}
     - 综合分析：{N}

   图谱来源信号覆盖：
   - 已参与：{ok}
   - 缺少 sources：{missing_sources}
   - sources 为空：{empty_sources}
   - 格式无效：{invalid_sources}
   - 当前不参与：{not_applicable}

   研究方向：
   - purpose.md 是否存在：{是/否}

   最近活动：
   - {日期} ingest | {素材标题}
   - {日期} ingest | {素材标题}
   ...

   外挂状态：
   {summary-human 原文}

   建议：
   - 你可能想深入了解 {某主题}，已有 {N} 篇相关素材
   - {某实体} 被 {N} 篇素材提到，值得整理成独立页面
   ```
   （英文版按「输出语言规则」生成，结构相同。）

   外挂状态直接使用 `bash ${SKILL_DIR}/scripts/adapter-state.sh summary-human` 的输出，不要自己再重写一套来源清单。

---
