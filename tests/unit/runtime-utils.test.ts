import { describe, expect, it } from 'vitest';
import {
  buildPosixPortOwnerProbeScript,
  buildWindowsPortOwnerProbeScript,
  isLikelyWslPortProxyCommand,
  tryConvertPosixWslUncToWindowsPath,
} from '@electron/gateway/runtime-utils';

describe('buildWindowsPortOwnerProbeScript', () => {
  it('uses a non-reserved variable for owning pid', () => {
    const script = buildWindowsPortOwnerProbeScript(18789);
    expect(script).toContain('$ownerPid = [int]$conn.OwningProcess');
    expect(script).toContain('ProcessId=$ownerPid');
    expect(script).not.toContain('$pid = [int]');
  });
});

describe('buildPosixPortOwnerProbeScript', () => {
  it('uses newline-separated shell statements to avoid then; syntax errors', () => {
    const script = buildPosixPortOwnerProbeScript(18789);
    expect(script).toContain('if [ -z "$line" ]; then\n  echo "0||"');
    expect(script).not.toContain('then;');
    expect(script).not.toContain('; then;');
  });
});

describe('tryConvertPosixWslUncToWindowsPath', () => {
  it('converts /wsl.localhost paths to windows UNC paths', () => {
    const converted = tryConvertPosixWslUncToWindowsPath('/wsl.localhost/Ubuntu-22.04/home/keyzj/.openclaw/openclaw.json');
    expect(converted).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\keyzj\\.openclaw\\openclaw.json');
  });

  it('supports paths with repeated leading slashes', () => {
    const converted = tryConvertPosixWslUncToWindowsPath('//wsl.localhost/Ubuntu-22.04/home/keyzj/.openclaw');
    expect(converted).toBe('\\\\wsl.localhost\\Ubuntu-22.04\\home\\keyzj\\.openclaw');
  });

  it('returns undefined for non-unc posix paths', () => {
    const converted = tryConvertPosixWslUncToWindowsPath('/home/keyzj/.openclaw/openclaw.json');
    expect(converted).toBeUndefined();
  });
});

describe('isLikelyWslPortProxyCommand', () => {
  it('detects vm relay args used by WSL port proxy process', () => {
    const hit = isLikelyWslPortProxyCommand(' --mode 2 --vm-id {ce839093-880f-4b2d-80b5-b818f152c71d} --handle 2168');
    expect(hit).toBe(true);
  });

  it('returns false for ordinary process commands', () => {
    const hit = isLikelyWslPortProxyCommand('C:\\Windows\\System32\\notepad.exe');
    expect(hit).toBe(false);
  });
});
