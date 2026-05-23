# crystallize（结晶化）

**触发条件**：
用户说"结晶化"、"crystallize"、"把这个记进知识库"、"这段对话很有价值"

**输入**：
用户主动提供的内容（文字粘贴进对话，或明确引用某段上下文）。
用户必须主动提供内容，AI 不自动提取当前会话。

**处理步骤（MVP）**：

1. 用户提供内容（文字粘贴进对话）
2. AI 从内容中提取：
   - 核心洞见（3-5 条）
   - 关键决策和原因
   - 值得记录的结论
3. 生成 `wiki/synthesis/sessions/{主题}-{日期}.md`，格式参考 `templates/synthesis-template.md`
   - 本轮不要求 crystallize 页面补 `sources`，默认不参与 graph source overlap
4. 更新 `log.md`（记录本次结晶化操作）

> MVP 版本不自动创建 entity 页面，不自动更新 index.md。

**confidence 规则**：
结晶化来源的内容默认标记为 `INFERRED`（来自推断/对话，非原始文档）。

**输出示例**：
已创建 wiki/synthesis/sessions/AI-agent-设计决策-20260413.md
已更新 log.md
