import { describe, expect, it } from 'vitest';
import {
  buildBrowserOAuthAccount,
  buildDeviceOAuthAccount,
} from '../../runtime-host/application/providers/provider-oauth-account-service';

const clock = {
  nowMs: () => 1_700_000_000_000,
  nowIso: () => '2023-11-14T22:13:20.000Z',
};

describe('provider-oauth-account-service', () => {
  it('Device OAuth 账号只写凭证字段', () => {
    const account = buildDeviceOAuthAccount({
      providerType: 'minimax-portal',
      accountId: 'minimax-default',
      baseUrl: 'https://api.minimax.io/anthropic',
      clock,
      existingAccount: {
        id: 'minimax-default',
        vendorId: 'minimax-portal',
        label: 'MiniMax (Global)',
        authMode: 'oauth_device',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(account).toEqual(expect.objectContaining({
      id: 'minimax-default',
      vendorId: 'minimax-portal',
      authMode: 'oauth_device',
      baseUrl: 'https://api.minimax.io/anthropic',
      enabled: true,
    }));
  });

  it('Browser OAuth 账号保留 token 资源信息', () => {
    const account = buildBrowserOAuthAccount({
      providerType: 'openai',
      accountId: 'openai-main',
      runtimeProviderId: 'openai-codex',
      oauthTokenEmail: 'dev@example.com',
      clock,
    });

    expect(account.metadata).toMatchObject({
      email: 'dev@example.com',
      resourceUrl: 'openai-codex',
    });
  });
});
