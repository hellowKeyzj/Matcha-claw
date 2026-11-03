;(() => {
  const stateKey = '__matchaTabClaimIndicator'
  if (globalThis[stateKey]) return

  const pingType = 'MATCHA_TAB_CLAIM_INDICATOR_PING'
  const updateType = 'MATCHA_TAB_CLAIM_INDICATOR_UPDATE'
  const marker = 'data-matcha-agent-claim-icon'
  const createdMarker = 'data-matcha-agent-claim-created'
  const originalHrefMarker = 'data-matcha-agent-claim-original-href'
  const faviconMarker = 'data-matcha-agent-claim-favicon="true"'
  const inactiveRel = 'apple-touch-icon'
  let pendingRelRestores = []

  function isClaimFavicon(href) {
    if (!href?.startsWith('data:image/svg+xml,')) return false
    try {
      return decodeURIComponent(href.slice('data:image/svg+xml,'.length)).includes(faviconMarker)
    } catch {
      return false
    }
  }

  function clearMetadata(link) {
    link.removeAttribute(marker)
    link.removeAttribute(createdMarker)
    link.removeAttribute(originalHrefMarker)
  }

  function flushPendingRelRestores() {
    const pending = pendingRelRestores
    pendingRelRestores = []
    for (const { link, originalRel } of pending) {
      if (isClaimFavicon(link.getAttribute('href'))) {
        link.remove()
      } else if (link.getAttribute('rel') === inactiveRel) {
        if (originalRel === null) link.removeAttribute('rel')
        else link.setAttribute('rel', originalRel)
      }
    }
  }

  function restore(refreshBrowser = false) {
    flushPendingRelRestores()
    for (const link of document.querySelectorAll(`link[${marker}]`)) {
      const shouldRestore = isClaimFavicon(link.getAttribute('href'))
      const created = link.hasAttribute(createdMarker)
      const originalHref = link.getAttribute(originalHrefMarker)
      if (refreshBrowser && shouldRestore) {
        pendingRelRestores.push({ link, originalRel: link.getAttribute('rel') })
        link.setAttribute('rel', inactiveRel)
      }
      clearMetadata(link)
      if (!shouldRestore) continue
      if (created) {
        if (!refreshBrowser) link.remove()
      } else if (originalHref === null) link.removeAttribute('href')
      else link.setAttribute('href', originalHref)
    }
    if (pendingRelRestores.length > 0) setTimeout(flushPendingRelRestores, 0)
  }

  function apply(favicon) {
    restore()
    let targets = [
      ...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"]'),
    ].map((link) => ({ link, created: false }))
    if (targets.length === 0) {
      const link = document.createElement('link')
      link.rel = 'icon'
      ;(document.head || document.documentElement).appendChild(link)
      targets = [{ link, created: true }]
    }

    for (const { link, created } of targets) {
      const originalHref = link.getAttribute('href')
      link.setAttribute(marker, '')
      if (created) link.setAttribute(createdMarker, '')
      if (originalHref !== null) link.setAttribute(originalHrefMarker, originalHref)
      link.href = favicon
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === pingType) {
      sendResponse({ ok: true })
      return false
    }
    if (
      message?.type !== updateType ||
      typeof message.claimed !== 'boolean' ||
      (message.claimed && typeof message.favicon !== 'string')
    ) {
      return false
    }

    if (message.claimed) apply(message.favicon)
    else restore(true)
    sendResponse({ ok: true })
    return false
  })

  globalThis[stateKey] = true
})()
