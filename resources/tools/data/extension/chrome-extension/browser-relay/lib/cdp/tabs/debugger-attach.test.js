import { afterEach, describe, expect, test } from 'bun:test'

import { createCommandContext } from '../commands/deadline.js'
import {
  attachDebugger,
  startDebuggerAttach,
  startDebuggerDetach,
} from './debugger-attach.js'

const originalChrome = globalThis.chrome
const originalSetTimeout = globalThis.setTimeout

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function context() {
  const sentAt = Date.now()
  return createCommandContext({
    requestId: 1,
    method: 'Runtime.evaluate',
    sentAt,
    deadlineAt: sentAt + 60_000,
  })
}

function accelerateTimers(delays) {
  globalThis.setTimeout = (callback, delay, ...args) => {
    delays.push(delay)
    return originalSetTimeout(callback, 0, ...args)
  }
}

afterEach(() => {
  globalThis.chrome = originalChrome
  globalThis.setTimeout = originalSetTimeout
})

describe('attachDebugger deadlines', () => {
  test('bounds chrome.debugger.attach by the shared attach budget', async () => {
    const delays = []
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        attach: () => new Promise(() => {}),
        sendCommand: async () => ({}),
      },
    }

    await expect(attachDebugger(1, context())).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.attach',
      timeoutSource: 'command_deadline',
    })
    expect(delays.at(-1)).toBeGreaterThan(25_000)
  })

  test('retains raw attach settlement after the bounded result times out', async () => {
    const delays = []
    const attachGate = deferred()
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        attach: () => attachGate.promise,
        sendCommand: async () => ({}),
      },
    }

    const operation = startDebuggerAttach(4, context())
    await expect(operation.result).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.attach',
    })

    attachGate.resolve()
    await expect(operation.settlement).resolves.toMatchObject({ status: 'fulfilled' })
  })

  test('retains raw detach settlement after the bounded result times out', async () => {
    const delays = []
    const detachGate = deferred()
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        detach: () => detachGate.promise,
      },
    }

    const operation = startDebuggerDetach(5, context())
    await expect(operation.result).resolves.toBeUndefined()

    detachGate.resolve()
    await expect(operation.settlement).resolves.toMatchObject({ status: 'fulfilled' })
  })

  test('caps Page.enable at the CDP leaf limit', async () => {
    const delays = []
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: (_debuggee, method) =>
          method === 'Page.enable' ? new Promise(() => {}) : Promise.resolve({}),
      },
    }

    await expect(attachDebugger(2, context())).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.sendCommand:Page.enable',
      timeoutSource: 'operation_limit',
      debuggerAttached: true,
    })
    expect(delays.at(-1)).toBe(10_000)
  })

  test('falls back when Target.getTargetInfo reaches its CDP leaf limit', async () => {
    const delays = []
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: (_debuggee, method) =>
          method === 'Target.getTargetInfo' ? new Promise(() => {}) : Promise.resolve(),
        getTargets: async () => [
          { id: 'REAL_TARGET_3', tabId: 3, attached: true, type: 'page' },
        ],
      },
    }

    await expect(attachDebugger(3, context())).resolves.toEqual({ realTargetId: 'REAL_TARGET_3' })
    expect(delays.at(-1)).toBe(10_000)
  })

  test('does not start the fallback after the command deadline expires', async () => {
    const delays = []
    let getTargetsCalls = 0
    accelerateTimers(delays)
    const sentAt = Date.now()
    const commandContext = createCommandContext({
      requestId: 2,
      method: 'Runtime.evaluate',
      sentAt,
      deadlineAt: sentAt + 20,
    })
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: (_debuggee, method) =>
          method === 'Target.getTargetInfo' ? new Promise(() => {}) : Promise.resolve(),
        getTargets: async () => {
          getTargetsCalls++
          return []
        },
      },
    }

    await expect(attachDebugger(4, commandContext)).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.sendCommand:Target.getTargetInfo',
      timeoutSource: 'command_deadline',
      debuggerAttached: true,
    })
    expect(getTargetsCalls).toBe(0)
  })
})

