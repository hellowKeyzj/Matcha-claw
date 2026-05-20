import { describe, expect, it } from 'vitest';
import {
  GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER,
  OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER,
  getLegacyOpenClawProviderKeys,
  getOpenClawProviderKey,
} from '../../runtime-host/application/providers/provider-runtime-rules';

describe('provider-runtime-rules', () => {
  it('custom/ollama 已是 runtime key 时保持幂等', () => {
    expect(getOpenClawProviderKey('ollama', 'ollama')).toBe('ollama');
    expect(getOpenClawProviderKey('custom', 'custom-abc12345')).toBe('custom-abc12345');
    expect(getOpenClawProviderKey('ollama', 'ollama-1a2b3c4d')).toBe('ollama-1a2b3c4d');
  });

  it('custom/ollama 非 runtime key 时生成稳定短 key', () => {
    expect(getOpenClawProviderKey('custom', 'moonshot-cn')).toBe('custom-moonshot-cn');
    expect(getOpenClawProviderKey('ollama', 'local-account')).toBe('ollama-local-account');
    expect(getOpenClawProviderKey('custom', 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a')).toBe('custom-dd749b2e');
  });

  it('custom/ollama 返回错误长 key 算法留下的旧 provider key', () => {
    expect(getLegacyOpenClawProviderKeys('custom', 'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a')).toEqual([
      'custom-dd749b2e-4807-4e78-bb50-7f7e3ae81d7a',
    ]);
    expect(getLegacyOpenClawProviderKeys('custom', 'custom-dd749b2e')).toEqual([]);
  });

  it('内置 provider 不走多实例 key 截断规则', () => {
    expect(getOpenClawProviderKey('openai', 'openai-personal')).toBe('openai');
    expect(getOpenClawProviderKey('minimax-portal-cn', 'any')).toBe('minimax-portal');
    expect(getOpenClawProviderKey('moonshot-global', 'moonshot-global-work')).toBe('moonshot-global');
  });

  it('Browser OAuth 只定义 runtime provider key，不再携带默认模型', () => {
    expect(OPENAI_BROWSER_OAUTH_RUNTIME_PROVIDER).toBe('openai-codex');
    expect(GOOGLE_BROWSER_OAUTH_RUNTIME_PROVIDER).toBe('google-gemini-cli');
  });
});
