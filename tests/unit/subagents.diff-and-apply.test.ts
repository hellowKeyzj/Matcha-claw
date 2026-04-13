import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLineDiff } from '@/lib/line-diff';
import { gatewayClientRpcMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

import { useSubagentsStore } from '@/stores/subagents';

describe('subagents diff and apply', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    useSubagentsStore.setState({
      agents: [{ id: 'writer', name: 'Writer', isDefault: false }],
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      error: null,
      managedAgentId: 'writer',
      draftPromptByAgent: { writer: 'old prompt' },
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
      draftSessionKeyByAgent: {
        writer: 'agent:writer:subagent-draft-123',
      },
      draftRawOutputByAgent: {},
      persistedFilesByAgent: {
        writer: {
          'AGENTS.md': 'line-1\nline-2',
        },
      },
      selectedAgentId: 'writer',
      loadAgents: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
      draftByFile: {
        'AGENTS.md': {
          name: 'AGENTS.md',
          content: 'line-1\nline-3',
          reason: 'refine behavior',
          confidence: 0.9,
          needsReview: false,
        },
      },
      draftError: null,
      previewDiffByFile: {},
    });
  });

  it('builds line-level diff (add/remove/keep)', () => {
    const diff = buildLineDiff('line-1\nline-2', 'line-1\nline-3');
    expect(diff).toEqual([
      { type: 'keep', value: 'line-1' },
      { type: 'remove', value: 'line-2' },
      { type: 'add', value: 'line-3' },
    ]);
  });

  it('does not call agents.files.set until applyDraft is confirmed', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockResolvedValue({ success: true, result: {} });

    useSubagentsStore.getState().generatePreviewDiffByFile({
      'AGENTS.md': 'line-1\nline-2',
    });

    expect(rpc).not.toHaveBeenCalledWith(
      'agents.files.set',
      expect.anything()
    );

    await useSubagentsStore.getState().applyDraft('writer');

    expect(rpc).toHaveBeenCalledWith(
      'agents.files.set',
      {
        agentId: 'writer',
        name: 'AGENTS.md',
        content: 'line-1\nline-3',
      },
      undefined,
    );
    expect(rpc).not.toHaveBeenCalledWith(
      'sessions.delete',
      expect.anything()
    );
  });

  it('clears draft/preview and marks apply success after applyDraft', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockResolvedValue({ success: true, result: {} });

    useSubagentsStore.getState().generatePreviewDiffByFile({
      'AGENTS.md': 'line-1\nline-2',
    });
    await useSubagentsStore.getState().applyDraft('writer');

    const state = useSubagentsStore.getState();
    expect(state.draftByFile).toEqual({});
    expect(state.previewDiffByFile).toEqual({});
    expect(state.draftError).toBeNull();
    expect(state.draftApplySuccessByAgent.writer).toBe(true);
    expect(state.draftSessionKeyByAgent.writer).toBe('agent:writer:subagent-draft-123');
  });

  it('deletes session and clears draft when cancelDraft is called', async () => {
    const rpc = gatewayClientRpcMock;
    rpc.mockResolvedValue({ success: true, result: {} });

    await useSubagentsStore.getState().cancelDraft('writer');

    expect(rpc).toHaveBeenCalledWith(
      'sessions.delete',
      {
        key: 'agent:writer:subagent-draft-123',
        deleteTranscript: true,
      },
      undefined,
    );
    const state = useSubagentsStore.getState();
    expect(state.draftByFile).toEqual({});
    expect(state.previewDiffByFile).toEqual({});
    expect(state.draftSessionKeyByAgent.writer).toBeUndefined();
    expect(state.draftPromptByAgent.writer).toBeUndefined();
  });
});
