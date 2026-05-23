---
name: llm-wiki
version: 3.6.2
author: sdyckjq-lab
license: MIT
description: |
  个人知识库构建系统（基于 Karpathy llm-wiki 方法论）。让 AI 持续构建和维护你的知识库，
  支持多种素材源（网页、推特、公众号、小红书、知乎、YouTube、PDF、本地文件），
  自动整理为结构化的 wiki。
  触发条件：用户明确提到"知识库"、"wiki"、"llm-wiki"，或要求对已初始化的知识库执行
  消化、查询、健康检查等操作。不要在用户只是要求"总结这篇文章"时触发——必须是明确的
  知识库相关意图。
metadata:
  openclaw:
    tags:
      - knowledge-base
      - wiki
      - research
      - note-taking
---

# llm-wiki — 个人知识库构建系统

把碎片化信息整理为持续积累、互相链接的本地 Markdown 知识库。

## 触发条件

仅当用户明确提到“知识库 / wiki / llm-wiki”，或要求对已初始化知识库执行消化、查询、健康检查、图谱、结晶化等操作时使用。

不要在用户只是要求“总结这篇文章”时触发；必须有沉淀到知识库的意图。

## 路径约定

- `SKILL_DIR`：本 `SKILL.md` 所在目录。
- 工作流说明：`${SKILL_DIR}/workflows/*.md`
- 共享规则：`${SKILL_DIR}/references/*.md`
- 脚本：`${SKILL_DIR}/scripts/*.sh`
- 模板：`${SKILL_DIR}/templates/`
- 本包由 MatchaClaw 预装到 OpenClaw skills 目录；不要假设固定盘符或 Windows/macOS/Linux 绝对路径。

## 使用方式

1. 先按用户意图读取 `references/routing.md`。
2. 再只读取对应的 `workflows/<name>.md`。
3. 执行工作流前按需读取共享规则：
   - `references/workspace.md`
   - `references/language-rules.md`
   - `references/dependencies.md`
   - `references/adapter-state.md`

## 工作流索引

| 意图 | 文件 |
|---|---|
| 初始化知识库 | `workflows/init.md` |
| 消化 URL / 文件 / 文本 | `workflows/ingest.md` |
| 批量消化 | `workflows/batch-ingest.md` |
| 查询知识库 | `workflows/query.md` |
| 深度综合 / 对比 / 时间线 | `workflows/digest.md` |
| 健康检查 | `workflows/lint.md` |
| 查看状态 | `workflows/status.md` |
| 知识图谱 | `workflows/graph.md` |
| 删除素材 | `workflows/delete.md` |
| 对话结晶化 | `workflows/crystallize.md` |

## 核心原则

- 所有写入都落在用户选择的知识库目录。
- URL 自动提取先走来源路由和 adapter 状态检查；不可用时回退到手动粘贴或本地文件。
- 输出语言跟随知识库 `.wiki-schema.md` 的语言配置。
- 不静默安装全局工具，不静默写入用户未确认的外部目录。
