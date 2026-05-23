# 依赖检查

核心主线（本地文件、纯文本、已有知识库操作）默认不需要这些提取依赖。

只有当用户给的是 URL 类来源，并且明确要自动提取网页 / X / 微信公众号 / YouTube / 知乎内容时，才检查以下可选依赖。

如果缺失，说明 MatchaClaw 预装版默认只提供知识库核心主线；网页 / X / 微信公众号 / YouTube / 知乎自动提取属于可选能力。用户仍可直接提供本地文件、粘贴文本，或改走手动入口。

可选依赖 skill / 工具：
- `baoyu-url-to-markdown` — 普通网页、X/Twitter、部分知乎提取
- `wechat-article-to-markdown` — 微信公众号提取
- `youtube-transcript` — YouTube 字幕提取

核心主线不因这些依赖缺失而中断。
