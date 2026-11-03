import { afterEach, describe, expect, test } from 'bun:test'

import { createCommandContext } from '../commands/deadline.js'
import { AgentGroupManager } from './agent-group.js'

const originalChrome = globalThis.chrome

afterEach(() => {
  globalThis.chrome = originalChrome
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function deadlineContext(requestId, timeoutMs) {
  const sentAt = Date.now()
  return createCommandContext({
    requestId,
    method: 'Target.createTarget',
    sentAt,
    deadlineAt: sentAt + timeoutMs,
  })
}

describe('AgentGroupManager deadline queue', () => {
  test('releases the queue when chrome.tabs.group exceeds the command deadline', async () => {
    let groupCalls = 0
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => ({ id }),
        update: async () => {},
      },
      tabs: {
        group: () => {
          groupCalls++
          return groupCalls === 1 ? new Promise(() => {}) : Promise.resolve(2)
        },
      },
    }
    const manager = new AgentGroupManager()

    await expect(manager.addTab(1, deadlineContext(1, 20))).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabs.group',
    })
    await expect(manager.addTab(2, deadlineContext(2, 1_000))).resolves.toBeUndefined()
    expect(groupCalls).toBe(2)
    expect(manager.groupId).toBe(2)
  })

  test('repairs a candidate after metadata update times out without creating a second group', async () => {
    const groupInputs = []
    let updateCalls = 0
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => ({ id }),
        update: () => {
          updateCalls++
          return updateCalls === 1 ? new Promise(() => {}) : Promise.resolve()
        },
      },
      tabs: {
        group: async (input) => {
          groupInputs.push(input)
          return input.groupId ?? 7
        },
      },
    }
    const manager = new AgentGroupManager()

    await expect(manager.addTab(1, deadlineContext(7, 20))).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabGroups.update',
    })
    expect(manager.groupId).toBeNull()

    await expect(manager.addTab(2, deadlineContext(8, 1_000))).resolves.toBeUndefined()
    expect(groupInputs).toEqual([
      { tabIds: [1] },
      { tabIds: [2], groupId: 7 },
    ])
    expect(updateCalls).toBe(2)
    expect(manager.groupId).toBe(7)
  })

  test('drops a missing candidate and creates a replacement group', async () => {
    const groupInputs = []
    let updateCalls = 0
    let candidateExists = true
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => {
          if (id === 7 && !candidateExists) throw new Error('No group')
          return { id }
        },
        update: () => {
          updateCalls++
          return updateCalls === 1 ? new Promise(() => {}) : Promise.resolve()
        },
      },
      tabs: {
        group: async (input) => {
          groupInputs.push(input)
          return groupInputs.length === 1 ? 7 : 8
        },
      },
    }
    const manager = new AgentGroupManager()

    await expect(manager.addTab(1, deadlineContext(9, 20))).rejects.toMatchObject({
      stage: 'chrome.tabGroups.update',
    })
    candidateExists = false
    await expect(manager.addTab(2, deadlineContext(10, 1_000))).resolves.toBeUndefined()

    expect(groupInputs).toEqual([{ tabIds: [1] }, { tabIds: [2] }])
    expect(manager.groupId).toBe(8)
  })

  test('dissolve cleans a candidate whose metadata never initialized', async () => {
    const removed = []
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => ({ id }),
        update: () => new Promise(() => {}),
      },
      tabs: {
        group: async () => 7,
        query: async ({ groupId }) => groupId === 7 ? [{ id: 1 }] : [],
        remove: async (ids) => { removed.push(ids) },
        ungroup: async () => {},
      },
    }
    const manager = new AgentGroupManager()

    await expect(manager.addTab(1, deadlineContext(11, 20))).rejects.toMatchObject({
      stage: 'chrome.tabGroups.update',
    })
    expect(manager.groupId).toBeNull()

    await manager.dissolve(new Set([1]))
    expect(removed).toEqual([[1]])
    expect(manager.groupId).toBeNull()
  })

  test('close-all finds an untitled candidate by its cached ID', async () => {
    const removed = []
    let updateCalls = 0
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => ({ id }),
        update: () => {
          updateCalls++
          return updateCalls === 1 ? new Promise(() => {}) : Promise.resolve()
        },
      },
      tabs: {
        group: async () => 7,
        query: async ({ groupId }) => groupId === 7 ? [{ id: 1 }, { id: 2 }] : [],
        remove: async (ids) => { removed.push(ids) },
      },
    }
    const manager = new AgentGroupManager()

    await expect(manager.addTab(1, deadlineContext(12, 20))).rejects.toMatchObject({
      stage: 'chrome.tabGroups.update',
    })
    await expect(
      manager.closeAllAccioAgentGroupTabs(deadlineContext(13, 1_000)),
    ).resolves.toEqual({ success: true, groups: 1, closed: 2 })
    expect(removed).toEqual([[1, 2]])
    expect(manager.groupId).toBeNull()
  })

  test('bounds global group discovery and tab removal', async () => {
    globalThis.chrome = {
      tabGroups: {
        query: () => new Promise(() => {}),
      },
      tabs: {
        query: async () => [],
        remove: async () => {},
      },
    }
    const manager = new AgentGroupManager()

    await expect(
      manager.closeAllAccioAgentGroupTabs(deadlineContext(4, 20)),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabGroups.query',
    })

    globalThis.chrome.tabGroups.query = async () => [{ id: 7, title: 'Accio Agent' }]
    globalThis.chrome.tabs.query = () => new Promise(() => {})
    await expect(
      manager.closeAllAccioAgentGroupTabs(deadlineContext(5, 20)),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabs.query:closeAllAgentGroups',
    })

    globalThis.chrome.tabs.query = async () => [{ id: 10 }]
    globalThis.chrome.tabs.remove = () => new Promise(() => {})
    await expect(
      manager.closeAllAccioAgentGroupTabs(deadlineContext(6, 20)),
    ).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.tabs.remove:closeAllAgentGroups',
    })
  })

  test('an expired waiter never bypasses the active group mutation', async () => {
    const firstGroup = deferred()
    let groupCalls = 0
    globalThis.chrome = {
      tabGroups: {
        query: async () => [],
        get: async (id) => ({ id }),
        update: async () => {},
      },
      tabs: {
        group: () => {
          groupCalls++
          return groupCalls === 1 ? firstGroup.promise : Promise.resolve(1)
        },
      },
    }
    const manager = new AgentGroupManager()

    const first = manager.addTab(1)
    await Promise.resolve()
    const expired = manager.addTab(2, deadlineContext(3, 20))
    await expect(expired).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'agent_group.queue_wait',
    })

    const third = manager.addTab(3)
    await Promise.resolve()
    expect(groupCalls).toBe(1)
    firstGroup.resolve(1)
    await first
    await third
    expect(groupCalls).toBe(2)
  })
})
