import { describe, expect, it } from 'vitest';
import {
  buildBrowserOAuthAccount,
  buildDeviceOAuthAccount,
} from '../../runtime-host/application/providers/provider-oauth-account-service';

describe('provider-oauth-account-service', () => {
  it('MiniMax 旧默认模型会在 OAuth 重登后迁移到新默认模型', () => {
    const account = buildDeviceOAuthAccount({
      providerType: 'minimax-portal',
      accountId: 'minimax-default',
      baseUrl: 'https://api.minimax.io/anthropic',
      defaultModel: 'MiniMax-M2.7',
      existingAccount: {
        id: 'minimax-default',
        vendorId: 'minimax-portal',
        label: 'MiniMax (Global)',
        authMode: 'oauth_device',
        model: 'MiniMax-M2.5',
        enabled: true,
        isDefault: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(account.model).toBe('MiniMax-M2.7');
  });

  it('MiniMax 用户自定义模型不会被覆盖', () => {
    const account = buildDeviceOAuthAccount({
      providerType: 'minimax-portal-cn',
      accountId: 'minimax-cn-custom',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      defaultModel: 'MiniMax-M2.7',
      existingAccount: {
        id: 'minimax-cn-custom',
        vendorId: 'minimax-portal-cn',
        label: 'MiniMax (CN)',
        authMode: 'oauth_device',
        model: 'abab7.5-chat',
        enabled: true,
        isDefault: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(account.model).toBe('abab7.5-chat');
  });

  it('MiniMax 无历史模型时使用当前默认模型', () => {
    const account = buildDeviceOAuthAccount({
      providerType: 'minimax-portal',
      accountId: 'minimax-new',
      baseUrl: 'https://api.minimax.io/anthropic',
      defaultModel: 'MiniMax-M2.7',
    });

    expect(account.model).toBe('MiniMax-M2.7');
  });

  it('OpenAI Browser OAuth 账户默认模型为 gpt-5.4', () => {
    const account = buildBrowserOAuthAccount({
      providerType: 'openai',
      accountId: 'openai-main',
      runtimeProviderId: 'openai-codex',
    });

    expect(account.model).toBe('gpt-5.4');
  });
});
