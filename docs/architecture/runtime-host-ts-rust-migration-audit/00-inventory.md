# runtime-host 当前文件清单与审计覆盖门禁

> 生成时间：以当前工作树为准。此清单是文件**范围证明**，不是“已走读”证明；文件只有在对应分片报告中出现完整记录后才可标为已审计。

- 当前生产源文件：**589**（`.ts` 588，`.cjs` 1）。
- `build/**` 下的编译产物明确排除；依赖目录、测试输出、临时目录也排除。
- 相邻非代码数据/配置：`runtime-host/application/sessions/tool/tool-display-overrides.json`、`runtime-host/application/sessions/tool/tool-display-shared-spec.json` 在 Session 分片作为输入契约读取，但不计入源文件数；`package.json`/`tsconfig.json` 是构建配置，不作为逐代码文件记录。
- Git 标记只用于识别工作树来源；无论 tracked/untracked/ignored，当前存在源文件都必须走读。

## 分片统计

| 报告 | 当前文件数 | 责任范围 |
|---|---:|---|
| [01-api-bootstrap.md](01-api-bootstrap.md) | 37 | api、bootstrap、runtime-host 根入口 |
| [02-composition-core.md](02-composition-core.md) | 38 | composition、core、services |
| [03-bridge-shared-plugin.md](03-bridge-shared-plugin.md) | 42 | openclaw-bridge、plugin-engine、shared |
| [04-agent-runtime-capabilities.md](04-agent-runtime-capabilities.md) | 40 | agent-runtime、capabilities |
| [05-platform-gateway-runtime-host.md](05-platform-gateway-runtime-host.md) | 31 | application gateway/platform-runtime/runtime-host |
| [06-sessions.md](06-sessions.md) | 58 | Session domain source（含 canonical/tool） |
| [07-session-workflows.md](07-session-workflows.md) | 16 | 所有 session-* workflow |
| [08-nonsession-workflows.md](08-nonsession-workflows.md) | 49 | 其余 workflow |
| [09-openclaw-runtime-infrastructure.md](09-openclaw-runtime-infrastructure.md) | 23 | OpenClaw runtime/infrastructure/gateway |
| [10-openclaw-projections.md](10-openclaw-projections.md) | 37 | OpenClaw projection |
| [11-openclaw-workflows.md](11-openclaw-workflows.md) | 17 | OpenClaw workflows/service |
| [12-team-runtime-remote-fleet.md](12-team-runtime-remote-fleet.md) | 93 | TeamRun 与 Remote Fleet |
| [13-connectors-plugins-skills.md](13-connectors-plugins-skills.md) | 28 | connector/plugin/skill/toolchain |
| [14-operational-domains.md](14-operational-domains.md) | 55 | provider/security/settings/channel/usage/license/cron/common/chat/files |
| [15-remaining-application.md](15-remaining-application.md) | 25 | 其余 application（含 matcha-agent adapter） |

## 当前工作树逐路径清单

### 01-api-bootstrap.md

- `runtime-host/api/common/http.ts` — tracked
- `runtime-host/api/dispatch/dispatch-envelope.ts` — tracked
- `runtime-host/api/dispatch/dispatch-route-handler.ts` — tracked
- `runtime-host/api/dispatch/runtime-route-dispatcher-types.ts` — tracked
- `runtime-host/api/dispatch/runtime-route-dispatcher.ts` — tracked
- `runtime-host/api/dispatch/runtime-route-index.ts` — tracked
- `runtime-host/api/routes/capability-routes.ts` — tracked
- `runtime-host/api/routes/capability-routing-routes.ts` — tracked
- `runtime-host/api/routes/channel-routes.ts` — tracked
- `runtime-host/api/routes/clawhub-routes.ts` — tracked
- `runtime-host/api/routes/cron-routes.ts` — tracked
- `runtime-host/api/routes/external-connector-routes.ts` — tracked
- `runtime-host/api/routes/file-routes.ts` — tracked
- `runtime-host/api/routes/gateway-routes.ts` — tracked
- `runtime-host/api/routes/license-routes.ts` — tracked
- `runtime-host/api/routes/openclaw-routes.ts` — tracked
- `runtime-host/api/routes/platform-routes.ts` — tracked
- `runtime-host/api/routes/plugin-runtime-routes.ts` — tracked
- `runtime-host/api/routes/provider-models-routes.ts` — tracked
- `runtime-host/api/routes/provider-routes.ts` — tracked
- `runtime-host/api/routes/remote-fleet-routes.ts` — untracked-or-ignored
- `runtime-host/api/routes/remote-fleet-runtime-agent-ingress-route.ts` — untracked-or-ignored
- `runtime-host/api/routes/route-utils.ts` — tracked
- `runtime-host/api/routes/runtime-host-routes.ts` — tracked
- `runtime-host/api/routes/runtime-topology-routes.ts` — tracked
- `runtime-host/api/routes/security-routes.ts` — tracked
- `runtime-host/api/routes/session-routes.ts` — tracked
- `runtime-host/api/routes/settings-routes.ts` — tracked
- `runtime-host/api/routes/skills-routes.ts` — tracked
- `runtime-host/api/routes/subagent-routes.ts` — tracked
- `runtime-host/api/routes/team-runtime-webhook-routes.ts` — tracked
- `runtime-host/api/routes/toolchain-uv-routes.ts` — tracked
- `runtime-host/api/routes/workbench-routes.ts` — tracked
- `runtime-host/bootstrap/runtime-config.ts` — tracked
- `runtime-host/host-process.cjs` — untracked-or-ignored
- `runtime-host/main-cli.ts` — untracked-or-ignored
- `runtime-host/main.ts` — untracked-or-ignored

### 02-composition-core.md