describe('attachDebugger target identity fallback', () => {
  test('keeps Target.getTargetInfo as the primary target identity path', async () => {
    let getTargetsCalls = 0
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) =>
          method === 'Target.getTargetInfo'
            ? { targetInfo: { targetId: 'REAL_TARGET_6' } }
            : undefined,
        getTargets: async () => {
          getTargetsCalls++
          return []
        },
      },
    }

    await expect(attachDebugger(6)).resolves.toEqual({ realTargetId: 'REAL_TARGET_6' })
    expect(getTargetsCalls).toBe(0)
  })

  test('uses chrome.debugger.getTargets for the legacy -32000 Not allowed response', async () => {
    let getTargetsCalls = 0
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') {
            throw new Error('{"code":-32000,"message":"Not allowed"}')
          }
        },
        getTargets: async () => {
          getTargetsCalls++
          return [
            { id: 'OTHER_TARGET', tabId: 8, attached: true, type: 'page' },
            { id: 'REAL_TARGET_7', tabId: 7, attached: true, type: 'page' },
          ]
        },
      },
    }

    await expect(attachDebugger(7)).resolves.toEqual({ realTargetId: 'REAL_TARGET_7' })
    expect(getTargetsCalls).toBe(1)
  })

  test('falls back for a structured Target.getTargetInfo error', async () => {
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') {
            throw { code: -32000, message: 'Not allowed' }
          }
        },
        getTargets: async () => [
          { id: 'REAL_TARGET_9', tabId: 9, attached: true, type: 'page' },
        ],
      },
    }

    await expect(attachDebugger(9)).resolves.toEqual({ realTargetId: 'REAL_TARGET_9' })
  })

  test.each([
    new Error('{"code":-32000,"message":"Another error"}'),
    new Error('Not allowed'),
    new Error('{malformed'),
  ])('falls back without depending on the primary error shape', async (targetInfoError) => {
    let getTargetsCalls = 0
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') throw targetInfoError
        },
        getTargets: async () => {
          getTargetsCalls++
          return [{ id: 'REAL_TARGET_10', tabId: 10, attached: true, type: 'page' }]
        },
      },
    }

    await expect(attachDebugger(10)).resolves.toEqual({ realTargetId: 'REAL_TARGET_10' })
    expect(getTargetsCalls).toBe(1)
  })

  test('falls back when Target.getTargetInfo returns no target ID', async () => {
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) =>
          method === 'Target.getTargetInfo' ? { targetInfo: {} } : undefined,
        getTargets: async () => [
          { id: 'REAL_TARGET_10', tabId: 10, attached: true, type: 'page' },
        ],
      },
    }

    await expect(attachDebugger(10)).resolves.toEqual({ realTargetId: 'REAL_TARGET_10' })
  })

  test('fails initialization when the fallback cannot find the attached page target', async () => {
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') {
            throw new Error('{"code":-32000,"message":"Not allowed"}')
          }
        },
        getTargets: async () => [
          { id: 'DETACHED_TARGET', tabId: 11, attached: false, type: 'page' },
          { id: 'WORKER_TARGET', tabId: 11, attached: true, type: 'worker' },
        ],
      },
    }

    await expect(attachDebugger(11)).rejects.toThrow(
      'Target.getTargetInfo: {"code":-32000,"message":"Not allowed"}; ' +
        'chrome.debugger.getTargets: No attached page target was found for tab 11',
    )
  })

  test('preserves both identity errors when the fallback API fails', async () => {
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') throw new Error('primary identity failure')
        },
        getTargets: async () => {
          throw new Error('fallback identity failure')
        },
      },
    }

    await expect(attachDebugger(13)).rejects.toThrow(
      'Target.getTargetInfo: primary identity failure; ' +
        'chrome.debugger.getTargets: fallback identity failure',
    )
  })

  test('bounds the fallback target lookup by the CDP leaf limit', async () => {
    const delays = []
    accelerateTimers(delays)
    globalThis.chrome = {
      debugger: {
        attach: async () => {},
        sendCommand: async (_debuggee, method) => {
          if (method === 'Target.getTargetInfo') {
            throw new Error('{"code":-32000,"message":"Not allowed"}')
          }
        },
        getTargets: () => new Promise(() => {}),
      },
    }

    await expect(attachDebugger(12, context())).rejects.toMatchObject({
      code: 'COMMAND_DEADLINE_EXCEEDED',
      stage: 'chrome.debugger.getTargets:resolveTargetIdentity',
      timeoutSource: 'operation_limit',
      debuggerAttached: true,
    })
    expect(delays.at(-1)).toBe(10_000)
  })
})
