/**
 * Shared constants for the MatchaClaw Browser Relay extension.
 */

import { getRelayText } from '../pages/scripts/relay-i18n.js'

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

export function getRelayDisplayState(status) {
  if (!status || status.state === RelayState.DISABLED) return RelayState.DISABLED
  return status.connected === true && status.handshakeReady === true
    ? RelayState.CONNECTED
    : RelayState.DISCONNECTED
}

const text = getRelayText()
export const STATE_UI = {
  [RelayState.DISABLED]:     { dotColor: null,      title: `MatchaClaw Browser Relay — ${text.disabled}` },
  [RelayState.DISCONNECTED]: { dotColor: '#F59E0B', title: `MatchaClaw Browser Relay — ${text.disconnected}` },
  [RelayState.CONNECTED]:    { dotColor: '#22C55E', title: `MatchaClaw Browser Relay — ${text.connected}` },
}

export const STATE_TEXT = {
  [RelayState.DISABLED]:     { label: text.disabled, detail: text.disabledDetail },
  [RelayState.DISCONNECTED]: { label: text.disconnected, detail: text.disconnectedDetail },
  [RelayState.CONNECTED]:    { label: text.connected, detail: text.connectedDetail },
}

// ── Settings keys ──

export const SETTINGS_KEYS = Object.freeze({
  CLOSE_GROUP_ON_DISABLE: 'closeGroupOnDisable',
})

export async function getSetting(key, defaultValue = false) {
  const stored = await chrome.storage.local.get([key])
  return stored[key] ?? defaultValue
}

export async function setSetting(key, value) {
  await chrome.storage.local.set({ [key]: value })
}
