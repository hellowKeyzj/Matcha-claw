import { describe, expect, it, vi } from 'vitest';
import { TeamRuntimeWebhookAuthService } from '../../runtime-host/application/team-runtime/team-runtime-webhook-auth';

function createService(input: {
  envToken?: string;
  settings?: Record<string, unknown>;
  generatedHex?: string;
} = {}) {
  const settings = { ...(input.settings ?? {}) };
  const setValue = vi.fn(async (key: string, value: unknown) => {
    settings[key] = value;
    return value;
  });
  const service = new TeamRuntimeWebhookAuthService({
    environment: { getEnv: vi.fn((name: string) => name === 'MATCHACLAW_TEAM_WEBHOOK_TOKEN' ? input.envToken ?? '' : '') },
    settingsRepository: {
      getAll: vi.fn(async () => ({ ...settings })),
      setValue,
    },
    idGenerator: { randomHex: vi.fn(() => input.generatedHex ?? 'a'.repeat(64)) },
  });
  return { service, settings, setValue };
}

describe('TeamRuntimeWebhookAuthService', () => {
  it('generates and persists a desktop webhook token when no override or setting exists', async () => {
    const { service, settings, setValue } = createService({ generatedHex: 'b'.repeat(64) });

    await expect(service.getPublicAuthProjection()).resolves.toEqual({
      success: true,
      enabled: true,
      source: 'settings',
      headerName: 'x-matchaclaw-webhook-token',
      authorizationScheme: 'Bearer',
      maskedToken: 'mctwh_…bbbb',
      copySupported: false,
    });
    expect(settings.teamWebhookToken).toBe(`mctwh_${'b'.repeat(64)}`);
    expect(setValue).toHaveBeenCalledWith('teamWebhookToken', `mctwh_${'b'.repeat(64)}`);
  });

  it('reuses the persisted settings token without rewriting it', async () => {
    const { service, setValue } = createService({ settings: { teamWebhookToken: 'mctwh_existing' } });

    await expect(service.getToken()).resolves.toBe('mctwh_existing');
    expect(setValue).not.toHaveBeenCalled();
  });

  it('uses MATCHACLAW_TEAM_WEBHOOK_TOKEN as an advanced override without persisting it', async () => {
    const { service, setValue } = createService({
      envToken: 'env-secret',
      settings: { teamWebhookToken: 'mctwh_existing' },
    });

    await expect(service.getPublicAuthProjection()).resolves.toMatchObject({
      maskedToken: 'env-se…cret',
      source: 'environment',
      copySupported: false,
    });
    await expect(service.getToken()).resolves.toBe('env-secret');
    expect(setValue).not.toHaveBeenCalled();
  });
});
