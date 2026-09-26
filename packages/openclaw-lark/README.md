# OpenClaw Lark/Feishu Plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.16.0-blue.svg)](https://nodejs.org/)

[中文版](./README.zh.md) | English

This is the **Matcha-maintained source copy** of the OpenClaw Lark/Feishu plugin, built and delivered by this repository instead of the official npm package. It originates from the Lark/Feishu Open Platform team's plugin and the compatibility fork recorded in [PATCH-NOTES.md](./PATCH-NOTES.md); upstream copyright and the MIT license are retained. It connects OpenClaw to Lark/Feishu messages, docs, bases, calendars, tasks, and more.

## Features

This plugin provides comprehensive Lark/Feishu integration for OpenClaw, including:

| Category | Capabilities |
|------|------|
| 💬 Messenger | Read messages (group/DM history, thread replies), send messages, reply to messages, search messages, download images/files |
| 📄 Docs | Create, update, and read documents |
| 📊 Base | Create/manage bases, tables, fields, records (CRUD, batch operations, advanced filtering), views |
| 📈 Sheets | Create, edit, and view spreadsheets |
| 📅 Calendar | Manage calendars and events (create/query/update/delete/search), manage attendees, check free/busy status |
| ✅ Tasks | Manage tasks (create/query/update/complete), manage task lists, subtasks, and comments |

Additionally, the plugin supports:
- **📱 Interactive Cards**: Real-time status updates (Thinking/Generating/Complete), plus confirmation buttons for sensitive operations
- **🌊 Streaming Responses**: Live streaming text directly within message cards
- **🔒 Permission Policies**: Flexible access control policies for DMs and group chats
- **⚙️ Advanced Group Configuration**: Per-group settings including allowlists, skill bindings, and custom system prompts

## Security & Risk Warnings (Read Before Use)

This plugin integrates with OpenClaw AI automation capabilities and carries inherent risks such as model hallucinations, unpredictable execution, and prompt injection. After you authorize Lark/Feishu permissions, OpenClaw will act under your user identity within the authorized scope, which may lead to high-risk consequences such as leakage of sensitive data or unauthorized operations. Please use with caution.

To reduce these risks, the plugin enables default security protections at multiple layers. However, these risks still exist. We strongly recommend that you do not proactively modify any default security settings; once relevant restrictions are relaxed, the risks will increase significantly, and you will bear the consequences.

We recommend using the Lark/Feishu bot connected to OpenClaw as a private conversational assistant. Do not add it to group chats or allow other users to interact with it, to avoid abuse of permissions or data leakage.

Please fully understand all usage risks. By using this plugin, you are deemed to voluntarily assume all related responsibilities.


**Disclaimer:**

This software is licensed under the MIT License. When running, it calls Lark/Feishu Open Platform APIs. To use these APIs, you must comply with the following agreements and privacy policies:

- [Feishu Privacy Policy](https://www.feishu.cn/en/privacy?from=openclaw_plugin_readme)
- [Feishu User Terms of Service](https://www.feishu.cn/en/terms?from=openclaw_plugin_readme)
- [Feishu Store App Service Provider Security Management Specifications](https://open.larkoffice.com/document/uAjLw4CM/uMzNwEjLzcDMx4yM3ATM/management-practice/app-service-provider-security-management-specifications)

- [Lark Privacy Policy](https://www.larksuite.com/user-terms-of-service)
- [Lark User Terms of Service](https://www.larksuite.com/privacy-policy)

## Maintainer Build & Delivery

- **Node.js**: `>=24.16.0 <25 || >=26.1.0` (see `package.json`). Use the root repository's pnpm version.
- **Dependencies**: managed by the root pnpm workspace and lockfile. The private package retains the name `@larksuite/openclaw-lark`; the root depends on it via `workspace:*`. Its development SDK is pinned to **OpenClaw 2026.9.3**, matching the root.
- **Identity**: `pluginId=openclaw-lark`, `channelId=feishu`.

Run from the **repository root**:

```bash
pnpm install --frozen-lockfile
pnpm run build:openclaw-local-plugins -- openclaw-lark
pnpm --filter @larksuite/openclaw-lark run typecheck
pnpm --filter @larksuite/openclaw-lark run test
```

The managed builder invokes the package's `tsdown` build and stages the runtime files and dependencies in `build/openclaw-plugins/openclaw-lark`. The existing after-pack step delivers that directory to `resources/openclaw-plugins/openclaw-lark`.

Build outputs include `dist/index.mjs`, `dist/secret-contract-api.mjs`, and the standalone `dist/config-schema.mjs`. The root `secret-contract-api.js` discovery shim and `skills/` are retained. Rust reads `FEISHU_CONFIG_JSON_SCHEMA` from the standalone schema module; channel ownership is unchanged.

This delivery path does not download the official npm plugin, rewrite SDK imports in downloaded files, or ship the `bin` wrapper that invokes the official tools downloader. The commands above are maintenance checks, not a claim that they passed in this checkout.

## Usage Guide

[Upstream Lark/Feishu configuration guide](https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh) — use it for platform configuration; installation and delivery follow this repository's instructions above.

## Contributing

Changes to this maintained copy belong in the Matcha repository. Upstream project and compatibility-fork attribution are recorded in [PATCH-NOTES.md](./PATCH-NOTES.md).

## License

This project is licensed under the **MIT License**, retaining Copyright (c) 2026 Lark Technologies Pte. Ltd. See [LICENSE](./LICENSE) for details.
