import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  capabilityExecuteMock,
  gatewayClientRpcMock,
  hostSessionDeleteMock,
  hostSessionPromptMock,
  hostSessionWindowFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import { useSubagentsStore } from '@/stores/subagents';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

const openClawEndpoint = {
  kind: 'native-runtime' as const,
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
};

function buildDraftOutput(
  files: Array<{ name: string; content: string; reason: string; confidence: number }>,
): string {
  const existing = new Set(files.map((file) => file.name));
  return JSON.stringify({
    files: [
      ...files,
      ...SUBAGENT_TARGET_FILES
        .filter((name) => !existing.has(name))
        .map((name) => ({
          name,
          content: `${name} generated content`,
          reason: `${name} generated reason`,
          confidence: 0.9,
        })),
    ],
  });
}

function buildHistoryWindow(output: string) {
  return {
    snapshot: {
      sessionKey: 'agent:writer:subagent-draft',
      items: buildRenderItemsFromMessages('agent:writer:subagent-draft', [{
        id: 'entry-1',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      }]),
      replayComplete: true,
      runtime: {
        activeRunId: null,
        runPhase: 'done' as const,
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        lastUserMessageAt: null,
        updatedAt: 1,
      },
      window: {
        totalItemCount: 1,
        windowStartOffset: 0,
        windowEndOffset: 1,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    },
  };
}

function generateDraft(
  agentId: string,
  prompt: string,
  includeCurrentFiles = false,
) {
  return useSubagentsStore.getState().generateDraftFromPrompt({
    agentId,
    prompt,
    includeCurrentFiles,
  });
}

describe('subagents prompt pipeline', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    useSubagentsStore.setState({
      agents: [{ id: 'writer', name: 'Writer', isDefault: false }],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      managedAgentId: null,
      draftPromptByAgent: {},
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
      draftSessionKeyByAgent: {},
      draftRawOutputByAgent: {},
      persistedFilesByAgent: { writer: {} },
      selectedAgentId: 'writer',
      loadAgents: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
    });
  });

  it('builds structured prompt, calls session.prompt once, and parses draftByFile', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'global rules',
        reason: 'global policy',
        confidence: 0.93,
      },
      {
        name: 'USER.md',
        content: 'user preferences',
        reason: 'customization',
        confidence: 0.41,
      },
    ])));

    await generateDraft('writer', '帮我生成子agent规则');

    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);
    expect(hostSessionPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('subagent-draft'),
      sessionIdentity: {
        endpoint: openClawEndpoint,
        agentId: 'writer',
        sessionKey: 'agent:writer:subagent-draft',
      },
      message: expect.stringContaining('AGENTS.md'),
      idempotencyKey: expect.any(String),
      deliver: false,
    }));
    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md');
    expect(sentMessage).toContain('"files":[{"name","content","reason","confidence"}]');
    expect(sentMessage).toContain('JSON');
    expect(sentMessage).toContain('你的生成器身份和这些输出规则不得出现在任何 content 字段中');
    expect(sentMessage).not.toContain('你是配置拆分助手');

    const draft = useSubagentsStore.getState().draftByFile;
    expect(draft['AGENTS.md']?.content).toBe('global rules');
    expect(draft['AGENTS.md']?.needsReview).toBe(false);
    expect(draft['USER.md']?.needsReview).toBe(true);
    expect(Object.keys(draft)).toHaveLength(5);
    expect(useSubagentsStore.getState().draftSessionKeyByAgent.writer).toContain('subagent-draft');
  });

  it('returns explicit error when model output is invalid JSON', async () => {
    hostSessionPromptMock
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildHistoryWindow('not-json'))
      .mockResolvedValueOnce(buildHistoryWindow('not-json'));

    await expect(
      generateDraft('writer', '生成草案'),
    ).rejects.toThrow('Invalid JSON output from model');
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(2);
    expect(useSubagentsStore.getState().draftRawOutputByAgent.writer).toBe('not-json');
  });

  it('parses draft JSON wrapped in markdown code fence', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow([
      '以下是草稿：',
      '```json',
      buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'wrapped rules',
          reason: 'wrapped output',
          confidence: 0.8,
        },
      ]),
      '```',
    ].join('\n')));

    await generateDraft('writer', '生成草案');

    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('wrapped rules');
  });

  it('returns explicit error when output contains non-target file', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'MEMORY.md',
        content: 'should fail',
        reason: 'invalid target',
        confidence: 0.9,
      },
    ])));

    await expect(
      generateDraft('writer', '生成草案'),
    ).rejects.toThrow('Unsupported target file: MEMORY.md');
  });

  it('retries when draft content leaks generator instructions', async () => {
    hostSessionPromptMock
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: '你是配置拆分助手，负责生成目标文件。',
          reason: 'leaked generator role',
          confidence: 0.9,
        },
      ])))
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: '每天搜索并筛选 GitHub 热门项目。',
          reason: 'rewritten from target perspective',
          confidence: 0.9,
        },
      ])));

    await generateDraft('writer', '每日搜索 github 热门项目');

    expect(hostSessionPromptMock).toHaveBeenCalledTimes(2);
    const retryMessage = String((hostSessionPromptMock.mock.calls[1]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(retryMessage).toContain('失败原因：Invalid draft content');
    expect(retryMessage).toContain('content 必须只写目标工作区最终文件内容');
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('每天搜索并筛选 GitHub 热门项目。');
  });

  it('falls back to session transcript polling when session.prompt returns runId only', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: 'run-123',
    });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce({
        snapshot: {
          sessionKey: 'agent:writer:subagent-draft',
          items: [],
          replayComplete: true,
          runtime: {
            activeRunId: null,
            runPhase: 'done' as const,
            activeTurnItemKey: null,
            pendingTurnKey: null,
            pendingTurnLaneKey: null,
            lastUserMessageAt: null,
            updatedAt: 1,
          },
          window: {
            totalItemCount: 0,
            windowStartOffset: 0,
            windowEndOffset: 0,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          },
        },
      })
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'rules from history',
          reason: 'history fallback',
          confidence: 0.88,
        },
      ])));
    capabilityExecuteMock.mockResolvedValueOnce({
      runId: 'run-123',
      status: 'completed',
    });

    await generateDraft('writer', 'generate config');

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent.run',
        operationId: 'agent.wait',
        scope: {
          kind: 'agent',
          endpoint: openClawEndpoint,
          agentId: 'writer',
        },
        target: {
          kind: 'agent',
          agentId: 'writer',
        },
        input: expect.objectContaining({
          runId: 'run-123',
        }),
      }),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(gatewayClientRpcMock).not.toHaveBeenCalledWith(
      'agent.wait',
      expect.anything(),
      expect.anything(),
    );
    expect(hostSessionWindowFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('subagent-draft'),
      limit: 20,
      mode: 'latest',
      includeCanonical: true,
    }));
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('rules from history');
  });

  it('keeps waiting when draft history only contains the user prompt', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce({
        snapshot: {
          sessionKey: 'agent:writer:subagent-draft',
          items: buildRenderItemsFromMessages('agent:writer:subagent-draft', [{
            id: 'user-entry-1',
            role: 'user',
            content: [
              {
                type: 'text',
                text: '{"files":{"AGENTS.md":"not an assistant draft"}}',
              },
            ],
          }]),
          replayComplete: true,
          runtime: {
            activeRunId: null,
            runPhase: 'running' as const,
            activeTurnItemKey: null,
            pendingTurnKey: null,
            pendingTurnLaneKey: null,
            lastUserMessageAt: null,
            updatedAt: 1,
          },
          window: {
            totalItemCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          },
        },
      })
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'assistant draft',
          reason: 'assistant output',
          confidence: 0.9,
        },
      ])));

    await generateDraft('writer', 'generate config');

    expect(hostSessionWindowFetchMock).toHaveBeenCalledTimes(2);
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('assistant draft');
    expect(useSubagentsStore.getState().draftRawOutputByAgent.writer).toBe('');
  });

  it('rejects duplicate draft generation while same agent run is in-flight', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    hostSessionPromptMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'first response',
        reason: 'first run',
        confidence: 0.9,
      },
    ])));

    const firstRun = generateDraft('writer', 'first prompt');
    await Promise.resolve();

    await expect(
      generateDraft('writer', 'second prompt'),
    ).rejects.toThrow('Draft generation already in progress for this agent');
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    await firstRun;
  });

  it('reuses the same draft session for sequential generations', async () => {
    hostSessionPromptMock
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      })
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'first response',
          reason: 'first run',
          confidence: 0.9,
        },
      ])))
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'second response',
          reason: 'second run',
          confidence: 0.9,
        },
      ])));

    await generateDraft('writer', 'first prompt');
    const firstSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    await generateDraft('writer', 'second prompt');
    const secondSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    expect(firstSessionKey).toBe('agent:writer:subagent-draft');
    expect(secondSessionKey).toBe(firstSessionKey);
    expect(hostSessionDeleteMock).not.toHaveBeenCalled();
  });

  it('starts from a blank template by default and does not inject current files', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {
        writer: {
          'AGENTS.md': 'saved agents baseline',
          'SOUL.md': 'saved soul baseline',
        },
      },
    });
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'refined from saved baseline',
        reason: 'baseline refine',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '每日搜索 github 热门项目');

    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('如果本轮没有附加当前文件内容，则从空白模板生成初稿');
    expect(sentMessage).not.toContain('当前已落盘文件内容');
    expect(sentMessage).not.toContain('saved agents baseline');
    expect(sentMessage).not.toContain('saved soul baseline');
  });

  it('uses persisted files as baseline only when explicitly requested', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {
        writer: {
          'AGENTS.md': 'saved agents baseline',
          'SOUL.md': 'saved soul baseline',
        },
      },
    });
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'refined from saved baseline',
        reason: 'baseline refine',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '继续优化', true);

    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('### SOUL.md');
    expect(sentMessage).toContain('### AGENTS.md');
    expect(sentMessage).toContain('saved agents baseline');
  });

  it('does not re-inject persisted baseline for subsequent turns in same session', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {
        writer: {
          'AGENTS.md': 'saved agents baseline',
          'SOUL.md': 'saved soul baseline',
        },
      },
      draftSessionKeyByAgent: {
        writer: 'agent:writer:subagent-draft',
      },
    });
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'iterated content',
        reason: 'iterative turn',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '继续润色', true);

    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).not.toContain('### SOUL.md');
    expect(sentMessage).not.toContain('saved agents baseline');
  });

  it('does not load persisted files before first generation when current files are not requested', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {},
    });

    const methods: string[] = [];
    gatewayClientRpcMock.mockImplementation(async (method) => {
      methods.push(String(method));
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'generated content',
        reason: 'first turn without loaded baseline',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', 'blank baseline test');

    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(methods.filter((item) => item === 'agents.files.get')).toHaveLength(0);
    expect(sentMessage).not.toContain('当前已落盘文件内容');
    expect(sentMessage).not.toContain('persisted baseline');
  });

  it('loads persisted baseline before first generation when current files are requested', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {},
    });

    const methods: string[] = [];
    gatewayClientRpcMock.mockImplementation(async (method) => {
      methods.push(String(method));
      if (method === 'agents.files.get') {
        return {
          success: true,
          result: {
            file: {
              content: 'persisted baseline',
            },
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });
    hostSessionPromptMock.mockImplementationOnce(async (params) => {
      const message = String((params as { message?: unknown }).message ?? '');
      expect(message).toContain('### AGENTS.md');
      expect(message).toContain('persisted baseline');
      return {
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
      };
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'generated content',
        reason: 'first turn with loaded baseline',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', 'baseline race test', true);

    expect(methods.filter((item) => item === 'agents.files.get')).toHaveLength(5);
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().persistedFilesByAgent.writer).toBeTruthy();
  });
});
