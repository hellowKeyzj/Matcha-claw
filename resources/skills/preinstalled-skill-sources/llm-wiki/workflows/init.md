# init（初始化知识库）

### 前置检查（含多知识库 CWD 检查）

1. 先检查**当前工作目录**是否包含 `.wiki-schema.md`
   - 如果包含 → 当前目录已经是一个知识库，提示用户已存在并询问是否要重新初始化
2. 如果当前目录没有 → 读取 OpenClaw 配置目录下的 `.llm-wiki-path` 文件（优先 `OPENCLAW_CONFIG_DIR`，否则使用 OpenClaw 默认配置目录）
   - 如果存在 → 提示用户已有一个知识库（显示路径），询问是要新建还是切换到那个
3. 两个都没有 → 进入初始化流程

### 步骤

1. **询问知识库主题**（先向用户提问）：
   - "你的知识库要围绕什么主题？比如'AI 学习笔记'、'产品竞品分析'、'读书笔记'"
   - 如果用户没想法，默认用"我的知识库"

2. **询问知识库语言**（先向用户提问）：
   - "知识库内容用什么语言？中文 / English（默认中文）"
   - 选项：`zh`（中文）或 `en`（English）
   - 如果用户没有明确说，默认 `zh`
   - 将选择记录为 `WIKI_LANG`（`zh` 或 `en`）

3. **询问保存位置**（先向用户提问）：
   - 默认：用户主目录下的 `Documents/我的知识库/`（zh）或 `Documents/my-wiki/`（en）
   - 用户可以自定义路径

4. **运行初始化脚本**：
   ```bash
   bash ${SKILL_DIR}/scripts/init-wiki.sh "<路径>" "<主题>"
   ```

5. **补充初始化结果说明**：
   - `init-wiki.sh` 会同时生成 `purpose.md` 和 `.wiki-cache.json`
   - `purpose.md` 和 `.wiki-schema.md` 同级存放，用来记录研究目标、关键问题和研究范围
   - 提醒用户优先填写核心目标和关键问题；这些内容写在 `purpose.md` 里，后续 ingest 会优先参考这里的方向

6. **写入语言配置并本地化种子文件**：
   - 将 `.wiki-schema.md` 中的 `语言：{{LANGUAGE}}` 替换为：
     - `zh` → `语言：中文`（种子文件保持中文，无需额外处理）
     - `en` → `语言：English`，**同时**覆写以下种子文件为英文版：
   - 如果 `WIKI_LANG=en`，读取 `${SKILL_DIR}/templates/index-en-template.md`、`${SKILL_DIR}/templates/overview-en-template.md`、`${SKILL_DIR}/templates/log-en-template.md`，将 `{{DATE}}` 和 `{{TOPIC}}` 替换为实际值后，分别写入 `index.md`、`wiki/overview.md`、`log.md`

7. **确认路径记录**：
   - `init-wiki.sh` 会把知识库路径写入 OpenClaw 配置目录下的 `.llm-wiki-path`
   - 后续工作流优先从当前目录的 `.wiki-schema.md` 判断知识库；当前目录不是知识库时，再读取该路径记录

8. **输出引导**（根据 `WIKI_LANG` 切换语言）：

   **中文（zh）**：
   ```
   知识库已创建！路径：<路径>

   接下来你可以：
   - 给我一个链接，我会自动提取并整理（网页、X/Twitter、公众号、知乎等）
   - 小红书内容请直接粘贴文本给我（暂不支持自动提取）
   - 给我一个本地文件路径（PDF、Markdown 等）
   - 直接粘贴文本内容
   - 批量消化：给我一个文件夹路径

   推荐：用 Obsidian 打开这个文件夹，可以实时看到知识库的构建效果。
   ```
   （英文版按「输出语言规则」生成，结构相同。）

---
