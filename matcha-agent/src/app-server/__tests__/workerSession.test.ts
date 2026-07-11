import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QueryEngineConfig } from '../../QueryEngine.js'
import type { WorkerInitializePayload } from '../protocol/types.js'
import type { Tool } from '../../Tool.js'
import type { Command } from '../../commands.js'
import type { Message } from '../../types/message.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../../services/mcp/types.js'

const restores: (() => void)[] = []
const tempRoots: string[] = []
const originalCwd = process.cwd()
const originalRunTraceEnv = process.env.MATCHA_AGENT_RUN_TRACE

function mockModulePreservingExports(
  tsPath: string,
  overrides: Record<string, unknown>,
): void {
  const jsPath = tsPath.replace(/\.ts$/, '.js')
  const snapshot = { ...(require(tsPath) as Record<string, unknown>) }
  mock.module(tsPath, () => ({ ...snapshot, ...overrides }))
  mock.module(jsPath, () => ({ ...snapshot, ...overrides }))
  restores.push(() => {
    mock.module(tsPath, () => snapshot)
    mock.module(jsPath, () => snapshot)
  })
}

const queryEngineConfigs: QueryEngineConfig[] = []
const queryEngineSubmitMessages: unknown[] = []
const submittedQueryInputs: unknown[] = []
let queryEngineSubmitError: unknown
const mockSetModel = mock((_model: string) => {})

mockModulePreservingExports('../../QueryEngine.ts', {
  QueryEngine: class MockQueryEngine {
    constructor(config: QueryEngineConfig) {
      queryEngineConfigs.push(config)
    }

    submitMessage = mock(async function* (input: unknown) {
      submittedQueryInputs.push(input)
      if (queryEngineSubmitError !== undefined) {
        throw queryEngineSubmitError
      }
      for (const message of queryEngineSubmitMessages) {
        yield message
      }
    })
    interrupt = mock(() => {})
    resetAbortController = mock(() => {})
    setModel = mockSetModel
  },
})

const mcpTool = { name: 'mcp-tool', isMcp: true } as unknown as Tool
const assembledTool = { name: 'assembled-tool' } as unknown as Tool
const assembleToolPoolMock = mock(
  (_permissionContext: unknown, mcpTools: unknown) => {
    expect(mcpTools).toEqual([mcpTool])
    return [assembledTool]
  },
)

mockModulePreservingExports('../../tools.ts', {
  assembleToolPool: assembleToolPoolMock,
})

mockModulePreservingExports('../../Tool.ts', {
  getEmptyToolPermissionContext: mock(() => ({
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { user: [], project: [], local: [] },
    alwaysDenyRules: { user: [], project: [], local: [] },
    alwaysAskRules: { user: [], project: [], local: [] },
    isBypassPermissionsModeAvailable: true,
  })),
})

const baseCommand = {
  type: 'prompt',
  name: 'base-command',
  description: 'base command',
  progressMessage: 'loading base',
  contentLength: 0,
  source: 'builtin',
  getPromptForCommand: mock(async () => []),
} as unknown as Command
const mcpCommand = {
  type: 'prompt',
  name: 'mcp-command',
  description: 'mcp command',
  progressMessage: 'loading mcp',
  contentLength: 0,
  source: 'mcp',
  getPromptForCommand: mock(async () => []),
} as unknown as Command
const duplicateMcpCommand = {
  ...mcpCommand,
  name: 'base-command',
  description: 'duplicate should lose to base command',
} as unknown as Command

const getCommandsMock = mock(async (_cwd: string) => [baseCommand])
mockModulePreservingExports('../../commands.ts', {
  getCommands: getCommandsMock,
})

const agentDefinitions = {
  activeAgents: [{ name: 'test-agent' }],
  allAgents: [{ name: 'test-agent' }],
} as unknown as Awaited<
  ReturnType<
    typeof import('@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js')['getAgentDefinitionsWithOverrides']
  >
>
const getAgentDefinitionsWithOverridesMock = mock(
  async (_cwd: string) => agentDefinitions,
)
const loadAgentsDirModulePath =
  '@claude-code-best/builtin-tools/tools/AgentTool/loadAgentsDir.js'
const loadAgentsDirSnapshot = {
  ...(require(loadAgentsDirModulePath) as Record<string, unknown>),
}
mock.module(loadAgentsDirModulePath, () => ({
  ...loadAgentsDirSnapshot,
  getAgentDefinitionsWithOverrides: getAgentDefinitionsWithOverridesMock,
}))
restores.push(() =>
  mock.module(loadAgentsDirModulePath, () => loadAgentsDirSnapshot),
)

