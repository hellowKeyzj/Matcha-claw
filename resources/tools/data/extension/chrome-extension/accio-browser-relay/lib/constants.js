/**
 * Shared constants for the MatchaClaw Browser Relay extension.
 */

export const DEFAULT_CONTROL_PORT = 9234
export const RELAY_PORT_OFFSET = 2

const MAX_CONTROL_PORT = 65535 - RELAY_PORT_OFFSET

export function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CONTROL_PORT) return DEFAULT_CONTROL_PORT
  return n
}

export function computeRelayPort(controlPort) {
  return clampPort(controlPort) + RELAY_PORT_OFFSET
}

export const RelayState = Object.freeze({
  DISABLED: 'disabled',
  DISCONNECTED: 'disconnected',
  CONNECTED: 'connected',
})

export const TabType = Object.freeze({
  USER: 'user',
  AGENT: 'agent',
  RETAINED: 'retained',
})

export const STATE_UI = {
  [RelayState.DISABLED]:     { dotColor: null,      title: 'MatchaClaw Browser Relay — disabled' },
  [RelayState.DISCONNECTED]: { dotColor: '#F59E0B', title: 'MatchaClaw Browser Relay — connecting…' },
  [RelayState.CONNECTED]:    { dotColor: '#22C55E', title: 'MatchaClaw Browser Relay — connected' },
}

export const STATE_TEXT = {
  [RelayState.DISABLED]:     { label: 'Not Enabled', detail: 'Click the toggle or toolbar icon to enable.' },
  [RelayState.DISCONNECTED]: { label: 'Connecting…', detail: 'Relay is enabled. Trying to connect…' },
  [RelayState.CONNECTED]:    { label: 'Connected',   detail: 'Relay is active — agent can control your browser.' },
}
