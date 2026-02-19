import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubagentsStore } from '@/stores/subagents';

describe('subagents prompt pipeline', () => {
  beforeEach(() => {
    useSubagentsStore.setState({
      agents: [{ id: 'writer', name: 'Writer', isDefault: false }],
      loading: false,
      error: null,
      managedAgentId: null,
      draftPromptByAgent: {},
      draftGeneratingByAgent: {},
      draftApplyingByAgent: {},
      draftApplySuccessByAgent: {},
      draftSessionKeyByAgent: {},
      // writer 默认标记为“已加载但当前为空”，避免无关用例走基线加载分支
      persistedFilesByAgent: { writer: {} },
      selectedAgentId: 'writer',
      loadAgents: vi.fn().mockResolvedValue(undefined),
      selectAgent: vi.fn(),
    });
  });

  it('builds structured prompt, calls chat.send once, and parses draftByFile', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: JSON.stringify({
          files: [
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
          ],
        }),
      },
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '帮我生成子agent规则');

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      'gateway:rpc',
      'chat.send',
      expect.objectContaining({
        sessionKey: expect.stringContaining('subagent-draft'),
        message: expect.stringContaining('AGENTS.md'),
        idempotencyKey: expect.any(String),
      }),
      expect.any(Number)
    );
    expect(invoke.mock.calls[0]?.[2]).not.toHaveProperty('system');
    const sentMessage = String((invoke.mock.calls[0]?.[2] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('迭代规则（系统自动附加）：');
    expect(sentMessage).toContain('始终在同一会话中，基于上一版草稿继续迭代优化。');
    expect(sentMessage).toContain('输出格式必须始终为 JSON 的 files 数组');

    const draft = useSubagentsStore.getState().draftByFile;
    expect(draft['AGENTS.md']?.content).toBe('global rules');
    expect(draft['AGENTS.md']?.needsReview).toBe(false);
    expect(draft['USER.md']?.needsReview).toBe(true);
    expect(useSubagentsStore.getState().draftSessionKeyByAgent.writer).toContain('subagent-draft');
  });

  it('returns explicit error when model output is invalid JSON', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: 'not-json',
      },
    });

    await expect(
      useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案')
    ).rejects.toThrow('Invalid JSON output from model');
  });

  it('parses draft JSON wrapped in markdown code fence', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: [
          '以下是草稿：',
          '```json',
          JSON.stringify({
            files: [
              {
                name: 'AGENTS.md',
                content: 'wrapped rules',
                reason: 'wrapped output',
                confidence: 0.8,
              },
            ],
          }),
          '```',
        ].join('\n'),
      },
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案');

    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('wrapped rules');
  });

  it('returns explicit error when output contains non-target file', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: JSON.stringify({
          files: [
            {
              name: 'MEMORY.md',
              content: 'should fail',
              reason: 'invalid target',
              confidence: 0.9,
            },
          ],
        }),
      },
    });

    await expect(
      useSubagentsStore.getState().generateDraftFromPrompt('writer', '生成草案')
    ).rejects.toThrow('Unsupported target file: MEMORY.md');
  });

  it('falls back to chat.history polling when chat.send returns run status only', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: {
          runId: 'run-123',
          status: 'started',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          runId: 'run-123',
          status: 'completed',
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    files: [
                      {
                        name: 'AGENTS.md',
                        content: 'rules from history',
                        reason: 'history fallback',
                        confidence: 0.88,
                      },
                    ],
                  }),
                },
              ],
            },
          ],
        },
      });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'generate config');

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'gateway:rpc',
      'agent.wait',
      expect.objectContaining({
        runId: 'run-123',
      }),
      expect.any(Number)
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      'gateway:rpc',
      'chat.history',
      expect.objectContaining({
        sessionKey: expect.stringContaining('subagent-draft'),
        limit: 20,
      })
    );
    expect(useSubagentsStore.getState().draftByFile['AGENTS.md']?.content).toBe('rules from history');
  });

  it('rejects duplicate draft generation while same agent run is in-flight', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    let resolveFirst: ((value: unknown) => void) | undefined;
    invoke
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({
        success: true,
        result: {
          output: JSON.stringify({
            files: [
              {
                name: 'AGENTS.md',
                content: 'second response',
                reason: 'unused',
                confidence: 0.8,
              },
            ],
          }),
        },
      });

    const firstRun = useSubagentsStore.getState().generateDraftFromPrompt('writer', 'first prompt');
    await Promise.resolve();

    await expect(
      useSubagentsStore.getState().generateDraftFromPrompt('writer', 'second prompt')
    ).rejects.toThrow('Draft generation already in progress for this agent');
    expect(invoke).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      success: true,
      result: {
        output: JSON.stringify({
          files: [
            {
              name: 'AGENTS.md',
              content: 'first response',
              reason: 'first run',
              confidence: 0.9,
            },
          ],
        }),
      },
    });
    await firstRun;
  });

  it('reuses the same draft session for sequential generations', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    let sendCount = 0;
    invoke.mockImplementation(async (_, method) => {
      if (method === 'chat.send') {
        sendCount += 1;
        return {
          success: true,
          result: {
            output: JSON.stringify({
              files: [
                {
                  name: 'AGENTS.md',
                  content: sendCount === 1 ? 'first response' : 'second response',
                  reason: sendCount === 1 ? 'first run' : 'second run',
                  confidence: 0.9,
                },
              ],
            }),
          },
        };
      }
      if (method === 'chat.history') {
        return {
          success: true,
          result: {
            messages: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      files: [
                        {
                          name: 'AGENTS.md',
                          content: 'history response',
                          reason: 'history fallback',
                          confidence: 0.9,
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          },
        };
      }
      return { success: true, result: {} };
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'first prompt');
    const firstSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'second prompt');
    const secondSessionKey = useSubagentsStore.getState().draftSessionKeyByAgent.writer;

    expect(firstSessionKey).toBe('agent:writer:subagent-draft');
    expect(secondSessionKey).toBe(firstSessionKey);
    expect(invoke).not.toHaveBeenCalledWith(
      'gateway:rpc',
      'sessions.delete',
      expect.anything()
    );
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: JSON.stringify({
          files: [
            {
              name: 'AGENTS.md',
              content: 'refined from saved baseline',
              reason: 'baseline refine',
              confidence: 0.9,
            },
          ],
        }),
      },
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '继续优化');

    const sentMessage = String((invoke.mock.calls[0]?.[2] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).toContain('当前已落盘文件内容（作为本轮基线）:');
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
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: {
        output: JSON.stringify({
          files: [
            {
              name: 'AGENTS.md',
              content: 'iterated content',
              reason: 'iterative turn',
              confidence: 0.9,
            },
          ],
        }),
      },
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', '继续润色');

    const sentMessage = String((invoke.mock.calls[0]?.[2] as { message?: unknown } | undefined)?.message ?? '');
    expect(sentMessage).not.toContain('当前已落盘文件内容（作为本轮基线）:');
    expect(sentMessage).not.toContain('saved agents baseline');
  });

  it('loads persisted baseline before first generation when baseline is not loaded yet', async () => {
    useSubagentsStore.setState({
      persistedFilesByAgent: {},
    });

    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    const methods: string[] = [];
    invoke.mockImplementation(async (_, method, params) => {
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
      if (method === 'chat.send') {
        const message = String((params as { message?: unknown }).message ?? '');
        expect(message).toContain('### AGENTS.md');
        expect(message).toContain('persisted baseline');
        return {
          success: true,
          result: {
            output: JSON.stringify({
              files: [
                {
                  name: 'AGENTS.md',
                  content: 'generated content',
                  reason: 'first turn with loaded baseline',
                  confidence: 0.9,
                },
              ],
            }),
          },
        };
      }
      throw new Error(`Unexpected rpc method in test: ${String(method)}`);
    });

    await useSubagentsStore.getState().generateDraftFromPrompt('writer', 'baseline race test');

    expect(methods.filter((item) => item === 'agents.files.get')).toHaveLength(5);
    expect(methods.at(-1)).toBe('chat.send');
    expect(useSubagentsStore.getState().persistedFilesByAgent.writer).toBeTruthy();
  });
});
