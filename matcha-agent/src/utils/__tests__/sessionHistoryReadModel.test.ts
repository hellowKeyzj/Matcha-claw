import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  listSessionHistorySummaries,
  loadSessionHistorySummary,
  readSessionTranscriptReplayLines,
} from '../sessionHistoryReadModel'

const SESSION_ID = '10000000-0000-4000-8000-000000000001'
const HUMAN_MESSAGE_ID = '10000000-0000-4000-8000-000000000002'
const ABANDONED_MESSAGE_ID = '10000000-0000-4000-8000-000000000003'
const TOOL_USE_MESSAGE_ID = '10000000-0000-4000-8000-000000000004'
const TOOL_RESULT_MESSAGE_ID = '10000000-0000-4000-8000-000000000005'
const FINAL_MESSAGE_ID = '10000000-0000-4000-8000-000000000006'
const TOOL_CALL_ID = 'toolu_01HISTORYSOURCE'

let tempHome = ''
let configDir = ''
let previousConfigDir: string | undefined

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  tempHome = await mkdtemp(join(tmpdir(), 'session-history-read-model-'))
  configDir = join(tempHome, '.claude')
  process.env.CLAUDE_CONFIG_DIR = configDir
  const { getClaudeConfigHomeDir } = await import('src/utils/envUtils')
  getClaudeConfigHomeDir.cache.clear?.()
})

afterEach(async () => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  const { getClaudeConfigHomeDir } = await import('src/utils/envUtils')
  getClaudeConfigHomeDir.cache.clear?.()
  await rm(tempHome, { recursive: true, force: true })
})

type ReplayLine = {
  id: string
  parentId?: string
  message: {
    id: string
    originMessageId?: string
    role: string
    toolCallId?: string
    metadata: {
      sessionId: string
    }
  }
}

