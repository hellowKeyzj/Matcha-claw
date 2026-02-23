import { describe, it, expect, vi } from 'vitest';
import { runAgentAndCollectReport } from '@/pages/Teams/lib/orchestrator';

describe('team orchestrator', () => {
  it('runs agent, waits, and parses report', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({ success: true, result: { runId: 'r1', status: 'accepted' } })
      .mockResolvedValueOnce({ success: true, result: { runId: 'r1', status: 'ok' } })
      .mockResolvedValueOnce({ success: true, result: { messages: [{ role: 'assistant', content: 'REPORT: {"reportId":"r1","task_id":"t1","agent_id":"a1","status":"done","result":["x"]}' }] } });

    const report = await runAgentAndCollectReport({
      agentId: 'a1',
      sessionKey: 'agent:a1:team-1',
      message: 'do task',
      idempotencyKey: 'k1',
    });

    expect(report?.status).toBe('done');
  });
});
