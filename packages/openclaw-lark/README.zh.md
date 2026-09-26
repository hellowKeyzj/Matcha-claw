# OpenClaw  Lark/飞书 插件

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.16.0-blue.svg)](https://nodejs.org/)

[English](./README.md) | 中文版

这是 **Matcha 自行维护的 OpenClaw Lark/飞书插件源码副本**，由本仓库编译和交付，替代官方 npm 包。源码来自 Lark/飞书开放平台团队的插件及 [PATCH-NOTES.md](./PATCH-NOTES.md) 记录的兼容性分支，保留上游版权和 MIT 许可。它让 OpenClaw 能够读写飞书消息、文档、多维表格、日历、任务等。

## 特性

本插件为 OpenClaw 提供了全面的 Lark/飞书集成能力，主要包括：

| 类别 | 能力 |
|------|------|
| 💬 消息 | 消息读取（群聊/单聊历史、话题回复）、消息发送、消息回复、消息搜索、图片/文件下载 |
| 📄 文档 | 创建云文档、更新云文档、读取云文档内容 |
| 📊 多维表格 | 创建/管理多维表格、数据表、字段、记录（增删改查、批量操作、高级筛选）、视图 |
| 📈 电子表格 | 创建、编辑、查看电子表格 |
| 📅 日历日程 | 日历管理、日程管理（创建/查询/修改/删除/搜索）、参会人管理、忙闲查询 |
| ✅ 任务 | 任务管理（创建/查询/更新/完成）、清单管理、子任务、评论 |

此外，插件还支持：
- **📱 交互式卡片**：实时状态更新（思考中/生成中/完成状态），提供敏感操作的确认按钮
- **🌊 流式回复**：在消息卡片中提供实时的流式响应
- **🔒 权限策略**：为私聊和群聊提供灵活的访问控制策略
- **⚙️ 高级群组配置**：每个群聊的独立设置，包括白名单、技能绑定和自定义系统提示词

## 安全与风险提示（使用前必读）
本插件对接 OpenClaw AI 自动化能力，存在模型幻觉、执行不可控、提示词注入等固有风险；授权飞书权限后，OpenClaw 将以您的用户身份在授权范围内执行操作，可能导致敏感数据泄露、越权操作等高风险后果，请您谨慎操作和使用。
为降低上述风险，插件已在多个层面启用默认安全保护以降低上述风险，但上述风险仍然存在。我们强烈建议不要主动修改任何默认安全配置；一旦放开相关限制，上述风险将显著提高，由此产生的后果需由您自行承担。
我们建议您将接入 OpenClaw 的飞书机器人作为私人对话助手使用，请勿将其拉入群聊或允许其他用户与其交互，以避免权限被滥用或数据泄露。
请您充分知悉全部使用风险，使用本插件即视为您自愿承担相关所有责任。

**免责声明：** 

本软件的代码采用MIT许可证。
该软件运行时会调用Lark/飞书开放平台的API，使用这些API需要遵守如下协议和隐私政策：

- [飞书用户服务协议](https://www.feishu.cn/terms)
- [飞书隐私政策](https://www.feishu.cn/privacy)
- [飞书开放平台独立软件服务商安全管理运营规范](https://open.larkoffice.com/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/management-practice/app-service-provider-security-management-specifications)
- [Lark用户服务协议](https://www.larksuite.com/user-terms-of-service)
- [Lark隐私政策](https://www.larksuite.com/privacy-policy)

## 维护者构建与交付

- **Node.js**：`>=24.16.0 <25 || >=26.1.0`，以 `package.json` 为准；pnpm 使用仓库根目录声明的版本。
- **依赖**：由根 pnpm workspace 和锁文件统一管理。包保留 `@larksuite/openclaw-lark` 名称，设为 private，根依赖使用 `workspace:*`；开发 SDK 固定为与根一致的 **OpenClaw 2026.9.3**。
- **身份**：`pluginId=openclaw-lark`、`channelId=feishu`。

以下命令均在**仓库根目录**运行：

```bash
pnpm install --frozen-lockfile
pnpm run build:openclaw-local-plugins -- openclaw-lark
pnpm --filter @larksuite/openclaw-lark run typecheck
pnpm --filter @larksuite/openclaw-lark run test
```

既有 managed builder 调用本包的 `tsdown` 构建，将运行文件与依赖收集到 `build/openclaw-plugins/openclaw-lark`；after-pack 再交付至 `resources/openclaw-plugins/openclaw-lark`。

编译入口为 `dist/index.mjs`、`dist/secret-contract-api.mjs` 和独立的 `dist/config-schema.mjs`，保留根目录 `secret-contract-api.js` 发现入口及 `skills/`。Rust 从独立 schema 模块读取 `FEISHU_CONFIG_JSON_SCHEMA`，不改变渠道 owner。

这条交付链不再下载官方 npm 插件或对下载产物做 SDK import 文本补丁，也不交付调用官方 tools 下载器的 `bin` 包装入口。以上命令是维护检查入口，不表示当前检出已通过验证。

## 使用说明
[上游 Lark/飞书配置指南](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh)：用于参考开放平台配置；安装和交付以本仓库上述说明为准。

## 贡献

本维护副本的修改在 Matcha 仓库提交；上游项目与兼容性分支归属见 [PATCH-NOTES.md](./PATCH-NOTES.md)。

## 许可证

本项目采用 **MIT 许可证**，保留 Copyright (c) 2026 Lark Technologies Pte. Ltd. 署名。详情请参阅 [LICENSE](./LICENSE)。
