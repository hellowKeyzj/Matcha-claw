import { EXIT_REASONS, HOOK_EVENTS } from './sdk/coreSchemas.js'

export type {
  SDKControlRequest,
  SDKControlResponse,
} from './sdk/controlTypes.js'
export * from './sdk/coreTypes.js'
export * from './sdk/runtimeTypes.js'
export type { Settings } from './sdk/settingsTypes.generated.js'
export * from './sdk/toolTypes.js'

export { tool, createSdkMcpServer } from './sdk/sdkMcp.js'
export { AbortError, query, unstable_v2_prompt } from './sdk/query.js'
export {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from './sdk/v2Session.js'
export {
  getSessionMessages,
  getSessionInfo,
  listSessions,
  renameSession,
  tagSession,
} from './sdk/session.js'
export { forkSession } from './sdk/sessionFork.js'
export {
  buildMissedTaskNotification,
  watchScheduledTasks,
  type CronJitterConfig,
  type CronTask,
  type ScheduledTaskEvent,
  type ScheduledTasksHandle,
} from './sdk/scheduledTasks.js'
export {
  connectRemoteControl,
  type ConnectRemoteControlOptions,
  type InboundPrompt,
  type RemoteControlHandle,
} from './sdk/remoteControl.js'

export { HOOK_EVENTS, EXIT_REASONS }
export type HookEvent = (typeof HOOK_EVENTS)[number]
export type ExitReason = (typeof EXIT_REASONS)[number]