const defaultAppState = {
  toolPermissionContext: {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { user: [], project: [], local: [] },
    alwaysDenyRules: { user: [], project: [], local: [] },
    alwaysAskRules: { user: [], project: [], local: [] },
    isBypassPermissionsModeAvailable: true,
  },
  agentDefinitions: { activeAgents: [], allAgents: [] },
  mcp: {
    clients: [],
    tools: [],
    commands: [],
    resources: {},
    pluginReconnectKey: 0,
  },
}
mockModulePreservingExports('../../state/AppStateStore.ts', {
  getDefaultAppState: mock(() => defaultAppState),
})

mockModulePreservingExports('../../utils/fileStateCache.ts', {
  FileStateCache: class MockFileStateCache {},
})

mockModulePreservingExports('../../utils/permissions/permissions.ts', {
  hasPermissionsToUseTool: mock(async () => ({ behavior: 'allow' })),
})

const switchSessionMock = mock(() => {})
const setOriginalCwdMock = mock((_cwd: string) => {})
mockModulePreservingExports('../../bootstrap/state.ts', {
  switchSession: switchSessionMock,
  setOriginalCwd: setOriginalCwdMock,
  getSessionProjectDir: mock(() => null),
})

const applySafeConfigEnvironmentVariablesMock = mock(() => {})
mockModulePreservingExports('../../utils/managedEnv.ts', {
  applySafeConfigEnvironmentVariables: applySafeConfigEnvironmentVariablesMock,
})

const resetSettingsCacheMock = mock(() => {})
mockModulePreservingExports('../../utils/settings/settingsCache.ts', {
  resetSettingsCache: resetSettingsCacheMock,
})

const runWithCwdOverrideMock = mock(
  async <T>(_cwd: string, fn: () => T | Promise<T>): Promise<T> => fn(),
)
mockModulePreservingExports('../../utils/cwd.ts', {
  runWithCwdOverride: runWithCwdOverrideMock,
})

const resolveSessionFilePathMock = mock(
  async (): Promise<
    | { filePath: string; projectPath: string | undefined; fileSize: number }
    | undefined
  > => undefined,
)
mockModulePreservingExports('../../utils/sessionStoragePortable.ts', {
  resolveSessionFilePath: resolveSessionFilePathMock,
})

const getLastSessionLogMock = mock(
  async (): Promise<{ messages: Message[] } | null> => null,
)
mockModulePreservingExports('../../utils/sessionStorage.ts', {
  getLastSessionLog: getLastSessionLogMock,
})

const deserializeMessagesMock = mock((messages: Message[]) => messages)
mockModulePreservingExports('../../utils/conversationRecovery.ts', {
  deserializeMessages: deserializeMessagesMock,
})

const scopedMcpConfig = {
  type: 'stdio',
  command: 'node',
  args: [],
  scope: 'project',
}
const getClaudeCodeMcpConfigsMock = mock(async () => ({
  servers: { projectServer: scopedMcpConfig },
  errors: [],
}))
mockModulePreservingExports('../../services/mcp/config.ts', {
  getClaudeCodeMcpConfigs: getClaudeCodeMcpConfigsMock,
})

const mcpClient = {
  name: 'projectServer',
  type: 'failed',
  config: scopedMcpConfig,
} as unknown as MCPServerConnection
const mcpResource = {
  uri: 'file:///resource',
  name: 'resource',
  server: 'projectServer',
} as ServerResource
const getMcpToolsCommandsAndResourcesMock = mock(
  async (onConnectionAttempt, mcpConfigs) => {
    expect(mcpConfigs).toEqual({ projectServer: scopedMcpConfig })
    onConnectionAttempt({
      client: mcpClient,
      tools: [mcpTool],
      commands: [mcpCommand, duplicateMcpCommand],
      resources: [mcpResource],
    })
  },
)
mockModulePreservingExports('../../services/mcp/client.ts', {
  getMcpToolsCommandsAndResources: getMcpToolsCommandsAndResourcesMock,
})

mockModulePreservingExports('../../types/plugin.ts', {
  getPluginErrorMessage: mock(() => 'plugin error'),
})

const { createWorkerSession } = await import('../workers/workerSession.js')

