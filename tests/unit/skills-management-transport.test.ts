import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import {
  createSkillsManagementTransport,
  SKILLS_ENDPOINTS,
} from '../../electron/main/runtime-host-delivery/transport/skills/management';

const issuer = () => createRuntimeHostDeliveryIssuer();

function nativeResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

describe('skills management fixed delivery transport', () => {
  it('uses concrete endpoints and short-lived signed decisions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ results: [] }))
      .mockResolvedValueOnce(nativeResponse({ skill: null }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.search({ query: 'calendar', limit: 10 })).resolves.toEqual({
      status: 200,
      body: { results: [] },
    });
    await expect(transport.detail({ slug: 'calendar' })).resolves.toEqual({
      status: 200,
      body: { skill: null },
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, `http://127.0.0.1:3227${SKILLS_ENDPOINTS.search}`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ query: 'calendar', limit: 10 }),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers?.Authorization as string;
    const encoded = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toMatchObject({
      endpoint: SKILLS_ENDPOINTS.search,
      scope: 'skills:search',
      capability: 'skills.search',
      subject: 'skills-search',
    });
  });

  it('rejects unknown request fields before loopback delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.search({ query: 'calendar', extra: true })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    await expect(transport.beginUpload({
      kind: 'skill-archive', slug: 'calendar', sizeBytes: 10, path: 'C:/private',
    })).resolves.toEqual({ status: 400, body: { outcome: 'rejected' } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts the native upload progress contract for begin and chunk', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ uploadId: 'upload-1', receivedBytes: 0, expiresAt: 123 }))
      .mockResolvedValueOnce(nativeResponse({ uploadId: 'upload-1', receivedBytes: 3, expiresAt: 123 }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.beginUpload({
      kind: 'skill-archive',
      slug: 'calendar',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
    })).resolves.toEqual({
      status: 200,
      body: { uploadId: 'upload-1', receivedBytes: 0, expiresAt: 123 },
    });
    await expect(transport.appendUploadChunk({
      uploadId: 'upload-1',
      offset: 0,
      dataBase64: 'YWJj',
    })).resolves.toEqual({
      status: 200,
      body: { uploadId: 'upload-1', receivedBytes: 3, expiresAt: 123 },
    });
  });

  it('keeps upload progress DTOs closed when native adds commit-only fields', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ uploadId: 'upload-1', receivedBytes: 0, expiresAt: 123, sha256: 'a'.repeat(64) }))
      .mockResolvedValueOnce(nativeResponse({ uploadId: 'upload-1', receivedBytes: 3, expiresAt: 123, sha256: 'a'.repeat(64) }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.beginUpload({
      kind: 'skill-archive',
      slug: 'calendar',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
    })).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    await expect(transport.appendUploadChunk({
      uploadId: 'upload-1',
      offset: 0,
      dataBase64: 'YWJj',
    })).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
  });

  it('preserves uninstall notFound as typed 404 without widening other endpoint semantics', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ outcome: 'notFound' }, 404))
      .mockResolvedValueOnce(nativeResponse({ outcome: 'notFound' }, 404))
      .mockResolvedValueOnce(nativeResponse({ outcome: 'rejected' }, 400));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.uninstall({ skillKey: 'calendar' })).resolves.toEqual({
      status: 404,
      body: { outcome: 'notFound' },
    });
    await expect(transport.search({})).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    await expect(transport.search({})).resolves.toEqual({ status: 400, body: { outcome: 'rejected' } });
  });

  it('delivers local import and readme through fixed signed endpoints', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ outcome: 'accepted' }))
      .mockResolvedValueOnce(nativeResponse({ success: true, content: '# README', filePath: 'C:\\skills\\calendar\\SKILL.md' }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);
    await expect(transport.importBundle({ skillKey: 'calendar', files: [{ path: 'SKILL.md', content: '---\\nname: calendar\\n---' }] })).resolves.toEqual({ status: 200, body: { outcome: 'accepted' } });
    await expect(transport.readme({
      skillKey: 'calendar',
      filePath: 'C:\\skills\\calendar\\SKILL.md',
    })).resolves.toEqual({
      status: 200,
      body: { success: true, content: '# README', filePath: 'C:\\skills\\calendar\\SKILL.md' },
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/skills/import/bundle');
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/skills/readme');
  });

  it('preserves an empty trusted readme as a successful response', async () => {
    const transport = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockResolvedValue(nativeResponse({
        success: true,
        content: '',
        filePath: 'C:\\skills\\calendar\\SKILL.md',
      })),
    );

    await expect(transport.readme({ skillKey: 'calendar' })).resolves.toEqual({
      status: 200,
      body: { success: true, content: '', filePath: 'C:\\skills\\calendar\\SKILL.md' },
    });
  });

  it('rejects unsafe readme paths before loopback delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.readme({ skillKey: 'calendar', filePath: 'relative/SKILL.md' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    await expect(transport.readme({ skillKey: 'calendar', filePath: 'C:/private/README.md' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts malformed native replies and loopback failures', async () => {
    const malformed = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockResolvedValue(nativeResponse({ results: [], privatePath: 'C:/private/skills' })),
    );
    const malformedReadme = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockResolvedValue(nativeResponse({
        success: true,
        content: '# README',
        filePath: 'C:/private/README.md',
      })),
    );
    const failed = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockRejectedValue(new Error('secret at C:/private/skills')),
    );

    await expect(malformed.search({})).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    await expect(malformedReadme.readme({ skillKey: 'calendar' })).resolves.toEqual({
      status: 503,
      body: { outcome: 'unknown' },
    });
    await expect(failed.commitUpload({ uploadId: 'upload-1' })).resolves.toEqual({
      status: 503,
      body: { outcome: 'unknown' },
    });
  });
});
