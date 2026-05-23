# OpenClaw 入口

这是 MatchaClaw 预装的 OpenClaw-only `llm-wiki` 入口说明。核心能力看 [../../SKILL.md](../../SKILL.md)。

## 安装方式

在 MatchaClaw 中无需手动安装。预装流程会把本 skill 安装到 OpenClaw 当前 skills 根目录下的 `llm-wiki/`。

不同 OpenClaw 运行形态的用户根目录可能不同；以运行时提供的 workspace / skills 目录为准。脚本支持通过 `OPENCLAW_SKILLS_DIR` 覆盖 skills 根目录。

如果 Skills 页面显示为未启用，请在 MatchaClaw 中手动启用 `llm-wiki`。

## 可选提取器

默认只启用知识库核心主线。网页 / X / 微信公众号 / YouTube / 知乎自动提取属于可选能力；缺失时可以粘贴正文或使用本地文件继续消化素材。
