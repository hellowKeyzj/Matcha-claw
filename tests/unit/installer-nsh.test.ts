import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows NSIS installer script', () => {
  const script = readFileSync(join(process.cwd(), 'scripts', 'installer.nsh'), 'utf8');

  it('skips the legacy NSIS uninstaller before overwrite upgrades', () => {
    expect(script).toContain('DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString');
    expect(script).toContain('DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString');
    expect(script).toContain('customUnInstallCheck');
    expect(script).toContain('Old uninstaller exited with code $R0. Continuing with overwrite install');
  });

  it('moves the existing install directory aside before extraction', () => {
    expect(script).toContain('SetOutPath $TEMP');
    expect(script).toContain('Rename "$INSTDIR" "$INSTDIR._stale_$R8"');
    expect(script).toContain('CreateDirectory "$INSTDIR"');
  });
});
