import { basename, join, resolve } from 'node:path';
import type { RuntimeHostDiscoveredPlugin, RuntimeHostPluginPlatform } from '../shared/types';
import { getOpenClawConfigDir, getOpenClawDirPath } from '../api/storage/paths';

export const PLUGIN_MANIFEST_NAMES = ['openclaw.plugin.json', 'package.json'] as const;

export function getDefaultPluginDiscoveryRoots(): string[] {
  return [
    join(process.cwd(), 'plugins'),
    join(process.cwd(), 'packages'),
    join(process.env.USERPROFILE || process.env.HOME || '', '.matchaclaw', 'plugins'),
    join(getOpenClawConfigDir(), 'extensions'),
    join(getOpenClawDirPath(), 'dist', 'extensions'),
  ].filter(Boolean);
}

export function classifyPluginDiscoverySource(root: string): RuntimeHostDiscoveredPlugin['source'] {
  const normalizedRoot = resolve(root);
  if (normalizedRoot.includes(join('openclaw', 'dist', 'extensions'))) {
    return 'bundled';
  }
  if (normalizedRoot.includes(join('.openclaw', 'extensions'))) {
    return 'openclaw-extension';
  }
  if (normalizedRoot.includes(join('.matchaclaw', 'plugins'))) {
    return 'matchaclaw-extension';
  }
  return 'workspace';
}

export function classifyPluginPlatformFromManifest(manifestPath: string): RuntimeHostPluginPlatform {
  return basename(manifestPath).toLowerCase() === 'openclaw.plugin.json'
    ? 'openclaw'
    : 'matchaclaw';
}

export function classifyPluginKindFromSource(
  source: RuntimeHostDiscoveredPlugin['source'],
): RuntimeHostDiscoveredPlugin['kind'] {
  return source === 'openclaw-extension' || source === 'matchaclaw-extension'
    ? 'third-party'
    : 'builtin';
}
