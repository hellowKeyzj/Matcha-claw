import { describe, expect, it } from 'vitest';
import { applyControlUiRootOverride } from '../../electron/utils/openclaw-auth';

describe('applyControlUiRootOverride', () => {
  it('应在缺省配置下写入 gateway.controlUi.root', () => {
    const input: Record<string, unknown> = {};
    const { nextConfig, outcome } = applyControlUiRootOverride(input, 'C:\\temp\\control-ui');

    expect(outcome).toBe('updated');
    expect(nextConfig.gateway).toEqual({
      mode: 'local',
      controlUi: {
        root: 'C:\\temp\\control-ui',
      },
    });
  });

  it('应在 root 已相同的情况下保持 unchanged', () => {
    const input: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        controlUi: {
          root: 'C:\\temp\\control-ui',
        },
      },
    };

    const { nextConfig, outcome } = applyControlUiRootOverride(input, 'C:\\temp\\control-ui');
    expect(outcome).toBe('unchanged');
    expect(nextConfig).toEqual(input);
  });

  it('应在已有自定义 root 且未 force 时跳过覆盖', () => {
    const input: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        controlUi: {
          root: 'D:\\my-custom-ui',
        },
      },
    };

    const { nextConfig, outcome } = applyControlUiRootOverride(input, 'C:\\temp\\control-ui');
    expect(outcome).toBe('skipped-existing-root');
    expect(nextConfig).toEqual(input);
  });

  it('应在 force=true 时覆盖已有自定义 root', () => {
    const input: Record<string, unknown> = {
      gateway: {
        mode: 'local',
        controlUi: {
          root: 'D:\\my-custom-ui',
        },
      },
    };

    const { nextConfig, outcome } = applyControlUiRootOverride(input, 'C:\\temp\\control-ui', { force: true });
    expect(outcome).toBe('updated');
    expect((nextConfig.gateway as Record<string, unknown>).controlUi).toEqual({
      root: 'C:\\temp\\control-ui',
    });
  });
});
