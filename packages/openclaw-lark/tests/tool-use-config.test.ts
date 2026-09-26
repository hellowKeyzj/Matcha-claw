import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { clearSessionStoreCacheForTest, upsertSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { resolveToolUseDisplayConfig } from '../src/card/tool-use-config';

// 2026.9.x: sessions are SQLite-backed. A hand-written JSON store file is no
// longer readable by the session-store API, so fixtures are seeded through the
// supported write path instead.
function createStorePath(testName: string): string {
  const dir = join(tmpdir(), `openclaw-lark-tool-use-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${testName}.sqlite`);
}

async function seedStore(
  storePath: string,
  agentId: string,
  entries: Record<string, { verboseLevel?: string }>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await upsertSessionEntry({
      agentId,
      sessionKey,
      storePath,
      entry: { sessionId: `session-${sessionKey}`, updatedAt: 1, ...entry },
    } as never);
  }
}

afterEach(() => {
  clearSessionStoreCacheForTest();
  rmSync(join(tmpdir(), `openclaw-lark-tool-use-${process.pid}`), { recursive: true, force: true });
});

describe('resolveToolUseDisplayConfig', () => {
  it('uses session verbose override from the session store', async () => {
    const storePath = createStorePath('session-override');
    await seedStore(storePath, 'main', {
      'agent:main:feishu:dm:user-1': { verboseLevel: 'full' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: storePath },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
      feishuCfg: { toolUseDisplay: { showFullPaths: true } } as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(true);
    expect(config.showFullPaths).toBe(true);
  });

  it('lets inline /verbose override the stored session level for this message', async () => {
    const storePath = createStorePath('inline-override');
    await seedStore(storePath, 'main', {
      'agent:main:feishu:dm:user-1': { verboseLevel: 'off' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: storePath },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'please inspect this /verbose full',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
  });

  it('falls back to agents.defaults.verboseDefault when no override exists', () => {
    const storePath = createStorePath('default-fallback');

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: storePath },
        agents: { defaults: { verboseDefault: 'on' } },
      } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('on');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(false);
  });

  it('defaults to off when no inline, session, or config value is present', () => {
    const storePath = createStorePath('hard-off');

    const config = resolveToolUseDisplayConfig({
      cfg: { session: { store: storePath } } as never,
      feishuCfg: {} as never,
      agentId: 'main',
      sessionKey: 'agent:main:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('off');
    expect(config.showToolUse).toBe(false);
  });

  it('falls back to the default-agent session key for non-default agents', async () => {
    const storePath = createStorePath('non-default-agent-fallback');
    await seedStore(storePath, 'main', {
      'agent:main:feishu:dm:user-1': { verboseLevel: 'full' },
    });

    const config = resolveToolUseDisplayConfig({
      cfg: {
        session: { store: storePath },
        agents: { defaults: { verboseDefault: 'off' } },
      } as never,
      feishuCfg: {} as never,
      agentId: 'hr',
      sessionKey: 'agent:hr:feishu:dm:user-1',
      body: 'run tests',
    });

    expect(config.mode).toBe('full');
    expect(config.showToolUse).toBe(true);
    expect(config.showToolResultDetails).toBe(true);
  });
});
