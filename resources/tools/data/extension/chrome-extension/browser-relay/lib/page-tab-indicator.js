import {
  CommandDeadlineExceededError,
  awaitWithDeadline,
} from './cdp/commands/deadline.js'

const PING_TYPE = 'MATCHA_TAB_CLAIM_INDICATOR_PING'
const UPDATE_TYPE = 'MATCHA_TAB_CLAIM_INDICATOR_UPDATE'
const CONTENT_SCRIPT = 'lib/content_script/tab-claim-indicator.js'
const FAVICON_MARKER = 'data-matcha-agent-claim-favicon="true"'
const CURSOR_PATH =
  'M3.04536 4.45259C2.7582 3.60299 3.60299 2.7582 4.45259 3.04536L14.1828 6.33403C15.1637 6.66558 15.0872 8.08006 14.0715 8.39045L10.2994 9.54319C9.93919 9.65327 9.65327 9.93919 9.54319 10.2994L8.39046 14.0715C8.08007 15.0872 6.66558 15.1637 6.33404 14.1828L3.04536 4.45259Z'
const MAX_FAVICON_BYTES = 64 * 1024
const faviconDataUrls = new Map()
const indicatorUpdates = new Map()

async function awaitOperation(commandContext, stage, operation) {
  if (!commandContext) return operation()
  if (!stage.startsWith('chrome.')) return awaitWithDeadline(commandContext, stage, operation)
  await awaitWithDeadline(commandContext, stage, () => undefined)
  const pending = Promise.resolve(operation())
  commandContext.trackNativeOperation?.(pending)
  // Only the caller wait expires; the per-tab fence follows raw native settlement.
  const result = await pending
  await awaitWithDeadline(commandContext, stage, () => undefined)
  return result
}

async function ping(tabId, commandContext) {
  try {
    const response = await awaitOperation(
      commandContext,
      'chrome.tabs.sendMessage:claimIndicatorPing',
      () => chrome.tabs.sendMessage(tabId, { type: PING_TYPE }),
    )
    return response?.ok === true
  } catch (err) {
    if (err instanceof CommandDeadlineExceededError) throw err
    return false
  }
}

async function ensureContentScript(tabId, commandContext) {
  if (await ping(tabId, commandContext)) return

  await awaitOperation(
    commandContext,
    'chrome.scripting.executeScript:claimIndicator',
    () => chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT],
      injectImmediately: true,
    }),
  )
  if (!(await ping(tabId, commandContext))) {
    throw new Error(`Claim indicator unavailable for tab ${tabId}`)
  }
}

function escapeSvgAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

async function toDataUrl(blob, commandContext) {
  const buffer = await awaitOperation(
    commandContext,
    'blob.arrayBuffer:claimFavicon',
    () => blob.arrayBuffer(),
  )
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
  }
  return `data:${blob.type || 'image/bmp'};base64,${btoa(binary)}`
}

async function readPageFavicon(pageUrl, commandContext) {
  const url = new URL(chrome.runtime.getURL('/_favicon/'))
  url.searchParams.set('pageUrl', pageUrl)
  url.searchParams.set('size', '32')
  const response = await awaitOperation(
    commandContext,
    'fetch:claimFavicon',
    () => fetch(url.toString(), { credentials: 'omit' }),
  )
  if (!response.ok) throw new Error(`Failed to load page favicon: HTTP ${response.status}`)
  const blob = await awaitOperation(
    commandContext,
    'response.blob:claimFavicon',
    () => response.blob(),
  )
  if (!blob.type.startsWith('image/') || blob.size > MAX_FAVICON_BYTES) {
    throw new Error('Invalid page favicon response')
  }
  return toDataUrl(blob, commandContext)
}

async function loadPageFavicon(tabId, commandContext) {
  const tab = await awaitOperation(
    commandContext,
    'chrome.tabs.get:claimFaviconSource',
    () => chrome.tabs.get(tabId),
  )
  if (!tab.url || !tab.favIconUrl || isAgentClaimFavicon(tab.favIconUrl)) return null

  const cached = faviconDataUrls.get(tabId)
  if (cached?.pageUrl === tab.url) return cached.dataUrl

  const pageUrl = tab.url
  const favIconUrl = tab.favIconUrl
  const dataUrl = await readPageFavicon(pageUrl, commandContext)
  const current = await awaitOperation(
    commandContext,
    'chrome.tabs.get:claimFaviconVerify',
    () => chrome.tabs.get(tabId),
  )
  if (current.url !== pageUrl || current.favIconUrl !== favIconUrl) return null
  faviconDataUrls.set(tabId, { pageUrl, dataUrl })
  return dataUrl
}

function createClaimFavicon(source) {
  const sourceImage = source
    ? `<image href="${escapeSvgAttribute(source)}" width="32" height="32" opacity="0.3"/>`
    : ''
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" ${FAVICON_MARKER} viewBox="0 0 32 32">
  ${sourceImage}
  <path d="${CURSOR_PATH}" fill="black" stroke="white" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke fill" transform="translate(-2 -2) scale(2.1)"/>
</svg>
`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function isAgentClaimFavicon(url) {
  if (!url?.startsWith('data:image/svg+xml,')) return false
  try {
    return decodeURIComponent(url.slice('data:image/svg+xml,'.length)).includes(FAVICON_MARKER)
  } catch {
    return false
  }
}

export function clearAgentClaimFaviconCache(tabId) {
  faviconDataUrls.delete(tabId)
}

export async function setAgentClaimTabIndicator(tabId, claimed, commandContext) {
  const context = commandContext
  const update = (indicatorUpdates.get(tabId) ?? Promise.resolve()).then(async () => {
    const source = claimed ? await loadPageFavicon(tabId, context) : null
    const favicon = claimed ? createClaimFavicon(source) : null
    if (!claimed) clearAgentClaimFaviconCache(tabId)
    await ensureContentScript(tabId, context)
    const response = await awaitOperation(
      context,
      'chrome.tabs.sendMessage:claimIndicatorUpdate',
      () => chrome.tabs.sendMessage(tabId, {
        type: UPDATE_TYPE,
        claimed,
        favicon,
      }),
    )
    if (response?.ok !== true) {
      throw new Error(response?.error || `Claim indicator rejected update for tab ${tabId}`)
    }
  })
  const settled = update.catch(() => {}).finally(() => {
    if (indicatorUpdates.get(tabId) === settled) indicatorUpdates.delete(tabId)
  })
  indicatorUpdates.set(tabId, settled)
  if (context) await awaitWithDeadline(context, 'claim_indicator.update', () => update)
  else await update
}
