import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildLineDiff } from '@/lib/line-diff';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents diff and apply', () => {
  beforeEach(() => {
    useSubagentsStore.setState({
      agents: [{ id: 'writer', name: 'Writer', isDefault: false }],
      loading: false,
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
      draftRoleMetadataByAgent: {
        writer: {
          summary: '负责子 agent 行为规范设计与执行流程约束。',
          tags: ['subagent', 'prompt', 'workflow'],
        },
      },
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'gateway:rpc') {
        return { success: true, result: {} };
      }
      if (channel === 'roles:readMetadata') {
        return {
          path: '/tmp/ROLES_METADATA.md',
          content: [
            '# ROLES_METADATA',
            '',
            '```json',
            JSON.stringify({
              version: 1,
              updatedAt: '2026-01-01T00:00:00.000Z',
              roles: [{
                agentId: 'writer',
                name: 'Writer',
                role: 'Writer',
                summary: 'writer handles tasks in its specialty and reports outcomes.',
                tags: [],
                model: 'custom/claude-sonnet-4.5',
                emoji: '🤖',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }],
            }, null, 2),
            '```',
            '',
          ].join('\n'),
        };
      }
      if (channel === 'roles:writeMetadata') {
        return undefined;
      }
      return undefined;
    });

    useSubagentsStore.getState().generatePreviewDiffByFile({
      'AGENTS.md': 'line-1\nline-2',
    });

    expect(invoke).not.toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.files.set',
      expect.anything()
    );

    await useSubagentsStore.getState().applyDraft('writer');

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'agents.files.set',
      {
        agentId: 'writer',
        name: 'AGENTS.md',
        content: 'line-1\nline-3',
      }
    );
    expect(invoke).not.toHaveBeenCalledWith(
      'gateway:rpc',
      'sessions.delete',
      expect.anything()
    );
  });

  it('clears draft/preview and marks apply success after applyDraft', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'gateway:rpc') {
        return { success: true, result: {} };
      }
      if (channel === 'roles:readMetadata') {
        return {
          path: '/tmp/ROLES_METADATA.md',
          content: '# ROLES_METADATA\n\n```json\n{"version":1,"updatedAt":"2026-01-01T00:00:00.000Z","roles":[]}\n```\n',
        };
      }
      return undefined;
    });

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
    expect(state.draftRoleMetadataByAgent.writer).toBeUndefined();
  });

  it('writes role metadata from draft summary/tags instead of default summary', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const defaultSummary = 'writer handles tasks in its specialty and reports outcomes.';
    const draftSummary = '负责子 agent 行为规范设计与执行流程约束。';
    invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
      if (channel === 'gateway:rpc') {
        return { success: true, result: {} };
      }
      if (channel === 'roles:readMetadata') {
        return {
          path: '/tmp/ROLES_METADATA.md',
          content: [
            '# ROLES_METADATA',
            '',
            '```json',
            JSON.stringify({
              version: 1,
              updatedAt: '2026-01-01T00:00:00.000Z',
              roles: [{
                agentId: 'writer',
                name: 'Writer',
                role: 'Writer',
                summary: defaultSummary,
                tags: [],
                model: 'custom/claude-sonnet-4.5',
                emoji: '🤖',
                updatedAt: '2026-01-01T00:00:00.000Z',
              }],
            }, null, 2),
            '```',
            '',
          ].join('\n'),
        };
      }
      if (channel === 'roles:writeMetadata') {
        return undefined;
      }
      return undefined;
    });

    await useSubagentsStore.getState().applyDraft('writer');

    const writeCall = invoke.mock.calls.find((call) => call[0] === 'roles:writeMetadata');
    expect(writeCall).toBeTruthy();
    const payload = writeCall?.[1] as { rootDir: string; content: string } | undefined;
    expect(payload?.content).toContain(draftSummary);
    expect(payload?.content).toContain('"tags": [');
    expect(payload?.content).toContain('"subagent"');
    expect(payload?.content).not.toContain(defaultSummary);
  });

  it('deletes session and clears draft when cancelDraft is called', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValue({ success: true, result: {} });

    await useSubagentsStore.getState().cancelDraft('writer');

    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'sessions.delete',
      {
        key: 'agent:writer:subagent-draft-123',
        deleteTranscript: true,
      }
    );
    const state = useSubagentsStore.getState();
    expect(state.draftByFile).toEqual({});
    expect(state.previewDiffByFile).toEqual({});
    expect(state.draftSessionKeyByAgent.writer).toBeUndefined();
    expect(state.draftPromptByAgent.writer).toBeUndefined();
  });
});
