import { describe, expect, it } from 'vitest';
import { detectDestructive } from '../../packages/openclaw-security-plugin/src/vendor/clawguardian-destructive/detector';

describe('destructive detector cross-platform coverage', () => {
  it('识别 Linux ip route flush 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'ip route flush table main' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('network_destructive');
  });

  it('识别 Linux systemctl disable sshd 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'systemctl disable sshd' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('system_destructive');
  });

  it('识别 Linux service stop nginx 为 high', () => {
    const match = detectDestructive('system.run', { command: 'service nginx stop' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('system_destructive');
  });

  it('识别 Windows rmdir /s 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'rmdir /s /q C:\\temp\\demo' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('file_delete');
  });

  it('识别 Windows reg delete /f 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'reg delete HKLM\\Software\\Demo /f' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('system_destructive');
  });

  it('识别 Windows taskkill /f 为 high', () => {
    const match = detectDestructive('system.run', { command: 'taskkill /f /pid 1234' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('process_kill');
  });

  it('识别 PowerShell Remove-Item -Recurse -Force 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'powershell -Command "Remove-Item C:\\temp\\x -Recurse -Force"' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('file_delete');
  });

  it('识别 Windows netsh advfirewall reset 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'netsh advfirewall reset' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('network_destructive');
  });

  it('识别 Windows route delete 为 high', () => {
    const match = detectDestructive('system.run', { command: 'route delete 0.0.0.0' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('network_destructive');
  });

  it('识别 PowerShell NetFirewallRule 变更为 high', () => {
    const match = detectDestructive('system.run', { command: 'pwsh -Command "Remove-NetFirewallRule -DisplayName DemoRule"' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('network_destructive');
  });

  it('识别 macOS diskutil eraseDisk 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'diskutil eraseDisk APFS Demo /dev/disk3' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('system_destructive');
  });

  it('识别 macOS launchctl bootout 为 high', () => {
    const match = detectDestructive('system.run', { command: 'launchctl bootout system/com.apple.sshd' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('system_destructive');
  });

  it('识别 macOS csrutil disable 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'csrutil disable' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('privilege_escalation');
  });

  it('识别 macOS pfctl -f 为 critical', () => {
    const match = detectDestructive('system.run', { command: 'pfctl -f /etc/pf.conf' });
    expect(match?.severity).toBe('critical');
    expect(match?.category).toBe('network_destructive');
  });

  it('识别 macOS route delete 为 high', () => {
    const match = detectDestructive('system.run', { command: 'route delete default' });
    expect(match?.severity).toBe('high');
    expect(match?.category).toBe('network_destructive');
  });

  it('普通 Windows 读取命令不应误报', () => {
    const match = detectDestructive('system.run', { command: 'dir C:\\Users\\Public' });
    expect(match).toBeUndefined();
  });
});
