import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkTeamControllerReadiness } from '@/lib/team/controller';

describe('team controller readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns ready when controller exists and required files are complete', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: { agents: [{ id: 'team-controller' }] },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          files: [
            { name: 'AGENTS.md', missing: false, size: 12 },
            { name: 'SOUL.md', missing: false, size: 5 },
            { name: 'TOOLS.md', missing: false, size: 5 },
            { name: 'IDENTITY.md', missing: false, size: 5 },
            { name: 'USER.md', missing: false, size: 5 },
          ],
        },
      });

    const status = await checkTeamControllerReadiness('team-controller');
    expect(status.ready).toBe(true);
  });

  it('returns missing-agent when controller does not exist', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke.mockResolvedValueOnce({
      success: true,
      result: { agents: [{ id: 'a1' }] },
    });

    const status = await checkTeamControllerReadiness('team-controller');
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('missing-agent');
  });

  it('returns agents-md-empty when AGENTS.md has no content', async () => {
    const invoke = vi.mocked(window.electron.ipcRenderer.invoke);
    invoke
      .mockResolvedValueOnce({
        success: true,
        result: { agents: [{ id: 'team-controller' }] },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          files: [
            { name: 'AGENTS.md', missing: false, size: 0 },
            { name: 'SOUL.md', missing: false, size: 5 },
            { name: 'TOOLS.md', missing: false, size: 5 },
            { name: 'IDENTITY.md', missing: false, size: 5 },
            { name: 'USER.md', missing: false, size: 5 },
          ],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        result: {
          file: { content: '   ' },
        },
      });

    const status = await checkTeamControllerReadiness('team-controller');
    expect(status.ready).toBe(false);
    expect(status.reason).toBe('agents-md-empty');
  });
});