afterAll(async () => {
  for (let i = restores.length - 1; i >= 0; i--) {
    restores[i]?.()
  }
  restores.length = 0
  process.chdir(originalCwd)
  if (originalRunTraceEnv === undefined) {
    delete process.env.MATCHA_AGENT_RUN_TRACE
  } else {
    process.env.MATCHA_AGENT_RUN_TRACE = originalRunTraceEnv
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

beforeEach(() => {
  queryEngineConfigs.length = 0
  queryEngineSubmitMessages.length = 0
  submittedQueryInputs.length = 0
  queryEngineSubmitError = undefined
  mockSetModel.mockClear()
  assembleToolPoolMock.mockClear()
  getCommandsMock.mockClear()
  getAgentDefinitionsWithOverridesMock.mockClear()
  switchSessionMock.mockClear()
  setOriginalCwdMock.mockClear()
  applySafeConfigEnvironmentVariablesMock.mockClear()
  resetSettingsCacheMock.mockClear()
  runWithCwdOverrideMock.mockClear()
  resolveSessionFilePathMock.mockClear()
  getLastSessionLogMock.mockClear()
  deserializeMessagesMock.mockClear()
  getClaudeCodeMcpConfigsMock.mockClear()
  getMcpToolsCommandsAndResourcesMock.mockClear()
  if (originalRunTraceEnv === undefined) {
    delete process.env.MATCHA_AGENT_RUN_TRACE
  } else {
    process.env.MATCHA_AGENT_RUN_TRACE = originalRunTraceEnv
  }
})

describe('createWorkerSession', () => {
  async function createInitializedSession(
    emit = mock((_frame: unknown) => {}),
  ) {
    const payload: WorkerInitializePayload = {
      sessionId: 'session-1',
      cwd: originalCwd,
      model: 'test-model',
      permissionMode: 'acceptEdits',
    }
    const session = await createWorkerSession(payload, { emit })
    return { session, emit }
  }

  test('loads MCP configs for the worker cwd and injects MCP resources into QueryEngine', async () => {
    const payload: WorkerInitializePayload = {
      sessionId: 'session-1',
      cwd: originalCwd,
      model: 'test-model',
      permissionMode: 'acceptEdits',
    }

    await createWorkerSession(payload, { emit: mock(() => {}) })

    expect(runWithCwdOverrideMock).toHaveBeenCalledWith(
      originalCwd,
      expect.any(Function),
    )
    expect(setOriginalCwdMock).toHaveBeenCalledWith(originalCwd)
    expect(getCommandsMock).toHaveBeenCalledWith(originalCwd)
    expect(getAgentDefinitionsWithOverridesMock).toHaveBeenCalledWith(
      originalCwd,
    )
    expect(getClaudeCodeMcpConfigsMock).toHaveBeenCalledTimes(1)
    expect(getMcpToolsCommandsAndResourcesMock).toHaveBeenCalledTimes(1)
    expect(assembleToolPoolMock).toHaveBeenCalledTimes(1)

    expect(queryEngineConfigs).toHaveLength(1)
    const config = queryEngineConfigs[0]
    expect(config?.cwd).toBe(originalCwd)
    expect(config?.tools).toEqual([assembledTool])
    expect(config?.mcpClients).toEqual([mcpClient])
    expect(config?.commands.map(command => command.name)).toEqual([
      'base-command',
      'mcp-command',
    ])
    expect(config?.commands[0]).toBe(baseCommand)
    expect(config?.agents).toBe(agentDefinitions.activeAgents)
    expect(config?.getAppState().mcp).toEqual({
      clients: [mcpClient],
      tools: [mcpTool],
      commands: [mcpCommand, duplicateMcpCommand],
      resources: { projectServer: [mcpResource] },
      pluginReconnectKey: 0,
    })
    expect(mockSetModel).toHaveBeenCalledWith('test-model')
  })

  test('loads existing transcript history into QueryEngine without extending the worker protocol', async () => {
    const transcriptMessages = [
      {
        type: 'user',
        uuid: 'history-user-message',
        timestamp: '2026-07-09T00:00:00.000Z',
        message: { role: 'user', content: 'old question' },
      },
      {
        type: 'assistant',
        uuid: 'history-assistant-message',
        timestamp: '2026-07-09T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'old answer' }],
        },
      },
    ] as unknown as Message[]
    const restoredMessages = [
      ...transcriptMessages,
      {
        type: 'assistant',
        uuid: 'resume-sentinel-message',
        timestamp: '2026-07-09T00:00:02.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'resume sentinel' }],
        },
      } as unknown as Message,
    ]
    resolveSessionFilePathMock.mockImplementationOnce(async () => ({
      filePath: join(originalCwd, 'session-1.jsonl'),
      projectPath: originalCwd,
      fileSize: 123,
    }))
    getLastSessionLogMock.mockImplementationOnce(async () => ({
      messages: transcriptMessages,
    }))
    deserializeMessagesMock.mockImplementationOnce(() => restoredMessages)
    const payload: WorkerInitializePayload = {
      sessionId: 'session-1',
      cwd: originalCwd,
      model: 'test-model',
      permissionMode: 'acceptEdits',
    }

    const session = await createWorkerSession(payload, { emit: mock(() => {}) })
    await session.prompt('run-2', 'continue from history')

    expect(resolveSessionFilePathMock).toHaveBeenCalledWith(
      'session-1',
      originalCwd,
    )
    expect(switchSessionMock).toHaveBeenCalledWith('session-1', originalCwd)
    expect(getLastSessionLogMock).toHaveBeenCalledWith('session-1')
    expect(deserializeMessagesMock).toHaveBeenCalledWith(transcriptMessages)
    expect(queryEngineConfigs[0]?.initialMessages).toBe(restoredMessages)
    expect(submittedQueryInputs).toEqual(['continue from history'])
  })

  test('keeps the worker runtime cwd while initializing a session workspace cwd', async () => {
    const workspaceCwd = await mkdtemp(join(tmpdir(), 'matcha-worker-cwd-'))
    tempRoots.push(workspaceCwd)
    const payload: WorkerInitializePayload = {
      sessionId: 'session-1',
      cwd: workspaceCwd,
      model: 'test-model',
      permissionMode: 'acceptEdits',
    }

    await createWorkerSession(payload, { emit: mock(() => {}) })

    expect(process.cwd()).toBe(originalCwd)
    expect(runWithCwdOverrideMock).toHaveBeenCalledWith(
      workspaceCwd,
      expect.any(Function),
    )
    expect(getCommandsMock).toHaveBeenCalledWith(workspaceCwd)
    expect(getAgentDefinitionsWithOverridesMock).toHaveBeenCalledWith(
      workspaceCwd,
    )
    expect(queryEngineConfigs[0]?.cwd).toBe(workspaceCwd)
  })

  test('passes prompt content blocks to QueryEngine when prompt contains media payload', async () => {
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', [
      { type: 'text', text: 'hello with image' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64-image',
        },
      },
    ])

    expect(submittedQueryInputs).toEqual([
      [
        { type: 'text', text: 'hello with image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'base64-image',
          },
        },
      ],
    ])
  })

  test('emits one terminal failed frame when QueryEngine throws', async () => {
    queryEngineSubmitError = new Error('network failed')
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isFrameType(frame, 'run.failed')),
    ).toHaveLength(1)
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.failed')),
    ).toHaveLength(0)
  })

  test('uses the SDK message_start id for following stream deltas', async () => {
    queryEngineSubmitMessages.push(
      {
        type: 'stream_event',
        uuid: 'stream-event-1',
        event: {
          type: 'message_start',
          message: { id: 'assistant-message-1' },
        },
      },
      {
        type: 'stream_event',
        uuid: 'stream-event-2',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'hello' },
        },
      },
    )
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const sdkEvents = emit.mock.calls
      .map(call => call[0])
      .filter(isSdkMessageEventFrame)
    expect(
      sdkEvents.map(frame => frame.event.projectionHints?.messageId),
    ).toEqual(['assistant-message-1', 'assistant-message-1'])
  })

  test('emits only a top-level completed frame for a successful SDK result', async () => {
    queryEngineSubmitMessages.push({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    })
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isFrameType(frame, 'run.completed')),
    ).toHaveLength(1)
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.completed')),
    ).toHaveLength(0)
  })

  test('emits only a top-level failed frame for an error SDK result', async () => {
    queryEngineSubmitMessages.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'tool failed',
    })
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isFrameType(frame, 'run.failed')),
    ).toHaveLength(1)
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.failed')),
    ).toHaveLength(0)
  })

  test('does not emit run.trace when trace env is disabled', async () => {
    queryEngineSubmitMessages.push({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
    })
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.trace')),
    ).toEqual([])
  })

  test('emits scalar run.trace events when trace env is enabled', async () => {
    process.env.MATCHA_AGENT_RUN_TRACE = '1'
    queryEngineSubmitMessages.push({
      type: 'result',
      subtype: 'success',
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    })
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const traceEvents = emit.mock.calls
      .map(call => call[0])
      .filter(isRunTraceEventFrame)
      .map(frame => frame.event)
    expect(traceEvents).toEqual([
      {
        type: 'run.trace',
        runId: 'run-1',
        workerId: 'matcha-agent-worker',
        stage: 'worker.query.submit.started',
      },
      {
        type: 'run.trace',
        runId: 'run-1',
        workerId: 'matcha-agent-worker',
        stage: 'worker.query.sdk_result',
        details: { isError: false, stopReason: 'end_turn' },
      },
    ])
  })

  test('emits a sanitized error trace before worker failure frame', async () => {
    process.env.MATCHA_AGENT_RUN_TRACE = '1'
    queryEngineSubmitError = new Error('provider secret should not be logged')
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const traceEvents = emit.mock.calls
      .map(call => call[0])
      .filter(isRunTraceEventFrame)
      .map(frame => frame.event)
    expect(traceEvents.at(-1)).toEqual({
      type: 'run.trace',
      runId: 'run-1',
      workerId: 'matcha-agent-worker',
      stage: 'worker.query.error',
      details: { errorName: 'Error' },
    })
  })

  test('emits cancellation as a worker event without a completed frame', async () => {
    queryEngineSubmitError = new Error('aborted')
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)
    session.cancel('run-1', 'user stopped')

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.cancelled')),
    ).toHaveLength(1)
    expect(
      frames.filter(frame => isFrameType(frame, 'run.completed')),
    ).toHaveLength(0)
  })

  test('emits cancellation when an interrupted QueryEngine finishes cleanly', async () => {
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)
    session.cancel('run-1', 'user stopped')

    await session.prompt('run-1', 'hello')

    const frames = emit.mock.calls.map(call => call[0])
    expect(
      frames.filter(frame => isEventFrameType(frame, 'run.cancelled')),
    ).toHaveLength(1)
    expect(
      frames.filter(frame => isFrameType(frame, 'run.completed')),
    ).toHaveLength(0)
  })

  test('keeps message_stop on the active assistant id and clears it for the next message', async () => {
    queryEngineSubmitMessages.push(
      {
        type: 'stream_event',
        uuid: 'stream-event-1',
        event: {
          type: 'message_start',
          message: { id: 'assistant-message-1' },
        },
      },
      {
        type: 'stream_event',
        uuid: 'stream-event-2',
        event: { type: 'message_stop' },
      },
      {
        type: 'stream_event',
        uuid: 'stream-event-3',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'next' },
        },
      },
    )
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')

    const sdkEvents = emit.mock.calls
      .map(call => call[0])
      .filter(isSdkMessageEventFrame)
    expect(
      sdkEvents.map(frame => frame.event.projectionHints?.messageId),
    ).toEqual(['assistant-message-1', 'assistant-message-1', 'stream-event-3'])
  })

  test('does not reuse a stale assistant id for terminal SDK result or the next prompt', async () => {
    queryEngineSubmitMessages.push(
      {
        type: 'stream_event',
        uuid: 'stream-event-1',
        event: {
          type: 'message_start',
          message: { id: 'assistant-message-1' },
        },
      },
      {
        type: 'result',
        subtype: 'success',
        uuid: 'result-message-1',
      },
    )
    const emit = mock((_frame: unknown) => {})
    const { session } = await createInitializedSession(emit)

    await session.prompt('run-1', 'hello')
    queryEngineSubmitMessages.length = 0
    queryEngineSubmitMessages.push({
      type: 'stream_event',
      uuid: 'stream-event-2',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'next' },
      },
    })
    await session.prompt('run-2', 'hello again')

    const sdkEvents = emit.mock.calls
      .map(call => call[0])
      .filter(isSdkMessageEventFrame)
    expect(
      sdkEvents.map(frame => frame.event.projectionHints?.messageId),
    ).toEqual(['assistant-message-1', 'result-message-1', 'stream-event-2'])
  })
})

function isFrameType(frame: unknown, type: string): boolean {
  return isRecord(frame) && frame.type === type
}

function isEventFrameType(frame: unknown, eventType: string): boolean {
  return (
    isRecord(frame) &&
    frame.type === 'event' &&
    isRecord(frame.event) &&
    frame.event.type === eventType
  )
}

function isSdkMessageEventFrame(frame: unknown): frame is {
  event: { projectionHints?: { messageId?: string } }
} {
  return isEventFrameType(frame, 'sdk.message')
}

function isRunTraceEventFrame(frame: unknown): frame is {
  event: {
    type: 'run.trace'
    runId: string
    workerId?: string
    stage: string
    details?: Record<string, unknown>
  }
} {
  return isEventFrameType(frame, 'run.trace')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
