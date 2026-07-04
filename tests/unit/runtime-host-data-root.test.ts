import { describe, expect, it } from 'vitest';
import { resolveRuntimeHostRuntimeDataRootDir } from '../../runtime-host/composition/modules/runtime-infrastructure-module';
import type { RuntimePlatform } from '../../runtime-host/application/common/runtime-ports';

function environment(input: {
  appName?: string;
  platform: RuntimePlatform;
  homeDir: string;
  env?: Record<string, string | undefined>;
}) {
  return {
    appName: input.appName ?? 'MatchaClaw',
    platform: input.platform,
    homeDir: input.homeDir,
    getEnv: (name: string) => input.env?.[name]?.trim() ?? '',
  };
}

describe('resolveRuntimeHostRuntimeDataRootDir', () => {
  it('uses the Electron userData env when it is provided', () => {
    expect(resolveRuntimeHostRuntimeDataRootDir(environment({
      platform: 'win32',
      homeDir: 'C:/Users/Alice',
      env: { MATCHACLAW_APP_USER_DATA_DIR: 'D:/MatchaClaw/UserData' },
    }))).toBe('D:/MatchaClaw/UserData');
  });

  it('falls back to the same AppData userData shape on Windows development launches', () => {
    expect(resolveRuntimeHostRuntimeDataRootDir(environment({
      platform: 'win32',
      homeDir: 'C:/Users/Alice',
      env: { APPDATA: 'C:/Users/Alice/AppData/Roaming' },
    }))).toBe('C:\\Users\\Alice\\AppData\\Roaming\\MatchaClaw');
  });

  it('falls back to platform userData roots instead of the working directory', () => {
    expect(resolveRuntimeHostRuntimeDataRootDir(environment({
      platform: 'darwin',
      homeDir: '/Users/alice',
    }))).toBe('/Users/alice/Library/Application Support/MatchaClaw');
    expect(resolveRuntimeHostRuntimeDataRootDir(environment({
      platform: 'linux',
      homeDir: '/home/alice',
      env: { XDG_CONFIG_HOME: '/home/alice/.config' },
    }))).toBe('/home/alice/.config/MatchaClaw');
  });
});
