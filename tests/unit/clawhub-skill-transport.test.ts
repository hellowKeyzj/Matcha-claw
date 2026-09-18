import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/issuer';
import { createClawHubSkillInstallTransport } from '../../electron/main/runtime-host-delivery/transport/skills/clawhub-install';

const installRequest = {
  slug: 'skill-alpha',
  version: '1.2.3',
  force: false,
} as const;

describe('ClawHub skill install delivery transport', () => {
  it('binds the fixed install request to the sealed localhost endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({ outcome: 'accepted', slug: 'skill-alpha', version: '1.2.3' }),
    });
    const transport = createClawHubSkillInstallTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.install(installRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'accepted', slug: 'skill-alpha', version: '1.2.3' },
    });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/clawhub/skills/install', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(installRequest),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers.Authorization as string;
    const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
      endpoint: '/api/clawhub/skills/install',
      scope: 'skills:install',
      capability: 'clawhubSkill.install',
      subject: 'clawhub-skill-install',
    });
  });

  it('rejects malformed public input before delivery', async () => {
    const fetcher = vi.fn();
    const transport = createClawHubSkillInstallTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.install({ slug: '../private', force: false, extra: true })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected', slug: 'invalid' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: 'accepted', slug: 'skill-alpha', rawFailure: 'C:/private/error' },
    { outcome: 'completed', slug: 'skill-alpha' },
    { outcome: 'accepted', slug: 'other-skill' },
    { outcome: 'accepted', slug: 'skill-alpha', version: 'bad\nversion' },
  ])('fails closed for an invalid native result', async (body) => {
    const transport = createClawHubSkillInstallTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({ status: 200, json: async () => body }),
    );

    const response = await transport.install(installRequest);
    expect(response).toEqual({
      status: 503,
      body: { outcome: 'unknown', slug: 'skill-alpha' },
    });
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it('redacts native and loopback failures as an unknown outcome', async () => {
    const transport = createClawHubSkillInstallTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockRejectedValue(new Error('native failure at C:/private/skill')),
    );

    const response = await transport.install(installRequest);
    expect(response).toEqual({
      status: 503,
      body: { outcome: 'unknown', slug: 'skill-alpha' },
    });
    expect(JSON.stringify(response)).not.toContain('C:/private/skill');
  });
});
