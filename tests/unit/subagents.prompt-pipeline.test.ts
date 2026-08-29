import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  gatewayClientRpcMock,
  hostSessionNewMock,
  hostSessionSendMock,
  hostSessionWindowFetchMock,
  resetGatewayClientMocks,
} from './helpers/mock-gateway-client';
import { SUBAGENT_TARGET_FILES } from '@/constants/subagent-files';
import { __resetSubagentsStoreInternalCachesForTest, useSubagentsStore } from '@/stores/subagents';
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

function buildSessionView(sessionKey = 'agent:writer:subagent-draft') {
  return {
    sessionKey,
    endpointSessionId: 'subagent-draft',
    identity: {
      endpoint: openClawEndpoint,
      agentId: 'writer',
      sessionKey,
    },
    epoch: 1,
    seq: 0,
    cursor: 0,
    items: { complete: [] },
    tools: { complete: [] },
    approvals: { complete: [] },
    runtime: { complete: { phase: 'completed', activeRunId: null, issue: null } },
    window: { complete: {
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    } },
    completeness: 'complete',
  };
}

function buildHistoryWindow(output: string) {
  return {
    ...buildSessionView(),
    cursor: 1,
    items: { complete: [{
      kind: 'assistantTurn' as const,
      itemId: 'entry-1',
      runId: null,
      messageId: 'entry-1',
      status: 'final' as const,
      segments: [{ kind: 'text' as const, text: output }],
      text: output,
    }] },
    window: { complete: {
      totalItemCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    } },
  };
}

