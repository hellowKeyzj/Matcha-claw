import { RelayState, getRelayDisplayState } from '../../lib/constants.js'
import {
  getRelayErrorMessage,
  matchesRelayErrorChange,
  readRelayError,
} from '../../lib/cdp/relay/error-state.js'
import { escapeHtml } from './security.js'
import { pageLanguage, relayText } from './relay-i18n.js'

const statusCard = document.getElementById('status-card')
const label = document.getElementById('label')
const toggle = document.getElementById('toggle')
const meta = document.getElementById('meta')
const tabsSection = document.getElementById('tabs-section')
const tabsHeader = document.getElementById('tabs-header')
const tabsList = document.getElementById('tabs-list')
const versionBadge = document.getElementById('version-badge')
const errorBanner = document.getElementById('error-banner')
const errorText = document.getElementById('error-text')
const browserSelect = document.getElementById('browser-select')

toggle.setAttribute('aria-label', relayText.toggle)
label.textContent = relayText.checking
tabsHeader.querySelector('span').textContent = relayText.tabs
tabsHeader.setAttribute('aria-label', relayText.tabs)
document.getElementById('settings-label').textContent = relayText.settings
browserSelect.textContent = relayText.useWindow

let transientError = ''
let currentPopupWindowId = null

try {
  versionBadge.textContent = 'v' + chrome.runtime.getManifest().version
} catch (_) {}

const STATE_LABELS = {
  [RelayState.DISABLED]: relayText.disabled,
  [RelayState.DISCONNECTED]: relayText.disconnected,
  [RelayState.CONNECTED]: relayText.connected,
}

const ARROW_SVG =
  '<svg class="tab-go" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 2.5l4 3.5-4 3.5"/></svg>'

function isWindowSelected(status, windowId) {
  return typeof status?.browserInstanceId === 'string'
    && status.selectedBrowserInstanceId === status.browserInstanceId
    && status.selectedWindowId === windowId
}

async function selectExecutionWindow(windowId) {
  transientError = ''
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'selectExecutionWindow',
      windowId,
    })
    if (!response?.ok) {
      transientError = relayText.selectFailed
    }
  } catch {
    transientError = relayText.selectFailed
  }
  await refresh()
}

function render(status) {
  const state = getRelayDisplayState(status)
  const selected = isWindowSelected(status, currentPopupWindowId)
  statusCard.dataset.state = state
  label.textContent = STATE_LABELS[state]
  browserSelect.dataset.selected = String(selected)
  browserSelect.textContent = selected ? relayText.usingWindow : relayText.useWindow

  if (!toggleBusy) {
    toggle.checked = state !== RelayState.DISABLED
  }

  meta.innerHTML = ''
  if (status?.attachedTabs > 0) {
    addChip(`${status.attachedTabs}`, status.attachedTabs === 1 ? relayText.tab : relayText.tabs, 'tabs')
  }
  if (status?.agentTabs > 0) {
    const nonRetained = status.agentTabs - (status.retainedTabs || 0)
    if (nonRetained > 0) addChip(`${nonRetained}`, relayText.agent, 'agent')
    if (status.retainedTabs > 0) addChip(`${status.retainedTabs}`, relayText.retained, 'retained')
  }
}

function addChip(num, text, kind) {
  const chip = document.createElement('span')
  chip.className = `chip chip-${kind}`
  chip.innerHTML = `<span class="chip-num">${escapeHtml(num)}</span> ${escapeHtml(text)}`
  meta.appendChild(chip)
}

function tabSortKey(t) {
  if (t.active) return -1
  if (t.isRetained) return 0
  if (t.isAgent) return 1
  return 2
}

