import { RelayState } from '../../lib/constants.js'

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

const ERROR_MESSAGES = {
  encryption_unsupported:
    'Desktop app does not support encrypted transport. Please update the desktop app to the latest version.',
}
let transientError = ''
let currentPopupWindowId = null

try {
  versionBadge.textContent = 'v' + chrome.runtime.getManifest().version
} catch (_) {}

const STATE_LABELS = {
  [RelayState.DISABLED]: 'Offline',
  [RelayState.DISCONNECTED]: 'Connecting…',
  [RelayState.CONNECTED]: 'Connected',
}

const ARROW_SVG =
  '<svg class="tab-go" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.5 2.5l4 3.5-4 3.5"/></svg>'

function escapeHtml(str) {
  const div = document.createElement('div')
  div.appendChild(document.createTextNode(str))
  return div.innerHTML
}

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
      transientError = response?.error || `select window failed: ${windowId}`
    }
  } catch (error) {
    transientError = error?.message || String(error)
  }
  await refresh()
}

function render(status) {
  const state = status?.state || RelayState.DISABLED
  const selected = isWindowSelected(status, currentPopupWindowId)
  statusCard.dataset.state = state
  label.textContent = STATE_LABELS[state] || 'Unknown'
  browserSelect.dataset.selected = String(selected)
  browserSelect.textContent = selected ? 'Using This Window' : 'Use This Window'

  if (!toggleBusy) {
    toggle.checked = state !== RelayState.DISABLED
  }

  meta.innerHTML = ''
  if (status?.attachedTabs > 0) {
    addChip(`${status.attachedTabs}`, status.attachedTabs === 1 ? 'tab' : 'tabs', 'tabs')
  }
  if (status?.agentTabs > 0) {
    const nonRetained = status.agentTabs - (status.retainedTabs || 0)
    if (nonRetained > 0) addChip(`${nonRetained}`, 'agent', 'agent')
    if (status.retainedTabs > 0) addChip(`${status.retainedTabs}`, 'retained', 'retained')
  }
}

function addChip(num, text, kind) {
  const chip = document.createElement('span')
  chip.className = `chip chip-${kind}`
  chip.innerHTML = `<span class="chip-num">${num}</span> ${text}`
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
  windows.forEach((window) => window.tabs.sort((a, b) => tabSortKey(a) - tabSortKey(b)))
  const hasTabs = windows.some((window) => window.tabs.length > 0)
  tabsSection.dataset.empty = String(!hasTabs)

  if (!hasTabs) {
    tabsList.innerHTML = ''
    return
  }

  tabsList.innerHTML = ''
  windows.forEach((window) => {
    const header = document.createElement('div')
    header.className = 'tabs-header tabs-window-header'

    const title = document.createElement('span')
    title.textContent = window.windowId != null ? `Window ${window.windowId}` : 'Window'
    header.appendChild(title)

    if (window.windowId != null) {
      const selected = isWindowSelected(status, window.windowId)
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'window-select-button'
      button.dataset.selected = String(selected)
      button.textContent = selected ? 'Using This Window' : 'Use This Window'
      button.addEventListener('click', async (event) => {
        event.stopPropagation()
        await selectExecutionWindow(window.windowId)
      })
      header.appendChild(button)
    }

    tabsList.appendChild(header)

    window.tabs.forEach((tab) => {
      const el = document.createElement('div')
      el.className = 'tab-item'
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
            transientError = response?.error || `attach failed for tab ${tab.tabId}`
            await refresh()
            return
          }
          await refresh()
          window.close()
        } catch (error) {
          transientError = error?.message || String(error)
          await refresh()
        }
      })

      const displayTitle = tab.title || tab.url || `Tab ${tab.tabId}`
      const safeTitle = escapeHtml(displayTitle)
      const safeState = escapeHtml(tab.state || 'virtual')
      let badge = ''
      if (tab.active) {
        badge = '<span class="tab-badge tab-badge-agent">active</span>'
      } else if (tab.isAgent && !tab.isRetained) {
        badge = '<span class="tab-badge tab-badge-agent">agent</span>'
      } else if (tab.isRetained) {
        badge = '<span class="tab-badge tab-badge-retained">retained</span>'
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
})

browserSelect.addEventListener('click', async () => {
  if (currentPopupWindowId == null) return
  await selectExecutionWindow(currentPopupWindowId)
})

function renderError(errorKey) {
  const message =
    (errorKey && ERROR_MESSAGES[errorKey])
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
      chrome.storage.local.get(['_relayError']),
      chrome.windows.getCurrent().catch(() => null),
    ])
    currentPopupWindowId = Number.isInteger(currentWindow?.id) ? currentWindow.id : null
    render(status)
    renderTabs(browserResp?.browserInstances, status)
    renderError(stored._relayError)
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
    await chrome.runtime.sendMessage({ type: 'toggleRelay' })
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
    ('relayEnabled' in changes || '_relayState' in changes || '_relayError' in changes)
  ) {
    void refresh()
  }
})

void refresh()
setInterval(() => void refresh(), 1000)
