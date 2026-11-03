import { RELAY_PORT_OFFSET, clampPort, computeRelayPort } from '../../lib/constants.js'
import { relayText } from './relay-i18n.js'

// ── DOM refs ──

const portInput = document.getElementById('port')
const portStatus = document.getElementById('port-status')
const versionBadge = document.getElementById('version-badge')

document.querySelectorAll('[data-i18n]').forEach((element) => {
  element.textContent = relayText[element.dataset.i18n]
})
portInput.setAttribute('aria-label', relayText.controlPort)

try {
  versionBadge.textContent = 'v' + chrome.runtime.getManifest().version
} catch (_) {}

// ── Port settings ──

function setPortStatus(kind, message) {
  portStatus.dataset.kind = kind || ''
  portStatus.textContent = message || ''
}

async function checkPort(controlPort) {
  const port = computeRelayPort(controlPort)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(900) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setPortStatus('ok', relayText.portReachable.replace('{port}', String(port)))
  } catch {
    setPortStatus('error', relayText.portUnreachable.replace('{port}', String(port)))
  }
}

async function loadPort() {
  const stored = await chrome.storage.local.get(['controlPort', 'relayPort'])
  const fromRelay =
    stored.relayPort != null
      ? Number.parseInt(String(stored.relayPort), 10) - RELAY_PORT_OFFSET
      : undefined
  const port = clampPort(Number.isFinite(fromRelay) ? fromRelay : stored.controlPort)
  portInput.value = String(port)
}

async function savePort() {
  const port = clampPort(portInput.value)
  await chrome.storage.local.set({ controlPort: port })
  portInput.value = String(port)
  await checkPort(port)
}

document.getElementById('save').addEventListener('click', () => void savePort())

// ── Logs viewer ──

const logsContainer = document.getElementById('logs-container')
const logsRefresh = document.getElementById('logs-refresh')

function formatTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function refreshLogs() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getLogs', limit: 100 })
    const logs = resp?.logs || []
    if (logs.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'logs-empty'
      empty.textContent = relayText.noLogs
      logsContainer.replaceChildren(empty)
      return
    }
    logsContainer.innerHTML = ''
    for (const entry of logs) {
      const row = document.createElement('div')
      row.className = 'log-row'

      const time = document.createElement('span')
      time.className = 'log-time'
      time.textContent = formatTime(entry.ts)

      const dir = document.createElement('span')
      dir.className = 'log-dir'
      dir.dataset.dir = entry.dir
      dir.textContent = entry.dir

      const method = document.createElement('span')
      method.className = 'log-method'
      method.textContent = entry.method || ''

      const detail = document.createElement('span')
      detail.className = 'log-detail'
      detail.textContent = entry.detail || ''

      row.append(time, dir, method, detail)
      logsContainer.appendChild(row)
    }
    logsContainer.scrollTop = logsContainer.scrollHeight
  } catch { /* background not ready */ }
}

logsRefresh.addEventListener('click', () => void refreshLogs())

// ── Init ──

void loadPort()
void refreshLogs()
