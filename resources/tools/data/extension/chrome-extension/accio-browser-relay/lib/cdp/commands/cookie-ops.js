function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeCookieInput(cookie) {
  if (!cookie || typeof cookie !== 'object') return null
  const name = asNonEmptyString(cookie.name)
  const value = typeof cookie.value === 'string' ? cookie.value : null
  if (!name || value === null) return null

  return {
    name,
    value,
    url: asNonEmptyString(cookie.url),
    domain: asNonEmptyString(cookie.domain),
    path: asNonEmptyString(cookie.path),
  }
}

function normalizeCookieResult(cookie) {
  if (!cookie || typeof cookie !== 'object') return null
  return {
    name: typeof cookie.name === 'string' ? cookie.name : '',
    value: typeof cookie.value === 'string' ? cookie.value : '',
    domain: typeof cookie.domain === 'string' ? cookie.domain : undefined,
    path: typeof cookie.path === 'string' ? cookie.path : undefined,
    expires: typeof cookie.expirationDate === 'number' ? cookie.expirationDate : undefined,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: typeof cookie.sameSite === 'string' ? cookie.sameSite : undefined,
    session: cookie.session === true,
  }
}

function resolveCookieCapableUrl(tab) {
  if (!tab?.url) return null
  try {
    const url = new URL(tab.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function buildCookieRemovalUrl(cookie, pageUrl) {
  const fallbackHost = pageUrl.hostname
  const cookieDomain = typeof cookie.domain === 'string'
    ? cookie.domain.replace(/^\./, '').trim()
    : ''
  const host = cookieDomain && fallbackHost.endsWith(cookieDomain) ? fallbackHost : cookieDomain || fallbackHost
  const protocol = cookie.secure === true
    ? 'https:'
    : pageUrl.protocol === 'http:' || pageUrl.protocol === 'https:'
      ? pageUrl.protocol
      : 'https:'
  const path = typeof cookie.path === 'string' && cookie.path ? cookie.path : '/'
  return `${protocol}//${host}${path}`
}

async function getCookiePageUrl(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  return resolveCookieCapableUrl(tab)
}

export async function extGetCookies(tabId) {
  const pageUrl = await getCookiePageUrl(tabId)
  if (!pageUrl) return []

  const cookies = await chrome.cookies.getAll({ url: pageUrl.toString() })
  return cookies.map(normalizeCookieResult).filter(Boolean)
}

export async function extSetCookies(tabId, params) {
  const pageUrl = await getCookiePageUrl(tabId)
  const cookies = Array.isArray(params?.cookies)
    ? params.cookies.map(normalizeCookieInput).filter(Boolean)
    : []

  if (!cookies.length) {
    throw new Error('cookies are required for Extension.setCookies')
  }

  for (const cookie of cookies) {
    const url = cookie.url ?? pageUrl?.toString() ?? null
    if (!url) {
      throw new Error('A cookie url is required when the current page has no cookie-capable URL.')
    }
    await chrome.cookies.set({
      name: cookie.name,
      value: cookie.value,
      url,
      domain: cookie.domain || undefined,
      path: cookie.path || undefined,
    })
  }

  return { ok: true }
}

export async function extClearCookies(tabId) {
  const pageUrl = await getCookiePageUrl(tabId)
  if (!pageUrl) {
    return { ok: true }
  }

  const cookies = await chrome.cookies.getAll({ url: pageUrl.toString() })
  for (const cookie of cookies) {
    if (!cookie?.name) continue
    await chrome.cookies.remove({
      url: buildCookieRemovalUrl(cookie, pageUrl),
      name: cookie.name,
      storeId: typeof cookie.storeId === 'string' ? cookie.storeId : undefined,
    })
  }

  return { ok: true }
}
