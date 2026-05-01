import { describe, expect, it, vi } from 'vitest';
import { handleSkillsRoute } from '../../runtime-host/api/routes/skills-routes';

describe('skills route state sync', () => {
  it('PUT /api/skills/state 在 Gateway 运行时走 skills.update RPC', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const setSkillEnabledLocal = vi.fn(async () => ({ success: true }));

    const result = await handleSkillsRoute(
      'PUT',
      '/api/skills/state',
      {
        skillKey: 'multi-search-engine',
        enabled: true,
      },
      {
        getAllSkillConfigsLocal: () => ({}),
        updateSkillConfigLocal: async () => ({ success: true }),
        setSkillEnabledLocal,
        listEffectiveSkillsLocal: async () => [],
        openclawBridge: {
          isGatewayRunning: async () => true,
          gatewayRpc,
        },
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(gatewayRpc).toHaveBeenCalledWith('skills.update', {
      skillKey: 'multi-search-engine',
      enabled: true,
    });
    expect(setSkillEnabledLocal).not.toHaveBeenCalled();
  });

  it('PUT /api/skills/state 在 Gateway 未运行时会本地显式写 enabled', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const setSkillEnabledLocal = vi.fn(async () => ({ success: true }));

    const result = await handleSkillsRoute(
      'PUT',
      '/api/skills/state',
      {
        skillKey: 'web-extract',
        enabled: false,
      },
      {
        getAllSkillConfigsLocal: () => ({}),
        updateSkillConfigLocal: async () => ({ success: true }),
        setSkillEnabledLocal,
        listEffectiveSkillsLocal: async () => [],
        openclawBridge: {
          isGatewayRunning: async () => false,
          gatewayRpc,
        },
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(setSkillEnabledLocal).toHaveBeenCalledWith('web-extract', false);
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('PUT /api/skills/config 在 Gateway 运行时也统一走 skills.update RPC', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const updateSkillConfigLocal = vi.fn(async () => ({ success: true }));

    const result = await handleSkillsRoute(
      'PUT',
      '/api/skills/config',
      {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
        env: {
          TAVILY_SEARCH_DEPTH: 'advanced',
        },
      },
      {
        getAllSkillConfigsLocal: () => ({}),
        updateSkillConfigLocal,
        setSkillEnabledLocal: async () => ({ success: true }),
        listEffectiveSkillsLocal: async () => [],
        openclawBridge: {
          isGatewayRunning: async () => true,
          gatewayRpc,
        },
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(gatewayRpc).toHaveBeenCalledWith('skills.update', {
      skillKey: 'tavily-search',
      apiKey: 'tv-key',
      env: {
        TAVILY_SEARCH_DEPTH: 'advanced',
      },
    });
    expect(updateSkillConfigLocal).not.toHaveBeenCalled();
  });

  it('PUT /api/skills/config 在 Gateway 未运行时会本地写配置', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const updateSkillConfigLocal = vi.fn(async () => ({ success: true }));

    const result = await handleSkillsRoute(
      'PUT',
      '/api/skills/config',
      {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
      },
      {
        getAllSkillConfigsLocal: () => ({}),
        updateSkillConfigLocal,
        setSkillEnabledLocal: async () => ({ success: true }),
        listEffectiveSkillsLocal: async () => [],
        openclawBridge: {
          isGatewayRunning: async () => false,
          gatewayRpc,
        },
      },
    );

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(updateSkillConfigLocal).toHaveBeenCalledWith('tavily-search', {
      apiKey: 'tv-key',
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