- `runtime-host/composition/application-service-registry.ts` — tracked
- `runtime-host/composition/application-services.ts` — tracked
- `runtime-host/composition/container.ts` — tracked
- `runtime-host/composition/gateway-auto-recovery.ts` — tracked
- `runtime-host/composition/gateway-device-identity-adapters.ts` — tracked
- `runtime-host/composition/license-node-runtime.ts` — tracked
- `runtime-host/composition/modules/acp-connector-module.ts` — tracked
- `runtime-host/composition/modules/agent-runtime-module.ts` — tracked
- `runtime-host/composition/modules/external-connectors-application-module.ts` — tracked
- `runtime-host/composition/modules/gateway-bridge-module.ts` — tracked
- `runtime-host/composition/modules/openclaw-application-module.ts` — tracked
- `runtime-host/composition/modules/openclaw-infrastructure-module.ts` — tracked
- `runtime-host/composition/modules/openclaw-route-module.ts` — tracked
- `runtime-host/composition/modules/operations-application-module.ts` — tracked
- `runtime-host/composition/modules/operations-route-module.ts` — tracked
- `runtime-host/composition/modules/platform-runtime-module.ts` — tracked
- `runtime-host/composition/modules/plugin-runtime-module.ts` — tracked
- `runtime-host/composition/modules/remote-fleet-application-module.ts` — untracked-or-ignored
- `runtime-host/composition/modules/runtime-application-module.ts` — tracked
- `runtime-host/composition/modules/runtime-infrastructure-module.ts` — tracked
- `runtime-host/composition/modules/runtime-route-module.ts` — tracked
- `runtime-host/composition/modules/session-route-module.ts` — tracked
- `runtime-host/composition/modules/session-runtime-module.ts` — tracked
- `runtime-host/composition/parent-transport-client.ts` — tracked
- `runtime-host/composition/plugin-file-system-adapter.ts` — tracked
- `runtime-host/composition/route-registry.ts` — tracked
- `runtime-host/composition/runtime-host-composition.ts` — tracked
- `runtime-host/composition/runtime-host-infrastructure-adapters.ts` — tracked
- `runtime-host/composition/runtime-host-module-registry.ts` — tracked
- `runtime-host/composition/runtime-host-runner.ts` — tracked
- `runtime-host/composition/runtime-host-runtime-module-registry.ts` — tracked
- `runtime-host/composition/runtime-host-server.ts` — tracked
- `runtime-host/composition/runtime-host-tokens.ts` — tracked
- `runtime-host/composition/runtime-route-composition.ts` — tracked
- `runtime-host/core/jobs.ts` — tracked
- `runtime-host/core/lifecycle.ts` — tracked
- `runtime-host/core/registry.ts` — tracked
- `runtime-host/services/background-task-manager.ts` — tracked

### 03-bridge-shared-plugin.md

- `runtime-host/openclaw-bridge/bridge.ts` — tracked
- `runtime-host/openclaw-bridge/capabilities.ts` — tracked
- `runtime-host/openclaw-bridge/client-auth-ports.ts` — tracked
- `runtime-host/openclaw-bridge/client-auth.ts` — tracked
- `runtime-host/openclaw-bridge/client-connection-tracker.ts` — tracked
- `runtime-host/openclaw-bridge/client-errors.ts` — tracked
- `runtime-host/openclaw-bridge/client-frame-handler.ts` — tracked
- `runtime-host/openclaw-bridge/client-heartbeat.ts` — tracked
- `runtime-host/openclaw-bridge/client-pending-rpc.ts` — tracked
- `runtime-host/openclaw-bridge/client-port-probe.ts` — tracked
- `runtime-host/openclaw-bridge/client-reconnect-policy.ts` — tracked
- `runtime-host/openclaw-bridge/client-rpc-sender.ts` — tracked
- `runtime-host/openclaw-bridge/client-socket-session.ts` — tracked
- `runtime-host/openclaw-bridge/client-state.ts` — tracked
- `runtime-host/openclaw-bridge/client.ts` — tracked
- `runtime-host/openclaw-bridge/events.ts` — tracked
- `runtime-host/openclaw-bridge/index.ts` — tracked
- `runtime-host/openclaw-bridge/protocol.ts` — tracked
- `runtime-host/plugin-engine/plugin-discovery.ts` — tracked
- `runtime-host/plugin-engine/plugin-file-system.ts` — tracked
- `runtime-host/plugin-engine/plugin-id.ts` — tracked
- `runtime-host/plugin-engine/plugin-location-rules.ts` — tracked
- `runtime-host/plugin-engine/plugin-manifest-loader.ts` — tracked
- `runtime-host/shared/browser-mode.ts` — tracked
- `runtime-host/shared/capability-descriptor.ts` — tracked
- `runtime-host/shared/chat-message-normalization.ts` — tracked
- `runtime-host/shared/device-identity.ts` — tracked
- `runtime-host/shared/gateway-chat-send-params.ts` — tracked
- `runtime-host/shared/gateway-error.ts` — tracked
- `runtime-host/shared/matcha-terminal-delivery-trace.ts` — untracked-or-ignored
- `runtime-host/shared/logger.ts` — tracked
- `runtime-host/shared/parent-transport-contracts.ts` — tracked
- `runtime-host/shared/platform-runtime-contracts.ts` — tracked
- `runtime-host/shared/runtime-address.ts` — tracked
- `runtime-host/shared/runtime-host-constants.ts` — tracked
- `runtime-host/shared/runtime-topology.ts` — tracked
- `runtime-host/shared/session-adapter-types.ts` — tracked
- `runtime-host/shared/task-tool-contract.ts` — tracked
- `runtime-host/shared/trace-log-level.ts` — tracked
- `runtime-host/shared/transport-contract.ts` — tracked
- `runtime-host/shared/types.ts` — tracked
- `runtime-host/shared/update-version.ts` — tracked

### 04-agent-runtime-capabilities.md

- `runtime-host/application/agent-runtime/agent-runtime-application-service.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/agent-runtime-registry.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/runtime-address.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/runtime-capability-descriptors.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/runtime-endpoint-types.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/runtime-identity-contract.ts` — tracked
- `runtime-host/application/agent-runtime/contracts/runtime-session-context.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-canonical-adapter.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-client-connector.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-framing.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-identity.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-json-rpc-client.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-profiles.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-protocol-adapter.ts` — tracked
- `runtime-host/application/agent-runtime/protocol-connectors/acp/acp-stdio-transport.ts` — tracked
- `runtime-host/application/capabilities/agent/agent-run-capability.ts` — tracked
- `runtime-host/application/capabilities/agent/agent-skill-config-capability.ts` — tracked
- `runtime-host/application/capabilities/agent/agent-tool-config-capability.ts` — tracked
- `runtime-host/application/capabilities/agent/subagent-management-capability.ts` — tracked
- `runtime-host/application/capabilities/approval/session-approval-capability.ts` — tracked
- `runtime-host/application/capabilities/contracts/capability-descriptor.ts` — tracked
- `runtime-host/application/capabilities/contracts/capability-registry.ts` — tracked
- `runtime-host/application/capabilities/contracts/capability-router.ts` — tracked
- `runtime-host/application/capabilities/integration/channel-integration-capability.ts` — tracked
- `runtime-host/application/capabilities/license/license-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/model/model-provider-capability.ts` — tracked
- `runtime-host/application/capabilities/model/session-model-capability.ts` — tracked
- `runtime-host/application/capabilities/platform/platform-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/plugin/plugin-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/runtime/runtime-host-capability.ts` — tracked
- `runtime-host/application/capabilities/scheduler/cron-scheduler-capability.ts` — tracked
- `runtime-host/application/capabilities/security/security-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/session/session-management-capability.ts` — tracked
- `runtime-host/application/capabilities/session/session-prompt-capability.ts` — tracked
- `runtime-host/application/capabilities/settings/settings-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/skill/skill-management-capability.ts` — tracked
- `runtime-host/application/capabilities/task/task-control-capability.ts` — tracked
- `runtime-host/application/capabilities/team/team-runtime-capability.ts` — tracked
- `runtime-host/application/capabilities/tool/tool-invoke-capability.ts` — tracked
- `runtime-host/application/capabilities/workspace/workspace-file-capability.ts` — tracked

