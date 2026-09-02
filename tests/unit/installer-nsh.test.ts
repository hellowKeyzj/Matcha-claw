import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows NSIS installer script', () => {
  const script = readFileSync(join(process.cwd(), 'scripts', 'installer.nsh'), 'utf8');

  it('preserves old uninstall registry entries until overwrite upgrades succeed', () => {
    expect(script).not.toContain('DeleteRegValue SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" UninstallString');
    expect(script).not.toContain('customUnInstallCheck');
    expect(script).toContain('DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"');
    expect(script).toContain('DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"');
  });

  it('skips orphan cleanup on fresh installs', () => {
    const existingInstallGuard = 'IfFileExists "$INSTDIR\\" 0 _existing_install_cleanup_done';
    const orphanCleanupStart = '; Even if MatchaClaw.exe was not detected';
    const orphanProcessScan = 'Get-CimInstance -ClassName Win32_Process';
    const handleReleaseWait = 'Sleep 2000\n  _existing_install_cleanup_done:';
    const orphanCleanupIndex = script.indexOf(orphanCleanupStart);
    const orphanProcessScanIndex = script.indexOf(
      orphanProcessScan,
      orphanCleanupIndex,
    );

    expect(orphanCleanupIndex).toBeGreaterThan(-1);
    expect(script.indexOf(existingInstallGuard)).toBeLessThan(orphanCleanupIndex);
    expect(orphanProcessScanIndex).toBeGreaterThan(orphanCleanupIndex);
    expect(script.indexOf(handleReleaseWait)).toBeGreaterThan(orphanProcessScanIndex);
  });

  it('moves the existing install directory aside before extraction', () => {
    expect(script).toContain('SetOutPath $TEMP');
    expect(script).toContain('Rename "$INSTDIR" "$INSTDIR._stale_$R8"');
    expect(script).toContain('StrCpy $matchaclawRollbackDir "$INSTDIR._stale_$R8"');
    expect(script).toContain('CreateDirectory "$INSTDIR"');
  });
});
