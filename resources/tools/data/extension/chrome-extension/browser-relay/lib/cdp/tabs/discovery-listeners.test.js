import { describe, expect, test } from 'bun:test'
import { registerTabDiscoveryListeners } from './discovery-listeners.js'

function setup() {
  const listeners = {}
  const records = new Map()
  const calls = []
  let connected = true
  const tabs = Object.fromEntries(['onCreated', 'onUpdated'].map(name => [name, {
    addListener(fn) { listeners[name] = fn },
  }]))
  const manager = {
    discover(id, url, title) {
      calls.push({ id, url, title })
      if (!records.has(id) && /^(https?:|file:|about:blank$)/.test(url ?? '')) records.set(id, { url, title })
    },
    has(id) { return records.has(id) },
    updateTab(id, url, title) {
      const record = records.get(id)
      if (url !== undefined) record.url = url
      if (title !== undefined) record.title = title
    },
  }
  registerTabDiscoveryListeners(tabs, manager, () => connected)
  return { listeners, records, calls, disconnect() { connected = false } }
}

describe('early popup discovery', () => {
  test('registers created loading pages without waiting for complete', () => {
    const { listeners, records } = setup()
    listeners.onCreated({ id: 12, url: 'https://example.com/result', status: 'loading' })
    expect(records.get(12)?.url).toBe('https://example.com/result')
  })
  test('discovers the first committed URL when creation had only pendingUrl', () => {
    const { listeners, records } = setup()
    listeners.onCreated({ id: 12, pendingUrl: 'https://example.com/intent' })
    expect(records.size).toBe(0)
    listeners.onUpdated(12, { url: 'https://example.com/result', status: 'loading' }, { url: 'https://example.com/result' })
    expect(records.get(12)?.url).toBe('https://example.com/result')
  })
  test('blank popup becomes its real URL and empty title is preserved', () => {
    const { listeners, records } = setup()
    listeners.onCreated({ id: 12, url: 'about:blank', title: 'Blank' })
    listeners.onUpdated(12, { url: 'https://example.com/result', title: '' }, { url: 'https://example.com/result', title: '' })
    expect(records.get(12)).toEqual({ url: 'https://example.com/result', title: '' })
    expect(records.size).toBe(1)
  })
  test('disconnected events and invalid tab IDs do not register', () => {
    const s = setup()
    s.listeners.onCreated({ url: 'https://example.com' })
    s.disconnect()
    s.listeners.onCreated({ id: 12, url: 'https://example.com' })
    s.listeners.onUpdated(12, { status: 'complete' }, { url: 'https://example.com' })
    expect(s.calls).toEqual([])
  })
})
