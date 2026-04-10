import { describe, expect, it } from 'vitest';
import {
  PROVIDER_TYPE_INFO,
  getProviderDocsUrl,
  resolveProviderModelForSave,
  shouldShowProviderModelId,
} from '@/lib/providers';
import { buildProviderListItems } from '@/lib/provider-accounts';

describe('provider metadata', () => {
  it('exposes SiliconFlow model override without requiring dev mode', () => {
    const siliconflow = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'siliconflow');
    const openrouter = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'openrouter');
    const ark = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'ark');
    expect(siliconflow).toBeDefined();
    expect(openrouter?.defaultModelId).toBe('openai/gpt-5.4');
    expect(ark?.codePlanPresetBaseUrl).toBe('https://ark.cn-beijing.volces.com/api/coding/v3');
    expect(ark?.codePlanPresetModelId).toBe('ark-code-latest');
    expect(ark?.codePlanDocsUrl).toBe('https://www.volcengine.com/docs/82379/1928261?lang=zh');
    expect(shouldShowProviderModelId(siliconflow, false)).toBe(true);
    expect(
      resolveProviderModelForSave(siliconflow, 'Qwen/Qwen3-Coder-480B-A35B-Instruct', false),
    ).toBe('Qwen/Qwen3-Coder-480B-A35B-Instruct');
    expect(resolveProviderModelForSave(openrouter, '   ', false)).toBe('openai/gpt-5.4');
  });

  it('resolves provider docs url by locale', () => {
    const anthropic = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'anthropic');
    const custom = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'custom');
    const qwen = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'qwen-portal');

    expect(getProviderDocsUrl(anthropic, 'en')).toBe('https://platform.claude.com/docs/en/api/overview');
    expect(getProviderDocsUrl(custom, 'zh-CN')).toBe(
      'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#IWQCdfe5fobGU3xf3UGcgbLynGh',
    );
    expect(getProviderDocsUrl(custom, 'en')).toBe(
      'https://icnnp7d0dymg.feishu.cn/wiki/BmiLwGBcEiloZDkdYnGc8RWnn6d#Ee1ldfvKJoVGvfxc32mcILwenth',
    );
    expect(getProviderDocsUrl(qwen, 'en')).toBeUndefined();
  });

  it('buildProviderListItems handles invalid snapshot arrays safely', () => {
    const items = buildProviderListItems(
      undefined as unknown as never[],
      undefined as unknown as never[],
      undefined as unknown as never[],
      null,
    );
    expect(items).toEqual([]);
  });

  it('MiniMax provider metadata points to M2.7 and global console url', () => {
    const minimaxGlobal = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal');
    const minimaxCn = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal-cn');

    expect(minimaxGlobal?.defaultModelId).toBe('MiniMax-M2.7');
    expect(minimaxGlobal?.apiKeyUrl).toBe('https://platform.minimax.io');
    expect(minimaxCn?.defaultModelId).toBe('MiniMax-M2.7');
  });

  it('OAuth provider 仅在开发者模式显示模型覆盖并提供稳定默认值', () => {
    const openai = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'openai');
    const google = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'google');
    const minimax = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal');
    const minimaxCn = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'minimax-portal-cn');
    const qwen = PROVIDER_TYPE_INFO.find((provider) => provider.id === 'qwen-portal');

    expect(openai).toMatchObject({
      showModelId: true,
      showModelIdInDevModeOnly: true,
      defaultModelId: 'gpt-5.4',
    });
    expect(google).toMatchObject({
      showModelId: true,
      showModelIdInDevModeOnly: true,
      defaultModelId: 'gemini-3-pro-preview',
    });
    expect(minimax).toMatchObject({
      showModelId: true,
      showModelIdInDevModeOnly: true,
      defaultModelId: 'MiniMax-M2.7',
    });
    expect(minimaxCn).toMatchObject({
      showModelId: true,
      showModelIdInDevModeOnly: true,
      defaultModelId: 'MiniMax-M2.7',
    });
    expect(qwen).toMatchObject({
      showModelId: true,
      showModelIdInDevModeOnly: true,
      defaultModelId: 'coder-model',
    });

    expect(shouldShowProviderModelId(openai, false)).toBe(false);
    expect(shouldShowProviderModelId(google, false)).toBe(false);
    expect(shouldShowProviderModelId(minimax, false)).toBe(false);
    expect(shouldShowProviderModelId(minimaxCn, false)).toBe(false);
    expect(shouldShowProviderModelId(qwen, false)).toBe(false);

    expect(shouldShowProviderModelId(openai, true)).toBe(true);
    expect(shouldShowProviderModelId(google, true)).toBe(true);
    expect(shouldShowProviderModelId(minimax, true)).toBe(true);
    expect(shouldShowProviderModelId(minimaxCn, true)).toBe(true);
    expect(shouldShowProviderModelId(qwen, true)).toBe(true);

    expect(resolveProviderModelForSave(openai, '   ', true)).toBe('gpt-5.4');
    expect(resolveProviderModelForSave(google, '   ', true)).toBe('gemini-3-pro-preview');
    expect(resolveProviderModelForSave(minimax, '   ', true)).toBe('MiniMax-M2.7');
    expect(resolveProviderModelForSave(minimaxCn, '   ', true)).toBe('MiniMax-M2.7');
    expect(resolveProviderModelForSave(qwen, '   ', true)).toBe('coder-model');
  });
});
