import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayClientRpcMock,
  hostSessionDeleteMock,
  hostSessionPromptMock,
  hostSessionWindowFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';
import { useSubagentsStore } from '@/stores/subagents';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildDraftOutput(
  files: Array<{ name: string; content: string; reason: string; confidence: number }>,
): string {
  return JSON.stringify({
    files,
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
        sending: false,
        activeRunId: null,
        runPhase: 'done' as const,
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        pendingFinal: false,
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
      promptId: 'prompt-1',
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

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '帮我生成子agent规则');

    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);
    expect(hostSessionPromptMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('subagent-draft'),
      message: expect.stringContaining('AGENTS.md'),
      idempotencyKey: expect.any(String),
      promptId: expect.any(String),
      deliver: false,
    }));
    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md');
    expect(sentMessage).toContain('"files":[{"name","content","reason","confidence"}]');
    expect(sentMessage).toContain('JSON');

    const draft = useSubagentsStore.getState().draftByFile;
    expect(draft['AGENTS.md']?.content).toBe('global rules');
    expect(draft['AGENTS.md']?.needsReview).toBe(false);
    expect(draft['USER.md']?.needsReview).toBe(true);
    expect(useSubagentsStore.getState().draftSessionKeyByAgent.writer).toContain('subagent-draft');
  });

  it('returns explicit error when model output is invalid JSON', async () => {
    hostSessionPromptMock
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
        promptId: 'prompt-1',
      })
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
        promptId: 'prompt-2',
      });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildHistoryWindow('not-json'))
      .mockResolvedValueOnce(buildHistoryWindow('not-json'));

    await expect(
      useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案'),
    ).rejects.toThrow('Invalid JSON output from model');
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(2);
    expect(useSubagentsStore.getState().draftRawOutputByAgent.writer).toBe('not-json');
  });

  it('parses draft JSON wrapped in markdown code fence', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
      promptId: 'prompt-1',
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow([
      '以下是草稿：',
      '```json',
      JSON.stringify({
        files: [{
          name: 'AGENTS.md',
          content: 'wrapped rules',
          reason: 'wrapped output',
          confidence: 0.8,
        }],
      }),
      '```',
    ].join('\n')));

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案');

    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('wrapped rules');
  });

  it('returns explicit error when output contains non-target file', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
      promptId: 'prompt-1',
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
      useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案'),
    ).rejects.toThrow('Unsupported target file: MEMORY.md');
  });

  it('falls back to session transcript polling when session.prompt returns runId only', async () => {
    hostSessionPromptMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: 'run-123',
      promptId: 'prompt-1',
    });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce({
        snapshot: {
          sessionKey: 'agent:writer:subagent-draft',
          items: [],
          replayComplete: true,
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'done' as const,
            activeTurnItemKey: null,
            pendingTurnKey: null,
            pendingTurnLaneKey: null,
            pendingFinal: false,
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
    gatewayClientRpcMock.mockImplementation(async (method) => {
      if (method === 'agent.wait') {
        return {
          success: true,
          result: {
            runId: 'run-123',
            status: 'completed',
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'generate config');

    expect(gatewayClientRpcMock).toHaveBeenCalledWith(
      'agent.wait',
      expect.objectContaining({
        runId: 'run-123',
      }),
      expect.any(Number),
    );
    expect(hostSessionWindowFetchMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('subagent-draft'),
      limit: 20,
      mode: 'latest',
      includeCanonical: true,
    }));
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('rules from history');
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

    const firstRun = useSubagentsStore.getState().generateDraftFromPrompt('writer', 'first prompt');
    await Promise.resolve();

    await expect(
      useSubagentsStore.getState().generateDraftFromPrompt('writer', 'second prompt'),
    ).rejects.toThrow('Draft generation already in progress for this agent');
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      success: true,
      sessionKey: 'agent:writer:subagent-draft',
      runId: null,
      promptId: 'prompt-1',
    });
    await firstRun;
  });

  it('reuses the same draft session for sequential generations', async () => {
    hostSessionPromptMock
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
        promptId: 'prompt-1',
      })
      .mockResolvedValueOnce({
        success: true,
        sessionKey: 'agent:writer:subagent-draft',
        runId: null,
        promptId: 'prompt-2',
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

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'first prompt');
    const firstSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'second prompt');
    const secondSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    expect(firstSessionKey).toBe('agent:writer:subagent-draft');
    expect(secondSessionKey).toBe(firstSessionKey);
    expect(hostSessionDeleteMock).not.toHaveBeenCalled();
  });

  it('uses persisted files as non-initial baseline context', async () => {
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
      promptId: 'prompt-1',
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'refined from saved baseline',
        reason: 'baseline refine',
        confidence: 0.9,
      },
    ])));

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '继续优化');

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
      promptId: 'prompt-1',
    });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'iterated content',
        reason: 'iterative turn',
        confidence: 0.9,
      },
    ])));

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '继续润色');

    const sentMessage = String((hostSessionPromptMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).not.toContain('### SOUL.md');
    expect(sentMessage).not.toContain('saved agents baseline');
  });

  it('loads persisted baseline before first generation when baseline is not loaded yet', async () => {
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
        promptId: 'prompt-1',
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

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'baseline race test');

    expect(methods.filter((item) => item === 'agents.files.get')).toHaveLength(5);
    expect(hostSessionPromptMock).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().persistedFilesByAgent.writer).toBeTruthy();
  });
});
