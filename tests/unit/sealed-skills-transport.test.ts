import { describe, expect, it, vi } from 'vitest';

import {
  createSealedSkillsTransport,
  SEALED_SKILLS_ENDPOINTS,
} from '../../electron/main/runtime-host-delivery/transport/skills/sealed';
import type { RuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';

const issuer: RuntimeHostDeliveryIssuer = {
  verificationKey: 'public',
  signDecision: () => 'signed-decision',
};

function nativeResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

describe('sealed skills fixed delivery transport', () => {
  it('preserves export and install notFound as typed 404 responses', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ outcome: 'notFound' }, 404))
      .mockResolvedValueOnce(nativeResponse({ outcome: 'notFound' }, 404));
    const transport = createSealedSkillsTransport(issuer, 3227, fetcher);

    await expect(transport.export({ skillKey: 'calendar' })).resolves.toEqual({
      status: 404,
      body: { outcome: 'notFound' },
    });
    await expect(transport.install({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' })).resolves.toEqual({
      status: 404,
      body: { outcome: 'notFound' },
    });
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ packagePath: 'C:/sealed/calendar.matcha-skillpkg' }));
    expect(String(fetcher.mock.calls[1]?.[1]?.body)).not.toMatch(/authorizationKey|deviceEnvelope|contentKey|rawPayload|token/);
  });

  it.each([
    { authorizationKey: 'authorization-key' },
    { deviceEnvelope: 'device-envelope' },
    { contentKey: 'content-key' },
    { rawPayload: 'raw-payload' },
    { token: 'token' },
  ])('rejects install requests that still carry private cloud authorization fields', async (privateField) => {
    const fetcher = vi.fn();
    const transport = createSealedSkillsTransport(issuer, 3227, fetcher);

    await expect(transport.install({ packagePath: 'C:/sealed/calendar.matcha-skillpkg', ...privateField })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps public endpoints fixed to status and package mutations', () => {
    expect(SEALED_SKILLS_ENDPOINTS).toEqual({
      status: '/api/sealed-skills/status',
      export: '/api/sealed-skills/export',
      exportCloud: '/api/sealed-skills/export-cloud',
      install: '/api/sealed-skills/install',
      uninstall: '/api/sealed-skills/uninstall',
    });
    expect(Object.values(SEALED_SKILLS_ENDPOINTS)).not.toContain('/api/sealed-skills/read');
  });
});