### 05-platform-gateway-runtime-host.md

- `runtime-host/application/gateway/gateway-capability-service.ts` — tracked
- `runtime-host/application/gateway/gateway-readiness.ts` — tracked
- `runtime-host/application/gateway/gateway-runtime-port.ts` — tracked
- `runtime-host/application/gateway/service.ts` — tracked
- `runtime-host/application/platform-runtime/audit-sink.ts` — tracked
- `runtime-host/application/platform-runtime/context-assembler.ts` — tracked
- `runtime-host/application/platform-runtime/index.ts` — tracked
- `runtime-host/application/platform-runtime/local-event-bus.ts` — tracked
- `runtime-host/application/platform-runtime/platform-jobs.ts` — tracked
- `runtime-host/application/platform-runtime/platform-runtime-port.ts` — tracked
- `runtime-host/application/platform-runtime/policy-engine.ts` — tracked
- `runtime-host/application/platform-runtime/run-session-service.ts` — tracked
- `runtime-host/application/platform-runtime/runtime-manager-service.ts` — tracked
- `runtime-host/application/platform-runtime/service.ts` — tracked
- `runtime-host/application/platform-runtime/state/gateway-plugin-state-ledger.ts` — tracked
- `runtime-host/application/platform-runtime/state/local-plugin-state-ledger.ts` — tracked
- `runtime-host/application/platform-runtime/state/tool-registry-store.ts` — tracked
- `runtime-host/application/platform-runtime/state/tool-registry-view-ledger.ts` — tracked
- `runtime-host/application/platform-runtime/tool-catalog-service.ts` — tracked
- `runtime-host/application/platform-runtime/tool-executor.ts` — tracked
- `runtime-host/application/platform-runtime/tool-reconciler.ts` — tracked
- `runtime-host/application/runtime-host/bootstrap-jobs.ts` — tracked
- `runtime-host/application/runtime-host/bootstrap.ts` — tracked
- `runtime-host/application/runtime-host/parent-shell-port.ts` — tracked
- `runtime-host/application/runtime-host/prelaunch-maintenance-cache.ts` — tracked
- `runtime-host/application/runtime-host/prelaunch-plugin-maintenance.ts` — tracked
- `runtime-host/application/runtime-host/runtime-jobs-service.ts` — tracked
- `runtime-host/application/runtime-host/runtime-long-task-service.ts` — tracked
- `runtime-host/application/runtime-host/runtime-state.ts` — tracked
- `runtime-host/application/runtime-host/runtime-task-ports.ts` — tracked
- `runtime-host/application/runtime-host/service.ts` — tracked

### 06-sessions.md

- `runtime-host/application/sessions/assistant-segment-media.ts` — tracked
- `runtime-host/application/sessions/assistant-turn-assembler.ts` — tracked
- `runtime-host/application/sessions/assistant-turn-entry.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-approval-events.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-events.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-projection.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-reducer.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-state.ts` — tracked
- `runtime-host/application/sessions/canonical/canonical-transcript-replay.ts` — tracked
- `runtime-host/application/sessions/service.ts` — tracked
- `runtime-host/application/sessions/session-catalog-jobs.ts` — tracked
- `runtime-host/application/sessions/session-catalog-model.ts` — tracked
- `runtime-host/application/sessions/session-catalog.ts` — tracked
- `runtime-host/application/sessions/session-command-service.ts` — tracked
- `runtime-host/application/sessions/session-context-tokens.ts` — tracked
- `runtime-host/application/sessions/session-execution-graph-runtime.ts` — tracked
- `runtime-host/application/sessions/session-gateway-ingress-service.ts` — tracked
- `runtime-host/application/sessions/session-hydration-jobs.ts` — tracked
- `runtime-host/application/sessions/session-metadata-repository.ts` — tracked
- `runtime-host/application/sessions/session-operation-coordinator.ts` — tracked
- `runtime-host/application/sessions/session-prompt-service.ts` — tracked
- `runtime-host/application/sessions/session-render-model.ts` — tracked
- `runtime-host/application/sessions/session-runtime-requests.ts` — tracked
- `runtime-host/application/sessions/session-runtime-state.ts` — tracked
- `runtime-host/application/sessions/session-runtime-store-repository.ts` — tracked
- `runtime-host/application/sessions/session-runtime-types.ts` — tracked
- `runtime-host/application/sessions/session-snapshot-service.ts` — tracked
- `runtime-host/application/sessions/session-state-model.ts` — tracked
- `runtime-host/application/sessions/session-storage-repository.ts` — tracked
- `runtime-host/application/sessions/session-timeline-runtime.ts` — tracked
- `runtime-host/application/sessions/session-transcript-timeline-loader.ts` — tracked
- `runtime-host/application/sessions/session-value-normalization.ts` — tracked
- `runtime-host/application/sessions/session-window-model.ts` — tracked
- `runtime-host/application/sessions/state-only-tools.ts` — tracked
- `runtime-host/application/sessions/task-completion-events.ts` — tracked
- `runtime-host/application/sessions/task-snapshot-normalizer.ts` — tracked
- `runtime-host/application/sessions/timeline-state.ts` — tracked
- `runtime-host/application/sessions/todo-tool-debug.ts` — tracked
- `runtime-host/application/sessions/tool/tool-card-content.ts` — tracked
- `runtime-host/application/sessions/tool/tool-card-preview.ts` — tracked
- `runtime-host/application/sessions/tool/tool-card-render-state.ts` — tracked
- `runtime-host/application/sessions/tool/tool-card-utils.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-browser-detail.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-common.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-detail-resolvers.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-exec-shell.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-exec.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-format.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display-message-detail.ts` — tracked
- `runtime-host/application/sessions/tool/tool-display.ts` — tracked
- `runtime-host/application/sessions/transcript-content-extractors.ts` — tracked
- `runtime-host/application/sessions/transcript-labels.ts` — tracked
- `runtime-host/application/sessions/transcript-media-extractors.ts` — tracked
- `runtime-host/application/sessions/transcript-parser.ts` — tracked
- `runtime-host/application/sessions/transcript-task-snapshot-replay.ts` — tracked
- `runtime-host/application/sessions/transcript-types.ts` — tracked

