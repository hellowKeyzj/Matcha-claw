import { basename, join, resolve } from 'node:path';
import type { RuntimeHostDiscoveredPlugin, RuntimeHostPluginPlatform } from '../shared/types';

export const PLUGIN_MANIFEST_NAMES = ['openclaw.plugin.json', 'package.json'] as const;

export interface PluginLocationContext {
  readonly openClawConfigDir: string;
  readonly openClawDirPath: string;
  readonly workingDir: string;
  readonly matchaClawPluginsDir?: string;
}

export function getDefaultPluginDiscoveryRoots(context: PluginLocationContext): string[] {
  return [
    join(context.workingDir, 'plugins'),
    join(context.workingDir, 'packages'),
    context.matchaClawPluginsDir,
    join(context.openClawConfigDir, 'extensions'),
    join(context.openClawDirPath, 'dist', 'extensions'),
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

export function getOpenClawRuntimePluginDiscoveryRoots(context: PluginLocationContext): string[] {
  return [
    join(context.openClawConfigDir, 'extensions'),
    join(context.openClawDirPath, 'dist', 'extensions'),
  ].filter(Boolean);
}

export function classifyPluginDiscoverySource(
  root: string,
  context: PluginLocationContext,
): RuntimeHostDiscoveredPlugin['source'] {
  const normalizedRoot = resolve(root);
  if (normalizedRoot === resolve(join(context.openClawDirPath, 'dist', 'extensions'))) {
    return 'bundled';
  }
  if (normalizedRoot === resolve(join(context.openClawConfigDir, 'extensions'))) {
    return 'openclaw-extension';
  }
  if (context.matchaClawPluginsDir && normalizedRoot === resolve(context.matchaClawPluginsDir)) {
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
