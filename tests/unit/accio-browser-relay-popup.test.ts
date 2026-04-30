// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'

function buildPopupDom() {
  document.body.innerHTML = `
    <div id="status-card"></div>
    <div id="label"></div>
    <input id="toggle" type="checkbox" />
    <div id="meta"></div>
    <div id="tabs-section" data-empty="true" data-open="false"></div>
    <div id="tabs-header"></div>
    <div id="tabs-list"></div>
    <div id="version-badge"></div>
    <div id="error-banner" data-visible="false"></div>
    <div id="error-text"></div>
    <button id="browser-select"></button>
    <button id="open-settings"></button>
  `
}

async function flushUi() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('accio browser relay popup', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    buildPopupDom()
    Object.assign(window, { close: vi.fn() })
    vi.stubGlobal('setInterval', vi.fn(() => 1))
  })

  it('highlights only the selected window within the same browser profile', async () => {
    let selectedWindowId = 2

    Object.assign(globalThis, {
      chrome: {
        runtime: {
          getManifest: vi.fn(() => ({ version: '0.0.0-test' })),
          openOptionsPage: vi.fn(),
          sendMessage: vi.fn(async (payload: { type: string; windowId?: number }) => {
            if (payload.type === 'getRelayStatus') {
              return {
                state: 'connected',
                connected: true,
                active: true,
                reconnecting: false,
                attachedTabs: 2,
                agentTabs: 0,
                retainedTabs: 0,
                browserInstanceId: 'browser-a',
                selectedBrowserInstanceId: 'browser-a',
                selectedWindowId,
              }
            }
            if (payload.type === 'getBrowserInstanceList') {
              return {
                browserInstances: [{
                  browserInstanceId: 'browser-a',
                  selected: true,
                  windows: [
                    {
                      windowId: 1,
                      active: true,
                      selected: selectedWindowId === 1,
                      tabs: [{ tabId: 11, state: 'connected', title: 'Page A', url: 'https://a.example.com', active: true, windowId: 1 }],
                    },
                    {
                      windowId: 2,
                      active: false,
                      selected: selectedWindowId === 2,
                      tabs: [{ tabId: 22, state: 'connected', title: 'Page B', url: 'https://b.example.com', active: true, windowId: 2 }],
                    },
                  ],
                }],
                selectedBrowserInstanceId: 'browser-a',
                selectedWindowId,
              }
            }
            if (payload.type === 'selectExecutionWindow') {
              selectedWindowId = payload.windowId ?? selectedWindowId
              return { ok: true, selectedBrowserInstanceId: 'browser-a', selectedWindowId }
            }
            throw new Error(`unexpected message type: ${payload.type}`)
          }),
        },
        windows: {
          getCurrent: vi.fn(async () => ({ id: 2 })),
          update: vi.fn(async () => {}),
        },
        tabs: {
          update: vi.fn(async () => {}),
        },
        storage: {
          local: {
            get: vi.fn(async () => ({})),
          },
          onChanged: {
            addListener: vi.fn(),
          },
        },
      },
    })

    await import('../../resources/tools/data/extension/chrome-extension/browser-relay/pages/scripts/popup.js')
    await flushUi()

    const windowButtons = [...document.querySelectorAll<HTMLButtonElement>('.window-select-button')]
    expect(windowButtons.map((entry) => entry.textContent?.trim())).toEqual([
      'Use This Window',
      'Using This Window',
    ])
    expect(document.querySelectorAll('.window-select-button[data-selected="true"]')).toHaveLength(1)

    await windowButtons[0].click()
    await flushUi()

    const updatedButtons = [...document.querySelectorAll<HTMLButtonElement>('.window-select-button')]
    expect(updatedButtons.map((entry) => entry.textContent?.trim())).toEqual([
      'Using This Window',
      'Use This Window',
    ])
    expect(document.querySelectorAll('.window-select-button[data-selected="true"]')).toHaveLength(1)
  })
})