### 07-session-workflows.md

- `runtime-host/application/workflows/session-approval/session-approval-workflow.ts` — tracked
- `runtime-host/application/workflows/session-catalog/session-catalog-workflow.ts` — tracked
- `runtime-host/application/workflows/session-command/session-command-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/session-gateway-ingress/session-gateway-ingress-workflow.ts` — tracked
- `runtime-host/application/workflows/session-hydration/session-hydration-workflow.ts` — tracked
- `runtime-host/application/workflows/session-lifecycle/session-lifecycle-workflow.ts` — tracked
- `runtime-host/application/workflows/session-metadata/session-model-resolution-workflow.ts` — tracked
- `runtime-host/application/workflows/session-model-selection/session-model-selection-workflow.ts` — tracked
- `runtime-host/application/workflows/session-operation/session-operation-result-workflow.ts` — tracked
- `runtime-host/application/workflows/session-run/session-run-workflow.ts` — tracked
- `runtime-host/application/workflows/session-runtime-store/session-runtime-store-persistence-workflow.ts` — tracked
- `runtime-host/application/workflows/session-snapshot/session-snapshot-workflow.ts` — tracked
- `runtime-host/application/workflows/session-storage/session-storage-index-workflow.ts` — tracked
- `runtime-host/application/workflows/session-storage/session-storage-mutation-workflow.ts` — tracked
- `runtime-host/application/workflows/session-storage/session-storage-repository-workflow.ts` — tracked
- `runtime-host/application/workflows/session-storage/session-storage-transcript-workflow.ts` — tracked

### 08-nonsession-workflows.md

- `runtime-host/application/workflows/channel-runtime/channel-activation-workflow.ts` — tracked
- `runtime-host/application/workflows/channel-runtime/channel-config-mutation-workflow.ts` — tracked
- `runtime-host/application/workflows/channel-runtime/channel-config-workflow.ts` — tracked
- `runtime-host/application/workflows/channel-runtime/channel-runtime-workflow.ts` — tracked
- `runtime-host/application/workflows/cron/cron-job-mutation-workflow.ts` — tracked
- `runtime-host/application/workflows/cron/cron-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/diagnostics/diagnostics-collection-workflow.ts` — tracked
- `runtime-host/application/workflows/gateway-readiness/gateway-readiness-workflow.ts` — tracked
- `runtime-host/application/workflows/platform-runtime/platform-native-tool-workflow.ts` — tracked
- `runtime-host/application/workflows/platform-runtime/platform-run-session-workflow.ts` — tracked
- `runtime-host/application/workflows/platform-runtime/platform-runtime-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/platform-runtime/platform-tool-runtime-workflow.ts` — tracked
- `runtime-host/application/workflows/platform-runtime/platform-tool-state-workflow.ts` — tracked
- `runtime-host/application/workflows/plugin-lifecycle/plugin-companion-skill-workflow.ts` — tracked
- `runtime-host/application/workflows/plugin-lifecycle/runtime-plugin-lifecycle-workflow.ts` — tracked
- `runtime-host/application/workflows/plugin-runtime/plugin-catalog-discovery-workflow.ts` — tracked
- `runtime-host/application/workflows/plugin-runtime/plugin-runtime-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-account/provider-account-mutation-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-capability-routing-store/provider-capability-routing-store-persistence-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-capability-routing/provider-capability-routing-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-model/provider-models-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-model/provider-models-projection-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-models-store/provider-models-store-persistence-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-oauth/provider-oauth-completion-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow.ts` — tracked
- `runtime-host/application/workflows/provider-store/provider-store-persistence-workflow.ts` — tracked
- `runtime-host/application/workflows/runtime-bootstrap/gateway-prelaunch-workflow.ts` — tracked
- `runtime-host/application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow.ts` — tracked
- `runtime-host/application/workflows/runtime-host/runtime-host-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/scheduled-agent/scheduled-agent-trigger-workflow.ts` — tracked
- `runtime-host/application/workflows/security-emergency/security-emergency-response-workflow.ts` — tracked
- `runtime-host/application/workflows/security-operations/security-gateway-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/security-operations/security-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/security-policy/security-policy-store-workflow.ts` — tracked
- `runtime-host/application/workflows/security-policy/security-policy-sync-workflow.ts` — tracked
- `runtime-host/application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow.ts` — tracked
- `runtime-host/application/workflows/settings-store/settings-store-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-install/clawhub-skill-install-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-install/local-skill-import-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-install/preinstalled-skills-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-install/skill-bundle-transfer-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-runtime/skill-runtime-workflow.ts` — tracked
- `runtime-host/application/workflows/skill-runtime/skills-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow.ts` — tracked
- `runtime-host/application/workflows/task-runtime/task-operations-workflow.ts` — tracked
- `runtime-host/application/workflows/task-runtime/task-runtime-workflow.ts` — tracked
- `runtime-host/application/workflows/toolchain-install/uv-python-install-workflow.ts` — tracked
- `runtime-host/application/workflows/usage/token-usage-history-workflow.ts` — tracked
- `runtime-host/application/workflows/workspace-file/workspace-file-runtime-workflow.ts` — tracked

### 09-openclaw-runtime-infrastructure.md

- `runtime-host/application/adapters/openclaw/gateway/openclaw-gateway-event-bridge.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-agent-model-repository.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-profile-store.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-provider-keys.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-auth-store.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-mutex.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-config-repository.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-environment-repository.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-runtime-data-layout.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-subagent-template-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-context-merge.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-rules.ts` — tracked
- `runtime-host/application/adapters/openclaw/infrastructure/openclaw-workspace-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-approval-adapter.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-profile.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-adapter.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-driver.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-session-artefact-resolver.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-session-metadata-resolver.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-transport.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-v4-canonical-adapter.ts` — tracked
- `runtime-host/application/adapters/openclaw/runtime/openclaw-v4-protocol-adapter.ts` — tracked

### 10-openclaw-projections.md