describe('readSessionTranscriptReplayLines', () => {
  test('replays the recovered Claude JSONL parent chain and preserves tool results', async () => {
    const sessionFile = join(
      configDir,
      'projects',
      '-history-read-model-fixture',
      `${SESSION_ID}.jsonl`,
    )
    const transcriptEntries = [
      {
        uuid: HUMAN_MESSAGE_ID,
        parentUuid: null,
        isSidechain: false,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:00.000Z',
        type: 'user',
        cwd: '/workspace/history-read-model-fixture',
        userType: 'external',
        version: '2.8.1',
        gitBranch: 'main',
        message: {
          role: 'user',
          content: 'Inspect the repository status.',
        },
      },
      {
        uuid: ABANDONED_MESSAGE_ID,
        parentUuid: HUMAN_MESSAGE_ID,
        isSidechain: false,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:01.000Z',
        type: 'assistant',
        cwd: '/workspace/history-read-model-fixture',
        userType: 'external',
        version: '2.8.1',
        gitBranch: 'main',
        requestId: 'req_abandoned_history_source',
        message: {
          id: 'msg_abandoned_history_source',
          model: 'claude-opus-4-8',
          role: 'assistant',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: 10,
            output_tokens: 10,
          },
          content: [{ type: 'text', text: 'An abandoned response.' }],
        },
      },
      {
        uuid: TOOL_USE_MESSAGE_ID,
        parentUuid: HUMAN_MESSAGE_ID,
        isSidechain: false,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:02.000Z',
        type: 'assistant',
        cwd: '/workspace/history-read-model-fixture',
        userType: 'external',
        version: '2.8.1',
        gitBranch: 'main',
        requestId: 'req_tool_use_history_source',
        message: {
          id: 'msg_tool_use_history_source',
          model: 'claude-opus-4-8',
          role: 'assistant',
          stop_reason: 'tool_use',
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: 10,
            output_tokens: 10,
          },
          content: [
            {
              type: 'tool_use',
              id: TOOL_CALL_ID,
              name: 'Bash',
              input: { command: 'git status --short' },
            },
          ],
        },
      },
      {
        uuid: TOOL_RESULT_MESSAGE_ID,
        parentUuid: TOOL_USE_MESSAGE_ID,
        isSidechain: false,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:03.000Z',
        type: 'user',
        cwd: '/workspace/history-read-model-fixture',
        userType: 'external',
        version: '2.8.1',
        gitBranch: 'main',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: TOOL_CALL_ID,
              content: ' M matcha-agent/src/utils/sessionHistoryReadModel.ts',
            },
          ],
        },
      },
      {
        uuid: FINAL_MESSAGE_ID,
        parentUuid: TOOL_RESULT_MESSAGE_ID,
        isSidechain: false,
        sessionId: SESSION_ID,
        timestamp: '2026-07-11T12:00:04.000Z',
        type: 'assistant',
        cwd: '/workspace/history-read-model-fixture',
        userType: 'external',
        version: '2.8.1',
        gitBranch: 'main',
        requestId: 'req_final_history_source',
        message: {
          id: 'msg_final_history_source',
          model: 'claude-opus-4-8',
          role: 'assistant',
          stop_reason: 'end_turn',
          stop_sequence: null,
          type: 'message',
          usage: {
            input_tokens: 20,
            output_tokens: 20,
          },
          content: [{ type: 'text', text: 'The repository has one change.' }],
        },
      },
    ]

    await mkdir(dirname(sessionFile), { recursive: true })
    await writeFile(
      sessionFile,
      `${transcriptEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    )

    const replayLines = await readSessionTranscriptReplayLines(SESSION_ID, 4)
    const replay = replayLines.map(line => JSON.parse(line) as ReplayLine)
    const expectedChain = [
      { id: HUMAN_MESSAGE_ID, parentId: undefined, role: 'user' },
      {
        id: TOOL_USE_MESSAGE_ID,
        parentId: HUMAN_MESSAGE_ID,
        role: 'assistant',
      },
      {
        id: TOOL_RESULT_MESSAGE_ID,
        parentId: TOOL_USE_MESSAGE_ID,
        role: 'toolresult',
      },
      {
        id: FINAL_MESSAGE_ID,
        parentId: TOOL_RESULT_MESSAGE_ID,
        role: 'assistant',
      },
    ]

    expect(replay).toHaveLength(expectedChain.length)
    for (const [index, expected] of expectedChain.entries()) {
      const line = replay[index]!
      expect(line.id).toBe(expected.id)
      expect(line.parentId).toBe(expected.parentId)
      expect(line.message.id).toBe(expected.id)
      expect(line.message.originMessageId).toBe(expected.parentId)
      expect(line.message.role).toBe(expected.role)
      expect(line.message.metadata.sessionId).toBe(SESSION_ID)
    }
    expect(replay.map(line => line.id)).not.toContain(ABANDONED_MESSAGE_ID)
    expect(replay[2]!.message.toolCallId).toBe(TOOL_CALL_ID)
  })

  test('marks only real user messages as conversations in history summaries', async () => {
    const projectDir = join(configDir, 'projects', '-history-eligibility')
    const realUserSessionId = '10000000-0000-4000-8000-000000000010'
    const toolResultSessionId = '10000000-0000-4000-8000-000000000011'
    const metadataSessionId = '10000000-0000-4000-8000-000000000012'
    const writeSession = async (
      sessionId: string,
      entries: Record<string, unknown>[],
    ): Promise<void> => {
      await writeFile(
        join(projectDir, `${sessionId}.jsonl`),
        `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
      )
    }

    await mkdir(projectDir, { recursive: true })
    await writeSession(realUserSessionId, [
      {
        uuid: '10000000-0000-4000-8000-000000000013',
        parentUuid: null,
        isSidechain: false,
        sessionId: realUserSessionId,
        timestamp: '2026-07-11T12:10:00.000Z',
        type: 'user',
        cwd: '/workspace/history-eligibility',
        userType: 'external',
        version: '2.8.1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'A real historical prompt.' }],
        },
      },
    ])
    await writeSession(toolResultSessionId, [
      {
        uuid: '10000000-0000-4000-8000-000000000014',
        parentUuid: null,
        isSidechain: false,
        sessionId: toolResultSessionId,
        timestamp: '2026-07-11T12:11:00.000Z',
        type: 'user',
        cwd: '/workspace/history-eligibility',
        userType: 'external',
        version: '2.8.1',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: TOOL_CALL_ID }],
        },
      },
    ])
    await writeSession(metadataSessionId, [
      {
        type: 'custom-title',
        sessionId: metadataSessionId,
        customTitle: 'Title without conversation',
      },
    ])

    const summaries = await listSessionHistorySummaries(10)
    expect(
      summaries.find(summary => summary.sessionId === realUserSessionId),
    ).toMatchObject({ hasConversation: true })
    expect(
      summaries.find(summary => summary.sessionId === toolResultSessionId),
    ).not.toMatchObject({ hasConversation: true })
    expect(
      summaries.find(summary => summary.sessionId === metadataSessionId),
    ).not.toMatchObject({ hasConversation: true })

    await expect(loadSessionHistorySummary(realUserSessionId)).resolves.toMatchObject({
      hasConversation: true,
    })
    await expect(
      loadSessionHistorySummary(toolResultSessionId),
    ).resolves.not.toMatchObject({ hasConversation: true })
  })
})
