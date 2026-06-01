import { describe, expect, test } from 'bun:test'

describe('agentSdkTypes entrypoint', () => {
  test('exports the SDK facade without starting a query process', async () => {
    const sdk = await import('../../agentSdkTypes.js')

    expect(typeof sdk.query).toBe('function')
    expect(typeof sdk.unstable_v2_prompt).toBe('function')
    expect(typeof sdk.unstable_v2_createSession).toBe('function')
    expect(typeof sdk.unstable_v2_resumeSession).toBe('function')
    expect(typeof sdk.tool).toBe('function')
    expect(typeof sdk.createSdkMcpServer).toBe('function')
    expect(typeof sdk.listSessions).toBe('function')
    expect(typeof sdk.getSessionInfo).toBe('function')
    expect(typeof sdk.getSessionMessages).toBe('function')
    expect(typeof sdk.renameSession).toBe('function')
    expect(typeof sdk.tagSession).toBe('function')
    expect(typeof sdk.forkSession).toBe('function')
    expect(typeof sdk.watchScheduledTasks).toBe('function')
    expect(typeof sdk.buildMissedTaskNotification).toBe('function')
    expect(typeof sdk.connectRemoteControl).toBe('function')
    expect(sdk.HOOK_EVENTS).toContain('PreToolUse')
    expect(sdk.EXIT_REASONS).toContain('prompt_input_exit')
  })
})
