import { describe, it, expect, vi } from 'vitest';
import { fetchLatestAgentOutput } from '@/pages/Teams/lib/output';

describe('team output', () => {
  it('fetches latest assistant message', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: { messages: [{ role: 'assistant', content: 'hello' }] },
    });

    const text = await fetchLatestAgentOutput('agent:a1:team:t1');
    expect(text).toBe('hello');
  });
});
