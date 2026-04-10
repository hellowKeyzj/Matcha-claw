import { describe, expect, it } from 'vitest';
import {
  GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF,
  OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF,
  getOpenClawProviderKey,
} from '../../runtime-host/application/providers/provider-runtime-rules';

describe('provider-runtime-rules', () => {
  it('custom/ollama 已是 runtime key 时保持幂等', () => {
    expect(getOpenClawProviderKey('custom', 'custom-abc12345')).toBe('custom-abc12345');
    expect(getOpenClawProviderKey('ollama', 'ollama-1a2b3c4d')).toBe('ollama-1a2b3c4d');
  });

  it('custom/ollama 非 runtime key 时生成稳定短 key', () => {
    expect(getOpenClawProviderKey('custom', 'moonshot-cn')).toBe('custom-moonshot');
    expect(getOpenClawProviderKey('ollama', 'ollama-local-account')).toBe('ollama-ollamalo');
  });

  it('内置 provider 不走多实例 key 截断规则', () => {
    expect(getOpenClawProviderKey('openai', 'openai-personal')).toBe('openai');
    expect(getOpenClawProviderKey('minimax-portal-cn', 'any')).toBe('minimax-portal');
  });

  it('Browser OAuth 默认模型 ref 与当前产品策略一致', () => {
    expect(OPENAI_BROWSER_OAUTH_DEFAULT_MODEL_REF).toBe('openai-codex/gpt-5.4');
    expect(GOOGLE_BROWSER_OAUTH_DEFAULT_MODEL_REF).toBe('google-gemini-cli/gemini-3-pro-preview');
  });
});
