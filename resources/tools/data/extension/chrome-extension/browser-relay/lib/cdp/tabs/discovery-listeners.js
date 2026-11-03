/** Register virtual tabs before load completion; discovery never attaches or claims them. */
export function registerTabDiscoveryListeners(tabs, manager, isConnected, options = {}) {
  const schedule = options.schedule ?? ((task) => task())

  tabs.onCreated.addListener((tab) => {
    schedule(() => {
      if (!isConnected() || !Number.isInteger(tab.id)) return
      // pendingUrl is intent, not committed navigation evidence. Wait for onUpdated
      // if Chrome has not exposed the actual URL yet.
      manager.discover(tab.id, tab.url, tab.title, { windowId: tab.windowId, active: tab.active })
    })
  })
  tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    schedule(() => {
      if (!isConnected()) return
      const shouldDiscover = options.onUpdated?.(tabId, changeInfo, tab) !== false
      // Loading pages can take arbitrarily long to reach complete. Register on the
      // first observable URL instead, including about:blank popups; TabManager
      // retains scheme filtering and the user's cancelled-tab exclusion.
      const metadata = { windowId: tab.windowId, active: tab.active }
      if (shouldDiscover) manager.discover(tabId, tab.url, tab.title, metadata)
      const currentUrl = changeInfo.url ?? tab?.url
      const currentTitle = changeInfo.title ?? tab?.title
      if (manager.has(tabId)) {
        manager.updateTab(tabId, currentUrl, currentTitle, metadata)
      }
    })
  })
}
