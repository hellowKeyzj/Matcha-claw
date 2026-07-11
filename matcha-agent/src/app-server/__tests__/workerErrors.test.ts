import { describe, expect, test } from 'bun:test'
import { errorToMessage } from '../workers/workerErrors.js'

describe('workerErrors', () => {
  test('preserves messages from non-Error resolver objects', () => {
    const error = {
      name: 'ResolveMessage',
      message:
        "Cannot find module '@claude-code-best/builtin-tools/tools/SendMessageTool/SendMessageTool.js'",
    }

    expect(errorToMessage(error, 'Worker operation failed')).toBe(
      "Cannot find module '@claude-code-best/builtin-tools/tools/SendMessageTool/SendMessageTool.js'",
    )
  })
})
