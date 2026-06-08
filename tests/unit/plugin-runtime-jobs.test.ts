import { describe, expect, it, vi } from 'vitest';
import { createPluginRuntimeJobPort, SET_ENABLED_PLUGINS_JOB } from '../../runtime-host/application/plugins/plugin-runtime-jobs';

describe('plugin runtime jobs', () => {
  it('dedupes setEnabled jobs by payload instead of globally', () => {
    const submit = vi.fn((type, payload, options) => ({
      success: true as const,
      job: {
        id: `job-${submit.mock.calls.length}`,
        type,
        queue: 'default',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
        options,
      },
    }));
    const jobs = createPluginRuntimeJobPort({ submit }, { latestByType: () => null });

    jobs.submitSetEnabledPlugins({ pluginIds: ['task-manager'], enabled: true });
    jobs.submitSetEnabledPlugins({ pluginIds: ['team-runtime'], enabled: true });
    jobs.submitSetEnabledPlugins({ pluginIds: ['task-manager'], enabled: false });

    expect(submit).toHaveBeenNthCalledWith(1, SET_ENABLED_PLUGINS_JOB, { pluginIds: ['task-manager'], enabled: true }, {
      dedupeKey: 'plugins.setEnabled:enable:task-manager',
    });
    expect(submit).toHaveBeenNthCalledWith(2, SET_ENABLED_PLUGINS_JOB, { pluginIds: ['team-runtime'], enabled: true }, {
      dedupeKey: 'plugins.setEnabled:enable:team-runtime',
    });
    expect(submit).toHaveBeenNthCalledWith(3, SET_ENABLED_PLUGINS_JOB, { pluginIds: ['task-manager'], enabled: false }, {
      dedupeKey: 'plugins.setEnabled:disable:task-manager',
    });
  });
});