function renderTabs(browserInstances, status) {
  const instance = browserInstances?.[0]
  const windows = instance?.windows || []
  windows.forEach((browserWindow) => browserWindow.tabs.sort((a, b) => tabSortKey(a) - tabSortKey(b)))
  const hasTabs = windows.some((browserWindow) => browserWindow.tabs.length > 0)
  tabsSection.dataset.empty = String(!hasTabs)

  if (!hasTabs) {
    tabsList.innerHTML = ''
    return
  }

  tabsList.innerHTML = ''
  windows.forEach((browserWindow) => {
    const header = document.createElement('div')
    header.className = 'tabs-header tabs-window-header'

    const title = document.createElement('span')
    title.textContent = browserWindow.windowId != null ? `${relayText.window} ${browserWindow.windowId}` : relayText.window
    header.appendChild(title)

    if (browserWindow.windowId != null) {
      const selected = isWindowSelected(status, browserWindow.windowId)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'window-select-button'
      button.dataset.selected = String(selected)
      button.textContent = selected ? relayText.usingWindow : relayText.useWindow
      button.addEventListener('click', async (event) => {
        event.stopPropagation()
        await selectExecutionWindow(browserWindow.windowId)
      })
      header.appendChild(button)
    }

    tabsList.appendChild(header)

    browserWindow.tabs.forEach((tab) => {
      const el = document.createElement('div')
      el.className = 'tab-item'
      el.setAttribute('role', 'button')
      el.tabIndex = 0
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        el.click()
      })
      el.addEventListener('click', async () => {
        transientError = ''

        if (tab.state === 'connected') {
          chrome.tabs.update(tab.tabId, { active: true })
          if (tab.windowId) chrome.windows.update(tab.windowId, { focused: true })
          window.close()
          return
        }

        try {
          const response = await chrome.runtime.sendMessage({
            type: 'attachTab',
            tabId: tab.tabId,
          })
          if (!response?.ok) {
            transientError = relayText.attachFailed
            await refresh()
            return
          }
          await refresh()
          window.close()
        } catch {
          transientError = relayText.attachFailed
          await refresh()
        }
      })

      const displayTitle = tab.title || tab.url || `${relayText.tab} ${tab.tabId}`
      const safeTitle = escapeHtml(displayTitle)
      const safeState = escapeHtml(tab.state || 'virtual')
      let badge = ''
      if (tab.active) {
        badge = `<span class="tab-badge tab-badge-agent">${escapeHtml(relayText.active)}</span>`
      } else if (tab.isAgent && !tab.isRetained) {
        badge = `<span class="tab-badge tab-badge-agent">${escapeHtml(relayText.agent)}</span>`
      } else if (tab.isRetained) {
        badge = `<span class="tab-badge tab-badge-retained">${escapeHtml(relayText.retained)}</span>`
      }

      el.innerHTML =
        `<span class="tab-dot" data-state="${safeState}"></span>` +
        `<span class="tab-title" title="${safeTitle}">${safeTitle}</span>` +
        badge +
        ARROW_SVG
      tabsList.appendChild(el)
    })
  })
}

tabsHeader.addEventListener('click', () => {
  const isOpen = tabsSection.dataset.open === 'true'
  tabsSection.dataset.open = String(!isOpen)
  tabsHeader.setAttribute('aria-expanded', String(!isOpen))
})
tabsHeader.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  tabsHeader.click()
})

browserSelect.addEventListener('click', async () => {
  if (currentPopupWindowId == null) return
  await selectExecutionWindow(currentPopupWindowId)
})

function renderError(errorKey, severity) {
  const message =
    getRelayErrorMessage(errorKey, severity, pageLanguage)
    || (typeof errorKey === 'string' && errorKey.trim() ? errorKey.trim() : '')
    || transientError

  if (message) {
    errorBanner.dataset.visible = 'true'
    errorText.textContent = message
  } else {
    errorBanner.dataset.visible = 'false'
    errorText.textContent = ''
  }
}

async function refresh() {
  try {
    const [status, browserResp, stored, currentWindow] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'getRelayStatus' }),
      chrome.runtime.sendMessage({ type: 'getBrowserInstanceList' }),
      readRelayError(),
      chrome.windows.getCurrent().catch(() => null),
    ])
    currentPopupWindowId = Number.isInteger(currentWindow?.id) ? currentWindow.id : null
    render(status)
    renderTabs(browserResp?.browserInstances, status)
    renderError(stored.code, stored.severity)
  } catch {
    currentPopupWindowId = null
    render(null)
    renderTabs([], null)
    renderError(null)
  }
}

let toggleBusy = false
toggle.addEventListener('change', async () => {
  if (toggleBusy) return
  toggleBusy = true
  try {
    const response = await chrome.runtime.sendMessage({ type: 'toggleRelay' })
    transientError = response?.error ? relayText.toggleFailed : ''
    await refresh()
  } catch {
    transientError = relayText.toggleFailed
    await refresh()
  } finally {
    toggleBusy = false
  }
})

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
  window.close()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === 'local' &&
    ('relayEnabled' in changes || '_relayState' in changes || matchesRelayErrorChange(changes))
  ) {
    void refresh()
  }
})

void refresh()
setInterval(() => void refresh(), 1000)
