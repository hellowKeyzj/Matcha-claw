import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('application boundary', () => {
  it('application layer does not import adapters', async () => {
    const files = [
      'runtime-host/application/platform-runtime/runtime-manager-service.ts',
      'runtime-host/application/platform-runtime/run-session-service.ts',
      'runtime-host/application/platform-runtime/tool-catalog-service.ts',
    ];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/adapters\//);
      expect(source).not.toMatch(/gateway\/manager/);
    }
  });

  it('keeps platform run-session orchestration in workflow', async () => {
    const serviceSource = await readFile('runtime-host/application/platform-runtime/run-session-service.ts', 'utf8');
    const workflowSource = await readFile('runtime-host/application/workflows/platform-runtime/platform-run-session-workflow.ts', 'utf8');

    expect(workflowSource).toContain('contextAssembler.assemble');
    expect(workflowSource).toContain('runtimeDriver.execute');
    expect(workflowSource).toContain('eventBus.publish');
    expect(workflowSource).toContain('auditSink.append');
    expect(serviceSource).not.toContain('contextAssembler.assemble');
    expect(serviceSource).not.toContain('runtimeDriver.execute');
    expect(serviceSource).not.toContain('eventBus.publish');
    expect(serviceSource).not.toContain('auditSink.append');
  });
});
