# llm-wiki for MatchaClaw OpenClaw

这是 MatchaClaw 预装的 OpenClaw-only 版 `llm-wiki` skill，基于 sdyckjq-lab/llm-wiki-skill v3.6.2 裁剪。

它用于把链接、文件、粘贴文本等素材整理为持续维护、互相链接的本地 Markdown 知识库。

## 在 MatchaClaw 中使用

MatchaClaw 会通过预装 skill 机制把本目录安装到 OpenClaw 当前 skills 根目录下的 `llm-wiki/`。不同 OpenClaw 运行形态的用户根目录可能不同；以运行时提供的 workspace / skills 目录为准，脚本支持通过 `OPENCLAW_SKILLS_DIR` 覆盖 skills 根目录。

无需运行上游安装脚本。启用 skill 后，可以直接对 OpenClaw 说：

```text
帮我初始化一个知识库
帮我消化这篇：<链接或文件路径>
检查知识库健康状态
画个知识图谱
```

## 能力边界

默认预装只包含知识库核心主线：

- PDF、本地 Markdown / 文本 / HTML
- 纯文本粘贴
- 知识库查询、综合、健康检查和图谱生成

网页 / X / 微信公众号 / YouTube / 知乎自动提取属于可选适配器能力。MatchaClaw 会像托管 `uv` 一样把托管 `bun` 注入 OpenClaw runtime PATH；未安装这些适配器或其本地依赖时，仍可粘贴正文或提供本地文件继续使用。

## 目录结构

知识库初始化后通常包含：

```text
raw/              # 原始素材
wiki/             # AI 生成和维护的知识页
purpose.md        # 研究方向与目标
index.md          # 索引
log.md            # 操作日志
.wiki-schema.md   # 配置
.wiki-cache.json  # 素材去重缓存
```

## OpenClaw-only 裁剪说明

本包只面向 MatchaClaw/OpenClaw 预装链路，不包含其他平台入口文件或安装脚本。