- `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-projection.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status-jobs.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/external-connector-openclaw-mcp-status.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-agent-tool-config-projection.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-anthropic-messages-max-tokens.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-capability-routing-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-channel-config-projection.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-channel-login-session-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-channel-plugin-bindings.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer-rules.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-config-sanitizer.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-custom-media-plugin-config-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-injected-plugin-catalog-platform-policy.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-catalog.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-managed-plugin-installer.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-oauth-plugin-registration.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-catalog-kind-policy.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-channel-config.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-model.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-config-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-discovery-state.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-install-record.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-plugin-skill-sync.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-accounts-projection-port.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-rules.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-config-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-entry-builder.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-model-pruning.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-models-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-provider-snapshot.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-proxy-sync.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-runtime-config-sync.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-security-plugin-config-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/projections/openclaw-subagent-config-projection.ts` — tracked

### 11-openclaw-workflows.md

- `runtime-host/application/adapters/openclaw/openclaw-service.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-agent-model-store-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-profile-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-auth/openclaw-auth-store-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-capability-routing-projection-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-channel/openclaw-weixin-account-store-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-plugin/openclaw-plugin-config-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-custom-media-plugin-config-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-config-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-provider/openclaw-provider-models-projection-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-security-plugin-config-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-cli-command-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-config-file-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-environment-status-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-subagent-template-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-maintenance-workflow.ts` — tracked
- `runtime-host/application/adapters/openclaw/workflows/openclaw-workspace/openclaw-workspace-query-workflow.ts` — tracked

### 12-team-runtime-remote-fleet.md

- `runtime-host/application/remote-fleet/index.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/infrastructure/remote-fleet-file-state-store.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/infrastructure/remote-fleet-node-identity.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/infrastructure/remote-fleet-system-clock.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/infrastructure/worker/remote-fleet-worker-entry.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-agent-client.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-agent-ingress.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-audit.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-bootstrap-dispatcher.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-bootstrap-docker-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-bootstrap-k8s-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-bootstrap-ssh-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-bootstrap.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-capability-projection.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-capability-routes.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-command-dispatch.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-command-policy.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-command-queue.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-connectors.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-credential-host-rpc.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-credential-store.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-custom-terminal-config.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-docker-target-config.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-environment-secret-resolver.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-k8s-target-config.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-lease-manager.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-log-stream.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-metrics.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-model.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-operation-id.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-ops-timeline.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-reconcile.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-routing-service.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-runtime-agent-transport-dispatcher.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-runtime-launch.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-runtime.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-secret-host-rpc.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-secret-policy.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-service.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-ssh-target-config.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-store.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-contracts.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-custom-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-docker-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-k8s-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-manager.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-providers.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-terminal-ssh-provider.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-worker-client.ts` — untracked-or-ignored
- `runtime-host/application/remote-fleet/remote-fleet-worker-contracts.ts` — untracked-or-ignored
- `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-materialization-adapter.ts` — tracked
- `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-agent-policy-projection.ts` — tracked
- `runtime-host/application/team-runtime/adapters/openclaw/openclaw-team-role-session-materialization-adapter.ts` — tracked
- `runtime-host/application/team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts` — untracked-or-ignored
- `runtime-host/application/team-runtime/adapters/session-runtime-team-role-session-adapter.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-command-ledger.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-event.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-evidence.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-instance.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-managed-agent.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-node-prompt-delivery.ts` — tracked
- `runtime-host/application/team-runtime/domain/team-run.ts` — tracked
- `runtime-host/application/team-runtime/graph/definition.ts` — tracked
- `runtime-host/application/team-runtime/graph/export-yaml.ts` — tracked
- `runtime-host/application/team-runtime/graph/index.ts` — tracked
- `runtime-host/application/team-runtime/graph/projection.ts` — tracked
- `runtime-host/application/team-runtime/graph/reducer.ts` — tracked
- `runtime-host/application/team-runtime/graph/run-state.ts` — tracked
- `runtime-host/application/team-runtime/graph/scheduler.ts` — tracked
- `runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/index.ts` — tracked
- `runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-command-ledger.ts` — tracked
- `runtime-host/application/team-runtime/infrastructure/worker/team-runtime-worker-entry.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-agent-materialization-port.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-command-ledger-port.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-node-prompt-delivery-port.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-notification-port.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-role-session-materialization-port.ts` — tracked
- `runtime-host/application/team-runtime/ports/team-role-session-port.ts` — tracked
- `runtime-host/application/team-runtime/team-dependency-plan.ts` — tracked
- `runtime-host/application/team-runtime/team-node-prompt-delivery-service.ts` — tracked
- `runtime-host/application/team-runtime/team-run-registry.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-cron-scheduler.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-debug-logging.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-jobs.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-operation-id.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-package-service.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-port.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-service.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-state-store.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-webhook-auth.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-worker-client.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-worker-contracts.ts` — tracked
- `runtime-host/application/team-runtime/team-runtime-worker-host-proxy.ts` — tracked

### 13-connectors-plugins-skills.md

- `runtime-host/application/external-connectors/external-connector-capability.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-connection-status.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-downstream-status.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-json-store.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-model.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-service.ts` — tracked
- `runtime-host/application/external-connectors/external-connector-store.ts` — tracked
- `runtime-host/application/external-connectors/external-mcp-server-program-catalog.ts` — tracked
- `runtime-host/application/plugins/catalog.ts` — tracked
- `runtime-host/application/plugins/managed-plugin-catalog.ts` — tracked
- `runtime-host/application/plugins/plugin-companion-skill-service.ts` — tracked
- `runtime-host/application/plugins/plugin-groups.ts` — tracked
- `runtime-host/application/plugins/plugin-lifecycle-registry.ts` — tracked
- `runtime-host/application/plugins/plugin-lifecycle-types.ts` — tracked
- `runtime-host/application/plugins/plugin-lifecycles/memory-lancedb-pro-lifecycle.ts` — tracked
- `runtime-host/application/plugins/plugin-runtime-jobs.ts` — tracked
- `runtime-host/application/plugins/plugin-runtime-service.ts` — tracked
- `runtime-host/application/plugins/runtime-plugin-registry.ts` — tracked
- `runtime-host/application/plugins/runtime-plugin-service.ts` — tracked
- `runtime-host/application/skills/clawhub-cli.ts` — tracked
- `runtime-host/application/skills/clawhub-jobs.ts` — tracked
- `runtime-host/application/skills/clawhub-registry-client.ts` — tracked
- `runtime-host/application/skills/clawhub.ts` — tracked
- `runtime-host/application/skills/service.ts` — tracked
- `runtime-host/application/skills/skills-jobs.ts` — tracked
- `runtime-host/application/skills/store.ts` — tracked
- `runtime-host/application/toolchain/toolchain-jobs.ts` — tracked
- `runtime-host/application/toolchain/uv-service.ts` — tracked

### 14-operational-domains.md

