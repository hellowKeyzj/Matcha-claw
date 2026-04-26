const STORAGE_KEYS = Object.freeze({
  BROWSER_INSTANCE_ID: 'browserInstanceId',
})

export async function getBrowserInstanceId() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.BROWSER_INSTANCE_ID])
  const existing = typeof stored[STORAGE_KEYS.BROWSER_INSTANCE_ID] === 'string'
    ? stored[STORAGE_KEYS.BROWSER_INSTANCE_ID].trim()
    : ''
  if (existing) return existing

  const generated = self.crypto?.randomUUID?.() || `browser-${Date.now()}-${Math.random().toString(16).slice(2)}`
  await chrome.storage.local.set({ [STORAGE_KEYS.BROWSER_INSTANCE_ID]: generated })
  return generated
}
