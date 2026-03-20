# Security Core 模块边界（v2 重构中）

## 目录分层

```text
packages/openclaw-security-plugin/
├── src/
│   ├── adapters/
│   │   └── openclaw/plugin.ts
│   ├── application/
│   │   └── security-runtime.ts
│   ├── core/
│   │   ├── types.ts
│   │   ├── policy.ts
│   │   ├── runtime-guard.ts
│   │   └── runtime-engine/
│   │       ├── detector.ts
│   │       ├── decision.ts
│   │       ├── action.ts
│   │       ├── shared.ts
│   │       └── types.ts
│   ├── infrastructure/
│   │   ├── actions.ts
│   │   ├── auditor.ts
│   │   └── monitors/selected-monitors.ts
│   ├── vendor/
│   │   ├── secureclaw-runtime-bridge.ts
│   │   ├── secureclaw-runtime/
│   │   │   ├── src/auditor.ts
│   │   │   ├── src/types.ts
│   │   │   ├── src/utils/{hash.ts,ioc-db.ts}
│   │   │   └── ioc/indicators.json
│   │   ├── clawguardian-destructive/
│   │   └── shield-core/
│   └── index.ts
```

## 职责划分

- `adapters/*`：框架适配层。仅负责把 OpenClaw 插件接口映射到应用层，不承载安全策略决策。
- `application/*`：应用编排层。负责 hook 注册、gateway method 注册、运行时状态与流程编排。
- `core/*`：领域内核层。负责策略模型、规则决策、运行时拦截判定（与具体插件框架解耦）。
- `core/runtime-engine/*`：运行时规则引擎三层，分别承载检测、决策与动作物化，`runtime-guard.ts` 仅保留编排职责。
- `infrastructure/*`：基础设施与用例实现，承载安全动作、启动审计、监控采集。
- `src/vendor/secureclaw-runtime/*`：secureclaw 审计运行时最小子集（本项目内可控实现），供 bridge 与 auditor 调用。
- `src/vendor/secureclaw-runtime-bridge.ts`：审计桥接层，只依赖 `src/vendor/secureclaw-runtime`，不跨层直连顶层快照目录。

## 依赖方向约束

1. `adapters` 只可依赖 `application`，禁止直接依赖 `vendor`。
2. `application` 可依赖 `core` 与基础设施（`actions/auditor/monitors`），禁止反向依赖 `adapters`。
3. `core` 不得依赖 `adapters` 与 UI/Electron 路由。
4. 运行时代码只允许从 `src/vendor/secureclaw-runtime/*` 导入 secureclaw 审计子模块，禁止跨目录引用非运行时快照源。
