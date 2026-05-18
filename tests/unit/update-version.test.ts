import { describe, expect, it } from 'vitest';
import { compareAppVersions, isUpdateVersionNewer } from '../../runtime-host/shared/update-version';

describe('update version comparison', () => {
  it('treats lower and equal release versions as not newer', () => {
    expect(isUpdateVersionNewer('1.0.0', '1.0.1')).toBe(false);
    expect(isUpdateVersionNewer('1.0.1', '1.0.1')).toBe(false);
  });

  it('treats higher release versions as newer', () => {
    expect(isUpdateVersionNewer('1.0.2', '1.0.1')).toBe(true);
    expect(isUpdateVersionNewer('1.1.0', '1.0.9')).toBe(true);
  });

  it('orders prerelease versions before their release version', () => {
    expect(compareAppVersions('1.0.1-beta.1', '1.0.1')).toBe(-1);
    expect(compareAppVersions('1.0.1', '1.0.1-beta.1')).toBe(1);
    expect(isUpdateVersionNewer('1.0.1-beta.2', '1.0.1-beta.1')).toBe(true);
  });
});
