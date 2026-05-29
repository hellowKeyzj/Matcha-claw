import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('release mac signing config', () => {
  it('keeps electron-builder mac defaults sign-capable (no hardcoded unsigned)', async () => {
    const config = await readFile('electron-builder.yml', 'utf8');
    expect(config).not.toContain('identity: null');
    expect(config).toContain('notarize: true');
  });

  it('builds signed mac apps with a single explicit notarization submission per arch', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    expect(workflow).toContain('if [ -z "${CSC_LINK:-}" ] || [ -z "${CSC_KEY_PASSWORD:-}" ]; then');
    expect(workflow).toContain('if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then');
    expect(workflow).toContain('pnpm exec electron-builder --mac dir --x64 --arm64 --publish never -c.mac.notarize=false');
    expect(workflow).toContain('submit_notary x64 "release/mac/MatchaClaw.app"');
    expect(workflow).toContain('submit_notary arm64 "release/mac-arm64/MatchaClaw.app"');
    expect(workflow).toContain('Refusing to submit again automatically to avoid duplicate Apple notarization quota usage.');
    expect(workflow).not.toContain('-c.mac.identity=null');
  });
});
