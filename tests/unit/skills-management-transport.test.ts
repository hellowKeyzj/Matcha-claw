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
      .mockResolvedValueOnce(nativeResponse({ skill: null }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.detail({ slug: 'calendar' })).resolves.toEqual({
      status: 200,
      body: { skill: null },
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, `http://127.0.0.1:3227${SKILLS_ENDPOINTS.detail}`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ slug: 'calendar' }),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers?.Authorization as string;
    const encoded = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toMatchObject({
      endpoint: SKILLS_ENDPOINTS.detail,
      scope: 'skills:read',
      capability: 'skills.detail',
      subject: 'skills-detail',
    });
  });

  it('sends raw OpenClaw skill keys for config mutations', async () => {
    const fetcher = vi.fn().mockResolvedValue(nativeResponse({ outcome: 'accepted' }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.mutateConfig({ skillKey: 'Excel XLSX', enabled: false })).resolves.toEqual({
      status: 200,
      body: { outcome: 'accepted' },
    });

    expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      body: JSON.stringify({ skillKey: 'Excel XLSX', enabled: false }),
    }));
  });

  it('posts ClawHub install to the skills management endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(nativeResponse({ outcome: 'accepted' }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.installClawHub({ slug: 'weather' })).resolves.toEqual({
      status: 200,
      body: { outcome: 'accepted' },
    });

    expect(fetcher).toHaveBeenCalledWith(`http://127.0.0.1:3227${SKILLS_ENDPOINTS.clawHubInstall}`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ slug: 'weather' }),
    }));
    const authorization = fetcher.mock.calls[0]?.[1]?.headers?.Authorization as string;
    const encoded = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString())).toMatchObject({
      endpoint: SKILLS_ENDPOINTS.clawHubInstall,
      scope: 'skills:install',
      capability: 'skills.install',
      subject: 'skills-clawhub-install',
    });
  });

  it('rejects non-legacy ClawHub refs before local CLI install', async () => {
    const fetcher = vi.fn();
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);

    await expect(transport.installClawHub({ slug: '@owner/weather' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    await expect(transport.updateClawHub({ slug: 'skills-sh:owner/repo/weather' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    await expect(transport.installClawHub({ slug: '../private' })).resolves.toEqual({
      status: 400,
      body: { outcome: 'rejected' },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects unknown request fields before loopback delivery', async () => {
    const fetcher = vi.fn();
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);
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

    await expect(transport.uninstall({ skillKey: '163邮箱助手专业版', slug: '163-email-assistant' })).resolves.toEqual({
      status: 404,
      body: { outcome: 'notFound' },
    });
    expect(fetcher).toHaveBeenNthCalledWith(1, `http://127.0.0.1:3227${SKILLS_ENDPOINTS.uninstall}`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ skillKey: '163邮箱助手专业版', slug: '163-email-assistant' }),
    }));
    await expect(transport.detail({ slug: 'calendar' })).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
    await expect(transport.detail({ slug: 'calendar' })).resolves.toEqual({ status: 400, body: { outcome: 'rejected' } });
  });

  it('delivers local import and readme through fixed signed endpoints', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(nativeResponse({ outcome: 'accepted' }))
      .mockResolvedValueOnce(nativeResponse({ success: true, content: '# README', filePath: 'C:\\skills\\Excel XLSX\\SKILL.md' }));
    const transport = createSkillsManagementTransport(issuer(), 3227, fetcher);
    await expect(transport.importBundle({ skillKey: 'Excel XLSX', files: [{ path: 'SKILL.md', content: '---\\nname: Excel XLSX\\n---' }] })).resolves.toEqual({ status: 200, body: { outcome: 'accepted' } });
    await expect(transport.readme({
      skillKey: 'Excel XLSX',
      slug: 'excel-xlsx',
      filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
      baseDir: 'C:\\skills\\Excel XLSX',
    })).resolves.toEqual({
      status: 200,
      body: { success: true, content: '# README', filePath: 'C:\\skills\\Excel XLSX\\SKILL.md' },
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain('/api/skills/import/bundle');
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ skillKey: 'Excel XLSX', files: [{ path: 'SKILL.md', content: '---\\nname: Excel XLSX\\n---' }] }));
    expect(fetcher.mock.calls[1]?.[0]).toContain('/api/skills/readme');
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ skillKey: 'Excel XLSX', slug: 'excel-xlsx', filePath: 'C:\\skills\\Excel XLSX\\SKILL.md', baseDir: 'C:\\skills\\Excel XLSX' }));
  });

  it('keeps native skill identity separate from marketplace slug', async () => {
    const transport = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockResolvedValue(nativeResponse({
        skills: [{
          key: 'Excel XLSX',
          slug: 'excel-xlsx',
          baseDir: 'C:\\skills\\Excel XLSX',
          filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
          name: 'Excel XLSX',
          description: 'Spreadsheet work',
          enabled: true,
          selectable: true,
          unavailableReason: null,
          missingCategories: [],
          eligible: true,
          bundled: false,
          always: false,
          emoji: '📊',
        }, {
          key: 'vendor/foo',
          name: 'Vendor Foo',
          description: '',
          enabled: true,
          selectable: true,
          unavailableReason: null,
          missingCategories: [],
          eligible: true,
        }],
      })),
    );

    await expect(transport.readStatus()).resolves.toEqual({
      status: 200,
      body: {
        skills: [{
          skillKey: 'Excel XLSX',
          slug: 'excel-xlsx',
          name: 'Excel XLSX',
          description: 'Spreadsheet work',
          baseDir: 'C:\\skills\\Excel XLSX',
          filePath: 'C:\\skills\\Excel XLSX\\SKILL.md',
          disabled: false,
          selectable: true,
          unavailableReason: null,
          eligible: true,
          missingCategories: [],
          bundled: false,
          always: false,
          emoji: '📊',
        }, {
          skillKey: 'vendor/foo',
          name: 'Vendor Foo',
          description: '',
          disabled: false,
          selectable: true,
          unavailableReason: null,
          eligible: true,
          missingCategories: [],
        }],
      },
    });
  });

  it('projects native Rust skill status to renderer shape', async () => {
    const transport = createSkillsManagementTransport(
      issuer(),
      3227,
      vi.fn().mockResolvedValue(nativeResponse({
        skills: [{
          key: 'missing-os',
          name: 'Missing OS',
          description: '',
          enabled: true,
          selectable: false,
          unavailableReason: 'missingRequirements',
          missingCategories: ['operatingSystem'],
          eligible: false,
        }],
      })),
    );

    await expect(transport.readStatus()).resolves.toEqual({
      status: 200,
      body: {
        skills: [{
          skillKey: 'missing-os',
          name: 'Missing OS',
          description: '',
          disabled: false,
          selectable: false,
          unavailableReason: 'missingRequirements',
          eligible: false,
          missingCategories: ['operatingSystem'],
          missing: { os: [] },
        }],
      },
    });
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

    await expect(malformed.detail({ slug: 'calendar' })).resolves.toEqual({ status: 503, body: { outcome: 'unknown' } });
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
