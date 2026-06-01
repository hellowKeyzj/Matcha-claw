import { describe, expect, test } from 'bun:test'
import { ProcessTransport } from '../processTransport.js'

describe('ProcessTransport', () => {
  test('maps SDK options to headless CLI flags', () => {
    const transport = new ProcessTransport({
      options: {
        model: 'claude-sonnet-4-6',
        permissionMode: 'default',
        allowedTools: ['Read', 'Edit'],
        disallowedTools: ['Bash(rm:*)'],
        maxTurns: 3,
        maxBudgetUsd: 1.25,
        taskBudget: 2048,
        mcpServers: {
          local: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        },
        resume: 'session-1',
        forkSession: true,
        includePartialMessages: true,
      },
    })

    const args = (transport as unknown as { buildArgs(): string[] }).buildArgs()

    expect(args).toContain('--task-budget')
    expect(args).toContain('2048')
    expect(args).toContain('--fork-session')
    expect(args[args.indexOf('--fork-session') + 1]).toBe(
      '--include-partial-messages',
    )
    expect(args).toContain('--mcp-config')
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
        },
      },
    })
  })
})