- `runtime-host/application/channels/channel-activation-strategy.ts` — tracked
- `runtime-host/application/channels/channel-jobs.ts` — tracked
- `runtime-host/application/channels/channel-login-session-service.ts` — tracked
- `runtime-host/application/channels/channel-pairing-service.ts` — tracked
- `runtime-host/application/channels/channel-runtime.ts` — tracked
- `runtime-host/application/channels/channel-snapshot-projection.ts` — tracked
- `runtime-host/application/channels/service.ts` — tracked
- `runtime-host/application/chat/send-media.ts` — tracked
- `runtime-host/application/common/application-response.ts` — tracked
- `runtime-host/application/common/runtime-contracts.ts` — tracked
- `runtime-host/application/common/runtime-job-throttle.ts` — tracked
- `runtime-host/application/common/runtime-ports.ts` — tracked
- `runtime-host/application/cron/cron-jobs.ts` — tracked
- `runtime-host/application/cron/cron-model.ts` — tracked
- `runtime-host/application/cron/cron-session-history.ts` — tracked
- `runtime-host/application/cron/service.ts` — tracked
- `runtime-host/application/files/file-service.ts` — tracked
- `runtime-host/application/license/license-rules.ts` — tracked
- `runtime-host/application/license/service.ts` — tracked
- `runtime-host/application/providers/account-runtime.ts` — tracked
- `runtime-host/application/providers/accounts.ts` — tracked
- `runtime-host/application/providers/capability-routing-service.ts` — tracked
- `runtime-host/application/providers/capability-routing-store.ts` — tracked
- `runtime-host/application/providers/custom-media-provider-contracts.ts` — tracked
- `runtime-host/application/providers/custom-media-runtime-projection.ts` — tracked
- `runtime-host/application/providers/oauth-runtime.ts` — tracked
- `runtime-host/application/providers/provider-account-jobs.ts` — tracked
- `runtime-host/application/providers/provider-accounts-projection-port.ts` — tracked
- `runtime-host/application/providers/provider-model-capabilities.ts` — tracked
- `runtime-host/application/providers/provider-models-service.ts` — tracked
- `runtime-host/application/providers/provider-models-store.ts` — tracked
- `runtime-host/application/providers/provider-oauth-account-service.ts` — tracked
- `runtime-host/application/providers/provider-projection-sync-plan.ts` — tracked
- `runtime-host/application/providers/provider-registry.ts` — tracked
- `runtime-host/application/providers/provider-store-model.ts` — tracked
- `runtime-host/application/providers/provider-store-repository.ts` — tracked
- `runtime-host/application/providers/provider-types.ts` — tracked
- `runtime-host/application/providers/provider-validation.ts` — tracked
- `runtime-host/application/providers/store-sync.ts` — tracked
- `runtime-host/application/security/security-emergency-policy.ts` — tracked
- `runtime-host/application/security/security-jobs.ts` — tracked
- `runtime-host/application/security/security-plugin-config-applier.ts` — tracked
- `runtime-host/application/security/security-policy-normalizer.ts` — tracked
- `runtime-host/application/security/security-policy-presets.ts` — tracked
- `runtime-host/application/security/security-policy-store.ts` — tracked
- `runtime-host/application/security/security-policy-types.ts` — tracked
- `runtime-host/application/security/security-rule-catalog.ts` — tracked
- `runtime-host/application/security/service.ts` — tracked
- `runtime-host/application/settings/defaults.ts` — tracked
- `runtime-host/application/settings/service.ts` — tracked
- `runtime-host/application/settings/settings-jobs.ts` — tracked
- `runtime-host/application/settings/store.ts` — tracked
- `runtime-host/application/usage/token-usage-history-jobs.ts` — tracked
- `runtime-host/application/usage/token-usage-history.ts` — tracked
- `runtime-host/application/usage/token-usage-parser.ts` — tracked

### 15-remaining-application.md

- `runtime-host/application/adapters/matcha-agent/runtime/index.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-app-server-client.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-event-bridge.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-profile.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-protocol-adapter.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-adapter.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-runtime-identity.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-session-checkpoint-store.ts` — untracked-or-ignored
- `runtime-host/application/adapters/matcha-agent/runtime/matcha-agent-transport.ts` — untracked-or-ignored
- `runtime-host/application/runtime-cli/matcha-runtime-command.ts` — tracked
- `runtime-host/application/runtime-cli/mcp-stdio-json-rpc.ts` — tracked
- `runtime-host/application/runtime-cli/runtime-host-dispatch-client.ts` — tracked
- `runtime-host/application/runtime-cli/system-runtime-mcp-server-command.ts` — tracked
- `runtime-host/application/subagents/agent-skill-config-contracts.ts` — tracked
- `runtime-host/application/subagents/agent-skill-config-service.ts` — tracked
- `runtime-host/application/subagents/agent-tool-config-contracts.ts` — tracked
- `runtime-host/application/subagents/agent-tool-config-service.ts` — tracked
- `runtime-host/application/subagents/service.ts` — tracked
- `runtime-host/application/subagents/subagent-config-contracts.ts` — tracked
- `runtime-host/application/support/diagnostics-bundle.ts` — tracked
- `runtime-host/application/support/diagnostics-jobs.ts` — tracked
- `runtime-host/application/support/diagnostics.ts` — tracked
- `runtime-host/application/tasks/service.ts` — tracked
- `runtime-host/application/workbench/bootstrap.ts` — tracked
- `runtime-host/application/workbench/service.ts` — tracked

## 明确排除

- `runtime-host/build/**`：编译输出，不是需要迁移的 source of truth。
- `node_modules/**`、覆盖率、测试输出、临时目录：不是本仓库拥有的 runtime-host 生产源。
- `runtime-host/package.json`、`runtime-host/tsconfig.json`：构建配置，将在最终迁移实施阶段单列，不伪装成代码语义记录。

## 当前 `git status` 全量覆盖账本

> 快照方法：`git status --short --untracked-files=all`。本节覆盖审计开始时工作树的 **M / D / ??** 条目；它的作用是防止本次审计只因初始 inventory 聚焦 `runtime-host/**` 而静默遗漏当前改动。文件归类为 production semantic owner、Delivery / build evidence、test oracle、文档/治理，或明确排除的本地/二进制产物。分类不是“测试已经运行”或“迁移已经完成”的声明。

### 当前生产代码：必须有旧 owner / active-path 记录

