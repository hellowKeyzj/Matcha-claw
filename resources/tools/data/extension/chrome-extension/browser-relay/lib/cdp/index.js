/**
 * CDP channel — Chrome DevTools Protocol relay infrastructure.
 *
 *   relay/              — WebSocket connection & state machine
 *   tabs/               — Tab lifecycle, discovery, idle detection, tab groups
 *   commands/           — CDP command routing & Target.* handlers
 *   events/             — CDP event interception (dialogs, security, page lifecycle)
 */

export { TabManager } from './tabs/manager.js'
export { createDispatcher } from './commands/dispatch.js'
export { createTabCommandScheduler } from './commands/tab-command-scheduler.js'
export {
  initRelay,
  trySendToRelay,
  isRelayConnected,
  isRelayActive,
  isRelayEnabled,
  isReconnecting,
  getRelayConnectionSnapshot,
  getRelayState,
  toggle,
  disconnect,
  connectAndAttach,
  reconnectNow,
  bootstrapRelayConnection,
  initFromStorage,
  setRelayEnabled,
  getLogBuffer,
  ensureKeepAliveAlarm,
  handleConnectionAlarm,
  hasPendingReconnectAlarm,
} from './relay/connection.js'
