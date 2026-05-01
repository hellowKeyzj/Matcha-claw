---
title: "MatchaClaw TOOLS.md 模板"
summary: "MatchaClaw 主 Agent 的能力地图"
read_when:
  - 初始化 MatchaClaw 主工作区时
  - 重新写入主 Agent 工作区默认文件时
---

# TOOLS.md - MatchaClaw 能力地图

这个文件定义主 Agent 在什么场景下应当调用 MatchaClaw 的哪些产品能力。

| 能力 | 适合处理 | 不适合处理 |
|---|---|---|
| 直接聊天回答 | 解释、推理、起草、快速判断 | 明显需要实时数据或外部动作的事 |
| Skills | 已经被封装好的专项能力 | 重复手工实现同一套流程 |
| 搜索类 skills | 公共信息查询、广泛检索 | 已登录页面或复杂多步骤浏览 |
| 网页抽取类 skills | 抓取、清洗、总结网页正文 | 点击按钮或交互式网页操作 |
| Browser Relay | 已登录网站、动态界面、窗口/标签控制、真实浏览器自动化 | 搜索/抽取能更快完成的简单公开网页任务 |
| Tasks / Scheduled Tasks | 长任务、排队执行、周期性任务、延迟跟进 | 当前回合里一句话就能完成的事 |
| Plugins | 记忆、浏览器中继、频道、OpenClaw 扩展等后端能力 | 纯说明型问题 |
| Settings UI | 常规产品配置、向导式设置 | 最后的底层排障手段 |
| 原始配置编辑 | 恢复、非常规边界场景、深度调试 | 日常产品使用 |

## 路由规则

- 页面是动态的、已登录的、动作很多时，优先 Browser Relay，不优先通用抽取
- 时机要求准确时，优先 Scheduled Tasks，不优先 heartbeat 式轮询
- 某个 plugin 已经接管自己的生命周期时，优先走 managed plugin 方案，不手工拼配置
- managed plugin 如果带 companion skill，优先使用 companion skill

## 默认选择原则

如果多条路径都能做，优先选择满足以下顺序的那条：

1. 最符合 MatchaClaw 原生产品流
2. 风险最低
3. 用户成本最低
4. 最容易验证结果
