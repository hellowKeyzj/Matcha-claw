import { describe, expect, it, vi } from 'vitest';
import { RunSessionService } from '@electron/core/application';

describe('run session service', () => {
  it('assembles context then delegates runtime execute', async () => {
    const assembler = {
      assemble: vi.fn().mockResolvedValue({
        sessionId: 's1',
        systemPrompt: '',
        resourceBindings: [],
        enabledTools: [],
        platformCredentials: {},
      }),
    };
    const runtime = {
      execute: vi.fn().mockResolvedValue('run-1'),
    };
    const eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
    const auditSink = { append: vi.fn().mockResolvedValue(undefined) };

    const service = new RunSessionService(
      assembler as never,
      runtime as never,
      eventBus as never,
      auditSink as never,
    );

    const runId = await service.start({ sessionId: 's1' });
    expect(runId).toBe('run-1');
    expect(assembler.assemble).toHaveBeenCalledTimes(1);
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(auditSink.append).toHaveBeenCalledTimes(1);
  });
});
