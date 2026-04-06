import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { RuntimeHostDiscoveredPlugin, RuntimeHostPluginPlatform } from '../shared/types';

export const PLUGIN_MANIFEST_NAMES = ['openclaw.plugin.json', 'package.json'] as const;

export function getDefaultPluginDiscoveryRoots(): string[] {
  return [
    join(process.cwd(), 'plugins'),
    join(process.cwd(), 'packages'),
    join(process.cwd(), 'build', 'openclaw-plugins'),
    join(homedir(), '.matchaclaw', 'plugins'),
    join(homedir(), '.openclaw', 'extensions'),
    ...(typeof process.resourcesPath === 'string' && process.resourcesPath.trim()
      ? [
          join(process.resourcesPath, 'openclaw-plugins'),
          join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins'),
        ]
      : []),
    ...(String(process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR || '').trim()
      ? [dirname(resolve(process.env.MATCHACLAW_RUNTIME_HOST_TASK_PLUGIN_SOURCE_DIR))]
      : []),
  ].filter(Boolean);
}

export function classifyPluginDiscoverySource(root: string): RuntimeHostDiscoveredPlugin['source'] {
  const normalizedRoot = resolve(root);
  if (normalizedRoot.includes(join('.openclaw', 'extensions'))) {
    return 'openclaw-extension';
  }
  if (normalizedRoot.includes(join('.matchaclaw', 'plugins'))) {
    return 'matchaclaw-extension';
  }
  if (normalizedRoot.includes(join('openclaw-plugins'))) {
    return 'bundled';
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