| 当前 status 路径 | 本次记录位置 | 分类与边界 |
|---|---|---|
| `electron/gateway/{config-sync-env,config-sync,lifecycle-controller,manager,port-readiness,process-launcher,process-policy,public-status,restart-controller,startup-orchestrator,startup-recovery,startup-stderr,state,supervisor}.ts`（删除）及 `electron/main/process-runtime/openclaw-gateway/**`（新增） | [05-platform-gateway-runtime-host.md](05-platform-gateway-runtime-host.md)、[08-nonsession-workflows.md](08-nonsession-workflows.md)、[09-openclaw-runtime-infrastructure.md](09-openclaw-runtime-infrastructure.md) | 当前 Gateway lifecycle 的外部旧 owner：config、attach/orphan、readiness、restart/recovery、stderr、public lifecycle、shutdown/PID/provenance。目标 Rust Local Process Host必须接管其受管 Runtime lifecycle语义；Gateway协议/配置adapter与OpenClaw native internals仍分别归Runtime Integration/Native Runtime Edge。 |
| `electron/main/runtime-host-process-manager.ts`（删除）及 `electron/main/process-runtime/{local-process-runtime,process-registry,runtime-host-process-manager,adapters/runtime-host-process-adapter,contracts,readiness,restart-policy,log-tail}.ts` | [01-api-bootstrap.md](01-api-bootstrap.md)、[02-composition-core.md](02-composition-core.md)、[05-platform-gateway-runtime-host.md](05-platform-gateway-runtime-host.md) | runtime-host Local Process Host的外部旧 owner：launch/attach、child handle/PID provenance、readiness、restart/backoff、logs、graceful/force shutdown、process-tree cleanup与public lifecycle。当前在Electron；终态应由Rust Runtime/Local Process Host成为唯一active semantic owner。 |
| `electron/main/process-runtime/{matcha-agent-app-server-process-manager,adapters/matcha-agent-app-server-process-adapter}.ts`、`local-process-runtime.ts` 的 stdin-grace/tree-kill、`matcha-agent/src/app-server/{main.ts,workers/workerProcess.ts,workers/workerSupervisor.ts}`及 app-server status/restart接线 | [04-agent-runtime-capabilities.md](04-agent-runtime-capabilities.md)、[15-remaining-application.md](15-remaining-application.md) | app-server root 的stdin协议关闭、3秒grace、root PID/provenance与tree-kill升级是Rust Local Process Host的外部旧 owner；`WorkerSupervisor`的ACK→stdin EOF→真实worker exit→2秒后kill语义仍是peer Native Runtime Edge。`taskkill /T`只可作root未退出后的异常兜底，不是正常worker回收；迁移必须另验root退出后的worker orphan与restart non-overlap，不能随worker/run/approval/event-store/snapshot/index一并迁入。 |
| `electron/{api,main,preload,utils}/**` 其余 status 生产路径（含 Host API、窗口/bootstrap、IPC、Host API proxy、config、logs/diagnostics route） | [01-api-bootstrap.md](01-api-bootstrap.md)、[04-agent-runtime-capabilities.md](04-agent-runtime-capabilities.md)、[12-team-runtime-remote-fleet.md](12-team-runtime-remote-fleet.md)、[15-remaining-application.md](15-remaining-application.md) | Delivery client/desktop integration或相应runtime-host public contract witness；不拥有业务事实。仅上列被最终架构指定的受管 Runtime lifecycle语义进入Rust迁移，不能按整个Electron目录迁移。 |
| `runtime-host/api/routes/{remote-fleet-routes,remote-fleet-runtime-agent-ingress-route}.ts`、`runtime-host/api/routes/route-utils.ts`、`runtime-host/main.ts` | [01-api-bootstrap.md](01-api-bootstrap.md) | Remote Fleet HTTP command/query 和 RuntimeAgent ingress 是两个不同 supported entry；route/transport 不拥有 Fleet facts。 |
| `runtime-host/composition/**` 的 status 路径（含 `modules/remote-fleet-application-module.ts`） | [02-composition-core.md](02-composition-core.md) | composition / registry / dynamic binding evidence；不能把 DI registration 当作业务事实或完整 active reachability 证明。 |
| `runtime-host/openclaw-bridge/**`、`runtime-host/shared/runtime-topology.ts`、`runtime-host/shared/matcha-terminal-delivery-trace.ts` | [03-bridge-shared-plugin.md](03-bridge-shared-plugin.md) | OpenClaw protocol transport epoch、readiness observation、terminal delivery trace 与 cross-runtime topology grammar。 |
| `runtime-host/application/{agent-runtime,capabilities}/**` 的 status 路径 | [04-agent-runtime-capabilities.md](04-agent-runtime-capabilities.md) | Endpoint binding、dynamic capability scope/replace/prune 与 transport selection；registry 不是 Fleet / Session facts source。 |
| `runtime-host/application/{gateway,platform-runtime,runtime-host}/**` 的 status 路径 | [05-platform-gateway-runtime-host.md](05-platform-gateway-runtime-host.md) | Gateway readiness/bootstrap、runtime lifecycle facade 和 job boundary；Gateway native control remains Runtime Integration。 |
| `runtime-host/application/sessions/**` 的 status 路径 | [06-sessions.md](06-sessions.md) | Session canonical facts/reducer/timeline and transcript-derived projections. |
| `runtime-host/application/workflows/session-{catalog,gateway-ingress,lifecycle,run}/**` 的 status 路径 | [07-session-workflows.md](07-session-workflows.md) | Local commit → runtime send、ingress/reducer、catalog/lifecycle workflow updates; no unproven external receipt guarantee. |
| `runtime-host/application/workflows/{gateway-readiness,runtime-bootstrap,runtime-host,skill-runtime}/**` 的 status 路径 | [08-nonsession-workflows.md](08-nonsession-workflows.md) | Gateway prelaunch/readiness、runtime operation 与 skill workflow changes。 |
| `runtime-host/application/adapters/openclaw/{gateway,runtime}/**` 的 status 路径 | [09-openclaw-runtime-infrastructure.md](09-openclaw-runtime-infrastructure.md) | OpenClaw profile, canonical translation and gateway-event integration；不迁移 OpenClaw LLM loop/tool harness/native approval。 |
| `runtime-host/application/{remote-fleet,team-runtime/adapters/remote-fleet-team-endpoint-selector-adapter.ts}`、Remote Fleet routes/composition | [12-team-runtime-remote-fleet.md](12-team-runtime-remote-fleet.md) | Fleet Domain facts / queue / lease / reconciliation；RuntimeAgent ingress 独立入口；TeamRun selector 只是下游 consumer。 |
| `runtime-host/application/adapters/matcha-agent/runtime/**` | [15-remaining-application.md](15-remaining-application.md) | matcha-agent peer Runtime Integration adapter；不能把 native runtime LLM loop、tool harness、approval或持久状态上收给 runtime-host/Rust。 |
| `matcha-agent/src/app-server/{main.ts,sessions/sessionEventCommitter.ts,transport/clientHub.ts,workers/workerSupervisor.ts}` | [15-remaining-application.md](15-remaining-application.md) | Native Runtime Edge 的 app-server facts、worker、event append/commit、client fan-out；与 Runtime Integration 的 boundary 一并记录。 |
| `src/**` 的 status 生产路径（含 `src/pages/RemoteFleet/**`、chat/team/gateway/layout/settings、`src/lib/**`、`src/stores/**`、i18n） | [04-agent-runtime-capabilities.md](04-agent-runtime-capabilities.md)、[06-sessions.md](06-sessions.md)、[07-session-workflows.md](07-session-workflows.md)、[12-team-runtime-remote-fleet.md](12-team-runtime-remote-fleet.md)、[14-operational-domains.md](14-operational-domains.md)、[15-remaining-application.md](15-remaining-application.md) | Renderer/host API/UI store/locale是Delivery projection与用户入口：Session、Fleet、TeamRun、Settings、peer runtime等只将其作为consumer contract/oracle，不能反推canonical truth或外部effect completion。 |