function buildUserPromptHistoryWindow(text: string) {
  return {
    ...buildSessionView(),
    cursor: 1,
    items: { complete: [{
      kind: 'userMessage' as const,
      itemId: 'user-entry-1',
      messageId: 'user-entry-1',
      text,
      content: [{ kind: 'text' as const, text }],
      status: 'final' as const,
    }] },
    window: { complete: {
      totalItemCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    } },
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
    __resetSubagentsStoreInternalCachesForTest();
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
      draftSessionTargetByAgent: {},
      draftRawOutputByAgent: {},
      persistedFilesByAgent: { writer: {} },
      selectedAgentId: 'writer',
      loadAgents: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
    });
    hostSessionNewMock.mockResolvedValue(buildSessionView());
  });

  it('builds structured prompt, calls session.prompt once, and parses draftByFile', async () => {
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
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

    expect(hostSessionSendMock).toHaveBeenCalledTimes(1);
    expect(hostSessionSendMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: expect.stringContaining('subagent-draft'),
      endpointSessionId: 'subagent-draft',
      sessionIdentity: {
        endpoint: openClawEndpoint,
        agentId: 'writer',
        sessionKey: 'agent:writer:subagent-draft',
      },
      message: expect.stringContaining('AGENTS.md'),
      idempotencyKey: expect.any(String),
      deliver: false,
    }), undefined);
    const sentMessage = String((hostSessionSendMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
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
    expect(useSubagentsStore.getState().draftSessionTargetByAgent.writer?.sessionKey).toContain('subagent-draft');
  });

  it('returns explicit error when model output is invalid JSON', async () => {
    hostSessionSendMock
      .mockResolvedValueOnce({ outcome: 'succeeded' })
      .mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildHistoryWindow('not-json'))
      .mockResolvedValueOnce(buildHistoryWindow('not-json'));

    await expect(
      generateDraft('writer', '生成草案'),
    ).rejects.toThrow('Invalid JSON output from model');
    expect(hostSessionSendMock).toHaveBeenCalledTimes(2);
    expect(useSubagentsStore.getState().draftRawOutputByAgent.writer).toBe('not-json');
  });

  it('parses draft JSON wrapped in markdown code fence', async () => {
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
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
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
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
    hostSessionSendMock
      .mockResolvedValueOnce({ outcome: 'succeeded' })
      .mockResolvedValueOnce({ outcome: 'succeeded' });
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

    expect(hostSessionSendMock).toHaveBeenCalledTimes(2);
    const retryMessage = String((hostSessionSendMock.mock.calls[1]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(retryMessage).toContain('失败原因：Invalid draft content');
    expect(retryMessage).toContain('content 必须只写目标工作区最终文件内容');
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('每天搜索并筛选 GitHub 热门项目。');
  });

  it('falls back to session transcript polling when session.prompt returns runId only', async () => {
    hostSessionSendMock.mockResolvedValueOnce({
      outcome: 'succeeded',
      runId: 'run-123',
      status: 'started',
    });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildSessionView())
      .mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
        {
          name: 'AGENTS.md',
          content: 'rules from history',
          reason: 'history fallback',
          confidence: 0.88,
        },
      ])));
    gatewayClientRpcMock.mockResolvedValueOnce({
      runId: 'run-123',
      status: 'completed',
    });

    await generateDraft('writer', 'generate config');

    expect(gatewayClientRpcMock).toHaveBeenCalledWith(
      'agent.wait',
      expect.objectContaining({
        kind: 'draftWait',
        endpoint: openClawEndpoint,
        agentId: 'writer',
        runId: 'run-123',
        waitSliceMs: 30_000,
        rpcTimeoutBufferMs: 10_000,
      }),
      40_000,
    );
    expect(hostSessionWindowFetchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: expect.stringContaining('subagent-draft'),
        endpointSessionId: 'subagent-draft',
        limit: 20,
        mode: 'latest',
      }),
      undefined,
    );
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('rules from history');
  });

  it('keeps waiting when draft history only contains the user prompt', async () => {
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock
      .mockResolvedValueOnce(buildUserPromptHistoryWindow('{"files":{"AGENTS.md":"not an assistant draft"}}'))
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
    hostSessionSendMock.mockImplementationOnce(() => new Promise((resolve) => {
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
    expect(hostSessionSendMock).toHaveBeenCalledTimes(1);

    resolveFirst?.({ outcome: 'succeeded' });
    await firstRun;
  });

  it('reuses the same draft session for sequential generations', async () => {
    hostSessionSendMock
      .mockResolvedValueOnce({ outcome: 'succeeded' })
      .mockResolvedValueOnce({ outcome: 'succeeded' });
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
    const firstSessionKey = useSubagentsStore.getState().draftSessionTargetByAgent.writer?.sessionKey;

    await generateDraft('writer', 'second prompt');
    const secondSessionKey = useSubagentsStore.getState().draftSessionTargetByAgent.writer?.sessionKey;

    expect(firstSessionKey).toBe('agent:writer:subagent-draft');
    expect(secondSessionKey).toBe(firstSessionKey);
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
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'refined from saved baseline',
        reason: 'baseline refine',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '每日搜索 github 热门项目');

    const sentMessage = String((hostSessionSendMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
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
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'refined from saved baseline',
        reason: 'baseline refine',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '继续优化', true);

    const sentMessage = String((hostSessionSendMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
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
      draftSessionTargetByAgent: {
        writer: {
          sessionKey: 'agent:writer:subagent-draft',
          endpointSessionId: 'subagent-draft',
          sessionIdentity: {
            endpoint: openClawEndpoint,
            agentId: 'writer',
            sessionKey: 'agent:writer:subagent-draft',
          },
        },
      },
    });
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'iterated content',
        reason: 'iterative turn',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', '继续润色', true);

    const sentMessage = String((hostSessionSendMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
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
    hostSessionSendMock.mockResolvedValueOnce({ outcome: 'succeeded' });
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildHistoryWindow(buildDraftOutput([
      {
        name: 'AGENTS.md',
        content: 'generated content',
        reason: 'first turn without loaded baseline',
        confidence: 0.9,
      },
    ])));

    await generateDraft('writer', 'blank baseline test');

    const sentMessage = String((hostSessionSendMock.mock.calls[0]?.[0] as { message?: unknown } | undefined)?.message ?? '');
    expect(methods.filter((item) => item === 'agents.files.get')).toHaveLength(0);
    expect(sentMessage).not.toContain('当前已落盘文件内容');
    expect(sentMessage).not.toContain('persisted baseline');
  });

  it('uses persisted baseline before first generation when current files are requested', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {
        writer: { 'AGENTS.md': 'persisted baseline' },
      },
    });

    hostSessionSendMock.mockImplementationOnce(async (params) => {
      const message = String((params as { message?: unknown }).message ?? '');
      expect(message).toContain('### AGENTS.md');
      expect(message).toContain('persisted baseline');
      return { outcome: 'succeeded' };
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

    expect(hostSessionSendMock).toHaveBeenCalledTimes(1);
    expect(useSubagentsStore.getState().persistedFilesByAgent.writer).toMatchObject({
      'AGENTS.md': 'persisted baseline',
    });
  });
});
