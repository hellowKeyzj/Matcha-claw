const STORAGE_KEYS = Object.freeze({
  BROWSER_INSTANCE_ID: 'browserInstanceId',
})

let instancePromise

export function getBrowserInstanceId() {
  instancePromise ??= (async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.BROWSER_INSTANCE_ID])
    const existing = typeof stored[STORAGE_KEYS.BROWSER_INSTANCE_ID] === 'string'
      ? stored[STORAGE_KEYS.BROWSER_INSTANCE_ID].trim()
      : ''
    if (existing) return existing

    const generated = self.crypto.randomUUID()
    await chrome.storage.local.set({ [STORAGE_KEYS.BROWSER_INSTANCE_ID]: generated })
    return generated
  })().catch((error) => {
    instancePromise = undefined
    throw error
  })
  return instancePromise
}
