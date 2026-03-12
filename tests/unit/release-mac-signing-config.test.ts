import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release mac signing config', () => {
  it('keeps electron-builder mac defaults sign-capable (no hardcoded unsigned)', async () => {
    const config = await readFile('electron-builder.yml', 'utf8');
    expect(config).not.toContain('identity: null');
    expect(config).toContain('notarize: true');
  });

  it('uses workflow conditional CLI overrides for unsigned/signed mac builds', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('if [ -n "${CSC_LINK:-}" ] && [ -n "${CSC_KEY_PASSWORD:-}" ]; then');
    expect(workflow).toContain('BUILDER_ARGS=(--mac --publish never)');
    expect(workflow).toContain('pnpm exec electron-builder "${BUILDER_ARGS[@]}"');
    expect(workflow).toContain('-c.mac.identity=null');
    expect(workflow).toContain('-c.mac.notarize=false');
  });
});
