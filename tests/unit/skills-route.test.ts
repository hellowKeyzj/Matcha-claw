import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handleSkillsRoutes } from '../../electron/api/routes/skills';

function incoming(body: unknown, method = 'POST') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

const transport = {
  readStatus: vi.fn(),
  detail: vi.fn(),
  mutateConfig: vi.fn(),
  installClawHub: vi.fn(),
  updateClawHub: vi.fn(),
  beginUpload: vi.fn(),
  appendUploadChunk: vi.fn(),
  commitUpload: vi.fn(),
  uninstall: vi.fn(),
  importMarkdown: vi.fn(),
  importBundle: vi.fn(),
  readme: vi.fn(),
};

describe('skills fixed host API routes', () => {
  it('dispatches only concrete endpoint operations', async () => {
    transport.detail.mockResolvedValue({ status: 200, body: { skill: null } });
    const result = response();

    await expect(handleSkillsRoutes(
      incoming({ slug: 'calendar' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/skills/detail'),
      transport,
    )).resolves.toBe(true);

    expect(transport.detail).toHaveBeenCalledWith({ slug: 'calendar' });
    expect(result.state).toEqual({ statusCode: 200, body: { skill: null } });
  });

  it('redacts route-local transport failures', async () => {
    transport.detail.mockRejectedValue(new Error('private path C:/private/skill'));
    const result = response();

    await handleSkillsRoutes(
      incoming({ slug: 'calendar' }),
      result.raw as never,
      new URL('http://127.0.0.1/api/skills/detail'),
      transport,
    );

    expect(result.state).toEqual({ statusCode: 503, body: { outcome: 'unknown' } });
    expect(JSON.stringify(result.state)).not.toContain('private');
  });

  it('rejects malformed JSON and does not call delivery', async () => {
    const detail = vi.fn();
    const result = response();
    const malformed = Object.assign(Readable.from(['{"slug":']), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    await handleSkillsRoutes(
      malformed as never,
      result.raw as never,
      new URL('http://127.0.0.1/api/skills/detail'),
      { ...transport, detail },
    );

    expect(detail).not.toHaveBeenCalled();
    expect(result.state).toEqual({ statusCode: 400, body: { outcome: 'rejected' } });
  });

  it('dispatches readme and import routes without exposing paths', async () => {
    transport.importMarkdown.mockResolvedValue({ status: 200, body: { outcome: 'accepted' } });
    transport.readme.mockResolvedValue({ status: 200, body: { success: true, content: '# Skill', filePath: 'C:\\skills\\skill\\SKILL.md' } });
    const imported = response();
    await handleSkillsRoutes(incoming({ content: '---\\nname: skill\\n---' }), imported.raw as never, new URL('http://127.0.0.1/api/skills/import/markdown'), transport);
    expect(imported.state.body).toEqual({ outcome: 'accepted' });
    const read = response();
    await handleSkillsRoutes(incoming({ skillKey: 'skill', filePath: 'C:\\skills\\skill\\SKILL.md' }), read.raw as never, new URL('http://127.0.0.1/api/skills/readme'), transport);
    expect(read.state.body).toEqual({ success: true, content: '# Skill', filePath: 'C:\\skills\\skill\\SKILL.md' });
    expect(JSON.stringify(read.state.body)).not.toContain('private');
  });

  it('does not claim an unknown endpoint or method', async () => {
    const result = response();
    await expect(handleSkillsRoutes(
      incoming({}, 'POST'),
      result.raw as never,
      new URL('http://127.0.0.1/api/skills/search'),
      transport,
    )).resolves.toBe(false);
  });
});
