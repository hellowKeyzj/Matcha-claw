import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import { createSkillBundleTransport } from '../../electron/main/runtime-host-delivery/transport/skills/bundle';

const exportRequest = { skillKeys: ['web-search'] } as const;
const importRequest = {
  skillBundles: [{
    skillKey: 'web-search',
    files: [{
      path: 'SKILL.md',
      content: '---\nname: web-search\ndescription: Search the web\n---\n',
    }],
  }],
} as const;

describe('Subagent skill bundle delivery transport', () => {
  it('binds export and import to their fixed sealed localhost endpoints', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ outcome: 'accepted', skillBundles: importRequest.skillBundles }),
      })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ outcome: 'accepted' }) });
    const transport = createSkillBundleTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.exportBundles(exportRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'accepted', skillBundles: importRequest.skillBundles },
    });
    await expect(transport.importBundles(importRequest)).resolves.toEqual({
      status: 200,
      body: { outcome: 'accepted' },
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3227/api/subagents/skill-bundles/export', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(exportRequest),
    }));
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3227/api/subagents/skill-bundles/import', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify(importRequest),
    }));
    for (const call of fetcher.mock.calls) {
      const authorization = call[1]?.headers.Authorization as string;
      const decision = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
      expect(JSON.parse(Buffer.from(decision, 'base64url').toString())).toMatchObject({
        scope: 'subagents:skill-bundles',
        capability: 'subagentSkillBundles.transfer',
        subject: 'subagent-skill-bundles',
      });
    }
  });

  it('rejects malformed public input before delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSkillBundleTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.importBundles({ skillBundles: [{ skillKey: '../private', files: [] }] })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts malformed host replies and loopback failures as unknown', async () => {
    const malformed = createSkillBundleTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({ outcome: 'accepted', skillBundles: [], rawPath: 'C:/private/skills' }),
      }),
    );
    const failed = createSkillBundleTransport(
      createRuntimeHostDeliveryIssuer(),
      3227,
      vi.fn().mockRejectedValue(new Error('native failure at C:/private/skills')),
    );

    await expect(malformed.exportBundles(exportRequest)).resolves.toEqual({
      status: 503,
      body: { outcome: 'unknown' },
    });
    const response = await failed.importBundles(importRequest);
    expect(response).toEqual({ status: 503, body: { outcome: 'unknown' } });
    expect(JSON.stringify(response)).not.toContain('C:/private/skills');
  });
});