### Delivery、构建、治理与文档：必须显式保留为证据，非旧 semantic owner

| 当前 status 路径 | 分类 / 审计处理 |
|---|---|
| `.github/workflows/{check,release}.yml`、`electron-builder.yml`、`package.json`、`pnpm-lock.yaml`、`tsconfig.runtime-host-process.json`、`vite.config.ts` | CI、dependency resolution、Electron package matrix 与 worker build topology evidence；当前仍为 Node/TS runtime-host delivery baseline，不能误写为 Rust workspace/CI 已存在。 |
| `scripts/{after-pack.cjs,build-matcha-agent.mjs,check-main-api-boundary.mjs,dev-with-run-trace.mjs}` | package / build / boundary / developer-run tracing evidence。`dev-with-run-trace.mjs` 的输出、token、path、trace redaction 仍须在 delivery audit 中负向验证，不能把脚本本身当 business owner。 |
| `.gitignore` | repository hygiene / inclusion evidence；它允许 command/audit governance 被 Git 跟踪，但未自动使未跟踪文件成为 committed migration evidence。 |
| `.claude/commands/{code,runtime-host-ts-rust-migrate}.md`、`RUNTIME_HOST_TS_RUST_IMPLEMENTATION_STANDARD.md` | migration governance；不是当前生产 owner，也不表示 Rust cutover、attestation、workspace 或 CI 已存在。 |
| `docs/architecture/{layered-architecture,local-process-runtime-matcha-agent-app-server-plan,matcha-agent-os-target-architecture}.md`、`docs/agents/{debugging-playbook,debugging-case-archive}.md` | architecture / debugging / design evidence。只可记录已由代码证明的当前事实；计划和目标不能反向成为当前 semantic owner 证据。 |
| `docs/architecture/runtime-host-ts-rust-migration-audit/{README,00-inventory,01-api-bootstrap,02-composition-core,03-bridge-shared-plugin,04-agent-runtime-capabilities,05-platform-gateway-runtime-host,06-sessions,07-session-workflows,08-nonsession-workflows,09-openclaw-runtime-infrastructure,10-openclaw-projections,11-openclaw-workflows,12-team-runtime-remote-fleet,13-connectors-plugins-skills,14-operational-domains,15-remaining-application}.md` | 本审计证据库本身；未经 Git add/commit 不能替代未来 migration record 或 immutable attestation。 |
| `matcha-agent/docs/{matcha-agent-app-server-architecture,matcha-agent-architecture}.md` | peer Runtime architecture documentation；用于边界证据，不是 app-server source of truth。 |

### Test oracle：已列入审计，但本次未执行

以下 status 测试条目全部只作为现有/待补 oracle，不被写为通过：

- `tests/contract/**`：runtime-host transport / API harness contract evidence。
- `tests/integration/remote-fleet-docker.integration.test.ts`：Docker provider 外部副作用 integration oracle。
- `tests/unit/local-process-*.test.ts`、`tests/unit/{app-bootstrap,log-routes,matcha-agent-app-server-*,openclaw-gateway-process-*,openclaw-gateway-supervisor,runtime-host-process-manager-compatibility,runtime-host-server-runtime-agent-ingress}.test.ts`：当前 Electron process-runtime/route/app-server Delivery evidence。
- `tests/unit/remote-fleet-*.test.ts`：Remote Fleet model、queue、policy、provider、terminal、secret、worker、route、projection、renderer evidence。
- 其余 status 中的 `tests/unit/**`（Gateway、runtime-host、agent-runtime、session、chat、Teams、IPC、config、host API 等）及 `matcha-agent/src/app-server/{__tests__,transport/__tests__}/**`：对应生产文件的回归/contract evidence。它们必须在关联分片保留为未运行 oracle，不能因文件名或 mock 存在而推断真实外部 provider、process、durability 或 security boundary 已验证。

### 明确排除：不复制、不提交为迁移 production owner

| 当前 status 路径 | 排除理由 |
|---|---|
| `matcha-agent/.matcha-agent-app-server/sessions/**` | 本地运行产生的 JSONL、snapshot、index；可能含 session/run/prompt/tool/approval/worker/payload 与 workspace 信息。可作为敏感 storage-shape 的抽象风险证据，**不得**复制内容进 audit、fixture、日志或提交。 |
| `resources/skills/plugin-companion-skills/browser-flow-create/runtime/__pycache__/openclaw_browser_client.cpython-314.pyc` | Python bytecode cache，不是仓库拥有的生产 source。 |
| `0001-build-add-opt-in-matcha-agent-packaging.patch` | 本地补丁产物；不是 active source、delivery artifact 或迁移证据。 |
| `软件著作权申请资料/**`（含 `.rar`、`.docx`、截图、草稿、JSON/Markdown/TXT） | 软件著作权申请资料与生成物；不是 runtime-host/peer Runtime production source。不得将其二进制、截图或可能含产品/环境数据的内容纳入 migration evidence。 |

### 复核规则

1. 上表覆盖当前 status 的每个路径族；新增 status 生产路径必须先增补其所属分片或新增独占 Delivery audit，不能只在最终回复提及。
2. 删除的旧 Gateway/manager 文件和新增 process-runtime 文件必须一起核对，防止以“目录移动”掩盖策略、状态或 external-controller ownership 的变化。
3. test、CI、package 与文档只提供 oracle / topology / design evidence，不能取代 production source 走读，也不能填充未执行的验证结果。
4. local sensitive artifacts 与 binary/generated output 的排除是安全边界，而非“未覆盖”；它们不得随审计被复制或纳入 Rust migration fixture。
