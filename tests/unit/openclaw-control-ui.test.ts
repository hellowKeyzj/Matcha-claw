import { describe, expect, it } from 'vitest';
import { buildOpenClawControlUiUrl } from '../../electron/utils/openclaw-control-ui';

describe('buildOpenClawControlUiUrl', () => {
  it('使用 URL fragment 传递 token', () => {
    expect(buildOpenClawControlUiUrl(18789, 'clawx-test-token')).toBe(
      'http://127.0.0.1:18789/#token=clawx-test-token',
    );
  });

  it('空 token 时不拼接 fragment', () => {
    expect(buildOpenClawControlUiUrl(18789, '   ')).toBe('http://127.0.0.1:18789/');
  });
});
